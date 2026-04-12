import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAVED_SESSIONS_PATH = join(__dirname, '..', '..', '.saved-sessions.json');

const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours for active sessions
const SESSION_EXITED_TIMEOUT_MS = 30 * 1000;
const OUTPUT_BUFFER_MAX_BYTES = 512 * 1024;
const IDLE_TIMEOUT_MS = 3000;

const sessions = new Map();

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

export function createSession({ cwd, cols, rows, claudeSessionId, shell }) {
  const id = randomUUID();

  const { SSH_AUTH_SOCK, SSH_AGENT_PID, ...cleanEnv } = process.env;

  let command, args;
  if (shell) {
    command = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
    args = [];
  } else {
    command = process.platform === 'win32' ? 'claude.exe' : 'claude';
    args = claudeSessionId ? ['--resume', claudeSessionId] : [];
  }

  const ptyProcess = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...cleanEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '1',
    },
  });

  const session = {
    id,
    cwd,
    shell: !!shell,
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
        if (!session.exited && !session.idleNotified) {
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

export function listSessions() {
  const result = [];
  for (const [id, session] of sessions) {
    if (session.exited) continue;
    result.push({
      id,
      cwd: session.cwd,
      connected: session.socket !== null,
      shell: session.shell,
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

export function destroySession(id) {
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

  if (!session.exited) {
    try {
      session.ptyProcess.kill();
    } catch {
      // already dead
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
