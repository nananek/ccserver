// Store boundary for the network-isolation settings GUI: validation,
// normalization, and read-modify-write preservation of the rest of
// sandbox.config.json. Runs against a throwaway CCSERVER_SANDBOX_CONFIG so
// the host's real config is never touched (same precedent as
// sandbox-config.test.js).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getNetworkSettings, updateNetworkSettings, resolveSandboxConfigPath } from './networkAllowlist.js';

let tmpRoot;
let cfgPath;
let prevConfig;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-network-allowlist-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  prevConfig = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
});

after(() => {
  if (prevConfig === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
  else process.env.CCSERVER_SANDBOX_CONFIG = prevConfig;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeRaw(obj) {
  writeFileSync(cfgPath, JSON.stringify(obj));
}

test('resolveSandboxConfigPath honors CCSERVER_SANDBOX_CONFIG', () => {
  assert.equal(resolveSandboxConfigPath(), cfgPath);
});

test('getNetworkSettings defaults on a missing file', () => {
  try { rmSync(cfgPath, { force: true }); } catch { /* ignore */ }
  assert.deepEqual(getNetworkSettings(), { isolate: false, initialState: 'enforce', mode: 'enforce', allowedHosts: [], deniedHosts: [] });
});

test('getNetworkSettings mirrors loadSandboxConfig parsing', () => {
  writeRaw({ network: { isolate: true, initialState: 'open', mode: 'audit', allowedHosts: ['api.example.com', 42, null, ''], deniedHosts: ['evil.example', 42, null, ''] } });
  assert.deepEqual(getNetworkSettings(), { isolate: true, initialState: 'open', mode: 'audit', allowedHosts: ['api.example.com'], deniedHosts: ['evil.example'] });
});

test('getNetworkSettings collapses a missing initialState to enforce', () => {
  writeRaw({ network: { isolate: true } });
  assert.deepEqual(getNetworkSettings(), { isolate: true, initialState: 'enforce', mode: 'enforce', allowedHosts: [], deniedHosts: [] });
});

test('updateNetworkSettings creates the file and normalizes entries', () => {
  try { rmSync(cfgPath, { force: true }); } catch { /* ignore */ }
  const res = updateNetworkSettings({ isolate: true, initialState: 'open', mode: 'audit', allowedHosts: ['  API.Example.COM ', '.example.net', 'api.example.com'], deniedHosts: ['  Evil.Example ', '.tracker.example'] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.settings, { isolate: true, initialState: 'open', mode: 'audit', allowedHosts: ['api.example.com', '.example.net'], deniedHosts: ['evil.example', '.tracker.example'] });
  const onDisk = JSON.parse(readFileSync(cfgPath, 'utf-8'));
  assert.deepEqual(onDisk.network.allowedHosts, ['api.example.com', '.example.net']);
  assert.deepEqual(onDisk.network.deniedHosts, ['evil.example', '.tracker.example']);
});

test('updateNetworkSettings is partial and preserves other keys', () => {
  writeRaw({ '//note': 'keep me', docker: false, network: { isolate: false, mode: 'enforce', allowedHosts: ['a.example'] } });
  const res = updateNetworkSettings({ allowedHosts: ['b.example'] });
  assert.equal(res.ok, true);
  const onDisk = JSON.parse(readFileSync(cfgPath, 'utf-8'));
  assert.equal(onDisk['//note'], 'keep me', 'comment keys survive');
  assert.equal(onDisk.docker, false, 'unrelated keys survive');
  assert.deepEqual(onDisk.network, { isolate: false, mode: 'enforce', allowedHosts: ['b.example'] }, 'unpatched keys stay untouched on disk');
});

test('updateNetworkSettings rejects bad isolate/initialState/mode/list', () => {
  writeRaw({});
  for (const patch of [
    { isolate: 'yes' },
    { initialState: 'sometimes' },
    { initialState: true },
    { mode: 'sometimes' },
    { allowedHosts: 'api.example.com' },
    { allowedHosts: ['https://api.example.com'] },
    { allowedHosts: ['api.example.com:443'] },
    { allowedHosts: ['*.example.com'] },
    { allowedHosts: ['not a host'] },
    { allowedHosts: [''] },
    { deniedHosts: 'evil.example' },
    { deniedHosts: ['https://evil.example'] },
    { deniedHosts: ['*.evil.example'] },
    { deniedHosts: ['not a host'] },
    null,
    42,
  ]) {
    const res = updateNetworkSettings(patch);
    assert.equal(res.ok, false, `must reject ${JSON.stringify(patch)}`);
    assert.equal(res.code, 'validation');
  }
  // Rejected writes change nothing on disk.
  assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf-8')), {});
});

test('updateNetworkSettings refuses a corrupt file instead of overwriting it', () => {
  writeFileSync(cfgPath, '{ not json');
  const res = updateNetworkSettings({ allowedHosts: ['a.example'] });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'internal');
  assert.equal(readFileSync(cfgPath, 'utf-8'), '{ not json', 'corrupt file left untouched');
});
