// Per-role git worktree resolution for combo groups (workerA/workerB/...).
// Each role gets its own git checkout so parallel git operations (implement
// on one branch, review another) no longer race over one shared cwd -- see
// tmp/combo-worktree-plan.md sections 1-3 for the full design.
//
// Placement policy: worktrees live OUTSIDE the project directory (mirrors
// orchestratorDir / the persistent sandbox HOME), keyed by the same
// projectHashForCwd used for orchestratorDir, so they survive a group being
// torn down and re-launched for the same project.
//
//   ~/.local/share/ccserver-sandbox/worktrees/<projectHash>/<role>/
//
// The server only ever creates worktrees with `git worktree add --detach`:
// it never creates or checks out a branch itself. Branch creation is left
// entirely to the agent running inside the worktree (`git checkout -b ...`),
// because git's exclusive-checkout constraint applies only to a *branch*
// being checked out twice, never to multiple worktrees sharing one detached
// HEAD commit -- see plan section 2.3.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { projectHashForCwd } from './projectHash.js';

export function worktreeRoot() {
  return process.env.CCSERVER_WORKTREE_ROOT
    || join(homedir(), '.local', 'share', 'ccserver-sandbox', 'worktrees');
}

export function worktreePathFor(projectCwd, role) {
  return join(worktreeRoot(), projectHashForCwd(projectCwd), role);
}

// stderr is piped (not inherited): a non-repo cwd or a routine "prunable"
// state produces expected git stderr chatter ("fatal: not a git
// repository", "Preparing worktree ...") that would otherwise look like a
// real server error in the logs on every call.
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

// False for a missing directory, a plain (non-git) directory, or when the
// `git` binary itself is unavailable -- worktree.js degrades to "share the
// project cwd as-is" in every one of those cases (plan section 2.8).
function isGitRepo(cwd) {
  if (!isDirectory(cwd)) return false;
  try {
    return git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

function branchShortName(ref) {
  return ref && ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

// Parses `git worktree list --porcelain` into per-worktree records. Blocks
// are separated by a blank line; each starts with a `worktree <path>` line.
function listWorktrees(projectCwd) {
  let out;
  try {
    out = git(projectCwd, ['worktree', 'list', '--porcelain']);
  } catch {
    return [];
  }
  const entries = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), branch: null, detached: false, prunable: false };
      entries.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length);
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line.startsWith('prunable')) {
      cur.prunable = true;
    }
  }
  return entries;
}

function branchExists(projectCwd, branch) {
  if (!branch) return false;
  try {
    git(projectCwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

// Absolute git-common-dir of a worktree (where the actual object store,
// refs and .git/worktrees/<name> metadata live -- see sandbox.js's
// gitCommonDir bind, which is what makes `git status` work inside the
// sandboxed worktree at all).
function commonDirOf(worktreePath) {
  try {
    const raw = git(worktreePath, ['rev-parse', '--git-common-dir']).trim();
    return resolve(worktreePath, raw);
  } catch {
    return null;
  }
}

function commonDirOfProject(projectCwd) {
  try {
    const raw = git(projectCwd, ['rev-parse', '--git-common-dir']).trim();
    return resolve(projectCwd, raw);
  } catch {
    return null;
  }
}

function branchOf(worktreePath) {
  try {
    const ref = git(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
    return ref || null;
  } catch {
    return null;
  }
}

// Idempotent worktree resolver (plan sections 2.3, 3.2, 3.6.1). Always safe
// to call again for the same (projectCwd, role): an already-healthy worktree
// is reused untouched, never recreated.
//
// `hintBranch` is the branch last known to be checked out in this role's
// worktree, from groupManager's persisted memberWorktrees (plan section
// 3.6.1, `memberWorktrees` hint). It is only consulted when the worktree
// directory has been lost from disk AND `git worktree list` no longer
// reports it (prunable entry already pruned, or external interference
// removed the registration). Without the hint the resolver would treat that
// as a fresh detached creation and never flag the branch loss.
//
// Returns either:
//   { usedWorktree: false, cwd: projectCwd, gitCommonDir: null }
//     projectCwd is not a git repo (or git itself is unavailable) -- caller
//     falls back to sharing projectCwd across roles, exactly like before
//     this feature existed.
//   { usedWorktree: true, cwd, gitCommonDir, created, lostWork, branch }
//     created:  a NEW worktree was made just now (first-time creation, or a
//               recreation after the old one disappeared from disk). false
//               when an existing, healthy worktree was reused as-is.
//     lostWork: true only when recreation discarded a working branch's
//               checkout that the agent itself had created (uncommitted /
//               untracked changes, and -- if the branch itself is also gone
//               -- its commits too). Never true for a first-time creation or
//               a clean reuse of a still-detached worktree.
//     branch:   the branch currently checked out in the resulting worktree,
//               or null while it is still on detached HEAD.
export function resolveMemberWorktree(projectCwd, role, hintBranch = null) {
  if (!isGitRepo(projectCwd)) {
    return { usedWorktree: false, cwd: projectCwd, gitCommonDir: null };
  }
  const path = worktreePathFor(projectCwd, role);
  mkdirSync(dirname(path), { recursive: true });

  const entries = listWorktrees(projectCwd);
  const existing = entries.find((e) => resolve(e.path) === resolve(path));

  if (existing && !existing.prunable) {
    const branch = existing.detached ? null : branchShortName(existing.branch);
    return {
      usedWorktree: true,
      cwd: path,
      gitCommonDir: commonDirOf(path),
      created: false,
      lostWork: false,
      branch,
    };
  }

  // A crash between mkdir/worktree setup can leave the deterministic target
  // directory behind without a corresponding git worktree registration.
  // `git worktree add` refuses such a path even when it is empty, so remove
  // only an empty stale directory and let the normal add path continue.
  // Never remove a non-empty unregistered directory here.
  if (!existing && existsSync(path)) {
    let empty = false;
    try { empty = readdirSync(path).length === 0; } catch { /* handled below */ }
    if (empty) {
      try { rmdirSync(path); } catch { /* let git report the real failure */ }
    } else if (isGitRepo(path) && commonDirOf(path) === commonDirOfProject(projectCwd)) {
      // The registration may have been pruned externally while the checkout
      // itself survived. Reusing it preserves the user's files and avoids
      // trying to overwrite a potentially valuable worktree.
      return {
        usedWorktree: true,
        cwd: path,
        gitCommonDir: commonDirOf(path),
        created: false,
        lostWork: false,
        branch: branchOf(path),
      };
    }
  }

  // Registered in .git/worktrees/ but the directory itself is gone
  // (prunable) -- prune the stale registration before adding again at the
  // same path, and remember whether a working branch was checked out there
  // (the prune drops that information from `git worktree list`).
  const priorBranchFromGit = existing && !existing.detached ? branchShortName(existing.branch) : null;
  // External interference may have already pruned the stale registration
  // (rm -rf + `git worktree prune`), leaving `existing` null and
  // `priorBranchFromGit` null even though the persisted memberWorktrees
  // still knows which branch was checked out. The hint restores that
  // knowledge so branch loss is still detected (plan 3.6.1, `memberWorktrees`
  // hint). Prefer the live git state when available; fall back to the hint
  // only when git no longer reports the branch.
  const priorBranch = priorBranchFromGit || (typeof hintBranch === 'string' ? hintBranch : null);
  if (existing) {
    try { git(projectCwd, ['worktree', 'prune']); } catch { /* best effort */ }
  }

  if (priorBranch && branchExists(projectCwd, priorBranch)) {
    // Case 2: the branch survives in the shared repo -- reattach the
    // worktree to it. Only the on-disk (uncommitted/untracked) changes are
    // lost, not the branch's commits. This also covers the external-
    // interference case where the worktree was pruned away but the hint
    // still knows the surviving branch name.
    git(projectCwd, ['worktree', 'add', path, priorBranch]);
    return { usedWorktree: true, cwd: path, gitCommonDir: commonDirOf(path), created: true, lostWork: true, branch: priorBranch };
  }

  // Case 3 (a working branch existed but is gone too, whether observed via
  // `git worktree list` or via the memberWorktrees hint) or a genuine
  // first-time creation (priorBranch is null either way -- never true here
  // for a worktree that was cleanly detached, so lostWork below is only set
  // when a working branch is actually being lost).
  const baseRef = git(projectCwd, ['rev-parse', 'HEAD']).trim();
  git(projectCwd, ['worktree', 'add', '--detach', path, baseRef]);
  return {
    usedWorktree: true,
    cwd: path,
    gitCommonDir: commonDirOf(path),
    created: true,
    lostWork: !!priorBranch,
    branch: null,
  };
}

// Every `<projectHash>/<role>` directory that currently exists on disk under
// worktreeRoot(), as absolute paths -- for the startup orphan scan (plan
// section 3.7-3). Never throws: a missing/unreadable root just yields no
// entries (nothing to scan yet).
export function listWorktreeDirs() {
  const root = worktreeRoot();
  let projectHashes;
  try {
    projectHashes = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const dirs = [];
  for (const hash of projectHashes) {
    const projectDir = join(root, hash);
    let roles;
    try {
      roles = readdirSync(projectDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const role of roles) dirs.push(join(projectDir, role));
  }
  return dirs;
}

// Best-effort removal (plan section 3.7): a plain `git worktree remove`,
// never `--force` -- uncommitted/untracked changes make it fail on purpose,
// and that failure must not destroy them. Returns true on success (or when
// there was nothing to remove), false when it failed (caller logs a warning
// and leaves the directory for the orphan scan to flag later).
export function removeMemberWorktree(projectCwd, role) {
  const path = worktreePathFor(projectCwd, role);
  if (!existsSync(path)) return true;
  if (!isGitRepo(projectCwd)) return true; // nothing registered to remove
  try {
    git(projectCwd, ['worktree', 'remove', path]);
    return true;
  } catch {
    return false;
  }
}
