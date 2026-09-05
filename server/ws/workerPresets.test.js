import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizePresetInput,
  listPresets,
  createPreset,
  updatePreset,
  deletePreset,
  getPreset,
} from './workerPresets.js';
import { closeDb } from '../db.js';

// Same withConfig helper as sandbox-config.test.js: point loadSandboxConfig
// at a temp sandbox.config.json for the duration of fn(), so hiddenApps can
// be exercised without touching a real deployment config.
function withConfig(json, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-worker-presets-config-'));
  const path = join(dir, 'sandbox.config.json');
  try {
    writeFileSync(path, JSON.stringify(json));
    const prev = process.env.CCSERVER_SANDBOX_CONFIG;
    process.env.CCSERVER_SANDBOX_CONFIG = path;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
      else process.env.CCSERVER_SANDBOX_CONFIG = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let tmpRoot;
const savedHomeRoot = process.env.CCSERVER_SANDBOX_HOME_ROOT;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-worker-presets-'));
  // getDb() reads this lazily on first store call, so setting it in before()
  // (before any store call) is enough -- no dynamic-import tricks needed.
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'presets.sqlite3');
  // Keep the v2 migration's importLegacy away from the host's real
  // .index.json (a fresh test DB would otherwise import -- and postApply
  // RENAME -- it as a side effect).
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
});

after(() => {
  closeDb();
  delete process.env.CCSERVER_DB_PATH;
  if (savedHomeRoot === undefined) delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  else process.env.CCSERVER_SANDBOX_HOME_ROOT = savedHomeRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('normalizePresetInput accepts a valid preset and trims fields', () => {
  const n = normalizePresetInput({ name: ' 実装担当 ', role: ' workerImplement ', app: 'codex', model: ' gpt-5.4 ' });
  assert.equal(n.ok, true);
  assert.deepEqual(n.value, { name: '実装担当', role: 'workerImplement', app: 'codex', model: 'gpt-5.4' });
});

test('normalizePresetInput normalizes empty model to null and keeps null model', () => {
  assert.equal(normalizePresetInput({ name: 'x', role: 'workerX', app: 'claude', model: '' }).value.model, null);
  assert.equal(normalizePresetInput({ name: 'x', role: 'workerX', app: 'claude', model: null }).value.model, null);
  assert.equal(normalizePresetInput({ name: 'x', role: 'workerX', app: 'claude' }).value.model, null);
});

test('normalizePresetInput rejects bad names', () => {
  for (const name of ['', '   ', 'a'.repeat(81), 42, null]) {
    const n = normalizePresetInput({ name, role: 'workerX', app: 'claude' });
    assert.equal(n.ok, false, `name ${JSON.stringify(name)} must be rejected`);
    assert.ok(n.errors.some((e) => /name/.test(e)));
  }
  assert.equal(normalizePresetInput({ role: 'workerX', app: 'claude' }).ok, false, 'missing name rejected');
  // 80 characters is exactly at the limit.
  assert.equal(normalizePresetInput({ name: 'あ'.repeat(80), role: 'workerX', app: 'claude' }).ok, true);
});

test('normalizePresetInput rejects control characters in the name', () => {
  for (const ch of ['\u0000', '\u0007', '\u001f', '\u007f']) {
    const n = normalizePresetInput({ name: `bad${ch}name`, role: 'workerX', app: 'claude' });
    assert.equal(n.ok, false);
    assert.ok(n.errors.some((e) => /control/.test(e)), `${JSON.stringify(ch)} reported as control character`);
  }
});

test('normalizePresetInput enforces the worker role regex (orchestrator excluded by the pattern itself)', () => {
  for (const role of ['orchestrator', 'WorkerA', 'worker a', 'worker/a', '', 'helper']) {
    assert.equal(normalizePresetInput({ name: 'x', role, app: 'claude' }).ok, false, `role ${JSON.stringify(role)} rejected`);
  }
  for (const role of ['workerA', 'workerImplement', 'worker-extra', 'worker_2', 'workerC']) {
    assert.equal(normalizePresetInput({ name: 'x', role, app: 'claude' }).ok, true, `role ${role} accepted`);
  }
  assert.equal(normalizePresetInput({ name: 'x', role: 'worker'.padEnd(80, 'a'), app: 'claude' }).ok, true, '80 chars ok');
  assert.equal(normalizePresetInput({ name: 'x', role: 'worker'.padEnd(81, 'a'), app: 'claude' }).ok, false, '81 chars rejected');
});

test('normalizePresetInput whitelists apps without copilot', () => {
  assert.equal(normalizePresetInput({ name: 'x', role: 'workerX', app: 'copilot' }).ok, false);
  assert.equal(normalizePresetInput({ name: 'x', role: 'workerX', app: 'gemini' }).ok, false);
  assert.equal(normalizePresetInput({ name: 'x', role: 'workerX', app: 'opencode' }).ok, true);
});

test('normalizePresetInput bounds the model length and type', () => {
  assert.equal(normalizePresetInput({ name: 'x', role: 'workerX', app: 'claude', model: 'm'.repeat(200) }).ok, true);
  assert.equal(normalizePresetInput({ name: 'x', role: 'workerX', app: 'claude', model: 'm'.repeat(201) }).ok, false);
  assert.equal(normalizePresetInput({ name: 'x', role: 'workerX', app: 'claude', model: 5 }).ok, false);
});

test('normalizePresetInput workers[] mode allows missing name/app', () => {
  const n = normalizePresetInput({ role: 'workerSolo' }, { allowMissingName: true, allowMissingApp: true });
  assert.equal(n.ok, true);
  assert.deepEqual(n.value, { name: null, role: 'workerSolo', app: null, model: null });
  // Explicit copilot is still refused even when app is otherwise optional.
  assert.equal(normalizePresetInput({ role: 'workerSolo', app: 'copilot' }, { allowMissingName: true, allowMissingApp: true }).ok, false);
});

test('CRUD round-trip: create returns a server-generated UUID and timestamps', () => {
  const res = createPreset({ name: '実装担当', role: 'workerImplement', app: 'codex', model: 'gpt-5.4' });
  assert.equal(res.ok, true);
  assert.match(res.preset.id, /^[0-9a-f-]{36}$/);
  assert.equal(res.preset.name, '実装担当');
  assert.equal(res.preset.role, 'workerImplement');
  assert.equal(res.preset.app, 'codex');
  assert.equal(res.preset.model, 'gpt-5.4');
  assert.equal(typeof res.preset.createdAt, 'number');
  assert.equal(typeof res.preset.updatedAt, 'number');

  const list = listPresets();
  assert.equal(list.ok, true);
  assert.equal(list.presets.length, 1);
  assert.deepEqual(list.presets[0], res.preset);
});

test('duplicate roles are refused with duplicate-role (DB UNIQUE backstop)', () => {
  createPreset({ name: 'one', role: 'workerDup', app: 'claude' });
  const res = createPreset({ name: 'two', role: 'workerDup', app: 'opencode' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'duplicate-role');
  assert.match(res.message, /already exists/);
});

test('invalid input is refused with validation and leaves the DB untouched', () => {
  const before = listPresets().presets.length;
  const res = createPreset({ name: 'broken', role: 'not-a-worker', app: 'claude' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'validation');
  assert.equal(listPresets().presets.length, before, 'nothing inserted');
});

test('update replaces all fields, keeps id/created_at, bumps updated_at', async () => {
  const created = createPreset({ name: 'old', role: 'workerUpd', app: 'claude' }).preset;
  await new Promise((r) => setTimeout(r, 5));
  const res = updatePreset(created.id, { name: 'new', role: 'workerUpd2', app: 'opencode', model: 'm1' });
  assert.equal(res.ok, true);
  assert.equal(res.preset.id, created.id);
  assert.equal(res.preset.createdAt, created.createdAt, 'created_at preserved');
  assert.ok(res.preset.updatedAt >= created.updatedAt);
  assert.equal(res.preset.name, 'new');
  assert.equal(res.preset.role, 'workerUpd2');
  assert.equal(res.preset.app, 'opencode');
  assert.equal(res.preset.model, 'm1');

  // Updating to a role owned by ANOTHER preset is duplicate-role...
  const other = createPreset({ name: 'other', role: 'workerOther', app: 'claude' }).preset;
  const clash = updatePreset(created.id, { name: 'x', role: other.role, app: 'claude' });
  assert.equal(clash.ok, false);
  assert.equal(clash.code, 'duplicate-role');
  // ...while re-saving a row's own role is fine.
  assert.equal(updatePreset(other.id, { name: 'other2', role: 'workerOther', app: 'claude' }).ok, true);
});

test('update/delete of an unknown id return not-found', () => {
  assert.equal(updatePreset('nope-id', { name: 'x', role: 'workerX', app: 'claude' }).code, 'not-found');
  assert.equal(deletePreset('nope-id').code, 'not-found');
  assert.equal(getPreset('nope-id').code, 'not-found');
});

test('delete removes the preset; the freed role is reusable', () => {
  const p = createPreset({ name: 'gone soon', role: 'workerGone', app: 'codex' }).preset;
  assert.equal(deletePreset(p.id).ok, true);
  assert.equal(listPresets().presets.some((x) => x.id === p.id), false);
  assert.equal(createPreset({ name: 'reuse', role: 'workerGone', app: 'claude' }).ok, true, 'UNIQUE slot freed');
});

test('createPreset/updatePreset refuse an app hidden via sandbox.config.json\'s hiddenApps (issue #105)', () => {
  withConfig({ hiddenApps: ['codex'] }, () => {
    const res = createPreset({ name: 'hidden app', role: 'workerHiddenCreate', app: 'codex' });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'validation');
    assert.match(res.message, /codex.*hidden/);
    assert.equal(listPresets().presets.some((p) => p.role === 'workerHiddenCreate'), false, 'nothing inserted');
  });

  // A preset created while codex was still visible must not be silently
  // re-savable with the same now-hidden app either.
  const p = createPreset({ name: 'was visible', role: 'workerHiddenUpdate', app: 'codex' }).preset;
  withConfig({ hiddenApps: ['codex'] }, () => {
    const res = updatePreset(p.id, { name: 'still codex', role: 'workerHiddenUpdate', app: 'codex' });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'validation');
    // The stored row must be untouched by the rejected update.
    assert.equal(getPreset(p.id).preset.name, 'was visible');
  });
  // Same preset, same app -- once codex is visible again, saving succeeds.
  assert.equal(updatePreset(p.id, { name: 'still codex', role: 'workerHiddenUpdate', app: 'codex' }).ok, true);
});

test('presets survive closeDb + reopen (restart simulation)', () => {
  const p = createPreset({ name: 'persist me', role: 'workerPersist', app: 'claude', model: null }).preset;
  closeDb();
  const list = listPresets();
  assert.equal(list.ok, true);
  const found = list.presets.find((x) => x.id === p.id);
  assert.ok(found, 'preset still listed after reopening the DB');
  assert.deepEqual(found, p, 'identical row content (model NULL included)');
});
