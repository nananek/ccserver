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

// `describe` is what keeps a wait from swallowing the diagnosis: a condition
// that never comes true otherwise reports nothing but 'timed out', which is
// exactly the failure mode that makes a waited-for state hard to debug. It is
// only called on the timeout path.
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
// so these two lists between them name both physical connections of a
// simultaneous double-dial -- which is what lets a test see that one of them
// has been dropped (see the duplicate-dial test).
let acceptedByA = [];
let acceptedByB = [];
// Withholds one side's acceptInbound until the test says so. acceptInbound is
// what sends that side's link-hello on the connection, and the PEER only
// resolves its candidate for that connection once the hello lands -- so
// holding it keeps the peer's second candidate pending for as long as the test
// wants. A release, not a delay: a timer would just re-introduce the race the
// test exists to remove. Off by default, and the un-held path is unchanged, so
// no other test's timing moves.
let inboundHoldA = false;
let inboundHoldB = false;
let heldAcceptsA = [];
let heldAcceptsB = [];

function acceptInto(target, accepted, held, hold, socket, info) {
  accepted.push(socket);
  if (hold) {
    held.push(() => { if (!socket.destroyed) target.acceptInbound(socket, info); });
    return;
  }
  target.acceptInbound(socket, info);
}

// Delivers everything held back so far, and stops holding.
function releaseHeldAccepts() {
  inboundHoldA = false;
  inboundHoldB = false;
  const pending = [...heldAcceptsA, ...heldAcceptsB];
  heldAcceptsA = [];
  heldAcceptsB = [];
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
  // close() only tears down the link's LIVE connection. A duplicate dial that
  // has not finished resolving still has a second candidate socket open, and an
  // accepted-but-never-adopted socket keeps the event loop alive -- so a test
  // that fails mid-resolution would hang the whole file instead of reporting
  // its assertion. Drop everything the listeners handed out.
  for (const sock of [...acceptedByA, ...acceptedByB]) {
    try { sock.destroy(); } catch { /* already gone */ }
  }
  acceptedByA = [];
  acceptedByB = [];
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

// Issue #237: `connected` is `!!this.live`, and _resolveCandidate adopts the
// FIRST candidate unconditionally, swapping to the winner only when the second
// one arrives. So `connected && connected` is true while a side may still be
// holding the loser, and asserting right after it reads a state that has not
// settled -- intermittently, because under load the two candidates' arrivals
// spread apart. This waits for the resolution to be OVER instead.
//
// The signal: a double dial creates exactly two physical connections, and
// settling destroys one of them. So this waits for both sides to be
// `connected` with exactly one of the two accepted sockets destroyed.
//
// Be clear about what that does NOT prove. Each of these lists holds ONE END
// of a connection -- the end our listener accepted. Destroying that end says
// nothing about the far end, which lives inside the peer's FederationLink: a
// side that has not yet seen the close can still be `connected` while holding
// its own end of the SAME losing connection. So "nobody holds the destroyed
// socket" is true and "both sides are on the survivor" does not follow from
// it. The condition is not logically closed, and a review built the
// counterexample: hold the winner's accepting side in "sends its hello but
// never reads" (pause() right after acceptInbound) and this wait goes true
// 20/20 with both sides reading as the dialer -- i.e. sitting on two DIFFERENT
// connections, exactly what the assertion's own message is about.
//
// What does hold it shut in a natural run is causal order, not logic. The
// preferring dialer cannot resolve the winning connection until the peer's
// hello arrives on it, and the peer sends that hello when it accepts -- by
// which point it has a framer up, and OUR hello was written before that. So
// the peer resolves the winning connection BEFORE we do, and is already off
// the loser by the time we supersede and destroy it. Measured: no false
// positive in 200 idle runs plus 300 under 16 CPU burners on 8 cores, polled
// densely with setImmediate. Nothing reaches this state without being
// constructed.
//
// So: a large reduction of the original window (which needed only "the second
// candidate has not arrived at EITHER side"), not an airtight one.
//
// It does fail safe if misapplied: anything that is not a double dial leaves
// `accepted` below 2, so this never goes true for a one-sided dial -- it times
// out (with `describe`) rather than quietly passing.
//
// Deliberately NOT the assertion's own condition: this says "resolution
// finished", the assertions say "it finished the way the fingerprint rule
// requires". A real regression in the rule still settles, so it still fails as
// an assertion with actual/expected -- not as a bare timeout. And whenever the
// condition is simply never met, the wait times out with `describe` reporting
// the observed state rather than just the word 'timeout'. (Which states leave
// it unmet is exactly what the paragraph above says is not proven, so that is
// the claim here, not a stronger one.)
function duplicateDialState() {
  const both = [...acceptedByA, ...acceptedByB];
  return {
    accepted: both.length,
    dropped: both.filter((sock) => sock.destroyed).length,
    aConnected: linkA.connected,
    bConnected: linkB.connected,
    aIsDialer: linkA.live?.isDialer ?? null,
    bIsDialer: linkB.live?.isDialer ?? null,
  };
}

function waitForDuplicateDialToSettle(opts = {}) {
  return waitFor(() => {
    const st = duplicateDialState();
    return st.aConnected && st.bConnected && st.accepted === 2 && st.dropped === 1;
  }, {
    describe: () => `duplicate dial never settled: ${JSON.stringify(duplicateDialState())}`,
    ...opts,
  });
}

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
  await waitForDuplicateDialToSettle();

  const aShouldBeDialer = winningDialerIsSelf(identityA.fingerprint, identityB.fingerprint);
  assert.equal(linkA.live.isDialer, aShouldBeDialer);
  assert.equal(linkB.live.isDialer, !aShouldBeDialer, 'the two sides must agree on the same physical connection');

  // Both directions still function over whichever connection won.
  assert.equal((await linkA.rpc('sessions.list', {})).ok, true);
  assert.equal((await linkB.rpc('sessions.list', {})).ok, true);
});

// The red for #237, made deterministic. The original failure needed the full
// suite's scheduling pressure to spread the two candidates' arrivals apart;
// here the winning connection's link-hello is simply withheld, so the
// unsettled state is entered on purpose and held open with no timer involved.
//
// Against the old `connected && connected` wait this test fails on the first
// orientation assertion -- the same assertion issue #237 reported. Not the same
// value direction: `aShouldBeDialer` comes from freshly generated fingerprints
// each run, so which way the comparison reads varies per run (5 runs gave 4
// one way, 1 the other). Against the settled wait it passes.
test('#237 duplicate dials: a late winning candidate is waited out, not asserted through', { skip }, async () => {
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
  // Hold the accept on whichever listener the WINNING dialer connects to. Its
  // hello is then the one in flight, so both sides adopt the losing connection
  // first and sit there: connected, and holding the wrong one.
  if (aShouldBeDialer) inboundHoldB = true; else inboundHoldA = true;

  linkA.connect();
  linkB.connect();

  // The state #237 asserted in. Waiting FOR it (rather than assuming it is
  // already there) keeps the setup itself off the clock -- a slow handshake
  // delays this line instead of breaking the test.
  await waitFor(
    () => linkA.live?.isDialer === !aShouldBeDialer && linkB.live?.isDialer === aShouldBeDialer,
    { describe: () => `never reached the unsettled state: ${JSON.stringify(duplicateDialState())}` },
  );
  assert.equal(linkA.connected, true, 'both sides read as connected here -- that is the whole problem');
  assert.equal(linkB.connected, true);
  assert.equal(duplicateDialState().dropped, 0, 'nothing has been dropped yet: resolution has not run');

  // Let the winning hello through; now resolution can finish.
  assert.equal(releaseHeldAccepts(), 1, 'exactly the winning dialer\'s connection was held');
  await waitForDuplicateDialToSettle();

  assert.equal(linkA.live.isDialer, aShouldBeDialer);
  assert.equal(linkB.live.isDialer, !aShouldBeDialer, 'the two sides must agree on the same physical connection');
  assert.equal((await linkA.rpc('sessions.list', {})).ok, true, 'the surviving connection is the usable one');
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
