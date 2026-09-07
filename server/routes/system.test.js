// Route-level tests for GET /api/system-stats:
// - 常に200を返し、1項目の失敗で全体を500にしない (macOS の /proc 不在対策)
// - 正常系では cpu/memory の数値を含むこと

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { systemRoute } from './system.js';

let app;
before(async () => {
  app = Fastify();
  await app.register(systemRoute, { prefix: '/api' });
});
after(async () => {
  try { await app.close(); } catch {}
});

test('GET /system-stats returns 200 with cpu and memory on this host', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/system-stats' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.cpu, 'cpu present');
  assert.equal(typeof body.cpu.usage.total, 'number');
  assert.ok(Array.isArray(body.cpu.usage.cores));
  assert.ok(body.memory, 'memory present');
  assert.equal(typeof body.memory.total, 'number');
  assert.equal(typeof body.memory.used, 'number');
  assert.ok(Array.isArray(body.storage));
});

test('GET /system-stats?ipmi=1 returns 200 without ENABLE_IPMI', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/system-stats?ipmi=1' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ipmi, null);
});
