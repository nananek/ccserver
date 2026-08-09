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

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-gm-test-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  groupManager = await import('./groupManager.js');
});

after(() => {
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

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
