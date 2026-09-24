// Privacy-preserving, opt-in aggregate counters for gh-broker use.
//
// This module deliberately accepts only already-normalized categories.  It
// never receives argv, repository names, paths, command output, error text,
// account identifiers, or an event timestamp.  The on-disk file is a small
// aggregate, not an event log, and is never sent anywhere by ccserver.
//
// Scope of the hardening below: it keeps a hostile *file* from harming the
// broker or the operator -- no blocking reads, no crash, no unbounded growth,
// no escape sequences or planted text reaching a report, and no path this
// module owns (the aggregate, its lock, its tmp) that can silence recording.
// Where recording is abandoned anyway, it says so on the broker's log rather
// than stopping quietly, because a silent stop is indistinguishable from
// "nothing to record" and is what every round of this has been about.  It is NOT integrity protection: the aggregate
// is unauthenticated, so anyone who can write it can forge counts within the
// fixed categories.  Keeping the file where sessions cannot write it is the
// only thing that makes the numbers trustworthy (see docs-site
// sandbox/configuration.md).
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
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
// A lock whose mtime is further ahead than this cannot belong to a live
// writer, whatever the clock says (see tryLock).
const CLOCK_SKEW_MS = 5_000;
// A warning repeats at most this often per reason. Once-per-process kept a
// flood out of the log but also meant a fault an operator missed went quiet
// forever; an hourly reminder is still 24 lines a day at worst.
const WARN_REPEAT_MS = 60 * 60 * 1000;
// A lock genuinely held by a concurrent writer is released in well under a
// millisecond. Being blocked by one for this long is not contention -- it is
// someone refreshing a planted lock, which is otherwise indistinguishable
// from a live writer and therefore silent (see tryLock).
const HELD_LOCK_STUCK_MS = 60_000;
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

// Every path that abandons a write goes through here. Recording that stops
// silently is indistinguishable from "nothing to record": gh keeps working,
// `show` keeps printing "opted-in", and the operator never learns the counts
// went stale. Successive reviews each found another way to stop recording
// quietly -- a held lock, a planted directory, an impossible mtime -- so
// making failure observable is structural rather than per-case. One warning
// per distinct reason keeps a hot path from becoming a log flood while
// guaranteeing a wedged aggregate is never invisible.
const warnedReasons = new Map(); // reason -> last warned at (ms)
// Quote the path: a warning goes to the broker's log, and a configured path
// can contain newlines or escape sequences. The CLI already does this for the
// paths it prints; the log had been left raw.
function q(path) { return JSON.stringify(String(path)); }
// Every warning in this module goes through here, including the ones that
// report a *successful* recovery -- those had been raw console.warn calls and
// so escaped the once-per-reason rule entirely, which let a planted stale lock
// produce a warning per gh call.
function warnOnce(reason, message, now = Date.now()) {
  const last = warnedReasons.get(reason);
  if (last !== undefined && now - last < WARN_REPEAT_MS) return false;
  warnedReasons.set(reason, now);
  console.warn(`[gh-usage] ${message}`);
  return true;
}
function abandon(reason, path, detail = '') {
  warnOnce(reason, `not recording (${reason}) at ${q(path)}${detail ? `: ${detail}` : ''}; counts are incomplete until this is resolved`);
  return false;
}
// Exported for tests: warnings are rate-limited per process, so a test that
// asserts on one has to be able to arm it again.
export function resetGhUsageWarnings() { warnedReasons.clear(); }

// The three paths this module owns: the aggregate itself, `<aggregate>.lock`
// and `<aggregate>.<pid>.tmp`. Anything sitting at one of them that is not the
// regular file we expect -- a directory, FIFO, device or symlink -- is an
// obstruction, and clearing it is the same operation whatever its type. That
// uniformity is the point: fixing only the types named in the last report is
// what left a directory at the aggregate path working as a silent kill switch
// after the lock and tmp paths had been dealt with.
//
// unlink(2) removes files, symlinks, FIFOs and devices, and removes a symlink
// without following it. It cannot remove a directory (EISDIR), and the only
// other thing tried here is rmdir(2), which removes an EMPTY directory and
// nothing else.
//
// Deliberately NOT a recursive delete. An earlier version of this reached for
// rmSync({recursive:true}) so that "clear an obstruction" would work for every
// file type, which turned these paths into a delete primitive rooted at an
// operator-configured path: pointing `file` at a real directory (a typo, or
// `enable --file <dir>`, which the CLI accepted) destroyed its contents on the
// next gh call. It was also not actually bounded -- the entry cap counted only
// the top level, so eight directories holding 64k files still deleted all of
// them synchronously.
//
// The uniformity that matters is that every obstruction takes the SAME PATH,
// not that every obstruction gets deleted. This module only ever creates
// regular files at these three paths, so a non-empty directory is never its
// own work product and never something it should remove. Declining and saying
// so satisfies the rule that recording must not stop silently, which is what
// the recursive delete was reaching for.
function clearObstruction(path) {
  try { unlinkSync(path); return true; }
  catch (e) { if (e.code === 'ENOENT') return true; }
  try { rmdirSync(path); return true; }
  catch { return false; }
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
    if (st.isFile() && st.size <= MAX_AGGREGATE_BYTES) return { fd, size: st.size };
  } catch { /* fall through to close */ }
  try { closeSync(fd); } catch {}
  return null;
}

// Read at most the number of bytes fstat just reported, and never more than
// the cap. readFileSync(fd) read to EOF instead, so the size check was only
// ever a snapshot: a concurrent writer that shrank the file, let the fstat
// pass, then grew it again had the broker read the whole thing -- hundreds of
// MB of RSS and a single gh call stalled for hundreds of ms, against a module
// that promises neither. Enforcing the bound *while* reading, on the same
// descriptor that was measured, closes that by construction rather than by
// narrowing a window. One extra byte distinguishes "exactly `size`" from
// "grew under us", which is discarded.
export function readCapped(fd, size) {
  const cap = Math.min(size, MAX_AGGREGATE_BYTES);
  const buf = Buffer.allocUnsafe(cap + 1);
  let len = 0;
  while (len < buf.length) {
    let n;
    try { n = readSync(fd, buf, len, buf.length - len, null); }
    catch { return null; }
    if (n === 0) break;
    len += n;
  }
  if (len > cap) return null; // it grew past what we verified
  return buf.toString('utf8', 0, len);
}

function readState(path) {
  const opened = openRegularFile(path);
  // Not a readable regular file: start fresh rather than read it. The next
  // writeState renames over whatever is there, so a planted FIFO/symlink is
  // replaced by a real aggregate instead of stopping recording for good.
  if (opened === null) return emptyState();
  const { fd, size } = opened;
  try {
    const text = readCapped(fd, size);
    if (text === null) return emptyState();
    const parsed = JSON.parse(text);
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
function createLock(lock) {
  try {
    const fd = openSync(lock, 'wx', 0o600);
    try { closeSync(fd); } catch {}
    return true;
  } catch { return false; }
}

// A lock is only "held by a live writer" for a bounded interval that has
// actually begun. Testing `age < LOCK_STALE_MS` alone treated a lock dated in
// the future as perpetually fresh, so one `touch -d '+100 years'` stopped
// recording for good -- silently, since the stale-lock warning only fires when
// breaking one succeeds. A small skew allowance tolerates real clock and
// filesystem jitter; beyond it, no live writer could have produced the mtime.
function lockIsHeld(st) {
  if (!st.isFile()) return false; // never written by us: an obstruction, not a lock
  const age = Date.now() - st.mtimeMs;
  return age >= -CLOCK_SKEW_MS && age < LOCK_STALE_MS;
}

// When the lock has been "held" continuously since this moment, it is no
// longer plausible contention. Cleared every time the lock is actually taken.
let heldSince = 0;

function tryLock(lock) {
  if (createLock(lock)) { heldSince = 0; return true; }
  let st;
  try { st = lstatSync(lock); }
  catch { // vanished, or the failure was never EEXIST
    if (createLock(lock)) { heldSince = 0; return true; }
    return abandon('lock-unavailable', lock);
  }
  if (lockIsHeld(st)) {
    // A real concurrent writer holds the lock for microseconds, so skipping
    // this increment is normal and stays silent. Someone refreshing a planted
    // lock looks identical at any single moment and differs only in duration
    // -- which is the one thing that can be checked, so that the "held" branch
    // cannot be a silent kill switch (it was, until this).
    const now = Date.now();
    if (!heldSince) heldSince = now;
    else if (now - heldSince >= HELD_LOCK_STUCK_MS) {
      abandon('lock-held-too-long', lock,
        `it has been locked for ${Math.round((now - heldSince) / 1000)}s, far longer than a writer holds it; remove it by hand`);
    }
    return false;
  }
  if (!clearObstruction(lock) || !createLock(lock)) {
    return abandon('lock-stuck', lock,
      'it is not a file this module wrote and could not be removed (a non-empty directory is never removed); remove it by hand');
  }
  heldSince = 0;
  warnOnce('stale-lock-removed',
    `removed a stale aggregate lock (${q(lock)}); a previous writer may have crashed or the aggregate may be under attack`);
  return true;
}

function withLock(path, fn) {
  const lock = `${path}.lock`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch (e) {
    return abandon('directory-unusable', dirname(path), e.message); // observability must never block gh
  }
  if (!tryLock(lock)) return false; // tryLock has already reported anything worth reporting
  try { return fn(); }
  catch (e) { return abandon('write-failed', path, e.message); } // an unwritable/full aggregate must never fail the gh call
  finally {
    try { unlinkSync(lock); } catch {}
  }
}

function valid(value, set, fallback) { return set.has(value) ? value : fallback; }
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

// rename(2) replaces a regular file, a symlink, a FIFO or a device, but
// refuses to replace a directory (EISDIR/ENOTDIR/EEXIST/ENOTEMPTY). A
// directory planted at the aggregate path therefore stopped recording for
// good even after the lock and tmp paths learned to clear obstructions --
// the same silent kill switch, one path over. Treat the destination like the
// other two paths we own: clear it and retry once.
function renameOnto(tmp, path) {
  try { renameSync(tmp, path); return; }
  catch (e) {
    if (!['EISDIR', 'ENOTDIR', 'EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e;
    if (!clearObstruction(path)) {
      abandon('aggregate-obstructed', path,
        'something that is not a file is in the way and was not removed (a non-empty directory is never removed); move it aside by hand');
      throw e;
    }
    warnOnce('aggregate-obstruction-cleared',
      `cleared an obstruction at the aggregate path (${q(path)}); it was not a regular file`);
  }
  renameSync(tmp, path);
}

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
    clearObstruction(tmp);
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 });
    renameOnto(tmp, path);
  } catch (e) {
    clearObstruction(tmp);
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

// What is actually sitting at an aggregate path. Used by `reset` to decide
// what it may replace and by `show` to tell "nothing recorded yet" apart from
// "could not be read" -- an empty report is the same either way, which left
// an operator with a broken aggregate believing it was merely idle.
//
// For `reset`: absent or an existing aggregate is always fine; a directory,
// FIFO, device or symlink is never written; and any other regular file needs
// --force, which also covers the one legitimate case this cannot recognise --
// an aggregate too corrupt to parse, i.e. exactly what `reset` exists to
// repair. lstat, not stat: a symlink is not something to follow and clobber.
export function aggregateStatus(path) {
  let st;
  try { st = lstatSync(path); }
  catch (e) { return e.code === 'ENOENT' ? 'ok' : 'unreadable'; }
  if (!st.isFile()) return 'not-a-regular-file';
  // Distinct from 'unreadable', and forceable: an aggregate grown past the
  // read cap (by corruption or on purpose) used to fall into 'unreadable',
  // which --force did not cover -- so `reset`, whose whole job is repairing
  // an aggregate too damaged to parse, could not repair this one.
  if (st.size > MAX_AGGREGATE_BYTES) return 'too-large';
  const opened = openRegularFile(path);
  if (opened === null) return 'unreadable';
  try {
    const text = readCapped(opened.fd, opened.size);
    const parsed = text === null ? null : JSON.parse(text);
    if (parsed && parsed.version === VERSION && isPlainObject(parsed.counters)) return 'ok';
  } catch { /* unparseable: not recognisably ours */ }
  finally { try { closeSync(opened.fd); } catch {} }
  return 'not-an-aggregate';
}

// Statuses `--force` may override. A directory/FIFO/device/symlink is never
// one of them: the recorder clears an obstruction at its own configured
// aggregate path, but `reset --file` takes an operator-typed path, where a
// typo naming a real directory must not become a recursive delete.
const FORCEABLE = new Set(['not-an-aggregate', 'too-large']);

// recordGhUsage deliberately runs no such check: its rename replaces a
// planted FIFO/symlink and restores recording, whereas refusing would let one
// stop recording for good.
export function resetGhUsage(path, { force = false } = {}) {
  const status = aggregateStatus(path);
  if (status !== 'ok' && !(force && FORCEABLE.has(status))) return false;
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

