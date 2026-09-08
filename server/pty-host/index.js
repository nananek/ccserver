// pty-host entrypoint (plan5 Step1): a standalone, independently-runnable
// process. Deliberately imports nothing from server/index.js or
// server/ws/sessionManager.js -- when the CCSERVER_PTY_HOST feature flag is
// off (the only mode this repo runs in until plan5 Step2+), the existing
// server must have zero new dependency on this directory, and this directory
// must be fully usable (spawn a real pty, exercise every RPC) without the
// main server ever having run.
//
// Run directly: `node server/pty-host/index.js`.

import { join } from 'node:path';
import { PtyStore } from './ptyStore.js';
import { createRpcServer } from './rpcServer.js';
import { GitBrokerRegistry } from './gitBrokerRegistry.js';
// Issue #119 Step6: both modules are pure/leaf (appLaunch.js has no imports
// at all; ptyHostSessionMeta.js only node:fs/path/url) -- safe to import from
// pty-host without risking the circular dependency this file's own header
// comment guards against (sessionManager.js/groupManager.js/db.js stay off
// limits, not every module server本体 happens to also use).
import { appLaunchArgs } from '../ws/appLaunch.js';
import { loadPtyHostSessionMeta } from '../ws/ptyHostSessionMeta.js';

const SOCK_NAME = 'ccserver-pty-host.sock';

// Same convention as server/ws/notify.js's getNotifySockPath(): prefer
// XDG_RUNTIME_DIR, fall back to /run/user/<uid>, then /tmp.
//
// Plan5 Step5 (partitioning): shardIndex 0 (the default, and the only value
// that existed before Step5) resolves to exactly the same path as before --
// single-instance deployments and every existing CCSERVER_PTY_HOST_SOCK
// override keep working unchanged. A non-zero shardIndex derives a sibling
// path so multiple pty-host instances (one systemd unit per shard, started
// with different CCSERVER_PTY_HOST_SOCK/CCSERVER_PTY_HOST_SHARD_INDEX values)
// never collide on the same socket. This function itself is the only piece
// of pty-host aware of sharding -- startPtyHost() below still just binds
// whatever single sockPath it's given, so pty-host's own code stays
// partition-count-agnostic (routing across shards lives entirely in
// server本体's ptyHostClient.js).
export function getPtyHostSockPath(shardIndex = 0) {
  if (process.env.CCSERVER_PTY_HOST_SOCK) {
    return shardIndex === 0
      ? process.env.CCSERVER_PTY_HOST_SOCK
      : `${process.env.CCSERVER_PTY_HOST_SOCK}-${shardIndex}`;
  }
  const base = process.env.XDG_RUNTIME_DIR
    || (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : '/tmp');
  return join(base, shardIndex === 0 ? SOCK_NAME : `ccserver-pty-host-${shardIndex}.sock`);
}

// Issue #119 Step6-2: pty-host's own identity within a sharded deployment.
// Unlike getPtyHostSockPath() above (which server本体's ptyHostClient.js
// calls, once per shard, to know WHERE each instance listens), THIS instance
// has no other way to learn which shard it itself is -- it never sees
// CCSERVER_PTY_HOST_SHARDS/shardIndexForKey (that routing logic lives
// entirely in ptyHostClient.js, by design, see this file's own header
// comment) and ptyHostSessionMeta.json is a single file shared by every
// shard, keyed by session id with each entry separately carrying its own
// shardIndex. Auto-resume (autoResumeSessions below) needs to know which of
// those entries are actually its own to relaunch -- an operator running more
// than one shard sets this explicitly per systemd unit (see docs-site's
// systemd.md), the same way each shard's CCSERVER_PTY_HOST_SOCK is already
// set today. Unset/invalid defaults to 0, matching every single-shard
// deployment (and shardIndexForKey()'s own default) that predates sharding.
export function getPtyHostShardIndex() {
  const raw = process.env.CCSERVER_PTY_HOST_SHARD_INDEX;
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

// Issue #119 Step6-3: relaunches every session ptyHostSessionMeta.json says
// belongs to THIS shard, reusing the exact same session id (so server本体's
// EXISTING restorePtyHostSessions()/reconcileShardAfterReconnect() -- see
// sessionManager.js -- reattach it exactly the way they already reattach any
// other still-alive pty-host session; no new server本体-side matching logic
// needed for this to work). Called once at startup, before the RPC listener
// opens, so no client can observe a partially-resumed shard.
//
// Rebuilds the full spawn() call exactly as createSession()'s usePtyHost
// branch (sessionManager.js) originally made it -- command/env/the socket
// paths/orchestratorClaudeMdSrc/gitCommonDir/groupFilesDir/
// sandboxHomeCreatedBy are replayed verbatim (see setPtyHostSessionMeta's own
// call site comment for why a fresh buildSandboxSpawn() run against these,
// rather than reusing a frozen already-sandboxed command/args pair, matters:
// reapOrphans() above just killed whatever git-broker the crashed generation
// had running, so anything short of rebuilding the sandbox from scratch
// would bind a session into a git-broker socket nothing is listening on
// anymore) -- only the resume portion of `args` is rebuilt fresh, preferring
// the continuously-tracked latestClaudeSessionId (Step6-0) over the
// ambiguous resumeLast fallback whenever it's known.
function autoResumeSessions(ptyStore, shardIndex) {
  const all = loadPtyHostSessionMeta();
  let attempted = 0;
  let succeeded = 0;
  for (const [id, meta] of Object.entries(all)) {
    if ((meta.shardIndex ?? 0) !== shardIndex) continue; // another shard's session -- not ours to resume
    attempted++;
    try {
      const resumeArgs = meta.shell
        ? []
        : appLaunchArgs(meta.app, meta.latestClaudeSessionId
          ? { resumeId: meta.latestClaudeSessionId, model: meta.model, permissionMode: meta.permissionMode }
          : { resumeLast: true, model: meta.model, permissionMode: meta.permissionMode });
      ptyStore.spawn({
        id,
        cwd: meta.cwd,
        // The real cols/rows aren't persisted (no viewer is watching a
        // just-crashed shard's sessions to negotiate against) -- same
        // fixed-default convention already used for every other launch with
        // no real viewport yet (groupManager.js's member launches, scheduled
        // prompts); the first browser to reattach negotiates the real size
        // immediately via resize.
        cols: 80,
        rows: 24,
        command: meta.command,
        args: [...resumeArgs, ...(meta.mcpArgs || [])],
        env: meta.env || {},
        sandbox: !!meta.sandbox,
        sandboxOpts: meta.sandboxOpts,
        // Same fallback sessionManager.js's own spawn() call already applies
        // (see its own comment): a shell+sandbox session's `app` field is
        // null (shells carry no app), but ptyStore.spawn() refuses
        // sandbox:true without one.
        app: meta.app || 'claude',
        mcpSocketPath: meta.mcpSocketPath,
        notifySocketPath: meta.notifySocketPath,
        usageSocketPath: meta.usageSocketPath,
        metaSocketPath: meta.metaSocketPath,
        reviewerSocketPath: meta.reviewerSocketPath,
        reuseSandboxHome: meta.reuseSandboxHome,
        orchestratorClaudeMdSrc: meta.orchestratorClaudeMdSrc,
        gitCommonDir: meta.gitCommonDir,
        groupFilesDir: meta.groupFilesDir,
        sandboxHomeCreatedBy: meta.sandboxHomeCreatedBy,
      });
      succeeded++;
    } catch (err) {
      // Left for the next restart/orphan sweep (restorePtyHostSessions()'s
      // orphanedMeta case, sessionManager.js) rather than deleted here --
      // pty-host itself never deletes ptyHostSessionMeta.json entries (see
      // that file's own header comment: server本体 owns this file's
      // lifecycle), and a transient failure (e.g. the sandbox's persistent
      // HOME dir is mid-deletion) might succeed on a later attempt.
      console.warn(`[pty-host] auto-resume: session ${id} (${meta.cwd}) failed to relaunch: ${err.message} -- leaving its metadata for server本体's next reconcile`);
    }
  }
  return { attempted, succeeded };
}

// Starts pty-host and returns its live handles. Exported (rather than only
// run via the bottom guard) so tests can start/stop an instance in-process
// against a throwaway socket path.
export async function startPtyHost({ sockPath = getPtyHostSockPath(), shardIndex = getPtyHostShardIndex() } = {}) {
  const gitBrokerRegistry = new GitBrokerRegistry();
  const reaped = gitBrokerRegistry.reapOrphans();
  if (reaped.found > 0) {
    console.log(`[pty-host] startup cleanup: ${reaped.killed}/${reaped.found} orphaned git-broker(s) from a previous run killed`);
  }

  const ptyStore = new PtyStore({ gitBrokerRegistry });

  // Issue #119 Step6-3: before opening the RPC listener (so no client -- in
  // particular server本体's own reconnect -- can see a partially-resumed
  // shard), relaunch whatever this shard held before it crashed.
  const resumed = autoResumeSessions(ptyStore, shardIndex);
  if (resumed.attempted > 0) {
    console.log(`[pty-host] auto-resume: ${resumed.succeeded}/${resumed.attempted} session(s) relaunched (shard ${shardIndex})`);
  }

  const rpc = await createRpcServer(ptyStore, { sockPath });
  console.log(`[pty-host] listening at ${sockPath} (pid ${process.pid})`);

  return {
    ptyStore,
    sockPath,
    async stop() {
      await rpc.close();
    },
  };
}

function isMain() {
  // Node ESM has no require.main; compare the invoked script path instead.
  return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  startPtyHost().then((host) => {
    // Step0's PoC finding applies to pty-host itself as much as to
    // server本体: there is no way to preserve live ptys across pty-host's
    // OWN exit (they die with it, SIGHUP'd by the kernel the moment this
    // process's fds close -- see plan5 section 0). So unlike
    // sessionManager.js's gracefulShutdown(), there is no "save metadata,
    // kill cleanly" dance to do here that would change the outcome; this
    // handler exists only to log the tradeoff plainly instead of dying
    // silently, and to close the UDS listener so the socket file doesn't
    // linger stale. Issue #119 Step6's auto-resume (autoResumeSessions
    // above, run on the NEXT startPtyHost()) is what actually relaunches
    // these sessions -- systemd's Restart=on-failure is what makes that next
    // startup happen at all after a crash; this same shutdown() also runs
    // for a deliberate `systemctl restart`, which Restart=on-failure has
    // nothing to do with.
    const shutdown = (signal) => {
      const live = host.ptyStore.size();
      if (live > 0) {
        console.warn(
          `[pty-host] received ${signal} with ${live} live session(s) -- they will be relaunched via `
          + 'auto-resume once this instance restarts (see docs-site/deployment/systemd.md), but any '
          + 'command still running inside them at this moment is lost -- only the conversation/shell itself '
          + 'comes back, not its in-flight process state.'
        );
      }
      host.stop().finally(() => process.exit(0));
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }).catch((err) => {
    console.error(`[pty-host] failed to start: ${err.message}`);
    process.exit(1);
  });
}
