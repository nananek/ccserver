// usageMcp.js -- the server-global ccserver-usage "get_usage" tool wiring.
// Tests the pure injection decision (shouldInjectUsage) and the usageEnabled/
// getUsageSockPath helpers. The broker lifecycle (Unix socket + MCP wire) is
// covered in mcpBroker.test.js, mirroring notify.test.js / mcpBroker.test.js's
// split for ccserver-notify.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { usageEnabled, shouldInjectUsage, getUsageSockPath } from './usageMcp.js';

// Point CCSERVER_SANDBOX_CONFIG at a temp file and CCSERVER_CLAUDE_BIN at a
// deterministic (present or absent) path, so usageEnabled()'s "claude
// installed" half never depends on what happens to be on this host's PATH.
async function withUsageConfig(sandboxJson, claudeBin, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-usage-'));
  const cfgPath = join(dir, 'sandbox.config.json');
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  try {
    writeFileSync(cfgPath, JSON.stringify(sandboxJson));
    process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
    if (claudeBin === undefined) delete process.env.CCSERVER_CLAUDE_BIN;
    else process.env.CCSERVER_CLAUDE_BIN = claudeBin;
    await fn();
  } finally {
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    if (prevBin === undefined) delete process.env.CCSERVER_CLAUDE_BIN;
    else process.env.CCSERVER_CLAUDE_BIN = prevBin;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('usageEnabled: claude installed + usageMcp unset -> false (default off)', async () => {
  await withUsageConfig({}, process.execPath, async () => {
    assert.equal(usageEnabled(), false);
  });
});

test('usageEnabled: claude installed + usageMcp:true -> true', async () => {
  await withUsageConfig({ usageMcp: true }, process.execPath, async () => {
    assert.equal(usageEnabled(), true);
  });
});

test('usageEnabled: showUsage does not control MCP injection', async () => {
  await withUsageConfig({ showUsage: false, usageMcp: true }, process.execPath, async () => {
    assert.equal(usageEnabled(), true);
  });
  await withUsageConfig({ showUsage: true, usageMcp: false }, process.execPath, async () => {
    assert.equal(usageEnabled(), false);
  });
});

test('usageEnabled: claude not installed -> false regardless of showUsage', async () => {
  await withUsageConfig({}, '/no/such/claude-xyz', async () => {
    assert.equal(usageEnabled(), false);
  });
  await withUsageConfig({ showUsage: true }, '/no/such/claude-xyz', async () => {
    assert.equal(usageEnabled(), false);
  });
});

test('shouldInjectUsage: claude sessions only, gated on usageEnabled', () => {
  const base = { shell: false, app: 'claude', usageEnabled: true };
  assert.equal(shouldInjectUsage(base), true, 'standalone claude session');
  assert.equal(shouldInjectUsage({ ...base, shell: true }), false, 'shell sessions never');
  assert.equal(shouldInjectUsage({ ...base, app: 'opencode' }), false, 'opencode has no /usage equivalent');
  assert.equal(shouldInjectUsage({ ...base, app: 'copilot' }), false, 'copilot has no CLI-arg/env MCP injection');
  assert.equal(shouldInjectUsage({ ...base, app: null }), false, 'shells (app null) never');
  assert.equal(shouldInjectUsage({ ...base, usageEnabled: false }), false, 'feature disabled -> never');
});

// Unlike shouldInjectNotify, shouldInjectUsage takes no groupId/groupRole at
// all -- every member of a combo group running claude gets it, worker and
// orchestrator alike. Asserted by simply never threading those fields through
// and confirming the decision is unaffected by extra unrelated properties.
test('shouldInjectUsage: worker/orchestrator/standalone are not distinguished', () => {
  const base = { shell: false, app: 'claude', usageEnabled: true };
  assert.equal(shouldInjectUsage({ ...base, groupId: 'g1', groupRole: 'workerA' }), true, 'workers get it too');
  assert.equal(shouldInjectUsage({ ...base, groupId: 'g1', groupRole: 'orchestrator' }), true);
  assert.equal(shouldInjectUsage({ ...base, groupId: null, groupRole: null }), true, 'standalone');
});

test('getUsageSockPath: distinct socket file under XDG_RUNTIME_DIR, not the notify socket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-usage-sock-'));
  const prev = process.env.XDG_RUNTIME_DIR;
  try {
    process.env.XDG_RUNTIME_DIR = dir;
    const sockPath = getUsageSockPath();
    assert.equal(sockPath, join(dir, 'ccserver-usage.d', 'sock'));
    assert.ok(!sockPath.includes('notify'), 'usage socket must not collide with the notify socket name');
  } finally {
    if (prev === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = prev;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
