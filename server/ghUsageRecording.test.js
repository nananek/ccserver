import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyGhUsage, formatGhUsageReport, recordGhUsage, resetGhUsage, resetTargetStatus } from './ghUsageRecording.js';

let dir;
let oldEnabled;
let oldFile;

afterEach(() => {
  if (oldEnabled === undefined) delete process.env.CCSERVER_GH_USAGE_RECORDING; else process.env.CCSERVER_GH_USAGE_RECORDING = oldEnabled;
  if (oldFile === undefined) delete process.env.CCSERVER_GH_USAGE_RECORDING_FILE; else process.env.CCSERVER_GH_USAGE_RECORDING_FILE = oldFile;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

test('gh usage recorder is off by default and stores only normalized aggregate categories', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  delete process.env.CCSERVER_GH_USAGE_RECORDING;
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  assert.equal(recordGhUsage({ client: 'codex', target: 'issue', operation: 'create', result: 'success' }), false);

  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  assert.equal(recordGhUsage({ client: 'codex', target: 'issue', operation: 'create', result: 'success' }), true);
  assert.equal(recordGhUsage({ client: 'codex', target: 'issue', operation: 'create', denial: 'not-allowlisted' }), true);
  const report = formatGhUsageReport(file);
  assert.match(report, /client=codex sandbox=sandboxed broker=on/);
  assert.match(report, /target=issue operation=create result=success count=1/);
  assert.match(report, /target=issue operation=create result=broker-denied:not-allowlisted count=1/);
  assert.doesNotMatch(report, /secret-org|private|argv|aggregate\.json/);
});

test('gh usage reset removes all counters and classifier never retains argv values', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  assert.deepEqual(classifyGhUsage(['issue', 'comment', '99', '--repo', 'secret-org/private']), { target: 'issue', operation: 'comment' });
  recordGhUsage({ client: 'claude', ...classifyGhUsage(['issue', 'comment']), result: 'success' });
  resetGhUsage(file);
  assert.doesNotMatch(formatGhUsageReport(file), /count=/);
});

test('a broken aggregate path returns false instead of throwing (observability must never block gh)', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const notADir = join(dir, 'not-a-dir');
  writeFileSync(notADir, 'regular file');
  const file = join(notADir, 'aggregate.json');
  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  assert.equal(recordGhUsage({ client: 'codex', target: 'issue', operation: 'read', result: 'success' }), false);
  assert.equal(resetGhUsage(file), false);
});

test('mutating gh subcommands are classified as mutations, never as reads', () => {
  assert.deepEqual(classifyGhUsage(['pr', 'merge', '42']), { target: 'pr', operation: 'close' });
  assert.deepEqual(classifyGhUsage(['pr', 'ready', '42']), { target: 'pr', operation: 'edit' });
});

test('a tampered startedOn cannot inject lines into the report and is normalized on the next write', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  writeFileSync(file, JSON.stringify({
    version: 1,
    startedOn: '2026-01-01\nclient=evil sandbox=sandboxed broker=on\n  target=pr operation=create result=success count=99999',
    counters: {
      'codex\tissue\tread\tsuccess': 2,
      'bogus\tkey\twith\textra': 5,
      'codex\tissue\tread\tbroker-denied:made-up': 3,
    },
  }));
  const report = formatGhUsageReport(file);
  assert.doesNotMatch(report, /client=evil|99999|made-up|bogus/);
  assert.match(report, /period: \d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}/);
  assert.match(report, /target=issue operation=read result=success count=2/);

  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  assert.equal(recordGhUsage({ client: 'codex', target: 'issue', operation: 'read', result: 'success' }), true);
  const state = JSON.parse(readFileSync(file, 'utf8'));
  assert.match(state.startedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(state.counters['codex\tissue\tread\tsuccess'], 3);
});

test('a planted symlink at the tmp path cannot redirect the write', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  const victim = join(dir, 'victim.txt');
  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  writeFileSync(victim, 'ORIGINAL\n');
  symlinkSync(victim, `${file}.${process.pid}.tmp`);
  assert.equal(recordGhUsage({ client: 'codex', target: 'issue', operation: 'read', result: 'success' }), true);
  assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL\n');
  assert.match(readFileSync(file, 'utf8'), /"version":1/);
});

test('a fresh lock is skipped without waiting; a stale lock is broken', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  writeFileSync(`${file}.lock`, 'planted');
  const t0 = Date.now();
  assert.equal(recordGhUsage({ client: 'codex', target: 'issue', operation: 'read', result: 'success' }), false);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 900, `recording must not block on a lock (took ${elapsed}ms)`);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(`${file}.lock`), true, 'a fresh foreign lock is left alone');

  const past = new Date(Date.now() - 60_000);
  utimesSync(`${file}.lock`, past, past);
  assert.equal(recordGhUsage({ client: 'codex', target: 'issue', operation: 'read', result: 'success' }), true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).counters['codex\tissue\tread\tsuccess'], 1);
  assert.equal(existsSync(`${file}.lock`), false, 'our lock is released after the write');
});

test('a malformed counters row cannot crash the report or survive the next write', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  writeFileSync(file, JSON.stringify({
    version: 1,
    startedOn: '2026-01-01',
    counters: {
      // Three fields, not four: [...key.split('\t'), count] shifted the count
      // into the result slot, and printing threw on result.startsWith.
      'codex\tissue\tread': 5,
      'codex\tissue\tread\tsuccess\textra': 7,
      'codex\tissue\tread\tsuccess': 2,
    },
    leaked: '/home/someone/secret-project',
  }));
  const report = formatGhUsageReport(file);
  assert.match(report, /target=issue operation=read result=success count=2/);
  assert.doesNotMatch(report, /count=5|count=7|secret-project/);

  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  assert.equal(recordGhUsage({ client: 'codex', target: 'issue', operation: 'read', result: 'success' }), true);
  const state = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(state).sort(), ['counters', 'startedOn', 'version'], 'unknown top-level keys must not be re-persisted');
  assert.deepEqual(state.counters, { 'codex\tissue\tread\tsuccess': 3 });
});

test('counters stored as an array cannot silently swallow every increment', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  // JSON.stringify drops string properties set on an array, so accepting one
  // here made every later increment vanish while recordGhUsage returned true.
  writeFileSync(file, JSON.stringify({ version: 1, startedOn: '2026-01-01', counters: [] }));
  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  assert.equal(recordGhUsage({ client: 'codex', target: 'issue', operation: 'read', result: 'success' }), true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).counters['codex\tissue\tread\tsuccess'], 1);
});

test('the report groups rows under one header per client, in stable key order', () => {
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  writeFileSync(file, JSON.stringify({
    version: 1,
    startedOn: '2026-01-01',
    counters: {
      'codex\tpr\tedit\tsuccess': 2,
      'claude\tissue\tread\tsuccess': 1,
      'codex\tissue\tcreate\tsuccess': 3,
    },
  }));
  const body = formatGhUsageReport(file, { includePeriod: false }).trimEnd().split('\n').slice(3);
  assert.deepEqual(body, [
    'client=claude sandbox=sandboxed broker=on',
    '  target=issue operation=read result=success count=1',
    'client=codex sandbox=sandboxed broker=on',
    '  target=issue operation=create result=success count=3',
    '  target=pr operation=edit result=success count=2',
  ]);
});

// An obstruction planted at the lock or tmp path used to stop recording
// permanently AND silently: unlink(2) cannot remove a directory, so the
// stale-lock recovery failed, and warnStaleLock only fires on success.
for (const kind of ['lock', 'tmp']) {
  test(`a directory planted at the ${kind} path cannot silence recording`, () => {
    oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
    oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
    dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
    const file = join(dir, 'aggregate.json');
    const planted = kind === 'lock' ? `${file}.lock` : `${file}.${process.pid}.tmp`;
    mkdirSync(planted, { recursive: true });
    // Older than LOCK_STALE_MS, so the mtime check alone would call it stale
    // and then fail to unlink it.
    const old = new Date(Date.now() - 600_000);
    utimesSync(planted, old, old);

    process.env.CCSERVER_GH_USAGE_RECORDING = '1';
    process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
    assert.equal(recordGhUsage({ client: 'codex', target: 'pr', operation: 'read', result: 'success' }), true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).counters['codex\tpr\tread\tsuccess'], 1);
    assert.equal(existsSync(planted), false, 'the obstruction must be cleared, not worked around');
  });
}

test('an oversized aggregate is ignored rather than read into memory', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  writeFileSync(file, `{"version":1,"startedOn":"2026-01-01","counters":{}}${' '.repeat(1024 * 1024 + 1)}`);
  assert.doesNotMatch(formatGhUsageReport(file), /count=/);
  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  assert.equal(recordGhUsage({ client: 'codex', target: 'pr', operation: 'read', result: 'success' }), true);
  const state = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(state.counters, { 'codex\tpr\tread\tsuccess': 1 }, 'the oversized file is replaced, not appended to');
});

test('reset refuses anything that is not an aggregate unless forced', () => {
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const victim = join(dir, 'victim.txt');
  writeFileSync(victim, 'IMPORTANT USER DATA\n');
  assert.equal(resetTargetStatus(victim), 'not-an-aggregate');
  assert.equal(resetGhUsage(victim), false);
  assert.equal(readFileSync(victim, 'utf8'), 'IMPORTANT USER DATA\n', 'reset must not clobber an unrelated file');
  // --force exists for an aggregate too corrupt to recognise, which is
  // exactly what reset is for.
  assert.equal(resetGhUsage(victim, { force: true }), true);
  assert.deepEqual(JSON.parse(readFileSync(victim, 'utf8')).counters, {});

  const asDir = join(dir, 'a-directory');
  mkdirSync(asDir);
  assert.equal(resetTargetStatus(asDir), 'not-a-regular-file');
  assert.equal(resetGhUsage(asDir, { force: true }), false, 'not even --force may write over a directory');
  assert.equal(lstatSync(asDir).isDirectory(), true);

  const link = join(dir, 'link.json');
  symlinkSync(victim, link);
  assert.equal(resetTargetStatus(link), 'not-a-regular-file', 'reset must not follow a symlink');

  const fresh = join(dir, 'fresh.json');
  assert.equal(resetTargetStatus(fresh), 'ok');
  assert.equal(resetGhUsage(fresh), true);
});
