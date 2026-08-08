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
  groupManager = await import('./groupManager.js');
  tools = await import('./mcpTools.js');
});

after(() => {
  for (const id of groupsToDestroy) groupManager.destroyGroup(id);
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeGroup() {
  const id = randomUUID();
  groupManager.createGroup({ groupId: id, cwd: `/srv/project-${id}`, orchestratorDir: `/srv/orch-${id}` });
  groupsToDestroy.push(id);
  return id;
}

// deps the way mcpServer would build them for the control socket
function controlDeps(groupId) {
  return {
    groupId,
    groupManager,
    sessionManager: { getSession: () => null, writeToSession: () => false },
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
    sessionManager: { getSession: () => null, writeToSession: () => false },
  };
}

test('listGroupSessions reports registered members with roles', () => {
  const g = makeGroup();
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

test('isSessionInGroup: only registered members pass', () => {
  const g = makeGroup();
  groupManager.registerMember(g, 'workerA', 'sess-a');
  assert.equal(groupManager.isSessionInGroup(g, 'sess-a'), true);
  assert.equal(groupManager.isSessionInGroup(g, 'sess-other'), false);
  assert.equal(groupManager.isSessionInGroup('no-such-group', 'sess-a'), false);
});

// The critical boundary: a group's tools must refuse every session id that
// belongs to a different group (or none at all).
test('authorization: cross-group session ids are refused by every tool', () => {
  const a = makeGroup();
  const b = makeGroup();
  groupManager.registerMember(a, 'workerA', 'sess-a1');
  groupManager.registerMember(a, 'orchestrator', 'sess-a2');
  groupManager.registerMember(b, 'workerA', 'sess-b1');

  const depsA = controlDeps(a);

  const r = tools.readOutput(depsA, { sessionId: 'sess-b1' });
  assert.equal(r.error, 'unauthorized');

  const i = tools.sendInput(depsA, { sessionId: 'sess-b1', text: 'ls' });
  assert.equal(i.error, 'unauthorized');

  const c = tools.closeTab(depsA, { sessionId: 'sess-b1' });
  assert.equal(c.error, 'unauthorized');

  const s = tools.getTabStatus(depsA, { sessionId: 'sess-b1' });
  assert.equal(s.error, 'unauthorized');

  // Unregistered ids (even ones that look plausible) are refused too.
  const u = tools.readOutput(depsA, { sessionId: 'sess-a1-gone' });
  assert.equal(u.error, 'unauthorized');
});

test('readOutput: authorized member with no live session yields not-found (no crash)', () => {
  const g = makeGroup();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const r = tools.readOutput(controlDeps(g), { sessionId: 'sess-a1' });
  assert.equal(r.error, 'not-found');
});

test('readOutput: rejects the session from a destroyed group', () => {
  const g = makeGroup();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  groupManager.destroyGroup(g);
  const r = tools.readOutput(controlDeps(g), { sessionId: 'sess-a1' });
  assert.equal(r.error, 'unauthorized');
});

test('handoff: worker pushes and orchestrator receives the structured event', async () => {
  const g = makeGroup();
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
  const g = makeGroup();
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

test('handoff: invalid status is rejected before reaching the queue', () => {
  const g = makeGroup();
  const res = tools.handoffToOrchestrator(handoffDeps(g, 'workerA', 'sess-a1'), { summary: 'x', status: 'sideways' });
  assert.equal(res.error, 'bad-request');
});

test('waitForHandoff: empty queue times out with a tiny timedOut result (not an error)', async () => {
  const g = makeGroup();
  const started = Date.now();
  const ev = await tools.waitForHandoff(controlDeps(g), { timeoutMs: 60 });
  assert.equal(ev.timedOut, true);
  assert.ok(Date.now() - started >= 50);
});

test('waitForHandoff: a handoff that arrives while waiting resolves immediately', async () => {
  const g = makeGroup();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const wait = tools.waitForHandoff(controlDeps(g), { timeoutMs: 500 });
  setTimeout(() => {
    tools.handoffToOrchestrator(handoffDeps(g, 'workerA', 'sess-a1'), { summary: 'late arrival', status: 'done' });
  }, 30);
  const ev = await wait;
  assert.equal(ev.summary, 'late arrival');
});

test('openTab: cwd outside the group project dir is refused before any spawn', () => {
  const g = makeGroup();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const res = tools.openTab(controlDeps(g), { role: 'workerC', app: 'claude', cwd: '/somewhere/else' });
  assert.equal(res.error, 'cwd-not-allowed');
});

test('openTab: invalid app is refused', () => {
  const g = makeGroup();
  const res = tools.openTab(controlDeps(g), { role: 'workerC', app: 'shell', cwd: `/srv/project-${g}` });
  assert.equal(res.error, 'bad-request');
});

test('openTab: unknown group errors cleanly', () => {
  const res = tools.openTab(controlDeps('no-such-group'), { role: 'workerC', app: 'claude', cwd: '/x' });
  assert.equal(res.error, 'group-not-found');
});

test('closeTab: destroying a member removes it from the group', () => {
  const g = makeGroup();
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
