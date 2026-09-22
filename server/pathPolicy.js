// Shared path-containment policy for issue #189's browseRoots restriction.
// Used by both the HTTP layer (routes/files.js, routes/dirs.js) and the
// WS/session layer (ws/sessionManager.js, ws/sandbox.js), so it stays
// dependency-free (node builtins only) to avoid a circular import between
// those two layers.

import { resolve, sep, dirname, basename, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';

const HOME = homedir();

function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return resolve(HOME, p.slice(2));
  return p;
}

// Parses sandbox.config.json's raw browseRoots. [] or a non-array means
// "unrestricted" (the existing host-wide behavior is preserved) -- same
// "silently drop invalid values" policy as hiddenApps (sandbox.js).
export function normalizeBrowseRoots(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry) continue;
    const abs = resolve(expandHome(entry));
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

// Whether absPath (already resolve()d) equals or sits under one of roots.
// roots=[] means unrestricted (back-compat). Mirrors the
// `x === root || x.startsWith(root + '/')` containment check in
// groupManager.js.
function withinRoots(absPath, roots) {
  if (roots.length === 0) return true;
  return roots.some((root) => absPath === root || absPath.startsWith(root + sep));
}

function realOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// realpath(), but tolerant of absPath not existing yet (about to be
// created): walks up to the nearest existing ancestor, resolves THAT, and
// reattaches the missing tail. This is what makes containment symlink-safe
// in both directions at once -- a root that itself sits behind a symlink
// (macOS's /tmp -> /private/tmp is the common case) still lines up with a
// not-yet-created path underneath it, while a symlink planted INSIDE an
// allowed root that points outside it (an escape attempt) still resolves to
// its real, out-of-bounds target once it exists.
function realOrNearest(absPath) {
  try {
    return realpathSync(absPath);
  } catch {
    const parent = dirname(absPath);
    if (parent === absPath) return absPath; // reached the top; nothing left to resolve
    return join(realOrNearest(parent), basename(absPath));
  }
}

// Containment check with symlink-escape protection: safePath()/
// browseDirectory() historically only resolve() a path (never follow
// symlinks), so a symlink planted inside an allowed root that points outside
// it would otherwise defeat browseRoots entirely. Both absPath and each root
// are compared by their "real" spelling (realOrNearest), not their lexical
// one -- comparing a realpath'd absPath against lexical roots would
// otherwise misjudge a root that itself sits behind a symlink as "outside".
export function isContained(absPath, roots) {
  if (roots.length === 0) return true;
  const realRoots = roots.map(realOrSelf);
  return withinRoots(realOrNearest(absPath), realRoots);
}

// Resolves a user-supplied path the same way the pre-existing
// resolve('/', requestedPath || fallback) contract did (relative paths
// anchored at /, '..' collapsed -- see files.test.js's host-wide-policy
// pin), then applies containment on top.
export function resolveWithinRoots(requestedPath, roots, fallback = '/') {
  const path = resolve('/', requestedPath || fallback);
  return { ok: isContained(path, roots), path };
}

// browseRoots (issue #189) session-cwd-only exemption: every combo-group
// session's cwd is a server-synthesized scratch directory under this fixed
// tree -- workers always run in their own git worktree (worktree.js's
// worktreeRoot(), default `<this>/worktrees`), the orchestrator always runs
// in its isolated CLAUDE.md-only scratch dir (routes/groups.js's
// ORCHESTRATOR_ROOT, default `<this>/orchestrator`) -- NEVER the project
// directory itself (see groupManager.js's addMember: "options.cwd ... is
// intentionally never read here"). Bounding them by browseRoots would make
// every combo/group launch impossible the moment browseRoots is configured,
// since these dirs sit outside any project-directory-shaped browseRoots
// entry an operator would realistically set. This mirrors
// persistentHomeDir() (sandbox.js, the sandboxed $HOME) already living under
// this same tree, unrestricted by browseRoots for the same reason. Used ONLY
// for the session-launch cwd check (sessionManager.js / sandbox.js's
// buildSandboxSpawn) -- it does NOT apply to /api/files or /api/dirs, which
// stay fully bounded by browseRoots.
//
// Unlike the combo cwds it exists for, `absPath` here IS ultimately
// client-supplied (the `cwd` of a launch request), so the lexical check
// alone is not enough: a symlink planted inside the scratch tree would
// otherwise be exempted while pointing anywhere. That is not just a
// browseRoots bypass -- buildBwrapArgs binds `--bind <cwd> <cwd>`, and the
// kernel resolves the bind SOURCE through the symlink, so a link like
// `<scratch>/worktrees/escape -> /` made the sandbox rw-bind the HOST ROOT
// at that path (verified live: a shell launched with that cwd could read and
// write host files through relative paths). Any sandboxed session can plant
// such a link -- its persistent HOME is rw-bound under this same tree -- so
// the exemption additionally requires the path's real location to be inside
// the (real) scratch tree.
const CCSERVER_SANDBOX_SCRATCH_ROOT = resolve(join(HOME, '.local', 'share', 'ccserver-sandbox'));
export function isCcserverScratchPath(absPath) {
  if (!withinRoots(absPath, [CCSERVER_SANDBOX_SCRATCH_ROOT])) return false;
  return withinRoots(realOrNearest(absPath), [realOrSelf(CCSERVER_SANDBOX_SCRATCH_ROOT)]);
}
