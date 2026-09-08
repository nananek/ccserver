// Route-level tests for GET /api/system-stats:
// - 常に200を返し、1項目の失敗で全体を500にしない (macOS の /proc 不在対策)
// - 正常系では cpu/memory の数値を含むこと

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { systemRoute, cpuStatsFromOs, memoryFromOs, parseVmStat, parseSwapUsage, parseDfOutput } from './system.js';

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

const VM_STAT_APPLE_SILICON = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               30589.
Pages active:                            422224.
Pages inactive:                          419065.
Pages speculative:                         5280.
Pages throttled:                              0.
Pages wired down:                         92865.
Pages purgeable:                           2074.
Pages occupied by compressor:             45402.
Pages stored in compressor:              124270.
`;

test('parseVmStat follows Activity Monitor accounting (wired+active+occupied)', () => {
  const mem = parseVmStat(VM_STAT_APPLE_SILICON, 16 * 1024 ** 3);
  assert.equal(mem.total, 16384);
  const toMb = (pages) => Math.round((pages * 16384) / 1024 / 1024);
  assert.equal(mem.used, toMb(92865 + 422224 + 45402));
  assert.equal(mem.free, toMb(30589));
  assert.equal(mem.available, toMb(30589 + 419065 + 5280 + 2074));
  assert.equal(mem.bufferCache, null);
  assert.ok(mem.used + mem.available <= mem.total + 1, 'parts stay within total');
});

test('parseVmStat falls back to 4096-byte pages and tolerates missing keys', () => {
  const mem = parseVmStat('Pages free: 100.\nPages active: 200.\nPages wired down: 50.\n', 1024 ** 3);
  const toMb = (pages) => Math.round((pages * 4096) / 1024 / 1024);
  assert.equal(mem.used, toMb(50 + 200));
  assert.equal(mem.available, toMb(100));
});

test('parseSwapUsage handles M/K/G suffixes and garbage', () => {
  assert.deepEqual(
    parseSwapUsage('vm.swapusage: total = 1024.00M  used = 345.50M  free = 678.50M  (encrypted)'),
    { swapTotal: 1024, swapUsed: 346 },
  );
  assert.deepEqual(
    parseSwapUsage('vm.swapusage: total = 1.00G  used = 512.00K  free = 1.00G'),
    { swapTotal: 1024, swapUsed: 1 },
  );
  assert.deepEqual(parseSwapUsage('total = 0.00M  used = 0.00M'), { swapTotal: 0, swapUsed: 0 });
  assert.deepEqual(parseSwapUsage('nonsense'), { swapTotal: 0, swapUsed: 0 });
});

const DF_MACOS = `Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s3s1  478724992  22190104 117794720    16%    /
devfs                 410       410         0   100%    /dev
/dev/disk3s6    478724992        40 117794720     1%    /System/Volumes/VM
/dev/disk3s1    478724992 309672600 117794720    73%    /System/Volumes/Data
map auto_home           0         0         0   100%    /System/Volumes/Data/home
/dev/disk7s2    488395080 154286376 333839768    32%    /Volumes/External SSD
tmpfs              100000     10000     90000    10%    /run
`;

test('parseDfOutput drops /System mounts but keeps / and spaced mounts', () => {
  const rows = parseDfOutput(DF_MACOS, 'darwin');
  const mounts = rows.map((r) => r.mount);
  assert.ok(!mounts.some((m) => m === '/System' || m.startsWith('/System/')), `no /System rows: ${mounts}`);
  assert.ok(mounts.includes('/'), 'root kept');
  assert.ok(mounts.includes('/Volumes/External SSD'), 'spaced mount kept whole');
  assert.ok(!mounts.includes('/dev'), 'non-/dev device dropped');
  assert.ok(!mounts.includes('/run'), 'EXCLUDE_FS dropped');
  for (const r of rows) {
    assert.ok(r.total > 0 && r.used >= 0 && typeof r.usedPct === 'number');
  }
});

test('parseDfOutput reports container usage on / (macOS firmlink view)', () => {
  const rows = parseDfOutput(DF_MACOS, 'darwin');
  const root = rows.find((r) => r.mount === '/');
  // APFS shares Total/Available across the container; Data's own Used
  // (309672600K) omits System/Preboot, so derive container used as
  // total - available to match Finder/system_profiler. Device follows Data.
  const toMb = (k) => Math.round((k * 1024) / 1024 / 1024);
  assert.equal(root.device, 'disk3s1');
  assert.equal(root.total, toMb(478724992));
  assert.equal(root.available, toMb(117794720));
  assert.equal(root.used, toMb(478724992 - 117794720));
  assert.equal(root.used + root.available, root.total);
});

test('parseDfOutput keeps / as-is without a Data row (Linux)', () => {
  const rows = parseDfOutput(`Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/sda1         10000000   2000000   8000000    20%    /
`, 'linux');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mount, '/');
  assert.equal(rows[0].device, 'sda1');
});

test('parseDfOutput on linux keeps /System rows and root as-is', () => {
  const rows = parseDfOutput(`Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/sda1         10000000   2000000   8000000    20%    /
/dev/sdb1        478724992 309672600 117794720    73%    /System/Volumes/Data
/dev/sdc1          5000000   1000000   4000000    20%    /System/archive
`, 'linux');
  const mounts = rows.map((r) => r.mount);
  const root = rows.find((r) => r.mount === '/');
  const toMb = (k) => Math.round((k * 1024) / 1024 / 1024);
  assert.equal(root.device, 'sda1');
  assert.equal(root.total, toMb(10000000));
  assert.equal(root.used, toMb(2000000));
  assert.ok(mounts.includes('/System/Volumes/Data'), 'Data row kept as normal mount on linux');
  assert.ok(mounts.includes('/System/archive'), '/System/archive not excluded on linux');
});
