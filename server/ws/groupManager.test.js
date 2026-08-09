// Tests for groupManager's persistence/restore lifecycle and the teardown
// fixes:
//   - groups survive a server restart (persistGroups writes the registry,
//     restoreGroups rebuilds it with the orchestrator dir + instructions)
//   - destroyGroup settles pending takeHandoff waiters instead of leaving
//     them attached to the (now removed) emitter
//   - addMember refuses to grow a full group (member cap) before any spawn
//   - destroyGroup removes the orchestratorDir -- but only when its basename
//     equals the groupId (a malformed/foreign path is never deleted)
//
// Real control brokers listen on UDS during createGroup (same as
// mcpBroker.test.js); no agent CLIs, no bwrap, no browser needed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let runtimeDir;
let groupManager;
let groupsToDestroy = [];

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-gm-test-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  process.env.CCSERVER_SAVED_SESSIONS_PATH = join(runtimeDir, 'saved-sessions.json');
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

  groupManager.destroyGroup(gid);
  // orchestratorDir basename == groupId here, so it is removed with the group.
  assert.equal(existsSync(join(runtimeDir, gid)), false);
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

  // Orchestrator dir + instruction files are brought back for resume/restart.
  assert.equal(readFileSync(join(orchDir, 'CLAUDE.md'), 'utf-8'), '# Orchestrator instructions');
  assert.equal(readFileSync(join(orchDir, 'AGENTS.md'), 'utf-8'), '# Orchestrator instructions');

  // Session-less members surface as exited (skeleton only -- no saved-session
  // entry to match in this test).
  const workerA = groupManager.listGroupMembers(gid).find((m) => m.role === 'workerA');
  assert.equal(workerA.exited, true);
  assert.equal(workerA.restored, false);

  groupManager.destroyGroup(gid);
});

test('a newer takeHandoff supersedes a still-pending one (no zombie listener)', async () => {
  const gid = await makeGroup();

  // Call A: a pending wait that never resolves on its own (timeoutMs <= 0).
  const waitA = groupManager.takeHandoff(gid, 0);
  // Call B: the real waiter arriving while A is still unresolved. Under the
  // pre-fix implementation A's listener would stay attached and consume the
  // next pushHandoff, leaving B stuck until timeout; now A is orphaned first.
  const waitB = groupManager.takeHandoff(gid, 0);

  const event = { type: 'done', from: 'workerA' };
  assert.equal(groupManager.pushHandoff(gid, event), true);

  const [resA, resB] = await Promise.all([waitA, waitB]);
  assert.deepEqual(resA, { orphaned: true }, 'superseded waiter settles as orphaned, not by stealing the event');
  assert.deepEqual(resB, event, 'the latest waiter receives the pushed event');
});

test('a superseded waiter is removed from pendingTakes (no zombie listener left behind)', async () => {
  const gid = await makeGroup();

  const waitA = groupManager.takeHandoff(gid, 0);
  assert.equal(groupManager.getGroup(gid).pendingTakes.size, 1);

  // The newer waiter supersedes A, which must not linger in pendingTakes --
  // otherwise its listener would consume the next pushHandoff before waitB.
  const waitB = groupManager.takeHandoff(gid, 0);
  assert.equal(groupManager.getGroup(gid).pendingTakes.size, 1, 'orphaned A must not linger');
  assert.deepEqual(await waitA, { orphaned: true });

  groupManager.pushHandoff(gid, { type: 'first' });
  assert.deepEqual(await waitB, { type: 'first' });
  assert.equal(groupManager.getGroup(gid).pendingTakes.size, 0, 'resolved waiter cleans up');
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

test('destroyGroup only removes an orchestratorDir whose basename equals the groupId', async () => {
  const gid = randomUUID();
  const fakeDir = join(runtimeDir, 'unrelated-dir');
  mkdirSync(fakeDir, { recursive: true });
  await groupManager.createGroup({ groupId: gid, cwd: '/srv/proj', orchestratorDir: fakeDir });
  groupManager.destroyGroup(gid);
  assert.equal(existsSync(fakeDir), true, 'foreign path must never be deleted');
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
});

// --- addMember (open_tab) spawn/teardown paths, exercised with a fake
// session facade (no real ptys): the atomic-replacement invariant -- the old
// member is only destroyed AFTER the new channel + session exist, and a
// failure anywhere leaves the old member fully usable.

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
