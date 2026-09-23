import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyGhUsage, formatGhUsageReport, recordGhUsage, resetGhUsage } from './ghUsageRecording.js';

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
