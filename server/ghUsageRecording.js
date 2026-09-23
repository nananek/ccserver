// Privacy-preserving, opt-in aggregate counters for gh-broker use.
//
// This module deliberately accepts only already-normalized categories.  It
// never receives argv, repository names, paths, command output, error text,
// account identifiers, or an event timestamp.  The on-disk file is a small
// aggregate, not an event log, and is never sent anywhere by ccserver.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const VERSION = 1;
// startedOn is the only free-form string a report ever prints. It must look
// like a plain date so a tampered/corrupt aggregate can never inject extra
// lines into `show` output (see readState).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A lock older than this is considered abandoned (crashed writer) or planted
// to suppress recording, and is broken on the next attempt (see tryLock).
const LOCK_STALE_MS = 30_000;
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
    if (parsed && parsed.version === VERSION && parsed.counters && typeof parsed.counters === 'object') {
      // Counters are validated again at print time (fixed categories), but
      // startedOn is printed verbatim: never trust it from disk. Falling back
      // to today() also normalizes a tampered file on the next write.
      const startedOn = typeof parsed.startedOn === 'string' && DATE_RE.test(parsed.startedOn) ? parsed.startedOn : today();
      return { ...parsed, startedOn };
    }
  } catch { /* missing/corrupt data starts fresh; never expose its contents */ }
  return emptyState();
}

// Best-effort, single-attempt lock. Recording is observability, so it must
// never delay a gh call: an earlier draft busy-waited up to 1s on contention,
// which a planted lock turned into +1s on every gh call. A stale lock
// (crashed writer, or one planted to suppress recording) is broken by mtime
// so it cannot silence recording forever. The atomic rename in writeState is
// what actually protects the file; the lock only avoids lost increments.
let warnedStaleLock = false;
function warnStaleLock(lock) {
  if (warnedStaleLock) return;
  warnedStaleLock = true;
  console.warn(`[gh-usage] removed a stale aggregate lock (${lock}); a previous writer may have crashed or the aggregate may be under attack`);
}

function tryLock(lock) {
  try {
    const fd = openSync(lock, 'wx', 0o600);
    try { closeSync(fd); } catch {}
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') return false;
  }
  try {
    if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return false;
    unlinkSync(lock);
    const fd = openSync(lock, 'wx', 0o600);
    try { closeSync(fd); } catch {}
    warnStaleLock(lock);
    return true;
  } catch {
    return false;
  }
}

function withLock(path, fn) {
  const lock = `${path}.lock`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    return false; // observability must never block gh
  }
  if (!tryLock(lock)) return false; // another writer holds it (or it cannot be created); never wait
  try { return fn(); }
  catch { return false; } // an unwritable/full aggregate must never fail the gh call
  finally {
    try { unlinkSync(lock); } catch {}
  }
}

function valid(value, set, fallback) { return set.has(value) ? value : fallback; }

function writeState(path, state) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    // 'wx' (O_CREAT|O_EXCL) never opens an existing path, so a symlink
    // planted at the tmp name cannot redirect this write to another file
    // (the previous plain writeFileSync followed such a symlink). Remove a
    // leftover tmp from a crashed writer first: it is ours by pid, and
    // leaving it would block this process's recording forever.
    try { unlinkSync(tmp); } catch {}
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

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
    writeState(path, state);
    return true;
  });
}

export function resetGhUsage(path) {
  return withLock(path, () => {
    writeState(path, emptyState());
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
  const operation = ({
    create: 'create', edit: 'edit', close: 'close', reopen: 'close',
    // `pr merge` closes the PR and `pr ready` flips its draft state -- both
    // mutate, so neither may fall through to the read default.
    merge: 'close', ready: 'edit',
    comment: 'comment', review: 'comment',
  })[sub] || 'read';
  return { target, operation };
}

export function defaultRecordingPath(configPath) {
  return join(dirname(configPath), 'gh-usage-recording.json');
}

export function stateFileExists(path) { return existsSync(path); }
