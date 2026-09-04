// getUsage()'s capture() spawns a real `claude` process for most inputs, so
// (per routes/usage.test.js's header comment) this suite deliberately covers
// only the refusal paths that return BEFORE any spawn happens -- same
// technique as sessionManager.test.js's "refuses an uninstalled agent" test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getUsage } from './usage.js';

// Self-review (issue #105): sandbox.config.json's hiddenApps must not be a
// purely cosmetic picker-hiding feature. GET /api/usage (and the warmUsage()
// background job that calls it once at boot) would otherwise still spawn a
// real `claude` process even when the operator listed it in hiddenApps
// specifically because they haven't contracted for it -- there is no launch
// picker on this endpoint for the client-side hide to protect. Pin
// CCSERVER_CLAUDE_BIN at a real, always-executable file (the running node
// binary) so claude reads as INSTALLED -- the hidden check must fire even
// when the app is present, and must fire before capture() would otherwise
// spawn anything.
test('getUsage refuses when claude is hidden, without ever spawning it', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-usage-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ hiddenApps: ['claude'] }));
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_CLAUDE_BIN = process.execPath;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const res = await getUsage({ force: true });
    assert.equal(res.usage, null, 'no usage may be captured for a hidden app');
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
