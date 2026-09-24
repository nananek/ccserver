// Test-only support module (not imported by any production code path).
//
// Why this exists, and why it asserts instead of merely helping.
//
// server/cli/setup.js MOVES files. A test that runs it has to be certain that
// everything the registry can name resolves inside the test's own scratch
// directory -- and the registry names things in TWO places that no obvious
// environment tweak relocates:
//
//   1. $HOME. paths.js's legacyDataRoot() is built from homedir() on purpose
//      and deliberately does NOT honor $XDG_DATA_HOME (see its comment: every
//      pre-#201 module hardcoded ~/.local/share/ccserver-sandbox, so honoring
//      XDG there would fail to name the operator's real files). Isolating the
//      three XDG variables is therefore NOT enough: a child with the real
//      $HOME still resolves the operator's live SQLite DB, GPG vault, mTLS
//      federation key and group-files, and `setup.js --yes` dutifully
//      migrates all of it into the test's temp directory, which the test then
//      deletes in its `finally`.
//
//   2. THE CHECKOUT AND ITS PARENT. repoRoot() is import.meta.url-based, so
//      it points at the real working tree no matter what the environment
//      says, and eight registry entries have their legacy location there:
//      server/sandbox.config.json plus the seven .saved-*.json /
//      .scheduled-prompts.json state files at the repo root. On an
//      un-migrated host sandbox.config.json is the LIVE config -- browseRoots,
//      binds, webhook URLs -- so a developer running `npm test` in their own
//      checkout lost it, along with their saved sessions, groups, group docs,
//      group files, notification subscriptions, schedules and Vikunja tasks.
//      A ninth lives one level HIGHER: the db entry's second legacy spelling
//      is repoParentDir()/ccserver.sqlite3, the pre-#190 default, which
//      paths.js keeps forever because real checkouts still have one there.
//      getDb()'s automatic old-old -> old hop RELOCATES it, and since it is
//      outside both $HOME and the checkout, neither of the other guards sees
//      it -- found by server/tools/path-canary.js on its first run, after
//      three rounds of hand-placed decoys had all missed it.
//      Since no env var can move repoRoot(), the only way to keep the wizard
//      and the spawned servers away from these is to hand them an explicit
//      CCSERVER_* override per entry, which turns each one into an
//      `env-override` skip (and, for the DB, makes migrateLegacyDbFile()
//      return immediately).
//
// Neither of these is hypothetical. (1) was found by an attacker-perspective
// review of this branch, reproduced against a fake $HOME; (2) survived that
// first fix and was found by the follow-up verification -- one run of
// startup-setup-gate.test.js was enough to destroy all eight.
//
// So: every test that spawns the wizard goes through spawnWizard(), which
// builds the env AND asserts on it, and anything that spawns a server goes
// through isolatedEnv(). The assertion is the point -- a future test that
// forgets fails loudly instead of eating someone's data.

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const SETUP_CLI = join(SERVER_DIR, 'cli', 'setup.js');
const REPO_ROOT = join(SERVER_DIR, '..');

// Registry entries whose legacy location is outside the isolated $HOME -- in
// the checkout or its parent (see the header's point 2). Mirrors
// server/paths.js's `sandboxConfig` entry, its STATE_FILES table, and the db
// entry's repoParentDir() spelling; the test at the bottom of
// testIsolation.test.js pins this list against the registry, so the two
// cannot drift apart silently.
const CHECKOUT_ENTRIES = [
  // Not in the checkout itself but in its PARENT -- see the header's point 2.
  ['db', 'CCSERVER_DB_PATH', 'ccserver.sqlite3'],
  ['sandboxConfig', 'CCSERVER_SANDBOX_CONFIG', 'sandbox.config.json'],
  ['savedSessions', 'CCSERVER_SAVED_SESSIONS_PATH', 'saved-sessions.json'],
  ['scheduledPrompts', 'CCSERVER_SCHEDULES_PATH', 'scheduled-prompts.json'],
  ['savedGroups', 'CCSERVER_GROUPS_PATH', 'saved-groups.json'],
  ['savedGroupDocs', 'CCSERVER_GROUP_DOCS_PATH', 'saved-group-docs.json'],
  ['savedGroupFiles', 'CCSERVER_GROUP_FILES_PATH', 'saved-group-files.json'],
  ['savedNotifications', 'CCSERVER_NOTIFY_PATH', 'saved-notifications.json'],
  ['savedVikunjaTasks', 'CCSERVER_VIKUNJA_TASKS_PATH', 'saved-vikunja-tasks.json'],
];

export const CHECKOUT_ENTRY_IDS = CHECKOUT_ENTRIES.map(([id]) => id);

// Breadcrumbs the wizard drops (pathMigration.js's writeBreadcrumbs, R9). The
// one under legacyDataRoot() lands inside the isolated HOME and goes away with
// the scratch directory; this one lands in the real checkout, so spawnWizard
// cleans it up rather than leaving litter behind after every run.
const CHECKOUT_BREADCRUMB = join(REPO_ROOT, '.ccserver-state-moved.txt');

// Resolves symlinks before comparing. A purely lexical check is defeated by a
// symlink INSIDE the scratch directory: point <dir>/home at the real $HOME and
// "is it under <dir>" is true while the wizard follows the link straight out
// to the operator's data (reproduced). Real callers use mkdtemp and would not
// do that, but a guard whose whole job is preventing data loss should not be
// undone by the one filesystem feature it is guaranteed to meet.
//
// Only the leading, already-existing part of a path can be resolved -- the
// XDG roots usually do not exist yet when this runs -- so walk up to the
// nearest existing ancestor, realpath THAT, and re-attach the remainder.
//
// The walk-up has to tell two failures apart, or it reopens the hole it
// closes. realpathSync throws for a path that does not exist AND for a
// DANGLING symlink (one whose target does not exist yet). Treating both as
// "not there" made <scratch>/home -> /outside/not-yet resolve back to
// <scratch>/home and pass the containment check, which is the lexical bug
// again wearing a different hat. So a symlink is followed explicitly --
// lstat says it is one even when its target is missing -- and only a genuine
// ENOENT walks up.
function realOrNearest(path, hops = 0) {
  const abs = resolve(path);
  let head = abs;
  const tail = [];
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch { /* absent, or a dangling symlink -- distinguished below */ }

    let link = null;
    try { if (lstatSync(head).isSymbolicLink()) link = readlinkSync(head); } catch { /* truly absent */ }
    if (link !== null) {
      // A dangling symlink still NAMES somewhere. Follow it to that name and
      // keep resolving from there. The hop cap makes a symlink cycle return
      // something outside any scratch root rather than spin forever, which
      // fails closed.
      if (hops > 32) return join('/__symlink-loop__', ...tail);
      const target = resolve(dirname(head), link);
      return realOrNearest(tail.length === 0 ? target : join(target, ...tail), hops + 1);
    }

    const parent = dirname(head);
    if (parent === head) return abs;      // nothing on this path exists
    tail.unshift(basename(head));
    head = parent;
  }
}

function isUnder(path, root) {
  const abs = realOrNearest(path);
  const base = realOrNearest(root);
  return abs === base || abs.startsWith(base + sep);
}

// The CCSERVER_* overrides that point the checkout-derived entries at `dir`
// instead of at the real working tree. Exported so a test can compose it into
// an env it builds itself, and so testIsolation.test.js can assert on it.
//
// `allow` names registry ids (see CHECKOUT_ENTRY_IDS) that are deliberately
// left un-overridden because the test's whole point is to migrate that entry
// out of the checkout. Naming one is an explicit acknowledgement: it makes the
// test responsible for seeding and removing its own file.
export function checkoutEnv(dir, { allow = [] } = {}) {
  for (const id of allow) {
    if (!CHECKOUT_ENTRY_IDS.includes(id)) {
      throw new Error(`checkoutEnv: ${id} is not a checkout-derived registry entry (have: ${CHECKOUT_ENTRY_IDS.join(', ')})`);
    }
  }
  const out = {};
  for (const [id, envVar, name] of CHECKOUT_ENTRIES) {
    if (allow.includes(id)) continue;
    out[envVar] = join(dir, 'checkout', name);
  }
  return out;
}

// A child env with HOME and all three XDG roots pointed inside `dir`, and
// every CCSERVER_* stripped so the runner's own environment cannot turn a
// registry entry into an env-override and change what is being tested.
//
// This alone is the right env for spawning a SERVER, which never migrates
// anything. Spawning the WIZARD needs the checkout overrides on top -- see
// spawnWizard, which is how every test does it.
export function isolatedEnv(dir, extra = {}) {
  if (!isUnder(dir, tmpdir())) {
    throw new Error(`isolatedEnv: ${dir} is not under ${tmpdir()} -- refusing to build a test env outside the temp tree`);
  }
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });

  const base = { ...process.env };
  for (const key of Object.keys(base)) {
    if (key.startsWith('CCSERVER_') || key.startsWith('XDG_')) delete base[key];
  }
  return {
    ...base,
    HOME: home,
    XDG_CONFIG_HOME: join(dir, 'config'),
    XDG_DATA_HOME: join(dir, 'data'),
    XDG_STATE_HOME: join(dir, 'state'),
    ...extra,
  };
}

// Call this immediately before anything that MOVES files (the wizard with
// --yes). Throws unless every place the registry can resolve to lands inside
// `root`, the scratch directory this test allocated: HOME, the three XDG
// roots, and each checkout-derived entry's override.
//
// Anchored on `root`, NOT on tmpdir(): "is it somewhere under /tmp" is a
// property an attacker-shaped accident satisfies for free. A developer (or CI
// image) whose $HOME is itself a directory under /tmp -- which is exactly how
// this branch's own fake-HOME verification runs -- would pass a
// tmpdir()-relative check while still pointing the wizard at that real home,
// and the wizard would migrate it. Requiring the paths to be under the
// specific directory the caller made has no such hole.
export function assertSafeToMigrate(env, root, { allowCheckoutMigration = [] } = {}) {
  if (!root) throw new Error('assertSafeToMigrate: the scratch root is required');
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
    const value = env[key];
    if (!value || !isUnder(value, root)) {
      throw new Error(
        `assertSafeToMigrate: ${key}=${value ?? '(unset)'} is outside the test scratch directory ${root}. `
        + 'Running the setup wizard with this env could migrate real host data.',
      );
    }
  }
  // The checkout half. No environment variable moves repoRoot(), so the only
  // thing standing between the wizard and the developer's live
  // server/sandbox.config.json is an explicit override per entry.
  for (const [id, envVar] of CHECKOUT_ENTRIES) {
    if (allowCheckoutMigration.includes(id)) continue;
    const value = env[envVar];
    if (!value || !isUnder(value, root)) {
      throw new Error(
        `assertSafeToMigrate: ${envVar}=${value ?? '(unset)'} is outside the test scratch directory ${root}. `
        + `Without it the wizard would migrate ${id} out of the real checkout `
        + '(see testIsolation.js). Use checkoutEnv(root), or pass '
        + `allowCheckoutMigration: ['${id}'] if the test really means to move it.`,
      );
    }
  }
}

// In-process equivalent: points HOME and the XDG roots at `dir` for the
// current process and returns a restore function. os.homedir() reads $HOME on
// POSIX on every call, so this really does move legacyDataRoot().
//
// Does NOT cover the checkout-derived entries -- its callers plan and inspect,
// they do not run the wizard over the whole registry. Anything that applies a
// migration belongs in spawnWizard.
export function withIsolatedHome(dir) {
  if (!isUnder(dir, tmpdir())) {
    throw new Error(`withIsolatedHome: ${dir} is not under ${tmpdir()}`);
  }
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(dir, 'config');
  process.env.XDG_DATA_HOME = join(dir, 'data');
  process.env.XDG_STATE_HOME = join(dir, 'state');
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  };
}

// The ONE sanctioned way for a test to run the real wizard as a child
// process. Everything that spawns server/cli/setup.js goes through here, so
// the isolation cannot be skipped by forgetting to call it -- which is the
// whole point. Relying on "remember to isolate HOME" as a convention is what
// produced the data loss in the first place; this makes the convention
// mechanical.
//
// Checks the RESOLVED values immediately before spawning (not at env
// construction time), so an `extra` override that reintroduces the real HOME,
// or clears one of the checkout overrides, is caught too.
export function spawnWizard(dir, args = [], extra = {}, { allowCheckoutMigration = [] } = {}) {
  const env = isolatedEnv(dir, {
    LC_ALL: 'C',
    PORT: '1',
    ...checkoutEnv(dir, { allow: allowCheckoutMigration }),
    ...extra,
  });
  assertSafeToMigrate(env, dir, { allowCheckoutMigration });
  const hadBreadcrumb = existsSync(CHECKOUT_BREADCRUMB);
  try {
    return spawnSync(process.execPath, [SETUP_CLI, ...args], { env, encoding: 'utf8', timeout: 60000 });
  } finally {
    // The wizard writes this into the real checkout whenever it moves
    // anything. Gitignored, but litter -- and after a test run it names a
    // migration that happened in a temp directory that no longer exists.
    if (!hadBreadcrumb) {
      try { rmSync(CHECKOUT_BREADCRUMB, { force: true }); } catch { /* best effort */ }
    }
  }
}
