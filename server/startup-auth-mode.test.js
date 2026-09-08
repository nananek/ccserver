// Issue #141 Step5: server/index.js's onRequest auth hook has never had an
// automated test covering it end to end -- not before Issue #141, and not
// across Step1-4 either. server/routes/auth.test.js exercises authRoute()
// against a bare fastify app with no onRequest hook at all (its own header
// comment says so: "gating is verified by code review instead"), and
// server/authMode.test.js only covers resolveAuthMode() as a pure function.
// Nothing has ever booted the real server and thrown real requests at it to
// confirm none/token/passkey actually gate (or don't gate) what index.js's
// comments claim they do.
//
// Same "spawn the real entrypoint" approach as startup-pty-host-fallback.js/
// startup-hidden-apps.test.js, but this file also needs to *talk* to the
// booted server (real headers, real cookies) rather than just read its
// logs -- so readiness is a real fetch loop against a free port, the same
// pattern server/ws/federationTwoInstance.test.js uses for its two real
// server/index.js child processes.

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 150 } = {}) {
  const start = Date.now();
  for (;;) {
    let ok;
    try {
      ok = await fn();
    } catch {
      ok = false;
    }
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

function tempEnvPaths(dir) {
  return {
    CCSERVER_DB_PATH: join(dir, 'db.sqlite3'),
    CCSERVER_GROUPS_PATH: join(dir, 'groups.json'),
    CCSERVER_SAVED_SESSIONS_PATH: join(dir, 'sessions.json'),
    // Explicit rather than relying on server/package.json's npm-test-only
    // pin, so this file boots just as fast under a direct `node --test
    // server/startup-auth-mode.test.js` -- Issue #119 Step7's boot-time
    // pty-host probe otherwise burns its ~3s retry budget on every one of
    // this file's several server boots for no reason relevant to auth.
    CCSERVER_PTY_HOST: '0',
  };
}

// One real `node server/index.js` child process, reachable over plain HTTP.
// Readiness polls a real request instead of sleeping a fixed amount or
// scraping stdout for a "listening" line -- /api/auth/mode is reachable (200
// or, in `token` mode, 401 -- token mode's onRequest hook has no allowlist
// of its own, see index.js) in every mode, so either response proves the
// fastify app and its auth hook are both actually live.
class Server {
  constructor(env) {
    this.env = env;
    this.proc = null;
    this.logChunks = [];
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.env.PORT}`;
  }

  spawn() {
    const proc = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: __dirname,
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    proc.stdout.on('data', (d) => this.logChunks.push(d.toString()));
    proc.stderr.on('data', (d) => this.logChunks.push(d.toString()));
  }

  async start() {
    this.spawn();
    await waitFor(async () => {
      if (this.proc.exitCode !== null) {
        throw new Error(`server exited early (code ${this.proc.exitCode}) before becoming ready; logs:\n${this.logs()}`);
      }
      try {
        const res = await fetch(`${this.baseUrl}/api/auth/mode`);
        return res.status === 200 || res.status === 401;
      } catch {
        return false;
      }
    }, { timeoutMs: 15_000, intervalMs: 150 });
  }

  // For the "refuses to boot" case: success means the process exits on its
  // own (process.exit(1) during startup), not that it becomes reachable.
  async waitForExit(timeoutMs = 10_000) {
    if (this.proc.exitCode !== null) return this.proc.exitCode;
    await Promise.race([
      once(this.proc, 'exit'),
      sleep(timeoutMs).then(() => {
        throw new Error(`server did not exit within ${timeoutMs}ms; logs:\n${this.logs()}`);
      }),
    ]);
    return this.proc.exitCode;
  }

  async stop() {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    const exited = once(proc, 'exit');
    proc.kill('SIGTERM');
    const outcome = await Promise.race([
      exited.then(() => 'exited'),
      sleep(5000).then(() => 'timeout'),
    ]);
    if (outcome === 'timeout') {
      proc.kill('SIGKILL');
      await exited;
    }
  }

  logs() {
    return this.logChunks.join('');
  }
}

// Builds the child env from a clean slate: CCSERVER_AUTH_MODE/CCSERVER_TOKEN
// come ONLY from `extraEnv`, never from whatever this test-runner process
// itself happens to have set (unlike CCSERVER_PTY_HOST, neither has a
// repo-wide npm-test pin today, but stripping first keeps every test's mode
// exactly what it declares regardless of the ambient environment).
function childEnv(dir, extraEnv) {
  const base = { ...process.env };
  delete base.CCSERVER_AUTH_MODE;
  delete base.CCSERVER_TOKEN;
  return { ...base, ...tempEnvPaths(dir), ...extraEnv };
}

async function withServer(extraEnv, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-startup-auth-mode-'));
  const port = await getFreePort();
  const server = new Server(childEnv(dir, { ...extraEnv, PORT: String(port) }));
  try {
    await server.start();
    await fn(server);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('none mode (CCSERVER_AUTH_MODE/CCSERVER_TOKEN both unset): unauthenticated requests reach protected routes', async () => {
  await withServer({}, async (server) => {
    const res = await fetch(`${server.baseUrl}/api/dirs/home`);
    assert.equal(res.status, 200, `expected 200 with no auth in none mode; logs:\n${server.logs()}`);
  });
});

test('token mode (only CCSERVER_TOKEN set): resolveAuthMode() defaults to token and gates /api by query or Bearer', async () => {
  await withServer({ CCSERVER_TOKEN: 'sekrit-token' }, async (server) => {
    const noAuth = await fetch(`${server.baseUrl}/api/dirs/home`);
    assert.equal(noAuth.status, 401, 'no credentials at all must 401');

    const wrongToken = await fetch(`${server.baseUrl}/api/dirs/home?token=wrong`);
    assert.equal(wrongToken.status, 401, 'a wrong token must 401, not just "missing"');

    const queryToken = await fetch(`${server.baseUrl}/api/dirs/home?token=sekrit-token`);
    assert.equal(queryToken.status, 200, 'the correct token via ?token= must be accepted');

    const bearerToken = await fetch(`${server.baseUrl}/api/dirs/home`, {
      headers: { Authorization: 'Bearer sekrit-token' },
    });
    assert.equal(bearerToken.status, 200, 'the correct token via Authorization: Bearer must be accepted');

    // Pre-#141 behavior, unchanged: paths outside /api and /ws are never
    // gated in any mode (index.js's onRequest hook returns immediately for
    // them). NODE_ENV isn't 'production' here, so this 404s (no static
    // handler registered) rather than serving the built client -- the point
    // is only that it's not a 401 from the auth hook.
    const staticAsset = await fetch(`${server.baseUrl}/`);
    assert.notEqual(staticAsset.status, 401, 'a non-/api, non-/ws path must never be gated');
  });
});

test('passkey mode: /api/auth/mode is reachable with no session, protected routes 401 without one, and CCSERVER_TOKEN is ignored', async () => {
  await withServer({ CCSERVER_AUTH_MODE: 'passkey', CCSERVER_TOKEN: 'ignored-token' }, async (server) => {
    const modeRes = await fetch(`${server.baseUrl}/api/auth/mode`);
    assert.equal(modeRes.status, 200, 'GET /api/auth/mode must work with no session yet');
    assert.deepEqual(await modeRes.json(), { mode: 'passkey' });

    const noSession = await fetch(`${server.baseUrl}/api/dirs/home`);
    assert.equal(noSession.status, 401, 'a protected route must 401 with no session cookie');

    // passkey mode never accepts CCSERVER_TOKEN as a Bearer credential --
    // plan decision 5 ("passkeyモード選択時はCCSERVER_TOKENによるBearer認証を
    // 受け付けない"), not merely unused but actively rejected the same as any
    // other missing credential.
    const withIgnoredToken = await fetch(`${server.baseUrl}/api/dirs/home`, {
      headers: { Authorization: 'Bearer ignored-token' },
    });
    assert.equal(withIgnoredToken.status, 401, 'CCSERVER_TOKEN must not work as a Bearer credential in passkey mode');

    assert.match(
      server.logs(),
      /CCSERVER_TOKEN is set but ignored because CCSERVER_AUTH_MODE=passkey/,
      'the ignored token must be logged, not silently dropped'
    );
  });
});

test('an unknown CCSERVER_AUTH_MODE value refuses to boot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-startup-auth-mode-bogus-'));
  const port = await getFreePort();
  const server = new Server(childEnv(dir, { CCSERVER_AUTH_MODE: 'bogus', PORT: String(port) }));
  try {
    server.spawn();
    const code = await server.waitForExit();
    assert.notEqual(code, 0, `server must exit non-zero on an unknown mode; logs:\n${server.logs()}`);
    assert.match(
      server.logs(),
      /Unknown CCSERVER_AUTH_MODE/,
      'the refusal must name itself as an unknown mode, not fail opaquely'
    );
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
