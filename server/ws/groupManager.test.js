// Tests for groupManager's persistence/restore lifecycle and the teardown
// fixes:
//   - groups survive a server restart (persistGroups writes the registry,
//     restoreGroups rebuilds it with the orchestrator dir + instructions)
//   - destroyGroup settles pending takeHandoff waiters instead of leaving
//     them attached to the (now removed) emitter
//   - addMember refuses to grow a full group (member cap) before any spawn
//   - destroyGroup leaves the orchestratorDir in place (it is a per-project
//     resource reused across group launches for the same project)
//   - restoreGroups no longer writes CLAUDE.md/AGENTS.md (generation moved to
//     generateOrchestratorClaudeMdSrc, called right before every spawn)
//   - generateOrchestratorClaudeMdSrc merges the repo template with the
//     group's saved custom instructions and writes it to a host-only path,
//     picking up template edits and instruction changes on every call
//   - groupExistsForCwd (routes/groups.js) matches a real registered group,
//     i.e. POST /groups's 409 duplicate-project check sees the live listing
//
// Real control brokers listen on UDS during createGroup (same as
// mcpBroker.test.js); no agent CLIs, no bwrap, no browser needed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let runtimeDir;
let groupManager;
let groupsToDestroy = [];
// A throwaway copy of the real template, seeded from it once up front. The
// "template edit lands on the next generation" test below mutates this copy
// (never the real, repo-tracked server/ws/orchestrator-template.md): other
// test files (e.g. sessionManager.test.js) read that real file concurrently
// as their content oracle, and node --test runs files in parallel by
// default, so mutating it in place would be a cross-file race.
let templateCopyPath;

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-gm-test-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  process.env.CCSERVER_SAVED_SESSIONS_PATH = join(runtimeDir, 'saved-sessions.json');
  // generateOrchestratorClaudeMdSrc's output dir must never land under the
  // real home directory during tests -- see the env override in groupManager.js.
  process.env.CCSERVER_ORCHESTRATOR_GENERATED_ROOT = join(runtimeDir, 'orchestrator-generated');
  templateCopyPath = join(runtimeDir, 'orchestrator-template.md');
  cpSync(join(import.meta.dirname, 'orchestrator-template.md'), templateCopyPath);
  process.env.CCSERVER_ORCHESTRATOR_TEMPLATE_PATH = templateCopyPath;
  groupManager = await import('./groupManager.js');
});

after(() => {
  for (const id of groupsToDestroy) groupManager.destroyGroup(id);
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function makeGroup(cwd = '/srv/proj') {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd, orchestratorDir: join(runtimeDir, gid) });
  groupsToDestroy.push(gid);
  return gid;
}

test('persistGroups writes the member registry; destroyGroup removes the entry', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({
    groupId: gid,
    cwd: '/srv/proj',
    orchestratorDir: join(runtimeDir, gid),
    orchestratorApp: 'opencode',
  });
  groupManager.registerMember(gid, 'workerA', 'sess-a1');
  groupManager.registerMember(gid, 'orchestrator', 'sess-o');

  const saved = JSON.parse(readFileSync(process.env.CCSERVER_GROUPS_PATH, 'utf-8'));
  const entry = saved.find((g) => g.id === gid);
  assert.ok(entry, 'group persisted');
  assert.deepEqual(entry.members, { workerA: 'sess-a1', orchestrator: 'sess-o' });
  assert.equal(entry.orchestratorApp, 'opencode');

  // The orchestratorDir is a per-project resource: destroying the group must
  // not remove it (it is reused as the cwd for the next group on the project;
  // CLAUDE.md/AGENTS.md are generated fresh at that group's own spawn time).
  const orchDir = join(runtimeDir, gid);
  mkdirSync(orchDir, { recursive: true });
  groupManager.destroyGroup(gid);
  assert.equal(existsSync(orchDir), true, 'orchestratorDir survives destroyGroup');
  // No groups remain, so the persisted file is unlinked entirely (not just
  // pruned) -- the group entry must be gone either way.
  let after = [];
  try {
    after = JSON.parse(readFileSync(process.env.CCSERVER_GROUPS_PATH, 'utf-8'));
  } catch {
    // file unlinked when the registry became empty -- expected
  }
  assert.equal(after.some((g) => g.id === gid), false, 'destroyed group is gone from the persisted file');
});

test('restoreGroups rebuilds a group from the persisted file (restart survival)', async () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `orch-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1234,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    orchestratorApp: 'claude',
    instructions: '# Orchestrator instructions',
    sandboxOpts: null,
    members: { workerA: 'dead-sess-a', orchestrator: 'dead-sess-o' },
  }]));

  const info = groupManager.restoreGroups();
  assert.equal(info.restored, 1);
  assert.deepEqual(info.ids, [gid]);

  const group = groupManager.getGroup(gid);
  assert.ok(group, 'group re-registered');
  assert.equal(group.cwd, '/srv/proj');
  assert.equal(group.orchestratorApp, 'claude');
  assert.deepEqual(
    [...group.members],
    [['workerA', 'dead-sess-a'], ['orchestrator', 'dead-sess-o']],
  );
  assert.equal(group.controlBroker, null, 'brokers are recreated lazily');
  // Instructions metadata is restored -- generation into an actual
  // CLAUDE.md/AGENTS.md happens only at the next real (re)spawn, via
  // generateOrchestratorClaudeMdSrc (see the dedicated tests below).
  assert.equal(group.instructions, '# Orchestrator instructions');

  // Session-less members surface as exited (skeleton only -- no saved-session
  // entry to match in this test).
  const workerA = groupManager.listGroupMembers(gid).find((m) => m.role === 'workerA');
  assert.equal(workerA.exited, true);
  assert.equal(workerA.restored, false);

  groupManager.destroyGroup(gid);
});

test('restoreGroups does not write CLAUDE.md/AGENTS.md (generation happens only at actual spawn time)', async () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `orch-nowrite-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    orchestratorApp: 'claude',
    instructions: '# Orchestrator instructions',
    sandboxOpts: null,
    members: { workerA: 'dead-sess-a', orchestrator: 'dead-sess-o' },
  }]));

  const info = groupManager.restoreGroups();
  assert.equal(info.restored, 1);
  assert.equal(existsSync(orchDir), true, 'orchestratorDir itself is still (re)created');
  assert.equal(existsSync(join(orchDir, 'CLAUDE.md')), false, 'restoreGroups no longer writes CLAUDE.md');
  assert.equal(existsSync(join(orchDir, 'AGENTS.md')), false, 'restoreGroups no longer writes AGENTS.md');
  groupsToDestroy.push(gid);
});

test('groupExistsForCwd matches a real registered group (POST /groups 409 detection)', async () => {
  const { groupExistsForCwd } = await import('../routes/groups.js');
  // Unique cwd: only this test's group can match it (other tests leave
  // '/srv/proj' groups in the registry until the after() cleanup).
  const cwd = `/srv/proj-${randomUUID()}`;
  const gid = await makeGroup(cwd);
  const listing = groupManager.listGroups();
  const hit = groupExistsForCwd(`${cwd}/`, listing);
  assert.ok(hit, 'the live listGroups() listing must be matched');
  assert.equal(hit.groupId, gid);
  assert.equal(groupExistsForCwd('/srv/other', listing), null, 'a different project must not match');
});

test('a newer takeHandoff supersedes a still-pending one (no zombie listener)', async () => {
  const gid = await makeGroup();

  // Call A: a pending wait that never resolves on its own (timeoutMs <= 0).
  const waitA = groupManager.takeHandoff(gid, 0);
  // Call B: the real waiter arriving while A is still unresolved. Under the
  // pre-fix implementation A's listener would stay attached and consume the
  // next pushHandoff, leaving B stuck until timeout; now A is superseded
  // first.
  const waitB = groupManager.takeHandoff(gid, 0);

  const event = { type: 'done', from: 'workerA' };
  assert.equal(groupManager.pushHandoff(gid, event), true);

  const [resA, resB] = await Promise.all([waitA, waitB]);
  assert.deepEqual(resA, { timedOut: true }, 'superseded waiter settles as timedOut, not by stealing the event');
  assert.deepEqual(resB, event, 'the latest waiter receives the pushed event');
});

test('a superseded waiter is removed from pendingTakes (no zombie listener left behind)', async () => {
  const gid = await makeGroup();

  const waitA = groupManager.takeHandoff(gid, 0);
  assert.equal(groupManager.getGroup(gid).pendingTakes.size, 1);

  // The newer waiter supersedes A, which must not linger in pendingTakes --
  // otherwise its listener would consume the next pushHandoff before waitB.
  const waitB = groupManager.takeHandoff(gid, 0);
  assert.equal(groupManager.getGroup(gid).pendingTakes.size, 1, 'superseded A must not linger');
  assert.deepEqual(await waitA, { timedOut: true });

  groupManager.pushHandoff(gid, { type: 'first' });
  assert.deepEqual(await waitB, { type: 'first' });
  assert.equal(groupManager.getGroup(gid).pendingTakes.size, 0, 'resolved waiter cleans up');
});

// The supersede reclaim: a waiter that already dequeued an event (its
// delivery is committed only on the next macrotask) gives it back to the
// queue when superseded -- the event must reach the fresh waiter instead of
// being lost with the stale one.
test('supersede reclaims an event a stale waiter already consumed', async () => {
  const gid = await makeGroup();

  const waitA = groupManager.takeHandoff(gid, 0);
  const event = { type: 'done', from: 'workerA', summary: 'E1' };
  groupManager.pushHandoff(gid, event); // A dequeues it (delivery not yet committed)

  const waitB = groupManager.takeHandoff(gid, 0); // supersedes A, reclaiming the event
  const [resA, resB] = await Promise.all([waitA, waitB]);
  assert.deepEqual(resA, { timedOut: true }, 'the stale waiter settles as timedOut without the event');
  assert.deepEqual(resB, event, 'the reclaimed event reaches the new waiter');
});

// The core no-loss guarantee: a waiter whose connection is dead must not
// dequeue anything -- the event stays queued for the next (live) waiter.
test('a dead (isAlive:false) waiter never consumes; the next live waiter receives the event', async () => {
  const gid = await makeGroup();

  const deadWait = groupManager.takeHandoff(gid, 0, { isAlive: () => false });
  groupManager.pushHandoff(gid, { type: 'done', from: 'workerA', summary: 'survives death' });
  // The dead waiter has not consumed: the queue still holds the event and a
  // live waiter supersedes the dead one and receives it.
  const liveWait = groupManager.takeHandoff(gid, 0, { isAlive: () => true });
  const [resDead, resLive] = await Promise.all([deadWait, liveWait]);
  assert.deepEqual(resDead, { timedOut: true });
  assert.deepEqual(resLive, { type: 'done', from: 'workerA', summary: 'survives death' });
});

test('onOrchestratorExit settles pending waiters as timedOut (no 15-min zombie)', async () => {
  const gid = await makeGroup();

  const wait = groupManager.takeHandoff(gid, 0); // never times out on its own
  assert.equal(groupManager.getGroup(gid).pendingTakes.size, 1);
  groupManager.onOrchestratorExit(gid);
  assert.equal(groupManager.getGroup(gid).pendingTakes.size, 0, 'waiters settled on orchestrator exit');
  const res = await Promise.race([
    wait,
    new Promise((r) => setTimeout(() => r('still-pending'), 500)),
  ]);
  assert.deepEqual(res, { timedOut: true });

  // The queue is untouched: a worker handoff after the exit is still
  // received by the next waiter.
  groupManager.pushHandoff(gid, { summary: 'after exit' });
  const next = await groupManager.takeHandoff(gid, 200);
  assert.deepEqual(next, { summary: 'after exit' });
});

test('destroyGroup settles pending takeHandoff waiters', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: '/srv/proj', orchestratorDir: '/srv/orch' });
  const wait = groupManager.takeHandoff(gid, 0); // never times out on its own
  groupManager.destroyGroup(gid);
  const res = await Promise.race([
    wait,
    new Promise((r) => setTimeout(() => r('still-pending'), 500)),
  ]);
  assert.deepEqual(res, { error: 'group-destroyed' });
});

test('pushHandoff records the turn moving to the orchestrator (with lastHandoffAt)', async () => {
  const gid = await makeGroup();
  groupManager.registerMember(gid, 'workerA', 'sess-a');
  groupManager.registerMember(gid, 'orchestrator', 'sess-o');

  assert.equal(groupManager.getGroup(gid).currentTurn, null);
  assert.equal(groupManager.getGroup(gid).lastHandoffAt, null);

  assert.equal(groupManager.pushHandoff(gid, { type: 'done', from: 'workerA', summary: 'x' }), true);
  const group = groupManager.getGroup(gid);
  assert.equal(group.currentTurn, 'orchestrator');
  assert.ok(group.lastHandoffAt, 'lastHandoffAt is stamped');
  assert.ok(group.lastHandoffAt <= Date.now());
});

test('pushHandoff honors an explicit nextRole for the incoming turn', async () => {
  const gid = await makeGroup();
  groupManager.registerMember(gid, 'workerA', 'sess-a');
  groupManager.registerMember(gid, 'workerB', 'sess-b');
  groupManager.registerMember(gid, 'orchestrator', 'sess-o');

  groupManager.pushHandoff(gid, { type: 'done', from: 'workerA', summary: 'passing to B', nextRole: 'workerB' });
  assert.equal(groupManager.getGroup(gid).currentTurn, 'workerB');
});

test('setCurrentTurn moves the turn to a registered role only', async () => {
  const gid = await makeGroup();
  groupManager.registerMember(gid, 'workerA', 'sess-a');
  groupManager.registerMember(gid, 'orchestrator', 'sess-o');

  assert.equal(groupManager.setCurrentTurn(gid, 'workerA'), true);
  assert.equal(groupManager.getGroup(gid).currentTurn, 'workerA');

  // Unknown role / unknown group are no-ops.
  assert.equal(groupManager.setCurrentTurn(gid, 'ghost'), false);
  assert.equal(groupManager.getGroup(gid).currentTurn, 'workerA');
  assert.equal(groupManager.setCurrentTurn('no-such-group', 'workerA'), false);
});

test('getRoleForSession maps a sessionId back to its role', async () => {
  const gid = await makeGroup();
  groupManager.registerMember(gid, 'workerA', 'sess-a');
  assert.equal(groupManager.getRoleForSession(gid, 'sess-a'), 'workerA');
  assert.equal(groupManager.getRoleForSession(gid, 'sess-unknown'), null);
  assert.equal(groupManager.getRoleForSession('no-such-group', 'sess-a'), null);
});

test('addMember refuses to grow a full group (member cap)', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: `/srv/proj-${gid}`, orchestratorDir: `/srv/orch-${gid}` });
  groupManager.registerMember(gid, 'orchestrator', 'sess-o');
  for (let i = 0; i < 7; i++) {
    groupManager.registerMember(gid, `worker${String.fromCharCode(65 + i)}`, `sess-${i}`);
  }
  assert.equal(groupManager.listGroupMembers(gid).length, 8);

  const res = await groupManager.addMember(gid, 'workerH', { app: 'claude', cwd: `/srv/proj-${gid}` });
  assert.equal(res.error, 'too-many-members');
  // The existing members are untouched.
  assert.equal(groupManager.listGroupMembers(gid).length, 8);

  groupManager.destroyGroup(gid);
});

test('destroyGroup never removes the orchestratorDir (per-project resource)', async () => {
  const gid = randomUUID();
  const dir = join(runtimeDir, `project-dir-${gid}`);
  mkdirSync(dir, { recursive: true });
  await groupManager.createGroup({ groupId: gid, cwd: '/srv/proj', orchestratorDir: dir });
  groupManager.destroyGroup(gid);
  assert.equal(existsSync(dir), true, 'orchestratorDir must survive the group being destroyed');
});

test('listGroups reports membership and live-ness', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: '/srv/proj', orchestratorDir: '/srv/orch' });
  groupManager.registerMember(gid, 'workerA', 'sess-a');

  const entry = groupManager.listGroups().find((g) => g.groupId === gid);
  assert.ok(entry);
  assert.equal(entry.cwd, '/srv/proj');
  assert.equal(entry.memberCount, 1);
  assert.equal(entry.liveCount, 0, 'a fake session id is not a live session');

  groupManager.destroyGroup(gid);
  assert.equal(groupManager.listGroups().some((g) => g.groupId === gid), false);
});

// The assembly race (routes/groups.js): workerA's pty crashes while workerB
// and the orchestrator are still being spawned. Before markGroupAssembled()
// the "no live members" auto-destroy in onSessionExit must NOT fire -- the
// half-built group (and its control broker) has to survive so the remaining
// members can still be registered.
test('a member exiting mid-assembly does not auto-destroy the group; it does after assembly', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: '/srv/proj', orchestratorDir: '/srv/orch' });
  groupManager.registerMember(gid, 'workerA', 'sess-a');
  groupsToDestroy.push(gid);

  // workerA died right after registering; siblings don't exist yet. The
  // group (and the control broker created by createGroup) must survive.
  groupManager.onSessionExit({ id: 'sess-a', groupId: gid, groupRole: 'workerA', exited: true });
  assert.ok(groupManager.getGroup(gid), 'assembling group must survive a member crash');

  // Once assembly completes, the normal rule applies again: all dead -> gone.
  groupManager.registerMember(gid, 'workerB', 'sess-b');
  groupManager.registerMember(gid, 'orchestrator', 'sess-o');
  groupManager.markGroupAssembled(gid);
  groupManager.onSessionExit({ id: 'sess-a', groupId: gid, groupRole: 'workerA', exited: true });
  groupManager.onSessionExit({ id: 'sess-b', groupId: gid, groupRole: 'workerB', exited: true });
  groupManager.onSessionExit({ id: 'sess-o', groupId: gid, groupRole: 'orchestrator', exited: true });
  assert.equal(groupManager.getGroup(gid), null, 'assembled group with no live members self-destructs');
});

test('restoreGroups matches member resume info from .saved-sessions.json (restored members)', async () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `restore-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    orchestratorApp: 'claude',
    instructions: '# Orch',
    sandboxOpts: { gpg: true },
    members: { workerA: 'dead-sess-a', orchestrator: 'dead-sess-o' },
  }]));
  // A graceful shutdown saved these with their group membership; the
  // 'another-group' entry must NOT leak into this group's members.
  writeFileSync(process.env.CCSERVER_SAVED_SESSIONS_PATH, JSON.stringify([
    { cwd: '/srv/proj', claudeSessionId: 'conv-1', sandbox: true, sandboxOpts: { gpg: true }, app: 'claude', groupId: gid, groupRole: 'workerA' },
    { cwd: orchDir, claudeSessionId: null, sandbox: true, sandboxOpts: null, app: 'opencode', groupId: gid, groupRole: 'orchestrator' },
    { cwd: '/other', claudeSessionId: 'conv-x', sandbox: true, sandboxOpts: null, app: 'claude', groupId: 'another-group', groupRole: 'workerA' },
  ]));
  groupsToDestroy.push(gid);

  const info = groupManager.restoreGroups();
  assert.equal(info.restored, 1);

  const members = groupManager.listGroupMembers(gid);
  const workerA = members.find((m) => m.role === 'workerA');
  assert.equal(workerA.restored, true, 'pty gone but resume info matched from the saved session');
  assert.equal(workerA.claudeSessionId, 'conv-1');
  assert.equal(workerA.app, 'claude');
  assert.equal(workerA.sandbox, true);
  assert.equal(workerA.sandboxOpts.gpg, true);
  const orch = members.find((m) => m.role === 'orchestrator');
  assert.equal(orch.restored, true);
  assert.equal(orch.app, 'opencode');
  assert.equal(workerA.cwd, '/srv/proj');
  // Restored members have no live pty, hence no activity timestamp (Issue #16).
  assert.equal(workerA.lastOutputAt, null);
  assert.equal(workerA.idleForMs, null);
  assert.equal(workerA.autoYes, null, 'restored member has no live session -> autoYes null');
  assert.equal(orch.lastOutputAt, null);
  assert.equal(orch.idleForMs, null);
});

// Issue #16: live members carry their activity timestamp through
// list_group_sessions so the orchestrator can scan the whole group for a
// stuck member in one call (fake session facade -- no real pty needed).
test('listGroupMembers: live sessions report lastOutputAt/idleForMs; session-less members report null', async () => {
  const gid = await makeGroup();
  const lastOutputAt = Date.now() - 3000;
  const fake = {
    getSession: (id) => (id === 'live-sess' ? { exited: false, socket: null, lastOutputAt, autoYes: true } : null),
    createSession: () => { throw new Error('unused'); },
    destroySession: () => {},
    writeToSession: () => false,
    dockerAvailability: () => ({ dockerAvailable: null, dockerReason: null }),
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.registerMember(gid, 'workerA', 'live-sess');
    groupManager.registerMember(gid, 'orchestrator', 'dead-sess');
    const members = groupManager.listGroupMembers(gid);
    const workerA = members.find((m) => m.role === 'workerA');
    const orch = members.find((m) => m.role === 'orchestrator');
    assert.equal(workerA.lastOutputAt, lastOutputAt);
    assert.ok(workerA.idleForMs >= 3000 && workerA.idleForMs <= 4000, `idleForMs must be the time since the last output (got ${workerA.idleForMs})`);
    assert.equal(workerA.autoYes, true, 'live session carries its autoYes state');
    assert.equal(orch.lastOutputAt, null, 'no live session -> no timestamp');
    assert.equal(orch.idleForMs, null);
    assert.equal(orch.autoYes, null, 'no live session -> autoYes null');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

// The orchestrator must always be the leftmost/active tab and the first
// list_group_sessions entry, even though the real launch order (routes/groups.js)
// registers the workers first and the orchestrator last.
test('listGroupMembers: orchestrator is always first regardless of registration order', async () => {
  const gid = await makeGroup();
  const fake = {
    getSession: () => null,
    createSession: () => { throw new Error('unused'); },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    // Real launch order (routes/groups.js): workers first, orchestrator last;
    // open_tab appends workerC.
    groupManager.registerMember(gid, 'workerA', 'sess-a');
    groupManager.registerMember(gid, 'workerB', 'sess-b');
    groupManager.registerMember(gid, 'orchestrator', 'sess-o');
    groupManager.registerMember(gid, 'workerC', 'sess-c');
    assert.deepEqual(
      groupManager.listGroupMembers(gid).map((m) => m.role),
      ['orchestrator', 'workerA', 'workerB', 'workerC'],
      'orchestrator must sort to the front; other roles keep insertion order',
    );
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

test('listGroupMembers keeps the orchestrator first after restoreGroups', async () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `restore-first-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    orchestratorApp: 'claude',
    instructions: null,
    sandboxOpts: null,
    members: { workerA: 'dead-a', workerB: 'dead-b', orchestrator: 'dead-o' },
  }]));
  groupsToDestroy.push(gid);

  groupManager.restoreGroups();
  const members = groupManager.listGroupMembers(gid);
  assert.deepEqual(
    members.map((m) => m.role),
    ['orchestrator', 'workerA', 'workerB'],
    'restored members keep the orchestrator first',
  );
});
// --- getOrchestratorSandboxOpts / getRegisteredMemberSandboxOpts: the
// resolution helpers openTab (mcpTools.js) uses to cap a genuinely new
// member's sandboxOpts against the orchestrator's own current grant, and to
// keep an already-registered member's sandboxOpts unchanged across a restart
// (see the sandboxOpts privilege-escalation fix plan).

test('getOrchestratorSandboxOpts: prefers the live orchestrator session sandboxOpts', async () => {
  const gid = await makeGroup();
  const fake = {
    getSession: (id) => (id === 'orch-sess' ? { sandboxOpts: { gpg: true, sshAgent: false } } : null),
    createSession: () => { throw new Error('unused'); },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.registerMember(gid, 'orchestrator', 'orch-sess');
    assert.deepEqual(groupManager.getOrchestratorSandboxOpts(gid), { gpg: true, sshAgent: false });
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

test('getOrchestratorSandboxOpts: falls back to memberSaved when no live session', async () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `orch-saved-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    orchestratorApp: 'claude',
    instructions: null,
    sandboxOpts: null,
    members: { orchestrator: 'dead-orch-sess' },
  }]));
  writeFileSync(process.env.CCSERVER_SAVED_SESSIONS_PATH, JSON.stringify([
    { cwd: orchDir, claudeSessionId: null, sandbox: true, sandboxOpts: { gpg: false, sshAgent: true }, app: 'claude', groupId: gid, groupRole: 'orchestrator' },
  ]));
  groupsToDestroy.push(gid);

  groupManager.restoreGroups();
  assert.deepEqual(groupManager.getOrchestratorSandboxOpts(gid), { gpg: false, sshAgent: true });
});

test('getOrchestratorSandboxOpts: falls back to memberPrefs.orchestrator.sandboxOpts when no session or saved info', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({
    groupId: gid,
    cwd: '/srv/proj',
    orchestratorDir: join(runtimeDir, gid),
    orchestratorSandboxOpts: { gpg: true, sshAgent: true },
  });
  groupsToDestroy.push(gid);
  assert.deepEqual(groupManager.getOrchestratorSandboxOpts(gid), { gpg: true, sshAgent: true });
});

test('getOrchestratorSandboxOpts: unknown groupId returns null', () => {
  assert.equal(groupManager.getOrchestratorSandboxOpts('no-such-group'), null);
});

test('getRegisteredMemberSandboxOpts: unregistered role reports registered:false, sandboxOpts:null', async () => {
  const gid = await makeGroup();
  assert.deepEqual(groupManager.getRegisteredMemberSandboxOpts(gid, 'workerA'), { registered: false, sandboxOpts: null });
});

test('getRegisteredMemberSandboxOpts: registered role prefers the live session sandboxOpts', async () => {
  const gid = await makeGroup();
  const fake = {
    getSession: (id) => (id === 'live-worker' ? { sandboxOpts: { gpg: true, sshAgent: true } } : null),
    createSession: () => { throw new Error('unused'); },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.registerMember(gid, 'workerA', 'live-worker');
    assert.deepEqual(groupManager.getRegisteredMemberSandboxOpts(gid, 'workerA'), {
      registered: true,
      sandboxOpts: { gpg: true, sshAgent: true },
    });
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

test('getRegisteredMemberSandboxOpts: dead session falls back to memberSaved (the restart case)', async () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `worker-saved-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    orchestratorApp: 'claude',
    instructions: null,
    sandboxOpts: null,
    members: { workerA: 'dead-worker-sess' },
  }]));
  writeFileSync(process.env.CCSERVER_SAVED_SESSIONS_PATH, JSON.stringify([
    { cwd: '/srv/proj', claudeSessionId: 'conv-1', sandbox: true, sandboxOpts: { gpg: true, sshAgent: false }, app: 'claude', groupId: gid, groupRole: 'workerA' },
  ]));
  groupsToDestroy.push(gid);

  groupManager.restoreGroups();
  assert.deepEqual(groupManager.getRegisteredMemberSandboxOpts(gid, 'workerA'), {
    registered: true,
    sandboxOpts: { gpg: true, sshAgent: false },
  });
});

// --- addMember (open_tab) spawn/teardown paths, exercised with a fake
// session facade (no real ptys): the atomic-replacement invariant -- the old
// member is only destroyed AFTER the new channel + session exist, and a
// failure anywhere leaves the old member fully usable.

test('addMember refuses copilot/commandcode explicitly and corrects the fallback to claude', async () => {
  const gid = await makeGroup();
  let seenApp = null;
  const fake = {
    getSession: () => null,
    createSession: (opts) => { seenApp = opts.app; return { sessionId: 'sess-c', session: {} }; },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    // An explicit copilot request is refused before any spawn.
    const res = await groupManager.addMember(gid, 'workerA', { app: 'copilot', cwd: '/srv/proj' });
    assert.equal(res.error, 'bad-request');
    assert.match(res.message, /not supported in groups/);
    assert.equal(seenApp, null, 'no spawn attempt for the refused member');
    // Same for commandcode (no verified MCP injection).
    const resCc = await groupManager.addMember(gid, 'workerA', { app: 'commandcode', cwd: '/srv/proj' });
    assert.equal(resCc.error, 'bad-request');
    assert.match(resCc.message, /not supported in groups/);
    assert.match(resCc.message, /commandcode/);
    assert.equal(seenApp, null, 'no spawn attempt for the refused member');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }

  // A persisted member pref landing on copilot (legacy group) is corrected to
  // claude instead of failing the launch.
  const gid2 = randomUUID();
  await groupManager.createGroup({
    groupId: gid2,
    cwd: '/srv/proj',
    orchestratorDir: join(runtimeDir, gid2),
    memberPrefs: { workerB: { app: 'copilot' } },
  });
  groupsToDestroy.push(gid2);
  groupManager.setSessionApiForTests(fake);
  try {
    const res = await groupManager.addMember(gid2, 'workerB', { cwd: '/srv/proj' });
    assert.equal(res.error, undefined, `fallback-resolved addMember should not fail: ${res.message || ''}`);
    assert.equal(seenApp, 'claude', 'copilot fallback corrected to claude');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid2);
  }
});

test('addMember spawns a session and registers it with a handoff channel (open_tab path)', async () => {
  const gid = await makeGroup();
  let seenOpts = null;
  const fake = {
    getSession: () => null,
    createSession: (opts) => { seenOpts = opts; return { sessionId: 'sess-new', session: {} }; },
    destroySession: () => { throw new Error('nothing to destroy on a fresh role'); },
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    const res = await groupManager.addMember(gid, 'workerA', { app: 'claude', cwd: '/srv/proj' });
    assert.equal(res.sessionId, 'sess-new');
    assert.equal(seenOpts.groupRole, 'workerA');
    assert.equal(seenOpts.sandbox, true);
    assert.equal(seenOpts.cwd, '/srv/proj');
    assert.ok(seenOpts.mcpSocketPath, 'session launched with the channel socket bound');
    assert.equal(groupManager.isSessionInGroup(gid, 'sess-new'), true);
    const ch = groupManager.getGroup(gid).handoffChannels.get('workerA');
    assert.ok(ch, 'handoff channel created');
    assert.equal(ch.sessionId, 'sess-new', 'channel bound to the new member');
    assert.ok(existsSync(ch.sockPath), 'channel socket file exists on disk');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

test('addMember replacing an existing role is atomic: old session destroyed only after the new one is in place', async () => {
  const gid = await makeGroup();
  groupManager.registerMember(gid, 'workerA', 'sess-old');
  await groupManager.createMemberHandoffChannel(gid, 'workerA'); // as a launched member would have
  const oldChannel = groupManager.getGroup(gid).handoffChannels.get('workerA');
  assert.equal(oldChannel.sessionId, 'sess-old');

  const destroyed = [];
  const fake = {
    getSession: () => null,
    createSession: (opts) => {
      assert.equal(opts.groupRole, 'workerA');
      return { sessionId: 'sess-new', session: {} };
    },
    destroySession: (sid) => destroyed.push(sid),
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    const res = await groupManager.addMember(gid, 'workerA', { app: 'claude', cwd: '/srv/proj' });
    assert.equal(res.sessionId, 'sess-new');
    assert.equal(groupManager.isSessionInGroup(gid, 'sess-old'), false, 'old member unregistered');
    assert.equal(groupManager.isSessionInGroup(gid, 'sess-new'), true);
    assert.deepEqual(destroyed, ['sess-old'], 'old session destroyed exactly once, after the swap');
    const ch = groupManager.getGroup(gid).handoffChannels.get('workerA');
    assert.ok(ch && ch !== oldChannel, 'channel replaced');
    assert.equal(ch.sessionId, 'sess-new');
    assert.ok(existsSync(ch.sockPath), 'replacement channel socket file exists');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

test('addMember spawn failure leaves the previous member and its channel intact', async () => {
  const gid = await makeGroup();
  groupManager.registerMember(gid, 'workerA', 'sess-old');
  await groupManager.createMemberHandoffChannel(gid, 'workerA');

  const fake = {
    getSession: () => null,
    createSession: () => ({ error: 'spawn failed' }),
    destroySession: () => { throw new Error('the old session must never be destroyed on spawn failure'); },
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    const res = await groupManager.addMember(gid, 'workerA', { app: 'claude', cwd: '/srv/proj' });
    assert.equal(res.error, 'spawn-failed');
    assert.equal(groupManager.isSessionInGroup(gid, 'sess-old'), true, 'old member untouched');
    const ch = groupManager.getGroup(gid).handoffChannels.get('workerA');
    assert.ok(ch, 'channel restored for the old member');
    assert.equal(ch.sessionId, 'sess-old');
    assert.ok(existsSync(ch.sockPath), 'restored channel is listening again (socket file recreated)');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

// --- memberPrefs: per-role launch preferences (app/model/sandboxOpts) -------

test('createGroup persists memberPrefs for all three roles; workers fall back to the group sandbox flags', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({
    groupId: gid,
    cwd: '/srv/proj',
    orchestratorDir: join(runtimeDir, gid),
    sandboxOpts: { gpg: true, sshAgent: false },
    memberPrefs: {
      workerA: { app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: false, sshAgent: true } },
      workerB: { app: 'claude', model: null, sandboxOpts: null },
      orchestrator: { app: 'claude', model: 'gpt-5', sandboxOpts: null },
    },
  });
  groupsToDestroy.push(gid);

  const prefs = groupManager.getMemberPrefs(gid);
  assert.deepEqual(prefs.workerA, { name: null, app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: false, sshAgent: true } });
  assert.deepEqual(prefs.workerB, { name: null, app: 'claude', model: null, sandboxOpts: null });
  assert.deepEqual(prefs.orchestrator, { name: null, app: 'claude', model: 'gpt-5', sandboxOpts: null });

  const group = groupManager.getGroup(gid);
  assert.equal(group.orchestratorApp, 'claude');
  assert.equal(group.orchestratorModel, 'gpt-5');

  // The persisted file carries memberPrefs (survives a restart).
  const saved = JSON.parse(readFileSync(process.env.CCSERVER_GROUPS_PATH, 'utf-8'));
  const entry = saved.find((g) => g.id === gid);
  assert.deepEqual(entry.memberPrefs.workerA, { name: null, app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: false, sshAgent: true } });
});

test('memberPrefs defaults: omitted worker sandboxOpts inherit the group flags, orchestrator has none', async () => {
  const gid = await makeGroup();
  const prefs = groupManager.getMemberPrefs(gid);
  // Default group has no sandboxOpts, so workers fall back to null.
  assert.deepEqual(prefs.workerA, { name: null, app: null, model: null, sandboxOpts: null });
  assert.deepEqual(prefs.orchestrator, { name: null, app: null, model: null, sandboxOpts: null });
});

test('setMemberPrefs updates a role and keeps orchestratorApp/orchestratorModel in sync', async () => {
  const gid = await makeGroup();
  assert.equal(groupManager.setMemberPrefs(gid, 'workerA', { app: 'opencode', model: 'gpt-5' }), true);
  assert.deepEqual(groupManager.getMemberPrefs(gid, 'workerA'), { name: null, app: 'opencode', model: 'gpt-5', sandboxOpts: null });

  groupManager.setMemberPrefs(gid, 'orchestrator', { app: 'opencode', model: 'claude-opus', sandboxOpts: { gpg: true } });
  const group = groupManager.getGroup(gid);
  assert.equal(group.orchestratorApp, 'opencode');
  assert.equal(group.orchestratorModel, 'claude-opus');

  assert.equal(groupManager.setMemberPrefs('no-such-group', 'workerA', {}), false);
});

test('restoreGroups rebuilds memberPrefs (with legacy orchestratorApp migration)', async () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `prefs-restore-${gid}`);
  // Legacy shape: orchestratorApp exists but no memberPrefs field.
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    orchestratorApp: 'opencode',
    instructions: '# Orch',
    sandboxOpts: { gpg: true },
    members: { workerA: 'dead-a', workerB: 'dead-b', orchestrator: 'dead-o' },
  }]));
  groupsToDestroy.push(gid);

  groupManager.restoreGroups();
  const prefs = groupManager.getMemberPrefs(gid);
  // Legacy orchestratorApp migrates into the orchestrator preference.
  assert.equal(prefs.orchestrator.app, 'opencode');
  // Workers have no app preference (legacy groups had none) but inherit the
  // group sandboxOpts fallback.
  assert.deepEqual(prefs.workerA.sandboxOpts, { gpg: true, sshAgent: false });
  assert.equal(groupManager.getGroup(gid).orchestratorApp, 'opencode');
});

test('restoreGroups: persisted memberPrefs round-trip (model preserved)', async () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `prefs-rt-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    orchestratorApp: 'claude',
    instructions: '# Orch',
    sandboxOpts: null,
    memberPrefs: {
      workerA: { app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: false, sshAgent: true } },
      workerB: { app: 'claude', model: null, sandboxOpts: null },
      orchestrator: { app: 'claude', model: 'gpt-5', sandboxOpts: null },
    },
    members: { workerA: 'dead-a', workerB: 'dead-b', orchestrator: 'dead-o' },
  }]));
  groupsToDestroy.push(gid);

  groupManager.restoreGroups();
  const prefs = groupManager.getMemberPrefs(gid);
  assert.deepEqual(prefs.workerA, { name: null, app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: false, sshAgent: true } });
  assert.deepEqual(prefs.workerB, { name: null, app: 'claude', model: null, sandboxOpts: null });
  assert.deepEqual(prefs.orchestrator, { name: null, app: 'claude', model: 'gpt-5', sandboxOpts: null });
});

test('restoreGroups: open_tab-created extra roles keep their memberPrefs (workerC survives restart)', async () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `prefs-extra-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    orchestratorApp: 'claude',
    instructions: null,
    sandboxOpts: { gpg: true, sshAgent: false },
    memberPrefs: {
      workerA: { app: 'opencode', model: null, sandboxOpts: { gpg: true, sshAgent: false } },
      workerB: { app: 'opencode', model: null, sandboxOpts: { gpg: true, sshAgent: false } },
      orchestrator: { app: 'claude', model: null, sandboxOpts: null },
      workerC: { app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: false, sshAgent: true } },
    },
    members: { workerA: 'dead-a', workerB: 'dead-b', orchestrator: 'dead-o', workerC: 'dead-c' },
  }]));
  groupsToDestroy.push(gid);

  groupManager.restoreGroups();
  const prefs = groupManager.getMemberPrefs(gid);
  assert.deepEqual(prefs.workerC, { name: null, app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: false, sshAgent: true } },
    'a non-fixed-trio worker role must not lose its preference on restore');
  assert.ok('workerA' in prefs, 'the fixed trio is still normalized');
});


test('addMember resolves options by precedence: explicit > memberPrefs > defaults', async () => {
  const gid = await makeGroup();
  const fake = {
    getSession: () => null,
    createSession: (opts) => {
      seenOpts = opts;
      return { sessionId: `sess-${opts.app}-${opts.model || 'null'}-${opts.sandboxOpts?.gpg ?? 'null'}-${opts.sandboxOpts?.sshAgent ?? 'null'}`, session: {} };
    },
    destroySession: () => {},
    writeToSession: () => false,
  };
  let seenOpts = null;
  groupManager.setSessionApiForTests(fake);
  try {
    // No memberPrefs, no explicit options: app falls back to the sandbox
    // config default, model null, sandboxOpts to the group level (null here).
    const r1 = await groupManager.addMember(gid, 'workerA', { cwd: '/srv/proj' });
    assert.equal(r1.error, undefined, `default-resolved addMember should not fail: ${r1.message || ''}`);
    assert.equal(seenOpts.model, null);
    assert.equal(seenOpts.sandboxOpts, null);
    assert.equal(r1.model, null);

    // Set a preference, then omit the option: preference wins.
    groupManager.setMemberPrefs(gid, 'workerA', { app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: true, sshAgent: false } });
    const r2 = await groupManager.addMember(gid, 'workerA', { cwd: '/srv/proj' });
    assert.equal(seenOpts.app, 'opencode');
    assert.equal(seenOpts.model, 'gpt-5');
    assert.deepEqual(seenOpts.sandboxOpts, { gpg: true, sshAgent: false });
    assert.deepEqual(r2.sandboxOpts, { gpg: true, sshAgent: false });

    // Explicit options beat the preference.
    const r3 = await groupManager.addMember(gid, 'workerA', { app: 'claude', model: 'claude-sonnet', cwd: '/srv/proj', sandboxOpts: { gpg: false, sshAgent: true } });
    assert.equal(seenOpts.app, 'claude');
    assert.equal(seenOpts.model, 'claude-sonnet');
    assert.deepEqual(seenOpts.sandboxOpts, { gpg: false, sshAgent: true });

    // Explicit model null means "app default" -- must override the preference.
    const r4 = await groupManager.addMember(gid, 'workerA', { model: null, cwd: '/srv/proj' });
    assert.equal(seenOpts.model, null);
    assert.equal(r4.model, null);

    // A failed replacement must not clobber the preference: after r4 the
    // stored pref is app=claude/model=null (r3's app + r4's explicit null
    // model), and the failed explicit spawn (claude/claude-sonnet) must leave
    // it alone.
    const failing = { getSession: () => null, createSession: () => ({ error: 'boom' }), destroySession: () => {}, writeToSession: () => false };
    groupManager.setSessionApiForTests(failing);
    await groupManager.addMember(gid, 'workerA', { app: 'claude', model: 'claude-sonnet', cwd: '/srv/proj' });
    assert.deepEqual(groupManager.getMemberPrefs(gid, 'workerA'), { name: null, app: 'claude', model: null, sandboxOpts: { gpg: false, sshAgent: true } }, 'failed spawn must leave the old preference untouched');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

test('addMember stores the effective launch data as the role preference (atomic with registration)', async () => {
  const gid = await makeGroup();
  const fake = {
    getSession: () => null,
    createSession: () => ({ sessionId: 'sess-new', session: { model: 'gpt-5' } }),
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    const res = await groupManager.addMember(gid, 'workerA', { app: 'opencode', model: 'gpt-5', cwd: '/srv/proj', sandboxOpts: { gpg: true } });
    assert.equal(res.error, undefined);
    assert.deepEqual(groupManager.getMemberPrefs(gid, 'workerA'), { name: null, app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: true, sshAgent: false } });
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

// generateOrchestratorClaudeMdSrc: merges server/ws/orchestrator-template.md
// with the group's saved custom instructions and writes the result to a
// host-only path (see sandbox.js's ro-bind overlay). templateCopyPath (set
// in before()) is a throwaway copy seeded from the real template via
// CCSERVER_ORCHESTRATOR_TEMPLATE_PATH -- the "template edit lands on the
// next generation" case below edits it in place, which would race with
// other test files reading the real, repo-tracked template concurrently if
// it targeted that file directly.

test('generateOrchestratorClaudeMdSrc: no custom instructions -> content is exactly the template', async () => {
  const gid = await makeGroup();
  const dest = groupManager.generateOrchestratorClaudeMdSrc(gid);
  assert.ok(dest, 'a destination path is returned');
  const template = readFileSync(templateCopyPath, 'utf-8');
  assert.equal(readFileSync(dest, 'utf-8'), template);
});

test('generateOrchestratorClaudeMdSrc: custom instructions are appended under a dedicated heading, template stays intact', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({
    groupId: gid,
    cwd: '/srv/proj-custom',
    orchestratorDir: join(runtimeDir, gid),
    instructions: '# My custom project notes',
  });
  groupsToDestroy.push(gid);
  const dest = groupManager.generateOrchestratorClaudeMdSrc(gid);
  const content = readFileSync(dest, 'utf-8');
  const template = readFileSync(templateCopyPath, 'utf-8');
  assert.ok(content.startsWith(template), 'template is included verbatim (never substituted)');
  assert.match(content, /## プロジェクト固有の指示 \(ユーザー設定\)/);
  assert.match(content, /# My custom project notes/);
});

test('generateOrchestratorClaudeMdSrc: same orchestratorDir -> same path, regenerated content reflects a template edit', async () => {
  const gid = await makeGroup('/srv/proj-regen');
  const destA = groupManager.generateOrchestratorClaudeMdSrc(gid);
  const destB = groupManager.generateOrchestratorClaudeMdSrc(gid);
  assert.equal(destA, destB, 'the generated path is stable for a given orchestratorDir');

  const original = readFileSync(templateCopyPath, 'utf-8');
  try {
    writeFileSync(templateCopyPath, '# Edited Orchestrator Template\n');
    const destC = groupManager.generateOrchestratorClaudeMdSrc(gid);
    assert.equal(destC, destA, 'still the same path');
    assert.equal(
      readFileSync(destC, 'utf-8'),
      '# Edited Orchestrator Template\n',
      'a template edit lands on the very next generation, no caching',
    );
  } finally {
    writeFileSync(templateCopyPath, original);
  }
});

test('generateOrchestratorClaudeMdSrc: unknown groupId returns null', () => {
  assert.equal(groupManager.generateOrchestratorClaudeMdSrc(randomUUID()), null);
});

test('an arbitrary worker role keeps its display name in memberPrefs, persistence and listGroupMembers', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({
    groupId: gid,
    cwd: '/srv/proj',
    orchestratorDir: join(runtimeDir, gid),
    // POST /groups' workers[] path passes name/app/model/sandboxOpts keyed by
    // the (arbitrary) worker role.
    memberPrefs: {
      workerImplement: { name: '実装担当', app: 'codex', model: 'gpt-5.4', sandboxOpts: null },
      orchestrator: { app: 'claude', model: null, sandboxOpts: null },
    },
  });
  groupsToDestroy.push(gid);
  groupManager.registerMember(gid, 'workerImplement', 'sess-impl');

  const member = groupManager.listGroupMembers(gid).find((m) => m.role === 'workerImplement');
  assert.equal(member.name, '実装担当');

  const saved = JSON.parse(readFileSync(process.env.CCSERVER_GROUPS_PATH, 'utf-8'));
  const entry = saved.find((g) => g.id === gid);
  assert.equal(entry.memberPrefs.workerImplement.name, '実装担当', 'display name persisted');

  // setMemberPrefs without a name keeps the existing one (fallback merge).
  groupManager.setMemberPrefs(gid, 'workerImplement', { app: 'claude', model: null, sandboxOpts: null });
  assert.equal(groupManager.getMemberPrefs(gid, 'workerImplement').name, '実装担当');
  // An explicit new name wins.
  groupManager.setMemberPrefs(gid, 'workerImplement', { name: '実装二番手', app: 'claude' });
  assert.equal(groupManager.getMemberPrefs(gid, 'workerImplement').name, '実装二番手');
});

test('restoreGroups: legacy records without a display name restore with name null (role fallback)', () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `orch-name-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    members: { workerA: 'dead-a' },
    memberPrefs: { workerA: { app: 'opencode', model: null, sandboxOpts: null } },
  }]));
  const info = groupManager.restoreGroups();
  assert.ok(info.ids.includes(gid));
  const member = groupManager.listGroupMembers(gid).find((m) => m.role === 'workerA');
  assert.equal(member.name, null, 'no name in the old record -> null, UI shows the role');
  assert.equal(member.app, 'opencode');
});

test('restoreGroups: a persisted display name survives a restart for arbitrary roles', () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `orch-name2-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    members: { workerReview: 'dead-r' },
    memberPrefs: { workerReview: { name: 'レビュー担当', app: 'claude', model: 'm', sandboxOpts: null } },
  }]));
  groupManager.restoreGroups();
  const member = groupManager.listGroupMembers(gid).find((m) => m.role === 'workerReview');
  assert.equal(member.name, 'レビュー担当');
});
