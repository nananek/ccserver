// Ported from server/ws/sessionTimeout.test.js's resolveSessionTimeoutMs
// coverage: the parsing rules are the same public contract (same env var
// names), now owned by pty-host (plan5 section 2.2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionTimeoutMs, resolveExitedTimeoutMs } from './timeouts.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('resolveSessionTimeoutMs: env overrides, 0 disables, garbage falls back', () => {
  const TWO_HOURS = 2 * 60 * 60 * 1000;

  assert.equal(resolveSessionTimeoutMs({}), TWO_HOURS, 'unset keeps the historical 2h');
  assert.equal(resolveSessionTimeoutMs({ CCSERVER_SESSION_TIMEOUT_MS: '' }), TWO_HOURS, 'empty is unset');
  assert.equal(resolveSessionTimeoutMs({ CCSERVER_SESSION_TIMEOUT_MS: '   ' }), TWO_HOURS, 'blank is unset');
  assert.equal(resolveSessionTimeoutMs({ CCSERVER_SESSION_TIMEOUT_MS: '86400000' }), 86400000);
  assert.equal(resolveSessionTimeoutMs({ CCSERVER_SESSION_TIMEOUT_MS: '0' }), 0, '0 disables');
  assert.equal(resolveSessionTimeoutMs({ CCSERVER_SESSION_TIMEOUT_MS: '-5' }), 0, 'negative also disables');
  assert.equal(resolveSessionTimeoutMs({ CCSERVER_SESSION_TIMEOUT_MS: 'forever' }), TWO_HOURS,
    'a non-number must not silently become 0 (that would disable teardown by typo)');
  assert.equal(resolveSessionTimeoutMs({ CCSERVER_SESSION_TIMEOUT_MS: '1500.7' }), 1500, 'truncated to ms');
  assert.equal(resolveSessionTimeoutMs({ CCSERVER_SESSION_TIMEOUT_MS: '2147483648' }), 2147483647,
    'one past the setTimeout ceiling is clamped');
  assert.equal(resolveSessionTimeoutMs({ CCSERVER_SESSION_TIMEOUT_MS: '999999999999' }), 2147483647,
    'a huge value is clamped, never wrapped');
});

test('resolveExitedTimeoutMs: env overrides, floors at 1s (never fully disabled)', () => {
  const FIVE_MIN = 5 * 60 * 1000;

  assert.equal(resolveExitedTimeoutMs({}), FIVE_MIN, 'unset keeps the historical 5m');
  assert.equal(resolveExitedTimeoutMs({ CCSERVER_SESSION_EXITED_TIMEOUT_MS: '10000' }), 10000);
  assert.equal(resolveExitedTimeoutMs({ CCSERVER_SESSION_EXITED_TIMEOUT_MS: '0' }), 1000,
    'an exited session must always eventually be reaped -- 0 floors at the 1s minimum, unlike the running-session timeout');
  assert.equal(resolveExitedTimeoutMs({ CCSERVER_SESSION_EXITED_TIMEOUT_MS: '-5' }), 1000, 'negative also floors');
  assert.equal(resolveExitedTimeoutMs({ CCSERVER_SESSION_EXITED_TIMEOUT_MS: 'nope' }), FIVE_MIN,
    'a non-number falls back rather than becoming a very short timeout by typo');
  assert.equal(resolveExitedTimeoutMs({ CCSERVER_SESSION_EXITED_TIMEOUT_MS: '999999999999' }), 2147483647,
    'clamped to the setTimeout ceiling, never wrapped');
});

test('a clamped timeout is actually safe to hand to setTimeout', async () => {
  const seen = [];
  const onWarning = (w) => { if (w.name === 'TimeoutOverflowWarning') seen.push(w.name); };
  process.on('warning', onWarning);
  try {
    const ms = resolveSessionTimeoutMs({ CCSERVER_SESSION_TIMEOUT_MS: '999999999999' });
    const timer = setTimeout(() => seen.push('FIRED'), ms);
    await sleep(120);
    clearTimeout(timer);
    assert.deepEqual(seen, [], `expected no overflow warning and no early fire, got ${seen.join(',')}`);
  } finally {
    process.off('warning', onWarning);
  }
});
