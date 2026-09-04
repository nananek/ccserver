// Unit tests for the pure GetAccountRateLimitsResponse -> UsageButton shape
// mapping. Does NOT cover getCodexUsage()/capture()'s actual capture path --
// that spawns the real `codex` binary, which isn't something a unit test
// should trigger (see server/routes/usage.test.js's header comment for the
// same reasoning about Claude's /api/usage). The hiddenApps refusal below is
// an exception: it's checked before resolveApp('codex') even runs (see
// capture()'s comment), so it never reaches a spawn and needs no real
// install -- unlike claude, codex has no CCSERVER_*_BIN override to fake one
// with (see sandbox-resolve.test.js's header comment).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mapRateLimits, getCodexUsage } from './codexUsage.js';

test('mapRateLimits: primary + secondary windows both present', () => {
  const result = mapRateLimits({
    limitId: 'codex',
    limitName: null,
    planType: 'plus',
    primary: { usedPercent: 42, resetsAt: 1_700_000_000, windowDurationMins: 300 },
    secondary: { usedPercent: 17, resetsAt: 1_700_600_000, windowDurationMins: 10080 },
  });

  assert.equal(result.plan, 'plus');
  assert.equal(result.cost, null);
  assert.equal(result.limits.length, 2);

  const [primary, secondary] = result.limits;
  assert.equal(primary.label, '5時間');
  assert.equal(primary.pct, 42);
  assert.equal(primary.resetAt, 1_700_000_000 * 1000);
  assert.equal(primary.windowMs, 300 * 60 * 1000);
  assert.equal(typeof primary.resets, 'string');

  assert.equal(secondary.label, '週次');
  assert.equal(secondary.pct, 17);
  assert.equal(secondary.resetAt, 1_700_600_000 * 1000);
  assert.equal(secondary.windowMs, 10080 * 60 * 1000);
});

test('mapRateLimits: only primary present -- secondary omitted entirely', () => {
  const result = mapRateLimits({
    planType: 'pro',
    primary: { usedPercent: 5, resetsAt: 1_700_000_000, windowDurationMins: 60 },
    secondary: null,
  });

  assert.equal(result.limits.length, 1);
  assert.equal(result.limits[0].label, '1時間');
});

test('mapRateLimits: null rateLimits -> empty limits, null plan/cost', () => {
  const result = mapRateLimits(null);
  assert.deepEqual(result, { limits: [], cost: null, plan: null });
});

test('mapRateLimits: windowDurationMins/resetsAt null -> resetAt/windowMs/resets null, pct still surfaced', () => {
  const result = mapRateLimits({
    planType: null,
    primary: { usedPercent: 63, resetsAt: null, windowDurationMins: null },
    secondary: null,
  });

  assert.equal(result.plan, null);
  assert.equal(result.limits.length, 1);
  const [primary] = result.limits;
  assert.equal(primary.pct, 63);
  assert.equal(primary.resetAt, null);
  assert.equal(primary.windowMs, null);
  assert.equal(primary.resets, null);
  assert.equal(primary.label, '使用量');
});

test('mapRateLimits: non-multiple-of-60 minutes falls back to a minute label', () => {
  const result = mapRateLimits({
    primary: { usedPercent: 1, resetsAt: null, windowDurationMins: 90 },
    secondary: null,
  });
  assert.equal(result.limits[0].label, '90分');
});

test('mapRateLimits: non-weekly day-multiple gets a day label', () => {
  const result = mapRateLimits({
    primary: null,
    secondary: { usedPercent: 9, resetsAt: null, windowDurationMins: 2 * 24 * 60 },
  });
  assert.equal(result.limits.length, 1);
  assert.equal(result.limits[0].label, '2日');
});

// Self-review (issue #105): sandbox.config.json's hiddenApps must not be a
// purely cosmetic picker-hiding feature. GET /api/usage?app=codex (and the
// warmCodexUsage() background job that calls it once at boot) would
// otherwise still spawn a real `codex` process even when the operator listed
// it in hiddenApps specifically because they haven't contracted for it --
// there is no launch picker on this endpoint for the client-side hide to
// protect. capture() checks hiddenApps before resolveApp('codex') even runs,
// so this assertion holds regardless of whether codex happens to be
// installed on the machine running this suite.
test('getCodexUsage refuses when codex is hidden, without ever spawning it', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-codex-usage-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ hiddenApps: ['codex'] }));
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const res = await getCodexUsage({ force: true });
    assert.equal(res.usage, null, 'no usage may be captured for a hidden app');
    assert.match(res.error, /codex is hidden on this server/);
    assert.match(res.error, /hiddenApps/, 'the error names the config key responsible');
  } finally {
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
