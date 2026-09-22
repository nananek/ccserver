// Pure allow-list matching (isHostAllowed) plus a real end-to-end exercise
// of the broker process (startNetworkBroker/setNetworkBrokerMode): actual
// CONNECT tunnels against a local echo server, no real network/internet
// involved. Mirrors sandbox-git-broker.test.js's "spin up the real child
// process" style.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect as netConnect } from 'node:net';
import { spawn as spawnFn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHostAllowed, isHostDenied, isHostMatched, startNetworkBroker, setNetworkBrokerMode, setNetworkBrokerLists, networkBrokerProxyUrl, buildIsolatedProxyEnv } from './network-broker.js';

const NETWORK_BROKER_PATH = fileURLToPath(new URL('./network-broker.js', import.meta.url));

// --- isHostAllowed (pure) ----------------------------------------------------

test('isHostAllowed: exact match', () => {
  assert.equal(isHostAllowed('api.example.com', ['api.example.com']), true);
  assert.equal(isHostAllowed('api.example.com', ['API.EXAMPLE.COM']), true, 'case-insensitive');
  assert.equal(isHostAllowed('other.example.com', ['api.example.com']), false);
});

test('isHostAllowed: leading-dot suffix matches the domain and its subdomains', () => {
  assert.equal(isHostAllowed('example.com', ['.example.com']), true);
  assert.equal(isHostAllowed('api.example.com', ['.example.com']), true);
  assert.equal(isHostAllowed('deep.api.example.com', ['.example.com']), true);
  assert.equal(isHostAllowed('notexample.com', ['.example.com']), false, 'must not match a bare suffix without the dot boundary');
  assert.equal(isHostAllowed('example.com.attacker.example', ['.example.com']), false);
});

test('isHostAllowed: fails closed on empty/malformed input', () => {
  assert.equal(isHostAllowed('api.example.com', []), false);
  assert.equal(isHostAllowed('api.example.com', undefined), false);
  assert.equal(isHostAllowed('api.example.com', [null, 42, '']), false);
  assert.equal(isHostAllowed('', ['api.example.com']), false);
  assert.equal(isHostAllowed(null, ['api.example.com']), false);
});

// --- real broker process: CONNECT relay, auth, live toggle, audit mode -----

const brokers = [];
const echoServers = [];

after(() => {
  for (const b of brokers) {
    try { b.proc.kill('SIGKILL'); } catch { /* already dead */ }
    try { rmSync(b.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  for (const s of echoServers) { try { s.close(); } catch { /* ignore */ } }
});

// A plain TCP echo server standing in for "the real destination" -- CONNECT
// tunnels are transport-agnostic, so an echo server is enough to prove data
// actually flows both ways through the broker.
function startEchoServer() {
  return new Promise((resolve) => {
    const server = createServer((sock) => { sock.on('data', (d) => sock.write(d)); });
    server.listen(0, '127.0.0.1', () => {
      echoServers.push(server);
      resolve(server.address().port);
    });
  });
}

// Issues a raw CONNECT through the broker and resolves with the status line
// and (on 200) the tunnel socket, positioned right after the blank line that
// ends the CONNECT response headers.
function rawConnect(brokerPort, targetHostPort, proxyAuthHeader) {
  return new Promise((resolve, reject) => {
    const sock = netConnect(brokerPort, '127.0.0.1');
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      sock.removeListener('data', onData);
      const statusLine = buf.slice(0, buf.indexOf('\r\n'));
      resolve({ statusLine, sock });
    };
    sock.on('data', onData);
    sock.on('error', reject);
    sock.on('connect', () => {
      const lines = [`CONNECT ${targetHostPort} HTTP/1.1`, `Host: ${targetHostPort}`];
      if (proxyAuthHeader) lines.push(`Proxy-Authorization: ${proxyAuthHeader}`);
      sock.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
  });
}

function basicAuth(token) {
  return `Basic ${Buffer.from(`x:${token}`).toString('base64')}`;
}

test('allowed host: CONNECT succeeds and data relays both ways', async () => {
  const targetPort = await startEchoServer();
  const broker = await startNetworkBroker({ allowedHosts: ['127.0.0.1'] });
  brokers.push(broker);

  const { statusLine, sock } = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(statusLine, /^HTTP\/1\.1 200/);

  const echoed = await new Promise((resolve) => {
    sock.once('data', (d) => resolve(d.toString()));
    sock.write('ping\n');
  });
  assert.equal(echoed, 'ping\n');
  sock.destroy();
});

test('non-allowed host: CONNECT is refused with 403', async () => {
  const targetPort = await startEchoServer();
  const broker = await startNetworkBroker({ allowedHosts: ['some-other-host.example'] });
  brokers.push(broker);

  const { statusLine } = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(statusLine, /^HTTP\/1\.1 403/);
});

test('missing or wrong proxy token: 407, even for an allowed host', async () => {
  const targetPort = await startEchoServer();
  const broker = await startNetworkBroker({ allowedHosts: ['127.0.0.1'] });
  brokers.push(broker);

  const noAuth = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, null);
  assert.match(noAuth.statusLine, /^HTTP\/1\.1 407/);

  const wrongAuth = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth('not-the-real-token'));
  assert.match(wrongAuth.statusLine, /^HTTP\/1\.1 407/);
});

test('audit mode: always allows (and would-deny is only logged)', async () => {
  const targetPort = await startEchoServer();
  const broker = await startNetworkBroker({ allowedHosts: [], mode: 'audit' });
  brokers.push(broker);

  const { statusLine } = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(statusLine, /^HTTP\/1\.1 200/, 'audit mode never blocks, even for a non-allow-listed host');
});

test('state: "open" starts the broker unrestricted, no toggle needed', async () => {
  // An isolation-enabled launch with network.initialState 'open' (see buildSandboxSpawn)
  // must behave exactly like no isolation at all until the running-session
  // toggle flips it, not like the (default) 'enforce' start.
  const targetPort = await startEchoServer();
  const broker = await startNetworkBroker({ allowedHosts: [], state: 'open' });
  brokers.push(broker);
  assert.equal(broker.state, 'open');

  const { statusLine } = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(statusLine, /^HTTP\/1\.1 200/, 'open-start session begins fully open, not enforced');
});

test('live toggle: setNetworkBrokerMode flips enforce <-> open without restarting', async () => {
  const targetPort = await startEchoServer();
  const broker = await startNetworkBroker({ allowedHosts: [] }); // nothing allow-listed
  brokers.push(broker);

  const denied = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(denied.statusLine, /^HTTP\/1\.1 403/, 'starts in enforce with an empty allow-list');

  const flipped = await setNetworkBrokerMode({ port: broker.port, token: broker.adminToken }, 'open');
  assert.equal(flipped, true);
  const opened = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(opened.statusLine, /^HTTP\/1\.1 200/, 'open state lets everything through, same broker process');

  const flippedBack = await setNetworkBrokerMode({ port: broker.port, token: broker.adminToken }, 'enforce');
  assert.equal(flippedBack, true);
  const deniedAgain = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(deniedAgain.statusLine, /^HTTP\/1\.1 403/, 'flipping back to enforce re-applies the allow-list immediately');
});

test('setNetworkBrokerMode rejects an invalid mode and a wrong token', async () => {
  const broker = await startNetworkBroker({ allowedHosts: [] });
  brokers.push(broker);

  assert.equal(await setNetworkBrokerMode({ port: broker.port, token: broker.adminToken }, 'not-a-real-mode'), false);
  assert.equal(await setNetworkBrokerMode({ port: broker.port, token: 'wrong' }, 'open'), false);
});

// H1 fix regression: before this fix, the proxy token embedded in the
// sandbox's HTTP_PROXY/HTTPS_PROXY env (readable by anything running inside
// the sandbox) was the SAME value that authenticated /__admin/mode and
// /__admin/allowlist -- a sandboxed agent could read it off its own env and
// use it to disable its own network egress allow-list. The two tokens must
// now be independent, and the proxy token alone must never authenticate an
// admin call.
test('H1: the proxy token (visible inside the sandbox) cannot authenticate admin endpoints', async () => {
  const broker = await startNetworkBroker({ allowedHosts: ['allowed.example'] });
  brokers.push(broker);

  assert.notEqual(broker.token, broker.adminToken, 'proxy token and admin token must be independent secrets');

  const rejectedMode = await adminPost(broker.port, '/__admin/mode', broker.token, { mode: 'open' });
  assert.match(rejectedMode.statusLine, /^HTTP\/1\.1 401/, 'proxy token must not open the live allow-list toggle');

  const rejectedAllowlist = await adminPost(broker.port, '/__admin/allowlist', broker.token, { hosts: ['evil.example'] });
  assert.match(rejectedAllowlist.statusLine, /^HTTP\/1\.1 401/, 'proxy token must not replace the allow-list');

  const acceptedMode = await adminPost(broker.port, '/__admin/mode', broker.adminToken, { mode: 'open' });
  assert.match(acceptedMode.statusLine, /^HTTP\/1\.1 200/, 'the real admin token still works');
});

// --- H1 follow-up (review on #178): the admin token now arrives over a
// private pipe (the child's stdin) instead of its own env -- see
// network-broker.js's readAdminTokenFromStdin. These spawn the file directly
// (bypassing startNetworkBroker's own well-formed handshake) to drive that
// handshake into every failure shape it must reject: the broker must never
// listen (no port file, no accepting socket) without a validated token.

function spawnBrokerDirect() {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-nb-stdin-test-'));
  const allowlistPath = join(dir, 'allowlist.json');
  const denylistPath = join(dir, 'denylist.json');
  const portFile = join(dir, 'port');
  writeFileSync(allowlistPath, '[]');
  writeFileSync(denylistPath, '[]');
  const proc = spawnFn(process.execPath, [
    NETWORK_BROKER_PATH, '--serve',
    '--allowlist', allowlistPath, '--denylist', denylistPath,
    '--mode', 'enforce', '--state', 'enforce', '--port-file', portFile,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CCSANDBOX_NETWORK_BROKER_TOKEN: 'irrelevant-proxy-token' },
  });
  proc.stdout.resume();
  proc.stderr.resume();
  return { proc, dir, portFile };
}

function waitForExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    proc.on('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
  });
}

test('H1: empty, malformed, or oversized admin-token stdin fails the broker closed', async () => {
  const cases = [
    ['empty (immediate EOF)', (p) => p.stdin.end()],
    ['malformed token', (p) => p.stdin.end('not-a-real-token')],
    ['oversized payload', (p) => p.stdin.end('a'.repeat(1000))],
  ];
  for (const [name, write] of cases) {
    const { proc, dir, portFile } = spawnBrokerDirect();
    write(proc);
    const result = await waitForExit(proc, 3000);
    try {
      assert.ok(result, `${name}: broker must exit, not hang, on bad admin-token stdin`);
      assert.notEqual(result.code, 0, `${name}: broker must exit non-zero on bad admin-token stdin`);
      assert.equal(existsSync(portFile), false, `${name}: broker must never create a port file / start listening without a valid admin token`);
    } finally {
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
});

test('H1: admin-token stdin that never reaches EOF never starts the broker', async () => {
  const { proc, dir, portFile } = spawnBrokerDirect();
  // Deliberately never call proc.stdin.end(): readAdminTokenFromStdin waits
  // for EOF and must not fall back to starting the server in the meantime.
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    assert.equal(existsSync(portFile), false, 'broker must not start listening while still waiting on the admin-token handshake');
    assert.equal(proc.exitCode, null, 'broker should still be waiting, not have exited/crashed on its own');
  } finally {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('H1: an asynchronous EPIPE while sending the admin token fails startup without crashing the parent', async () => {
  const closeStdinBeforeReturning = (_command, _args, options) => {
    const proc = spawnFn(process.execPath, [
      '-e',
      'require("node:fs").closeSync(0); setTimeout(() => process.exit(1), 500)',
    ], options);
    // Make the child close fd 0 before startNetworkBroker calls stdin.end().
    // The resulting EPIPE is emitted asynchronously on proc.stdin; try/catch
    // around .end() cannot handle it.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    return proc;
  };
  await assert.rejects(
    () => startNetworkBroker({}, { spawnProcess: closeStdinBeforeReturning }),
    /network broker failed to start: (?:write EPIPE|exited code=1)/,
  );
});

test('networkBrokerProxyUrl embeds the token as Basic-auth userinfo', () => {
  const url = networkBrokerProxyUrl({ port: 12345, token: 'abc/def' });
  assert.equal(url, 'http://networkbroker:abc%2Fdef@127.0.0.1:12345');
});

test('buildIsolatedProxyEnv sets both proxy casings plus loopback NO_PROXY', () => {
  const env = buildIsolatedProxyEnv({ host: '10.0.2.2', port: 54321, token: 'a/b' });
  const expected = 'http://networkbroker:a%2Fb@10.0.2.2:54321';
  assert.equal(env.HTTP_PROXY, expected);
  assert.equal(env.HTTPS_PROXY, expected);
  assert.equal(env.http_proxy, expected);
  assert.equal(env.https_proxy, expected);
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1');
  assert.equal(env.no_proxy, 'localhost,127.0.0.1');
  const withExtra = buildIsolatedProxyEnv({ host: 'h', port: 1, token: 't', noProxyExtra: ['dind'] });
  assert.equal(withExtra.NO_PROXY, 'localhost,127.0.0.1,dind');
});

// --- live allow-list replacement (POST /__admin/allowlist) -------------------

// Plain HTTP POST against the broker's admin endpoint (not a CONNECT tunnel).
// The child never sets Content-Length (Node replies chunked), and headers
// and body can arrive in separate packets, so this waits for a complete body:
// either the declared Content-Length bytes or a fully decoded chunked frame.
function adminPost(brokerPort, path, token, body) {
  return new Promise((resolve, reject) => {
    const sock = netConnect(brokerPort, '127.0.0.1');
    const payload = JSON.stringify(body);
    let buf = '';
    const tryResolve = () => {
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return false;
      const head = buf.slice(0, idx);
      let rest = buf.slice(idx + 4);
      const lenMatch = /content-length:\s*(\d+)/i.exec(head);
      if (lenMatch) {
        if (rest.length < Number(lenMatch[1])) return false;
        resolve({ statusLine: head.slice(0, head.indexOf('\r\n')), body: rest.slice(0, Number(lenMatch[1])) });
        return true;
      }
      if (/transfer-encoding:\s*chunked/i.test(head)) {
        let out = '';
        for (;;) {
          const eol = rest.indexOf('\r\n');
          if (eol === -1) return false;
          const size = parseInt(rest.slice(0, eol), 16);
          if (Number.isNaN(size)) return false;
          if (rest.length < eol + 2 + size + 2) return false;
          if (size === 0) {
            resolve({ statusLine: head.slice(0, head.indexOf('\r\n')), body: out });
            return true;
          }
          out += rest.slice(eol + 2, eol + 2 + size);
          rest = rest.slice(eol + 2 + size + 2);
        }
      }
      resolve({ statusLine: head.slice(0, head.indexOf('\r\n')), body: rest });
      return true;
    };
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      tryResolve();
    });
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write(
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\n`
        + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
      );
    });
  });
}

test('allowlist endpoint: live replacement flips verdicts without restarting', async () => {
  const targetPort = await startEchoServer();
  const broker = await startNetworkBroker({ allowedHosts: [] }); // enforce, nothing allowed
  brokers.push(broker);
  const target = `127.0.0.1:${targetPort}`;

  const denied = await rawConnect(broker.port, target, basicAuth(broker.token));
  assert.match(denied.statusLine, /^HTTP\/1\.1 403/);
  denied.sock.destroy();

  const replaced = await adminPost(broker.port, '/__admin/allowlist', broker.adminToken, { hosts: [' 127.0.0.1 '] });
  assert.match(replaced.statusLine, /^HTTP\/1\.1 200/, 'normalizes + applies');
  assert.equal(JSON.parse(replaced.body).count, 1);

  const allowed = await rawConnect(broker.port, target, basicAuth(broker.token));
  assert.match(allowed.statusLine, /^HTTP\/1\.1 200/, 'same broker process, new verdict');
  allowed.sock.destroy();
});

test('allowlist endpoint: 401 without token, 400 on bad lists', async () => {
  const broker = await startNetworkBroker({ allowedHosts: ['127.0.0.1'] });
  brokers.push(broker);

  const noAuth = await adminPost(broker.port, '/__admin/allowlist', 'wrong-token', { hosts: [] });
  assert.match(noAuth.statusLine, /^HTTP\/1\.1 401/);

  for (const body of [{ hosts: ['https://evil.example'] }, { hosts: 'nope' }, { nope: [] }]) {
    const res = await adminPost(broker.port, '/__admin/allowlist', broker.adminToken, body);
    assert.match(res.statusLine, /^HTTP\/1\.1 400/, `rejects ${JSON.stringify(body)}`);
  }

  // A rejected push changes nothing: the original list still allows.
  const targetPort = await startEchoServer();
  const { statusLine, sock } = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(statusLine, /^HTTP\/1\.1 200/);
  sock.destroy();
});

// --- deny-list (deniedHosts): absolute deny, wins over allow/open/audit ----

test('isHostDenied: same exact-or-leading-dot syntax as the allow-list', () => {
  assert.equal(isHostDenied('evil.example', ['evil.example']), true);
  assert.equal(isHostDenied('sub.evil.example', ['.evil.example']), true);
  assert.equal(isHostDenied('evil.example', ['.evil.example']), true);
  assert.equal(isHostDenied('not-evil.example', ['.evil.example']), false);
  assert.equal(isHostMatched('a.example', ['a.example']), true, 'shared matcher');
  assert.equal(isHostDenied('a.example', []), false);
});

test('denied host: CONNECT is refused even when allow-listed (enforce)', async () => {
  const targetPort = await startEchoServer();
  const broker = await startNetworkBroker({ allowedHosts: ['127.0.0.1'], deniedHosts: ['127.0.0.1'] });
  brokers.push(broker);

  const { statusLine } = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(statusLine, /^HTTP\/1\.1 403/, 'deny wins over allow on overlap');
});

test('denied host: refused even in live open state', async () => {
  const targetPort = await startEchoServer();
  const broker = await startNetworkBroker({ allowedHosts: [], deniedHosts: ['127.0.0.1'], state: 'open' });
  brokers.push(broker);

  const { statusLine } = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(statusLine, /^HTTP\/1\.1 403/, 'open allows everything except the deny-list');
});

test('denied host: refused even in audit mode', async () => {
  const targetPort = await startEchoServer();
  const broker = await startNetworkBroker({ allowedHosts: [], deniedHosts: ['127.0.0.1'], mode: 'audit' });
  brokers.push(broker);

  const { statusLine } = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(statusLine, /^HTTP\/1\.1 403/, 'audit never blocks except denied hosts');
});

test('denylist endpoint: live replacement via setNetworkBrokerLists', async () => {
  const targetPort = await startEchoServer();
  const broker = await startNetworkBroker({ allowedHosts: ['127.0.0.1'] });
  brokers.push(broker);
  const target = `127.0.0.1:${targetPort}`;

  const before = await rawConnect(broker.port, target, basicAuth(broker.token));
  assert.match(before.statusLine, /^HTTP\/1\.1 200/);
  before.sock.destroy();

  assert.equal(await setNetworkBrokerLists({ port: broker.port, token: broker.adminToken }, { deniedHosts: ['127.0.0.1'] }), true);
  const denied = await rawConnect(broker.port, target, basicAuth(broker.token));
  assert.match(denied.statusLine, /^HTTP\/1\.1 403/, 'live deny push blocks without restart');
  denied.sock.destroy();

  assert.equal(await setNetworkBrokerLists({ port: broker.port, token: broker.adminToken }, { deniedHosts: [] }), true);
  const reopened = await rawConnect(broker.port, target, basicAuth(broker.token));
  assert.match(reopened.statusLine, /^HTTP\/1\.1 200/, 'clearing the deny-list restores the allow verdict');
  reopened.sock.destroy();
});

// --- RST resilience: client abort after deny must not kill the broker ------
// Regression for `CONNECT tomadoi.com:443 -> deny (denylist)` followed by
// `Error: read ECONNRESET / Unhandled 'error' event / exited code=1`.
// 407/400/403 paths used to end() without any socket 'error' listener, so a
// client RST after the verdict killed the whole broker process.
test('client RST after 403/407/400 does not kill the broker', async () => {
  const targetPort = await startEchoServer();
  const broker = await startNetworkBroker({ allowedHosts: [], deniedHosts: ['127.0.0.1'] });
  brokers.push(broker);
  const target = `127.0.0.1:${targetPort}`;

  // 403 deny + abrupt RST (no graceful close, mirrors undici/curl on 403).
  const denied = await rawConnect(broker.port, target, basicAuth(broker.token));
  assert.match(denied.statusLine, /^HTTP\/1\.1 403/);
  denied.sock.destroy(); // RST instead of FIN

  // 407 (no/wrong token) + abrupt RST.
  const noAuth = await rawConnect(broker.port, target, null);
  assert.match(noAuth.statusLine, /^HTTP\/1\.1 407/);
  noAuth.sock.destroy();

  // Fire-and-forget CONNECT that never waits for the verdict, then RST.
  await new Promise((resolve) => {
    const sock = netConnect(broker.port, '127.0.0.1', () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${basicAuth(broker.token)}\r\n\r\n`);
      sock.destroy();
      // Give the broker a tick to hit the ECONNRESET path if unhandled.
      setTimeout(resolve, 100);
    });
    sock.on('error', () => {});
  });

  // Malformed HTTP + abrupt close (clientError path).
  await new Promise((resolve) => {
    const sock = netConnect(broker.port, '127.0.0.1', () => {
      sock.write('NOT-A-REAL-REQUEST\r\n\r\n');
      sock.destroy();
      setTimeout(resolve, 100);
    });
    sock.on('error', () => {});
  });

  // Broker must still be alive and still enforce the denylist.
  assert.equal(broker.proc.exitCode, null, 'broker survived client RSTs');
  assert.equal(broker.proc.signalCode, null, 'broker survived client RSTs');
  const stillDenied = await rawConnect(broker.port, target, basicAuth(broker.token));
  assert.match(stillDenied.statusLine, /^HTTP\/1\.1 403/, 'same broker still answers after RSTs');
  stillDenied.sock.destroy();
});
