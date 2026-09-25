// A routine server stop (SIGTERM/SIGINT -> sessionManager.gracefulShutdown)
// must leave the groups it is stopping restorable.
//
// gracefulShutdown() kills every pty, and each pty's exit reaches
// groupManager.onSessionExit -- which used to destroy a group the moment its
// last live member exited. A stop is exactly that moment for every group, so
// it destroyed all of them: registry entry, docs, handoff queue, files,
// worktrees, and the members' own .saved-sessions.json entries (the members
// were gone from sessionManager by the time finish() wrote that file). The
// persistence and restoreGroups() that exist for "groups survive a server
// restart" only ever saw a crash (SIGKILL), never a normal stop.
//
// The existing restore tests call restoreGroups() in-process against a file
// they wrote themselves; nothing drove the stop path. This does, with real
// (shell) ptys standing in for agents, and then restores from what the stop
// actually left on disk.
//
// gracefulShutdown() flips a process-wide flag that is never cleared (the
// process is on its way out), so the stop test comes last in this file and
// nothing after it may rely on a group being destroyed by an exit.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stopBroker } from './mcpBroker.js';

let runtimeDir;
let groupManager;
let sessionManager;

before(async () => {
  // Short base: the broker sockets live under XDG_RUNTIME_DIR (see
  // groupManager.test.js).
  runtimeDir = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'ccs-gsd-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  process.env.CCSERVER_GROUP_DOCS_PATH = join(runtimeDir, 'saved-group-docs.json');
  process.env.CCSERVER_GROUP_FILES_PATH = join(runtimeDir, 'saved-group-files.json');
  process.env.CCSERVER_GROUP_FILES_ROOT = join(runtimeDir, 'group-files');
  process.env.CCSERVER_SAVED_SESSIONS_PATH = join(runtimeDir, 'saved-sessions.json');
  process.env.CCSERVER_ORCHESTRATOR_GENERATED_ROOT = join(runtimeDir, 'orchestrator-generated');
  process.env.CCSERVER_WORKTREE_ROOT = join(runtimeDir, 'worktrees');
  const templateCopyPath = join(runtimeDir, 'orchestrator-template.md');
  cpSync(join(import.meta.dirname, 'orchestrator-template.md'), templateCopyPath);
  process.env.CCSERVER_ORCHESTRATOR_TEMPLATE_PATH = templateCopyPath;
  groupManager = await import('./groupManager.js');
  sessionManager = await import('./sessionManager.js');
});

after(() => {
  // Release the exited-session retention timers so the runner exits promptly.
  sessionManager.destroyAllSessions();
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(pred, what, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(25);
  }
}

// An assembled group whose members are live shell sessions bound to their
// roles (the session-create listener registers each), standing in for agents.
// `claudeSessionId` is what the agent CLI would have printed for a
// conversation; without one a claude member has nothing to resume and is not
// saved.
async function makeLiveGroup(roles) {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: '/srv/proj', orchestratorDir: join(runtimeDir, gid) });
  const sessions = {};
  for (const role of roles) {
    const res = await sessionManager.createSession({
      cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false, groupId: gid, groupRole: role,
    });
    assert.ok(res.session, `${role} shell should spawn`);
    res.session.claudeSessionId = `conv-${role}`;
    sessions[role] = res.session;
  }
  groupManager.markGroupAssembled(gid);
  return { gid, sessions };
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

test('a member exiting on its own still destroys a group with no live member left', async () => {
  const { gid, sessions } = await makeLiveGroup(['workerA']);
  try {
    assert.ok(groupManager.getGroup(gid));
    sessions.workerA.ptyProcess.kill();
    await until(() => groupManager.getGroup(gid) === null, 'the last member exit to destroy the group');
    assert.equal(existsSync(process.env.CCSERVER_GROUPS_PATH), false, 'no group left, so no registry file');
  } finally {
    groupManager.destroyGroup(gid);
  }
});

test('onSessionExit keeps an assembled group with no live member when the exit is the server stopping', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: '/srv/proj', orchestratorDir: join(runtimeDir, gid) });
  groupManager.registerMember(gid, 'workerA', 'sess-a');
  groupManager.markGroupAssembled(gid);
  try {
    const exited = { id: 'sess-a', groupId: gid, groupRole: 'workerA', exited: true };
    groupManager.onSessionExit(exited, { shuttingDown: true });
    assert.ok(groupManager.getGroup(gid), 'a stop is not the group ending');
    groupManager.onSessionExit(exited, { shuttingDown: false });
    assert.equal(groupManager.getGroup(gid), null, 'the same exit at any other time still ends it');
  } finally {
    groupManager.destroyGroup(gid);
  }
});

test('a graceful shutdown leaves the group, its docs, handoff queue and files on disk, and restoreGroups brings them back with resumable members', async () => {
  const { gid } = await makeLiveGroup(['orchestrator', 'workerA']);
  try {
    assert.equal(groupManager.publishGroupDoc(gid, 'workerA', 'plan', '# the plan').ok, true);
    assert.equal(groupManager.pushHandoff(gid, {
      id: 'h-1', fromSessionId: 'x', fromRole: 'workerA', summary: 'done with A', status: 'done', nextRole: null, at: 1,
    }), true);
    const uploaded = groupManager.publishGroupFilesFromUpload(gid, [{ name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('kept') }]);
    assert.equal(uploaded.ok, true);
    const fileId = uploaded.files[0].id;
    const blobPath = groupManager.fetchGroupFile(gid, fileId).blobPath;
    const liveGroup = groupManager.getGroup(gid);

    await sessionManager.gracefulShutdown();

    // What the stop left behind. This is all the next process gets.
    assert.ok(groupManager.getGroup(gid), 'the stop must not destroy the group');
    assert.equal(existsSync(blobPath), true, 'the group file blob must survive the stop');
    const groups = readJson(process.env.CCSERVER_GROUPS_PATH);
    const saved = groups.find((g) => g.id === gid);
    assert.ok(saved, 'the group is still in the registry file');
    assert.deepEqual(Object.keys(saved.members).sort(), ['orchestrator', 'workerA']);
    assert.deepEqual(saved.handoffQueue.map((e) => e.id), ['h-1']);
    assert.equal(readJson(process.env.CCSERVER_GROUP_DOCS_PATH)[gid].plan.content, '# the plan');
    assert.equal(readJson(process.env.CCSERVER_GROUP_FILES_PATH)[gid][fileId].name, 'notes.txt');
    const savedSessions = readJson(process.env.CCSERVER_SAVED_SESSIONS_PATH).filter((s) => s.groupId === gid);
    assert.deepEqual(
      savedSessions.map((s) => [s.groupRole, s.claudeSessionId]).sort(),
      [['orchestrator', 'conv-orchestrator'], ['workerA', 'conv-workerA']],
      'both members are saved with their group role and resume id',
    );

    // The next process: nothing live survives into it, so drop what the
    // stopped one still holds (brokers are stopped by the member exits; this
    // is defensive) and rebuild from the files alone.
    if (liveGroup.controlBroker) stopBroker(liveGroup.controlBroker);
    for (const channel of liveGroup.handoffChannels.values()) stopBroker(channel);
    const info = groupManager.restoreGroups();
    assert.ok(info.ids.includes(gid), 'restoreGroups finds the group');
    assert.notEqual(groupManager.getGroup(gid), liveGroup, 'the group was rebuilt from disk, not left over in memory');

    const members = groupManager.listGroupMembers(gid);
    assert.deepEqual(members.map((m) => m.role).sort(), ['orchestrator', 'workerA']);
    for (const m of members) {
      assert.equal(m.restored, true, `${m.role} has no pty but can be resumed`);
      assert.equal(m.exited, true);
      assert.equal(m.claudeSessionId, `conv-${m.role}`);
    }
    assert.equal(groupManager.fetchGroupDoc(gid, 'plan').content, '# the plan');
    const [file] = groupManager.listGroupFiles(gid).files;
    assert.equal(file.name, 'notes.txt');
    assert.equal(readFileSync(groupManager.fetchGroupFile(gid, file.id).blobPath, 'utf-8'), 'kept');
    const handoff = await groupManager.takeHandoff(gid, 1000);
    assert.equal(handoff.id, 'h-1', 'the undelivered handoff is still queued');
    assert.equal(handoff.summary, 'done with A');
  } finally {
    groupManager.destroyGroup(gid);
  }
});
