// Route-level unit test for the orchestrator-restart resume policy. The
// restart options are built by the pure orchestratorRestartSessionOpts()
// helper (exercised here directly -- no fastify/pty machinery needed); the
// route itself is a thin pass-through.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestratorRestartSessionOpts, orchestratorDirForCwd, groupExistsForCwd, orchestratorRestartFailureStatus, launchFailureCode, workerLaunchFailureCode } from './groups.js';
import { isInfrastructureError } from '../ws/sessionManager.js';

test('orchestratorRestartSessionOpts: restart continues the last conversation', () => {
  const opts = orchestratorRestartSessionOpts({
    group: { id: 'group-1', cwd: '/srv/proj', orchestratorDir: '/tmp/orch/group-1' },
    app: 'claude',
    mcpSocketPath: '/tmp/mcp.sock',
  });
  assert.equal(opts.cwd, '/tmp/orch/group-1');
  assert.equal(opts.cols, 80);
  assert.equal(opts.rows, 24);
  assert.equal(opts.sandbox, true);
  assert.equal(opts.sandboxOpts, null);
  assert.equal(opts.app, 'claude');
  assert.equal(opts.groupId, 'group-1');
  assert.equal(opts.groupRole, 'orchestrator');
  assert.equal(opts.mcpSocketPath, '/tmp/mcp.sock');
  assert.equal(opts.resumeLast, true, 'restart must resume the group\u2019s previous conversation');
  assert.equal(opts.projectName, 'proj', 'notify attribution uses the real project basename, not the hashed orchestrator dir');
});

test('orchestratorRestartSessionOpts: resumeLast is independent of the app', () => {
  for (const app of ['claude', 'opencode']) {
    const opts = orchestratorRestartSessionOpts({
      group: { id: 'g', cwd: '/srv/proj', orchestratorDir: '/d' },
      app,
      mcpSocketPath: '/s',
    });
    assert.equal(opts.resumeLast, true, `resumeLast must be set for ${app}`);
    assert.equal(opts.app, app);
    assert.equal(opts.projectName, 'proj', `the real project basename is attributed for ${app}`);
  }
});

test('isInfrastructureError: infra failures surface as 500, request rejections stay 400', () => {
  // Mirrors the actual createSession() message shapes in server/ws/sessionManager.js;
  // if those messages change, this test forces INFRA_ERROR_PREFIXES to follow.
  assert.equal(isInfrastructureError('Failed to build sandbox: bwrap not found'), true);
  assert.equal(isInfrastructureError('Failed to spawn "claude": spawn ENOENT'), true);
  assert.equal(isInfrastructureError('Cannot launch: sandbox.config.json sets "forceSandbox": true, but bwrap is not available on this host. Install bwrap (bubblewrap) or disable forceSandbox.'), true);
  // Request-as-given rejections must keep mapping to 400.
  assert.equal(isInfrastructureError('Cannot launch: copilot is hidden on this server (sandbox.config.json\'s "hiddenApps"). Remove it from hiddenApps to allow launches.'), false);
  assert.equal(isInfrastructureError('Cannot launch: codex is not installed on this server (searched /usr/bin).'), false);
  assert.equal(isInfrastructureError('Cannot launch in the filesystem root (/) -- claude aborts immediately there. Choose a working directory first.'), false);
  // Defensive: the restart route passes `res.error || 'unknown error'`.
  assert.equal(isInfrastructureError('unknown error'), false);
  assert.equal(isInfrastructureError(null), false);
  assert.equal(isInfrastructureError(undefined), false);
  assert.equal(isInfrastructureError(''), false);
});

test('orchestratorRestartFailureStatus: infra faults are 500, request rejections stay 400', () => {
  // The restart route must branch on this (it is the only production caller):
  // createSession() CAN fail server-side, so a fixed 400 misclassifies.
  assert.equal(orchestratorRestartFailureStatus('Failed to build sandbox: bwrap not found'), 500);
  assert.equal(orchestratorRestartFailureStatus('Failed to spawn "claude": spawn ENOENT'), 500);
  assert.equal(orchestratorRestartFailureStatus('Cannot launch: sandbox.config.json sets "forceSandbox": true, but bwrap is not available.'), 500);
  // Request-as-given rejections -- including the sandbox-home conflict, which
  // is a state conflict (close the using tab first), not an infra fault.
  assert.equal(orchestratorRestartFailureStatus('Cannot launch: copilot is hidden on this server.'), 400);
  assert.equal(orchestratorRestartFailureStatus('このプロジェクトのサンドボックスを利用中のセッションがあるため、新規作成（前回環境の破棄）できません。先にタブを閉じてください。'), 400);
  // Defensive: the route passes `res.error || 'unknown error'`, and a missing
  // session without an error string must stay 400.
  assert.equal(orchestratorRestartFailureStatus('unknown error'), 400);
  assert.equal(orchestratorRestartFailureStatus(null), 400);
  assert.equal(orchestratorRestartFailureStatus(undefined), 400);
  assert.equal(orchestratorRestartFailureStatus(''), 400);
});

test('launchFailureCode: POST /groups launch failures split internal/validation like the restart route', () => {
  // Same classification core as orchestratorRestartFailureStatus, but in the
  // { ok, code } vocabulary of launchGroupFromSpec/fail().
  assert.equal(launchFailureCode('Failed to build sandbox: bwrap not found'), 'internal');
  assert.equal(launchFailureCode('Failed to spawn "codex": spawn ENOENT'), 'internal');
  assert.equal(launchFailureCode('Cannot launch: sandbox.config.json sets "forceSandbox": true, but bwrap is not available.'), 'internal');
  assert.equal(launchFailureCode('Cannot launch: copilot is hidden on this server.'), 'validation');
  assert.equal(launchFailureCode('Cannot launch: codex is not installed on this server (searched /usr/bin).'), 'validation');
  assert.equal(launchFailureCode('Cannot launch in the filesystem root (/) -- claude aborts immediately there. Choose a working directory first.'), 'validation');
  assert.equal(launchFailureCode('このプロジェクトのサンドボックスを利用中のセッションがあるため、新規作成（前回環境の破棄）できません。先にタブを閉じてください。'), 'validation');
  assert.equal(launchFailureCode('unknown error'), 'validation');
  assert.equal(launchFailureCode(null), 'validation');
  assert.equal(launchFailureCode(undefined), 'validation');
  assert.equal(launchFailureCode(''), 'validation');
});

test('workerLaunchFailureCode: channel-failed is internal, the rest follows the message', () => {
  // addMember's stable error code for handoff broker (unix socket) creation
  // failure -- server-side fault regardless of the message text.
  assert.equal(workerLaunchFailureCode({ error: 'channel-failed', message: 'failed to create handoff channel' }), 'internal');
  // spawn-failed passes the createSession error through as message, so the
  // infra/request split still applies.
  assert.equal(workerLaunchFailureCode({ error: 'spawn-failed', message: 'Failed to spawn "codex": spawn ENOENT' }), 'internal');
  assert.equal(workerLaunchFailureCode({ error: 'spawn-failed', message: 'Failed to build sandbox: bwrap not found' }), 'internal');
  assert.equal(workerLaunchFailureCode({ error: 'spawn-failed', message: 'Cannot launch: codex is not installed on this server (searched /usr/bin).' }), 'validation');
  // Request-as-given rejections keep their codes.
  assert.equal(workerLaunchFailureCode({ error: 'bad-request', message: 'app must be claude, opencode, or codex' }), 'validation');
  assert.equal(workerLaunchFailureCode({ error: 'invalid-role', message: 'only worker sessions can be replaced' }), 'validation');
  assert.equal(workerLaunchFailureCode({ error: 'too-many-members', message: 'group is full' }), 'validation');
  // Defensive shapes never surface as 500.
  assert.equal(workerLaunchFailureCode({ error: 'boom' }), 'validation');
  assert.equal(workerLaunchFailureCode(null), 'validation');
  assert.equal(workerLaunchFailureCode(undefined), 'validation');
});

test('orchestratorDirForCwd is deterministic per project path', () => {
  const a = orchestratorDirForCwd('/srv/proj');
  assert.equal(orchestratorDirForCwd('/srv/proj'), a, 'same cwd -> same dir');
  assert.equal(orchestratorDirForCwd('/srv/proj/'), a, 'trailing slash normalizes to the same dir');
  assert.notEqual(orchestratorDirForCwd('/srv/other'), a, 'different cwd -> different dir');
});

test('groupExistsForCwd matches an existing group for the same project', () => {
  const groups = [
    { groupId: 'g1', cwd: '/srv/proj', liveCount: 2 },
    { groupId: 'g2', cwd: '/srv/other', liveCount: 0 },
  ];
  assert.equal(groupExistsForCwd('/srv/proj', groups).groupId, 'g1');
  assert.equal(groupExistsForCwd('/srv/proj/', groups).groupId, 'g1', 'cwd spelling variants match');
  assert.equal(groupExistsForCwd('/srv/nowhere', groups), null);
});

test('orchestratorRestartSessionOpts carries model and member-specific sandbox options', () => {
  const opts = orchestratorRestartSessionOpts({
    group: { id: 'g', cwd: '/srv/proj', orchestratorDir: '/d' },
    app: 'opencode',
    model: 'gpt-5',
    sandboxOpts: { gpg: true, sshAgent: false },
    mcpSocketPath: '/s',
  });
  assert.equal(opts.app, 'opencode');
  assert.equal(opts.model, 'gpt-5');
  assert.deepEqual(opts.sandboxOpts, { gpg: true, sshAgent: false });
  assert.equal(opts.projectName, 'proj');
});

// memberSpecFromBody is module-private, so the POST normalization contract is
// exercised through the exported pieces it feeds: orchestratorRestartSessionOpts
// (above) and the presence-aware memberPrefs handling in groupManager (covered
// in groupManager.test.js). The wire-level acceptance -- omitted app/model
// fields fall back to persisted role preferences -- is verified end-to-end in
// mcpBroker.test.js (open_tab) and through the groupManager precedence tests.
test('orchestratorRestartSessionOpts: default model/sandboxOpts stay null (no flag leakage)', () => {
  const opts = orchestratorRestartSessionOpts({
    group: { id: 'g', cwd: '/srv/proj', orchestratorDir: '/d' },
    app: 'claude',
    mcpSocketPath: '/s',
  });
  assert.equal(opts.model, null);
  assert.equal(opts.sandboxOpts, null);
});

test('orchestratorRestartSessionOpts: a group without a cwd keeps projectName null (no crash)', () => {
  const opts = orchestratorRestartSessionOpts({
    group: { id: 'g', cwd: null, orchestratorDir: '/d' },
    app: 'claude',
    mcpSocketPath: '/s',
  });
  assert.equal(opts.projectName, null, 'missing group cwd must not throw basename()');
});

test('orchestratorRestartSessionOpts: orchestratorClaudeMdSrc passes through to the session opts', () => {
  const withSrc = orchestratorRestartSessionOpts({
    group: { id: 'g', cwd: '/srv/proj', orchestratorDir: '/d' },
    app: 'claude',
    mcpSocketPath: '/s',
    orchestratorClaudeMdSrc: '/host/orchestrator-generated/abc.md',
  });
  assert.equal(withSrc.orchestratorClaudeMdSrc, '/host/orchestrator-generated/abc.md');

  const withoutSrc = orchestratorRestartSessionOpts({
    group: { id: 'g', cwd: '/srv/proj', orchestratorDir: '/d' },
    app: 'claude',
    mcpSocketPath: '/s',
  });
  assert.equal(withoutSrc.orchestratorClaudeMdSrc, null, 'defaults to null when omitted');
});

// --- normalizeWorkers: canonical workers[] payload + legacy adapter --------

import { normalizeWorkers, MAX_WORKERS } from './groups.js';
import * as groupManagerModule from '../ws/groupManager.js';

test('MAX_WORKERS is the member cap minus the orchestrator', () => {
  assert.equal(MAX_WORKERS, groupManagerModule.MAX_GROUP_MEMBERS - 1);
  assert.equal(MAX_WORKERS, 7);
});

test('normalizeWorkers: legacy payloads without workers[] keep the workerA/workerB adapter', () => {
  const legacy = normalizeWorkers({
    workerA: { app: 'claude', model: 'm1' },
    workerB: { sandboxOpts: { gpg: true, sshAgent: false } },
    orchestrator: { app: 'opencode' },
  });
  assert.deepEqual(legacy.workers.map((w) => w.role), ['workerA', 'workerB']);
  assert.deepEqual(legacy.workers[0].spec, { app: 'claude', model: 'm1' });
  assert.deepEqual(legacy.workers[1].spec, { sandboxOpts: { gpg: true, sshAgent: false } });

  // Fully empty legacy body still normalizes (all prefs fall back later).
  const empty = normalizeWorkers({});
  assert.deepEqual(empty.workers.map((w) => w.role), ['workerA', 'workerB']);
  assert.deepEqual(empty.workers[0].spec, {});
});

test('normalizeWorkers: legacy adapter carries sandboxOpts.tools through (regression: PR#114 review)', () => {
  const legacy = normalizeWorkers({
    workerA: { sandboxOpts: { gpg: true, tools: { rtk: true, codeReviewGraph: false } } },
    workerB: { sandboxOpts: { gpg: false } },
  });
  assert.deepEqual(legacy.workers[0].spec.sandboxOpts, {
    gpg: true,
    sshAgent: false,
    tools: { rtk: true, codeReviewGraph: false },
  });
  // No tools provided -> no tools key (mirrors groupManager.normalizeSandboxOpts).
  assert.deepEqual(legacy.workers[1].spec.sandboxOpts, { gpg: false, sshAgent: false });
});

test('normalizeWorkers: a valid workers[] snapshot passes through normalized', () => {
  const res = normalizeWorkers({
    workers: [
      { name: '実装担当', role: 'workerImplement', app: 'codex', model: 'gpt-5.4' },
      { role: 'workerReview', app: 'claude' },
      { role: 'workerExtra' },
    ],
  });
  assert.equal(res.error, undefined);
  assert.equal(res.workers.length, 3);
  assert.deepEqual(res.workers[0], { role: 'workerImplement', spec: { name: '実装担当', app: 'codex', model: 'gpt-5.4' } });
  assert.deepEqual(res.workers[1].spec, { app: 'claude' });
  assert.deepEqual(res.workers[2].spec, {});
});

test('normalizeWorkers: structural rejections', () => {
  assert.match(normalizeWorkers({ workers: 'nope' }).error, /must be an array/);
  assert.match(normalizeWorkers({ workers: [] }).error, /at least one/);
  assert.match(
    normalizeWorkers({ workers: Array.from({ length: 8 }, (_, i) => ({ role: `workerN${i}` })) }).error,
    /too many workers/,
  );
  assert.ok(Array.from({ length: MAX_WORKERS }, (_, i) => ({ role: `workerN${i}` })));
  assert.equal(normalizeWorkers({ workers: Array.from({ length: MAX_WORKERS }, (_, i) => ({ role: `workerN${i}` })) }).error, undefined,
    'exactly MAX_WORKERS entries are accepted');
});

test('normalizeWorkers: duplicate roles and bad entries are refused with the index in the message', () => {
  assert.match(normalizeWorkers({ workers: [{ role: 'workerA' }, { role: 'workerA' }] }).error, /duplicate worker role: workerA/);
  assert.match(normalizeWorkers({ workers: [{ role: 'orchestrator' }] }).error, /workers\[0\]/);
  assert.match(normalizeWorkers({ workers: [{ role: 'workerOk' }, { name: '' }] }).error, /workers\[1\]/);
  assert.match(normalizeWorkers({ workers: [{ role: 'workerX', app: 'copilot' }] }).error, /not supported in groups/);
  assert.match(normalizeWorkers({ workers: [{ role: 'workerX', model: 5 }] }).error, /model must be a string or null/);
});

test('normalizeWorkers: per-entry sandboxOpts mirror memberSpecFromBody semantics', () => {
  const res = normalizeWorkers({ workers: [
    { role: 'workerS', sandboxOpts: { gpg: 1, sshAgent: 'yes' } },
    { role: 'workerT', sandboxOpts: 'bogus' },
  ]});
  assert.deepEqual(res.workers[0].spec.sandboxOpts, { gpg: true, sshAgent: true });
  assert.deepEqual(res.workers[1].spec.sandboxOpts, null);
});

test('normalizeWorkers: workers[] sandboxOpts.tools survives normalization (regression: PR#114 review, groups.js was dropping tools)', () => {
  const res = normalizeWorkers({ workers: [
    { role: 'workerRtk', sandboxOpts: { gpg: true, sshAgent: false, tools: { rtk: true, codeReviewGraph: true } } },
    { role: 'workerMixed', sandboxOpts: { tools: { rtk: 1, codeReviewGraph: 0 } } },
    { role: 'workerBadTools', sandboxOpts: { gpg: true, tools: 'nope' } },
    { role: 'workerNoTools', sandboxOpts: { gpg: true } },
  ]});
  assert.deepEqual(res.workers[0].spec.sandboxOpts, {
    gpg: true,
    sshAgent: false,
    tools: { rtk: true, codeReviewGraph: true },
  });
  assert.deepEqual(res.workers[1].spec.sandboxOpts, {
    gpg: false,
    sshAgent: false,
    tools: { rtk: true, codeReviewGraph: false },
  });
  // Non-object tools is treated as absent, same as normalizeSandboxOpts.
  assert.deepEqual(res.workers[2].spec.sandboxOpts, { gpg: true, sshAgent: false });
  // No tools key at all -> no tools key in the output.
  assert.deepEqual(res.workers[3].spec.sandboxOpts, { gpg: true, sshAgent: false });
});

test('normalizeWorkers: workers explicitly null falls back to the legacy adapter', () => {
  const res = normalizeWorkers({ workers: null, workerA: { app: 'claude' } });
  assert.deepEqual(res.workers.map((w) => w.role), ['workerA', 'workerB']);
  assert.deepEqual(res.workers[0].spec, { app: 'claude' });
});
