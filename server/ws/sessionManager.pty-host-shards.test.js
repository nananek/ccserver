// Plan5 Step5 (partitioning) integration: exercises sessionManager.js's
// usePtyHost branches ROUTING ACROSS MULTIPLE real, independent pty-host
// instances via CCSERVER_PTY_HOST_SHARDS -- same "no mocks, real bash pty"
// approach as sessionManager.pty-host.test.js, which sticks to a single,
// unsharded instance (shardIndexForKey/shardKeyForSession's own pure-function
// unit tests live in ptyHostClient.test.js). This file is the one that
// proves cross-instance routing actually works end-to-end: spawn lands on
// the right shard, subscribe reaches the same shard spawn used (the
// "见落としやすい罠" ptyHostClient.js's header comment warns about),
// restorePtyHostSessions()/gracefulShutdown()/initPtyHostDestroyedHandler()
// all correctly fan out across shards, and one shard being unreachable does
// not corrupt restore metadata belonging to a healthy one.
//
// A dedicated file (not folded into sessionManager.pty-host.test.js) for the
// same reason that file is dedicated on its own: CCSERVER_PTY_HOST_SHARDS is
// read at call time by shardCount(), so flipping it for "just a few tests"
// in a shared file would leak into whichever tests run after them in the
// same process. node:test gives every file its own process, so setting it
// once in this file's `before` cleanly isolates it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRpcServer } from '../pty-host/rpcServer.js';
import { shardIndexForKey, shardKeyForSession } from './ptyHostClient.js';

const SHARD_COUNT = 2;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(check, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await sleep(intervalMs);
  }
}

let sessionManager;
let ptyHostClientMod;
let getPtyHostSockPath;
let startPtyHost;
let hosts; // hosts[shardIndex] = { ptyStore, sockPath, stop() }
let sockDir;
let runtimeDir;

before(async () => {
  sockDir = mkdtempSync(join(tmpdir(), 'ccserver-sm-ptyhost-shards-test-'));
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-sm-ptyhost-shards-runtime-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  process.env.CCSERVER_ORCHESTRATOR_GENERATED_ROOT = join(runtimeDir, 'orchestrator-generated');
  process.env.CCSERVER_PTY_HOST_SESSION_META_PATH = join(runtimeDir, 'pty-host-session-meta.json');
  process.env.CCSERVER_PTY_HOST_SOCK = join(sockDir, 'pty-host.sock');
  process.env.CCSERVER_PTY_HOST_SHARDS = String(SHARD_COUNT);
  process.env.CCSERVER_PTY_HOST = '1';

  ({ startPtyHost, getPtyHostSockPath } = await import('../pty-host/index.js'));
  hosts = [];
  for (let i = 0; i < SHARD_COUNT; i++) {
    hosts.push(await startPtyHost({ sockPath: getPtyHostSockPath(i) }));
  }

  ptyHostClientMod = await import('./ptyHostClient.js');
  sessionManager = await import('./sessionManager.js');
  sessionManager.initPtyHostDestroyedHandler();
});

after(async () => {
  sessionManager.destroyAllSessions();
  ptyHostClientMod.resetPtyHostClientForTests();
  for (const host of hosts) {
    try { await host.stop(); } catch { /* may already be stopped by a test */ }
  }
  delete process.env.CCSERVER_PTY_HOST;
  delete process.env.CCSERVER_PTY_HOST_SOCK;
  delete process.env.CCSERVER_PTY_HOST_SHARDS;
  delete process.env.CCSERVER_PTY_HOST_SESSION_META_PATH;
  for (const dir of candidateDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  try { rmSync(sockDir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function shardIndexFor({ groupId = null, cwd }) {
  return shardIndexForKey(shardKeyForSession({ groupId, cwd }));
}

// Deterministically finds a cwd whose shardIndexForKey lands on the target
// shard, rather than asserting on hardcoded paths that would need updating
// if the hash algorithm ever changed -- SHARD_COUNT=2 means this terminates
// within a handful of tries in practice. Each candidate must be a REAL
// directory (not just a plausible-looking path): the shell spawned for it
// needs a cwd that actually exists, or it exits immediately (code 1) and
// every output/restore assertion below would fail for a reason that has
// nothing to do with sharding.
const candidateDirs = [];
function findCwdForShard(targetShard) {
  for (let i = 0; ; i++) {
    if (!candidateDirs[i]) candidateDirs[i] = mkdtempSync(join(tmpdir(), 'ccserver-shard-test-'));
    const cwd = candidateDirs[i];
    if (shardIndexFor({ cwd }) === targetShard) return cwd;
  }
}

async function destroySessionAndWait(sessionId, shardIndex) {
  sessionManager.destroySession(sessionId, { reason: 'test' });
  await waitFor(() => !hosts[shardIndex].ptyStore.list().some((s) => s.id === sessionId), { timeoutMs: 2000 });
}

test('createSession spawns onto the shard shardIndexForKey(cwd) selects, and only that shard has it', async () => {
  const cwd0 = findCwdForShard(0);
  const cwd1 = findCwdForShard(1);
  const res0 = await sessionManager.createSession({ cwd: cwd0, cols: 80, rows: 24, shell: true, sandbox: false });
  const res1 = await sessionManager.createSession({ cwd: cwd1, cols: 80, rows: 24, shell: true, sandbox: false });
  try {
    assert.equal(res0.session.ptyHostShardIndex, 0);
    assert.equal(res1.session.ptyHostShardIndex, 1);
    assert.ok(hosts[0].ptyStore.list().some((s) => s.id === res0.sessionId), 'shard 0 actually has the shard-0 session');
    assert.ok(!hosts[1].ptyStore.list().some((s) => s.id === res0.sessionId), 'shard 1 does not have the shard-0 session');
    assert.ok(hosts[1].ptyStore.list().some((s) => s.id === res1.sessionId), 'shard 1 actually has the shard-1 session');
    assert.ok(!hosts[0].ptyStore.list().some((s) => s.id === res1.sessionId), 'shard 0 does not have the shard-1 session');
  } finally {
    await destroySessionAndWait(res0.sessionId, 0);
    await destroySessionAndWait(res1.sessionId, 1);
  }
});

// The one test that actually proves the "見落としやすい罠" ptyHostClient.js's
// header comment warns about is avoided: if createSession() had re-derived
// the client for subscribe() instead of reusing the one spawn() used, and
// shardCount() (env-var read) ever disagreed between the two calls, subscribe
// would RPC a session id to the wrong instance and this would hang/fail.
test('output/write round-trip works end-to-end when routed onto the non-default shard 1', async () => {
  const cwd = findCwdForShard(1);
  const res = await sessionManager.createSession({ cwd, cols: 80, rows: 24, shell: true, sandbox: false });
  const { sessionId, session } = res;
  assert.equal(session.ptyHostShardIndex, 1);
  try {
    const marker = `SHARD1_${Date.now()}`;
    sessionManager.writeToSession(sessionId, `echo ${marker}`, { submit: true });
    await waitFor(() => session.outputBuffer.join('').includes(marker), { timeoutMs: 5000 });
  } finally {
    await destroySessionAndWait(sessionId, 1);
  }
});

test('a shared groupId keeps every member on the same shard regardless of differing cwd', async () => {
  const groupId = 'shard-affinity-group';
  const cwdA = findCwdForShard(0);
  const cwdB = findCwdForShard(1);
  const resA = await sessionManager.createSession({ cwd: cwdA, cols: 80, rows: 24, shell: true, sandbox: false, groupId, groupRole: 'worker1' });
  const resB = await sessionManager.createSession({ cwd: cwdB, cols: 80, rows: 24, shell: true, sandbox: false, groupId, groupRole: 'worker2' });
  try {
    assert.equal(resA.session.ptyHostShardIndex, resB.session.ptyHostShardIndex, 'same groupId => same shard despite different cwd');
  } finally {
    await destroySessionAndWait(resA.sessionId, resA.session.ptyHostShardIndex);
    await destroySessionAndWait(resB.sessionId, resB.session.ptyHostShardIndex);
  }
});

test('initPtyHostDestroyedHandler notices a session pty-host destroys autonomously on a non-default shard', async () => {
  const cwd1 = findCwdForShard(1);
  const res = await sessionManager.createSession({ cwd: cwd1, cols: 80, rows: 24, shell: true, sandbox: false });
  const { sessionId } = res;
  assert.equal(res.session.ptyHostShardIndex, 1);
  assert.ok(sessionManager.getSession(sessionId));

  hosts[1].ptyStore.destroy(sessionId);

  await waitFor(() => sessionManager.getSession(sessionId) === undefined, { timeoutMs: 2000 });
});

test('restorePtyHostSessions reattaches sessions spread across multiple shards, each through its own client', async () => {
  const cwd0 = findCwdForShard(0);
  const cwd1 = findCwdForShard(1);
  const res0 = await sessionManager.createSession({ cwd: cwd0, cols: 80, rows: 24, shell: true, sandbox: false });
  const res1 = await sessionManager.createSession({ cwd: cwd1, cols: 80, rows: 24, shell: true, sandbox: false });
  try {
    const marker0 = `SHARD0_PRE_${Date.now()}`;
    const marker1 = `SHARD1_PRE_${Date.now()}`;
    sessionManager.writeToSession(res0.sessionId, `echo ${marker0}`, { submit: true });
    sessionManager.writeToSession(res1.sessionId, `echo ${marker1}`, { submit: true });
    await waitFor(() => res0.session.outputBuffer.join('').includes(marker0), { timeoutMs: 5000 });
    await waitFor(() => res1.session.outputBuffer.join('').includes(marker1), { timeoutMs: 5000 });

    ptyHostClientMod.resetPtyHostClientForTests();
    sessionManager.resetPtyHostDestroyedHandlerForTests();
    sessionManager.initPtyHostDestroyedHandler();

    const info = await sessionManager.restorePtyHostSessions();
    assert.ok(info.restored >= 2, "both shards' sessions were reattached");

    const restored0 = sessionManager.getSession(res0.sessionId);
    const restored1 = sessionManager.getSession(res1.sessionId);
    assert.ok(restored0);
    assert.ok(restored1);
    assert.equal(restored0.ptyHostShardIndex, 0);
    assert.equal(restored1.ptyHostShardIndex, 1);
    assert.ok(restored0.outputBuffer.join('').includes(marker0));
    assert.ok(restored1.outputBuffer.join('').includes(marker1));
  } finally {
    await destroySessionAndWait(res0.sessionId, 0);
    await destroySessionAndWait(res1.sessionId, 1);
  }
});

test("gracefulShutdown closes every shard's client without killing any shard's ptys", async () => {
  const cwd0 = findCwdForShard(0);
  const cwd1 = findCwdForShard(1);
  const res0 = await sessionManager.createSession({ cwd: cwd0, cols: 80, rows: 24, shell: true, sandbox: false });
  const res1 = await sessionManager.createSession({ cwd: cwd1, cols: 80, rows: 24, shell: true, sandbox: false });

  await sessionManager.gracefulShutdown();

  assert.equal(sessionManager.getSession(res0.sessionId), undefined);
  assert.equal(sessionManager.getSession(res1.sessionId), undefined);
  assert.ok(hosts[0].ptyStore.list().some((s) => s.id === res0.sessionId && !s.exited), "shard 0's pty survives gracefulShutdown");
  assert.ok(hosts[1].ptyStore.list().some((s) => s.id === res1.sessionId && !s.exited), "shard 1's pty survives gracefulShutdown");

  ptyHostClientMod.resetPtyHostClientForTests();
  sessionManager.resetPtyHostDestroyedHandlerForTests();
  sessionManager.initPtyHostDestroyedHandler();

  const info = await sessionManager.restorePtyHostSessions();
  assert.ok(info.restored >= 2, 'both survived and were reattached after the simulated restart');

  await destroySessionAndWait(res0.sessionId, 0);
  await destroySessionAndWait(res1.sessionId, 1);
});

// The key safety property Step5 adds over the pre-Step5, single-instance
// restorePtyHostSessions(): one shard being unreachable must not make the
// orphaned-metadata sweep wrongly delete restore metadata for a live session
// that simply happens to live on a DIFFERENT, healthy shard.
test('restorePtyHostSessions preserves a healthy shard\'s restore metadata when a different shard is unreachable, and recovers once it comes back', async () => {
  const { loadPtyHostSessionMeta } = await import('./ptyHostSessionMeta.js');
  const cwd0 = findCwdForShard(0);
  const cwd1 = findCwdForShard(1);
  const res0 = await sessionManager.createSession({ cwd: cwd0, cols: 80, rows: 24, shell: true, sandbox: false });
  const res1 = await sessionManager.createSession({ cwd: cwd1, cols: 80, rows: 24, shell: true, sandbox: false });

  // Make shard 1 unreachable (its rpc listener down; the pty itself, and its
  // ptyStore, are untouched -- simulating a transient network blip / restart
  // window rather than an actual pty-host crash, so this cleanly isolates
  // the "unreachable" code path from the "session actually gone" one).
  const shard1SockPath = getPtyHostSockPath(1);
  const shard1PtyStore = hosts[1].ptyStore;
  await hosts[1].stop();

  try {
    ptyHostClientMod.resetPtyHostClientForTests();
    sessionManager.resetPtyHostDestroyedHandlerForTests();
    sessionManager.initPtyHostDestroyedHandler();

    const info = await sessionManager.restorePtyHostSessions();
    assert.ok(info.restored >= 1, "shard 0's session was still restored");
    assert.ok(sessionManager.getSession(res0.sessionId), 'shard 0 session is back in the sessions Map');
    assert.ok(
      loadPtyHostSessionMeta()[res1.sessionId],
      "shard 1's restore metadata must survive its shard being merely unreachable, not get swept as orphaned",
    );

    // Bring shard 1 back on the exact same socket path, reusing its
    // original ptyStore (still holding the live session) -- proves the
    // preserved metadata above was actually correct, not just harmlessly
    // stale.
    const rpc = await createRpcServer(shard1PtyStore, { sockPath: shard1SockPath });
    hosts[1] = { ptyStore: shard1PtyStore, sockPath: shard1SockPath, stop: () => rpc.close() };

    ptyHostClientMod.resetPtyHostClientForTests();
    sessionManager.resetPtyHostDestroyedHandlerForTests();
    sessionManager.initPtyHostDestroyedHandler();

    const info2 = await sessionManager.restorePtyHostSessions();
    assert.ok(info2.restored >= 1, "shard 1's session was restored now that its shard is reachable again, thanks to the preserved metadata");
    assert.ok(sessionManager.getSession(res1.sessionId), 'shard 1 session is back too');
  } finally {
    await destroySessionAndWait(res0.sessionId, 0);
    await destroySessionAndWait(res1.sessionId, 1);
  }
});
