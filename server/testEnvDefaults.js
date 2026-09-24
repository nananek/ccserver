// Loaded into EVERY test process via `node --test --import ./testEnvDefaults.js`
// (see this workspace's "test" script). NOT a test file -- it defines no
// tests and `node --test` does not discover this name.
//
// THE INVARIANT: no test process ever resolves a real host path.
//
// server/paths.js answers with the operator's live locations by default, and
// that is correct -- it is what production needs. But it means a test process
// that merely imports a store gets pointed at real data, in two ways that no
// single environment tweak covers:
//
//   $HOME.       legacyDataRoot() is homedir()-based on purpose and ignores
//                $XDG_DATA_HOME, so the SQLite DB (auth sessions, GPG vault
//                key material, paired instances), the federation private key,
//                group-files, the sandbox HOMEs, worktrees and the dind
//                data-root all resolve under the operator's real home.
//   THE CHECKOUT. repoRoot() is import.meta.url-based, so nothing moves it.
//                server/sandbox.config.json and the seven state JSONs at the
//                repo root live there, and on an un-migrated host those are
//                LIVE files.
//
// Both were reached without any wizard involved, just by normal store
// behavior. Each line below was reproduced by running the suite against a
// DECOY layout -- a throwaway $HOME seeded to look like a pre-#201 host, plus
// decoy files in the checkout -- and checking what came back changed:
//
//   getDb()                             opens dbPath() and runs migrations on
//                                       it. The decoy home's ccserver.sqlite3
//                                       came back with a different checksum.
//   db migration v2's postApply         renameSync(legacyHomeIndexFile()).
//                                       The decoy home's home/.index.json came
//                                       back as .index.json.migrated.
//   sessionManager.persistSchedules()   unlinkSync(schedulesPath()) when the
//                                       schedule list goes empty. The decoy
//                                       .scheduled-prompts.json in the
//                                       checkout was gone.
//   sessionManager.gracefulShutdown()   writeFileSync(savedSessionsPath())
//   groupManager.persistGroups() and
//   its docs/files siblings             unlinkSync() their file when the last
//                                       group is destroyed
//
// On a developer's machine $HOME is their real home, so those same three
// lines land on their real DB, their real sidecar index and their real state
// files. That inference is the point of the decoy: it is what the code does
// with whatever $HOME and repoRoot() resolve to.
//
// About a dozen test files are exposed, and the fix used to be "remember to
// set the right CCSERVER_* in this file's before() hook". That is a
// convention, and a convention is what a future test forgets -- forgetting
// one is precisely how this branch's Critical data-loss defect happened. So
// default the WHOLE registry to a per-process scratch directory, here, once.
//
// A test that sets its own value still wins: this only fills in what the
// environment leaves unset. paths.test.js, which asserts the real defaults,
// deletes every CCSERVER_* in its beforeEach and is unaffected. And
// testIsolation.js strips CCSERVER_* back out when it builds a child env, so
// nothing here leaks into a spawned wizard or server -- those get their own
// explicit isolation.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mirrors server/paths.js's registry: every entry's env var, and a name for
// it inside the scratch directory. testIsolation.test.js pins the
// checkout-derived subset against the registry, and paths.test.js pins that
// every entry HAS an env var, so a new entry cannot appear without a place
// here to put it.
const REGISTRY_DEFAULTS = [
  // Inside the checkout before migration -- see the header.
  ['CCSERVER_SANDBOX_CONFIG', 'sandbox.config.json'],
  ['CCSERVER_SAVED_SESSIONS_PATH', 'saved-sessions.json'],
  ['CCSERVER_SCHEDULES_PATH', 'scheduled-prompts.json'],
  ['CCSERVER_GROUPS_PATH', 'saved-groups.json'],
  ['CCSERVER_GROUP_DOCS_PATH', 'saved-group-docs.json'],
  ['CCSERVER_GROUP_FILES_PATH', 'saved-group-files.json'],
  ['CCSERVER_NOTIFY_PATH', 'saved-notifications.json'],
  ['CCSERVER_VIKUNJA_TASKS_PATH', 'saved-vikunja-tasks.json'],
  // Under the operator's real $HOME before migration.
  ['CCSERVER_DB_PATH', 'ccserver.sqlite3'],
  ['CCSERVER_FEDERATION_HOME', 'federation'],
  ['CCSERVER_GROUP_FILES_ROOT', 'group-files'],
  ['CCSERVER_ORCHESTRATOR_GENERATED_ROOT', 'orchestrator-generated'],
  ['CCSERVER_USAGE_CWD', 'usage-cwd'],
  ['CCSERVER_CODEX_USAGE_CWD', 'codex-usage-cwd'],
  ['CCSERVER_SANDBOX_HOME_ROOT', 'home'],
  ['CCSERVER_WORKTREE_ROOT', 'worktrees'],
  ['CCSERVER_REVIEW_WORKTREE_ROOT', 'review-worktrees'],
  ['CCSERVER_ORCHESTRATOR_ROOT', 'orchestrator'],
  ['CCSERVER_SANDBOX_DIND_ROOT', 'dind'],
];

const root = mkdtempSync(join(tmpdir(), 'ccserver-test-state-'));

for (const [envVar, name] of REGISTRY_DEFAULTS) {
  if (!process.env[envVar]) process.env[envVar] = join(root, name);
}

// One scratch directory per test process -- `node --test` gives each file its
// own process, so these never collide.
process.on('exit', () => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});
