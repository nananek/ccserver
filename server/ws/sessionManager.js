import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSandboxSpawn, resolveApp, sandboxAvailable, loadSandboxConfig, persistentHomeDir, dockerSandboxAvailable, dockerdStatus, dockerdLockHeld } from './sandbox.js';
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
  appResumeArgs,
  appModelArgs,
  appSubmitKey,
  extractResumeSessionId,
  detectPermissionPrompt,
} from './appLaunch.js';
import { stripAnsi } from './mcpTools.js';
import { findSessionLimitReset } from './sessionLimitDetect.js';
import { recordSessionLimitReset } from '../sessionLimitState.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAVED_SESSIONS_PATH = process.env.CCSERVER_SAVED_SESSIONS_PATH || join(__dirname, '..', '..', '.saved-sessions.json');
const SCHEDULES_PATH = join(__dirname, '..', '..', '.scheduled-prompts.json');

const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours for active sessions
const SESSION_EXITED_TIMEOUT_MS = 30 * 1000;
const OUTPUT_BUFFER_MAX_BYTES = 512 * 1024;
const IDLE_TIMEOUT_MS = 3000;

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
// the orchestrator's control broker) and returns its sockPath. Used by the
// scheduled-prompt auto-resume path, where a group member's session is
// recreated outside the explicit launch flows.
const mcpSocketResolvers = new Set();

export function setMcpSocketResolver(fn) {
  mcpSocketResolvers.add(fn);
}

// Resolve the MCP socket path for a group member being recreated. Resolves to
// null when no resolver can produce one (group gone, broker failed, or not a
// group member) -- the caller then launches without MCP injection.
export async function resolveMcpSocketForSession(groupId, groupRole) {
  for (const fn of mcpSocketResolvers) {
    try {
      const sockPath = await fn(groupId, groupRole);
      if (sockPath) return sockPath;
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

// Which agent new sessions launch when the client doesn't request one
// (legacy scheduled prompts, or a client that predates app selection).
// Config-driven rather than a hardcoded constant, per sandbox.config.json's
// gitignored-real-file / committed-.example.json pattern -- so the default
// lives in the (untracked) config, not in committed source.
function defaultApp() {
  return loadSandboxConfig().defaultApp;
}

// Model normalization for storage/serialization: `model` is an optional
// non-empty string, or explicit null meaning "use the app default model". Any
// other value (empty string, wrong type) is coerced to null so an invalid
// value can never leak into persistence or the CLI arg builder.
function normalizeModel(model) {
  return typeof model === 'string' && model.length > 0 ? model : null;
}

export function createSession({ cwd, cols, rows, claudeSessionId, shell, sandbox, sandboxOpts, app, model, resumeLast, groupId = null, groupRole = null, mcpSocketPath = null, projectName = null, reuseSandboxHome = true, orchestratorClaudeMdSrc = null, gitCommonDir = null, groupFilesDir = null, isMetaAgent = false, isReviewJob = false, sandboxHomeCreatedBy = null }) {
  const id = randomUUID();

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
  // not just automated/edge-case callers. Shells are unaffected: plain
  // /bin/bash starts fine at /.
  if (!shell && cwd === '/') {
    return {
      sessionId: id,
      session: null,
      error: 'Cannot launch in the filesystem root (/) -- claude aborts immediately there. Choose a working directory first.',
    };
  }

  // Which agent CLI this session runs. Shell sessions have no app.
  const sessionApp = shell ? null : (isValidApp(app) ? app : defaultApp());
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
  // regardless of whether a group exists"). Shells and copilot are excluded
  // outright (see shouldInjectReviewer); the feature is off by default
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
  // excludes copilot, and a review job is never a shell), so this never
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
    args = appResumeArgs(sessionApp, claudeSessionId, { resumeLast });
    // Model selection must accompany fresh launches and resume alike; the
    // helper only emits the flag for apps whose CLI is verified to accept it.
    args.push(...appModelArgs(sessionApp, sessionModel));
  }
  command = resolveCommand(command);

  // forceSandbox (sandbox.config.json) overrides the client's per-launch
  // choice: every session -- agents and shells alike -- must run sandboxed,
  // and a launch is refused when the sandbox can't be built instead of
  // falling back to a direct spawn. `sandboxRequested` is the mode oracle for
  // the MCP bridge config below: a requested sandbox either builds (mode
  // 'sandbox') or errors out (the config is then never used), so 'host' is
  // only ever reached when the session genuinely runs unsandboxed.
  const forceSandbox = loadSandboxConfig().forceSandbox;
  const sandboxRequested = (forceSandbox || sandbox) && process.platform !== 'win32' && sandboxAvailable();

  // MCP config injection -- never written to a file (see mcpConfig.js). Combo
  // sessions (groupId set) get their role's broker (ccserver); notify-enabled
  // sessions additionally get ccserver-notify, whose bridge command depends on
  // whether this session ends up sandboxed (the fixed in-sandbox path vs. the
  // host node+bridge). The args must be in the target command before
  // buildSandboxSpawn runs, so the mode is derived from sandboxRequested.
  let mcpEnv = {};
  if (sessionApp && (mcpSocketPath || useNotify || useUsage || useMeta || useReviewer)) {
    const injected = buildMcpConfigArgsAndEnv(sessionApp, {
      // ccserver (the group broker) only when the session has a group socket:
      // standalone notify sessions must not get a broken ccserver entry (its
      // bridge would point at a socket that is never bound for them).
      groupMcp: !!mcpSocketPath,
      notify: useNotify ? {
        mode: sandboxRequested ? 'sandbox' : 'host',
        sockPath: notifySocketPath,
        identity: notifyIdentity,
      } : undefined,
      usage: useUsage ? {
        mode: sandboxRequested ? 'sandbox' : 'host',
        sockPath: usageSocketPath,
      } : undefined,
      meta: useMeta ? {
        mode: sandboxRequested ? 'sandbox' : 'host',
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
        mode: sandboxRequested ? 'sandbox' : 'host',
        sockPath: reviewerSocketPath,
        identity: reviewerIdentity,
      } : undefined,
    });
    mcpEnv = injected.env;
    args.push(...injected.args);
  }

  // Optionally wrap the target in a filesystem sandbox (Linux only) so it can
  // only see the project directory plus configured paths, with an isolated
  // rootless docker inside. See sandbox.js.
  let useSandbox = false;
  let sandboxDocker = false;
  let sandboxStateDir = null;
  let sandboxGitBrokerProc = null;
  let sandboxGitBrokerDir = null;
  if (sandboxRequested) {
    // A fresh (wipe) sandbox is refused while another sandbox of the same
    // project is still using the same persistent HOME -- deleting the host dir
    // under a live bind mount would corrupt that session. The client disables
    // the "new" option in the same situation (GET /api/sandbox/status), so
    // this is the authoritative backstop.
    if (loadSandboxConfig().persistentHome && !reuseSandboxHome) {
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
      const spawn = buildSandboxSpawn({ cwd, targetCommand: [command, ...args], app: sessionApp, sandboxOpts, mcpSocketPath, notifySocketPath, usageSocketPath, metaSocketPath, reviewerSocketPath, reuseSandboxHome, orchestratorClaudeMdSrc, gitCommonDir, groupFilesDir: resolvedGroupFilesDir, sandboxHomeCreatedBy });
      command = spawn.command;
      args = spawn.args;
      sandboxDocker = !!spawn.docker;
      sandboxStateDir = spawn.stateDir || null;
      sandboxGitBrokerProc = spawn.gitBrokerProc || null;
      sandboxGitBrokerDir = spawn.gitBrokerDir || null;
      useSandbox = true;
    } catch (err) {
      return { sessionId: id, session: null, error: `Failed to build sandbox: ${err.message}` };
    }
  } else if (forceSandbox) {
    const reason = process.platform === 'win32'
      ? 'the sandbox is Linux-only'
      : 'bwrap is not available on this host';
    return {
      sessionId: id,
      session: null,
      error: `Cannot launch: sandbox.config.json sets "forceSandbox": true, but ${reason}. Install bwrap (bubblewrap) or disable forceSandbox.`,
    };
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
    return { sessionId: id, session: null, error: `Failed to spawn "${command}": ${err.message}` };
  }

  const session = {
    id,
    cwd,
    shell: !!shell,
    app: sessionApp,
    model: sessionModel,
    groupId,
    groupRole,
    // True only for sessions launched with the explicit isMetaAgent flag (the
    // privileged self-management agent). Display/debug bookkeeping -- the
    // authorization boundary is the meta broker socket, not this flag.
    isMetaAgent: !!isMetaAgent,
    sandbox: useSandbox,
    sandboxOpts: useSandbox ? (sandboxOpts || null) : null, // per-launch gpg/sshAgent override, for schedule/resume replay
    docker: sandboxDocker, // whether THIS session's sandbox launched with docker (see dockerAvailability)
    dockerTag: sandboxDocker && sandboxStateDir ? basename(sandboxStateDir) : null, // matches CCSANDBOX_DOCKERD_TAG (sandbox.js), identifies this session's dockerd in the status file
    sandboxStateDir, // rootlesskit state dir to remove on teardown (docker only)
    sandboxGitBrokerProc, // host-side git-broker child process, killed on teardown
    sandboxGitBrokerDir, // its runtime dir (socket + allow-list), removed on teardown
    reuseSandboxHome, // true = keep the previous persistent HOME, false = started fresh (wiped)
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
    settled: false, // reached the first idle gap (TUI init burst over) -- the send_input settle gate
    settleWaiters: [], // resolvers waiting on `settled` (see waitUntilSettled)
    lastOutputAt: null, // epoch ms of the most recent output chunk; null until the first one (activity timestamp, Issue #16)
    // Workers (groupRole in 'workerX' form) always run inside the sandbox, so
    // start them with Auto-Y enabled. The orchestrator (groupRole ===
    // 'orchestrator') and standalone sessions (groupRole === null) keep the
    // historical off default. groupRole is already validated server-side
    // (WORKER_ROLE_RE in groupManager), so "anything but the fixed
    // 'orchestrator' string is a worker" is a safe check here.
    autoYes: !!groupRole && groupRole !== 'orchestrator',
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
    startedClaudeSessionId: claudeSessionId || null,
    scheduleId: null, // key into the module-level `schedules` map, if any
    pendingInjection: null, // { text, at } — scheduled prompt awaiting a freshly-resumed session
    pendingInjectionTimer: null, // RESUME_INJECT_FALLBACK_MS safety net; cleared on teardown
    // Lightweight virtual screen (see screenModel.js): fed every output
    // chunk, exposing the current visible screen and a change counter so
    // read_output can tell "spinner still drawing" from "static screen".
    // screenLastChangeAt is stamped when the screen visibly changes (not on
    // every byte) -- the basis of read_output's screenIdleMs / get_tab_status.
    screen: createScreenModel({ cols, rows: SCREEN_ROWS }),
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

    // Keep the virtual screen model in parallel with the buffer: it only
    // stamps screenLastChangeAt when the visible screen actually changes,
    // so a spinner redrawing the same line registers as activity while a
    // byte flow that leaves the screen static does not.
    const screenVersion = session.screen.version();
    session.screen.feed(data);
    if (session.screen.version() !== screenVersion) {
      session.screenLastChangeAt = Date.now();
    }

    if (session.socket && session.socket.readyState === 1) {
      try {
        session.socket.send(JSON.stringify({ type: 'output', data }));
      } catch {
        // Prevent output serialization errors from crashing the PTY handler
      }
    }

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
            if (session.app === 'opencode' || session.app === 'copilot' || session.app === 'codex') {
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
      session.claudeSessionId = extractResumeSessionId(
        session.app,
        session.outputBuffer.slice(-50).join('')
      );
    }

    // Keep any pending scheduled prompt alive across this exit: refresh its
    // resume id and detach it so it auto-resumes the conversation at fire time.
    refreshScheduleOnExit(session);

    for (const fn of sessionExitListeners) {
      try {
        fn(session);
      } catch {
        // a listener must never break the pty exit path
      }
    }

    if (session.socket && session.socket.readyState === 1) {
      session.socket.send(JSON.stringify({
        type: 'exit',
        exitCode,
        signal,
        claudeSessionId: session.claudeSessionId,
      }));
    }

    if (!session.socket && sessions.has(session.id)) {
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

  return { sessionId: id, session };
}

export function getSession(id) {
  return sessions.get(id);
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

// Push the current schedule state to a session's socket. Needed by any
// server-internal path that arms/changes a schedule without a client request
// to respond to (e.g. the auto-session-limit detector in onData) -- unlike
// schedule_prompt/cancel_schedule/get_schedule, those paths have no
// request/response leg to piggyback the push on.
function notifyScheduleState(session) {
  if (session?.socket && session.socket.readyState === 1) {
    session.socket.send(buildScheduleStateMsg(scheduledPromptPublic(session)));
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

// Schedule-entry matching for the "same project" live-session substitution
// (fireSchedule branch 2). Group members match strictly -- only the SAME
// group AND SAME role -- because combo workers legitimately share cwd+app
// with each other, so a cwd+app match alone could inject into the wrong
// worker. A model-annotated schedule must likewise only inject into a
// session launched with the SAME model; unmodeled entries (both null) keep
// the original cwd+shell+app semantics. Exported for direct unit testing.
export function matchesScheduleTarget(session, entry) {
  return !!session && !session.exited && !!session.ptyProcess
    && session.cwd === entry.cwd
    && session.shell === entry.shell
    && session.app === entry.app
    && (session.model ?? null) === (entry.model ?? null)
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
  // opencode and copilot expose no session id in their TUI output, so resume
  // the last session of the project instead of a specific one.
  // A group member gets its role's MCP socket re-created (handoff channel or
  // control broker) so the resumed session can actually reach the group --
  // otherwise the orchestrator's wait_for_handoff would wait on a worker that
  // can never hand off. If that socket can't be produced (group already torn
  // down, broker failed), the prompt is dropped rather than orphaned: a
  // member session without MCP can never hand off again, and in the
  // group-gone case nobody is waiting anyway.
  const mcpSocketPath = entry.groupId && entry.groupRole
    ? await resolveMcpSocketForSession(entry.groupId, entry.groupRole)
    : null;
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
  const res = createSession({
    cwd,
    cols: 80,
    rows: 24,
    claudeSessionId: entry.claudeSessionId,
    shell: entry.shell,
    sandbox: entry.sandbox,
    sandboxOpts: entry.sandboxOpts,
    app: entry.app,
    model: entry.model,
    resumeLast: entry.app === 'opencode' || entry.app === 'copilot' || entry.app === 'codex',
    // A group member keeps its membership across the resume: groupManager's
    // session-create listener re-binds the role to the new sessionId.
    groupId: entry.groupId,
    groupRole: entry.groupRole,
    mcpSocketPath,
    orchestratorClaudeMdSrc,
    gitCommonDir,
  });
  if (!res?.session) return;
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
      connected: session.socket !== null,
      shell: session.shell,
      sandbox: session.sandbox,
      sandboxOpts: session.sandboxOpts || null,
      app: session.app,
      model: session.model || null,
      groupId: session.groupId || null,
      groupRole: session.groupRole || null,
      isMetaAgent: !!session.isMetaAgent,
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

  // Tear down the host-side git-broker alongside the sandboxed pty: it's a
  // plain child process (not part of the bwrap/rootlesskit tree), so it
  // isn't reaped by the pty kill above and must be stopped explicitly.
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

  sessions.delete(id);
}

export function destroyAllSessions() {
  for (const [id] of sessions) {
    destroySession(id);
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
    groupId: session.groupId || null,
    groupRole: session.groupRole || null,
  };
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
        const claudeId = session.claudeSessionId || extractResumeId(session);
        // claude sessions are saved when their resume id is known; opencode
        // and copilot sessions are always saved (resume happens via
        // `opencode -c` / `copilot --continue`).
        if (claudeId || session.app === 'opencode' || session.app === 'copilot' || session.app === 'codex') {
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
  }

  session.timeoutTimer = setTimeout(() => {
    destroySession(session.id);
  }, ms);
}
