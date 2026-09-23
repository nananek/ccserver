// Relocates ccserver's files from the pre-#201 layout to the XDG one
// (issue #201 Step3). The generalization of db.js's migrateLegacyDbFile(),
// which did exactly this for one file and its two sidecars; every rule here
// is that function's rule, widened to the whole registry.
//
// planMigration() has no side effects at all, so the wizard's dry run and
// GET /api/setup-status can share one answer. applyMigration() is the only
// thing in the codebase that moves a file between layouts -- nothing happens
// at boot, by design (decision D3).
//
// fs access goes through an injectable `deps`, the same test seam as
// migrateLegacyDbFile(path, legacy)'s second argument: EXDEV and EACCES are
// the two failure modes that matter most here and neither is reproducible
// on demand from a normal test.

import {
  chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { allPaths, configRoot, dataRoot, stateRoot, legacyDataRoot, repoRoot } from './paths.js';

export const nodeFs = {
  existsSync, mkdirSync, renameSync, cpSync, rmSync, statSync, lstatSync,
  chmodSync, readdirSync, writeFileSync, linkSync, unlinkSync,
};

const ROOT_MODE = 0o700;

// --- planning ---------------------------------------------------------------

// -> { steps, skips, warnings, kept }
//
//   Step    { id, label, kind, type, envVar, from, to, items[], mode, sidecars }
//             mode: 'rename' | 'copy-delete'
//   Skip    { id, label, reason: 'env-override' | 'nothing-to-move' | 'already-migrated' | 'ephemeral', detail }
//   Warning { id, label, reason: 'both-present', message, path }
//   Kept    { id, label, at, reason: 'sticky-large' }
export function planMigration({ entries = allPaths(), deps = nodeFs } = {}) {
  const steps = [];
  const skips = [];
  const warnings = [];
  const kept = [];

  for (const entry of entries) {
    // 1. An operator who set the env var meant it. This is db.js:68's
    //    `if (process.env.CCSERVER_DB_PATH) return`, promoted to the rule
    //    for every entry -- and issue #201's requirement 2 verbatim.
    if (entry.overridden) {
      skips.push({ id: entry.id, label: entry.label, reason: 'env-override', detail: `${entry.envVar}=${entry.path}` });
      continue;
    }

    const target = entry.target;
    // Sidecars count for presence on BOTH sides (attack-test-201 F4b): a
    // crash between moving ccserver.sqlite3 and its -wal left the WAL behind
    // at the old path, and because only the main file was probed the next run
    // reported "nothing to do", wrote the marker, and the server opened a DB
    // whose committed-but-uncheckpointed transactions were still sitting in
    // the orphaned WAL. SQLite treats a DB with no WAL as clean, so those
    // commits vanish silently rather than as corruption.
    const targetExists = anyPresent(target, entry.sidecars, deps);
    const present = entry.legacyPaths.filter((p) => anyPresent(p, entry.sidecars, deps));

    // 2. Both occupied. Moving would clobber live data and merging could
    //    clobber it differently, so neither happens -- db.js:69-79's
    //    console.warn, structured. Deliberately NOT a blocker: making it one
    //    would leave the operator with no way to ever finish.
    if (targetExists && present.length > 0) {
      warnings.push({
        id: entry.id,
        label: entry.label,
        reason: 'both-present',
        path: present[0],
        message: `${entry.label} が移行先 (${target}) と旧位置 (${present.join(', ')}) の両方にあります。`
          + '統合はしません。旧位置はそのまま残るので、確認のうえ手動で削除してください。',
      });
      continue;
    }

    if (targetExists) {
      skips.push({ id: entry.id, label: entry.label, reason: 'already-migrated', detail: target });
      continue;
    }

    if (present.length === 0) {
      skips.push({ id: entry.id, label: entry.label, reason: 'nothing-to-move', detail: null });
      continue;
    }

    // 3. Throwaway bwrap cwds. usage.js/codexUsage.js keep them empty on
    //    purpose and mkdir them on demand; copying one across is pointless.
    if (entry.ephemeral) {
      skips.push({ id: entry.id, label: entry.label, reason: 'ephemeral', detail: present[0] });
      continue;
    }

    // 4. Anything that is not a regular file / directory is refused rather
    //    than carried across (attack-test-201 F6). A FIFO planted at a legacy
    //    state path used to be migrated faithfully into the new state dir,
    //    where restoreGroups()/restoreSchedules() then blocked forever inside
    //    readFileSync -- reading a FIFO with no writer does not throw, it
    //    waits -- leaving a server that never finishes booting AND ignores
    //    SIGTERM, so systemd could only kill it after TimeoutStopSec.
    //    Leaving the oddity at the old path means the new path is simply
    //    absent, which every reader already handles.
    const kind = fileKind(present[0], deps);
    if (kind !== 'file' && kind !== 'dir') {
      warnings.push({
        id: entry.id,
        label: entry.label,
        reason: 'not-a-regular-file',
        path: present[0],
        message: `${entry.label} (${present[0]}) は通常のファイル/ディレクトリではありません (${kind})。`
          + '移行せずにそのまま残します。不要なら手動で削除してください。',
      });
      continue;
    }

    // 5. Sticky trees: left in place, and the choice RECORDED (see the
    //    header of stickyReasons below for why we do not move them).
    if (entry.stickyLegacy) {
      kept.push({ id: entry.id, label: entry.label, at: present[0], reason: 'sticky-large' });
      continue;
    }

    steps.push(buildStep(entry, present[0], target, deps));
  }

  return { steps, skips, warnings, kept };
}

// lstat, never stat: a symlink must be reported as a symlink rather than as
// whatever it points at, or the check below could be walked straight past.
function fileKind(path, deps) {
  let st;
  try {
    st = deps.lstatSync ? deps.lstatSync(path) : deps.statSync(path);
  } catch {
    return 'unknown';
  }
  if (st.isFile()) return 'file';
  if (st.isDirectory()) return 'dir';
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isFIFO()) return 'FIFO';
  if (st.isSocket()) return 'socket';
  return 'special';
}

// True when the path itself or any of its sidecars exists.
function anyPresent(path, sidecars, deps) {
  if (deps.existsSync(path)) return true;
  return (sidecars || []).some((suffix) => deps.existsSync(`${path}${suffix}`));
}

function buildStep(entry, from, to, deps) {
  // Sidecars are part of the same logical object: a SQLite WAL that ends up
  // in a different directory than its main file is corruption, not an
  // inconvenience. Only the ones that actually exist go in.
  // The main file may be absent while a sidecar lingers (an interrupted
  // earlier run), so every component is tested individually.
  const items = [];
  for (const suffix of ['', ...entry.sidecars]) {
    if (deps.existsSync(`${from}${suffix}`)) items.push({ from: `${from}${suffix}`, to: `${to}${suffix}` });
  }
  return {
    id: entry.id,
    label: entry.label,
    kind: entry.kind,
    type: entry.type,
    envVar: entry.envVar,
    mode: crossesFilesystem(from, to, deps) ? 'copy-delete' : 'rename',
    fileMode: entry.mode,
    sidecars: entry.sidecars,
    from,
    to,
    items,
  };
}

// rename(2) cannot cross a filesystem boundary, and this migration crosses
// them routinely: the state JSONs start inside the repo checkout -- often a
// separate mount, /srv or a bind -- and land under $XDG_STATE_HOME in the
// operator's home. db.js's rename-only predecessor never had to care,
// because both of its paths were always under the same home directory.
//
// Decided HERE, at plan time, rather than caught as an EXDEV at apply time,
// so the dry run can tell the operator that a real copy is about to happen
// (which for a multi-gigabyte tree is the difference between instant and
// several minutes).
function crossesFilesystem(from, to, deps) {
  try {
    return deps.statSync(dirname(from)).dev !== deps.statSync(nearestExisting(dirname(to), deps)).dev;
  } catch {
    // Cannot tell -> assume same-device and let applyMigration fall back on
    // the EXDEV it gets. Never a reason to fail planning.
    return false;
  }
}

// The destination directory usually does not exist yet, so walk up to the
// closest ancestor that does -- that is the filesystem the new file lands on.
function nearestExisting(dir, deps) {
  let cur = dir;
  for (;;) {
    if (deps.existsSync(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

// --- applying ---------------------------------------------------------------

// Performs the plan, or undoes everything and throws.
//
// All-or-nothing across the WHOLE plan, which is stricter than db.js:90-99
// (it rolled back only the suffixes of the one file it was moving). The
// reason is operational: a half-migrated host is the worst possible state
// for a production service that cannot be restarted at will -- some state at
// the old paths, some at the new, and whichever layout it boots in, it is
// missing half its data. Rolling all the way back leaves the host exactly as
// it was, still bootable on the old layout.
export function applyMigration(plan, { deps = nodeFs, onLog } = {}) {
  ensureRoots(deps);

  const undo = [];
  const moved = [];
  try {
    for (const step of plan.steps) {
      deps.mkdirSync(dirname(step.to), { recursive: true, mode: ROOT_MODE });
      for (const item of step.items) {
        undo.push(relocate(item.from, item.to, step.mode, deps));
      }
      applyModes(step, deps);
      moved.push(step);
      onLog?.(step);
    }
  } catch (err) {
    rollback(undo);
    throw new Error(
      `移行に失敗しました: ${err.message}\n`
      + `すでに移動した ${undo.length} 件は元の場所に戻しました。レイアウトは v1 のままです。`,
    );
  }
  // The undo stack is handed back rather than discarded (attack-test-201 F3):
  // the caller still has to write the layout marker, and until that lands the
  // migration has not actually happened as far as the server is concerned. A
  // failure there -- EISDIR on a layout.json someone turned into a directory,
  // EACCES, ENOSPC -- used to leave every file moved and the marker absent,
  // so the server resolved the now-empty OLD paths and booted as if it had
  // lost everything. That is the "half-migrated" state this engine exists to
  // prevent, reached through the back door.
  return { moved, rollback: () => rollback(undo) };
}

function rollback(undo) {
  for (const step of [...undo].reverse()) {
    try { step(); } catch { /* best-effort rollback */ }
  }
}

// Moves one path; returns the function that puts it back.
//
// Never overwrites: the destination is claimed atomically where the platform
// allows it, rather than checked with existsSync and then written (F10 --
// that check-then-act window let a concurrent writer's file be clobbered
// silently). linkSync fails with EEXIST if the target appeared in between,
// and cpSync is given errorOnExist so the copy path behaves the same way.
function relocate(from, to, mode, deps) {
  if (mode === 'rename') {
    try {
      claimByLink(from, to, deps);
      return () => { deps.renameSync(to, from); };
    } catch (err) {
      // The device check was a prediction, not a guarantee (bind mounts, a
      // racing mount). Fall through to the copy path rather than failing.
      if (err.code !== 'EXDEV') throw describeExists(err, to);
    }
  }
  // copy -> verify -> delete, in that order: until the source is unlinked
  // nothing has been lost. verbatimSymlinks keeps a symlinked cache inside a
  // persistent HOME a symlink instead of silently inflating it into a copy.
  //
  // A failure mid-copy leaves a PARTIAL destination, and leaving it there is
  // how F4 turned a full disk into data loss: the next run saw both sides
  // occupied, reported a both-present warning, wrote the marker anyway, and
  // the truncated copy became the official data. So the partial is removed
  // on the way out.
  // Whether the destination was already there decides what cleanup is even
  // allowed: a partial copy WE created must be removed, but somebody else's
  // pre-existing file must never be, or the cleanup becomes the data loss.
  const preexisting = deps.existsSync(to);
  try {
    deps.cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  } catch (err) {
    if (!preexisting) {
      try { deps.rmSync(to, { recursive: true, force: true }); } catch { /* nothing to clean */ }
    }
    throw describeExists(err, to);
  }
  if (!deps.existsSync(to)) throw new Error(`コピーに失敗しました: ${from} -> ${to}`);
  deps.rmSync(from, { recursive: true, force: true });
  return () => {
    deps.cpSync(to, from, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    deps.rmSync(to, { recursive: true, force: true });
  };
}

// Claim `to` without a check-then-act window. link(2) is atomic and fails
// with EEXIST rather than replacing, which rename(2) would do. Directories
// cannot be hard-linked, so those fall back to rename guarded by an explicit
// existence check -- rename onto a non-empty directory fails with ENOTEMPTY
// on its own, and an empty one being replaced is harmless.
function claimByLink(from, to, deps) {
  if (!deps.linkSync || isDirectory(from, deps)) {
    if (deps.existsSync(to)) {
      const err = new Error(`移行先に既にあります: ${to}`);
      err.code = 'EEXIST';
      throw err;
    }
    deps.renameSync(from, to);
    return;
  }
  deps.linkSync(from, to);
  deps.unlinkSync(from);
}

// Keeps the operator-facing wording for the one failure they are most
// likely to hit, without losing the errno the caller may branch on.
function describeExists(err, to) {
  if (err.code !== 'EEXIST') return err;
  const wrapped = new Error(`移行先に既にファイルがあります: ${to}`);
  wrapped.code = 'EEXIST';
  wrapped.cause = err;
  return wrapped;
}

function isDirectory(path, deps) {
  try {
    return deps.lstatSync ? deps.lstatSync(path).isDirectory() : deps.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Owner-only everywhere. The config carries federation pairing secrets, the
// federation dir the mTLS private key (federationIdentity.js:83,91 already
// requires 0700/0600), the DB session tokens and GPG vault material
// (db.js's L2 chmod). Best-effort: an exotic or read-only fs must not undo
// a successful move.
function applyModes(step, deps) {
  try {
    deps.chmodSync(step.to, step.fileMode);
    for (const item of step.items.slice(1)) deps.chmodSync(item.to, step.fileMode);
  } catch { /* best effort */ }
}

export function ensureRoots(deps = nodeFs) {
  for (const dir of [configRoot(), dataRoot(), stateRoot()]) {
    deps.mkdirSync(dir, { recursive: true, mode: ROOT_MODE });
  }
}

// --- why the sticky trees stay put ------------------------------------------
// Exported as text so the wizard can print the reason instead of restating
// it, and so there is exactly one copy of it.
//
// Any ONE of these would be sufficient on its own:
//
// 1. git worktree gitdir pointers are ABSOLUTE. Each <worktree>/.git holds
//    `gitdir: <legacyDataRoot>/worktrees/<hash>/<role>/.git`, and the origin
//    repo's .git/worktrees/<name>/gitdir points back, also absolutely.
//    Moving breaks both directions, and `git worktree repair` has to run
//    per origin repo -- repos the wizard has no way to enumerate. Meanwhile
//    ws/worktree.js reads a broken worktree as "gone from disk" and
//    recreates it: that is the path by which a combo worker's uncommitted
//    work disappears.
// 2. dind/ is a live docker data-root holding a real flock
//    (sandbox.js's .ccserver-dockerd.lock). Moving it out from under a
//    running -- or leaked -- rootless dockerd is undefined behavior, and it
//    is gigabytes.
// 3. home/ persistent HOMEs are full of baked-in absolute paths: .mcp.json,
//    virtualenvs, node_modules/.bin shims, pip RECORD files, gitconfig
//    includeIf. Moving one is a quiet wrecking ball.
// 4. Size. If ~/.local is a separate mount this becomes a real copy.
//
// And issue #201's actual complaint does not apply to them: it is about
// config and state scattered INSIDE the install tree. These are already
// outside it, already under ~/.local/share, already env-overridable. The
// only thing wrong with them is the directory's NAME.
export const STICKY_REASON =
  '巨大 / 実行中の可能性があり、git worktree や永続HOMEに絶対パスが埋まっているため';

// --- breadcrumbs (R9) -------------------------------------------------------
// The most likely real-world accident: a host whose checkout is on an older
// or WIP branch gets restarted, the OLD code resolves the OLD paths, and the
// files are not there any more -- it boots empty. Nothing in the old code
// can be made to notice, so leave a note where a human looking for the
// missing files will find it.
const BREADCRUMB = (roots) =>
  'ccserver の設定・状態ファイルは XDG レイアウト (issue #201) へ移動しました。\n'
  + `  設定:   ${roots.config}\n`
  + `  データ: ${roots.data}\n`
  + `  状態:   ${roots.state}\n\n`
  + 'このディレクトリにあったファイルは上記へ移動しています。\n'
  + '古いブランチのコードで起動すると旧パスを参照するため、空の状態で起動します。\n'
  + 'issue #201 を含むブランチに更新してから起動してください。\n';

export function writeBreadcrumbs(deps = nodeFs) {
  const text = BREADCRUMB({ config: configRoot(), data: dataRoot(), state: stateRoot() });
  const written = [];
  for (const target of [join(legacyDataRoot(), 'MOVED-TO-XDG.txt'), join(repoRoot(), '.ccserver-state-moved.txt')]) {
    try {
      deps.mkdirSync(dirname(target), { recursive: true });
      writeFileNoFollow(target, text, 0o644, deps);
      written.push(target);
    } catch { /* a read-only checkout is fine -- this is a courtesy, not a step */ }
  }
  return written;
}

// Writes without following a symlink at `path` (attack-test-201 F5).
//
// One of these breadcrumbs lands in the repo root, which a sandboxed session
// can have as its cwd -- so an agent could plant
// `.ccserver-state-moved.txt -> ~/.ssh/authorized_keys` and wait for the
// operator to run `npm run setup`, at which point a plain writeFileSync
// follows the link and destroys whatever it points at. Same exposure for the
// layout marker.
//
// 'wx' creates and fails with EEXIST if anything is already there, so an
// existing symlink can never be followed; the replace path then unlinks the
// entry (removing the LINK, not its target) and retries. lstat is checked
// first so a pre-existing regular file is still replaceable normally.
export function writeFileNoFollow(path, text, mode, deps = nodeFs) {
  try {
    deps.writeFileSync(path, text, { flag: 'wx', mode });
    return;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  // Whatever is there -- a regular file from a previous run, or a symlink /
  // FIFO someone planted -- is removed as an ENTRY and recreated. rmSync
  // unlinks the link itself, never its target, so the planted path's victim
  // is untouched.
  deps.rmSync(path, { force: true });
  deps.writeFileSync(path, text, { flag: 'wx', mode });
}

// Legacy files the wizard did NOT move and does NOT reference any more, so
// the operator can clean up deliberately. Only reports; never deletes.
export function findLeftovers({ entries = allPaths(), deps = nodeFs } = {}) {
  const out = [];
  for (const entry of entries) {
    if (entry.overridden || entry.stickyLegacy) continue;
    for (const legacy of entry.legacyPaths) {
      if (legacy !== entry.path && deps.existsSync(legacy)) out.push({ id: entry.id, label: entry.label, path: legacy });
    }
  }
  return out;
}
