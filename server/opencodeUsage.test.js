// Unit tests for the OpenCode Go usage reader. The pure mapping
// (mapGoUsage/extractGoKey) plus the toggle/key gating are covered here.
// getOpencodeUsage()'s success path stubs the global fetch -- no real
// request to opencode.ai ever leaves the process. Never touches the real
// ~/.local/share/opencode/auth.json: XDG_DATA_HOME and
// CCSERVER_SANDBOX_CONFIG are pinned to temp dirs (and OPENCODE_AUTH_CONTENT
// is cleared) for the whole file.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractGoKey,
  mapGoUsage,
  opencodeGoEnabled,
  opencodeGoAvailable,
  readOpencodeGoKey,
  getOpencodeUsage,
  warmOpencodeUsage,
} from './opencodeUsage.js';

let tmpRoot;
let cfgPath;
let dataHome;
let prevConfigEnv;
let prevDataHome;
let prevAuthContent;
let prevGoUsageEnv;
let origFetch;

const VALID_PAYLOAD = {
  usage: {
    rolling: { status: 'ok', percent: 4, resetsAt: '2026-08-13T16:27:38.287Z' },
    weekly: { status: 'ok', percent: 3, resetsAt: '2026-08-17T00:00:00.287Z' },
    monthly: { status: 'ok', percent: 1, resetsAt: '2026-09-13T06:06:01.287Z' },
  },
};

function writeConfig(obj) {
  writeFileSync(cfgPath, JSON.stringify(obj));
}

function writeAuthKey(key = 'test-key') {
  mkdirSync(join(dataHome, 'opencode'), { recursive: true });
  writeFileSync(join(dataHome, 'opencode', 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key } }));
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-opencode-usage-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  dataHome = join(tmpRoot, 'data-home');
  writeConfig({});
  prevConfigEnv = process.env.CCSERVER_SANDBOX_CONFIG;
  prevDataHome = process.env.XDG_DATA_HOME;
  prevAuthContent = process.env.OPENCODE_AUTH_CONTENT;
  prevGoUsageEnv = process.env.CCSERVER_OPENCODE_GO_USAGE;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  process.env.XDG_DATA_HOME = dataHome;
  delete process.env.OPENCODE_AUTH_CONTENT;
  delete process.env.CCSERVER_OPENCODE_GO_USAGE;
  origFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  if (prevConfigEnv === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
  else process.env.CCSERVER_SANDBOX_CONFIG = prevConfigEnv;
  if (prevDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevDataHome;
  if (prevAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT;
  else process.env.OPENCODE_AUTH_CONTENT = prevAuthContent;
  if (prevGoUsageEnv === undefined) delete process.env.CCSERVER_OPENCODE_GO_USAGE;
  else process.env.CCSERVER_OPENCODE_GO_USAGE = prevGoUsageEnv;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('extractGoKey: api entry yields its key', () => {
  assert.equal(extractGoKey({ 'opencode-go': { type: 'api', key: 'k123' } }), 'k123');
});

test('extractGoKey: missing entry, empty key, null input -> null', () => {
  assert.equal(extractGoKey({}), null);
  assert.equal(extractGoKey({ 'opencode-go': { type: 'api', key: '' } }), null);
  assert.equal(extractGoKey({ 'opencode-go': { type: 'api' } }), null);
  assert.equal(extractGoKey(null), null);
  assert.equal(extractGoKey('nope'), null);
});

// type: 'oauth' -- an OAuth access token, not a static API key (see the
// comment above extractGoKey for the auth.json union shape). expires may be
// epoch-ms or epoch-seconds; the >1e12 heuristic tells them apart.
test('extractGoKey: oauth entry with a future expires (ms) -> the access token', () => {
  const future = Date.now() + 3600_000;
  assert.equal(extractGoKey({ 'opencode-go': { type: 'oauth', access: 'tok123', refresh: 'r', expires: future } }), 'tok123');
});

test('extractGoKey: oauth entry with a future expires in seconds -> still valid via the unit heuristic', () => {
  const futureSeconds = Math.floor((Date.now() + 3600_000) / 1000);
  assert.ok(futureSeconds < 1e12, 'sanity: this is really a seconds-since-epoch value');
  assert.equal(extractGoKey({ 'opencode-go': { type: 'oauth', access: 'tok123', expires: futureSeconds } }), 'tok123');
});

test('extractGoKey: oauth entry with a past expires -> null (expired, no refresh attempted)', () => {
  const past = Date.now() - 3600_000;
  assert.equal(extractGoKey({ 'opencode-go': { type: 'oauth', access: 'tok123', expires: past } }), null);
});

test('extractGoKey: oauth entry missing access -> null', () => {
  assert.equal(extractGoKey({ 'opencode-go': { type: 'oauth', refresh: 'r', expires: Date.now() + 3600_000 } }), null);
});

test('extractGoKey: oauth entry with a non-numeric/missing expires -> skips the expiry check, returns access', () => {
  assert.equal(extractGoKey({ 'opencode-go': { type: 'oauth', access: 'tok123' } }), 'tok123');
  assert.equal(extractGoKey({ 'opencode-go': { type: 'oauth', access: 'tok123', expires: 'not-a-number' } }), 'tok123');
});

// type: 'wellknown' -- intentionally unsupported (see the comment above
// extractGoKey): which of key/token is the bearer credential is unconfirmed.
// This is a regression guard, not an endorsement of the current behavior.
test('extractGoKey: wellknown entry -> null (not implemented)', () => {
  assert.equal(extractGoKey({ 'opencode-go': { type: 'wellknown', key: 'k', token: 't' } }), null);
});

test('mapGoUsage: three windows map to the shared shape', () => {
  const result = mapGoUsage(VALID_PAYLOAD);
  assert.equal(result.plan, 'OpenCode Go');
  assert.equal(result.cost, null);
  assert.equal(result.limits.length, 3);

  const [rolling, weekly, monthly] = result.limits;
  assert.equal(rolling.label, '5時間');
  assert.equal(rolling.pct, 4);
  assert.equal(rolling.resetAt, Date.parse('2026-08-13T16:27:38.287Z'));
  assert.equal(rolling.windowMs, 5 * 3600 * 1000);
  assert.equal(typeof rolling.resets, 'string');

  assert.equal(weekly.label, '週次');
  assert.equal(weekly.pct, 3);
  assert.equal(weekly.windowMs, 7 * 24 * 3600 * 1000);

  // monthly anchors on the subscription anniversary: no fixed window,
  // so no pace marker client-side.
  assert.equal(monthly.label, '月次');
  assert.equal(monthly.pct, 1);
  assert.equal(monthly.windowMs, null);
});

test('mapGoUsage: null/invalid payload -> empty limits, null plan/cost', () => {
  assert.deepEqual(mapGoUsage(null), { limits: [], cost: null, plan: null });
  assert.deepEqual(mapGoUsage({}), { limits: [], cost: null, plan: null });
  assert.deepEqual(mapGoUsage({ usage: null }), { limits: [], cost: null, plan: null });
});

test('mapGoUsage: malformed windows are skipped', () => {
  const result = mapGoUsage({
    usage: {
      rolling: { status: 'ok', percent: -5, resetsAt: '2026-08-13T16:27:38.287Z' }, // negative
      weekly: { status: 'weird', percent: 3, resetsAt: '2026-08-17T00:00:00.287Z' }, // bad status
      monthly: { status: 'ok', percent: 1, resetsAt: 'not-a-date' }, // bad resetsAt
    },
  });
  assert.equal(result.limits.length, 0);
  assert.equal(result.plan, null);
});

// A rate-limited window can legitimately report over 100% used (e.g. a burst
// against a rolling quota) -- this must surface as-is, not be discarded as
// malformed (which used to drop the other two, otherwise-valid, windows too;
// see getOpencodeUsage's WINDOWS.length check on the full mapped result).
test('mapGoUsage: rate-limited window is still surfaced with its pct, over-100 included', () => {
  const result = mapGoUsage({
    usage: {
      rolling: { status: 'rate-limited', percent: 104, resetsAt: '2026-08-13T16:27:38.287Z' },
      weekly: { status: 'ok', percent: 3, resetsAt: '2026-08-17T00:00:00.287Z' },
      monthly: { status: 'ok', percent: 1, resetsAt: '2026-09-13T06:06:01.287Z' },
    },
  });
  assert.equal(result.limits.length, 3);
  assert.equal(result.limits[0].pct, 104);
});

test('opencodeGoEnabled: default on; file false disables; env wins both ways', () => {
  assert.equal(opencodeGoEnabled(), true);
  writeConfig({ opencodeGoUsage: false });
  assert.equal(opencodeGoEnabled(), false);
  process.env.CCSERVER_OPENCODE_GO_USAGE = '1';
  assert.equal(opencodeGoEnabled(), true);
  writeConfig({ opencodeGoUsage: true });
  process.env.CCSERVER_OPENCODE_GO_USAGE = '0';
  assert.equal(opencodeGoEnabled(), false);
  // Unrecognized env falls back to the file.
  process.env.CCSERVER_OPENCODE_GO_USAGE = 'maybe';
  assert.equal(opencodeGoEnabled(), true);
});

test('readOpencodeGoKey / opencodeGoAvailable: key file presence gates, toggle wins', () => {
  assert.equal(readOpencodeGoKey(), null);
  assert.equal(opencodeGoAvailable(), false);
  writeAuthKey('k123');
  assert.equal(readOpencodeGoKey(), 'k123');
  assert.equal(opencodeGoAvailable(), true);
  writeConfig({ opencodeGoUsage: false });
  assert.equal(opencodeGoAvailable(), false, 'disabled toggle hides even with a key');
});

// hiddenApps (issue #105): an operator who hasn't contracted for opencode
// must see it disappear from the picker (opencodeGoAvailable -> false) even
// with a valid key, and no code path may read the key file or hit the
// network on its behalf (capture()/getOpencodeUsage()/warmOpencodeUsage()).
test('opencodeGoAvailable: false when opencode is hidden, even with a valid key', () => {
  writeAuthKey('k123');
  assert.equal(opencodeGoAvailable(), true);
  writeConfig({ hiddenApps: ['opencode'] });
  assert.equal(opencodeGoAvailable(), false);
});

test('getOpencodeUsage: hidden app short-circuits without reading the key or fetching', async () => {
  writeConfig({ hiddenApps: ['opencode'] });
  writeAuthKey('k123');
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error('must not fetch'); };
  const res = await getOpencodeUsage({ force: true });
  assert.equal(res.usage, null);
  assert.match(res.error, /hidden on this server/);
  assert.equal(fetched, false);
});

test('warmOpencodeUsage: does nothing when opencode is hidden, even with a valid key', () => {
  writeConfig({ hiddenApps: ['opencode'] });
  writeAuthKey('k123');
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error('must not fetch'); };
  warmOpencodeUsage();
  assert.equal(fetched, false);
});

test('readOpencodeGoKey: OPENCODE_AUTH_CONTENT wins over auth.json', () => {
  writeAuthKey('file-key');
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ 'opencode-go': { type: 'api', key: 'env-key' } });
  assert.equal(readOpencodeGoKey(), 'env-key');
});

test('getOpencodeUsage: disabled config short-circuits without fetching', async () => {
  writeConfig({ opencodeGoUsage: false });
  writeAuthKey('k123');
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error('must not fetch'); };
  const res = await getOpencodeUsage({ force: true });
  assert.equal(res.usage, null);
  assert.match(res.error, /disabled by config/);
  assert.equal(fetched, false);
});

test('getOpencodeUsage: missing key errors without fetching', async () => {
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error('must not fetch'); };
  const res = await getOpencodeUsage({ force: true });
  assert.equal(res.usage, null);
  assert.match(res.error, /API key not found/);
  assert.equal(fetched, false);
});

test('getOpencodeUsage: 403 means no subscription', async () => {
  writeAuthKey('k123');
  globalThis.fetch = async () => ({ status: 403, ok: false });
  const res = await getOpencodeUsage({ force: true });
  assert.equal(res.usage, null);
  assert.match(res.error, /No OpenCode Go subscription/);
});

test('getOpencodeUsage: 401 means rejected key', async () => {
  writeAuthKey('k123');
  globalThis.fetch = async () => ({ status: 401, ok: false });
  const res = await getOpencodeUsage({ force: true });
  assert.equal(res.usage, null);
  assert.match(res.error, /Invalid opencode Go API key/);
});

test('getOpencodeUsage: incomplete windows are an error, not a partial cache', async () => {
  writeAuthKey('k123');
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({ usage: { rolling: VALID_PAYLOAD.usage.rolling } }),
  });
  const res = await getOpencodeUsage({ force: true });
  assert.equal(res.usage, null);
  assert.match(res.error, /Could not parse/);
});

// NOTE: this success case runs last: it populates the module cache, and the
// failure cases above assert `usage: null`, which a stale-cache fallback
// would otherwise turn into a cache hit.
test('getOpencodeUsage: 200 maps through and sends the Bearer key', async () => {
  writeAuthKey('k123');
  let seenAuth = null;
  let seenUrl = null;
  globalThis.fetch = async (url, opts) => {
    seenUrl = String(url);
    seenAuth = opts?.headers?.authorization;
    return { status: 200, ok: true, json: async () => VALID_PAYLOAD };
  };
  const res = await getOpencodeUsage({ force: true });
  assert.equal(seenUrl, 'https://opencode.ai/zen/go/v1/usage');
  assert.equal(seenAuth, 'Bearer k123');
  assert.equal(res.usage.plan, 'OpenCode Go');
  assert.equal(res.usage.limits.length, 3);
  assert.equal(typeof res.updatedAt, 'number');
});

// These two run after the success case above (each primes its own cache
// explicitly before exercising the behavior under test), and must stay last:
// they deliberately leave a stale cache behind, which any later `usage: null`
// assertion elsewhere in this file would misread as a cache hit.

test('getOpencodeUsage: toggle OFF wins over a fresh cache, no force needed', async () => {
  writeAuthKey('k123');
  globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => VALID_PAYLOAD });
  const primed = await getOpencodeUsage({ force: true });
  assert.ok(primed.usage, 'sanity: cache is populated before disabling');

  writeConfig({ opencodeGoUsage: false });
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error('must not fetch'); };
  const res = await getOpencodeUsage(); // no force: the fresh cache alone must not win
  assert.equal(res.usage, null);
  assert.match(res.error, /disabled by config/);
  assert.equal(fetched, false);
});

test('getOpencodeUsage: 403 with an existing cache still returns usage:null (no stale fallback)', async () => {
  writeAuthKey('k123');
  globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => VALID_PAYLOAD });
  const primed = await getOpencodeUsage({ force: true });
  assert.ok(primed.usage, 'sanity: cache is populated before the 403');

  globalThis.fetch = async () => ({ status: 403, ok: false });
  const res = await getOpencodeUsage({ force: true });
  assert.equal(res.usage, null, 'a 403 is final: it must not fall back to the stale cached usage');
  assert.match(res.error, /No OpenCode Go subscription/);
});

// #252: ~/.local/share/opencode is bound READ-WRITE into every sandboxed
// session (sandbox.js's appBinds, from AGENT_CONFIG_REL_PATHS), and as a
// DIRECTORY bind -- so a session can unlink auth.json and leave a FIFO there.
// A plain readFileSync does not throw on a FIFO, it blocks in open(2) with no
// writer, and being synchronous it takes the whole event loop (and the SIGTERM
// handler) down with it. GET /api/dirs/home reaches this on any viewer's first
// page load, so it is not a privileged path.
//
// If this test ever regresses it does NOT fail -- it HANGS, which is the
// symptom itself. Run this file with an external timeout.
test('#252: a FIFO at auth.json is refused, not waited on', () => {
  const authPath = join(dataHome, 'opencode', 'auth.json');
  mkdirSync(join(dataHome, 'opencode'), { recursive: true });
  try { unlinkSync(authPath); } catch { /* not there */ }
  execFileSync('mkfifo', [authPath]);

  const started = Date.now();
  // No key, same as a corrupt or absent file -- the hostile shape lands in the
  // catch that a parse error already used.
  assert.equal(readOpencodeGoKey(), null);
  assert.equal(opencodeGoAvailable(), false);
  // Generous, but far below any "it blocked" reading: an O_NONBLOCK open of a
  // writerless FIFO returns immediately.
  assert.ok(Date.now() - started < 2000, `reading a FIFO must return at once, took ${Date.now() - started}ms`);
});

// The same guard must not reject the ordinary case.
test('#252: a regular auth.json still reads normally', () => {
  const authPath = join(dataHome, 'opencode', 'auth.json');
  try { unlinkSync(authPath); } catch { /* not there */ }
  mkdirSync(join(dataHome, 'opencode'), { recursive: true });
  writeFileSync(authPath, JSON.stringify({ 'opencode-go': { type: 'api', key: 'sk-plain' } }));
  assert.equal(readOpencodeGoKey(), 'sk-plain');
});
