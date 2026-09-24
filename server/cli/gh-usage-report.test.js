// Real child-process tests for the opt-in gh usage control CLI. A usage
// error must exit non-zero and must NOT touch sandbox.config.json, and
// `enable` must tighten a pre-existing config file's permissions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

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

function run(args, opts = {}) {
  const env = { ...process.env, CCSERVER_SANDBOX_CONFIG: cfgPath };
  // Node's test runner marks the process running each test file with
  // NODE_TEST_CONTEXT; a spawned node script inherits it and (Node 26) can
  // start as a test-runner child with empty stdout instead of executing the
  // CLI. Strip it so the child is a plain CLI invocation.
  delete env.NODE_TEST_CONTEXT;
  // A timeout, not an unbounded wait: a regression that blocks on the
  // aggregate (a FIFO once froze readFileSync outright) must fail the test
  // rather than hang the whole run.
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env,
    timeout: 20_000,
    ...opts,
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
  assert.match(res.stderr, /Refusing to reset .*unusable/);
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
  // Run from tmpRoot, not the repo: this checkout may itself live under the
  // ccserver scratch tree, which `enable` refuses (see the scratch-tree test).
  const res = run(['enable'], { cwd: tmpRoot });
  assert.equal(res.status, 0, res.stderr);
  const { file } = readConfig().ghUsageRecording;
  assert.equal(isAbsolute(file), true, `enable wrote a relative path: ${file}`);
  assert.equal(file, join(tmpRoot, 'usage-relative.json'));
});

// mkfifo is POSIX-only; the suite already assumes symlinks elsewhere, but
// skip rather than fail if it is unavailable.
function mkfifo(path) {
  try { unlinkSync(path); } catch { /* usually absent */ }
  return spawnSync('mkfifo', [path]).status === 0;
}

test('show and reset never block on a FIFO planted at the aggregate path', (t) => {
  const fifo = join(tmpRoot, 'fifo.json');
  if (!mkfifo(fifo)) return t.skip('mkfifo unavailable');
  writeConfig({ docker: false });

  // readFileSync on a FIFO waits for a writer, which froze the CLI (and, in
  // the broker, the event loop -- SIGTERM could not even be delivered).
  const show = run(['show', '--file', fifo]);
  assert.equal(show.signal, null, 'show hung on the FIFO');
  assert.equal(show.status, 0, show.stderr);
  assert.doesNotMatch(show.stdout, /count=/);

  const reset = run(['reset', '--file', fifo]);
  assert.equal(reset.signal, null, 'reset hung on the FIFO');
  assert.equal(reset.status, 1, `reset should refuse a FIFO: ${reset.stdout}`);
  assert.match(reset.stderr, /Refusing to reset/);
});

test('reset refuses an unrelated file, and --force is what overwrites it', () => {
  const victim = join(tmpRoot, 'victim.txt');
  writeFileSync(victim, 'IMPORTANT USER DATA\n');
  writeConfig({ docker: false });

  const refused = run(['reset', '--file', victim]);
  assert.equal(refused.status, 1, `reset clobbered an unrelated file: ${refused.stdout}`);
  assert.match(refused.stderr, /not a gh usage aggregate/);
  assert.equal(readFileSync(victim, 'utf8'), 'IMPORTANT USER DATA\n');

  const forced = run(['reset', '--force', '--file', victim]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.deepEqual(JSON.parse(readFileSync(victim, 'utf8')).counters, {});

  assert.equal(run(['show', '--force']).status, 2, '--force is only valid with reset');
});

test('a path is quoted on its way to the terminal', () => {
  const tricky = join(tmpRoot, 'esc-\u001b[31mRED.json');
  writeFileSync(tricky, JSON.stringify({ version: 1, startedOn: '2026-01-01', counters: {} }));
  writeConfig({ docker: false });
  const res = run(['reset', '--file', tricky]);
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /\u001b\[31m/, 'a raw escape sequence reached the terminal');
  assert.match(res.stdout, /\\u001b\[31mRED/);
});

test('enable refuses a path inside browseRoots instead of bricking the next boot', () => {
  const inside = join(tmpRoot, 'roots', 'project', 'agg.json');
  writeConfig({ browseRoots: [join(tmpRoot, 'roots')], forceSandbox: true });
  const res = run(['enable', '--file', inside]);
  assert.equal(res.status, 1, `enable should refuse: ${res.stdout}`);
  assert.match(res.stderr, /inside browseRoots/);
  assert.deepEqual(readConfig(), { browseRoots: [join(tmpRoot, 'roots')], forceSandbox: true }, 'the config must be untouched');

  // Outside is fine, and disable is never blocked (it is how you recover).
  const outside = join(tmpRoot, 'outside', 'agg.json');
  assert.equal(run(['enable', '--file', outside]).status, 0);
  assert.equal(readConfig().ghUsageRecording.file, outside);
  assert.equal(run(['disable']).status, 0);
});

test('enable refuses the ccserver scratch tree even without browseRoots', () => {
  // pathPolicy exempts this tree from browseRoots precisely because each
  // session's persistent HOME and the combo worktrees are rw-bound from it --
  // so an aggregate there is writable by the agents it counts, in the default
  // configuration where the browseRoots guard does not run at all.
  const inScratch = join(homedir(), '.local', 'share', 'ccserver-sandbox', 'home', 'proj', 'agg.json');
  writeConfig({ docker: false });
  const res = run(['enable', '--file', inScratch]);
  assert.equal(res.status, 1, `enable should refuse: ${res.stdout}`);
  assert.match(res.stderr, /scratch tree/);
  assert.deepEqual(readConfig(), { docker: false }, 'the config must be untouched');
});

test('an aggregate past the read cap is repairable with reset --force', () => {
  const big = join(tmpRoot, 'big-aggregate.json');
  writeFileSync(big, 'x'.repeat(1024 * 1024 + 1));
  writeConfig({ docker: false });
  const refused = run(['reset', '--file', big]);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /larger than a gh usage aggregate/);
  const forced = run(['reset', '--force', '--file', big]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.deepEqual(JSON.parse(readFileSync(big, 'utf8')).counters, {});
});

test('enable refuses a target that is not a plain file', () => {
  // Accepting these was how an operator typo reached the recorder, which then
  // renamed its aggregate onto the path -- and, before the obstruction rules
  // were narrowed, deleted a real directory's contents to do it.
  const asDir = join(tmpRoot, 'a-real-directory');
  mkdirSync(asDir, { recursive: true });
  writeFileSync(join(asDir, 'irreplaceable.txt'), 'DATA');
  for (const target of [asDir, '/dev/null', '/']) {
    writeConfig({ docker: false });
    const res = run(['enable', '--file', target]);
    assert.equal(res.status, 1, `enable ${target} -> exit ${res.status}: ${res.stdout}`);
    assert.match(res.stderr, /not a file the aggregate can be written to/);
    assert.deepEqual(readConfig(), { docker: false }, `enable ${target} mutated the config`);
  }
  assert.equal(readFileSync(join(asDir, 'irreplaceable.txt'), 'utf8'), 'DATA');
});

test('show says why a report is empty when the aggregate cannot be read', () => {
  const big = join(tmpRoot, 'unreadable-aggregate.json');
  writeFileSync(big, 'x'.repeat(1024 * 1024 + 1));
  writeConfig({ docker: false });
  const res = run(['show', '--file', big]);
  assert.equal(res.status, 0, res.stderr);
  // The report itself stays pasteable on stdout; the diagnosis goes to stderr.
  assert.doesNotMatch(res.stdout, /count=|warning:/);
  assert.match(res.stderr, /could not be read as a gh usage aggregate \(too-large\)/);

  // A genuinely empty aggregate says nothing at all.
  const fresh = join(tmpRoot, 'fresh-aggregate.json');
  const ok = run(['show', '--file', fresh]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stderr, '', `a missing aggregate must not warn: ${ok.stderr}`);
});
