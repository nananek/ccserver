// Issue #201 Step7. Runs the wizard as a real child process against a
// throwaway XDG triple, the way an operator does -- same spawnSync + LC_ALL
// harness as cli.test.js, which is also where the dry-run/--yes contract
// these assertions pin was established.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnWizard } from '../testIsolation.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
let tmpRoot;
let caseDir;

before(() => { tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-setup-cli-')); });
after(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

beforeEach(() => {
  caseDir = mkdtempSync(join(tmpRoot, 'case-'));
});

function roots() {
  return {
    config: join(caseDir, 'config', 'ccserver'),
    data: join(caseDir, 'data', 'ccserver'),
    state: join(caseDir, 'state', 'ccserver'),
  };
}

// Every spawn of the real wizard goes through spawnWizard(), which isolates
// HOME as well as the XDG roots and ABORTS if either resolves outside the
// temp tree. legacyDataRoot() is homedir()-based, so without that a `--yes`
// here would migrate the operator's live DB, federation key and group-files
// into caseDir -- which after() deletes.
function runSetup(args = [], extraEnv = {}) {
  return spawnWizard(caseDir, args, extraEnv);
}

function marker() {
  return JSON.parse(readFileSync(join(roots().config, 'layout.json'), 'utf-8'));
}

// --- argument handling ------------------------------------------------------

test('an unknown flag exits 2 without touching anything', () => {
  const res = runSetup(['--yse']);
  assert.equal(res.status, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /不明な引数/);
  assert.equal(existsSync(roots().config), false);
});

test('--help prints the usage and exits 0', () => {
  const res = runSetup(['--help']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /--move-large/);
  assert.match(res.stdout, /--seed-example/);
  assert.equal(existsSync(roots().config), false, '--help must not create anything');
});

test('--json emits a machine-readable plan and no prose', () => {
  const res = runSetup(['--json']);
  assert.equal(res.status, 0, res.stderr);
  const plan = JSON.parse(res.stdout);
  assert.equal(plan.layoutVersion, 1);
  assert.equal(plan.targetLayoutVersion, 2);
  assert.equal(plan.roots.config, roots().config);
  assert.ok(Array.isArray(plan.steps));
});

// --- fresh install ----------------------------------------------------------

test('a dry run on a fresh host changes NOTHING -- no marker, no directories', () => {
  const res = runSetup();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /ドライラン/);
  assert.match(res.stdout, /--yes/);
  assert.equal(existsSync(roots().config), false);
  assert.equal(existsSync(roots().data), false);
  assert.equal(existsSync(roots().state), false);
});

test('--yes writes the marker at v2 and creates all three roots at 0700', () => {
  const res = runSetup(['--yes']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(marker().layoutVersion, 2);
  assert.ok(Number.isInteger(marker().completedAt));
  for (const dir of Object.values(roots())) {
    assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
  }
});

test('★ the generated sandbox.config.json is MINIMAL and has no gpg key', () => {
  // Copying sandbox.config.example.json verbatim would set "gpg": true, and
  // sandbox.js reads that as `raw.gpg === true` -- absent means false. So a
  // verbatim copy would silently start forwarding the host's gpg-agent and
  // ~/.gnupg into every sandbox as a side effect of running a migration.
  runSetup(['--yes']);
  const path = join(roots().config, 'sandbox.config.json');
  const text = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed), ['//'], 'only the pointer comment');
  assert.equal('gpg' in parsed, false);
  assert.match(parsed['//'], /sandbox\.config\.example\.json/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('--seed-example opts into the full annotated example instead', () => {
  runSetup(['--yes', '--seed-example']);
  const text = readFileSync(join(roots().config, 'sandbox.config.json'), 'utf-8');
  assert.equal(text, readFileSync(join(REPO_ROOT, 'server', 'sandbox.config.example.json'), 'utf-8'));
});

test('re-running is idempotent and does not rewrite completedAt', async () => {
  runSetup(['--yes']);
  const first = marker().completedAt;
  await new Promise((r) => setTimeout(r, 5));

  const again = runSetup();
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /移行するものはありません/);
  assert.match(again.stdout, /v2 \(移行済み/);

  const reapply = runSetup(['--yes']);
  assert.equal(reapply.status, 0, reapply.stderr);
  assert.equal(marker().completedAt, first, 'the original completion time is history, not a timestamp to bump');
});

// --- migration --------------------------------------------------------------

// Builds a legacy layout the wizard can see. The repo-root state files are
// real paths, so each is removed again afterwards.
function seedLegacyState(names) {
  const made = [];
  for (const name of names) {
    const path = join(REPO_ROOT, name);
    if (existsSync(path)) continue;        // never clobber a developer's real file
    writeFileSync(path, JSON.stringify({ seeded: name }));
    made.push(path);
  }
  return made;
}

test('a dry run lists the state files it would move, and moves none of them', () => {
  const made = seedLegacyState(['.saved-notifications.json']);
  try {
    if (made.length === 0) return;         // the checkout already had one
    const res = runSetup();
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /saved-notifications\.json/);
    assert.match(res.stdout, /移動するもの/);
    assert.equal(existsSync(made[0]), true, 'a dry run moves nothing');
    assert.equal(existsSync(join(roots().state, 'saved-notifications.json')), false);
  } finally {
    for (const p of made) rmSync(p, { force: true });
  }
});

test('--yes actually relocates a state file and drops the leading dot', () => {
  const made = seedLegacyState(['.saved-vikunja-tasks.json']);
  try {
    if (made.length === 0) return;
    const res = runSetup(['--yes']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(existsSync(made[0]), false, 'the old path is emptied');
    const moved = join(roots().state, 'saved-vikunja-tasks.json');
    assert.deepEqual(JSON.parse(readFileSync(moved, 'utf-8')), { seeded: '.saved-vikunja-tasks.json' });
    assert.ok(marker().migrated.includes('savedVikunjaTasks'));
  } finally {
    for (const p of made) rmSync(p, { force: true });
  }
});

test('a cross-filesystem move is announced as copy-delete before it runs', () => {
  // $TMPDIR and the repo checkout are on different mounts in most sandboxes
  // and CI images; when they are not, the plan legitimately says 'rename'
  // and there is nothing to assert.
  const made = seedLegacyState(['.saved-group-docs.json']);
  try {
    if (made.length === 0) return;
    const plan = JSON.parse(runSetup(['--json']).stdout);
    const step = plan.steps.find((s) => s.id === 'savedGroupDocs');
    assert.ok(step, 'the seeded file must appear as a step');
    if (step.mode !== 'copy-delete') return;
    assert.match(runSetup().stdout, /別FS: コピー＋削除/);
  } finally {
    for (const p of made) rmSync(p, { force: true });
  }
});

// --- env overrides and sticky trees -----------------------------------------

test('an env-overridden path is named as untouched and never appears as a move', () => {
  const custom = join(caseDir, 'mygroups.json');
  writeFileSync(custom, '[]');
  const res = runSetup([], { CCSERVER_GROUPS_PATH: custom });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /env var で上書き済み/);
  assert.match(res.stdout, /CCSERVER_GROUPS_PATH/);

  const plan = JSON.parse(runSetup(['--json'], { CCSERVER_GROUPS_PATH: custom }).stdout);
  assert.equal(plan.steps.some((s) => s.id === 'savedGroups'), false);
  assert.ok(plan.skips.some((s) => s.id === 'savedGroups' && s.reason === 'env-override'));
});

test('an env-overridden DB is named in the output and stays put', () => {
  const custom = join(caseDir, 'my.sqlite3');
  writeFileSync(custom, 'not-really-sqlite');
  const res = runSetup(['--yes'], { CCSERVER_DB_PATH: custom });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readFileSync(custom, 'utf-8'), 'not-really-sqlite');
  assert.equal(existsSync(join(roots().data, 'ccserver.sqlite3')), false);
  assert.ok(marker().skipped.some((s) => s.id === 'db'));
});

// The sticky trees live under legacyDataRoot(), which is homedir()-based --
// and spawnWizard() points $HOME at caseDir/home. So they have to be seeded
// THERE. An earlier version of this test built them under caseDir directly
// and then looped over plan.kept, which was therefore always empty: every
// assertion was inside a loop that never ran and a deepEqual([], []). It
// passed no matter what the wizard did with a sticky tree.
function legacySandboxRoot() {
  return join(caseDir, 'home', '.local', 'share', 'ccserver-sandbox');
}

test('sticky trees are recorded in kept[] rather than moved', () => {
  const legacyWorktrees = join(legacySandboxRoot(), 'worktrees');
  mkdirSync(join(legacyWorktrees, 'proj'), { recursive: true });

  const plan = JSON.parse(runSetup(['--json']).stdout);
  assert.ok(plan.kept.length > 0, 'the seeded worktrees tree must be reported as kept');
  const worktrees = plan.kept.find((k) => k.id === 'worktrees');
  assert.ok(worktrees, `worktrees must be kept; got ${JSON.stringify(plan.kept)}`);
  assert.equal(worktrees.at, legacyWorktrees);
  for (const k of plan.kept) {
    assert.equal(k.reason, 'sticky-large');
    assert.equal(plan.steps.some((s) => s.id === k.id), false, `${k.id} must not also be a step`);
  }

  runSetup(['--yes']);
  assert.deepEqual(marker().kept.map((k) => k.id).sort(), plan.kept.map((k) => k.id).sort());
  // Still where it was, and the marker is what makes resolution keep
  // pointing at it (rather than an existsSync probe that could race).
  assert.equal(existsSync(join(legacyWorktrees, 'proj')), true);
  assert.equal(existsSync(join(roots().data, 'worktrees')), false);
});

test('★ --move-large really moves a sticky tree, and clears it from kept[]', () => {
  const legacyWorktrees = join(legacySandboxRoot(), 'worktrees');
  mkdirSync(join(legacyWorktrees, 'proj'), { recursive: true });
  writeFileSync(join(legacyWorktrees, 'proj', 'f.txt'), 'WORKTREE-CONTENT');

  runSetup(['--yes', '--move-large']);
  assert.equal(readFileSync(join(roots().data, 'worktrees', 'proj', 'f.txt'), 'utf-8'), 'WORKTREE-CONTENT');
  assert.equal(existsSync(legacyWorktrees), false, 'the old location is emptied');
  assert.deepEqual(marker().kept, [], 'nothing is sticky once it has been moved');
  assert.ok(marker().migrated.includes('worktrees'));
});

test('a both-present entry is warned about in BOTH the dry run and --yes', () => {
  // rev2 §3-A keeps this a warning and not a blocker on purpose (a blocker
  // leaves the operator with no way to ever finish), so being impossible to
  // miss is all the enforcement it gets. It has to survive on an
  // already-migrated host too, which is where it is most likely to appear.
  const legacyFed = join(legacySandboxRoot(), 'federation');
  mkdirSync(legacyFed, { recursive: true });
  writeFileSync(join(legacyFed, 'instance.key'), 'OLD-KEY');
  runSetup(['--yes']);                       // moves it; host is now v2
  mkdirSync(legacyFed, { recursive: true }); // and it reappears at the old path
  writeFileSync(join(legacyFed, 'instance.key'), 'RESURRECTED');

  const dry = runSetup();
  assert.match(dry.stdout, /両方にあります/, 'the dry run must say so');
  assert.match(dry.stdout, /警告/);

  const yes = runSetup(['--yes']);
  assert.match(yes.stdout, /両方にあります/, '--yes must say so too, after the move list');
  assert.equal(readFileSync(join(legacyFed, 'instance.key'), 'utf-8'), 'RESURRECTED', 'and merge nothing');
  assert.equal(readFileSync(join(roots().data, 'federation', 'instance.key'), 'utf-8'), 'OLD-KEY');
});

test('★ the dry run predicts what --yes does on an ALREADY-MIGRATED host', () => {
  // This used to be wrong: printPlan() was skipped once the marker said v2,
  // so a host with a legacy file left behind (a rolled-back run, or an older
  // branch booted once and re-creating it) printed
  // "移行するものはありません" and then --yes moved the file anyway.
  runSetup(['--yes']);
  const legacyLeft = join(legacySandboxRoot(), 'orchestrator-generated');
  mkdirSync(legacyLeft, { recursive: true });
  writeFileSync(join(legacyLeft, 'x.md'), 'LEFT-BEHIND');

  const dry = runSetup();
  assert.match(dry.stdout, /移動するもの/, 'the dry run must announce the pending move');
  assert.match(dry.stdout, /orchestrator-generated/);
  assert.doesNotMatch(dry.stdout, /移行するものはありません/);
  assert.equal(existsSync(join(legacyLeft, 'x.md')), true, 'and still move nothing');

  const yes = runSetup(['--yes']);
  assert.match(yes.stdout, /移動しました/);
  assert.equal(readFileSync(join(roots().data, 'orchestrator-generated', 'x.md'), 'utf-8'), 'LEFT-BEHIND');
});

// --- the wizard must not open the DB ----------------------------------------

test('★ the wizard never opens the database (no -wal/-shm appear next to it)', () => {
  // Opening the DB at the old path moments before moving it would create
  // sidecars the plan was computed without.
  const dbDir = join(caseDir, 'dbhome');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'ccserver.sqlite3');
  writeFileSync(dbPath, 'x');
  runSetup(['--yes'], { CCSERVER_DB_PATH: dbPath });
  assert.deepEqual(readdirSync(dbDir), ['ccserver.sqlite3'], 'no WAL/SHM sidecars were created');
});
