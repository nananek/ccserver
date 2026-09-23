// ============================================================================
// ccserver's configuration model (issue #201, decision D2). This header is
// the normative statement of the rule; docs-site's
// reference/configuration-model.md is the same rule for operators.
//
//   Settings that can be changed from the Web UI and take effect without a
//   restart live in SQLite's `settings` table. Settings that are read once
//   at process start and require a restart to change -- above all the
//   security boundaries (browseRoots / forceSandbox / allowUnsandboxedAgents
//   / hiddenApps) -- live in sandbox.config.json.
//
//   THE TEST: does the safety of an ALREADY RUNNING session depend on this
//   value? If yes, it is static.
//
// That last sentence is the useful part. A running sandbox's bind mounts
// were computed from browseRoots at launch time; making browseRoots dynamic
// would mean the UI could show a value that the live sandboxes are not
// actually honoring. So it stays static, and "we just haven't gotten to it"
// is not why.
//
// Known exception today: the network allowlist has a Settings GUI tab but
// read-modify-writes sandbox.config.json (ws/networkAllowlist.js). #205
// moves it here; this table exists so it has somewhere to land.
//
// Not to be confused (the docs call this out too): sandbox.config.json's
// `gpg` / `gpgVault` booleans are "forward the host agent into sandboxes",
// while the Web UI's GPG連携 tab (GpgVaultSection.jsx) is the vault's own
// setup and lock management. Different concepts, similar names.
// ============================================================================
//
// Values round-trip through JSON in every case, including strings and
// booleans: one decode path, and `null` means "the value is null", never
// "no row". Validation belongs to the caller -- the same division of labor
// network-broker.js's normalizeNetworkSettings already has.

import { getDb } from './db.js';

// Names that are not ordinary properties when assigned to a plain object.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function getSetting(scope, scopeId, key, fallback = undefined) {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE scope = ? AND scope_id = ? AND key = ?')
    .get(scope, scopeId, key);
  return row ? decode(row.value, `${scope}/${scopeId}/${key}`, fallback) : fallback;
}

// Every key in one scope, as a plain object.
export function getScope(scope, scopeId) {
  const rows = getDb()
    .prepare('SELECT key, value FROM settings WHERE scope = ? AND scope_id = ? ORDER BY key')
    .all(scope, scopeId);
  // Reserved key names are dropped (attack-test-201 F9). Keys come from the
  // table, and `out['__proto__'] = value` on a plain object REPLACES the
  // object's prototype instead of adding a property -- so a row with that
  // name polluted the returned object. Skipping the three reserved names
  // closes it while keeping an ordinary object as the return type; a
  // null-prototype object would be safer still, but it breaks deepEqual and
  // every other normal thing a caller does with the result, for a key nobody
  // has a legitimate use for. Nothing can write arbitrary keys today (the
  // table ships empty, #205 is its first writer), so this is closed before it
  // is reachable rather than after.
  const out = {};
  for (const row of rows) {
    if (RESERVED_KEYS.has(row.key)) {
      console.warn(`[settings] ${scope}/${scopeId}/${row.key} uses a reserved key name; skipping`);
      continue;
    }
    const value = decode(row.value, `${scope}/${scopeId}/${row.key}`, undefined);
    if (value !== undefined) out[row.key] = value;
  }
  return out;
}

// The named members of a scope -- #205's "list the network profiles".
export function listScopeIds(scope) {
  return getDb()
    .prepare('SELECT DISTINCT scope_id FROM settings WHERE scope = ? ORDER BY scope_id')
    .all(scope)
    .map((r) => r.scope_id);
}

export function setSetting(scope, scopeId, key, value, { updatedBy = null } = {}) {
  upsert(getDb(), scope, scopeId, key, value, updatedBy, Date.now());
}

// Writes a whole object at once. replace: true makes it the ENTIRE contents
// of the scope -- keys absent from `obj` are deleted -- which is the
// primitive "save this profile" needs. One BEGIN IMMEDIATE around the
// delete and the inserts, so a failure partway leaves the previous scope
// untouched rather than half-erased.
export function setScope(scope, scopeId, obj, { updatedBy = null, replace = false } = {}) {
  const db = getDb();
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (replace) {
      db.prepare('DELETE FROM settings WHERE scope = ? AND scope_id = ?').run(scope, scopeId);
    }
    for (const [key, value] of Object.entries(obj)) {
      upsert(db, scope, scopeId, key, value, updatedBy, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already unwound */ }
    throw err;
  }
}

export function deleteSetting(scope, scopeId, key) {
  return getDb()
    .prepare('DELETE FROM settings WHERE scope = ? AND scope_id = ? AND key = ?')
    .run(scope, scopeId, key).changes > 0;
}

export function deleteScope(scope, scopeId) {
  return getDb()
    .prepare('DELETE FROM settings WHERE scope = ? AND scope_id = ?')
    .run(scope, scopeId).changes;
}

// Newest write in a scope, for ETags and change polling. null when empty.
export function scopeUpdatedAt(scope, scopeId) {
  const row = getDb()
    .prepare('SELECT MAX(updated_at) AS at FROM settings WHERE scope = ? AND scope_id = ?')
    .get(scope, scopeId);
  return row?.at ?? null;
}

function upsert(db, scope, scopeId, key, value, updatedBy, now) {
  db.prepare(
    'INSERT INTO settings (scope, scope_id, key, value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT(scope, scope_id, key) DO UPDATE SET '
    + 'value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
  ).run(scope, scopeId, key, JSON.stringify(value === undefined ? null : value), now, updatedBy);
}

// A hand-edited or truncated row must not take down the caller: it reads as
// the fallback, which is what an absent row would have produced.
function decode(raw, where, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`[settings] ${where} holds invalid JSON; using the fallback`);
    return fallback;
  }
}
