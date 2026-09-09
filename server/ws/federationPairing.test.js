// Pure DB/state-machine coverage for the bidirectional pairing model (see
// federationPairing.js's header comment). No networking, no TLS -- every
// scenario here is driven directly through the module's exported functions,
// the same way federationServer.js / federationClient.js / routes/federation.js
// do.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../db.js';
import * as pairing from './federationPairing.js';

let tmpRoot;
const savedHomeRoot = process.env.CCSERVER_SANDBOX_HOME_ROOT;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-federation-pairing-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
});

after(() => {
  closeDb();
  delete process.env.CCSERVER_DB_PATH;
  if (savedHomeRoot === undefined) delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  else process.env.CCSERVER_SANDBOX_HOME_ROOT = savedHomeRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // Isolate every test from the others' rows -- cheaper than a fresh tmp DB
  // per test, and paired_instances has no FK dependents to worry about.
  getDb().exec('DELETE FROM paired_instances');
});

test('a fresh inbound request creates a pending_local_approval row with both decisions unset', () => {
  const row = pairing.recordInboundRequest({
    fingerprint: 'FP:B', certPem: 'PEM-B', hostnameClaimed: 'host-a', addr: '10.0.0.1:3210',
  });
  assert.equal(row.status, 'pending_local_approval');
  assert.equal(row.localDecision, null);
  assert.equal(row.remoteDecision, null);
  assert.equal(row.direction, 'inbound_initiated');
});

test('activation requires BOTH local and remote decisions to be approved, in either order', () => {
  const row = pairing.recordInboundRequest({ fingerprint: 'FP:C', certPem: 'PEM', hostnameClaimed: null, addr: 'h:1' });

  // Local approves first: still waiting on the peer.
  const afterLocal = pairing.recordLocalDecision(row.id, 'approved');
  assert.equal(afterLocal.status, 'pending_remote_approval');

  // Learning the peer also approved completes it.
  const afterRemote = pairing.recordRemoteDecision(row.id, 'approved');
  assert.equal(afterRemote.status, 'active');
  assert.ok(afterRemote.approvedAt);
});

test('activation also works when the remote decision is learned before the local one', () => {
  const row = pairing.recordInboundRequest({ fingerprint: 'FP:D', certPem: 'PEM', hostnameClaimed: null, addr: 'h:1' });

  const afterRemote = pairing.recordRemoteDecision(row.id, 'approved');
  assert.equal(afterRemote.status, 'pending_local_approval', 'remote alone must not activate the pair');

  const afterLocal = pairing.recordLocalDecision(row.id, 'approved');
  assert.equal(afterLocal.status, 'active');
});

test('either side rejecting produces status=rejected regardless of the other side', () => {
  const row = pairing.recordInboundRequest({ fingerprint: 'FP:E', certPem: 'PEM', hostnameClaimed: null, addr: 'h:1' });
  pairing.recordLocalDecision(row.id, 'approved');
  const rejected = pairing.recordRemoteDecision(row.id, 'rejected');
  assert.equal(rejected.status, 'rejected');
});

test('revoke is sticky: a revoked row cannot be re-activated by decisions or re-proposed back to pending', () => {
  const row = pairing.recordInboundRequest({ fingerprint: 'FP:F', certPem: 'PEM', hostnameClaimed: null, addr: 'h:1' });
  pairing.recordLocalDecision(row.id, 'approved');
  pairing.recordRemoteDecision(row.id, 'approved');
  assert.equal(pairing.getInstance(row.id).status, 'active');

  const revoked = pairing.revoke(row.id);
  assert.equal(revoked.status, 'revoked');
  assert.ok(revoked.revokedAt);

  // Decisions after revoke must not resurrect it.
  assert.equal(pairing.recordLocalDecision(row.id, 'approved'), null);
  assert.equal(pairing.getInstance(row.id).status, 'revoked');

  // A fresh propose from the same (still-revoked) fingerprint is refused.
  const reProposed = pairing.recordInboundRequest({ fingerprint: 'FP:F', certPem: 'PEM2', hostnameClaimed: null, addr: 'h:2' });
  assert.equal(reProposed, null);
  assert.equal(pairing.getInstance(row.id).status, 'revoked');

  assert.equal(pairing.getActiveInstance(row.id), null, 'getActiveInstance must never return a revoked row');
});

test('forgetInstance refuses non-revoked rows and leaves them untouched', () => {
  const active = pairing.recordInboundRequest({ fingerprint: 'FP:N1', certPem: 'PEM', hostnameClaimed: null, addr: 'h:1' });
  pairing.recordLocalDecision(active.id, 'approved');
  pairing.recordRemoteDecision(active.id, 'approved');
  assert.equal(pairing.getInstance(active.id).status, 'active');
  assert.equal(pairing.forgetInstance(active.id), null);
  assert.equal(pairing.getInstance(active.id).status, 'active', 'row must survive a refused forget');

  const rejected = pairing.recordInboundRequest({ fingerprint: 'FP:N2', certPem: 'PEM', hostnameClaimed: null, addr: 'h:1' });
  pairing.recordLocalDecision(rejected.id, 'rejected');
  assert.equal(pairing.forgetInstance(rejected.id), null);
  assert.equal(pairing.getInstance(rejected.id).status, 'rejected');
});

test('forgetInstance returns null for an unknown id', () => {
  assert.equal(pairing.forgetInstance('does-not-exist'), null);
});

test('forgetInstance hard-deletes a revoked row, unblocking re-pairing with the same fingerprint', () => {
  const row = pairing.recordInboundRequest({ fingerprint: 'FP:N3', certPem: 'PEM', hostnameClaimed: null, addr: 'h:1' });
  pairing.recordLocalDecision(row.id, 'approved');
  pairing.recordRemoteDecision(row.id, 'approved');
  pairing.revoke(row.id);
  assert.equal(pairing.getInstance(row.id).status, 'revoked');

  const forgotten = pairing.forgetInstance(row.id);
  assert.equal(forgotten.id, row.id);
  assert.equal(forgotten.status, 'revoked', 'returns the row as it was just before deletion');

  assert.equal(pairing.getInstance(row.id), null, 'row is gone entirely, not just re-statused');
  assert.equal(pairing.getInstanceByFingerprint('FP:N3'), null);

  // The core issue #161 scenario: with the row gone, the same fingerprint
  // proposing again is treated as a brand-new peer, not refused as revoked.
  const reProposed = pairing.recordInboundRequest({ fingerprint: 'FP:N3', certPem: 'PEM2', hostnameClaimed: null, addr: 'h:2' });
  assert.notEqual(reProposed, null);
  assert.notEqual(reProposed.id, row.id, 'a brand-new row, not the deleted one resurrected');
  assert.equal(reProposed.status, 'pending_local_approval');
});

test('a rejected pairing can be retried from scratch by a fresh propose', () => {
  const row = pairing.recordInboundRequest({ fingerprint: 'FP:G', certPem: 'PEM', hostnameClaimed: null, addr: 'h:1' });
  pairing.recordLocalDecision(row.id, 'rejected');
  assert.equal(pairing.getInstance(row.id).status, 'rejected');

  const retried = pairing.recordInboundRequest({ fingerprint: 'FP:G', certPem: 'PEM-NEW', hostnameClaimed: 'new-label', addr: 'h:2' });
  assert.equal(retried.id, row.id, 'the UNIQUE(remote_fingerprint) row is reused, not duplicated');
  assert.equal(retried.status, 'pending_local_approval');
  assert.equal(retried.localDecision, null);
  assert.equal(retried.remoteDecision, null);
});

test('a duplicate propose from an already-pending fingerprint is idempotent (no duplicate row, no decision reset)', () => {
  const row = pairing.recordInboundRequest({ fingerprint: 'FP:H', certPem: 'PEM', hostnameClaimed: null, addr: 'h:1' });
  pairing.recordLocalDecision(row.id, 'approved');

  const again = pairing.recordInboundRequest({ fingerprint: 'FP:H', certPem: 'PEM', hostnameClaimed: 'updated-label', addr: 'h:1-new' });
  assert.equal(again.id, row.id);
  assert.equal(again.status, 'pending_remote_approval', 'the existing decision must survive a retried propose');
  assert.equal(again.addr, 'h:1-new', 'display-only fields still refresh');
});

test('listPending only returns pending_local_approval / pending_remote_approval rows', () => {
  const a = pairing.recordInboundRequest({ fingerprint: 'FP:I1', certPem: 'PEM', hostnameClaimed: null, addr: 'h:1' });
  const b = pairing.recordInboundRequest({ fingerprint: 'FP:I2', certPem: 'PEM', hostnameClaimed: null, addr: 'h:1' });
  pairing.recordLocalDecision(b.id, 'approved');
  pairing.recordRemoteDecision(b.id, 'approved'); // now active
  const c = pairing.recordInboundRequest({ fingerprint: 'FP:I3', certPem: 'PEM', hostnameClaimed: null, addr: 'h:1' });
  pairing.revoke(c.id);

  const ids = pairing.listPending().map((r) => r.id);
  assert.ok(ids.includes(a.id));
  assert.equal(ids.includes(b.id), false);
  assert.equal(ids.includes(c.id), false);
});

test('sweepExpiredPending moves only rows older than the max age, leaves decided/revoked rows alone', () => {
  const old = pairing.recordInboundRequest({ fingerprint: 'FP:J', certPem: 'PEM', hostnameClaimed: null, addr: 'h:1' });
  getDb().prepare('UPDATE paired_instances SET created_at = ? WHERE id = ?')
    .run(Date.now() - pairing.PENDING_MAX_AGE_MS - 1000, old.id);
  const fresh = pairing.recordInboundRequest({ fingerprint: 'FP:K', certPem: 'PEM', hostnameClaimed: null, addr: 'h:1' });

  const swept = pairing.sweepExpiredPending();
  assert.ok(swept >= 1);
  assert.equal(pairing.getInstance(old.id).status, 'expired');
  assert.equal(pairing.getInstance(fresh.id).status, 'pending_local_approval');
});

test('inbound pending rows beyond MAX_PENDING_ROWS auto-reject the oldest one', () => {
  const ids = [];
  const base = Date.now();
  for (let i = 0; i < pairing.MAX_PENDING_ROWS + 2; i++) {
    const row = pairing.recordInboundRequest({ fingerprint: `FP:CAP-${i}`, certPem: 'PEM', hostnameClaimed: null, addr: 'h:1' });
    ids.push(row.id);
    // created_at strictly increasing so "oldest" is unambiguous even within
    // the same millisecond, while staying recent (sweepExpiredPending, run
    // by listPending() below, would otherwise treat a far-past timestamp as
    // stale and expire every row before the cap assertion even runs).
    getDb().prepare('UPDATE paired_instances SET created_at = ? WHERE id = ?').run(base + i, row.id);
  }
  const pendingIds = pairing.listPending().map((r) => r.id);
  assert.ok(pendingIds.length <= pairing.MAX_PENDING_ROWS);
  assert.equal(pairing.getInstance(ids[0]).status, 'rejected', 'the oldest row was auto-rejected to make room');
  assert.equal(pairing.getInstance(ids[ids.length - 1]).status, 'pending_local_approval', 'the newest row survives');
});

test('recordOutboundRequest sets direction=outbound_initiated and accepts a label', () => {
  const row = pairing.recordOutboundRequest({
    fingerprint: 'FP:L', certPem: 'PEM', hostnameClaimed: 'peer-host', addr: '10.0.0.9:3210', label: 'my-desktop',
  });
  assert.equal(row.direction, 'outbound_initiated');
  assert.equal(row.label, 'my-desktop');
});

test('setLabel updates the label and getRawByFingerprint / getInstanceByFingerprint see it', () => {
  const row = pairing.recordInboundRequest({ fingerprint: 'FP:M', certPem: 'PEM', hostnameClaimed: null, addr: 'h:1' });
  pairing.setLabel(row.id, 'renamed');
  assert.equal(pairing.getInstance(row.id).label, 'renamed');
  assert.equal(pairing.getInstanceByFingerprint('FP:M').label, 'renamed');
  assert.equal(pairing.getRawByFingerprint('FP:M').label, 'renamed');
});

test('deriveStatus is a pure function matching every case the schema documents', () => {
  assert.equal(pairing.deriveStatus({ localDecision: null, remoteDecision: null, revokedAt: null }), 'pending_local_approval');
  assert.equal(pairing.deriveStatus({ localDecision: 'approved', remoteDecision: null, revokedAt: null }), 'pending_remote_approval');
  assert.equal(pairing.deriveStatus({ localDecision: 'approved', remoteDecision: 'approved', revokedAt: null }), 'active');
  assert.equal(pairing.deriveStatus({ localDecision: 'approved', remoteDecision: 'rejected', revokedAt: null }), 'rejected');
  assert.equal(pairing.deriveStatus({ localDecision: 'rejected', remoteDecision: null, revokedAt: null }), 'rejected');
  assert.equal(pairing.deriveStatus({ localDecision: 'approved', remoteDecision: 'approved', revokedAt: 123 }), 'revoked');
});
