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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, spawnWizard } from './testIsolation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(__dirname, 'index.js');
const SETUP_CLI = join(__dirname, 'cli', 'setup.js');
const REPO_ROOT = join(__dirname, '..');

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

// HOME is isolated too, not just the XDG roots. legacyDataRoot() is
// homedir()-based by design, so a child with the real $HOME resolves the
// operator's real pre-#201 tree -- and runWizard() below would migrate it
// into `dir`, which every test here deletes in its `finally`. See
// testIsolation.js.
function childEnv(dir, extra = {}) {
  return isolatedEnv(dir, { CCSERVER_HOST: '127.0.0.1', ...extra });
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

// Routed through spawnWizard(), the single choke point that isolates HOME
// and ABORTS if it or the XDG roots resolve outside the temp tree.
function runWizard(dir) {
  const res = spawnWizard(dir, ['--yes'], { CCSERVER_HOST: '127.0.0.1' });
  if (res.status !== 0) {
    throw new Error(`setup --yes failed:\n${res.stdout}${res.stderr}`);
  }
  return res.stdout;
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
    runWizard(dir);
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

// attack-test-201 F2 (High): the gate was completely bypassable over
// WebSocket. HTTP POST /api/sessions returned 503, but a WS `init` created a
// session anyway, and `schedule_prompt` wrote .scheduled-prompts.json -- both
// into the pre-migration paths the operator was about to migrate. The gate's
// stated purpose was simply not met.
//
// The fix gates by MESSAGE, not by connection, because blocking /ws/
// wholesale would cut running sessions off from their browsers and let the
// 12h idle timeout reap them (the very thing rev2's R2 warns about). So these
// two tests are a pair: the write paths must be refused AND the re-attach
// path must still work.
test('★ F2: WS init and schedule_prompt are refused while gated, and write nothing to the legacy paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-gate-ws-'));
  try {
    await withServer(dir, { CCSERVER_LAYOUT: 'legacy' }, async (server) => {
      const legacyHome = join(dir, 'home');

      const init = await wsRequest(server, {
        type: 'init', cwd: '/tmp', cols: 80, rows: 24, shell: true,
      });
      assert.equal(init.type, 'error', `init must be refused; got ${JSON.stringify(init)}`);
      assert.equal(init.code, 'SETUP_REQUIRED');

      const sched = await wsRequest(server, {
        type: 'schedule_prompt', time: '23:59', text: 'GATE-BYPASS-PROMPT',
      });
      assert.equal(sched.type, 'error', `schedule_prompt must be refused; got ${JSON.stringify(sched)}`);
      assert.equal(sched.code, 'SETUP_REQUIRED');

      // The state files F2 showed being written must not exist, in either
      // layout's location. (The SQLite DB is deliberately NOT on this list:
      // an un-migrated host legitimately opens/creates it at the legacy path
      // on boot -- that is the layout it is running in, not a gate bypass.)
      for (const p of [
        join(legacyHome, '.scheduled-prompts.json'),
        join(legacyHome, '.saved-sessions.json'),
        join(REPO_ROOT, '.scheduled-prompts.json'),
        join(dir, 'state', 'ccserver', 'scheduled-prompts.json'),
        join(dir, 'state', 'ccserver', 'saved-sessions.json'),
      ]) {
        assert.equal(existsSync(p), false, `${p} must not have been created while gated`);
      }
      assert.equal((await (await fetch(`${server.baseUrl}/api/sessions`)).json()).length ?? 0, 0,
        'no session may exist after a refused init');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F2: the re-attach path (attach/ping) stays open while gated -- R2 is not reintroduced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-gate-ws-attach-'));
  try {
    await withServer(dir, { CCSERVER_LAYOUT: 'legacy' }, async (server) => {
      // `ping` needs no session and proves the socket is not gated wholesale.
      const pong = await wsRequest(server, { type: 'ping' });
      assert.notEqual(pong.code, 'SETUP_REQUIRED', 'ping must not be gated');

      // `attach` to a session that does not exist answers with its own
      // error, NOT the setup gate: the message class is allowed through, so
      // a browser holding a live sessionId can still reconnect to it.
      const attach = await wsRequest(server, { type: 'attach', sessionId: 'no-such-session' });
      assert.notEqual(attach.code, 'SETUP_REQUIRED',
        'attach must reach its own handler -- this is the path that keeps running sessions reachable');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Opens /ws/terminal, sends one message, resolves with the first reply that
// is not an unrelated broadcast.
function wsRequest(server, msg, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/ws/terminal`);
    const timer = setTimeout(() => { ws.close(); reject(new Error(`no reply to ${msg.type} within ${timeoutMs}ms`)); }, timeoutMs);
    const done = (value) => { clearTimeout(timer); ws.close(); resolve(value); };
    ws.addEventListener('open', () => ws.send(JSON.stringify(msg)));
    ws.addEventListener('message', (ev) => {
      let parsed;
      try { parsed = JSON.parse(ev.data); } catch { return; }
      // 'output'/'pong' chatter aside, the first typed reply is the answer.
      if (parsed.type === 'output') return;
      done(parsed);
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`ws error for ${msg.type}`)); });
  });
}
