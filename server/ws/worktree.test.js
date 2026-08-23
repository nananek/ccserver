// Tests for worktree.js's resolveMemberWorktree/removeMemberWorktree/
// listWorktreeDirs against a real throwaway git repo (git worktree
// operations are cheap and local -- no network, no bwrap). Covers the
// idempotent-resolve contract from plan sections 2.3/2.8/3.2/3.6.1:
//   - non-git cwd falls back to sharing it as-is
//   - first-time creation is detached (no branch)
//   - a healthy worktree is reused untouched (including a branch the agent
//     itself checked out)
//   - a worktree lost from disk is recreated -- reattached to its branch if
//     it survives (lostWork:true), or freshly detached if not
//   - removeMemberWorktree is a no-op success for a non-git cwd / missing
//     worktree, and never --force's a removal blocked by local changes

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let runtimeDir;
let repo;
let worktree;

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
}

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-worktree-test-'));
  process.env.CCSERVER_WORKTREE_ROOT = join(runtimeDir, 'worktrees');
  worktree = await import('./worktree.js');

  repo = join(runtimeDir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
});

after(() => {
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('resolveMemberWorktree falls back to sharing cwd when it is not a git repo', () => {
  const res = worktree.resolveMemberWorktree(join(runtimeDir, 'not-a-repo'), 'workerA');
  assert.deepEqual(res, { usedWorktree: false, cwd: join(runtimeDir, 'not-a-repo'), gitCommonDir: null });
});

test('resolveMemberWorktree: first-time creation is a fresh detached worktree', () => {
  const res = worktree.resolveMemberWorktree(repo, 'workerA');
  assert.equal(res.usedWorktree, true);
  assert.equal(res.created, true);
  assert.equal(res.lostWork, false);
  assert.equal(res.branch, null);
  assert.equal(res.cwd, worktree.worktreePathFor(repo, 'workerA'));
  assert.ok(existsSync(res.cwd));
  assert.ok(res.gitCommonDir && existsSync(res.gitCommonDir));
});

test('resolveMemberWorktree: removes an empty target left by an interrupted setup', () => {
  const path = worktree.worktreePathFor(repo, 'worker-stale');
  mkdirSync(path, { recursive: true });
  const res = worktree.resolveMemberWorktree(repo, 'worker-stale');
  assert.equal(res.usedWorktree, true);
  assert.equal(res.created, true);
  assert.ok(existsSync(res.cwd));
});

test('resolveMemberWorktree: reuses an existing healthy worktree untouched', () => {
  const first = worktree.resolveMemberWorktree(repo, 'workerB');
  writeFileSync(join(first.cwd, 'scratch.txt'), 'untouched marker');
  const second = worktree.resolveMemberWorktree(repo, 'workerB');
  assert.equal(second.created, false);
  assert.equal(second.cwd, first.cwd);
  assert.ok(existsSync(join(second.cwd, 'scratch.txt')), 'reuse does not wipe the worktree');
});

test('resolveMemberWorktree: reuse reflects a branch the agent checked out itself', () => {
  const res = worktree.resolveMemberWorktree(repo, 'workerC');
  git(res.cwd, ['checkout', '-q', '-b', 'feature/agent-branch']);
  const reused = worktree.resolveMemberWorktree(repo, 'workerC');
  assert.equal(reused.created, false);
  assert.equal(reused.lostWork, false);
  assert.equal(reused.branch, 'feature/agent-branch');
});

test('resolveMemberWorktree: disk loss with a surviving branch is reattached (lostWork:true)', () => {
  const res = worktree.resolveMemberWorktree(repo, 'workerD');
  git(res.cwd, ['checkout', '-q', '-b', 'feature/survives']);
  rmSync(res.cwd, { recursive: true, force: true }); // simulate a crash / manual rm -- prunable now

  const recreated = worktree.resolveMemberWorktree(repo, 'workerD');
  assert.equal(recreated.created, true);
  assert.equal(recreated.lostWork, true, 'uncommitted worktree state was lost even though the branch survived');
  assert.equal(recreated.branch, 'feature/survives');
  assert.ok(existsSync(recreated.cwd));
});

test('resolveMemberWorktree: disk loss with the branch also gone falls back to a fresh detached worktree', () => {
  const res = worktree.resolveMemberWorktree(repo, 'workerE');
  git(res.cwd, ['checkout', '-q', '-b', 'feature/also-gone']);
  rmSync(res.cwd, { recursive: true, force: true });
  git(repo, ['worktree', 'prune']);
  git(repo, ['branch', '-D', 'feature/also-gone']);

  const recreated = worktree.resolveMemberWorktree(repo, 'workerE');
  assert.equal(recreated.created, true);
  assert.equal(recreated.lostWork, false, 'the resolver never observed the branch, so it cannot flag its loss');
  assert.equal(recreated.branch, null);
});

test('removeMemberWorktree removes a clean worktree and is idempotent', () => {
  const res = worktree.resolveMemberWorktree(repo, 'workerF');
  assert.equal(worktree.removeMemberWorktree(repo, 'workerF'), true);
  assert.ok(!existsSync(res.cwd));
  // Second call: nothing left to remove -- still reports success.
  assert.equal(worktree.removeMemberWorktree(repo, 'workerF'), true);
});

test('removeMemberWorktree is a no-op success for a non-git cwd', () => {
  assert.equal(worktree.removeMemberWorktree(join(runtimeDir, 'not-a-repo'), 'workerA'), true);
});

test('removeMemberWorktree fails (never --force) when uncommitted changes block it, leaving the directory intact', () => {
  const res = worktree.resolveMemberWorktree(repo, 'workerG');
  writeFileSync(join(res.cwd, 'dirty.txt'), 'uncommitted change');
  assert.equal(worktree.removeMemberWorktree(repo, 'workerG'), false);
  assert.ok(existsSync(join(res.cwd, 'dirty.txt')), 'the directory and its uncommitted change survive the failed removal');
});

test('listWorktreeDirs reports every <projectHash>/<role> directory created so far', () => {
  worktree.resolveMemberWorktree(repo, 'workerZ');
  const dirs = worktree.listWorktreeDirs();
  assert.ok(dirs.includes(worktree.worktreePathFor(repo, 'workerZ')));
});
