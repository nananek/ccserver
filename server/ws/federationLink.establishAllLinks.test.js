// Issue #142 Step 3: establishAllLinks() -- the boot-time sweep
// (server/index.js calls this once, right after ensureFederationServer()
// brings the inbound mTLS listener up) that kicks every still-relevant
// pair's FederationLink into dialing immediately, closing the gap where a
// pair sitting untouched in paired_instances since the last restart would
// otherwise never get a connect() call until some RPC/reconcile happened to
// touch it (federationClient.js's getReadyLink/reconcilePending/
// callInstanceRpc).
//
// establishAllLinks() calls the REAL federationIdentity.js singleton
// (ensureIdentity()) for "self", exactly like its one real call site in
// server/index.js -- so this file's harness follows federationServer.test.js's
// pattern (a real self identity via that singleton, a second fully
// independent openssl-generated identity playing "the peer") rather than
// federationLink.test.js's two-arbitrary-identities harness, which never
// touches that singleton at all.
//
// A genuine two-real-process one-directional-reachability scenario (Issue
// #142's core motivating case: A can dial B but not vice versa) is Step 4's
// job per the issue text ("新規の双方向到達性/一方向到達性シナリオのテスト追加") --
// it needs two actually-separate processes/identity singletons to be a real
// test rather than a simulation. What IS in scope here, and what actually
// changes user-observable behavior, is the boot-time trigger itself: a pair
// gets dialed the moment establishAllLinks() runs, with no RPC/reconcile call
// involved at all.

import {
  test, before, after, beforeEach, afterEach,
} from 'node:test';
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
import {
  opensslAvailable, _resetIdentityCacheForTests, ensureIdentity, peerCertInfo,
} from './federationIdentity.js';
import {
  FederationLink, establishAllLinks, getLink, _resetLinksForTests,
} from './federationLink.js';

const skip = !opensslAvailable();
let tmpRoot;
const savedHome = process.env.CCSERVER_FEDERATION_HOME;

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

function approve(row) {
  pairing.recordLocalDecision(row.id, 'approved');
  pairing.recordRemoteDecision(row.id, 'approved');
  return pairing.getInstance(row.id);
}

let self;
let peerIdentity;
let peerServer;
// The peer's own FederationLink, representing ITS view of "us" -- accepts
// whatever we dial into peerServer. Reassigned per test since each test
// wants its own row/fingerprint bookkeeping.
let peerLink = null;

before(async () => {
  if (skip) return;
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-establish-all-links-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
  process.env.CCSERVER_FEDERATION_HOME = join(tmpRoot, 'self-federation');
  _resetIdentityCacheForTests();
  self = await ensureIdentity();

  peerIdentity = genIdentity(join(tmpRoot, 'peer'), 'peer');
  peerServer = await listenTls(peerIdentity, (socket) => {
    const info = peerCertInfo(socket);
    if (info && peerLink) peerLink.acceptInbound(socket, info);
  });
});

after(() => {
  if (skip) return;
  try { peerServer.close(); } catch { /* ignore */ }
  _resetIdentityCacheForTests();
  closeDb();
  delete process.env.CCSERVER_DB_PATH;
  delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  if (savedHome === undefined) delete process.env.CCSERVER_FEDERATION_HOME; else process.env.CCSERVER_FEDERATION_HOME = savedHome;
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  if (skip) return;
  getDb().prepare('DELETE FROM paired_instances').run();
  _resetLinksForTests();
  peerLink = null;
});

afterEach(() => {
  if (skip) return;
  // _resetLinksForTests() only tears down links registered through
  // getOrCreateLink() (the ones establishAllLinks() creates on OUR side) --
  // peerLink is a raw FederationLink built directly in each test and must be
  // closed here too, or its reconnect-backoff/revoke-check timers keep the
  // process (and this whole file's test run) alive past the last test.
  peerLink?.close();
  _resetLinksForTests();
});

test('establishAllLinks() dials an active pair immediately at "boot", with no RPC/reconcile call ever made', { skip }, async () => {
  const row = approve(pairing.recordOutboundRequest({
    fingerprint: peerIdentity.fingerprint,
    certPem: peerIdentity.cert,
    hostnameClaimed: 'peer',
    addr: `127.0.0.1:${peerServer.address().port}`,
  }));
  assert.equal(row.status, 'active');

  // The peer's side of the link, ready to accept our dial -- note this test
  // never calls federationClient.js's reconcilePending/callInstanceRpc/
  // getReadyLink, nor FederationLink#connect() directly: establishAllLinks()
  // is the ONLY thing that should cause a dial here. The placeholder id is
  // fine: it's only consulted by the (30s-interval) revoke-check timer,
  // well past this test's lifetime.
  peerLink = new FederationLink({ id: 'peer-side-row', fingerprint: self.fingerprint }, { selfIdentity: peerIdentity });

  const count = await establishAllLinks({ log: console });
  // Exactly the one row created above -- establishAllLinks() takes its
  // listInstances() snapshot right here, before the peer-side bookkeeping
  // row below exists, so that row (needed only for the RPC authorization
  // check further down) can never be double-counted as one of OUR pairs.
  assert.equal(count, 1, 'the one active row should be counted');

  const link = getLink(peerIdentity.fingerprint);
  assert.ok(link, 'establishAllLinks() must register a FederationLink for the active pair');
  await waitFor(() => link.connected && peerLink.connected);
  assert.equal(link.live.isDialer, true, 'our side dialed out -- establishAllLinks() calls connect(), never acceptInbound()');

  // The peer's own view of self (same shared test DB -- see this file's
  // header comment), added only now: _handleIncomingRpc re-fetches by
  // fingerprint fresh on every RPC, so the peer's end needs this to
  // authorize the sessions.list call below.
  approve(pairing.recordOutboundRequest({
    fingerprint: self.fingerprint, certPem: self.cert, hostnameClaimed: 'self-under-test', addr: 'unused:0',
  }));

  const resp = await link.rpc('sessions.list', {});
  assert.equal(resp.ok, true, 'the link established purely by establishAllLinks() must be a real, usable link');
});

test('establishAllLinks() also connects pending pairs (needed to ever learn the peer\'s decision), but skips revoked/expired/rejected ones', { skip }, async () => {
  const pendingLocal = pairing.recordOutboundRequest({
    fingerprint: peerIdentity.fingerprint,
    certPem: peerIdentity.cert,
    hostnameClaimed: 'peer',
    addr: `127.0.0.1:${peerServer.address().port}`,
  });
  assert.equal(pendingLocal.status, 'pending_local_approval');

  // Three terminal-state rows, each with its own distinct (bogus, unreachable)
  // fingerprint/addr -- their whole point is that establishAllLinks() must
  // never even attempt to register a link for them, so reachability doesn't
  // matter here.
  const revokedRow = pairing.recordOutboundRequest({
    fingerprint: 'aa'.repeat(32), certPem: 'n/a', hostnameClaimed: 'gone', addr: '127.0.0.1:1',
  });
  pairing.revoke(revokedRow.id);

  const rejectedRow = pairing.recordOutboundRequest({
    fingerprint: 'bb'.repeat(32), certPem: 'n/a', hostnameClaimed: 'no', addr: '127.0.0.1:1',
  });
  pairing.recordLocalDecision(rejectedRow.id, 'rejected');
  assert.equal(pairing.getInstance(rejectedRow.id).status, 'rejected');

  const expiredRow = pairing.recordOutboundRequest({
    fingerprint: 'cc'.repeat(32), certPem: 'n/a', hostnameClaimed: 'stale', addr: '127.0.0.1:1',
  });
  getDb().prepare("UPDATE paired_instances SET status = 'expired' WHERE id = ?").run(expiredRow.id);

  // No RPC call happens in this test, so (unlike the previous test) the
  // peer side never needs a real DB-backed row of its own -- a placeholder
  // fingerprint-only row is enough for the link-hello handshake, and
  // (crucially) adding it here rather than through pairing.recordOutboundRequest
  // avoids polluting the very listInstances() snapshot this test is
  // asserting about.
  peerLink = new FederationLink({ id: 'peer-side-row', fingerprint: self.fingerprint }, { selfIdentity: peerIdentity });

  const count = await establishAllLinks({ log: console });
  assert.equal(count, 1, 'only the pending row is a candidate -- the three terminal-state rows must be filtered out');

  assert.ok(getLink(peerIdentity.fingerprint), 'the pending pair must get a registered link (reachability is how its remote_decision is ever learned)');
  assert.equal(getLink('aa'.repeat(32)), null, 'revoked pair must not get a link');
  assert.equal(getLink('bb'.repeat(32)), null, 'rejected pair must not get a link');
  assert.equal(getLink('cc'.repeat(32)), null, 'expired pair must not get a link');

  await waitFor(() => getLink(peerIdentity.fingerprint).connected);
});

test('establishAllLinks() resolves immediately even when a pair is unreachable (fire-and-forget, never delays boot)', { skip }, async () => {
  // A private, non-routable address: TCP connect attempts to it black-hole
  // rather than refusing instantly, so a synchronous/awaited dial would sit
  // for the full connectTimeoutMs (10s default). establishAllLinks() itself
  // must not wait for that -- connect() only starts the dial and returns.
  pairing.recordOutboundRequest({
    fingerprint: 'dd'.repeat(32), certPem: 'n/a', hostnameClaimed: 'unreachable', addr: '10.255.255.1:9',
  });

  const startedAt = Date.now();
  await establishAllLinks({ log: console });
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 1000, `establishAllLinks() must not block on an unreachable pair's dial (took ${elapsedMs}ms)`);
});
