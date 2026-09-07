// Session destroy timeouts are operator-tunable. Sessions used to be killed
// after a hard-coded 2h with no client attached, and reaped 30s after their
// pty exited, with no way to change either -- so a session that died while
// the tab was closed was gone (and unexplained) by the time anyone looked.
//
// This file runs with the idle timeout DISABLED and a 1s exited timeout, set
// before sessionManager is imported (it resolves both at module load). Test
// files get their own process under `node --test`, so that env does not leak.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sessionManager;
let runtimeDir;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fakeSocket() {
  return { readyState: 1, sent: [], send(m) { this.sent.push(m); }, close() {} };
}

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-timeout-test-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  process.env.CCSERVER_SESSION_TIMEOUT_MS = '0';
  process.env.CCSERVER_SESSION_EXITED_TIMEOUT_MS = '1000';
  sessionManager = await import('./sessionManager.js');
});

after(() => {
  sessionManager.destroyAllSessions();
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('resolveSessionTimeoutMs: env overrides, 0 disables, garbage falls back', () => {
  const { resolveSessionTimeoutMs } = sessionManager;
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
  // setTimeout silently turns an over-32-bit delay into 1ms, so "keep sessions
  // for a very long time" would otherwise mean "destroy them immediately".
  assert.equal(resolveSessionTimeoutMs({ CCSERVER_SESSION_TIMEOUT_MS: '2147483648' }), 2147483647,
    'one past the setTimeout ceiling is clamped');
  assert.equal(resolveSessionTimeoutMs({ CCSERVER_SESSION_TIMEOUT_MS: '999999999999' }), 2147483647,
    'a huge value is clamped, never wrapped');
});

test('a clamped timeout is actually safe to hand to setTimeout', async () => {
  const seen = [];
  // Only the overflow warning matters here; the runner emits unrelated ones
  // of its own (ExperimentalWarning for node:sqlite, for instance).
  const onWarning = (w) => { if (w.name === 'TimeoutOverflowWarning') seen.push(w.name); };
  process.on('warning', onWarning);
  try {
    const ms = sessionManager.resolveSessionTimeoutMs({ CCSERVER_SESSION_TIMEOUT_MS: '999999999999' });
    // The value alone proves nothing -- what matters is that Node accepts it
    // as a real delay. An unclamped one emits TimeoutOverflowWarning and fires
    // within milliseconds instead.
    const timer = setTimeout(() => seen.push('FIRED'), ms);
    await sleep(120);
    clearTimeout(timer);
    assert.deepEqual(seen, [], `expected no overflow warning and no early fire, got ${seen.join(',')}`);
  } finally {
    process.off('warning', onWarning);
  }
});

test('resolveExitedTimeoutMs: defaults to 5min and can never be disabled', () => {
  const { resolveExitedTimeoutMs } = sessionManager;
  const FIVE_MIN = 5 * 60 * 1000;

  assert.equal(resolveExitedTimeoutMs({}), FIVE_MIN);
  assert.equal(resolveExitedTimeoutMs({ CCSERVER_SESSION_EXITED_TIMEOUT_MS: '30000' }), 30000);
  assert.equal(resolveExitedTimeoutMs({ CCSERVER_SESSION_EXITED_TIMEOUT_MS: 'nope' }), FIVE_MIN);
  // An exited session has no process left; keeping it forever would fill the
  // session list with rows nothing can ever attach to.
  assert.equal(resolveExitedTimeoutMs({ CCSERVER_SESSION_EXITED_TIMEOUT_MS: '0' }), 1000, 'clamped, not disabled');
  assert.equal(resolveExitedTimeoutMs({ CCSERVER_SESSION_EXITED_TIMEOUT_MS: '-1' }), 1000, 'clamped, not disabled');
  assert.equal(resolveExitedTimeoutMs({ CCSERVER_SESSION_EXITED_TIMEOUT_MS: '999999999999' }), 2147483647,
    'and clamped at the setTimeout ceiling on the other end');
});

test('with the idle timeout disabled, a session with no viewers is left alone', async () => {
  const res = await sessionManager.createSession({
    cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false,
  });
  assert.ok(res.session, 'shell session should spawn');
  const { sessionId, session } = res;
  const socket = fakeSocket();
  try {
    sessionManager.attachSocket(sessionId, socket);
    sessionManager.detachSocket(sessionId, socket);

    assert.equal(session.sockets.size, 0, 'nobody is watching');
    assert.equal(session.timeoutTimer, null, 'no destroy timer is armed at all');

    await sleep(1500); // well past the 1s exited timeout, which must not apply
    assert.ok(sessionManager.getSession(sessionId), 'the live session survives with no viewers');
    assert.equal(session.exited, false, 'and its pty was never killed');
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

test('an exited session is still reaped, even with the idle timeout disabled', async () => {
  const res = await sessionManager.createSession({
    cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false,
  });
  assert.ok(res.session, 'shell session should spawn');
  const { sessionId, session } = res;
  const socket = fakeSocket();
  sessionManager.attachSocket(sessionId, socket);
  await sleep(300);

  sessionManager.writeToSession(sessionId, 'exit', { submit: true });
  for (let i = 0; i < 40 && !session.exited; i++) await sleep(100);
  assert.equal(session.exited, true, 'the shell exited');

  sessionManager.detachSocket(sessionId, socket);
  assert.notEqual(session.timeoutTimer, null, 'the exited-session cleanup timer IS armed');

  await sleep(1600); // > CCSERVER_SESSION_EXITED_TIMEOUT_MS (1000)
  assert.equal(sessionManager.getSession(sessionId), undefined, 'the exited session was reaped');
});
