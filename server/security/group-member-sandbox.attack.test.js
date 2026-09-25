// R1 (#290) attack tests: a REGISTERED group member must never be (re)launched
// unsandboxed, through any path a browser can reach -- and must not be able to
// talk the server into one by claiming ids/roles/values it does not own.
//
// Run (from server/):
//   node --import ./testEnvDefaults.js --test --test-timeout=60000 security/group-member-sandbox.attack.test.js
//
// This file is an acceptance artifact: the RED tests assert the SAFE behavior
// and fail on 42b4aecffa18ad56c5164c1312c140476ac6f730; the GREEN tests pin
// behavior that must not regress. It needs no network; everything it writes is
// under os.tmpdir(). Real-bwrap assertions skip with a reason where bwrap
// cannot build a sandbox.
//
// The schedule test (the RED one on 42b4aec) is host-independent: with a
// sandbox backend it requires the auto-resumed member to be sandboxed, and
// without one it passes when the fixed revision launches nothing at all
// (fail-closed, "bwrap is not available") -- it can only fail by launching a
// member session unsandboxed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stopBroker } from '../ws/mcpBroker.js';

let runtimeDir;
let projectDir;
let groupManager;
let sessionManager;
let terminal;
let sandboxModule;

before(async () => {
  // Short base: broker sockets live under XDG_RUNTIME_DIR.
  runtimeDir = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'ccs-sec-'));
  projectDir = join(runtimeDir, 'project'); // not a git repo: members fall back to it as cwd
  mkdirSync(projectDir, { recursive: true });
  const template = join(import.meta.dirname, '..', 'ws', 'orchestrator-template.md');
  cpSync(template, join(runtimeDir, 'orchestrator-template.md'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  process.env.CCSERVER_GROUP_DOCS_PATH = join(runtimeDir, 'saved-group-docs.json');
  process.env.CCSERVER_GROUP_FILES_PATH = join(runtimeDir, 'saved-group-files.json');
  process.env.CCSERVER_GROUP_FILES_ROOT = join(runtimeDir, 'group-files');
  process.env.CCSERVER_SAVED_SESSIONS_PATH = join(runtimeDir, 'saved-sessions.json');
  process.env.CCSERVER_SCHEDULES_PATH = join(runtimeDir, 'scheduled-prompts.json');
  process.env.CCSERVER_ORCHESTRATOR_GENERATED_ROOT = join(runtimeDir, 'orchestrator-generated');
  process.env.CCSERVER_WORKTREE_ROOT = join(runtimeDir, 'worktrees');
  process.env.CCSERVER_ORCHESTRATOR_TEMPLATE_PATH = join(runtimeDir, 'orchestrator-template.md');
  // The real /ws/terminal handler refuses init while the #201 setup gate is up;
  // declaring the migrated layout keeps this file about the sandbox.
  process.env.CCSERVER_LAYOUT = 'xdg';
  // Same pins every real-launch test uses: no docker (rootlesskit needs subuid
  // ranges), no git broker (its child would keep node --test alive), no
  // persistent HOME.
  process.env.CCSERVER_SANDBOX_CONFIG = join(runtimeDir, 'sandbox.config.json');
  writeFileSync(process.env.CCSERVER_SANDBOX_CONFIG,
    JSON.stringify({ docker: false, gitBroker: false, persistentHome: false }));
  groupManager = await import('../ws/groupManager.js');
  sessionManager = await import('../ws/sessionManager.js');
  terminal = await import('../ws/terminal.js');
  sandboxModule = await import('../ws/sandbox.js');
});

after(() => {
  terminal.setCreateSessionForTests(null);
  sessionManager.destroyAllSessions();
  delete process.env.CCSERVER_LAYOUT;
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, what, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(25);
  }
}

async function makeGroup({ roles = [], memberPrefs = null, sandboxOpts = null } = {}) {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: projectDir, orchestratorDir: join(runtimeDir, gid), memberPrefs, sandboxOpts });
  for (const role of roles) groupManager.registerMember(gid, role, `gone-${role}`);
  groupManager.markGroupAssembled(gid);
  return gid;
}

// A reboot: in-memory state is gone and the registry is read back from its file.
function simulateRestart(gid) {
  const live = groupManager.getGroup(gid);
  if (live.controlBroker) stopBroker(live.controlBroker);
  for (const channel of live.handoffChannels.values()) stopBroker(channel);
  return groupManager.restoreGroups();
}

const BROAD = { gpg: true, sshAgent: true, gpgVault: true, tools: { rtk: true, codeReviewGraph: true } };
const NARROW = { gpg: true, sshAgent: false, gpgVault: false };

// ---------------------------------------------------------------------------
// GREEN: the decision itself. A registered member is forced sandboxed no
// matter what the request says, and gets exactly the registered options.
// ---------------------------------------------------------------------------

test('GREEN: a registered member is forced to sandbox:true with its registered opts, whatever the request says', async () => {
  const gid = await makeGroup({ roles: ['workerA'], memberPrefs: { workerA: { sandboxOpts: NARROW } } });
  try {
    for (const requested of [
      { sandbox: false, sandboxOpts: BROAD },
      { sandbox: false, sandboxOpts: null },
      {},
      { sandbox: 0, sandboxOpts: BROAD },
      { sandbox: 'false', sandboxOpts: BROAD },
      { sandbox: [], sandboxOpts: BROAD },
    ]) {
      const r = groupManager.resolveMemberInitLaunch(gid, 'workerA', requested);
      assert.equal(r.member, true, JSON.stringify(requested));
      assert.equal(r.sandbox, true, JSON.stringify(requested));
      assert.deepEqual(r.sandboxOpts, NARROW, JSON.stringify(requested));
    }
    // A client that does ask for the sandbox is not "forced".
    assert.equal(groupManager.resolveMemberInitLaunch(gid, 'workerA', { sandbox: true }).forced, false);
  } finally { groupManager.destroyGroup(gid); }
});

test('GREEN: ids and roles that do not name a registered member cannot become one (and vice versa)', async () => {
  const gid = await makeGroup({ roles: ['workerA'] });
  const other = await makeGroup({ roles: ['workerB'] });
  try {
    const asked = { sandbox: false, sandboxOpts: BROAD };
    const same = { member: false, forced: false, sandbox: false, sandboxOpts: BROAD };
    for (const [id, role] of [
      [null, null],
      [gid, null],
      [null, 'workerA'],
      [gid, 'workerB'],            // a real role, but of another group
      [other, 'workerA'],
      [randomUUID(), 'workerA'],   // a group that is not in the registry
      [randomUUID(), 'orchestrator'],
      [gid, 'workerA '],           // trailing space
      [gid, ' workerA'],
      [gid, 'WORKERA'],
      [gid, 'workerZ'],
      [gid, '__proto__'],
      [gid, 'constructor'],
      [gid, 'toString'],
      [{ toString: () => gid }, { toString: () => 'workerA' }], // non-strings
      [[gid], ['workerA']],
      [gid, ['workerA']],
      [42, 'workerA'],
    ]) {
      assert.deepEqual(groupManager.resolveMemberInitLaunch(id, role, asked), same, `id=${String(id)} role=${String(role)}`);
    }
  } finally { groupManager.destroyGroup(gid); groupManager.destroyGroup(other); }
});

test('GREEN: the orchestrator is forced too, before and after it is in the member map', async () => {
  const withOrch = await makeGroup({ roles: ['orchestrator'], memberPrefs: { orchestrator: { sandboxOpts: NARROW } } });
  const withoutOrch = await makeGroup({ roles: [], memberPrefs: { orchestrator: { sandboxOpts: NARROW } } });
  try {
    for (const gid of [withOrch, withoutOrch]) {
      const r = groupManager.resolveMemberInitLaunch(gid, 'orchestrator', { sandbox: false, sandboxOpts: BROAD });
      assert.equal(r.member, true);
      assert.equal(r.sandbox, true);
      assert.equal(r.forced, true);
      assert.deepEqual(r.sandboxOpts, NARROW);
    }
  } finally { groupManager.destroyGroup(withOrch); groupManager.destroyGroup(withoutOrch); }
});

test('GREEN: after a restart a legacy saved sandbox:false cannot leak through init either', async () => {
  const gid = await makeGroup({ roles: ['workerA'], memberPrefs: { workerA: { sandboxOpts: NARROW } } });
  try {
    const legacySaved = { gpg: false, sshAgent: true, gpgVault: false };
    writeFileSync(process.env.CCSERVER_SAVED_SESSIONS_PATH, JSON.stringify([
      { groupId: gid, groupRole: 'workerA', app: 'claude', cwd: projectDir, claudeSessionId: 'conv-a', sandbox: false, sandboxOpts: legacySaved },
    ]));
    simulateRestart(gid);
    const r = groupManager.resolveMemberInitLaunch(gid, 'workerA', { sandbox: false, sandboxOpts: BROAD });
    assert.equal(r.sandbox, true, 'a saved sandbox:false is a legacy artifact, not a launch instruction');
    assert.deepEqual(r.sandboxOpts, legacySaved, 'the saved session is still the registered resolution source');
  } finally {
    rmSync(process.env.CCSERVER_SAVED_SESSIONS_PATH, { force: true });
    groupManager.destroyGroup(gid);
  }
});

test('GREEN: a restored member with neither a live nor a saved session is listed sandboxed', async () => {
  const gid = await makeGroup({ roles: ['workerA', 'orchestrator'] });
  try {
    simulateRestart(gid);
    for (const m of groupManager.listGroupMembers(gid)) {
      assert.equal(m.sandbox, true, `${m.role}: the browser echoes this back in the re-launch`);
    }
  } finally { groupManager.destroyGroup(gid); }
});

// ---------------------------------------------------------------------------
// GREEN: what a real `init` actually hands to createSession.
// ---------------------------------------------------------------------------

function fakeChan() {
  const sent = [];
  return { sent, readyState: 1, send(json) { sent.push(JSON.parse(json)); }, close() { this.readyState = 3; } };
}

async function initAndRecord(msg) {
  const calls = [];
  terminal.setCreateSessionForTests(async (opts) => { calls.push(opts); return { error: 'stopped by the test' }; });
  try {
    const chan = fakeChan();
    await terminal.attachTerminalHandler(chan).handleMessage({ type: 'init', cols: 80, rows: 24, ...msg });
    return { calls, sent: chan.sent };
  } finally { terminal.setCreateSessionForTests(null); }
}

test('GREEN: init hands createSession sandbox:true and the registered opts for a member, whatever the client sent', async () => {
  const gid = await makeGroup({ roles: ['orchestrator', 'workerA'], memberPrefs: { workerA: { sandboxOpts: NARROW } } });
  try {
    for (const claimed of [
      { sandbox: false, sandboxOpts: BROAD },
      { sandbox: false, sandboxOpts: null },
      {},
      { sandbox: 0 },
      { sandbox: 'false', sandboxOpts: BROAD },
    ]) {
      const { calls } = await initAndRecord({ cwd: projectDir, groupId: gid, groupRole: 'workerA', ...claimed });
      assert.equal(calls.length, 1, JSON.stringify(claimed));
      assert.equal(calls[0].sandbox, true, JSON.stringify(claimed));
      assert.deepEqual(calls[0].sandboxOpts, NARROW, JSON.stringify(claimed));
      assert.equal(calls[0].groupId, gid);
      assert.equal(calls[0].groupRole, 'workerA');
    }
  } finally { groupManager.destroyGroup(gid); }
});

test('GREEN: init refuses a claimed role the group never had, including case and whitespace variants', async () => {
  const gid = await makeGroup({ roles: ['workerA'] });
  try {
    for (const role of ['workerZ', 'workerA ', ' workerA', 'WORKERA', '__proto__']) {
      const { calls, sent } = await initAndRecord({ cwd: projectDir, groupId: gid, groupRole: role, sandbox: false });
      assert.equal(calls.length, 0, `role=${JSON.stringify(role)} must never reach createSession`);
      assert.equal(sent.find((m) => m.type === 'error')?.code, 'SPAWN_FAILED', `role=${JSON.stringify(role)}`);
    }
    const gone = await initAndRecord({ cwd: projectDir, groupId: randomUUID(), groupRole: 'orchestrator', sandbox: false });
    assert.equal(gone.calls.length, 0, 'a group that is not in the registry cannot be re-launched');
  } finally { groupManager.destroyGroup(gid); }
});

test('GREEN: a session that is not a registered member keeps its own values, exactly as before', async () => {
  const gid = await makeGroup({ roles: ['workerA'] });
  try {
    const plain = await initAndRecord({ cwd: projectDir, sandbox: false, sandboxOpts: BROAD });
    assert.equal(plain.calls[0].sandbox, false);
    assert.deepEqual(plain.calls[0].sandboxOpts, BROAD);
    const idOnly = await initAndRecord({ cwd: projectDir, groupId: gid, sandbox: false });
    assert.equal(idOnly.calls[0].sandbox, false, 'a groupId alone does not make a member');
    const roleOnly = await initAndRecord({ cwd: projectDir, groupRole: 'workerA', sandbox: false });
    assert.equal(roleOnly.calls[0].sandbox, false, 'a role alone does not make a member');
  } finally { groupManager.destroyGroup(gid); }
});

// ---------------------------------------------------------------------------
// RED: the schedule auto-resume path still launches a registered member with
// the sandbox flag persisted in the entry. For entries written while a member
// ran unsandboxed (pre-fix), that is sandbox:false -- the exact hole, one
// restart later.
// ---------------------------------------------------------------------------

test('RED: a persisted schedule entry for a registered member must not auto-resume it unsandboxed', async () => {
  const gid = await makeGroup({ roles: ['workerA'] });
  try {
    // Two entries, both missed (fired while the server was down), so both fire
    // ~3s after restoreSchedules(). The control has no group and is an ordinary
    // unsandboxed shell by design; it proves the fire path ran. The member entry
    // asserts the safe behavior: whatever comes back must be sandboxed (or not
    // launched at all, which is also fail-closed).
    writeFileSync(process.env.CCSERVER_SCHEDULES_PATH, JSON.stringify([
      { at: Date.now() - 1000, text: 'true', cwd: projectDir, sandbox: false, sandboxOpts: null, shell: true, groupId: null, groupRole: null, source: 'manual' },
      { at: Date.now() - 1000, text: 'true', cwd: projectDir, sandbox: false, sandboxOpts: BROAD, shell: true, groupId: gid, groupRole: 'workerA', source: 'manual' },
    ]));
    sessionManager.restoreSchedules();

    await until(() => sessionManager.listSessions().some((s) => !s.groupId && s.shell && s.cwd === projectDir),
      'the control schedule to fire');
    const control = sessionManager.listSessions().find((s) => !s.groupId && s.shell && s.cwd === projectDir);
    assert.equal(control.sandbox, false, 'control: an ordinary scheduled shell is unsandboxed by design');

    // The member entry fires at the same 3s boundary as the control. On a host
    // WITH a sandbox backend the fixed revision launches it sandboxed; on one
    // without (CI's unit matrix) it is FAIL-CLOSED: the prompt is dropped and
    // no member session appears at all. Both outcomes pass -- the failure this
    // test exists for is a member session that DID launch unsandboxed.
    // Bounded grace, not a poll for one outcome: the entry fires ~3s after
    // restoreSchedules (fireSchedule's missed-schedule delay), the control above
    // proves that wave ran, and an unsandboxed launch (the only failure case)
    // finishes in milliseconds; the extra grace lets a sandboxed launch finish.
    await sleep(3000);
    const memberSessions = sessionManager.listSessions()
      .filter((s) => s.groupId === gid && s.groupRole === 'workerA');
    // Zero member sessions is safe (fail-closed: nothing was launched).
    for (const member of memberSessions) {
      assert.equal(member.sandbox, true,
        'a registered member auto-resumed from a persisted entry must never run unsandboxed');
    }
  } finally {
    for (const s of sessionManager.listSessions()) {
      if (s.shell && (s.groupId === gid || !s.groupId)) sessionManager.destroySession(s.id);
    }
    rmSync(process.env.CCSERVER_SCHEDULES_PATH, { force: true });
    groupManager.destroyGroup(gid);
  }
});

// ---------------------------------------------------------------------------
// GREEN (bwrap only): the real re-launch lands in another mount namespace.
// ---------------------------------------------------------------------------

const BWRAP_RUNS = process.platform === 'linux' && existsSync('/usr/bin/bwrap')
  && spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true']).status === 0;

test('GREEN: a member re-launched after a restart really runs outside the server mount namespace', {
  skip: !BWRAP_RUNS && 'no working bwrap here',
}, async (t) => {
  assert.equal(sandboxModule.sandboxAvailable(), true);
  const gid = await makeGroup({ roles: ['orchestrator'] });
  let sessionId = null;
  try {
    simulateRestart(gid);
    const chan = fakeChan();
    await terminal.attachTerminalHandler(chan).handleMessage({
      type: 'init', cols: 80, rows: 24, shell: true, cwd: projectDir,
      sandbox: false, sandboxOpts: BROAD, groupId: gid, groupRole: 'orchestrator',
    });
    const reply = chan.sent.find((m) => m.type === 'session');
    assert.ok(reply, `re-launch accepted: ${JSON.stringify(chan.sent.find((m) => m.type === 'error'))}`);
    sessionId = reply.sessionId;
    assert.equal(reply.sandbox, true);

    const session = sessionManager.getSession(sessionId);
    assert.equal(session.sandbox, true);
    sessionManager.writeToSession(sessionId, "printf 'NS=%s\\n' \"$(readlink /proc/self/ns/mnt)\"\r");
    await until(() => session.exited || session.outputBuffer.join('').includes('NS=mnt:['),
      'the shell to print its mount namespace');
    const printed = session.outputBuffer.join('');
    if (session.exited && /^bwrap: /m.test(printed)) {
      t.skip(`bwrap could not assemble the sandbox on this host: ${printed.split('\n').find((l) => /^bwrap: /.test(l))}`);
      return;
    }
    assert.ok(!session.exited, `sandboxed shell exited (${session.exitCode}): ${JSON.stringify(printed.slice(-400))}`);
    const inside = /NS=(mnt:\[\d+\])/.exec(printed)[1];
    assert.notEqual(inside, readlinkSync('/proc/self/ns/mnt'), 'the member is not in the server mount namespace');
  } finally {
    if (sessionId) sessionManager.destroySession(sessionId);
    groupManager.destroyGroup(gid);
  }
});
