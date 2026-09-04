// Route-level unit test for the orchestrator-restart resume policy. The
// restart options are built by the pure orchestratorRestartSessionOpts()
// helper (exercised here directly -- no fastify/pty machinery needed); the
// route itself is a thin pass-through.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestratorRestartSessionOpts, orchestratorDirForCwd, groupExistsForCwd } from './groups.js';

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

test('normalizeWorkers: workers explicitly null falls back to the legacy adapter', () => {
  const res = normalizeWorkers({ workers: null, workerA: { app: 'claude' } });
  assert.deepEqual(res.workers.map((w) => w.role), ['workerA', 'workerB']);
  assert.deepEqual(res.workers[0].spec, { app: 'claude' });
});
