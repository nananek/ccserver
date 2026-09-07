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

// Starts pty-host and returns its live handles. Exported (rather than only
// run via the bottom guard) so tests can start/stop an instance in-process
// against a throwaway socket path.
export async function startPtyHost({ sockPath = getPtyHostSockPath() } = {}) {
  const gitBrokerRegistry = new GitBrokerRegistry();
  const reaped = gitBrokerRegistry.reapOrphans();
  if (reaped.found > 0) {
    console.log(`[pty-host] startup cleanup: ${reaped.killed}/${reaped.found} orphaned git-broker(s) from a previous run killed`);
  }

  const ptyStore = new PtyStore({ gitBrokerRegistry });
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
    // linger stale. Restart-triggered auto-resume (plan5 Step6) is the
    // actual mitigation, not this handler.
    const shutdown = (signal) => {
      const live = host.ptyStore.size();
      if (live > 0) {
        console.warn(
          `[pty-host] received ${signal} with ${live} live session(s) -- they will be lost `
          + '(pty-host restart is a data-loss event by design until plan5 Step6\'s auto-resume lands; '
          + 'see docs/plan5 section 7.2/7.4). Restart the affected sessions after pty-host comes back up.'
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
