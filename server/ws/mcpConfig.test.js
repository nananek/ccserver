// buildMcpConfigArgsAndEnv -- the per-CLI MCP registration injection for
// combo-launched sessions. claude gets an inline `--mcp-config <JSON>` CLI
// arg (process-scoped, no ~/.claude.json mutation); opencode gets an
// OPENCODE_CONFIG_CONTENT env var (deep-merged, no file written). Both point
// at the fixed in-sandbox bridge command. Pure function -- no deps, no I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpConfigArgsAndEnv } from './mcpConfig.js';

test('claude gets an inline --mcp-config JSON pointing at the sandbox bridge', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('claude');
  assert.equal(args[0], '--mcp-config');
  assert.equal(args.length, 2, 'exactly one flag + one inline JSON argument');
  const cfg = JSON.parse(args[1]);
  assert.deepEqual(cfg.mcpServers.ccserver, {
    type: 'stdio',
    command: '/ccserver-sandbox-mcp-bridge',
    args: [],
  });
  assert.deepEqual(env, {}, 'claude needs no env injection');
});

test('opencode gets OPENCODE_CONFIG_CONTENT env (local command bridge), no CLI args', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('opencode');
  assert.deepEqual(args, []);
  const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(cfg.mcp.ccserver.type, 'local');
  assert.deepEqual(cfg.mcp.ccserver.command, ['/ccserver-sandbox-mcp-bridge']);
});

test('unknown app falls back to the claude-style CLI arg (default branch)', () => {
  const { args } = buildMcpConfigArgsAndEnv('shell');
  assert.equal(args[0], '--mcp-config');
  assert.ok(JSON.parse(args[1]).mcpServers.ccserver);
});
