// Route-level unit test for the orchestrator-restart resume policy. The
// restart options are built by the pure orchestratorRestartSessionOpts()
// helper (exercised here directly -- no fastify/pty machinery needed); the
// route itself is a thin pass-through.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestratorRestartSessionOpts, orchestratorDirForCwd, groupExistsForCwd } from './groups.js';

test('orchestratorRestartSessionOpts: restart continues the last conversation', () => {
  const opts = orchestratorRestartSessionOpts({
    group: { id: 'group-1', orchestratorDir: '/tmp/orch/group-1' },
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
});

test('orchestratorRestartSessionOpts: resumeLast is independent of the app', () => {
  for (const app of ['claude', 'opencode']) {
    const opts = orchestratorRestartSessionOpts({
      group: { id: 'g', orchestratorDir: '/d' },
      app,
      mcpSocketPath: '/s',
    });
    assert.equal(opts.resumeLast, true, `resumeLast must be set for ${app}`);
    assert.equal(opts.app, app);
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
