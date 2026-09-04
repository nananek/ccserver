// Tests for reviewer.js (issue #102): the disposable per-job worktree
// lifecycle, the SQLite-backed job store (db.js v6 pr_reviews), and
// run_review's argument validation. Deliberately does NOT exercise the
// actual session launch / completion-watcher path (runReview end-to-end):
// that needs a real spawned agent CLI, which isn't available in this test
// environment -- see validateRunReviewArgs, factored out specifically so the
// pre-launch validation logic can be tested without touching sessionManager.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let runtimeDir;
let repo;
let reviewer;
let dbMod;
let sessionManagerMod;

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
}

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-reviewer-test-'));
  process.env.CCSERVER_REVIEW_WORKTREE_ROOT = join(runtimeDir, 'review-worktrees');
  process.env.CCSERVER_DB_PATH = join(runtimeDir, 'test.sqlite3');
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(runtimeDir, 'home');

  reviewer = await import('./reviewer.js');
  dbMod = await import('../db.js');
  // Only used by the fallback-poller test below, which needs a real (but
  // shell -- no agent CLI required) session so checkCompletion's `exited`
  // check has something live to look at.
  sessionManagerMod = await import('./sessionManager.js');

  repo = join(runtimeDir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const mainBranch = git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t.com', 'checkout', '-q', '-b', 'feature']);
  writeFileSync(join(repo, 'a.txt'), 'feature content\n');
  git(repo, ['add', 'a.txt']);
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t.com', 'commit', '-q', '-m', 'feature commit']);
  git(repo, ['checkout', '-q', mainBranch]);
});

after(() => {
  dbMod.closeDb();
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// --- worktree lifecycle ------------------------------------------------------

test('reviewWorktreePath is deterministic per (cwd, jobId) and lives under a dedicated root', () => {
  const path = reviewer.reviewWorktreePath(repo, 'job-1');
  assert.equal(path, reviewer.reviewWorktreePath(repo, 'job-1'));
  assert.notEqual(path, reviewer.reviewWorktreePath(repo, 'job-2'));
  assert.ok(path.startsWith(reviewer.reviewWorktreeRoot()));
});

test('createReviewWorktree checks out the resolved ref detached, removeReviewWorktree cleans it up', async () => {
  const { path, resolvedRef } = await reviewer.createReviewWorktree(repo, 'job-branch', 'feature');
  assert.ok(existsSync(path));
  assert.equal(readFileSync(join(path, 'a.txt'), 'utf-8'), 'feature content\n');
  assert.equal(resolvedRef, git(repo, ['rev-parse', 'feature']).trim());
  // detached -- symbolic-ref fails on a detached HEAD
  assert.throws(() => git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']));

  reviewer.removeReviewWorktree(repo, 'job-branch');
  assert.equal(existsSync(path), false);
  // git no longer thinks it's registered either
  const list = git(repo, ['worktree', 'list', '--porcelain']);
  assert.ok(!list.includes(path));
});

test('removeReviewWorktree is a no-op for a job that was never created', () => {
  assert.doesNotThrow(() => reviewer.removeReviewWorktree(repo, 'never-existed'));
});

test('createReviewWorktree rejects for an unresolvable ref', async () => {
  await assert.rejects(() => reviewer.createReviewWorktree(repo, 'job-bad-ref', 'no-such-branch'));
});

test('createReviewWorktree fetches a branch that was pushed to origin after the local clone was made', async () => {
  // Simulates the "pushed-but-PR-less branch" case from run_review's tool
  // description: headRef exists on origin but was never fetched into the
  // caller's local clone (repo.js's origin/master case, not something rev-parse
  // can see without a fetch first -- see resolveRefForWorktree).
  const remote = join(runtimeDir, 'remote.git');
  mkdirSync(remote, { recursive: true });
  git(remote, ['init', '-q', '--bare']);

  const seed = join(runtimeDir, 'fetch-seed');
  mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q']);
  git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  git(seed, ['remote', 'add', 'origin', remote]);
  const seedBranch = git(seed, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
  git(seed, ['push', '-q', 'origin', seedBranch]);

  const clone = join(runtimeDir, 'fetch-clone');
  git(runtimeDir, ['clone', '-q', remote, clone]);

  // Pushed to origin only AFTER the clone above -- `clone` has no local ref
  // and no origin/far-branch remote-tracking ref for it yet.
  git(seed, ['checkout', '-q', '-b', 'far-branch']);
  writeFileSync(join(seed, 'far.txt'), 'far content\n');
  git(seed, ['add', 'far.txt']);
  git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t.com', 'commit', '-q', '-m', 'far commit']);
  git(seed, ['push', '-q', 'origin', 'far-branch']);

  assert.throws(() => git(clone, ['rev-parse', 'far-branch']), 'sanity: not resolvable before the fetch fallback kicks in');

  const { path, resolvedRef } = await reviewer.createReviewWorktree(clone, 'job-fetch', 'far-branch');
  try {
    assert.equal(readFileSync(join(path, 'far.txt'), 'utf-8'), 'far content\n');
    assert.equal(resolvedRef, git(seed, ['rev-parse', 'far-branch']).trim());
    // resolveRefForWorktree fetches into a job-private ref, not the shared
    // FETCH_HEAD, and deletes it once it has the resolved SHA (see the race
    // this avoids when two jobs on the same project fetch concurrently).
    assert.throws(() => git(clone, ['rev-parse', '--verify', 'refs/ccserver-reviewer/job-fetch']));
  } finally {
    reviewer.removeReviewWorktree(clone, 'job-fetch');
  }
});

test('createReviewWorktree resolves the right ref for two concurrent jobs fetching different unfetched branches on the same project', async () => {
  // Regression test: resolveRefForWorktree's fetch step is async (does not
  // block the event loop, see its comment), so two run_review calls against
  // the SAME project (allowed -- MAX_CONCURRENT_REVIEWS is process-wide, not
  // per-project) really can have their fetches interleave. Fetching into the
  // shared FETCH_HEAD would let one job resolve the OTHER job's ref with no
  // error at all; fetching into a job-private ref (refs/ccserver-reviewer/
  // <jobId>) must keep them independent no matter the interleaving.
  const remote = join(runtimeDir, 'remote-concurrent.git');
  mkdirSync(remote, { recursive: true });
  git(remote, ['init', '-q', '--bare']);

  const seed = join(runtimeDir, 'concurrent-seed');
  mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q']);
  git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  git(seed, ['remote', 'add', 'origin', remote]);
  const seedBranch = git(seed, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
  git(seed, ['push', '-q', 'origin', seedBranch]);

  const clone = join(runtimeDir, 'concurrent-clone');
  git(runtimeDir, ['clone', '-q', remote, clone]);

  for (const name of ['branch-x', 'branch-y']) {
    git(seed, ['checkout', '-q', seedBranch]);
    git(seed, ['checkout', '-q', '-b', name]);
    writeFileSync(join(seed, `${name}.txt`), `${name} content\n`);
    git(seed, ['add', `${name}.txt`]);
    git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t.com', 'commit', '-q', '-m', `${name} commit`]);
    git(seed, ['push', '-q', 'origin', name]);
  }
  const shaX = git(seed, ['rev-parse', 'branch-x']).trim();
  const shaY = git(seed, ['rev-parse', 'branch-y']).trim();
  assert.notEqual(shaX, shaY);

  const [resultX, resultY] = await Promise.all([
    reviewer.createReviewWorktree(clone, 'job-x', 'branch-x'),
    reviewer.createReviewWorktree(clone, 'job-y', 'branch-y'),
  ]);
  try {
    assert.equal(resultX.resolvedRef, shaX);
    assert.equal(resultY.resolvedRef, shaY);
    assert.equal(readFileSync(join(resultX.path, 'branch-x.txt'), 'utf-8'), 'branch-x content\n');
    assert.equal(readFileSync(join(resultY.path, 'branch-y.txt'), 'utf-8'), 'branch-y content\n');
  } finally {
    reviewer.removeReviewWorktree(clone, 'job-x');
    reviewer.removeReviewWorktree(clone, 'job-y');
  }
});

// --- dirty-diff snapshot / apply --------------------------------------------

test('snapshotDirtyChanges captures tracked + untracked changes, applyPatchToWorktree replays them', async () => {
  const scratch = join(runtimeDir, 'scratch-repo');
  mkdirSync(scratch, { recursive: true });
  git(scratch, ['init', '-q']);
  writeFileSync(join(scratch, 'tracked.txt'), 'original\n');
  git(scratch, ['add', 'tracked.txt']);
  git(scratch, ['-c', 'user.name=t', '-c', 'user.email=t@t.com', 'commit', '-q', '-m', 'init']);

  // one tracked edit, one new untracked file
  writeFileSync(join(scratch, 'tracked.txt'), 'edited\n');
  writeFileSync(join(scratch, 'untracked.txt'), 'new file\n');

  const patch = reviewer.snapshotDirtyChanges(scratch);
  assert.ok(patch.includes('tracked.txt'));
  assert.ok(patch.includes('untracked.txt'));

  const { path: worktreePath } = await reviewer.createReviewWorktree(scratch, 'job-dirty', 'HEAD');
  try {
    reviewer.applyPatchToWorktree(worktreePath, patch);
    assert.equal(readFileSync(join(worktreePath, 'tracked.txt'), 'utf-8'), 'edited\n');
    assert.equal(readFileSync(join(worktreePath, 'untracked.txt'), 'utf-8'), 'new file\n');
  } finally {
    reviewer.removeReviewWorktree(scratch, 'job-dirty');
  }
});

test('snapshotDirtyChanges throwing after a successful createReviewWorktree does not orphan the worktree', async () => {
  // Regression test for the mode === 'dirty' branch in runReview: it used to
  // call snapshotDirtyChanges() OUTSIDE the try/catch that cleans up via
  // removeReviewWorktree() on failure (that catch only wrapped
  // applyPatchToWorktree), so a snapshot failure after the worktree was
  // already created leaked it. A bare repo reproduces this deterministically:
  // `git worktree add` against a bare repo succeeds (bare repos are a normal
  // worktree base), but `git diff HEAD` fails immediately after ("this
  // operation must be run in a work tree") since a bare repo's own directory
  // has no work tree to diff -- unlike createReviewWorktree's HEAD resolution
  // (git rev-parse HEAD), which needs no work tree and succeeds fine.
  const bareRemote = join(runtimeDir, 'dirty-bare-remote.git');
  mkdirSync(bareRemote, { recursive: true });
  git(bareRemote, ['init', '-q', '--bare']);

  const seed = join(runtimeDir, 'dirty-bare-seed');
  mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q']);
  git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  git(seed, ['remote', 'add', 'origin', bareRemote]);
  git(seed, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);

  const { path } = await reviewer.createReviewWorktree(bareRemote, 'job-dirty-bare', 'HEAD');
  assert.ok(existsSync(path), 'sanity: worktree add against a bare repo succeeds');

  assert.throws(() => reviewer.snapshotDirtyChanges(bareRemote), /work tree/);

  // This is the exact recovery runReview's mode === 'dirty' branch now takes
  // when the snapshot step throws (see the try/catch around it in runReview).
  reviewer.removeReviewWorktree(bareRemote, 'job-dirty-bare');
  assert.equal(existsSync(path), false);
  const list = git(bareRemote, ['worktree', 'list', '--porcelain']);
  assert.ok(!list.includes(path));
});

test('snapshotDirtyChanges returns an empty patch for a clean tree', () => {
  const clean = join(runtimeDir, 'clean-repo');
  mkdirSync(clean, { recursive: true });
  git(clean, ['init', '-q']);
  git(clean, ['-c', 'user.name=t', '-c', 'user.email=t@t.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  assert.equal(reviewer.snapshotDirtyChanges(clean).trim(), '');
});

// --- validateRunReviewArgs ---------------------------------------------------

test('validateRunReviewArgs requires an existing directory', () => {
  const res = reviewer.validateRunReviewArgs({ cwd: join(runtimeDir, 'does-not-exist'), headRef: 'feature' });
  assert.equal(res.ok, false);
  assert.match(res.error, /existing directory/);
});

test('validateRunReviewArgs requires cwd to be a git repository', () => {
  const notARepo = join(runtimeDir, 'not-a-repo');
  mkdirSync(notARepo, { recursive: true });
  const res = reviewer.validateRunReviewArgs({ cwd: notARepo, headRef: 'feature' });
  assert.equal(res.ok, false);
  assert.match(res.error, /git repository/);
});

test('validateRunReviewArgs requires at least one of number/headRef/includeUncommitted', () => {
  const res = reviewer.validateRunReviewArgs({ cwd: repo });
  assert.equal(res.ok, false);
  assert.match(res.error, /number, headRef, or includeUncommitted/);
});

test('validateRunReviewArgs: number wins outright over headRef/includeUncommitted (PR mode first)', () => {
  const res = reviewer.validateRunReviewArgs({ cwd: repo, number: 42, headRef: 'feature', includeUncommitted: true });
  assert.equal(res.ok, true);
  assert.equal(res.value.mode, 'pr');
  assert.equal(res.value.number, 42);
});

test('validateRunReviewArgs: headRef wins over includeUncommitted when number is absent', () => {
  const res = reviewer.validateRunReviewArgs({ cwd: repo, headRef: 'feature', includeUncommitted: true });
  assert.equal(res.ok, true);
  assert.equal(res.value.mode, 'branch');
  assert.equal(res.value.headRef, 'feature');
});

test('validateRunReviewArgs: includeUncommitted alone selects dirty mode', () => {
  const res = reviewer.validateRunReviewArgs({ cwd: repo, includeUncommitted: true });
  assert.equal(res.ok, true);
  assert.equal(res.value.mode, 'dirty');
});

test('validateRunReviewArgs: app falls back to claude for an unrecognized value; model/requestedBy default sanely', () => {
  const res = reviewer.validateRunReviewArgs({ cwd: repo, headRef: 'feature', app: 'not-a-real-app' });
  assert.equal(res.ok, true);
  assert.equal(res.value.app, 'claude');
  assert.equal(res.value.model, null);
  assert.equal(res.value.requestedBy, 'reviewer');
});

test('validateRunReviewArgs: focus defaults to null and is trimmed when given', () => {
  const absent = reviewer.validateRunReviewArgs({ cwd: repo, headRef: 'feature' });
  assert.equal(absent.value.focus, null);

  const trimmed = reviewer.validateRunReviewArgs({ cwd: repo, headRef: 'feature', focus: '  security please  ' });
  assert.equal(trimmed.value.focus, 'security please');

  // whitespace-only / non-string input is treated the same as omitting it
  // (see baseRef/model's same "empty string -> null" normalization).
  const blank = reviewer.validateRunReviewArgs({ cwd: repo, headRef: 'feature', focus: '   ' });
  assert.equal(blank.value.focus, null);
  const wrongType = reviewer.validateRunReviewArgs({ cwd: repo, headRef: 'feature', focus: 123 });
  assert.equal(wrongType.value.focus, null);
});

// --- buildReviewPrompt -------------------------------------------------------

test('buildReviewPrompt: no focus leaves each mode\'s base prompt untouched, but the finish_review instruction is always appended', () => {
  const pr = reviewer.buildReviewPrompt({ mode: 'pr', number: 42, jobId: 'job-1' });
  assert.ok(pr.startsWith('gh pr checkout 42 && /code-review --comment\n\n'));
  assert.doesNotMatch(pr, /Focus especially on/);
  assert.match(pr, /mcp__ccserver-reviewer__finish_review tool with jobId="job-1"/);

  const dirty = reviewer.buildReviewPrompt({ mode: 'dirty', jobId: 'job-2' });
  assert.ok(dirty.startsWith('/code-review\n\n'));
  assert.match(dirty, /mcp__ccserver-reviewer__finish_review tool with jobId="job-2"/);

  const branch = reviewer.buildReviewPrompt({ mode: 'branch', baseRef: 'origin/master', jobId: 'job-3' });
  assert.ok(branch.startsWith('/code-review origin/master\n\n'));
  assert.match(branch, /mcp__ccserver-reviewer__finish_review tool with jobId="job-3"/);
});

test('buildReviewPrompt: a focus is appended to every mode\'s prompt, before the finish_review instruction', () => {
  const focus = 'セキュリティ面を重点的に見てください';
  for (const args of [
    { mode: 'pr', number: 42 },
    { mode: 'dirty' },
    { mode: 'branch', baseRef: 'origin/master' },
  ]) {
    const withoutFocus = reviewer.buildReviewPrompt({ ...args, jobId: 'job-x' });
    const withFocus = reviewer.buildReviewPrompt({ ...args, focus, jobId: 'job-x' });
    const focusLine = `Focus especially on: ${focus}`;
    assert.ok(withFocus.includes(focusLine), `expected focus line in: ${withFocus}`);
    // focus is inserted between the base command and the finish_review
    // instruction, not appended after it.
    assert.ok(
      withFocus.indexOf(focusLine) < withFocus.indexOf('finish_review'),
      'focus must come before the finish_review instruction',
    );
    // everything else about the prompt is unchanged by adding focus.
    assert.equal(withFocus.replace(`\n\n${focusLine}`, ''), withoutFocus);
  }
});

test('buildReviewPrompt: the finish_review instruction carries the exact jobId runReview generated', () => {
  const prompt = reviewer.buildReviewPrompt({ mode: 'dirty', jobId: 'a1b2c3' });
  assert.match(prompt, /jobId="a1b2c3"/);
});

// --- SQLite CRUD (pr_reviews, db.js v6) -------------------------------------

test('getReview / listReviews read back what was inserted', () => {
  const db = dbMod.getDb();
  db.prepare(`INSERT INTO pr_reviews
      (id, project_cwd, base_ref, head_ref, resolved_ref, mode, app, model, status, session_id, worktree_path, requested_by, focus, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('rev-1', repo, 'main', 'feature', 'deadbeef', 'branch', 'claude', null, 'running', 'sess-1', '/tmp/wt', 'tester', 'security please', 1000);

  const got = reviewer.getReview({ id: 'rev-1' });
  assert.equal(got.ok, true);
  assert.equal(got.review.id, 'rev-1');
  assert.equal(got.review.projectCwd, repo);
  assert.equal(got.review.mode, 'branch');
  assert.equal(got.review.postedToPr, false);
  assert.equal(got.review.focus, 'security please');

  const missing = reviewer.getReview({ id: 'no-such-id' });
  assert.equal(missing.ok, false);

  const listed = reviewer.listReviews({ cwd: repo });
  assert.equal(listed.ok, true);
  assert.ok(listed.reviews.some((r) => r.id === 'rev-1'));

  const listedElsewhere = reviewer.listReviews({ cwd: '/nowhere' });
  assert.equal(listedElsewhere.reviews.length, 0);
});

test('getReview: focus is null when the job was created without one', () => {
  const db = dbMod.getDb();
  db.prepare(`INSERT INTO pr_reviews
      (id, project_cwd, base_ref, head_ref, mode, app, status, created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
    .run('rev-no-focus', repo, 'main', 'feature', 'branch', 'claude', 'running', 1000);

  const got = reviewer.getReview({ id: 'rev-no-focus' });
  assert.equal(got.ok, true);
  assert.equal(got.review.focus, null);
});

// --- finish_review / completion fallback (issue #103 follow-up) -------------

// Inserts a fake "running" job row directly (bypassing runReview's whole
// worktree/session-launch machinery, same as the SQLite CRUD tests above) so
// finish_review/checkCompletion can be exercised against a known jobId +
// sessionId without a real agent CLI. mode is always 'branch' with no PR
// number, so completeReviewJob's checkPrCommentPosted step is a no-op (skips
// needing a real `gh`).
function insertRunningJob(id, { sessionId = 'sess-owner', createdAt = Date.now() } = {}) {
  dbMod.getDb().prepare(`INSERT INTO pr_reviews
      (id, project_cwd, base_ref, head_ref, mode, app, status, session_id, worktree_path, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, repo, 'main', 'feature', 'branch', 'claude', 'running', sessionId, reviewer.reviewWorktreePath(repo, id), createdAt);
}

test('finishReview: the job\'s own session can mark it done, with the caller\'s summary recorded', async () => {
  insertRunningJob('job-finish-ok');
  const res = await reviewer.finishReview({ jobId: 'job-finish-ok', status: 'done', summary: 'looks good', callerSessionId: 'sess-owner' });
  assert.deepEqual(res, { ok: true, id: 'job-finish-ok', status: 'done' });

  const got = reviewer.getReview({ id: 'job-finish-ok' });
  assert.equal(got.review.status, 'done');
  assert.equal(got.review.resultSummary, 'looks good');
  assert.ok(got.review.finishedAt);
});

test('finishReview: rejects an unknown jobId', async () => {
  const res = await reviewer.finishReview({ jobId: 'no-such-job', status: 'done', callerSessionId: 'anyone' });
  assert.deepEqual(res, { ok: false, error: 'not-found' });
});

test('finishReview: rejects a caller whose sessionId does not match the job\'s own session', async () => {
  insertRunningJob('job-finish-wrong-session', { sessionId: 'sess-owner-2' });
  const res = await reviewer.finishReview({ jobId: 'job-finish-wrong-session', status: 'done', callerSessionId: 'sess-imposter' });
  assert.equal(res.ok, false);
  assert.match(res.error, /not authorized/);

  // the job is untouched -- still running, no DB update happened.
  const got = reviewer.getReview({ id: 'job-finish-wrong-session' });
  assert.equal(got.review.status, 'running');
});

test('finishReview: rejects a call with no identity frame at all (callerSessionId null)', async () => {
  insertRunningJob('job-finish-no-identity', { sessionId: 'sess-owner-3' });
  const res = await reviewer.finishReview({ jobId: 'job-finish-no-identity', status: 'done', callerSessionId: null });
  assert.equal(res.ok, false);
  assert.match(res.error, /not authorized/);
});

test('finishReview: rejects a job that is already finished', async () => {
  insertRunningJob('job-finish-twice', { sessionId: 'sess-owner-4' });
  const first = await reviewer.finishReview({ jobId: 'job-finish-twice', status: 'done', callerSessionId: 'sess-owner-4' });
  assert.equal(first.ok, true);

  const second = await reviewer.finishReview({ jobId: 'job-finish-twice', status: 'failed', callerSessionId: 'sess-owner-4' });
  assert.equal(second.ok, false);
  assert.match(second.error, /already done, not running/);
});

test('finishReview: rejects an invalid status value', async () => {
  insertRunningJob('job-finish-bad-status', { sessionId: 'sess-owner-5' });
  const res = await reviewer.finishReview({ jobId: 'job-finish-bad-status', status: 'running', callerSessionId: 'sess-owner-5' });
  assert.equal(res.ok, false);
  assert.match(res.error, /"done" or "failed"/);
});

test('checkCompletion fallback: a session that exited before calling finish_review is marked failed', async () => {
  // No real session with this id was ever created -- sessionManager.getSession
  // returns undefined for it, which checkCompletion treats the same as an
  // exited session (see its `exited = !session || session.exited`).
  insertRunningJob('job-fallback-exited', { sessionId: 'sess-never-existed' });
  await reviewer.checkCompletion({
    jobId: 'job-fallback-exited', sessionId: 'sess-never-existed', projectCwd: repo, number: null, startedAt: Date.now(),
  });
  const got = reviewer.getReview({ id: 'job-fallback-exited' });
  assert.equal(got.review.status, 'failed');
  assert.match(got.review.resultSummary, /exited before calling finish_review/);
});

test('checkCompletion fallback: a live session that never calls finish_review times out after ABSOLUTE_TIMEOUT_MS', async () => {
  // A real (shell, no agent CLI needed) session so `exited` is false and the
  // timeout branch specifically is what fires -- not the exited one above.
  const shell = sessionManagerMod.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  assert.ok(shell.session, 'sanity: the shell session actually spawned');
  insertRunningJob('job-fallback-timeout', { sessionId: shell.sessionId });
  try {
    await reviewer.checkCompletion({
      jobId: 'job-fallback-timeout',
      sessionId: shell.sessionId,
      projectCwd: repo,
      number: null,
      // Far enough in the past that "elapsed >= ABSOLUTE_TIMEOUT_MS" is true
      // without waiting 20 real minutes.
      startedAt: Date.now() - reviewer.ABSOLUTE_TIMEOUT_MS - 1000,
    });
    const got = reviewer.getReview({ id: 'job-fallback-timeout' });
    assert.equal(got.review.status, 'timeout');
    assert.match(got.review.resultSummary, /timed out .* without calling finish_review/);
    // completeReviewJob destroys the (still-live) session as part of cleanup.
    assert.equal(sessionManagerMod.getSession(shell.sessionId), undefined);
  } finally {
    // best effort in case the assertion above is what failed
    sessionManagerMod.destroySession(shell.sessionId, { keepSchedule: false });
  }
});

test('checkCompletion fallback: does nothing while a job is neither exited nor past the timeout', async () => {
  const shell = sessionManagerMod.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  assert.ok(shell.session);
  insertRunningJob('job-fallback-still-running', { sessionId: shell.sessionId });
  try {
    await reviewer.checkCompletion({
      jobId: 'job-fallback-still-running', sessionId: shell.sessionId, projectCwd: repo, number: null, startedAt: Date.now(),
    });
    const got = reviewer.getReview({ id: 'job-fallback-still-running' });
    assert.equal(got.review.status, 'running', 'still running -- finish_review is the expected next step, not a fallback guess');
  } finally {
    sessionManagerMod.destroySession(shell.sessionId, { keepSchedule: false });
  }
});

// --- completion notification (issue #102 plan section 3.6.1) ----------------

// Regression for the self-review fix closing completingJobs' unbounded
// growth (it used to never be deleted once added -- one leaked UUID per
// completed job, forever, for the life of the process). Racing finish_review
// against an overdue fallback tick for the SAME job also exercises
// completingJobs' actual purpose (only one of the two may run the real
// cleanup) -- finish_review's explicit result is structurally guaranteed to
// win: it reaches completeReviewJob's synchronous completingJobs.add() with
// no `await` in between, while checkCompletion must await loadSessionDeps()
// first, so finish_review's claim always lands before checkCompletion's own
// completeReviewJob call can even check the Set.
test('completeReviewJob: a finish_review vs fallback-poller race is won by finish_review, and completingJobs is not leaked', async () => {
  const shell = sessionManagerMod.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  assert.ok(shell.session);
  insertRunningJob('job-race', { sessionId: shell.sessionId });
  const before = reviewer._completingJobsSizeForTests();
  try {
    const [finishRes] = await Promise.all([
      reviewer.finishReview({ jobId: 'job-race', status: 'done', summary: 'race winner', callerSessionId: shell.sessionId }),
      reviewer.checkCompletion({
        jobId: 'job-race',
        sessionId: shell.sessionId,
        projectCwd: repo,
        number: null,
        startedAt: Date.now() - reviewer.ABSOLUTE_TIMEOUT_MS - 1000,
      }),
    ]);
    assert.equal(finishRes.ok, true);
    const got = reviewer.getReview({ id: 'job-race' });
    assert.equal(got.review.status, 'done', "finish_review's explicit result must win, not the fallback poller's timeout guess");
    assert.equal(got.review.resultSummary, 'race winner');
    assert.equal(
      reviewer._completingJobsSizeForTests(),
      before,
      'the job\'s completingJobs entry must be reclaimed after cleanup, not leaked for the life of the process',
    );
  } finally {
    sessionManagerMod.destroySession(shell.sessionId, { keepSchedule: false });
  }
});

test('reviewNotificationTitle: PR mode uses owner/repo#number, prefixed by status', () => {
  const review = { mode: 'pr', prOwner: 'acme', prRepo: 'widgets', prNumber: 42 };
  assert.equal(reviewer.reviewNotificationTitle(review, 'done'), 'Review done: acme/widgets#42');
  assert.equal(reviewer.reviewNotificationTitle(review, 'failed'), 'Review failed: acme/widgets#42');
  assert.equal(reviewer.reviewNotificationTitle(review, 'timeout'), 'Review timed out: acme/widgets#42');
});

test('reviewNotificationTitle: PR mode falls back to "PR #N" when owner/repo could not be resolved', () => {
  const review = { mode: 'pr', prOwner: null, prRepo: null, prNumber: 7 };
  assert.equal(reviewer.reviewNotificationTitle(review, 'done'), 'Review done: PR #7');
});

test('reviewNotificationTitle: branch mode names the headRef, with the project basename in parens', () => {
  const review = { mode: 'branch', headRef: 'feature/x', projectCwd: '/srv/my-repo' };
  assert.equal(reviewer.reviewNotificationTitle(review, 'done'), 'Review done: feature/x (my-repo)');
});

test('reviewNotificationTitle: dirty mode names "uncommitted changes"', () => {
  const review = { mode: 'dirty', headRef: null, projectCwd: '/srv/my-repo' };
  assert.equal(reviewer.reviewNotificationTitle(review, 'failed'), 'Review failed: uncommitted changes (my-repo)');
});

test('reviewNotificationTitle: no projectCwd -> no trailing parens', () => {
  const review = { mode: 'branch', headRef: 'feature/x', projectCwd: null };
  assert.equal(reviewer.reviewNotificationTitle(review, 'done'), 'Review done: feature/x');
});

test('reviewNotificationBody: includes status, an optional focus line, and mode-specific PR/get_review guidance', () => {
  const withFocus = reviewer.reviewNotificationBody(
    { id: 'job-1', mode: 'pr', focus: 'security' },
    { status: 'done', postedToPr: true },
  );
  assert.match(withFocus, /^status: done$/m);
  assert.match(withFocus, /^focus: security$/m);
  assert.match(withFocus, /Posted as a PR comment\./);

  const noFocusNotPosted = reviewer.reviewNotificationBody(
    { id: 'job-2', mode: 'pr', focus: null },
    { status: 'failed', postedToPr: false },
  );
  assert.doesNotMatch(noFocusNotPosted, /^focus:/m);
  assert.match(noFocusNotPosted, /Not posted as a PR comment/);

  const branchMode = reviewer.reviewNotificationBody(
    { id: 'job-3', mode: 'branch', focus: null },
    { status: 'timeout', postedToPr: false },
  );
  assert.match(branchMode, /get_review\(\{ id: "job-3" \}\)/);
});

// End-to-end: completeReviewJob (reached here via finish_review) actually
// calls notify.js's sendNotification -- not just that the pure title/body
// builders above produce the right text. Mocks global.fetch the same way
// notify.test.js does (an ESM static-import binding for sendNotification
// itself can't be swapped from outside the module, but fetch is a plain
// global). This is exactly the wiring the original issue-#102 plan called
// for and that went unimplemented (and unnoticed across three self-review
// rounds) until this follow-up.
test('completeReviewJob sends a ccserver-notify notification with the PR/focus/postedToPr details baked in', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-reviewer-notify-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ notify: { discordWebhook: 'https://discord.example/hook' } }));
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  const prevWebhook = process.env.CCSERVER_DISCORD_WEBHOOK;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  delete process.env.CCSERVER_DISCORD_WEBHOOK;

  const notify = await import('./notify.js');
  notify.restoreNotify();

  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return { ok: true };
  };

  dbMod.getDb().prepare(`INSERT INTO pr_reviews
      (id, project_cwd, base_ref, mode, pr_owner, pr_repo, pr_number, app, status, session_id, worktree_path, focus, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      'job-notify-pr', repo, 'main', 'pr', 'acme', 'widgets', 42, 'claude', 'running',
      'sess-notify-1', reviewer.reviewWorktreePath(repo, 'job-notify-pr'), 'security', Date.now(),
    );

  try {
    const res = await reviewer.finishReview({ jobId: 'job-notify-pr', status: 'done', callerSessionId: 'sess-notify-1' });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1, 'exactly one notification delivery attempt (the discord webhook)');
    const payload = JSON.parse(calls[0].opts.body);
    assert.ok(payload.content.startsWith('✅ Review done: acme/widgets#42'), payload.content);
    assert.ok(payload.content.includes('focus: security'), payload.content);
    // no real gh CLI session/auth for this fake "acme/widgets" repo in the
    // test env -> checkPrCommentPosted fails closed to false either way.
    assert.ok(payload.content.includes('Not posted as a PR comment'), payload.content);
  } finally {
    global.fetch = realFetch;
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    if (prevWebhook === undefined) delete process.env.CCSERVER_DISCORD_WEBHOOK;
    else process.env.CCSERVER_DISCORD_WEBHOOK = prevWebhook;
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// --- injection decision ------------------------------------------------------

test('shouldInjectReviewer excludes shells and copilot but allows any other app regardless of groupRole', () => {
  assert.equal(reviewer.shouldInjectReviewer({ shell: true, app: null, reviewerEnabled: true }), false);
  assert.equal(reviewer.shouldInjectReviewer({ shell: false, app: 'copilot', reviewerEnabled: true }), false);
  assert.equal(reviewer.shouldInjectReviewer({ shell: false, app: 'commandcode', reviewerEnabled: true }), false);
  assert.equal(reviewer.shouldInjectReviewer({ shell: false, app: 'claude', reviewerEnabled: false }), false);
  assert.equal(reviewer.shouldInjectReviewer({ shell: false, app: 'claude', reviewerEnabled: true }), true);
});
