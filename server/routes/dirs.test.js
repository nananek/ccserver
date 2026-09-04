// Route-level tests for POST /api/dirs folder creation, focused on the
// opt-in gitInit flag: fixed `git init` argv run inside the freshly created
// directory, backward-compatible when omitted/false, and the directory is
// kept (with {error, path}) when git init itself fails.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirsRoute } from './dirs.js';

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

// GET /dirs/home exposes the meta-agent feature flag so the launch modal can
// disable (and explain) its メタエージェント mode. The value must follow
// sandbox.config.json's "metaAgentMcp" live (loadSandboxConfig re-reads on
// every call), and a missing file / missing key means false.
test('GET /dirs/home exposes metaAgentEnabled following sandbox.config.json', async () => {
  const cfg = join(runtimeDir, 'sandbox.config.json');
  const savedConfigEnv = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfg;
  try {
    // No config file at all -> default off.
    let res = await app.inject({ method: 'GET', url: '/api/dirs/home' });
    assert.equal(res.json().metaAgentEnabled, false);

    writeFileSync(cfg, JSON.stringify({ metaAgentMcp: true }));
    res = await app.inject({ method: 'GET', url: '/api/dirs/home' });
    assert.equal(res.json().metaAgentEnabled, true);

    writeFileSync(cfg, JSON.stringify({ metaAgentMcp: false }));
    res = await app.inject({ method: 'GET', url: '/api/dirs/home' });
    assert.equal(res.json().metaAgentEnabled, false);

    // Key absent -> off (same as the pre-feature config shape).
    writeFileSync(cfg, JSON.stringify({ docker: true }));
    res = await app.inject({ method: 'GET', url: '/api/dirs/home' });
    assert.equal(res.json().metaAgentEnabled, false);
  } finally {
    if (savedConfigEnv === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = savedConfigEnv;
    try { rmSync(cfg, { force: true }); } catch {}
  }
});

// GET /dirs/home also exposes hiddenApps (issue #105) so every launch picker
// can remove those apps entirely, regardless of install status. Same
// live-following-sandbox.config.json contract as metaAgentEnabled above.
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
