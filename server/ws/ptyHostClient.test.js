// Exercises PtyHostClient/RemotePty against a real (in-process) pty-host
// instance -- same "real bash pty, no mocks" approach as
// server/pty-host/*.test.js and server/ws/sessionManager.test.js.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPtyHost } from '../pty-host/index.js';
import { PtyStore } from '../pty-host/ptyStore.js';
import { createRpcServer } from '../pty-host/rpcServer.js';
import { PtyHostClient } from './ptyHostClient.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(check, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // await, not a bare call: check() can be async (e.g. one that itself
    // awaits an RPC) -- a bare `if (check())` would test the truthiness of
    // the returned Promise object itself (always true) and return on the
    // very first iteration without ever inspecting the real result.
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await sleep(intervalMs);
  }
}

function shellSpawnParams(extra = {}) {
  return {
    cwd: process.env.HOME || '/tmp',
    cols: 80,
    rows: 24,
    command: process.env.SHELL || '/bin/bash',
    args: [],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'xterm-256color' },
    ...extra,
  };
}

let sockDir;
let sockPath;
let host;

before(async () => {
  sockDir = mkdtempSync(join(tmpdir(), 'ccserver-ptyhostclient-test-'));
  sockPath = join(sockDir, 'pty-host.sock');
  host = await startPtyHost({ sockPath });
});

after(async () => {
  await host.stop();
  try { rmSync(sockDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('constructing a client never touches the socket (lazy init)', () => {
  const client = new PtyHostClient(join(sockDir, 'never-touched.sock'));
  assert.equal(client._socket, null);
  assert.equal(client._connectPromise, null);
  client.close();
});

test('spawn -> subscribe -> write/onData -> onExit round-trip through a real shell', async () => {
  const client = new PtyHostClient(sockPath);
  try {
    const rpty = await client.spawn(shellSpawnParams());
    assert.ok(rpty.pid > 0);
    assert.equal(rpty.cols, 80);
    assert.equal(rpty.rows, 24);

    const chunks = [];
    rpty.onData((data) => chunks.push(data));
    let exitInfo = null;
    rpty.onExit((info) => { exitInfo = info; });

    await client.subscribe(rpty, 0);
    rpty.write('echo PTYHOSTCLIENT_MARKER_$((2+3))\n');
    await waitFor(() => chunks.join('').includes('PTYHOSTCLIENT_MARKER_5'));

    rpty.kill();
    await waitFor(() => exitInfo !== null);
    assert.equal(typeof exitInfo.exitCode, 'number');

    rpty.destroy();
    // destroy() is fire-and-forget: wait for pty-host to actually finish
    // processing it before this test's `finally` closes the connection.
    // Otherwise the connection can be torn down (rpc.close()/client.close()
    // racing this in-flight RPC) before pty-host's kill()+destroy() on the
    // still-live pty completes, which leaked a live child process and hung
    // the whole test process's natural exit in practice.
    await waitFor(() => !host.ptyStore.list().some((s) => s.id === rpty.sessionId));
  } finally {
    client.close();
  }
});

test('write/resize/kill/destroy are fire-and-forget: they never throw synchronously', async () => {
  const client = new PtyHostClient(sockPath);
  try {
    const rpty = await client.spawn(shellSpawnParams());
    await client.subscribe(rpty, 0);
    assert.doesNotThrow(() => rpty.write('echo hi\n'));
    assert.doesNotThrow(() => rpty.resize(100, 30));
    assert.equal(rpty.cols, 100);
    assert.equal(rpty.rows, 30);
    assert.doesNotThrow(() => rpty.kill());
    await sleep(100);
    assert.doesNotThrow(() => rpty.destroy());
    // See the previous test's comment: wait for pty-host to actually finish
    // tearing this down before closing the connection out from under it.
    await waitFor(() => !host.ptyStore.list().some((s) => s.id === rpty.sessionId));
  } finally {
    client.close();
  }
});

test('an unreachable pty-host rejects spawn() with an INFRA_ERROR_PREFIXES-compatible message', async () => {
  const client = new PtyHostClient(join(sockDir, 'no-such-socket.sock'));
  try {
    // assert.rejects matches a RegExp against String(error) (so "Error: "
    // prefixed), not error.message alone -- no leading ^ anchor.
    await assert.rejects(
      client.spawn(shellSpawnParams({ command: 'claude' })),
      /Failed to spawn "claude": pty-host unreachable/,
    );
  } finally {
    client.close();
  }
});

test('list() returns every live session, and destroy() removes it', async () => {
  const client = new PtyHostClient(sockPath);
  try {
    const rpty = await client.spawn(shellSpawnParams());
    const sessions = await client.list();
    assert.ok(sessions.some((s) => s.id === rpty.sessionId));
    rpty.destroy();
    await waitFor(async () => !(await client.list()).some((s) => s.id === rpty.sessionId));
  } finally {
    client.close();
  }
});

test('onDestroyed fires when a subscribed session is torn down via an explicit destroy RPC', async () => {
  // Note on what this test deliberately does NOT cover: pty-host's own idle/
  // exited timers (server/pty-host/ptyStore.js's _armTimeout) only ever arm
  // when a session's subscriber set is empty -- and _emit() only delivers
  // `destroyed` to whoever is still in that (now-empty) set, i.e. nobody.
  // Under this client's "stay subscribed for the session's whole life"
  // invariant (see sessionManager.js's createSession), that self-timeout
  // path can therefore never fire while server本体's own connection is
  // alive, and even if it did, there would be no live subscriber left to
  // notify. So the only way `destroyed` actually reaches a listener is via
  // an explicit `destroy` RPC sent while still subscribed -- exactly what
  // destroySession()'s RemotePty.destroy() call does, and what this test
  // exercises.
  const client = new PtyHostClient(sockPath);
  try {
    const destroyed = [];
    client.onDestroyed((sessionId, reason) => destroyed.push({ sessionId, reason }));

    const rpty = await client.spawn(shellSpawnParams());
    await client.subscribe(rpty, 0);
    rpty.destroy();

    await waitFor(() => destroyed.some((d) => d.sessionId === rpty.sessionId), { timeoutMs: 2000 });
  } finally {
    client.close();
  }
});

test('reconnect: client resubscribes from lastSeq after the pty-host connection drops and comes back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-ptyhostclient-reconnect-'));
  const sp = join(dir, 'pty-host.sock');
  const store = new PtyStore();
  let rpc = await createRpcServer(store, { sockPath: sp });
  const client = new PtyHostClient(sp);
  try {
    const chunks = [];
    const rpty = await client.spawn(shellSpawnParams());
    rpty.onData((d) => chunks.push(d));
    await client.subscribe(rpty, 0);

    rpty.write('echo BEFORE_DROP\n');
    await waitFor(() => chunks.join('').includes('BEFORE_DROP'));

    // Simulate a pty-host restart: close the RPC listener without touching
    // the store (the live pty must survive -- passive teardown guarantee),
    // then rebind a fresh listener on the same socket path/store.
    await rpc.close();
    await sleep(50);
    rpc = await createRpcServer(store, { sockPath: sp });

    rpty.write('echo AFTER_RECONNECT\n');
    await waitFor(() => chunks.join('').includes('AFTER_RECONNECT'), { timeoutMs: 8000 });

    rpty.destroy();
    // See the round-trip test's comment: wait for the teardown to actually
    // land before this test's `finally` closes both ends of the connection.
    await waitFor(() => !store.list().some((s) => s.id === rpty.sessionId));
  } finally {
    client.close();
    await rpc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
