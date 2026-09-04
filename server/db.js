// SQLite foundation for ccserver's persistent state (plan: sqlite-worker-presets).
//
// Design: lazy singleton + explicit initDb(), deliberately different from the
// other modules' "read env at module load" convention -- reading CCSERVER_DB_PATH
// inside getDb() means tests can set the env before the first call without
// dynamic-import tricks, and a broken DB refuses boot (initDb fail-fast) instead
// of failing lazily on first store access.
//
// Error semantics (do not mix these up):
//   - migration/init failure  -> throw (index.js turns that into log + exit(1))
//   - normal runtime failures -> callers decide; safeDb() exists for the later
//     phases' best-effort operational-state writes, never for user-facing CRUD.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// Leaf modules only (node builtins below them): importing anything that
// reaches back into the stores here would create an evaluation-order cycle
// (stores import getDb from this file).
import { projectHashForCwd } from './ws/projectHash.js';
import { resolveOriginUrl } from './ws/gitAllowlist.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let dbInstance = null;

// Repo-root DB by default (next to .saved-groups.json et al), overridable for
// tests / multi-instance hosts. Read on every getDb() call, never cached.
export function dbPath() {
  return process.env.CCSERVER_DB_PATH || join(__dirname, '..', '..', 'ccserver.sqlite3');
}

function applyPragmas(db) {
  // WAL: concurrent readers during writes (the UI polls while stores persist).
  // NORMAL fsync is the documented WAL pairing. busy_timeout keeps parallel
  // writers (group launches) from failing on a transient lock.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
}

// The pre-v2 sidecar index sandbox.js kept under the sandbox home root
// (slug -> resolved project cwd), imported once by the v2 migration. Mirrors
// sandbox.js's sandboxHomeRoot() -- kept in lockstep deliberately; a test
// asserts the two agree so a future edit to either cannot silently split the
// path.
export function legacyHomeIndexFile() {
  const root = process.env.CCSERVER_SANDBOX_HOME_ROOT
    || join(homedir(), '.local', 'share', 'ccserver-sandbox', 'home');
  return join(root, '.index.json');
}

// v1: worker presets. v2: projects + sandboxes (the formal successor of
// sandbox.js's old homeIndex.json sidecar -- one row per real project
// directory, plus per-project persistent HOME bookkeeping). Later phases move
// more JSON stores onto this mechanism -- one table per store, INTEGER ms
// timestamps, UUID TEXT ids, FKs added by new migrations when both sides exist.
export const MIGRATIONS = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE worker_presets (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          role       TEXT NOT NULL UNIQUE,
          app        TEXT NOT NULL,
          model      TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    },
    // importLegacy(db) -- hook for the later JSON-store migration phases. A
    // migration that imports a legacy file defines it here; the runner calls
    // it inside the same transaction as up(): target tables empty AND legacy
    // file present -> tolerant parse -> INSERT. After the COMMIT succeeds the
    // caller renames the file to `.migrated`; if that rename fails it logs
    // and moves on -- the "don't import into a non-empty table" idempotence
    // guard is what protects the next boot, not the rename.
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE projects (
          id           TEXT PRIMARY KEY,
          cwd          TEXT NOT NULL UNIQUE,
          path_hash    TEXT NOT NULL UNIQUE,
          label        TEXT,
          git_remote   TEXT,
          created_at   INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE TABLE sandboxes (
          slug         TEXT PRIMARY KEY,
          project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
          cwd          TEXT NOT NULL,
          created_at   INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          created_by   TEXT
        );
        CREATE INDEX idx_sandboxes_project_id ON sandboxes(project_id);
      `);
    },
    // One-time import of sandbox.js's legacy sidecar index (slug -> resolved
    // project cwd). The original creation timestamps were never tracked, so
    // both timestamps fall back to "now"; git_remote is filled best-effort
    // (non-git / unreadable repos stay NULL). Runs inside this migration's
    // transaction: any failure rolls the whole v2 back and refuses boot.
    importLegacy(db) {
      let raw;
      try {
        raw = readFileSync(legacyHomeIndexFile(), 'utf-8');
      } catch {
        return; // no legacy index (fresh install, or already migrated)
      }
      let index;
      try {
        index = JSON.parse(raw);
      } catch {
        console.warn('[db] homeIndex.json exists but is not valid JSON; skipping its import');
        return;
      }
      if (!index || typeof index !== 'object' || Array.isArray(index)) return;
      const now = Date.now();
      const findProject = db.prepare('SELECT id FROM projects WHERE cwd = ?');
      const insertProject = db.prepare(
        'INSERT INTO projects (id, cwd, path_hash, label, git_remote, created_at, last_seen_at) VALUES (?, ?, ?, NULL, ?, ?, ?)',
      );
      const insertSandbox = db.prepare(
        'INSERT INTO sandboxes (slug, project_id, cwd, created_at, last_used_at, created_by) VALUES (?, ?, ?, ?, ?, NULL)',
      );
      for (const [slug, cwd] of Object.entries(index)) {
        if (typeof slug !== 'string' || !slug || typeof cwd !== 'string' || !cwd) continue;
        let projectId = findProject.get(cwd)?.id;
        if (!projectId) {
          projectId = randomUUID();
          let origin = null;
          try { origin = resolveOriginUrl(cwd); } catch { /* non-git / unreadable */ }
          insertProject.run(projectId, cwd, projectHashForCwd(cwd), origin, now, now);
        }
        insertSandbox.run(slug, projectId, cwd, now, now);
      }
    },
    // Post-COMMIT retirement of the imported file (see the v1 comment block:
    // file renames cannot join the transaction). The runner wraps every
    // postApply in its own best-effort try/catch.
    postApply() {
      renameSync(legacyHomeIndexFile(), `${legacyHomeIndexFile()}.migrated`);
    },
  },
  {
    // v3: combo launch presets -- a named bundle of N workers (+ orchestrator
    // app/model/instructions preferences) that expands into a POST /groups
    // workers[] snapshot at launch time. A separate table from
    // worker_presets: that one's role is globally UNIQUE, which would forbid
    // reusing the same role across different combos.
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE launch_presets (
          id                 TEXT PRIMARY KEY,
          name               TEXT NOT NULL UNIQUE,
          orchestrator_app   TEXT,
          orchestrator_model TEXT,
          instructions       TEXT,
          created_at         INTEGER NOT NULL,
          updated_at         INTEGER NOT NULL
        );
        CREATE TABLE launch_preset_workers (
          id                TEXT PRIMARY KEY,
          preset_id         TEXT NOT NULL REFERENCES launch_presets(id) ON DELETE CASCADE,
          position          INTEGER NOT NULL,
          name              TEXT,
          role              TEXT NOT NULL,
          app               TEXT NOT NULL,
          model             TEXT,
          sandbox_gpg       INTEGER NOT NULL DEFAULT 0,
          sandbox_ssh_agent INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX idx_launch_preset_workers_role ON launch_preset_workers(preset_id, role);
      `);
    },
  },
  {
    // v4: server-initiated destructive-action approvals (see ws/approvals.js).
    // A meta-agent MCP tool that wants to close a session / destroy a group /
    // delete a sandbox inserts a 'pending' row and blocks on an in-memory
    // waiter until the browser decides via POST /api/approvals/:id/decision
    // or the fixed 5-minute timeout expires it (timeout == rejected, fail-safe).
    version: 4,
    up(db) {
      db.exec(`
        CREATE TABLE pending_approvals (
          id           TEXT PRIMARY KEY,
          kind         TEXT NOT NULL,
          summary      TEXT NOT NULL,
          payload      TEXT NOT NULL,
          requested_by TEXT,
          status       TEXT NOT NULL DEFAULT 'pending',
          created_at   INTEGER NOT NULL,
          resolved_at  INTEGER,
          resolved_by  TEXT
        );
        CREATE INDEX idx_pending_approvals_status ON pending_approvals(status, created_at);
      `);
    },
  },
  {
    // v5: cross-instance (federation) pairing (see ws/federationPairing.js /
    // ws/federationIdentity.js / ws/federationServer.js / ws/federationClient.js).
    // Each instance's own long-lived identity key/cert lives in a FILE (SSH
    // host-key style, 0600 -- see federationIdentity.js), never in this DB;
    // this table only stores the *pinned* facts about the peers we trust.
    //
    // remote_fingerprint is the sole trust anchor (SHA-256 of the peer's
    // whole leaf certificate, as Node's tls.getPeerCertificate().fingerprint256
    // already reports it -- not a hand-rolled SPKI-only digest): CA validation
    // is disabled entirely for the federation TLS listener/client (see
    // federationServer.js), so a connection is only ever trusted by exact
    // match against this column. remote_hostname_claimed/remote_addr are
    // self-reported display strings and MUST NOT be used for authorization.
    //
    // Bidirectional human approval (plan decision 3, 2026-08-24): each side
    // independently records its own human's decision in local_decision, and
    // the last decision it learned about the peer (by asking, see
    // federationPairing.reconcilePending) in remote_decision. `status` is a
    // derived, persisted projection of the pair (local_decision,
    // remote_decision, revoked_at) -- see federationPairing.deriveStatus --
    // kept as a real column (rather than computed on every read) so the
    // existing "WHERE status = ..." index-friendly queries the rest of the
    // codebase's plan describes keep working unchanged.
    version: 5,
    up(db) {
      db.exec(`
        CREATE TABLE paired_instances (
          id                       TEXT PRIMARY KEY,
          label                    TEXT,
          remote_fingerprint       TEXT NOT NULL UNIQUE,
          remote_cert_pem          TEXT NOT NULL,
          remote_hostname_claimed  TEXT,
          remote_addr              TEXT NOT NULL,
          direction                TEXT NOT NULL,
          local_decision           TEXT,
          remote_decision          TEXT,
          status                   TEXT NOT NULL DEFAULT 'pending_local_approval',
          created_at               INTEGER NOT NULL,
          approved_at              INTEGER,
          revoked_at               INTEGER,
          last_seen_at             INTEGER
        );
        CREATE INDEX idx_paired_instances_status ON paired_instances(status);
        CREATE INDEX idx_paired_instances_fingerprint ON paired_instances(remote_fingerprint);
      `);
    },
  },
  {
    // v6: ccserver-reviewer job history (see ws/reviewer.js). One row per
    // run_review call -- a disposable headless session running /code-review
    // against a local git ref/branch/PR/uncommitted diff. Unlike the
    // in-memory-mirrored JSON stores (.scheduled-prompts.json,
    // .saved-notifications.json), this data is meant to accumulate and be
    // queried by id/status/project (list_reviews/get_review), so it goes
    // straight into SQLite like every other post-v1 store.
    version: 6,
    up(db) {
      db.exec(`
        CREATE TABLE pr_reviews (
          id             TEXT PRIMARY KEY,
          project_cwd    TEXT NOT NULL,
          base_ref       TEXT NOT NULL,
          head_ref       TEXT,
          resolved_ref   TEXT,
          pr_owner       TEXT,
          pr_repo        TEXT,
          pr_number      INTEGER,
          mode           TEXT NOT NULL,
          app            TEXT NOT NULL,
          model          TEXT,
          status         TEXT NOT NULL DEFAULT 'running',
          session_id     TEXT,
          worktree_path  TEXT,
          result_summary TEXT,
          posted_to_pr   INTEGER NOT NULL DEFAULT 0,
          requested_by   TEXT,
          focus          TEXT,
          created_at     INTEGER NOT NULL,
          finished_at    INTEGER
        );
        CREATE INDEX idx_pr_reviews_project_cwd ON pr_reviews(project_cwd);
        CREATE INDEX idx_pr_reviews_status ON pr_reviews(status);
      `);
    },
  },
];

// Runs pending migrations in order. Each one executes inside BEGIN IMMEDIATE
// with its user_version bump in the same transaction (SQLite DDL is
// transactional; user_version lives atomically in the DB header), so a failed
// migration leaves the DB exactly as before -- then we fail fast.
// postApply(db?) runs AFTER its migration's COMMIT, outside any transaction:
// best-effort side effects that must not influence correctness (retiring an
// imported legacy file). Its failure is logged and skipped -- the importLegacy
// idempotence guard is what protects the next boot, not postApply.
export function migrate(db, migrations = MIGRATIONS) {
  const current = Number(db.prepare('PRAGMA user_version').get().user_version);
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      m.up(db);
      if (typeof m.importLegacy === 'function') m.importLegacy(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already unwound */ }
      throw new Error(`db migration v${m.version} failed: ${err.message}`);
    }
    if (typeof m.postApply === 'function') {
      try {
        m.postApply(db);
      } catch (err) {
        console.warn(`[db] v${m.version} postApply failed (continuing): ${err.message}`);
      }
    }
  }
}

export function getDb() {
  if (dbInstance) return dbInstance;
  if (typeof DatabaseSync !== 'function') {
    throw new Error('ccserver requires Node >= 22.13 (node:sqlite)');
  }
  const path = dbPath();
  if (path !== ':memory:') {
    try { mkdirSync(dirname(path), { recursive: true }); } catch { /* open will report */ }
  }
  const db = new DatabaseSync(path);
  applyPragmas(db);
  migrate(db);
  dbInstance = db;
  return dbInstance;
}

// Explicit startup init for index.js: same work as getDb(), but named for the
// boot-time contract -- a failure here must refuse the launch (log + exit(1)),
// not surface later as a 500 from some unrelated route.
export function initDb() {
  getDb();
}

// Test seam (and shutdown helper): closes the singleton so the next getDb()
// re-opens from disk -- how the "survives a restart" behavior is exercised
// in-process.
export function closeDb() {
  if (!dbInstance) return;
  const db = dbInstance;
  dbInstance = null;
  try { db.close(); } catch { /* best effort */ }
}

// Best-effort wrapper for the later phases' operational-state writes (the
// groups/schedules hot paths whose JSON persistence today swallows errors).
// Deliberately NOT used by user-facing CRUD: those must surface failures.
export function safeDb(fn, fallback) {
  try {
    return fn(getDb());
  } catch (err) {
    console.warn(`[db] operation failed (best-effort): ${err.message}`);
    return fallback;
  }
}
