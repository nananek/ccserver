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
import { createServer as createTlsServer, connect as tlsConnect } from 'node:tls';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, readFileSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { closeDb, getDb } from '../db.js';
import { resetLayoutCache } from '../paths.js';
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

// Issue #201: the setup gate has to cover the federation surface as well.
// index.js gates HTTP writes and terminal.js gates the WS `init` /
// `schedule_prompt` messages, but a paired peer talks neither -- the
// federation listener is its own TLS port and never sees fastify's onRequest
// hook. Without this, a peer could create sessions, groups and worktrees on
// an un-migrated host, writing saved-sessions.json / saved-groups.json to
// the very paths the operator was about to migrate (attack-test-201 F2,
// through a third door).
test('★ #201: the CREATING federation RPCs are refused while setup is incomplete', async () => {
  const savedLayout = process.env.CCSERVER_LAYOUT;
  process.env.CCSERVER_LAYOUT = 'legacy';
  resetLayoutCache();
  try {
    for (const method of ['sessions.create', 'groups.create']) {
      // No ctx and no deps on purpose: the refusal has to land BEFORE
      // loadRouteDeps(), so it works on a host whose DB is still at the old
      // path and cannot be opened yet.
      const res = await RPC_METHODS[method]({}, undefined);
      assert.equal(res.ok, false, method);
      assert.equal(res.code, 'SETUP_REQUIRED', method);
      assert.match(res.error, /npm run setup/);
    }
  } finally {
    if (savedLayout === undefined) delete process.env.CCSERVER_LAYOUT;
    else process.env.CCSERVER_LAYOUT = savedLayout;
    resetLayoutCache();
  }
});

test('#201: only the creating RPCs are gated -- reads and destroys are not', async () => {
  // Gating the read/destroy side would cut a peer off from the sessions
  // already running on the host, which is the 12h-timeout outage rev2's R2
  // warns about. Neither can put new state at a path the wizard is about to
  // move: destroy only removes.
  const savedLayout = process.env.CCSERVER_LAYOUT;
  process.env.CCSERVER_LAYOUT = 'legacy';
  resetLayoutCache();
  try {
    const list = await RPC_METHODS['sessions.list']({}, undefined);
    assert.equal(list.ok, true);
    assert.notEqual(list.code, 'SETUP_REQUIRED');
    const destroy = await RPC_METHODS['sessions.destroy']({ id: 'no-such-session' }, undefined);
    assert.notEqual(destroy.code, 'SETUP_REQUIRED');
  } finally {
    if (savedLayout === undefined) delete process.env.CCSERVER_LAYOUT;
    else process.env.CCSERVER_LAYOUT = savedLayout;
    resetLayoutCache();
  }
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

// `describe` is only called on the timeout path, so a wait that never comes
// true still says what it was looking at instead of just 'timed out'.
function waitFor(fn, { timeoutMs = 5000, intervalMs = 20, describe = null } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok;
      try { ok = fn(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) {
        let detail = '';
        if (describe) {
          try { detail = ` -- ${describe()}`; } catch (e) { detail = ` -- describe() threw: ${e.message}`; }
        }
        return reject(new Error(`timed out waiting for condition${detail}`));
      }
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
// Every socket each side's listener accepted, in arrival order. A link's own
// dialed socket lives inside FederationLink, but its FAR end is one of these,
// so between them these two lists name both physical connections of a
// simultaneous double dial -- which is what lets a test reach into one end of a
// connection the link under test is holding the other end of.
let acceptedByA = [];
let acceptedByB = [];
// Withholds one side's acceptInbound until the test releases it. acceptInbound
// is what sends that side's link-hello, and the PEER only resolves its
// candidate for that connection once the hello lands -- so holding it parks the
// peer with an unresolved candidate for as long as the test wants. A release,
// not a timer: the point is to remove timing from the setup, not to bet on it.
let inboundHoldA = false;
let inboundHoldB = false;
let heldAcceptsA = [];
let heldAcceptsB = [];
// The sockets currently sitting in those queues. A held socket has not been
// handed to a link, so no link can own it -- if a test fails before releasing,
// only the harness can close it. Deliberately just the held ones: sockets a
// link HAS taken are the link's to clean up, and covering for it here is what
// would hide issue #246.
let heldSockets = [];

function acceptInto(target, accepted, held, hold, socket, info) {
  accepted.push(socket);
  if (hold) {
    heldSockets.push(socket);
    held.push(() => { if (!socket.destroyed) target.acceptInbound(socket, info); });
    return;
  }
  target.acceptInbound(socket, info);
}

function releaseHeldAccepts() {
  inboundHoldA = false;
  inboundHoldB = false;
  const pending = [...heldAcceptsA, ...heldAcceptsB];
  heldAcceptsA = [];
  heldAcceptsB = [];
  heldSockets = [];
  for (const deliver of pending) deliver();
  return pending.length;
}

before(async () => {
  if (skip) return;
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-federation-link-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');

  identityA = genIdentity(join(tmpRoot, 'a'), 'instance-a');
  identityB = genIdentity(join(tmpRoot, 'b'), 'instance-b');

  serverA = await listenTls(identityA, (socket) => {
    const info = peerCertInfo(socket);
    if (info && inboundTargetA) acceptInto(inboundTargetA, acceptedByA, heldAcceptsA, inboundHoldA, socket, info);
  });
  serverB = await listenTls(identityB, (socket) => {
    const info = peerCertInfo(socket);
    if (info && inboundTargetB) acceptInto(inboundTargetB, acceptedByB, heldAcceptsB, inboundHoldB, socket, info);
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
  acceptedByA = [];
  acceptedByB = [];
  inboundHoldA = false;
  inboundHoldB = false;
  heldAcceptsA = [];
  heldAcceptsB = [];
  heldSockets = [];
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
  // Only the ones still held (see heldSockets): no link ever took these, so
  // nothing else can close them.
  for (const sock of heldSockets) {
    try { sock.destroy(); } catch { /* already gone */ }
  }
  heldSockets = [];
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

// ---------------------------------------------------------------------
// Issues #246 / #247: what a link folds when it loses a connection.
//
// Three paths take a connection away: close(), the body of _onSocketClose, and
// _resolveCandidate's supersede branch. They did not agree on what to fold --
// pendingRpc and the open channels were folded by the first two only, and the
// sockets of candidates that have not resolved yet were folded by none of them
// (they were not recorded anywhere). Both issues are that disagreement seen
// from two sides, so these tests pin the shared teardown on ALL THREE paths
// rather than only on the two that were reported.

// Parks both links with the losing connection adopted and the winning one's
// hello still in flight -- the middle of a double dial, held open with no timer.
// Returns the release fn plus which side is the preferring dialer.
async function parkMidDuplicateDial() {
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

  const aShouldBeDialer = winningDialerIsSelf(identityA.fingerprint, identityB.fingerprint);
  if (aShouldBeDialer) inboundHoldB = true; else inboundHoldA = true;
  linkA.connect();
  linkB.connect();
  await waitFor(
    () => linkA.live?.isDialer === !aShouldBeDialer && linkB.live?.isDialer === aShouldBeDialer,
    { timeoutMs: 5000 },
  );
  return { aShouldBeDialer };
}

test('#246 close() destroys a candidate socket that has not resolved yet', { skip }, async () => {
  // A candidate is unresolved until the PEER's link-hello arrives on it, so the
  // simplest way to hold one there is a peer that connects, is accepted, and
  // then says nothing. No double dial needed: this is the plain shape of the
  // bug, and the socket in question is the one our own listener accepted, so
  // the test can see it without reaching inside the link.
  const row = approve(pairing.recordInboundRequest({
    fingerprint: identityB.fingerprint, certPem: identityB.cert, hostnameClaimed: 'b', addr: `127.0.0.1:${serverB.address().port}`,
  }));
  linkA = new FederationLink(row, { selfIdentity: identityA });
  inboundTargetA = linkA;

  const mute = await new Promise((resolve) => {
    const sock = tlsConnect({
      host: '127.0.0.1', port: serverA.address().port,
      key: identityB.key, cert: identityB.cert, rejectUnauthorized: false,
    }, () => resolve(sock));
  });
  try {
    // acceptInbound has started a candidate on linkA and written OUR hello;
    // `mute` never answers, so that candidate never resolves.
    await waitFor(() => acceptedByA.length === 1);
    const unresolvedEnd = acceptedByA[0];
    assert.equal(linkA.connected, false, 'the candidate must not have been adopted -- nothing resolved it');
    assert.equal(unresolvedEnd.destroyed, false, 'precondition: the unresolved candidate socket is open');

    linkA.close();

    await waitFor(() => unresolvedEnd.destroyed, {
      timeoutMs: 3000,
      describe: () => `close() left the unresolved candidate socket open (destroyed=${unresolvedEnd.destroyed}); nothing else owns it, so it stays in the host process`,
    });
  } finally {
    try { mute.destroy(); } catch { /* already gone */ }
  }
});

test('#247 a superseded connection folds the RPC that was riding on it', { skip }, async () => {
  const { aShouldBeDialer } = await parkMidDuplicateDial();
  // The preferring dialer is the side that supersedes: the winning connection
  // is the one IT dialed, so its own candidate for it is the one that wins.
  const superseding = aShouldBeDialer ? linkA : linkB;
  // Its live (losing) connection is the end ITS OWN listener accepted...
  const ownLosingEnd = (aShouldBeDialer ? acceptedByA : acceptedByB).at(-1);
  // ...and the winning connection's far end sits on the peer's listener.
  const peerWinningEnd = (aShouldBeDialer ? acceptedByB : acceptedByA).at(-1);
  // Say so rather than assume it: if this bookkeeping is wrong the test would
  // otherwise quietly stop being about anything.
  assert.equal(ownLosingEnd, superseding.live.socket, 'the socket we are about to pause must be the live (losing) one');

  // Stop OUR side reading on the losing connection, so the reply to the RPC
  // below can never land and the request stays outstanding.
  ownLosingEnd.pause();
  const inflight = superseding.rpc('sessions.list', {}, { timeoutMs: 15_000 });
  const settled = inflight.then(() => 'resolved', (e) => `rejected: ${e.message}`);
  assert.equal(superseding.pendingRpc.size, 1, 'precondition: the RPC is outstanding on the losing connection');

  // Release the held accept (which WRITES the peer's hello on the winning
  // connection) and immediately stop the peer from READING on it. The peer can
  // therefore not resolve the winner, so it will not discard the loser, so its
  // close cannot reach us first -- which pins the order to "we resolve first",
  // the ordering in which the discard branch is the only thing that could fold
  // this RPC. The other order is already handled by _onSocketClose and is not
  // what this test is about.
  releaseHeldAccepts();
  peerWinningEnd.pause();

  const outcome = await Promise.race([
    settled,
    new Promise((resolve) => setTimeout(() => resolve('STILL PENDING'), 4000)),
  ]);
  assert.notEqual(outcome, 'STILL PENDING', 'the RPC on the discarded connection was never folded -- it would have sat until its own 15s timeout');
  // Named for the path that folded it, so this cannot pass by way of the close
  // handler doing the work instead.
  assert.match(outcome, /^rejected: federation link superseded/, 'the supersede branch is what must fold it');
  assert.equal(superseding.pendingRpc.size, 0, 'and pendingRpc must be left empty');
});

test('#247 all three teardown paths fold an outstanding RPC', { skip }, async () => {
  // The factoring is the point: one shared teardown, reached from every path
  // that takes a connection away. A path that skips it is exactly the bug.
  const rowForBFromA = approve(pairing.recordOutboundRequest({
    fingerprint: identityB.fingerprint, certPem: identityB.cert, hostnameClaimed: 'b', addr: `127.0.0.1:${serverB.address().port}`,
  }));
  const rowForAFromB = approve(pairing.recordInboundRequest({
    fingerprint: identityA.fingerprint, certPem: identityA.cert, hostnameClaimed: 'a', addr: `127.0.0.1:${serverA.address().port}`,
  }));

  // Path 1: close(). One-sided dial, so there is exactly one connection.
  linkA = new FederationLink(rowForBFromA, { selfIdentity: identityA });
  linkB = new FederationLink(rowForAFromB, { selfIdentity: identityB });
  inboundTargetB = linkB;
  linkA.connect();
  await waitFor(() => linkA.connected && linkB.connected);
  acceptedByB.at(-1).pause();
  let settled = linkA.rpc('sessions.list', {}, { timeoutMs: 15_000 }).then(() => 'resolved', (e) => `rejected: ${e.message}`);
  assert.equal(linkA.pendingRpc.size, 1);
  linkA.close();
  assert.match(await settled, /^rejected: federation link closed/, 'close() must fold the outstanding RPC');
  assert.equal(linkA.pendingRpc.size, 0, 'close() must leave pendingRpc empty');
  linkB.close(); // this pair is finished with; afterEach only knows the last one

  // Path 2: the body of _onSocketClose -- the peer drops the live connection.
  linkA = new FederationLink(rowForBFromA, { selfIdentity: identityA });
  linkB = new FederationLink(rowForAFromB, { selfIdentity: identityB });
  inboundTargetB = linkB;
  linkA.connect();
  await waitFor(() => linkA.connected && linkB.connected);
  const peerEnd = acceptedByB.at(-1);
  peerEnd.pause();
  settled = linkA.rpc('sessions.list', {}, { timeoutMs: 15_000 }).then(() => 'resolved', (e) => `rejected: ${e.message}`);
  assert.equal(linkA.pendingRpc.size, 1);
  peerEnd.destroy();
  assert.match(await settled, /^rejected: federation link closed/, 'a dropped live connection must fold the outstanding RPC');
  await waitFor(() => linkA.pendingRpc.size === 0);
  linkA.close();
  linkB.close();

  // Path 3 is the supersede branch, covered by the test above -- it needs the
  // held double dial, which cannot coexist with the one-sided setup here.
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
