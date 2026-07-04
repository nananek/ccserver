import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSandboxSpawn, resolveClaude, sandboxAvailable } from './sandbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAVED_SESSIONS_PATH = join(__dirname, '..', '..', '.saved-sessions.json');
const SCHEDULES_PATH = join(__dirname, '..', '..', '.scheduled-prompts.json');

const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours for active sessions
const SESSION_EXITED_TIMEOUT_MS = 30 * 1000;
const OUTPUT_BUFFER_MAX_BYTES = 512 * 1024;
const IDLE_TIMEOUT_MS = 3000;

const sessions = new Map();

function resolveCommand(cmd) {
  if (process.platform !== 'win32') return cmd;
  try {
    return execFileSync('where.exe', [cmd], { encoding: 'utf-8' }).split('\r\n')[0].trim();
  } catch {
    return cmd;
  }
}

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

function extractClaudeSessionId(outputBuffer) {
  const recentOutput = outputBuffer.slice(-50).join('');
  const clean = stripAnsi(recentOutput);

  const matches = [...clean.matchAll(/claude\s+(?:--resume|-r)\s+([a-zA-Z0-9_-]+)/gi)];
  if (matches.length > 0) return matches[matches.length - 1][1];

  return null;
}

export function createSession({ cwd, cols, rows, claudeSessionId, shell, sandbox }) {
  const id = randomUUID();

  const { SSH_AUTH_SOCK, SSH_AGENT_PID, ...cleanEnv } = process.env;

  let command, args;
  if (shell) {
    command = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
    args = [];
  } else {
    command = resolveClaude().command;
    args = claudeSessionId ? ['--resume', claudeSessionId] : [];
  }
  command = resolveCommand(command);

  // Optionally wrap the target in a filesystem sandbox (Linux only) so it can
  // only see the project directory plus configured paths, with an isolated
  // rootless docker inside. See sandbox.js.
  let useSandbox = false;
  let sandboxStateDir = null;
  if (sandbox && process.platform !== 'win32' && sandboxAvailable()) {
    try {
      const spawn = buildSandboxSpawn({ cwd, targetCommand: [command, ...args] });
      command = spawn.command;
      args = spawn.args;
      sandboxStateDir = spawn.stateDir || null;
      useSandbox = true;
    } catch (err) {
      return { sessionId: id, session: null, error: `Failed to build sandbox: ${err.message}` };
    }
  }

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...cleanEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '1',
      // For claude sessions, keep it drawing to the main buffer instead of the
      // alternate screen (DECSET 1049). The alt-screen has no scrollback, so
      // xterm.js's scrollLines()/scroll buttons do nothing while it's active;
      // disabling it lets scrollback accumulate again. DISABLE_MOUSE_CLICKS
      // additionally hands the scroll wheel back to xterm.js. Only affects
      // ccserver-launched claude; shells are left untouched.
      ...(shell ? {} : {
        CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
        CLAUDE_CODE_DISABLE_MOUSE_CLICKS: '1',
      }),
    },
  });
  } catch (err) {
    return { sessionId: id, session: null, error: `Failed to spawn "${command}": ${err.message}` };
  }

  const session = {
    id,
    cwd,
    shell: !!shell,
    sandbox: useSandbox,
    sandboxStateDir, // rootlesskit state dir to remove on teardown (docker only)
    ptyProcess,
    socket: null,
    outputBuffer: [],
    bufferSize: 0,
    cols,
    rows,
    exited: false,
    exitCode: null,
    exitSignal: null,
    timeoutTimer: null,
    claudeSessionId: null,
    idleTimer: null,
    idleNotified: false,
    autoYes: false,
    autoYesLog: [],
    autoYesPending: null,
    autoYesBuf: '',
    startedClaudeSessionId: claudeSessionId || null,
    scheduleId: null, // key into the module-level `schedules` map, if any
    pendingInjection: null, // { text, at } — scheduled prompt awaiting a freshly-resumed session
  };

  ptyProcess.onData((data) => {
    appendToBuffer(session, data);

    if (session.socket && session.socket.readyState === 1) {
      try {
        session.socket.send(JSON.stringify({ type: 'output', data }));
      } catch {
        // Prevent output serialization errors from crashing the PTY handler
      }
    }

    // Idle detection: reset timer on every output chunk (Claude sessions only)
    if (!session.shell) {
      // Only reset notification state on substantial output (not cursor/control sequences)
      const stripped = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
      if (stripped.length > 2) {
        session.idleNotified = false;
      }
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
      }
      session.idleTimer = setTimeout(() => {
        if (session.exited) return;
        // A scheduled prompt may be waiting for this (freshly auto-resumed)
        // session to settle before typing its text. Deliver it once quiet.
        if (session.pendingInjection) {
          const inj = session.pendingInjection;
          session.pendingInjection = null;
          const delivered = injectIntoLiveSession(session, inj.text);
          notifyFired(session, { at: inj.at, text: inj.text }, delivered);
          return;
        }
        if (!session.idleNotified) {
          const now = Date.now();
          if (!session.lastNotifyTime || now - session.lastNotifyTime > 30000) {
            session.idleNotified = true;
            session.lastNotifyTime = now;
            if (session.socket && session.socket.readyState === 1) {
              session.socket.send(JSON.stringify({ type: 'input_needed' }));
            }
          }
        }
      }, IDLE_TIMEOUT_MS);

      // Auto-yes detection for Claude Code CLI permission prompts
      // Claude Code uses Ink Select UI — Enter accepts the focused option (default: Yes)
      if (session.autoYes) {
        // Strip all ANSI escape sequences
        const ansiRe = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()][A-Z0-9]|[>=<]|#[0-9])/g;
        const stripped = data.replace(ansiRe, '');
        // Accumulate stripped text since last auto-yes response (max 10KB)
        session.autoYesBuf += stripped;
        if (session.autoYesBuf.length > 10000) {
          session.autoYesBuf = session.autoYesBuf.slice(-5000);
        }
        const buf = session.autoYesBuf;
        // Ink renders text with cursor positioning, so spaces may be missing after ANSI strip
        const bufNoSpace = buf.replace(/\s+/g, '');
        const hasPermissionPrompt =
          /Doyouwantto(proceed|makethisedit|use)/i.test(bufNoSpace) ||
          /Yes,allow/i.test(bufNoSpace) ||
          /Claudewantsto(fetch|search|call)/i.test(bufNoSpace);
        if (hasPermissionPrompt) {
          if (session.autoYesPending) clearTimeout(session.autoYesPending);
          session.autoYesPending = setTimeout(() => {
            session.autoYesPending = null;
            if (session.exited || !session.autoYes) return;
            // Clean up prompt text for display: re-insert spaces around known words
            const cleanBuf = buf
              .replace(/[^\x20-\x7E\n]/g, ' ')  // remove non-printable chars
              .replace(/\s+/g, ' ').trim();
            // Extract a meaningful description from the buffer
            const noSpace = cleanBuf.replace(/\s/g, '');
            let promptLine = 'permission prompt';
            const editMatch = noSpace.match(/makethiseditto\s*(\S+)/i);
            const fetchMatch = noSpace.match(/Claudewantstofetchcontentfrom\s*(\S+)/i);
            const searchMatch = noSpace.match(/Claudewantstosearchthewebfor:\s*(.+?)(?:\}|$)/i);
            if (editMatch) {
              promptLine = `Edit: ${editMatch[1]}`;
            } else if (fetchMatch) {
              promptLine = `Fetch: ${fetchMatch[1]}`;
            } else if (searchMatch) {
              promptLine = `Web Search: ${searchMatch[1]}`;
            } else if (/Doyouwanttoproceed/i.test(noSpace)) {
              // Try to find tool name from nearby text like "Bash(...)" or "Read(...)"
              const toolMatch = noSpace.match(/(Bash|Read|Write|Edit|Glob|Grep|WebFetch|WebSearch|NotebookEdit)\(/i);
              promptLine = toolMatch ? `${toolMatch[1]} (auto-approved)` : 'Tool use (auto-approved)';
            } else {
              promptLine = cleanBuf.slice(0, 80) || 'permission prompt';
            }
            const entry = { time: Date.now(), prompt: promptLine };
            session.autoYesLog.push(entry);
            if (session.autoYesLog.length > 100) session.autoYesLog.shift();
            // Reset buffer after responding — prevents re-matching old prompts
            session.autoYesBuf = '';
            // Send Enter key — default-focused option is "Yes"
            session.ptyProcess.write('\r');
            if (session.socket && session.socket.readyState === 1) {
              session.socket.send(JSON.stringify({ type: 'auto_yes', entry }));
            }
          }, 500);
        }
      }
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    session.exited = true;
    session.exitCode = exitCode;
    session.exitSignal = signal;
    if (!session.shell) {
      session.claudeSessionId = extractClaudeSessionId(session.outputBuffer);
    }

    // Keep any pending scheduled prompt alive across this exit: refresh its
    // resume id and detach it so it auto-resumes the conversation at fire time.
    refreshScheduleOnExit(session);

    if (session.socket && session.socket.readyState === 1) {
      session.socket.send(JSON.stringify({
        type: 'exit',
        exitCode,
        signal,
        claudeSessionId: session.claudeSessionId,
      }));
    }

    if (!session.socket) {
      startTimeout(session, SESSION_EXITED_TIMEOUT_MS);
    }
  });

  sessions.set(id, session);
  return { sessionId: id, session };
}

export function getSession(id) {
  return sessions.get(id);
}

const MAX_SCHEDULE_AHEAD_MS = 48 * 60 * 60 * 1000; // 48h

// The server's IANA timezone (e.g. "Asia/Tokyo"). Claude Code prints its
// rate-limit reset times in this zone, so scheduling is interpreted here too.
let SERVER_TZ = 'UTC';
try {
  SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
} catch {
  // keep UTC fallback
}

export function getServerTimeInfo() {
  return { tz: SERVER_TZ, now: Date.now() };
}

// Convert an "HH:MM" wall-clock time in the SERVER's local timezone into the
// next matching absolute epoch (today if still ahead, otherwise tomorrow).
export function computeNextLocalTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime();
}

// Fire missed prompts up to this late after a restart; older ones are dropped.
const SCHEDULE_STALE_GRACE_MS = 12 * 60 * 60 * 1000; // 12h
// Safety net for delivering into a freshly-resumed session that never goes idle.
const RESUME_INJECT_FALLBACK_MS = 15 * 1000;

// scheduleId -> { at, text, cwd, sandbox, shell, claudeSessionId, sessionId, timer }
// The source of truth for scheduled prompts. Mirrored to disk so schedules
// survive a server restart/crash (see persistSchedules/restoreSchedules).
const schedules = new Map();

function persistSchedules() {
  try {
    const arr = [];
    for (const s of schedules.values()) {
      arr.push({
        at: s.at,
        text: s.text,
        cwd: s.cwd,
        sandbox: !!s.sandbox,
        shell: !!s.shell,
        claudeSessionId: s.claudeSessionId || null,
      });
    }
    if (arr.length > 0) {
      writeFileSync(SCHEDULES_PATH, JSON.stringify(arr));
    } else {
      try { unlinkSync(SCHEDULES_PATH); } catch { /* nothing to remove */ }
    }
  } catch {
    // best effort — persistence must never crash the session manager
  }
}

// Best-known Claude conversation id for resuming this session later.
function resumeIdForSession(session) {
  if (!session) return null;
  if (session.claudeSessionId) return session.claudeSessionId;
  const extracted = extractClaudeSessionId(session.outputBuffer);
  if (extracted) return extracted;
  return session.startedClaudeSessionId || null;
}

function scheduleForSession(sessionId) {
  for (const [sid, s] of schedules) {
    if (s.sessionId === sessionId) return sid;
  }
  return null;
}

// Public (serializable) view of a session's scheduled prompt
export function scheduledPromptPublic(session) {
  if (!session?.scheduleId) return null;
  const s = schedules.get(session.scheduleId);
  return s ? { at: s.at, text: s.text } : null;
}

// Detach the schedule from a session that's going away, but keep it armed so it
// auto-resumes the conversation at fire time.
function detachScheduleFromSession(sessionId) {
  const sid = scheduleForSession(sessionId);
  if (sid == null) return;
  const s = schedules.get(sid);
  if (s) s.sessionId = null;
  const session = sessions.get(sessionId);
  if (session) session.scheduleId = null;
}

function refreshScheduleOnExit(session) {
  const sid = scheduleForSession(session.id);
  if (sid == null) return;
  const s = schedules.get(sid);
  if (!s) return;
  const freshId = resumeIdForSession(session);
  if (freshId) s.claudeSessionId = freshId;
  s.sessionId = null; // the pty is gone; force the resume path at fire time
  session.scheduleId = null;
  persistSchedules();
}

function injectIntoLiveSession(session, text) {
  try {
    // Type the prompt text, then submit with Enter after a short delay so the
    // TUI registers the input before the newline is sent.
    session.ptyProcess.write(text);
    setTimeout(() => {
      if (!session.exited && session.ptyProcess) {
        try {
          session.ptyProcess.write('\r');
        } catch {
          // pty may have died between writes
        }
      }
    }, 200);
    return true;
  } catch {
    return false;
  }
}

function notifyFired(session, info, delivered) {
  if (session?.socket && session.socket.readyState === 1) {
    session.socket.send(JSON.stringify({
      type: 'schedule_fired',
      at: info.at,
      text: info.text,
      delivered,
    }));
    session.socket.send(JSON.stringify({ type: 'schedule_state', scheduled: null }));
  }
}

function fireSchedule(scheduleId) {
  const entry = schedules.get(scheduleId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  schedules.delete(scheduleId);
  persistSchedules();

  // 1) The originating session, if still alive.
  let target = entry.sessionId ? sessions.get(entry.sessionId) : null;
  if (target && (target.exited || !target.ptyProcess)) target = null;

  // 2) Otherwise any live session for the same project (user reopened it).
  if (!target) {
    for (const s of sessions.values()) {
      if (!s.exited && s.ptyProcess && s.cwd === entry.cwd && s.shell === entry.shell) {
        target = s;
        break;
      }
    }
  }

  if (target) {
    if (target.scheduleId === scheduleId) target.scheduleId = null;
    const delivered = injectIntoLiveSession(target, entry.text);
    notifyFired(target, entry, delivered);
    return;
  }

  // 3) No live session — auto-resume the conversation, then inject once ready.
  const res = createSession({
    cwd: entry.cwd,
    cols: 80,
    rows: 24,
    claudeSessionId: entry.claudeSessionId,
    shell: entry.shell,
    sandbox: entry.sandbox,
  });
  if (!res?.session) return;
  const session = res.session;
  session.pendingInjection = { text: entry.text, at: entry.at };
  // Safety net: deliver even if the session never emits an idle gap (e.g. a
  // plain shell). The idle path normally fires first for Claude sessions.
  setTimeout(() => {
    if (session.exited || !session.pendingInjection) return;
    const inj = session.pendingInjection;
    session.pendingInjection = null;
    const delivered = injectIntoLiveSession(session, inj.text);
    notifyFired(session, inj, delivered);
  }, RESUME_INJECT_FALLBACK_MS);
}

// Schedule a prompt to be injected at absolute epoch `at`. Returns the public
// view on success, or null if the time is invalid (past / too far ahead).
export function setScheduledPrompt(id, at, text) {
  const session = sessions.get(id);
  if (!session) return null;

  const delay = at - Date.now();
  if (!Number.isFinite(at) || delay <= 0 || delay > MAX_SCHEDULE_AHEAD_MS) {
    return null;
  }
  if (typeof text !== 'string' || text.length === 0) return null;

  // Replace any existing schedule for this session.
  cancelScheduledPrompt(id);

  const scheduleId = randomUUID();
  const entry = {
    at,
    text,
    cwd: session.cwd,
    sandbox: !!session.sandbox,
    shell: !!session.shell,
    claudeSessionId: resumeIdForSession(session),
    sessionId: id,
    timer: setTimeout(() => fireSchedule(scheduleId), delay),
  };
  schedules.set(scheduleId, entry);
  session.scheduleId = scheduleId;
  persistSchedules();
  return { at, text };
}

export function cancelScheduledPrompt(id) {
  const sid = scheduleForSession(id);
  if (sid == null) return;
  const s = schedules.get(sid);
  if (s?.timer) clearTimeout(s.timer);
  schedules.delete(sid);
  const session = sessions.get(id);
  if (session) session.scheduleId = null;
  persistSchedules();
}

// Re-arm persisted schedules on server startup. Future ones get a fresh timer;
// ones missed while the server was down fire shortly after startup (unless too
// stale). No session is spawned now — that happens lazily at fire time.
export function restoreSchedules() {
  let arr;
  try {
    arr = JSON.parse(readFileSync(SCHEDULES_PATH, 'utf-8'));
  } catch {
    return; // no file / unreadable
  }
  if (!Array.isArray(arr)) return;

  const now = Date.now();
  let restored = 0;
  let missed = 0;
  for (const e of arr) {
    if (!e || typeof e.text !== 'string' || !Number.isFinite(e.at)) continue;
    if (e.at > now + MAX_SCHEDULE_AHEAD_MS) continue; // implausibly far ahead

    const delay = e.at - now;
    if (delay <= 0 && now - e.at > SCHEDULE_STALE_GRACE_MS) continue; // too old, drop

    const scheduleId = randomUUID();
    const entry = {
      at: e.at,
      text: e.text,
      cwd: e.cwd,
      sandbox: !!e.sandbox,
      shell: !!e.shell,
      claudeSessionId: e.claudeSessionId || null,
      sessionId: null,
      timer: null,
    };
    // Missed schedules fire a few seconds after startup so the server can finish
    // booting; future ones fire at their time.
    const fireIn = delay <= 0 ? 3000 : delay;
    entry.timer = setTimeout(() => fireSchedule(scheduleId), fireIn);
    schedules.set(scheduleId, entry);
    restored++;
    if (delay <= 0) missed++;
  }
  persistSchedules(); // rewrite the pruned set
  return { restored, missed };
}

export function listSessions() {
  const result = [];
  for (const [id, session] of sessions) {
    if (session.exited) continue;
    result.push({
      id,
      cwd: session.cwd,
      connected: session.socket !== null,
      shell: session.shell,
      sandbox: session.sandbox,
    });
  }
  return result;
}

export function attachSocket(id, socket) {
  const session = sessions.get(id);
  if (!session) return false;

  if (session.timeoutTimer) {
    clearTimeout(session.timeoutTimer);
    session.timeoutTimer = null;
  }

  if (session.socket && session.socket !== socket) {
    try {
      session.socket.send(
        JSON.stringify({ type: 'detached', reason: 'replaced' })
      );
      session.socket.close(4001, 'Replaced by new client');
    } catch {
      // old socket may already be closed
    }
  }

  session.socket = socket;
  return true;
}

export function detachSocket(id, socketToDetach) {
  const session = sessions.get(id);
  if (!session) return;

  if (socketToDetach && session.socket !== socketToDetach) return;

  session.socket = null;

  const timeout = session.exited
    ? SESSION_EXITED_TIMEOUT_MS
    : SESSION_TIMEOUT_MS;
  startTimeout(session, timeout);
}

export function destroySession(id, { keepSchedule = true } = {}) {
  const session = sessions.get(id);
  if (!session) return;

  if (session.timeoutTimer) {
    clearTimeout(session.timeoutTimer);
    session.timeoutTimer = null;
  }

  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  // By default the scheduled prompt outlives the session (disconnect / idle
  // timeout / shutdown) and auto-resumes at fire time. Only an explicit
  // user-initiated teardown cancels it.
  if (keepSchedule) {
    detachScheduleFromSession(id);
  } else {
    cancelScheduledPrompt(id);
  }

  if (!session.exited) {
    try {
      session.ptyProcess.kill();
    } catch {
      // already dead
    }
  }

  // Remove the sandbox's unique rootlesskit state dir. The --unshare-pid tree is
  // torn down by the kill above (kernel reaps dockerd with the namespace); this
  // just clears the leftover socket dir under /run. Best effort — the dir is
  // unique per launch, so a stale one never blocks a future sandbox anyway.
  if (session.sandboxStateDir) {
    try {
      rmSync(session.sandboxStateDir, { recursive: true, force: true });
    } catch {
      // nothing to remove / still held — harmless
    }
  }

  sessions.delete(id);
}

export function destroyAllSessions() {
  for (const [id] of sessions) {
    destroySession(id);
  }
}

export function gracefulShutdown() {
  return new Promise((resolve) => {
    const pendingSessions = [];

    for (const [, session] of sessions) {
      if (!session.exited) {
        pendingSessions.push(session);
        try {
          session.ptyProcess.kill();
        } catch {
          // already dead
        }
      }
    }

    const finish = () => {
      const savedSessions = [];
      for (const [, session] of sessions) {
        const claudeId = session.claudeSessionId
          || extractClaudeSessionId(session.outputBuffer);
        if (claudeId) {
          savedSessions.push({
            cwd: session.cwd,
            claudeSessionId: claudeId,
            sandbox: !!session.sandbox,
          });
        }
      }

      if (savedSessions.length > 0) {
        try {
          writeFileSync(SAVED_SESSIONS_PATH, JSON.stringify(savedSessions));
        } catch {
          // best effort
        }
      }

      destroyAllSessions();
      resolve();
    };

    if (pendingSessions.length === 0) {
      finish();
      return;
    }

    // Wait up to 3 seconds for processes to exit
    let done = false;
    const interval = setInterval(() => {
      if (done) return;
      if (pendingSessions.every((s) => s.exited)) {
        done = true;
        clearInterval(interval);
        finish();
      }
    }, 100);

    setTimeout(() => {
      if (!done) {
        done = true;
        clearInterval(interval);
        finish();
      }
    }, 3000);
  });
}

let savedSessionsCache = null;

export function removeSavedSession(index) {
  const list = loadSavedSessions();
  if (index < 0 || index >= list.length) return false;
  list.splice(index, 1);
  return true;
}

export function loadSavedSessions() {
  if (savedSessionsCache !== null) return savedSessionsCache;
  try {
    const data = readFileSync(SAVED_SESSIONS_PATH, 'utf-8');
    unlinkSync(SAVED_SESSIONS_PATH);
    savedSessionsCache = JSON.parse(data);
    return savedSessionsCache;
  } catch {
    savedSessionsCache = [];
    return [];
  }
}

function appendToBuffer(session, data) {
  session.outputBuffer.push(data);
  session.bufferSize += data.length;

  while (session.bufferSize > OUTPUT_BUFFER_MAX_BYTES && session.outputBuffer.length > 0) {
    const removed = session.outputBuffer.shift();
    session.bufferSize -= removed.length;
  }
}

function startTimeout(session, ms) {
  if (session.timeoutTimer) {
    clearTimeout(session.timeoutTimer);
  }

  session.timeoutTimer = setTimeout(() => {
    destroySession(session.id);
  }, ms);
}
