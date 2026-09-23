// Issue #201 Step4 (decision D2). The table ships empty, so these tests are
// really a contract for #205: the shapes exercised below (an active-profile
// pointer in 'global', named profiles in their own scope) are the ones the
// network allowlist will land in.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, closeDb } from './db.js';
import {
  getSetting, getScope, listScopeIds, setSetting, setScope,
  deleteSetting, deleteScope, scopeUpdatedAt,
} from './settingsStore.js';

let tmpRoot;
const savedDbPath = process.env.CCSERVER_DB_PATH;
const savedHomeRoot = process.env.CCSERVER_SANDBOX_HOME_ROOT;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-settings-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  // Migrating a fresh DB runs v2's importLegacy/postApply, which read AND
  // RENAME sandbox.js's legacy sidecar index under CCSERVER_SANDBOX_HOME_ROOT
  // -- on a pre-v2 host that is the operator's real
  // ~/.local/share/ccserver-sandbox/home/.index.json. Same hazard db.test.js
  // documents at length; anything that opens a DB has to override this.
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
});

after(() => {
  closeDb();
  if (savedDbPath === undefined) delete process.env.CCSERVER_DB_PATH;
  else process.env.CCSERVER_DB_PATH = savedDbPath;
  if (savedHomeRoot === undefined) delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  else process.env.CCSERVER_SANDBOX_HOME_ROOT = savedHomeRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().prepare('DELETE FROM settings').run();
});

test('v10 created the settings table with the (scope, scope_id, key) primary key', () => {
  const cols = getDb().prepare('PRAGMA table_info(settings)').all();
  assert.deepEqual(cols.map((c) => c.name), ['scope', 'scope_id', 'key', 'value', 'updated_at', 'updated_by']);
  assert.deepEqual(cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
    ['scope', 'scope_id', 'key']);
});

test('every JSON type round-trips unchanged', () => {
  const cases = {
    str: 'hello',
    num: 42,
    float: 1.5,
    yes: true,
    no: false,
    nil: null,
    obj: { a: 1, nested: { b: [1, 2] } },
    arr: ['github.com', 'npmjs.org'],
    empty: {},
  };
  for (const [key, value] of Object.entries(cases)) setSetting('t', '', key, value);
  for (const [key, value] of Object.entries(cases)) {
    assert.deepEqual(getSetting('t', '', key), value, key);
  }
});

test('a stored null is a value, not an absence', () => {
  setSetting('t', '', 'k', null);
  assert.equal(getSetting('t', '', 'k', 'FALLBACK'), null);
  assert.equal(getSetting('t', '', 'missing', 'FALLBACK'), 'FALLBACK');
});

test('an unset key returns the fallback, and an unknown scope is {}', () => {
  assert.equal(getSetting('nope', '', 'nope'), undefined);
  assert.equal(getSetting('nope', '', 'nope', 7), 7);
  assert.deepEqual(getScope('nope', ''), {});
  assert.deepEqual(listScopeIds('nope'), []);
  assert.equal(scopeUpdatedAt('nope', ''), null);
});

test('setSetting upserts rather than duplicating', () => {
  setSetting('t', '', 'k', 'first');
  setSetting('t', '', 'k', 'second');
  assert.equal(getSetting('t', '', 'k'), 'second');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM settings').get().n, 1);
});

test('scopes are isolated from each other and from scope_ids', () => {
  setSetting('a', '', 'k', 'a-global');
  setSetting('a', 'one', 'k', 'a-one');
  setSetting('b', '', 'k', 'b-global');
  assert.equal(getSetting('a', '', 'k'), 'a-global');
  assert.equal(getSetting('a', 'one', 'k'), 'a-one');
  assert.equal(getSetting('b', '', 'k'), 'b-global');
});

test('setScope with replace deletes the keys the new object does not have', () => {
  setScope('p', 'strict', { allowedHosts: ['a'], deniedHosts: ['b'], stale: true });
  setScope('p', 'strict', { allowedHosts: ['c'] }, { replace: true });
  assert.deepEqual(getScope('p', 'strict'), { allowedHosts: ['c'] });
});

test('setScope without replace merges into what is already there', () => {
  setScope('p', 'strict', { allowedHosts: ['a'], mode: 'deny' });
  setScope('p', 'strict', { mode: 'allow' });
  assert.deepEqual(getScope('p', 'strict'), { allowedHosts: ['a'], mode: 'allow' });
});

test('a setScope that throws partway leaves the previous scope untouched', () => {
  setScope('p', 'strict', { keep: 'me' });
  // A value JSON.stringify refuses (a BigInt) aborts the transaction.
  assert.throws(() => setScope('p', 'strict', { a: 1, bad: 1n }, { replace: true }));
  assert.deepEqual(getScope('p', 'strict'), { keep: 'me' }, 'the rollback must restore the deleted rows');
});

test('#205\'s shape: an active-profile pointer plus named profiles', () => {
  setSetting('global', '', 'network.activeProfile', 'strict');
  setScope('network-profile', 'strict', { allowedHosts: ['github.com'], mode: 'allow' });
  setScope('network-profile', 'open', { allowedHosts: [], mode: 'allow' });

  assert.equal(getSetting('global', '', 'network.activeProfile'), 'strict');
  assert.deepEqual(listScopeIds('network-profile'), ['open', 'strict']);
  assert.deepEqual(getScope('network-profile', 'strict'), { allowedHosts: ['github.com'], mode: 'allow' });

  assert.equal(deleteScope('network-profile', 'open'), 2, 'deleting a profile is one statement');
  assert.deepEqual(listScopeIds('network-profile'), ['strict']);
});

test('deleteSetting reports whether a row was actually removed', () => {
  setSetting('t', '', 'k', 1);
  assert.equal(deleteSetting('t', '', 'k'), true);
  assert.equal(deleteSetting('t', '', 'k'), false);
});

test('scopeUpdatedAt tracks the newest write in the scope', async () => {
  setSetting('t', '', 'a', 1);
  const first = scopeUpdatedAt('t', '');
  assert.ok(Number.isInteger(first));
  await new Promise((r) => setTimeout(r, 5));
  setSetting('t', '', 'b', 2);
  assert.ok(scopeUpdatedAt('t', '') >= first);
});

test('updated_by is recorded when the caller supplies it', () => {
  setSetting('t', '', 'k', 1, { updatedBy: 'cli' });
  assert.equal(getDb().prepare('SELECT updated_by FROM settings WHERE key = ?').get('k').updated_by, 'cli');
  setSetting('t', '', 'k', 2);
  assert.equal(getDb().prepare('SELECT updated_by FROM settings WHERE key = ?').get('k').updated_by, null);
});

test('a row holding invalid JSON reads as the fallback instead of throwing', () => {
  getDb().prepare('INSERT INTO settings (scope, scope_id, key, value, updated_at) VALUES (?,?,?,?,?)')
    .run('t', '', 'broken', '{not json', Date.now());
  assert.equal(getSetting('t', '', 'broken', 'SAFE'), 'SAFE');
  setSetting('t', '', 'fine', 1);
  assert.deepEqual(getScope('t', ''), { fine: 1 }, 'one bad row must not poison the scope');
});

test('★ F9: a __proto__ row cannot pollute the object getScope returns', () => {
  getDb().prepare('INSERT INTO settings (scope, scope_id, key, value, updated_at) VALUES (?,?,?,?,?)')
    .run('t', '', '__proto__', JSON.stringify({ polluted: true }), Date.now());
  setSetting('t', '', 'ok', 1);

  const scope = getScope('t', '');
  assert.equal(Object.getPrototypeOf(scope), Object.prototype, 'the prototype must be untouched');
  assert.equal(scope.polluted, undefined);
  assert.equal(({}).polluted, undefined, 'and nothing global may be affected');
  assert.deepEqual(scope, { ok: 1 }, 'the reserved row is dropped, the real one survives');
});
