// Issue #201 Step1. The first test below is the one that matters: it pins
// every registry entry's LEGACY resolution to the literal path that module
// used before #201 existed. If it passes, deploying this code moves nothing
// on a host that has not run the wizard -- which is the difference between
// a layout change and three production hosts booting on empty state.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  xdgConfigHome, xdgDataHome, xdgStateHome,
  configRoot, dataRoot, stateRoot, legacyDataRoot, repoRoot, repoParentDir,
  layoutMarkerPath, readLayout, layoutVersion, resetLayoutCache, setupRequired,
  allPaths, pathEntry, resolvePath, guardedPaths, scratchRoots, legacyHomeIndexFile,
  PATH_IDS, CURRENT_LAYOUT_VERSION, LEGACY_LAYOUT_VERSION,
} from './paths.js';

const XDG_VARS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'];
const CC_VARS = [
  'CCSERVER_LAYOUT', 'CCSERVER_DB_PATH', 'CCSERVER_GROUPS_PATH', 'CCSERVER_SANDBOX_CONFIG',
  'CCSERVER_SAVED_SESSIONS_PATH', 'CCSERVER_SCHEDULES_PATH', 'CCSERVER_GROUP_DOCS_PATH',
  'CCSERVER_GROUP_FILES_PATH', 'CCSERVER_NOTIFY_PATH', 'CCSERVER_VIKUNJA_TASKS_PATH',
  'CCSERVER_FEDERATION_HOME', 'CCSERVER_GROUP_FILES_ROOT', 'CCSERVER_ORCHESTRATOR_ROOT',
  'CCSERVER_ORCHESTRATOR_GENERATED_ROOT', 'CCSERVER_USAGE_CWD', 'CCSERVER_CODEX_USAGE_CWD',
  'CCSERVER_SANDBOX_HOME_ROOT', 'CCSERVER_WORKTREE_ROOT', 'CCSERVER_REVIEW_WORKTREE_ROOT',
  'CCSERVER_SANDBOX_DIND_ROOT',
];
const ENV_VARS = [...XDG_VARS, ...CC_VARS];
const saved = {};
let tmpRoot;
let caseDir;

before(() => {
  for (const k of ENV_VARS) saved[k] = process.env[k];
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-paths-'));
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
  for (const k of CC_VARS) delete process.env[k];
  resetLayoutCache();
});

function writeMarker(obj) {
  mkdirSync(configRoot(), { recursive: true });
  writeFileSync(layoutMarkerPath(), JSON.stringify(obj));
  resetLayoutCache();
}

// ===========================================================================
// THE REGRESSION NET
// ===========================================================================

// Every one of these is the literal expression the owning module used before
// #201, re-derived here rather than imported -- importing the registry to
// check the registry would prove nothing.
const LEGACY_EXPECTATIONS = {
  sandboxConfig: () => join(repoRoot(), 'server', 'sandbox.config.json'),
  savedSessions: () => join(repoRoot(), '.saved-sessions.json'),
  scheduledPrompts: () => join(repoRoot(), '.scheduled-prompts.json'),
  savedGroups: () => join(repoRoot(), '.saved-groups.json'),
  savedGroupDocs: () => join(repoRoot(), '.saved-group-docs.json'),
  savedGroupFiles: () => join(repoRoot(), '.saved-group-files.json'),
  savedNotifications: () => join(repoRoot(), '.saved-notifications.json'),
  savedVikunjaTasks: () => join(repoRoot(), '.saved-vikunja-tasks.json'),
  db: () => join(homedir(), '.local', 'share', 'ccserver-sandbox', 'ccserver.sqlite3'),
  federationHome: () => join(homedir(), '.local', 'share', 'ccserver-sandbox', 'federation'),
  groupFiles: () => join(homedir(), '.local', 'share', 'ccserver-sandbox', 'group-files'),
  orchestratorGenerated: () => join(homedir(), '.local', 'share', 'ccserver-sandbox', 'orchestrator-generated'),
  usageCwd: () => join(homedir(), '.local', 'share', 'ccserver-sandbox', 'usage-cwd'),
  codexUsageCwd: () => join(homedir(), '.local', 'share', 'ccserver-sandbox', 'codex-usage-cwd'),
  sandboxHome: () => join(homedir(), '.local', 'share', 'ccserver-sandbox', 'home'),
  worktrees: () => join(homedir(), '.local', 'share', 'ccserver-sandbox', 'worktrees'),
  reviewWorktrees: () => join(homedir(), '.local', 'share', 'ccserver-sandbox', 'review-worktrees'),
  orchestrator: () => join(homedir(), '.local', 'share', 'ccserver-sandbox', 'orchestrator'),
  dind: () => join(homedir(), '.local', 'share', 'ccserver-sandbox', 'dind'),
};

test('★ with no marker, every entry resolves to exactly the path it did before #201', () => {
  // No marker file has been written, so this is a host that pulled the code
  // and has not run the wizard -- the state all three production hosts are
  // in the moment this lands.
  assert.equal(layoutVersion(), LEGACY_LAYOUT_VERSION);
  for (const entry of allPaths()) {
    const expected = LEGACY_EXPECTATIONS[entry.id];
    assert.ok(expected, `${entry.id} has no legacy expectation recorded -- add one`);
    assert.equal(entry.path, expected(), `${entry.id} must not move without the wizard`);
  }
  assert.equal(
    Object.keys(LEGACY_EXPECTATIONS).length, allPaths().length,
    'every registry entry needs a legacy expectation, and vice versa',
  );
});

test('★ the legacy paths do NOT follow $XDG_DATA_HOME', () => {
  // The pre-#201 modules built ~/.local/share/ccserver-sandbox from
  // homedir() literally. A host with XDG_DATA_HOME pointed elsewhere still
  // has its real files under $HOME, so honoring XDG in legacy mode would
  // name a directory that does not contain them -- and boot empty.
  process.env.XDG_DATA_HOME = join(caseDir, 'somewhere-else');
  assert.equal(legacyDataRoot(), join(homedir(), '.local', 'share', 'ccserver-sandbox'));
  assert.equal(resolvePath(PATH_IDS.db), LEGACY_EXPECTATIONS.db());
  // ...while the XDG root does follow it.
  assert.equal(dataRoot(), join(caseDir, 'somewhere-else', 'ccserver'));
});

// ===========================================================================

test('XDG env vars are honored and the ccserver subdir is appended', () => {
  assert.equal(configRoot(), join(caseDir, 'config', 'ccserver'));
  assert.equal(dataRoot(), join(caseDir, 'data', 'ccserver'));
  assert.equal(stateRoot(), join(caseDir, 'state', 'ccserver'));
});

test('unset, empty and relative XDG values all fall back to the spec defaults', () => {
  for (const k of XDG_VARS) delete process.env[k];
  assert.equal(xdgConfigHome(), join(homedir(), '.config'));
  assert.equal(xdgDataHome(), join(homedir(), '.local', 'share'));
  assert.equal(xdgStateHome(), join(homedir(), '.local', 'state'));

  process.env.XDG_DATA_HOME = '';
  assert.equal(xdgDataHome(), join(homedir(), '.local', 'share'), 'empty string is not a path');

  process.env.XDG_DATA_HOME = 'relative/nope';
  assert.equal(xdgDataHome(), join(homedir(), '.local', 'share'), 'the spec requires absolute');
});

test('layoutVersion: absent marker is v1, a v2 marker is v2, garbage reads as v1', () => {
  assert.equal(layoutVersion(), LEGACY_LAYOUT_VERSION);
  assert.equal(setupRequired(), true);

  writeMarker({ layoutVersion: CURRENT_LAYOUT_VERSION, completedAt: 1 });
  assert.equal(layoutVersion(), CURRENT_LAYOUT_VERSION);
  assert.equal(setupRequired(), false);
  assert.equal(readLayout().completedAt, 1);

  mkdirSync(configRoot(), { recursive: true });
  writeFileSync(layoutMarkerPath(), 'not json at all');
  resetLayoutCache();
  assert.equal(layoutVersion(), LEGACY_LAYOUT_VERSION, 'a corrupt marker must fall back to today\'s paths');
});

test('CCSERVER_LAYOUT forces a layout in both directions, ignoring the marker', () => {
  writeMarker({ layoutVersion: CURRENT_LAYOUT_VERSION });
  process.env.CCSERVER_LAYOUT = 'legacy';
  assert.equal(layoutVersion(), LEGACY_LAYOUT_VERSION);
  assert.equal(resolvePath(PATH_IDS.db), LEGACY_EXPECTATIONS.db());

  delete process.env.CCSERVER_LAYOUT;
  resetLayoutCache();
  rmSync(layoutMarkerPath(), { force: true });
  resetLayoutCache();
  assert.equal(layoutVersion(), LEGACY_LAYOUT_VERSION);
  process.env.CCSERVER_LAYOUT = 'xdg';
  assert.equal(layoutVersion(), CURRENT_LAYOUT_VERSION);
  assert.equal(resolvePath(PATH_IDS.db), join(dataRoot(), 'ccserver.sqlite3'));
});

test('once migrated, every entry resolves under the three XDG roots', () => {
  writeMarker({ layoutVersion: CURRENT_LAYOUT_VERSION });
  const roots = { config: configRoot(), data: dataRoot(), state: stateRoot() };
  for (const entry of allPaths()) {
    assert.ok(
      entry.path.startsWith(roots[entry.kind]),
      `${entry.id} (${entry.kind}) resolved to ${entry.path}, outside ${roots[entry.kind]}`,
    );
  }
});

test('an env var beats BOTH layouts', () => {
  const custom = join(caseDir, 'my.sqlite3');
  process.env.CCSERVER_DB_PATH = custom;
  assert.equal(resolvePath(PATH_IDS.db), custom, 'legacy layout');
  assert.equal(pathEntry(PATH_IDS.db).overridden, true);

  writeMarker({ layoutVersion: CURRENT_LAYOUT_VERSION });
  assert.equal(resolvePath(PATH_IDS.db), custom, 'xdg layout');
});

test('an empty env var is treated as unset, not as a path', () => {
  process.env.CCSERVER_GROUPS_PATH = '';
  assert.equal(pathEntry(PATH_IDS.savedGroups).overridden, false);
  assert.equal(resolvePath(PATH_IDS.savedGroups), LEGACY_EXPECTATIONS.savedGroups());
});

test('sticky trees stay at the path the marker recorded, not at the XDG target', () => {
  // The wizard leaves these behind and writes down where. Resolution reads
  // that record rather than probing the filesystem, so it cannot race an
  // empty directory into existence at the new root.
  const at = join(caseDir, 'legacy-worktrees');
  writeMarker({
    layoutVersion: CURRENT_LAYOUT_VERSION,
    kept: [{ id: 'worktrees', at, reason: 'sticky-large' }],
  });
  const entry = pathEntry(PATH_IDS.worktrees);
  assert.equal(entry.path, at);
  assert.equal(entry.keptLegacy, true);
  // A sticky entry with no kept record was moved (--move-large) or never
  // existed, so it uses the new root.
  assert.equal(resolvePath(PATH_IDS.dind), join(dataRoot(), 'dind'));
  assert.equal(pathEntry(PATH_IDS.dind).keptLegacy, false);
});

test('the sqlite entry carries both historical spellings, newest first', () => {
  const legacy = pathEntry(PATH_IDS.db).legacyPaths;
  assert.deepEqual(legacy, [
    join(legacyDataRoot(), 'ccserver.sqlite3'),
    join(repoParentDir(), 'ccserver.sqlite3'),
  ]);
  // repoParentDir is the repo's PARENT -- the historical '..' off-by-one --
  // and must not be confused with repoRoot.
  assert.notEqual(repoParentDir(), repoRoot());
  assert.equal(join(repoRoot(), '..'), repoParentDir());
});

test('scratchRoots returns both trees, in every layout', () => {
  // pathPolicy.js's bwrap exemption depends on this; dropping either root
  // strands whichever sessions are on the other side of the migration.
  assert.deepEqual(scratchRoots(), [dataRoot(), legacyDataRoot()]);
  writeMarker({ layoutVersion: CURRENT_LAYOUT_VERSION });
  assert.deepEqual(scratchRoots(), [dataRoot(), legacyDataRoot()]);
});

test('guardedPaths covers every internal entry and labels it with its env var', () => {
  const guarded = guardedPaths();
  assert.equal(guarded.length, allPaths().length, 'every registry entry is ccserver-internal');
  for (const g of guarded) {
    assert.ok(g.path && g.label && g.envVar, `${g.id} needs a path, label and env var`);
  }
  // The refusal message tells operators to use the env var, so every entry
  // must actually have one -- .scheduled-prompts.json famously did not.
  assert.equal(pathEntry(PATH_IDS.scheduledPrompts).envVar, 'CCSERVER_SCHEDULES_PATH');
});

test('the federation entry guards the whole directory, so instance.crt is covered', () => {
  const e = pathEntry(PATH_IDS.federationHome);
  assert.equal(e.type, 'dir');
  assert.equal(e.guard, true);
  assert.equal(e.mode, 0o700);
});

test('legacyHomeIndexFile sits inside whichever sandbox home is live', () => {
  assert.equal(legacyHomeIndexFile(), join(resolvePath(PATH_IDS.sandboxHome), '.index.json'));
  writeMarker({ layoutVersion: CURRENT_LAYOUT_VERSION });
  assert.equal(legacyHomeIndexFile(), join(dataRoot(), 'home', '.index.json'));
});

test('registry integrity: unique ids, non-empty labels, targets distinct from legacy', () => {
  const all = allPaths();
  assert.equal(new Set(all.map((e) => e.id)).size, all.length, 'ids must be unique');
  for (const e of all) {
    assert.ok(e.label.length > 0, `${e.id} needs a label`);
    assert.ok(e.path.startsWith('/'), `${e.id} must be absolute`);
    assert.ok(['config', 'data', 'state'].includes(e.kind), `${e.id} kind`);
    assert.ok(['file', 'dir'].includes(e.type), `${e.id} type`);
    assert.ok(e.legacyPaths.length > 0, `${e.id} needs at least one legacy path`);
    for (const legacy of e.legacyPaths) {
      assert.notEqual(legacy, e.target, `${e.id}: a legacy path equal to the target means nothing would move`);
    }
  }
  assert.deepEqual(Object.keys(PATH_IDS).sort(), all.map((e) => e.id).sort());
});

test('only the DB declares sidecars, and it declares both', () => {
  for (const e of allPaths()) {
    assert.deepEqual(e.sidecars, e.id === 'db' ? ['-wal', '-shm'] : []);
  }
});

test('pathEntry rejects an unknown id rather than returning undefined', () => {
  assert.throws(() => pathEntry('nope'), /unknown path registry id/);
});

test('the sticky and ephemeral sets are exactly what the wizard expects', () => {
  const sticky = allPaths().filter((e) => e.stickyLegacy).map((e) => e.id).sort();
  assert.deepEqual(sticky, ['dind', 'orchestrator', 'reviewWorktrees', 'sandboxHome', 'worktrees']);
  const ephemeral = allPaths().filter((e) => e.ephemeral).map((e) => e.id).sort();
  assert.deepEqual(ephemeral, ['codexUsageCwd', 'usageCwd']);
});
