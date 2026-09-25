// A registered group member is ALWAYS launched sandboxed, with the sandboxOpts
// registered for it -- whatever a browser `init` says.
//
// The hole: after a server restart a member with no saved session (every claude
// member after a routine stop -- it is only saved when its conversation id is
// known -- and every member after a crash) was listed with sandbox:false, the
// browser echoed that in its re-launch `init`, and terminal.js passed the
// client's value straight to createSession. With no forceSandbox / browseRoots
// configured, nothing overrode it: the agent (auto-approving, for a worker) ran
// as a direct child of the server, in the server's mount namespace, with its
// state, config and the data directory in view.
//
// Three layers here: the decision on its own (resolveMemberInitLaunch), what a
// real `init` hands to createSession (the seam in terminal.js), and, where a
// sandbox can be built, a re-launch after a simulated restart that must really
// end up in another mount namespace than the server.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stopBroker } from './mcpBroker.js';

let runtimeDir;
let projectDir;
let groupManager;
let sessionManager;
let terminal;
let sandboxModule;

before(async () => {
  // Short base: the broker sockets live under XDG_RUNTIME_DIR.
  runtimeDir = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'ccs-gms-'));
  projectDir = join(runtimeDir, 'project');   // not a git repo: workers use it as their cwd
  cpSync(join(import.meta.dirname, 'orchestrator-template.md'), join(runtimeDir, 'orchestrator-template.md'));
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
  // The real /ws/terminal dispatcher refuses `init` while the #201 setup gate is
  // up; declaring the migrated layout keeps this file about the sandbox (the gate
  // itself is covered by startup-setup-gate.test.js).
  process.env.CCSERVER_LAYOUT = 'xdg';
  // The same pins every test that really launches a sandbox uses: no docker (that
  // goes through rootlesskit, which needs subuid ranges a CI runner or a nested
  // sandbox may not have), no gitBroker (a live child that would keep node --test
  // from exiting), no persistent HOME.
  process.env.CCSERVER_SANDBOX_CONFIG = join(runtimeDir, 'sandbox.config.json');
  writeFileSync(process.env.CCSERVER_SANDBOX_CONFIG, JSON.stringify({ docker: false, gitBroker: false, persistentHome: false }));
  mkdirSync(projectDir, { recursive: true });
  groupManager = await import('./groupManager.js');
  sessionManager = await import('./sessionManager.js');
  terminal = await import('./terminal.js');
  sandboxModule = await import('./sandbox.js');
});

after(() => {
  terminal.setCreateSessionForTests(null);
  sessionManager.destroyAllSessions();
  delete process.env.CCSERVER_LAYOUT;
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(25);
  }
}

// A group with these roles registered (their sessions are gone, as after a
// restart). `memberPrefs` is what was registered for a role at launch.
async function makeGroup({ roles = [], memberPrefs = null, sandboxOpts = null } = {}) {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: projectDir, orchestratorDir: join(runtimeDir, gid), memberPrefs, sandboxOpts });
  for (const role of roles) groupManager.registerMember(gid, role, `gone-${role}`);
  groupManager.markGroupAssembled(gid);
  return gid;
}

// A restart: what is in memory is gone and the registry is read back from its
// file. The brokers of the old in-memory group are stopped first, as the process
// that owned them would have.
function simulateRestart(gid) {
  const live = groupManager.getGroup(gid);
  if (live.controlBroker) stopBroker(live.controlBroker);
  for (const channel of live.handoffChannels.values()) stopBroker(channel);
  return groupManager.restoreGroups();
}

const BROAD = { gpg: true, sshAgent: true, gpgVault: true, tools: { rtk: true, codeReviewGraph: true } };
const NARROW = { gpg: true, sshAgent: false, gpgVault: false };

// ------------------------------------------------------------------ the decision

test('a registered worker is launched sandboxed with exactly its registered sandboxOpts, whatever the client sent', async () => {
  const gid = await makeGroup({ roles: ['workerA'], memberPrefs: { workerA: { sandboxOpts: NARROW } } });
  try {
    const r = groupManager.resolveMemberInitLaunch(gid, 'workerA', { sandbox: false, sandboxOpts: BROAD });
    assert.equal(r.member, true);
    assert.equal(r.sandbox, true, 'a client that says no sandbox does not get one');
    assert.equal(r.forced, true, 'and the caller is told it was overridden');
    assert.deepEqual(r.sandboxOpts, NARROW, 'the member gets what was registered for it, not what the client asks for');
    // A client that sends nothing at all (the shape after a restart) gets the same.
    assert.deepEqual(groupManager.resolveMemberInitLaunch(gid, 'workerA', {}).sandboxOpts, NARROW);
  } finally { groupManager.destroyGroup(gid); }
});

test('a member with no registered sandboxOpts gets none, not the client\'s', async () => {
  const gid = await makeGroup({ roles: ['workerB'] });
  try {
    const r = groupManager.resolveMemberInitLaunch(gid, 'workerB', { sandbox: true, sandboxOpts: BROAD });
    assert.equal(r.sandboxOpts, null);
    assert.equal(r.sandbox, true);
    assert.equal(r.forced, false, 'it asked for a sandbox, so nothing was overridden');
  } finally { groupManager.destroyGroup(gid); }
});

test('the orchestrator too, whether or not it is in the member map yet', async () => {
  const withOrch = await makeGroup({ roles: ['orchestrator'], memberPrefs: { orchestrator: { sandboxOpts: NARROW } } });
  const withoutOrch = await makeGroup({ roles: [], memberPrefs: { orchestrator: { sandboxOpts: NARROW } } });
  try {
    for (const gid of [withOrch, withoutOrch]) {
      const r = groupManager.resolveMemberInitLaunch(gid, 'orchestrator', { sandbox: false, sandboxOpts: BROAD });
      assert.equal(r.member, true);
      assert.equal(r.sandbox, true);
      assert.deepEqual(r.sandboxOpts, NARROW);
    }
  } finally { groupManager.destroyGroup(withOrch); groupManager.destroyGroup(withoutOrch); }
});

test('anything that is not a registered member keeps the client\'s values, exactly as before', async () => {
  const gid = await makeGroup({ roles: ['workerA'] });
  try {
    const asked = { sandbox: false, sandboxOpts: BROAD };
    const same = { member: false, forced: false, sandbox: false, sandboxOpts: BROAD };
    assert.deepEqual(groupManager.resolveMemberInitLaunch(null, null, asked), same, 'a plain session');
    assert.deepEqual(groupManager.resolveMemberInitLaunch(gid, null, asked), same, 'a groupId with no role');
    assert.deepEqual(groupManager.resolveMemberInitLaunch(null, 'workerA', asked), same, 'a role with no groupId');
    assert.deepEqual(groupManager.resolveMemberInitLaunch(randomUUID(), 'workerA', asked), same, 'a group that is not in the registry');
    assert.deepEqual(groupManager.resolveMemberInitLaunch(randomUUID(), 'orchestrator', asked), same, 'the orchestrator role of a group that is not in the registry');
    assert.deepEqual(groupManager.resolveMemberInitLaunch(gid, 'workerZ', asked), same, 'a role the group never registered');
    assert.deepEqual(groupManager.resolveMemberInitLaunch({ toString: () => gid }, { toString: () => 'workerA' }, asked), same, 'ids that are not strings');
    // ...including the no-sandbox default of an ordinary session.
    assert.deepEqual(groupManager.resolveMemberInitLaunch(gid, 'workerZ', {}), { member: false, forced: false, sandbox: false, sandboxOpts: null });
    // and the client's own sandbox:true stays true.
    assert.equal(groupManager.resolveMemberInitLaunch(null, null, { sandbox: true }).sandbox, true);
  } finally { groupManager.destroyGroup(gid); }
});

test('after a restart the registered sandboxOpts survive: from the saved session when there is one, else from memberPrefs', async () => {
  const gid = await makeGroup({
    roles: ['workerA', 'workerB'],
    memberPrefs: { workerA: { sandboxOpts: NARROW }, workerB: { sandboxOpts: NARROW } },
  });
  try {
    // workerA has a saved session (its own, narrower-than-broad options); workerB has none.
    const savedOpts = { gpg: false, sshAgent: true, gpgVault: false };
    writeFileSync(process.env.CCSERVER_SAVED_SESSIONS_PATH, JSON.stringify([
      { groupId: gid, groupRole: 'workerA', app: 'claude', cwd: projectDir, claudeSessionId: 'conv-a', sandbox: true, sandboxOpts: savedOpts },
    ]));
    simulateRestart(gid);
    const a = groupManager.resolveMemberInitLaunch(gid, 'workerA', { sandbox: false, sandboxOpts: BROAD });
    const b = groupManager.resolveMemberInitLaunch(gid, 'workerB', { sandbox: false, sandboxOpts: BROAD });
    assert.deepEqual(a.sandboxOpts, savedOpts, 'saved session first');
    assert.deepEqual(b.sandboxOpts, NARROW, 'memberPrefs when nothing was saved');
    assert.equal(a.sandbox && b.sandbox, true);
  } finally {
    rmSync(process.env.CCSERVER_SAVED_SESSIONS_PATH, { force: true });
    groupManager.destroyGroup(gid);
  }
});

test('a restored member with neither a live nor a saved session is listed as sandboxed', async () => {
  const gid = await makeGroup({ roles: ['workerA', 'orchestrator'] });
  try {
    simulateRestart(gid);   // nothing saved, no session
    const members = groupManager.listGroupMembers(gid);
    assert.deepEqual(members.map((m) => m.role).sort(), ['orchestrator', 'workerA']);
    for (const m of members) {
      assert.equal(m.restored, false, 'not even a saved session to restore from');
      assert.equal(m.sandbox, true, `${m.role}: the UI echoes this back in the re-launch, and draws its no-sandbox warning from it`);
    }
  } finally { groupManager.destroyGroup(gid); }
});

// --------------------------------------------------- what a real `init` launches

function fakeChan() {
  const sent = [];
  return { sent, readyState: 1, send(json) { sent.push(JSON.parse(json)); }, close() { this.readyState = 3; } };
}

// Runs one browser `init` with createSession replaced by a recorder, so what the
// handler hands over can be read without launching anything.
async function initAndRecord(msg) {
  const calls = [];
  terminal.setCreateSessionForTests(async (opts) => { calls.push(opts); return { error: 'stopped by the test' }; });
  try {
    const chan = fakeChan();
    await terminal.attachTerminalHandler(chan).handleMessage({ type: 'init', cols: 80, rows: 24, ...msg });
    return { calls, sent: chan.sent };
  } finally { terminal.setCreateSessionForTests(null); }
}

test('init: a registered member always reaches createSession with sandbox:true and its registered options', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const gid = await makeGroup({ roles: ['orchestrator', 'workerA'], memberPrefs: { workerA: { sandboxOpts: NARROW } } });
  try {
    for (const claimed of [{ sandbox: false, sandboxOpts: BROAD }, { sandbox: false, sandboxOpts: null }, {}, { sandbox: 0 }]) {
      const { calls } = await initAndRecord({ cwd: projectDir, groupId: gid, groupRole: 'workerA', ...claimed });
      assert.equal(calls.length, 1, `client said ${JSON.stringify(claimed)}`);
      assert.equal(calls[0].sandbox, true, `client said ${JSON.stringify(claimed)}`);
      assert.deepEqual(calls[0].sandboxOpts, NARROW);
      assert.equal(calls[0].groupId, gid);
      assert.equal(calls[0].groupRole, 'workerA');
    }
    const orch = await initAndRecord({ cwd: '/anywhere', groupId: gid, groupRole: 'orchestrator', sandbox: false, sandboxOpts: BROAD });
    assert.equal(orch.calls[0].sandbox, true);
    assert.equal(orch.calls[0].sandboxOpts, null, 'nothing registered for the orchestrator, so nothing granted');
    // A client that does ask for the sandbox is not overridden -- and not warned about.
    warn.mock.resetCalls();
    const fine = await initAndRecord({ cwd: projectDir, groupId: gid, groupRole: 'workerA', sandbox: true });
    assert.equal(fine.calls[0].sandbox, true);
    assert.equal(warn.mock.calls.filter((c) => c.arguments.join(' ').includes('[terminal]')).length, 0);
  } finally { groupManager.destroyGroup(gid); }
});

test('init: overriding a member says so, and only says so', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const gid = await makeGroup({ roles: ['workerA'], memberPrefs: { workerA: { sandboxOpts: NARROW } } });
  try {
    await initAndRecord({ cwd: projectDir, groupId: gid, groupRole: 'workerA', sandbox: false, sandboxOpts: BROAD });
    const lines = warn.mock.calls.map((c) => c.arguments.join(' ')).filter((l) => l.includes('[terminal]'));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /workerA/);
    assert.match(lines[0], /did not ask for a sandbox/);
    assert.doesNotMatch(lines[0], new RegExp(projectDir.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')), 'no path');
    assert.doesNotMatch(lines[0], /gpg|ssh|token|secret/i, 'nothing about credentials or options');
  } finally { groupManager.destroyGroup(gid); }
});

test('init: a session that is not a registered member is passed through exactly as before', async () => {
  const gid = await makeGroup({ roles: ['workerA'] });
  try {
    const plain = await initAndRecord({ cwd: projectDir, sandbox: false, sandboxOpts: BROAD });
    assert.equal(plain.calls[0].sandbox, false);
    assert.deepEqual(plain.calls[0].sandboxOpts, BROAD);
    const plainSandboxed = await initAndRecord({ cwd: projectDir, sandbox: true });
    assert.equal(plainSandboxed.calls[0].sandbox, true);
    assert.equal(plainSandboxed.calls[0].sandboxOpts, null);
    // A groupId alone (or a groupRole alone) does not make it a member.
    const idOnly = await initAndRecord({ cwd: projectDir, groupId: gid, sandbox: false });
    assert.equal(idOnly.calls[0].sandbox, false);
    const roleOnly = await initAndRecord({ cwd: projectDir, groupRole: 'workerA', sandbox: false });
    assert.equal(roleOnly.calls[0].sandbox, false);
  } finally { groupManager.destroyGroup(gid); }
});

test('init: claiming a role the group never had is refused before anything is launched', async () => {
  const gid = await makeGroup({ roles: ['workerA'] });
  try {
    const { calls, sent } = await initAndRecord({ cwd: projectDir, groupId: gid, groupRole: 'workerZ', sandbox: false });
    assert.equal(calls.length, 0, 'createSession is never reached');
    assert.equal(sent.find((m) => m.type === 'error')?.code, 'SPAWN_FAILED');
    const gone = await initAndRecord({ cwd: projectDir, groupId: randomUUID(), groupRole: 'orchestrator', sandbox: false });
    assert.equal(gone.calls.length, 0, 'nor for a group that is not in the registry');
  } finally { groupManager.destroyGroup(gid); }
});

// ------------------------------------ a scheduled prompt resuming a member

// The other way a member is launched without a browser: a persisted schedule fires
// while no session is alive (server/ws/sessionManager.js's fireSchedule) and creates
// the session from the entry. An entry written while a member ran on the host -- the
// hole above -- says sandbox:false and whatever sandboxOpts its client chose; the
// entry survives an upgrade, so it must not decide the launch.
//
// What the resume asks createSession for is what is asserted, through the launcher seam
// (as for `init` above): it needs no sandbox on the host running the test, and what
// createSession would report back (effective, normalized options) cannot blur it.
async function fireScheduleOf(t, gid, role, entryExtra = {}) {
  const warn = t.mock.method(console, 'warn', () => {});
  const launches = [];
  sessionManager.setScheduleLaunchForTests(async (opts) => { launches.push(opts); return { error: 'stopped by the test' }; });
  t.after(() => sessionManager.setScheduleLaunchForTests(null));
  writeFileSync(process.env.CCSERVER_SCHEDULES_PATH, JSON.stringify([{
    at: Date.now() + 200, text: 'noop', cwd: projectDir, shell: true, app: 'claude', permissionMode: 'standard',
    groupId: gid, groupRole: role, source: 'manual', ...entryExtra,
  }]));
  assert.equal(sessionManager.restoreSchedules().restored, 1);
  const dropped = () => warn.mock.calls.map((c) => c.arguments.join(' ')).find((l) => l.includes('[scheduler] dropping prompt') && l.includes('not a registered member'));
  await until(() => launches.length > 0 || dropped(), 'the schedule to fire');
  return { launches, dropped: dropped() };
}

test('a scheduled prompt resumes a member sandboxed with its registered options, whatever the entry recorded', async (t) => {
  const OFF = { gpg: false, sshAgent: false, gpgVault: false };
  const gid = await makeGroup({ roles: ['workerA'], memberPrefs: { workerA: { sandboxOpts: OFF } } });
  try {
    simulateRestart(gid);
    const { launches, dropped } = await fireScheduleOf(t, gid, 'workerA', { sandbox: false, sandboxOpts: BROAD });
    assert.equal(launches.length, 1, `the resume reached createSession (dropped: ${dropped})`);
    assert.equal(launches[0].sandbox, true, 'a member whose entry said sandbox:false is resumed sandboxed');
    assert.deepEqual(launches[0].sandboxOpts, OFF, 'with what was registered for it, not what the entry recorded');
    assert.equal(launches[0].groupId, gid);
    assert.equal(launches[0].groupRole, 'workerA');
    assert.ok(launches[0].mcpSocketPath, 'and still with its handoff channel');
  } finally { groupManager.destroyGroup(gid); }
});

test('a scheduled prompt of a role the group never had is dropped, and no channel is made for it', async (t) => {
  const gid = await makeGroup({ roles: ['workerA'] });
  try {
    const { launches, dropped } = await fireScheduleOf(t, gid, 'workerZ', { sandbox: false });
    assert.equal(launches.length, 0, 'nothing was launched for it');
    assert.match(dropped, /workerZ of .*not a registered member/);
    assert.equal(groupManager.getGroup(gid).handoffChannels.has('workerZ'), false, 'nothing was minted for the unknown role');
    assert.equal(groupManager.getGroup(gid).members.has('workerZ'), false);
  } finally { groupManager.destroyGroup(gid); }
});

// ------------------------------------------- a real re-launch after a restart

// Can a sandbox really be built here? (The same probe the CI job uses.)
const BWRAP_RUNS = process.platform === 'linux' && existsSync('/usr/bin/bwrap')
  && spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true']).status === 0;

test('a member re-launched after a restart really runs in its own mount namespace, however its client asked', {
  skip: !BWRAP_RUNS && 'no working bwrap here: this is what the bwrap CI job runs',
}, async (t) => {
  assert.equal(sandboxModule.sandboxAvailable(), true);
  const gid = await makeGroup({ roles: ['orchestrator'] });
  let sessionId = null;
  try {
    simulateRestart(gid);   // the member is registered, but nothing was saved for it
    const chan = fakeChan();
    const handler = terminal.attachTerminalHandler(chan);
    const [member] = groupManager.listGroupMembers(gid);
    // What a browser sends when the tab was opened from a stale or empty view.
    await handler.handleMessage({
      type: 'init', cols: 80, rows: 24, shell: true, cwd: member.cwd || projectDir,
      sandbox: false, sandboxOpts: BROAD, groupId: gid, groupRole: 'orchestrator',
    });
    const reply = chan.sent.find((m) => m.type === 'session');
    assert.ok(reply, `the re-launch was accepted: ${JSON.stringify(chan.sent.find((m) => m.type === 'error'))}`);
    sessionId = reply.sessionId;
    assert.equal(reply.sandbox, true, 'the session reports that it is sandboxed');

    const session = sessionManager.getSession(sessionId);
    assert.equal(session.sandbox, true);
    assert.deepEqual(session.sandboxOpts, null, 'and did not get the options the client asked for');

    // The proof that counts: the shell's own mount namespace is not the server's.
    sessionManager.writeToSession(sessionId, "printf 'NS=%s\\n' \"$(readlink /proc/self/ns/mnt)\"\r");
    await until(() => /NS=mnt:\[\d+\]/.test(session.outputBuffer.join('')) || session.exited,
      'the shell to print its mount namespace');
    const printed = session.outputBuffer.join('');
    if (session.exited && /^bwrap: /m.test(printed)) {
      // bwrap failed while ASSEMBLING the sandbox (a bind source it cannot mount:
      // seen when this runs inside a ccserver sandbox, where the host's
      // ~/.claude.json is a stale bind -- run with a clean HOME). It did try to
      // build one, which the launch would not have done unsandboxed, but nothing
      // about the namespace was measured, so say so rather than pass or fail.
      t.skip(`bwrap could not assemble the sandbox on this host: ${printed.split('\n').find((l) => /^bwrap: /.test(l))}`);
      return;
    }
    assert.ok(!session.exited, `the sandboxed shell exited (code ${session.exitCode}): ${JSON.stringify(printed.slice(-600))}`);
    const inside = /NS=(mnt:\[\d+\])/.exec(session.outputBuffer.join(''))[1];
    assert.notEqual(inside, readlinkSync('/proc/self/ns/mnt'), 'the member is not in the server\'s mount namespace');
  } finally {
    if (sessionId) sessionManager.destroySession(sessionId);
    groupManager.destroyGroup(gid);
  }
});
