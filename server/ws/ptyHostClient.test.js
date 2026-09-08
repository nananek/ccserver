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
import {
  PtyHostClient,
  shardCount,
  shardIndexForKey,
  shardKeyForSession,
  getPtyHostClient,
  getAllPtyHostClients,
  resetPtyHostClientForTests,
  isPtyHostEnabled,
  checkPtyHostReachable,
} from './ptyHostClient.js';

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

// Issue #143 problem 2: the real pty-host binary never closes its RPC
// listener without the whole process exiting right after (see
// server/pty-host/index.js's shutdown() -- stop()/rpc.close() is only ever
// called immediately before process.exit(0)), and a dying process SIGHUPs
// every pty it owned (Step0's PoC finding) -- so a 'close' on this
// connection can only mean every session this client held is gone for good.
// A previous version of this test simulated "the RPC listener bounces but
// the ptys secretly survive" to exercise resubscribe-after-reconnect; that
// scenario cannot happen with the real binary, and Issue #143 retires the
// blind-resubscribe-across-a-close behavior it depended on in favor of the
// onDisconnected() contract exercised below.
test('onDisconnected fires with every held sessionId when the connection drops, and a forgotten session is never silently resubscribed after reconnecting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-ptyhostclient-disconnect-'));
  const sp = join(dir, 'pty-host.sock');
  const store = new PtyStore();
  let rpc = await createRpcServer(store, { sockPath: sp });
  const client = new PtyHostClient(sp);
  let rpty;
  try {
    const chunks = [];
    rpty = await client.spawn(shellSpawnParams());
    rpty.onData((d) => chunks.push(d));
    await client.subscribe(rpty, 0);

    rpty.write('echo BEFORE_DROP\n');
    await waitFor(() => chunks.join('').includes('BEFORE_DROP'));

    const disconnected = [];
    client.onDisconnected((sessionIds) => disconnected.push(...sessionIds));

    // Stands in for "pty-host's process died" (see this test's header
    // comment) -- rpcServer.js's close() destroys every accepted connection,
    // which is exactly what a dead process's kernel-closed fds look like
    // from this client's side.
    await rpc.close();
    await waitFor(() => disconnected.length > 0);
    assert.deepEqual(disconnected, [rpty.sessionId]);

    // Bringing a listener back up on the same store (convenient for this
    // test's setup only, NOT a claim that production ever preserves ptys
    // across a close) must not silently resume delivering to the
    // now-forgotten rpty: onDisconnected already told the caller this
    // session is gone, so resubscribing it behind the caller's back would
    // contradict that.
    rpc = await createRpcServer(store, { sockPath: sp });
    rpty.write('echo AFTER_RECONNECT\n');
    let resumed = true;
    try {
      await waitFor(() => chunks.join('').includes('AFTER_RECONNECT'), { timeoutMs: 2000 });
    } catch {
      resumed = false;
    }
    assert.equal(resumed, false, 'a forgotten session must not silently resume receiving output after reconnect');
  } finally {
    // Bypasses the client entirely (which may or may not still be able to
    // reach this session) so the real shell process is always reaped, even
    // though the assertions above deliberately leave it unsubscribed/unknown
    // to the client -- see the round-trip test's comment on why a leaked
    // live pty must never survive a test.
    if (rpty) store.destroy(rpty.sessionId);
    client.close();
    await rpc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Issue #119 Step6: onReconnected is the pair to onDisconnected above, but
// fires only on a RECONNECT (never the first connect at boot -- see
// sessionManager.js's initPtyHostReconnectedHandler, which reconciles
// whatever pty-host may have auto-resumed while its shard was unreachable;
// nothing needs reconciling on a plain boot, restorePtyHostSessions()
// already covers that).
test('onReconnected never fires on the first connect, but fires exactly once after a real reconnect following a disconnect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-ptyhostclient-reconnect-'));
  const sp = join(dir, 'pty-host.sock');
  const store = new PtyStore();
  let rpc = await createRpcServer(store, { sockPath: sp });
  const client = new PtyHostClient(sp);
  const reconnections = [];
  client.onReconnected(() => reconnections.push(Date.now()));
  try {
    // First connect, at "boot" -- spawn() is enough to force _ensureConnected().
    const rpty = await client.spawn(shellSpawnParams());
    assert.equal(reconnections.length, 0, 'the very first connect is not a reconnect');
    store.destroy(rpty.sessionId);

    // Stands in for pty-host's process dying (see onDisconnected's own test
    // above for why rpc.close() is the right stand-in).
    await rpc.close();

    // Bring a listener back up on the same path -- the client's own backoff
    // schedule should find it without any external nudge.
    rpc = await createRpcServer(store, { sockPath: sp });
    await waitFor(() => reconnections.length > 0, { timeoutMs: 5000 });
    assert.equal(reconnections.length, 1, 'fired exactly once for this one reconnect');
  } finally {
    client.close();
    await rpc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Plan5 Step5 (partitioning): these are pure-function/lazy-construction
// tests, no pty-host instance involved -- see sessionManager.pty-host-
// shards.test.js for the end-to-end "actually routes to different real
// instances" coverage.

test('shardCount defaults to 1 when CCSERVER_PTY_HOST_SHARDS is unset, and rejects non-positive/non-integer values', () => {
  const prev = process.env.CCSERVER_PTY_HOST_SHARDS;
  try {
    delete process.env.CCSERVER_PTY_HOST_SHARDS;
    assert.equal(shardCount(), 1);
    process.env.CCSERVER_PTY_HOST_SHARDS = '3';
    assert.equal(shardCount(), 3);
    process.env.CCSERVER_PTY_HOST_SHARDS = '0';
    assert.equal(shardCount(), 1, 'non-positive falls back to 1');
    process.env.CCSERVER_PTY_HOST_SHARDS = '-2';
    assert.equal(shardCount(), 1, 'negative falls back to 1');
    process.env.CCSERVER_PTY_HOST_SHARDS = 'not-a-number';
    assert.equal(shardCount(), 1, 'non-integer falls back to 1');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_PTY_HOST_SHARDS;
    else process.env.CCSERVER_PTY_HOST_SHARDS = prev;
  }
});

test('shardIndexForKey always returns 0 when shard count is 1 (no partitioning)', () => {
  assert.equal(shardIndexForKey('anything', 1), 0);
  assert.equal(shardIndexForKey('group:foo', 1), 0);
});

test('shardIndexForKey is deterministic for the same key, and spreads distinct keys across shards', () => {
  const first = shardIndexForKey('cwd:abc123', 4);
  assert.equal(shardIndexForKey('cwd:abc123', 4), first, 'same key always maps to the same shard');
  assert.ok(first >= 0 && first < 4);

  // Not a strict requirement of the underlying mod-hash, but a real
  // regression check: a handful of distinct keys should not all collide onto
  // the same shard (that would indicate a broken hash, e.g. always reading
  // zeroed bytes instead of the digest).
  const seen = new Set();
  for (let i = 0; i < 20; i++) seen.add(shardIndexForKey(`cwd:project-${i}`, 4));
  assert.ok(seen.size > 1, 'distinct keys should spread across more than one shard');
});

test('shardKeyForSession prefers groupId over cwd, and is otherwise stable/distinct', () => {
  const withGroup = shardKeyForSession({ groupId: 'g1', cwd: '/tmp/a' });
  const sameGroupDifferentCwd = shardKeyForSession({ groupId: 'g1', cwd: '/tmp/b' });
  assert.equal(withGroup, sameGroupDifferentCwd, 'groupId alone determines the key when present, cwd is ignored');

  const noGroupA = shardKeyForSession({ groupId: null, cwd: '/tmp/a' });
  const noGroupB = shardKeyForSession({ groupId: null, cwd: '/tmp/b' });
  assert.notEqual(noGroupA, noGroupB, 'distinct cwds get distinct keys when there is no group');
  assert.notEqual(noGroupA, withGroup, 'a group key and a project key never collide by construction');
});

test('getPtyHostClient(shardIndex) memoizes per shard: same index returns the same client, different indices differ', () => {
  try {
    const c0a = getPtyHostClient(0);
    const c0b = getPtyHostClient(0);
    const c1 = getPtyHostClient(1);
    assert.equal(c0a, c0b, 'repeated calls for the same shard return the same client');
    assert.notEqual(c0a, c1, 'different shards get different clients');
  } finally {
    resetPtyHostClientForTests();
  }
});

test('getAllPtyHostClients returns exactly shardCount() clients, indexed 0..N-1', () => {
  const prev = process.env.CCSERVER_PTY_HOST_SHARDS;
  try {
    process.env.CCSERVER_PTY_HOST_SHARDS = '3';
    const all = getAllPtyHostClients();
    assert.equal(all.length, 3);
    assert.equal(all[0], getPtyHostClient(0));
    assert.equal(all[1], getPtyHostClient(1));
    assert.equal(all[2], getPtyHostClient(2));
  } finally {
    resetPtyHostClientForTests();
    if (prev === undefined) delete process.env.CCSERVER_PTY_HOST_SHARDS;
    else process.env.CCSERVER_PTY_HOST_SHARDS = prev;
  }
});

// Issue #119 Step7-2: isPtyHostEnabled() now defaults to ON (unset/empty),
// flipped from the historical default-OFF -- only an explicit '0' opts out.
// Exercised via the injected `env` param (a plain object, not process.env)
// so this stays a pure-function test with no global mutation/restore.
test('isPtyHostEnabled defaults to true when unset or empty, false only for an explicit "0"', () => {
  assert.equal(isPtyHostEnabled({}), true, 'unset means enabled by default');
  assert.equal(isPtyHostEnabled({ CCSERVER_PTY_HOST: '' }), true, 'empty string means enabled by default');
  assert.equal(isPtyHostEnabled({ CCSERVER_PTY_HOST: '0' }), false, 'explicit "0" is the only way to opt out');
  assert.equal(isPtyHostEnabled({ CCSERVER_PTY_HOST: '1' }), true, 'the historical explicit "1" still means enabled');
  assert.equal(isPtyHostEnabled({ CCSERVER_PTY_HOST: 'yes' }), true, 'any other non-"0" value stays enabled, not just "1"');
});

test('isPtyHostEnabled reads process.env by default when no env argument is given', () => {
  const prev = process.env.CCSERVER_PTY_HOST;
  try {
    process.env.CCSERVER_PTY_HOST = '0';
    assert.equal(isPtyHostEnabled(), false);
    delete process.env.CCSERVER_PTY_HOST;
    assert.equal(isPtyHostEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_PTY_HOST;
    else process.env.CCSERVER_PTY_HOST = prev;
  }
});

// Issue #119 Step7-3: checkPtyHostReachable() backs server/index.js's
// boot-time auto-fallback -- an existing deployment that never started
// ccserver-pty-host.service must not have isPtyHostEnabled()'s new
// default-ON break every session creation outright.
test('checkPtyHostReachable resolves true against a real, running pty-host', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-ptyhostclient-reachable-'));
  const sockPath = join(dir, 'pty-host.sock');
  const host = await startPtyHost({ sockPath });
  const client = new PtyHostClient(sockPath);
  try {
    assert.equal(await checkPtyHostReachable(client), true);
  } finally {
    client.close();
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkPtyHostReachable resolves false only once its timeout elapses when nothing is ever listening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-ptyhostclient-unreachable-'));
  // A path in a real, existing directory that nothing ever listens on. Each
  // individual connection attempt is refused/ENOENT near-instantly, but
  // checkPtyHostReachable() must keep retrying across its whole timeoutMs
  // budget rather than give up on that first instant failure -- see its own
  // comment: a single attempt failing fast is indistinguishable from "the
  // pty-host that will bind this exact path in another second is still
  // starting up" (the boot-race case this function exists to survive), so
  // this genuinely-never-there case is expected to cost close to the full
  // timeout, not return early.
  const sockPath = join(dir, 'nothing-here.sock');
  const client = new PtyHostClient(sockPath);
  const startedAt = Date.now();
  try {
    const reachable = await checkPtyHostReachable(client, 500);
    assert.equal(reachable, false);
    assert.ok(Date.now() - startedAt >= 450, 'an absent socket must retry across the full timeout, not fail on the first attempt');
  } finally {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkPtyHostReachable detects a pty-host that finishes starting up partway through the probe window', async () => {
  // Reproduces Issue #119 Step7-3's boot race: server本体 and pty-host start
  // together (systemd's After= only orders unit starts, it does not wait for
  // pty-host to actually finish initializing -- see docs/ccserver.service),
  // so the very first connection attempt can hit a socket path that doesn't
  // exist YET, not one that will never exist. checkPtyHostReachable() must
  // keep polling and pick up pty-host once it does bind, well before its
  // overall timeout elapses.
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-ptyhostclient-boot-race-'));
  const sockPath = join(dir, 'pty-host.sock');
  const client = new PtyHostClient(sockPath);
  let host;
  try {
    const probe = checkPtyHostReachable(client, 3000);
    await sleep(300);
    host = await startPtyHost({ sockPath });
    assert.equal(await probe, true);
  } finally {
    client.close();
    if (host) await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkPtyHostReachable resolves false once its own timeout elapses, for a client that never settles', async () => {
  // A stub, not a real PtyHostClient: only list() matters to
  // checkPtyHostReachable, and a promise that never settles is the cleanest
  // way to exercise the timeout race deterministically -- a real "pty-host
  // accepts the connection but never answers" repro would need an actual
  // wedged process.
  const neverSettles = { list: () => new Promise(() => {}) };
  const reachable = await checkPtyHostReachable(neverSettles, 200);
  assert.equal(reachable, false);
});
