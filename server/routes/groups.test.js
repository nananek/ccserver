// Route-level unit test for the orchestrator-restart resume policy. The
// restart options are built by the pure orchestratorRestartSessionOpts()
// helper (exercised here directly -- no fastify/pty machinery needed); the
// route itself is a thin pass-through.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestratorRestartSessionOpts } from './groups.js';

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
