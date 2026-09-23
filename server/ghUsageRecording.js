// Privacy-preserving, opt-in aggregate counters for gh-broker use.
//
// This module deliberately accepts only already-normalized categories.  It
// never receives argv, repository names, paths, command output, error text,
// account identifiers, or an event timestamp.  The on-disk file is a small
// aggregate, not an event log, and is never sent anywhere by ccserver.
//
// Scope of the hardening below: it keeps a hostile *file* from harming the
// broker or the operator -- no blocking reads, no crash, no unbounded growth,
// no escape sequences or planted text reaching a report, no lock or tmp path
// that can silence recording.  It is NOT integrity protection: the aggregate
// is unauthenticated, so anyone who can write it can forge counts within the
// fixed categories.  Keeping the file where sessions cannot write it is the
// only thing that makes the numbers trustworthy (see docs-site
// sandbox/configuration.md).
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const VERSION = 1;
// startedOn is the only free-form string a report ever prints. It must look
// like a plain date so a tampered/corrupt aggregate can never inject extra
// lines into `show` output (see readState).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A lock older than this is considered abandoned (crashed writer) or planted
// to suppress recording, and is broken on the next attempt (see tryLock).
const LOCK_STALE_MS = 30_000;
// The aggregate is bounded by construction (a few thousand fixed-category
// rows at most), so anything larger is corrupt or planted and is not read.
const MAX_AGGREGATE_BYTES = 1024 * 1024;
const CLIENTS = new Set(['claude', 'codex', 'opencode', 'copilot', 'commandcode', 'shell']);
const TARGETS = new Set(['issue', 'pr', 'repository', 'workflow', 'release']);
const OPERATIONS = new Set(['read', 'create', 'edit', 'close', 'comment', 'workflow', 'release']);
const RESULTS = new Set(['success', 'cli-error', 'broker-unavailable', 'auth-error', 'timeout', 'cancelled']);
const DENIED_PREFIX = 'broker-denied:';
const DENIALS = new Set([
  'subcommand-not-allowed', 'ambiguous-flags', 'repo-unresolved', 'repo-must-be-explicit',
  'not-allowlisted', 'blocked-message', 'file-arg-requires-stdin', 'unrecognized-flag',
  'release-assets-not-allowed', 'release-download-dir-not-allowed', 'release-download-output-not-stdout',
  'workflow-field-file-not-allowed', 'attach-not-allowed', 'checkout-worktree-not-allowed',
  'bad-request', 'unauthorized', 'exec-failed', 'timeout',
]);

export function recordingPath() {
  // Trim what we return, not just what we test: a config value padded with
  // whitespace would otherwise name a literally space-padded path.
  const configured = (process.env.CCSERVER_GH_USAGE_RECORDING_FILE || '').trim();
  return configured || null;
}

export function recordingEnabled() {
  // Keeping the enable switch in the child environment makes the default
  // unequivocally off even if an old/corrupt state file happens to exist.
  return process.env.CCSERVER_GH_USAGE_RECORDING === '1' && Boolean(recordingPath());
}

// Local calendar date, not toISOString()'s UTC one: this is a report an
// operator reads next to their own clock, and in e.g. JST the UTC date is a
// day behind for the first nine hours of every day.
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function emptyState() { return { version: VERSION, startedOn: today(), counters: {} }; }

// The single definition of a well-formed row, shared by readState (what may
// be kept on disk) and formatGhUsageReport (what may be printed) so the two
// can never drift. A key is exactly four tab-separated fixed categories; a
// key with a different field count would also mis-align the tuple the report
// destructures (a 3-field key shifted `count` into `result`, and printing
// then threw on result.startsWith).
function validRow(key, count) {
  const parts = key.split('\t');
  if (parts.length !== 4) return false;
  const [client, target, operation, result] = parts;
  return CLIENTS.has(client) && TARGETS.has(target) && OPERATIONS.has(operation)
    && (RESULTS.has(result) || (result.startsWith(DENIED_PREFIX) && DENIALS.has(result.slice(DENIED_PREFIX.length))))
    && Number.isSafeInteger(count) && count > 0;
}

// Open `path` only if it is a regular file, and never block doing so.
// readFileSync assumed a regular file: on a FIFO planted at the aggregate
// path, read(2) blocked until a writer showed up, freezing the broker's event
// loop so completely that its SIGTERM handler could not run -- session
// teardown then left an orphan broker and socket behind, and every later gh
// call in that session hung. O_NONBLOCK makes open(2) return immediately for
// a FIFO, and fstat on the descriptor we already hold (not a separate lstat,
// which a symlink swap could race) rules out FIFOs, devices and directories.
function openRegularFile(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch { return null; }
  try {
    const st = fstatSync(fd);
    if (st.isFile() && st.size <= MAX_AGGREGATE_BYTES) return fd;
  } catch { /* fall through to close */ }
  try { closeSync(fd); } catch {}
  return null;
}

function readState(path) {
  const fd = openRegularFile(path);
  // Not a readable regular file: start fresh rather than read it. The next
  // writeState renames over whatever is there, so a planted FIFO/symlink is
  // replaced by a real aggregate instead of stopping recording for good.
  if (fd === null) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(fd, 'utf8'));
    // `typeof [] === 'object'` too, and JSON.stringify drops the string
    // properties an increment adds to an array -- so a one-byte tamper
    // ("counters": []) would silently swallow every future increment while
    // recordGhUsage still reported success. Require a plain object.
    if (parsed && parsed.version === VERSION && isPlainObject(parsed.counters)) {
      // startedOn is printed verbatim: never trust it from disk. Falling back
      // to today() also normalizes a tampered file on the next write.
      const startedOn = typeof parsed.startedOn === 'string' && DATE_RE.test(parsed.startedOn) ? parsed.startedOn : today();
      // Rebuild rather than spread `parsed`: spreading carried arbitrary
      // top-level keys and malformed counter rows from a tampered/corrupt
      // file straight back into the next writeState, so the "fixed categories
      // only" file an operator is invited to share could hold planted text
      // forever (and grow without bound).
      const counters = {};
      for (const [key, count] of Object.entries(parsed.counters)) {
        if (validRow(key, count)) counters[key] = count;
      }
      return { version: VERSION, startedOn, counters };
    }
  } catch { /* missing/corrupt data starts fresh; never expose its contents */ }
  finally { try { closeSync(fd); } catch {} }
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
// Recovery itself can fail (an unwritable directory, or an obstruction we
// could not clear). Say so once: silence here is indistinguishable from
// "nothing to record", which is what made a planted lock such an effective
// way to stop recording unnoticed.
let warnedLockStuck = false;
function warnLockStuck(lock) {
  if (warnedLockStuck) return;
  warnedLockStuck = true;
  console.warn(`[gh-usage] cannot acquire or clear the aggregate lock (${lock}); recording is stopped until it is removed by hand`);
}

function createLock(lock) {
  try {
    const fd = openSync(lock, 'wx', 0o600);
    try { closeSync(fd); } catch {}
    return true;
  } catch { return false; }
}

// unlink(2) cannot remove a directory (EISDIR), so a directory planted at the
// lock or tmp path defeated stale-lock recovery outright and silenced
// recording permanently -- precisely the attack the mtime check exists to
// stop. Fall back to rmSync for that case. The path is always our own
// `<aggregate>.lock` / `.<pid>.tmp` sibling, never operator data, and unlink
// already removes a symlink without following it.
function removeObstruction(p) {
  try { unlinkSync(p); return true; }
  catch (e) { if (e.code === 'ENOENT') return true; }
  try { rmSync(p, { recursive: true, force: true }); return true; }
  catch { return false; }
}

function tryLock(lock) {
  if (createLock(lock)) return true;
  let st;
  try { st = lstatSync(lock); }
  catch { return createLock(lock); } // it vanished, or never existed (not EEXIST)
  // A lock that is not a regular file was never written by us, so it is an
  // obstruction whatever its mtime says.
  if (st.isFile() && Date.now() - st.mtimeMs < LOCK_STALE_MS) return false;
  if (!removeObstruction(lock) || !createLock(lock)) {
    warnLockStuck(lock);
    return false;
  }
  warnStaleLock(lock);
  return true;
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
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

function writeState(path, state) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    // 'wx' (O_CREAT|O_EXCL) never opens an existing path, so a symlink
    // planted at the tmp name cannot redirect this write to another file
    // (the previous plain writeFileSync followed such a symlink)...
    // ...and clear a leftover tmp from a crashed writer first: it is ours by
    // pid, and leaving it would block this process's recording forever. A
    // planted *directory* here could not be unlinked at all, which is why
    // this goes through removeObstruction rather than a bare unlink.
    removeObstruction(tmp);
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    removeObstruction(tmp);
    throw e;
  }
}

export function recordGhUsage({ client, target, operation, result, denial } = {}) {
  if (!recordingEnabled()) return false;
  const path = recordingPath();
  const safeClient = valid(client, CLIENTS, 'shell');
  const safeTarget = valid(target, TARGETS, 'repository');
  const safeOperation = valid(operation, OPERATIONS, 'read');
  const safeResult = denial && DENIALS.has(denial) ? `${DENIED_PREFIX}${denial}` : valid(result, RESULTS, 'cli-error');
  return withLock(path, () => {
    const state = readState(path);
    const key = `${safeClient}\t${safeTarget}\t${safeOperation}\t${safeResult}`;
    state.counters[key] = (Number.isSafeInteger(state.counters[key]) ? state.counters[key] : 0) + 1;
    writeState(path, state);
    return true;
  });
}

// What `reset` may replace. It creates or overwrites its target outright, so
// a mistyped --file used to silently turn an operator's unrelated file into
// aggregate JSON. Absent or an existing aggregate is always fine; a
// directory, FIFO, device or symlink is never written; and any other regular
// file needs --force, which also covers the one legitimate case this cannot
// recognise -- an aggregate too corrupt to parse, i.e. exactly what `reset`
// exists to repair. lstat, not stat: a symlink is not something to follow and
// clobber.
export function resetTargetStatus(path) {
  let st;
  try { st = lstatSync(path); }
  catch (e) { return e.code === 'ENOENT' ? 'ok' : 'unreadable'; }
  if (!st.isFile()) return 'not-a-regular-file';
  const fd = openRegularFile(path);
  if (fd === null) return 'unreadable';
  try {
    const parsed = JSON.parse(readFileSync(fd, 'utf8'));
    if (parsed && parsed.version === VERSION && isPlainObject(parsed.counters)) return 'ok';
  } catch { /* unparseable: not recognisably ours */ }
  finally { try { closeSync(fd); } catch {} }
  return 'not-an-aggregate';
}

// recordGhUsage deliberately runs no such check: its rename replaces a
// planted FIFO/symlink and restores recording, whereas refusing would let one
// stop recording for good.
export function resetGhUsage(path, { force = false } = {}) {
  const status = resetTargetStatus(path);
  if (status !== 'ok' && !(force && status === 'not-an-aggregate')) return false;
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
    .filter(([key, count]) => validRow(key, count))
    // Order on the whole key with a plain codepoint compare: sorting on the
    // client alone left same-client rows in JSON key order, and localeCompare
    // made a shared report depend on the host's locale.
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, count]) => [...key.split('\t'), count]);
  let openClient = null;
  for (const [client, target, operation, result, count] of rows) {
    // One header per client with its rows indented under it -- the sample
    // output in docs-site sandbox/configuration.md, not a header per row.
    if (client !== openClient) {
      openClient = client;
      lines.push(`client=${client} sandbox=sandboxed broker=on`);
    }
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

