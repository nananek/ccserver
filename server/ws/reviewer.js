// ccserver-reviewer (issue #102): on-demand disposable code review jobs.
//
// A `run_review` MCP call launches a throwaway headless session against a
// FRESH git worktree -- never the caller's own cwd or an existing combo
// worktree -- and drives it through /code-review. It is entirely independent
// of orchestration groups: any session (worker, orchestrator, or standalone)
// may ask for a review of any local ref/branch/PR/uncommitted diff.
//
// Process-wide concept (NOT group-scoped, like ccserver-notify/-usage): one
// Unix socket hosts it for the whole server process
// (${XDG_RUNTIME_DIR}/ccserver-reviewer.sock, see getReviewerSockPath). Each
// reviewer-enabled session's sandbox binds that one socket in; the MCP
// config tells the agent to reach it through the same bridge wrapper as the
// other process-global servers (see mcpConfig.js / sandbox-mcp-wrapper.cjs).
// Opt-in via sandbox.config.json's "reviewerMcp" (default false, like
// usageMcp/metaAgentMcp) -- this spawns real sandboxed sessions on any
// caller's say-so, so it must not exist by accident.
//
// Worktree design (deliberately NOT worktree.js's resolveMemberWorktree,
// see the issue-#102 plan): that resolver is role-scoped (one slot per
// (projectCwd, role), reused idempotently) and has no way to check out an
// arbitrary ref -- both wrong for a job system that runs many concurrent,
// disposable reviews. Instead each job gets its own throwaway detached
// worktree under a separate root:
//   ~/.local/share/ccserver-sandbox/review-worktrees/<projectHash>/<jobId>/
// removed unconditionally (git worktree remove --force, then rmSync) once
// the job finishes -- unlike worktree.js's removeMemberWorktree, there is no
// "never destroy uncommitted agent work" concern here: nothing but this
// module ever writes into a review worktree before the session starts.
//
// Uncommitted (dirty) changes are captured as a patch (`git diff HEAD` +
// untracked files diffed against /dev/null) and `git apply`'d onto the
// worktree, rather than pointing the session at the live project directory:
// the caller's directory can keep changing while the review runs, and two
// sessions opening the same cwd risks agent-CLI lock/state collisions.
//
// Job persistence is SQLite (pr_reviews, db.js v6) rather than a JSON
// sidecar: unlike the in-memory-mirrored stores (.scheduled-prompts.json,
// .saved-notifications.json), review jobs accumulate and need id/status/
// project lookups -- see db.js's header comment on why stores like that go
// straight into the DB.
//
// This module imports sessionManager.js and routes/sessions.js LAZILY
// (dynamic import inside runReview/the completion watcher), mirroring
// metaAgent.js: the static import graph stays acyclic (sessionManager.js
// statically imports this module's injection-decision exports below, so
// this module must never statically import sessionManager.js back).

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { getDb } from '../db.js';
import { projectHashForCwd } from './projectHash.js';
import { loadSandboxConfig, persistentHomeDir, deleteSandboxHome } from './sandbox.js';
import { stripAnsi } from './mcpTools.js';

const REVIEWER_SOCKET_NAME = 'ccserver-reviewer.sock';

const VALID_APPS = ['claude', 'opencode', 'codex'];
const DEFAULT_APP = 'claude';

// Completion-detection thresholds (see the header comment / issue-#102 plan
// section 8: these are starting values, not measured -- /code-review's real
// runtime, especially with a slow model or a large diff, may need a longer
// idle/absolute window than this).
const SETTLE_TIMEOUT_MS = 15 * 1000; // waitUntilSettled cap before typing the prompt
const MIN_RUNTIME_MS = 30 * 1000; // never call a job done before this, even if idle
const IDLE_DONE_MS = 60 * 1000; // screen idle this long -> assume /code-review finished
const ABSOLUTE_TIMEOUT_MS = 20 * 60 * 1000; // safety-net hard stop
const POLL_INTERVAL_MS = 5 * 1000;
const SUMMARY_MAX_CHARS = 4000;
const GH_PR_VIEW_TIMEOUT_MS = 15 * 1000;

let reviewerBroker = null; // { server, sockPath, dir, connections } | null
let stopBrokerFn = null;

export function getReviewerSockPath() {
  const base = process.env.XDG_RUNTIME_DIR
    || (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : '/tmp');
  return join(base, REVIEWER_SOCKET_NAME);
}

// Whether the reviewer feature is on at all: an explicit opt-in flag in
// sandbox.config.json (default false), like usageMcp/metaAgentMcp.
export function reviewerEnabled() {
  return loadSandboxConfig().reviewerMcp === true;
}

// Pure injection decision for createSession. Unlike notify (orchestrator
// only), any session may ask for a review -- workers included (issue #102
// consensus point 4: callable regardless of whether a group exists). Only
// shells (no MCP at all) and copilot (no CLI-arg/env MCP injection) are
// excluded.
export function shouldInjectReviewer({ shell, app, reviewerEnabled }) {
  return !shell && app != null && app !== 'copilot' && !!reviewerEnabled;
}

export function reviewerBrokerRunning() {
  return !!reviewerBroker;
}

// --- worktree management ----------------------------------------------------

export function reviewWorktreeRoot() {
  return process.env.CCSERVER_REVIEW_WORKTREE_ROOT
    || join(homedir(), '.local', 'share', 'ccserver-sandbox', 'review-worktrees');
}

export function reviewWorktreePath(projectCwd, jobId) {
  return join(reviewWorktreeRoot(), projectHashForCwd(projectCwd), jobId);
}

// stderr is piped (not inherited), mirroring worktree.js's git() helper: a
// routine failure (bad ref, no origin remote) produces expected stderr
// chatter that would otherwise look like a real server error in the logs.
function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isGitRepo(cwd) {
  if (!isDirectory(cwd)) return false;
  try {
    return git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

// origin/HEAD (the remote's default branch, set by `git remote set-head` /
// a clone) when known locally, else the current branch, else 'HEAD' itself
// (detached project checkout) -- best-effort default for an omitted baseRef.
function resolveDefaultBaseRef(projectCwd) {
  try {
    const ref = git(projectCwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).trim();
    if (ref) return ref;
  } catch { /* origin/HEAD not recorded locally */ }
  try {
    const branch = git(projectCwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
    if (branch) return branch;
  } catch { /* detached HEAD */ }
  return 'HEAD';
}

function resolveRepoOwnerRepo(cwd) {
  let url;
  try {
    url = git(cwd, ['remote', 'get-url', 'origin']).trim();
  } catch {
    return null;
  }
  const m = /(?:github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Creates a disposable detached worktree for one review job, checked out at
// `ref` (resolved on the PROJECT repo, so it must already exist there). PR
// mode checks out the actual PR branch itself (see buildReviewPrompt) --
// this is only ever called with 'HEAD' for that mode, giving the session a
// clean starting point to run `gh pr checkout` from.
export function createReviewWorktree(projectCwd, jobId, ref) {
  const path = reviewWorktreePath(projectCwd, jobId);
  mkdirSync(dirname(path), { recursive: true });
  const resolvedRef = git(projectCwd, ['rev-parse', ref]).trim();
  git(projectCwd, ['worktree', 'add', '--detach', path, resolvedRef]);
  return { path, resolvedRef };
}

// Best-effort, unconditional teardown -- unlike worktree.js's
// removeMemberWorktree, --force is safe here (see header comment: nothing
// but this module ever writes into a review worktree). Never throws.
export function removeReviewWorktree(projectCwd, jobId) {
  const path = reviewWorktreePath(projectCwd, jobId);
  if (!existsSync(path)) return;
  try {
    git(projectCwd, ['worktree', 'remove', '--force', path]);
  } catch (err) {
    console.warn(`[reviewer] git worktree remove failed for ${path}: ${err.message}`);
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// Captures the caller's uncommitted (tracked + untracked) changes as one
// patch, for mode='dirty' jobs -- see header comment for why this is applied
// to the disposable worktree instead of pointing the session at the live cwd.
export function snapshotDirtyChanges(projectCwd) {
  const tracked = git(projectCwd, ['diff', '--binary', 'HEAD']);
  let untracked = [];
  try {
    untracked = git(projectCwd, ['ls-files', '--others', '--exclude-standard'])
      .split('\n')
      .filter(Boolean);
  } catch {
    // no untracked files
  }
  const untrackedPatches = untracked.map((file) => {
    try {
      // No differences (can't happen for an untracked file against
      // /dev/null) would exit 0; a real diff exits 1 -- both land here via
      // the try, but git diff --no-index only ever throws on a genuine
      // error (e.g. a binary/unreadable file), which is caught below.
      return git(projectCwd, ['diff', '--binary', '--no-index', '/dev/null', file]);
    } catch (err) {
      // git diff --no-index follows diff(1)'s convention: exit 1 means "a
      // diff was found", not a failure -- execFileSync throws on any
      // non-zero exit, so recover the actual patch text from the thrown
      // error's stdout instead of treating this as a real failure.
      if (typeof err.stdout === 'string' && err.stdout) return err.stdout;
      console.warn(`[reviewer] could not diff untracked file ${file}: ${err.message}`);
      return '';
    }
  });
  return tracked + untrackedPatches.join('');
}

export function applyPatchToWorktree(worktreePath, patchText) {
  if (!patchText || !patchText.trim()) return;
  execFileSync('git', ['-C', worktreePath, 'apply', '--whitespace=nowarn', '-'], {
    input: patchText,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// Best-effort removal of the per-job sandbox HOME: reviewer sessions launch
// with cwd = the (unique, disposable) worktree path, so with persistentHome
// enabled sandbox.js would otherwise create -- and never clean up -- one
// persistent HOME directory per review job forever (persistentHomeDir keys
// off cwd, and this cwd is never reused). Skipped entirely when
// persistentHome is off (nothing was created) or the HOME is still in use by
// a live sandbox (dindLockHeld) -- logged, not fatal, either way.
async function cleanupSandboxHome(worktreePath) {
  if (!loadSandboxConfig().persistentHome) return;
  try {
    const name = basename(persistentHomeDir(worktreePath));
    const res = await deleteSandboxHome(name);
    if (!res.ok) {
      console.warn(`[reviewer] could not remove sandbox HOME for ${worktreePath}: ${res.error}`);
    }
  } catch (err) {
    console.warn(`[reviewer] failed to remove sandbox HOME for ${worktreePath}: ${err.message}`);
  }
}

// --- job persistence (SQLite, db.js v6 pr_reviews) --------------------------

function rowToReview(row) {
  return {
    id: row.id,
    projectCwd: row.project_cwd,
    baseRef: row.base_ref,
    headRef: row.head_ref,
    resolvedRef: row.resolved_ref,
    prOwner: row.pr_owner,
    prRepo: row.pr_repo,
    prNumber: row.pr_number,
    mode: row.mode,
    app: row.app,
    model: row.model,
    status: row.status,
    sessionId: row.session_id,
    worktreePath: row.worktree_path,
    resultSummary: row.result_summary,
    postedToPr: !!row.posted_to_pr,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function insertReview(row) {
  getDb().prepare(`INSERT INTO pr_reviews
      (id, project_cwd, base_ref, head_ref, resolved_ref, pr_owner, pr_repo, pr_number,
       mode, app, model, status, session_id, worktree_path, requested_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      row.id, row.projectCwd, row.baseRef, row.headRef ?? null, row.resolvedRef ?? null,
      row.prOwner ?? null, row.prRepo ?? null, row.prNumber ?? null, row.mode, row.app,
      row.model ?? null, row.status, row.sessionId ?? null, row.worktreePath ?? null,
      row.requestedBy ?? null, row.createdAt,
    );
}

function setReviewSessionId(id, sessionId) {
  getDb().prepare('UPDATE pr_reviews SET session_id = ? WHERE id = ?').run(sessionId, id);
}

function finishReview(id, { status, resultSummary, postedToPr }) {
  getDb().prepare(`UPDATE pr_reviews
      SET status = ?, result_summary = ?, posted_to_pr = ?, finished_at = ?
      WHERE id = ?`)
    .run(status, resultSummary ?? null, postedToPr ? 1 : 0, Date.now(), id);
}

export function getReview({ id } = {}) {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'id is required' };
  const row = getDb().prepare('SELECT * FROM pr_reviews WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'not-found' };
  return { ok: true, review: rowToReview(row) };
}

export function listReviews({ cwd, limit } = {}) {
  const cappedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50;
  const db = getDb();
  const rows = typeof cwd === 'string' && cwd
    ? db.prepare('SELECT * FROM pr_reviews WHERE project_cwd = ? ORDER BY created_at DESC LIMIT ?').all(cwd, cappedLimit)
    : db.prepare('SELECT * FROM pr_reviews ORDER BY created_at DESC LIMIT ?').all(cappedLimit);
  return { ok: true, reviews: rows.map(rowToReview) };
}

// --- run_review --------------------------------------------------------------

// Pure validation/normalization of run_review's args -- factored out of
// runReview so it can be unit tested without touching git or sessionManager
// at all (see reviewer.test.js). Mirrors createSessionViaApi's "validation
// errors never throw" contract.
export function validateRunReviewArgs(args = {}) {
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : null;
  if (!cwd) return { ok: false, error: 'cwd is required' };
  if (!isDirectory(cwd)) return { ok: false, error: 'cwd must be an existing directory' };
  if (!isGitRepo(cwd)) return { ok: false, error: 'cwd is not a git repository' };

  const number = Number.isInteger(args.number) && args.number > 0 ? args.number : null;
  const headRef = typeof args.headRef === 'string' && args.headRef ? args.headRef : null;
  const includeUncommitted = !!args.includeUncommitted;
  if (!number && !headRef && !includeUncommitted) {
    return { ok: false, error: 'one of number, headRef, or includeUncommitted is required' };
  }
  // Priority when more than one is given: number (PR mode) wins outright,
  // then an explicit headRef, then includeUncommitted -- see the issue-#102
  // plan's "not mutually exclusive, PR mode wins" note.
  const mode = number ? 'pr' : (headRef ? 'branch' : 'dirty');

  const app = VALID_APPS.includes(args.app) ? args.app : DEFAULT_APP;
  const model = typeof args.model === 'string' && args.model ? args.model : null;
  const requestedBy = typeof args.requestedBy === 'string' && args.requestedBy ? args.requestedBy : 'reviewer';
  const baseRef = typeof args.baseRef === 'string' && args.baseRef ? args.baseRef : null;

  return { ok: true, value: { cwd, number, headRef, includeUncommitted, mode, app, model, requestedBy, baseRef } };
}

function buildReviewPrompt({ mode, number, baseRef }) {
  if (mode === 'pr') {
    // The session owns the gh credential bridge already (git-broker.js /
    // ghAllowlist.js), so it runs the checkout itself instead of the host
    // resolving the PR ref up front.
    return `gh pr checkout ${number} && /code-review --comment`;
  }
  if (mode === 'dirty') {
    // The worktree's HEAD is untouched and the patch is applied as
    // uncommitted changes on top of it -- "the current diff" is exactly
    // what /code-review reviews with no target.
    return '/code-review';
  }
  // branch mode: the worktree's HEAD is a detached checkout of the resolved
  // headRef commit, so an explicit baseRef target tells /code-review what to
  // diff it against (a bare "current diff" would see nothing on a fresh,
  // unmodified checkout).
  return `/code-review ${baseRef}`;
}

let sessionManagerMod = null;
let sessionsRouteMod = null;

// Lazily resolves sessionManager.js / routes/sessions.js -- see the header
// comment on why this can never be a static import.
async function loadSessionDeps() {
  if (!sessionManagerMod) {
    [sessionManagerMod, sessionsRouteMod] = await Promise.all([
      import('./sessionManager.js'),
      import('../routes/sessions.js'),
    ]);
  }
  return { sessionManager: sessionManagerMod, sessionsRoute: sessionsRouteMod };
}

// Host-side gh call: this runs in the ccserver process itself (never through
// the sandboxed gh wrapper / ghAllowlist.js -- those exist to restrict an
// untrusted SANDBOXED agent, not a call ccserver initiates on its own), the
// same trust level git-broker.js's execGh runs at. Best effort: any failure
// (gh missing, no PR, network) just leaves posted_to_pr false.
async function checkPrCommentPosted(projectCwd, number, sinceMs) {
  try {
    const out = execFileSync('gh', ['pr', 'view', String(number), '--json', 'comments'], {
      cwd: projectCwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GH_PR_VIEW_TIMEOUT_MS,
    });
    const parsed = JSON.parse(out);
    if (!Array.isArray(parsed?.comments)) return false;
    return parsed.comments.some((c) => {
      const createdAt = Date.parse(c?.createdAt ?? '');
      return Number.isFinite(createdAt) && createdAt >= sinceMs;
    });
  } catch {
    return false;
  }
}

function summarizeSessionOutput(session) {
  const raw = session.outputBuffer.join('');
  const text = stripAnsi(raw);
  return text.length > SUMMARY_MAX_CHARS ? text.slice(-SUMMARY_MAX_CHARS) : text;
}

// jobId -> interval handle, so a job's watcher can be torn down exactly once
// and tests can assert none are left dangling.
const watchers = new Map();
// jobIds whose watcher tick is currently awaiting the (async) completion
// check -- guards against overlapping ticks when a gh call runs long.
const checksInFlight = new Set();

function startCompletionWatcher({ jobId, sessionId, projectCwd, number }) {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (checksInFlight.has(jobId)) return;
    checksInFlight.add(jobId);
    checkCompletion({ jobId, sessionId, projectCwd, number, startedAt })
      .catch((err) => console.warn(`[reviewer] completion check failed for job ${jobId}: ${err.message}`))
      .finally(() => checksInFlight.delete(jobId));
  }, POLL_INTERVAL_MS);
  watchers.set(jobId, timer);
}

// Need-driven, self-stopping poller (mirrors routes/system.js's
// startIpmiPolling/refreshIpmiCache): ticks until THIS job reaches a
// terminal state, then clears its own interval. `screenLastChangeAt` (see
// sessionManager.js's screenModel-backed idle tracking) is the busy/idle
// signal -- a spinner keeps it fresh, a finished /code-review run leaves the
// screen static.
async function checkCompletion({ jobId, sessionId, projectCwd, number, startedAt }) {
  const { sessionManager } = await loadSessionDeps();
  const session = sessionManager.getSession(sessionId);
  const elapsed = Date.now() - startedAt;
  const exited = !session || session.exited;
  const idleMs = session?.screenLastChangeAt ? Date.now() - session.screenLastChangeAt : 0;
  const timedOut = elapsed >= ABSOLUTE_TIMEOUT_MS;
  const idleSettled = elapsed >= MIN_RUNTIME_MS && idleMs >= IDLE_DONE_MS;
  if (!exited && !timedOut && !idleSettled) return; // still working -- check again next tick

  const timer = watchers.get(jobId);
  if (timer) clearInterval(timer);
  watchers.delete(jobId);

  let status;
  let resultSummary;
  if (exited) {
    status = 'failed';
    resultSummary = 'session exited before the review could be confirmed complete';
  } else if (timedOut) {
    status = 'timeout';
    resultSummary = `review timed out after ${Math.round(ABSOLUTE_TIMEOUT_MS / 60000)} minutes`;
  } else {
    status = 'done';
    resultSummary = summarizeSessionOutput(session);
  }

  const postedToPr = number ? await checkPrCommentPosted(projectCwd, number, startedAt) : false;

  if (!exited) sessionManager.destroySession(sessionId, { keepSchedule: false });
  removeReviewWorktree(projectCwd, jobId);
  await cleanupSandboxHome(reviewWorktreePath(projectCwd, jobId));
  finishReview(jobId, { status, resultSummary, postedToPr });
}

// Launches one review job and returns immediately with its id/status --
// completion is asynchronous (see startCompletionWatcher above); poll
// get_review/list_reviews for the outcome.
export async function runReview(args = {}) {
  const v = validateRunReviewArgs(args);
  if (!v.ok) return v;
  const { cwd, number, headRef, mode, app, model, requestedBy } = v.value;
  const baseRef = v.value.baseRef || resolveDefaultBaseRef(cwd);
  const jobId = randomUUID();

  let worktreePath;
  let resolvedRef;
  let prOwner = null;
  let prRepo = null;
  try {
    if (mode === 'pr') {
      ({ path: worktreePath, resolvedRef } = createReviewWorktree(cwd, jobId, 'HEAD'));
      const remote = resolveRepoOwnerRepo(cwd);
      prOwner = remote?.owner ?? null;
      prRepo = remote?.repo ?? null;
    } else if (mode === 'branch') {
      ({ path: worktreePath, resolvedRef } = createReviewWorktree(cwd, jobId, headRef));
    } else {
      ({ path: worktreePath, resolvedRef } = createReviewWorktree(cwd, jobId, 'HEAD'));
      const patch = snapshotDirtyChanges(cwd);
      try {
        applyPatchToWorktree(worktreePath, patch);
      } catch (err) {
        removeReviewWorktree(cwd, jobId);
        return { ok: false, error: `failed to apply uncommitted changes to the review worktree: ${err.message}` };
      }
    }
  } catch (err) {
    return { ok: false, error: `failed to prepare the review worktree: ${err.message}` };
  }

  insertReview({
    id: jobId, projectCwd: cwd, baseRef, headRef: mode === 'pr' ? null : headRef, resolvedRef,
    prOwner, prRepo, prNumber: number, mode, app, model, status: 'running',
    sessionId: null, worktreePath, requestedBy, createdAt: Date.now(),
  });

  const { sessionManager, sessionsRoute } = await loadSessionDeps();
  const launch = await sessionsRoute.createSessionViaApi({
    cwd: worktreePath,
    app,
    model,
    sandbox: true,
    requestedBy: `reviewer:${jobId}`,
  });
  if (!launch.ok) {
    finishReview(jobId, { status: 'failed', resultSummary: launch.message, postedToPr: false });
    removeReviewWorktree(cwd, jobId);
    return { ok: false, error: launch.message };
  }

  const sessionId = launch.body.sessionId;
  setReviewSessionId(jobId, sessionId);

  await sessionManager.waitUntilSettled(sessionId, { timeoutMs: SETTLE_TIMEOUT_MS });
  sessionManager.writeToSession(sessionId, buildReviewPrompt({ mode, number, baseRef }), { submit: true });

  startCompletionWatcher({ jobId, sessionId, projectCwd: cwd, number });

  return { ok: true, id: jobId, status: 'running', sessionId, worktreePath, mode, resolvedRef };
}

// The reviewerApi facade handed to buildReviewerMcpServer (see mcpServer.js).
export const reviewerApi = {
  runReview,
  listReviews,
  getReview,
};

// Start (once) the global Unix-socket broker hosting ccserver-reviewer.
// Callers must await it before launching sessions: bwrap's --bind-try
// snapshots the socket file at mount time, so the file must exist first.
// Safe to call repeatedly -- the second call is a no-op returning the
// existing socket path.
export async function ensureReviewerBroker() {
  if (reviewerBroker) return reviewerBroker.sockPath;
  const broker = await import('./mcpBroker.js');
  stopBrokerFn = broker.stopBroker;
  reviewerBroker = await broker.startReviewerBroker({
    reviewerApi,
    sockPath: getReviewerSockPath(),
  });
  return reviewerBroker.sockPath;
}

// Teardown for graceful shutdown. Synchronous (the stopBroker reference is
// cached on the first ensureReviewerBroker call). Best effort; a stale
// socket file is removed by the next boot's listenMcp anyway. Any jobs still
// running are left as-is in the DB (status stays 'running') -- there is no
// live process to correlate them with after a restart, so they are simply
// stale rows a human can see via list_reviews; nothing auto-resumes them.
export function stopReviewerBroker() {
  for (const timer of watchers.values()) clearInterval(timer);
  watchers.clear();
  if (!reviewerBroker) return;
  try {
    if (stopBrokerFn) stopBrokerFn(reviewerBroker);
  } catch {
    // best effort
  }
  reviewerBroker = null;
}
