// Privacy-preserving, opt-in aggregate counters for gh-broker use.
//
// This module deliberately accepts only already-normalized categories.  It
// never receives argv, repository names, paths, command output, error text,
// account identifiers, or an event timestamp.  The on-disk file is a small
// aggregate, not an event log, and is never sent anywhere by ccserver.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const VERSION = 1;
const CLIENTS = new Set(['claude', 'codex', 'opencode', 'copilot', 'commandcode', 'shell']);
const TARGETS = new Set(['issue', 'pr', 'repository', 'workflow', 'release']);
const OPERATIONS = new Set(['read', 'create', 'edit', 'close', 'comment', 'workflow', 'release']);
const RESULTS = new Set(['success', 'cli-error', 'broker-unavailable', 'auth-error', 'timeout', 'cancelled']);
const DENIALS = new Set([
  'subcommand-not-allowed', 'ambiguous-flags', 'repo-unresolved', 'repo-must-be-explicit',
  'not-allowlisted', 'blocked-message', 'file-arg-requires-stdin', 'unrecognized-flag',
  'release-assets-not-allowed', 'release-download-dir-not-allowed', 'release-download-output-not-stdout',
  'workflow-field-file-not-allowed', 'attach-not-allowed', 'checkout-worktree-not-allowed',
  'bad-request', 'unauthorized', 'exec-failed', 'timeout',
]);

export function recordingPath() {
  const configured = process.env.CCSERVER_GH_USAGE_RECORDING_FILE;
  return configured && configured.trim() ? configured : null;
}

export function recordingEnabled() {
  // Keeping the enable switch in the child environment makes the default
  // unequivocally off even if an old/corrupt state file happens to exist.
  return process.env.CCSERVER_GH_USAGE_RECORDING === '1' && Boolean(recordingPath());
}

function today() { return new Date().toISOString().slice(0, 10); }
function emptyState() { return { version: VERSION, startedOn: today(), counters: {} }; }

function readState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && parsed.version === VERSION && typeof parsed.startedOn === 'string' && parsed.counters && typeof parsed.counters === 'object') return parsed;
  } catch { /* missing/corrupt data starts fresh; never expose its contents */ }
  return emptyState();
}

function withLock(path, fn) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 1000;
  let fd;
  while (Date.now() < deadline) {
    try { fd = openSync(lock, 'wx', 0o600); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
  }
  if (fd === undefined) return false; // observability must never block gh
  try { return fn(); } finally {
    try { closeSync(fd); } catch {}
    try { unlinkSync(lock); } catch {}
  }
}

function valid(value, set, fallback) { return set.has(value) ? value : fallback; }

export function recordGhUsage({ client, target, operation, result, denial } = {}) {
  if (!recordingEnabled()) return false;
  const path = recordingPath();
  const safeClient = valid(client, CLIENTS, 'shell');
  const safeTarget = valid(target, TARGETS, 'repository');
  const safeOperation = valid(operation, OPERATIONS, 'read');
  const safeResult = denial && DENIALS.has(denial) ? `broker-denied:${denial}` : valid(result, RESULTS, 'cli-error');
  return withLock(path, () => {
    const state = readState(path);
    const key = `${safeClient}\t${safeTarget}\t${safeOperation}\t${safeResult}`;
    state.counters[key] = (Number.isSafeInteger(state.counters[key]) ? state.counters[key] : 0) + 1;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  });
}

export function resetGhUsage(path) {
  return withLock(path, () => {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(emptyState())}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  });
}

export function formatGhUsageReport(path, { includePeriod = true } = {}) {
  const state = readState(path);
  const lines = ['ccserver-gh-usage-report: 1'];
  if (includePeriod) lines.push(`period: ${state.startedOn}..${today()}`);
  lines.push('recording: opted-in-local-aggregate', '');
  const rows = Object.entries(state.counters)
    .map(([key, count]) => [...key.split('\t'), count])
    .filter(([client, target, operation, result, count]) => CLIENTS.has(client) && TARGETS.has(target) && OPERATIONS.has(operation) && (RESULTS.has(result) || (result.startsWith('broker-denied:') && DENIALS.has(result.slice(14)))) && Number.isSafeInteger(count) && count > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [client, target, operation, result, count] of rows) {
    lines.push(`client=${client} sandbox=sandboxed broker=on`);
    lines.push(`  target=${target} operation=${operation} result=${result} count=${count}`);
  }
  return `${lines.join('\n')}\n`;
}

export function classifyGhUsage(argv) {
  const [top, sub] = Array.isArray(argv) ? argv : [];
  const target = ({ issue: 'issue', pr: 'pr', repo: 'repository', workflow: 'workflow', run: 'workflow', release: 'release' })[top] || 'repository';
  if (top === 'workflow' || top === 'run') return { target, operation: 'workflow' };
  if (top === 'release') return { target, operation: 'release' };
  const operation = ({ create: 'create', edit: 'edit', close: 'close', reopen: 'close', comment: 'comment', review: 'comment' })[sub] || 'read';
  return { target, operation };
}

export function defaultRecordingPath(configPath) {
  return join(dirname(configPath), 'gh-usage-recording.json');
}

export function stateFileExists(path) { return existsSync(path); }
