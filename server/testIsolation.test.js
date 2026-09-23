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
// The fix is testIsolation.js. These tests exist so that a future test which
// forgets $HOME fails here loudly rather than eating someone's home
// directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedEnv, assertSafeToMigrate, withIsolatedHome, spawnWizard } from './testIsolation.js';

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

    // And the fully isolated env passes.
    assertSafeToMigrate(isolatedEnv(dir), dir);
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

    const env = isolatedEnv(dir, { LC_ALL: 'C', PORT: '1' });
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
