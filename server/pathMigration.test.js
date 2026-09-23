// Issue #201 Step3. Two things here are load-bearing beyond the obvious:
// the all-plan rollback (a half-migrated host is worse than an un-migrated
// one) and the EXDEV branch, which the real migration hits whenever the repo
// checkout and $HOME are on different mounts -- a normal deployment, not an
// exotic one.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planMigration, applyMigration, nodeFs, findLeftovers, writeBreadcrumbs, writeFileNoFollow } from './pathMigration.js';
import { resetLayoutCache, repoRoot, legacyDataRoot } from './paths.js';
import { withIsolatedHome } from './testIsolation.js';

const ENV_VARS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'CCSERVER_LAYOUT'];
const saved = {};
let tmpRoot;
let caseDir;

before(() => {
  for (const k of ENV_VARS) saved[k] = process.env[k];
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-pathmig-'));
});

after(() => {
  for (const k of ENV_VARS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  resetLayoutCache();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  caseDir = mkdtempSync(join(tmpRoot, 'case-'));
  process.env.XDG_CONFIG_HOME = join(caseDir, 'config');
  process.env.XDG_DATA_HOME = join(caseDir, 'data');
  process.env.XDG_STATE_HOME = join(caseDir, 'state');
  resetLayoutCache();
});

// A hand-built entry, so these tests exercise the engine rather than the
// registry (paths.test.js owns the registry).
function entry(over = {}) {
  const id = over.id || 'thing';
  return {
    id,
    label: over.label || id,
    envVar: over.envVar ?? 'CCSERVER_THING',
    kind: over.kind || 'state',
    type: over.type || 'file',
    mode: over.mode ?? 0o600,
    sidecars: over.sidecars || [],
    path: over.path || join(caseDir, 'old', id),
    target: over.target || join(caseDir, 'new', id),
    legacyPaths: over.legacyPaths || [join(caseDir, 'old', id)],
    overridden: over.overridden === true,
    stickyLegacy: over.stickyLegacy === true,
    ephemeral: over.ephemeral === true,
    keptLegacy: false,
    keptAt: null,
    guard: true,
  };
}

function put(path, content = 'payload') {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

// --- planning ---------------------------------------------------------------

test('an env override is skipped, never migrated (issue #201 requirement 2)', () => {
  const e = entry({ overridden: true, path: '/var/lib/cc/thing.json' });
  put(e.legacyPaths[0]);
  const plan = planMigration({ entries: [e] });
  assert.equal(plan.steps.length, 0);
  assert.deepEqual(plan.skips.map((s) => s.reason), ['env-override']);
  assert.match(plan.skips[0].detail, /CCSERVER_THING=/);
});

test('both locations occupied: a warning, no step, and nothing is merged', () => {
  const e = entry();
  put(e.legacyPaths[0], 'old');
  put(e.target, 'new');
  const plan = planMigration({ entries: [e] });
  assert.equal(plan.steps.length, 0);
  assert.equal(plan.warnings.length, 1);
  assert.equal(plan.warnings[0].reason, 'both-present');
  assert.equal(plan.warnings[0].path, e.legacyPaths[0]);
  // Not a blocker: an operator stuck on this could never finish the setup.
  assert.equal(readFileSync(e.legacyPaths[0], 'utf-8'), 'old');
  assert.equal(readFileSync(e.target, 'utf-8'), 'new');
});

test('already at the target, nothing in the old place: already-migrated', () => {
  const e = entry();
  put(e.target);
  const plan = planMigration({ entries: [e] });
  assert.deepEqual(plan.skips.map((s) => s.reason), ['already-migrated']);
});

test('nothing anywhere: nothing-to-move, empty plan', () => {
  const plan = planMigration({ entries: [entry()] });
  assert.equal(plan.steps.length, 0);
  assert.deepEqual(plan.skips.map((s) => s.reason), ['nothing-to-move']);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.kept, []);
});

test('sticky trees become kept records instead of steps', () => {
  const e = entry({ id: 'worktrees', type: 'dir', stickyLegacy: true });
  mkdirSync(e.legacyPaths[0], { recursive: true });
  const plan = planMigration({ entries: [e] });
  assert.equal(plan.steps.length, 0);
  assert.deepEqual(plan.kept, [{ id: 'worktrees', label: 'worktrees', at: e.legacyPaths[0], reason: 'sticky-large' }]);
});

test('ephemeral scratch dirs are skipped rather than copied', () => {
  const e = entry({ id: 'usageCwd', type: 'dir', ephemeral: true });
  mkdirSync(e.legacyPaths[0], { recursive: true });
  const plan = planMigration({ entries: [e] });
  assert.equal(plan.steps.length, 0);
  assert.deepEqual(plan.skips.map((s) => s.reason), ['ephemeral']);
});

test('only existing sidecars join the step, and they travel with the main file', () => {
  const e = entry({ id: 'db', type: 'file', sidecars: ['-wal', '-shm'] });
  put(e.legacyPaths[0], 'main');
  put(`${e.legacyPaths[0]}-wal`, 'wal');
  // no -shm on disk
  const plan = planMigration({ entries: [e] });
  assert.equal(plan.steps.length, 1);
  assert.deepEqual(plan.steps[0].items.map((i) => i.from), [e.legacyPaths[0], `${e.legacyPaths[0]}-wal`]);
});

// --- EXDEV ------------------------------------------------------------------

test('EXDEV: a cross-device step is planned as copy-delete and says so before running', () => {
  const e = entry();
  put(e.legacyPaths[0]);
  // Two different st_dev values -> the planner must choose copy-delete. The
  // dry run shows this, because for a multi-gigabyte tree the difference
  // between rename and copy is the difference between instant and minutes.
  let call = 0;
  const deps = { ...nodeFs, statSync: () => ({ dev: ++call }) };
  const plan = planMigration({ entries: [e], deps });
  assert.equal(plan.steps[0].mode, 'copy-delete');

  const sameDev = { ...nodeFs, statSync: () => ({ dev: 42 }) };
  assert.equal(planMigration({ entries: [e], deps: sameDev }).steps[0].mode, 'rename');
});

test('EXDEV: an unexpected EXDEV at apply time still falls through to copy-delete', () => {
  // The device check is a prediction (bind mounts, a racing mount can beat
  // it), so rename failing with EXDEV must not fail the migration.
  const e = entry();
  put(e.legacyPaths[0], 'payload');
  const deps = {
    ...nodeFs,
    renameSync: () => { const err = new Error('cross-device link not permitted'); err.code = 'EXDEV'; throw err; },
  };
  const plan = planMigration({ entries: [e], deps: { ...nodeFs, statSync: () => ({ dev: 1 }) } });
  assert.equal(plan.steps[0].mode, 'rename');
  applyMigration(plan, { deps });
  assert.equal(readFileSync(e.target, 'utf-8'), 'payload');
  assert.equal(existsSync(e.legacyPaths[0]), false, 'the source is removed only after the copy landed');
});

test('a non-EXDEV error while claiming the destination is NOT silently turned into a copy', () => {
  const e = entry();
  put(e.legacyPaths[0]);
  // The same-device path claims the destination with link(2) (atomic, fails
  // on EEXIST) rather than rename, so the injection goes there.
  const deps = {
    ...nodeFs,
    linkSync: () => { const err = new Error('permission denied'); err.code = 'EACCES'; throw err; },
  };
  const plan = planMigration({ entries: [e], deps: { ...nodeFs, statSync: () => ({ dev: 1 }) } });
  assert.throws(() => applyMigration(plan, { deps }), /permission denied/);
  assert.equal(existsSync(e.legacyPaths[0]), true, 'the source stays put');
});

// --- applying ---------------------------------------------------------------

test('a file moves with its sidecars and their contents are preserved', () => {
  const e = entry({ id: 'db', kind: 'data', sidecars: ['-wal', '-shm'] });
  put(e.legacyPaths[0], 'main');
  put(`${e.legacyPaths[0]}-wal`, 'wal');
  put(`${e.legacyPaths[0]}-shm`, 'shm');
  applyMigration(planMigration({ entries: [e] }));
  assert.equal(readFileSync(e.target, 'utf-8'), 'main');
  assert.equal(readFileSync(`${e.target}-wal`, 'utf-8'), 'wal');
  assert.equal(readFileSync(`${e.target}-shm`, 'utf-8'), 'shm');
  assert.equal(existsSync(e.legacyPaths[0]), false);
  assert.equal(statSync(e.target).mode & 0o777, 0o600);
});

test('a directory moves with its nested contents, at mode 0700', () => {
  const e = entry({ id: 'federationHome', kind: 'data', type: 'dir', mode: 0o700 });
  mkdirSync(join(e.legacyPaths[0], 'nested'), { recursive: true });
  writeFileSync(join(e.legacyPaths[0], 'instance.key'), 'KEY');
  writeFileSync(join(e.legacyPaths[0], 'nested', 'deep'), 'DEEP');
  applyMigration(planMigration({ entries: [e] }));
  assert.equal(readFileSync(join(e.target, 'instance.key'), 'utf-8'), 'KEY');
  assert.equal(readFileSync(join(e.target, 'nested', 'deep'), 'utf-8'), 'DEEP');
  assert.equal(statSync(e.target).mode & 0o777, 0o700);
});

test('★ one failure rolls the WHOLE plan back, not just the failing item', () => {
  // A half-migrated host is the worst outcome available: some state at the
  // old paths, some at the new, and it is missing half its data whichever
  // layout it boots in. db.js's predecessor only unwound the one file it was
  // moving; this engine unwinds everything.
  const a = entry({ id: 'a' });
  const b = entry({ id: 'b' });
  const c = entry({ id: 'c' });
  put(a.legacyPaths[0], 'A');
  put(b.legacyPaths[0], 'B');
  put(c.legacyPaths[0], 'C');
  // c's destination is occupied, which applyMigration refuses.
  put(c.target, 'OCCUPIED');

  // a and b plan normally; c does not (its target is occupied, so the
  // planner emits a both-present warning). Build c's step by hand to model a
  // STALE plan -- one computed before the occupant appeared -- which is
  // exactly the case applyMigration has to refuse at execution time.
  const plan = { steps: [a, b].map((e) => planMigration({ entries: [e] }).steps[0]) };
  assert.equal(plan.steps.filter(Boolean).length, 2);
  const full = {
    steps: [...plan.steps, {
      id: 'c', label: 'c', kind: 'state', type: 'file', mode: 'rename', fileMode: 0o600,
      sidecars: [], from: c.legacyPaths[0], to: c.target,
      items: [{ from: c.legacyPaths[0], to: c.target }],
    }],
  };

  assert.throws(() => applyMigration(full), /移行に失敗しました/);
  assert.equal(readFileSync(a.legacyPaths[0], 'utf-8'), 'A', 'a must be back where it started');
  assert.equal(readFileSync(b.legacyPaths[0], 'utf-8'), 'B', 'b must be back where it started');
  assert.equal(readFileSync(c.legacyPaths[0], 'utf-8'), 'C', 'c never moved');
  assert.equal(existsSync(a.target), false);
  assert.equal(existsSync(b.target), false);
  assert.equal(readFileSync(c.target, 'utf-8'), 'OCCUPIED', 'the occupant is untouched');
});

test('an existing destination is never overwritten, even if the plan is stale', () => {
  const e = entry();
  put(e.legacyPaths[0], 'mine');
  const plan = planMigration({ entries: [e] });
  assert.equal(plan.steps.length, 1);
  put(e.target, 'someone else got here first');   // the world moved on
  assert.throws(() => applyMigration(plan), /移行先に既にファイルがあります/);
  assert.equal(readFileSync(e.target, 'utf-8'), 'someone else got here first');
  assert.equal(readFileSync(e.legacyPaths[0], 'utf-8'), 'mine');
});

test('the rollback survives a failure in the middle of one item\'s sidecars', () => {
  const e = entry({ id: 'db', sidecars: ['-wal'] });
  put(e.legacyPaths[0], 'main');
  put(`${e.legacyPaths[0]}-wal`, 'wal');
  const plan = planMigration({ entries: [e] });
  // Fail on the SECOND component (the -wal), after the main file has already
  // moved. Injected on linkSync because that is what claims the destination
  // on the same-device path; renameSync is left real so the rollback works.
  let links = 0;
  const deps = {
    ...nodeFs,
    linkSync: (from, to) => {
      if (++links === 2) throw new Error('disk full');
      return nodeFs.linkSync(from, to);
    },
  };
  assert.throws(() => applyMigration(plan, { deps }), /disk full/);
  assert.equal(readFileSync(e.legacyPaths[0], 'utf-8'), 'main', 'the main file came back');
  assert.equal(readFileSync(`${e.legacyPaths[0]}-wal`, 'utf-8'), 'wal', 'and so did the WAL');
  assert.equal(existsSync(e.target), false, 'nothing is left at the destination');
  assert.equal(existsSync(`${e.target}-wal`), false);
});

test('★ an orphaned sidecar moves on its own, and still gets the tight mode', () => {
  // An interrupted earlier run can leave ccserver.sqlite3-wal behind with no
  // main file. The planner has to notice it (F4b: a WAL orphaned at the old
  // path holds committed transactions that SQLite would otherwise consider
  // never to have happened) and the chmod has to reach it: a -wal holds real
  // database pages, so leaving it at an inherited 0644 next to a 0600 DB
  // publishes exactly what the chmod exists to protect. It used to be
  // skipped, because applyModes chmod'd step.to -- the ABSENT main file --
  // first, and one throw inside a single try swallowed the rest.
  const e = entry({ id: 'db', kind: 'data', sidecars: ['-wal', '-shm'] });
  put(`${e.legacyPaths[0]}-wal`, 'wal-only');
  chmodSync(`${e.legacyPaths[0]}-wal`, 0o644);

  const plan = planMigration({ entries: [e] });
  assert.equal(plan.steps.length, 1, 'a lone sidecar is still something to move');
  assert.deepEqual(plan.steps[0].items.map((i) => i.from), [`${e.legacyPaths[0]}-wal`]);

  applyMigration(plan);
  assert.equal(readFileSync(`${e.target}-wal`, 'utf-8'), 'wal-only');
  assert.equal(statSync(`${e.target}-wal`).mode & 0o777, 0o600, 'the sidecar must be tightened too');
  assert.equal(existsSync(e.target), false, 'and no empty main file is invented');
});

test('a claimed destination is released again when the source cannot be unlinked', () => {
  // The same-device path claims `to` with link(2) and then unlinks `from`.
  // If that unlink fails, leaving the link behind hands the NEXT run a
  // both-present warning over a file that never actually moved -- the
  // partial-destination trap (F4) that the copy path already cleans up after
  // itself for.
  const e = entry();
  put(e.legacyPaths[0], 'payload');
  const deps = {
    ...nodeFs,
    statSync: (p) => (typeof p === 'string' && p.includes('old') ? { dev: 1 } : { dev: 1 }),
    unlinkSync: (p) => { if (p === e.legacyPaths[0]) { const err = new Error('operation not permitted'); err.code = 'EPERM'; throw err; } return nodeFs.unlinkSync(p); },
  };
  const plan = planMigration({ entries: [e], deps: { ...nodeFs, statSync: () => ({ dev: 1 }) } });
  assert.equal(plan.steps[0].mode, 'rename');
  assert.throws(() => applyMigration(plan, { deps }), /operation not permitted/);
  assert.equal(readFileSync(e.legacyPaths[0], 'utf-8'), 'payload', 'the source is untouched');
  assert.equal(existsSync(e.target), false, 'and nothing is left claiming the destination');
});

test('applyMigration reports what it moved and calls onLog per step', () => {
  const a = entry({ id: 'a' });
  const b = entry({ id: 'b' });
  put(a.legacyPaths[0]);
  put(b.legacyPaths[0]);
  const plan = { steps: [planMigration({ entries: [a] }).steps[0], planMigration({ entries: [b] }).steps[0]] };
  const logged = [];
  const result = applyMigration(plan, { onLog: (s) => logged.push(s.id) });
  assert.deepEqual(result.moved.map((s) => s.id), ['a', 'b']);
  assert.deepEqual(logged, ['a', 'b']);
});

// --- leftovers and breadcrumbs ----------------------------------------------

test('findLeftovers reports old copies that are no longer referenced', () => {
  const e = entry({ path: join(caseDir, 'new', 'thing') });   // already resolving to the new path
  put(e.legacyPaths[0], 'stale');
  const found = findLeftovers({ entries: [e] });
  assert.deepEqual(found.map((f) => f.path), [e.legacyPaths[0]]);
  assert.equal(existsSync(e.legacyPaths[0]), true, 'reporting only -- never deletes');
});

test('findLeftovers ignores env-overridden and sticky entries', () => {
  const overridden = entry({ id: 'o', overridden: true, path: '/elsewhere' });
  const sticky = entry({ id: 's', stickyLegacy: true, path: join(caseDir, 'new', 's') });
  put(overridden.legacyPaths[0]);
  put(sticky.legacyPaths[0]);
  assert.deepEqual(findLeftovers({ entries: [overridden, sticky] }), []);
});

test('breadcrumbs name the new roots so an old-branch boot leaves a trail', () => {
  // R9: the likeliest real accident is a host on an older branch restarting
  // after the migration and resolving the old paths -- it boots empty and
  // nothing in that old code can notice. A note where someone hunting for
  // the missing files will look is all that can be done.
  //
  // HOME is redirected for the duration: one breadcrumb goes to
  // legacyDataRoot(), which without this is the developer's real
  // ~/.local/share/ccserver-sandbox.
  const restore = withIsolatedHome(caseDir);
  try {
    const written = writeBreadcrumbs();
    assert.ok(written.length > 0);
    for (const path of written) {
      const text = readFileSync(path, 'utf-8');
      assert.match(text, /XDG/);
      assert.match(text, /古いブランチ/);
      rmSync(path, { force: true });
    }
  } finally {
    restore();
    resetLayoutCache();
  }
});

// --- non-regular files (attack-test-201 F6) ---------------------------------

test('★ F6: a FIFO at a legacy path is refused, not migrated into the new state dir', () => {
  // Migrating it faithfully was the bug: restoreGroups()/restoreSchedules()
  // then blocked forever in readFileSync (a FIFO with no writer waits, it
  // does not throw), so the server never finished booting and ignored
  // SIGTERM. Leaving it behind makes the new path simply absent, which every
  // reader already handles.
  const e = entry();
  mkdirSync(join(e.legacyPaths[0], '..'), { recursive: true });
  try {
    execFileSync('mkfifo', [e.legacyPaths[0]]);
  } catch {
    return; // no mkfifo on this platform
  }
  const plan = planMigration({ entries: [e] });
  assert.equal(plan.steps.length, 0, 'a FIFO must never become a move step');
  assert.equal(plan.warnings.length, 1);
  assert.equal(plan.warnings[0].reason, 'not-a-regular-file');
  assert.match(plan.warnings[0].message, /FIFO/);

  applyMigration(plan);
  assert.equal(existsSync(e.target), false, 'nothing may appear at the new path');
  assert.equal(lstatSync(e.legacyPaths[0]).isFIFO(), true, 'and the oddity stays where it was');
});

test('F6: a symlink at a legacy path is refused too (it is not the file it points at)', () => {
  const e = entry();
  const real = put(join(caseDir, 'elsewhere'), 'payload');
  mkdirSync(join(e.legacyPaths[0], '..'), { recursive: true });
  symlinkSync(real, e.legacyPaths[0]);
  const plan = planMigration({ entries: [e] });
  assert.equal(plan.steps.length, 0);
  assert.equal(plan.warnings[0].reason, 'not-a-regular-file');
  assert.match(plan.warnings[0].message, /symlink/);
});

test('F6: an odd SIDECAR is refused too, not just an odd main file', () => {
  // The kind check runs over every component that exists, so a FIFO planted
  // at ccserver.sqlite3-wal cannot ride along with a perfectly ordinary main
  // file into the new data directory.
  const e = entry({ id: 'db', kind: 'data', sidecars: ['-wal', '-shm'] });
  put(e.legacyPaths[0], 'main');
  try {
    execFileSync('mkfifo', [`${e.legacyPaths[0]}-wal`]);
  } catch {
    return; // no mkfifo on this platform
  }
  const plan = planMigration({ entries: [e] });
  assert.equal(plan.steps.length, 0, 'the whole entry is held back, main file included');
  assert.equal(plan.warnings[0].reason, 'not-a-regular-file');
  assert.equal(plan.warnings[0].path, `${e.legacyPaths[0]}-wal`, 'and it names the component at fault');
  applyMigration(plan);
  assert.equal(existsSync(e.target), false);
});

test('F6: ordinary files and directories are still migrated normally', () => {
  const f = entry({ id: 'f' });
  const d = entry({ id: 'd', type: 'dir' });
  put(f.legacyPaths[0], 'payload');
  mkdirSync(d.legacyPaths[0], { recursive: true });
  const plan = planMigration({ entries: [f, d] });
  assert.deepEqual(plan.steps.map((s) => s.id), ['f', 'd']);
  assert.deepEqual(plan.warnings, []);
});

// --- symlink-safe writes (attack-test-201 F5) -------------------------------

test('★ F5: writeBreadcrumbs does not write through a planted symlink', () => {
  // A sandboxed session whose cwd is the ccserver checkout can create
  // <repo>/.ccserver-state-moved.txt as a symlink to any file the operator
  // can write, then wait for them to run `npm run setup`. Following the link
  // destroyed the victim (~/.bashrc, ~/.ssh/authorized_keys, ...).
  const restore = withIsolatedHome(caseDir);
  try {
    const victim = put(join(caseDir, 'victim.txt'), 'VICTIM-IMPORTANT-CONTENT');
    const link = join(repoRoot(), '.ccserver-state-moved.txt');
    if (existsSync(link)) return;              // never disturb a real checkout
    symlinkSync(victim, link);
    try {
      writeBreadcrumbs();
      assert.equal(readFileSync(victim, 'utf-8'), 'VICTIM-IMPORTANT-CONTENT',
        'the symlink target must be untouched');
      assert.equal(lstatSync(link).isSymbolicLink(), false,
        'the planted link is replaced by a real file, not followed');
    } finally {
      rmSync(link, { force: true });
      rmSync(join(legacyDataRoot(), 'MOVED-TO-XDG.txt'), { force: true });
    }
  } finally {
    restore();
    resetLayoutCache();
  }
});

test('F5: writeFileNoFollow replaces an ordinary file normally', () => {
  const path = put(join(caseDir, 'plain.txt'), 'old');
  writeFileNoFollow(path, 'new', 0o600);
  assert.equal(readFileSync(path, 'utf-8'), 'new');
});
