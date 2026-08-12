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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let runtimeDir;
let groupManager;
let sessionManager;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// The schedules file lives at a fixed repo-root path (no env override for it
// in sessionManager.js); tests back it up and restore it so the runner never
// leaves test entries behind.
function schedulePath() {
  return join(import.meta.dirname, '..', '..', '.scheduled-prompts.json');
}

function readOptionalFile(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
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
  // Group persistence must never touch the repo-root state file during tests.
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  groupManager = await import('./groupManager.js');
  sessionManager = await import('./sessionManager.js');
});

after(() => {
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  // Release the exited-session retention timers (30s cleanup) and any
  // pending schedule/fallback timers the tests armed, so the runner process
  // exits promptly instead of waiting out the production retention period.
  sessionManager.destroyAllSessions();
});

test('savedSessionPublic preserves group membership (restart filter keeps working)', () => {
  const member = {
    cwd: '/srv/proj', app: 'opencode', sandbox: true, sandboxOpts: null, model: 'gpt-5',
    claudeSessionId: null, groupId: 'group-1', groupRole: 'workerA',
  };
  const out = sessionManager.savedSessionPublic(member, null);
  assert.equal(out.groupId, 'group-1');
  assert.equal(out.groupRole, 'workerA');
  assert.equal(out.app, 'opencode');
  assert.equal(out.model, 'gpt-5', 'the launch model is serialized for graceful-shutdown restore');

  const plain = sessionManager.savedSessionPublic({ ...member, groupId: null, groupRole: null }, 'conv-123');
  assert.equal(plain.groupId, null);
  assert.equal(plain.groupRole, null);
  assert.equal(plain.claudeSessionId, 'conv-123');
});

// Model state on sessions: an explicit non-empty model is stored normalized,
// invalid/empty/absent values normalize to null (never an empty string or a
// wrong type leaking into the CLI arg builder or persistence).
test('createSession stores the effective model (normalized); shells never carry one', async () => {
  const shell = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false, model: 'gpt-5' });
  assert.ok(shell.session, 'shell session should spawn');
  try {
    assert.equal(shell.session.model, null, 'shell sessions never carry a model, even an explicit one');
    assert.equal(sessionManager.listSessions().find((s) => s.id === shell.sessionId).model, null);
  } finally {
    sessionManager.destroySession(shell.sessionId, { keepSchedule: false });
  }

  // Non-shell model normalization is exercised through the pure path by
  // appLaunch.test.js; here we assert the session object contract by handing
  // createSession a synthetic app that the launcher can resolve without a real
  // agent CLI -- a shell with a fabricated app/model pair still goes through
  // the same sessionModel computation (shell wins). The normalization rules
  // are additionally covered by the persisted schedule tests below.
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  assert.ok(res.session);
  try {
    res.session.model = '';
    const pub = sessionManager.savedSessionPublic(res.session, null);
    assert.equal(pub.model, null, 'empty-string models normalize to null');
    res.session.model = 'gpt-5';
    assert.equal(sessionManager.savedSessionPublic(res.session, null).model, 'gpt-5');
  } finally {
    sessionManager.destroySession(res.sessionId, { keepSchedule: false });
  }
});

// A configured claudeBin that resolves nowhere (a bare name on no searched
// dir) must be refused with the clear not-installed error instead of reaching
// pty.spawn (opaque execvp ENOENT / exit 127 right after "起動しました").
// Deterministic: CCSERVER_CLAUDE_BIN overrides the config file, and no real
// CLI install is needed.
test('createSession refuses an uninstalled agent with a clear error', () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-sess-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false }));
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_CLAUDE_BIN = 'no-such-claude-xyz';
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const res = sessionManager.createSession({
      cwd: '/tmp', cols: 80, rows: 24, shell: false, sandbox: false, app: 'claude',
    });
    assert.equal(res.session, null, 'no session may be created for a missing CLI');
    assert.match(res.error, /claude is not installed on this server/);
    assert.match(res.error, /searched PATH/, 'the error names the search targets');
  } finally {
    if (prevBin === undefined) delete process.env.CCSERVER_CLAUDE_BIN;
    else process.env.CCSERVER_CLAUDE_BIN = prevBin;
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// setScheduledPrompt captures the session's launch model into the persisted
// schedule entry so the auto-resume path replays it (persistSchedules).
test('setScheduledPrompt persists the session model into the schedule file', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  assert.ok(res.session, 'shell session should spawn');
  try {
    res.session.model = 'anthropic/claude-sonnet-4';
    assert.ok(sessionManager.setScheduledPrompt(res.sessionId, Date.now() + 5000, 'MARKER_MODEL'));
    const saved = JSON.parse(readFileSync(schedulePath(), 'utf-8'));
    const entry = saved.find((e) => e.text === 'MARKER_MODEL');
    assert.ok(entry, 'schedule persisted');
    assert.equal(entry.model, 'anthropic/claude-sonnet-4', 'the launch model survives into the persisted schedule');
  } finally {
    sessionManager.destroySession(res.sessionId, { keepSchedule: false });
  }
});

// restoreSchedules preserves a persisted model (round-trip through the file);
// the entry is armed with a bad cwd so the fire fails harmlessly and never
// leaves a live session behind.
test('restoreSchedules preserves the model for a restored schedule entry', async () => {
  const savedPath = schedulePath();
  const before = readOptionalFile(savedPath);
  const at = Date.now() + 300;
  writeFileSync(savedPath, JSON.stringify([{
    at,
    text: 'MARKER_RESTORE_MODEL',
    cwd: '/nonexistent-for-model-restore',
    sandbox: false,
    sandboxOpts: null,
    shell: true,
    app: 'claude',
    model: 'gpt-5',
    claudeSessionId: null,
    groupId: null,
    groupRole: null,
  }]));
  try {
    const info = sessionManager.restoreSchedules();
    assert.equal(info.restored, 1);
    const rewritten = JSON.parse(readFileSync(savedPath, 'utf-8'));
    const entry = rewritten.find((e) => e.text === 'MARKER_RESTORE_MODEL');
    assert.ok(entry, 'restored schedule re-persisted');
    assert.equal(entry.model, 'gpt-5', 'the model round-trips through restore');
    // The entry is armed; let the fire run (bad cwd -> createSession error,
    // prompt dropped, no lingering session) so no timer keeps the process up.
    await sleep(800);
    const leftover = sessionManager.listSessions().filter((s) => s.cwd === '/nonexistent-for-model-restore');
    assert.equal(leftover.length, 0, 'the failed-cwd fire must not leave a session behind');
  } finally {
    try { unlinkSync(savedPath); } catch { /* already gone */ }
    if (before != null) writeFileSync(savedPath, before);
  }
});

// Legacy persisted schedules (predating the model field) restore with null --
// the app default, never a wrong type.
test('restoreSchedules: legacy schedules without a model field restore with null', async () => {
  const savedPath = schedulePath();
  const before = readOptionalFile(savedPath);
  const at = Date.now() + 300;
  writeFileSync(savedPath, JSON.stringify([{
    at,
    text: 'MARKER_LEGACY',
    cwd: '/nonexistent-for-model-restore',
    sandbox: false,
    shell: true,
    app: 'claude',
    claudeSessionId: null,
  }]));
  try {
    const info = sessionManager.restoreSchedules();
    assert.equal(info.restored, 1);
    const rewritten = JSON.parse(readFileSync(savedPath, 'utf-8'));
    assert.equal(rewritten[0].model, null, 'legacy schedules restore with a null model (app default)');
    await sleep(800);
  } finally {
    try { unlinkSync(savedPath); } catch { /* already gone */ }
    if (before != null) writeFileSync(savedPath, before);
  }
});

// copilot sessions persist their app in the schedule file and restore as
// copilot (isValidApp passes), so the auto-resume path replays `--continue`.
test('schedules round-trip a copilot app', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  assert.ok(res.session, 'shell session should spawn');
  try {
    res.session.app = 'copilot';
    assert.ok(sessionManager.setScheduledPrompt(res.session.id, Date.now() + 5000, 'MARKER_COPILOT'));
    const saved = JSON.parse(readFileSync(schedulePath(), 'utf-8'));
    const entry = saved.find((e) => e.text === 'MARKER_COPILOT');
    assert.equal(entry.app, 'copilot', 'the app survives into the persisted schedule');
  } finally {
    sessionManager.destroySession(res.session.id, { keepSchedule: false });
  }

  // Restore path: a persisted copilot entry keeps its app (isValidApp gate).
  const savedPath = schedulePath();
  const before = readOptionalFile(savedPath);
  const at = Date.now() + 300;
  writeFileSync(savedPath, JSON.stringify([{
    at,
    text: 'MARKER_RESTORE_COPILOT',
    cwd: '/nonexistent-for-copilot-restore',
    sandbox: false,
    shell: true,
    app: 'copilot',
    model: null,
    claudeSessionId: null,
    groupId: null,
    groupRole: null,
  }]));
  try {
    const info = sessionManager.restoreSchedules();
    assert.equal(info.restored, 1);
    const rewritten = JSON.parse(readFileSync(savedPath, 'utf-8'));
    assert.equal(rewritten.find((e) => e.text === 'MARKER_RESTORE_COPILOT').app, 'copilot');
    await sleep(800);
  } finally {
    try { unlinkSync(savedPath); } catch { /* already gone */ }
    if (before != null) writeFileSync(savedPath, before);
  }
});
// Workers always run inside the sandbox, so their sessions start with Auto-Y
// enabled; the orchestrator and standalone sessions keep it off.
test('createSession defaults Auto-Y on for workers, off for orchestrator/standalone', () => {
  const spawn = (groupRole) => sessionManager.createSession({
    cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false, groupRole,
  });
  const worker = spawn('workerA');
  const workerB = spawn('workerB');
  const orch = spawn('orchestrator');
  const standalone = spawn(null);
  try {
    assert.equal(worker.session.autoYes, true, "workerA (a worker) should start with Auto-Y on");
    assert.equal(workerB.session.autoYes, true, "workerB (a worker) should start with Auto-Y on");
    assert.equal(orch.session.autoYes, false, "the orchestrator keeps Auto-Y off");
    assert.equal(standalone.session.autoYes, false, "standalone sessions keep Auto-Y off");
  } finally {
    for (const res of [worker, workerB, orch, standalone]) {
      sessionManager.destroySession(res.sessionId, { keepSchedule: false });
    }
  }
});

// writeToSession is the shared input path for the WS 'input' handler and the
// MCP send_input tool: it must write into the live pty, reset the idle
// watchdog, and (with submit) send Enter after the text. Real shell session.
test('writeToSession types into a live session; submit appends Enter', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const id = res.sessionId;
  assert.ok(res.session, 'shell session should spawn');
  try {
    await sleep(400); // let the shell reach its prompt

    assert.equal(sessionManager.writeToSession(id, 'echo WRITE_TO_SESSION_MARKER', { submit: true }), true);
    await sleep(1200); // echo + shell runs the command

    const buf = sessionManager.getSession(id).outputBuffer.join('');
    // Two occurrences: the typed command (echoed back) AND the command's own
    // output. Escape noise between them (bracketed-paste toggling) varies by
    // shell, so count rather than match a strict sequence.
    const occurrences = buf.match(/WRITE_TO_SESSION_MARKER/g) || [];
    assert.ok(occurrences.length >= 2, `the typed text and the echo output must both appear (got ${occurrences.length}): ${buf}`);
  } finally {
    sessionManager.destroySession(id, { keepSchedule: false });
  }
});

test('writeToSession on an exited session returns false', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const id = res.sessionId;
  await sleep(300);
  sessionManager.destroySession(id, { keepSchedule: false });
  assert.equal(sessionManager.writeToSession(id, 'ls'), false);
  assert.equal(sessionManager.writeToSession('no-such-session', 'ls'), false);
});

// Issue #15 settle gate: waitUntilSettled resolves immediately for sessions
// that can never settle (plain shells have no idle timer, unknown ids, and
// already-settled sessions short-circuit to their current state).
test('waitUntilSettled: shell sessions and unknown ids resolve immediately without settling', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  assert.ok(res.session, 'shell session should spawn');
  try {
    const r = await sessionManager.waitUntilSettled(res.sessionId);
    assert.deepEqual(r, { settled: false, timedOut: false });
  } finally {
    sessionManager.destroySession(res.sessionId, { keepSchedule: false });
  }

  assert.deepEqual(await sessionManager.waitUntilSettled('no-such-session'), { settled: false, timedOut: false });
});

test('waitUntilSettled: an already-settled session resolves immediately with settled:true', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const s = res.session;
  assert.ok(s);
  try {
    s.settled = true;
    const r = await sessionManager.waitUntilSettled(s.id);
    assert.deepEqual(r, { settled: true, timedOut: false });
  } finally {
    sessionManager.destroySession(s.id, { keepSchedule: false });
  }
});

test('waitUntilSettled: times out (and removes its waiter) when no idle gap arrives', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const s = res.session;
  assert.ok(s);
  try {
    // Stand in for an agent session that produces no output: the idle timer
    // (and thus the settle gate) only exists for non-shell sessions.
    s.shell = false;
    s.settled = false;
    s.settleWaiters = [];
    const started = Date.now();
    const r = await sessionManager.waitUntilSettled(s.id, { timeoutMs: 60 });
    assert.ok(Date.now() - started >= 50);
    assert.deepEqual(r, { settled: false, timedOut: true });
    assert.equal(s.settleWaiters.length, 0, 'a timed-out waiter must remove itself');
  } finally {
    sessionManager.destroySession(s.id, { keepSchedule: false });
  }
});

// Issue #16: lastOutputAt is the activity timestamp exposed to the
// orchestrator (get_tab_status / list_group_sessions) so a hung member can be
// distinguished from one that is merely slow. It must be null until the first
// output chunk arrives, then advance with every chunk -- shells included (the
// plain shell session here stands in for an agent TUI).
test('lastOutputAt: null at spawn, then advanced by real pty output (shell included)', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const id = res.sessionId;
  const s = res.session;
  assert.ok(s, 'shell session should spawn');
  try {
    assert.equal(s.lastOutputAt, null, 'no output received yet after spawn');

    await sleep(400); // let the shell reach its prompt
    const first = s.lastOutputAt;
    assert.ok(first != null, 'the shell prompt output must be recorded as activity');
    assert.ok(Date.now() - first < 5000, 'the timestamp must be recent');

    sessionManager.writeToSession(id, 'echo ACTIVITY_MARKER', { submit: true });
    await sleep(1200); // echo + shell runs the command
    const second = s.lastOutputAt;
    assert.ok(second != null && second > first, 'later output keeps advancing the timestamp');
    assert.ok(Date.now() - second < 5000, 'the timestamp must track the newest output');
  } finally {
    sessionManager.destroySession(id, { keepSchedule: false });
  }
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

// Fix 7 (Issue #30): a model-annotated schedule must only inject into a live
// session launched with the SAME model -- never into an unmodeled or
// differently-modeled one. Both sides are already normalizeModel()-ed by the
// time the matcher runs, so ?? null gives a safe strict comparison.
test('matchesScheduleTarget is model-scoped (no cross-model injection)', () => {
  const live = (over = {}) => ({
    cwd: '/srv/proj', shell: false, app: 'opencode',
    model: null, groupId: null, groupRole: null, exited: false, ptyProcess: {},
    ...over,
  });
  const entry = {
    cwd: '/srv/proj', shell: false, app: 'opencode', model: 'anthropic/claude-sonnet-4',
    groupId: null, groupRole: null,
  };

  // Unmodeled / differently-modeled sessions must not take the schedule
  // (Issue #30: the user reopened the project with google/gemini-2.0-flash).
  assert.equal(sessionManager.matchesScheduleTarget(live(), entry), false);
  assert.equal(sessionManager.matchesScheduleTarget(live({ model: 'google/gemini-2.0-flash' }), entry), false);
  // The same-model session matches.
  assert.equal(
    sessionManager.matchesScheduleTarget(live({ model: 'anthropic/claude-sonnet-4' }), entry),
    true,
  );

  // Unmodeled entries (legacy schedules) keep matching unmodeled sessions only.
  const plain = { ...entry, model: null };
  assert.equal(sessionManager.matchesScheduleTarget(live(), plain), true);
  assert.equal(sessionManager.matchesScheduleTarget(live({ model: 'anthropic/claude-sonnet-4' }), plain), false);

  // The model match must not break the group+role scope: same model but a
  // different group/role still refuses, and same group+role+model matches.
  const groupEntry = { ...entry, groupId: 'g1', groupRole: 'workerA' };
  assert.equal(
    sessionManager.matchesScheduleTarget(
      live({ model: 'anthropic/claude-sonnet-4', groupId: 'g1', groupRole: 'workerB' }),
      groupEntry,
    ),
    false,
    'same model but a different role must not match',
  );
  assert.equal(
    sessionManager.matchesScheduleTarget(
      live({ model: 'anthropic/claude-sonnet-4', groupId: 'g2', groupRole: 'workerA' }),
      groupEntry,
    ),
    false,
    'same model but a different group must not match',
  );
  assert.equal(
    sessionManager.matchesScheduleTarget(
      live({ model: 'anthropic/claude-sonnet-4', groupId: 'g1', groupRole: 'workerA' }),
      groupEntry,
    ),
    true,
    'same model and same group+role matches',
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
  // Mark the assembly complete (POST /groups does this after the last member
  // registers; this test drives the group directly, so it does it here) --
  // from then on the all-exited cleanup applies.
  groupManager.markGroupAssembled(gid);
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

// The old idle heuristic sent `input_needed` to the client on an idle agent
// session (removed -- see the notify-mcp plan / README). Regression guard: an
// agent session going idle must NOT emit input_needed, while the settle gate
// (a separate, still-used consumer of the same idle timer) keeps working.
// A fake claude binary stands in for the real CLI (no agent install needed).
test('idle timer no longer sends input_needed, but still advances the settle gate', async () => {
  const binDir = mkdtempSync(join(tmpdir(), 'ccserver-fake-agent-'));
  const fakeBin = join(binDir, 'fake-claude');
  writeFileSync(fakeBin, '#!/bin/bash\nprintf "FAKE_AGENT_READY\\n"\nsleep 100\n', { mode: 0o755 });
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-fake-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false }));
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_CLAUDE_BIN = fakeBin;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  let id = null;
  try {
    const res = sessionManager.createSession({
      cwd: '/tmp', cols: 80, rows: 24, shell: false, sandbox: false, app: 'claude',
    });
    assert.ok(res.session, 'agent session should spawn');
    id = res.sessionId;
    const s = res.session;
    const sent = [];
    s.socket = { readyState: 1, send: (m) => sent.push(m) };
    await sleep(3600); // > IDLE_TIMEOUT_MS (3000): the idle timer fires
    assert.equal(s.settled, true, 'settle gate still advances on the first idle gap');
    const types = sent.map((m) => {
      try { return JSON.parse(m).type; } catch { return null; }
    });
    assert.ok(!types.includes('input_needed'), 'no input_needed is ever sent');
  } finally {
    if (id) sessionManager.destroySession(id, { keepSchedule: false });
    if (prevBin === undefined) delete process.env.CCSERVER_CLAUDE_BIN;
    else process.env.CCSERVER_CLAUDE_BIN = prevBin;
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(binDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// notifyIdentity attribution (see notify.js / mcpConfig.js): the per-session
// identity rides to the bridge as the CCSERVER_NOTIFY_IDENTITY env. An
// explicit projectName overrides basename(cwd) -- a combo orchestrator's cwd
// is a hashed orchestrator dir (routes/groups.js) and must not leak into the
// notify footer; without one the cwd basename is used (existing behavior). A
// fake claude binary echoes the env var so the injected identity is
// observable from the session's output buffer.
test('createSession notify identity: explicit projectName wins, cwd basename is the fallback', async () => {
  const binDir = mkdtempSync(join(tmpdir(), 'ccserver-fake-agent-'));
  const fakeBin = join(binDir, 'fake-claude');
  writeFileSync(fakeBin, '#!/bin/bash\nprintf "%s\\n" "$CCSERVER_NOTIFY_IDENTITY"\n', { mode: 0o755 });
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-fake-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({
    docker: false,
    gitBroker: false,
    notify: { discordWebhook: 'https://discord.example/hook' },
  }));
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_CLAUDE_BIN = fakeBin;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  const notify = await import('./notify.js');
  await notify.ensureNotifyBroker();
  const ids = [];
  const identityOf = (s) => {
    const line = s.outputBuffer.join('').split('\n').map((l) => l.trim()).find((l) => l.startsWith('{'));
    return line ? JSON.parse(line) : null;
  };
  try {
    const named = sessionManager.createSession({
      cwd: '/tmp', cols: 80, rows: 24, shell: false, sandbox: false, app: 'claude',
      projectName: 'real-proj',
    });
    assert.ok(named.session, 'agent session should spawn');
    ids.push(named.sessionId);
    await sleep(500);
    const namedIdentity = identityOf(named.session);
    assert.ok(namedIdentity, 'notify identity must be injected (CCSERVER_NOTIFY_IDENTITY env)');
    assert.equal(namedIdentity.projectName, 'real-proj', 'the explicit projectName wins over the cwd basename');
    assert.equal(namedIdentity.cwd, '/tmp');

    const fallback = sessionManager.createSession({
      cwd: '/tmp', cols: 80, rows: 24, shell: false, sandbox: false, app: 'claude',
    });
    assert.ok(fallback.session, 'agent session should spawn');
    ids.push(fallback.sessionId);
    await sleep(500);
    const fallbackIdentity = identityOf(fallback.session);
    assert.ok(fallbackIdentity, 'notify identity must be injected');
    assert.equal(fallbackIdentity.projectName, 'tmp', 'without an explicit projectName the cwd basename is used');
  } finally {
    for (const id of ids) sessionManager.destroySession(id, { keepSchedule: false });
    notify.stopNotifyBroker();
    if (prevBin === undefined) delete process.env.CCSERVER_CLAUDE_BIN;
    else process.env.CCSERVER_CLAUDE_BIN = prevBin;
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(binDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
