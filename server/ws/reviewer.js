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
//
// Completion detection (issue #103 follow-up): the review session ITSELF
// calling the `finish_review` MCP tool is the AUTHORITATIVE way a job
// completes -- buildReviewPrompt tells it to, with its own jobId, as part of
// every prompt. finish_review verifies the caller really is that job's own
// session (via the per-connection identity frame sessionManager.js attaches,
// see shouldInjectReviewer/isReviewJob) before accepting it. The idle-poller
// this used to rely on as its primary signal is now a pure FALLBACK safety
// net -- it never guesses "done" from screen idleness any more, only
// "exited" (the session's process died) or "timed out" (ABSOLUTE_TIMEOUT_MS
// elapsed with no finish_review call at all, e.g. the agent hung or was
// never going to call it). See completeReviewJob, the single cleanup path
// both finish_review and the fallback poller funnel into -- it also fires a
// best-effort ccserver-notify notification (issue #102 plan section 3.6.1;
// see notifyReviewComplete) once the DB row is written, regardless of which
// of the two paths reached it.

import { randomUUID } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { getDb } from '../db.js';
import { projectHashForCwd } from './projectHash.js';
import { loadSandboxConfig, persistentHomeDir, deleteSandboxHome } from './sandbox.js';
import { stripAnsi } from './mcpTools.js';
// A plain in-process call, not the MCP path -- mirrors groupManager.js's
// notifyWorktreeDataLoss (same "call sendNotification() directly on a
// server-side completion event" pattern). Safe as a static import: notify.js
// imports neither this module nor sessionManager.js, so no cycle.
import { sendNotification } from './notify.js';

const REVIEWER_SOCKET_NAME = 'ccserver-reviewer.sock';

const VALID_APPS = ['claude', 'opencode', 'codex'];
const DEFAULT_APP = 'claude';

// Completion-detection thresholds (see the header comment: finish_review is
// now the primary signal, these only govern the fallback poller). Not a
// measured value -- /code-review's real runtime, especially with a slow
// model or a large diff, may need a longer window than this.
const SETTLE_TIMEOUT_MS = 15 * 1000; // waitUntilSettled cap before typing the prompt
// Exported so tests can compute a deadline already past this without
// duplicating the constant (see reviewer.test.js's timeout-fallback test).
export const ABSOLUTE_TIMEOUT_MS = 20 * 60 * 1000; // fallback hard stop if finish_review never comes
const POLL_INTERVAL_MS = 5 * 1000;
const SUMMARY_MAX_CHARS = 4000;
const GH_PR_VIEW_TIMEOUT_MS = 15 * 1000;
const REF_FETCH_TIMEOUT_MS = 15 * 1000;

// Soft cap on jobs accepted (worktree created / session launched) at once,
// process-wide -- run_review is injected into every non-shell/non-copilot
// session once reviewerMcp is on (see shouldInjectReviewer), including
// workers, and each job spawns a real sandboxed agent CLI session, so an
// agent looping on run_review with no cap would be free to exhaust host
// resources. Overridable for local testing / larger hosts.
const MAX_CONCURRENT_REVIEWS = Number(process.env.CCSERVER_REVIEWER_MAX_CONCURRENT) || 4;

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

// Runs one command WITHOUT blocking the event loop, unlike the sync git()
// helper above. Reserved for the two calls in this module that can involve
// real network I/O and a multi-second timeout (the fetch fallback below, and
// checkPrCommentPosted's `gh pr view`) -- every other call here (rev-parse,
// worktree add/remove, diff, apply) is local-only and finishes in
// milliseconds, so it's fine to leave those synchronous, matching
// worktree.js's existing execFileSync convention. A *synchronous* multi-
// second call would instead freeze the whole ccserver process (every
// session's pty I/O, every other MCP call, all of it -- Node has one JS
// thread and execFileSync doesn't yield to the event loop) each time it runs,
// defeating the point of MAX_CONCURRENT_REVIEWS letting several jobs run at
// once.
function execFileAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function gitFetchAsync(cwd, args) {
  return execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf-8', timeout: REF_FETCH_TIMEOUT_MS });
}

// Resolves `ref` to a commit on the PROJECT repo, fetching it from origin
// first if it isn't already known locally. Plain rev-parse is tried first
// (the common case -- no network at all) so this only pays for a fetch when
// actually needed: a branch mode job's headRef may be a "pushed-but-PR-less
// branch" (see run_review's tool description) that was never fetched into
// the caller's local clone. Swallowed on failure (offline, no origin remote,
// ref genuinely doesn't exist anywhere): the rev-parse retry right after is
// what actually decides success/failure, surfacing the same error as before
// this fell back to fetching.
async function resolveRefForWorktree(projectCwd, ref, jobId) {
  if (ref === 'HEAD') return git(projectCwd, ['rev-parse', ref]).trim();
  try {
    return git(projectCwd, ['rev-parse', ref]).trim();
  } catch (localErr) {
    // Fetch into a job-private ref, never a bare `fetch origin <ref>` (which
    // only ever writes the single FETCH_HEAD file). projectCwd is the SAME
    // directory for every concurrent run_review job against this project
    // (MAX_CONCURRENT_REVIEWS allows several at once, and gitFetchAsync above
    // deliberately no longer blocks the event loop, so their fetches really
    // can interleave now) -- two jobs resolving different unfetched refs at
    // once would otherwise race on FETCH_HEAD, and one could silently check
    // out the OTHER job's ref with no error at all.
    const tmpRef = `refs/ccserver-reviewer/${jobId}`;
    try {
      await gitFetchAsync(projectCwd, ['fetch', '--quiet', 'origin', `${ref}:${tmpRef}`]);
      return git(projectCwd, ['rev-parse', tmpRef]).trim();
    } catch {
      // best effort -- surface the original local rev-parse failure (an
      // unreachable/absent-origin fetch failure is a less useful message
      // than "unknown revision <ref>")
      throw localErr;
    } finally {
      // The SHA is already captured above (or we're failing anyway) -- the
      // ref itself served its purpose. Best effort: leaving it behind would
      // grow refs/ccserver-reviewer/ forever, but a failed delete is harmless.
      try { git(projectCwd, ['update-ref', '-d', tmpRef]); } catch { /* nothing to delete */ }
    }
  }
}

// Creates a disposable detached worktree for one review job, checked out at
// `ref` (resolved on the PROJECT repo via resolveRefForWorktree above). PR
// mode checks out the actual PR branch itself (see buildReviewPrompt) --
// this is only ever called with 'HEAD' for that mode, giving the session a
// clean starting point to run `gh pr checkout` from.
export async function createReviewWorktree(projectCwd, jobId, ref) {
  const path = reviewWorktreePath(projectCwd, jobId);
  mkdirSync(dirname(path), { recursive: true });
  const resolvedRef = await resolveRefForWorktree(projectCwd, ref, jobId);
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
    focus: row.focus,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function insertReview(row) {
  getDb().prepare(`INSERT INTO pr_reviews
      (id, project_cwd, base_ref, head_ref, resolved_ref, pr_owner, pr_repo, pr_number,
       mode, app, model, status, session_id, worktree_path, requested_by, focus, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      row.id, row.projectCwd, row.baseRef, row.headRef ?? null, row.resolvedRef ?? null,
      row.prOwner ?? null, row.prRepo ?? null, row.prNumber ?? null, row.mode, row.app,
      row.model ?? null, row.status, row.sessionId ?? null, row.worktreePath ?? null,
      row.requestedBy ?? null, row.focus ?? null, row.createdAt,
    );
}

function setReviewSessionId(id, sessionId) {
  getDb().prepare('UPDATE pr_reviews SET session_id = ? WHERE id = ?').run(sessionId, id);
}

// Named markReviewFinished (not finishReview) to leave that name free for
// the exported finish_review MCP handler below -- this is only the raw DB
// write, called from inside completeReviewJob (and once directly, for the
// launch-failure path in runReview that has no watcher/completion-job to
// route through).
function markReviewFinished(id, { status, resultSummary, postedToPr }) {
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
  // Free-form "pay extra attention to X" steer for the review (issue #103
  // feedback: "セキュリティ面を重点的にレビューして" etc.) -- trimmed and
  // normalized to null/absent the same way baseRef/model are, so callers
  // that pass '' or whitespace-only get the same "no focus" behavior as
  // omitting it entirely.
  const focusRaw = typeof args.focus === 'string' ? args.focus.trim() : '';
  const focus = focusRaw || null;

  return { ok: true, value: { cwd, number, headRef, includeUncommitted, mode, app, model, requestedBy, baseRef, focus } };
}

// Exported (like validateRunReviewArgs) purely so it can be unit tested
// without touching git or sessionManager.
export function buildReviewPrompt({ mode, number, baseRef, focus, jobId }) {
  let base;
  if (mode === 'pr') {
    // The session owns the gh credential bridge already (git-broker.js /
    // ghAllowlist.js), so it runs the checkout itself instead of the host
    // resolving the PR ref up front.
    base = `gh pr checkout ${number} && /code-review --comment`;
  } else if (mode === 'dirty') {
    // The worktree's HEAD is untouched and the patch is applied as
    // uncommitted changes on top of it -- "the current diff" is exactly
    // what /code-review reviews with no target.
    base = '/code-review';
  } else {
    // branch mode: the worktree's HEAD is a detached checkout of the
    // resolved headRef commit, so an explicit baseRef target tells
    // /code-review what to diff it against (a bare "current diff" would see
    // nothing on a fresh, unmodified checkout).
    base = `/code-review ${baseRef}`;
  }
  // This is typed into the agent's chat input, not run as a shell command
  // (see writeToSession) -- appending plain-language instructions after the
  // slash command works the same as a human typing a follow-up sentence.
  const parts = [base];
  if (focus) parts.push(`Focus especially on: ${focus}`);
  // finish_review is now the AUTHORITATIVE completion signal (see the module
  // header comment) -- every mode gets this instruction, with the SAME jobId
  // runReview already generated and recorded in pr_reviews, so finish_review
  // can match the calling session's identity against it.
  parts.push(`When you are finished, you MUST call the mcp__ccserver-reviewer__finish_review tool with jobId="${jobId}" (status: "done" or "failed", summary: a short note on what you found) before ending the session -- this is what marks the review complete. If you never call it, ccserver will eventually time the job out on its own, but that is a fallback, not the intended way to finish.`);
  return parts.join('\n\n');
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
    const out = await execFileAsync('gh', ['pr', 'view', String(number), '--json', 'comments'], {
      cwd: projectCwd, encoding: 'utf-8', timeout: GH_PR_VIEW_TIMEOUT_MS,
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

// jobId -> interval handle, so a job's fallback watcher can be torn down
// exactly once and tests can assert none are left dangling.
const watchers = new Map();
// jobIds whose watcher tick is currently awaiting the (async) completion
// check -- guards against overlapping ticks when a gh call runs long.
const checksInFlight = new Set();
// jobIds already handed to (or currently inside) completeReviewJob. Unlike
// checksInFlight (which only serializes the fallback POLLER's own ticks
// against each other), this guards the race the poller now shares with
// finish_review: an MCP finish_review call and an overdue poller tick can
// each independently decide "this job is done" and reach completeReviewJob
// at effectively the same moment. Checked-and-added synchronously as the
// very first thing completeReviewJob does (no `await` before the add), the
// same single-threaded-JS guarantee activeReviewCount's comment below relies
// on -- so exactly one of the two ever actually runs the cleanup.
const completingJobs = new Set();

// Count of jobs currently occupying a concurrency slot (see
// MAX_CONCURRENT_REVIEWS): held from the moment runReview accepts a job
// until completeReviewJob reaches a terminal state for it. Checked and
// incremented synchronously with no `await` in between (see runReview), so
// two overlapping run_review calls can never both slip past a full cap --
// ordinary JS single-threadedness makes that a correctness guarantee here,
// not just best-effort.
let activeReviewCount = 0;

function releaseReviewSlot() {
  activeReviewCount = Math.max(0, activeReviewCount - 1);
}

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

// Notification title for a finished job (issue #102 plan section 3.6.1:
// "call notify.js's sendNotification() in-process on completion" -- the part
// missed by the original implementation and all three self-review rounds).
// Exported (like buildReviewPrompt) purely for unit testing.
export function reviewNotificationTitle(review, status) {
  const prefix = status === 'done' ? 'Review done' : status === 'failed' ? 'Review failed' : 'Review timed out';
  if (review.mode === 'pr') {
    const target = (review.prOwner && review.prRepo) ? `${review.prOwner}/${review.prRepo}#${review.prNumber}` : `PR #${review.prNumber}`;
    return `${prefix}: ${target}`;
  }
  // branch mode always has a headRef (validateRunReviewArgs requires it);
  // dirty mode never does -- "uncommitted changes" names it instead.
  const target = review.mode === 'branch' && review.headRef ? review.headRef : 'uncommitted changes';
  const project = review.projectCwd ? basename(review.projectCwd) : null;
  return project ? `${prefix}: ${target} (${project})` : `${prefix}: ${target}`;
}

// Exported alongside reviewNotificationTitle for the same reason.
export function reviewNotificationBody(review, { status, postedToPr }) {
  const lines = [`status: ${status}`];
  if (review.focus) lines.push(`focus: ${review.focus}`);
  if (review.mode === 'pr') {
    lines.push(postedToPr ? 'Posted as a PR comment.' : 'Not posted as a PR comment -- see the result via get_review.');
  } else {
    lines.push(`See the full result via get_review({ id: "${review.id}" }).`);
  }
  return lines.join('\n');
}

// Best-effort, fire-and-forget -- mirrors groupManager.js's
// notifyWorktreeDataLoss exactly (never awaited by the caller, a delivery
// failure must never affect job completion). sendNotification degrades to a
// no-op with no channel configured, so no new opt-in flag is needed here.
function notifyReviewComplete(review, { status, postedToPr }) {
  const level = status === 'done' ? 'success' : status === 'failed' ? 'error' : 'warning';
  sendNotification({
    title: reviewNotificationTitle(review, status),
    body: reviewNotificationBody(review, { status, postedToPr }),
    level,
  }, {
    sessionId: review.sessionId,
    cwd: review.projectCwd,
    projectName: review.projectCwd ? basename(review.projectCwd) : null,
  }).catch(() => { /* best effort, see notify.js */ });
}

// The single cleanup path for a finished review job, reached from TWO
// places (see the module header comment):
//   - finishReview() (the finish_review MCP tool): the review session's own
//     explicit "I'm done" signal -- the PRIMARY, expected way a job ends.
//   - checkCompletion()'s fallback poller: only for a session that exited
//     (crashed/was killed) or ran past ABSOLUTE_TIMEOUT_MS without ever
//     calling finish_review.
// completingJobs (see above) makes sure whichever of the two gets here
// first is the only one that actually runs; the other becomes a no-op
// (return false) instead of double-tearing-down the same worktree/session.
async function completeReviewJob({ jobId, sessionId, projectCwd, number, startedAt, status, resultSummary }) {
  if (completingJobs.has(jobId)) return false;
  completingJobs.add(jobId);

  const timer = watchers.get(jobId);
  if (timer) clearInterval(timer);
  watchers.delete(jobId);

  // Wrapped in try/finally so a throw anywhere in here (most plausibly
  // markReviewFinished's DB write; destroySession/removeReviewWorktree/
  // cleanupSandboxHome are already internally best-effort and never throw)
  // still releases the concurrency slot instead of leaking it forever, since
  // nothing will ever retry this jobId again (completingJobs already claimed
  // it above).
  try {
    const { sessionManager } = await loadSessionDeps();
    const session = sessionManager.getSession(sessionId);
    // A caller-supplied resultSummary (finish_review's `summary`, or the
    // fallback poller's own diagnostic string) always wins; only fall back
    // to the session's raw recent output when neither was given (finish_review
    // called with no summary at all).
    const summary = resultSummary || (session ? summarizeSessionOutput(session) : `review ${status}`);
    const postedToPr = number ? await checkPrCommentPosted(projectCwd, number, startedAt) : false;
    if (session && !session.exited) sessionManager.destroySession(sessionId, { keepSchedule: false });
    removeReviewWorktree(projectCwd, jobId);
    await cleanupSandboxHome(reviewWorktreePath(projectCwd, jobId));
    markReviewFinished(jobId, { status, resultSummary: summary, postedToPr });
    // Read the row back rather than threading mode/prOwner/prRepo/headRef/
    // focus through every completeReviewJob caller -- it was just written,
    // so a single extra SQLite read here is cheap and keeps both call sites
    // (checkCompletion, finishReview) simple.
    const finished = getReview({ id: jobId });
    if (finished.ok) notifyReviewComplete(finished.review, { status, postedToPr });
  } finally {
    releaseReviewSlot();
  }
  return true;
}

// Need-driven, self-stopping FALLBACK poller (mirrors routes/system.js's
// startIpmiPolling/refreshIpmiCache): ticks until THIS job reaches a
// terminal state, then clears its own interval. Unlike before, this never
// guesses "done" from idle screen output -- finish_review is the
// authoritative signal for that now (see the module header comment). This
// only catches the two cases finish_review can't: the session's process
// already died (exited), or nobody ever called finish_review at all within
// ABSOLUTE_TIMEOUT_MS (timedOut).
//
// Exported (like buildReviewPrompt) so tests can invoke one fallback tick
// directly with a fabricated `startedAt`, instead of waiting real minutes
// for ABSOLUTE_TIMEOUT_MS or driving a real setInterval.
export async function checkCompletion({ jobId, sessionId, projectCwd, number, startedAt }) {
  const { sessionManager } = await loadSessionDeps();
  const session = sessionManager.getSession(sessionId);
  const exited = !session || session.exited;
  const timedOut = Date.now() - startedAt >= ABSOLUTE_TIMEOUT_MS;
  if (!exited && !timedOut) return; // still working -- finish_review is expected; check again next tick

  const status = exited ? 'failed' : 'timeout';
  const resultSummary = exited
    ? 'session exited before calling finish_review'
    : `review timed out after ${Math.round(ABSOLUTE_TIMEOUT_MS / 60000)} minutes without calling finish_review`;
  await completeReviewJob({ jobId, sessionId, projectCwd, number, startedAt, status, resultSummary });
}

// The finish_review MCP tool's implementation: the review session's own
// authoritative "I'm done" signal (see the module header comment).
// callerSessionId comes from the MCP connection's identity frame
// (CCSERVER_REVIEWER_IDENTITY, see sessionManager.js/mcpServer.js) -- ONLY
// the session the job itself launched may call this for that job, verified
// by matching it against the job's own recorded session_id.
export async function finishReview({ jobId, status, summary, callerSessionId } = {}) {
  if (typeof jobId !== 'string' || !jobId) return { ok: false, error: 'jobId is required' };
  if (status !== 'done' && status !== 'failed') return { ok: false, error: 'status must be "done" or "failed"' };

  const found = getReview({ id: jobId });
  if (!found.ok) return { ok: false, error: 'not-found' };
  const review = found.review;
  if (review.status !== 'running') {
    return { ok: false, error: `job ${jobId} is already ${review.status}, not running` };
  }
  // review.sessionId is null in the brief window between insertReview and
  // setReviewSessionId (see runReview) -- no caller can legitimately match
  // that, so treat it the same as any other mismatch: reject.
  if (!callerSessionId || callerSessionId !== review.sessionId) {
    return { ok: false, error: "not authorized: finish_review may only be called by the review job's own session" };
  }

  // completeReviewJob's own return value (false = lost the race with the
  // fallback poller, which already claimed this job via completingJobs) is
  // not surfaced as an error: the job IS finished (or about to be) either
  // way, from the caller's point of view. A re-read here to report the
  // "real" outcome would risk a stale 'running' row if the winner's own
  // async cleanup hasn't finished writing yet, so this just acknowledges
  // what the caller itself asked for instead of claiming false precision.
  await completeReviewJob({
    jobId,
    sessionId: review.sessionId,
    projectCwd: review.projectCwd,
    number: review.prNumber,
    startedAt: review.createdAt,
    status,
    resultSummary: typeof summary === 'string' && summary.trim() ? summary.trim() : null,
  });
  return { ok: true, id: jobId, status };
}

// Launches one review job and returns immediately with its id/status --
// completion is asynchronous (see startCompletionWatcher above); poll
// get_review/list_reviews for the outcome.
export async function runReview(args = {}) {
  const v = validateRunReviewArgs(args);
  if (!v.ok) return v;
  // Cap check-and-increment is synchronous (no `await` between them), so
  // this can't race with another concurrent runReview call -- see
  // activeReviewCount's comment.
  if (activeReviewCount >= MAX_CONCURRENT_REVIEWS) {
    return { ok: false, error: `too many review jobs running (max ${MAX_CONCURRENT_REVIEWS}); wait for one to finish or check list_reviews` };
  }
  activeReviewCount++;
  let slotHeld = true; // cleared once the job is handed off to completeReviewJob, which releases it instead

  const { cwd, number, headRef, mode, app, model, requestedBy, focus } = v.value;

  // Everything from here on runs inside the try/finally below, so
  // releaseReviewSlot() is guaranteed to fire on ANY throw between the
  // increment above and the handoff to completeReviewJob -- resolveDefaultBaseRef
  // and randomUUID() don't throw today, but nothing should have to keep being
  // true forever for the slot count to stay correct.
  try {
    const baseRef = v.value.baseRef || resolveDefaultBaseRef(cwd);
    const jobId = randomUUID();

    let worktreePath;
    let resolvedRef;
    let prOwner = null;
    let prRepo = null;
    try {
      if (mode === 'pr') {
        ({ path: worktreePath, resolvedRef } = await createReviewWorktree(cwd, jobId, 'HEAD'));
        const remote = resolveRepoOwnerRepo(cwd);
        prOwner = remote?.owner ?? null;
        prRepo = remote?.repo ?? null;
      } else if (mode === 'branch') {
        ({ path: worktreePath, resolvedRef } = await createReviewWorktree(cwd, jobId, headRef));
      } else {
        ({ path: worktreePath, resolvedRef } = await createReviewWorktree(cwd, jobId, 'HEAD'));
        // Both the snapshot (git diff HEAD -- fails e.g. if cwd is a bare
        // repo, which has no work tree to diff) and the apply step run AFTER
        // the worktree above already exists, so both must go through the
        // same cleanup-on-failure path -- snapshotDirtyChanges throwing here
        // used to fall through to the outer catch below, which returns an
        // error WITHOUT calling removeReviewWorktree, orphaning the worktree
        // (with no DB row yet to even list it via list_reviews).
        try {
          const patch = snapshotDirtyChanges(cwd);
          applyPatchToWorktree(worktreePath, patch);
        } catch (err) {
          removeReviewWorktree(cwd, jobId);
          return { ok: false, error: `failed to capture/apply uncommitted changes to the review worktree: ${err.message}` };
        }
      }
    } catch (err) {
      return { ok: false, error: `failed to prepare the review worktree: ${err.message}` };
    }

    insertReview({
      id: jobId, projectCwd: cwd, baseRef, headRef: mode === 'pr' ? null : headRef, resolvedRef,
      prOwner, prRepo, prNumber: number, mode, app, model, status: 'running',
      sessionId: null, worktreePath, requestedBy, focus, createdAt: Date.now(),
    });

    const { sessionManager, sessionsRoute } = await loadSessionDeps();
    const launch = await sessionsRoute.createSessionViaApi({
      cwd: worktreePath,
      app,
      model,
      sandbox: true,
      requestedBy: `reviewer:${jobId}`,
      // Forces reviewer MCP injection into THIS session regardless of the
      // live reviewerMcp config value (see sessionManager.js's useReviewer
      // comment) -- without it, finish_review would be unreachable for this
      // job if the flag was flipped off after the broker started.
      isReviewJob: true,
    });
    if (!launch.ok) {
      markReviewFinished(jobId, { status: 'failed', resultSummary: launch.message, postedToPr: false });
      removeReviewWorktree(cwd, jobId);
      return { ok: false, error: launch.message };
    }

    const sessionId = launch.body.sessionId;
    setReviewSessionId(jobId, sessionId);

    await sessionManager.waitUntilSettled(sessionId, { timeoutMs: SETTLE_TIMEOUT_MS });
    sessionManager.writeToSession(sessionId, buildReviewPrompt({ mode, number, baseRef, focus, jobId }), { submit: true });

    startCompletionWatcher({ jobId, sessionId, projectCwd: cwd, number });
    slotHeld = false; // handed off -- checkCompletion releases the slot when the job finishes

    return { ok: true, id: jobId, status: 'running', sessionId, worktreePath, mode, resolvedRef };
  } finally {
    if (slotHeld) releaseReviewSlot();
  }
}

// The reviewerApi facade handed to buildReviewerMcpServer (see mcpServer.js).
export const reviewerApi = {
  runReview,
  listReviews,
  getReview,
  finishReview,
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
