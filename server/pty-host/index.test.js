import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPtyHostSockPath, getPtyHostShardIndex, startPtyHost } from './index.js';
import { setPtyHostSessionMeta, loadPtyHostSessionMeta } from '../ws/ptyHostSessionMeta.js';

test('getPtyHostSockPath: CCSERVER_PTY_HOST_SOCK wins, else XDG_RUNTIME_DIR, else /run/user/<uid>', () => {
  const prevSock = process.env.CCSERVER_PTY_HOST_SOCK;
  const prevXdg = process.env.XDG_RUNTIME_DIR;
  try {
    process.env.CCSERVER_PTY_HOST_SOCK = '/tmp/explicit.sock';
    assert.equal(getPtyHostSockPath(), '/tmp/explicit.sock');

    delete process.env.CCSERVER_PTY_HOST_SOCK;
    process.env.XDG_RUNTIME_DIR = '/tmp/xdg-test-dir';
    assert.equal(getPtyHostSockPath(), '/tmp/xdg-test-dir/ccserver-pty-host.sock');
  } finally {
    if (prevSock === undefined) delete process.env.CCSERVER_PTY_HOST_SOCK; else process.env.CCSERVER_PTY_HOST_SOCK = prevSock;
    if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = prevXdg;
  }
});

test('startPtyHost: listens on the given path, serves a real session, and stop() tears the listener down without touching live sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-pty-host-index-test-'));
  const sockPath = join(dir, 'pty-host.sock');
  // No orphaned brokers exist yet -- point the registry at a private path so
  // this test can never race a real pty-host instance's own registry file.
  process.env.CCSERVER_PTY_HOST_GITBROKER_REGISTRY = join(dir, 'gitbroker-registry.json');
  try {
    const host = await startPtyHost({ sockPath });
    try {
      assert.ok(existsSync(sockPath), 'the socket file exists once listening');

      const { id } = host.ptyStore.spawn({
        cwd: process.env.HOME || '/tmp',
        cols: 80,
        rows: 24,
        command: process.env.SHELL || '/bin/bash',
        args: [],
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
      assert.equal(host.ptyStore.size(), 1);

      await host.stop();
      // stop() closes the RPC listener, not the sessions it was serving --
      // plan5's passive-teardown guarantee applies to pty-host's own UDS
      // server shutdown too, not just an unexpected disconnect.
      assert.equal(host.ptyStore.size(), 1, 'stop() must not destroy live sessions');
      host.ptyStore.destroy(id);
    } finally {
      // best-effort: already stopped above in the success path
      await host.stop().catch(() => {});
    }
  } finally {
    delete process.env.CCSERVER_PTY_HOST_GITBROKER_REGISTRY;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Issue #119 Step6-2.
test('getPtyHostShardIndex: CCSERVER_PTY_HOST_SHARD_INDEX wins, else 0; invalid values also fall back to 0', () => {
  const prev = process.env.CCSERVER_PTY_HOST_SHARD_INDEX;
  try {
    delete process.env.CCSERVER_PTY_HOST_SHARD_INDEX;
    assert.equal(getPtyHostShardIndex(), 0);

    process.env.CCSERVER_PTY_HOST_SHARD_INDEX = '2';
    assert.equal(getPtyHostShardIndex(), 2);

    process.env.CCSERVER_PTY_HOST_SHARD_INDEX = '0';
    assert.equal(getPtyHostShardIndex(), 0);

    process.env.CCSERVER_PTY_HOST_SHARD_INDEX = '-1';
    assert.equal(getPtyHostShardIndex(), 0, 'a negative index is invalid, falls back to 0');

    process.env.CCSERVER_PTY_HOST_SHARD_INDEX = 'not-a-number';
    assert.equal(getPtyHostShardIndex(), 0, 'a non-numeric value is invalid, falls back to 0');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_PTY_HOST_SHARD_INDEX;
    else process.env.CCSERVER_PTY_HOST_SHARD_INDEX = prev;
  }
});

// Issue #119 Step6-3: startPtyHost() relaunches whatever ptyHostSessionMeta.json
// says belongs to its own shard, under the SAME session id, before it ever
// opens its RPC listener -- this is what lets server本体's existing
// restorePtyHostSessions()/reconcileShardAfterReconnect() (sessionManager.js)
// reattach it with zero new server本体-side matching logic. A shell entry
// (app: null) is used here specifically because it needs no resume-args
// reconstruction at all (see autoResumeSessions' `meta.shell ? [] : ...`
// branch) and no real claude/agent binary -- this test is about the
// mechanics of picking up and relaunching meta entries, not app-specific
// resume behavior (see sessionManager.pty-host.test.js for the claude
// --resume + reconnect-reconcile end-to-end coverage).
test('startPtyHost auto-resumes a session belonging to its own shard, under the same id, before opening its RPC listener', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-pty-host-autoresume-test-'));
  const sockPath = join(dir, 'pty-host.sock');
  const metaPath = join(dir, 'pty-host-session-meta.json');
  process.env.CCSERVER_PTY_HOST_GITBROKER_REGISTRY = join(dir, 'gitbroker-registry.json');
  process.env.CCSERVER_PTY_HOST_SESSION_META_PATH = metaPath;
  const sessionId = 'auto-resume-test-shell-session';
  setPtyHostSessionMeta(sessionId, {
    cwd: dir,
    shell: true,
    app: null,
    model: null,
    permissionMode: 'standard',
    command: process.env.SHELL || '/bin/bash',
    mcpArgs: [],
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    sandbox: false,
    sandboxOpts: null,
    reuseSandboxHome: true,
    startedClaudeSessionId: null,
    latestClaudeSessionId: null,
    shardIndex: 0,
  });
  try {
    const host = await startPtyHost({ sockPath, shardIndex: 0 });
    try {
      assert.ok(host.ptyStore.list().some((s) => s.id === sessionId), 'the meta entry for this shard was relaunched under its original id');
    } finally {
      host.ptyStore.destroy(sessionId);
      await host.stop();
    }
  } finally {
    delete process.env.CCSERVER_PTY_HOST_GITBROKER_REGISTRY;
    delete process.env.CCSERVER_PTY_HOST_SESSION_META_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startPtyHost does not auto-resume a meta entry belonging to a DIFFERENT shard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-pty-host-autoresume-othershard-test-'));
  const sockPath = join(dir, 'pty-host.sock');
  const metaPath = join(dir, 'pty-host-session-meta.json');
  process.env.CCSERVER_PTY_HOST_GITBROKER_REGISTRY = join(dir, 'gitbroker-registry.json');
  process.env.CCSERVER_PTY_HOST_SESSION_META_PATH = metaPath;
  const sessionId = 'auto-resume-test-other-shard-session';
  setPtyHostSessionMeta(sessionId, {
    cwd: dir, shell: true, app: null, command: process.env.SHELL || '/bin/bash',
    mcpArgs: [], env: { PATH: process.env.PATH, HOME: process.env.HOME },
    sandbox: false, sandboxOpts: null, reuseSandboxHome: true,
    startedClaudeSessionId: null, latestClaudeSessionId: null,
    shardIndex: 1, // this instance is shard 0 below -- not its session
  });
  try {
    const host = await startPtyHost({ sockPath, shardIndex: 0 });
    try {
      assert.ok(!host.ptyStore.list().some((s) => s.id === sessionId), 'a different shard\'s entry was left alone');
      // The metadata itself is untouched -- server本体's own reconcile (not
      // this shard) decides its fate once ITS shard comes back.
      assert.ok(loadPtyHostSessionMeta()[sessionId], 'the metadata entry survives, for whichever shard actually owns it');
    } finally {
      await host.stop();
    }
  } finally {
    delete process.env.CCSERVER_PTY_HOST_GITBROKER_REGISTRY;
    delete process.env.CCSERVER_PTY_HOST_SESSION_META_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

// A meta entry too broken to relaunch (here: no `command` at all, e.g. one
// written before Step6-1's schema existed) must not crash pty-host's own
// startup -- it's simply skipped, per plan, left for a later restart/orphan
// sweep to resolve instead of guessed at.
test('startPtyHost skips (without crashing) a meta entry that fails to relaunch, leaving its metadata alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-pty-host-autoresume-broken-test-'));
  const sockPath = join(dir, 'pty-host.sock');
  const metaPath = join(dir, 'pty-host-session-meta.json');
  process.env.CCSERVER_PTY_HOST_GITBROKER_REGISTRY = join(dir, 'gitbroker-registry.json');
  process.env.CCSERVER_PTY_HOST_SESSION_META_PATH = metaPath;
  const sessionId = 'auto-resume-test-broken-session';
  setPtyHostSessionMeta(sessionId, {
    cwd: dir, shell: true, app: null,
    // no `command` -- ptyStore.spawn() throws "command must be a non-empty string"
    shardIndex: 0,
  });
  try {
    const host = await startPtyHost({ sockPath, shardIndex: 0 });
    try {
      assert.equal(host.ptyStore.list().length, 0, 'nothing crashed the startup; the broken entry was simply skipped');
      assert.ok(loadPtyHostSessionMeta()[sessionId], 'pty-host never deletes meta entries itself, even a failed one');
    } finally {
      await host.stop();
    }
  } finally {
    delete process.env.CCSERVER_PTY_HOST_GITBROKER_REGISTRY;
    delete process.env.CCSERVER_PTY_HOST_SESSION_META_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startPtyHost reaps a leftover orphaned git-broker registry entry on boot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-pty-host-index-reap-test-'));
  const sockPath = join(dir, 'pty-host.sock');
  const regPath = join(dir, 'gitbroker-registry.json');
  process.env.CCSERVER_PTY_HOST_GITBROKER_REGISTRY = regPath;
  try {
    // A pid essentially guaranteed not to be alive, standing in for a
    // previous pty-host generation's orphaned git-broker.
    writeFileSync(regPath, JSON.stringify({ 'stale-session': { pid: 999999, dir: join(dir, 'gone') } }));
    const host = await startPtyHost({ sockPath });
    try {
      assert.equal(existsSync(regPath), false, 'the stale registry was cleared during startup');
    } finally {
      await host.stop();
    }
  } finally {
    delete process.env.CCSERVER_PTY_HOST_GITBROKER_REGISTRY;
    rmSync(dir, { recursive: true, force: true });
  }
});
