// Integration tests for the combo-group interactions with the scheduler and
// the graceful-shutdown save path:
//   - savedSessionPublic keeps groupId/groupRole (restart doesn't surface
//     group members as standalone sessions).
//   - resolveMcpSocketForSession + groupManager's resolver recreate a dead
//     member's handoff channel / the orchestrator's control broker.
//   - fireSchedule's live-session substitution is group+role aware (two
//     workers sharing cwd+app in different groups must not cross-inject).
//   - fireSchedule's auto-resume re-creates the member's MCP channel and
//     re-binds the role.
//
// Real (shell) sessions stand in for agents -- no sandbox or agent CLI
// required. Each test cleans up after itself.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let runtimeDir;
let groupManager;
let sessionManager;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// A live shell session bound to a group role (the session-create listener
// registers it), standing in for an agent member.
function shellMember(cwd, groupId, groupRole) {
  const res = sessionManager.createSession({
    cwd, cols: 80, rows: 24,
    shell: true, sandbox: false,
    groupId, groupRole,
  });
  assert.ok(res.session, 'shell session should spawn');
  return res.session;
}

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-sched-test-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  groupManager = await import('./groupManager.js');
  sessionManager = await import('./sessionManager.js');
});

after(() => {
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('savedSessionPublic preserves group membership (restart filter keeps working)', () => {
  const member = {
    cwd: '/srv/proj', app: 'opencode', sandbox: true, sandboxOpts: null,
    claudeSessionId: null, groupId: 'group-1', groupRole: 'workerA',
  };
  const out = sessionManager.savedSessionPublic(member, null);
  assert.equal(out.groupId, 'group-1');
  assert.equal(out.groupRole, 'workerA');
  assert.equal(out.app, 'opencode');

  const plain = sessionManager.savedSessionPublic({ ...member, groupId: null, groupRole: null }, 'conv-123');
  assert.equal(plain.groupId, null);
  assert.equal(plain.groupRole, null);
  assert.equal(plain.claudeSessionId, 'conv-123');
});

test('resolveGroupMcpSocket: creates a worker handoff channel, reuses/recreates the control broker', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: '/srv/proj', orchestratorDir: '/srv/orch' });
  const group = groupManager.getGroup(gid);

  // Worker: no channel yet -> created and registered.
  const workerSock = await groupManager.resolveGroupMcpSocket(gid, 'workerA');
  assert.ok(workerSock, 'worker channel socket path returned');
  assert.equal(group.handoffChannels.get('workerA').sockPath, workerSock);
  // Second call reuses the existing channel.
  const workerSock2 = await groupManager.resolveGroupMcpSocket(gid, 'workerA');
  assert.equal(workerSock2, workerSock);

  // Orchestrator: existing control broker is returned as-is.
  const orchSock = await groupManager.resolveGroupMcpSocket(gid, 'orchestrator');
  assert.equal(orchSock, group.controlBroker.sockPath);
  // Simulate the orchestrator's pty exiting (broker stopped) -> resolver
  // brings the broker back.
  groupManager.onOrchestratorExit(gid);
  assert.equal(group.controlBroker, null);
  const orchSock2 = await groupManager.resolveGroupMcpSocket(gid, 'orchestrator');
  assert.ok(orchSock2, 'control broker recreated');
  assert.equal(group.controlBroker.sockPath, orchSock2);

  // Unknown group -> null (caller drops the prompt rather than orphan).
  assert.equal(await groupManager.resolveGroupMcpSocket('no-such-group', 'workerA'), null);
  groupManager.destroyGroup(gid);
});

// Fix 6: the "same project" live-session substitution must not inject into a
// same-cwd/same-app worker belonging to ANOTHER group -- covered by direct
// unit tests of the exported matcher (fireSchedule uses it verbatim).
test('matchesScheduleTarget is group+role scoped (no cross-group injection)', () => {
  const live = (over = {}) => ({
    cwd: '/srv/proj', shell: false, app: 'claude',
    groupId: null, groupRole: null, exited: false, ptyProcess: {},
    ...over,
  });
  const entry = {
    cwd: '/srv/proj', shell: false, app: 'claude',
    groupId: null, groupRole: null,
  };
  const groupEntry = { ...entry, groupId: 'g1', groupRole: 'workerA' };

  // Legacy (non-group) entries keep the plain cwd+shell+app semantics.
  assert.equal(sessionManager.matchesScheduleTarget(live(), entry), true);
  assert.equal(sessionManager.matchesScheduleTarget(live({ cwd: '/other' }), entry), false);
  assert.equal(sessionManager.matchesScheduleTarget(live({ exited: true }), entry), false);

  // Group entries match only the same group AND same role.
  assert.equal(
    sessionManager.matchesScheduleTarget(live({ groupId: 'g1', groupRole: 'workerA' }), groupEntry),
    true,
  );
  assert.equal(
    sessionManager.matchesScheduleTarget(live({ groupId: 'g2', groupRole: 'workerA' }), groupEntry),
    false,
    'same cwd+app but a different group must not match',
  );
  assert.equal(
    sessionManager.matchesScheduleTarget(live({ groupId: 'g1', groupRole: 'orchestrator' }), groupEntry),
    false,
    'same group but a different role must not match',
  );
  assert.equal(
    sessionManager.matchesScheduleTarget(live({ groupId: null, groupRole: null }), groupEntry),
    false,
    'a standalone session must not match a group entry',
  );
});

// Fix 3: auto-resume of a dead group member recreates its handoff channel,
// binds it to the new session, and re-registers the role.
test('fireSchedule auto-resume of a group member recreates its MCP channel and rebinds the role', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: '/tmp', orchestratorDir: `/srv/orch-${gid}` });

  const dead = shellMember('/tmp', gid, 'workerA');
  const orch = shellMember('/tmp', gid, 'orchestrator'); // keeps the group alive

  assert.ok(sessionManager.setScheduledPrompt(dead.id, Date.now() + 700, 'MARKER_RESUME'));
  const deadId = dead.id;
  sessionManager.destroySession(dead.id); // keepSchedule defaults true

  await sleep(2500); // branch 3: resolver + createSession + re-registration

  const group = groupManager.getGroup(gid);
  assert.ok(group, 'group survives (orchestrator alive)');
  const member = group.members.get('workerA');
  assert.ok(member, 'workerA still registered');
  assert.notEqual(member, deadId, 'role rebound to the resumed session');
  const channel = group.handoffChannels.get('workerA');
  assert.ok(channel, 'a fresh handoff channel was created');
  assert.equal(channel.sessionId, member, 'channel bound to the resumed session');
  assert.ok(channel.sockPath, 'channel has a socket path');

  sessionManager.destroySession(member, { keepSchedule: false });
  sessionManager.destroySession(orch.id, { keepSchedule: false });
  groupManager.destroyGroup(gid);
});

// Fix 3 fallback: when the group is already gone, the resume is dropped
// instead of spawning an MCP-less orphan that could never hand off.
test('fireSchedule drops the prompt when the member group no longer exists', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: '/tmp', orchestratorDir: `/srv/orch-${gid}` });
  const member = shellMember('/tmp', gid, 'workerA');
  const orch = shellMember('/tmp', gid, 'orchestrator');

  assert.ok(sessionManager.setScheduledPrompt(member.id, Date.now() + 500, 'MARKER_ORPHAN_DROP'));
  // Tear the whole group down before the fire: members die, the all-exited
  // cleanup removes the group from the registry.
  sessionManager.destroySession(member.id); // keepSchedule
  sessionManager.destroySession(orch.id);   // keepSchedule
  await sleep(1800);
  assert.equal(groupManager.getGroup(gid), null, 'group cleaned up after all members exited');
  // Nothing to assert on the session side: no orphan may exist with this
  // groupId (invisible in the UI + unable to hand off).
  const leftover = sessionManager.listSessions().filter((s) => s.groupId === gid);
  assert.equal(leftover.length, 0, 'no MCP-less orphan session was spawned');
});
