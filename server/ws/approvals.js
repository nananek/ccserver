// Server-initiated destructive-action approvals (DB v4, plan section 3).
//
// A caller that wants to close_session / destroy_group / delete_sandbox
// must never destroy a running agent on its own say-so: it inserts a
// 'pending' row here and BLOCKS the call on an in-memory waiter until the
// browser decides via POST /api/approvals/:id/decision. The shape is the
// groupManager pushHandoff/takeHandoff "make the caller wait, resolve later"
// pattern simplified to 1:1 -- one approval id has exactly one waiter, so
// there is no queue and no re-queue/supersede machinery.
//
// Fail-safe direction: an undecided approval ALWAYS ends as "do nothing".
// The timeout is a fixed 5 minutes and expiry resolves like a rejection;
// rows still pending at boot (server restarted mid-wait; the waiter died
// with the old process) are expired by expireStalePendingApprovals().
//
// requestedBy is attribution only (shown in the dialog) -- never an
// authorization input; the caller's own trust boundary (whatever that is)
// gates whether it may request an approval at all. No current caller uses
// this (issue #189 removed the sole consumer, the privileged meta-agent MCP
// toolset); kept as generic infrastructure for a future feature that needs
// the same human-in-the-loop gate.

import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';

export const APPROVAL_KINDS = ['close_session', 'destroy_group', 'delete_sandbox'];
export const APPROVAL_DECISIONS = ['approved', 'rejected'];

// Fixed per plan decision 4 [2026-08-24]: not configurable in v1.
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

const MAX_SUMMARY_CHARS = 500;
const MAX_PAYLOAD_BYTES = 8 * 1024;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const HISTORY_LIMIT = 20;

// approvalId -> { resolve, timer }
const waiters = new Map();

function rowToApproval(row) {
  if (!row) return null;
  let payload = null;
  try { payload = JSON.parse(row.payload); } catch { /* corrupt row: surface raw */ }
  return {
    id: row.id,
    kind: row.kind,
    summary: row.summary,
    payload,
    requestedBy: row.requested_by ?? null,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
    resolvedBy: row.resolved_by ?? null,
  };
}

function getApprovalRow(id) {
  return getDb()
    .prepare('SELECT id, kind, summary, payload, requested_by, status, created_at, resolved_at, resolved_by FROM pending_approvals WHERE id = ?')
    .get(id);
}

// Pure validation for requestApproval input. Returns { ok, value } or
// { ok, errors }.
export function normalizeApprovalInput({ kind, summary, payload, requestedBy } = {}) {
  const errors = [];
  if (!APPROVAL_KINDS.includes(kind)) {
    errors.push(`kind must be one of: ${APPROVAL_KINDS.join(', ')}`);
  }
  let trimmedSummary = null;
  if (typeof summary !== 'string' || !summary.trim()) {
    errors.push('summary is required');
  } else {
    trimmedSummary = summary.trim();
    if (trimmedSummary.length > MAX_SUMMARY_CHARS) errors.push(`summary must be at most ${MAX_SUMMARY_CHARS} characters`);
    else if (CONTROL_CHARS_RE.test(trimmedSummary.replace(/\n/g, ''))) errors.push('summary must not contain control characters');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    errors.push('payload must be an object');
  } else {
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, 'utf-8') > MAX_PAYLOAD_BYTES) errors.push(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  if (requestedBy != null && typeof requestedBy !== 'string') {
    errors.push('requestedBy must be a string or null');
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      kind,
      summary: trimmedSummary,
      payloadJson: JSON.stringify(payload),
      requestedBy: requestedBy ?? null,
    },
  };
}

// Insert a pending approval and block until a human decides or the fixed
// timeout expires it. Resolves (never rejects) with:
//   { status: 'approved', approval } | { status: 'rejected', approval }
//   | { status: 'expired', approval }
// Validation failures reject with an Error whose message lists the problems
// (a caller bug, not a runtime condition).
export function requestApproval(input, { timeoutMs = APPROVAL_TIMEOUT_MS } = {}) {
  const n = normalizeApprovalInput(input);
  if (!n.ok) {
    return Promise.reject(new Error(n.errors.join('; ')));
  }
  const id = randomUUID();
  const now = Date.now();
  try {
    getDb()
      .prepare(`INSERT INTO pending_approvals (id, kind, summary, payload, requested_by, status, created_at)
                VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
      .run(id, n.value.kind, n.value.summary, n.value.payloadJson, n.value.requestedBy, now);
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise((resolve) => {
    const finish = (status) => {
      waiters.delete(id);
      resolve({ status, approval: rowToApproval(getApprovalRow(id)) });
    };
    const timer = setTimeout(() => {
      // Expire only if still pending (a racing decideApproval may have won).
      try {
        getDb()
          .prepare("UPDATE pending_approvals SET status = 'expired', resolved_at = ?, resolved_by = 'timeout' WHERE id = ? AND status = 'pending'")
          .run(Date.now(), id);
      } catch { /* best effort: the DB may be closing */ }
      finish('expired');
    }, Math.max(Number(timeoutMs) || 0, 0));
    waiters.set(id, { resolve: finish, timer });
  });
}

// Apply the browser's decision. Result object semantics (user-facing REST):
//   { ok: true, approval } -- the waiter (if any) was resolved with this status
//   { ok:false, code:'not-found' | 'already-resolved', message }
export function decideApproval(id, decision) {
  if (!APPROVAL_DECISIONS.includes(decision)) {
    return { ok: false, code: 'validation', message: `decision must be one of: ${APPROVAL_DECISIONS.join(', ')}` };
  }
  if (typeof id !== 'string' || !id) {
    return { ok: false, code: 'not-found', message: 'approval not found' };
  }
  try {
    const res = getDb()
      .prepare("UPDATE pending_approvals SET status = ?, resolved_at = ?, resolved_by = 'browser' WHERE id = ? AND status = 'pending'")
      .run(decision, Date.now(), id);
    if (res.changes === 0) {
      const row = getApprovalRow(id);
      if (!row) return { ok: false, code: 'not-found', message: 'approval not found' };
      return { ok: false, code: 'already-resolved', message: `approval already ${row.status}`, approval: rowToApproval(row) };
    }
    const approval = rowToApproval(getApprovalRow(id));
    // Unblock the waiting MCP tool call, if its connection is still there
    // (a server restart drops the waiters; the stale row path above covers it).
    const waiter = waiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(decision);
    }
    return { ok: true, approval };
  } catch (err) {
    return { ok: false, code: 'internal', message: err.message };
  }
}

// Pending first (oldest first -- what the banner should show), then the most
// recent resolved history. historyCount caps the resolved tail.
export function listApprovals({ historyCount = HISTORY_LIMIT } = {}) {
  try {
    const pending = getDb()
      .prepare("SELECT id, kind, summary, payload, requested_by, status, created_at, resolved_at, resolved_by FROM pending_approvals WHERE status = 'pending' ORDER BY created_at ASC, id ASC")
      .all();
    const history = getDb()
      .prepare("SELECT id, kind, summary, payload, requested_by, status, created_at, resolved_at, resolved_by FROM pending_approvals WHERE status != 'pending' ORDER BY resolved_at DESC, created_at DESC LIMIT ?")
      .all(Math.max(Number(historyCount) || 0, 0));
    return { ok: true, pending: pending.map(rowToApproval), history: history.map(rowToApproval) };
  } catch (err) {
    return { ok: false, code: 'internal', message: err.message };
  }
}

// Boot-time sweep: any row still 'pending' belongs to a waiter that died with
// the previous process. Expire them all -- fail-safe means nothing runs just
// because the server restarted. Returns how many rows were swept.
export function expireStalePendingApprovals() {
  try {
    return getDb()
      .prepare("UPDATE pending_approvals SET status = 'expired', resolved_at = ?, resolved_by = 'server-restart' WHERE status = 'pending'")
      .run(Date.now()).changes;
  } catch (err) {
    console.warn(`[approvals] could not expire stale pendings: ${err.message}`);
    return 0;
  }
}

// Test seam: drop every waiter without resolving (simulates a crash).
export function _resetWaitersForTests() {
  for (const waiter of waiters.values()) clearTimeout(waiter.timer);
  waiters.clear();
}
