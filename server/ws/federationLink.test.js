// Two layers of coverage, mirroring federationServer.test.js's split:
//  1. Pure functions (nextReconnectDelayMs, winningDialerIsSelf) -- no
//     networking, no DB.
//  2. A real mTLS integration suite with TWO independently-generated
//     identities ("A" and "B", neither going through
//     federationIdentity.js's singleton -- FederationLink takes its
//     selfIdentity as a plain constructor argument, so there is nothing to
//     fight there). Both A's and B's paired_instances rows live in the same
//     test-local sqlite DB, which is fine: they're keyed by different
//     remote_fingerprint values (B's fingerprint for A's row, A's for B's),
//     exactly like two real, separate instances' independent DBs would be.
//     Skips the whole live suite when openssl is unavailable, same as
//     federationIdentity.test.js / federationServer.test.js.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTlsServer } from 'node:tls';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, readFileSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { closeDb, getDb } from '../db.js';
import * as pairing from './federationPairing.js';
import { opensslAvailable, peerCertInfo } from './federationIdentity.js';
import {
  FederationLink,
  nextReconnectDelayMs,
  winningDialerIsSelf,
  RPC_METHODS,
  authorizeRequest,
} from './federationLink.js';

// ---------------------------------------------------------------------
// Pure function tests

test('nextReconnectDelayMs: 2s initial, x1.5 growth, capped at 10s', () => {
  let d = nextReconnectDelayMs(null);
  assert.equal(d, 2000);
  d = nextReconnectDelayMs(d);
  assert.equal(d, 3000);
  d = nextReconnectDelayMs(d);
  assert.equal(d, 4500);
  d = nextReconnectDelayMs(d);
  assert.equal(d, 6750);
  d = nextReconnectDelayMs(d);
  assert.equal(d, 10000);
  d = nextReconnectDelayMs(d);
  assert.equal(d, 10000, 'stays capped once at the ceiling');
});

test('winningDialerIsSelf: lexicographically smaller fingerprint wins, symmetric across perspectives', () => {
  assert.equal(winningDialerIsSelf('aaa', 'bbb'), true);
  assert.equal(winningDialerIsSelf('bbb', 'aaa'), false);
  // Whichever side computes it, the two perspectives must disagree about
  // who "self" is winning as -- otherwise both (or neither) side would keep
  // the same physical connection, which is the whole point of the rule.
  assert.notEqual(winningDialerIsSelf('aaa', 'bbb'), winningDialerIsSelf('bbb', 'aaa'));
});

test('RPC_METHODS / authorizeRequest are exported here for link dispatch to share', () => {
  assert.equal(typeof RPC_METHODS['sessions.list'], 'function');
  assert.equal(authorizeRequest({ kind: 'rpc', method: 'sessions.list' }, { status: 'active' }, false).ok, true);
});

// Issue #161 regression: a forgotten (hard-deleted) peer must be treated
// exactly like a never-before-seen one, not like a revoked one -- the whole
// point of forgetting is to unblock a fresh pairing.propose from that
// fingerprint. federationPairing.forgetInstance() achieves this purely by
// deleting the row (see that module), so what matters here is confirming
// authorizeRequest's existing "no row at all" branch already does the right
// thing for pairing.propose specifically, since that is the one RPC a
// pre-active peer is allowed to call.
test('authorizeRequest: pairing.propose from an unknown (or forgotten) fingerprint is allowed', () => {
  assert.equal(authorizeRequest({ kind: 'rpc', method: 'pairing.propose' }, undefined, false).ok, true);
  assert.equal(authorizeRequest({ kind: 'rpc', method: 'pairing.propose' }, null, false).ok, true);
});

test('authorizeRequest: pairing.propose from a still-revoked fingerprint is refused', () => {
  const result = authorizeRequest({ kind: 'rpc', method: 'pairing.propose' }, { status: 'revoked' }, false);
  assert.equal(result.ok, false);
  assert.match(result.error, /revoked/);
});

// ---------------------------------------------------------------------
// Live mTLS integration suite

const skip = !opensslAvailable();
let tmpRoot;

function genIdentity(dir, cn) {
  mkdirSync(dir, { recursive: true });
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ed25519', '-days', '36500', '-nodes',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-subj', `/CN=${cn}`,
  ], { stdio: 'ignore' });
  const key = readFileSync(join(dir, 'key.pem'));
  const cert = readFileSync(join(dir, 'cert.pem'), 'utf-8');
  const fingerprint = new X509Certificate(cert).fingerprint256;
  return { key, cert, fingerprint };
}

function listenTls(identity, onSocket) {
  return new Promise((resolve) => {
    const server = createTlsServer(
      { key: identity.key, cert: identity.cert, requestCert: true, rejectUnauthorized: false },
      onSocket,
    );
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function waitFor(fn, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok;
      try { ok = fn(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// Approves a freshly recorded row on both sides so deriveStatus lands on
// 'active' immediately -- these tests exercise the link, not the approval
// workflow (already covered by federationPairing.test.js).
function approve(row) {
  pairing.recordLocalDecision(row.id, 'approved');
  pairing.recordRemoteDecision(row.id, 'approved');
  return pairing.getInstance(row.id);
}

let identityA;
let identityB;
let serverA;
let serverB;
// Mutable per-test targets: serverA/serverB's inbound handler forwards to
// whichever link the CURRENT test cares about (each test builds fresh
// FederationLink instances so timers/state never leak across tests).
let inboundTargetA = null;
let inboundTargetB = null;

before(async () => {
  if (skip) return;
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-federation-link-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');

  identityA = genIdentity(join(tmpRoot, 'a'), 'instance-a');
  identityB = genIdentity(join(tmpRoot, 'b'), 'instance-b');

  serverA = await listenTls(identityA, (socket) => {
    const info = peerCertInfo(socket);
    if (info && inboundTargetA) inboundTargetA.acceptInbound(socket, info);
  });
  serverB = await listenTls(identityB, (socket) => {
    const info = peerCertInfo(socket);
    if (info && inboundTargetB) inboundTargetB.acceptInbound(socket, info);
  });
});

after(() => {
  if (skip) return;
  try { serverA.close(); } catch { /* ignore */ }
  try { serverB.close(); } catch { /* ignore */ }
  closeDb();
  delete process.env.CCSERVER_DB_PATH;
  delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  rmSync(tmpRoot, { recursive: true, force: true });
});

let linkA;
let linkB;

beforeEach(() => {
  if (skip) return;
  inboundTargetA = null;
  inboundTargetB = null;
  // Each test re-pairs the same two identities from scratch -- clear
  // whatever rows an earlier test (including a revoke) left behind.
  getDb().prepare('DELETE FROM paired_instances').run();
});

afterEach(() => {
  if (skip) return;
  linkA?.close();
  linkB?.close();
  linkA = null;
  linkB = null;
});

test('a link established by only one side dialing carries RPC in BOTH directions', { skip }, async () => {
  const rowForBFromA = approve(pairing.recordOutboundRequest({
    fingerprint: identityB.fingerprint, certPem: identityB.cert, hostnameClaimed: 'b', addr: `127.0.0.1:${serverB.address().port}`,
  }));
  const rowForAFromB = approve(pairing.recordInboundRequest({
    fingerprint: identityA.fingerprint, certPem: identityA.cert, hostnameClaimed: 'a', addr: `127.0.0.1:${serverA.address().port}`,
  }));

  linkA = new FederationLink(rowForBFromA, { selfIdentity: identityA });
  linkB = new FederationLink(rowForAFromB, { selfIdentity: identityB });
  inboundTargetB = linkB; // B never dials -- only accepts A's inbound connection

  linkA.connect();
  await waitFor(() => linkA.connected && linkB.connected);
  assert.equal(linkA.live.isDialer, true);
  assert.equal(linkB.live.isDialer, false);

  // The original one-shot design could only ever have the DIALING side send
  // 'rpc' -- this is the actual regression test for the plan's core ask:
  // the accepting side (B) can now call an RPC on the dialing side (A) too.
  const respFromB = await linkB.rpc('sessions.list', {});
  assert.equal(respFromB.ok, true);
  assert.ok(Array.isArray(respFromB.sessions));

  const respFromA = await linkA.rpc('sessions.list', {});
  assert.equal(respFromA.ok, true);
  assert.ok(Array.isArray(respFromA.sessions));

  // Terminal channel multiplexing: A opens a channel toward B; a plain ping
  // must come back as pong without touching sessionManager (same behavior
  // federationServer.test.js's one-shot version already covered).
  const channel = linkA.openTerminalChannel();
  const pong = await new Promise((resolve) => {
    channel.onMessage(resolve);
    channel.send({ type: 'ping' });
  });
  assert.deepEqual(pong, { type: 'pong' });
  channel.close();
});

test('duplicate simultaneous dials resolve to one link, consistently on both sides', { skip }, async () => {
  const rowForBFromA = approve(pairing.recordOutboundRequest({
    fingerprint: identityB.fingerprint, certPem: identityB.cert, hostnameClaimed: 'b', addr: `127.0.0.1:${serverB.address().port}`,
  }));
  const rowForAFromB = approve(pairing.recordOutboundRequest({
    fingerprint: identityA.fingerprint, certPem: identityA.cert, hostnameClaimed: 'a', addr: `127.0.0.1:${serverA.address().port}`,
  }));

  linkA = new FederationLink(rowForBFromA, { selfIdentity: identityA });
  linkB = new FederationLink(rowForAFromB, { selfIdentity: identityB });
  inboundTargetA = linkA;
  inboundTargetB = linkB;

  // Both sides dial each other at once -- the scenario the plan's duplicate
  // resolution rule exists for.
  linkA.connect();
  linkB.connect();
  await waitFor(() => linkA.connected && linkB.connected);

  const aShouldBeDialer = winningDialerIsSelf(identityA.fingerprint, identityB.fingerprint);
  assert.equal(linkA.live.isDialer, aShouldBeDialer);
  assert.equal(linkB.live.isDialer, !aShouldBeDialer, 'the two sides must agree on the same physical connection');

  // Both directions still function over whichever connection won.
  assert.equal((await linkA.rpc('sessions.list', {})).ok, true);
  assert.equal((await linkB.rpc('sessions.list', {})).ok, true);
});

test('revoking the pair permanently closes the link and stops reconnecting', { skip }, async () => {
  const rowForBFromA = approve(pairing.recordOutboundRequest({
    fingerprint: identityB.fingerprint, certPem: identityB.cert, hostnameClaimed: 'b', addr: `127.0.0.1:${serverB.address().port}`,
  }));
  const rowForAFromB = approve(pairing.recordInboundRequest({
    fingerprint: identityA.fingerprint, certPem: identityA.cert, hostnameClaimed: 'a', addr: `127.0.0.1:${serverA.address().port}`,
  }));

  linkA = new FederationLink(rowForBFromA, { selfIdentity: identityA, revokeCheckIntervalMs: 50 });
  linkB = new FederationLink(rowForAFromB, { selfIdentity: identityB });
  inboundTargetB = linkB;

  linkA.connect();
  await waitFor(() => linkA.connected);

  pairing.revoke(rowForBFromA.id);
  await waitFor(() => linkA.destroyed && !linkA.connected, { timeoutMs: 2000 });

  // Must not come back even after waiting past a normal reconnect window.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(linkA.connected, false);
  assert.equal(linkA.destroyed, true);
});

test('a link survives sitting idle past its own connect timeout (no RPC/terminal traffic)', { skip }, async () => {
  // Regression test: node's `tls.connect({ timeout })` option sets a
  // socket-level IDLE timer that keeps firing for the socket's whole life,
  // not just during the handshake -- dialTls used to leave it armed after
  // connecting, so a link with zero RPC/terminal traffic for
  // connectTimeoutMs would self-destruct and reconnect in a loop even
  // though nothing was actually wrong. connectTimeoutMs is set far below
  // the reconnect backoff's own initial delay so a spurious disconnect
  // would show up here as `linkA.connected === false` well before this test
  // times out.
  const rowForBFromA = approve(pairing.recordOutboundRequest({
    fingerprint: identityB.fingerprint, certPem: identityB.cert, hostnameClaimed: 'b', addr: `127.0.0.1:${serverB.address().port}`,
  }));
  const rowForAFromB = approve(pairing.recordInboundRequest({
    fingerprint: identityA.fingerprint, certPem: identityA.cert, hostnameClaimed: 'a', addr: `127.0.0.1:${serverA.address().port}`,
  }));

  linkA = new FederationLink(rowForBFromA, { selfIdentity: identityA, connectTimeoutMs: 100 });
  linkB = new FederationLink(rowForAFromB, { selfIdentity: identityB });
  inboundTargetB = linkB;

  linkA.connect();
  await waitFor(() => linkA.connected && linkB.connected);

  await new Promise((r) => setTimeout(r, 400)); // 4x connectTimeoutMs, zero traffic

  assert.equal(linkA.connected, true, 'link must not self-destruct from idling past connectTimeoutMs');
  assert.equal(linkB.connected, true);
  assert.equal((await linkA.rpc('sessions.list', {})).ok, true, 'link is still usable after the idle period');
});

test('a dropped connection reconnects automatically via the backoff timer', { skip }, async () => {
  const rowForBFromA = approve(pairing.recordOutboundRequest({
    fingerprint: identityB.fingerprint, certPem: identityB.cert, hostnameClaimed: 'b', addr: `127.0.0.1:${serverB.address().port}`,
  }));
  const rowForAFromB = approve(pairing.recordInboundRequest({
    fingerprint: identityA.fingerprint, certPem: identityA.cert, hostnameClaimed: 'a', addr: `127.0.0.1:${serverA.address().port}`,
  }));

  linkA = new FederationLink(rowForBFromA, { selfIdentity: identityA });
  linkB = new FederationLink(rowForAFromB, { selfIdentity: identityB });
  inboundTargetB = linkB;

  linkA.connect();
  await waitFor(() => linkA.connected && linkB.connected);

  // Simulate a dropped network connection from A's side.
  linkA.live.socket.destroy();
  await waitFor(() => !linkA.connected, { timeoutMs: 1000 });
  await waitFor(() => linkA.connected && linkB.connected, { timeoutMs: 8000 });
  assert.equal((await linkA.rpc('sessions.list', {})).ok, true);
});
