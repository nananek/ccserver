// Route-level tests for GET /api/system-stats:
// - 常に200を返し、1項目の失敗で全体を500にしない (macOS の /proc 不在対策)
// - 正常系では cpu/memory の数値を含むこと

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { systemRoute, cpuStatsFromOs, memoryFromOs } from './system.js';

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

test('cpuStatsFromOs matches the /proc shape used for usage deltas', () => {
  const stats = cpuStatsFromOs();
  assert.ok(stats.total, 'total present');
  for (const key of ['idle', 'busy', 'total']) {
    assert.equal(typeof stats.total[key], 'number');
  }
  assert.equal(stats.total.total, stats.total.idle + stats.total.busy);
  assert.ok(Array.isArray(stats.cores));
  for (const core of stats.cores) {
    assert.equal(core.total, core.idle + core.busy);
  }
});

test('memoryFromOs keeps the response contract (numbers, swap zeros)', () => {
  const mem = memoryFromOs();
  for (const key of ['total', 'used', 'free', 'available']) {
    assert.equal(typeof mem[key], 'number', key);
  }
  assert.ok(mem.total >= mem.used, 'used does not exceed total');
  // No swap/buffer detail available via node:os; frontend renders these as hidden/placeholder.
  assert.equal(mem.swapTotal, 0);
  assert.equal(mem.swapUsed, 0);
});
