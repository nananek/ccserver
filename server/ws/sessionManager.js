import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSandboxSpawn, resolveApp, sandboxAvailable, sandboxBackend, sandboxUnavailableReason, forceSandboxUnavailableReason, loadSandboxConfig, persistentHomeDir, dockerSandboxAvailable, dockerdStatus, dockerdLockHeld, resolveTools } from './sandbox.js';
import { releaseSeatbeltOverlay } from './sandbox-seatbelt.js';
import { getGroupFilesDir, ensureGroupFilesDir } from './groupFiles.js';
import { buildMcpConfigArgsAndEnv } from './mcpConfig.js';
import { shouldInjectNotify, notifyEnabled, getNotifySockPath, notifyBrokerRunning } from './notify.js';
import { shouldInjectUsage, usageEnabled, getUsageSockPath, usageBrokerRunning } from './usageMcp.js';
import { shouldInjectMetaAgent, metaAgentEnabled, getMetaSockPath, metaBrokerRunning, ensureMetaAgentDir } from './metaAgent.js';
import { shouldInjectReviewer, reviewerEnabled, getReviewerSockPath, reviewerBrokerRunning } from './reviewer.js';
import { createScreenModel, SCREEN_ROWS } from './screenModel.js';
import { bunTmpdirEnv } from './bunTmpdir.js';
import { buildSessionEnv } from './sessionEnv.js';
import {
  isValidApp,
  appLaunchArgs,
  normalizePermissionMode,
  appSubmitKey,
  extractResumeSessionId,
  detectPermissionPrompt,
} from './appLaunch.js';
import { stripAnsi } from './mcpTools.js';
import { findSessionLimitReset } from './sessionLimitDetect.js';
import { recordSessionLimitReset } from '../sessionLimitState.js';
import { getPtyHostClient, getAllPtyHostClients, shardIndexForKey, shardKeyForSession, isPtyHostEnabled } from './ptyHostClient.js';
import { setPtyHostSessionMeta, patchPtyHostSessionMeta, deletePtyHostSessionMeta, loadPtyHostSessionMeta } from './ptyHostSessionMeta.js';
import {
  parseTimeoutEnv,
  DEFAULT_SESSION_TIMEOUT_MS,
  DEFAULT_SESSION_EXITED_TIMEOUT_MS,
  MIN_SESSION_EXITED_TIMEOUT_MS,
} from '../timeoutEnv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAVED_SESSIONS_PATH = process.env.CCSERVER_SAVED_SESSIONS_PATH || join(__dirname, '..', '..', '.saved-sessions.json');
const SCHEDULES_PATH = join(__dirname, '..', '..', '.scheduled-prompts.json');

const OUTPUT_BUFFER_MAX_BYTES = 512 * 1024;
const IDLE_TIMEOUT_MS = 3000;
// PTY size negotiation floor. The pty is sized to the SMALLEST viewport among
// the attached clients, so a single client reporting a degenerate size would
// otherwise collapse the pty for everyone.
const MIN_PTY_COLS = 2;
const MIN_PTY_ROWS = 1;

// Both timeouts are operator-tunable. Parsed once at module load (env changes
// mid-process are not a supported scenario) but exported as functions so the
// parsing rules themselves stay directly testable.

// Idle (no viewer attached) destroy timeout. 0 or negative disables it
// entirely -- the session then lives until the pty exits or someone tears it
// down explicitly.
export function resolveSessionTimeoutMs(env = process.env) {
  return parseTimeoutEnv(env.CCSERVER_SESSION_TIMEOUT_MS, {
    name: 'CCSERVER_SESSION_TIMEOUT_MS',
    fallback: DEFAULT_SESSION_TIMEOUT_MS,
    min: 0,
    logPrefix: '[session]',
  });
}

// Cleanup delay after the pty has exited. Never disabled: an exited session
// has no process left, and keeping it forever would fill the session list
// with rows that can never be attached to again.
export function resolveExitedTimeoutMs(env = process.env) {
  return parseTimeoutEnv(env.CCSERVER_SESSION_EXITED_TIMEOUT_MS, {
    name: 'CCSERVER_SESSION_EXITED_TIMEOUT_MS',
    fallback: DEFAULT_SESSION_EXITED_TIMEOUT_MS,
    min: MIN_SESSION_EXITED_TIMEOUT_MS,
    logPrefix: '[session]',
  });
}

const SESSION_TIMEOUT_MS = resolveSessionTimeoutMs();
const SESSION_EXITED_TIMEOUT_MS = resolveExitedTimeoutMs();

const sessions = new Map();

// Observers of session exits (pty terminated, for any reason: normal exit,
// user teardown, group destroy) and of session creations. Used by
// groupManager to stop MCP brokers of dying sessions and to re-bind roles
// when a member session is (re)created outside the explicit launch paths
// (e.g. a scheduled prompt auto-resuming a group member). Runtime-only -- no
// module init cycles.
const sessionExitListeners = new Set();
const sessionCreateListeners = new Set();

export function setSessionExitListener(fn) {
  sessionExitListeners.add(fn);
}

export function setSessionCreateListener(fn) {
  sessionCreateListeners.add(fn);
}

// Resolvers of the MCP socket a group member session should be launched with.
// groupManager registers one: it (re)creates the member's handoff channel (or
// the orchestrator's control broker) and returns { sockPath, token }. Used by
// the scheduled-prompt auto-resume path, where a group member's session is
// recreated outside the explicit launch flows.
const mcpSocketResolvers = new Set();

export function setMcpSocketResolver(fn) {
  mcpSocketResolvers.add(fn);
}

// Resolve the MCP socket for a group member being recreated: returns
// { sockPath, token } (token gates the socket -- see mcpBroker.js), or null
// when no resolver can produce one (group gone, broker failed, or not a group
// member) -- the caller then launches without MCP injection.
export async function resolveMcpSocketForSession(groupId, groupRole) {
  for (const fn of mcpSocketResolvers) {
    try {
      const resolved = await fn(groupId, groupRole);
      // Back-compat: a resolver may still return a bare sockPath string.
      if (typeof resolved === 'string' && resolved) return { sockPath: resolved, token: null };
      if (resolved && resolved.sockPath) return { sockPath: resolved.sockPath, token: resolved.token || null };
    } catch {
      // try the next resolver
    }
  }
  return null;
}

// Resolvers of the orchestrator's freshly generated CLAUDE.md/AGENTS.md
// source path (template + saved per-project instructions, merged host-side
// on every launch). groupManager registers one (generateOrchestratorClaudeMdSrc)
// -- same resolver-registration pattern as mcpSocketResolvers above, needed
// for the same reason: the scheduled-prompt auto-resume path lives here and
// cannot import groupManager.js (circular import).
const orchestratorClaudeMdResolvers = new Set();

export function setOrchestratorClaudeMdResolver(fn) {
  orchestratorClaudeMdResolvers.add(fn);
}

// Resolve the host path of the orchestrator's generated CLAUDE.md/AGENTS.md
// overlay. Resolves to null when no resolver can produce one (group gone) --
// the caller then treats this the same as an unresolvable mcpSocketPath.
export async function resolveOrchestratorClaudeMdSrc(groupId) {
  for (const fn of orchestratorClaudeMdResolvers) {
    try {
      const src = await fn(groupId);
      if (src) return src;
    } catch {
      // try the next resolver
    }
  }
  return null;
}

// Resolvers of a group member's launch cwd + git-common-dir sandbox bind:
// worker roles get their own git worktree (resolved/recreated fresh on
// every (re)spawn, see worktree.js), the orchestrator gets its stable
// orchestratorDir. groupManager registers one (resolveMemberLaunchCwd) --
// same resolver-registration pattern as the two above, and for the same
// reason: this auto-resume path cannot import groupManager.js (circular
// import).
const memberCwdResolvers = new Set();

export function setMemberCwdResolver(fn) {
  memberCwdResolvers.add(fn);
}

// Resolve { cwd, gitCommonDir } for a group member being (re)spawned.
// Resolves to null when no resolver can produce one (group gone, or
// worktree resolution itself failed) -- the caller must refuse the spawn
// rather than fall back to a stale/blind cwd.
export async function resolveMemberCwdForSession(groupId, groupRole) {
  for (const fn of memberCwdResolvers) {
    try {
      const result = await fn(groupId, groupRole);
      if (result) return result;
    } catch {
      // try the next resolver
    }
  }
  return null;
}

function resolveCommand(cmd) {
  if (process.platform !== 'win32') return cmd;
  try {
    return execFileSync('where.exe', [cmd], { encoding: 'utf-8' }).split('\r\n')[0].trim();
  } catch {
    return cmd;
  }
}

function extractResumeId(session) {
  return extractResumeSessionId(session.app, session.outputBuffer.slice(-50).join(''));
}

// Prefixes marking a createSession() failure as a server-side infrastructure
// fault rather than a rejection of the request as given. Exported so HTTP
// layers (routes/groups.js) classify without re-typing the strings.
export const INFRA_ERROR_PREFIXES = ['Failed to build sandbox', 'Failed to spawn', 'Cannot launch: sandbox.config.json sets "forceSandbox"'];

/**
 * Whether a createSession() error message reports infrastructure failure
 * (sandbox build / process spawn) as opposed to a bad request.
 * @param {string} msg Error message from createSession().
 * @returns {boolean}
 */
export function isInfrastructureError(msg) {
  return INFRA_ERROR_PREFIXES.some((p) => String(msg || '').startsWith(p));
}

// Model normalization for storage/serialization: `model` is an optional
// non-empty string, or explicit null meaning "use the app default model". Any
// other value (empty string, wrong type) is coerced to null so an invalid
// value can never leak into persistence or the CLI arg builder.
function normalizeModel(model) {
  return typeof model === 'string' && model.length > 0 ? model : null;
}

// Builds the `session` record and wires its ptyProcess onData/onExit
// listeners -- the exact same construction both createSession() (a freshly
// spawned or pty-host-spawned ptyProcess) and restorePtyHostSessions() (plan5
// Step3: a ptyProcess re-attached to an already-running pty-host session via
// PtyHostClient.attach()) need, registers it in `sessions`, and fires
// sessionCreateListeners. Factored out so the restore path can produce a
// session indistinguishable from one createSession() itself just launched --
// AutoYes / session-limit detection / screenModel / outputBuffer accumulation
// must all behave identically regardless of which path built the record.
//
// `meta.settled` defaults to false (a freshly launched TUI is still mid
// init-burst); restorePtyHostSessions() passes true -- a session being
// reattached to is by definition not in that initial burst any more.
function buildSessionRecord(id, ptyProcess, meta) {
  const session = {
    id,
    cwd: meta.cwd,
    shell: !!meta.shell,
    app: meta.app,
    model: meta.model,
    permissionMode: meta.permissionMode,
    groupId: meta.groupId,
    groupRole: meta.groupRole,
    // Operator-assigned display name (null = none; the UI falls back to the
    // directory basename). Set post-launch via setSessionLabel (PATCH
    // /api/sessions/:id), never from launch input -- launch bodies are
    // forwarded nearly as-is across trust boundaries (REST, MCP, federation),
    // so a display string must not ride along with them.
    customLabel: normalizeCustomLabel(meta.customLabel),
    // True only for sessions launched with the explicit isMetaAgent flag (the
    // privileged self-management agent). Display/debug bookkeeping -- the
    // authorization boundary is the meta broker socket, not this flag.
    isMetaAgent: !!meta.isMetaAgent,
    sandbox: !!meta.sandbox,
    sandboxOpts: meta.sandbox ? (meta.sandboxOpts || null) : null, // per-launch gpg/sshAgent override, for schedule/resume replay
    docker: !!meta.docker, // whether THIS session's sandbox launched with docker (see dockerAvailability)
    dockerTag: meta.docker && meta.sandboxStateDir ? basename(meta.sandboxStateDir) : null, // matches CCSANDBOX_DOCKERD_TAG (sandbox.js), identifies this session's dockerd in the status file
    sandboxStateDir: meta.sandboxStateDir ?? null, // rootlesskit state dir to remove on teardown (docker only)
    sandboxGitBrokerProc: meta.sandboxGitBrokerProc ?? null, // host-side git-broker child process, killed on teardown
    sandboxGitBrokerDir: meta.sandboxGitBrokerDir ?? null, // its runtime dir (socket + allow-list), removed on teardown
    sandboxCommitGuardDir: meta.sandboxCommitGuardDir ?? null, // commit-msg guard's runtime dir (config json only, no process), removed on teardown
    sandboxSeatbeltDir: meta.sandboxSeatbeltDir ?? null, // seatbelt profile/shim runtime dir (macOS only), removed on teardown
    sandboxSeatbeltFiles: meta.sandboxSeatbeltFiles ?? null, // orchestrator rule copies in the project dir (macOS only), unlinked on teardown
    reuseSandboxHome: meta.reuseSandboxHome, // true = keep the previous persistent HOME, false = started fresh (wiped)
    // Plan5 Step5: which pty-host instance this session's pty actually lives
    // on. Decided once at creation (createSession()'s usePtyHost branch) and
    // never recomputed -- see ptyHostClient.js's shardIndexForKey() header
    // comment on why reshuffling on every call would be wrong. null outside
    // usePtyHost mode. Callers pass the already-resolved value (createSession
    // passes null for direct-spawn sessions, restorePtyHostSessions()
    // resolves a pre-Step5 restore-metadata entry's missing shardIndex to 0
    // -- see its own comment), so this is a plain readthrough.
    ptyHostShardIndex: meta.shardIndex ?? null,
    ptyProcess,
    // Every attached viewer, mapped to the viewport it last reported. A
    // session is shared: opening it from a second device adds a socket here
    // instead of evicting the first (see attachSocket). The viewport values
    // feed negotiateSize -- the pty is sized to the smallest of them.
    sockets: new Map(),
    outputBuffer: [],
    bufferSize: 0,
    cols: meta.cols,
    rows: meta.rows,
    createdAt: Date.now(), // for the uptime figure in the teardown log
    exited: false,
    exitCode: null,
    exitSignal: null,
    timeoutTimer: null,
    claudeSessionId: null,
    idleTimer: null,
    settled: !!meta.settled, // reached the first idle gap (TUI init burst over) -- the send_input settle gate
    settleWaiters: [], // resolvers waiting on `settled` (see waitUntilSettled)
    lastOutputAt: null, // epoch ms of the most recent output chunk; null until the first one (activity timestamp, Issue #16)
    // Workers (groupRole in 'workerX' form) always run inside the sandbox, so
    // start them with Auto-Y enabled. The orchestrator (groupRole ===
    // 'orchestrator') and standalone sessions (groupRole === null) keep the
    // historical off default. groupRole is already validated server-side
    // (WORKER_ROLE_RE in groupManager), so "anything but the fixed
    // 'orchestrator' string is a worker" is a safe check here.
    autoYes: !!meta.groupRole && meta.groupRole !== 'orchestrator',
    autoYesLog: [],
    autoYesPending: null,
    autoYesBuf: '',
    // Session-limit auto-resume detection (see sessionLimitDetect.js).
    // limitDetectBuf holds a sliding window of RAW bytes, not yet
    // ANSI-stripped: a pty chunk boundary can split an escape sequence
    // mid-sequence, and stripping each chunk independently would leak the
    // tail of a split sequence as bare control bytes. Accumulating raw
    // bytes and stripping the whole window each time lets the next chunk's
    // arrival complete a sequence the previous chunk left dangling.
    // lastAutoLimitResetAt is the resetAtMs already scheduled for, so a TUI
    // redraw of the same status line doesn't re-arm the schedule every chunk.
    limitDetectBuf: '',
    lastAutoLimitResetAt: null,
    startedClaudeSessionId: meta.startedClaudeSessionId ?? null,
    // Issue #119 Step6: same sliding-window pattern as limitDetectBuf above,
    // but for continuously tracking the most recent `claude --resume <id>`
    // hint a live claude session prints (extractResumeSessionId, appLaunch.js)
    // -- unlike session.claudeSessionId (only ever set once, from onExit,
    // after the process has already died), this stays current WHILE the
    // session is still running, so pty-host's own crash-recovery auto-resume
    // (server/pty-host/index.js) can relaunch with the actual latest id
    // instead of falling back to an ambiguous resumeLast. Seeded from
    // meta.startedClaudeSessionId (not null): if this launch itself already
    // knew an accurate id (a manual resume) and the pty dies before ever
    // printing a NEW hint, that id is still the best known value, not
    // "nothing detected yet". Only tracked/written back for app==='claude'
    // (see the onData handler below) -- every other app's
    // extractResumeSessionId always returns null (see appLaunch.js), so
    // there is nothing to track for them.
    lastKnownResumeId: meta.startedClaudeSessionId ?? null,
    resumeIdDetectBuf: '',
    resumeIdWriteTimer: null,
    resumeIdLastWriteAt: 0,
    scheduleId: null, // key into the module-level `schedules` map, if any
    pendingInjection: null, // { text, at } — scheduled prompt awaiting a freshly-resumed session
    pendingInjectionTimer: null, // RESUME_INJECT_FALLBACK_MS safety net; cleared on teardown
    // Lightweight virtual screen (see screenModel.js): fed every output
    // chunk, exposing the current visible screen and a change counter so
    // read_output can tell "spinner still drawing" from "static screen".
    // screenLastChangeAt is stamped when the screen visibly changes (not on
    // every byte) -- the basis of read_output's screenIdleMs / get_tab_status.
    screen: createScreenModel({ cols: meta.cols, rows: SCREEN_ROWS }),
    screenLastChangeAt: null,
  };

  ptyProcess.onData((rawData) => {
    const data = rawData;
    // Activity timestamp: every output chunk counts, shells included (unlike
    // the agent-only idle detection below). Pure activity bookkeeping.
    session.lastOutputAt = Date.now();
    appendToBuffer(session, data);

    // Session-limit auto-resume detection -- role/app agnostic, applies to
    // every session per the plan (a shell session simply never matches).
    // See sessionLimitDetect.js for the regex/timezone-math and the
    // limitDetectBuf field above for why raw bytes are accumulated instead
    // of stripping each chunk independently.
    session.limitDetectBuf = (session.limitDetectBuf + data).slice(-LIMIT_DETECT_BUF_MAX_CHARS);
    const limitMatch = findSessionLimitReset(stripAnsi(session.limitDetectBuf));
    if (limitMatch && limitMatch.resetAtMs !== session.lastAutoLimitResetAt) {
      // Identify this limit event by its resetAtMs so the TUI redrawing the
      // same status line (which keeps re-matching every chunk) doesn't
      // re-arm the schedule on every redraw.
      session.lastAutoLimitResetAt = limitMatch.resetAtMs;
      // Independent of the auto-schedule lifecycle below (which can be
      // skipped when a manual schedule already exists) -- the scheduler
      // panel's default-time hint should still learn about this detection.
      recordSessionLimitReset({
        resetAtMs: limitMatch.resetAtMs,
        timeZone: limitMatch.timeZone,
        source: 'session-output',
      });
      const existingSid = scheduleForSession(session.id);
      const existing = existingSid ? schedules.get(existingSid) : null;
      // A manual schedule (set via the browser's clock panel) is never
      // clobbered by the auto-detector, even if it looks stale relative to
      // the new reset time -- the user's explicit intent wins. An existing
      // 'auto-session-limit' schedule is safe to replace with this fresher
      // detection (normally unreachable here, since the resetAtMs guard
      // above already filters out same-event redraws).
      if (!existing || existing.source === 'auto-session-limit') {
        const scheduled = setScheduledPrompt(
          session.id,
          limitMatch.resetAtMs + SESSION_LIMIT_RESUME_DELAY_MS,
          SESSION_LIMIT_RESUME_MESSAGE,
          { source: 'auto-session-limit' },
        );
        if (scheduled) {
          notifyScheduleState(session);
        } else {
          console.warn(`[session-limit] could not auto-schedule a resume for session ${session.id} (reset ${new Date(limitMatch.resetAtMs).toISOString()})`);
        }
      } else {
        console.warn(`[session-limit] session ${session.id} hit its limit, but a manual schedule already exists -- not overriding it`);
      }
    }

    // Issue #119 Step6-0: continuously track claude's latest `--resume <id>`
    // hint (see lastKnownResumeId's field comment above) so pty-host's own
    // crash-recovery auto-resume has an accurate id, not just resumeLast.
    // Only worth the sliding-window bookkeeping when it can actually go
    // anywhere: usePtyHost gates the whole point (a direct-spawned session
    // dies with server本体 itself, same as before pty-host existed -- there is
    // no separate crash-recovery path for it to feed), and app==='claude'
    // gates the extraction itself (every other app's extractResumeSessionId
    // always returns null, see appLaunch.js).
    if (isPtyHostEnabled() && session.app === 'claude') {
      session.resumeIdDetectBuf = (session.resumeIdDetectBuf + data).slice(-RESUME_ID_DETECT_BUF_MAX_CHARS);
      // extractResumeSessionId does its own ANSI-stripping internally (unlike
      // findSessionLimitReset above), so the raw window is passed straight
      // through.
      const detected = extractResumeSessionId('claude', session.resumeIdDetectBuf);
      if (detected && detected !== session.lastKnownResumeId) {
        session.lastKnownResumeId = detected;
        scheduleResumeIdWriteback(session);
      }
    }

    // Keep the virtual screen model in parallel with the buffer: it only
    // stamps screenLastChangeAt when the visible screen actually changes,
    // so a spinner redrawing the same line registers as activity while a
    // byte flow that leaves the screen static does not.
    const screenVersion = session.screen.version();
    session.screen.feed(data);
    if (session.screen.version() !== screenVersion) {
      session.screenLastChangeAt = Date.now();
    }

    broadcast(session, { type: 'output', data });

    // Idle detection: reset timer on every output chunk (Claude sessions only)
    if (!session.shell) {
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
      }
      session.idleTimer = setTimeout(() => {
        if (session.exited) return;
        // The first idle gap means a freshly-launched TUI has finished its
        // initialization burst: mark the session settled and wake anyone
        // waiting on the settle gate (send_input's waitUntilSettled).
        if (!session.settled) {
          session.settled = true;
          const waiters = session.settleWaiters;
          session.settleWaiters = [];
          for (const w of waiters) w();
        }
        // A scheduled prompt may be waiting for this (freshly auto-resumed)
        // session to settle before typing its text. Deliver it once quiet.
        if (session.pendingInjection) {
          const inj = session.pendingInjection;
          session.pendingInjection = null;
          if (session.pendingInjectionTimer) {
            clearTimeout(session.pendingInjectionTimer);
            session.pendingInjectionTimer = null;
          }
          const delivered = injectIntoLiveSession(session, inj.text);
          notifyFired(session, { at: inj.at, text: inj.text }, delivered);
        }
      }, IDLE_TIMEOUT_MS);

      // Auto-yes detection for agent permission prompts. Claude uses Ink's
      // Select UI, opencode renders a "Permission required" box, and Codex
      // uses a numbered approval menu. Each selects its one-time approval by
      // default, so Enter is the shared response.
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
        const hasPermissionPrompt = detectPermissionPrompt(session.app, bufNoSpace);
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
            if (session.app === 'opencode' || session.app === 'copilot' || session.app === 'codex' || session.app === 'commandcode') {
              // Neither TUI's byte stream exposes which tool is being approved,
              // so the label stays generic (claude's does carry tool names).
              promptLine = 'Permission prompt (auto-approved)';
            } else {
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
            }
            const entry = { time: Date.now(), prompt: promptLine };
            session.autoYesLog.push(entry);
            if (session.autoYesLog.length > 100) session.autoYesLog.shift();
            // Reset buffer after responding — prevents re-matching old prompts
            session.autoYesBuf = '';
            // Send Enter key — default-focused option is "Yes"
            session.ptyProcess.write('\r');
            broadcast(session, { type: 'auto_yes', entry });
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
      session.claudeSessionId = extractResumeSessionId(
        session.app,
        session.outputBuffer.slice(-50).join('')
      );
    }

    // Keep any pending scheduled prompt alive across this exit: refresh its
    // resume id and detach it so it auto-resumes the conversation at fire time.
    refreshScheduleOnExit(session);

    // Issue #119 Step6-0: a debounced write-back pending when the pty exits
    // is the last chance to get it onto disk -- no more onData chunks will
    // ever arrive to trigger the next one, so anything still only in memory
    // at this point would otherwise be lost the moment server本体 itself
    // later restarts (or, for a pty-host-hosted session, is exactly the kind
    // of gap flushResumeIdWriteback's own callers already guard elsewhere --
    // see initPtyHostDisconnectedHandler below).
    if (session.resumeIdWriteTimer) flushResumeIdWriteback(session);

    for (const fn of sessionExitListeners) {
      try {
        fn(session);
      } catch {
        // a listener must never break the pty exit path
      }
    }

    // Until this landed nothing recorded WHY a session went away, so a pty
    // that died while the tab was closed was indistinguishable from a
    // server restart -- both just surfaced as SESSION_NOT_FOUND on the next
    // open. Log the exit itself, and see destroySession for the teardown.
    console.log(
      `[session] ${session.id} pty exited (code=${exitCode}, signal=${signal ?? 'none'}, `
      + `app=${session.app || (session.shell ? 'shell' : 'unknown')}, cwd=${session.cwd}, `
      + `viewers=${session.sockets.size}, uptime=${Date.now() - session.createdAt}ms)`
    );

    broadcast(session, {
      type: 'exit',
      exitCode,
      signal,
      claudeSessionId: session.claudeSessionId,
    });

    if (session.sockets.size === 0 && sessions.has(session.id)) {
      startTimeout(session, SESSION_EXITED_TIMEOUT_MS);
    }
  });

  sessions.set(id, session);

  for (const fn of sessionCreateListeners) {
    try {
      fn(session);
    } catch {
      // a listener must never break session creation
    }
  }

  return session;
}

export async function createSession({ cwd, cols, rows, claudeSessionId, shell, sandbox, sandboxOpts, app, model, permissionMode, resumeLast, groupId = null, groupRole = null, mcpSocketPath = null, mcpToken = null, projectName = null, reuseSandboxHome = true, orchestratorClaudeMdSrc = null, gitCommonDir = null, groupFilesDir = null, isMetaAgent = false, isReviewJob = false, sandboxHomeCreatedBy = null, customLabel = null }) {
  const id = randomUUID();
  // Read once and thread through: this hot path (every session launch) was
  // otherwise re-reading + re-parsing sandbox.config.json up to four times
  // (defaultApp, hiddenApps, forceSandbox, persistentHome) via separate
  // loadSandboxConfig() calls below.
  const cfg = loadSandboxConfig();

  // Invariant: meta-agent sessions (isMetaAgent:true, groupId-less) always
  // run in the fixed project-outside directory ~/.local/share/ccserver-
  // sandbox/meta-agent, regardless of the client-supplied cwd. This is a
  // safety force, NOT an authorization boundary -- even when metaAgentMcp is
  // off or the broker is not running we still force the cwd so a privileged
  // flag can never land the session inside a project (prompt-injection
  // material / bwrap rw-bind). Shells are included (no real caller sends
  // shell+isMetaAgent, but tests use it to verify with a real pty).
  if (isMetaAgent && !groupId) {
    cwd = ensureMetaAgentDir();
  }

  // claude (and likely opencode) aborts immediately (SIGABRT, exit 134, no
  // output at all) when launched with the filesystem root as cwd -- refuse
  // with a clear error instead of the opaque crash. Reachable via the
  // directory browser's own "/" fallback (used until the home-dir fetch
  // resolves, or if the user navigates all the way up and launches there),
  // not just automated/edge-case callers. Plain unsandboxed shells are
  // unaffected: plain /bin/bash starts fine at /.
  //
  // A SANDBOXED shell at / is refused too: the project subtree rule would
  // become "^/(/.*)?$" (seatbelt, see subtrees()) or a "/" bind (bwrap),
  // silently granting the whole filesystem -- a fail-open sandbox. Shell
  // sessions only run sandboxed under forceSandbox or an explicit per-launch
  // sandbox request, so the refusal is gated on those. The "would grant the
  // whole filesystem" wording only fits when a sandbox would actually be
  // built: `sandbox:true` on a host with no available backend (forceSandbox
  // off) constructs no sandbox, so the raw-flag check still refuses the launch
  // (a `/` cwd is invalid regardless of backend) but drops the counterfactual
  // clause from the message.
  if (cwd === '/' && (!shell || sandbox || cfg.forceSandbox)) {
    const wouldSandbox = process.platform !== 'win32' && sandboxAvailable();
    return {
      sessionId: id,
      session: null,
      error: !shell
        ? 'Cannot launch in the filesystem root (/) -- claude aborts immediately there. Choose a working directory first.'
        : wouldSandbox
          ? 'Cannot launch a sandboxed shell in the filesystem root (/) -- the sandbox would grant the whole filesystem. Choose a working directory first.'
          : 'Cannot launch a sandboxed shell in the filesystem root (/). Choose a working directory first.',
    };
  }

  // Which agent CLI this session runs. Shell sessions have no app.
  const sessionApp = shell ? null : (isValidApp(app) ? app : cfg.defaultApp);

  // Self-review (issue #105): sandbox.config.json's hiddenApps removes an app
  // from every launch picker client-side, but every picker ultimately funnels
  // its choice through this same createSession() (single launches, combo
  // workers/orchestrator, worker/launch-preset expansion, meta-agent). Without
  // a check here, hiding an app is purely cosmetic -- any client that sends
  // `app` directly (a hand-crafted WS/API call, a stale MCP preset, a worker
  // preset saved before the app was hidden) would still start a real session
  // for an app the operator hasn't contracted for. Refuse the same way the
  // not-installed check below does, rather than trusting every caller to have
  // re-checked hiddenApps itself. Checked BEFORE resolveApp() below: once an
  // app is hidden, whether it happens to be installed is irrelevant, and this
  // ordering means the refusal never depends on install detection.
  if (sessionApp && cfg.hiddenApps.includes(sessionApp)) {
    return {
      sessionId: id,
      session: null,
      error: `Cannot launch: ${sessionApp} is hidden on this server (sandbox.config.json's "hiddenApps"). Remove it from hiddenApps to allow launches.`,
    };
  }
  const resolved = sessionApp ? resolveApp(sessionApp) : null;

  // Refuse launches of an agent that doesn't exist on this host, instead of
  // letting node-pty fail with an opaque execvp/ENOENT error (exit 127) right
  // after the "起動しました" message. resolveApp's `found` covers every search
  // path (PATH, the server's node bin dir, ~/.local/bin, and the app-specific
  // extras) and honors the claudeBin override; the searched-dirs text mirrors
  // resolveAgentCommand's candidates. A defaultApp pointing at a missing
  // install is refused the same way: silently switching to another app would
  // start scheduled prompts / orchestrator restarts in an unintended agent.
  if (sessionApp && !resolved.found) {
    const searched = {
      claude: "PATH, the server's node bin directory, ~/.local/bin",
      opencode: "PATH, the server's node bin directory, ~/.local/bin, ~/.opencode/bin",
      copilot: "PATH, the server's node bin directory, ~/.local/bin",
      codex: "PATH, the server's node bin directory, ~/.local/bin",
      commandcode: "PATH, the server's node bin directory, ~/.local/bin, project .tools/bin",
    }[sessionApp];
    return {
      sessionId: id,
      session: null,
      error: `Cannot launch: ${sessionApp} is not installed on this server (searched ${searched}).`,
    };
  }
  // Which model this session launches with. Explicit null / absent means "use
  // the app's persisted-or-default model" (no --model flag is emitted); only a
  // non-empty string becomes a CLI model selection. Shells never carry one.
  const sessionModel = shell ? null : normalizeModel(model);
  // Permission mode for commandcode launches ('standard' by default -- no
  // flag; 'auto-accept' / 'yolo' add the corresponding CLI flag, see
  // appLaunch.js's appPermissionArgs). Unknown values normalize to
  // 'standard'. Shells and non-commandcode apps are forced to 'standard'
  // here too, not just left un-flagged by appPermissionArgs -- otherwise a
  // caller-supplied 'yolo'/'auto-accept' would sit in session.permissionMode
  // (surfaced via listSessions/savedSessionPublic/federation) and could
  // mislead a consumer that treats that field as an actual bypass signal.
  const sessionPermissionMode = (shell || sessionApp !== 'commandcode')
    ? 'standard'
    : normalizePermissionMode(permissionMode);

  // ccserver-notify injection (see notify.js): standalone agent sessions and
  // combo orchestrators get the process-global notify MCP server when the
  // feature is enabled (Discord webhook configured or subscriptions exist)
  // AND the broker is actually listening (it is started once at boot). The
  // broker-running check prevents injecting a dead socket path when the boot
  // startup failed, or when a config edit enables notify without a restart.
  // Shells and combo workers never do. The socket path is the process-global
  // one, created once at boot (ensureNotifyBroker).
  const useNotify = notifyBrokerRunning() && shouldInjectNotify({
    shell: !!shell,
    app: sessionApp,
    groupId,
    groupRole,
    notifyEnabled: notifyEnabled(),
  });
  const notifySocketPath = useNotify ? getNotifySockPath() : null;

  // Per-connection identity for ccserver-notify (see notify.js / mcpBroker.js):
  // rides to the bridge as CCSERVER_NOTIFY_IDENTITY and becomes the "_from:"
  // footer on this session's notifications. Attribution only -- never an
  // authorization input. projectName defaults to basename(cwd) (createSession
  // already refuses the filesystem root for agent sessions, so a meaningful
  // name exists); an explicit projectName wins when the session's cwd is not
  // the real project path (combo orchestrators run in a hashed orchestrator
  // dir -- see routes/groups.js).
  const notifyIdentity = useNotify ? {
    sessionId: id,
    groupId,
    groupRole,
    cwd,
    projectName: projectName ?? basename(cwd),
    app: sessionApp,
  } : null;

  // ccserver-usage injection (see usageMcp.js): every claude session (shells,
  // opencode and copilot excluded -- see shouldInjectUsage) gets the
  // process-global get_usage MCP tool when the feature is enabled (claude
  // installed AND usageMcp explicitly enabled) AND the broker is
  // actually listening. Unlike notify, worker/orchestrator/standalone are not
  // distinguished -- every member of a combo group that runs claude gets it.
  const useUsage = usageBrokerRunning() && shouldInjectUsage({
    shell: !!shell,
    app: sessionApp,
    usageEnabled: usageEnabled(),
  });
  const usageSocketPath = useUsage ? getUsageSockPath() : null;

  // ccserver-meta injection (see metaAgent.js): ONLY for sessions explicitly
  // launched with isMetaAgent:true (the single privileged self-management
  // agent -- never auto-injected into group members, shells, or anything
  // else), when the feature is enabled in the config AND the broker is
  // actually listening. The per-connection identity rides to the bridge as
  // CCSERVER_META_IDENTITY and becomes this connection's identity frame
  // (self-target guards / attribution inside the meta tools).
  const useMeta = !groupId && metaBrokerRunning() && shouldInjectMetaAgent({
    shell: !!shell,
    app: sessionApp,
    isMetaAgent: !!isMetaAgent,
    metaAgentEnabled: metaAgentEnabled(),
  });
  const metaSocketPath = useMeta ? getMetaSockPath() : null;

  // ccserver-reviewer injection (see reviewer.js): unlike notify, ANY session
  // -- worker or standalone -- gets it (issue #102 consensus point 4: "callable
  // regardless of whether a group exists"). Shells, copilot and commandcode
  // are excluded outright (see shouldInjectReviewer); the feature is off by default
  // (sandbox.config.json's reviewerMcp) and requires the broker to actually be
  // listening, same gating as notify/usage/meta.
  //
  // isReviewJob (true ONLY for the one session runReview() itself launches
  // for a given job, see reviewer.js) bypasses reviewerEnabled() specifically
  // -- never the broker-running check, there being no live broker means there
  // is genuinely no socket to bind. Without this override, a live edit to
  // sandbox.config.json flipping reviewerMcp to false after the broker
  // already started (the broker itself is never torn down on a config edit,
  // only at boot) would silently leave a review job's OWN session unable to
  // reach finish_review -- the tool that must be its authoritative completion
  // signal (see completeReviewJob) -- breaking the design for every job
  // started after that edit until a restart. shell/app are structurally
  // guaranteed sane for a review job already (VALID_APPS in reviewer.js
  // excludes copilot/commandcode, and a review job is never a shell), so this never
  // actually bypasses those two checks in practice.
  const useReviewer = reviewerBrokerRunning() && (isReviewJob === true || shouldInjectReviewer({
    shell: !!shell,
    app: sessionApp,
    reviewerEnabled: reviewerEnabled(),
  }));
  const reviewerSocketPath = useReviewer ? getReviewerSockPath() : null;
  // Per-connection identity for finish_review's caller verification (see
  // reviewer.js's finishReview): only the sessionId matters here, unlike
  // notify/meta's richer identity objects.
  const reviewerIdentity = useReviewer ? { sessionId: id } : null;

  // Server-only variables (NODE_ENV, PORT, CCSERVER_*, forwarded ssh-agent)
  // must not reach the session; see sessionEnv.js.
  const cleanEnv = buildSessionEnv();

  let command, args;
  if (shell) {
    command = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
    args = [];
  } else {
    command = resolved.command;
    // appLaunchArgs combines resume + model + permission-mode args in this
    // exact order; appLaunch.test.js exercises the same function so a
    // reordering here can't drift away from what's tested (see PR#108 review).
    args = appLaunchArgs(sessionApp, {
      resumeId: claudeSessionId,
      resumeLast,
      model: sessionModel,
      permissionMode: sessionPermissionMode,
    });
  }
  command = resolveCommand(command);

  // forceSandbox (sandbox.config.json) overrides the client's per-launch
  // choice: every session -- agents and shells alike -- must run sandboxed,
  // and a launch is refused when the sandbox can't be built instead of
  // falling back to a direct spawn. `sandboxRequested` is the mode oracle for
  // the MCP bridge config below: a requested sandbox either builds (mode
  // 'sandbox') or errors out (the config is then never used), so 'host' is
  // only ever reached when the session genuinely runs unsandboxed.
  const forceSandbox = cfg.forceSandbox;
  const sandboxRequested = (forceSandbox || sandbox) && process.platform !== 'win32' && sandboxAvailable();

  // Non-sandboxed host spawns exec on the host, not in the sandbox: a bare
  // `command` resolved against SANDBOX_PATH may not resolve on the server
  // process's own PATH (e.g. a ~/.local/bin install with a GUI/systemd PATH
  // that lacks it), and the child then dies immediately with exit 1 and no
  // output. Prefer the resolved absolute host path there (see resolveApp's
  // hostCommand); sandboxed launches keep the bare name their own PATH
  // resolves, so this never touches the sandbox branches below.
  if (!shell && !sandboxRequested && resolved.hostCommand) {
    command = resolved.hostCommand;
  }

  // Defensive backstop for the above: resolveApp always supplies hostCommand
  // when found, so a bare host-spawn name here means something regressed --
  // refuse with a clear message instead of an opaque immediate exit 1. Kept
  // under the "Failed to spawn" prefix (not "Cannot launch: <app> ...", which
  // INFRA_ERROR_PREFIXES reserves for request-as-given rejections) so this
  // server-side PATH misconfiguration classifies as an infra fault (500),
  // not a 400 -- see isInfrastructureError / groups.test.js.
  if (!shell && !sandboxRequested && !command.includes('/') && process.platform !== 'win32') {
    const onHostPath = (process.env.PATH || '').split(':').some((dir) => {
      if (!dir) return false;
      try {
        const st = statSync(join(dir, command));
        return st.isFile() && (st.mode & 0o111);
      } catch { return false; }
    });
    if (!onHostPath) {
      return {
        sessionId: id,
        session: null,
        error: `Failed to spawn "${command}": not on the server's host PATH (resolved via the sandbox PATH `
          + `instead). Add ${sessionApp}'s install dir to the server's PATH before starting the server.`,
      };
    }
  }

  // An explicitly requested sandbox that cannot be built is refused instead
  // of silently falling back to a direct (unsandboxed) spawn: running on the
  // host while the client believes it is sandboxed is worse than an error.
  // (forceSandbox refusals keep their own message in the spawn branches
  // below, so this only covers the non-forced explicit request.)
  if (sandbox && !forceSandbox && !sandboxRequested) {
    const { reason, hint } = sandboxUnavailableReason();
    return {
      sessionId: id,
      session: null,
      error: `Failed to build sandbox: ${reason}. ${hint}`,
    };
  }

  // Seatbelt (macOS) has no fixed in-sandbox paths: the host node/bridge and
  // sockets are directly visible, so every MCP bridge invocation -- including
  // the group ccserver bridge -- must use the host form. bwrap keeps the
  // fixed-path form. Non-sandboxed launches keep their existing behavior.
  const seatbeltSandbox = sandboxRequested && sandboxBackend() === 'seatbelt';
  const mcpBridgeMode = seatbeltSandbox ? 'host' : (sandboxRequested ? 'sandbox' : 'host');

  // Tool provisioning (rtk / code-review-graph): the server config supplies
  // the fallback default and the client's per-session sandboxOpts.tools (which
  // the launch menu defaults to ON for these, remembered per directory)
  // overrides it. The tools are provisioned into the sandbox HOME at launch,
  // so they are only ever injected when this session is actually sandboxed.
  // Thread cfg.tools through: the config was already read once above, so
  // resolveTools must not re-read + re-parse it here on every launch.
  const tools = resolveTools(sandboxOpts, cfg.tools);

  // MCP config injection -- never written to a file (see mcpConfig.js). Combo
  // sessions (groupId set) get their role's broker (ccserver); notify-enabled
  // sessions additionally get ccserver-notify, whose bridge command depends on
  // whether this session ends up sandboxed (the fixed in-sandbox path vs. the
  // host node+bridge). The args must be in the target command before
  // buildSandboxSpawn runs, so the mode is derived from sandboxRequested.
  let mcpEnv = {};
  // Issue #119 Step6-1: the MCP registration args (injected.args below),
  // captured separately from the rest of `args` so pty-host's own
  // crash-recovery auto-resume (server/pty-host/index.js) can replay them
  // verbatim without re-deriving whether notify/usage/meta/reviewer/group-mcp
  // apply or rebuilding their identity payloads -- only the resume/model/
  // permission portion appLaunchArgs() produces needs to be regenerated
  // fresh (a resume id that was accurate at THIS launch may not be by the
  // time pty-host relaunches it). See setPtyHostSessionMeta's mcpArgs field
  // below.
  let mcpArgs = [];
  // code-review-graph is only provisionable under bwrap (mount-bound
  // provisioner); seatbelt sandboxes never get the binary, so injecting the
  // MCP server there would fail every session.
  const crgInjectable = sandboxRequested && !seatbeltSandbox && tools.codeReviewGraph;
  if (sessionApp && (mcpSocketPath || useNotify || useUsage || useMeta || useReviewer || crgInjectable)) {
    const injected = buildMcpConfigArgsAndEnv(sessionApp, {
      // ccserver (the group broker) only when the session has a group socket:
      // standalone notify sessions must not get a broken ccserver entry (its
      // bridge would point at a socket that is never bound for them).
      groupMcp: !!mcpSocketPath,
      // Seatbelt sandboxes can't use the fixed in-sandbox bridge path (it is
      // never bound there), so they take the host invocation. Non-sandboxed
      // group sessions intentionally keep the fixed-path form (see
      // groupInvocation in mcpConfig.js).
      hostBridge: seatbeltSandbox,
      notify: useNotify ? {
        mode: mcpBridgeMode,
        sockPath: notifySocketPath,
        identity: notifyIdentity,
      } : undefined,
      usage: useUsage ? {
        mode: mcpBridgeMode,
        sockPath: usageSocketPath,
      } : undefined,
      meta: useMeta ? {
        mode: mcpBridgeMode,
        sockPath: metaSocketPath,
        identity: {
          sessionId: id,
          groupId,
          groupRole,
          cwd,
          projectName: projectName ?? basename(cwd),
          app: sessionApp,
        },
      } : undefined,
      reviewer: useReviewer ? {
        mode: mcpBridgeMode,
        sockPath: reviewerSocketPath,
        identity: reviewerIdentity,
      } : undefined,
      // code-review-graph MCP is injected only into sandboxed sessions that
      // can actually provision it (bwrap; never on the host, never seatbelt).
      tools: crgInjectable ? tools : null,
      cwd,
    });
    mcpEnv = injected.env;
    mcpArgs = injected.args;
    args.push(...injected.args);
  }

  // Optionally wrap the target in a filesystem sandbox (bwrap on Linux,
  // sandbox-exec on macOS) so it can only see the project directory plus
  // configured paths, with an isolated rootless docker inside on Linux.
  // See sandbox.js.
  //
  // usePtyHost (plan5 Step2, section 2.1): pty-host's own spawn() builds the
  // sandbox itself (server/pty-host/ptyStore.js already imports
  // buildSandboxSpawn), so this branch sends it the raw command/args plus the
  // sandbox parameters instead of calling buildSandboxSpawn() here. Only the
  // checks that depend on server本体's OWN state (the live `sessions` Map,
  // this project's group-files dir) still run here -- pty-host has no
  // visibility into either.
  const usePtyHost = isPtyHostEnabled();
  let useSandbox = false;
  let sandboxDocker = false;
  let sandboxStateDir = null;
  let sandboxGitBrokerProc = null;
  let sandboxGitBrokerDir = null;
  let sandboxCommitGuardDir = null;
  let sandboxSeatbeltDir = null;
  let sandboxSeatbeltFiles = null;
  let ptyProcess;
  // Plan5 Step5 (partitioning): decided once here and reused for BOTH the
  // spawn() call below and the subscribe() call after buildSessionRecord --
  // never re-derived via a second getPtyHostClient() call in between. Doing
  // so would risk shardCount() having changed (env var read at call time) or
  // simply reading less clearly as "the same client", either of which could
  // silently send subscribe() to a different pty-host instance than the one
  // spawn() actually landed on, RPC-ing for a session id that instance has
  // never heard of. See ptyHostClient.js's header comment on this exact trap.
  let ptyHostShardIndex = null;
  let ptyHostShardClient = null;

  if (usePtyHost) {
    ptyHostShardIndex = shardIndexForKey(shardKeyForSession({ groupId, cwd }));
    ptyHostShardClient = getPtyHostClient(ptyHostShardIndex);
    if (sandboxRequested) {
      // Same conflict backstop as the direct-spawn branch below (see its
      // comment) -- this check is server本体-only state, so it can't move
      // into pty-host.
      if (cfg.persistentHome && !reuseSandboxHome) {
        const targetPath = persistentHomeDir(cwd);
        if (sandboxHomeConflict(targetPath, [...sessions.values()])) {
          return {
            sessionId: id,
            session: null,
            error: 'このプロジェクトのサンドボックスを利用中のセッションがあるため、新規作成（前回環境の破棄）できません。先にタブを閉じてください。',
          };
        }
      }
    } else if (forceSandbox) {
      const { reason, hint } = forceSandboxUnavailableReason();
      return {
        sessionId: id,
        session: null,
        error: `Cannot launch: sandbox.config.json sets "forceSandbox": true, but ${reason}. ${hint}`,
      };
    }
    let resolvedGroupFilesDir = groupFilesDir;
    if (sandboxRequested && !resolvedGroupFilesDir && groupId) {
      try {
        resolvedGroupFilesDir = getGroupFilesDir(groupId);
        ensureGroupFilesDir(groupId);
      } catch { resolvedGroupFilesDir = null; }
    }

    // Same env recipe as the direct-spawn branch below, computed against
    // sandboxRequested instead of the (not-yet-known) useSandbox -- pty-host
    // hasn't attempted the sandbox build yet at this point, but a launch that
    // requested one and fails is reported as an error below rather than
    // silently falling through, so this can never end up materially wrong.
    const ptyEnv = {
      ...cleanEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '1',
      ...(shell || sessionApp !== 'claude' ? {} : {
        CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
        CLAUDE_CODE_DISABLE_MOUSE_CLICKS: '1',
      }),
      ...mcpEnv,
      ...(shell || sessionApp !== 'opencode' || sandboxRequested ? {} : bunTmpdirEnv()),
    };

    try {
      const rpty = await ptyHostShardClient.spawn({
        id,
        cwd,
        cols,
        rows,
        command,
        args,
        env: ptyEnv,
        sandbox: !!sandboxRequested,
        sandboxOpts,
        // pty-host's ptyStore.spawn() refuses sandbox:true without an "app"
        // (server/pty-host/ptyStore.js) -- stricter than buildSandboxSpawn's
        // own resolveApp(app), which already treats a null/unrecognized app
        // as "resolve the claude binary" (none of its app-specific branches
        // match). shell:true forces sessionApp to null above, and shell +
        // sandbox is a real, reachable combination (plain POST /api/sessions,
        // and RemoteInstanceView.jsx's independently-toggleable シェル/
        // サンドボックス checkboxes) that worked before pty-host existed.
        // Falling back to the same default here (only used inside pty-host's
        // sandbox branch -- session.app itself stays sessionApp, i.e. null,
        // for shell sessions) keeps that combination working unchanged.
        app: sessionApp || 'claude',
        mcpSocketPath,
        mcpToken,
        notifySocketPath,
        usageSocketPath,
        metaSocketPath,
        reviewerSocketPath,
        reuseSandboxHome,
        orchestratorClaudeMdSrc,
        gitCommonDir,
        groupFilesDir: resolvedGroupFilesDir,
        sandboxHomeCreatedBy,
      });
      ptyProcess = rpty;
      useSandbox = !!sandboxRequested;
      sandboxDocker = !!rpty.sandboxInfo?.docker;
      sandboxStateDir = rpty.sandboxInfo?.stateDir || null;
      // Read-only ownership reference for fireSchedule's retire-first guard:
      // teardown itself stays pty-host's (the destroy path below is skipped
      // in this mode), but an exited predecessor must still be recognisable
      // as the overlay owner before a scheduled auto-resume spawns a
      // successor into the same deterministic orchestratorDir.
      sandboxSeatbeltFiles = Array.isArray(rpty.sandboxInfo?.seatbeltFiles)
        ? rpty.sandboxInfo.seatbeltFiles
        : null;
      // sandboxGitBrokerProc/sandboxGitBrokerDir/sandboxCommitGuardDir stay
      // null: pty-host itself owns and tears down whatever it built --
      // git-broker's process/dir (plan5 2.1) and, since this branch's own
      // commitGuardDir fix, the commit-message guard's runtime dir too (see
      // server/pty-host/ptyStore.js) -- server本体 has no handle to any of
      // it and must not try.
      //
      // Step3 (plan5): persist exactly the "launch input" fields pty-host's
      // own list() can never return (it deliberately holds none of this --
      // see ptyStore.js's header comment) so a restart can rebuild this
      // session's `session` record via restorePtyHostSessions() instead of
      // losing it. Written only on success -- an id that never reaches this
      // point never spawned on pty-host's side, so there would be nothing to
      // restore.
      setPtyHostSessionMeta(id, {
        cwd,
        shell: !!shell,
        app: sessionApp,
        model: sessionModel,
        permissionMode: sessionPermissionMode,
        groupId,
        groupRole,
        customLabel: normalizeCustomLabel(customLabel),
        isMetaAgent: !!isMetaAgent,
        sandbox: useSandbox,
        sandboxOpts: useSandbox ? (sandboxOpts || null) : null,
        docker: sandboxDocker,
        sandboxStateDir,
        reuseSandboxHome,
        startedClaudeSessionId: claudeSessionId || null,
        // Plan5 Step5: persisted, not recomputed on restore -- see this
        // file's restorePtyHostSessions() and ptyHostClient.js's
        // shardIndexForKey() header comment.
        shardIndex: ptyHostShardIndex,
        // Issue #119 Step6-1: everything below lets pty-host's own
        // crash-recovery auto-resume (server/pty-host/index.js) call
        // ptyStore.spawn() again with the exact same shape this call itself
        // used -- command/env/the socket paths/orchestratorClaudeMdSrc/
        // gitCommonDir/groupFilesDir/sandboxHomeCreatedBy are replayed
        // verbatim (a fresh buildSandboxSpawn() run there rebuilds the
        // sandbox -- including a fresh git-broker -- from these exactly as
        // this launch itself did; a git-broker started by the crashed
        // pty-host generation does NOT survive to be reused, see
        // gitBrokerRegistry.js's reapOrphans()), while only the resume
        // portion of `args` (mcpArgs holds everything else already decided
        // above) gets rebuilt fresh from whatever's known at RESUME time.
        mcpArgs,
        env: ptyEnv,
        command,
        mcpSocketPath,
        mcpToken,
        notifySocketPath,
        usageSocketPath,
        metaSocketPath,
        reviewerSocketPath,
        orchestratorClaudeMdSrc,
        gitCommonDir,
        groupFilesDir: resolvedGroupFilesDir,
        sandboxHomeCreatedBy,
        // Step6-0's continuously-updated resume id (see buildSessionRecord's
        // lastKnownResumeId field comment) starts here at the same value
        // startedClaudeSessionId does -- the freshest accurate id known at
        // this exact moment, before the pty has printed anything of its own.
        latestClaudeSessionId: claudeSessionId || null,
      });
    } catch (err) {
      // pty-host's own errors already carry the "Failed to build sandbox" /
      // "Failed to spawn" prefixes INFRA_ERROR_PREFIXES expects (see
      // server/pty-host/ptyStore.js); ptyHostClient.spawn() mints the same
      // "Failed to spawn" prefix for the unreachable case. Forward verbatim.
      return { sessionId: id, session: null, error: err.message };
    }
  } else {
    if (sandboxRequested) {
      // A fresh (wipe) sandbox is refused while another sandbox of the same
      // project is still using the same persistent HOME -- deleting the host dir
      // under a live bind mount would corrupt that session. The client disables
      // the "new" option in the same situation (GET /api/sandbox/status), so
      // this is the authoritative backstop.
      if (cfg.persistentHome && !reuseSandboxHome) {
        const targetPath = persistentHomeDir(cwd);
        if (sandboxHomeConflict(targetPath, [...sessions.values()])) {
          return {
            sessionId: id,
            session: null,
            error: 'このプロジェクトのサンドボックスを利用中のセッションがあるため、新規作成（前回環境の破棄）できません。先にタブを閉じてください。',
          };
        }
      }
      // Group file exchange: every sandboxed group member gets its group's
      // blob directory read-only at /ccserver-group-files.
      let resolvedGroupFilesDir = groupFilesDir;
      if (!resolvedGroupFilesDir && groupId) {
        try {
          resolvedGroupFilesDir = getGroupFilesDir(groupId);
          ensureGroupFilesDir(groupId);
        } catch { resolvedGroupFilesDir = null; }
      }
      try {
        const spawn = buildSandboxSpawn({ cwd, targetCommand: [command, ...args], app: sessionApp, sandboxOpts, mcpSocketPath, mcpToken, notifySocketPath, usageSocketPath, metaSocketPath, reviewerSocketPath, reuseSandboxHome, orchestratorClaudeMdSrc, gitCommonDir, groupFilesDir: resolvedGroupFilesDir, sandboxHomeCreatedBy });
        command = spawn.command;
        args = spawn.args;
        sandboxDocker = !!spawn.docker;
        sandboxStateDir = spawn.stateDir || null;
        sandboxGitBrokerProc = spawn.gitBrokerProc || null;
        sandboxGitBrokerDir = spawn.gitBrokerDir || null;
        sandboxCommitGuardDir = spawn.commitGuardDir || null;
        sandboxSeatbeltDir = spawn.seatbeltDir || null;
        sandboxSeatbeltFiles = spawn.seatbeltFiles || null;
        useSandbox = true;
      } catch (err) {
        return { sessionId: id, session: null, error: `Failed to build sandbox: ${err.message}` };
      }
    } else if (forceSandbox) {
      const { reason, hint } = forceSandboxUnavailableReason();
      return {
        sessionId: id,
        session: null,
        error: `Cannot launch: sandbox.config.json sets "forceSandbox": true, but ${reason}. ${hint}`,
      };
    }

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
        ...(shell || sessionApp !== 'claude' ? {} : {
          CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
          CLAUDE_CODE_DISABLE_MOUSE_CLICKS: '1',
        }),
        // opencode is left with full mouse capture (its default): the TUI keeps
        // the whole conversation in an internal scrollable area that the wheel
        // scrolls natively, and its own drag-selection + copy-on-select writes
        // to the browser clipboard via OSC 52 (handled client-side).
        ...mcpEnv,
        // /tmp being mounted noexec makes Bun fail to unpack + dlopen its
        // embedded libopentui.so, so opencode's TUI dies at startup (opencode
        // #26136/#27580). Direct host launches switch BUN_TMPDIR to
        // ~/.cache/opencode/tmp when the host TMPDIR is noexec. Sandboxed
        // launches don't: the sandbox's /tmp is a fresh tmpfs that is always
        // executable, and the host-side cache dir is not bound into bwrap (with
        // a fresh HOME it would not even exist), so setting it there would
        // break what it is meant to fix.
        ...(shell || sessionApp !== 'opencode' || useSandbox ? {} : bunTmpdirEnv()),
      },
    });
    } catch (err) {
      // The sandbox (if any) was already built by this point -- clean up what
      // buildSandboxSpawn created (brokers, guard/profile dirs), mirroring
      // pty-host's own spawn-failure path (see ptyStore.js). Otherwise a
      // failed launch leaks a live broker process and its runtime dirs.
      if (sandboxStateDir) { try { rmSync(sandboxStateDir, { recursive: true, force: true }); } catch { /* best effort */ } }
      if (sandboxGitBrokerProc) { try { sandboxGitBrokerProc.kill('SIGTERM'); } catch { /* already dead */ } }
      if (sandboxGitBrokerDir) { try { rmSync(sandboxGitBrokerDir, { recursive: true, force: true }); } catch { /* best effort */ } }
      if (sandboxCommitGuardDir) { try { rmSync(sandboxCommitGuardDir, { recursive: true, force: true }); } catch { /* best effort */ } }
      if (sandboxSeatbeltDir) { try { rmSync(sandboxSeatbeltDir, { recursive: true, force: true }); } catch { /* best effort */ } }
      if (Array.isArray(sandboxSeatbeltFiles)) {
        // Same guard as destroySession(): a concurrent launch from the same
        // orchestratorDir may already own these paths. (The failed session
        // itself is not registered yet, so no self-exclusion is needed.)
        releaseSeatbeltOverlay(
          sandboxSeatbeltFiles,
          [...sessions.values()].map((other) => other.sandboxSeatbeltFiles),
        );
      }
      return { sessionId: id, session: null, error: `Failed to spawn "${command}": ${err.message}` };
    }
  }

  const session = buildSessionRecord(id, ptyProcess, {
    cwd,
    shell,
    app: sessionApp,
    model: sessionModel,
    permissionMode: sessionPermissionMode,
    groupId,
    groupRole,
    customLabel,
    isMetaAgent,
    sandbox: useSandbox,
    sandboxOpts,
    docker: sandboxDocker,
    sandboxStateDir,
    sandboxGitBrokerProc,
    sandboxGitBrokerDir,
    sandboxCommitGuardDir,
    sandboxSeatbeltDir,
    sandboxSeatbeltFiles,
    reuseSandboxHome,
    cols,
    rows,
    startedClaudeSessionId: claudeSessionId || null,
    shardIndex: ptyHostShardIndex,
  });

  if (usePtyHost) {
    // Subscribe for this session's entire lifetime, independent of browser
    // viewer count (a deliberate departure from plan5 5.2.3's original
    // "subscribe on 0->1 viewers" sketch -- see this file's onData handler
    // above: AutoYes auto-response, session-limit detection, and
    // session.outputBuffer accumulation must keep running with zero viewers
    // attached, exactly the scenario AutoYes exists for). onData/onExit are
    // already wired above, so nothing here can be missed even if pty-host
    // has already produced output by the time this resolves. Reuses
    // ptyHostShardClient (the same client spawn() used above), not a fresh
    // getPtyHostClient() call -- see this function's own comment on why.
    try {
      await ptyHostShardClient.subscribe(ptyProcess, 0);
    } catch (err) {
      console.warn(`[session] ${id}: initial pty-host subscribe failed (will retry on reconnect): ${err.message}`);
    }
  }

  return { sessionId: id, session };
}

export function getSession(id) {
  return sessions.get(id);
}

// Operator-assigned display names for sessions (right-click rename in the
// client). Null/undefined/empty-after-trim means "no custom name". Overlong
// input is rejected (not truncated) so the caller can surface the limit.
export const MAX_CUSTOM_LABEL_LENGTH = 64;

export function normalizeCustomLabel(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  // Strip ASCII + C1 control characters and U+2028/U+2029 line separators --
  // the label is rendered in single-line UI slots (session rows, terminal
  // header), where they would split lines or break layout.
  const cleaned = value.replace(/[\u0000-\u001F\u007F\u0080-\u009F\u2028\u2029]/g, '').trim();
  if (!cleaned) return null;
  return cleaned;
}

export function setSessionLabel(id, label) {
  const session = sessions.get(id);
  if (!session) {
    return { ok: false, code: 'not-found', message: 'Session not found' };
  }
  if (label !== null && label !== undefined && typeof label !== 'string') {
    return { ok: false, code: 'validation', message: 'customLabel must be a string or null' };
  }
  const normalized = normalizeCustomLabel(label);
  if (normalized !== null && [...normalized].length > MAX_CUSTOM_LABEL_LENGTH) {
    return { ok: false, code: 'validation', message: `customLabel must be at most ${MAX_CUSTOM_LABEL_LENGTH} characters` };
  }
  session.customLabel = normalized;
  return { ok: true, session };
}

// Write text into a live session's pty, optionally submitting with Enter.
// Shared by the WS 'input' path (terminal.js) and the MCP send_input tool
// (mcpTools.js). Idle timer reset mirrors the WS input handler.
export function writeToSession(id, text, { submit = false } = {}) {
  const session = sessions.get(id);
  if (!session?.ptyProcess || session.exited) return false;
  try {
    session.ptyProcess.write(text);
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (submit) {
      // Delay the Enter so the TUI registers the text first (same pattern as
      // injectIntoLiveSession). The key resolves through the per-app submit
      // table (appLaunch.appSubmitKey) -- never a literal here -- so an app
      // that ever needs a different submit byte changes only that table.
      setTimeout(() => {
        if (!session.exited && session.ptyProcess) {
          try {
            session.ptyProcess.write(appSubmitKey(session.app));
          } catch {
            // pty may have died between writes
          }
        }
      }, 200);
    }
    return true;
  } catch {
    return false;
  }
}

// Named control keys writable via writeKeyToSession (MCP send_key). This is
// deliberately a WHITELIST of exact byte sequences, never a generic raw-input
// API: arbitrary strings, ANSI sequences, Ctrl-C/Ctrl-D or arrow keys are not
// exposed, so this path can dismiss an agent TUI's confirmation modal but can
// never stop/kill the worker's shell or drive its UI beyond that.
const SESSION_KEYS = {
  escape: '\x1b',
};

// Write ONE whitelisted control key into a live session's pty. Liveness check
// and idle-timer handling mirror writeToSession; unlike writeToSession there
// is no delayed submit -- a confirmation modal must close on the key itself,
// so no CR is appended.
export function writeKeyToSession(id, key) {
  const bytes = SESSION_KEYS[key];
  if (!bytes) return false;
  const session = sessions.get(id);
  if (!session?.ptyProcess || session.exited) return false;
  try {
    session.ptyProcess.write(bytes);
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    return true;
  } catch {
    return false;
  }
}

// Gate for tools that type into a freshly-launched agent TUI (send_input):
// wait until the session's output has gone idle (first IDLE_TIMEOUT_MS gap)
// so keystrokes aren't dropped by a TUI that is still initializing. Resolves
// immediately -- with the session's current settled state -- for sessions
// that can never settle (missing, exited, plain shell, already settled).
// Best-effort: callers write regardless of the outcome; a timed-out wait just
// reports { settled: false, timedOut: true } so the caller can re-check.
const SETTLE_WAIT_TIMEOUT_MS = 10 * 1000;

export function waitUntilSettled(id, { timeoutMs = SETTLE_WAIT_TIMEOUT_MS } = {}) {
  const session = sessions.get(id);
  if (!session || session.exited || session.shell || session.settled) {
    return Promise.resolve({ settled: !!session?.settled, timedOut: false });
  }
  return new Promise((resolve) => {
    let timer = null;
    const onSettled = () => {
      if (timer) clearTimeout(timer);
      resolve({ settled: true, timedOut: false });
    };
    session.settleWaiters.push(onSettled);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        const i = session.settleWaiters.indexOf(onSettled);
        if (i !== -1) {
          session.settleWaiters.splice(i, 1);
          resolve({ settled: false, timedOut: true });
        }
      }, timeoutMs);
    }
  });
}

const MAX_SCHEDULE_AHEAD_MS = 48 * 60 * 60 * 1000; // 48h

// Session-limit auto-resume detection (see sessionLimitDetect.js and the
// onData handler above). The status line is short, so a window well past its
// longest plausible rendering (including redraws/padding) is cheap to keep
// and to re-strip/re-match on every chunk.
const LIMIT_DETECT_BUF_MAX_CHARS = 2048;
const SESSION_LIMIT_RESUME_DELAY_MS = 60 * 1000; // fire 1 minute after reset
const SESSION_LIMIT_RESUME_MESSAGE = 'セッション制限がリセットされました。作業を続けてください。';

// Issue #119 Step6-0: claude's `claude --resume <id>` hint (~40-60 chars
// including the uuid) is far shorter than the session-limit status line
// above, but ANSI escapes can still interleave with it across redraws --
// generously larger than the longest realistic hint while staying well
// below LIMIT_DETECT_BUF_MAX_CHARS, since this signal needs nowhere near as
// much context.
const RESUME_ID_DETECT_BUF_MAX_CHARS = 512;
// How long to hold a changed lastKnownResumeId in memory before writing it
// to ptyHostSessionMeta.json (see scheduleResumeIdWriteback below). Chosen
// as a starting point in the plan's suggested 5-10s range; claude is
// expected to only reprint this hint on infrequent events (e.g.
// compaction), so real write frequency is likely far below what even makes
// this debounce necessary. Env-overridable (read fresh per call, like
// ptyHostClient.js's shardCount()) both so an operator can tune it against
// observed behavior without a code change, and so tests aren't stuck
// waiting out a real 10s window.
const DEFAULT_RESUME_ID_WRITE_DEBOUNCE_MS = 10_000;
function resumeIdWriteDebounceMs() {
  const raw = process.env.CCSERVER_RESUME_ID_DEBOUNCE_MS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_RESUME_ID_WRITE_DEBOUNCE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RESUME_ID_WRITE_DEBOUNCE_MS;
}

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
        sandboxOpts: s.sandboxOpts || null,
        shell: !!s.shell,
        app: s.app || 'claude',
        model: normalizeModel(s.model) || null,
        permissionMode: normalizePermissionMode(s.permissionMode),
        claudeSessionId: s.claudeSessionId || null,
        groupId: s.groupId || null,
        groupRole: s.groupRole || null,
        source: s.source || 'manual',
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

// Best-known conversation id for resuming this session later.
function resumeIdForSession(session) {
  if (!session) return null;
  if (session.claudeSessionId) return session.claudeSessionId;
  const extracted = extractResumeId(session);
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
  return s ? { at: s.at, text: s.text, source: s.source } : null;
}

// Does any live, sandboxed session share `targetPath` as its persistent HOME?
// Used to refuse a "new sandbox" (wipe) while another sandbox of the same
// project is still using it: deleting the host dir under an active bind mount
// would corrupt that session's HOME. Unsandboxed sessions don't bind the
// persistent HOME and are unaffected. Exported for unit testing -- pure over
// the live-session list.
export function sandboxHomeConflict(targetPath, liveSessions) {
  for (const s of liveSessions) {
    if (!s || s.exited || !s.sandbox) continue;
    if (persistentHomeDir(s.cwd) === targetPath) return true;
  }
  return false;
}

// Whether THIS session can actually use docker right now -- surfaced by
// get_tab_status/list_group_sessions so the orchestrator can check before
// handing a worker a docker task, instead of finding out from a failure (see
// tmp/docker-availability-visibility-plan.md). A live rootless dockerd is
// only ever able to hold ONE project's data-root at a time (see
// sandbox-entrypoint.sh's flock); a second sandbox of the same project
// launches with docker: false internally rather than corrupting that
// data-root, and Node never previously tracked whether the flock was
// actually won.
//
//   dockerAvailable  dockerReason                          meaning
//   null             'not-sandboxed'                       no sandbox, docker N/A
//   false            'tooling-missing'                     bwrap/rootlesskit/etc not installed
//   false            'disabled-by-config'                  sandbox.config.json docker:false
//   null             'starting'                            docker enabled, dockerd hasn't won/lost the flock yet -- retry shortly
//   true             'available'                           this session's own dockerd holds the data-root lock
//   false            'data-root-locked-by-another-session'  a different session's dockerd holds it
//
// A tag mismatch alone doesn't prove "another session has it": the status
// file is never cleared on exit, so it can just as well be leftover from a
// session that has since fully exited (see DOCKERD_STATUS_NAME in
// sandbox.js). dockerdLockHeld() disambiguates by checking whether the flock
// is actually held right now -- if not, this is still just an unresolved
// "starting" (this session's own dockerd hasn't raced for the flock yet),
// not a hard conflict worth diverting the task elsewhere.
//
// Exported for unit testing -- pure over a session-shaped object (only
// .sandbox/.docker/.dockerTag/.cwd are read).
export function dockerAvailability(session) {
  if (!session?.sandbox) return { dockerAvailable: null, dockerReason: 'not-sandboxed' };
  if (!session.docker) {
    return { dockerAvailable: false, dockerReason: dockerSandboxAvailable() ? 'disabled-by-config' : 'tooling-missing' };
  }
  const status = dockerdStatus(session.cwd);
  if (status === session.dockerTag) return { dockerAvailable: true, dockerReason: 'available' };
  if (status && dockerdLockHeld(session.cwd)) return { dockerAvailable: false, dockerReason: 'data-root-locked-by-another-session' };
  return { dockerAvailable: null, dockerReason: 'starting' };
}

// Count of live sandboxed sessions sharing cwd's persistent HOME. Surfaced by
// GET /api/sandbox/status so the client can disable the destructive "new"
// option while the project's sandbox is in use.
export function sandboxHomeInUse(cwd) {
  return sandboxHomeInUsePath(persistentHomeDir(cwd));
}

// Count of live sandboxed sessions whose persistent HOME is exactly
// `homePath`. Backs the settings page (GET /api/sandboxes) and the delete
// guard: a sandbox that is currently mounted by a live session must not be
// deleted from under it.
export function sandboxHomeInUsePath(homePath) {
  let n = 0;
  for (const s of sessions.values()) {
    if (sandboxHomeConflict(homePath, [s])) n++;
  }
  return n;
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

// Issue #119 Step6-0: writes session.lastKnownResumeId to
// ptyHostSessionMeta.json's latestClaudeSessionId right now, clearing any
// armed debounce timer. Called both when the debounce window has actually
// elapsed (scheduleResumeIdWriteback below) and from the onExit/disconnect
// paths that must not let a pending value die in memory only.
function flushResumeIdWriteback(session) {
  if (session.resumeIdWriteTimer) {
    clearTimeout(session.resumeIdWriteTimer);
    session.resumeIdWriteTimer = null;
  }
  session.resumeIdLastWriteAt = Date.now();
  patchPtyHostSessionMeta(session.id, { latestClaudeSessionId: session.lastKnownResumeId });
}

// Issue #119 Step6-0: debounces the ptyHostSessionMeta.json write-back for a
// newly-detected lastKnownResumeId. If the last actual write was long enough
// ago (resumeIdWriteDebounceMs()), write immediately; otherwise hold the
// value in memory (already updated by the caller) and let an already-armed
// timer -- or a freshly armed one -- pick up whatever the LATEST value is
// once it fires, rather than writing on every single detected change.
function scheduleResumeIdWriteback(session) {
  const debounceMs = resumeIdWriteDebounceMs();
  const elapsed = Date.now() - session.resumeIdLastWriteAt;
  if (elapsed >= debounceMs) {
    flushResumeIdWriteback(session);
    return;
  }
  if (session.resumeIdWriteTimer) return; // already armed; will flush the latest value when it fires
  session.resumeIdWriteTimer = setTimeout(() => flushResumeIdWriteback(session), debounceMs - elapsed);
  session.resumeIdWriteTimer.unref?.();
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

// Build a schedule_state payload including server timezone info so the client
// can display/interpret times in the server's zone (matching Claude Code).
// Exported so terminal.js's WS-request handlers (schedule_prompt,
// cancel_schedule, get_schedule, init, attach) can reuse the same payload
// shape as the server-internal push paths below.
export function buildScheduleStateMsg(scheduled, error) {
  const { tz, now } = getServerTimeInfo();
  return JSON.stringify({
    type: 'schedule_state',
    scheduled,
    serverTz: tz,
    serverNow: now,
    ...(error ? { error } : {}),
  });
}

// Push the current schedule state to every attached viewer. Needed by any
// server-internal path that arms/changes a schedule without a client request
// to respond to (e.g. the auto-session-limit detector in onData) -- unlike
// schedule_prompt/cancel_schedule/get_schedule, those paths have no
// request/response leg to piggyback the push on.
function notifyScheduleState(session) {
  if (!session) return;
  broadcast(session, buildScheduleStateMsg(scheduledPromptPublic(session)));
}

function notifyFired(session, info, delivered) {
  if (!session) return;
  broadcast(session, {
    type: 'schedule_fired',
    at: info.at,
    text: info.text,
    delivered,
  });
  broadcast(session, { type: 'schedule_state', scheduled: null });
}

// Schedule-entry matching for the "same project" live-session substitution
// (fireSchedule branch 2). Group members match strictly -- only the SAME
// group AND SAME role -- because combo workers legitimately share cwd+app
// with each other, so a cwd+app match alone could inject into the wrong
// worker. A model-annotated schedule must likewise only inject into a
// session launched with the SAME model; unmodeled entries (both null) keep
// the original cwd+shell+app semantics. The same rule applies to the
// permission mode: a yolo/auto-accept schedule must not inject into a
// standard session (legacy entries without the field count as 'standard').
// Exported for direct unit testing.
export function matchesScheduleTarget(session, entry) {
  return !!session && !session.exited && !!session.ptyProcess
    && session.cwd === entry.cwd
    && session.shell === entry.shell
    && session.app === entry.app
    && (session.model ?? null) === (entry.model ?? null)
    && (session.permissionMode ?? 'standard') === (entry.permissionMode ?? 'standard')
    && (session.groupId ?? null) === (entry.groupId ?? null)
    && (session.groupRole ?? null) === (entry.groupRole ?? null);
}

async function fireSchedule(scheduleId) {
  const entry = schedules.get(scheduleId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  schedules.delete(scheduleId);
  persistSchedules();

  // 1) The originating session, if still alive.
  let target = entry.sessionId ? sessions.get(entry.sessionId) : null;
  if (target && (target.exited || !target.ptyProcess)) target = null;

  // 2) Otherwise any live session for the same project (user reopened it).
  // See matchesScheduleTarget: group members match strictly by group+role.
  if (!target) {
    for (const s of sessions.values()) {
      if (matchesScheduleTarget(s, entry)) {
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
  // opencode, copilot, codex and commandcode expose no session id in their
  // TUI output, so resume the last session of the project instead of a
  // specific one.
  // A group member gets its role's MCP socket re-created (handoff channel or
  // control broker) so the resumed session can actually reach the group --
  // otherwise the orchestrator's wait_for_handoff would wait on a worker that
  // can never hand off. If that socket can't be produced (group already torn
  // down, broker failed), the prompt is dropped rather than orphaned: a
  // member session without MCP can never hand off again, and in the
  // group-gone case nobody is waiting anyway.
  const mcpResolved = entry.groupId && entry.groupRole
    ? await resolveMcpSocketForSession(entry.groupId, entry.groupRole)
    : null;
  const mcpSocketPath = mcpResolved ? mcpResolved.sockPath : null;
  const mcpToken = mcpResolved ? mcpResolved.token : null;
  if (entry.groupId && !mcpSocketPath) {
    console.warn(`[scheduler] dropping prompt for group member ${entry.groupRole} of ${entry.groupId}: MCP socket unavailable`);
    return;
  }
  // The orchestrator's CLAUDE.md/AGENTS.md overlay must be regenerated on
  // every respawn (see groupManager.generateOrchestratorClaudeMdSrc) -- this
  // auto-resume path is the one spawn site that can't call it directly
  // (would create an import cycle with groupManager.js), so it goes through
  // the same resolver-registration pattern as mcpSocketPath above. Same
  // fail-closed policy too: an orchestrator that can't get a fresh overlay
  // must not fall back to launching without one (that would be a silent
  // regression back to the writable-CLAUDE.md hole this mechanism closes).
  const orchestratorClaudeMdSrc = entry.groupId && entry.groupRole === 'orchestrator'
    ? await resolveOrchestratorClaudeMdSrc(entry.groupId)
    : null;
  if (entry.groupId && entry.groupRole === 'orchestrator' && !orchestratorClaudeMdSrc) {
    console.warn(`[scheduler] dropping prompt for orchestrator of ${entry.groupId}: CLAUDE.md generation unavailable`);
    return;
  }
  // Same "server decides, never trust a persisted value blindly" resolution
  // as every other group-member (re)spawn site (terminal.js's init
  // reconnect, groupManager.addMember): entry.cwd may point at a worker's
  // worktree that's since been lost from disk, so the resolver is always
  // consulted (it recreates it -- and notifies on genuine data loss --
  // rather than launching into a dead directory); see
  // groupManager.resolveMemberLaunchCwd. Same fail-closed policy as
  // mcpSocketPath/orchestratorClaudeMdSrc above.
  let cwd = entry.cwd;
  let gitCommonDir = null;
  if (entry.groupId && entry.groupRole) {
    const cwdRes = await resolveMemberCwdForSession(entry.groupId, entry.groupRole);
    if (!cwdRes) {
      console.warn(`[scheduler] dropping prompt for group member ${entry.groupRole} of ${entry.groupId}: working directory unavailable`);
      return;
    }
    cwd = cwdRes.cwd;
    gitCommonDir = cwdRes.gitCommonDir;
  }
  // An exited-but-not-yet-reaped predecessor of the same group+role still
  // owns its seatbelt orchestrator overlay (sandboxSeatbeltFiles). Retire it
  // now -- after every drop check (a dropped prompt must not destroy an
  // exited session the user may still have open) but before the successor
  // launches, or the successor sees the overlay files as pre-existing,
  // claims no ownership, and the predecessor's later teardown unlinks the
  // live successor's CLAUDE.md/AGENTS.md mid-session. Same retire-first
  // ordering as routes/groups.js's orchestrator restart.
  if (entry.groupId && entry.groupRole) {
    for (const s of [...sessions.values()]) {
      if (s.exited && s.groupId === entry.groupId && s.groupRole === entry.groupRole
          && Array.isArray(s.sandboxSeatbeltFiles)) {
        // Awaited: in pty-host mode the overlay unlink happens over there,
        // so the successor must not spawn until the ack is back (#12).
        await retireSessionForReuse(s.id);
      }
    }
  }
  const res = await createSession({
    cwd,
    cols: 80,
    rows: 24,
    claudeSessionId: entry.claudeSessionId,
    shell: entry.shell,
    sandbox: entry.sandbox,
    sandboxOpts: entry.sandboxOpts,
    app: entry.app,
    model: entry.model,
    permissionMode: entry.permissionMode,
    resumeLast: entry.app === 'opencode' || entry.app === 'copilot' || entry.app === 'codex' || entry.app === 'commandcode',
    // A group member keeps its membership across the resume: groupManager's
    // session-create listener re-binds the role to the new sessionId.
    groupId: entry.groupId,
    groupRole: entry.groupRole,
    mcpSocketPath,
    mcpToken,
    orchestratorClaudeMdSrc,
    gitCommonDir,
  });
  if (!res?.session) {
    // Same "explain every drop" policy as the mcpSocketPath/
    // orchestratorClaudeMdSrc/cwd guards above: a hiddenApps rejection (or
    // any other createSession() failure -- not-installed, invalid cwd) must
    // not disappear silently just because this is the auto-resume path
    // rather than a live launch request with a client to report the error to.
    console.warn(`[scheduler] dropping prompt for schedule ${scheduleId}: ${res?.error || 'createSession failed'}`);
    return;
  }
  const session = res.session;
  session.pendingInjection = { text: entry.text, at: entry.at };
  // Safety net: deliver even if the session never emits an idle gap (e.g. a
  // plain shell). The idle path normally fires first for Claude sessions.
  // Tracked on the session so a destroyed one doesn't keep a dead timer
  // armed (it no-ops, but holds the event loop in tests and lingers in prod).
  session.pendingInjectionTimer = setTimeout(() => {
    if (session.exited || !session.pendingInjection) return;
    const inj = session.pendingInjection;
    session.pendingInjection = null;
    session.pendingInjectionTimer = null;
    const delivered = injectIntoLiveSession(session, inj.text);
    notifyFired(session, inj, delivered);
  }, RESUME_INJECT_FALLBACK_MS);
}

// Schedule a prompt to be injected at absolute epoch `at`. Returns the public
// view on success, or null if the time is invalid (past / too far ahead).
// `source` distinguishes a user-set schedule ('manual', the default, set via
// the browser's clock panel) from one the session-limit auto-detector armed
// ('auto-session-limit') -- see the onData handler below, which uses this to
// avoid clobbering a manual schedule.
export function setScheduledPrompt(id, at, text, { source = 'manual' } = {}) {
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
    sandboxOpts: session.sandboxOpts || null,
    shell: !!session.shell,
    app: session.app || 'claude',
    model: normalizeModel(session.model) || null,
    permissionMode: normalizePermissionMode(session.permissionMode),
    claudeSessionId: resumeIdForSession(session),
    sessionId: id,
    groupId: session.groupId || null,
    groupRole: session.groupRole || null,
    source,
    timer: setTimeout(() => fireSchedule(scheduleId), delay),
  };
  schedules.set(scheduleId, entry);
  session.scheduleId = scheduleId;
  persistSchedules();
  return { at, text, source };
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
      sandboxOpts: e.sandboxOpts || null,
      shell: !!e.shell,
      // Legacy persisted schedules predate the app field and were claude.
      app: isValidApp(e.app) ? e.app : 'claude',
      // Legacy schedules predate the model field; null means the app default.
      model: normalizeModel(e.model) || null,
      // Legacy schedules predate the permissionMode field; 'standard' (no
      // flag) is the safe direction.
      permissionMode: normalizePermissionMode(e.permissionMode),
      claudeSessionId: e.claudeSessionId || null,
      // Group membership survives a restart: an auto-resume re-binds the
      // role (see fireSchedule), so a member isn't orphaned by a reboot.
      groupId: e.groupId || null,
      groupRole: e.groupRole || null,
      // Legacy entries (no source field) fall back to 'manual' -- the safe
      // direction, since a manual schedule is protected from being clobbered
      // by the auto-detector while an 'auto-session-limit' one is not (see
      // the onData handler).
      source: e.source === 'auto-session-limit' ? 'auto-session-limit' : 'manual',
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
      connected: session.sockets.size > 0,
      viewers: session.sockets.size,
      shell: session.shell,
      sandbox: session.sandbox,
      sandboxOpts: session.sandboxOpts || null,
      app: session.app,
      model: session.model || null,
      permissionMode: normalizePermissionMode(session.permissionMode),
      groupId: session.groupId || null,
      groupRole: session.groupRole || null,
      isMetaAgent: !!session.isMetaAgent,
      customLabel: session.customLabel || null,
    });
  }
  return result;
}

// Privileged-consumer facade (see ws/metaAgent.js): the meta agent's tools
// legitimately read/destroy ANY session, so this facade spans all of them --
// unlike groupManager's per-group sessionApi. Kept to the minimum surface the
// meta tools need; createSession goes through routes/sessions.js's shared
// launch function instead, so REST and MCP launches can never drift.
const sessionManagerApi = {
  listSessions,
  getSession,
  destroySession,
  sandboxHomeInUsePath,
};

export function getSessionManagerApi() {
  return sessionManagerApi;
}

// Send one message to every viewer attached to a session. A viewer whose
// socket has gone away (or throws on send) must never break the pty data
// path or starve the other viewers, so each send is isolated.
//
// Dead sockets are also dropped here. With a single socket per session a
// stale one was simply overwritten by the next attach, but a SET of viewers
// keeps anything nobody removed -- and a session whose set never empties is
// a session whose destroy timer never arms, i.e. a pty that outlives its
// last real viewer forever. detachSocket is still the normal path (the ws
// 'close' handler); this is the backstop for a socket that dies without one.
function broadcast(session, payload) {
  if (!session?.sockets?.size) return;
  const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let dead = null;
  for (const chan of session.sockets.keys()) {
    if (chan.readyState !== 1) {
      (dead ??= []).push(chan);
      continue;
    }
    try {
      chan.send(str);
    } catch {
      (dead ??= []).push(chan);
    }
  }
  // Pruning re-runs the size negotiation and can broadcast a `size` of its
  // own; that recursion terminates because these sockets are gone from the
  // map by then, so the nested call finds nothing left to prune.
  if (dead) for (const chan of dead) removeViewer(session, chan);
}

// The pty has ONE size but a shared session can have several viewers with
// different window sizes, so the pty runs at the smallest of them (the same
// choice tmux makes by default): every viewer then sees the full screen,
// with the roomier ones showing unused margin. Returns null when no viewer
// has reported a usable viewport, meaning "leave the pty size alone".
function negotiateSize(session) {
  let cols = null;
  let rows = null;
  for (const viewport of session.sockets.values()) {
    if (!viewport) continue;
    const c = Number(viewport.cols);
    const r = Number(viewport.rows);
    if (Number.isFinite(c) && c > 0) cols = cols === null ? c : Math.min(cols, c);
    if (Number.isFinite(r) && r > 0) rows = rows === null ? r : Math.min(rows, r);
  }
  if (cols === null || rows === null) return null;
  return {
    cols: Math.max(MIN_PTY_COLS, Math.trunc(cols)),
    rows: Math.max(MIN_PTY_ROWS, Math.trunc(rows)),
  };
}

// Resize the pty to the negotiated size and tell every viewer what the
// agreed size is, so a client whose own request lost the negotiation can
// render at the size the pty actually uses instead of its own.
// Returns the size in force (negotiated, or the unchanged current one).
export function applyNegotiatedSize(session) {
  const target = negotiateSize(session);
  const current = { cols: session.cols, rows: session.rows };
  if (!target) return current;
  if (target.cols === session.cols && target.rows === session.rows) return current;

  if (!session.exited && session.ptyProcess) {
    try {
      session.ptyProcess.resize(target.cols, target.rows);
    } catch {
      // pty may have died between the exited check and here
      return current;
    }
  }
  session.cols = target.cols;
  session.rows = target.rows;
  broadcast(session, { type: 'size', cols: target.cols, rows: target.rows });
  return target;
}

// Record one viewer's requested window size and re-run the negotiation.
// Returns the size actually in force so the caller can answer the requester
// even when its request did not win.
export function setSocketViewport(id, socket, cols, rows) {
  const session = sessions.get(id);
  if (!session || !session.sockets.has(socket)) return null;
  session.sockets.set(socket, normalizeViewport(cols, rows));
  return applyNegotiatedSize(session);
}

function normalizeViewport(cols, rows) {
  const c = Number(cols);
  const r = Number(rows);
  if (!Number.isFinite(c) || !Number.isFinite(r) || c <= 0 || r <= 0) return null;
  return { cols: Math.trunc(c), rows: Math.trunc(r) };
}

// Attaching is additive: a second device joins the session instead of
// evicting the first. (Before this, a new client closed the incumbent with
// code 4001 and the incumbent's UI gave up reconnecting -- opening a session
// from a phone kicked the desktop off it.)
export function attachSocket(id, socket, viewport = null) {
  const session = sessions.get(id);
  if (!session) return false;

  if (session.timeoutTimer) {
    clearTimeout(session.timeoutTimer);
    session.timeoutTimer = null;
  }

  session.sockets.set(socket, normalizeViewport(viewport?.cols, viewport?.rows));
  applyNegotiatedSize(session);
  broadcast(session, { type: 'viewers', count: session.sockets.size });
  return true;
}

// Drop one viewer and settle the consequences: a wider negotiated size for
// whoever is left, or the destroy timer once the session has no viewers at
// all. No-op if this socket was not attached, so a duplicate detach (or a
// prune racing the ws 'close' handler) cannot fire spurious viewer events.
function removeViewer(session, socket) {
  if (!session.sockets.delete(socket)) return;

  if (session.sockets.size > 0) {
    // A viewer leaving can widen the negotiated size (it may have been the
    // smallest one), so re-run it for those still attached.
    applyNegotiatedSize(session);
    broadcast(session, { type: 'viewers', count: session.sockets.size });
    return;
  }

  const timeout = session.exited
    ? SESSION_EXITED_TIMEOUT_MS
    : SESSION_TIMEOUT_MS;
  if (timeout > 0) {
    console.log(
      `[session] ${session.id} last viewer left; destroying in ${timeout}ms`
      + `${session.exited ? ' (pty already exited)' : ''}`
    );
  }
  startTimeout(session, timeout);
}

export function detachSocket(id, socketToDetach) {
  const session = sessions.get(id);
  if (!session) return;
  removeViewer(session, socketToDetach);
}

// `reason` is for the teardown log only -- it has no effect on behavior. It
// exists because sessions used to vanish with no record of which path took
// them (idle timeout? pty exit cleanup? an explicit teardown? a restart?),
// which made "my session died early" impossible to diagnose after the fact.
export function destroySession(id, { keepSchedule = true, reason = 'request' } = {}) {
  const session = sessions.get(id);
  if (!session) return;

  console.log(
    `[session] ${id} destroyed (reason=${reason}, `
    + `app=${session.app || (session.shell ? 'shell' : 'unknown')}, cwd=${session.cwd}, `
    + `uptime=${Date.now() - session.createdAt}ms, ptyExited=${session.exited}, `
    + `viewers=${session.sockets.size})`
  );

  if (session.timeoutTimer) {
    clearTimeout(session.timeoutTimer);
    session.timeoutTimer = null;
  }

  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  if (session.pendingInjectionTimer) {
    clearTimeout(session.pendingInjectionTimer);
    session.pendingInjectionTimer = null;
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

  // Force-close the pty master read stream. kill() alone only signals the
  // child; if a grandchild still holds the slave fd (or the child lingers),
  // the master never sees EOF and the read stream keeps the event loop
  // alive indefinitely (hanging test runners and lingering handles in prod).
  try {
    session.ptyProcess.destroy();
  } catch {
    // already torn down
  }

  // Remove the sandbox's unique rootlesskit state dir, tear down the
  // host-side git-broker (a plain child process, not part of the
  // --unshare-pid tree the kill above reaps), and remove the commit-message
  // guard's runtime dir (see startCommitGuard, sandbox.js -- just a JSON
  // config file, no process, unlike gitBroker there's nothing to kill).
  //
  // usePtyHost: skipped entirely -- pty-host's own `destroy` RPC handler
  // already does all of it (plan5 2.1: it owns teardown for whatever it
  // built). session.sandboxStateDir is still populated in this mode (see
  // createSession -- needed for dockerAvailability()'s dockerTag lookup), so
  // this guard is required, not just redundant-but-harmless: server本体 must
  // not race pty-host to remove the same directory out from under it.
  // session.sandboxGitBrokerProc/Dir/CommitGuardDir stay null in this mode,
  // so those blocks would already no-op even without the guard.
  if (!isPtyHostEnabled()) {
    if (session.sandboxStateDir) {
      try {
        rmSync(session.sandboxStateDir, { recursive: true, force: true });
      } catch {
        // nothing to remove / still held — harmless
      }
    }

    if (session.sandboxGitBrokerProc) {
      try {
        session.sandboxGitBrokerProc.kill('SIGTERM');
      } catch {
        // already dead
      }
    }
    if (session.sandboxGitBrokerDir) {
      try {
        rmSync(session.sandboxGitBrokerDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    if (session.sandboxCommitGuardDir) {
      try {
        rmSync(session.sandboxCommitGuardDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    if (session.sandboxSeatbeltDir) {
      try {
        rmSync(session.sandboxSeatbeltDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    // Orchestrator rule files materialized into the project dir by the
    // seatbelt backend (NOT under seatbeltDir -- unlink each best-effort).
    // A successor launched from the same deterministic orchestratorDir
    // (restart / scheduled auto-resume) owns the same paths: only unlink
    // files no other registered session still references, or the successor's
    // overlay is deleted out from under it mid-session.
    if (Array.isArray(session.sandboxSeatbeltFiles)) {
      releaseSeatbeltOverlay(
        session.sandboxSeatbeltFiles,
        [...sessions.values()].filter((other) => other !== session).map((other) => other.sandboxSeatbeltFiles),
      );
    }
  } else {
    // Step3 (plan5): this session's restore metadata (see
    // setPtyHostSessionMeta in createSession()'s usePtyHost branch) is only
    // useful while the pty-host session it describes is still alive --
    // destroySession() tearing it down here (or restorePtyHostSessions()
    // finding it already gone at the next boot) both mean there is nothing
    // left to reattach to.
    deletePtyHostSessionMeta(id);
  }

  sessions.delete(id);
}

// Retire-first for overlay reuse (#12): destroy the exited predecessor before
// the caller spawns a successor into the same deterministic orchestratorDir,
// and -- in pty-host mode -- wait for pty-host's destroy ack (overlay unlink
// included) first. destroySession() alone is fire-and-forget there
// (RemotePty kill/destroy send no-reply frames), so a successor spawned
// immediately after would race the predecessor's unlink, and a UDS drop in
// between would lose the destroy entirely while the successor (seeing
// pre-existing overlay files) claims no ownership. Direct-spawn
// destroySession() unlinks synchronously, so no wait is needed there.
export async function retireSessionForReuse(id) {
  const session = sessions.get(id);
  if (!session) return;
  if (isPtyHostEnabled()) {
    try {
      const shardIndex = session.shardIndex ?? shardIndexForKey(shardKeyForSession(session));
      await getPtyHostClient(shardIndex).destroySession(id);
    } catch { /* best effort -- fall through to local bookkeeping */ }
  }
  destroySession(id, { keepSchedule: true, reason: 'retire-first' });
}

let ptyHostDestroyedHandlerArmed = false;

// Registers pty-host's `destroyed` push-event handler exactly once
// (idempotent -- server/index.js calls this unconditionally at boot; a no-op
// when the feature flag is off, so it never opens the UDS socket in that
// case). See plan5 5.2.3: pty-host can tear a session down on its own (its
// own idle/exited timeout, or as a crash-recovery backstop once server本体's
// connection drops and never comes back) without server本体 having called
// destroySession() itself -- this is the only path that then cleans up the
// local `sessions` Map entry for that case. When destroySession() got there
// first (the common case), `sessions.get(sessionId)` is already gone and
// this is a no-op.
//
// Plan5 Step5: registers against every currently-configured shard
// (getAllPtyHostClients()), not just shard 0 -- a session destroyed on its
// own by ANY instance must still be noticed. shardCount() is read once here,
// at boot; it is not expected to change over this process's lifetime (see
// ptyHostClient.js's shardCount() comment).
export function initPtyHostDestroyedHandler() {
  if (!isPtyHostEnabled()) return;
  if (ptyHostDestroyedHandlerArmed) return;
  ptyHostDestroyedHandlerArmed = true;
  for (const client of getAllPtyHostClients()) {
    client.onDestroyed((sessionId, reason) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      if (session.timeoutTimer) {
        clearTimeout(session.timeoutTimer);
        session.timeoutTimer = null;
      }
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = null;
      }
      // Same as destroySession()'s teardown: a dead session must not keep this
      // RESUME_INJECT_FALLBACK_MS safety-net timer armed (see fireSchedule()'s
      // comment on it) -- it would no-op harmlessly once fired, but there is
      // no reason to let it linger holding the event loop / referencing a
      // session already gone from the sessions Map.
      if (session.pendingInjectionTimer) {
        clearTimeout(session.pendingInjectionTimer);
        session.pendingInjectionTimer = null;
      }
      console.log(`[session] ${sessionId} destroyed by pty-host (reason=${reason || 'unknown'}, viewers=${session.sockets.size})`);
      sessions.delete(sessionId);
      // Same reasoning as destroySession()'s else-branch: pty-host tore this
      // session down on its own, so there is nothing left to reattach to at the
      // next restore.
      deletePtyHostSessionMeta(sessionId);
    });
  }
}

// Test seam: re-arm initPtyHostDestroyedHandler() for a test that starts its
// own in-process pty-host and needs the handler registered against a fresh
// PtyHostClient (see ptyHostClient.js's resetPtyHostClientForTests()).
export function resetPtyHostDestroyedHandlerForTests() {
  ptyHostDestroyedHandlerArmed = false;
}

let ptyHostDisconnectedHandlerArmed = false;

// Issue #143 problem 2: pairs with initPtyHostDestroyedHandler() above, but
// reacts to an entire SHARD disappearing (see ptyHostClient.js's
// onDisconnected() -- fired only when a shard's pty-host process actually
// died, never for our own close() during gracefulShutdown()/test teardown)
// rather than one session being torn down individually.
//
// Unlike the `destroyed` handler, this cannot rely on the ordinary
// ptyProcess.onExit() path having already run: `exit`/`destroyed` are both
// events pty-host sends over the very connection that just died, so neither
// will EVER arrive for a session whose shard is gone. That means this
// handler must itself do everything onExit would have -- including running
// sessionExitListeners (groupManager.js's onSessionExit stops the dead
// orchestrator's control broker / a dead worker's handoff channel and
// auto-destroys an emptied group; skipping it here would leak those brokers
// forever, exactly the kind of silently-broken-forever state this Issue is
// about) -- not just the local sessions Map bookkeeping.
//
// Deliberately deletes from `sessions` immediately (unlike a normal pty
// exit, which lingers exited:true behind SESSION_EXITED_TIMEOUT_MS so a
// client can still read final scrollback) -- Issue #143's own complaint is
// that a ghosted session keeps appearing in GET /api/sessions, and there is
// no live pty left to reattach to even if a client did ask. ptyHostSessionMeta
// is deliberately left untouched (see restorePtyHostSessions()'s
// unreachableShards handling): the next restore, once this shard is back,
// either reattaches a session that in fact survived or sweeps the entry via
// the existing orphaned-metadata path -- guessing now would destroy
// information Step6 (auto-resume) will want.
export function initPtyHostDisconnectedHandler() {
  if (!isPtyHostEnabled()) return;
  if (ptyHostDisconnectedHandlerArmed) return;
  ptyHostDisconnectedHandlerArmed = true;
  for (const client of getAllPtyHostClients()) {
    client.onDisconnected((sessionIds) => {
      for (const sessionId of sessionIds) {
        const session = sessions.get(sessionId);
        if (!session) continue;
        if (session.timeoutTimer) {
          clearTimeout(session.timeoutTimer);
          session.timeoutTimer = null;
        }
        if (session.idleTimer) {
          clearTimeout(session.idleTimer);
          session.idleTimer = null;
        }
        if (session.pendingInjectionTimer) {
          clearTimeout(session.pendingInjectionTimer);
          session.pendingInjectionTimer = null;
        }
        session.exited = true;
        // session.claudeSessionId starts life as null (buildSessionRecord)
        // and is otherwise refreshed only by a real pty exit (same
        // extraction as buildSessionRecord's ptyProcess.onExit, above) --
        // never while the session is merely running. Skipping this here
        // would broadcast a null claudeSessionId below, and the frontend's
        // 'exit' handler treats a falsy claudeSessionId as "nothing to
        // resume" and WIPES the browser's stored resume key for this
        // app/cwd, even though the conversation itself is still resumable
        // (only this shard's connection died, not the underlying session).
        if (!session.shell) {
          session.claudeSessionId = extractResumeSessionId(
            session.app,
            session.outputBuffer.slice(-50).join('')
          );
        }
        // Keep any pending scheduled prompt alive across this exit: refresh
        // its resume id and detach it so it auto-resumes the conversation at
        // fire time (same reason buildSessionRecord's ptyProcess.onExit
        // calls this).
        refreshScheduleOnExit(session);
        // Issue #119 Step6-0: this shard's pty-host process is gone -- no
        // more onData chunks will ever arrive for THIS session record to
        // debounce against, so any value still only pending in memory must
        // reach ptyHostSessionMeta.json now. This is the scenario the
        // pending-flush contract exists for: pty-host itself may already be
        // auto-resuming this exact session id from that very file (see
        // server/pty-host/index.js) by the time this handler runs.
        if (session.resumeIdWriteTimer) flushResumeIdWriteback(session);
        for (const fn of sessionExitListeners) {
          try {
            fn(session);
          } catch {
            // a listener must never break this cleanup path
          }
        }
        console.log(`[session] ${sessionId} marked exited: its pty-host shard disconnected (viewers=${session.sockets.size})`);
        // exitCode/signal are genuinely unknown -- pty-host died mid-flight,
        // no exit frame was ever sent -- so both ride as null. Same
        // {type:'exit', ...} shape a real pty exit broadcasts (see
        // buildSessionRecord's ptyProcess.onExit above) so the existing
        // frontend handler needs no changes.
        broadcast(session, {
          type: 'exit',
          exitCode: null,
          signal: null,
          claudeSessionId: session.claudeSessionId,
        });
        sessions.delete(sessionId);
      }
    });
  }
}

// Test seam: re-arm initPtyHostDisconnectedHandler() for a test that starts
// its own in-process pty-host and needs the handler registered against a
// fresh PtyHostClient (see ptyHostClient.js's resetPtyHostClientForTests()).
export function resetPtyHostDisconnectedHandlerForTests() {
  ptyHostDisconnectedHandlerArmed = false;
}

// Shared by restorePtyHostSessions() (below, the whole-fleet boot-time
// reconcile) and reconcileShardAfterReconnect() (Issue #119 Step6, a single
// shard's post-crash reconcile): given one live() entry pty-host reports and
// its matching restore metadata, reattaches + rebuilds this module's
// `sessions` Map entry for it and resumes streaming its output. The caller
// has already confirmed `live` isn't already exited. Returns true if the
// session was restored, false if the attach itself failed (network blip
// between list() and here -- the caller decides whether that's worth
// retrying).
async function reattachLiveSession(live, meta, client, shardIndex) {
  // attach() can throw if pty-host has become unreachable since the list()
  // call that found `live` (e.g. it was restarted mid-loop while restoring
  // many sessions) -- caught per-session so one bad reattach doesn't abort
  // the whole restore (leaving every subsequent live session unrestored) or
  // skip whatever sweep the caller runs after this loop.
  let rpty;
  try {
    rpty = await client.attach(live.id, {
      cols: live.cols,
      rows: live.rows,
      pid: live.pid,
      sandbox: { active: live.sandbox?.active, docker: live.sandbox?.docker, stateDir: meta.sandboxStateDir },
    });
  } catch (err) {
    console.warn(`[session] ${live.id}: restore attach failed, skipping (${err.message})`);
    return false;
  }

  buildSessionRecord(live.id, rpty, {
    ...meta,
    cols: live.cols,
    rows: live.rows,
    // Reattaching, not launching: this session is by definition already
    // past whatever TUI init burst it once had (see buildSessionRecord's
    // header comment on `settled`).
    settled: true,
    // Absorbs restore-metadata entries written before Step5 existed (no
    // shardIndex field at all): every such entry was necessarily created
    // by the sole pre-Step5 instance, i.e. shard 0.
    shardIndex: meta.shardIndex ?? shardIndex,
  });

  // Replays the retained backlog through the exact same onData path a
  // live session uses (buildSessionRecord wired it above) -- a
  // still-pending permission prompt gets AutoYes'd exactly as it would
  // on a live session, and outputBuffer/screenModel end up in the state
  // a browser reconnecting expects. Same call shape as createSession()'s
  // own post-spawn subscribe (sinceSeq 0 = full retained backlog).
  try {
    await client.subscribe(rpty, 0);
  } catch (err) {
    console.warn(`[session] ${live.id}: restore subscribe failed (will retry on reconnect): ${err.message}`);
  }

  return true;
}

// Plan5 Step3: rebuilds `sessions` Map entries for pty-host sessions that
// survived a server本体 restart (pty-host is a separate process/systemd unit
// -- see server/pty-host/'s header docs -- so its ptys keep running across a
// server本体 crash or `systemctl restart ccserver` even though this Map does
// not). A no-op when CCSERVER_PTY_HOST is unset.
//
// Call this BEFORE restoreGroups() (see server/index.js): a group's
// memberSaved fallback only kicks in when sessionApi.getSession(sessionId)
// finds nothing, so restoring live pty-host sessions into `sessions` first
// lets a still-running group member be found as a live session instead of
// being (wrongly) treated as gone.
//
// Matches pty-host's list() against this module's own restore metadata (see
// ptyHostSessionMeta.js) by id, three-way:
//   - both agree (and the pty hasn't exited) -> reattach + restore.
//   - pty-host has it, metadata doesn't -> never restore from partial/guessed
//     fields (see plan5 Step3: "無理に最小構成で復元しない"); leave it for
//     pty-host's own idle/exited timeout to eventually reap.
//   - metadata has it, pty-host doesn't (pty-host itself restarted/crashed,
//     or the pty already exited) -> the metadata entry describes nothing
//     restorable any more; drop it.
// An already-exited-but-not-yet-reaped pty-host session (still inside its
// post-exit grace window) is deliberately treated as the third case, not
// restored: Step3 hands a live, attachable terminal back to the browser --
// there's no running process to hand back for one that's already exited, and
// replaying whether the group/schedule machinery should react to an exit
// that happened in the PREVIOUS server本体 process is out of scope here (see
// this file's gracefulShutdown()/destroySession() for how a live exit is
// normally handled).
//
// Plan5 Step5 (partitioning): loops this whole three-way match once per
// shard (getAllPtyHostClients()), attach()ing/subscribe()ing through that
// SAME shard's client both times (the exact trap ptyHostClient.js's header
// comment warns about -- see also createSession()'s ptyHostShardClient
// reuse). liveById accumulates every shard's list() into one shared Map
// before the final orphaned-metadata sweep runs, so an entry legitimately
// living on shard 2 isn't mistaken for orphaned just because shard 0 was
// scanned first.
//
// A single unreachable shard must NOT make the orphaned-metadata sweep wrong
// for every OTHER shard: unlike the pre-Step5 single-instance version (which
// could safely bail out of the whole function on one failure), here that
// would mean one instance being briefly unreachable wipes out restore
// metadata that legitimately lives on healthy shards' still-alive sessions.
// So each unreachable shard's index is tracked, and the sweep skips any
// metadata entry whose (possibly pre-Step5-missing, defaulted to 0) shardIndex
// names an unreachable shard -- that entry is left alone to be resolved on a
// future restore attempt once its shard comes back, rather than guessed at
// now.
export async function restorePtyHostSessions() {
  if (!isPtyHostEnabled()) {
    return { restored: 0, orphanedLive: 0, orphanedMeta: 0, alreadyExited: 0 };
  }

  const metaAll = loadPtyHostSessionMeta();
  const liveById = new Map();
  const unreachableShards = new Set();
  let restored = 0;
  let orphanedLive = 0;
  let alreadyExited = 0;

  const shardClients = getAllPtyHostClients();
  for (let shardIndex = 0; shardIndex < shardClients.length; shardIndex++) {
    const client = shardClients[shardIndex];
    let liveList;
    try {
      liveList = await client.list();
    } catch (err) {
      console.error(`[session] restorePtyHostSessions: could not reach pty-host shard ${shardIndex} (${err.message}) -- skipping restore for this shard`);
      unreachableShards.add(shardIndex);
      continue;
    }

    for (const live of liveList) liveById.set(live.id, live);

    for (const live of liveList) {
      const meta = metaAll[live.id];
      if (!meta) {
        console.warn(`[session] pty-host session ${live.id} (shard ${shardIndex}) has no restore metadata -- leaving it to pty-host's own idle/exited timeout`);
        orphanedLive++;
        continue;
      }
      if (live.exited) {
        deletePtyHostSessionMeta(live.id);
        alreadyExited++;
        continue;
      }

      if (await reattachLiveSession(live, meta, client, shardIndex)) restored++;
    }
  }

  // A metadata entry whose id no shard's list() returned describes nothing
  // restorable any more (its pty-host instance itself restarted/crashed
  // between this entry's write and this boot) -- drop it rather than let it
  // accumulate. Skipped for entries whose own shard was unreachable this
  // round (see this function's header comment) -- those get another chance
  // next restore instead of being guessed at now.
  let orphanedMeta = 0;
  for (const [id, meta] of Object.entries(metaAll)) {
    if (liveById.has(id)) continue;
    if (unreachableShards.has(meta.shardIndex ?? 0)) continue;
    deletePtyHostSessionMeta(id);
    orphanedMeta++;
  }

  return { restored, orphanedLive, orphanedMeta, alreadyExited };
}

let ptyHostReconnectedHandlerArmed = false;

// Issue #119 Step6: without this, Step6's whole benefit is invisible from
// the user's side. initPtyHostDisconnectedHandler (Issue #143) treats a
// shard's PtyHostClient disconnecting as every session it held being lost --
// correct when pty-host itself has no way to bring them back, but Step6
// gives it exactly that way (see server/pty-host/index.js's own
// auto-resume, keyed by the SAME session ids ptyHostSessionMeta.json already
// names). Once that shard's client reconnects, pty-host may already be
// running some of those same ids again; this reattaches this module's side
// of the same reconciliation restorePtyHostSessions() does at boot, scoped
// to just the one shard that came back (never a global rescan -- every OTHER
// shard's sessions were never touched by this shard's crash, and re-running
// the boot-time function verbatim would re-buildSessionRecord() every
// currently-healthy session on every other shard too, silently replacing
// their live records).
// Known minor limitation, deliberately not handled here: unlike
// restorePtyHostSessions(), this never sweeps metaAll for THIS shard's own
// orphaned metadata (an entry whose auto-resume attempt failed on pty-host's
// side, per autoResumeSessions' own try/catch in server/pty-host/index.js).
// Such an entry lingers in ptyHostSessionMeta.json until the next full
// server本体 restart's restorePtyHostSessions() sweep reaches it -- harmless
// (it names nothing currently live, and is skipped safely at the next
// reconcile too, since sessions.has()/metaAll lookups above just find no
// match for it) but not actively cleaned up by a reconnect alone.
async function reconcileShardAfterReconnect(shardIndex, client) {
  const metaAll = loadPtyHostSessionMeta();
  let liveList;
  try {
    liveList = await client.list();
  } catch (err) {
    // Already unreachable again by the time this ran -- its own next
    // reconnect will retry this same reconcile.
    console.warn(`[session] shard ${shardIndex} reconnected but is already unreachable again (${err.message})`);
    return;
  }

  let restored = 0;
  for (const live of liveList) {
    // Defensive, should never actually trigger: every session this shard's
    // disconnect handler held was already deleted from `sessions`, and no
    // NEW session could have been created on this shard while it was
    // unreachable (createSession()'s spawn() call would have failed
    // outright) -- but never clobber an existing live record regardless.
    if (sessions.has(live.id)) continue;
    const meta = metaAll[live.id];
    // pty-host has it, this module's metadata doesn't -- same as
    // restorePtyHostSessions()'s orphanedLive case: never restore from
    // guessed fields, leave it to pty-host's own idle/exited timeout.
    if (!meta) continue;
    if (live.exited) {
      deletePtyHostSessionMeta(live.id);
      continue;
    }
    if (await reattachLiveSession(live, meta, client, shardIndex)) restored++;
  }
  if (restored > 0) {
    console.log(`[session] shard ${shardIndex} reconnected: reattached ${restored} session(s) pty-host auto-resumed while it was unreachable`);
  }
}

// Registers, on every shard's client, a callback fired only on a RECONNECT
// (never the first connect at boot -- see ptyHostClient.js's onReconnected)
// that runs reconcileShardAfterReconnect() for that one shard. A no-op when
// CCSERVER_PTY_HOST is unset; idempotent the same way
// initPtyHostDestroyedHandler/initPtyHostDisconnectedHandler are.
export function initPtyHostReconnectedHandler() {
  if (!isPtyHostEnabled()) return;
  if (ptyHostReconnectedHandlerArmed) return;
  ptyHostReconnectedHandlerArmed = true;
  const shardClients = getAllPtyHostClients();
  for (let shardIndex = 0; shardIndex < shardClients.length; shardIndex++) {
    const client = shardClients[shardIndex];
    client.onReconnected(() => {
      reconcileShardAfterReconnect(shardIndex, client).catch((err) => {
        console.error(`[session] shard ${shardIndex} reconnect reconcile failed: ${err.message}`);
      });
    });
  }
}

// Test seam: re-arm initPtyHostReconnectedHandler() for a test that starts
// its own in-process pty-host and needs the handler registered against a
// fresh PtyHostClient (see ptyHostClient.js's resetPtyHostClientForTests()).
export function resetPtyHostReconnectedHandlerForTests() {
  ptyHostReconnectedHandlerArmed = false;
}

export function destroyAllSessions() {
  for (const [id] of sessions) {
    destroySession(id, { reason: 'shutdown' });
  }
}

// Public (serializable) view of a session for the graceful-shutdown
// .saved-sessions.json write. Group membership is preserved so a restarted
// server doesn't surface group members as plain standalone sessions.
// `claudeId` is the best-known resume id (already-resolved by the caller,
// falling back to a buffer extraction) -- keeps the on-exit id as the
// primary source.
export function savedSessionPublic(session, claudeId) {
  return {
    cwd: session.cwd,
    claudeSessionId: claudeId || null,
    sandbox: !!session.sandbox,
    sandboxOpts: session.sandboxOpts || null,
    app: session.app || 'claude',
    model: normalizeModel(session.model) || null,
    permissionMode: normalizePermissionMode(session.permissionMode),
    groupId: session.groupId || null,
    groupRole: session.groupRole || null,
    customLabel: session.customLabel || null,
  };
}

export function gracefulShutdown() {
  // Step4 (plan5): when pty-host is enabled (isPtyHostEnabled()), pty-host
  // owns these ptys as a separate, independently-restarted systemd unit (see
  // server/pty-host/index.js's header comment + Step0's PoC finding that a
  // killed parent takes its ptys down with it) -- killing them here would
  // defeat Step3's restore-on-restart (restorePtyHostSessions()) before it
  // ever gets a chance to run: there would be nothing left for it to
  // reattach to. Server本体 must only drop its own local bookkeeping and
  // disconnect THIS process's UDS link, leaving the actual ptys running on
  // pty-host for the next boot's restorePtyHostSessions() to find via
  // list(). No .saved-sessions.json write either: that file only feeds the
  // direct-spawn restore path below -- direct-spawn is Step7's permanent
  // fallback mode, not code on its way out, but it still has nothing to do
  // with THIS branch: pty-host sessions restore from ptyHostSessionMeta.json
  // instead, which createSession() already keeps continuously up to date
  // (see setPtyHostSessionMeta), so there is nothing new to persist here.
  // destroyAllSessions()/destroySession() are deliberately not reused for
  // this cleanup: both call
  // session.ptyProcess.kill()/.destroy(), which for a RemotePty is an actual
  // fire-and-forget kill/destroy RPC to pty-host (see ptyHostClient.js) --
  // exactly the "pty dies with the server本体 restart" bug this step fixes.
  if (isPtyHostEnabled()) {
    for (const [id, session] of sessions) {
      if (session.timeoutTimer) {
        clearTimeout(session.timeoutTimer);
        session.timeoutTimer = null;
      }
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = null;
      }
      if (session.pendingInjectionTimer) {
        clearTimeout(session.pendingInjectionTimer);
        session.pendingInjectionTimer = null;
      }
      sessions.delete(id);
    }
    // Plan5 Step5: close every shard's client, not just shard 0 -- sessions
    // may be spread across any of them.
    for (const client of getAllPtyHostClients()) client.close();
    return Promise.resolve();
  }

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
        const claudeId = session.claudeSessionId || extractResumeId(session);
        // claude sessions are saved when their resume id is known; opencode
        // / copilot / codex / commandcode sessions are always saved (resume
        // happens via `opencode -c` / `copilot --continue` /
        // `codex resume --last` / `commandcode -c`).
        if (claudeId || session.app === 'opencode' || session.app === 'copilot' || session.app === 'codex' || session.app === 'commandcode') {
          savedSessions.push(savedSessionPublic(session, claudeId));
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

// Read .saved-sessions.json WITHOUT unlinking it or touching the cache --
// used by groupManager.restoreGroups() to match each restored group member's
// resume info (app/cwd/claudeSessionId/sandbox) while the file is still
// intact.
export function peekSavedSessions() {
  try {
    return JSON.parse(readFileSync(SAVED_SESSIONS_PATH, 'utf-8'));
  } catch {
    return null;
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
    session.timeoutTimer = null;
  }

  // Non-positive = the operator disabled idle destruction
  // (CCSERVER_SESSION_TIMEOUT_MS=0); the session then survives until its pty
  // exits or someone tears it down explicitly. The exited-session cleanup
  // never reaches here with a non-positive value (resolveExitedTimeoutMs
  // clamps to >= 1s), so an exited session is always eventually reaped.
  if (!(ms > 0)) return;

  session.timeoutTimer = setTimeout(() => {
    destroySession(session.id, {
      reason: session.exited ? 'exited-timeout' : 'idle-timeout',
    });
  }, ms);
}
