import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { normalizeBrowseRoots, isContained, resolveWithinRoots, isCcserverScratchPath } from './pathPolicy.js';

test('normalizeBrowseRoots: non-array or missing collapses to []', () => {
  assert.deepEqual(normalizeBrowseRoots(undefined), []);
  assert.deepEqual(normalizeBrowseRoots(null), []);
  assert.deepEqual(normalizeBrowseRoots('/srv/projects'), []);
  assert.deepEqual(normalizeBrowseRoots({ root: '/srv/projects' }), []);
});

test('normalizeBrowseRoots: resolves absolute paths and expands ~', () => {
  const roots = normalizeBrowseRoots(['/srv/projects', '~/repos', '~']);
  assert.deepEqual(roots, ['/srv/projects', join(homedir(), 'repos'), homedir()]);
});

test('normalizeBrowseRoots: drops non-string/empty entries and dedupes', () => {
  const roots = normalizeBrowseRoots(['/srv/projects', '/srv/projects', '/srv/projects/', 42, null, '', undefined]);
  // '/srv/projects' and '/srv/projects/' both resolve() to the same string.
  assert.deepEqual(roots, ['/srv/projects']);
});

test('isContained: [] roots means unrestricted', () => {
  assert.equal(isContained('/etc/passwd', []), true);
  assert.equal(isContained('/', []), true);
});

test('isContained: exact match and subtree match are contained; siblings and prefixes are not', () => {
  const roots = ['/srv/projects'];
  assert.equal(isContained('/srv/projects', roots), true);
  assert.equal(isContained('/srv/projects/app1', roots), true);
  assert.equal(isContained('/srv/projects/app1/sub', roots), true);
  // Lexical prefix match without a path separator must not count
  // ('/srv/projects-evil' is a sibling, not a subtree).
  assert.equal(isContained('/srv/projects-evil', roots), false);
  assert.equal(isContained('/srv/other', roots), false);
  assert.equal(isContained('/', roots), false);
});

test('isContained: a path that does not exist yet is judged lexically (no throw)', () => {
  const roots = ['/srv/projects'];
  assert.equal(isContained('/srv/projects/not-created-yet/deep/path', roots), true);
  assert.equal(isContained('/srv/other/not-created-yet', roots), false);
});

test('isContained: a symlink inside an allowed root pointing outside it is rejected', () => {
  const base = mkdtempSync(join(tmpdir(), 'ccserver-pathpolicy-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const escapeLink = join(root, 'escape');
  try {
    symlinkSync(outside, escapeLink);
    // Lexically the symlink path sits inside `root`, but its realpath
    // resolves to `outside` -- must be rejected.
    assert.equal(isContained(escapeLink, [root]), false);
    // A genuine subdirectory (no symlink) stays allowed.
    const real = join(root, 'real');
    mkdirSync(real);
    assert.equal(isContained(real, [root]), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('resolveWithinRoots: [] roots preserves the historical resolve(\'/\', requestedPath || fallback) contract', () => {
  assert.deepEqual(resolveWithinRoots('etc/passwd', []), { ok: true, path: '/etc/passwd' });
  assert.deepEqual(resolveWithinRoots('/a/../../b', []), { ok: true, path: '/b' });
  assert.deepEqual(resolveWithinRoots('', [], '/fallback'), { ok: true, path: '/fallback' });
});

test('resolveWithinRoots: applies containment on top of the same resolution', () => {
  const roots = ['/srv/projects'];
  assert.deepEqual(resolveWithinRoots('/srv/projects/app1', roots), { ok: true, path: '/srv/projects/app1' });
  const outside = resolveWithinRoots('/etc/passwd', roots);
  assert.equal(outside.ok, false);
  assert.equal(outside.path, '/etc/passwd');
});

test('isContained: a root that itself sits behind a symlink (e.g. macOS /tmp -> /private/tmp) still contains paths given in the same spelling', () => {
  const base = mkdtempSync(join(tmpdir(), 'ccserver-pathpolicy-symroot-'));
  const realTarget = join(base, 'real-root');
  const linkedRoot = join(base, 'linked-root');
  mkdirSync(realTarget, { recursive: true });
  try {
    symlinkSync(realTarget, linkedRoot);
    // The configured root is the SYMLINK spelling (as an operator would
    // write it in sandbox.config.json); a path given in that same spelling,
    // existing or not, must still be judged contained.
    assert.equal(isContained(join(linkedRoot, 'app1'), [linkedRoot]), true);
    assert.equal(isContained(join(linkedRoot, 'not-created-yet', 'deep'), [linkedRoot]), true);
    // The REAL spelling of the same location must also be recognized as
    // contained (both sides normalize to the same real path).
    assert.equal(isContained(join(realTarget, 'app1'), [linkedRoot]), true);
    // A genuine sibling of the real target is still rejected.
    assert.equal(isContained(join(base, 'other'), [linkedRoot]), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('resolveWithinRoots: relative-path escape attempts collapse via resolve() before containment is checked', () => {
  const roots = ['/srv/projects'];
  // '..' is collapsed by resolve('/', ...) the same way it always was; the
  // result then still has to pass containment.
  const res = resolveWithinRoots('../../etc/passwd', roots);
  assert.equal(res.path, resolve('/', '../../etc/passwd'));
  assert.equal(res.ok, false);
});

// isCcserverScratchPath (issue #189): combo-group sessions always run in a
// server-synthesized scratch dir under ~/.local/share/ccserver-sandbox
// (worker git worktrees, the orchestrator's isolated dir) -- never the
// project directory itself -- so sessionManager.js's browseRoots cwd check
// exempts this tree specifically, or every combo/group launch would be
// refused the moment browseRoots is configured.
test('isCcserverScratchPath: recognizes the scratch tree and its subdirectories, rejects everything else', () => {
  const scratchRoot = join(homedir(), '.local', 'share', 'ccserver-sandbox');
  assert.equal(isCcserverScratchPath(scratchRoot), true);
  assert.equal(isCcserverScratchPath(join(scratchRoot, 'worktrees', 'abc123', 'workerA')), true);
  assert.equal(isCcserverScratchPath(join(scratchRoot, 'orchestrator', 'abc123')), true);
  assert.equal(isCcserverScratchPath(join(scratchRoot, 'home', 'someproject')), true);
  // Siblings and prefixes of the scratch root must not match.
  assert.equal(isCcserverScratchPath(`${scratchRoot}-evil`), false);
  assert.equal(isCcserverScratchPath(join(homedir(), '.local', 'share', 'other-app')), false);
  assert.equal(isCcserverScratchPath('/srv/projects/app1'), false);
  assert.equal(isCcserverScratchPath('/'), false);
});

// Regression (issue #189 self-review): the exemption must not be fooled by a
// symlink planted inside the scratch tree. `cwd` is client-supplied and any
// sandboxed session can create such a link in its own rw-bound HOME, so a
// purely lexical prefix check let `<scratch>/worktrees/escape -> /` through
// -- skipping the browseRoots refusal AND making buildBwrapArgs' `--bind
// <cwd> <cwd>` resolve its bind source to the host root (a live PoC could
// read/write host files from the "sandboxed" shell).
test('isCcserverScratchPath: a symlink inside the scratch tree pointing outside it is rejected', () => {
  const scratchRoot = join(homedir(), '.local', 'share', 'ccserver-sandbox');
  const outside = mkdtempSync(join(tmpdir(), 'ccserver-scratch-escape-'));
  const escapeLink = join(scratchRoot, 'worktrees', `test-escape-${process.pid}-${Date.now()}`);
  mkdirSync(dirname(escapeLink), { recursive: true });
  try {
    symlinkSync(outside, escapeLink);
    assert.equal(isCcserverScratchPath(escapeLink), false,
      'a scratch-internal symlink resolving outside the scratch tree must not be exempt');
  } finally {
    rmSync(escapeLink, { force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('isCcserverScratchPath: a symlink resolving to a real directory inside the scratch tree stays exempt', () => {
  const scratchRoot = join(homedir(), '.local', 'share', 'ccserver-sandbox');
  const realDir = join(scratchRoot, 'worktrees', `test-real-${process.pid}-${Date.now()}`);
  const link = join(scratchRoot, 'worktrees', `test-link-${process.pid}-${Date.now()}`);
  mkdirSync(realDir, { recursive: true });
  try {
    symlinkSync(realDir, link);
    assert.equal(isCcserverScratchPath(link), true);
    assert.equal(isCcserverScratchPath(join(link, 'sub', 'not-created-yet')), true);
  } finally {
    rmSync(link, { force: true });
    rmSync(realDir, { recursive: true, force: true });
  }
});
