// Test-only support module (not imported by any production code path).
//
// Why this exists, and why it asserts instead of merely helping:
//
// Isolating $XDG_CONFIG_HOME / $XDG_DATA_HOME / $XDG_STATE_HOME is NOT enough
// to make a test that runs the setup wizard safe. server/paths.js's
// legacyDataRoot() is deliberately built from homedir() and deliberately does
// NOT honor $XDG_DATA_HOME (see its comment: every pre-#201 module hardcoded
// ~/.local/share/ccserver-sandbox, so honoring XDG there would fail to name
// the operator's real files). That means a child process with the real $HOME
// resolves the operator's REAL legacy tree no matter what the XDG variables
// say -- and `setup.js --yes` will dutifully migrate their live SQLite DB,
// federation private key and group-files into the test's temp directory,
// which the test then deletes in its `finally`.
//
// That is not hypothetical: it was found by an attacker-perspective review of
// this very branch, reproduced against a fake $HOME, and it destroyed the DB,
// the federation key and the state files. `npm test` on any pre-#201 host
// would have done it for real.
//
// So every test that spawns the wizard, or a server that might run the
// legacy-to-legacy DB hop, must build its child env through isolatedEnv(),
// and anything that actually applies a migration must call
// assertSafeToMigrate() first. The assertion is the point: a future test that
// forgets HOME fails loudly instead of eating someone's data.

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETUP_CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli', 'setup.js');

function isUnder(path, root) {
  const abs = resolve(path);
  const base = resolve(root);
  return abs === base || abs.startsWith(base + sep);
}

// A child env with HOME and all three XDG roots pointed inside `dir`, and
// every CCSERVER_* stripped so the runner's own environment cannot turn a
// registry entry into an env-override and change what is being tested.
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
// --yes). Throws unless HOME and all three XDG roots resolve inside `root`,
// the scratch directory this test allocated.
//
// Anchored on `root`, NOT on tmpdir(): "is it somewhere under /tmp" is a
// property an attacker-shaped accident satisfies for free. A developer (or
// CI image) whose $HOME is itself a directory under /tmp -- which is exactly
// how this branch's own fake-HOME verification runs -- would pass a
// tmpdir()-relative check while still pointing the wizard at that real home,
// and the wizard would migrate it. Requiring the paths to be under the
// specific directory the caller made has no such hole.
export function assertSafeToMigrate(env, root) {
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
}

// In-process equivalent: points HOME and the XDG roots at `dir` for the
// current process and returns a restore function. os.homedir() reads $HOME on
// POSIX on every call, so this really does move legacyDataRoot().
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
// the isolation check cannot be skipped by forgetting to call it -- which is
// the whole point. Relying on "remember to isolate HOME" as a convention is
// what produced the data loss in the first place; this makes the convention
// mechanical.
//
// Checks the RESOLVED values immediately before spawning (not at env
// construction time), so an `extra` override that reintroduces the real HOME
// is caught too.
export function spawnWizard(dir, args = [], extra = {}) {
  const env = isolatedEnv(dir, { LC_ALL: 'C', PORT: '1', ...extra });
  assertSafeToMigrate(env, dir);
  return spawnSync(process.execPath, [SETUP_CLI, ...args], { env, encoding: 'utf8', timeout: 60000 });
}
