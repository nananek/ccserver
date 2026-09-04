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
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn as spawnProcess } from 'node:child_process';
import Fastify from 'fastify';
import { sessionsRoute } from '../routes/sessions.js';
import { persistentHomeDir } from './sandbox.js';
import { metaAgentDir } from './metaAgent.js';
import { findSessionLimitReset } from './sessionLimitDetect.js';
import { getLatestSessionLimitReset } from '../sessionLimitState.js';

let runtimeDir;
let groupManager;
let sessionManager;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Renders `epochMs` as claude's own "resets HH:MMam/pm" wall-clock format in
// the given IANA zone, for building a realistic session-limit message.
function zonedTimeString(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(epochMs));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.hour}:${map.minute}${map.dayPeriod.toLowerCase()}`;
}

// Builds a realistic "You've hit your session limit" line resetting at
// `epochMs` in `timeZone` (default Asia/Tokyo, matching the plan's example).
function sessionLimitLine(epochMs, timeZone = 'Asia/Tokyo') {
  return `You've hit your session limit · resets ${zonedTimeString(epochMs, timeZone)} (${timeZone})`;
}

// Single-quotes a string for a POSIX shell command line (the message itself
// contains an apostrophe -- "You've" -- so a naive `'${line}'` would close
// the quote early and hand the rest to bash as unquoted syntax).
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
  // generateOrchestratorClaudeMdSrc's output dir must never land under the
  // real home directory during tests -- see the env override in groupManager.js.
  process.env.CCSERVER_ORCHESTRATOR_GENERATED_ROOT = join(runtimeDir, 'orchestrator-generated');
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

// The delayed submit after the typed text must be the app's submit key from
// appLaunch.appSubmitKey -- CR for every current CLI (Codex included) -- and
// never a bare LF. A stub pty records every write so the exact byte sequence
// is asserted.
test('writeToSession submit writes the body then the app submit key (CR), never LF', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const id = res.sessionId;
  const s = res.session;
  try {
    const writes = [];
    s.app = 'codex'; // stand in for any agent TUI
    // Recording shim around the REAL pty: teardown must still reach it, or
    // the orphaned process/fd keeps the test runner's event loop alive.
    const realPty = s.ptyProcess;
    s.ptyProcess = {
      write: (data) => { writes.push(data); return realPty.write(data); },
      kill: () => realPty.kill(),
      destroy: () => realPty.destroy(),
    };
    assert.equal(sessionManager.writeToSession(id, 'review the diff', { submit: true }), true);
    assert.deepEqual(writes, ['review the diff'], 'only the body is written synchronously');
    await sleep(350); // past the 200ms delayed submit
    assert.deepEqual(writes, ['review the diff', '\r'], 'the delayed submit must be exactly CR');
    assert.ok(!writes.includes('\n'), 'LF must never be sent as a submit key');
  } finally {
    sessionManager.destroySession(id, { keepSchedule: false });
  }
});

// send_key backend (Codex "Create a plan?" modal recovery): the whitelisted
// escape key writes exactly one ESC byte -- no delayed CR, no extra bytes --
// and nothing outside the whitelist is writable at all.
test('writeKeyToSession: escape writes exactly one ESC, never a CR', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const id = res.sessionId;
  const s = res.session;
  try {
    await sleep(150);
    const writes = [];
    const realPty = s.ptyProcess; // teardown must reach the real pty (see above)
    s.ptyProcess = {
      write: (data) => writes.push(data),
      kill: () => realPty.kill(),
      destroy: () => realPty.destroy(),
    };
    assert.equal(sessionManager.writeKeyToSession(id, 'escape'), true);
    assert.deepEqual(writes, ['\x1b'], 'exactly one ESC byte');
    // No delayed submit follows (wait past writeToSession's 200ms delay).
    await sleep(300);
    assert.deepEqual(writes, ['\x1b']);
  } finally {
    sessionManager.destroySession(id, { keepSchedule: false });
  }
});

test('writeKeyToSession: unknown keys are refused and write nothing; dead/missing sessions return false', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const id = res.sessionId;
  const s = res.session;
  try {
    const writes = [];
    const realPty = s.ptyProcess; // teardown must reach the real pty (see above)
    s.ptyProcess = {
      write: (data) => writes.push(data),
      kill: () => realPty.kill(),
      destroy: () => realPty.destroy(),
    };
    // No raw bytes / control chars / other keys beyond 'escape'.
    for (const bad of ['ctrl-c', 'enter', '\x03', '\x1b[A', '{"raw":true}', 'ESC', undefined]) {
      assert.equal(sessionManager.writeKeyToSession(id, bad), false, `key ${JSON.stringify(bad)} must be refused`);
    }
    assert.deepEqual(writes, [], 'a refused key must never reach the pty');
  } finally {
    sessionManager.destroySession(id, { keepSchedule: false });
  }

  assert.equal(sessionManager.writeKeyToSession('no-such-session', 'escape'), false);
  assert.equal(sessionManager.writeKeyToSession(id, 'escape'), false, 'an exited/destroyed session refuses keys too');
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

// Orchestrator CLAUDE.md/AGENTS.md ro-bind overlay (see groupManager's
// generateOrchestratorClaudeMdSrc): the auto-resume path must regenerate it
// on every respawn, same resolver-registration pattern as mcpSocketPath. The
// dead session here is shell-spawned (sandbox: false, like shellMember uses
// throughout this file), so the observable proof that the resolver actually
// ran end-to-end is the role being rebound at all -- had resolution failed,
// the fail-closed guard below would have dropped the resume entirely and
// left the role bound to the dead session forever.
test('fireSchedule auto-resume of a dead orchestrator regenerates its CLAUDE.md overlay and rebinds the role', async () => {
  const gid = randomUUID();
  const orchestratorDir = join(runtimeDir, `orch-resume-${gid}`);
  await groupManager.createGroup({ groupId: gid, cwd: '/tmp', orchestratorDir });

  const workerKeepAlive = shellMember('/tmp', gid, 'workerA'); // keeps the group alive
  const deadOrch = shellMember('/tmp', gid, 'orchestrator');
  const deadOrchId = deadOrch.id;

  const generatedPath = join(process.env.CCSERVER_ORCHESTRATOR_GENERATED_ROOT, `${basename(orchestratorDir)}.md`);
  assert.equal(existsSync(generatedPath), false, 'nothing generated yet before the first (re)spawn');

  assert.ok(sessionManager.setScheduledPrompt(deadOrch.id, Date.now() + 700, 'MARKER_ORCH_RESUME'));
  sessionManager.destroySession(deadOrch.id); // keepSchedule defaults true

  await sleep(2500); // branch 3: resolvers (mcpSocketPath + orchestratorClaudeMdSrc) + createSession

  const group = groupManager.getGroup(gid);
  assert.ok(group, 'group survives (workerA alive)');
  const member = group.members.get('orchestrator');
  assert.ok(member, 'orchestrator still registered');
  assert.notEqual(member, deadOrchId, 'role rebound to the resumed session -- proves the overlay resolver did not drop the prompt');

  assert.ok(existsSync(generatedPath), 'the CLAUDE.md/AGENTS.md overlay source was (re)generated for the resume');
  const template = readFileSync(join(import.meta.dirname, 'orchestrator-template.md'), 'utf-8');
  assert.equal(readFileSync(generatedPath, 'utf-8'), template);

  sessionManager.destroySession(member, { keepSchedule: false });
  sessionManager.destroySession(workerKeepAlive.id, { keepSchedule: false });
  groupManager.destroyGroup(gid);
});

// Fail-closed counterpart of the above: when the overlay can't be generated
// (here, simulated by a group with no orchestratorDir -- generateOrchestratorClaudeMdSrc
// returns null in that case, same as a torn-down group), the resume must be
// dropped rather than launch an orchestrator with no CLAUDE.md overlay at
// all -- mirrors the existing mcpSocketPath drop policy.
test('fireSchedule drops the prompt when the orchestrator CLAUDE.md overlay cannot be generated', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: '/tmp', orchestratorDir: null });

  const workerKeepAlive = shellMember('/tmp', gid, 'workerA');
  const deadOrch = shellMember('/tmp', gid, 'orchestrator');
  const deadOrchId = deadOrch.id;

  assert.ok(sessionManager.setScheduledPrompt(deadOrch.id, Date.now() + 500, 'MARKER_ORCH_DROP'));
  sessionManager.destroySession(deadOrch.id);

  await sleep(1800);

  const group = groupManager.getGroup(gid);
  assert.ok(group, 'group survives (workerA alive)');
  assert.equal(group.members.get('orchestrator'), deadOrchId, 'role was never rebound -- the resume was dropped, not launched without an overlay');
  const leftover = sessionManager.listSessions().filter((s) => s.groupId === gid && s.groupRole === 'orchestrator');
  assert.equal(leftover.length, 0, 'no orchestrator session (dead or alive) was (re)spawned for this role');

  sessionManager.destroySession(workerKeepAlive.id, { keepSchedule: false });
  groupManager.destroyGroup(gid);
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

// isReviewJob forces reviewer-MCP identity injection into a review job's OWN
// session even while reviewerMcp is off in the live config (see
// sessionManager.js's useReviewer comment, and reviewer.js's runReview, which
// passes isReviewJob: true when launching a job's session). This matters
// because the reviewer broker, once started, is never torn down on a config
// edit (only at boot) -- without the bypass, flipping reviewerMcp off after
// boot would silently strand every review job started afterward with no way
// to reach finish_review, its authoritative completion signal. A NORMAL
// (non-review-job) session must still be refused it under the same off
// config, or the bypass would defeat the opt-in flag entirely.
test('createSession isReviewJob bypasses a disabled reviewerMcp flag for the review job\'s own session only', async () => {
  const binDir = mkdtempSync(join(tmpdir(), 'ccserver-fake-agent-'));
  const fakeBin = join(binDir, 'fake-claude');
  writeFileSync(fakeBin, '#!/bin/bash\nprintf "%s\\n" "$CCSERVER_REVIEWER_IDENTITY"\n', { mode: 0o755 });
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-fake-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, reviewerMcp: false }));
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_CLAUDE_BIN = fakeBin;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  const reviewer = await import('./reviewer.js');
  // ensureReviewerBroker() itself does not gate on reviewerMcp (only
  // index.js's boot code does) -- calling it directly here reproduces the
  // "broker started while the flag was on, then the flag got edited off"
  // scenario without needing an actual server restart.
  await reviewer.ensureReviewerBroker();
  const ids = [];
  try {
    assert.equal(reviewer.reviewerEnabled(), false, 'sanity: reviewerMcp really is off in this config');

    const forced = sessionManager.createSession({
      cwd: '/tmp', cols: 80, rows: 24, shell: false, sandbox: false, app: 'claude', isReviewJob: true,
    });
    assert.ok(forced.session, 'agent session should spawn');
    ids.push(forced.sessionId);
    await sleep(500);
    const forcedIdentity = forced.session.outputBuffer.join('').trim();
    assert.notEqual(forcedIdentity, '', 'isReviewJob:true must get the reviewer identity even with reviewerMcp off');
    assert.deepEqual(JSON.parse(forcedIdentity), { sessionId: forced.sessionId });

    const normal = sessionManager.createSession({
      cwd: '/tmp', cols: 80, rows: 24, shell: false, sandbox: false, app: 'claude',
    });
    assert.ok(normal.session);
    ids.push(normal.sessionId);
    await sleep(500);
    assert.equal(normal.session.outputBuffer.join('').trim(), '', 'a normal session must NOT get it while reviewerMcp is off');
  } finally {
    for (const id of ids) sessionManager.destroySession(id, { keepSchedule: false });
    reviewer.stopReviewerBroker();
    if (prevBin === undefined) delete process.env.CCSERVER_CLAUDE_BIN;
    else process.env.CCSERVER_CLAUDE_BIN = prevBin;
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(binDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// The bypass above is deliberately only safe because isReviewJob can never
// arrive from a network caller: reviewer.js's runReview sets it on a direct,
// in-process call to createSessionViaApi (see reviewer.js's loadSessionDeps),
// but POST /api/sessions is the SAME createSessionViaApi wired up to accept
// an arbitrary request body from anyone holding CCSERVER_TOKEN. Unlike
// isMetaAgent (harmless if a plain HTTP client sets it -- see
// createSessionViaApi's comment), isReviewJob has a real effect, so
// routes/sessions.js's POST handler must strip it from request.body before
// it ever reaches createSession. This exercises that boundary specifically
// (the test above only covers the safe, trusted, in-process call shape).
test('POST /api/sessions ignores a client-supplied isReviewJob -- reviewerMcp stays off for it', async () => {
  const binDir = mkdtempSync(join(tmpdir(), 'ccserver-fake-agent-'));
  const fakeBin = join(binDir, 'fake-claude');
  writeFileSync(fakeBin, '#!/bin/bash\nprintf "%s\\n" "$CCSERVER_REVIEWER_IDENTITY"\n', { mode: 0o755 });
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-fake-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, reviewerMcp: false }));
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_CLAUDE_BIN = fakeBin;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  const reviewer = await import('./reviewer.js');
  await reviewer.ensureReviewerBroker();
  const app = Fastify();
  await app.register(sessionsRoute, { prefix: '/api' });
  let sessionId = null;
  try {
    assert.equal(reviewer.reviewerEnabled(), false, 'sanity: reviewerMcp really is off in this config');
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { cwd: '/tmp', shell: false, sandbox: false, app: 'claude', isReviewJob: true },
    });
    assert.equal(res.statusCode, 200, res.body);
    sessionId = res.json().sessionId;
    await sleep(500);
    const session = sessionManager.getSession(sessionId);
    assert.equal(
      session.outputBuffer.join('').trim(),
      '',
      'isReviewJob in an HTTP request body must be ignored -- only reviewer.js\'s own in-process call may set it',
    );
  } finally {
    await app.close();
    if (sessionId) sessionManager.destroySession(sessionId, { keepSchedule: false });
    reviewer.stopReviewerBroker();
    if (prevBin === undefined) delete process.env.CCSERVER_CLAUDE_BIN;
    else process.env.CCSERVER_CLAUDE_BIN = prevBin;
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(binDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// The reuse-dialog safety rule: a "new sandbox" (wipe of the previous
// persistent HOME) is refused while another LIVE, SANDBOXED session of the
// same project is still using that HOME. Unsandboxed sessions don't bind the
// persistent HOME and are unaffected; exited sessions aren't "in use".
test('sandboxHomeConflict: refuses a wipe while a live sandboxed session shares the HOME', () => {
  const prevHome = process.env.CCSERVER_SANDBOX_HOME_ROOT;
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(runtimeDir, 'sandbox-home');
  try {
    const cwd = '/srv/proj';
    const target = persistentHomeDir(cwd);
    const liveSandboxed = { exited: false, sandbox: true, cwd };
    const liveUnsandboxed = { exited: false, sandbox: false, cwd };
    const otherProject = { exited: false, sandbox: true, cwd: '/srv/other' };
    const exitedSandboxed = { exited: true, sandbox: true, cwd };
    assert.equal(sessionManager.sandboxHomeConflict(target, [liveSandboxed]), true);
    assert.equal(sessionManager.sandboxHomeConflict(target, [liveUnsandboxed]), false, 'unsandboxed sessions are unaffected');
    assert.equal(sessionManager.sandboxHomeConflict(target, [otherProject]), false, 'other projects are unaffected');
    assert.equal(sessionManager.sandboxHomeConflict(target, [exitedSandboxed]), false, 'exited sessions are not in use');
    assert.equal(sessionManager.sandboxHomeConflict(target, []), false);
    assert.equal(sessionManager.sandboxHomeConflict(persistentHomeDir('/srv/proj/'), [liveSandboxed]), true, 'cwd spelling variants normalize to the same HOME');
  } finally {
    if (prevHome === undefined) delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
    else process.env.CCSERVER_SANDBOX_HOME_ROOT = prevHome;
  }
});

// sandboxHomeInUse is the endpoint-facing count built from the same rule;
// with only shell (unsandboxed) sessions in the registry it must read 0 for
// any cwd.
test('sandboxHomeInUse counts only live sandboxed sessions', () => {
  const prevHome = process.env.CCSERVER_SANDBOX_HOME_ROOT;
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(runtimeDir, 'sandbox-home');
  try {
    const shell = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
    assert.ok(shell.session, 'shell session should spawn');
    try {
      assert.equal(sessionManager.sandboxHomeInUse('/tmp'), 0, 'a live shell session does not hold the persistent HOME');
      assert.equal(sessionManager.sandboxHomeInUse('/srv/unrelated'), 0);
    } finally {
      sessionManager.destroySession(shell.sessionId, { keepSchedule: false });
    }
  } finally {
    if (prevHome === undefined) delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
    else process.env.CCSERVER_SANDBOX_HOME_ROOT = prevHome;
  }
});

// dockerAvailability(session): surfaced by get_tab_status/list_group_sessions
// so the orchestrator can check per-session docker usability up front instead
// of discovering the data-root race (a rootless dockerd can serve only ONE
// session per project at a time -- see sandbox-entrypoint.sh's flock) from a
// failed task (see tmp/docker-availability-visibility-plan.md). Pure function
// over a session-shaped object, same style as sandboxHomeConflict above;
// dockerdStatus's file read is isolated via CCSERVER_SANDBOX_DIND_ROOT, and
// the status file is written by hand here to stand in for
// sandbox-entrypoint.sh's write -- no real dockerd/bwrap/rootlesskit runs.
// The exact data-root path (dindRoot + slugify(cwd)) mirrors sandbox.js's
// private slugify(); the round-trip against the REAL production path is
// covered separately in sandbox-docker-status.test.js via buildSandboxSpawn.
// A mismatched tag alone must NOT read as "locked by another live session":
// the status file is never cleared on exit, so a tag mismatch is equally
// consistent with harmless leftover history from an already-exited session.
// dockerAvailability disambiguates via dockerdLockHeld() (a real flock
// probe), so this test holds a genuine flock (via the real flock(1) binary,
// same as sandbox-entrypoint.sh) to exercise that branch for real rather than
// just asserting against the file content.
test('dockerAvailability: not-sandboxed / tooling-or-config / starting / available / locked-by-another', async () => {
  const prevDind = process.env.CCSERVER_SANDBOX_DIND_ROOT;
  const dindDir = join(runtimeDir, 'dind-availability');
  process.env.CCSERVER_SANDBOX_DIND_ROOT = dindDir;
  let lockHolder = null;
  try {
    assert.deepEqual(
      sessionManager.dockerAvailability({ sandbox: false, docker: false, cwd: '/srv/proj' }),
      { dockerAvailable: null, dockerReason: 'not-sandboxed' },
      'no sandbox at all -- docker is simply not applicable',
    );

    const sandboxedNoDocker = sessionManager.dockerAvailability({ sandbox: true, docker: false, cwd: '/srv/proj' });
    assert.equal(sandboxedNoDocker.dockerAvailable, false);
    assert.ok(
      ['tooling-missing', 'disabled-by-config'].includes(sandboxedNoDocker.dockerReason),
      `expected a tooling/config reason, got ${sandboxedNoDocker.dockerReason}`,
    );

    const cwd = '/srv/docker-avail-proj';
    assert.deepEqual(
      sessionManager.dockerAvailability({ sandbox: true, docker: true, dockerTag: 'tag-mine', cwd }),
      { dockerAvailable: null, dockerReason: 'starting' },
      'docker was requested but the entrypoint has not won/lost the flock yet (no status file)',
    );

    const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root';
    const dataRoot = join(dindDir, slug);
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(join(dataRoot, '.ccserver-dockerd.status'), 'tag-mine');
    assert.deepEqual(
      sessionManager.dockerAvailability({ sandbox: true, docker: true, dockerTag: 'tag-mine', cwd }),
      { dockerAvailable: true, dockerReason: 'available' },
      'the status file tag matches this session\'s own dockerTag',
    );
    assert.deepEqual(
      sessionManager.dockerAvailability({ sandbox: true, docker: true, dockerTag: 'someone-elses-tag', cwd }),
      { dockerAvailable: null, dockerReason: 'starting' },
      'tag mismatch but nobody currently holds the flock -- stale leftover history, not a live conflict',
    );

    // Now actually hold the flock, so the mismatch reflects a genuinely live
    // competitor rather than history.
    const lockPath = join(dataRoot, '.ccserver-dockerd.lock');
    lockHolder = spawnProcess('flock', [lockPath, 'sleep', '5']);
    let result;
    for (let i = 0; i < 40; i++) {
      result = sessionManager.dockerAvailability({ sandbox: true, docker: true, dockerTag: 'someone-elses-tag', cwd });
      if (result.dockerReason === 'data-root-locked-by-another-session') break;
      await sleep(50);
    }
    assert.deepEqual(
      result,
      { dockerAvailable: false, dockerReason: 'data-root-locked-by-another-session' },
      'tag mismatch AND the flock is genuinely held -- a live conflict',
    );
  } finally {
    if (lockHolder) lockHolder.kill();
    if (prevDind === undefined) delete process.env.CCSERVER_SANDBOX_DIND_ROOT;
    else process.env.CCSERVER_SANDBOX_DIND_ROOT = prevDind;
  }
});

// Session-limit auto-resume detection (see sessionLimitDetect.js and the
// onData handler in sessionManager.js). A real shell session stands in for
// an agent: `echo` writes the exact bytes through the pty -> onData path,
// so these exercise the actual production code, not a re-implementation.
test('onData session-limit detection: auto-arms a resume schedule 1 minute after reset', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const { sessionId, session } = res;
  assert.ok(session, 'shell session should spawn');
  try {
    await sleep(400); // let the shell reach its prompt
    const resetAt = Date.now() + 60 * 60 * 1000; // 1h ahead -- comfortably "still today"
    const line = sessionLimitLine(resetAt);
    const expected = findSessionLimitReset(line, resetAt - 60000);
    assert.ok(expected, 'sanity: the constructed line must itself be parseable');

    sessionManager.writeToSession(sessionId, `echo ${shellQuote(line)}`, { submit: true });
    await sleep(1200);

    const scheduled = sessionManager.scheduledPromptPublic(session);
    assert.ok(scheduled, 'a schedule must have been auto-armed');
    assert.equal(scheduled.source, 'auto-session-limit');
    assert.equal(scheduled.at, expected.resetAtMs + 60000, 'fires exactly 1 minute after the parsed reset time');
    assert.equal(scheduled.text, 'セッション制限がリセットされました。作業を続けてください。');
  } finally {
    sessionManager.destroySession(sessionId, { keepSchedule: false });
  }
});

test('onData session-limit detection: does not override an existing manual schedule', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const { sessionId, session } = res;
  assert.ok(session, 'shell session should spawn');
  try {
    await sleep(400);
    assert.ok(sessionManager.setScheduledPrompt(sessionId, Date.now() + 30000, 'MANUAL_MARKER'));
    const manualScheduleId = session.scheduleId;
    assert.ok(manualScheduleId);

    const line = sessionLimitLine(Date.now() + 60 * 60 * 1000);
    sessionManager.writeToSession(sessionId, `echo ${shellQuote(line)}`, { submit: true });
    await sleep(1200);

    const scheduled = sessionManager.scheduledPromptPublic(session);
    assert.equal(scheduled.text, 'MANUAL_MARKER', 'the manual schedule must survive the auto-detection');
    assert.equal(scheduled.source, 'manual');
    assert.equal(session.scheduleId, manualScheduleId, 'the manual schedule entry itself is left untouched');
  } finally {
    sessionManager.destroySession(sessionId, { keepSchedule: false });
  }
});

test('onData session-limit detection: a redraw of the same reset time does not re-arm', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const { sessionId, session } = res;
  assert.ok(session, 'shell session should spawn');
  try {
    await sleep(400);
    const line = sessionLimitLine(Date.now() + 60 * 60 * 1000);

    sessionManager.writeToSession(sessionId, `echo ${shellQuote(line)}`, { submit: true });
    await sleep(1200);
    const firstScheduleId = session.scheduleId;
    assert.ok(firstScheduleId, 'first detection must arm a schedule');
    const firstAt = sessionManager.scheduledPromptPublic(session).at;

    // The TUI redrawing the identical status line (same resetAtMs) must not
    // cancel-and-reschedule -- same scheduleId, same fire time.
    sessionManager.writeToSession(sessionId, `echo ${shellQuote(line)}`, { submit: true });
    await sleep(1200);
    assert.equal(session.scheduleId, firstScheduleId, 'redraw of the same event does not re-arm the schedule');
    assert.equal(sessionManager.scheduledPromptPublic(session).at, firstAt);
  } finally {
    sessionManager.destroySession(sessionId, { keepSchedule: false });
  }
});

// Backend push regression guard: the auto-session-limit detector arms the
// schedule via setScheduledPrompt, but it's a server-internal trigger (pty
// output monitoring), not a client request to answer -- unlike
// schedule_prompt/cancel_schedule/get_schedule/init/attach, it has no
// response leg to piggyback a schedule_state push on. Without an explicit
// push (notifyScheduleState in sessionManager.js) the client's clock panel,
// which is entirely push-driven with no polling, never learns the schedule
// was armed until the next init/attach.
test('onData session-limit detection: auto-arm pushes schedule_state to the socket', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const { sessionId, session } = res;
  assert.ok(session, 'shell session should spawn');
  const sent = [];
  session.socket = { readyState: 1, send: (m) => sent.push(m) };
  try {
    await sleep(400);
    const line = sessionLimitLine(Date.now() + 60 * 60 * 1000);
    sessionManager.writeToSession(sessionId, `echo ${shellQuote(line)}`, { submit: true });
    await sleep(1200);

    const stateMsgs = sent
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter((m) => m?.type === 'schedule_state');
    assert.equal(stateMsgs.length, 1, 'exactly one schedule_state push for the auto-arm');
    assert.ok(stateMsgs[0].scheduled, 'the push carries the newly-armed schedule');
    assert.equal(stateMsgs[0].scheduled.source, 'auto-session-limit');
  } finally {
    sessionManager.destroySession(sessionId, { keepSchedule: false });
  }
});

test('onData session-limit detection: no schedule_state push when a manual schedule blocks the auto-arm', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const { sessionId, session } = res;
  assert.ok(session, 'shell session should spawn');
  try {
    await sleep(400);
    assert.ok(sessionManager.setScheduledPrompt(sessionId, Date.now() + 30000, 'MANUAL_MARKER'));

    // Attach the socket only after the manual schedule is set, so the
    // manual setScheduledPrompt call itself (which goes through the
    // schedule_prompt WS handler in production, not through this helper) is
    // excluded from `sent` -- this test only cares about the auto-detect path.
    const sent = [];
    session.socket = { readyState: 1, send: (m) => sent.push(m) };

    const line = sessionLimitLine(Date.now() + 60 * 60 * 1000);
    sessionManager.writeToSession(sessionId, `echo ${shellQuote(line)}`, { submit: true });
    await sleep(1200);

    const stateMsgs = sent
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter((m) => m?.type === 'schedule_state');
    assert.equal(stateMsgs.length, 0, 'the schedule is unchanged, so no push should fire');
  } finally {
    sessionManager.destroySession(sessionId, { keepSchedule: false });
  }
});

test('onData session-limit detection: records the reset into sessionLimitState (scheduler-panel hint source)', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const { sessionId, session } = res;
  assert.ok(session, 'shell session should spawn');
  try {
    await sleep(400);
    const resetAt = Date.now() + 60 * 60 * 1000;
    const line = sessionLimitLine(resetAt);
    const expected = findSessionLimitReset(line, resetAt - 60000);
    assert.ok(expected, 'sanity: the constructed line must itself be parseable');

    sessionManager.writeToSession(sessionId, `echo ${shellQuote(line)}`, { submit: true });
    await sleep(1200);

    const latest = getLatestSessionLimitReset();
    assert.ok(latest, 'the detection must be recorded regardless of the auto-arm outcome');
    assert.equal(latest.resetAtMs, expected.resetAtMs);
    assert.equal(latest.timeZone, expected.timeZone);
    assert.equal(latest.source, 'session-output');
  } finally {
    sessionManager.destroySession(sessionId, { keepSchedule: false });
  }
});

test('onData session-limit detection: still records into sessionLimitState even when a manual schedule blocks the auto-arm', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const { sessionId, session } = res;
  assert.ok(session, 'shell session should spawn');
  try {
    await sleep(400);
    assert.ok(sessionManager.setScheduledPrompt(sessionId, Date.now() + 30000, 'MANUAL_MARKER'));

    const resetAt = Date.now() + 60 * 60 * 1000;
    const line = sessionLimitLine(resetAt);
    const expected = findSessionLimitReset(line, resetAt - 60000);

    sessionManager.writeToSession(sessionId, `echo ${shellQuote(line)}`, { submit: true });
    await sleep(1200);

    const latest = getLatestSessionLimitReset();
    assert.ok(latest, 'the hint store is independent of the auto-arm skip path');
    assert.equal(latest.resetAtMs, expected.resetAtMs);

    const scheduled = sessionManager.scheduledPromptPublic(session);
    assert.equal(scheduled.text, 'MANUAL_MARKER', 'sanity: the manual schedule itself is untouched');
  } finally {
    sessionManager.destroySession(sessionId, { keepSchedule: false });
  }
});

test('onData session-limit detection: a redraw of the same reset time does not re-push', async () => {
  const res = sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const { sessionId, session } = res;
  assert.ok(session, 'shell session should spawn');
  const sent = [];
  session.socket = { readyState: 1, send: (m) => sent.push(m) };
  try {
    await sleep(400);
    const line = sessionLimitLine(Date.now() + 60 * 60 * 1000);
    const stateMsgCount = () => sent.filter((m) => {
      try { return JSON.parse(m).type === 'schedule_state'; } catch { return false; }
    }).length;

    sessionManager.writeToSession(sessionId, `echo ${shellQuote(line)}`, { submit: true });
    await sleep(1200);
    assert.equal(stateMsgCount(), 1, 'first detection pushes once');

    // The TUI redrawing the identical status line must not re-arm, and
    // therefore must not re-push either.
    sessionManager.writeToSession(sessionId, `echo ${shellQuote(line)}`, { submit: true });
    await sleep(1200);
    assert.equal(stateMsgCount(), 1, 'redraw of the same event does not re-push');
  } finally {
    sessionManager.destroySession(sessionId, { keepSchedule: false });
  }
});

// Meta-agent cwd invariant (see ws/metaAgent.js / createSession): sessions
// launched with isMetaAgent:true and no groupId ALWAYS run in the fixed
// project-outside meta-agent dir -- a client-supplied project cwd must never
// reach the privileged session (prompt-injection material / bwrap rw-bind).
// Flag-less launches keep the requested cwd; group members are excluded from
// the force (their cwd is resolved server-side from the group).
test('meta-agent launches are forced into the fixed meta-agent dir; plain and group launches are not', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'ccserver-meta-cwd-'));
  const spawned = [];
  try {
    const flagged = sessionManager.createSession({
      cwd: projectDir, cols: 80, rows: 24, shell: true, sandbox: false, isMetaAgent: true,
    });
    assert.ok(flagged.session, 'meta-flagged shell should spawn');
    spawned.push(flagged.sessionId);
    assert.equal(flagged.session.cwd, metaAgentDir(), 'isMetaAgent forces the fixed dir');
    assert.notEqual(flagged.session.cwd, projectDir, 'the client-supplied cwd is never used');

    const plain = sessionManager.createSession({
      cwd: projectDir, cols: 80, rows: 24, shell: true, sandbox: false,
    });
    assert.ok(plain.session, 'plain shell should spawn');
    spawned.push(plain.sessionId);
    assert.equal(plain.session.cwd, projectDir, 'flag-less launches keep the requested cwd');

    const member = sessionManager.createSession({
      cwd: projectDir, cols: 80, rows: 24, shell: true, sandbox: false,
      groupId: `g-meta-invariant-${randomUUID()}`, groupRole: 'workerA', isMetaAgent: true,
    });
    assert.ok(member.session, 'group-member shell should spawn');
    spawned.push(member.sessionId);
    assert.equal(member.session.cwd, projectDir, 'group members are resolved from the group, not forced');

    assert.equal(sessionManager.listSessions().find((s) => s.id === flagged.sessionId).isMetaAgent, true);
  } finally {
    for (const id of spawned) sessionManager.destroySession(id, { keepSchedule: false });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// REST contract (shared with the meta agent's launch_session tool): a meta
// launch needs no client cwd at all (the server forces the fixed dir), while
// a normal launch without an existing directory is still refused.
test('createSessionViaApi: isMetaAgent:true needs no cwd; normal launches still require one', async () => {
  const { createSessionViaApi } = await import('../routes/sessions.js');
  let sessionId = null;
  try {
    const meta = await createSessionViaApi({ isMetaAgent: true, shell: true });
    assert.equal(meta.ok, true, 'meta launch must not require a client cwd');
    sessionId = meta.body.sessionId;
    assert.equal(meta.body.cwd, metaAgentDir(), 'the API reports the forced fixed dir');
    assert.equal(meta.body.isMetaAgent, true);

    const bad = await createSessionViaApi({});
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'validation', 'a normal launch without cwd stays refused');
  } finally {
    if (sessionId) sessionManager.destroySession(sessionId, { keepSchedule: false });
  }
});
