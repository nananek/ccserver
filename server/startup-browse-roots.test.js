// Issue #201 Step6 / decision D4. The browseRoots boot refusal (#189) has
// never had a test: sandbox-config.test.js only covers loadSandboxConfig()'s
// parsing, and nothing has ever booted a server with browseRoots pointed at
// an internal file to confirm it actually refuses. Rewriting that check to
// be registry-driven without a regression net would be the wrong order, so
// here it is.
//
// The refusal exists because /api/files and /api/dirs serve anything inside
// browseRoots. If the DB (auth sessions, the GPG vault's encrypted secret
// key) or the federation mTLS private key fall inside it, they become
// downloadable over HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './testIsolation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(__dirname, 'index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Boots a server with the given sandbox.config.json and browseRoots, and
// reports whether it came up or refused, plus its logs.
async function boot(dir, config, extraEnv = {}) {
  const configHome = join(dir, 'config');
  mkdirSync(join(configHome, 'ccserver'), { recursive: true });
  const configPath = join(configHome, 'ccserver', 'sandbox.config.json');
  writeFileSync(configPath, JSON.stringify(config));
  // A migrated host: the marker is what makes the check use the three-root
  // form rather than the per-entry legacy one.
  writeFileSync(join(configHome, 'ccserver', 'layout.json'), JSON.stringify({ layoutVersion: 2, completedAt: Date.now() }));

  const port = await getFreePort();
  // HOME isolated as well as XDG: the CCSERVER_LAYOUT=legacy case below
  // resolves the legacy tree from homedir(), and the server's boot-time
  // legacy DB hop would otherwise touch the operator's real files.
  const proc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: __dirname,
    env: isolatedEnv(dir, {
      XDG_CONFIG_HOME: configHome,
      // Pinned at the file this function just wrote, which is where the
      // registry would resolve it anyway in the migrated layout. It matters
      // for the CCSERVER_LAYOUT=legacy case at the bottom: without the pin
      // that one resolves sandboxConfig to the REAL checkout's
      // server/sandbox.config.json, so whatever the developer happens to have
      // there -- a hiddenApps list that hides every app, a browseRoots of
      // their own -- decides whether this test passes.
      CCSERVER_SANDBOX_CONFIG: configPath,
      CCSERVER_HOST: '127.0.0.1',
      PORT: String(port),
      ...extraEnv,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });

  const started = Date.now();
  for (;;) {
    if (proc.exitCode !== null) return { booted: false, code: proc.exitCode, logs };
    try {
      await fetch(`http://127.0.0.1:${port}/api/auth/mode`);
      const exited = once(proc, 'exit');
      proc.kill('SIGTERM');
      await Promise.race([exited, sleep(5000).then(() => proc.kill('SIGKILL'))]);
      return { booted: true, code: null, logs };
    } catch { /* not up yet */ }
    if (Date.now() - started > 20_000) {
      proc.kill('SIGKILL');
      throw new Error(`neither booted nor exited within 20s; logs:\n${logs}`);
    }
    await sleep(150);
  }
}

function withDir(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccserver-browse-roots-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('browseRoots containing the ccserver DATA root refuses to boot and names it',
  withDir(async (dir) => {
    // $XDG_DATA_HOME/ccserver holds the SQLite DB and the federation private
    // key. Serving it over /api/files is the exposure #189 exists to stop.
    const res = await boot(dir, { browseRoots: [join(dir, 'data')] });
    assert.equal(res.booted, false, `must refuse; logs:\n${res.logs}`);
    assert.notEqual(res.code, 0);
    // The quotes around browseRoots are JSON-escaped by pino, so match
    // around them rather than on the raw message text.
    assert.match(res.logs, /Refusing to start: .*browseRoots.* is set/);
    assert.match(res.logs, /データディレクトリ/, 'the message must name what is exposed');
  }));

test('browseRoots containing the ccserver STATE root refuses to boot',
  withDir(async (dir) => {
    const res = await boot(dir, { browseRoots: [join(dir, 'state')] });
    assert.equal(res.booted, false, `must refuse; logs:\n${res.logs}`);
    assert.match(res.logs, /状態ディレクトリ/);
  }));

test('browseRoots containing the ccserver CONFIG root refuses to boot',
  withDir(async (dir) => {
    const res = await boot(dir, { browseRoots: [join(dir, 'config')] });
    assert.equal(res.booted, false, `must refuse; logs:\n${res.logs}`);
    assert.match(res.logs, /設定ディレクトリ/);
  }));

test('an env-overridden outlier inside browseRoots is caught, and named with its env var',
  withDir(async (dir) => {
    // The three roots cover everything the wizard placed, but an operator
    // who pulled one file out with an env var can have put it anywhere --
    // including inside browseRoots. Those are checked individually.
    const projects = join(dir, 'projects');
    mkdirSync(projects, { recursive: true });
    const res = await boot(dir, { browseRoots: [projects] }, {
      CCSERVER_DB_PATH: join(projects, 'ccserver.sqlite3'),
    });
    assert.equal(res.booted, false, `must refuse; logs:\n${res.logs}`);
    assert.match(res.logs, /CCSERVER_DB_PATH/, 'the message tells the operator which var to move it with');
  }));

test('a browseRoots well clear of ccserver\'s own directories boots normally',
  withDir(async (dir) => {
    const projects = join(dir, 'projects');
    mkdirSync(projects, { recursive: true });
    const res = await boot(dir, { browseRoots: [projects] });
    assert.equal(res.booted, true, `must boot; logs:\n${res.logs}`);
  }));

test('an unset browseRoots (the default) boots -- the check only applies when it is set',
  withDir(async (dir) => {
    const res = await boot(dir, {});
    assert.equal(res.booted, true, `must boot; logs:\n${res.logs}`);
  }));

test('a browseRoot INSIDE a ccserver root warns but does not refuse',
  withDir(async (dir) => {
    // The reverse containment has never been checked. Promoting it to a boot
    // refusal could break someone deliberately browsing a sandbox home, so
    // #201 only warns; escalating belongs in its own security review.
    const inside = join(dir, 'data', 'ccserver', 'home', 'myproj');
    mkdirSync(inside, { recursive: true });
    const res = await boot(dir, { browseRoots: [inside] });
    assert.equal(res.booted, true, `must still boot; logs:\n${res.logs}`);
    assert.match(res.logs, /points inside ccserver's own directories/);
  }));

test('an un-migrated host keeps the pre-#201 per-entry check',
  withDir(async (dir) => {
    // With CCSERVER_LAYOUT=legacy the internal files are still at their old
    // locations, so the three XDG roots are not where anything lives and the
    // check must fall back to checking each entry where it actually is.
    const res = await boot(dir, { browseRoots: [join(dir, 'data')] }, { CCSERVER_LAYOUT: 'legacy' });
    assert.equal(res.booted, true, `nothing internal is under the XDG data root yet; logs:\n${res.logs}`);
  }));
