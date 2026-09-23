// Real child-process tests for the opt-in gh usage control CLI. A usage
// error must exit non-zero and must NOT touch sandbox.config.json, and
// `enable` must tighten a pre-existing config file's permissions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, 'gh-usage-report.js');
let tmpRoot;
let cfgPath;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-cli-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
});

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CCSERVER_SANDBOX_CONFIG: cfgPath },
  });
}
function writeConfig(obj) { writeFileSync(cfgPath, JSON.stringify(obj)); }
function readConfig() { return JSON.parse(readFileSync(cfgPath, 'utf8')); }

test('invalid usage exits 2 without mutating the config', () => {
  for (const args of [
    ['enable', '--bogus'],
    ['enable', '--file'],
    ['show', '--no-period', 'extra'],
    ['reset', '--no-period'],
    ['frobnicate'],
    [],
  ]) {
    writeConfig({ docker: false });
    const res = run(args);
    assert.equal(res.status, 2, `${args.join(' ') || '(no args)'} -> exit ${res.status}: ${res.stderr}`);
    assert.deepEqual(readConfig(), { docker: false }, `${args.join(' ')} mutated the config`);
  }
});

test('enable/disable round-trip, show/reset, and 0600 on a pre-existing config', () => {
  const file = join(tmpRoot, 'usage.json');
  writeConfig({ docker: false });
  chmodSync(cfgPath, 0o644);

  const en = run(['enable', '--file', file]);
  assert.equal(en.status, 0, en.stderr);
  assert.deepEqual(readConfig().ghUsageRecording, { enabled: true, file });
  assert.equal(statSync(cfgPath).mode & 0o777, 0o600, 'enable must tighten the config file to 0600');

  writeFileSync(file, JSON.stringify({ version: 1, startedOn: '2026-09-01', counters: { 'codex\tissue\tread\tsuccess': 3 } }));
  const show = run(['show']);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /result=success count=3/);
  assert.doesNotMatch(run(['show', '--no-period']).stdout, /^period:/m);

  const reset = run(['reset']);
  assert.equal(reset.status, 0, reset.stderr);
  assert.doesNotMatch(run(['show']).stdout, /count=/);

  const dis = run(['disable']);
  assert.equal(dis.status, 0, dis.stderr);
  assert.equal(readConfig().ghUsageRecording.enabled, false);
  assert.equal(readConfig().ghUsageRecording.file, file, 'disable must keep the configured path');
});

test('reset on an unusable path exits 1 instead of reporting success', () => {
  const notADir = join(tmpRoot, 'not-a-dir');
  writeFileSync(notADir, 'regular file');
  writeConfig({ docker: false });
  const res = run(['reset', '--file', join(notADir, 'usage.json')]);
  assert.equal(res.status, 1, `reset should fail: ${res.stdout}`);
  assert.match(res.stderr, /Failed to reset/);
});
