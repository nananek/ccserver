// Persistent per-project HOME for sandboxed sessions:
//   - persistentHome on (default): buildBwrapArgs binds the per-project dir at
//     HOME instead of a fresh tmpfs; host ~/.local/bin is exposed at a
//     secondary bin-host path so the persistent home's own .local/bin stays
//     writable for agent-installed tools.
//   - reuseSandboxHome false: the previous HOME is wiped (rmSync) and
//     recreated empty before the bind.
//   - persistentHome off / buildMinimalSandboxSpawn: legacy fresh tmpfs HOME.
//
// Isolated via CCSERVER_SANDBOX_CONFIG (config) and CCSERVER_SANDBOX_HOME_ROOT
// (home root), both set for the whole file; no real bwrap/pty is involved --
// buildSandboxSpawn only assembles the argv.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxSpawn, buildMinimalSandboxSpawn, persistentHomeDir, sandboxHomeStatus } from './sandbox.js';

const HOME = process.env.HOME;

let cfgPath;
let tmpRoot;
let homeRoot;

async function spawnArgs({ cwd, reuseSandboxHome = true, json = { docker: false, gitBroker: false } } = {}) {
  writeFileSync(cfgPath, JSON.stringify(json));
  return (await buildSandboxSpawn({ cwd, targetCommand: ['claude'], app: 'claude', sandboxOpts: null, reuseSandboxHome })).args;
}

// --bind <src> <HOME> pairs, and --tmpfs <HOME> pairs (the args array also
// carries an unrelated '--tmpfs /tmp' when persistentHome is off, so a bare
// indexOf('--tmpfs') must not be used).
function findBindHome(args, src) {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--bind' && args[i + 1] === src && args[i + 2] === HOME) return i;
  }
  return -1;
}

function findTmpfsHome(args) {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--tmpfs' && args[i + 1] === HOME) return i;
  }
  return -1;
}

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-persist-home-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  homeRoot = join(tmpRoot, 'home');
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  process.env.CCSERVER_SANDBOX_HOME_ROOT = homeRoot;
});

after(() => {
  delete process.env.CCSERVER_SANDBOX_CONFIG;
  delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('persistentHomeDir is deterministic and resolve-normalized per cwd', () => {
  const a = persistentHomeDir('/srv/proj');
  assert.equal(persistentHomeDir('/srv/proj'), a, 'same cwd -> same dir');
  assert.equal(persistentHomeDir('/srv/proj/'), a, 'trailing slash normalizes to the same dir');
  assert.notEqual(persistentHomeDir('/srv/other'), a, 'different cwd -> different dir');
  assert.ok(a.startsWith(homeRoot), 'lives under the configured home root');
});

test('sandboxHomeStatus reports enabled/exists with persistentHome on', async () => {
  const cwd = join(tmpRoot, 'proj');
  assert.equal(sandboxHomeStatus(cwd).enabled, true);
  assert.equal(sandboxHomeStatus(cwd).exists, false, 'no dir yet');
  // A previous sandbox leaves its HOME behind.
  await spawnArgs({ cwd });
  assert.equal(sandboxHomeStatus(cwd).exists, true);
});

test('persistentHome on binds the per-project dir at HOME (no tmpfs HOME)', async () => {
  const cwd = join(tmpRoot, 'proj-a');
  const args = await spawnArgs({ cwd });
  const home = persistentHomeDir(cwd);
  const idx = findBindHome(args, home);
  assert.ok(idx > 0, 'uses a bind for HOME');
  assert.equal(args[idx + 2], HOME);
  assert.equal(findTmpfsHome(args), -1, 'HOME is not a tmpfs');
  assert.ok(existsSync(home), 'the HOME dir is created on the host');
});

test('persistentHome off keeps the legacy fresh tmpfs HOME', async () => {
  const cwd = join(tmpRoot, 'proj-b');
  const args = await spawnArgs({ cwd, json: { docker: false, gitBroker: false, persistentHome: false } });
  const idx = findTmpfsHome(args);
  assert.ok(idx > 0, 'tmpfs present');
  assert.equal(findBindHome(args, persistentHomeDir(cwd)), -1, 'no persistent HOME bind');
});

test('reuseSandboxHome false wipes the previous HOME and starts empty', async () => {
  const cwd = join(tmpRoot, 'proj-c');
  // First launch (reuse) leaves state behind.
  await spawnArgs({ cwd });
  const home = persistentHomeDir(cwd);
  assert.ok(existsSync(home));
  writeFileSync(join(home, 'installed-tool'), 'x');
  assert.deepEqual(readdirSync(home).sort(), ['.ccserver-tmp', '.local', 'installed-tool'], 'state survives a reuse launch');

  // Second launch with reuseSandboxHome:false wipes it.
  await spawnArgs({ cwd, reuseSandboxHome: false });
  assert.deepEqual(readdirSync(home).sort(), ['.ccserver-tmp', '.local'], 'the previous tool is gone after a fresh launch');
});

test('persistentHome on binds /tmp under the persistent HOME (no fresh tmpfs)', async () => {
  const cwd = join(tmpRoot, 'proj-f');
  const args = await spawnArgs({ cwd });
  const tmpSrc = join(persistentHomeDir(cwd), '.ccserver-tmp');
  const idx = args.indexOf('/tmp');
  assert.ok(idx > 0, '/tmp mount present');
  assert.equal(args[idx - 2], '--bind', '/tmp is a bind with a persistent HOME');
  assert.equal(args[idx - 1], tmpSrc, '/tmp source lives under the persistent HOME');
  assert.ok(existsSync(tmpSrc), 'the /tmp dir is created on the host');
});

test('persistentHome off keeps /tmp as a fresh tmpfs', async () => {
  const cwd = join(tmpRoot, 'proj-g');
  const args = await spawnArgs({ cwd, json: { docker: false, gitBroker: false, persistentHome: false } });
  const idx = args.indexOf('/tmp');
  assert.ok(idx > 0, '/tmp mount present');
  assert.equal(args[idx - 1], '--tmpfs', '/tmp stays a tmpfs without a persistent HOME');
});

test('persistent home exposes host ~/.local/bin at a secondary bin-host path on PATH', async () => {
  const cwd = join(tmpRoot, 'proj-d');
  const args = await spawnArgs({ cwd });
  const hostBinDest = join(HOME, '.local', 'bin-host');
  const bindIdx = args.indexOf('--ro-bind-try');
  assert.ok(bindIdx > 0, 'bin-host bind present');
  assert.equal(args[bindIdx + 1], join(HOME, '.local', 'bin'));
  assert.equal(args[bindIdx + 2], hostBinDest);
  const pathEnvIdx = args.indexOf('PATH');
  assert.ok(pathEnvIdx > 0);
  assert.ok(args[pathEnvIdx + 1].endsWith(hostBinDest), 'PATH includes bin-host');
});

test('tmpfs home keeps the legacy ro-bind of host ~/.local/bin at its real path', async () => {
  const cwd = join(tmpRoot, 'proj-e');
  const args = await spawnArgs({ cwd, json: { docker: false, gitBroker: false, persistentHome: false } });
  assert.ok(!args.includes(join(HOME, '.local', 'bin-host')), 'no bin-host path with tmpfs home');
  const pathEnvIdx = args.indexOf('PATH');
  assert.ok(!String(args[pathEnvIdx + 1]).includes('bin-host'), 'PATH has no bin-host');
});

test('buildMinimalSandboxSpawn never uses a persistent HOME (throwaway usage capture)', () => {
  const spawn = buildMinimalSandboxSpawn({ cwd: tmpRoot, targetCommand: ['claude'] });
  const args = spawn.args;
  const idx = findTmpfsHome(args);
  assert.ok(idx > 0, 'tmpfs present');
  assert.equal(findBindHome(args, persistentHomeDir(tmpRoot)), -1, 'no persistent HOME bind');
});
