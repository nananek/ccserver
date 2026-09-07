// CCSERVER_PTY_HOST=1 integration: exercises sessionManager.js's usePtyHost
// branches (plan5 Step2) against a real in-process pty-host instance, with a
// real bash pty underneath -- same "no mocks" approach as
// server/ws/sessionManager.test.js and server/ws/ptyHostClient.test.js.
//
// A dedicated file (not folded into sessionManager.test.js) because the flag
// is read at call time by createSession()/destroySession() themselves, so
// flipping it for "just a few tests" in a shared file would leak into
// whichever tests run after them in the same process. node:test gives every
// file its own process, so setting the env var once in this file's `before`
// cleanly isolates it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxAvailable, persistentHomeDir } from './sandbox.js';
import * as ptyHostSessionMeta from './ptyHostSessionMeta.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(check, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // await, not a bare call -- see ptyHostClient.test.js's waitFor for why
    // a bare `if (check())` would be wrong for an async check function.
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await sleep(intervalMs);
  }
}

let sessionManager;
let ptyHostClientMod;
let host;
let sockDir;
let runtimeDir;

before(async () => {
  sockDir = mkdtempSync(join(tmpdir(), 'ccserver-sm-ptyhost-test-'));
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-sm-ptyhost-runtime-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  process.env.CCSERVER_ORCHESTRATOR_GENERATED_ROOT = join(runtimeDir, 'orchestrator-generated');
  process.env.CCSERVER_PTY_HOST_SESSION_META_PATH = join(runtimeDir, 'pty-host-session-meta.json');
  process.env.CCSERVER_PTY_HOST_SOCK = join(sockDir, 'pty-host.sock');
  process.env.CCSERVER_PTY_HOST = '1';

  const { startPtyHost } = await import('../pty-host/index.js');
  host = await startPtyHost({ sockPath: process.env.CCSERVER_PTY_HOST_SOCK });

  ptyHostClientMod = await import('./ptyHostClient.js');
  sessionManager = await import('./sessionManager.js');
  sessionManager.initPtyHostDestroyedHandler();
});

after(async () => {
  sessionManager.destroyAllSessions();
  ptyHostClientMod.resetPtyHostClientForTests();
  await host.stop();
  delete process.env.CCSERVER_PTY_HOST;
  delete process.env.CCSERVER_PTY_HOST_SOCK;
  delete process.env.CCSERVER_PTY_HOST_SESSION_META_PATH;
  try { rmSync(sockDir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// destroySession()'s pty-host teardown is fire-and-forget: waiting for it to
// actually land on pty-host's side (not just returning from the call) before
// moving on is required everywhere in this file, not just where it looks
// convenient. Skipping it let a torn-down-but-not-yet-reaped session survive
// into afterEach()/after()'s own teardown, racing PtyHostClient.close() /
// host.stop() there and hanging the whole test process's natural exit --
// exactly the same class of bug ptyHostClient.test.js hit and fixed.
async function destroySessionAndWait(sessionId) {
  sessionManager.destroySession(sessionId, { reason: 'test' });
  await waitFor(() => !host.ptyStore.list().some((s) => s.id === sessionId), { timeoutMs: 2000 });
}

test('createSession spawns through pty-host and returns a RemotePty-backed session', async () => {
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  try {
    assert.ok(res.session, 'shell session should spawn via pty-host');
    assert.ok(res.session.ptyProcess.sessionId, 'ptyProcess is a RemotePty, not a direct node-pty IPty');
    assert.ok(res.session.ptyProcess.pid > 0);
  } finally {
    await destroySessionAndWait(res.sessionId);
  }
});

// The whole point of the Step2 "stay subscribed for the session's whole
// life" design revision (see createSession()'s usePtyHost branch and
// ptyHostClient.js's subscribe()): AutoYes auto-response and session-limit
// detection read session.outputBuffer / feed session.screen on every output
// chunk regardless of viewer count. If subscribe were still tied to
// session.sockets.size (plan5 5.2.3's original sketch), this would time out
// -- nobody ever attaches a socket in this test.
test('output reaches session.outputBuffer via pty-host with zero browser viewers attached', async () => {
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const { sessionId, session } = res;
  assert.equal(session.sockets.size, 0, 'no viewer attached');
  try {
    const marker = `PTYHOST_SM_${Date.now()}`;
    sessionManager.writeToSession(sessionId, `echo ${marker}`, { submit: true });
    await waitFor(() => session.outputBuffer.join('').includes(marker), { timeoutMs: 5000 });
  } finally {
    await destroySessionAndWait(sessionId);
  }
});

test('destroySession tears down the pty-host session too: it disappears from pty-host\'s own list()', async () => {
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const { sessionId } = res;
  assert.ok(host.ptyStore.list().some((s) => s.id === sessionId), 'pty-host has the session before teardown');
  await destroySessionAndWait(sessionId);
  assert.equal(sessionManager.getSession(sessionId), undefined, 'gone from server本体\'s local sessions Map');
});

// Exercises initPtyHostDestroyedHandler(): when pty-host tears a session down
// on its own (simulated here by reaching into host.ptyStore directly, since
// server本体 never initiates this path itself), server本体 must notice via
// the `destroyed` push event and clean up its own sessions Map -- without
// this, the session would live on as a zombie entry that destroySession()
// (and every other API) would think was still real.
test('a session pty-host destroys autonomously is cleaned up from the local sessions Map via onDestroyed', async () => {
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const { sessionId } = res;
  assert.ok(sessionManager.getSession(sessionId), 'session is tracked locally before pty-host acts');

  host.ptyStore.destroy(sessionId);

  await waitFor(() => sessionManager.getSession(sessionId) === undefined, { timeoutMs: 2000 });
});

// plan5 2.1 (the approved Step2 scope expansion): usePtyHost sessions no
// longer call buildSandboxSpawn() here at all -- pty-host's own spawn()
// builds the sandbox internally. This is the one test that actually proves
// that delegation works end-to-end, not just that the non-sandboxed path
// still spawns.
test('spawn({sandbox:true}) delegates sandbox construction to pty-host and actually runs inside bwrap', { skip: !sandboxAvailable() }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccserver-sm-ptyhost-sandbox-proj-'));
  // The fake agent binary must live under cwd, not a separate /tmp dir: the
  // sandbox's /tmp is a fresh tmpfs (see ptyStore.js's header comment) that
  // never sees the host's /tmp contents, but cwd itself is what the sandbox
  // bind-mounts in.
  const fakeBin = join(cwd, 'fake-claude');
  writeFileSync(fakeBin, '#!/bin/bash\necho SANDBOXED_MARKER_$$\n', { mode: 0o755 });
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  process.env.CCSERVER_CLAUDE_BIN = fakeBin;
  // docker:false -- this test only cares about the bwrap/rootlesskit
  // delegation, and a rootlesskit (docker) sandbox requires subuid/subgid
  // ranges this environment (itself running as an unprivileged-mapped-to-
  // root sandbox user) doesn't have. Same config shape ptyStore.test.js's
  // own sandbox integration test uses.
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-sm-ptyhost-sandbox-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, persistentHome: false }));
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  // Declared outside the try so the outer `finally` can always reach them --
  // a `waitFor` timeout partway through (e.g. the marker never showing up)
  // must never skip tearing down a session that pty-host already spawned:
  // that session's exited-timeout timer (server/ws/sessionManager.js's
  // startTimeout(), never unref'd) would otherwise keep this whole test
  // process alive for SESSION_EXITED_TIMEOUT_MS (default 5 minutes).
  let res;
  let stillRunning;
  try {
    res = await sessionManager.createSession({
      cwd, cols: 80, rows: 24, shell: false, app: 'claude', sandbox: true,
    });
    assert.ok(res.session, 'sandboxed agent session should spawn via pty-host');
    assert.equal(res.session.sandbox, true);
    await waitFor(() => res.session.outputBuffer.join('').includes('SANDBOXED_MARKER'), { timeoutMs: 8000 });

    // dockerAvailability() is a pure function over the session shape -- must
    // keep working unmodified against a pty-host session's populated
    // .sandbox/.docker/.dockerTag/.cwd fields. docker:false above means
    // 'disabled-by-config' here.
    const avail = sessionManager.dockerAvailability(res.session);
    assert.equal(avail.dockerReason, 'disabled-by-config');

    // sandboxHomeConflict() only counts LIVE sandboxed sessions -- the fake
    // agent above already exited (it just echoes and returns), so exercise
    // this against a still-running one instead.
    const longLivedBin = join(cwd, 'fake-claude-longlived');
    writeFileSync(longLivedBin, '#!/bin/bash\necho SANDBOXED_MARKER2_$$\nsleep 30\n', { mode: 0o755 });
    process.env.CCSERVER_CLAUDE_BIN = longLivedBin;
    stillRunning = await sessionManager.createSession({ cwd, cols: 80, rows: 24, shell: false, app: 'claude', sandbox: true });
    assert.ok(stillRunning.session, 'long-lived sandboxed agent session should spawn via pty-host');
    await waitFor(() => stillRunning.session.outputBuffer.join('').includes('SANDBOXED_MARKER2'), { timeoutMs: 8000 });
    assert.equal(stillRunning.session.exited, false, 'still running by the time the conflict check runs');
    assert.equal(
      sessionManager.sandboxHomeConflict(persistentHomeDir(cwd), [stillRunning.session]),
      true,
      'a live sandboxed session must register as a conflict for its own persistent HOME',
    );
  } finally {
    if (stillRunning?.session) await destroySessionAndWait(stillRunning.sessionId);
    if (res?.session) await destroySessionAndWait(res.sessionId);
    if (prevBin === undefined) delete process.env.CCSERVER_CLAUDE_BIN;
    else process.env.CCSERVER_CLAUDE_BIN = prevBin;
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// Regression test: sessionManager.js forces sessionApp to null for shell:true
// launches (see its `shell ? null : ...` computation), but pty-host's own
// spawn() refuses sandbox:true without an "app" (server/pty-host/ptyStore.js)
// -- stricter than buildSandboxSpawn's resolveApp(), which already treats a
// null/unrecognized app as "resolve the claude binary" and never threw. shell
// + sandbox is a real, reachable combination (plain POST /api/sessions, and
// RemoteInstanceView.jsx's independently-toggleable シェル/サンドボックス
// checkboxes both being on), so createSession() must keep it working under
// usePtyHost exactly as it did before pty-host existed -- see this file's
// createSession() usePtyHost branch, which now falls back to a non-null
// "app" value for pty-host's spawn() call specifically to satisfy this.
test('spawn({shell:true, sandbox:true}) still works through pty-host (session.app stays null)', { skip: !sandboxAvailable() }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccserver-sm-ptyhost-shellsandbox-proj-'));
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-sm-ptyhost-shellsandbox-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, persistentHome: false }));
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  let res;
  try {
    res = await sessionManager.createSession({ cwd, cols: 80, rows: 24, shell: true, sandbox: true });
    assert.ok(res.session, `sandboxed shell session should spawn via pty-host, got error: ${res.error}`);
    assert.equal(res.session.sandbox, true);
    assert.equal(res.session.app, null, 'session.app stays null for shell launches, sandboxed or not');
    sessionManager.writeToSession(res.sessionId, 'echo SHELL_SANDBOX_MARKER_$$', { submit: true });
    await waitFor(() => res.session.outputBuffer.join('').includes('SHELL_SANDBOX_MARKER'), { timeoutMs: 8000 });
  } finally {
    if (res?.session) await destroySessionAndWait(res.sessionId);
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('a pty-host-hosted session\'s pty actually dies with the shell process (real exit propagates through RemotePty)', async () => {
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const { sessionId, session } = res;
  try {
    sessionManager.writeToSession(sessionId, 'exit', { submit: true });
    await waitFor(() => session.exited === true, { timeoutMs: 5000 });
    assert.equal(session.exitCode, 0);
  } finally {
    await destroySessionAndWait(sessionId);
  }
});

// Step3 (plan5): restorePtyHostSessions() is what a real server本体 restart
// calls at boot to reattach to pty-host sessions that survived it. There is
// no seam to actually clear the module-level `sessions` Map the way a real
// process restart would (it's private, and destroyAllSessions() would tear
// down the pty-host session too, defeating the point) -- these tests instead
// drop the CLIENT-side state only (resetPtyHostClientForTests(), exactly the
// plan's own suggested rig) and verify restorePtyHostSessions() rebuilds a
// live, functional session from pty-host's list() + this file's own restore
// metadata, attaching a genuinely fresh RemotePty (the reset client's
// _remotePtys cache starts empty, so attach() can't be a cache hit).
test('restorePtyHostSessions reattaches a live session, replays its backlog, and keeps it functional', async () => {
  const res = await sessionManager.createSession({
    cwd: '/tmp', cols: 90, rows: 30, shell: true, sandbox: false,
    groupId: 'test-group-restore', groupRole: 'worker1', customLabel: 'Restore Me',
  });
  const { sessionId } = res;
  const oldPtyProcess = res.session.ptyProcess;
  try {
    const marker1 = `PRE_RESTORE_${Date.now()}`;
    sessionManager.writeToSession(sessionId, `echo ${marker1}`, { submit: true });
    await waitFor(() => res.session.outputBuffer.join('').includes(marker1), { timeoutMs: 5000 });

    // Simulate the client-side half of a server本体 restart: a fresh
    // PtyHostClient (armed exactly as server/index.js arms it at boot) with
    // no memory of any previously-attached RemotePty.
    ptyHostClientMod.resetPtyHostClientForTests();
    sessionManager.resetPtyHostDestroyedHandlerForTests();
    sessionManager.initPtyHostDestroyedHandler();

    const info = await sessionManager.restorePtyHostSessions();
    assert.ok(info.restored >= 1, 'at least this session was reattached');

    const restored = sessionManager.getSession(sessionId);
    assert.ok(restored, 'session is back in the local sessions Map');
    assert.notEqual(restored.ptyProcess, oldPtyProcess, 'a fresh RemotePty was attached, not the stale one');
    assert.equal(restored.cwd, '/tmp');
    assert.equal(restored.shell, true);
    assert.equal(restored.groupId, 'test-group-restore');
    assert.equal(restored.groupRole, 'worker1');
    assert.equal(restored.customLabel, 'Restore Me');
    assert.equal(restored.settled, true, 'a reattached session is not mid init-burst');
    assert.ok(
      restored.outputBuffer.join('').includes(marker1),
      'pre-restore output was replayed into outputBuffer via subscribe()',
    );

    const marker2 = `POST_RESTORE_${Date.now()}`;
    sessionManager.writeToSession(sessionId, `echo ${marker2}`, { submit: true });
    await waitFor(() => restored.outputBuffer.join('').includes(marker2), { timeoutMs: 5000 });
  } finally {
    await destroySessionAndWait(sessionId);
  }
});

test('restorePtyHostSessions leaves a pty-host session alone when its restore metadata is missing', async () => {
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const { sessionId } = res;
  try {
    // Simulates bullet 2 of restorePtyHostSessions' three-way match: pty-host
    // still has the session, but its metadata entry is gone (never written,
    // or lost some other way) -- restoring from partial/guessed fields is
    // explicitly out per plan5 Step3, so this must be left alone rather than
    // rebuilt with defaults.
    ptyHostSessionMeta.deletePtyHostSessionMeta(sessionId);

    const info = await sessionManager.restorePtyHostSessions();
    assert.ok(info.orphanedLive >= 1, 'counted as a live session with no metadata');

    // Untouched: still the original session this test created, still live.
    const stillThere = sessionManager.getSession(sessionId);
    assert.ok(stillThere, 'original session entry was left alone');
    assert.equal(stillThere.exited, false);
  } finally {
    await destroySessionAndWait(sessionId);
  }
});

test('restorePtyHostSessions drops a metadata entry whose pty-host session no longer exists', async () => {
  // A synthetic orphan: no real pty-host session was ever spawned for this
  // id, simulating bullet 3 (metadata survived a pty-host-side crash/restart
  // that server本体 did not go through). Deliberately NOT routed through
  // host.ptyStore.destroy() on a real session -- that fires the `destroyed`
  // push event, which initPtyHostDestroyedHandler() (armed in `before()`)
  // already cleans up on its own, making it impossible to isolate this
  // function's own orphaned-metadata sweep from that unrelated cleanup path.
  const fakeId = 'restore-test-orphan-meta-id';
  ptyHostSessionMeta.setPtyHostSessionMeta(fakeId, {
    cwd: '/tmp', shell: true, app: null, model: null, permissionMode: 'standard',
    groupId: null, groupRole: null, customLabel: null, isMetaAgent: false,
    sandbox: false, sandboxOpts: null, docker: false, sandboxStateDir: null,
    reuseSandboxHome: true, startedClaudeSessionId: null,
  });

  const info = await sessionManager.restorePtyHostSessions();
  assert.ok(info.orphanedMeta >= 1, 'the synthetic orphan was counted');
  assert.equal(ptyHostSessionMeta.loadPtyHostSessionMeta()[fakeId], undefined, 'its metadata entry was dropped');
  assert.equal(sessionManager.getSession(fakeId), undefined, 'nothing was ever added to the sessions Map for it');
});
