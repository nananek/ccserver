// Real child-process tests for the opt-in gh usage control CLI. A usage
// error must exit non-zero and must NOT touch sandbox.config.json, and
// `enable` must tighten a pre-existing config file's permissions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

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
  const env = { ...process.env, CCSERVER_SANDBOX_CONFIG: cfgPath };
  // Node's test runner marks the process running each test file with
  // NODE_TEST_CONTEXT; a spawned node script inherits it and (Node 26) can
  // start as a test-runner child with empty stdout instead of executing the
  // CLI. Strip it so the child is a plain CLI invocation.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env,
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

test('an unparseable config is refused, never replaced with defaults', () => {
  const broken = '{\n  "browseRoots": ["/srv/repos"],\n  "forceSandbox": true,\n  // stray comment\n}\n';
  for (const args of [['enable', '--file', join(tmpRoot, 'usage2.json')], ['disable'], ['show']]) {
    writeFileSync(cfgPath, broken);
    const res = run(args);
    assert.equal(res.status, 1, `${args.join(' ')} -> exit ${res.status}: ${res.stderr}`);
    assert.match(res.stderr, /Cannot parse/);
    assert.equal(readFileSync(cfgPath, 'utf8'), broken, `${args.join(' ')} clobbered an unparseable config`);
  }
});

test('a relative file in the config is rewritten as absolute', () => {
  // loadSandboxConfig treats a relative `file` as unset, so writing one back
  // would print "Enabled" for a config the server silently ignores.
  writeConfig({ docker: false, ghUsageRecording: { enabled: false, file: 'usage-relative.json' } });
  const res = run(['enable']);
  assert.equal(res.status, 0, res.stderr);
  const { file } = readConfig().ghUsageRecording;
  assert.equal(isAbsolute(file), true, `enable wrote a relative path: ${file}`);
  assert.equal(file, resolve('usage-relative.json'));
});
