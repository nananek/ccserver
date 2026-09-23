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
import { BRIDGE_APPS, BRIDGE_CHANNELS, BRIDGE_DEFAULTS } from '../ws/notifyBridgeSettings.js';

let tmpRoot;
let cfgPath;
let prevConfig;
let prevWebhook;
let app;

const writeConfig = (obj) => writeFileSync(cfgPath, JSON.stringify(obj, null, 2));
const readConfig = () => JSON.parse(readFileSync(cfgPath, 'utf-8'));

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-notifications-route-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  prevConfig = process.env.CCSERVER_SANDBOX_CONFIG;
  prevWebhook = process.env.CCSERVER_DISCORD_WEBHOOK;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  delete process.env.CCSERVER_DISCORD_WEBHOOK;
  app = Fastify();
  await app.register(notificationsRoute, { prefix: '/api' });
});

after(async () => {
  if (prevConfig === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
  else process.env.CCSERVER_SANDBOX_CONFIG = prevConfig;
  if (prevWebhook === undefined) delete process.env.CCSERVER_DISCORD_WEBHOOK;
  else process.env.CCSERVER_DISCORD_WEBHOOK = prevWebhook;
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
