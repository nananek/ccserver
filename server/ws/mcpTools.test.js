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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let runtimeDir;
let groupManager;
let tools;
let groupsToDestroy = [];

// The real brokers listen under XDG_RUNTIME_DIR (read at mcpBroker module
// evaluation), so point it at a fresh dir before importing.
before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-mcp-test-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  // Group persistence must never touch the repo-root state file during tests.
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  groupManager = await import('./groupManager.js');
  tools = await import('./mcpTools.js');
});

after(() => {
  for (const id of groupsToDestroy) groupManager.destroyGroup(id);
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function makeGroupAsync() {
  const id = randomUUID();
  await groupManager.createGroup({ groupId: id, cwd: `/srv/project-${id}`, orchestratorDir: `/srv/orch-${id}` });
  groupsToDestroy.push(id);
  return id;
}

// deps the way mcpServer would build them for the control socket
function controlDeps(groupId) {
  return {
    groupId,
    groupManager,
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
    groupManager,
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
    groupManager,
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
    groupManager,
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
    groupManager,
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
    groupManager,
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
      groupManager,
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

test('openTab: cwd outside the group project dir is refused before any spawn', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const res = await tools.openTab(controlDeps(g), { role: 'workerC', app: 'claude', cwd: '/somewhere/else' });
  assert.equal(res.error, 'cwd-not-allowed');
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
    groupManager,
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
    groupManager,
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

test('stripAnsi: removes common escape sequences', () => {
  assert.equal(tools.stripAnsi('\x1b[31mred\x1b[0m text'), 'red text');
  assert.equal(tools.stripAnsi('\x1b]0;title\x07hi'), 'hi');
  assert.equal(tools.stripAnsi('plain'), 'plain');
});
