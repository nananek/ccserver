// Issue #201 Step3. Two things here are load-bearing beyond the obvious:
// the all-plan rollback (a half-migrated host is worse than an un-migrated
// one) and the EXDEV branch, which the real migration hits whenever the repo
// checkout and $HOME are on different mounts -- a normal deployment, not an
// exotic one.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planMigration, applyMigration, nodeFs, findLeftovers, writeBreadcrumbs } from './pathMigration.js';
import { resetLayoutCache } from './paths.js';
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

test('a non-EXDEV rename error is NOT silently turned into a copy', () => {
  const e = entry();
  put(e.legacyPaths[0]);
  const deps = {
    ...nodeFs,
    renameSync: () => { const err = new Error('permission denied'); err.code = 'EACCES'; throw err; },
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

  const plan = { steps: [a, b, c].map((e) => planMigration({ entries: [e] }).steps[0]).filter(Boolean) };
  assert.equal(plan.steps.length, 2, 'c is a both-present warning, so build the failing case explicitly');

  // Build c's step by hand: the plan was computed before the target appeared.
  const cStep = { ...planMigration({ entries: [{ ...c, target: join(caseDir, 'new', 'c') }] }).steps[0] };
  const full = { steps: [...plan.steps, { ...cStep, to: c.target, items: [{ from: c.legacyPaths[0], to: c.target }] }] };

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
  let renames = 0;
  const deps = {
    ...nodeFs,
    renameSync: (from, to) => {
      if (++renames === 2) throw new Error('disk full');
      return nodeFs.renameSync(from, to);
    },
  };
  assert.throws(() => applyMigration(plan, { deps }), /disk full/);
  assert.equal(readFileSync(e.legacyPaths[0], 'utf-8'), 'main', 'the main file came back');
  assert.equal(existsSync(e.target), false, 'nothing is left at the destination');
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
