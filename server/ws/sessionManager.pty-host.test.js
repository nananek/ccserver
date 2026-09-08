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
  // Issue #119 Step6-0: a short debounce so tests exercising the write-back
  // don't need to wait out the real (10s default) window. Read fresh per
  // call (see sessionManager.js's resumeIdWriteDebounceMs), so this is safe
  // to set once for the whole file.
  process.env.CCSERVER_RESUME_ID_DEBOUNCE_MS = '300';

  const { startPtyHost } = await import('../pty-host/index.js');
  host = await startPtyHost({ sockPath: process.env.CCSERVER_PTY_HOST_SOCK });

  ptyHostClientMod = await import('./ptyHostClient.js');
  sessionManager = await import('./sessionManager.js');
  sessionManager.initPtyHostDestroyedHandler();
  sessionManager.initPtyHostDisconnectedHandler();
  sessionManager.initPtyHostReconnectedHandler();
});

after(async () => {
  sessionManager.destroyAllSessions();
  ptyHostClientMod.resetPtyHostClientForTests();
  await host.stop();
  delete process.env.CCSERVER_PTY_HOST;
  delete process.env.CCSERVER_PTY_HOST_SOCK;
  delete process.env.CCSERVER_PTY_HOST_SESSION_META_PATH;
  delete process.env.CCSERVER_RESUME_ID_DEBOUNCE_MS;
  try { rmSync(sockDir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// Issue #119 Step6-0 test helper: a fake claude CLI printing one or more
// `claude --resume <id>` hints (extractResumeSessionId's exact pattern, see
// appLaunch.js), each separated by a short gap, before idling so the session
// stays alive long enough to inspect. Mirrors the fake-claude-binary +
// sandbox.config.json rig sessionManager.pty-host-shards.test.js's own Issue
// #143 self-review test already uses (docker:false/gitBroker:false so the
// launch never tries to build a real sandboxed environment).
function writeFakeClaudeResumeBin(dir, resumeIds) {
  const fakeBin = join(dir, 'fake-claude');
  const lines = resumeIds.map((id) => `printf "claude --resume ${id}\\n"\nsleep 0.05\n`).join('');
  writeFileSync(fakeBin, `#!/bin/bash\n${lines}sleep 100\n`, { mode: 0o755 });
  return fakeBin;
}

function writeNoSandboxConfig(dir) {
  const cfgPath = join(dir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false }));
  return cfgPath;
}

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

// Step4 (plan5): gracefulShutdown() under CCSERVER_PTY_HOST=1 must not kill
// the pty-host-owned session -- doing so would defeat Step3's
// restore-on-restart before it ever gets a chance to run (see
// gracefulShutdown()'s own header comment in sessionManager.js). It should
// only drop server本体's local bookkeeping and disconnect this process's own
// UDS link, leaving the pty (and its restore metadata) alone -- so a
// restorePtyHostSessions() call right after, simulating the next boot, can
// still reattach to it with its backlog intact.
test('gracefulShutdown under CCSERVER_PTY_HOST=1 does not kill pty-host sessions -- they survive for the next restorePtyHostSessions()', async () => {
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const { sessionId } = res;
  const marker = `PRE_SHUTDOWN_${Date.now()}`;
  sessionManager.writeToSession(sessionId, `echo ${marker}`, { submit: true });
  await waitFor(() => res.session.outputBuffer.join('').includes(marker), { timeoutMs: 5000 });

  await sessionManager.gracefulShutdown();

  assert.equal(sessionManager.getSession(sessionId), undefined, 'server本体 forgot the session locally');
  assert.ok(
    host.ptyStore.list().some((s) => s.id === sessionId && !s.exited),
    'the pty itself is still alive on pty-host, untouched by the shutdown',
  );

  // Simulate the client-side half of a server本体 restart, same rig as the
  // restorePtyHostSessions test above.
  ptyHostClientMod.resetPtyHostClientForTests();
  sessionManager.resetPtyHostDestroyedHandlerForTests();
  sessionManager.initPtyHostDestroyedHandler();

  const info = await sessionManager.restorePtyHostSessions();
  assert.ok(info.restored >= 1, 'the still-live session was reattached after the simulated restart');

  const restored = sessionManager.getSession(sessionId);
  assert.ok(restored, 'session is back in the local sessions Map after restore');
  assert.ok(restored.outputBuffer.join('').includes(marker), 'pre-shutdown output survived and was replayed');

  await destroySessionAndWait(sessionId);
});

// Issue #119 Step6-0: the whole point of continuously tracking claude's
// --resume hint (rather than only extracting it once at onExit, the
// pre-existing behavior) is that pty-host's own crash-recovery auto-resume
// needs an ACCURATE id while the session is still very much alive. Two
// different hints (a compaction-like re-print) prove both that the FIRST one
// reaches disk promptly and that a CHANGED value overwrites it rather than
// sticking to whatever was first seen.
test('a live claude session\'s claude --resume hint is tracked and written back to ptyHostSessionMeta.json, latest value wins', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccserver-sm-ptyhost-resume-track-'));
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-sm-ptyhost-resume-track-cfg-'));
  const fakeBin = writeFakeClaudeResumeBin(cwd, ['resume-hint-first', 'resume-hint-second']);
  const cfgPath = writeNoSandboxConfig(cfgDir);
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_CLAUDE_BIN = fakeBin;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  let res;
  try {
    res = await sessionManager.createSession({ cwd, cols: 80, rows: 24, shell: false, app: 'claude', sandbox: false });
    const { sessionId, session } = res;
    assert.ok(res.session, `claude session should spawn, got error: ${res.error}`);

    await waitFor(() => session.outputBuffer.join('').includes('resume-hint-first'));
    assert.equal(session.lastKnownResumeId, 'resume-hint-first', 'tracked in memory as soon as the first hint is seen');
    await waitFor(
      () => ptyHostSessionMeta.loadPtyHostSessionMeta()[sessionId]?.latestClaudeSessionId === 'resume-hint-first',
      { timeoutMs: 2000 },
    );

    await waitFor(() => session.outputBuffer.join('').includes('resume-hint-second'));
    assert.equal(session.lastKnownResumeId, 'resume-hint-second', 'in-memory value follows the latest hint, not the first');
    await waitFor(
      () => ptyHostSessionMeta.loadPtyHostSessionMeta()[sessionId]?.latestClaudeSessionId === 'resume-hint-second',
      { timeoutMs: 2000 },
    );
  } finally {
    if (res?.session) await destroySessionAndWait(res.sessionId);
    if (prevBin === undefined) delete process.env.CCSERVER_CLAUDE_BIN; else process.env.CCSERVER_CLAUDE_BIN = prevBin;
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG; else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// Issue #119 Step6-0: proves the debounce actually delays a rapid second
// write rather than firing on every detected change -- a longer, dedicated
// window (this file's `before()` default of 300ms is tuned for other tests'
// patience, not for observing an in-flight delay) with generous margins on
// both sides of it.
test('ptyHostSessionMeta.json write-back is debounced: a rapid second hint does not land immediately', async () => {
  const prevDebounce = process.env.CCSERVER_RESUME_ID_DEBOUNCE_MS;
  process.env.CCSERVER_RESUME_ID_DEBOUNCE_MS = '600';
  const cwd = mkdtempSync(join(tmpdir(), 'ccserver-sm-ptyhost-resume-debounce-'));
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-sm-ptyhost-resume-debounce-cfg-'));
  const fakeBin = writeFakeClaudeResumeBin(cwd, ['debounce-hint-first', 'debounce-hint-second']);
  const cfgPath = writeNoSandboxConfig(cfgDir);
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_CLAUDE_BIN = fakeBin;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  let res;
  try {
    res = await sessionManager.createSession({ cwd, cols: 80, rows: 24, shell: false, app: 'claude', sandbox: false });
    const { sessionId, session } = res;
    assert.ok(res.session, `claude session should spawn, got error: ${res.error}`);

    // First hint: resumeIdLastWriteAt starts at 0, so this always writes
    // immediately regardless of the debounce window (see
    // scheduleResumeIdWriteback's own comment).
    await waitFor(() => ptyHostSessionMeta.loadPtyHostSessionMeta()[sessionId]?.latestClaudeSessionId === 'debounce-hint-first', { timeoutMs: 2000 });

    // The second hint prints ~50ms later (writeFakeClaudeResumeBin's gap),
    // well inside the 600ms window that just started -- shortly after it is
    // detected, the file must still show the FIRST value.
    await waitFor(() => session.lastKnownResumeId === 'debounce-hint-second', { timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(
      ptyHostSessionMeta.loadPtyHostSessionMeta()[sessionId]?.latestClaudeSessionId,
      'debounce-hint-first',
      'the second hint is being held back by the debounce, not written immediately',
    );

    // Once the window elapses, the held-back (latest) value reaches disk.
    await waitFor(
      () => ptyHostSessionMeta.loadPtyHostSessionMeta()[sessionId]?.latestClaudeSessionId === 'debounce-hint-second',
      { timeoutMs: 2000 },
    );
  } finally {
    if (res?.session) await destroySessionAndWait(res.sessionId);
    if (prevBin === undefined) delete process.env.CCSERVER_CLAUDE_BIN; else process.env.CCSERVER_CLAUDE_BIN = prevBin;
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG; else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    if (prevDebounce === undefined) delete process.env.CCSERVER_RESUME_ID_DEBOUNCE_MS; else process.env.CCSERVER_RESUME_ID_DEBOUNCE_MS = prevDebounce;
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// Issue #119 Step6-0: a pending debounced write must not be lost just
// because the pty exits before the debounce window elapses on its own -- see
// buildSessionRecord's onExit flush. A long debounce (much longer than this
// test is willing to wait) makes sure it's genuinely the exit-triggered
// flush landing this, not the timer coincidentally firing first.
test('a pending resume-id write-back is flushed immediately when the pty exits, not lost to the debounce window', async () => {
  const prevDebounce = process.env.CCSERVER_RESUME_ID_DEBOUNCE_MS;
  process.env.CCSERVER_RESUME_ID_DEBOUNCE_MS = '60000';
  const cwd = mkdtempSync(join(tmpdir(), 'ccserver-sm-ptyhost-resume-exitflush-'));
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-sm-ptyhost-resume-exitflush-cfg-'));
  const cfgPath = writeNoSandboxConfig(cfgDir);
  // Unlike writeFakeClaudeResumeBin (which idles after printing so a test can
  // keep inspecting a still-live session), this one exits right after its
  // second hint -- the exact scenario under test.
  const fakeBin = join(cwd, 'fake-claude');
  writeFileSync(
    fakeBin,
    '#!/bin/bash\nprintf "claude --resume exitflush-hint-first\\n"\nsleep 0.05\nprintf "claude --resume exitflush-hint-second\\n"\n',
    { mode: 0o755 },
  );
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  process.env.CCSERVER_CLAUDE_BIN = fakeBin;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  let res;
  try {
    res = await sessionManager.createSession({ cwd, cols: 80, rows: 24, shell: false, app: 'claude', sandbox: false });
    const { sessionId, session } = res;
    assert.ok(res.session, `claude session should spawn, got error: ${res.error}`);

    await waitFor(() => session.exited === true, { timeoutMs: 5000 });
    assert.equal(session.lastKnownResumeId, 'exitflush-hint-second', 'the second (pending, debounced) hint was still captured before exit');
    assert.equal(
      ptyHostSessionMeta.loadPtyHostSessionMeta()[sessionId]?.latestClaudeSessionId,
      'exitflush-hint-second',
      'onExit flushed the pending value instead of leaving it stuck behind the (60s) debounce window',
    );
  } finally {
    if (res?.session) await destroySessionAndWait(res.sessionId);
    if (prevBin === undefined) delete process.env.CCSERVER_CLAUDE_BIN; else process.env.CCSERVER_CLAUDE_BIN = prevBin;
    delete process.env.CCSERVER_SANDBOX_CONFIG;
    if (prevDebounce === undefined) delete process.env.CCSERVER_RESUME_ID_DEBOUNCE_MS; else process.env.CCSERVER_RESUME_ID_DEBOUNCE_MS = prevDebounce;
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// Issue #119 Step6 end-to-end: pty-host itself crashing and restarting (here,
// closing the RPC listener then starting a brand new startPtyHost() at the
// SAME sockPath -- a real crash would also SIGHUP every pty it owned, but
// that part is unreachable from a controlled test the same way it always is
// in this file, see e.g. the shutdown test above) must relaunch this
// session's SAME id via auto-resume (Step6-3), and server本体's own client
// reconnecting to the new instance must reattach it (Step6's
// initPtyHostReconnectedHandler) -- without a human touching anything.
test('a claude session survives a pty-host crash+restart with the same id, and server本体 reattaches it once its shard reconnects', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccserver-sm-ptyhost-autoresume-'));
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-sm-ptyhost-autoresume-cfg-'));
  const fakeBin = writeFakeClaudeResumeBin(cwd, ['auto-resume-hint']);
  const cfgPath = writeNoSandboxConfig(cfgDir);
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_CLAUDE_BIN = fakeBin;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  // Captured before any reassignment below, so cleanup can always reach the
  // pre-crash instance directly -- host.stop() only closes its RPC listener
  // (see this file's earlier "stop() must not destroy live sessions" test),
  // so the ORIGINAL process this test's session started as keeps running,
  // unreachable via RPC but still a live child of this test process, until
  // something calls ptyStore.destroy() on it directly.
  const crashedHost = host;
  // A fresh client with every handler re-armed against it -- an earlier
  // test's own resetPtyHostClientForTests() (e.g. "restorePtyHostSessions
  // reattaches...") drops the client object initPtyHostDisconnectedHandler/
  // initPtyHostReconnectedHandler were armed against in this file's
  // before(), only re-arming initPtyHostDestroyedHandler for its own needs.
  // Without this, this test's crashedHost.stop() below would go unnoticed by
  // a disconnected handler still listening on a client nothing uses anymore.
  ptyHostClientMod.resetPtyHostClientForTests();
  sessionManager.resetPtyHostDestroyedHandlerForTests();
  sessionManager.resetPtyHostDisconnectedHandlerForTests();
  sessionManager.resetPtyHostReconnectedHandlerForTests();
  sessionManager.initPtyHostDestroyedHandler();
  sessionManager.initPtyHostDisconnectedHandler();
  sessionManager.initPtyHostReconnectedHandler();
  let res;
  let freshHost;
  try {
    res = await sessionManager.createSession({ cwd, cols: 80, rows: 24, shell: false, app: 'claude', sandbox: false });
    const { sessionId, session } = res;
    assert.ok(res.session, `claude session should spawn, got error: ${res.error}`);

    await waitFor(() => session.outputBuffer.join('').includes('auto-resume-hint'));
    await waitFor(
      () => ptyHostSessionMeta.loadPtyHostSessionMeta()[sessionId]?.latestClaudeSessionId === 'auto-resume-hint',
      { timeoutMs: 2000 },
    );

    // Simulate pty-host crashing: close the RPC listener (this file's shared
    // `host`) -- server本体's client sees a real 'close', firing
    // onDisconnected (session ghosted from `sessions`, see Issue #143).
    await crashedHost.stop();
    await waitFor(() => sessionManager.getSession(sessionId) === undefined, { timeoutMs: 2000 });

    // Simulate systemd's Restart=on-failure bringing a fresh instance back up
    // at the SAME socket path -- its own startup runs auto-resume (Step6-3)
    // before opening the RPC listener, so by the time this resolves, the
    // relaunched session already exists under the SAME id.
    const { startPtyHost } = await import('../pty-host/index.js');
    freshHost = await startPtyHost({ sockPath: process.env.CCSERVER_PTY_HOST_SOCK });
    assert.ok(freshHost.ptyStore.list().some((s) => s.id === sessionId), 'auto-resume relaunched the same session id');

    // server本体's client reconnects on its own backoff schedule; once it
    // does, initPtyHostReconnectedHandler's reconcile must notice the
    // relaunched session and bring it back into `sessions`.
    await waitFor(() => sessionManager.getSession(sessionId) !== undefined, { timeoutMs: 5000 });
    const reattached = sessionManager.getSession(sessionId);
    assert.equal(reattached.cwd, cwd);
    assert.equal(reattached.app, 'claude');

    // Prove it's a genuinely live, usable pty, not just a Map entry.
    const newMarker = `AFTER_AUTORESUME_MARKER_${Date.now()}`;
    sessionManager.writeToSession(sessionId, `echo ${newMarker}`, { submit: true });
    await waitFor(() => reattached.outputBuffer.join('').includes(newMarker), { timeoutMs: 5000 });

    // From here on this file's shared `host` IS freshHost -- every later
    // test (and this file's own after()) must operate on the instance the
    // client is actually connected to now.
    host = freshHost;
  } finally {
    // Reap both generations' processes directly (bypassing the client/RPC
    // entirely, same reasoning as ptyHostClient.test.js's own teardown
    // pattern): the pre-crash one crashedHost's now-unreachable-via-RPC
    // ptyStore still holds, and (if auto-resume/reconnect got far enough to
    // create it) the post-crash one on freshHost. Both are no-ops if the
    // id was never actually running there.
    if (res?.sessionId) {
      try { crashedHost.ptyStore.destroy(res.sessionId); } catch { /* already gone */ }
      if (freshHost) { try { freshHost.ptyStore.destroy(res.sessionId); } catch { /* already gone */ } }
    }
    // Drop whatever server本体-side bookkeeping survived (harmless no-op if
    // the session was already ghosted/never reattached).
    if (res?.sessionId) sessionManager.destroySession(res.sessionId, { reason: 'test' });
    // Whatever went wrong or how far this got, every later test in this file
    // (and this file's own after()) needs `host` to end up as a genuinely
    // live instance at the shared socket path -- restore that unconditionally
    // rather than only on the success path. freshHost is already exactly
    // that if it was created; crashedHost is only still usable if it was
    // NEVER stopped (an assertion failed before that line).
    if (freshHost) {
      host = freshHost;
    } else if (host === crashedHost) {
      try {
        // Already-listening probe: crashedHost.stop() may or may not have
        // run before this depending on where the test failed. connectionCount
        // isn't exposed here, so just attempt a fresh listen and treat
        // EADDRINUSE (still listening -- stop() never ran) as "already fine".
        const { startPtyHost } = await import('../pty-host/index.js');
        host = await startPtyHost({ sockPath: process.env.CCSERVER_PTY_HOST_SOCK });
      } catch {
        // crashedHost was never actually stopped (failed before that line) --
        // it's still the live, listening instance; leave `host` as is.
      }
    }
    if (prevBin === undefined) delete process.env.CCSERVER_CLAUDE_BIN; else process.env.CCSERVER_CLAUDE_BIN = prevBin;
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG; else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
