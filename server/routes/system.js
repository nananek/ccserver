import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, readFileSync, existsSync } from 'node:fs';

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

async function getCpuUsage() {
  const content = await readFile('/proc/stat', 'utf-8');
  const stats = parseCpuStats(content);
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

async function getMemory() {
  const content = await readFile('/proc/meminfo', 'utf-8');
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

if (enableIpmi) {
  refreshIpmiCache();
  setInterval(refreshIpmiCache, 10000);
}

function getIpmiSensors() {
  if (!enableIpmi) return null;
  return ipmiCache;
}

async function getLoadAndUptime() {
  const content = await readFile('/proc/uptime', 'utf-8');
  const uptime = parseFloat(content.split(' ')[0]);
  const loadavgContent = await readFile('/proc/loadavg', 'utf-8');
  const parts = loadavgContent.trim().split(/\s+/);
  return {
    loadAvg: parts.slice(0, 3).map(Number),
    uptime: Math.floor(uptime),
  };
}

function getCpuModel() {
  try {
    const content = readFileSync('/proc/cpuinfo', 'utf-8');
    const m = content.match(/model name\s*:\s*(.+)/);
    return m ? m[1].trim() : 'Unknown';
  } catch {
    return 'Unknown';
  }
}

const cpuModel = getCpuModel();

export async function systemRoute(fastify, opts) {
  fastify.get('/system-stats', async () => {
    const [cpuUsage, memory, gpu, loadUptime] = await Promise.all([
      getCpuUsage(),
      getMemory(),
      getGpuInfo(),
      getLoadAndUptime(),
    ]);
    const ipmi = getIpmiSensors();
    const temperatures = getTemperatures();

    return {
      cpu: {
        model: cpuModel,
        coreCount: cpuUsage.cores.length,
        usage: cpuUsage,
      },
      memory,
      temperatures,
      gpu,
      ipmi,
      ...loadUptime,
    };
  });
}
