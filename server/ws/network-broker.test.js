// Pure allow-list matching (isHostAllowed) plus a real end-to-end exercise
// of the broker process (startNetworkBroker/setNetworkBrokerMode): actual
// CONNECT tunnels against a local echo server, no real network/internet
// involved. Mirrors sandbox-git-broker.test.js's "spin up the real child
// process" style.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect as netConnect } from 'node:net';
import { rmSync } from 'node:fs';
import { isHostAllowed, isHostDenied, isHostMatched, startNetworkBroker, setNetworkBrokerMode, setNetworkBrokerLists, networkBrokerProxyUrl, buildIsolatedProxyEnv } from './network-broker.js';

// --- isHostAllowed (pure) ----------------------------------------------------

test('isHostAllowed: exact match', () => {
  assert.equal(isHostAllowed('api.anthropic.com', ['api.anthropic.com']), true);
  assert.equal(isHostAllowed('api.anthropic.com', ['API.ANTHROPIC.COM']), true, 'case-insensitive');
  assert.equal(isHostAllowed('evil.com', ['api.anthropic.com']), false);
});

test('isHostAllowed: leading-dot suffix matches the domain and its subdomains', () => {
  assert.equal(isHostAllowed('anthropic.com', ['.anthropic.com']), true);
  assert.equal(isHostAllowed('api.anthropic.com', ['.anthropic.com']), true);
  assert.equal(isHostAllowed('deep.api.anthropic.com', ['.anthropic.com']), true);
  assert.equal(isHostAllowed('notanthropic.com', ['.anthropic.com']), false, 'must not match a bare suffix without the dot boundary');
  assert.equal(isHostAllowed('anthropic.com.evil.com', ['.anthropic.com']), false);
});

test('isHostAllowed: fails closed on empty/malformed input', () => {
  assert.equal(isHostAllowed('api.anthropic.com', []), false);
  assert.equal(isHostAllowed('api.anthropic.com', undefined), false);
  assert.equal(isHostAllowed('api.anthropic.com', [null, 42, '']), false);
  assert.equal(isHostAllowed('', ['api.anthropic.com']), false);
  assert.equal(isHostAllowed(null, ['api.anthropic.com']), false);
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
  const broker = startNetworkBroker({ allowedHosts: ['127.0.0.1'] });
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
  const broker = startNetworkBroker({ allowedHosts: ['some-other-host.example'] });
  brokers.push(broker);

  const { statusLine } = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(statusLine, /^HTTP\/1\.1 403/);
});

test('missing or wrong proxy token: 407, even for an allowed host', async () => {
  const targetPort = await startEchoServer();
  const broker = startNetworkBroker({ allowedHosts: ['127.0.0.1'] });
  brokers.push(broker);

  const noAuth = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, null);
  assert.match(noAuth.statusLine, /^HTTP\/1\.1 407/);

  const wrongAuth = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth('not-the-real-token'));
  assert.match(wrongAuth.statusLine, /^HTTP\/1\.1 407/);
});

test('audit mode: always allows (and would-deny is only logged)', async () => {
  const targetPort = await startEchoServer();
  const broker = startNetworkBroker({ allowedHosts: [], mode: 'audit' });
  brokers.push(broker);

  const { statusLine } = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(statusLine, /^HTTP\/1\.1 200/, 'audit mode never blocks, even for a non-allow-listed host');
});

test('state: "open" starts the broker unrestricted, no toggle needed', async () => {
  // Every Linux bwrap launch now always arms a broker (see
  // buildSandboxSpawn), starting 'open' when network.isolate was off -- this
  // must behave exactly like no isolation at all until the running-session
  // toggle flips it, not like the (default) 'enforce' start.
  const targetPort = await startEchoServer();
  const broker = startNetworkBroker({ allowedHosts: [], state: 'open' });
  brokers.push(broker);
  assert.equal(broker.state, 'open');

  const { statusLine } = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(statusLine, /^HTTP\/1\.1 200/, 'unarmed-by-config session starts fully open, not enforced');
});

test('live toggle: setNetworkBrokerMode flips enforce <-> open without restarting', async () => {
  const targetPort = await startEchoServer();
  const broker = startNetworkBroker({ allowedHosts: [] }); // nothing allow-listed
  brokers.push(broker);

  const denied = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(denied.statusLine, /^HTTP\/1\.1 403/, 'starts in enforce with an empty allow-list');

  const flipped = await setNetworkBrokerMode(broker, 'open');
  assert.equal(flipped, true);
  const opened = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(opened.statusLine, /^HTTP\/1\.1 200/, 'open state lets everything through, same broker process');

  const flippedBack = await setNetworkBrokerMode(broker, 'enforce');
  assert.equal(flippedBack, true);
  const deniedAgain = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(deniedAgain.statusLine, /^HTTP\/1\.1 403/, 'flipping back to enforce re-applies the allow-list immediately');
});

test('setNetworkBrokerMode rejects an invalid mode and a wrong token', async () => {
  const broker = startNetworkBroker({ allowedHosts: [] });
  brokers.push(broker);

  assert.equal(await setNetworkBrokerMode(broker, 'not-a-real-mode'), false);
  assert.equal(await setNetworkBrokerMode({ port: broker.port, token: 'wrong' }, 'open'), false);
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
  const broker = startNetworkBroker({ allowedHosts: [] }); // enforce, nothing allowed
  brokers.push(broker);
  const target = `127.0.0.1:${targetPort}`;

  const denied = await rawConnect(broker.port, target, basicAuth(broker.token));
  assert.match(denied.statusLine, /^HTTP\/1\.1 403/);
  denied.sock.destroy();

  const replaced = await adminPost(broker.port, '/__admin/allowlist', broker.token, { hosts: [' 127.0.0.1 '] });
  assert.match(replaced.statusLine, /^HTTP\/1\.1 200/, 'normalizes + applies');
  assert.equal(JSON.parse(replaced.body).count, 1);

  const allowed = await rawConnect(broker.port, target, basicAuth(broker.token));
  assert.match(allowed.statusLine, /^HTTP\/1\.1 200/, 'same broker process, new verdict');
  allowed.sock.destroy();
});

test('allowlist endpoint: 401 without token, 400 on bad lists', async () => {
  const broker = startNetworkBroker({ allowedHosts: ['127.0.0.1'] });
  brokers.push(broker);

  const noAuth = await adminPost(broker.port, '/__admin/allowlist', 'wrong-token', { hosts: [] });
  assert.match(noAuth.statusLine, /^HTTP\/1\.1 401/);

  for (const body of [{ hosts: ['https://evil.example'] }, { hosts: 'nope' }, { nope: [] }]) {
    const res = await adminPost(broker.port, '/__admin/allowlist', broker.token, body);
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
  const broker = startNetworkBroker({ allowedHosts: ['127.0.0.1'], deniedHosts: ['127.0.0.1'] });
  brokers.push(broker);

  const { statusLine } = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(statusLine, /^HTTP\/1\.1 403/, 'deny wins over allow on overlap');
});

test('denied host: refused even in live open state', async () => {
  const targetPort = await startEchoServer();
  const broker = startNetworkBroker({ allowedHosts: [], deniedHosts: ['127.0.0.1'], state: 'open' });
  brokers.push(broker);

  const { statusLine } = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(statusLine, /^HTTP\/1\.1 403/, 'open allows everything except the deny-list');
});

test('denied host: refused even in audit mode', async () => {
  const targetPort = await startEchoServer();
  const broker = startNetworkBroker({ allowedHosts: [], deniedHosts: ['127.0.0.1'], mode: 'audit' });
  brokers.push(broker);

  const { statusLine } = await rawConnect(broker.port, `127.0.0.1:${targetPort}`, basicAuth(broker.token));
  assert.match(statusLine, /^HTTP\/1\.1 403/, 'audit never blocks except denied hosts');
});

test('denylist endpoint: live replacement via setNetworkBrokerLists', async () => {
  const targetPort = await startEchoServer();
  const broker = startNetworkBroker({ allowedHosts: ['127.0.0.1'] });
  brokers.push(broker);
  const target = `127.0.0.1:${targetPort}`;

  const before = await rawConnect(broker.port, target, basicAuth(broker.token));
  assert.match(before.statusLine, /^HTTP\/1\.1 200/);
  before.sock.destroy();

  assert.equal(await setNetworkBrokerLists(broker, { deniedHosts: ['127.0.0.1'] }), true);
  const denied = await rawConnect(broker.port, target, basicAuth(broker.token));
  assert.match(denied.statusLine, /^HTTP\/1\.1 403/, 'live deny push blocks without restart');
  denied.sock.destroy();

  assert.equal(await setNetworkBrokerLists(broker, { deniedHosts: [] }), true);
  const reopened = await rawConnect(broker.port, target, basicAuth(broker.token));
  assert.match(reopened.statusLine, /^HTTP\/1\.1 200/, 'clearing the deny-list restores the allow verdict');
  reopened.sock.destroy();
});
