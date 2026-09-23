// Issue #201 Step5. Boots the real entrypoint and throws real requests at
// the gate, the same harness as startup-auth-mode.test.js.
//
// The single most important assertion in this file is that the server
// STARTS while un-migrated. Three production hosts run under
// `systemctl --user` with live sessions; if this code ever refuses to boot
// on an un-migrated host, the upgrade that introduces the wizard takes all
// of them down at once. Everything else here is about which requests still
// work while gated, and the rule behind that list is:
//
//   the gate stops the operator creating NEW state in the WRONG PLACE;
//   it does not stop the server serving state it already has.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(__dirname, 'index.js');
const SETUP_CLI = join(__dirname, 'cli', 'setup.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 15_000, intervalMs = 150 } = {}) {
  const start = Date.now();
  for (;;) {
    let ok;
    try { ok = await fn(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(intervalMs);
  }
}

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

function childEnv(dir, extra = {}) {
  const base = { ...process.env };
  // Strip every CCSERVER_* so an ambient override cannot turn a registry
  // entry into an env-override and change what the gate/plan reports.
  for (const k of Object.keys(base)) if (k.startsWith('CCSERVER_')) delete base[k];
  return {
    ...base,
    XDG_CONFIG_HOME: join(dir, 'config'),
    XDG_DATA_HOME: join(dir, 'data'),
    XDG_STATE_HOME: join(dir, 'state'),
    CCSERVER_HOST: '127.0.0.1',
    ...extra,
  };
}

class Server {
  constructor(env) { this.env = env; this.proc = null; this.logChunks = []; }

  get baseUrl() { return `http://127.0.0.1:${this.env.PORT}`; }

  async start() {
    this.proc = spawn(process.execPath, [SERVER_ENTRY], { cwd: __dirname, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (d) => this.logChunks.push(d.toString()));
    this.proc.stderr.on('data', (d) => this.logChunks.push(d.toString()));
    await waitFor(async () => {
      if (this.proc.exitCode !== null) {
        throw new Error(`server exited early (code ${this.proc.exitCode}); logs:\n${this.logs()}`);
      }
      try {
        return (await fetch(`${this.baseUrl}/api/auth/mode`)).status === 200;
      } catch { return false; }
    });
  }

  async stop() {
    if (!this.proc || this.proc.exitCode !== null) return;
    const exited = once(this.proc, 'exit');
    this.proc.kill('SIGTERM');
    if (await Promise.race([exited.then(() => 'ok'), sleep(5000).then(() => 'timeout')]) === 'timeout') {
      this.proc.kill('SIGKILL');
      await exited;
    }
  }

  logs() { return this.logChunks.join(''); }
}

function runWizard(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SETUP_CLI, '--yes'], {
      cwd: join(__dirname, '..'),
      env: { ...childEnv(dir), PORT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`setup --yes failed:\n${out}`))));
  });
}

async function withServer(dir, extra, fn) {
  const port = await getFreePort();
  const server = new Server(childEnv(dir, { ...extra, PORT: String(port) }));
  try {
    await server.start();
    await fn(server);
  } finally {
    await server.stop();
  }
}

test('★ an un-migrated host still BOOTS -- the gate never refuses to start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-gate-boot-'));
  try {
    await withServer(dir, { CCSERVER_LAYOUT: 'legacy' }, async (server) => {
      const res = await fetch(`${server.baseUrl}/api/auth/mode`);
      assert.equal(res.status, 200, `the server must serve while un-migrated; logs:\n${server.logs()}`);
      assert.match(server.logs(), /Setup is not complete/, 'and must say so in the log');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('while gated: writes are refused with 503 SETUP_REQUIRED, reads and re-attach are not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-gate-'));
  try {
    await withServer(dir, { CCSERVER_LAYOUT: 'legacy' }, async (server) => {
      const post = await fetch(`${server.baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp' }),
      });
      assert.equal(post.status, 503, 'creating a session would write state to the wrong place');
      const body = await post.json();
      assert.equal(body.code, 'SETUP_REQUIRED');
      assert.equal(body.command, 'npm run setup');

      // Reads stay open. GET /api/sessions in particular is what the UI
      // needs to list -- and therefore let someone re-attach to -- the
      // sessions already running. DEFAULT_SESSION_TIMEOUT_MS is 12h; block
      // this and they are silently reaped.
      assert.equal((await fetch(`${server.baseUrl}/api/sessions`)).status, 200);
      assert.equal((await fetch(`${server.baseUrl}/api/setup-status`)).status, 200);
      assert.equal((await fetch(`${server.baseUrl}/api/auth/mode`)).status, 200);

      // Other writes are gated too.
      const group = await fetch(`${server.baseUrl}/api/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(group.status, 503);

      // A non-/api, non-/ws path is never gated -- the SPA has to load to
      // render the explanation. NODE_ENV is not 'production' here, so this
      // 404s rather than serving the bundle; the point is that it is not a
      // 503.
      assert.notEqual((await fetch(`${server.baseUrl}/`)).status, 503);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/setup-status explains the gate: required, versions, and the pending moves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-gate-status-'));
  try {
    await withServer(dir, { CCSERVER_LAYOUT: 'legacy' }, async (server) => {
      const status = await (await fetch(`${server.baseUrl}/api/setup-status`)).json();
      assert.equal(status.setupRequired, true);
      assert.equal(status.layoutVersion, 1);
      assert.equal(status.targetLayoutVersion, 2);
      assert.equal(status.command, 'npm run setup');
      assert.equal(typeof status.liveSessions, 'number');
      assert.ok(Array.isArray(status.pending));
      assert.ok(status.roots.config && status.roots.data && status.roots.state);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('after the wizard runs, the gate is gone and writes are accepted again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-gate-after-'));
  try {
    await runWizard(dir);
    await withServer(dir, {}, async (server) => {
      const status = await (await fetch(`${server.baseUrl}/api/setup-status`)).json();
      assert.equal(status.setupRequired, false);
      assert.equal(status.layoutVersion, 2);

      const post = await fetch(`${server.baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.notEqual(post.status, 503, `no longer gated; logs:\n${server.logs()}`);
      assert.doesNotMatch(server.logs(), /Setup is not complete/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
