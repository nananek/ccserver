import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateReadProblem, aggregateStatus, classifyGhUsage, formatGhUsageReport, readCapped, recordGhUsage, resetGhUsage, resetGhUsageWarnings } from './ghUsageRecording.js';

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
  assert.equal(aggregateStatus(victim), 'not-an-aggregate');
  assert.equal(resetGhUsage(victim), false);
  assert.equal(readFileSync(victim, 'utf8'), 'IMPORTANT USER DATA\n', 'reset must not clobber an unrelated file');
  // --force exists for an aggregate too corrupt to recognise, which is
  // exactly what reset is for.
  assert.equal(resetGhUsage(victim, { force: true }), true);
  assert.deepEqual(JSON.parse(readFileSync(victim, 'utf8')).counters, {});

  const asDir = join(dir, 'a-directory');
  mkdirSync(asDir);
  assert.equal(aggregateStatus(asDir), 'not-a-regular-file');
  assert.equal(resetGhUsage(asDir, { force: true }), false, 'not even --force may write over a directory');
  assert.equal(lstatSync(asDir).isDirectory(), true);

  const link = join(dir, 'link.json');
  symlinkSync(victim, link);
  assert.equal(aggregateStatus(link), 'not-a-regular-file', 'reset must not follow a symlink');

  const fresh = join(dir, 'fresh.json');
  assert.equal(aggregateStatus(fresh), 'ok');
  assert.equal(resetGhUsage(fresh), true);
});

// Each warning fires once per process, and these tests assert on them.
function armWarnings() {
  resetGhUsageWarnings();
  const seen = [];
  const original = console.warn;
  console.warn = (...args) => { seen.push(args.join(' ')); };
  return { seen, restore() { console.warn = original; } };
}

test('a lock dated in the future cannot pass as held forever', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  const lock = `${file}.lock`;
  writeFileSync(lock, '');
  // `age < LOCK_STALE_MS` alone is satisfied forever by a negative age, so one
  // touch stopped recording for good -- and silently, since the stale-lock
  // warning only fires when breaking a lock succeeds.
  const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 100);
  utimesSync(lock, future, future);

  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  const w = armWarnings();
  try {
    assert.equal(recordGhUsage({ client: 'codex', target: 'pr', operation: 'read', result: 'success' }), true);
  } finally { w.restore(); }
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).counters['codex\tpr\tread\tsuccess'], 1);
  assert.equal(existsSync(lock), false);
  assert.match(w.seen.join('\n'), /stale aggregate lock/);
});

test('a lock held right now is still respected', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  writeFileSync(`${file}.lock`, '');
  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  // Skipped without waiting, and without a warning: a concurrent writer is
  // normal, not a fault.
  const w = armWarnings();
  try {
    assert.equal(recordGhUsage({ client: 'codex', target: 'pr', operation: 'read', result: 'success' }), false);
  } finally { w.restore(); }
  assert.equal(existsSync(file), false);
  assert.deepEqual(w.seen, []);
});

test('an empty directory at the aggregate path is cleared instead of wedging recording', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  // rename(2) refuses to replace a directory, so this stopped recording for
  // good even after the lock and tmp paths learned to clear obstructions.
  // Only an EMPTY one is removed (rmdir) -- a non-empty directory is someone
  // else's data and is refused instead; see the test further down.
  mkdirSync(file);
  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  const w = armWarnings();
  try {
    assert.equal(recordGhUsage({ client: 'codex', target: 'pr', operation: 'read', result: 'success' }), true);
  } finally { w.restore(); }
  assert.equal(lstatSync(file).isFile(), true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).counters['codex\tpr\tread\tsuccess'], 1);
  assert.match(w.seen.join('\n'), /cleared an obstruction at the aggregate path/);
});

test('a non-empty directory obstruction is refused out loud, never deleted', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  const lock = `${file}.lock`;
  mkdirSync(lock);
  writeFileSync(join(lock, 'someone-elses-file'), 'DATA');
  const old = new Date(Date.now() - 600_000);
  utimesSync(lock, old, old);
  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  const w = armWarnings();
  try {
    // This module only ever writes regular files here, so a non-empty
    // directory is never its own work product -- it declines rather than
    // deleting it, but never in silence.
    assert.equal(recordGhUsage({ client: 'codex', target: 'pr', operation: 'read', result: 'success' }), false);
  } finally { w.restore(); }
  assert.equal(existsSync(lock), true, 'the obstruction must be kept, not deleted');
  assert.equal(readFileSync(join(lock, 'someone-elses-file'), 'utf8'), 'DATA');
  assert.match(w.seen.join('\n'), /not recording \(lock-stuck\)/);
});

test('readCapped never reads past the size it was given', () => {
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'big.json');
  writeFileSync(file, 'x'.repeat(5 * 1024 * 1024));
  // This is the fstat-then-read race in miniature: `size` is what fstat saw,
  // the file on disk is much larger. Reading to EOF (readFileSync(fd)) pulled
  // in the whole thing; the bound has to hold while reading, not before.
  const fd = openSync(file, 'r');
  try {
    assert.equal(readCapped(fd, 100), null, 'a file that grew past the checked size must be discarded');
  } finally { closeSync(fd); }

  const small = join(dir, 'small.json');
  writeFileSync(small, 'hello');
  const fd2 = openSync(small, 'r');
  try { assert.equal(readCapped(fd2, statSync(small).size), 'hello'); }
  finally { closeSync(fd2); }
});

test('an aggregate that outgrew the read cap is repairable with --force', () => {
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
  assert.equal(aggregateStatus(file), 'too-large');
  assert.equal(resetGhUsage(file), false, 'still not silently overwritten');
  assert.equal(resetGhUsage(file, { force: true }), true);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).counters, {});
});

test('a non-empty directory at the aggregate path is never recursively deleted', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'operator-data');
  // An operator typo -- or `enable --file <dir>`, which the CLI accepted with
  // exit 0 -- pointed the aggregate at a real directory. Clearing obstructions
  // with a recursive delete then destroyed its contents on the next gh call.
  mkdirSync(join(file, 'sub'), { recursive: true });
  writeFileSync(join(file, 'irreplaceable.txt'), 'YEARS OF WORK');
  writeFileSync(join(file, 'sub', 'more.txt'), 'x');
  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  const w = armWarnings();
  try {
    assert.equal(recordGhUsage({ client: 'codex', target: 'pr', operation: 'read', result: 'success' }), false);
  } finally { w.restore(); }
  assert.equal(lstatSync(file).isDirectory(), true, 'the directory must survive');
  assert.equal(readFileSync(join(file, 'irreplaceable.txt'), 'utf8'), 'YEARS OF WORK');
  assert.equal(readFileSync(join(file, 'sub', 'more.txt'), 'utf8'), 'x');
  assert.match(w.seen.join('\n'), /not recording \(aggregate-obstructed\)/);
});

test('a deep planted tree is declined immediately, not counted then deleted', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  const lock = `${file}.lock`;
  // The entry cap only ever counted the TOP level, so a handful of
  // directories holding thousands of files passed it and were all deleted
  // synchronously. rmdir cannot recurse, so depth stops mattering.
  mkdirSync(lock);
  for (let i = 0; i < 4; i++) {
    const sub = join(lock, `d${i}`);
    mkdirSync(sub);
    for (let j = 0; j < 300; j++) writeFileSync(join(sub, `f${j}`), '');
  }
  const old = new Date(Date.now() - 600_000);
  utimesSync(lock, old, old);
  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  const started = Date.now();
  assert.equal(recordGhUsage({ client: 'codex', target: 'pr', operation: 'read', result: 'success' }), false);
  const elapsed = Date.now() - started;
  assert.equal(existsSync(join(lock, 'd0', 'f0')), true, '1200 files must not have been deleted');
  assert.ok(elapsed < 500, `declining must be immediate, took ${elapsed}ms`);
});

test('repeatedly planting a stale lock warns once, not once per attempt', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  // The stale-lock notice reports a *successful* recovery, so it had been a
  // raw console.warn outside the once-per-reason funnel -- one touch per gh
  // call was enough to flood the broker's log.
  const w = armWarnings();
  try {
    for (let i = 0; i < 5; i++) {
      writeFileSync(`${file}.lock`, '');
      const old = new Date(Date.now() - 600_000);
      utimesSync(`${file}.lock`, old, old);
      assert.equal(recordGhUsage({ client: 'codex', target: 'pr', operation: 'read', result: 'success' }), true);
    }
  } finally { w.restore(); }
  assert.equal(w.seen.filter((l) => /stale aggregate lock/.test(l)).length, 1, w.seen.join('\n'));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).counters['codex\tpr\tread\tsuccess'], 5);
});

test('a lock held far longer than any writer holds one stops being silent', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  const lock = `${file}.lock`;
  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  const call = { client: 'codex', target: 'pr', operation: 'read', result: 'success' };
  // Stamp the lock with the clock the module sees, so shifting time below
  // models a lock being refreshed rather than one going stale.
  const keepFresh = () => { writeFileSync(lock, ''); const t = new Date(Date.now()); utimesSync(lock, t, t); };
  const w = armWarnings();
  const realNow = Date.now;
  try {
    keepFresh();
    // Ordinary contention is normal and must stay quiet...
    assert.equal(recordGhUsage(call), false);
    assert.deepEqual(w.seen, [], 'a genuinely held lock must not warn');
    // ...but a refreshed planted lock is indistinguishable from a live writer
    // at any single moment and differs only in how long it persists.
    Date.now = () => realNow() + 120_000;
    keepFresh();
    assert.equal(recordGhUsage(call), false);
  } finally { Date.now = realNow; w.restore(); }
  assert.match(w.seen.join('\n'), /not recording \(lock-held-too-long\)/);
});

test('a warning quotes the path so a crafted one cannot forge log lines', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const odd = join(dir, 'a\nb\u001b[31m');
  mkdirSync(odd);
  const file = join(odd, 'aggregate.json');
  mkdirSync(file);
  writeFileSync(join(file, 'keep'), 'x');
  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  const w = armWarnings();
  try { assert.equal(recordGhUsage({ client: 'codex', target: 'pr', operation: 'read', result: 'success' }), false); }
  finally { w.restore(); }
  const line = w.seen.find((l) => /aggregate-obstructed/.test(l));
  assert.ok(line, w.seen.join('\n'));
  assert.doesNotMatch(line, /\n/, 'a literal newline reached the log line');
  assert.doesNotMatch(line, /\u001b\[31m/, 'a raw escape sequence reached the log');
});

test('show diagnoses the file the reader actually read, symlinks included', () => {
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  const link = join(dir, 'link.json');
  writeFileSync(file, JSON.stringify({
    version: 1, startedOn: '2026-01-01', counters: { 'codex\tpr\tread\tsuccess': 1 },
  }));
  symlinkSync('aggregate.json', link);
  // The reader follows symlinks; aggregateStatus does not, because `reset`
  // must not clobber a link's target. Diagnosing with the latter made `show`
  // print the counts and then claim the file could not be read.
  assert.match(formatGhUsageReport(link), /count=1/);
  assert.equal(aggregateReadProblem(link), null, 'a link to a healthy aggregate reads fine');
  assert.equal(aggregateStatus(link), 'not-a-regular-file', 'reset must still refuse to follow it');

  assert.equal(aggregateReadProblem(join(dir, 'absent.json')), null, 'an absent aggregate is empty, not broken');
  writeFileSync(join(dir, 'junk.json'), 'not json at all');
  assert.equal(aggregateReadProblem(join(dir, 'junk.json')), 'not-an-aggregate');
  writeFileSync(join(dir, 'big.json'), 'x'.repeat(1024 * 1024 + 1));
  assert.equal(aggregateReadProblem(join(dir, 'big.json')), 'too-large');
  mkdirSync(join(dir, 'a-dir'));
  assert.equal(aggregateReadProblem(join(dir, 'a-dir')), 'not-a-regular-file');
});

test('a warning detail cannot split the log line either', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  // write-failed passes an errno message, which embeds the paths raw -- so
  // quoting only the `path` argument still let a crafted path break the line.
  const odd = join(dir, 'a\nb\u001b[31m');
  mkdirSync(odd);
  const file = join(odd, 'aggregate.json');
  mkdirSync(file);
  writeFileSync(join(file, 'keep'), 'x');
  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  const w = armWarnings();
  try { assert.equal(recordGhUsage({ client: 'codex', target: 'pr', operation: 'read', result: 'success' }), false); }
  finally { w.restore(); }
  assert.ok(w.seen.length > 0);
  for (const line of w.seen) {
    assert.doesNotMatch(line, /\n/, `a warning split across lines: ${JSON.stringify(line)}`);
    assert.doesNotMatch(line, /\u001b\[31m/, `a raw escape reached the log: ${JSON.stringify(line)}`);
  }
  assert.ok(w.seen.some((l) => /write-failed/.test(l)), 'the errno-detail warning is the one that used to split');
});

test('releasing a held lock periodically no longer hides the drops', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const file = join(dir, 'aggregate.json');
  const lock = `${file}.lock`;
  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  process.env.CCSERVER_GH_USAGE_RECORDING_FILE = file;
  const call = { client: 'codex', target: 'pr', operation: 'read', result: 'success' };
  const w = armWarnings();
  try {
    // The continuous-hold timer resets on every successful acquire, so
    // letting one call through now and then kept it from ever firing while
    // still dropping nearly everything. Sheer volume of drops is the other
    // tell, and it survives the release.
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 60; i++) {
        writeFileSync(lock, '');
        const t = new Date(Date.now());
        utimesSync(lock, t, t);
        assert.equal(recordGhUsage(call), false);
      }
      rmSync(lock, { force: true });
      assert.equal(recordGhUsage(call), true, 'the occasional let-through still works');
    }
  } finally { w.restore(); }
  assert.match(w.seen.join('\n'), /not recording \(lock-contended\)/, w.seen.join('\n') || '(no warnings)');
});

test('a warning for one aggregate does not silence another', () => {
  oldEnabled = process.env.CCSERVER_GH_USAGE_RECORDING;
  oldFile = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  dir = mkdtempSync(join(tmpdir(), 'ccserver-gh-usage-'));
  const call = { client: 'codex', target: 'pr', operation: 'read', result: 'success' };
  const paths = [join(dir, 'a'), join(dir, 'b')].map((d) => {
    mkdirSync(d);
    const f = join(d, 'aggregate.json');
    mkdirSync(f);
    writeFileSync(join(f, 'keep'), 'x');
    return f;
  });
  process.env.CCSERVER_GH_USAGE_RECORDING = '1';
  const w = armWarnings();
  try {
    for (const f of paths) {
      process.env.CCSERVER_GH_USAGE_RECORDING_FILE = f;
      assert.equal(recordGhUsage(call), false);
    }
  } finally { w.restore(); }
  // Keyed by reason alone, B's identical reason was suppressed by A's.
  for (const f of paths) {
    assert.ok(w.seen.some((l) => l.includes(JSON.stringify(f))), `no warning named ${f}: ${w.seen.join('\n')}`);
  }
});
