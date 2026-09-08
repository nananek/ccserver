import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';

const execFileAsync = promisify(execFile);

// Previous CPU snapshot for usage calculation
let prevCpuStats = null;
let prevCpuTime = 0;

function parseCpuStats(statContent) {
  const lines = statContent.split('\n');
  const cores = [];
  let total = null;
  for (const line of lines) {
    const match = line.match(/^cpu(\d*)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (!match) continue;
    const values = match.slice(2).map(Number);
    const idle = values[3] + values[4]; // idle + iowait
    const busy = values[0] + values[1] + values[2] + values[5] + values[6]; // user+nice+system+irq+softirq
    const entry = { idle, busy, total: idle + busy };
    if (match[1] === '') {
      total = entry;
    } else {
      cores.push(entry);
    }
  }
  return { total, cores };
}

function calcUsage(prev, curr) {
  const totalDelta = curr.total - prev.total;
  if (totalDelta === 0) return 0;
  return ((curr.busy - prev.busy) / totalDelta) * 100;
}

// Whether a /proc read failure should fall back to node:os instead of
// propagating the error. /proc does not exist on macOS/BSD, and some
// restricted Linux environments lack it as well (ENOENT).
function shouldUseOsFallback(err) {
  return process.platform !== 'linux' || err?.code === 'ENOENT';
}

export function cpuStatsFromOs() {
  const cpus = os.cpus();
  const cores = [];
  let totalIdle = 0;
  let totalBusy = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    const idle = t.idle ?? 0;
    const busy = (t.user ?? 0) + (t.nice ?? 0) + (t.sys ?? 0) + (t.irq ?? 0);
    totalIdle += idle;
    totalBusy += busy;
    cores.push({ idle, busy, total: idle + busy });
  }
  return { total: { idle: totalIdle, busy: totalBusy, total: totalIdle + totalBusy }, cores };
}

async function getCpuUsage() {
  let stats;
  try {
    const content = await readFile('/proc/stat', 'utf-8');
    stats = parseCpuStats(content);
    if (!stats.total) throw new Error('unparseable /proc/stat');
  } catch (err) {
    if (shouldUseOsFallback(err)) {
      stats = cpuStatsFromOs();
    } else {
      throw err;
    }
  }
  const now = Date.now();

  let totalUsage = 0;
  let coreUsages = stats.cores.map(() => 0);

  if (prevCpuStats && (now - prevCpuTime) < 10000) {
    totalUsage = calcUsage(prevCpuStats.total, stats.total);
    coreUsages = stats.cores.map((core, i) =>
      prevCpuStats.cores[i] ? calcUsage(prevCpuStats.cores[i], core) : 0
    );
  }

  prevCpuStats = stats;
  prevCpuTime = now;

  return {
    total: Math.round(totalUsage * 10) / 10,
    cores: coreUsages.map((u) => Math.round(u * 10) / 10),
  };
}

export function memoryFromOs() {
  const toMb = (b) => Math.round(b / 1024 / 1024);
  const total = os.totalmem();
  const free = os.freemem();
  return {
    total: toMb(total),
    used: toMb(total - free),
    free: toMb(free),
    available: toMb(free),
    bufferCache: null,
    swapTotal: 0,
    swapUsed: 0,
  };
}

async function getMemory() {
  let content;
  try {
    content = await readFile('/proc/meminfo', 'utf-8');
  } catch (err) {
    if (shouldUseOsFallback(err)) {
      return memoryFromOs();
    }
    throw err;
  }
  const get = (key) => {
    const m = content.match(new RegExp(`${key}:\\s+(\\d+)`));
    return m ? parseInt(m[1], 10) : 0;
  };
  const totalKb = get('MemTotal');
  const freeKb = get('MemFree');
  const availableKb = get('MemAvailable');
  const buffersKb = get('Buffers');
  const cachedKb = get('Cached');
  const swapTotalKb = get('SwapTotal');
  const swapFreeKb = get('SwapFree');

  const toMb = (kb) => Math.round(kb / 1024);
  return {
    total: toMb(totalKb),
    used: toMb(totalKb - freeKb - buffersKb - cachedKb),
    free: toMb(freeKb),
    available: toMb(availableKb),
    bufferCache: toMb(buffersKb + cachedKb),
    swapTotal: toMb(swapTotalKb),
    swapUsed: toMb(swapTotalKb - swapFreeKb),
  };
}

function getTemperatures() {
  const temps = {};
  try {
    const hwmonBase = '/sys/class/hwmon';
    const hwmons = readdirSync(hwmonBase);
    for (const hwmon of hwmons) {
      const dir = `${hwmonBase}/${hwmon}`;
      const namePath = `${dir}/name`;
      if (!existsSync(namePath)) continue;
      const name = readFileSync(namePath, 'utf-8').trim();

      // Find all temp*_input files
      const entries = readdirSync(dir).filter((f) => f.match(/^temp\d+_input$/));
      for (const entry of entries) {
        const inputPath = `${dir}/${entry}`;
        const idx = entry.match(/^temp(\d+)_input$/)[1];
        const labelPath = `${dir}/temp${idx}_label`;
        const label = existsSync(labelPath)
          ? readFileSync(labelPath, 'utf-8').trim()
          : `${name} #${idx}`;
        const value = parseInt(readFileSync(inputPath, 'utf-8').trim(), 10);
        const category = name === 'coretemp' ? 'cpu' : name.includes('pch') ? 'pch' : 'other';
        if (!temps[category]) temps[category] = [];
        temps[category].push({ label, value: Math.round(value / 1000) });
      }
    }
  } catch {
    // Silently fail - no hwmon available
  }
  return temps;
}

async function getGpuInfo() {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=name,temperature.gpu,fan.speed,power.draw,power.limit,memory.used,memory.total,utilization.gpu',
      '--format=csv,noheader,nounits',
    ], { timeout: 3000 });
    const parts = stdout.trim().split(',').map((s) => s.trim());
    if (parts.length >= 8) {
      return {
        name: parts[0],
        temp: parseInt(parts[1], 10),
        fanSpeed: parseInt(parts[2], 10),
        powerUsage: parseFloat(parts[3]),
        powerCap: parseFloat(parts[4]),
        memoryUsed: parseInt(parts[5], 10),
        memoryTotal: parseInt(parts[6], 10),
        utilization: parseInt(parts[7], 10),
      };
    }
  } catch {
    // No NVIDIA GPU or nvidia-smi not available
  }
  return null;
}

const enableIpmi = process.env.ENABLE_IPMI === '1' || process.env.ENABLE_IPMI === 'true';

let ipmiCache = null;
let ipmiFetching = false;
let ipmiTimer = null;
let lastIpmiRequest = 0;
const IPMI_POLL_INTERVAL = 60000;
const IPMI_IDLE_TIMEOUT = 120000;

function parseIpmiOutput(stdout) {
  const lines = stdout.trim().split('\n');
  const power = [];
  const voltage = [];
  const fans = [];
  const temps = [];

  for (const line of lines) {
    const cols = line.split('|').map((s) => s.trim());
    if (cols.length < 3) continue;
    const name = cols[0];
    const reading = parseFloat(cols[1]);
    if (isNaN(reading)) continue;
    const unit = cols[2].toLowerCase();
    const status = cols[3]?.trim();
    if (status !== 'ok') continue;

    if (unit === 'watts') {
      power.push({ label: name, value: reading });
    } else if (unit === 'volts') {
      voltage.push({ label: name, value: reading });
    } else if (unit === 'rpm') {
      fans.push({ label: name, value: reading });
    } else if (unit === 'degrees c') {
      temps.push({ label: name, value: reading });
    }
  }
  return { power, voltage, fans, temps };
}

async function refreshIpmiCache() {
  if (ipmiFetching) return;
  if (Date.now() - lastIpmiRequest > IPMI_IDLE_TIMEOUT) {
    clearInterval(ipmiTimer);
    ipmiTimer = null;
    return;
  }
  ipmiFetching = true;
  try {
    const { stdout } = await execFileAsync('ipmitool', ['sensor', 'list'], { timeout: 10000 });
    ipmiCache = parseIpmiOutput(stdout);
  } catch {
    // keep previous cache on failure
  } finally {
    ipmiFetching = false;
  }
}

function startIpmiPolling() {
  if (ipmiTimer) return;
  refreshIpmiCache();
  ipmiTimer = setInterval(refreshIpmiCache, IPMI_POLL_INTERVAL);
  // Background polling must never keep the process alive on its own (same
  // pattern as ptyHostClient.js's reconnect timers / sessionManager.js's
  // resumeIdWriteTimer) -- without this, ENABLE_IPMI=1 leaves a live
  // 60s-interval timer that only self-clears after IPMI_IDLE_TIMEOUT (120s)
  // of no requests, which is what made routes/system.test.js hang until the
  // test runner's own timeout (Issue #156).
  ipmiTimer.unref?.();
}

function requestIpmi() {
  if (!enableIpmi) return null;
  lastIpmiRequest = Date.now();
  startIpmiPolling();
  return ipmiCache;
}

async function getLoadAndUptime() {
  try {
    const content = await readFile('/proc/uptime', 'utf-8');
    const uptime = parseFloat(content.split(' ')[0]);
    const loadavgContent = await readFile('/proc/loadavg', 'utf-8');
    const parts = loadavgContent.trim().split(/\s+/);
    return {
      loadAvg: parts.slice(0, 3).map(Number),
      uptime: Math.floor(uptime),
    };
  } catch (err) {
    if (shouldUseOsFallback(err)) {
      return {
        loadAvg: os.loadavg(),
        uptime: Math.floor(os.uptime()),
      };
    }
    throw err;
  }
}

function getCpuModel() {
  try {
    const content = readFileSync('/proc/cpuinfo', 'utf-8');
    const m = content.match(/model name\s*:\s*(.+)/);
    if (m) return m[1].trim();
  } catch {
    // fall through to os.cpus() below (/proc/cpuinfo does not exist on macOS)
  }
  try {
    const model = os.cpus()?.[0]?.model;
    if (model) return model.trim();
  } catch {
    // ignore
  }
  return 'Unknown';
}

const cpuModel = getCpuModel();

// --- Storage info ---

const EXCLUDE_FS = new Set(['tmpfs', 'devtmpfs', 'udev', 'squashfs', 'overlay', 'ramfs', 'cgroup', 'cgroup2', 'sysfs', 'proc', 'devpts', 'securityfs', 'pstore', 'efivarfs', 'bpf', 'autofs', 'mqueue', 'hugetlbfs', 'fusectl', 'configfs', 'debugfs', 'tracefs']);

async function getStorageInfo() {
  try {
    // -B1 is GNU-df-only and fails on BSD/macOS.
    // -k (1K blocks) works on both, so multiply by 1024 for byte conversion.
    const { stdout } = await execFileAsync('df', ['-P', '-k'], { timeout: 5000 });
    const lines = stdout.trim().split('\n').slice(1);
    const entries = [];
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 6) continue;
      const [device, total, used, available, , mount] = parts;
      const fsType = device.startsWith('/dev/') ? null : device;
      if (fsType && EXCLUDE_FS.has(fsType)) continue;
      if (!device.startsWith('/dev/')) continue;
      const toMb = (k) => Math.round((parseInt(k, 10) * 1024) / 1024 / 1024);
      const totalMb = toMb(total);
      if (totalMb === 0) continue;
      const usedMb = toMb(used);
      entries.push({
        mount,
        device: device.replace('/dev/', ''),
        total: totalMb,
        used: usedMb,
        available: toMb(available),
        usedPct: Math.round((usedMb / totalMb) * 1000) / 10,
      });
    }
    return entries;
  } catch {
    return [];
  }
}

export async function systemRoute(fastify, opts) {
  fastify.get('/system-stats', async (request) => {
    // Never fail the whole response with a 500 because of one section.
    // Return what could be collected and report failures as null/empty
    // values plus an errors object, always with HTTP 200.
    // (gpu/temperatures/storage already degrade gracefully, so they are
    // excluded from errors. A missing GPU etc. is a normal absence.)
    const [cpuRes, memRes, gpuRes, loadRes, storageRes] = await Promise.allSettled([
      getCpuUsage(),
      getMemory(),
      getGpuInfo(),
      getLoadAndUptime(),
      getStorageInfo(),
    ]);
    const errors = {};
    const cpuUsage = cpuRes.status === 'fulfilled' ? cpuRes.value : null;
    if (cpuRes.status === 'rejected') errors.cpu = String(cpuRes.reason?.message ?? cpuRes.reason);
    const memory = memRes.status === 'fulfilled' ? memRes.value : null;
    if (memRes.status === 'rejected') errors.memory = String(memRes.reason?.message ?? memRes.reason);
    const gpu = gpuRes.status === 'fulfilled' ? gpuRes.value : null;
    const loadUptime = loadRes.status === 'fulfilled'
      ? loadRes.value
      : { loadAvg: [], uptime: null };
    if (loadRes.status === 'rejected') errors.system = String(loadRes.reason?.message ?? loadRes.reason);
    const storage = storageRes.status === 'fulfilled' ? storageRes.value : [];

    const wantIpmi = request.query.ipmi === '1';
    const ipmi = wantIpmi ? requestIpmi() : null;
    const temperatures = getTemperatures();

    const body = {
      cpu: cpuUsage
        ? {
          model: cpuModel,
          coreCount: cpuUsage.cores.length,
          usage: cpuUsage,
        }
        : null,
      memory,
      storage,
      temperatures,
      gpu,
      ipmi,
      ...loadUptime,
    };
    if (Object.keys(errors).length > 0) body.errors = errors;
    return body;
  });
}
