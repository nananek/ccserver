// Integration coverage for the /api/federation/* REST surface, driven
// end-to-end over a real mTLS connection to a real (second) federation
// listener playing "the peer" -- same two-identity technique as
// ws/federationServer.test.js (peer B's TLS server captures its own identity
// at creation time, so swapping CCSERVER_FEDERATION_HOME + resetting the
// module cache afterward only affects THIS process's outbound identity, used
// by the routes under test acting as "instance A"). Skips entirely when
// openssl is unavailable (see federationIdentity.opensslAvailable).
//
// The peer's own decisions (steps a real second instance's browser would
// drive through its own REST layer) are simulated by calling
// federationPairing's DB functions directly against the peer's row -- there
// is no second Fastify app / second browser in this test, only a second real
// TLS listener.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../db.js';
import { federationRoute } from './federation.js';
import * as pairing from '../ws/federationPairing.js';
import { opensslAvailable, _resetIdentityCacheForTests } from '../ws/federationIdentity.js';
import { ensureFederationServer, stopFederationServer, _resetFederationServerForTests } from '../ws/federationServer.js';
import { getLink } from '../ws/federationLink.js';

const skip = !opensslAvailable();
let tmpRoot;
let app;
let peerPort;
const savedHome = process.env.CCSERVER_FEDERATION_HOME;
const savedPort = process.env.CCSERVER_FEDERATION_PORT;

before(async () => {
  if (skip) return;
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-federation-route-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');

  // The peer ("instance B"): a real federation listener with its own identity.
  process.env.CCSERVER_FEDERATION_HOME = join(tmpRoot, 'peer-federation');
  _resetIdentityCacheForTests();
  const peerServer = await ensureFederationServer({ port: 0, log: console });
  peerPort = peerServer.address().port;

  // "Instance A" (the one under test, reached only through app.inject below):
  // its own identity from here on. CCSERVER_FEDERATION_PORT is only read by
  // federationEnabled() as a boolean gate (POST /instances refuses to
  // initiate a pairing when federation is off); A does not need a real
  // listener of its own for this suite, since the peer never needs to dial A
  // back -- see the file header comment.
  process.env.CCSERVER_FEDERATION_HOME = join(tmpRoot, 'self-federation');
  process.env.CCSERVER_FEDERATION_PORT = '1';
  _resetIdentityCacheForTests();

  app = Fastify();
  await app.register(federationRoute, { prefix: '/api' });
});

after(async () => {
  if (skip) return;
  stopFederationServer();
  _resetFederationServerForTests();
  _resetIdentityCacheForTests();
  closeDb();
  delete process.env.CCSERVER_DB_PATH;
  delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  if (savedHome === undefined) delete process.env.CCSERVER_FEDERATION_HOME; else process.env.CCSERVER_FEDERATION_HOME = savedHome;
  if (savedPort === undefined) delete process.env.CCSERVER_FEDERATION_PORT; else process.env.CCSERVER_FEDERATION_PORT = savedPort;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('GET /federation/identity reports the enabled flag and fingerprint', { skip }, async () => {
  const res = await app.inject({ method: 'GET', url: '/api/federation/identity' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.enabled, true);
  assert.match(body.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

test('POST /federation/instances requires remoteAddr', { skip }, async () => {
  const res = await app.inject({ method: 'POST', url: '/api/federation/instances', payload: {} });
  assert.equal(res.statusCode, 400);
});

test('full pairing + proxy lifecycle over the REST surface', { skip }, async () => {
  // 1. Initiate pairing from "A" (the REST layer under test) to the real peer.
  const propose = await app.inject({
    method: 'POST', url: '/api/federation/instances',
    payload: { remoteAddr: `127.0.0.1:${peerPort}`, label: 'my-peer' },
  });
  assert.equal(propose.statusCode, 200);
  const aRow = propose.json().instance;
  // Symmetric model (federationPairing.js): a fresh row always starts
  // pending_local_approval -- the INITIATOR's own human hasn't decided yet
  // either, regardless of who dialed whom.
  assert.equal(aRow.status, 'pending_local_approval');
  assert.equal(aRow.label, 'my-peer');

  // Regression: initiatePairing's one-shot bootstrap dial becomes this
  // pair's persistent FederationLink (federationClient.js's initiatePairing
  // -> adoptBootstrapSocket), reusing the very socket that carried the
  // propose/response exchange. That socket was opened with tls.connect's
  // `timeout` option armed (fine for a one-shot RPC bounded by its own
  // response wait) -- if initiatePairing forgot to disable it before
  // handing the socket off, Node would destroy this link out from under it
  // ~10s after the last byte flows, well within how long a healthy,
  // barely-used link is expected to sit idle. `socket.timeout` reads back
  // the currently armed value directly, so this catches it without an
  // actual 10s wait.
  const bootstrapLink = getLink(aRow.fingerprint);
  assert.equal(bootstrapLink?.connected, true, 'sanity: initiatePairing promoted its socket into a live link');
  assert.equal(bootstrapLink.live.socket.timeout, 0, 'the promoted bootstrap socket\'s idle timeout must be disabled');

  // It shows up in GET /pending too (reconciled, but neither side has
  // decided yet so it stays pending).
  const pendingList = (await app.inject({ method: 'GET', url: '/api/federation/pending' })).json().pending;
  assert.ok(pendingList.some((r) => r.id === aRow.id));

  // 2. Simulate the peer's own human fully approving (no second REST layer
  // in this test -- see the file header comment).
  const peerRow = pairing.getInstanceByFingerprint(
    (await app.inject({ method: 'GET', url: '/api/federation/identity' })).json().fingerprint,
  );
  assert.ok(peerRow, 'the peer recorded an inbound row keyed by A\'s fingerprint');
  pairing.recordLocalDecision(peerRow.id, 'approved');
  pairing.recordRemoteDecision(peerRow.id, 'approved');
  assert.equal(pairing.getInstance(peerRow.id).status, 'active');

  // 3. A's human approves via the REST decide endpoint. The route
  // reconciles inline, so this should already come back 'active'.
  const decide = await app.inject({
    method: 'POST', url: `/api/federation/pending/${aRow.id}/decide`,
    payload: { decision: 'approved' },
  });
  assert.equal(decide.statusCode, 200);
  assert.equal(decide.json().instance.status, 'active');

  const listed = (await app.inject({ method: 'GET', url: '/api/federation/instances' })).json().instances;
  assert.ok(listed.find((r) => r.id === aRow.id && r.status === 'active'));

  // 4. Proxy endpoints now succeed against the real peer.
  const sessions = await app.inject({ method: 'GET', url: `/api/federation/instances/${aRow.id}/sessions` });
  assert.equal(sessions.statusCode, 200);
  assert.deepEqual(sessions.json(), { sessions: [] });

  const groups = await app.inject({ method: 'GET', url: `/api/federation/instances/${aRow.id}/groups` });
  assert.equal(groups.statusCode, 200);
  assert.deepEqual(groups.json(), { groups: [] });

  const dirs = await app.inject({ method: 'GET', url: `/api/federation/instances/${aRow.id}/dirs?path=/` });
  assert.equal(dirs.statusCode, 200);
  assert.equal(dirs.json().current, '/');

  // Rejecting a launch with a bad body still comes back as a proxied error,
  // not a crash.
  const badLaunch = await app.inject({ method: 'POST', url: `/api/federation/instances/${aRow.id}/sessions`, payload: {} });
  assert.equal(badLaunch.statusCode, 502);

  // 5. Rename via PATCH.
  const patch = await app.inject({ method: 'PATCH', url: `/api/federation/instances/${aRow.id}`, payload: { label: 'renamed' } });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().instance.label, 'renamed');

  // 6. Revoke, then every proxy call is refused locally (404) without even
  // dialing the peer.
  assert.ok(getLink(aRow.fingerprint)?.connected, 'sanity: step 4 above left a live FederationLink to the peer');

  const revoke = await app.inject({ method: 'DELETE', url: `/api/federation/instances/${aRow.id}` });
  assert.equal(revoke.statusCode, 200);
  assert.equal(revoke.json().instance.status, 'revoked');

  // Regression: revoking must also drop the peer's FederationLink right
  // away (see routes/federation.js's DELETE handler) rather than leaving it
  // registered to keep retrying/idling until its own 30s revoke-check timer
  // (or, for a link that never made it live, forever).
  assert.equal(getLink(aRow.fingerprint), null, 'revoke must remove the peer\'s FederationLink from the registry');

  const afterRevoke = await app.inject({ method: 'GET', url: `/api/federation/instances/${aRow.id}/sessions` });
  assert.equal(afterRevoke.statusCode, 404);
});

test('POST /pending/:id/decide validates the decision and unknown ids', { skip }, async () => {
  const bad = await app.inject({ method: 'POST', url: '/api/federation/pending/none/decide', payload: { decision: 'maybe' } });
  assert.equal(bad.statusCode, 400);

  const notFound = await app.inject({ method: 'POST', url: '/api/federation/pending/does-not-exist/decide', payload: { decision: 'approved' } });
  assert.equal(notFound.statusCode, 404);
});

test('proxy routes 404 for an instance id that was never paired', { skip }, async () => {
  const res = await app.inject({ method: 'GET', url: '/api/federation/instances/nope/sessions' });
  assert.equal(res.statusCode, 404);
});
