// Regression coverage for the race fixed in f2976a2 ("close leaked
// remote-terminal channel on early browser disconnect"): if the browser
// closes /ws/remote-terminal while openTerminalChannel() is still resolving,
// the channel it eventually opens must be closed right back down instead of
// left dangling.
//
// Issue #142 Step 2 changed what "still resolving" means: openTerminalChannel
// no longer owns a dedicated one-shot TLS connection per call (that would
// leak a whole federation TLS socket if raced) -- it multiplexes a channel
// over the pair's persistent FederationLink, and getReadyLink (see
// federationClient.js) only actually awaits anything when that link isn't
// connected yet, polling until either it comes up or a bounded timeout
// elapses. So the race window this suite exercises now is "the peer's link
// is still establishing" rather than "this one call's own handshake" -- the
// underlying TCP connection is shared and MUST survive a channel close (a
// federation TLS connection is a shared resource across every open tab
// against that peer now, not a leak the way it was in the one-shot design);
// what must not survive is the CHANNEL this call opened over it.
//
// Reuses the real federationClient/federationServer/federationPairing/
// federationLink stack end-to-end (same two-identity technique as
// routes/federation.test.js / ws/federationServer.test.js) plus a
// deliberately slow TCP relay in front of the real peer, so a link's dial
// can be caught reliably mid-flight -- a bare loopback TLS handshake
// completes far too fast to race against a synchronous close() otherwise.
// The pairing bootstrap itself (initiatePairing) still dials the peer
// directly and adopts that connection as the pair's first link before the
// relay is even created (see this file's header comment further down) --
// both sides' stale links are evicted once the relay is wired in, so the
// tests below hit a link that has to dial fresh, through the relay.
// remoteTerminalWs() itself is driven directly (a fake `fastify.get` that
// captures the route handler, a fake browser socket with the minimal
// {on,send,readyState} shape sessionManager.test.js's fake sockets already
// use) rather than through a real WebSocket client / Fastify listener,
// since no other *Ws route in this codebase is tested at that layer --
// ws/terminal.js, the route this one was factored out of, has none either.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer, createConnection as createNetConnection } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../db.js';
import { remoteTerminalWs } from './remoteTerminal.js';
import { initiatePairing } from './federationClient.js';
import * as pairing from './federationPairing.js';
import { opensslAvailable, _resetIdentityCacheForTests, ensureIdentity } from './federationIdentity.js';
import { ensureFederationServer, stopFederationServer, _resetFederationServerForTests } from './federationServer.js';
import { getLink, removeLink } from './federationLink.js';

const skip = !opensslAvailable();
const HANDSHAKE_DELAY_MS = 300;

let tmpRoot;
let peerPort;
let proxyServer;
let acceptedProxySockets;
let row;
let routeHandler;
const savedHome = process.env.CCSERVER_FEDERATION_HOME;
const savedPort = process.env.CCSERVER_FEDERATION_PORT;

// A raw TCP relay that accepts a connection immediately (so the client's
// TLS bytes are captured, not refused) but only dials the real peer after
// HANDSHAKE_DELAY_MS -- long enough for a test to close the browser socket
// while federationClient.openTerminalChannel() is still awaiting the TLS
// handshake through it. Once the delay elapses it's a plain bidirectional
// pipe, so the handshake and everything after it behaves exactly as a direct
// connection would.
function startDelayProxy(targetPort, onAccept) {
  const server = createNetServer((client) => {
    onAccept(client);
    client.pause();
    setTimeout(() => {
      const upstream = createNetConnection({ host: '127.0.0.1', port: targetPort }, () => {
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
    }, HANDSHAKE_DELAY_MS);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

class FakeBrowserSocket {
  constructor() {
    this._handlers = {};
    this.readyState = 1;
    this.sent = [];
  }
  on(event, cb) { (this._handlers[event] ??= []).push(cb); }
  send(data) { this.sent.push(data); }
}

before(async () => {
  if (skip) return;
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-remote-terminal-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');

  // The peer: a real federation listener with its own identity (same
  // technique as routes/federation.test.js).
  process.env.CCSERVER_FEDERATION_HOME = join(tmpRoot, 'peer-federation');
  _resetIdentityCacheForTests();
  const peerServer = await ensureFederationServer({ port: 0, log: console });
  peerPort = peerServer.address().port;

  // "Self" -- the instance whose /ws/remote-terminal route is under test.
  process.env.CCSERVER_FEDERATION_HOME = join(tmpRoot, 'self-federation');
  process.env.CCSERVER_FEDERATION_PORT = '1';
  _resetIdentityCacheForTests();

  const proposed = await initiatePairing({ remoteAddr: `127.0.0.1:${peerPort}`, label: 'peer' });
  const myFingerprint = (await ensureIdentity()).fingerprint;
  const peerSideRow = pairing.getInstanceByFingerprint(myFingerprint);
  assert.ok(peerSideRow, 'the peer recorded an inbound row for us');
  pairing.recordLocalDecision(peerSideRow.id, 'approved');
  pairing.recordRemoteDecision(peerSideRow.id, 'approved');
  // Normally learned by polling the peer (federationClient.reconcilePending,
  // driven from the REST layer -- see routes/federation.js); recorded
  // directly here since this suite never calls that REST layer.
  pairing.recordLocalDecision(proposed.id, 'approved');
  pairing.recordRemoteDecision(proposed.id, 'approved');
  row = pairing.getInstance(proposed.id);
  assert.equal(row.status, 'active');

  acceptedProxySockets = [];
  proxyServer = await startDelayProxy(peerPort, (s) => acceptedProxySockets.push(s));
  // Route this (already-active) pair's terminal traffic through the slow
  // relay instead of straight to the peer -- pairing itself is already done
  // above; only the link dial in the tests below is affected.
  getDb().prepare('UPDATE paired_instances SET remote_addr = ? WHERE id = ?')
    .run(`127.0.0.1:${proxyServer.address().port}`, row.id);
  // initiatePairing above already adopted a persistent FederationLink
  // pointed at the real peer address, dialed before the relay existed --
  // evict both sides' now-stale link (self's view of the peer, keyed by the
  // peer's fingerprint; the peer's view of self, keyed by ours) so the
  // tests below's very first channel open has to dial fresh, through the
  // relay this suite actually wants to race against.
  removeLink(row.fingerprint);
  removeLink(myFingerprint);

  const fakeFastify = { get: (_path, _opts, handler) => { routeHandler = handler; } };
  await remoteTerminalWs(fakeFastify, {});
  assert.equal(typeof routeHandler, 'function');
});

after(async () => {
  if (skip) return;
  // Issue #142 Step 2: unlike the one-shot connection this suite originally
  // raced against, the shared link deliberately survives a browser tab
  // closing (see the first test below) -- so by the time we get here, its
  // live TCP connection through the relay is still open. net.Server#close()
  // only fires its callback once every existing connection has closed on
  // its own, so tearing down every FederationLink (which destroys their
  // live sockets) has to happen BEFORE closing the relay, or this hangs
  // forever waiting for a connection nothing will ever close.
  stopFederationServer();
  _resetFederationServerForTests();
  if (proxyServer) await new Promise((resolve) => proxyServer.close(resolve));
  _resetIdentityCacheForTests();
  closeDb();
  delete process.env.CCSERVER_DB_PATH;
  delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  if (savedHome === undefined) delete process.env.CCSERVER_FEDERATION_HOME; else process.env.CCSERVER_FEDERATION_HOME = savedHome;
  if (savedPort === undefined) delete process.env.CCSERVER_FEDERATION_PORT; else process.env.CCSERVER_FEDERATION_PORT = savedPort;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('closing the browser socket mid-handshake closes the freshly opened federation channel instead of leaking it', { skip }, async () => {
  const socket = new FakeBrowserSocket();
  routeHandler(socket, {});
  const handleMessage = socket._handlers.message[0];
  const handleClose = socket._handlers.close[0];

  const pending = handleMessage(Buffer.from(JSON.stringify({
    type: 'ping', instanceId: row.id,
  })));

  // Give the handler time to reach `await openTerminalChannel(...)` --
  // HANDSHAKE_DELAY_MS keeps that promise pending well past this.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(acceptedProxySockets.length, 1, 'the handshake attempt reached the relay before we close the browser socket');
  assert.equal(acceptedProxySockets[0].destroyed, false, 'sanity: the relay socket is still open going into the race');

  handleClose(); // simulates the browser tab closing right after opening it

  await pending; // the message handler is async -- let it run to completion

  // Past HANDSHAKE_DELAY_MS the relay has connected upstream and the link
  // has finished connecting inside openTerminalChannel()'s getReadyLink
  // wait; the fix's `closed` check must have closed the CHANNEL right back
  // down instead of leaving it open with nobody left to read from it. The
  // underlying link itself is a shared resource now (Issue #142 Step 2) --
  // it must NOT be torn down just because this one tab closed, so the relay
  // socket stays open and the link stays connected.
  await new Promise((resolve) => setTimeout(resolve, HANDSHAKE_DELAY_MS + 400));
  const link = getLink(row.fingerprint);
  assert.ok(link, 'the link this call created is still registered');
  assert.equal(link.connected, true, 'the shared link survives one tab closing, unlike the one-shot connection it replaced');
  assert.equal(acceptedProxySockets[0].destroyed, false, 'the relay connection backing the shared link was not torn down');
  assert.equal(link.outboundChannels.size, 0, 'the channel this call opened was closed instead of left dangling');
});

test('without a race, a message is relayed to the peer and the reply is forwarded back to the browser', { skip }, async () => {
  const socket = new FakeBrowserSocket();
  routeHandler(socket, {});
  const handleMessage = socket._handlers.message[0];

  await handleMessage(Buffer.from(JSON.stringify({ type: 'ping', instanceId: row.id })));

  await new Promise((resolve) => setTimeout(resolve, HANDSHAKE_DELAY_MS + 400));
  const pong = socket.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'pong');
  assert.ok(pong, `expected a relayed pong, got: ${JSON.stringify(socket.sent)}`);
});
