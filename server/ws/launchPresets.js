// Launch preset store (SQLite, DB v3): a named bundle of N worker specs (+ an
// optional orchestrator app/model/instructions preference) that expands into
// a POST /groups workers[] snapshot at LAUNCH time -- never re-read live
// ("The server never re-reads a preset at launch time", same contract as
// workerPresets.js). A separate table from worker_presets on purpose: that
// one's role is globally UNIQUE, which would forbid reusing the same role in
// different combos; here roles are unique per preset only.
//
// Validation reuses workerPresets' normalizePresetInput so a preset and its
// expanded snapshot can never diverge from what POST /groups accepts. Unlike
// combo workers[], a preset's app is REQUIRED (launch_preset_workers.app is
// NOT NULL): a saved combo must reproduce its apps exactly instead of falling
// back to whatever defaultApp is configured at some later launch date.
//
// Error semantics follow workerPresets.js: user-facing CRUD returns
// { ok:false, code, message } result objects (validation -> 400,
// duplicate-name -> 409, not-found -> 404, internal -> 500).

import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import {
  normalizePresetInput,
  PRESET_APPS,
} from './workerPresets.js';

const NAME_MAX = 80;
const MODEL_MAX = 200;
const INSTRUCTIONS_MAX = 8 * 1024;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function isUniqueViolation(err) {
  return err?.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || /UNIQUE constraint failed/.test(err?.message || '');
}

function rowToPreset(row) {
  return {
    id: row.id,
    name: row.name,
    orchestratorApp: row.orchestrator_app ?? null,
    orchestratorModel: row.orchestrator_model ?? null,
    instructions: row.instructions ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToWorker(row) {
  return {
    id: row.id,
    position: row.position,
    name: row.name ?? null,
    role: row.role,
    app: row.app,
    model: row.model ?? null,
    sandboxOpts: { gpg: !!row.sandbox_gpg, sshAgent: !!row.sandbox_ssh_agent },
  };
}

// Pure validation for one worker entry of a preset payload. Reuses the shared
// preset rules (name optional -> role label fallback; copilot refused; model
// string-or-null) and adds the required app + per-preset role uniqueness.
export function normalizePresetWorker(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const n = normalizePresetInput(src, { allowMissingName: true });
  if (!n.ok) return n;
  if (!src.app || !PRESET_APPS.includes(src.app)) {
    // Same contract as workerPresets.js: keep the "copilot is not supported
    // in groups" substring the E2E suite matches on.
    return { ok: false, errors: ['app must be claude, opencode, or codex (copilot is not supported in groups; commandcode neither)'] };
  }
  const hasOwn = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const opts = src.sandboxOpts && typeof src.sandboxOpts === 'object'
    ? { gpg: !!src.sandboxOpts.gpg, sshAgent: !!src.sandboxOpts.sshAgent }
    : { gpg: false, sshAgent: false };
  return {
    ok: true,
    value: {
      ...n.value,
      app: src.app,
      sandboxOpts: opts,
      // Whether the caller actually passed each field (update replaces the
      // whole preset, so this mirrors normalizeWorkers' presence handling).
      present: { name: hasOwn('name'), model: hasOwn('model') },
    },
  };
}

// Pure normalization/validation for a full preset payload.
//   name              required, unique across presets (DB UNIQUE backstop)
//   orchestratorApp   null/absent allowed (group default at launch); otherwise
//                     a PRESET_APPS entry
//   orchestratorModel null/'' -> null; else trimmed string 1-MODEL_MAX
//   instructions      null/'' -> null; else trimmed string <= INSTRUCTIONS_MAX
//   workers           required array of 1..MAX_WORKERS entries (see above);
//                     roles must be unique within THIS preset
export function normalizeLaunchPresetInput(input, { maxWorkers }) {
  const source = input && typeof input === 'object' ? input : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(source, k);
  const errors = [];
  let name = null;
  if (has('name') && source.name !== null && source.name !== undefined && source.name !== '') {
    if (typeof source.name !== 'string') {
      errors.push('name must be a string');
    } else {
      const t = source.name.trim();
      if (!t || t.length > NAME_MAX) errors.push(`name must be 1-${NAME_MAX} characters`);
      else if (CONTROL_CHARS_RE.test(t)) errors.push('name must not contain control characters');
      else name = t;
    }
  } else {
    errors.push(`name must be 1-${NAME_MAX} characters`);
  }

  let orchestratorApp = null;
  if (has('orchestratorApp') && source.orchestratorApp !== null && source.orchestratorApp !== undefined && source.orchestratorApp !== '') {
    if (!PRESET_APPS.includes(source.orchestratorApp)) {
      errors.push('orchestratorApp must be claude, opencode, or codex');
    } else {
      orchestratorApp = source.orchestratorApp;
    }
  }

  let orchestratorModel = null;
  if (has('orchestratorModel') && source.orchestratorModel !== null && source.orchestratorModel !== undefined && source.orchestratorModel !== '') {
    if (typeof source.orchestratorModel !== 'string') {
      errors.push('orchestratorModel must be a string or null');
    } else {
      const t = source.orchestratorModel.trim();
      if (!t || t.length > MODEL_MAX) errors.push(`orchestratorModel must be 1-${MODEL_MAX} characters`);
      else orchestratorModel = t;
    }
  }

  let instructions = null;
  if (has('instructions') && source.instructions !== null && source.instructions !== undefined && source.instructions !== '') {
    if (typeof source.instructions !== 'string') {
      errors.push('instructions must be a string or null');
    } else {
      const t = source.instructions.trim();
      if (!t || t.length > INSTRUCTIONS_MAX) errors.push(`instructions must be 1-${INSTRUCTIONS_MAX} characters`);
      else instructions = t;
    }
  }

  let workers = null;
  const rawWorkers = source.workers;
  if (!Array.isArray(rawWorkers)) {
    errors.push('workers must be an array');
  } else if (rawWorkers.length < 1 || rawWorkers.length > maxWorkers) {
    errors.push(`workers must contain 1-${maxWorkers} entries`);
  } else {
    const seen = new Set();
    const out = [];
    let workerErrors = null;
    for (const [i, raw] of rawWorkers.entries()) {
      const w = normalizePresetWorker(raw);
      if (!w.ok) {
        (workerErrors ??= []).push(...w.errors.map((e) => `workers[${i}]: ${e}`));
        continue;
      }
      if (seen.has(w.value.role)) {
        (workerErrors ??= []).push(`workers[${i}]: duplicate worker role: ${w.value.role}`);
        continue;
      }
      seen.add(w.value.role);
      out.push(w.value);
    }
    if (workerErrors) errors.push(...workerErrors);
    else workers = out.map((w, i) => ({
      name: w.present.name ? w.name : null,
      role: w.role,
      app: w.app,
      model: w.present.model ? w.model : null,
      sandboxOpts: w.sandboxOpts,
      position: i,
    }));
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { name, orchestratorApp, orchestratorModel, instructions, workers },
  };
}

export function getPresetWorkers(presetId) {
  try {
    const rows = getDb()
      .prepare(`SELECT id, preset_id, position, name, role, app, model, sandbox_gpg, sandbox_ssh_agent
                FROM launch_preset_workers WHERE preset_id = ? ORDER BY position ASC, id ASC`)
      .all(presetId);
    return { ok: true, workers: rows.map(rowToWorker) };
  } catch (err) {
    return { ok: false, code: 'internal', message: err.message };
  }
}

export function getLaunchPreset(id) {
  if (typeof id !== 'string' || !id) return { ok: false, code: 'not-found', message: 'launch preset not found' };
  try {
    const row = getDb()
      .prepare(`SELECT id, name, orchestrator_app, orchestrator_model, instructions, created_at, updated_at
                FROM launch_presets WHERE id = ?`)
      .get(id);
    if (!row) return { ok: false, code: 'not-found', message: 'launch preset not found' };
    const workers = getPresetWorkers(id);
    if (!workers.ok) return workers;
    return { ok: true, preset: { ...rowToPreset(row), workers: workers.workers } };
  } catch (err) {
    return { ok: false, code: 'internal', message: err.message };
  }
}

export function listLaunchPresets() {
  try {
    const rows = getDb()
      .prepare(`SELECT id, name, orchestrator_app, orchestrator_model, instructions, created_at, updated_at
                FROM launch_presets ORDER BY created_at ASC, id ASC`)
      .all();
    const workersByPreset = new Map();
    const workerRows = getDb()
      .prepare(`SELECT id, preset_id, position, name, role, app, model, sandbox_gpg, sandbox_ssh_agent
                FROM launch_preset_workers ORDER BY position ASC, id ASC`)
      .all();
    for (const r of workerRows) {
      if (!workersByPreset.has(r.preset_id)) workersByPreset.set(r.preset_id, []);
      workersByPreset.get(r.preset_id).push(rowToWorker(r));
    }
    return {
      ok: true,
      presets: rows.map((row) => ({ ...rowToPreset(row), workers: workersByPreset.get(row.id) || [] })),
    };
  } catch (err) {
    return { ok: false, code: 'internal', message: err.message };
  }
}

const insertWorkerStmt = () => getDb().prepare(
  `INSERT INTO launch_preset_workers (id, preset_id, position, name, role, app, model, sandbox_gpg, sandbox_ssh_agent)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

function replaceWorkers(presetId, workers) {
  getDb().prepare('DELETE FROM launch_preset_workers WHERE preset_id = ?').run(presetId);
  for (const w of workers) {
    insertWorkerStmt().run(randomUUID(), presetId, w.position, w.name, w.role, w.app, w.model, w.sandboxOpts.gpg ? 1 : 0, w.sandboxOpts.sshAgent ? 1 : 0);
  }
}

export function createLaunchPreset(input, { maxWorkers } = {}) {
  if (!maxWorkers || !Number.isFinite(maxWorkers) || maxWorkers < 1) {
    throw new Error('createLaunchPreset requires a positive integer maxWorkers option');
  }
  const n = normalizeLaunchPresetInput(input, { maxWorkers });
  if (!n.ok) return { ok: false, code: 'validation', message: n.errors.join('; '), errors: n.errors };
  const id = randomUUID();
  const now = Date.now();
  try {
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO launch_presets (id, name, orchestrator_app, orchestrator_model, instructions, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, n.value.name, n.value.orchestratorApp, n.value.orchestratorModel, n.value.instructions, now, now);
      replaceWorkers(id, n.value.workers);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already unwound */ }
      throw err;
    }
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, code: 'duplicate-name', message: `a launch preset named "${n.value.name}" already exists` };
    }
    return { ok: false, code: 'internal', message: err.message };
  }
  return getLaunchPreset(id);
}

export function updateLaunchPreset(id, input, { maxWorkers } = {}) {
  if (!maxWorkers || !Number.isFinite(maxWorkers) || maxWorkers < 1) {
    throw new Error('updateLaunchPreset requires a positive integer maxWorkers option');
  }
  if (typeof id !== 'string' || !id) return { ok: false, code: 'not-found', message: 'launch preset not found' };
  const existing = getLaunchPreset(id);
  if (!existing.ok) return existing;
  const n = normalizeLaunchPresetInput(input, { maxWorkers });
  if (!n.ok) return { ok: false, code: 'validation', message: n.errors.join('; '), errors: n.errors };
  const now = Date.now();
  try {
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE launch_presets SET name = ?, orchestrator_app = ?, orchestrator_model = ?, instructions = ?, updated_at = ?
                  WHERE id = ?`)
        .run(n.value.name, n.value.orchestratorApp, n.value.orchestratorModel, n.value.instructions, now, id);
      replaceWorkers(id, n.value.workers); // full snapshot replace, positions renumbered
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already unwound */ }
      throw err;
    }
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, code: 'duplicate-name', message: `a launch preset named "${n.value.name}" already exists` };
    }
    return { ok: false, code: 'internal', message: err.message };
  }
  return getLaunchPreset(id);
}

export function deleteLaunchPreset(id) {
  if (typeof id !== 'string' || !id) return { ok: false, code: 'not-found', message: 'launch preset not found' };
  try {
    const res = getDb().prepare('DELETE FROM launch_presets WHERE id = ?').run(id);
    if (res.changes === 0) return { ok: false, code: 'not-found', message: 'launch preset not found' };
    // Workers go with it (ON DELETE CASCADE + foreign_keys=ON in db.js; the
    // explicit sweep below keeps the guarantee independent of that pragma).
    getDb().prepare('DELETE FROM launch_preset_workers WHERE preset_id = ?').run(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'internal', message: err.message };
  }
}
