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
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, unlinkSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn as spawnProcess } from 'node:child_process';
import Fastify from 'fastify';
import { sessionsRoute } from '../routes/sessions.js';
import { persistentHomeDir, sandboxAvailable, loadSandboxConfig } from './sandbox.js';
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
async function shellMember(cwd, groupId, groupRole) {
  const res = await sessionManager.createSession({
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

test('savedSessionPublic preserves group membership (restart filter keeps working)', async () => {
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
  const shell = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false, model: 'gpt-5' });
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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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

// An explicitly requested sandbox that cannot be built (bwrap missing) is
// refused instead of silently falling back to a direct spawn -- running on
// the host while the client believes it is sandboxed is worse than an error.
// Runs only where bwrap is absent (mirrors the skip-unless-available sandbox
// spawn tests); the refusal message keeps the 'Failed to build sandbox'
// prefix so HTTP layers classify it as an infra fault.
test('explicit sandbox request without bwrap is refused, not silently unsandboxed', { skip: sandboxAvailable() || loadSandboxConfig().forceSandbox }, async () => {
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: true });
  assert.equal(res.session, null, 'no session must be created');
  assert.match(res.error, /^Failed to build sandbox: /);
});

// Filesystem-root launches: claude/opencode abort immediately there (opaque
// SIGABRT, no output), and a SANDBOXED shell at / would get a fail-open
// sandbox -- the project subtree rule becomes "^/(/.*)?$" (seatbelt's
// subtrees('/')) or a "/" bind (bwrap), silently granting the whole
// filesystem. Plain unsandboxed shells are fine at /.
test('createSession refuses cwd=/ for agents and sandboxed shells, not plain shells', async () => {
  const agent = await sessionManager.createSession({ cwd: '/', cols: 80, rows: 24, shell: false, app: 'claude', sandbox: false });
  assert.equal(agent.session, null, 'agent launch at / is refused');
  assert.match(agent.error, /^Cannot launch in the filesystem root/);

  const sbShell = await sessionManager.createSession({ cwd: '/', cols: 80, rows: 24, shell: true, sandbox: true });
  assert.equal(sbShell.session, null, 'sandboxed shell at / is refused (fail-open profile)');
  assert.match(sbShell.error, /^Cannot launch a sandboxed shell in the filesystem root/);

  if (!loadSandboxConfig().forceSandbox) {
    const plain = await sessionManager.createSession({ cwd: '/', cols: 80, rows: 24, shell: true, sandbox: false });
    assert.ok(plain.session, 'plain unsandboxed shell at / still spawns');
    sessionManager.destroySession(plain.sessionId, { keepSchedule: false });
  }
});

// Permission mode state on sessions: any value normalizes to one of
// 'standard' | 'auto-accept' | 'yolo' (unknown -> 'standard'); shells always
// carry 'standard'. The CLI flag itself is commandcode-only (see
// appLaunch.test.js) -- storage here is app-agnostic, mirroring model.
test('createSession stores the normalized permissionMode; shells are always standard', async () => {
  const shell = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false, permissionMode: 'yolo' });
  assert.ok(shell.session, 'shell session should spawn');
  try {
    assert.equal(shell.session.permissionMode, 'standard', 'shell sessions never carry a permission mode');
    assert.equal(sessionManager.listSessions().find((s) => s.id === shell.sessionId).permissionMode, 'standard');
    assert.equal(sessionManager.savedSessionPublic(shell.session, null).permissionMode, 'standard');
  } finally {
    sessionManager.destroySession(shell.sessionId, { keepSchedule: false });
  }

  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  assert.ok(res.session);
  try {
    res.session.permissionMode = 'bogus';
    assert.equal(
      sessionManager.listSessions().find((s) => s.id === res.sessionId).permissionMode,
      'standard',
      'invalid permission modes normalize to standard in listSessions',
    );
    res.session.permissionMode = 'yolo';
    assert.equal(sessionManager.savedSessionPublic(res.session, null).permissionMode, 'yolo');
  } finally {
    sessionManager.destroySession(res.sessionId, { keepSchedule: false });
  }
});

// Operator-assigned display names (client right-click rename): stored on the
// session, surfaced via listSessions, persisted via savedSessionPublic.
// Blank clears, overlong/non-string input is rejected without clobbering the
// stored label, unknown ids report not-found.
test('setSessionLabel stores, clears, validates, and surfaces customLabel', async () => {
  const shell = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  assert.ok(shell.session, 'shell session should spawn');
  try {
    assert.equal(shell.session.customLabel, null, 'no custom label by default');
    assert.equal(sessionManager.listSessions().find((s) => s.id === shell.sessionId).customLabel, null);

    let res = sessionManager.setSessionLabel(shell.sessionId, '  マイ作業  ');
    assert.equal(res.ok, true);
    assert.equal(res.session.customLabel, 'マイ作業', 'trims surrounding whitespace');
    assert.equal(sessionManager.listSessions().find((s) => s.id === shell.sessionId).customLabel, 'マイ作業');
    assert.equal(sessionManager.savedSessionPublic(shell.session, null).customLabel, 'マイ作業');

    res = sessionManager.setSessionLabel(shell.sessionId, 'a\nb\tc');
    assert.equal(res.ok, true);
    assert.equal(res.session.customLabel, 'abc', 'strips control characters');

    res = sessionManager.setSessionLabel(shell.sessionId, 'x'.repeat(64));
    assert.equal(res.ok, true, 'exactly the limit is accepted');

    res = sessionManager.setSessionLabel(shell.sessionId, '   ');
    assert.equal(res.ok, true);
    assert.equal(res.session.customLabel, null, 'blank clears the label');
    assert.equal(sessionManager.listSessions().find((s) => s.id === shell.sessionId).customLabel, null);

    res = sessionManager.setSessionLabel(shell.sessionId, null);
    assert.equal(res.ok, true);
    assert.equal(res.session.customLabel, null);

    res = sessionManager.setSessionLabel(shell.sessionId, 'x'.repeat(65));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'validation');
    assert.equal(sessionManager.getSession(shell.sessionId).customLabel, null, 'rejected input must not clobber the stored label');

    res = sessionManager.setSessionLabel(shell.sessionId, 42);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'validation');
    assert.equal(sessionManager.getSession(shell.sessionId).customLabel, null);

    res = sessionManager.setSessionLabel('no-such-session', 'foo');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'not-found');
  } finally {
    sessionManager.destroySession(shell.sessionId, { keepSchedule: false });
  }

  const named = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false, customLabel: '初期名' });
  assert.ok(named.session, 'shell session should spawn');
  try {
    assert.equal(named.session.customLabel, '初期名', 'createSession accepts an initial label (restart restore path)');
  } finally {
    sessionManager.destroySession(named.sessionId, { keepSchedule: false });
  }
});

// PR#108 review: permissionMode is a commandcode-only concept (appLaunch.js's
// appPermissionArgs is a no-op for every other app), but before this test the
// stored session.permissionMode itself wasn't forced back to 'standard' for
// non-commandcode apps -- only shells were. A caller-supplied 'yolo' for
// app: 'claude' would sit in session.permissionMode and surface via
// listSessions/savedSessionPublic/federation, which could mislead a consumer
// that treats that field as an actual bypass signal even though no CLI flag
// was ever emitted. Pin CCSERVER_CLAUDE_BIN at a real, always-executable file
// (the running node binary) so claude reads as INSTALLED.
test('createSession forces permissionMode to standard for non-commandcode apps', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-sess-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false }));
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_CLAUDE_BIN = process.execPath;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const res = await sessionManager.createSession({
      cwd: '/tmp', cols: 80, rows: 24, shell: false, sandbox: false, app: 'claude', permissionMode: 'yolo',
    });
    assert.ok(res.session, 'claude session should spawn');
    try {
      assert.equal(res.session.permissionMode, 'standard', 'non-commandcode apps never carry a non-standard permission mode');
      assert.equal(sessionManager.listSessions().find((s) => s.id === res.sessionId).permissionMode, 'standard');
      assert.equal(sessionManager.savedSessionPublic(res.session, null).permissionMode, 'standard');
    } finally {
      sessionManager.destroySession(res.sessionId, { keepSchedule: false });
    }
  } finally {
    if (prevBin === undefined) delete process.env.CCSERVER_CLAUDE_BIN;
    else process.env.CCSERVER_CLAUDE_BIN = prevBin;
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// A configured claudeBin that resolves nowhere (a bare name on no searched
// dir) must be refused with the clear not-installed error instead of reaching
// pty.spawn (opaque execvp ENOENT / exit 127 right after "起動しました").
// Deterministic: CCSERVER_CLAUDE_BIN overrides the config file, and no real
// CLI install is needed.
test('createSession refuses an uninstalled agent with a clear error', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-sess-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false }));
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_CLAUDE_BIN = 'no-such-claude-xyz';
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const res = await sessionManager.createSession({
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

// Self-review (issue #105): sandbox.config.json's hiddenApps must not be
// purely cosmetic. Every launch picker (single, combo, worker/
// launch-preset expansion) funnels its choice through createSession -- if
// this function doesn't itself refuse a hidden app, any direct WS/API call
// (or a preset saved before the app was hidden) can still start a real
// session for an app the operator hasn't contracted for, regardless of what
// the client-side pickers show. Pin CCSERVER_CLAUDE_BIN at a real,
// always-executable file (the running node binary) so claude reads as
// INSTALLED -- the hidden check must fire even when the app is present,
// unlike the "not installed" case above.
test('createSession refuses a hidden (but installed) agent with a clear error', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-sess-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, hiddenApps: ['claude'] }));
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_CLAUDE_BIN = process.execPath;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const res = await sessionManager.createSession({
      cwd: '/tmp', cols: 80, rows: 24, shell: false, sandbox: false, app: 'claude',
    });
    assert.equal(res.session, null, 'no session may be created for a hidden app, even one that is installed');
    assert.match(res.error, /claude is hidden on this server/);
    assert.match(res.error, /hiddenApps/, 'the error names the config key responsible');
  } finally {
    if (prevBin === undefined) delete process.env.CCSERVER_CLAUDE_BIN;
    else process.env.CCSERVER_CLAUDE_BIN = prevBin;
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// The hiddenApps check runs BEFORE resolveApp() (see createSession), so the
// refusal reason must be "hidden", never "not installed", even for an app
// this test machine genuinely doesn't have -- unlike claude, opencode/copilot/
// codex have no CCSERVER_*_BIN override to fake an install with (see
// sandbox-resolve.test.js's header comment), so this is the only way to
// deterministically exercise the hidden check for them without depending on
// what happens to be on the machine running the suite.
test('createSession refuses a hidden agent even when it is not installed on this host', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-sess-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, hiddenApps: ['codex'] }));
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const res = await sessionManager.createSession({
      cwd: '/tmp', cols: 80, rows: 24, shell: false, sandbox: false, app: 'codex',
    });
    assert.equal(res.session, null, 'no session may be created for a hidden app');
    assert.match(res.error, /codex is hidden on this server/);
    assert.doesNotMatch(res.error, /not installed/, 'hidden must win over install status, not the reverse');
  } finally {
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// browseRoots (issue #189): when configured, every session's cwd must fall
// inside one of these directories -- checked unconditionally, before
// sessionApp is even resolved, so it applies equally to shells and agents.
test('createSession refuses a cwd outside browseRoots, for both shells and agents', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-sess-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  const allowed = mkdtempSync(join(tmpdir(), 'ccserver-sess-allowed-'));
  const outside = mkdtempSync(join(tmpdir(), 'ccserver-sess-outside-'));
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, browseRoots: [allowed] }));
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const shellOutside = await sessionManager.createSession({ cwd: outside, cols: 80, rows: 24, shell: true, sandbox: false });
    assert.equal(shellOutside.session, null, 'a shell outside browseRoots must be refused');
    assert.match(shellOutside.error, /outside the allowed browseRoots/);
    assert.match(shellOutside.error, /browseRoots/, 'the error names the config key responsible');

    const agentOutside = await sessionManager.createSession({ cwd: outside, cols: 80, rows: 24, shell: false, app: 'claude', sandbox: false });
    assert.equal(agentOutside.session, null, 'an agent outside browseRoots must be refused');
    assert.match(agentOutside.error, /outside the allowed browseRoots/);

    // Inside browseRoots, a plain shell is not refused BY THE CWD CHECK --
    // but browseRoots also forces every shell sandboxed with no opt-out, so
    // on a host with no sandbox backend the same launch is refused for that
    // reason instead (pinned by the "no sandbox backend" test below; CI
    // runners have no bwrap). Either way the cwd check itself must not fire.
    const shellInside = await sessionManager.createSession({ cwd: allowed, cols: 80, rows: 24, shell: true, sandbox: false });
    assert.doesNotMatch(shellInside.error || '', /outside the allowed browseRoots/,
      'a shell inside browseRoots must not be refused by the cwd check');
    if (sandboxAvailable()) {
      assert.ok(shellInside.session, 'a shell inside browseRoots spawns normally when a backend exists');
      assert.equal(shellInside.session.sandbox, true, 'browseRoots forces even a sandbox:false shell sandboxed');
      sessionManager.destroySession(shellInside.sessionId, { keepSchedule: false });
    } else {
      assert.equal(shellInside.session, null);
      assert.match(shellInside.error, /shell sessions must run sandboxed/);
    }
  } finally {
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(allowed, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(outside, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// browseRoots (issue #189) must not break combo/group launches: every
// worker/orchestrator session's cwd is a server-synthesized scratch dir
// under ~/.local/share/ccserver-sandbox (never the project directory
// itself -- see groupManager.js's addMember). That exemption is gated on the
// TRUSTED scratchCwd parameter (only in-process callers that synthesize the
// cwd pass it), never on the path alone -- see createSession's comment.
// This integration-tests the exemption through createSession() itself,
// against the REAL scratch root (not overridable via env var), using a
// throwaway subdirectory cleaned up afterward.
test('createSession accepts a scratch-tree cwd only via the trusted scratchCwd flag', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-sess-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  const allowed = mkdtempSync(join(tmpdir(), 'ccserver-sess-allowed-'));
  const scratchDir = join(homedir(), '.local', 'share', 'ccserver-sandbox', 'worktrees', `test-${randomUUID()}`);
  mkdirSync(scratchDir, { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, browseRoots: [allowed] }));
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    // Client-style call (no flag): the path alone must NOT be exempt, or any
    // REST/WS caller could point a session at the scratch tree (sandbox
    // HOME credentials, GPG vault DB, federation keys) and have it rw-bound
    // into the sandbox.
    const client = await sessionManager.createSession({ cwd: scratchDir, cols: 80, rows: 24, shell: true, sandbox: false });
    assert.equal(client.session, null, 'a client-supplied scratch cwd must be refused');
    assert.match(client.error, /outside the allowed browseRoots/);

    // Trusted in-process call (group worktree / orchestrator / reviewer):
    // not refused by the cwd check, and still forced sandboxed.
    const res = await sessionManager.createSession({ cwd: scratchDir, cols: 80, rows: 24, shell: true, sandbox: false, scratchCwd: true });
    assert.doesNotMatch(res.error || '', /outside the allowed browseRoots/,
      'a server-synthesized scratch cwd must not be refused by browseRoots');
    if (sandboxAvailable()) {
      assert.ok(res.session, 'a scratch-tree cwd spawns when a sandbox backend exists');
      // Still forced sandboxed like any other shell under browseRoots.
      assert.equal(res.session.sandbox, true);
      sessionManager.destroySession(res.sessionId, { keepSchedule: false });
    } else {
      // No backend: refused by the sandbox mandate, never by the cwd check.
      assert.equal(res.session, null);
      assert.match(res.error, /shell sessions must run sandboxed/);
    }
  } finally {
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(allowed, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// Fail closed (issue #189 self-review): a present-but-unusable browseRoots
// (e.g. a string instead of an array) must refuse launches, not silently
// fall back to host-wide access.
test('createSession refuses to launch when browseRoots is present but invalid', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-sess-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, browseRoots: '/srv/repos' }));
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
    assert.equal(res.session, null);
    assert.match(res.error, /"browseRoots" is invalid/);
  } finally {
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// Regression (issue #189 self-review): the scratch-tree exemption is
// symlink-safe. A symlink planted inside the tree (any sandboxed session can
// create one -- its HOME is rw-bound under the same tree) that points
// outside must NOT be treated as an exempt scratch cwd: that would skip the
// browseRoots refusal entirely, and buildBwrapArgs' `--bind <cwd> <cwd>`
// would resolve the bind source through the link (a live PoC pointing at /
// rw-bound the host root into the "sandboxed" shell). Refused here already
// by the cwd check, so this asserts the refusal reason regardless of whether
// a sandbox backend exists.
test('createSession refuses a cwd that is a scratch-internal symlink pointing outside browseRoots', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-sess-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  const allowed = mkdtempSync(join(tmpdir(), 'ccserver-sess-allowed-'));
  const outside = mkdtempSync(join(tmpdir(), 'ccserver-sess-outside-'));
  const escapeLink = join(homedir(), '.local', 'share', 'ccserver-sandbox', 'worktrees', `test-escape-${randomUUID()}`);
  mkdirSync(dirname(escapeLink), { recursive: true });
  symlinkSync(outside, escapeLink);
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, browseRoots: [allowed] }));
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    // scratchCwd:true simulates the trusted in-process callers: even THEY
    // must not follow a scratch-internal symlink out of the tree.
    const res = await sessionManager.createSession({ cwd: escapeLink, cols: 80, rows: 24, shell: true, sandbox: false, scratchCwd: true });
    assert.equal(res.session, null, 'a scratch symlink pointing outside must never launch a session');
    assert.match(res.error, /outside the allowed browseRoots/);
  } finally {
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(escapeLink, { force: true }); } catch { /* ignore */ }
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(allowed, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(outside, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// browseRoots forces every shell sandboxed with no client opt-out (issue
// #189's core complaint: a plain unsandboxed shell defeats browseRoots via
// `cd`). When the sandbox backend itself is unavailable, the launch must be
// refused -- never silently downgraded to an unsandboxed shell -- with a
// message naming browseRoots specifically (not forceSandbox's wording).
// Skipped wherever a real backend (or forceSandbox) is present, mirroring
// the "explicit sandbox request without bwrap" test above.
test('createSession refuses an unsandboxed shell when browseRoots is set and no sandbox backend is available', { skip: sandboxAvailable() || loadSandboxConfig().forceSandbox }, async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-sess-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  const allowed = mkdtempSync(join(tmpdir(), 'ccserver-sess-allowed-'));
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, browseRoots: [allowed] }));
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const res = await sessionManager.createSession({ cwd: allowed, cols: 80, rows: 24, shell: true, sandbox: false });
    assert.equal(res.session, null, 'a shell must never fall back to unsandboxed when browseRoots mandates sandboxing');
    assert.match(res.error, /^Cannot launch: sandbox\.config\.json sets "browseRoots"/);
    assert.match(res.error, /shell sessions must run sandboxed/);
  } finally {
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(allowed, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// allowUnsandboxedAgents:true is the one opt-out from browseRoots' sandbox
// mandate, and only for agents (never shells, see the test above). Exercised
// against a hidden (but nominally "installed" via CCSERVER_CLAUDE_BIN) app
// the same way the hiddenApps tests above fake an install, so the launch
// reaches the sandbox-mandate branch without needing bwrap or a real CLI.
test('createSession refuses an unsandboxed agent when browseRoots is set and allowUnsandboxedAgents is not true, but allows it when true', { skip: sandboxAvailable() || loadSandboxConfig().forceSandbox }, async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-sess-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  const allowed = mkdtempSync(join(tmpdir(), 'ccserver-sess-allowed-'));
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_CLAUDE_BIN = process.execPath;
  try {
    writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, browseRoots: [allowed], allowUnsandboxedAgents: false }));
    process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
    const blocked = await sessionManager.createSession({ cwd: allowed, cols: 80, rows: 24, shell: false, app: 'claude', sandbox: false });
    assert.equal(blocked.session, null, 'an agent must be refused, not silently unsandboxed, when allowUnsandboxedAgents is not true');
    assert.match(blocked.error, /^Cannot launch: sandbox\.config\.json sets "browseRoots"/);
    assert.match(blocked.error, /allowUnsandboxedAgents/);

    writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, browseRoots: [allowed], allowUnsandboxedAgents: true }));
    const bad = await sessionManager.createSession({ cwd: allowed, cols: 80, rows: 24, shell: false, app: 'claude', sandbox: false });
    // No sandbox backend here (test is skipped otherwise), so this either
    // spawns unsandboxed (allowed) or fails on host PATH resolution -- either
    // way it must NOT be refused for the browseRoots/allowUnsandboxedAgents
    // reason any more.
    if (!bad.session) assert.doesNotMatch(bad.error, /allowUnsandboxedAgents/);
    else sessionManager.destroySession(bad.sessionId, { keepSchedule: false });
  } finally {
    if (prevBin === undefined) delete process.env.CCSERVER_CLAUDE_BIN;
    else process.env.CCSERVER_CLAUDE_BIN = prevBin;
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(allowed, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// setScheduledPrompt captures the session's launch model into the persisted
// schedule entry so the auto-resume path replays it (persistSchedules).
test('setScheduledPrompt persists the session model into the schedule file', async () => {
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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

// setScheduledPrompt captures the session's permission mode into the persisted
// schedule entry so the auto-resume path replays it (persistSchedules).
test('setScheduledPrompt persists the session permissionMode into the schedule file', async () => {
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  assert.ok(res.session, 'shell session should spawn');
  try {
    // Shells always carry 'standard'; fabricate the commandcode mode the way
    // the model test above fabricates a model.
    res.session.permissionMode = 'yolo';
    assert.ok(sessionManager.setScheduledPrompt(res.sessionId, Date.now() + 5000, 'MARKER_PERMMODE'));
    const saved = JSON.parse(readFileSync(schedulePath(), 'utf-8'));
    const entry = saved.find((e) => e.text === 'MARKER_PERMMODE');
    assert.ok(entry, 'schedule persisted');
    assert.equal(entry.permissionMode, 'yolo', 'the permission mode survives into the persisted schedule');
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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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
test('createSession defaults Auto-Y on for workers, off for orchestrator/standalone', async () => {
  const spawn = (groupRole) => sessionManager.createSession({
    cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false, groupRole,
  });
  const worker = await spawn('workerA');
  const workerB = await spawn('workerB');
  const orch = await spawn('orchestrator');
  const standalone = await spawn(null);
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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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

  // Worker: no channel yet -> created and registered. Returns { sockPath, token }.
  const worker = await groupManager.resolveGroupMcpSocket(gid, 'workerA');
  assert.ok(worker && worker.sockPath, 'worker channel socket path returned');
  assert.ok(worker.token && worker.token.length >= 20, 'worker channel has a connection token');
  assert.equal(group.handoffChannels.get('workerA').sockPath, worker.sockPath);
  // Second call reuses the existing channel (same path + token).
  const worker2 = await groupManager.resolveGroupMcpSocket(gid, 'workerA');
  assert.deepEqual(worker2, worker);

  // Orchestrator: existing control broker is returned as-is.
  const orch = await groupManager.resolveGroupMcpSocket(gid, 'orchestrator');
  assert.equal(orch.sockPath, group.controlBroker.sockPath);
  assert.equal(orch.token, group.controlBroker.token);
  assert.notEqual(orch.token, worker.token, 'control and handoff tokens differ');
  // Simulate the orchestrator's pty exiting (broker stopped) -> resolver
  // brings the broker back (with a fresh token).
  groupManager.onOrchestratorExit(gid);
  assert.equal(group.controlBroker, null);
  const orch2 = await groupManager.resolveGroupMcpSocket(gid, 'orchestrator');
  assert.ok(orch2 && orch2.sockPath, 'control broker recreated');
  assert.equal(group.controlBroker.sockPath, orch2.sockPath);
  assert.equal(group.controlBroker.token, orch2.token);

  // Unknown group -> null (caller drops the prompt rather than orphan).
  assert.equal(await groupManager.resolveGroupMcpSocket('no-such-group', 'workerA'), null);
  groupManager.destroyGroup(gid);
});

// Fix 6: the "same project" live-session substitution must not inject into a
// same-cwd/same-app worker belonging to ANOTHER group -- covered by direct
// unit tests of the exported matcher (fireSchedule uses it verbatim).
test('matchesScheduleTarget is group+role scoped (no cross-group injection)', async () => {
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
test('matchesScheduleTarget is model-scoped (no cross-model injection)', async () => {
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

// A permission-mode-annotated schedule must only inject into a live session
// launched with the SAME mode -- never into a standard or differently-moded
// one (a yolo schedule replaying into a standard session would silently
// escalate its privileges, and vice versa). Legacy entries without the field
// count as 'standard' on both sides.
test('matchesScheduleTarget is permission-mode-scoped (no cross-mode injection)', async () => {
  const live = (over = {}) => ({
    cwd: '/srv/proj', shell: false, app: 'commandcode',
    model: null, permissionMode: 'standard', groupId: null, groupRole: null,
    exited: false, ptyProcess: {},
    ...over,
  });
  const entry = {
    cwd: '/srv/proj', shell: false, app: 'commandcode', model: null,
    permissionMode: 'yolo', groupId: null, groupRole: null,
  };

  assert.equal(sessionManager.matchesScheduleTarget(live(), entry), false);
  assert.equal(sessionManager.matchesScheduleTarget(live({ permissionMode: 'auto-accept' }), entry), false);
  assert.equal(sessionManager.matchesScheduleTarget(live({ permissionMode: 'yolo' }), entry), true);

  // Legacy entries (no permissionMode field) keep matching standard sessions only.
  const legacy = {
    cwd: '/srv/proj', shell: false, app: 'commandcode', model: null,
    groupId: null, groupRole: null,
  };
  assert.equal(sessionManager.matchesScheduleTarget(live(), legacy), true);
  assert.equal(sessionManager.matchesScheduleTarget(live({ permissionMode: 'yolo' }), legacy), false);
});

// Fix 3: auto-resume of a dead group member recreates its handoff channel,
// binds it to the new session, and re-registers the role.
test('fireSchedule auto-resume of a group member recreates its MCP channel and rebinds the role', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: '/tmp', orchestratorDir: `/srv/orch-${gid}` });

  const dead = await shellMember('/tmp', gid, 'workerA');
  const orch = await shellMember('/tmp', gid, 'orchestrator'); // keeps the group alive

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
  const member = await shellMember('/tmp', gid, 'workerA');
  const orch = await shellMember('/tmp', gid, 'orchestrator');

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

  const workerKeepAlive = await shellMember('/tmp', gid, 'workerA'); // keeps the group alive
  const deadOrch = await shellMember('/tmp', gid, 'orchestrator');
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

// Retire-first ordering for the seatbelt overlay: an exited-but-not-reaped
// orchestrator still owns its materialized CLAUDE.md/AGENTS.md
// (sandboxSeatbeltFiles). fireSchedule must retire it before the successor
// launches -- otherwise the successor sees the files as pre-existing, claims
// no ownership, and the predecessor's later teardown unlinks the live
// successor's overlay mid-session. Here the pty is killed directly so onExit
// marks it exited while it stays registered (open viewer tab).
test('fireSchedule retires an exited seatbelt-overlay predecessor before auto-resume', async () => {
  const gid = randomUUID();
  const orchestratorDir = join(runtimeDir, `orch-retire-${gid}`);
  await groupManager.createGroup({ groupId: gid, cwd: '/tmp', orchestratorDir });

  const workerKeepAlive = await shellMember('/tmp', gid, 'workerA');
  const deadOrch = await shellMember('/tmp', gid, 'orchestrator');
  const deadOrchId = deadOrch.id;

  mkdirSync(orchestratorDir, { recursive: true });
  writeFileSync(join(orchestratorDir, 'CLAUDE.md'), '# live rules\n');
  deadOrch.sandboxSeatbeltFiles = [join(orchestratorDir, 'CLAUDE.md')];
  deadOrch.ptyProcess.kill();
  const t0 = Date.now();
  while (!deadOrch.exited && Date.now() - t0 < 5000) await sleep(100);
  assert.ok(deadOrch.exited, 'predecessor pty exited but stays registered');

  assert.ok(sessionManager.setScheduledPrompt(deadOrchId, Date.now() + 700, 'MARKER_ORCH_RETIRE'));
  await sleep(2500); // branch 3: retire-first + resolvers + createSession

  assert.equal(sessionManager.getSession(deadOrchId), undefined, 'exited predecessor retired before resume');
  const member = groupManager.getGroup(gid).members.get('orchestrator');
  assert.ok(member && member !== deadOrchId, 'role rebound to the resumed session');

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

  const workerKeepAlive = await shellMember('/tmp', gid, 'workerA');
  const deadOrch = await shellMember('/tmp', gid, 'orchestrator');
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
    const res = await sessionManager.createSession({
      cwd: '/tmp', cols: 80, rows: 24, shell: false, sandbox: false, app: 'claude',
    });
    assert.ok(res.session, 'agent session should spawn');
    id = res.sessionId;
    const s = res.session;
    const sent = [];
    sessionManager.attachSocket(id, { readyState: 1, send: (m) => sent.push(m) });
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
    const named = await sessionManager.createSession({
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

    const fallback = await sessionManager.createSession({
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

    const forced = await sessionManager.createSession({
      cwd: '/tmp', cols: 80, rows: 24, shell: false, sandbox: false, app: 'claude', isReviewJob: true,
    });
    assert.ok(forced.session, 'agent session should spawn');
    ids.push(forced.sessionId);
    await sleep(500);
    const forcedIdentity = forced.session.outputBuffer.join('').trim();
    assert.notEqual(forcedIdentity, '', 'isReviewJob:true must get the reviewer identity even with reviewerMcp off');
    assert.deepEqual(JSON.parse(forcedIdentity), { sessionId: forced.sessionId });

    const normal = await sessionManager.createSession({
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
// an arbitrary request body from anyone holding CCSERVER_TOKEN. isReviewJob
// has a real effect, so routes/sessions.js's POST handler must strip it from
// request.body before it ever reaches createSession. This exercises that
// boundary specifically (the test above only covers the safe, trusted,
// in-process call shape).
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
test('sandboxHomeConflict: refuses a wipe while a live sandboxed session shares the HOME', async () => {
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

test('SandboxHomeLaunchReservations closes the async launch window without blocking reuse launches', () => {
  const reservations = new sessionManager.SandboxHomeLaunchReservations();
  const home = '/tmp/ccserver-reservation-test-home';

  assert.equal(reservations.reserve(home, { fresh: true }), true);
  assert.equal(reservations.count(home), 1);
  assert.equal(reservations.reserve(home, { fresh: true }), false, 'a second fresh launch cannot race the first wipe');

  assert.equal(reservations.reserve(home, { fresh: false }), true, 'reuse launches may coexist');
  assert.equal(reservations.count(home), 2);
  reservations.release(home);
  reservations.release(home);
  assert.equal(reservations.count(home), 0);

  const live = [{ exited: false, sandbox: true, cwd: '/srv/project' }];
  const liveHome = persistentHomeDir('/srv/project');
  assert.equal(reservations.reserve(liveHome, { fresh: true, liveSessions: live }), false, 'live sessions still block a fresh launch');
});

// sandboxHomeInUse is the endpoint-facing count built from the same rule;
// with only shell (unsandboxed) sessions in the registry it must read 0 for
// any cwd.
test('sandboxHomeInUse counts only live sandboxed sessions', async () => {
  const prevHome = process.env.CCSERVER_SANDBOX_HOME_ROOT;
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(runtimeDir, 'sandbox-home');
  try {
    const shell = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const { sessionId, session } = res;
  assert.ok(session, 'shell session should spawn');
  const sent = [];
  sessionManager.attachSocket(sessionId, { readyState: 1, send: (m) => sent.push(m) });
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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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
    sessionManager.attachSocket(sessionId, { readyState: 1, send: (m) => sent.push(m) });

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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
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
  const res = await sessionManager.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const { sessionId, session } = res;
  assert.ok(session, 'shell session should spawn');
  const sent = [];
  sessionManager.attachSocket(sessionId, { readyState: 1, send: (m) => sent.push(m) });
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

// REST contract: a launch without an existing cwd is refused.
test('createSessionViaApi: a launch without an existing cwd is refused', async () => {
  const { createSessionViaApi } = await import('../routes/sessions.js');
  const bad = await createSessionViaApi({});
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'validation', 'a launch without cwd is refused');
});
