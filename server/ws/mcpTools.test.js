// Unit tests for the MCP tool layer (mcpTools.js + groupManager.js), with
// special focus on the authorization boundary: a group's orchestrator must
// never be able to reach a session belonging to another group (or any session
// that is not a registered member). These tests use the real in-memory group
// registry but never spawn real agent sessions -- the member ids are fake
// registrations, which is exactly what the boundary checks operate on.
//
// MCP SDK / bwrap / browser / agent CLIs are NOT required.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let runtimeDir;
let groupManager;
let tools;
let screenModel;
let groupsToDestroy = [];
// Real on-disk repo fixtures for repo_info (see the repoInfo tests below).
let tmpRepos = [];

// The real brokers listen under XDG_RUNTIME_DIR (read at mcpBroker module
// evaluation), so point it at a fresh dir before importing.
before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-mcp-test-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  // Group persistence must never touch the repo-root state file during tests.
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  groupManager = await import('./groupManager.js');
  tools = await import('./mcpTools.js');
  screenModel = await import('./screenModel.js');
});

after(() => {
  for (const id of groupsToDestroy) groupManager.destroyGroup(id);
  for (const dir of tmpRepos) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Real on-disk repo fixtures for repo_info (see the repoInfo tests below).
function makeTmpRepo(tag) {
  const dir = mkdtempSync(join(tmpdir(), `ccserver-repo-${tag}-`));
  tmpRepos.push(dir);
  return dir;
}

async function makeGroupAsync() {
  const id = randomUUID();
  await groupManager.createGroup({ groupId: id, cwd: `/srv/project-${id}`, orchestratorDir: `/srv/orch-${id}` });
  groupsToDestroy.push(id);
  return id;
}

// deps the way mcpServer would build them for the control socket. The
// groupManager injected here is the REAL facade the production brokers
// receive (getGroupManagerApi) -- NOT the full module -- so a missing
// facade function (like the historical getGroup gap that broke repo_info in
// production) fails these tests instead of slipping past them.
function controlDeps(groupId) {
  return {
    groupId,
    groupManager: groupManager.getGroupManagerApi(),
    sessionManager: { getSession: () => null, writeToSession: () => false, waitUntilSettled: async () => ({ settled: true }) },
  };
}

// The production deps shape for broker servers: groupManager arrives as the
// narrow groupManagerApi facade (groupManager.js), which deliberately exposes
// getGroupCwd but NOT the raw getGroup (the group object carries controlBroker
// socket paths, handoff channels, etc. that LLM-facing tools must not reach).
// repo_info must work against exactly this shape.
function prodFacadeDeps(groupId) {
  return {
    groupId,
    groupManager: { getGroupCwd: (id) => groupManager.getGroupCwd(id) },
    sessionManager: { getSession: () => null, writeToSession: () => false, waitUntilSettled: async () => ({ settled: true }) },
  };
}

// deps the way mcpServer would build them for a worker's handoff socket:
// sessionId comes from the closure (here a fake registered id), never from args
function handoffDeps(groupId, role, sessionId) {
  return {
    groupId,
    role,
    getSessionId: () => sessionId,
    groupManager: groupManager.getGroupManagerApi(),
    sessionManager: { getSession: () => null, writeToSession: () => false, waitUntilSettled: async () => ({ settled: true }) },
  };
}

test('listGroupSessions reports registered members with roles', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a');
  groupManager.registerMember(g, 'workerB', 'sess-b');
  groupManager.registerMember(g, 'orchestrator', 'sess-o');

  const { members } = tools.listGroupSessions(controlDeps(g));
  const byRole = Object.fromEntries(members.map((m) => [m.role, m]));
  assert.equal(byRole.workerA.sessionId, 'sess-a');
  assert.equal(byRole.workerB.sessionId, 'sess-b');
  assert.equal(byRole.orchestrator.sessionId, 'sess-o');
  assert.equal(members.length, 3);
  // No live sessions behind these member ids (getSession returns null) ->
  // autoYes is null, like connected/lastOutputAt.
  assert.equal(byRole.workerA.autoYes, null);
  assert.equal(byRole.orchestrator.autoYes, null);
});

test('isSessionInGroup: only registered members pass', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a');
  assert.equal(groupManager.isSessionInGroup(g, 'sess-a'), true);
  assert.equal(groupManager.isSessionInGroup(g, 'sess-other'), false);
  assert.equal(groupManager.isSessionInGroup('no-such-group', 'sess-a'), false);
});

// The critical boundary: a group's tools must refuse every session id that
// belongs to a different group (or none at all).
test('authorization: cross-group session ids are refused by every tool', async () => {
  const a = await makeGroupAsync();
  const b = await makeGroupAsync();
  groupManager.registerMember(a, 'workerA', 'sess-a1');
  groupManager.registerMember(a, 'orchestrator', 'sess-a2');
  groupManager.registerMember(b, 'workerA', 'sess-b1');

  const depsA = controlDeps(a);

  const r = tools.readOutput(depsA, { sessionId: 'sess-b1' });
  assert.equal(r.error, 'unauthorized');

  const i = await tools.sendInput(depsA, { sessionId: 'sess-b1', text: 'ls' });
  assert.equal(i.error, 'unauthorized');

  const c = tools.closeTab(depsA, { sessionId: 'sess-b1' });
  assert.equal(c.error, 'unauthorized');

  const s = tools.getTabStatus(depsA, { sessionId: 'sess-b1' });
  assert.equal(s.error, 'unauthorized');

  // Unregistered ids (even ones that look plausible) are refused too.
  const u = tools.readOutput(depsA, { sessionId: 'sess-a1-gone' });
  assert.equal(u.error, 'unauthorized');
});

test('readOutput: authorized member with no live session yields not-found (no crash)', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const r = tools.readOutput(controlDeps(g), { sessionId: 'sess-a1' });
  assert.equal(r.error, 'not-found');
});

test('readOutput: rejects the session from a destroyed group', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  groupManager.destroyGroup(g);
  const r = tools.readOutput(controlDeps(g), { sessionId: 'sess-a1' });
  assert.equal(r.error, 'unauthorized');
});

test('handoff: worker pushes and orchestrator receives the structured event', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');

  const wd = handoffDeps(g, 'workerA', 'sess-a1');
  const res = tools.handoffToOrchestrator(wd, { summary: 'commit done', status: 'done' });
  assert.equal(res.ok, true);

  const ev = await tools.waitForHandoff(controlDeps(g), { timeoutMs: 500 });
  assert.equal(ev.error, undefined);
  assert.equal(ev.fromSessionId, 'sess-a1');
  assert.equal(ev.fromRole, 'workerA');
  assert.equal(ev.summary, 'commit done');
  assert.equal(ev.status, 'done');
  assert.equal(typeof ev.at, 'number');
});

test('handoff: FIFO order across two workers', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  groupManager.registerMember(g, 'workerB', 'sess-b1');

  tools.handoffToOrchestrator(handoffDeps(g, 'workerA', 'sess-a1'), { summary: 'first', status: 'done' });
  tools.handoffToOrchestrator(handoffDeps(g, 'workerB', 'sess-b1'), { summary: 'second', status: 'blocked' });

  const e1 = await tools.waitForHandoff(controlDeps(g), { timeoutMs: 500 });
  const e2 = await tools.waitForHandoff(controlDeps(g), { timeoutMs: 500 });
  assert.equal(e1.summary, 'first');
  assert.equal(e1.fromRole, 'workerA');
  assert.equal(e2.summary, 'second');
  assert.equal(e2.fromRole, 'workerB');
  assert.equal(e2.status, 'blocked');
});

test('handoff: invalid status is rejected before reaching the queue', async () => {
  const g = await makeGroupAsync();
  const res = tools.handoffToOrchestrator(handoffDeps(g, 'workerA', 'sess-a1'), { summary: 'x', status: 'sideways' });
  assert.equal(res.error, 'bad-request');
});

// The unit-level half of the "identity is closure-bound" invariant: even a
// caller that passes identity-looking fields in the tool arguments gets the
// closure's values (mcpTools only reads summary/status/nextRole).
test('handoff: identity fields in the arguments are ignored (closure wins)', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');

  const res = tools.handoffToOrchestrator(handoffDeps(g, 'workerA', 'sess-a1'), {
    summary: 'tampered',
    status: 'done',
    sessionId: 'evil-session',
    groupId: 'evil-group',
    role: 'orchestrator',
  });
  assert.equal(res.ok, true);

  const ev = await tools.waitForHandoff(controlDeps(g), { timeoutMs: 500 });
  assert.equal(ev.fromSessionId, 'sess-a1', 'identity must come from the deps closure, not the arguments');
  assert.equal(ev.fromRole, 'workerA');
  assert.equal(ev.groupId, undefined);
});

// Every control tool must be callable without any identity input -- the
// schemas forbid it at the wire layer (mcpBroker.test.js walks the schemas);
// this is the implementation half: no tool may even READ a wire-supplied
// identity, which the deps-shape (groupId only in deps) enforces at compile
// time. Sanity-check the read path against a session id that is NOT a member.
test('sendInput: authorized member whose session is gone yields not-found (no crash)', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const r = await tools.sendInput(controlDeps(g), { sessionId: 'sess-a1', text: 'ls' });
  assert.equal(r.error, 'not-found');
});

test('sendInput moves the current turn to the targeted member', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  groupManager.registerMember(g, 'orchestrator', 'sess-o');

  // A working writeToSession (the default controlDeps always returns false).
  const deps = {
    groupId: g,
    groupManager: groupManager.getGroupManagerApi(),
    sessionManager: { getSession: () => ({}), writeToSession: () => true, waitUntilSettled: async () => ({ settled: true }) },
  };

  const r = await tools.sendInput(deps, { sessionId: 'sess-a1', text: 'go' });
  assert.deepEqual(r, { ok: true, settled: true });
  assert.equal(groupManager.getGroup(g).currentTurn, 'workerA');
});

// Issue #15: open_tab returns as soon as the pty is up, but the TUI is still
// initializing -- keystrokes written into it are dropped. sendInput must hold
// the write until the settle gate (first idle gap) opens.
test('sendInput: holds the write until the settle gate opens (fresh session)', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');

  let writeCalls = 0;
  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  const deps = {
    groupId: g,
    groupManager: groupManager.getGroupManagerApi(),
    sessionManager: {
      waitUntilSettled: async () => {
        await gate;
        return { settled: true };
      },
      writeToSession: () => { writeCalls++; return true; },
    },
  };

  const pending = tools.sendInput(deps, { sessionId: 'sess-a1', text: 'go', submit: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(writeCalls, 0, 'must not write before the TUI has settled');
  releaseGate();
  const r = await pending;
  assert.deepEqual(r, { ok: true, settled: true });
  assert.equal(writeCalls, 1);
});

test('sendInput: still writes when the settle gate times out, reporting settled:false', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');

  let writeCalls = 0;
  const deps = {
    groupId: g,
    groupManager: groupManager.getGroupManagerApi(),
    sessionManager: {
      waitUntilSettled: async () => ({ settled: false, timedOut: true }),
      writeToSession: () => { writeCalls++; return true; },
    },
  };

  const r = await tools.sendInput(deps, { sessionId: 'sess-a1', text: 'go' });
  assert.equal(writeCalls, 1, 'the write is best-effort: it happens even on a settle timeout');
  assert.deepEqual(r, { ok: true, settled: false });
});

test('sendInput: an already-settled session writes without waiting (no latency regression)', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');

  let gateWaited = false;
  const deps = {
    groupId: g,
    groupManager: groupManager.getGroupManagerApi(),
    sessionManager: {
      waitUntilSettled: async () => { gateWaited = true; return { settled: true }; },
      writeToSession: () => true,
    },
  };

  const r = await tools.sendInput(deps, { sessionId: 'sess-a1', text: 'go' });
  assert.deepEqual(r, { ok: true, settled: true });
  // The settle gate must still be consulted (the wait itself is what the
  // real sessionManager short-circuits for already-settled sessions) -- the
  // no-wait property is covered against the real sessionManager below.
  assert.equal(gateWaited, true);
});

// Full wiring test: the real sessionManager's idle timer (3s of quiet output)
// opens the settle gate, and sendInput holds the write until then. A real
// bash session stands in for a freshly-launched agent TUI (shell flag flipped
// after spawn to activate the agent-only idle path).
test('sendInput (real session): holds the write until the idle gap opens the settle gate', async () => {
  const sm = await import('./sessionManager.js');
  const res = sm.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const s = res.session;
  assert.ok(s, 'shell session should spawn');
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', res.sessionId);
  try {
    s.shell = false;
    s.settled = false;
    s.settleWaiters = [];
    const writes = [];
    const deps = {
      groupId: g,
      groupManager: groupManager.getGroupManagerApi(),
      sessionManager: {
        getSession: (id) => sm.getSession(id),
        writeToSession: (id, text, opts) => { writes.push(text); return sm.writeToSession(id, text, opts); },
        waitUntilSettled: (id, opts) => sm.waitUntilSettled(id, opts),
      },
    };

    // TUI startup burst: bash echoes a line, then goes quiet.
    s.ptyProcess.write('echo TUI_BOOT_MARKER\r');
    const pending = tools.sendInput(deps, { sessionId: res.sessionId, text: 'go', submit: false });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(writes.length, 0, 'must not write while the TUI is still initializing');
    const r = await pending;
    assert.deepEqual(r, { ok: true, settled: true });
    assert.deepEqual(writes, ['go']);
    assert.equal(s.settled, true, 'the session must have settled via its idle timer');
  } finally {
    sm.destroySession(res.sessionId, { keepSchedule: false });
  }
});

// Issue #16: get_tab_status must expose the session's activity timestamp so
// the orchestrator can tell "slow but working" from "stuck". idleForMs is the
// elapsed time since the last output at call time.
test('getTabStatus: reports lastOutputAt and the derived idleForMs', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const lastOutputAt = Date.now() - 5000;
  const fakeSession = { cwd: '/srv/proj', app: 'claude', exited: false, socket: {}, lastOutputAt, autoYes: true };
  const deps = {
    groupId: g,
    groupManager: groupManager.getGroupManagerApi(),
    sessionManager: { getSession: (id) => (id === 'sess-a1' ? fakeSession : null), writeToSession: () => false, dockerAvailability: () => ({ dockerAvailable: null, dockerReason: null }) },
  };
  const r = tools.getTabStatus(deps, { sessionId: 'sess-a1' });
  assert.equal(r.error, undefined);
  assert.equal(r.lastOutputAt, lastOutputAt);
  assert.equal(r.autoYes, true, 'autoYes reflects the live session state');
  assert.ok(r.idleForMs >= 5000 && r.idleForMs <= 6000, `idleForMs must be the time since the last output (got ${r.idleForMs})`);
});

test('getTabStatus: no output yet (lastOutputAt null) yields idleForMs null', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const fakeSession = { cwd: '/srv/proj', app: 'claude', exited: false, lastOutputAt: null, autoYes: false };
  const deps = {
    groupId: g,
    groupManager: groupManager.getGroupManagerApi(),
    sessionManager: { getSession: (id) => (id === 'sess-a1' ? fakeSession : null), writeToSession: () => false, dockerAvailability: () => ({ dockerAvailable: null, dockerReason: null }) },
  };
  const r = tools.getTabStatus(deps, { sessionId: 'sess-a1' });
  assert.equal(r.lastOutputAt, null);
  assert.equal(r.idleForMs, null);
  assert.equal(r.autoYes, false);
});

// End-to-end contract check (see tmp/docker-availability-visibility-plan.md):
// unlike the tests above, this exercises the REAL production
// sessionManager.dockerAvailability through a REAL (unsandboxed, so no
// bwrap/docker needed) session, not a hand-written stub -- proving
// get_tab_status/list_group_sessions actually spread its result into their
// output rather than just asserting against a stub that happens to match.
test('getTabStatus / listGroupSessions: dockerAvailable/dockerReason come from the real dockerAvailability, not a stub', async () => {
  const g = await makeGroupAsync();
  const sm = await import('./sessionManager.js');
  const res = sm.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  assert.ok(res.session, 'shell session should spawn');
  try {
    groupManager.registerMember(g, 'workerA', res.sessionId);
    const deps = {
      groupId: g,
      groupManager: groupManager.getGroupManagerApi(),
      sessionManager: { getSession: sm.getSession, writeToSession: sm.writeToSession, dockerAvailability: sm.dockerAvailability },
    };
    const status = tools.getTabStatus(deps, { sessionId: res.sessionId });
    assert.deepEqual(
      { dockerAvailable: status.dockerAvailable, dockerReason: status.dockerReason },
      { dockerAvailable: null, dockerReason: 'not-sandboxed' },
    );

    const { members } = tools.listGroupSessions(deps);
    const workerA = members.find((m) => m.role === 'workerA');
    assert.deepEqual(
      { dockerAvailable: workerA.dockerAvailable, dockerReason: workerA.dockerReason },
      { dockerAvailable: null, dockerReason: 'not-sandboxed' },
    );
  } finally {
    sm.destroySession(res.sessionId, { keepSchedule: false });
  }
});

test('listGroupSessions: autoYes reflects each live session state', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  groupManager.registerMember(g, 'workerB', 'sess-b1');
  const fake = {
    getSession: (id) => (id === 'sess-a1'
      ? { app: 'claude', cwd: '/srv/proj', exited: false, autoYes: true }
      : id === 'sess-b1'
        ? { app: 'opencode', cwd: '/srv/proj', exited: false, autoYes: false }
        : null),
    createSession: () => { throw new Error('unused'); },
    destroySession: () => {},
    writeToSession: () => false,
    dockerAvailability: () => ({ dockerAvailable: null, dockerReason: null }),
  };
  groupManager.setSessionApiForTests(fake);
  try {
    const { members } = tools.listGroupSessions(controlDeps(g));
    const byRole = Object.fromEntries(members.map((m) => [m.role, m]));
    assert.equal(byRole.workerA.autoYes, true);
    assert.equal(byRole.workerB.autoYes, false);
  } finally {
    groupManager.setSessionApiForTests(null);
  }
});

test('waitForHandoff: empty queue times out with a tiny timedOut result (not an error)', async () => {
  const g = await makeGroupAsync();
  const started = Date.now();
  const ev = await tools.waitForHandoff(controlDeps(g), { timeoutMs: 60 });
  assert.equal(ev.timedOut, true);
  assert.ok(Date.now() - started >= 50);
});

test('waitForHandoff: a handoff that arrives while waiting resolves immediately', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const wait = tools.waitForHandoff(controlDeps(g), { timeoutMs: 500 });
  setTimeout(() => {
    tools.handoffToOrchestrator(handoffDeps(g, 'workerA', 'sess-a1'), { summary: 'late arrival', status: 'done' });
  }, 30);
  const ev = await wait;
  assert.equal(ev.summary, 'late arrival');
});

// Superseded by the worktree feature (plan section 3.3): cwd is no longer a
// caller-controlled input at all, so there is nothing left to validate here
// -- the server always resolves its own cwd for the role (its own git
// worktree, or the shared project cwd for a non-git project) and any wire
// value, valid or not, is simply ignored.
test('openTab: the cwd argument is accepted but never reaches session creation', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  let seenOpts = null;
  const fake = {
    getSession: () => null,
    createSession: (opts) => { seenOpts = opts; return { sessionId: 'sess-c', session: {} }; },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    const res = await tools.openTab(controlDeps(g), { role: 'workerC', app: 'claude', cwd: '/somewhere/else' });
    assert.equal(res.error, undefined, res.message || '');
    assert.notEqual(seenOpts.cwd, '/somewhere/else', 'the wire cwd argument must never reach session creation');
    assert.equal(res.cwd, seenOpts.cwd, 'the tool result reports the cwd the server actually resolved');
  } finally {
    groupManager.setSessionApiForTests(null);
  }
});

test('openTab: invalid app is refused', async () => {
  const g = await makeGroupAsync();
  const res = await tools.openTab(controlDeps(g), { role: 'workerC', app: 'shell', cwd: `/srv/project-${g}` });
  assert.equal(res.error, 'bad-request');
});

test('openTab: unknown group errors cleanly', async () => {
  const res = await tools.openTab(controlDeps('no-such-group'), { role: 'workerC', app: 'claude', cwd: '/x' });
  assert.equal(res.error, 'group-not-found');
});

// Issue: open_tab's app/model/sandboxOpts are optional at the wire layer.
// An omitted model must resolve through the role's persisted preference, then
// the app default; an explicit null model means "app default" and must
// override any persisted preference.
test('openTab: omitted model falls back to the persisted role preference', async () => {
  const g = await makeGroupAsync();
  // A fake session facade: addMember spawns via it and records the options.
  let seenOpts = null;
  const fake = {
    getSession: () => null,
    createSession: (opts) => { seenOpts = opts; return { sessionId: 'sess-m', session: {} }; },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.setMemberPrefs(g, 'workerA', { app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: true, sshAgent: false } });

    // model omitted -> persisted preference (gpt-5) is used.
    const r1 = await tools.openTab(controlDeps(g), { role: 'workerA', cwd: `/srv/project-${g}` });
    assert.equal(r1.error, undefined, r1.message || '');
    assert.equal(r1.model, 'gpt-5', 'effective model returned in the tool result');
    assert.equal(seenOpts.model, 'gpt-5');
    assert.deepEqual(seenOpts.sandboxOpts, { gpg: true, sshAgent: false }, 'persisted per-role sandbox flags survive open_tab');

    // Explicit model null -> app default (overrides the persisted preference).
    const r2 = await tools.openTab(controlDeps(g), { role: 'workerA', model: null, cwd: `/srv/project-${g}` });
    assert.equal(r2.model, null);
    assert.equal(seenOpts.model, null);

    // Explicit model string -> used directly.
    const r3 = await tools.openTab(controlDeps(g), { role: 'workerA', model: 'claude-sonnet-4', cwd: `/srv/project-${g}` });
    assert.equal(r3.model, 'claude-sonnet-4');
    assert.equal(seenOpts.model, 'claude-sonnet-4');

    // workerA is already a registered member at this point (r1 registered it).
    // Per the sandboxOpts privilege-escalation fix, a request against an
    // already-registered role is ignored entirely -- the member keeps
    // exactly the sandboxOpts it already had (see the dedicated openTab
    // cap/restart tests below), so this request does NOT take effect.
    const r4 = await tools.openTab(controlDeps(g), { role: 'workerA', sandboxOpts: { gpg: false, sshAgent: true }, cwd: `/srv/project-${g}` });
    assert.deepEqual(r4.sandboxOpts, { gpg: true, sshAgent: false }, 'restart keeps the existing grant, the request is not honored');
    assert.deepEqual(seenOpts.sandboxOpts, { gpg: true, sshAgent: false });
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(g);
  }
});

test('openTab: omitted app falls back to the persisted role preference', async () => {
  const g = await makeGroupAsync();
  let seenApp = null;
  const fake = {
    getSession: () => null,
    createSession: (opts) => { seenApp = opts.app; return { sessionId: 'sess-a', session: {} }; },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.setMemberPrefs(g, 'workerB', { app: 'opencode', model: null, sandboxOpts: null });
    const r = await tools.openTab(controlDeps(g), { role: 'workerB', cwd: `/srv/project-${g}` });
    assert.equal(r.error, undefined, r.message || '');
    assert.equal(r.app, 'opencode', 'omitted app resolves through the persisted preference');
    assert.equal(seenApp, 'opencode');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(g);
  }
});

// The orchestrator must never be able to spawn/replace "itself".
test('openTab: role orchestrator is refused (self-destruction guard)', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'orchestrator', 'sess-o');
  groupManager.registerMember(g, 'workerA', 'sess-a1');

  const res = await tools.openTab(controlDeps(g), { role: 'orchestrator', app: 'claude', cwd: `/srv/project-${g}` });
  assert.equal(res.error, 'invalid-role');
  // The existing orchestrator member is untouched (same sessionId still bound).
  assert.equal(groupManager.isSessionInGroup(g, 'sess-o'), true);
  const { members } = tools.listGroupSessions(controlDeps(g));
  const orch = members.find((m) => m.role === 'orchestrator');
  assert.equal(orch.sessionId, 'sess-o');
});

test('openTab: non-worker role formats are refused', async () => {
  const g = await makeGroupAsync();
  for (const bad of ['boss', 'Orchestrator', 'worker', 'orchestrator', ''] ) {
    const res = await tools.openTab(controlDeps(g), { role: bad, app: 'claude', cwd: `/srv/project-${g}` });
    assert.equal(res.error, 'invalid-role', `role ${JSON.stringify(bad)} should be refused`);
  }
});

// --- open_tab sandboxOpts privilege-escalation guard: a genuinely new
// member's requested gpg/sshAgent can never exceed the orchestrator's own
// current grant, and a restart of an already-registered role keeps exactly
// what it already had (the request is not even read). See mcpTools.js's
// openTab/capSandboxOpts and groupManager.js's getOrchestratorSandboxOpts /
// getRegisteredMemberSandboxOpts.

test('openTab: sandboxOpts cannot exceed what the orchestrator itself currently holds (privilege escalation guard)', async () => {
  const g = await makeGroupAsync();
  let seenOpts = null;
  const fake = {
    getSession: (id) => (id === 'orch-sess' ? { sandboxOpts: { gpg: false, sshAgent: false } } : null),
    createSession: (opts) => { seenOpts = opts; return { sessionId: 'sess-c', session: {} }; },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.registerMember(g, 'orchestrator', 'orch-sess');
    const res = await tools.openTab(controlDeps(g), {
      role: 'workerC', cwd: `/srv/project-${g}`, sandboxOpts: { gpg: true, sshAgent: true },
    });
    assert.equal(res.error, undefined, res.message || '');
    assert.deepEqual(res.sandboxOpts, { gpg: false, sshAgent: false }, 'downgraded to the orchestrator\'s own grant, not an error');
    assert.deepEqual(seenOpts.sandboxOpts, { gpg: false, sshAgent: false }, 'the spawned session never actually gets the escalated flags');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(g);
  }
});

test('openTab: gpg/sshAgent are capped independently', async () => {
  const g = await makeGroupAsync();
  let seenOpts = null;
  const fake = {
    getSession: (id) => (id === 'orch-sess' ? { sandboxOpts: { gpg: true, sshAgent: false } } : null),
    createSession: (opts) => { seenOpts = opts; return { sessionId: 'sess-c', session: {} }; },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.registerMember(g, 'orchestrator', 'orch-sess');
    const res = await tools.openTab(controlDeps(g), {
      role: 'workerC', cwd: `/srv/project-${g}`, sandboxOpts: { gpg: true, sshAgent: true },
    });
    assert.deepEqual(res.sandboxOpts, { gpg: true, sshAgent: false }, 'gpg passes through, sshAgent alone is capped');
    assert.deepEqual(seenOpts.sandboxOpts, { gpg: true, sshAgent: false });
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(g);
  }
});

test('openTab: a request within the orchestrator\'s own grant passes through unchanged', async () => {
  const g = await makeGroupAsync();
  let seenOpts = null;
  const fake = {
    getSession: (id) => (id === 'orch-sess' ? { sandboxOpts: { gpg: true, sshAgent: true } } : null),
    createSession: (opts) => { seenOpts = opts; return { sessionId: 'sess-c', session: {} }; },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.registerMember(g, 'orchestrator', 'orch-sess');
    const res = await tools.openTab(controlDeps(g), {
      role: 'workerC', cwd: `/srv/project-${g}`, sandboxOpts: { gpg: true, sshAgent: true },
    });
    assert.deepEqual(res.sandboxOpts, { gpg: true, sshAgent: true }, 'legitimate equal-privilege delegation is not blocked');
    assert.deepEqual(seenOpts.sandboxOpts, { gpg: true, sshAgent: true });
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(g);
  }
});

test('openTab: omitted sandboxOpts is unaffected by the cap', async () => {
  const g = await makeGroupAsync();
  let seenOpts = null;
  const fake = {
    // The orchestrator holds nothing -- if the cap wrongly applied to the
    // omitted-request fallback path, this would force sandboxOpts to
    // {gpg:false, sshAgent:false} instead of leaving the existing fallback
    // (pref.sandboxOpts || group.sandboxOpts, both null here) alone.
    getSession: (id) => (id === 'orch-sess' ? { sandboxOpts: { gpg: false, sshAgent: false } } : null),
    createSession: (opts) => { seenOpts = opts; return { sessionId: 'sess-c', session: {} }; },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.registerMember(g, 'orchestrator', 'orch-sess');
    const res = await tools.openTab(controlDeps(g), { role: 'workerC', cwd: `/srv/project-${g}` });
    assert.equal(res.sandboxOpts, null);
    assert.equal(seenOpts.sandboxOpts, null);
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(g);
  }
});

test('openTab: restarting a registered member keeps its existing sandboxOpts even when the orchestrator has less', async () => {
  const g = await makeGroupAsync();
  let seenOpts = null;
  const fake = {
    getSession: (id) => {
      if (id === 'orch-sess') return { sandboxOpts: { gpg: false, sshAgent: false } };
      return null; // workerA's own session is "dead" -- resolution falls through to memberPrefs
    },
    createSession: (opts) => { seenOpts = opts; return { sessionId: 'sess-a2', session: {} }; },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.registerMember(g, 'orchestrator', 'orch-sess');
    groupManager.registerMember(g, 'workerA', 'dead-a');
    groupManager.setMemberPrefs(g, 'workerA', { sandboxOpts: { gpg: true, sshAgent: true } });

    const res = await tools.openTab(controlDeps(g), {
      role: 'workerA', cwd: `/srv/project-${g}`, sandboxOpts: { gpg: true, sshAgent: true },
    });
    assert.deepEqual(res.sandboxOpts, { gpg: true, sshAgent: true }, 'restart is not downgraded by the orchestrator\'s lower grant');
    assert.deepEqual(seenOpts.sandboxOpts, { gpg: true, sshAgent: true });
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(g);
  }
});

test('openTab: restarting a registered member ignores a request to escalate beyond its own existing grant', async () => {
  const g = await makeGroupAsync();
  let seenOpts = null;
  const fake = {
    getSession: (id) => {
      if (id === 'orch-sess') return { sandboxOpts: { gpg: true, sshAgent: true } };
      return null;
    },
    createSession: (opts) => { seenOpts = opts; return { sessionId: 'sess-a2', session: {} }; },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.registerMember(g, 'orchestrator', 'orch-sess');
    groupManager.registerMember(g, 'workerA', 'dead-a');
    groupManager.setMemberPrefs(g, 'workerA', { sandboxOpts: { gpg: false, sshAgent: false } });

    // workerA never had gpg/sshAgent; asking for it on "restart" must not
    // grant it, even though the orchestrator itself currently holds both
    // (a restart-disguised escalation attempt).
    const res = await tools.openTab(controlDeps(g), {
      role: 'workerA', cwd: `/srv/project-${g}`, sandboxOpts: { gpg: true, sshAgent: true },
    });
    assert.deepEqual(res.sandboxOpts, { gpg: false, sshAgent: false });
    assert.deepEqual(seenOpts.sandboxOpts, { gpg: false, sshAgent: false });
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(g);
  }
});

test('openTab: a genuinely new member (never registered) is still capped even if a same-named role existed and was closed earlier', async () => {
  const g = await makeGroupAsync();
  let seenOpts = null;
  const fake = {
    getSession: (id) => {
      if (id === 'orch-sess') return { sandboxOpts: { gpg: false, sshAgent: false } };
      return null;
    },
    createSession: (opts) => { seenOpts = opts; return { sessionId: 'sess-a2', session: {} }; },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.registerMember(g, 'orchestrator', 'orch-sess');
    groupManager.registerMember(g, 'workerA', 'dead-a');
    groupManager.setMemberPrefs(g, 'workerA', { sandboxOpts: { gpg: true, sshAgent: true } });
    // closeTab's backend: removeMember deletes the role from group.members.
    groupManager.removeMember(g, 'dead-a');

    const res = await tools.openTab(controlDeps(g), {
      role: 'workerA', cwd: `/srv/project-${g}`, sandboxOpts: { gpg: true, sshAgent: true },
    });
    assert.deepEqual(res.sandboxOpts, { gpg: false, sshAgent: false }, 'closed-then-reopened role is a new member, capped by the orchestrator again');
    assert.deepEqual(seenOpts.sandboxOpts, { gpg: false, sshAgent: false });
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(g);
  }
});

// --- capSandboxOpts (direct unit tests) -------------------------------------
// No direct coverage existed before PR#114's review (gpg/sshAgent capping was
// only exercised indirectly through openTab above); tools support was added
// without any unit test at all, which is exactly how it went missing from
// mcpTools.js's own capSandboxOpts in the first place.

test('capSandboxOpts: a falsy requested value passes through unchanged', () => {
  assert.equal(tools.capSandboxOpts(null, { gpg: true }), null);
  assert.equal(tools.capSandboxOpts(undefined, { gpg: true }), undefined);
});

test('capSandboxOpts: gpg/sshAgent are capped independently against the holder\'s own grant', () => {
  const res = tools.capSandboxOpts({ gpg: true, sshAgent: true }, { gpg: true, sshAgent: false });
  assert.deepEqual(res, { gpg: true, sshAgent: false });
});

test('capSandboxOpts: missing cap denies everything by default', () => {
  const res = tools.capSandboxOpts({ gpg: true, sshAgent: true }, null);
  assert.deepEqual(res, { gpg: false, sshAgent: false });
});

test('capSandboxOpts: requested.tools is omitted from the output entirely when not requested', () => {
  const res = tools.capSandboxOpts({ gpg: true, sshAgent: true }, { gpg: true, sshAgent: true, tools: { rtk: true, codeReviewGraph: true } });
  assert.deepEqual(res, { gpg: true, sshAgent: true });
  assert.equal('tools' in res, false, 'no tools key must appear when the caller never asked for tools');
});

test('capSandboxOpts: tools cannot exceed what the cap holder itself currently holds (regression: PR#114 review, tools was silently dropped)', () => {
  const res = tools.capSandboxOpts(
    { gpg: true, sshAgent: true, tools: { rtk: true, codeReviewGraph: true } },
    { gpg: true, sshAgent: true, tools: { rtk: true, codeReviewGraph: false } },
  );
  assert.deepEqual(res, { gpg: true, sshAgent: true, tools: { rtk: true, codeReviewGraph: false } });
});

test('capSandboxOpts: a cap with no tools grant at all denies both tools flags', () => {
  const res = tools.capSandboxOpts(
    { gpg: true, sshAgent: true, tools: { rtk: true, codeReviewGraph: true } },
    { gpg: true, sshAgent: true },
  );
  assert.deepEqual(res, { gpg: true, sshAgent: true, tools: { rtk: false, codeReviewGraph: false } });
});

test('capSandboxOpts: requested.tools of the wrong type is treated as absent (no tools key output)', () => {
  const res = tools.capSandboxOpts({ gpg: true, tools: 'nope' }, { gpg: true, tools: { rtk: true, codeReviewGraph: true } });
  assert.deepEqual(res, { gpg: true, sshAgent: false });
});

test('openTab: tools cannot exceed what the orchestrator itself currently holds (privilege escalation guard, mirrors gpg/sshAgent)', async () => {
  const g = await makeGroupAsync();
  let seenOpts = null;
  const fake = {
    getSession: (id) => (id === 'orch-sess' ? { sandboxOpts: { gpg: true, sshAgent: true, tools: { rtk: true, codeReviewGraph: false } } } : null),
    createSession: (opts) => { seenOpts = opts; return { sessionId: 'sess-c', session: {} }; },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.registerMember(g, 'orchestrator', 'orch-sess');
    const res = await tools.openTab(controlDeps(g), {
      role: 'workerC',
      cwd: `/srv/project-${g}`,
      sandboxOpts: { gpg: true, sshAgent: true, tools: { rtk: true, codeReviewGraph: true } },
    });
    assert.equal(res.error, undefined, res.message || '');
    assert.deepEqual(res.sandboxOpts, { gpg: true, sshAgent: true, tools: { rtk: true, codeReviewGraph: false } });
    assert.deepEqual(seenOpts.sandboxOpts, { gpg: true, sshAgent: true, tools: { rtk: true, codeReviewGraph: false } }, 'the spawned session never actually gets the escalated codeReviewGraph tool');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(g);
  }
});

test('readOutput: authorized live member returns raw + stripped text (tail 0 clamps to 1 chunk, not 4000)', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const fakeSession = {
    cwd: '/srv/project-x',
    app: 'claude',
    exited: false,
    outputBuffer: ['\x1b[31mred\x1b[0m text ', 'more\n'],
  };
  const deps = {
    groupId: g,
    groupManager: groupManager.getGroupManagerApi(),
    sessionManager: { getSession: (id) => (id === 'sess-a1' ? fakeSession : null), writeToSession: () => false },
  };
  // tail: 0 must NOT silently fall back to the 4000 default -- it clamps to
  // the 1-chunk minimum instead.
  const out = tools.readOutput(deps, { sessionId: 'sess-a1', tail: 0 });
  assert.equal(out.error, undefined);
  assert.equal(out.text, 'more\n');
  assert.equal(out.raw, 'more\n');
  // A larger tail includes everything.
  const full = tools.readOutput(deps, { sessionId: 'sess-a1', tail: 100 });
  assert.equal(full.text, 'red text more\n');
});

// Cost control: read_output exists to keep the orchestrator's context small,
// so a default call must not return the whole ~512KB buffer.
test('readOutput: default tail stays small and output is hard-capped with truncated:true', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  // 800 chunks x 200 chars = 160KB of output -- far past the 16KB cap.
  const fakeSession = {
    cwd: '/srv/project-x',
    app: 'claude',
    exited: false,
    outputBuffer: Array.from({ length: 800 }, (_, i) => `chunk ${i} ` + 'x'.repeat(190)),
  };
  const deps = {
    groupId: g,
    groupManager: groupManager.getGroupManagerApi(),
    sessionManager: { getSession: (id) => (id === 'sess-a1' ? fakeSession : null), writeToSession: () => false },
  };
  const out = tools.readOutput(deps, { sessionId: 'sess-a1' });
  assert.equal(out.error, undefined);
  assert.ok(out.raw.length <= 16 * 1024, `raw must be capped (got ${out.raw.length})`);
  assert.ok(out.text.length <= 16 * 1024, `text must be capped (got ${out.text.length})`);
  assert.equal(out.truncated, true);
  // The tail of the output survives the cap.
  assert.ok(out.raw.endsWith('x'.repeat(190)), 'the newest chunk must be included');

  // An explicit huge tail is still capped by the char limit, not by chunks.
  const huge = tools.readOutput(deps, { sessionId: 'sess-a1', tail: 100000 });
  assert.ok(huge.raw.length <= 16 * 1024);
  assert.equal(huge.truncated, true);

  // Small output: no truncation flag, everything returned.
  const small = tools.readOutput(deps, { sessionId: 'sess-a1', tail: 1 });
  assert.equal(small.truncated, false);
  assert.ok(small.raw.endsWith('x'.repeat(190)));
});

// --- screen view (Issue: read_output must show the CURRENT screen, not the
// byte stream -- spinners redraw in place and cannot be read from raw bytes)
// ---------------------------------------------------------------------------

// A fake session carrying a real screen model, the way sessionManager would
// have one.
function makeScreenSession(screen, screenLastChangeAt = Date.now() - 100) {
  return {
    cwd: '/srv/project-x',
    app: 'claude',
    exited: false,
    outputBuffer: ['\x1b[2K\r⠋ analyzing\r'],
    screen,
    screenLastChangeAt,
  };
}

test('readOutput: screen shows the current view (spinner frames collapse to the latest line)', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  // A spinner redrawing one line in place: every frame is a CR + line erase
  // + new frame char. Only the last frame must be on the screen.
  const screen = screenModel.createScreenModel();
  screen.feed('\r\x1b[2K⠋ analyzing…\r\x1b[2K⠙ analyzing…\r\x1b[2K⠹ analyzing…');
  const deps = {
    groupId: g,
    groupManager: groupManager.getGroupManagerApi(),
    sessionManager: { getSession: (id) => (id === 'sess-a1' ? makeScreenSession(screen, Date.now() - 5000) : null), writeToSession: () => false },
  };
  const out = tools.readOutput(deps, { sessionId: 'sess-a1' });
  assert.equal(out.error, undefined);
  assert.equal(out.screen, '⠹ analyzing…', 'the screen view holds only the latest frame');
  assert.equal(out.screenAlt, false);
  assert.ok(out.screenIdleMs >= 5000, `screenIdleMs derives from the screen change time (got ${out.screenIdleMs})`);
});

test('readOutput: screen honors the row cap with screenTruncated:true', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const screen = screenModel.createScreenModel();
  for (let i = 0; i < 100; i++) screen.feed(`line ${i}\r\n`);
  const deps = {
    groupId: g,
    groupManager: groupManager.getGroupManagerApi(),
    sessionManager: { getSession: (id) => (id === 'sess-a1' ? makeScreenSession(screen) : null), writeToSession: () => false },
  };
  const out = tools.readOutput(deps, { sessionId: 'sess-a1' });
  assert.equal(out.screenTruncated, true);
  assert.equal(out.screen.split('\n').length, 40, 'screen view capped at the newest 40 rows');
  assert.ok(out.screen.endsWith('line 99\n'), 'the newest row survives the cap');
});

test('readOutput: session without a screen model yields null screen fields (no crash)', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const deps = {
    groupId: g,
    groupManager: groupManager.getGroupManagerApi(),
    sessionManager: {
      getSession: (id) => (id === 'sess-a1'
        ? { cwd: '/srv/project-x', app: 'claude', exited: false, outputBuffer: ['plain'] }
        : null),
      writeToSession: () => false,
    },
  };
  const out = tools.readOutput(deps, { sessionId: 'sess-a1' });
  assert.equal(out.error, undefined);
  assert.equal(out.text, 'plain');
  assert.equal(out.screen, null);
  assert.equal(out.screenIdleMs, null);
});

test('getTabStatus: reports screenIdleMs from the screen model', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const screenLastChangeAt = Date.now() - 9000;
  const fakeSession = {
    cwd: '/srv/proj',
    app: 'claude',
    exited: false,
    socket: {},
    lastOutputAt: Date.now() - 500,
    autoYes: true,
    screen: screenModel.createScreenModel(),
    screenLastChangeAt,
  };
  const deps = {
    groupId: g,
    groupManager: groupManager.getGroupManagerApi(),
    sessionManager: { getSession: (id) => (id === 'sess-a1' ? fakeSession : null), writeToSession: () => false, dockerAvailability: () => ({ dockerAvailable: null, dockerReason: null }) },
  };
  const r = tools.getTabStatus(deps, { sessionId: 'sess-a1' });
  assert.equal(r.error, undefined);
  assert.ok(r.screenIdleMs >= 9000 && r.screenIdleMs <= 10000, `screenIdleMs must be the time since the screen changed (got ${r.screenIdleMs})`);
  // idleForMs stays byte-based (backward compatible): here bytes kept
  // flowing recently while the screen is old -- the two signals diverge on
  // purpose (a spinner writes bytes without changing the screen).
  assert.ok(r.idleForMs <= r.screenIdleMs, 'a static screen with flowing bytes: idleForMs < screenIdleMs');
});

test('readOutput: the 16KB text cap never splits an escape sequence (no control-byte leak)', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  // Layout the stream so the 16KB-from-the-end cut lands INSIDE an escape
  // sequence: 9999 plain chars, then a SGR sequence starting at index 9999
  // (the cut position is raw.length - 16384 = 10000, inside the sequence),
  // then a visible word and filler. A naive `.slice(-16K)` would start the
  // text mid-sequence ("[31mcolored...") and stripAnsi would leave the
  // residue -- control bytes leak into `text`.
  const raw = 'a'.repeat(9999) + '\x1b[31m' + 'colored' + 'b'.repeat(16373);
  const fakeSession = {
    cwd: '/srv/project-x',
    app: 'claude',
    exited: false,
    outputBuffer: [raw],
  };
  const deps = {
    groupId: g,
    groupManager: groupManager.getGroupManagerApi(),
    sessionManager: { getSession: (id) => (id === 'sess-a1' ? fakeSession : null), writeToSession: () => false },
  };
  const out = tools.readOutput(deps, { sessionId: 'sess-a1' });
  assert.equal(out.truncated, true);
  assert.ok(out.text.length <= 16 * 1024, `text must stay capped (got ${out.text.length})`);
  assert.ok(!out.text.includes('\x1b'), 'no bare ESC may leak through the cap');
  assert.ok(out.text.startsWith('colored'), 'the cut lands after the split sequence: clean text follows');
});

test('readOutput: a dangling escape at the end of the stream never leaks into text', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  // The buffer tail itself ends mid-sequence (a pty chunk boundary split the
  // sequence): with the cap biting, the returned tail would end with a bare
  // "\x1b[31" that stripAnsi cannot remove -- the text view must not contain
  // it. Also cover the no-cap case (short stream, dangling escape at the end).
  const raw = 'a'.repeat(16381) + '\x1b[31';
  const fakeSession = {
    cwd: '/srv/project-x',
    app: 'claude',
    exited: false,
    outputBuffer: [raw],
  };
  const deps = {
    groupId: g,
    groupManager: groupManager.getGroupManagerApi(),
    sessionManager: { getSession: (id) => (id === 'sess-a1' ? fakeSession : null), writeToSession: () => false },
  };
  const out = tools.readOutput(deps, { sessionId: 'sess-a1' });
  assert.equal(out.truncated, true);
  assert.ok(out.text.length <= 16 * 1024, `text must stay capped (got ${out.text.length})`);
  assert.ok(!out.text.includes('\x1b'), 'the dangling escape must be trimmed, not leaked');
  assert.ok(out.text.endsWith('a'.repeat(100)), 'the visible tail survives');

  const short = tools.readOutput({
    ...deps,
    sessionManager: { getSession: (id) => (id === 'sess-a1' ? { ...fakeSession, outputBuffer: ['plain\x1b[3'] } : null), writeToSession: () => false },
  }, { sessionId: 'sess-a1' });
  assert.equal(short.text, 'plain', 'a dangling escape at the end of a short stream is trimmed too');
});

test('handoff queue is capped: overflow drops the oldest entries', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  for (let i = 0; i < 120; i++) {
    tools.handoffToOrchestrator(handoffDeps(g, 'workerA', 'sess-a1'), { summary: `s${i}`, status: 'done' });
  }
  const ev = await tools.waitForHandoff(controlDeps(g), { timeoutMs: 200 });
  assert.equal(ev.summary, 's20'); // the 20 oldest were dropped (cap 100)
});

// The scheduled-prompt auto-resume path creates a session carrying the
// original groupId/groupRole; the session-create listener must re-bind the
// role to the new sessionId (a real shell session stands in for an agent --
// no sandbox or agent CLI needed).
test('session created with groupId/groupRole is auto-registered to its role', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'dead-old-session');

  const sm = await import('./sessionManager.js');
  const res = sm.createSession({
    cwd: '/tmp', cols: 80, rows: 24,
    shell: true, sandbox: false,
    groupId: g, groupRole: 'workerA',
  });
  assert.ok(res.session, 'shell session should spawn');
  try {
    assert.equal(groupManager.isSessionInGroup(g, res.sessionId), true);
    assert.equal(groupManager.isSessionInGroup(g, 'dead-old-session'), false);
    const { members } = tools.listGroupSessions(controlDeps(g));
    assert.equal(members.find((m) => m.role === 'workerA').sessionId, res.sessionId);
  } finally {
    sm.destroySession(res.sessionId, { keepSchedule: false });
  }
});

test('closeTab: destroying a member removes it from the group', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  groupManager.registerMember(g, 'orchestrator', 'sess-o');
  const res = tools.closeTab(controlDeps(g), { sessionId: 'sess-a1' });
  assert.equal(res.ok, true);
  assert.equal(groupManager.isSessionInGroup(g, 'sess-a1'), false);
  assert.equal(groupManager.isSessionInGroup(g, 'sess-o'), true);
});

// --- new_session (fresh PTY replacement of a worker) -------------------------
// Regression contract (real-machine Codex incident): `/new\n\n<body>` sent as
// ONE send_input executes the slash command immediately and the body is
// swallowed (Codex consumed it as its session title and never answered).
// new_session therefore returns the fresh sessionId FIRST and accepts no
// instruction text -- the task body travels only through a LATER, separate
// send_input call.

test('newSession: replaces a worker via addMember({}) and reports the fresh launch (instruction text never accepted)', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-old');
  let seenOpts = null;
  const destroyed = [];
  const fake = {
    getSession: () => null,
    createSession: (opts) => { seenOpts = opts; return { sessionId: 'sess-new', session: {} }; },
    destroySession: (id) => destroyed.push(id),
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.setMemberPrefs(g, 'workerA', { app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: false, sshAgent: true } });

    const r = await tools.newSession(controlDeps(g), { sessionId: 'sess-old' });
    assert.equal(r.error, undefined, r.message || '');
    assert.equal(r.ok, true);
    assert.equal(r.previousSessionId, 'sess-old');
    assert.equal(r.sessionId, 'sess-new');
    assert.equal(r.role, 'workerA');
    assert.equal(r.app, 'opencode', 'the role\'s persisted app preference is reused');
    assert.equal(r.model, 'gpt-5', 'the role\'s persisted model preference is reused');
    assert.equal(r.cwd, seenOpts.cwd, 'the reported cwd is the one actually launched');
    assert.deepEqual(r.sandboxOpts, { gpg: false, sshAgent: true });

    // Fresh CLI launch: NO resume option may reach createSession.
    assert.ok(!('resumeLast' in seenOpts), 'resumeLast must not be passed (fresh conversation)');
    assert.ok(!('claudeSessionId' in seenOpts), 'no resume id may be passed');
    assert.equal(seenOpts.groupRole, 'workerA');

    // The old session is retired only after the replacement exists.
    assert.deepEqual(destroyed, ['sess-old']);
    assert.equal(groupManager.isSessionInGroup(g, 'sess-old'), false);
    assert.equal(groupManager.isSessionInGroup(g, 'sess-new'), true);
    // Mirrors sendInput: the turn moves to the (fresh) worker.
    assert.equal(groupManager.getGroup(g).currentTurn, 'workerA');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(g);
  }
});

test('newSession: other-group and unregistered session ids are refused without touching addMember', async () => {
  const a = await makeGroupAsync();
  const b = await makeGroupAsync();
  groupManager.registerMember(a, 'workerA', 'sess-a1');
  groupManager.registerMember(b, 'workerA', 'sess-b1');

  const neverSpawns = {
    getSession: () => null,
    createSession: () => { throw new Error('addMember must not be reached'); },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(neverSpawns);
  try {
    const cross = await tools.newSession(controlDeps(a), { sessionId: 'sess-b1' });
    assert.equal(cross.error, 'unauthorized');

    const unknown = await tools.newSession(controlDeps(a), { sessionId: 'sess-a1-gone' });
    assert.equal(unknown.error, 'unauthorized');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(a);
    groupManager.destroyGroup(b);
  }
});

// A prompt-injected orchestrator must not be able to replace itself.
test('newSession: the orchestrator session is refused before addMember runs', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'orchestrator', 'sess-o');
  groupManager.registerMember(g, 'workerA', 'sess-a1');

  const neverSpawns = {
    getSession: () => null,
    createSession: () => { throw new Error('addMember must not be reached'); },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(neverSpawns);
  try {
    const r = await tools.newSession(controlDeps(g), { sessionId: 'sess-o' });
    assert.equal(r.error, 'invalid-role');
    assert.equal(r.message.includes('orchestrator'), true, 'the refusal names the orchestrator guard');
    // Both members untouched.
    assert.equal(groupManager.isSessionInGroup(g, 'sess-o'), true);
    assert.equal(groupManager.isSessionInGroup(g, 'sess-a1'), true);
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(g);
  }
});

test('newSession: an addMember spawn failure propagates and leaves the old member live', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-old');
  const failing = {
    getSession: () => null,
    createSession: () => ({ error: 'pty failed', session: null }),
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(failing);
  try {
    const r = await tools.newSession(controlDeps(g), { sessionId: 'sess-old' });
    assert.equal(r.error, 'spawn-failed', 'the stable addMember error code passes through');
    assert.equal(r.message, 'pty failed');
    // Not treated as success: the old session was never retired.
    assert.equal(groupManager.isSessionInGroup(g, 'sess-old'), true);
    assert.equal(groupManager.getGroup(g).currentTurn, null);
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(g);
  }
});

// --- send_key (escape-only confirmation-modal recovery) ----------------------

test('sendKey: escape is forwarded to the pty immediately, without the settle gate', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const seen = [];
  const deps = {
    groupId: g,
    groupManager: groupManager.getGroupManagerApi(),
    sessionManager: {
      // No waitUntilSettled at all: if sendKey ever grew a gate, this would throw.
      writeKeyToSession: (id, key) => { seen.push([id, key]); return true; },
    },
  };
  const r = tools.sendKey(deps, { sessionId: 'sess-a1', key: 'escape' });
  assert.deepEqual(r, { ok: true }, 'no settled field -- the modal closes on the key itself');
  assert.deepEqual(seen, [['sess-a1', 'escape']]);
});

test('sendKey: group-bound authorization (cross-group/unregistered refused) and dead sessions yield not-found', async () => {
  const a = await makeGroupAsync();
  const b = await makeGroupAsync();
  groupManager.registerMember(a, 'workerA', 'sess-a1');
  groupManager.registerMember(b, 'workerA', 'sess-b1');

  const cross = tools.sendKey(controlDeps(a), { sessionId: 'sess-b1', key: 'escape' });
  assert.equal(cross.error, 'unauthorized');

  const unknown = tools.sendKey(controlDeps(a), { sessionId: 'sess-a1-gone', key: 'escape' });
  assert.equal(unknown.error, 'unauthorized');

  // Authorized but the pty is gone/exited -> the existing not-found shape.
  const deps = {
    groupId: a,
    groupManager: groupManager.getGroupManagerApi(),
    sessionManager: { writeKeyToSession: () => false },
  };
  const dead = tools.sendKey(deps, { sessionId: 'sess-a1', key: 'escape' });
  assert.equal(dead.error, 'not-found');
  groupManager.destroyGroup(b);
});

test('stripAnsi: removes common escape sequences', () => {
  assert.equal(tools.stripAnsi('\x1b[31mred\x1b[0m text'), 'red text');
  assert.equal(tools.stripAnsi('\x1b]0;title\x07hi'), 'hi');
  assert.equal(tools.stripAnsi('plain'), 'plain');
});

// --- publish_doc / fetch_doc / list_docs (worker<->worker handoff, plan
// section 7) -----------------------------------------------------------------

test('publishDoc: the publisher is deps.role (handoff server), never wire input', async () => {
  const g = await makeGroupAsync();
  const res = tools.publishDoc(handoffDeps(g, 'workerA', 'sess-a1'), { key: 'plan', content: '# plan' });
  assert.equal(res.ok, true);
  assert.equal(res.publishedBy, 'workerA');
});

test('fetchDoc/listDocs: a document published by one worker is visible to another worker and to the orchestrator (control socket)', async () => {
  const g = await makeGroupAsync();
  tools.publishDoc(handoffDeps(g, 'workerA', 'sess-a1'), { key: 'plan', content: 'the plan body' });

  // Another worker's handoff socket can fetch/list it too.
  const fromWorkerB = tools.fetchDoc(handoffDeps(g, 'workerB', 'sess-b1'), { key: 'plan' });
  assert.equal(fromWorkerB.content, 'the plan body');
  assert.equal(fromWorkerB.publishedBy, 'workerA');

  // The control socket (orchestrator) has fetch_doc/list_docs too, but no
  // publish_doc -- see mcpServer.js's buildControlMcpServer.
  const fromControl = tools.fetchDoc(controlDeps(g), { key: 'plan' });
  assert.equal(fromControl.content, 'the plan body');
  const listed = tools.listDocs(controlDeps(g));
  assert.deepEqual(listed.docs.map((d) => d.key), ['plan']);
  assert.equal(listed.docs[0].content, undefined);
});

test('fetchDoc: an unpublished key is a clean not-found', async () => {
  const g = await makeGroupAsync();
  const res = tools.fetchDoc(controlDeps(g), { key: 'nope' });
  assert.equal(res.error, 'not-found');
});

test('publishDoc/fetchDoc/listDocs are scoped per group: a document in one group is invisible from another', async () => {
  const g1 = await makeGroupAsync();
  const g2 = await makeGroupAsync();
  tools.publishDoc(handoffDeps(g1, 'workerA', 'sess-a1'), { key: 'plan', content: 'group 1 plan' });
  assert.equal(tools.fetchDoc(controlDeps(g2), { key: 'plan' }).error, 'not-found');
  assert.deepEqual(tools.listDocs(controlDeps(g2)).docs, []);
});

// --- repo_info (Issue: orchestrator repo-facts tool) -----------------------

test('repoInfo returns shallow repo facts (root/readme/packageJson/git)', async () => {
  const dir = makeTmpRepo('full');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'README.md'), '# My Project\n\nRead me.');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'my-project',
    version: '1.2.3',
    description: 'A test project',
    scripts: { build: 'tsc', test: 'vitest' },
    dependencies: { zod: '^3.0.0' },
    devDependencies: { typescript: '^5.0.0' },
  }));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'initial commit']);

  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: dir, orchestratorDir: join(dir, '..', 'orch') });
  groupsToDestroy.push(gid);

  const out = await tools.repoInfo(controlDeps(gid));
  assert.equal(out.error, undefined);
  assert.equal(out.cwd, dir);
  assert.ok(out.root.dirs.includes('src'), 'src dir listed');
  assert.ok(out.root.dirs.includes('docs'), 'docs dir listed');
  assert.ok(out.root.files.includes('package.json'), 'package.json listed');
  assert.ok(out.root.files.includes('README.md'), 'README.md listed');
  assert.equal(out.root.truncated, false);
  assert.equal(out.readme.file, 'README.md');
  assert.ok(out.readme.text.includes('My Project'));
  assert.equal(out.readme.truncated, false);
  assert.equal(out.packageJson.name, 'my-project');
  assert.equal(out.packageJson.version, '1.2.3');
  assert.equal(out.packageJson.description, 'A test project');
  assert.deepEqual(out.packageJson.scripts, ['build', 'test']);
  assert.deepEqual(out.packageJson.dependencies, ['zod']);
  assert.deepEqual(out.packageJson.devDependencies, ['typescript']);
  assert.ok(out.git.branch.length > 0, 'current branch reported');
  assert.ok(out.git.head.length > 0, 'short HEAD reported');
  assert.equal(out.git.log.length, 1);
  assert.ok(out.git.log[0].endsWith('initial commit'), `log line is '<hash> initial commit' (got ${out.git.log[0]})`);
  assert.equal(out.git.changes, 0, 'clean tree');
});

test('repoInfo: missing README/package.json/git fall back to null per section', async () => {
  const dir = makeTmpRepo('bare');
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: dir, orchestratorDir: join(dir, '..', 'orch') });
  groupsToDestroy.push(gid);

  const out = await tools.repoInfo(controlDeps(gid));
  assert.equal(out.readme, null, 'no README variant -> null');
  assert.equal(out.packageJson, null, 'no package.json -> null');
  assert.equal(out.git, null, 'not a git repository -> null');
  assert.deepEqual(out.root.dirs, []);
  assert.deepEqual(out.root.files, []);
});

test('repoInfo: unknown group yields group-not-found', async () => {
  const out = await tools.repoInfo(controlDeps('no-such-group'));
  assert.equal(out.error, 'group-not-found');
});

test('repoInfo: caps bite (root 100 entries, README 8KB, package keys 50)', async () => {
  const dir = makeTmpRepo('caps');
  for (let i = 0; i < 120; i++) writeFileSync(join(dir, `file-${String(i).padStart(3, '0')}.txt`), 'x');
  writeFileSync(join(dir, 'README.md'), 'x'.repeat(9000));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'caps',
    scripts: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`s${i}`, 'echo'])),
    dependencies: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`dep${i}`, '^1.0.0'])),
  }));
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: dir, orchestratorDir: join(dir, '..', 'orch') });
  groupsToDestroy.push(gid);

  const out = await tools.repoInfo(controlDeps(gid));
  assert.equal(out.root.files.length, 100, 'root listing capped at 100');
  assert.equal(out.root.truncated, true);
  assert.equal(out.readme.text.length, 8 * 1024, 'README capped at 8KB');
  assert.equal(out.readme.truncated, true);
  assert.equal(out.packageJson.scripts.length, 50, 'scripts keys capped at 50');
  assert.equal(out.packageJson.dependencies.length, 50, 'dependencies keys capped at 50');
});

// Regression: production broker deps hand repo_info the narrow groupManager
// facade (getGroupCwd only -- the full module's getGroup is never reachable),
// which used to crash with "deps.groupManager.getGroup is not a function".
test('repoInfo works against the production facade shape (no getGroup on groupManager)', async () => {
  const dir = makeTmpRepo('facade');
  writeFileSync(join(dir, 'README.md'), '# Facade Project');
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: dir, orchestratorDir: join(dir, '..', 'orch') });
  groupsToDestroy.push(gid);

  const deps = prodFacadeDeps(gid);
  assert.equal(typeof deps.groupManager.getGroup, 'undefined', 'facade shape must not expose getGroup');
  assert.equal(typeof deps.groupManager.getGroupCwd, 'function');

  const out = await tools.repoInfo(deps);
  assert.equal(out.error, undefined);
  assert.equal(out.cwd, dir);
  assert.equal(out.readme.file, 'README.md');
  assert.ok(out.readme.text.includes('Facade Project'));
  assert.ok(out.root.files.includes('README.md'));
});

test('repoInfo: group-not-found also works against the production facade shape', async () => {
  const deps = prodFacadeDeps('no-such-group');
  assert.equal(typeof deps.groupManager.getGroup, 'undefined', 'facade shape must not expose getGroup');
  const out = await tools.repoInfo(deps);
  assert.equal(out.error, 'group-not-found');
});
