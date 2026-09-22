import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxSpawn } from './sandbox.js';
import { getGroupFilesDir } from './groupFiles.js';

// gitBroker defaults on (see sandbox.js loadSandboxConfig) and buildSandboxSpawn
// spawns a real broker child process/socket when it is. Every other test that
// calls buildSandboxSpawn pins gitBroker:false via CCSERVER_SANDBOX_CONFIG for
// exactly this reason (see sandbox-git-common-dir.test.js etc.) -- this file
// didn't, so each call here leaked a live broker process that never exits,
// hanging `node --test` until CI's job timeout.
let cfgPath;
let tmpRoot;
let prevCfgEnv;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-sandbox-group-files-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, persistentHome: false }));
  prevCfgEnv = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
});

after(() => {
  if (prevCfgEnv === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
  else process.env.CCSERVER_SANDBOX_CONFIG = prevCfgEnv;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('sandbox: group member gets read-only bind at /ccserver-group-files, standalone does not', async () => {
  const cwd = '/tmp';
  const groupId = 'test-group-id';
  const groupFilesDir = getGroupFilesDir(groupId);
  // standalone: groupFilesDir null -> no bind
  const standalone = await buildSandboxSpawn({ cwd, targetCommand: ['/bin/true'], app: 'claude', groupFilesDir: null });
  const standaloneArgs = standalone.args.join(' ');
  assert.equal(standaloneArgs.includes('/ccserver-group-files'), false, 'standalone must not bind group files');

  // group member: explicit dir -> ro-bind-try
  const member = await buildSandboxSpawn({ cwd, targetCommand: ['/bin/true'], app: 'claude', groupFilesDir });
  const args = member.args.join(' ');
  assert.ok(args.includes('--ro-bind-try'), 'group bind is present');
  assert.ok(args.includes('/ccserver-group-files'), 'fixed sandbox path present');
  assert.ok(args.includes(groupFilesDir), 'host dir present');
  // Ensure it's ro-bind-try, not rw
  const idx = member.args.indexOf('--ro-bind-try');
  assert.notEqual(idx, -1);
  assert.equal(member.args[idx + 2], '/ccserver-group-files');
});

test('sandbox: groupFilesDir is auto-resolved for sandboxed group sessions', async () => {
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tmp = mkdtempSync(join(tmpdir(), 'cc-sb-fallback-'));
  process.env.CCSERVER_GROUP_FILES_ROOT = join(tmp, 'group-files');
  // Verify that a group member's host dir is ensured and bound read-only
  const groupId = 'fallback-gid';
  const { getGroupFilesDir, ensureGroupFilesDir } = await import('./groupFiles.js');
  const dir = getGroupFilesDir(groupId);
  ensureGroupFilesDir(groupId);
  assert.ok(existsSync(dir), 'ensureGroupFilesDir creates the host dir');
  const spawn = await buildSandboxSpawn({ cwd: '/tmp', targetCommand: ['/bin/true'], app: 'claude', groupFilesDir: dir });
  assert.ok(spawn.args.join(' ').includes('/ccserver-group-files'), 'auto-resolved dir is bound');
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.CCSERVER_GROUP_FILES_ROOT;
});
