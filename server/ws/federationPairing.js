// Local-DB half of cross-instance pairing (DB v5, see db.js). Pure state
// machine + CRUD over paired_instances -- no networking here (that's
// federationServer.js for inbound / federationClient.js for outbound).
//
// Bidirectional approval (plan decision 3, 2026-08-24): a pair only reaches
// 'active' once BOTH sides' humans have independently approved. Each row
// tracks two independent decisions:
//   local_decision  -- what the human using THIS instance's browser decided.
//   remote_decision -- the last decision we learned the peer made, either by
//                       asking (see reconcilePending, called from the REST
//                       polling path) or by the peer telling us so during a
//                       pairing.propose/pairing.status RPC.
// `status` is a derived, persisted projection of those two columns (plus
// revoked_at) -- see deriveStatus. Deliberately NOT turn-based ("receiver
// decides first"): either side's human can click Approve as soon as they've
// seen the peer's fingerprint, which is available immediately from the TLS
// handshake itself (see federationClient.js / federationServer.js), before
// any application-level exchange. This is simpler and order-independent
// compared to the plan's literal step-by-step walkthrough (plan section 4.2)
// while satisfying the same requirement: activation still requires two
// independent human approvals, never one alone.

import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';

export const DIRECTIONS = ['outbound_initiated', 'inbound_initiated'];
export const DECISIONS = ['approved', 'rejected'];

// Rows older than this while still undecided are swept to 'expired' (plan
// section 4.3: pairing intentionally does NOT use the 5-minute
// pending_approvals timeout -- an unattended peer may take days to notice).
export const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// DoS guard (plan section 10): caps how many undecided rows one instance will
// hold at once. A flood of bootstrap proposals past this cap auto-rejects the
// oldest pending row instead of letting the approval list grow unbounded.
export const MAX_PENDING_ROWS = 20;

function isPendingStatus(status) {
  return status === 'pending_local_approval' || status === 'pending_remote_approval';
}

// Pure derivation: the schema's `status` column mirrors this, recomputed
// every time a decision changes (recomputeAndPersistStatus). 'expired' is
// NOT derivable from decisions -- it is a timeout outcome written directly by
// sweepExpiredPending -- so a row already at 'expired' (or 'revoked') is left
// alone by this function's callers rather than recomputed back to pending.
export function deriveStatus({ localDecision, remoteDecision, revokedAt }) {
  if (revokedAt) return 'revoked';
  if (localDecision === 'rejected' || remoteDecision === 'rejected') return 'rejected';
  if (localDecision === 'approved' && remoteDecision === 'approved') return 'active';
  if (localDecision === 'approved') return 'pending_remote_approval';
  return 'pending_local_approval';
}

function rowToPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label ?? null,
    fingerprint: row.remote_fingerprint,
    hostnameClaimed: row.remote_hostname_claimed ?? null,
    addr: row.remote_addr,
    direction: row.direction,
    localDecision: row.local_decision ?? null,
    remoteDecision: row.remote_decision ?? null,
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at ?? null,
    revokedAt: row.revoked_at ?? null,
    lastSeenAt: row.last_seen_at ?? null,
  };
}

const COLUMNS = 'id, label, remote_fingerprint, remote_cert_pem, remote_hostname_claimed, remote_addr, direction, local_decision, remote_decision, status, created_at, approved_at, revoked_at, last_seen_at';

function getRowById(id) {
  return getDb().prepare(`SELECT ${COLUMNS} FROM paired_instances WHERE id = ?`).get(id);
}

function getRowByFingerprint(fingerprint) {
  return getDb().prepare(`SELECT ${COLUMNS} FROM paired_instances WHERE remote_fingerprint = ?`).get(fingerprint);
}

// Sweeps rows undecided for longer than PENDING_MAX_AGE_MS to 'expired'.
// Cheap (indexed on status) and side-effect-free when there is nothing to
// sweep, so callers run it inline before every list rather than needing a
// background timer. Returns the number of rows swept.
export function sweepExpiredPending() {
  const cutoff = Date.now() - PENDING_MAX_AGE_MS;
  return getDb()
    .prepare("UPDATE paired_instances SET status = 'expired' WHERE status IN ('pending_local_approval', 'pending_remote_approval') AND created_at < ?")
    .run(cutoff).changes;
}

// DoS guard: if accepting a new pending row would exceed MAX_PENDING_ROWS,
// auto-rejects the oldest pending row(s) first (plan section 10). Called
// right before inserting a fresh inbound row.
function enforcePendingCap() {
  const pending = getDb()
    .prepare("SELECT id FROM paired_instances WHERE status IN ('pending_local_approval', 'pending_remote_approval') ORDER BY created_at ASC")
    .all();
  const overflow = pending.length - (MAX_PENDING_ROWS - 1);
  if (overflow <= 0) return;
  const stmt = getDb().prepare("UPDATE paired_instances SET status = 'rejected', local_decision = 'rejected' WHERE id = ?");
  for (let i = 0; i < overflow; i++) stmt.run(pending[i].id);
}

export function listInstances() {
  sweepExpiredPending();
  return getDb()
    .prepare(`SELECT ${COLUMNS} FROM paired_instances ORDER BY created_at DESC`)
    .all()
    .map(rowToPublic);
}

export function listPending() {
  sweepExpiredPending();
  return getDb()
    .prepare(`SELECT ${COLUMNS} FROM paired_instances WHERE status IN ('pending_local_approval', 'pending_remote_approval') ORDER BY created_at ASC`)
    .all()
    .map(rowToPublic);
}

export function getInstance(id) {
  return rowToPublic(getRowById(id));
}

// Only 'active' rows may be used for actual proxied traffic (list/launch/
// terminal) -- see federationClient.js's callers. Kept separate from
// getInstance so authorization checks read as intent, not a status string
// comparison scattered across call sites.
export function getActiveInstance(id) {
  const row = getRowById(id);
  if (!row || row.status !== 'active') return null;
  return rowToPublic(row);
}

export function getInstanceByFingerprint(fingerprint) {
  return rowToPublic(getRowByFingerprint(fingerprint));
}

// Internal (network-trust) lookup used by federationServer.js's connection
// gate: needs the raw row (status especially) to decide what an inbound
// connection from this fingerprint may do, before any REST-shaped response.
export function getRawByFingerprint(fingerprint) {
  return getRowByFingerprint(fingerprint);
}

function upsertPeerRow({ id, label, fingerprint, certPem, hostnameClaimed, addr, direction }) {
  const now = Date.now();
  const existing = getRowByFingerprint(fingerprint);
  if (!existing) {
    if (direction === 'inbound_initiated') enforcePendingCap();
    getDb()
      .prepare(`INSERT INTO paired_instances
        (id, label, remote_fingerprint, remote_cert_pem, remote_hostname_claimed, remote_addr, direction, local_decision, remote_decision, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending_local_approval', ?)`)
      .run(id, label ?? null, fingerprint, certPem, hostnameClaimed ?? null, addr, direction, now);
    return rowToPublic(getRowById(id));
  }
  if (existing.status === 'revoked') {
    // Revocation is intentionally sticky (plan section 4.5 / 10): a revoked
    // fingerprint never silently re-enters the pending queue on its own say-so.
    return null;
  }
  if (existing.status === 'active' || isPendingStatus(existing.status)) {
    // Idempotent retry (e.g. a dropped bootstrap connection retried by the
    // initiator): just refresh the display-only fields and bump last_seen.
    getDb()
      .prepare('UPDATE paired_instances SET remote_cert_pem = ?, remote_hostname_claimed = ?, remote_addr = ?, last_seen_at = ? WHERE id = ?')
      .run(certPem, hostnameClaimed ?? null, addr, now, existing.id);
    return rowToPublic(getRowById(existing.id));
  }
  // 'rejected' or 'expired': a fresh propose from the same peer starts over.
  if (direction === 'inbound_initiated') enforcePendingCap();
  getDb()
    .prepare(`UPDATE paired_instances SET
        remote_cert_pem = ?, remote_hostname_claimed = ?, remote_addr = ?, direction = ?,
        local_decision = NULL, remote_decision = NULL, status = 'pending_local_approval',
        created_at = ?, approved_at = NULL, revoked_at = NULL, last_seen_at = NULL
      WHERE id = ?`)
    .run(certPem, hostnameClaimed ?? null, addr, direction, now, existing.id);
  return rowToPublic(getRowById(existing.id));
}

// Called by federationServer.js when an inbound connection presents a
// fingerprint with no existing row (or a lapsed one): creates/resets the row
// as 'inbound_initiated', status pending_local_approval. Self-pairing
// (fingerprint === our own) must be checked by the caller, which has our own
// identity; this module has no notion of "self".
export function recordInboundRequest({ fingerprint, certPem, hostnameClaimed, addr }) {
  return upsertPeerRow({ id: randomUUID(), fingerprint, certPem, hostnameClaimed, addr, direction: 'inbound_initiated' });
}

// Called by federationClient.js right after the initiator's bootstrap TLS
// handshake completes (before any application response arrives): the peer's
// certificate is already known from the handshake itself.
export function recordOutboundRequest({ fingerprint, certPem, hostnameClaimed, addr, label }) {
  return upsertPeerRow({ id: randomUUID(), fingerprint, certPem, hostnameClaimed, addr, direction: 'outbound_initiated', label });
}

function recomputeAndPersist(id, patch) {
  const row = getRowById(id);
  if (!row) return null;
  const merged = { ...row, ...patch };
  const status = deriveStatus({
    localDecision: merged.local_decision,
    remoteDecision: merged.remote_decision,
    revokedAt: merged.revoked_at,
  });
  const now = Date.now();
  const approvedAt = status === 'active' && !row.approved_at ? now : row.approved_at;
  getDb()
    .prepare('UPDATE paired_instances SET local_decision = ?, remote_decision = ?, status = ?, approved_at = ? WHERE id = ?')
    .run(merged.local_decision ?? null, merged.remote_decision ?? null, status, approvedAt ?? null, id);
  return rowToPublic(getRowById(id));
}

// The browser's own human decided (POST /api/federation/pending/:id/decide).
// Returns the updated public row, or null if the id doesn't exist / is
// already in a terminal state (revoked/expired -- 'rejected' can still be
// re-decided to 'approved' by hand, matching how a stray misclick should be
// recoverable without re-running the whole bootstrap).
export function recordLocalDecision(id, decision) {
  if (!DECISIONS.includes(decision)) return null;
  const row = getRowById(id);
  if (!row || row.status === 'revoked' || row.status === 'expired') return null;
  return recomputeAndPersist(id, { local_decision: decision });
}

// Learned via polling the peer (pairing.status) or from their propose/status
// RPC response. Never trusted for anything beyond this bookkeeping -- it only
// ever flips OUR row from pending_remote_approval to active (both must still
// have independently decided 'approved' locally too via deriveStatus).
export function recordRemoteDecision(id, decision) {
  if (!DECISIONS.includes(decision)) return null;
  const row = getRowById(id);
  if (!row || row.status === 'revoked' || row.status === 'expired') return null;
  return recomputeAndPersist(id, { remote_decision: decision });
}

export function touchLastSeen(id) {
  try {
    getDb().prepare('UPDATE paired_instances SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
  } catch { /* best effort -- never block a relay on this */ }
}

export function setLabel(id, label) {
  const row = getRowById(id);
  if (!row) return null;
  getDb().prepare('UPDATE paired_instances SET label = ? WHERE id = ?').run(typeof label === 'string' && label ? label : null, id);
  return rowToPublic(getRowById(id));
}

// Revocation is local-only and immediate (plan section 4.5): the peer is not
// notified, and the pinned fingerprint is kept (status='revoked') as an audit
// trail rather than deleted -- federationServer.js's connection gate refuses
// every subsequent connection from it.
export function revoke(id) {
  const row = getRowById(id);
  if (!row) return null;
  getDb().prepare("UPDATE paired_instances SET status = 'revoked', revoked_at = ? WHERE id = ?").run(Date.now(), id);
  return rowToPublic(getRowById(id));
}

// Hard-deletes a row, permanently removing the audit trail (Issue #161).
// Restricted to 'revoked' rows -- that is the one status upsertPeerRow()
// never lets leave on its own (see that function's header comment). This
// is what unblocks re-pairing with the same fingerprint: with the row
// gone, the next pairing.propose (either direction) is treated as a
// brand-new peer and goes through the normal pending_local_approval flow.
// revoke() itself is unchanged -- it stays a sticky, audit-preserving
// soft delete; forgetting is a separate, explicit follow-up action.
export function forgetInstance(id) {
  const row = getRowById(id);
  if (!row || row.status !== 'revoked') return null;
  getDb().prepare('DELETE FROM paired_instances WHERE id = ?').run(id);
  return rowToPublic(row);
}

export const _internal = { rowToPublic, isPendingStatus };
