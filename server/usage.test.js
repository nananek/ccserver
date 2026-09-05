// getUsage()'s capture() spawns a real `claude` process for most inputs, so
// (per routes/usage.test.js's header comment) this suite deliberately covers
// only the refusal paths that return BEFORE any spawn happens -- same
// technique as sessionManager.test.js's "refuses an uninstalled agent" test.
//
// parseUsage() itself is a pure function (no spawn involved), so it's tested
// directly below against raw --ax-screen-reader text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getUsage, parseUsage } from './usage.js';

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

// Issue #109: the async re-render the /usage screen goes through (Scanning
// local sessions... -> Refreshing...) can land a frame where a leftover UI
// string is concatenated onto the front of a percent/Resets line with no
// newline in between, e.g. "Esc to cancelResets 5:40pm (Asia/Tokyo)". The
// percent/Resets regexes used to be anchored at line-start (`^`), so such a
// frame either dropped the reset time (resets-line contamination) or the
// whole limit block (percent-line contamination), silently and without
// looksReady() ever noticing. These regressions pin the fix (line-end anchor
// only) against the exact shapes from the issue report, plus a clean-input
// case to guard against regressing the un-contaminated path.

test('parseUsage: clean input (no mid-line prefix) parses both blocks', () => {
  const raw = [
    'Current session',
    '87% 87% used',
    'Resets 5:40pm (Asia/Tokyo)',
    'Current week (all models)',
    '46% 46% used',
    'Resets Jul 10, 2am (Asia/Tokyo)',
  ].join('\n');

  const parsed = parseUsage(raw);
  assert.equal(parsed.limits.length, 2);

  const session = parsed.limits.find((l) => l.label === 'Current session');
  assert.equal(session?.pct, 87);
  assert.equal(session?.resets, '5:40pm (Asia/Tokyo)');

  const week = parsed.limits.find((l) => l.label === 'Current week (all models)');
  assert.equal(week?.pct, 46);
  assert.equal(week?.resets, 'Jul 10, 2am (Asia/Tokyo)');
});

test('parseUsage: mid-line prefix on the Resets line still yields resets/resetAt', () => {
  const raw = [
    'Current session',
    '87% 87% used',
    'Esc to cancelResets 5:40pm (Asia/Tokyo)',
  ].join('\n');

  const parsed = parseUsage(raw);
  assert.equal(parsed.limits.length, 1);
  const session = parsed.limits[0];
  assert.equal(session.pct, 87);
  assert.equal(session.resets, '5:40pm (Asia/Tokyo)');
  assert.ok(session.resetAt, 'resetAt should be resolved, not null');
});

test('parseUsage: mid-line prefix on the percent line still keeps the block', () => {
  const raw = [
    'Current session',
    'Esc to cancel87% 87% used',
    'Resets 5:40pm (Asia/Tokyo)',
  ].join('\n');

  const parsed = parseUsage(raw);
  assert.equal(parsed.limits.length, 1, 'the block must not vanish from limits');
  assert.equal(parsed.limits[0].pct, 87);
});
