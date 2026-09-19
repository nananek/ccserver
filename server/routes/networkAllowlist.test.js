// REST boundary for the network-isolation settings GUI: GET exposes the
// effective settings, PUT validates + writes the file and auto-applies the
// lists to live isolation-enabled sessions (none exist in this suite, so liveApplied is
// 0/0 -- the live push path itself is covered by
// sessionManager.pushAllowlistToArmedSessions.test.js).
// Runs against a throwaway CCSERVER_SANDBOX_CONFIG so the host's real config
// is never touched.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { networkAllowlistRoute } from './networkAllowlist.js';

let tmpRoot;
let cfgPath;
let prevConfig;
let app;

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-network-allowlist-route-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  prevConfig = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  app = Fastify();
  await app.register(networkAllowlistRoute, { prefix: '/api' });
});

after(async () => {
  if (prevConfig === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
  else process.env.CCSERVER_SANDBOX_CONFIG = prevConfig;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('GET returns defaults on a missing file', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/network-settings' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().settings, { isolate: false, initialState: 'enforce', mode: 'enforce', allowedHosts: [], deniedHosts: [] });
});

test('PUT writes the file, normalizes, and reports live counts', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/api/network-settings',
    payload: { isolate: true, initialState: 'open', mode: 'audit', allowedHosts: [' API.Example.COM ', '.example.net'], deniedHosts: [' Evil.Example ', '.tracker.example'] },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.settings, { isolate: true, initialState: 'open', mode: 'audit', allowedHosts: ['api.example.com', '.example.net'], deniedHosts: ['evil.example', '.tracker.example'] });
  assert.deepEqual(body.liveApplied, { ok: 0, failed: 0 }, 'no live sessions in this suite');
  const onDisk = JSON.parse(readFileSync(cfgPath, 'utf-8'));
  assert.deepEqual(onDisk.network.allowedHosts, ['api.example.com', '.example.net']);
  assert.deepEqual(onDisk.network.deniedHosts, ['evil.example', '.tracker.example']);

  const reread = await app.inject({ method: 'GET', url: '/api/network-settings' });
  assert.deepEqual(reread.json().settings, body.settings);
});

test('PUT validation errors map to 400 and change nothing', async () => {
  for (const payload of [
    { mode: 'sometimes' },
    { isolate: 'yes' },
    { initialState: 'sometimes' },
    { allowedHosts: ['https://evil.example'] },
    { allowedHosts: 'api.example.com' },
    { deniedHosts: ['https://evil.example'] },
    { deniedHosts: 'evil.example' },
  ]) {
    const res = await app.inject({ method: 'PUT', url: '/api/network-settings', payload });
    assert.equal(res.statusCode, 400, `must reject ${JSON.stringify(payload)}`);
    assert.ok(res.json().error);
  }
});
