// Regression net for the worst defect this branch shipped in review
// (attack-test-201 F1, Critical): `npm test` migrated the operator's real
// pre-#201 data into a temp directory and then deleted it.
//
// The tests that spawn the wizard isolated $XDG_*_HOME but not $HOME, and
// legacyDataRoot() is homedir()-based by design -- so `setup.js --yes` found
// the real ~/.local/share/ccserver-sandbox, moved the live SQLite DB, the
// federation private key and group-files into the test's mkdtemp dir, and
// the test's `finally { rmSync(dir) }` destroyed them. Reproduced against a
// fake $HOME: DB gone, federation key gone, saved-sessions gone.
//
// The first fix covered $HOME only, and a follow-up verification found that
// half the damage was still being done: eight registry entries have their
// legacy location inside the CHECKOUT (server/sandbox.config.json and the
// seven state JSONs at the repo root), repoRoot() is import.meta.url-based so
// no env var moves it, and assertSafeToMigrate looked at HOME and the XDG
// roots only. One run of startup-setup-gate.test.js destroyed all eight --
// including server/sandbox.config.json, which on an un-migrated host is the
// LIVE config (browseRoots, binds, webhook URLs).
//
// The fix is testIsolation.js. These tests exist so that a future test which
// forgets either half fails here loudly rather than eating someone's data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  isolatedEnv, checkoutEnv, assertSafeToMigrate, withIsolatedHome, spawnWizard,
  CHECKOUT_ENTRY_IDS,
} from './testIsolation.js';
import { allPaths, repoRoot } from './paths.js';

const SETUP_CLI = join(import.meta.dirname, 'cli', 'setup.js');

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-isolation-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('isolatedEnv redirects HOME, not just the XDG roots', () => {
  withTmp((dir) => {
    const env = isolatedEnv(dir);
    assert.equal(env.HOME, join(dir, 'home'));
    assert.notEqual(env.HOME, homedir());
    assert.equal(env.XDG_CONFIG_HOME, join(dir, 'config'));
    assert.equal(env.XDG_DATA_HOME, join(dir, 'data'));
    assert.equal(env.XDG_STATE_HOME, join(dir, 'state'));
    assert.equal(existsSync(env.HOME), true, 'HOME must exist -- the child resolves paths under it');
  });
});

test('isolatedEnv strips ambient CCSERVER_* and XDG_* so the runner cannot leak into the child', () => {
  withTmp((dir) => {
    const savedDb = process.env.CCSERVER_DB_PATH;
    const savedXdg = process.env.XDG_DATA_HOME;
    try {
      process.env.CCSERVER_DB_PATH = '/real/db.sqlite3';
      process.env.XDG_DATA_HOME = '/real/data';
      const env = isolatedEnv(dir);
      assert.equal(env.CCSERVER_DB_PATH, undefined);
      assert.equal(env.XDG_DATA_HOME, join(dir, 'data'));
    } finally {
      if (savedDb === undefined) delete process.env.CCSERVER_DB_PATH; else process.env.CCSERVER_DB_PATH = savedDb;
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = savedXdg;
    }
  });
});

// OUTSIDE is a path that is not under tmpdir() on any machine. homedir() is
// deliberately NOT used for this: a developer (or CI image) whose $HOME is
// itself under /tmp makes such an assertion silently vacuous -- and that is
// not hypothetical, it is how this very file used to run the real wizard
// against a fake home while appearing to pass.
const OUTSIDE = '/definitely-not-a-temp-dir/ccserver-should-never-write-here';

test('isolatedEnv refuses a directory outside the temp tree', () => {
  assert.throws(() => isolatedEnv(OUTSIDE), /not under/);
  assert.throws(() => isolatedEnv('/'), /not under/);
});

test('★ assertSafeToMigrate rejects the exact env shape that caused the data loss', () => {
  withTmp((dir) => {
    // XDG isolated, HOME left real -- what every spawning test in this
    // branch did before the fix.
    const unsafe = {
      HOME: OUTSIDE,
      XDG_CONFIG_HOME: join(dir, 'config'),
      XDG_DATA_HOME: join(dir, 'data'),
      XDG_STATE_HOME: join(dir, 'state'),
    };
    assert.throws(() => assertSafeToMigrate(unsafe, dir), /HOME=.*is outside/);

    // The real $HOME is rejected too, whatever it happens to be -- the check
    // is anchored on the caller's scratch directory, not on tmpdir().
    assert.throws(() => assertSafeToMigrate({ ...unsafe, HOME: homedir() }, dir), /HOME=.*is outside/);

    // And the fully isolated env passes -- but only WITH the checkout
    // overrides. HOME plus the XDG roots is not enough on its own.
    assert.throws(() => assertSafeToMigrate(isolatedEnv(dir), dir), /CCSERVER_.*is outside/);
    assertSafeToMigrate(isolatedEnv(dir, checkoutEnv(dir)), dir);
  });
});

test('assertSafeToMigrate rejects an unset HOME as well as a real one', () => {
  withTmp((dir) => {
    const env = isolatedEnv(dir);
    delete env.HOME;
    assert.throws(() => assertSafeToMigrate(env, dir), /HOME=\(unset\)/);
  });
});

test('★ the wizard with an isolated env leaves a decoy legacy tree under the real HOME alone', () => {
  // The end-to-end shape of F1, with the decoy placed where the real data
  // would be if $HOME were not redirected. If isolation regresses, the
  // wizard migrates the decoy out and this fails.
  withTmp((dir) => {
    const fakeHome = join(dir, 'pretend-real-home');
    const legacy = join(fakeHome, '.local', 'share', 'ccserver-sandbox');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'ccserver.sqlite3'), 'PRECIOUS');

    const env = isolatedEnv(dir, { LC_ALL: 'C', PORT: '1', ...checkoutEnv(dir) });
    assertSafeToMigrate(env, dir);
    const res = spawnSync(process.execPath, [SETUP_CLI, '--yes'], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(res.status, 0, res.stdout + res.stderr);

    assert.equal(existsSync(join(legacy, 'ccserver.sqlite3')), true,
      'the wizard must not reach outside the env it was given');
    assert.equal(existsSync(join(dir, 'data', 'ccserver', 'ccserver.sqlite3')), false,
      'and must not have migrated the decoy into the isolated tree');
  });
});

test('withIsolatedHome moves homedir() in-process and restores it', () => {
  withTmp((dir) => {
    const before = homedir();
    const restore = withIsolatedHome(dir);
    try {
      assert.equal(homedir(), join(dir, 'home'), 'os.homedir() reads $HOME on POSIX');
      assert.notEqual(homedir(), before);
    } finally {
      restore();
    }
    assert.equal(homedir(), before, 'the real HOME comes back');
  });
});

// --- the assertion must actually fire (anti-vacuity) ------------------------
// A guard nobody has watched fail is a guard you do not have. These pin that
// the un-isolated shapes are REFUSED, so the protection cannot quietly rot
// into a no-op the next time someone edits the helpers.

test('★ spawnWizard aborts instead of running when HOME is not isolated', () => {
  withTmp((dir) => {
    // The exact mistake: caller hands back the real HOME through `extra`.
    // Both the real $HOME and an arbitrary outside path must abort. Under a
    // fake home in /tmp the first of these is what a tmpdir()-relative check
    // would have let through.
    for (const home of [homedir(), OUTSIDE]) {
      assert.throws(
        () => spawnWizard(dir, ['--yes'], { HOME: home }),
        /assertSafeToMigrate: HOME=.*is outside/,
        `HOME=${home} must abort the test, not silently migrate real data`,
      );
    }
  });
});

test('★ spawnWizard aborts when any single XDG root escapes the temp tree', () => {
  withTmp((dir) => {
    for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
      assert.throws(
        () => spawnWizard(dir, ['--yes'], { [key]: join(homedir(), '.config') }),
        new RegExp(`assertSafeToMigrate: ${key}=.*is outside`),
        `${key} escaping the scratch directory must abort`,
      );
    }
  });
});

test('spawnWizard refuses a working directory outside the temp tree outright', () => {
  assert.throws(() => spawnWizard(OUTSIDE, ['--yes']), /not under/);
});

test('spawnWizard runs normally once everything is isolated', () => {
  withTmp((dir) => {
    const res = spawnWizard(dir, []);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /ドライラン/);
  });
});

// --- the checkout half ------------------------------------------------------

test('★ spawnWizard --yes leaves the real checkout\'s legacy files alone', () => {
  // The end-to-end shape of the residual F1. The decoys go where the wizard
  // WOULD find them -- the real working tree -- because that is the point:
  // repoRoot() cannot be redirected, so the only thing keeping the wizard off
  // them is the per-entry override spawnWizard passes. If that regresses,
  // these files are moved into `dir` and deleted with it, exactly as a
  // developer's live server/sandbox.config.json was.
  // A path that ALREADY has a file is guarded as-is rather than skipped. That
  // is the developer's live server/sandbox.config.json, and it is the thing
  // most worth asserting about -- skipping it is how a check like this goes
  // vacuous, which is exactly what happened when this file's own decoys were
  // in place during a verification run.
  const guarded = [];
  for (const entry of allPaths()) {
    for (const legacy of entry.legacyPaths) {
      if (!legacy.startsWith(repoRoot())) continue;
      if (existsSync(legacy)) {
        guarded.push({ id: entry.id, path: legacy, before: readFileSync(legacy, 'utf-8'), created: false });
        continue;
      }
      mkdirSync(dirname(legacy), { recursive: true });
      const before = `{"__decoy":"${entry.id}"}\n`;
      writeFileSync(legacy, before);
      guarded.push({ id: entry.id, path: legacy, before, created: true });
    }
  }
  try {
    assert.ok(guarded.length > 0, 'the registry must have legacy paths inside the checkout');
    withTmp((dir) => {
      const res = spawnWizard(dir, ['--yes']);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      for (const { id, path, before } of guarded) {
        assert.equal(existsSync(path), true, `${path} must still be there (${id})`);
        assert.equal(readFileSync(path, 'utf-8'), before, `${path} must be byte-for-byte unchanged (${id})`);
      }
    });
  } finally {
    for (const { path, created } of guarded) if (created) rmSync(path, { force: true });
  }
});

test('spawnWizard cleans up the breadcrumb it drops in the checkout', () => {
  const breadcrumb = join(repoRoot(), '.ccserver-state-moved.txt');
  if (existsSync(breadcrumb)) return;              // someone else's; leave it
  withTmp((dir) => {
    // Something has to actually move for a breadcrumb to be written, so give
    // the isolated HOME a legacy tree to migrate.
    const legacy = join(dir, 'home', '.local', 'share', 'ccserver-sandbox');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'ccserver.sqlite3'), 'DB');
    const res = spawnWizard(dir, ['--yes']);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(existsSync(join(dir, 'data', 'ccserver', 'ccserver.sqlite3')), true, 'sanity: it did migrate');
    assert.equal(existsSync(breadcrumb), false,
      'the breadcrumb names a migration into a temp dir that no longer exists; it must not be left behind');
  });
});

test('★ assertSafeToMigrate rejects a missing checkout override', () => {
  // The exact shape of the residual defect: HOME and XDG isolated, checkout
  // entries left pointing at the real working tree.
  withTmp((dir) => {
    for (const id of CHECKOUT_ENTRY_IDS) {
      const env = isolatedEnv(dir, checkoutEnv(dir, { allow: [id] }));
      assert.throws(
        () => assertSafeToMigrate(env, dir),
        new RegExp(`assertSafeToMigrate: CCSERVER_[A-Z_]+=\\(unset\\) is outside`),
        `${id} must be refused when its override is missing`,
      );
      // ...and allowed only when the caller says so explicitly.
      assertSafeToMigrate(env, dir, { allowCheckoutMigration: [id] });
    }
  });
});

test('assertSafeToMigrate rejects a checkout override pointing outside the scratch dir', () => {
  withTmp((dir) => {
    const env = isolatedEnv(dir, {
      ...checkoutEnv(dir),
      CCSERVER_SANDBOX_CONFIG: join(repoRoot(), 'server', 'sandbox.config.json'),
    });
    assert.throws(() => assertSafeToMigrate(env, dir), /CCSERVER_SANDBOX_CONFIG=.*is outside/);
  });
});

test('★ assertSafeToMigrate resolves symlinks: a scratch home pointing outside is refused', () => {
  // The guard used to be lexical, so <dir>/home could be a symlink to the
  // real $HOME: "is it under <dir>" was true while the wizard followed the
  // link straight out and migrated the data behind it (reproduced). Real
  // callers use mkdtemp and never do this, but a guard whose only job is
  // preventing data loss must not be undone by a symlink.
  withTmp((dir) => {
    const outside = join(dir, '..', `escape-${process.pid}`);
    mkdirSync(outside, { recursive: true });
    try {
      const scratch = join(dir, 'scratch');
      mkdirSync(scratch, { recursive: true });
      const home = join(scratch, 'home');
      symlinkSync(outside, home);
      const env = {
        HOME: home,
        XDG_CONFIG_HOME: join(scratch, 'config'),
        XDG_DATA_HOME: join(scratch, 'data'),
        XDG_STATE_HOME: join(scratch, 'state'),
        ...checkoutEnv(scratch),
      };
      assert.throws(() => assertSafeToMigrate(env, scratch), /HOME=.*is outside/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('CHECKOUT_ENTRY_IDS covers every registry entry whose legacy path is in the checkout', () => {
  // The list in testIsolation.js is hand-maintained. If a future entry lands
  // a legacy path inside the repo and is not added here, spawnWizard would
  // migrate it out of the developer's working tree -- so pin the two
  // together.
  const fromRegistry = allPaths()
    .filter((e) => e.legacyPaths.some((p) => p.startsWith(repoRoot())))
    .map((e) => e.id)
    .sort();
  assert.deepEqual([...CHECKOUT_ENTRY_IDS].sort(), fromRegistry);
  assert.ok(fromRegistry.includes('sandboxConfig'));
});
