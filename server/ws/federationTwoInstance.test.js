// Issue #142 Step 4: a genuine two-real-process integration suite.
//
// Every other federation test file works around federationIdentity.js's
// process-lifetime identity singleton (see federationIdentity.js's `cached`
// variable) by either bypassing it entirely (federationLink.test.js builds
// two synthetic `identity` objects and hands them straight to FederationLink's
// constructor) or by pairing the real singleton ("self") against a second,
// independently openssl-generated identity that never touches
// ensureIdentity() ("the peer") -- see federationServer.test.js's and
// federationLink.establishAllLinks.test.js's header comments. Both are fine
// for exercising FederationLink/federationServer.js in isolation, but neither
// can ever run the REAL server/index.js boot sequence (ensureFederationServer
// + establishAllLinks + fastify.listen, in that order) twice over as two
// independent "real" instances in the same process -- the singleton is
// shared, so "instance B" would just be talking to itself under a different
// name.
//
// This file instead spawns two actual `node server/index.js` child processes,
// each with its own CCSERVER_FEDERATION_HOME (identity)/CCSERVER_DB_PATH
// (paired_instances)/CCSERVER_FEDERATION_PORT/PORT, and drives them purely
// through their real HTTP/WS surface (routes/federation.js, /ws/remote-
// terminal) -- exactly what a browser talking to two real ccserver instances
// would do. This is the only way to actually verify Issue #142's core claim:
// that pairing, RPC, and terminal relay all work even when one instance could
// never dial the other back.
//
// Simulating one-directional reachability: no OS firewall/network-namespace
// trickery (would need root and wouldn't be portable to CI). Instead, right
// after the TOFU bootstrap creates the peer's row, this file overwrites that
// ONE row's remote_addr (via a direct node:sqlite connection to the child's
// own db file -- there is no REST endpoint for this, deliberately: a browser
// user never gets to pick an arbitrary stored peer address) with a
// non-routable "blackhole" address (10.255.255.1:9 -- same address
// federationLink.establishAllLinks.test.js already validated as a reliable,
// slow-to-fail-shut non-response rather than an instant refusal). Whichever
// side has this address stored for its peer can never successfully dial that
// peer; the other side's stored address stays correct.
//
// Heavy suite: two real child processes (each running the full boot sequence,
// real TLS handshakes, real sqlite migrations) per scenario, and one scenario
// deliberately waits out FederationLink's ~30s revoke-check interval. Kept in
// its own file, away from the fast unit-test suite, for exactly that reason.

import {
  test, describe, before, after,
} from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import {
  mkdtempSync, rmSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { opensslAvailable } from './federationIdentity.js';

const skip = !opensslAvailable();

const SERVER_ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // .../server
const SERVER_ENTRY = join(SERVER_ROOT, 'index.js');
const BLACKHOLE_ADDR = '10.255.255.1:9';

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

async function allocatePorts(n) {
  const ports = [];
  for (let i = 0; i < n; i++) ports.push(await getFreePort());
  return ports;
}

async function fetchJson(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* some responses have no body */ }
  return { status: res.status, ok: res.ok, body: parsed };
}

// Directly patches one row's remote_addr in a CHILD instance's own sqlite
// file -- opened as a second, short-lived connection alongside the child
// process's own (WAL mode supports this; see db.js's applyPragmas). This is
// the one deliberate "cheat": everything else in this file goes through the
// real HTTP/WS surface, exactly like a browser would.
function blackholeRemoteAddr(dbPath, fingerprint) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('UPDATE paired_instances SET remote_addr = ? WHERE remote_fingerprint = ?')
      .run(BLACKHOLE_ADDR, fingerprint);
  } finally {
    db.close();
  }
}

function instanceOpts(tmpRoot, label, httpPort, federationPort) {
  const dir = join(tmpRoot, label);
  mkdirSync(dir, { recursive: true });
  return {
    httpPort,
    federationPort,
    dbPath: join(dir, 'test.sqlite3'),
    sandboxHomeRoot: join(dir, 'home'),
    federationHome: join(dir, 'federation'),
    groupsPath: join(dir, '.saved-groups.json'),
    savedSessionsPath: join(dir, '.saved-sessions.json'),
  };
}

// One real `node server/index.js` child process. NODE_ENV is deliberately
// left unset (not 'production') so index.js skips registering the built
// client/dist static files -- this suite only ever talks to the API/WS
// surface. CCSERVER_HOSTNAME=127.0.0.1 makes federationClient.js's
// myClaimedAddr() deterministic (real OS hostname resolution would be a
// flaky, CI-environment-dependent thing to depend on here) -- scenarios that
// want a genuinely wrong address override it afterward via blackholeRemoteAddr.
class Instance {
  constructor(name, opts) {
    this.name = name;
    this.opts = opts;
    this.proc = null;
    this.logChunks = [];
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.opts.httpPort}`;
  }

  async start() {
    const env = {
      ...process.env,
      PORT: String(this.opts.httpPort),
      CCSERVER_FEDERATION_PORT: String(this.opts.federationPort),
      CCSERVER_DB_PATH: this.opts.dbPath,
      CCSERVER_SANDBOX_HOME_ROOT: this.opts.sandboxHomeRoot,
      CCSERVER_FEDERATION_HOME: this.opts.federationHome,
      CCSERVER_GROUPS_PATH: this.opts.groupsPath,
      CCSERVER_SAVED_SESSIONS_PATH: this.opts.savedSessionsPath,
      CCSERVER_HOSTNAME: '127.0.0.1',
    };
    delete env.CCSERVER_TOKEN;
    delete env.CCSERVER_AUTH_MODE;
    delete env.NODE_ENV;

    this.logChunks = [];
    const proc = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: SERVER_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    const onData = (chunk) => {
      this.logChunks.push(chunk.toString());
      if (this.logChunks.length > 4000) this.logChunks.shift();
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    await waitFor(async () => {
      if (proc.exitCode !== null) {
        throw new Error(`${this.name} exited early (code ${proc.exitCode}) before becoming ready`);
      }
      try {
        const res = await fetch(`${this.baseUrl}/api/federation/identity`);
        return res.ok;
      } catch {
        return false;
      }
    }, { timeoutMs: 20_000, intervalMs: 150 });
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

  dumpLogs() {
    console.error(`\n----- ${this.name} (port ${this.opts.httpPort}/${this.opts.federationPort}) logs -----`);
    console.error(this.logChunks.join(''));
    console.error(`----- end ${this.name} logs -----\n`);
  }

  async identity() {
    const res = await fetch(`${this.baseUrl}/api/federation/identity`);
    return res.json();
  }
}

// Full TOFU-pair-approve-until-active dance over the real REST API, exactly
// like ApprovalBanner.jsx/SettingsView.jsx do from the browser. When
// `blackholeBAddrForA` is set, B's freshly-created row for A is patched to an
// unreachable address BEFORE either side approves -- proving the rest of this
// function (and everything callers do afterward) never actually needed B to
// be able to dial A: the link both sides end up using is the single one A's
// own TOFU dial created and adopted on both ends.
async function pairAndApprove(a, b, { blackholeBAddrForA = false } = {}) {
  const fpA = (await a.identity()).fingerprint;

  const initRes = await fetchJson('POST', `${a.baseUrl}/api/federation/instances`, {
    remoteAddr: `127.0.0.1:${b.opts.federationPort}`,
  });
  assert.equal(initRes.status, 200, `A could not initiate pairing to B: ${JSON.stringify(initRes)}`);
  const idOnA = initRes.body.instance.id;

  let pendingOnB;
  await waitFor(async () => {
    const res = await fetchJson('GET', `${b.baseUrl}/api/federation/pending`);
    pendingOnB = res.body?.pending?.find((row) => row.fingerprint === fpA);
    return !!pendingOnB;
  }, { timeoutMs: 5000 });
  const idOnB = pendingOnB.id;

  if (blackholeBAddrForA) {
    blackholeRemoteAddr(b.opts.dbPath, fpA);
  }

  const decideA = await fetchJson('POST', `${a.baseUrl}/api/federation/pending/${idOnA}/decide`, { decision: 'approved' });
  assert.equal(decideA.status, 200, `A could not approve: ${JSON.stringify(decideA)}`);
  const decideB = await fetchJson('POST', `${b.baseUrl}/api/federation/pending/${idOnB}/decide`, { decision: 'approved' });
  assert.equal(decideB.status, 200, `B could not approve: ${JSON.stringify(decideB)}`);

  await waitFor(async () => {
    const res = await fetchJson('GET', `${a.baseUrl}/api/federation/instances`);
    return res.body?.instances?.find((r) => r.id === idOnA)?.status === 'active';
  }, { timeoutMs: 15_000, intervalMs: 300 });
  await waitFor(async () => {
    const res = await fetchJson('GET', `${b.baseUrl}/api/federation/instances`);
    return res.body?.instances?.find((r) => r.id === idOnB)?.status === 'active';
  }, { timeoutMs: 15_000, intervalMs: 300 });

  return { idOnA, idOnB, fingerprintA: fpA };
}

// Opens a real browser-shaped WS connection to `from`'s /ws/remote-terminal,
// asks it to relay to `instanceId`, and sends one plain {type:'ping'} --
// answered with {type:'pong'} by terminal.js's attachTerminalHandler without
// ever spawning a session (see federationServer.test.js's identical
// single-process version of this same check). Confirms the terminal-relay
// half of the protocol, not just RPC, works over the link.
async function terminalPing(from, instanceId) {
  const ws = new WebSocket(`ws://127.0.0.1:${from.opts.httpPort}/ws/remote-terminal`);
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('websocket failed to open')), { once: true });
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('terminal ping timed out')), 10_000);
      ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        clearTimeout(timer);
        if (msg.type === 'pong') resolve(msg);
        else reject(new Error(`unexpected terminal relay message: ${JSON.stringify(msg)}`));
      }, { once: true });
      ws.send(JSON.stringify({ instanceId, type: 'ping' }));
    });
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------
// Scenario 1: one-directional reachability (A -> B works, B -> A never does)

describe('federation: two real instances, one-directional reachability', { skip }, () => {
  let tmpRoot;
  let a;
  let b;
  let pair;

  before(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-fed-2inst-onedir-'));
    const [httpA, fedA, httpB, fedB] = await allocatePorts(4);
    a = new Instance('A', instanceOpts(tmpRoot, 'a', httpA, fedA));
    b = new Instance('B', instanceOpts(tmpRoot, 'b', httpB, fedB));
    await Promise.all([a.start(), b.start()]);
    pair = await pairAndApprove(a, b, { blackholeBAddrForA: true });
  }, { timeout: 60_000 });

  after(async () => {
    await Promise.all([a?.stop(), b?.stop()]);
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('pairing reaches active and A can RPC into B over the one link A alone dialed', async () => {
    try {
      const res = await fetchJson('GET', `${a.baseUrl}/api/federation/instances/${pair.idOnA}/sessions`);
      assert.equal(res.status, 200, `sessions.list over the one-directional link failed: ${JSON.stringify(res)}`);
      assert.ok(Array.isArray(res.body.sessions));
    } catch (err) {
      a.dumpLogs();
      b.dumpLogs();
      throw err;
    }
  });

  test('terminal relay (ping/pong) works end-to-end over the same one-directionally-reachable link', async () => {
    try {
      const pong = await terminalPing(a, pair.idOnA);
      assert.deepEqual(pong, { type: 'pong' });
    } catch (err) {
      a.dumpLogs();
      b.dumpLogs();
      throw err;
    }
  });
});

// ---------------------------------------------------------------------
// Scenario 2: bidirectional reachability -- duplicate link resolution

describe('federation: two real instances, bidirectional reachability - duplicate link resolution', { skip }, () => {
  let tmpRoot;
  let optsA;
  let optsB;
  let a;
  let b;
  let pair;

  before(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-fed-2inst-dup-'));
    const [httpA, fedA, httpB, fedB] = await allocatePorts(4);
    optsA = instanceOpts(tmpRoot, 'a', httpA, fedA);
    optsB = instanceOpts(tmpRoot, 'b', httpB, fedB);
    a = new Instance('A', optsA);
    b = new Instance('B', optsB);
    await Promise.all([a.start(), b.start()]);
    // Both addresses are correct here (no blackhole) -- this scenario is
    // about what happens when BOTH sides can reach each other.
    pair = await pairAndApprove(a, b);

    // Force a genuine simultaneous-dial race: kill both processes, then
    // respawn both (same ports/db/identity -- the 'active' row and the real
    // addresses on both sides survive the restart) close together, so each
    // one's own establishAllLinks() boot-time sweep dials the other from a
    // cold start with no live link on either end yet. Duplicate-link
    // resolution (federationLink.js's winningDialerIsSelf) has to run for
    // this pair to end up usable at all afterward.
    await Promise.all([a.stop(), b.stop()]);
    a = new Instance('A', optsA);
    b = new Instance('B', optsB);
    await Promise.all([a.start(), b.start()]);
  }, { timeout: 60_000 });

  after(async () => {
    await Promise.all([a?.stop(), b?.stop()]);
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('after a simultaneous cold restart, the link converges and RPC stays stable from both directions', async () => {
    // Black-box test: this file has no access to either process's internal
    // FederationLink registry, so "duplicate resolved to exactly one link"
    // is verified indirectly -- if resolution were broken (both sides kept
    // fighting over which socket wins, or picked inconsistently), repeated
    // RPC calls from both directions would fail or flap instead of staying
    // reliably successful.
    try {
      await waitFor(async () => {
        const res = await fetchJson('GET', `${a.baseUrl}/api/federation/instances/${pair.idOnA}/sessions`);
        return res.status === 200;
      }, { timeoutMs: 15_000, intervalMs: 300 });
      await waitFor(async () => {
        const res = await fetchJson('GET', `${b.baseUrl}/api/federation/instances/${pair.idOnB}/sessions`);
        return res.status === 200;
      }, { timeoutMs: 15_000, intervalMs: 300 });

      for (let i = 0; i < 5; i++) {
        const [resA, resB] = await Promise.all([
          fetchJson('GET', `${a.baseUrl}/api/federation/instances/${pair.idOnA}/sessions`),
          fetchJson('GET', `${b.baseUrl}/api/federation/instances/${pair.idOnB}/sessions`),
        ]);
        assert.equal(resA.status, 200, `A->B call #${i} failed post-restart: ${JSON.stringify(resA)}`);
        assert.equal(resB.status, 200, `B->A call #${i} failed post-restart: ${JSON.stringify(resB)}`);
        await sleep(300);
      }
    } catch (err) {
      a.dumpLogs();
      b.dumpLogs();
      throw err;
    }
  });
});

// ---------------------------------------------------------------------
// Scenario 3: revoke propagates promptly, even under one-directional
// reachability

describe('federation: two real instances, revoke propagation under one-directional reachability', { skip }, () => {
  let tmpRoot;
  let a;
  let b;
  let pair;

  before(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-fed-2inst-revoke-'));
    const [httpA, fedA, httpB, fedB] = await allocatePorts(4);
    a = new Instance('A', instanceOpts(tmpRoot, 'a', httpA, fedA));
    b = new Instance('B', instanceOpts(tmpRoot, 'b', httpB, fedB));
    await Promise.all([a.start(), b.start()]);
    pair = await pairAndApprove(a, b, { blackholeBAddrForA: true });
  }, { timeout: 60_000 });

  after(async () => {
    await Promise.all([a?.stop(), b?.stop()]);
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test(
    'B revoking its own (never-reachable-outbound) row for A promptly tears down an idle terminal relay',
    { timeout: 30_000 },
    async () => {
      // Deliberately an IDLE, already-open terminal channel rather than a
      // fresh RPC call: a fresh RPC gets refused immediately by
      // authorizeRequest's fresh per-call DB check regardless of any timer
      // (see federationLink.js's _handleIncomingRpc), which would exercise a
      // different, less interesting code path than an already-live channel
      // with nothing new flowing over it.
      //
      // What actually tears this down: routes/federation.js's DELETE handler
      // calls removeLink(fingerprint) synchronously right after
      // pairing.revoke() -- an IMMEDIATE local teardown of any live link for
      // that peer, not federationLink.js's ~30s revokeCheckTimer (that timer
      // is a fallback for a link that is still dialing/backed off, not yet
      // live, at the moment of revocation -- already covered by
      // federationLink.test.js's fast, shortened-interval unit test). This
      // test's job is to prove that DELETE-triggered path actually reaches
      // and closes the browser-facing WS in a real 2-process,
      // one-directional-reachability topology -- i.e. that B (which could
      // never have dialed A itself) can still fully and promptly sever the
      // pair through a purely local operation.
      let ws;
      try {
        ws = new WebSocket(`ws://127.0.0.1:${a.opts.httpPort}/ws/remote-terminal`);
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', () => resolve(), { once: true });
          ws.addEventListener('error', () => reject(new Error('websocket failed to open')), { once: true });
        });
        const closed = new Promise((resolve) => {
          ws.addEventListener('close', () => resolve('closed'), { once: true });
        });

        // Prove the channel is genuinely live before revoking anything.
        const pong = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('initial ping timed out')), 10_000);
          ws.addEventListener('message', (event) => {
            clearTimeout(timer);
            resolve(JSON.parse(event.data));
          }, { once: true });
          ws.send(JSON.stringify({ instanceId: pair.idOnA, type: 'ping' }));
        });
        assert.deepEqual(pong, { type: 'pong' });

        const del = await fetchJson('DELETE', `${b.baseUrl}/api/federation/instances/${pair.idOnB}`);
        assert.equal(del.status, 200, `B could not revoke: ${JSON.stringify(del)}`);

        const outcome = await Promise.race([
          closed,
          sleep(10_000).then(() => 'timeout'),
        ]);
        assert.equal(
          outcome,
          'closed',
          'the browser-facing terminal relay must close promptly once B revokes (routes/federation.js\'s removeLink()), even though B could never have dialed A itself',
        );
      } catch (err) {
        a.dumpLogs();
        b.dumpLogs();
        throw err;
      } finally {
        try { ws?.close(); } catch { /* ignore */ }
      }
    },
  );
});
