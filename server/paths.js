// The one place that decides where ccserver keeps anything on disk (issue
// #201). Before this file every module invented its own default inline --
// `join(homedir(), '.local','share','ccserver-sandbox', ...)` copy-pasted
// into a dozen modules, the state JSONs dropped at the repo root, and
// sandbox.config.json living *inside the install tree* where a git pull
// could take it out. Two of those defaults were even resolved twice, in two
// modules, from the same env var (CCSERVER_GROUP_FILES_PATH,
// CCSERVER_SANDBOX_HOME_ROOT).
//
// ============================================================================
// THE ONE RULE. Get this wrong and three production hosts lose their auth
// sessions, their GPG vault key material, their paired federation instances
// and every running group -- on a plain `systemctl --user restart`.
//
//   resolvePath(id):
//     1. env var set            -> its value      (unchanged from today)
//     2. layoutVersion() >= 2   -> the XDG path
//     3. otherwise              -> byte-for-byte TODAY'S path
//
// Deploying this code must not move a single default on its own. The layout
// only switches when the operator has run `npm run setup`, and the switch is
// one atomic fact -- a marker file -- not nineteen independent existsSync()
// guesses.
//
// An existence-based fallback ("use the new path if it exists, else the old
// one") was considered and rejected. It fails two ways: (a) the decision
// becomes per-entry and non-atomic, so booting an older branch once
// re-creates <repo>/.saved-groups.json and the next boot silently picks the
// stale file back up; (b) dbPath() would answer with the new path on an
// un-migrated host, node:sqlite would create an EMPTY DB there, and the
// wizard's never-overwrite rule would then strand the real one forever.
// With a marker, "no marker" means "identical to today", which is provable.
//
// Why the marker is a FILE (<configRoot>/layout.json) and not a DB row:
//   1. dbPath() itself depends on the layout -- a DB-backed marker is a
//      chicken-and-egg.
//   2. It has to survive `git clean` and a re-clone, so it cannot live
//      inside the repo.
//   3. The wizard reads and writes it with the server stopped, matching
//      server/cli/*.js's "never go through HTTP" policy.
//   4. $XDG_CONFIG_HOME is the one location that does not move during the
//      migration.
// layoutVersion is an integer rather than a boolean so a future v3 can
// re-trigger the wizard.
// ============================================================================
//
// Leaf module, same rule as server/db.js's header: node builtins only, and
// of node:fs only the readers. NOTHING here writes to disk -- relocation is
// server/pathMigration.js, driven by an explicit operator CLI.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- XDG base directories ---------------------------------------------------
//
// XDG ON EVERY PLATFORM, macOS INCLUDED. There is no `process.platform`
// branch here and that is a decision, not an oversight -- macOS convention
// would be ~/Library/Application Support/ccserver.
//
// Reasons, in order:
//   1. $XDG_* wins if it is set, and a macOS user who sets it means it. This
//      repo already relies on that: sandbox-seatbelt.js hands opencode
//      XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_STATE_HOME so its host config
//      is reachable from inside the sandbox. Honoring ~/Library instead
//      would ignore an explicit instruction from the operator.
//   2. ccserver is a long-running developer service driven from a terminal,
//      and ~/.config is where its neighbours (git, gh, claude, codex) keep
//      their state on macOS too. ~/Library/Application Support is where GUI
//      apps go.
//   3. One layout means one migration, one docs page, one set of paths in
//      every error message. A second platform layout would double the
//      registry's surface and every test that pins it.
//
// Where a platform branch IS warranted this repo makes one -- git-broker.js's
// hostRuntimeDir() falls back to /tmp on darwin because /run/user does not
// exist there. Nothing equivalent applies to ~/.config or ~/.local.
//
// An empty string counts as unset, matching opencodeUsage.js's authFilePath().
// A relative value is ignored too: the XDG spec requires absolute paths, and
// honoring a relative one would scatter state under whatever cwd the service
// happened to start in.
function xdgBase(envVar, ...fallback) {
  const raw = process.env[envVar];
  if (typeof raw === 'string' && raw !== '' && raw.startsWith('/')) return raw;
  return join(homedir(), ...fallback);
}

export function xdgConfigHome() { return xdgBase('XDG_CONFIG_HOME', '.config'); }
export function xdgDataHome() { return xdgBase('XDG_DATA_HOME', '.local', 'share'); }
export function xdgStateHome() { return xdgBase('XDG_STATE_HOME', '.local', 'state'); }

export function configRoot() { return join(xdgConfigHome(), 'ccserver'); }
export function dataRoot() { return join(xdgDataHome(), 'ccserver'); }
export function stateRoot() { return join(xdgStateHome(), 'ccserver'); }

// The pre-#201 catch-all tree. Built from homedir() LITERALLY and frozen
// that way forever: every module that hardcoded this default did the same,
// so on a host with $XDG_DATA_HOME pointed elsewhere the real files are
// still under ~/.local/share/ccserver-sandbox. Honoring XDG here would make
// the legacy path stop naming the files it is supposed to name -- the exact
// bug that loses data. dataRoot() above is the only one that honors XDG.
export function legacyDataRoot() {
  return join(homedir(), '.local', 'share', 'ccserver-sandbox');
}

// paths.js sits at server/, so '..' is the repo root. NOTE the asymmetry
// with db.js's historical legacyDbPath(): its '..','..' from server/ landed
// on the repo's PARENT (an off-by-one that shipped), while the same
// expression in server/ws/*.js means the repo root. Both spellings are real
// locations that real hosts have files at.
export function repoRoot() { return join(__dirname, '..'); }
export function repoParentDir() { return join(__dirname, '..', '..'); }

// --- layout marker ----------------------------------------------------------

export const CURRENT_LAYOUT_VERSION = 2;
export const LEGACY_LAYOUT_VERSION = 1;

export function layoutMarkerPath() { return join(configRoot(), 'layout.json'); }

// Memoized on the marker path. resolvePath() is a hot path -- loadSandboxConfig()
// calls it on every session launch -- and a readFileSync per call is not
// acceptable there. Safe to cache because the layout cannot change without a
// restart: only the wizard writes the marker, and it runs with the server
// stopped. Same reasoning as auth.js's cachedAuthMode on the client.
let markerCache = null; // { path, value }

export function resetLayoutCache() { markerCache = null; }

export function readLayout() {
  const path = layoutMarkerPath();
  if (markerCache && markerCache.path === path) return markerCache.value;
  let value = null;
  try {
    value = JSON.parse(readFileSync(path, 'utf-8'));
    if (!value || typeof value !== 'object') value = null;
  } catch {
    // Absent is the normal pre-migration state. Corrupt reads as absent too:
    // "fall back to today's paths" is the only safe direction, since the
    // alternative is booting against empty files.
    value = null;
  }
  markerCache = { path, value };
  return value;
}

// CCSERVER_LAYOUT=legacy|xdg forces a layout outright, bypassing both the
// marker and the cache. For tests and e2e, which need a known layout without
// running the wizard; also documented as the escape hatch for a second
// instance on a host whose $XDG_CONFIG_HOME is shared (R12).
export function layoutVersion() {
  const forced = process.env.CCSERVER_LAYOUT;
  if (forced === 'legacy') return LEGACY_LAYOUT_VERSION;
  if (forced === 'xdg') return CURRENT_LAYOUT_VERSION;
  const marker = readLayout();
  const raw = marker?.layoutVersion;
  return Number.isInteger(raw) && raw >= CURRENT_LAYOUT_VERSION ? raw : LEGACY_LAYOUT_VERSION;
}

export function setupRequired() { return layoutVersion() < CURRENT_LAYOUT_VERSION; }

// The `kept` records the wizard writes for entries it deliberately left at
// the legacy location. Authoritative on purpose: deciding "is it still
// over there?" with existsSync on every call would make resolution race an
// empty directory into existence at the new path.
// Validated, not merely read (attack-test-201 F7): `at` has to be an
// ABSOLUTE path string. A relative one used to be accepted verbatim, which
// resolves against whatever cwd the service happened to start in -- so a
// marker carrying "relative/evil" silently relocated the sandbox HOME root.
// A marker restored from a backup or synced from another host can carry
// anything, so a malformed record is ignored rather than trusted, and the
// entry falls back to its normal XDG target.
function keptAt(id) {
  const kept = readLayout()?.kept;
  if (!Array.isArray(kept)) return null;
  const hit = kept.find((k) => k && k.id === id && typeof k.at === 'string' && k.at.startsWith('/'));
  return hit ? hit.at : null;
}

// --- the registry -----------------------------------------------------------

const STATE_FILES = [
  ['savedSessions', 'saved-sessions.json', 'CCSERVER_SAVED_SESSIONS_PATH'],
  ['scheduledPrompts', 'scheduled-prompts.json', 'CCSERVER_SCHEDULES_PATH'],
  ['savedGroups', 'saved-groups.json', 'CCSERVER_GROUPS_PATH'],
  ['savedGroupDocs', 'saved-group-docs.json', 'CCSERVER_GROUP_DOCS_PATH'],
  ['savedGroupFiles', 'saved-group-files.json', 'CCSERVER_GROUP_FILES_PATH'],
  ['savedNotifications', 'saved-notifications.json', 'CCSERVER_NOTIFY_PATH'],
  ['savedVikunjaTasks', 'saved-vikunja-tasks.json', 'CCSERVER_VIKUNJA_TASKS_PATH'],
];

// Each definition:
//   id            stable key (migration plan, layout.json, tests, API)
//   label         what an operator sees printed
//   envVar        explicit override; highest precedence, never migrated
//   kind          'config' | 'data' | 'state' -> which XDG root
//   type          'file' | 'dir'
//   sidecars      file-only: suffixes that move WITH the file (-wal/-shm)
//   target()      the XDG destination
//   legacy()      today's locations, newest spelling first
//   guard         subject to the browseRoots exposure check (D4)
//   stickyLegacy  huge/live tree: stays at the legacy path unless the
//                 operator passes --move-large (see pathMigration.js)
//   ephemeral     throwaway scratch that is recreated, never moved
const REGISTRY = [
  {
    id: 'sandboxConfig',
    label: 'sandbox.config.json',
    envVar: 'CCSERVER_SANDBOX_CONFIG',
    kind: 'config',
    type: 'file',
    target: () => join(configRoot(), 'sandbox.config.json'),
    // Inside the install tree -- the reason this whole issue exists.
    legacy: () => [join(repoRoot(), 'server', 'sandbox.config.json')],
    guard: true,
  },
  ...STATE_FILES.map(([id, name, envVar]) => ({
    id,
    label: name,
    envVar,
    kind: 'state',
    type: 'file',
    target: () => join(stateRoot(), name),
    // The leading dot goes away with the move: nothing is being hidden from
    // anyone inside a dedicated state directory.
    legacy: () => [join(repoRoot(), `.${name}`)],
    guard: true,
  })),
  {
    id: 'db',
    label: 'ccserver.sqlite3',
    envVar: 'CCSERVER_DB_PATH',
    kind: 'data',
    type: 'file',
    sidecars: ['-wal', '-shm'],
    target: () => join(dataRoot(), 'ccserver.sqlite3'),
    // Two historical spellings: the post-#190 default under the sandbox
    // tree, and the pre-#190 one at the repo's PARENT. db.js's
    // migrateLegacyDbFile() still walks the second into the first.
    legacy: () => [join(legacyDataRoot(), 'ccserver.sqlite3'), join(repoParentDir(), 'ccserver.sqlite3')],
    guard: true,
  },
  {
    id: 'federationHome',
    label: 'federation/ (instance.key, instance.crt)',
    envVar: 'CCSERVER_FEDERATION_HOME',
    kind: 'data',
    type: 'dir',
    mode: 0o700,
    target: () => join(dataRoot(), 'federation'),
    legacy: () => [join(legacyDataRoot(), 'federation')],
    // Guards the whole directory, so instance.crt is covered -- the
    // pre-#201 check only listed the key.
    guard: true,
  },
  {
    id: 'groupFiles',
    label: 'group-files/ (グループ共有ファイル)',
    envVar: 'CCSERVER_GROUP_FILES_ROOT',
    kind: 'data',
    type: 'dir',
    target: () => join(dataRoot(), 'group-files'),
    legacy: () => [join(legacyDataRoot(), 'group-files')],
    guard: true,
  },
  {
    id: 'orchestratorGenerated',
    label: 'orchestrator-generated/',
    envVar: 'CCSERVER_ORCHESTRATOR_GENERATED_ROOT',
    kind: 'data',
    type: 'dir',
    target: () => join(dataRoot(), 'orchestrator-generated'),
    legacy: () => [join(legacyDataRoot(), 'orchestrator-generated')],
    guard: true,
  },
  {
    id: 'usageCwd',
    label: 'usage-cwd/',
    envVar: 'CCSERVER_USAGE_CWD',
    kind: 'data',
    type: 'dir',
    target: () => join(dataRoot(), 'usage-cwd'),
    legacy: () => [join(legacyDataRoot(), 'usage-cwd')],
    guard: true,
    // Deliberately kept empty by usage.js (it exists only so bwrap has a cwd
    // to bind); recreated at the new root rather than moved.
    ephemeral: true,
  },
  {
    id: 'codexUsageCwd',
    label: 'codex-usage-cwd/',
    envVar: 'CCSERVER_CODEX_USAGE_CWD',
    kind: 'data',
    type: 'dir',
    target: () => join(dataRoot(), 'codex-usage-cwd'),
    legacy: () => [join(legacyDataRoot(), 'codex-usage-cwd')],
    guard: true,
    ephemeral: true,
  },
  // --- sticky: big, live, or full of absolute paths -------------------------
  // These stay where they are by default. See pathMigration.js's §stickyLegacy
  // comment for the four independent reasons; the short version is that
  // moving them is a silent destruction device and issue #201's actual
  // complaint (state scattered INSIDE the install tree) does not apply to
  // them -- they are already outside it, already under ~/.local/share,
  // already env-overridable. Only the directory NAME is wrong.
  {
    id: 'sandboxHome',
    label: 'home/ (sandbox 永続HOME)',
    envVar: 'CCSERVER_SANDBOX_HOME_ROOT',
    kind: 'data',
    type: 'dir',
    target: () => join(dataRoot(), 'home'),
    legacy: () => [join(legacyDataRoot(), 'home')],
    guard: true,
    stickyLegacy: true,
  },
  {
    id: 'worktrees',
    label: 'worktrees/',
    envVar: 'CCSERVER_WORKTREE_ROOT',
    kind: 'data',
    type: 'dir',
    target: () => join(dataRoot(), 'worktrees'),
    legacy: () => [join(legacyDataRoot(), 'worktrees')],
    guard: true,
    stickyLegacy: true,
  },
  {
    id: 'reviewWorktrees',
    label: 'review-worktrees/',
    envVar: 'CCSERVER_REVIEW_WORKTREE_ROOT',
    kind: 'data',
    type: 'dir',
    target: () => join(dataRoot(), 'review-worktrees'),
    legacy: () => [join(legacyDataRoot(), 'review-worktrees')],
    guard: true,
    stickyLegacy: true,
  },
  {
    id: 'orchestrator',
    label: 'orchestrator/',
    envVar: 'CCSERVER_ORCHESTRATOR_ROOT',
    kind: 'data',
    type: 'dir',
    target: () => join(dataRoot(), 'orchestrator'),
    legacy: () => [join(legacyDataRoot(), 'orchestrator')],
    guard: true,
    stickyLegacy: true,
  },
  {
    id: 'dind',
    label: 'dind/ (docker data-root)',
    envVar: 'CCSERVER_SANDBOX_DIND_ROOT',
    kind: 'data',
    type: 'dir',
    target: () => join(dataRoot(), 'dind'),
    legacy: () => [join(legacyDataRoot(), 'dind')],
    guard: true,
    stickyLegacy: true,
  },
];

export const PATH_IDS = Object.freeze(
  Object.fromEntries(REGISTRY.map((e) => [e.id, e.id])),
);

// --- the test-process guard --------------------------------------------------
//
// Everything above answers with the operator's live locations by default,
// which is what production needs and what makes a TEST that resolves a
// default dangerous: it gets handed the real SQLite DB, the real sidecar
// index, the real state files. That has happened repeatedly on this branch --
// a wizard spawned with the real $HOME, `getDb()` migrating a real database,
// db migration v2 renaming a real .index.json, persistSchedules() deleting a
// real .scheduled-prompts.json -- and every time, the thing that was supposed
// to prevent it was a convention: "remember to set CCSERVER_* in this file's
// before() hook". db.test.js even carried a long comment warning about it,
// and the warning did not reach settingsStore.test.js when that was written
// months later. Conventions do not propagate, and when they break they break
// SILENTLY.
//
// server/testEnvDefaults.js turns the convention into a mechanism: it gives
// every test process a scratch default for all 19 entries. But it is wired in
// through `node --test --import ./testEnvDefaults.js`, so it is still one
// layer of convention -- `node --test server/foo.test.js` run by hand, which
// happens constantly while debugging, skips it and the guard silently
// vanishes again.
//
// So: in a test process, resolving an entry that has NO env var override is
// refused outright. That is the invariant stated directly ("a test must not
// resolve a default path") rather than a proxy for whether some import ran,
// and it converts "quietly touches real data" into "fails on the first line".
//
// Why process.execArgv and not NODE_TEST_CONTEXT: both identify a node:test
// file process, but NODE_TEST_CONTEXT is an env var and is INHERITED by child
// processes (measured), so a server or wizard spawned BY a test would look
// like a test too and refuse to boot. execArgv is per-process and comes back
// empty in a spawned child (measured), which is exactly the scope wanted
// here: this guard covers in-process test code, while spawned children get
// their isolation from testIsolation.js's isolatedEnv/checkoutEnv.
//
// Production cannot trip this. `node server/index.js` and `node --watch
// server/index.js` both have execArgv without any --test* entry (measured),
// and Node refuses --test in NODE_OPTIONS. Evaluated once: it is a fact about
// the process, not about paths, so unlike everything else in this file it is
// safe to freeze at load.
const IN_TEST_PROCESS = process.execArgv.some((a) => a.startsWith('--test'));

// The escape hatch, for the tests whose subject IS the default resolution --
// paths.test.js's legacy-reproduction table (the regression net that proves
// deploying this code moves nothing) and db.test.js's dbPath() defaults.
// Reading it per call rather than freezing it lets a single test turn it on
// around one assertion.
function defaultPathsAllowed() {
  return process.env.CCSERVER_ALLOW_DEFAULT_PATHS === '1';
}

function refuseDefaultPath(def) {
  throw new Error(
    `server/paths.js: refusing to resolve '${def.id}' from its default location inside a test process. `
    + `${def.envVar} is not set, so this would hand the test the real host path `
    + `(${def.legacy()[0]}) -- tests have destroyed real data that way. `
    + 'Run the suite through `npm test`, which loads server/testEnvDefaults.js and points every '
    + 'registry entry at a scratch directory; if you are running a single file by hand, add '
    + '`--import ./testEnvDefaults.js`. If this test\'s subject really is the default resolution, '
    + 'set CCSERVER_ALLOW_DEFAULT_PATHS=1 around it.',
  );
}

function buildEntry(def) {
  const raw = process.env[def.envVar];
  const envValue = typeof raw === 'string' && raw !== '' ? raw : null;
  if (envValue === null && IN_TEST_PROCESS && !defaultPathsAllowed()) refuseDefaultPath(def);
  const target = def.target();
  const legacyPaths = def.legacy();
  const version = layoutVersion();
  const kept = def.stickyLegacy ? keptAt(def.id) : null;

  let path;
  if (envValue) {
    path = envValue;                                  // 1. explicit wins
  } else if (version >= CURRENT_LAYOUT_VERSION) {
    path = kept || target;                            // 2. migrated layout
  } else {
    path = legacyPaths[0];                            // 3. exactly today
  }

  return {
    id: def.id,
    label: def.label,
    envVar: def.envVar,
    kind: def.kind,
    type: def.type,
    mode: def.mode ?? (def.type === 'dir' ? 0o700 : 0o600),
    sidecars: def.sidecars ? [...def.sidecars] : [],
    path,
    target,
    legacyPaths,
    overridden: envValue !== null,
    stickyLegacy: def.stickyLegacy === true,
    ephemeral: def.ephemeral === true,
    keptLegacy: kept !== null,
    keptAt: kept,
    guard: def.guard === true,
  };
}

// Re-resolved on every call, never memoized at module load: the wizard calls
// this before and after a migration, and tests rewrite the env between cases.
// (The marker file read underneath IS cached -- see readLayout.)
export function allPaths() {
  return REGISTRY.map(buildEntry);
}

export function pathEntry(id) {
  const def = REGISTRY.find((e) => e.id === id);
  if (!def) throw new Error(`unknown path registry id: ${id}`);
  return buildEntry(def);
}

// The single function every caller in the codebase goes through.
export function resolvePath(id) {
  return pathEntry(id).path;
}

// browseRoots exposure check (server/index.js, D4).
export function guardedPaths() {
  return allPaths().filter((e) => e.guard);
}

// pathPolicy.js's scratch exemption (R3, security-load-bearing). BOTH roots,
// forever: a session launched before the migration lives under the legacy
// root and must not lose its exemption mid-flight, and one launched after
// lives under the new root. Returning only one of them breaks whichever set
// of sessions is on the other side.
export function scratchRoots() {
  return [dataRoot(), legacyDataRoot()];
}

// The pre-v2 sidecar index, derived rather than registered: it is simply a
// file inside whichever sandbox home is live. Replaces the copy db.js used
// to resolve independently (and that a test had to police for drift).
export function legacyHomeIndexFile() {
  return join(resolvePath(PATH_IDS.sandboxHome), '.index.json');
}
