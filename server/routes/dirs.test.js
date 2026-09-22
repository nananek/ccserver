// Route-level tests for POST /api/dirs folder creation, focused on the
// opt-in gitInit flag: fixed `git init` argv run inside the freshly created
// directory, backward-compatible when omitted/false, and the directory is
// kept (with {error, path}) when git init itself fails.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { dirsRoute } from './dirs.js';

// browseRoots (issue #189): points loadSandboxConfig() at a temp config for
// the duration of `fn`, same pattern as sandbox-config.test.js's withConfig.
function withConfig(json, fn) {
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-dirs-cfg-'));
  const path = join(cfgDir, 'sandbox.config.json');
  return (async () => {
    try {
      writeFileSync(path, JSON.stringify(json));
      const prev = process.env.CCSERVER_SANDBOX_CONFIG;
      process.env.CCSERVER_SANDBOX_CONFIG = path;
      try {
        return await fn();
      } finally {
        if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
        else process.env.CCSERVER_SANDBOX_CONFIG = prev;
      }
    } finally {
      rmSync(cfgDir, { recursive: true, force: true });
    }
  })();
}

let runtimeDir;
let app;
let realPath;

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-dirs-route-'));
  app = Fastify();
  await app.register(dirsRoute, { prefix: '/api' });
  realPath = process.env.PATH;
});

after(async () => {
  try { await app.close(); } catch {}
  if (realPath !== undefined) process.env.PATH = realPath;
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
});

test('POST /dirs creates the directory and git-inits it when gitInit is true', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/dirs',
    payload: { parent: runtimeDir, name: 'proj-git', gitInit: true },
  });
  assert.equal(res.statusCode, 200);
  const newPath = res.json().path;
  assert.equal(newPath, join(runtimeDir, 'proj-git'));
  assert.ok(existsSync(newPath), 'directory exists');
  assert.ok(existsSync(join(newPath, '.git')), '.git was created by git init');
});

test('POST /dirs stays mkdir-only when gitInit is omitted or false', async () => {
  for (const extra of [{}, { gitInit: false }]) {
    const name = `plain-${Object.keys(extra).length}-${extra.gitInit === false ? 'f' : 'u'}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/dirs',
      payload: { parent: runtimeDir, name, ...extra },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().path, join(runtimeDir, name));
    assert.ok(!existsSync(join(runtimeDir, name, '.git')), `no .git for ${name}`);
  }
});

test('POST /dirs rejects an existing directory with 409', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/dirs',
    payload: { parent: runtimeDir, name: 'proj-git', gitInit: true },
  });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /already exists/);
});

test('POST /dirs keeps rejecting traversal-ish names', async () => {
  for (const name of ['../escape', 'a/b', '.', '..']) {
    const res = await app.inject({ method: 'POST', url: '/api/dirs', payload: { parent: runtimeDir, name } });
    assert.equal(res.statusCode, 400, `${name} must be rejected`);
  }
});

test('POST /dirs keeps the directory but reports failure when git init cannot run', async () => {
  // Empty PATH -> execFile('git') fails with ENOENT inside the route. node
  // --test runs each file in its own process, so this stays scoped here.
  process.env.PATH = runtimeDir;
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dirs',
      payload: { parent: runtimeDir, name: 'proj-init-fail', gitInit: true },
    });
    assert.equal(res.statusCode, 500);
    const body = res.json();
    assert.match(body.error, /^Directory created but git init failed:/);
    assert.equal(body.path, join(runtimeDir, 'proj-init-fail'));
    assert.ok(existsSync(body.path), 'the created directory is kept for manual retry');
  } finally {
    if (realPath !== undefined) process.env.PATH = realPath;
  }
});

// GET /dirs/home exposes toolsAvailable so the launch / settings UIs can
// render the rtk / code-review-graph toggles disabled-with-a-note instead of
// offering a checkbox the server silently drops (macOS seatbelt has no
// provisioner -- see issue #22). Both true on this non-macOS test host.
test('GET /dirs/home exposes toolsAvailable for the opt-in tool toggles', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/dirs/home' });
  const { toolsAvailable } = res.json();
  assert.ok(toolsAvailable && typeof toolsAvailable === 'object', 'toolsAvailable present');
  assert.equal(typeof toolsAvailable.rtk, 'boolean');
  assert.equal(typeof toolsAvailable.codeReviewGraph, 'boolean');
  // Availability tracks the platform, not config: this CI host is not macOS.
  assert.equal(toolsAvailable.rtk, process.platform !== 'darwin');
  assert.equal(toolsAvailable.codeReviewGraph, process.platform !== 'darwin');
});

// GET /dirs/home reports availableApps.opencodeGo: toggle on + Go API key
// present. Sync and network-free. Pinned to a temp config + temp,
// initially keyless XDG_DATA_HOME so the host's real auth.json never leaks
// in (an opencode-go key exists on dev hosts).
test('GET /dirs/home exposes availableApps.opencodeGo following toggle + key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-dirs-opencodego-'));
  const cfg = join(dir, 'sandbox.config.json');
  const savedConfigEnv = process.env.CCSERVER_SANDBOX_CONFIG;
  const savedDataHome = process.env.XDG_DATA_HOME;
  const savedAuthContent = process.env.OPENCODE_AUTH_CONTENT;
  const savedGoUsageEnv = process.env.CCSERVER_OPENCODE_GO_USAGE;
  process.env.CCSERVER_SANDBOX_CONFIG = cfg;
  process.env.XDG_DATA_HOME = join(dir, 'data-home');
  delete process.env.OPENCODE_AUTH_CONTENT;
  delete process.env.CCSERVER_OPENCODE_GO_USAGE;
  try {
    writeFileSync(cfg, JSON.stringify({}));
    // No key file -> not available (toggle defaults on).
    let res = await app.inject({ method: 'GET', url: '/api/dirs/home' });
    assert.equal(res.json().availableApps.opencodeGo, false);

    // Key present -> available.
    mkdirSync(join(dir, 'data-home', 'opencode'), { recursive: true });
    writeFileSync(
      join(dir, 'data-home', 'opencode', 'auth.json'),
      JSON.stringify({ 'opencode-go': { type: 'api', key: 'k123' } }),
    );
    res = await app.inject({ method: 'GET', url: '/api/dirs/home' });
    assert.equal(res.json().availableApps.opencodeGo, true);

    // Disabled toggle wins over the key.
    writeFileSync(cfg, JSON.stringify({ opencodeGoUsage: false }));
    res = await app.inject({ method: 'GET', url: '/api/dirs/home' });
    assert.equal(res.json().availableApps.opencodeGo, false);
  } finally {
    if (savedConfigEnv === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = savedConfigEnv;
    if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedDataHome;
    if (savedAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT;
    else process.env.OPENCODE_AUTH_CONTENT = savedAuthContent;
    if (savedGoUsageEnv === undefined) delete process.env.CCSERVER_OPENCODE_GO_USAGE;
    else process.env.CCSERVER_OPENCODE_GO_USAGE = savedGoUsageEnv;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// GET /dirs/home exposes sandboxAvailable (backend presence: bwrap on Linux,
// sandbox-exec on macOS) so the launch modal can disable the sandbox choice
// where it cannot work.
test('GET /dirs/home exposes sandboxAvailable as a boolean', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/dirs/home' });
  assert.equal(res.statusCode, 200);
  assert.equal(typeof res.json().sandboxAvailable, 'boolean');
});

// GET /dirs/home also exposes hiddenApps (issue #105) so every launch picker
// can remove those apps entirely, regardless of install status. Same
// live-following-sandbox.config.json contract as sandboxAvailable above.
test('GET /dirs/home exposes hiddenApps following sandbox.config.json', async () => {
  const cfg = join(runtimeDir, 'sandbox.config.json');
  const savedConfigEnv = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfg;
  try {
    // No config file at all -> nothing hidden.
    let res = await app.inject({ method: 'GET', url: '/api/dirs/home' });
    assert.deepEqual(res.json().hiddenApps, []);

    writeFileSync(cfg, JSON.stringify({ hiddenApps: ['copilot', 'codex'] }));
    res = await app.inject({ method: 'GET', url: '/api/dirs/home' });
    assert.deepEqual(res.json().hiddenApps, ['copilot', 'codex']);

    // Unknown entries are dropped by loadSandboxConfig's own validation --
    // the route just passes the already-validated array through.
    writeFileSync(cfg, JSON.stringify({ hiddenApps: ['copilot', 'not-a-real-app'] }));
    res = await app.inject({ method: 'GET', url: '/api/dirs/home' });
    assert.deepEqual(res.json().hiddenApps, ['copilot']);
  } finally {
    if (savedConfigEnv === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = savedConfigEnv;
    try { rmSync(cfg, { force: true }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// browseRoots (issue #189). browseRoots unset (the default) is exercised by
// every test above -- this section is additive, covering the restricted
// case.

test('GET /dirs/home exposes browseRoots ([] by default) and initialBrowsePath', async () => {
  let res = await app.inject({ method: 'GET', url: '/api/dirs/home' });
  let body = res.json();
  assert.deepEqual(body.browseRoots, []);
  assert.equal(body.initialBrowsePath, body.home);

  const allowed = mkdtempSync(join(tmpdir(), 'ccserver-dirs-browseroot-'));
  try {
    await withConfig({ browseRoots: [allowed] }, async () => {
      res = await app.inject({ method: 'GET', url: '/api/dirs/home' });
      body = res.json();
      assert.deepEqual(body.browseRoots, [allowed]);
      // home() (a temp-independent OS path) will not normally sit inside a
      // freshly minted browseRoots temp dir, so initialBrowsePath falls back
      // to the first configured root instead of home.
      assert.equal(body.initialBrowsePath, allowed);
    });
  } finally {
    rmSync(allowed, { recursive: true, force: true });
  }
});

test('GET /dirs/home: initialBrowsePath is home() when home() itself is inside browseRoots', async () => {
  await withConfig({ browseRoots: [homedir()] }, async () => {
    const res = await app.inject({ method: 'GET', url: '/api/dirs/home' });
    assert.equal(res.json().initialBrowsePath, homedir());
  });
});

// Fail closed (issue #189 self-review): a present-but-invalid browseRoots
// disables the directory API (503) and is reported to the client, instead of
// silently reverting to host-wide browsing.
test('a present-but-invalid browseRoots fails /dirs and /dirs/home closed', async () => {
  await withConfig({ browseRoots: '/srv/repos' }, async () => {
    const home = await app.inject({ method: 'GET', url: '/api/dirs/home' });
    assert.equal(home.statusCode, 200);
    assert.equal(home.json().browseRootsInvalid, true);

    const list = await app.inject({ method: 'GET', url: '/api/dirs?path=/etc' });
    assert.equal(list.statusCode, 503);
    assert.match(list.json().error, /browseRoots/);

    const mk = await app.inject({ method: 'POST', url: '/api/dirs', payload: { parent: '/tmp', name: 'x' } });
    assert.equal(mk.statusCode, 503);
  });
});

test('GET /dirs: a path outside browseRoots is refused with 403, inside is listed', async () => {
  const allowed = mkdtempSync(join(tmpdir(), 'ccserver-dirs-browseroot-'));
  const outside = mkdtempSync(join(tmpdir(), 'ccserver-dirs-outside-'));
  mkdirSync(join(allowed, 'sub'));
  try {
    await withConfig({ browseRoots: [allowed] }, async () => {
      const ok = await app.inject({ method: 'GET', url: `/api/dirs?path=${encodeURIComponent(allowed)}` });
      assert.equal(ok.statusCode, 200);
      assert.ok(ok.json().dirs.some((d) => d.name === 'sub'));

      const blocked = await app.inject({ method: 'GET', url: `/api/dirs?path=${encodeURIComponent(outside)}` });
      assert.equal(blocked.statusCode, 403);
      assert.match(blocked.json().error, /browseRoots/);
    });
  } finally {
    rmSync(allowed, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('GET /dirs: parent is null at the browseRoots boundary instead of exposing the outside path', async () => {
  const allowed = mkdtempSync(join(tmpdir(), 'ccserver-dirs-browseroot-'));
  try {
    await withConfig({ browseRoots: [allowed] }, async () => {
      const res = await app.inject({ method: 'GET', url: `/api/dirs?path=${encodeURIComponent(allowed)}` });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().parent, null, 'must not leak the real parent outside browseRoots');
    });
  } finally {
    rmSync(allowed, { recursive: true, force: true });
  }
});

test('POST /dirs: a parent outside browseRoots is refused with 403, inside still creates', async () => {
  const allowed = mkdtempSync(join(tmpdir(), 'ccserver-dirs-browseroot-'));
  const outside = mkdtempSync(join(tmpdir(), 'ccserver-dirs-outside-'));
  try {
    await withConfig({ browseRoots: [allowed] }, async () => {
      const blocked = await app.inject({
        method: 'POST',
        url: '/api/dirs',
        payload: { parent: outside, name: 'nope' },
      });
      assert.equal(blocked.statusCode, 403);
      assert.match(blocked.json().error, /browseRoots/);
      assert.equal(existsSync(join(outside, 'nope')), false);

      const ok = await app.inject({
        method: 'POST',
        url: '/api/dirs',
        payload: { parent: allowed, name: 'yep' },
      });
      assert.equal(ok.statusCode, 200);
      assert.ok(existsSync(join(allowed, 'yep')));
    });
  } finally {
    rmSync(allowed, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
