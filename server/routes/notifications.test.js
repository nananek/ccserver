// REST boundary for the agent notification bridge settings GUI: GET exposes
// the effective settings plus the vocabulary the client renders from, PUT
// validates + writes the file. Same throwaway-CCSERVER_SANDBOX_CONFIG harness
// as networkAllowlist.test.js so the host's real config is never touched.
//
// The settings semantics themselves live in notifyBridgeSettings.test.js;
// this suite covers the HTTP contract (status codes, response shape) and the
// one thing only the route knows: which delivery channels are actually
// reachable on this host.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notificationsRoute } from './notifications.js';
import { closeDb } from '../db.js';
import { _setDeliverFetchForTests, _getDeliverFetch } from '../ws/notify.js';
import { BRIDGE_APPS, BRIDGE_CHANNELS, BRIDGE_DEFAULTS } from '../ws/notifyBridgeSettings.js';

let tmpRoot;
let cfgPath;
let prevConfig;
let prevWebhook;
let prevDb;
let app;

const writeConfig = (obj) => writeFileSync(cfgPath, JSON.stringify(obj, null, 2));
const readConfig = () => JSON.parse(readFileSync(cfgPath, 'utf-8'));

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-notifications-route-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  prevConfig = process.env.CCSERVER_SANDBOX_CONFIG;
  prevWebhook = process.env.CCSERVER_DISCORD_WEBHOOK;
  prevDb = process.env.CCSERVER_DB_PATH;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  // This route reads the push store (VAPID key, subscription count), and
  // getDb() otherwise opens the REAL host database and would mint a VAPID
  // identity in it. Point it at a scratch file before the first call.
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  delete process.env.CCSERVER_DISCORD_WEBHOOK;
  app = Fastify();
  await app.register(notificationsRoute, { prefix: '/api' });
});

after(async () => {
  if (prevConfig === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
  else process.env.CCSERVER_SANDBOX_CONFIG = prevConfig;
  if (prevWebhook === undefined) delete process.env.CCSERVER_DISCORD_WEBHOOK;
  else process.env.CCSERVER_DISCORD_WEBHOOK = prevWebhook;
  if (prevDb === undefined) delete process.env.CCSERVER_DB_PATH;
  else process.env.CCSERVER_DB_PATH = prevDb;
  try { closeDb(); } catch { /* not opened */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  await app.close();
});

const get = () => app.inject({ method: 'GET', url: '/api/notify-settings' });
const put = (payload) => app.inject({ method: 'PUT', url: '/api/notify-settings', payload });

test('GET returns the defaults on a missing config file', async () => {
  const res = await get();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().settings, {
    ...BRIDGE_DEFAULTS,
    apps: [...BRIDGE_DEFAULTS.apps],
    channels: [...BRIDGE_DEFAULTS.channels],
  });
});

test('GET ships the vocabulary the GUI renders from', async () => {
  const { choices } = (await get()).json();
  assert.deepEqual(choices.apps, [...BRIDGE_APPS]);
  assert.deepEqual(choices.channels, [...BRIDGE_CHANNELS]);
  assert.deepEqual(choices.levels, ['info', 'success', 'warning', 'error']);
  // The GUI constrains its number inputs from these rather than hardcoding
  // bounds that could drift away from the server's validation.
  assert.equal(choices.limits.maxPerHour.min, 1);
  assert.ok(choices.limits.minIntervalMs.max > 0);
  assert.equal(choices.defaults.enabled, false);
});

test('channelsAvailable reports discord only once a webhook or subscription exists', async () => {
  writeConfig({});
  assert.deepEqual((await get()).json().channelsAvailable, { discord: false, webpush: false });

  writeConfig({ notify: { discordWebhook: 'https://discord.example/hook' } });
  assert.equal((await get()).json().channelsAvailable.discord, true);
});

test('PUT applies a partial patch and echoes the effective settings', async () => {
  writeConfig({ docker: true });
  const res = await put({ enabled: true, apps: ['claude'], maxPerHour: 30 });
  assert.equal(res.statusCode, 200);
  const { settings, channelsAvailable } = res.json();
  assert.equal(settings.enabled, true);
  assert.deepEqual(settings.apps, ['claude']);
  assert.equal(settings.maxPerHour, 30);
  assert.equal(settings.minIntervalMs, BRIDGE_DEFAULTS.minIntervalMs, 'untouched keys keep their defaults');
  assert.ok(channelsAvailable, 'the client refreshes availability from the same response');
  assert.equal(readConfig().docker, true, 'other config keys survive');
  assert.deepEqual((await get()).json().settings, settings, 'GET agrees with what PUT reported');
});

test('PUT rejects a bad value with 400 and a reason', async () => {
  writeConfig({});
  const res = await put({ apps: ['bogus'] });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /unknown app id\(s\): bogus/);
});

test('PUT rejects an unknown channel with 400', async () => {
  const res = await put({ channels: ['vikunja'] });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /unknown channel\(s\): vikunja/);
});

test('PUT rejects an out-of-range number with 400', async () => {
  const res = await put({ maxPerHour: 0 });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /maxPerHour must be between/);
});

test('PUT on a corrupt config answers 500 and leaves the file alone', async () => {
  const garbage = '{ nope';
  writeFileSync(cfgPath, garbage);
  const res = await put({ enabled: true });
  assert.equal(res.statusCode, 500);
  assert.match(res.json().error, /not valid JSON/);
  assert.equal(readFileSync(cfgPath, 'utf-8'), garbage);
});

test('PUT with a non-object body is a 400, not a crash', async () => {
  writeConfig({});
  const res = await app.inject({
    method: 'PUT',
    url: '/api/notify-settings',
    payload: JSON.stringify(['a']),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.statusCode, 400);
});

test('GET exposes the observability counters (review finding F4)', async () => {
  const { stats } = (await get()).json();
  // The bridge's own tally...
  for (const k of ['delivered', 'throttled', 'deduped', 'capped', 'unreachable', 'failed']) {
    assert.equal(typeof stats[k], 'number', `bridge stat ${k}`);
  }
  // ...and the detectors', aggregated across armed sessions.
  for (const k of ['armed', 'evictedKitty', 'truncatedKitty', 'overflowed', 'aborted']) {
    assert.equal(typeof stats[k], 'number', `detector stat ${k}`);
  }
});

test('PUT names an unknown setting instead of silently ignoring it (F5)', async () => {
  writeConfig({});
  const res = await put({ enabeld: true });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /unknown setting\(s\): enabeld/);
  assert.equal((await get()).json().settings.enabled, false, 'and nothing was written');
});

// --- Web Push subscriptions --------------------------------------------------

const VALID_SUB = {
  endpoint: 'https://push.example.net/p/abc123',
  keys: {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  },
};

test('GET exposes the VAPID public key a browser needs to subscribe', async () => {
  const { vapidPublicKey } = (await get()).json();
  assert.equal(typeof vapidPublicKey, 'string');
  const raw = Buffer.from(vapidPublicKey, 'base64url');
  assert.equal(raw.length, 65, 'an uncompressed P-256 point');
  assert.equal(raw[0], 0x04);
  // Stable across calls: the identity is minted once, not per request.
  assert.equal((await get()).json().vapidPublicKey, vapidPublicKey);
});

test('a browser can subscribe, and webpush then reports as available', async () => {
  assert.equal((await get()).json().channelsAvailable.webpush, false);
  const res = await app.inject({ method: 'POST', url: '/api/push/subscriptions', payload: VALID_SUB });
  assert.equal(res.statusCode, 200);
  const { subscription } = res.json();
  assert.ok(subscription.id);
  assert.equal(subscription.endpointOrigin, 'https://push.example.net');
  assert.equal((await get()).json().channelsAvailable.webpush, true);
});

test('the endpoint is never sent back to the client (it is a bearer secret)', async () => {
  const body = JSON.stringify((await get()).json());
  assert.ok(!body.includes('/p/abc123'), 'the endpoint path must not leave the server');
});

test('re-subscribing the same browser updates in place rather than duplicating', async () => {
  const before = (await get()).json().pushSubscriptions.length;
  await app.inject({ method: 'POST', url: '/api/push/subscriptions', payload: { ...VALID_SUB, label: 'my phone' } });
  const after = (await get()).json().pushSubscriptions;
  assert.equal(after.length, before, 'the endpoint is the identity');
  assert.equal(after.at(-1).label, 'my phone');
});

test('a malformed subscription is refused with a reason', async () => {
  const cases = [
    [{ ...VALID_SUB, endpoint: 'http://push.example.net/p/x' }, /must be an https/],
    [{ ...VALID_SUB, endpoint: 'https://127.0.0.1/p/x' }, /hostname, not an IP literal/],
    // Attacker review F1: every one of these was ACCEPTED before. The WHATWG
    // URL parser normalizes them all to the hex form, which the old classifier
    // read as a public address -- ::ffff:169.254.169.254 is the cloud metadata
    // service in an IPv6 costume.
    [{ ...VALID_SUB, endpoint: 'https://[::ffff:127.0.0.1]/p/x' }, /hostname, not an IP literal/],
    [{ ...VALID_SUB, endpoint: 'https://[::ffff:7f00:1]/p/x' }, /hostname, not an IP literal/],
    [{ ...VALID_SUB, endpoint: 'https://[0:0:0:0:0:ffff:7f00:1]/p/x' }, /hostname, not an IP literal/],
    [{ ...VALID_SUB, endpoint: 'https://[::ffff:169.254.169.254]/p/x' }, /hostname, not an IP literal/],
    [{ ...VALID_SUB, endpoint: 'https://[::1]/p/x' }, /hostname, not an IP literal/],
    // ...and a public IP literal is refused too: a push service is always a
    // hostname, so the literal form has no legitimate use here at all.
    [{ ...VALID_SUB, endpoint: 'https://[2001:4860:4860::8888]/p/x' }, /hostname, not an IP literal/],
    [{ ...VALID_SUB, endpoint: 'https://8.8.8.8/p/x' }, /hostname, not an IP literal/],
    // Attacker review F4: a 65-byte blob is not necessarily on the curve.
    [{ ...VALID_SUB, keys: { ...VALID_SUB.keys, p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url') } }, /not a point on the P-256 curve/],
    [{ ...VALID_SUB, keys: { ...VALID_SUB.keys, auth: 'AAAA' } }, /auth must decode to 16 bytes/],
    [{ ...VALID_SUB, keys: { ...VALID_SUB.keys, p256dh: 'AAAA' } }, /p256dh must decode to 65 bytes/],
    [{ endpoint: VALID_SUB.endpoint }, /p256dh is required/],
  ];
  for (const [payload, re] of cases) {
    const res = await app.inject({ method: 'POST', url: '/api/push/subscriptions', payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload).slice(0, 60));
    assert.match(res.json().error, re);
  }
});

test('a subscription can be removed, and an unknown id is a 404', async () => {
  const { pushSubscriptions } = (await get()).json();
  const id = pushSubscriptions[0].id;
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/push/subscriptions/${id}` })).statusCode, 200);
  assert.equal((await get()).json().pushSubscriptions.length, pushSubscriptions.length - 1);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/push/subscriptions/${id}` })).statusCode, 404);
});

test('the test-send endpoint reports what each channel did', async () => {
  writeConfig({ notify: { discordWebhook: 'https://discord.example/hook' } });
  const realFetch = _getDeliverFetch();
  let posted = 0;
  _setDeliverFetchForTests(async () => { posted += 1; return { ok: true }; });
  try {
    const res = await app.inject({
      method: 'POST', url: '/api/notify-settings/test', payload: { channels: ['discord'] },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().delivered.discord, true);
    assert.equal(posted, 1);
  } finally {
    _setDeliverFetchForTests(realFetch);
  }
});

test('the test-send endpoint rejects an unknown channel', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/notify-settings/test', payload: { channels: ['carrier-pigeon'] },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /unknown channel\(s\): carrier-pigeon/);
});
