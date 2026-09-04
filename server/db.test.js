import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dbPath, getDb, initDb, closeDb, migrate, safeDb, MIGRATIONS } from './db.js';

let tmpRoot;
const savedEnv = process.env.CCSERVER_DB_PATH;
const savedHomeRoot = process.env.CCSERVER_SANDBOX_HOME_ROOT;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-db-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  // The v2 importLegacy reads sandbox.js's legacy sidecar index under
  // CCSERVER_SANDBOX_HOME_ROOT. Without this override a host that still has a
  // real .index.json would leak its entries into every fresh test DB -- and
  // postApply would RENAME the user's real index as a test side effect.
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
});

after(() => {
  closeDb();
  if (savedEnv === undefined) delete process.env.CCSERVER_DB_PATH;
  else process.env.CCSERVER_DB_PATH = savedEnv;
  if (savedHomeRoot === undefined) delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  else process.env.CCSERVER_SANDBOX_HOME_ROOT = savedHomeRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('fresh open runs migrations to the latest version', () => {
  closeDb();
  const db = getDb();
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS[MIGRATIONS.length - 1].version);
  // The v1 table exists and is usable.
  db.prepare('INSERT INTO worker_presets (id, name, role, app, model, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('x', 'n', 'workerX', 'claude', null, 1, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM worker_presets').get().c, 1);
  // v2 tables exist and are usable.
  db.prepare('INSERT INTO projects (id, cwd, path_hash, label, git_remote, created_at, last_seen_at) VALUES (?,?,?,NULL,NULL,1,1)')
    .run('p1', '/srv/proj', 'h'.repeat(24));
  db.prepare('INSERT INTO sandboxes (slug, project_id, cwd, created_at, last_used_at, created_by) VALUES (?,?,?,?,?,NULL)')
    .run('srv_proj', 'p1', '/srv/proj', 1, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sandboxes').get().c, 1);
  // v5 table exists, usable, and enforces the UNIQUE(remote_fingerprint)
  // constraint the whole trust model rests on (see federationPairing.js).
  db.prepare(`INSERT INTO paired_instances
      (id, label, remote_fingerprint, remote_cert_pem, remote_hostname_claimed, remote_addr, direction, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('pi1', null, 'FP:X', 'PEM', 'host-a', '10.0.0.1:3210', 'inbound_initiated', 'pending_local_approval', 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM paired_instances').get().c, 1);
  assert.throws(() => {
    db.prepare(`INSERT INTO paired_instances
        (id, label, remote_fingerprint, remote_cert_pem, remote_hostname_claimed, remote_addr, direction, status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('pi2', null, 'FP:X', 'PEM2', 'host-b', '10.0.0.2:3210', 'outbound_initiated', 'pending_local_approval', 2);
  }, /UNIQUE/, 'remote_fingerprint is the sole trust anchor -- a duplicate must be impossible at the schema level');
  // v6 table exists and is usable (see ws/reviewer.js).
  db.prepare(`INSERT INTO pr_reviews
      (id, project_cwd, base_ref, head_ref, mode, app, status, created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
    .run('r1', '/srv/proj', 'origin/master', 'feature/x', 'branch', 'claude', 'running', 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM pr_reviews').get().c, 1);
});

test('reopening is idempotent (migrations do not re-apply) and data survives', () => {
  closeDb();
  getDb(); // first open creates + migrates
  closeDb();
  const db = getDb(); // second open
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS[MIGRATIONS.length - 1].version);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM worker_presets').get().c, 1, 'row from the previous handle is still there');
  // Re-running migrate() directly is a no-op once user_version matches.
  assert.doesNotThrow(() => migrate(db));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS[MIGRATIONS.length - 1].version);
});

test('pragmas are applied on open', () => {
  const db = getDb();
  assert.match(String(db.prepare('PRAGMA journal_mode').get().journal_mode), /wal/);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  // NORMAL = 1
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1);
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
});

test('initDb() resolves the same singleton as getDb()', () => {
  closeDb();
  initDb();
  assert.equal(getDb(), getDb(), 'both entry points share one instance per generation');
});

test('dbPath() defaults to the repo root and honors CCSERVER_DB_PATH', () => {
  const saved = process.env.CCSERVER_DB_PATH;
  try {
    delete process.env.CCSERVER_DB_PATH;
    assert.ok(dbPath().endsWith(join('server', '..', 'ccserver.sqlite3')) || /[\\/]ccserver\.sqlite3$/.test(dbPath()), 'default is <repo>/ccserver.sqlite3');
    process.env.CCSERVER_DB_PATH = '/tmp/somewhere/x.sqlite3';
    assert.equal(dbPath(), '/tmp/somewhere/x.sqlite3');
  } finally {
    if (saved === undefined) delete process.env.CCSERVER_DB_PATH;
    else process.env.CCSERVER_DB_PATH = saved;
  }
});

test('a failing migration throws, rolls back, and leaves no partial schema', () => {
  const db = new DatabaseSync(':memory:');
  const badMigrations = [
    {
      version: 1,
      up(d) {
        d.exec('CREATE TABLE should_rollback (id TEXT)');
        d.exec('CREATE TABLE definitely_broken (');
      },
    },
  ];
  assert.throws(() => migrate(db, badMigrations), /^Error: db migration v1 failed:/);
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 0, 'user_version bump rolled back with the migration');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='should_rollback'").all();
  assert.equal(tables.length, 0, 'DDL from the failed migration was rolled back');
});

test('a failing importLegacy hook aborts its migration transaction too', () => {
  const db = new DatabaseSync(':memory:');
  assert.throws(() => migrate(db, [
    {
      version: 1,
      up(d) { d.exec('CREATE TABLE t (id TEXT)'); },
      importLegacy() { throw new Error('legacy file unreadable'); },
    },
  ]), /db migration v1 failed: legacy file unreadable/);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t'").all().length, 0);
});

test('safeDb returns the fn result on success and the fallback on failure', () => {
  closeDb();
  assert.equal(safeDb((db) => db.prepare('PRAGMA user_version').get().user_version, -1), MIGRATIONS[MIGRATIONS.length - 1].version, 'first call initializes the DB');
  assert.equal(safeDb(() => { throw new Error('boom'); }, 'fb'), 'fb');
});
