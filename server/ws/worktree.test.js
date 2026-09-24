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
//   - recreation only ever unregisters this worktree's own entry, never
//     other sessions' registrations in the shared repo (issue #224)
//   - removeMemberWorktree is a no-op success for a non-git cwd / missing
//     worktree, and never --force's a removal blocked by local changes

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('resolveMemberWorktree: recovers when the worktree admin dir is gone but the checkout survives', () => {
  const first = worktree.resolveMemberWorktree(repo, 'worker-orphaned');
  writeFileSync(join(first.cwd, 'scratch.txt'), 'about to be lost');
  // Simulate external interference that deletes just the git-side admin dir
  // (.git/worktrees/<role>) while leaving the checkout's files on disk --
  // e.g. a stray `rm -rf` of .git/worktrees, or a `git worktree remove` run
  // against a stale/relocated project path. The checkout's `.git` gitlink
  // is now dangling: `git worktree add` would otherwise fail forever with
  // "already exists" against this non-empty, unrecognizable directory.
  rmSync(join(repo, '.git', 'worktrees', 'worker-orphaned'), { recursive: true, force: true });

  const recreated = worktree.resolveMemberWorktree(repo, 'worker-orphaned');
  assert.equal(recreated.usedWorktree, true);
  assert.equal(recreated.created, true);
  assert.ok(existsSync(recreated.cwd));
  assert.ok(!existsSync(join(recreated.cwd, 'scratch.txt')), 'dead checkout was discarded, not reused');
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

test("resolveMemberWorktree: recreating a lost worktree leaves other sessions' registrations alone (#224)", () => {
  // Two other sessions' worktrees sharing this repo. Their directories are
  // moved aside so this process cannot see them -- exactly the state a
  // sandbox is in for every worktree but its own (only its role's checkout
  // is bind-mounted), where all of them look "prunable" to git and a bare
  // `git worktree prune` unregisters them for real.
  const siblingA = worktree.worktreePathFor(repo, 'siblingA');
  const siblingB = worktree.worktreePathFor(repo, 'siblingB');
  worktree.resolveMemberWorktree(repo, 'siblingA');
  worktree.resolveMemberWorktree(repo, 'siblingB');
  const hiddenA = `${siblingA}.hidden`;
  const hiddenB = `${siblingB}.hidden`;
  renameSync(siblingA, hiddenA);
  renameSync(siblingB, hiddenB);

  // This role's own registration is stale (its checkout directory is gone),
  // which used to trigger `git worktree prune` before recreating it.
  const first = worktree.resolveMemberWorktree(repo, 'workerH');
  rmSync(first.cwd, { recursive: true, force: true });
  const recreated = worktree.resolveMemberWorktree(repo, 'workerH');
  assert.equal(recreated.created, true);

  // The siblings' registrations must survive, so simply putting their
  // directories back makes their checkouts usable again.
  const listed = git(repo, ['worktree', 'list', '--porcelain']);
  assert.ok(listed.includes(`worktree ${siblingA}`), "sibling A's registration must survive");
  assert.ok(listed.includes(`worktree ${siblingB}`), "sibling B's registration must survive");
  renameSync(hiddenA, siblingA);
  renameSync(hiddenB, siblingB);
  assert.equal(git(siblingA, ['rev-parse', '--is-inside-work-tree']).trim(), 'true', 'sibling A works again');
  assert.equal(git(siblingB, ['rev-parse', '--is-inside-work-tree']).trim(), 'true', 'sibling B works again');
});

test('resolveMemberWorktree: recreates a lost worktree when the worktree root is a symlink', () => {
  // git records/prints worktree paths as realpaths, while worktreePathFor()
  // builds a lexical path from CCSERVER_WORKTREE_ROOT (or $HOME). A root
  // that sits behind a symlink (macOS tmpdir /var -> /private/var, a
  // symlinked $HOME, or an operator's CCSERVER_WORKTREE_ROOT) must still
  // line up, or the stale-registration lookup and removal both miss and
  // recreation wedges forever with "missing but already registered
  // worktree".
  const realRoot = join(runtimeDir, 'worktrees-real');
  const linkRoot = join(runtimeDir, 'worktrees-link');
  mkdirSync(realRoot, { recursive: true });
  symlinkSync(realRoot, linkRoot, 'dir');
  const prev = process.env.CCSERVER_WORKTREE_ROOT;
  process.env.CCSERVER_WORKTREE_ROOT = linkRoot;
  try {
    const first = worktree.resolveMemberWorktree(repo, 'workerSymRoot');
    assert.equal(first.created, true);
    rmSync(first.cwd, { recursive: true, force: true }); // disk loss -- prunable now

    const recreated = worktree.resolveMemberWorktree(repo, 'workerSymRoot');
    assert.equal(recreated.created, true, 'symlink spelling must still match the recorded realpath');
    assert.equal(recreated.cwd, first.cwd);
    assert.equal(git(recreated.cwd, ['rev-parse', '--is-inside-work-tree']).trim(), 'true', 'checkout is usable again');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_WORKTREE_ROOT;
    else process.env.CCSERVER_WORKTREE_ROOT = prev;
  }
});

test('resolveMemberWorktree: recovers an orphaned checkout when the project path is a symlink', () => {
  // Same realpath-vs-lexical split, but on the project side: the dangling
  // gitlink's admin dir is under the *real* project's .git/worktrees while
  // commonDirOfProject() returns the lexical (symlinked) spelling, so the
  // dead-checkout containment check must canonicalize both sides or the
  // role can never be relaunched into its own path.
  const realRepo = join(runtimeDir, 'symproj-real');
  const linkRepo = join(runtimeDir, 'symproj-link');
  mkdirSync(realRepo, { recursive: true });
  git(realRepo, ['init', '-q']);
  git(realRepo, ['-c', 'user.name=t', '-c', 'user.email=t@t.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  symlinkSync(realRepo, linkRepo, 'dir');

  const first = worktree.resolveMemberWorktree(linkRepo, 'workerSymProj');
  writeFileSync(join(first.cwd, 'scratch.txt'), 'about to be discarded');
  // External interference: admin dir deleted, checkout survives with a
  // dangling .git gitlink (exactly the worker-orphaned scenario above).
  const adminRoot = join(realRepo, '.git', 'worktrees');
  for (const name of readdirSync(adminRoot)) rmSync(join(adminRoot, name), { recursive: true, force: true });

  const recreated = worktree.resolveMemberWorktree(linkRepo, 'workerSymProj');
  assert.equal(recreated.created, true, 'the dead checkout must be recognized as this project\'s own and replaced');
  assert.ok(!existsSync(join(recreated.cwd, 'scratch.txt')), 'dead checkout was discarded, not reused');
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

// --- M1 defense-in-depth (vuln_scan report / PoC p9) ------------------------

test('worktreePathFor throws for a role that would escape the worktree root', () => {
  for (const bad of ['../../../escape', 'a/../../../evil2', '../sibling', 'a/../..']) {
    assert.throws(
      () => worktree.worktreePathFor(repo, bad),
      /escapes the project's worktree directory/,
      `${bad} must be rejected`,
    );
  }
});

test('worktreePathFor still resolves an ordinary role normally, inside the configured root', () => {
  const path = worktree.worktreePathFor(repo, 'workerA');
  assert.ok(path.startsWith(`${worktree.worktreeRoot()}/`), 'stays under CCSERVER_WORKTREE_ROOT');
  assert.ok(path.endsWith('/workerA'), 'ends in the role name, unmodified');
});

test('resolveMemberWorktree propagates the escape rejection instead of creating anything outside the root', () => {
  assert.throws(() => worktree.resolveMemberWorktree(repo, '../../../escape'), /escapes the project's worktree directory/);
  assert.equal(existsSync(join(runtimeDir, 'escape')), false, 'nothing was created outside CCSERVER_WORKTREE_ROOT');
});

// --- hostile shared-metadata bounds (attacker view of issue #224) -----------
//
// Every sandboxed session sharing this repo can write the project's .git
// (sandbox.js rw-binds the common dir), so <admin>/gitdir and a worktree's
// .git must be treated as untrusted input: a FIFO there used to make git
// (and the hand-rolled readFileSync scan) block the server's event loop
// forever. Both tests run with a short git timeout override so the bound is
// observable without the 30s production default.

test('resolveMemberWorktree: a FIFO in .git/worktrees is bounded by the git timeout, not an event-loop hang', (t) => {
  const fifoEntry = join(repo, '.git', 'worktrees', 'evil-fifo');
  try {
    mkdirSync(fifoEntry, { recursive: true });
    execFileSync('mkfifo', [join(fifoEntry, 'gitdir')]);
  } catch {
    rmSync(fifoEntry, { recursive: true, force: true });
    t.skip('mkfifo unavailable');
    return;
  }
  const prev = process.env.CCSERVER_WORKTREE_GIT_TIMEOUT_MS;
  process.env.CCSERVER_WORKTREE_GIT_TIMEOUT_MS = '500';
  const path = worktree.worktreePathFor(repo, 'workerFifo');
  try {
    const started = Date.now();
    let threw = false;
    try { worktree.resolveMemberWorktree(repo, 'workerFifo'); } catch { threw = true; }
    const elapsed = Date.now() - started;
    // git list/add both hang on the FIFO; the timeout turns that into a
    // (fail-closed) refusal within a second or two instead of a frozen
    // process.
    assert.ok(elapsed < 5000, `resolve must be bounded by the git timeout (took ${elapsed}ms, threw=${threw})`);
    assert.ok(existsSync(fifoEntry), 'the hostile entry is left in place');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_WORKTREE_GIT_TIMEOUT_MS;
    else process.env.CCSERVER_WORKTREE_GIT_TIMEOUT_MS = prev;
    rmSync(fifoEntry, { recursive: true, force: true });
    rmSync(path, { recursive: true, force: true });
  }
});

test("resolveMemberWorktree: a FIFO at a role checkout's .git cannot block the metadata read", (t) => {
  // This one is read directly (worktreeGitdirTarget), not through git, so it
  // pins readGitdirFile's O_NONBLOCK/fstat guard independently of the git
  // timeout: a plain readFileSync would block forever on the FIFO.
  const path = worktree.worktreePathFor(repo, 'workerFifoGit');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'keep.txt'), 'stale non-empty dir');
  try {
    execFileSync('mkfifo', [join(path, '.git')]);
  } catch {
    rmSync(path, { recursive: true, force: true });
    t.skip('mkfifo unavailable');
    return;
  }
  const prev = process.env.CCSERVER_WORKTREE_GIT_TIMEOUT_MS;
  process.env.CCSERVER_WORKTREE_GIT_TIMEOUT_MS = '500';
  try {
    const started = Date.now();
    assert.throws(() => worktree.resolveMemberWorktree(repo, 'workerFifoGit'));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `metadata read must not block on the FIFO (took ${elapsed}ms)`);
    assert.ok(existsSync(join(path, 'keep.txt')), 'never removes a non-empty unrecognized directory');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_WORKTREE_GIT_TIMEOUT_MS;
    else process.env.CCSERVER_WORKTREE_GIT_TIMEOUT_MS = prev;
    rmSync(path, { recursive: true, force: true });
  }
});
