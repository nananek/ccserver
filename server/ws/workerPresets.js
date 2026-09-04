// Worker preset store (SQLite, shared scope): named launch templates
// (display name / technical role / CLI / model) the combo modal expands into
// a POST /groups workers[] snapshot. The server never re-reads a preset at
// launch time -- editing or deleting one only affects future selections.
//
// Error semantics: this is user-facing CRUD -- failures are returned as
// { ok:false, code, message } result objects and surface as HTTP statuses;
// nothing here is best-effort (see db.js's header comment).

import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { WORKER_ROLE_RE } from './groupManager.js';

// Presets can only contain CLIs that can join a group's MCP broker:
// copilot/commandcode have no CLI-arg/env MCP injection (config-file only /
// unverified) and are refused explicitly -- this whitelist is intentionally
// narrower than appLaunch.js's APPS.
export const PRESET_APPS = ['claude', 'opencode', 'codex'];

const NAME_MAX = 80;
const ROLE_MAX = 80;
const MODEL_MAX = 200;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function isUniqueViolation(err) {
  // node:sqlite surfaces constraint failures as ERR_SQLITE_ERROR with the
  // SQLite message text; match on the message (and keep the classic code
  // check for forward compatibility).
  return err?.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || /UNIQUE constraint failed/.test(err?.message || '');
}

function rowToPreset(row) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    app: row.app,
    model: row.model ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Pure normalization/validation for a preset-shaped input, shared with
// POST /groups' workers[] validation so the two paths can never disagree.
//
//   name : required display name unless opts.allowMissingName (workers[]
//          entries may omit it -> null; the UI falls back to the role).
//          Trimmed 1-80 chars, control characters rejected.
//   role : required technical identifier. Same WORKER_ROLE_RE as addMember()
//          ('orchestrator' is excluded by the pattern itself), <= 80 chars.
//   app  : required PRESETS_APPS entry unless opts.allowMissingApp (workers[]
//          may omit it -> null -> defaultApp at launch). copilot rejected by
//          not being in the whitelist.
//   model: optional. null allowed, '' normalizes to null, else trimmed string
//          1-200 chars.
//
// Returns { ok: true, value: { name, role, app, model } } or
//         { ok: false, errors: [ ... ] }.
export function normalizePresetInput(input, opts = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(source, k);
  const errors = [];
  const value = { name: null, role: null, app: null, model: null };

  if (has('name') && source.name !== null && source.name !== undefined && source.name !== '') {
    if (typeof source.name !== 'string') {
      errors.push('name must be a string');
    } else {
      const t = source.name.trim();
      if (!t || t.length > NAME_MAX) errors.push(`name must be 1-${NAME_MAX} characters`);
      else if (CONTROL_CHARS_RE.test(t)) errors.push('name must not contain control characters');
      else value.name = t;
    }
  } else if (!opts.allowMissingName) {
    // Absent / '' / null all normalize to value.name = null; only presets
    // (which require a display name) treat that as an error.
    errors.push(`name must be 1-${NAME_MAX} characters`);
  }

  if (has('role')) {
    if (typeof source.role !== 'string') {
      errors.push('role must be a string');
    } else {
      const t = source.role.trim();
      if (!WORKER_ROLE_RE.test(t)) errors.push('role must start with "worker" and use only letters, digits, "-" or "_" (e.g. workerImplement)');
      else if (t.length > ROLE_MAX) errors.push(`role must be at most ${ROLE_MAX} characters`);
      else value.role = t;
    }
  } else {
    errors.push('role is required');
  }

  if (has('app') && source.app !== null && source.app !== undefined && source.app !== '') {
    if (!PRESET_APPS.includes(source.app)) {
      // Keep "copilot is not supported in groups" verbatim: this string flows
      // into the REST 400s whose long-standing contract the E2E suite matches
      // on (see tests/copilot-launch.spec.js).
      errors.push('app must be claude, opencode, or codex (copilot is not supported in groups; commandcode neither)');
    } else {
      value.app = source.app;
    }
  } else if (!opts.allowMissingApp) {
    errors.push('app must be claude, opencode, or codex');
  }

  if (has('model') && source.model !== null && source.model !== undefined && source.model !== '') {
    if (typeof source.model !== 'string') {
      errors.push('model must be a string or null');
    } else {
      const t = source.model.trim();
      if (!t || t.length > MODEL_MAX) errors.push(`model must be 1-${MODEL_MAX} characters`);
      else value.model = t;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}

export function listPresets() {
  try {
    const rows = getDb()
      .prepare('SELECT id, name, role, app, model, created_at, updated_at FROM worker_presets ORDER BY created_at ASC, id ASC')
      .all();
    return { ok: true, presets: rows.map(rowToPreset) };
  } catch (err) {
    return { ok: false, code: 'internal', message: err.message };
  }
}

export function createPreset(input) {
  const n = normalizePresetInput(input);
  if (!n.ok) return { ok: false, code: 'validation', message: n.errors.join('; '), errors: n.errors };
  const id = randomUUID();
  const now = Date.now();
  try {
    getDb()
      .prepare('INSERT INTO worker_presets (id, name, role, app, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, n.value.name, n.value.role, n.value.app, n.value.model ?? null, now, now);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, code: 'duplicate-role', message: `a preset with role "${n.value.role}" already exists` };
    }
    return { ok: false, code: 'internal', message: err.message };
  }
  return { ok: true, preset: getPreset(id).preset };
}

export function updatePreset(id, input) {
  if (typeof id !== 'string' || !id) return { ok: false, code: 'not-found', message: 'preset not found' };
  const existing = getPreset(id);
  if (!existing.ok) return { ok: false, code: 'not-found', message: 'preset not found' };
  const n = normalizePresetInput(input);
  if (!n.ok) return { ok: false, code: 'validation', message: n.errors.join('; '), errors: n.errors };
  const now = Date.now();
  try {
    getDb()
      .prepare('UPDATE worker_presets SET name = ?, role = ?, app = ?, model = ?, updated_at = ? WHERE id = ?')
      .run(n.value.name, n.value.role, n.value.app, n.value.model ?? null, now, id);
  } catch (err) {
    // Keeping a row's own role cannot violate UNIQUE, so this fires only when
    // a *different* preset already owns the role.
    if (isUniqueViolation(err)) {
      return { ok: false, code: 'duplicate-role', message: `a preset with role "${n.value.role}" already exists` };
    }
    return { ok: false, code: 'internal', message: err.message };
  }
  return { ok: true, preset: getPreset(id).preset };
}

export function deletePreset(id) {
  if (typeof id !== 'string' || !id) return { ok: false, code: 'not-found', message: 'preset not found' };
  try {
    const res = getDb().prepare('DELETE FROM worker_presets WHERE id = ?').run(id);
    if (res.changes === 0) return { ok: false, code: 'not-found', message: 'preset not found' };
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'internal', message: err.message };
  }
}

export function getPreset(id) {
  try {
    const row = getDb()
      .prepare('SELECT id, name, role, app, model, created_at, updated_at FROM worker_presets WHERE id = ?')
      .get(id);
    if (!row) return { ok: false, code: 'not-found', message: 'preset not found' };
    return { ok: true, preset: rowToPreset(row) };
  } catch (err) {
    return { ok: false, code: 'internal', message: err.message };
  }
}
