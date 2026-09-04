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

// --- SQLite CRUD (pr_reviews, db.js v6) -------------------------------------

test('getReview / listReviews read back what was inserted', () => {
  const db = dbMod.getDb();
  db.prepare(`INSERT INTO pr_reviews
      (id, project_cwd, base_ref, head_ref, resolved_ref, mode, app, model, status, session_id, worktree_path, requested_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('rev-1', repo, 'main', 'feature', 'deadbeef', 'branch', 'claude', null, 'running', 'sess-1', '/tmp/wt', 'tester', 1000);

  const got = reviewer.getReview({ id: 'rev-1' });
  assert.equal(got.ok, true);
  assert.equal(got.review.id, 'rev-1');
  assert.equal(got.review.projectCwd, repo);
  assert.equal(got.review.mode, 'branch');
  assert.equal(got.review.postedToPr, false);

  const missing = reviewer.getReview({ id: 'no-such-id' });
  assert.equal(missing.ok, false);

  const listed = reviewer.listReviews({ cwd: repo });
  assert.equal(listed.ok, true);
  assert.ok(listed.reviews.some((r) => r.id === 'rev-1'));

  const listedElsewhere = reviewer.listReviews({ cwd: '/nowhere' });
  assert.equal(listedElsewhere.reviews.length, 0);
});

// --- injection decision ------------------------------------------------------

test('shouldInjectReviewer excludes shells and copilot but allows any other app regardless of groupRole', () => {
  assert.equal(reviewer.shouldInjectReviewer({ shell: true, app: null, reviewerEnabled: true }), false);
  assert.equal(reviewer.shouldInjectReviewer({ shell: false, app: 'copilot', reviewerEnabled: true }), false);
  assert.equal(reviewer.shouldInjectReviewer({ shell: false, app: 'claude', reviewerEnabled: false }), false);
  assert.equal(reviewer.shouldInjectReviewer({ shell: false, app: 'claude', reviewerEnabled: true }), true);
});
