// Builds the command line to launch Claude Code (or a shell) inside a
// filesystem sandbox, so it cannot read adjacent projects. When docker is
// enabled, a rootless dockerd is started *inside* the sandbox so that
// containers/volumes stay confined to the exposed paths.
//
// Architecture (docker on):
//   rootlesskit (outer, provides subuid userns + slirp4netns networking)
//     -> bwrap (inner, no --unshare-user, restricts the filesystem)
//        -> sandbox-entrypoint.sh
//           -> dockerd (background) + target command (claude/shell)
//
// Architecture (docker off): plain bwrap (--unshare-user) -> entrypoint -> target.
//
// The ordering matters: bwrap creating the user namespace would break
// newuidmap (no subuid mapping -> single uid), so rootlesskit must be the
// outer layer. See memory: sandbox-dind-recipe.

import { homedir } from 'node:os';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGitBroker } from './git-broker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(__dirname, 'sandbox-entrypoint.sh');
const GH_WRAPPER_SCRIPT = join(__dirname, 'sandbox-gh-wrapper.cjs');
const CRED_HELPER_SCRIPT = join(__dirname, 'sandbox-git-credential-helper.cjs');
const SSH_WRAPPER_SCRIPT = join(__dirname, 'sandbox-ssh-wrapper.cjs');
const GENERATED_GITCONFIG = join(__dirname, 'sandbox-gitconfig');
const DEFAULT_KNOWN_HOSTS = join(__dirname, 'sandbox-known-hosts');
const SSH_CONFIG_FILE = join(__dirname, 'sandbox-ssh-config');

const BWRAP = '/usr/bin/bwrap';
const ROOTLESSKIT = '/usr/bin/rootlesskit';
const BASH = '/usr/bin/bash';

// Fixed in-sandbox paths for the git-broker machinery (see buildBwrapArgs).
const SANDBOX_NODE_PATH = '/ccserver-sandbox-node';
const SANDBOX_CRED_HELPER_PATH = '/ccserver-sandbox-git-credential-helper.cjs';
const SANDBOX_ALLOWLIST_PATH = '/ccserver-sandbox-git-allowlist.json';
const SANDBOX_BROKER_SOCK_PATH = '/ccserver-sandbox-git-broker.sock';
const SANDBOX_REAL_SSH_PATH = '/ccserver-sandbox-real-ssh';
const SANDBOX_SSH_CONFIG_PATH = '/ccserver-sandbox-ssh-config';
const SANDBOX_KNOWN_HOSTS_USER_PATH = '/ccserver-sandbox-known-hosts-user';
const SANDBOX_KNOWN_HOSTS_DEFAULT_PATH = '/ccserver-sandbox-known-hosts-default';

// Fixed in-sandbox paths for the MCP bridge (see mcpBroker.js / mcpConfig.js):
// the group's control or handoff socket is bound at SANDBOX_MCP_SOCK_PATH and
// the byte-pipe wrapper script at SANDBOX_MCP_BRIDGE_PATH, which the agent
// CLIs are told to run via --mcp-config / OPENCODE_CONFIG_CONTENT. The
// process-global notify socket (ccserver-notify, see notify.js) is bound at a
// second fixed path the same wrapper reaches when invoked with the 'notify'
// argument. The process-global usage socket (ccserver-usage, see
// usageMcp.js) is bound at a third fixed path, reached with the 'usage'
// argument.
const SANDBOX_MCP_SOCK_PATH = '/ccserver-sandbox-mcp.sock';
const SANDBOX_NOTIFY_SOCK_PATH = '/ccserver-sandbox-notify.sock';
const SANDBOX_USAGE_SOCK_PATH = '/ccserver-sandbox-usage.sock';
const SANDBOX_MCP_BRIDGE_PATH = '/ccserver-sandbox-mcp-bridge';
const MCP_BRIDGE_SCRIPT = join(__dirname, 'sandbox-mcp-wrapper.cjs');

const HOME = homedir();
// process.getuid is undefined on Windows; the sandbox is Linux-only, but this
// module is imported unconditionally, so guard the top-level access.
const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || `/run/user/${UID}`;

// RootlessKit's state dir (holds the API socket dockerd connects to) lives
// under the runtime dir on the host; bwrap binds it in so dockerd can reach it.
// It MUST be unique per launch: rootlesskit flocks <state-dir>/lock, so a shared
// path lets a still-running (or slowly-torn-down) sandbox block the next one
// with "another RootlessKit is running with the same state directory". A fresh
// dir per session also means a leaked sandbox never blocks a new launch.
function newStateDir() {
  return join(XDG_RUNTIME_DIR, `dockerd-rootless-${randomUUID()}`);
}

// Where per-project docker data-roots (images/layers) live, so they persist
// across sessions of the same project. Overridable via
// CCSERVER_SANDBOX_DIND_ROOT for tests/alternate layouts.
function dindRoot() {
  return process.env.CCSERVER_SANDBOX_DIND_ROOT
    || join(HOME, '.local', 'share', 'ccserver-sandbox', 'dind');
}

// Where each project's persistent writable HOME lives (see buildBwrapArgs).
// Bound at HOME inside the sandbox so tools/caches installed by a previous
// session of the same project survive a relaunch. Overridable via
// CCSERVER_SANDBOX_HOME_ROOT for tests/alternate layouts.
export function sandboxHomeRoot() {
  return process.env.CCSERVER_SANDBOX_HOME_ROOT
    || join(HOME, '.local', 'share', 'ccserver-sandbox', 'home');
}

// The lock file a rootless dockerd holds (flock, see sandbox-entrypoint.sh's
// $DATA_ROOT/.ccserver-dockerd.lock) for the whole daemon lifetime. Its
// presence on the host tells us whether a daemon -- possibly leaked from an
// old session -- is still using a data-root.
const DOCKERD_LOCK_NAME = '.ccserver-dockerd.lock';

// Written by sandbox-entrypoint.sh the instant its background dockerd wins
// the DOCKERD_LOCK_NAME flock, containing that launch's CCSANDBOX_DOCKERD_TAG
// (see buildBwrapArgs). Lets dockerdStatus() below identify WHICH session
// currently holds a project's data-root -- flock itself only exposes
// held/free, not the holder's identity. Stale (not cleared) once written: a
// session that exits never erases its tag, so after it's gone the file still
// names it until some *future* launch wins the flock and overwrites it. A
// mismatched tag therefore does NOT by itself mean "held by another live
// session" -- it can equally mean "held by nobody, this is just leftover
// history" (a session mid-startup, before it has raced for the flock, would
// otherwise misread that as a hard, non-retriable conflict). Callers must
// pair this with dindLockHeld() to tell the two apart (see
// sessionManager.dockerAvailability, the only consumer).
const DOCKERD_STATUS_NAME = '.ccserver-dockerd.status';

// True when a (live or leaked) dockerd currently holds the data-root lock for
// this sandbox slug. Deletion must be refused then: the daemon's live overlay
// mounts defeat every removal strategy (EBUSY) and deleting under a running
// daemon would corrupt the data-root. flock(1) is the same util-linux binary
// the entrypoint uses; -n makes it exit non-zero immediately when the lock is
// held. A missing flock (ENOENT) must NOT hard-block deletion, so only a
// non-ENOENT failure counts as "held".
function dindLockHeld(name) {
  const lock = join(dindRoot(), name, DOCKERD_LOCK_NAME);
  if (!existsSync(lock)) return false;
  try {
    execFileSync('flock', ['-n', lock, 'true'], { stdio: 'ignore' });
    return false;
  } catch (err) {
    return err.code !== 'ENOENT';
  }
}

// cwd-keyed wrapper around dindLockHeld(), for callers outside this module
// that only ever address data-roots by cwd (mirrors dockerdStatus() below).
export function dockerdLockHeld(cwd) {
  return dindLockHeld(slugify(cwd));
}

// The CCSANDBOX_DOCKERD_TAG of whichever launch most recently won this
// project's dockerd flock (see DOCKERD_STATUS_NAME), or null before any
// session has ever started dockerd for this cwd. `cwd` must be the exact
// same string a session was launched with -- this mirrors buildBwrapArgs'
// `slugify(cwd)` (no resolve()) exactly, so the read path always matches
// that session's own write path (see sessionManager.dockerAvailability, the
// only consumer).
export function dockerdStatus(cwd) {
  const path = join(dindRoot(), slugify(cwd), DOCKERD_STATUS_NAME);
  try {
    return readFileSync(path, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

// Recursively remove a directory tree, escalating through successively more
// privileged strategies when a plain rmSync hits a permission error. Returns
// null on success, or an error message when every strategy failed (the caller
// turns that into a clean HTTP error instead of an opaque EACCES 500).
function removeTree(path) {
  if (!existsSync(path)) return null;
  const tryRemove = (fn) => {
    try {
      fn();
      if (!existsSync(path)) return true;
    } catch {
      // fall through to the next strategy
    }
    return false;
  };
  if (tryRemove(() => rmSync(path, { recursive: true, force: true }))) return null;
  // The offending dirs may be OURS but locked down (mode 000). As owner,
  // chmod -R u+rwx fixes listing with no namespace dance; cheap retry.
  if (tryRemove(() => {
    chmodSync(path, 0o700);
    execFileSync('chmod', ['-R', 'u+rwx', path], { stdio: 'ignore' });
    rmSync(path, { recursive: true, force: true });
  })) return null;
  if (tryRemove(() => removeTreeViaRootlesskit(path))) return null;
  if (tryRemove(() => removeTreeViaSudo(path))) return null;
  return `permission denied removing ${path}; run manually: sudo rm -rf "${path}"`;
}

// The persistent docker data-root is written by a rootless dockerd running
// inside a user namespace, so files created by container processes as a
// non-root uid are owned on the host by a subuid (e.g. 100000+ for the ast
// user) -- uids the ccserver process can neither read nor delete. containerd's
// overlayfs snapshot dirs
// (…/io.containerd.snapshotter.v1.overlayfs/snapshots/<id>/…) are exactly
// where those subuid-owned files land, which is why deleting a data-root used
// to fail with "EACCES: permission denied, scandir …/work/work". A fresh
// rootlesskit --net=none userns uses the SAME subuid mapping the sandbox used,
// so there the files are owned by mapped (non-root) uids that userns-root's
// capabilities make deletable.
function removeTreeViaRootlesskit(path) {
  if (!existsSync(ROOTLESSKIT)) return;
  const stateDir = join(XDG_RUNTIME_DIR, `ccserver-dind-cleanup-${randomUUID()}`);
  mkdirSync(stateDir, { recursive: true });
  try {
    execFileSync(ROOTLESSKIT, [
      `--state-dir=${stateDir}`,
      '--net=none',
      '--disable-host-loopback',
      'rm', '-rf', path,
    ], { stdio: 'ignore', timeout: 120_000 });
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Last resort for trees owned by a real root OUTSIDE the userns mapping (e.g.
// a data-root created by a server that once ran as root): passwordless sudo.
// Only ever runs when plain removal failed and sudo -n is actually configured.
function removeTreeViaSudo(path) {
  try {
    execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore' });
    execFileSync('sudo', ['-n', 'rm', '-rf', path], { stdio: 'ignore', timeout: 120_000 });
  } catch {
    // no passwordless sudo, or sudo itself failed
  }
}

// Deterministic per-project path of the persistent HOME. resolve() normalizes
// spelling variants (trailing slash, "..", ...) so they all map to one dir,
// mirroring orchestratorDirForCwd in routes/groups.js.
export function persistentHomeDir(cwd) {
  return join(sandboxHomeRoot(), slugify(resolve(cwd)));
}

// Public status for the reuse dialog: whether persistent HOME is enabled at
// all (sandbox.config.json's persistentHome) and whether a previous sandbox
// already left state for this cwd.
export function sandboxHomeStatus(cwd) {
  const enabled = loadSandboxConfig().persistentHome;
  const path = persistentHomeDir(cwd);
  let exists = false;
  try { exists = statSync(path).isDirectory(); } catch { /* not there yet */ }
  return { enabled, exists, path };
}

// Sidecar index mapping a home dir's slug back to the project path it was
// created for (the settings page shows real paths instead of opaque slugs).
// Lives in the home root itself -- OUTSIDE every sandbox's HOME -- so a
// sandboxed process never sees it. Best-effort: a missing/corrupt index just
// falls back to displaying the slug.
function homeIndexPath() {
  return join(sandboxHomeRoot(), '.index.json');
}

function readHomeIndex() {
  try {
    const raw = JSON.parse(readFileSync(homeIndexPath(), 'utf-8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

// Remember the project path a persistent HOME was created for. Called from
// buildSandboxSpawn; sync (single-threaded) so concurrent launches can't race.
function recordSandboxHome(cwd) {
  const slug = slugify(resolve(cwd));
  const index = readHomeIndex();
  if (index[slug] === resolve(cwd)) return;
  index[slug] = resolve(cwd);
  try { writeFileSync(homeIndexPath(), JSON.stringify(index)); } catch { /* best effort */ }
}

// Enumerate the persistent sandbox homes for the settings page:
//   { name (slug), path, cwd (real project path when the index knows it) }
export function listSandboxHomes() {
  const root = sandboxHomeRoot();
  const index = readHomeIndex();
  const entries = [];
  let names = [];
  try { names = readdirSync(root); } catch { return []; }
  for (const name of names) {
    const path = join(root, name);
    let isDir = false;
    try { isDir = statSync(path).isDirectory(); } catch { /* not a dir */ }
    if (!isDir) continue;
    entries.push({ name, path, cwd: typeof index[name] === 'string' ? index[name] : null });
  }
  return entries;
}

// Apparent size in bytes of a sandbox home (du -sb; recursive stat fallback).
export function sandboxHomeSize(path) {
  try {
    const out = execFileSync('du', ['-sb', path], { encoding: 'utf-8', timeout: 30_000 });
    const m = /^\s*(\d+)/.exec(out);
    if (m) return Number(m[1]);
  } catch { /* fall through to the stat walk */ }
  let total = 0;
  const walk = (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) {
      let children;
      try { children = readdirSync(p); } catch { return; }
      for (const c of children) walk(join(p, c));
    } else {
      total += st.size;
    }
  };
  walk(path);
  return total;
}

// Delete a sandbox: its persistent HOME plus the matching docker data-root
// (both keyed by the same slug). Name must be a bare slug (no separators) so
// the caller can never escape the roots. The in-use guard lives in the route
// (see sessionManager.sandboxHomeInUsePath). Removal is permission-tolerant:
// containerd overlayfs snapshot dirs can be owned by subuid-mapped uids the
// server can't read (see removeTree), and a still-running dockerd must block
// the whole delete rather than corrupt its data-root (dindLockHeld).
export function deleteSandboxHome(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    return { ok: false, error: 'invalid-sandbox-name' };
  }
  if (dindLockHeld(name)) {
    return { ok: false, error: 'docker-daemon-in-use' };
  }
  const homeErr = removeTree(join(sandboxHomeRoot(), name));
  const dindErr = removeTree(join(dindRoot(), name));
  if (homeErr || dindErr) {
    // Keep the index entry on partial failure so the settings page still
    // shows the sandbox and the user can retry.
    return { ok: false, error: homeErr || dindErr };
  }
  const index = readHomeIndex();
  if (Object.prototype.hasOwnProperty.call(index, name)) {
    delete index[name];
    try { writeFileSync(homeIndexPath(), JSON.stringify(index)); } catch { /* best effort */ }
  }
  return { ok: true };
}

// PATH set inside the sandbox at runtime (see buildBwrapArgs' --setenv PATH
// below). Resolving the bare "claude" command for install-dir detection must
// search this PATH, not the host ccserver process's own PATH: a personal PATH
// shim ahead of it there (e.g. a ~/.dotfiles/bin/claude wrapper that nests its
// own bwrap sandbox around /usr/bin/claude) is never on the sandboxed PATH, so
// resolving against the host PATH makes claudeInstallDir follow a wrapper the
// sandbox will never actually invoke -- silently missing the real install dir
// and leaving the sandboxed launch to fail with exit 127.
export const SANDBOX_PATH = `${join(HOME, '.local', 'bin')}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return join(HOME, p.slice(2));
  return p;
}

function slugify(p) {
  return p.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root';
}

// Load the optional sandbox config. Path from CCSERVER_SANDBOX_CONFIG, else
// server/sandbox.config.json (next to this module's parent). Shape:
//   { "docker": true, "binds": [ { "src": "~/.ssh", "mode": "ro" }, ... ] }
export function loadSandboxConfig() {
  const configPath = process.env.CCSERVER_SANDBOX_CONFIG
    || join(__dirname, '..', 'sandbox.config.json');
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    raw = {};
  }
  const docker = raw.docker !== false; // default on
  // Keep a persistent writable HOME per project (~/.local/share/ccserver-
  // sandbox/home/<project>, see persistentHomeDir) so tools/caches installed
  // inside the sandbox survive a session relaunch; the client offers a reuse
  // dialog and "new" wipes it. false restores the legacy fresh-tmpfs-HOME.
  const persistentHome = raw.persistentHome !== false; // default on
  const gpg = raw.gpg === true;        // forward gpg-agent + ~/.gnupg (opt-in)
  // Forward the host's ssh-agent socket (opt-in, like gpg). Not needed for
  // HTTPS git (gitBroker handles that entirely host-side, see below) or for
  // commit signing (that's the gpg flag above); this only matters for SSH git
  // remotes or running `ssh` directly inside the sandbox. Off by default
  // because a forwarded agent is real standing access to the host's keys for
  // the whole sandboxed process, not just git -- see the docker+gitBroker
  // bypass warning below for how much a live agent socket widens the hole.
  const sshAgent = raw.sshAgent === true;
  // Repo-scoped git credential broker: HTTPS credential helper + SSH gate,
  // both checked against the session cwd's own repo + submodules, and gh
  // CLI disabled (its API calls can't be repo-scoped without TLS
  // termination). Default on -- this replaces the old raw ~/.ssh /
  // ~/.config/gh exposure, which is blocked unconditionally regardless of
  // this flag (see the extraBinds filter below).
  const gitBroker = raw.gitBroker !== false;
  // Forbid launching the agent (or a shell) outside the sandbox: every session
  // is forced sandboxed, and a launch is refused -- instead of falling back to
  // a direct (unsandboxed) spawn -- when bwrap is unavailable (or on Windows).
  // Also blocks /usage's direct-launch fallback; see usage.js. Default off.
  const forceSandbox = raw.forceSandbox === true;
  // ccserver-notify (see notify.js): the Discord webhook the notify MCP tool
  // delivers to, plus the initial subscription seed (https webhook URLs only --
  // a non-https URL is dropped, never trusted as a delivery target). The
  // optional env override CCSERVER_DISCORD_WEBHOOK wins over the config file,
  // so the webhook URL never has to live in a file at all.
  const rawNotify = (raw.notify && typeof raw.notify === 'object') ? raw.notify : {};
  let discordWebhook = null;
  for (const candidate of [process.env.CCSERVER_DISCORD_WEBHOOK, rawNotify.discordWebhook]) {
    if (typeof candidate === 'string' && candidate.startsWith('https://')) {
      discordWebhook = candidate;
      break;
    }
  }
  const subscriptions = Array.isArray(rawNotify.subscriptions)
    ? rawNotify.subscriptions
      .filter((s) => s && typeof s === 'object' && typeof s.url === 'string' && s.url.startsWith('https://'))
      .map((s) => ({ url: s.url, name: typeof s.name === 'string' && s.name.length > 0 ? s.name : null }))
    : [];
  // Attribution overrides for ccserver-notify payloads (see notify.js):
  // notify.hostname pins the "_from:" host when the OS hostname is opaque or
  // several hosts share a webhook (CCSERVER_HOSTNAME env wins over both, set
  // in loadNotifyConfig); notify.attribution === false strips the footer
  // entirely (default on).
  const notifyHostname = typeof rawNotify.hostname === 'string' && rawNotify.hostname.length > 0 ? rawNotify.hostname : null;
  const notifyAttribution = rawNotify.attribution !== false;
  // Vikunja task tracking (see vikunjaClient.js): a `notify` call also
  // creates/updates a Vikunja task so a missed Discord ping still leaves a
  // TODO behind. Same env > config > default priority as discordWebhook
  // above; the API token is secret, so CCSERVER_VIKUNJA_API_TOKEN is the
  // recommended way to set it (README).
  const rawVikunja = (rawNotify.vikunja && typeof rawNotify.vikunja === 'object') ? rawNotify.vikunja : {};
  let vikunjaBaseUrl = null;
  for (const candidate of [process.env.CCSERVER_VIKUNJA_BASE_URL, rawVikunja.baseUrl]) {
    if (typeof candidate === 'string' && candidate.startsWith('https://')) {
      vikunjaBaseUrl = candidate.replace(/\/+$/, '');
      break;
    }
  }
  let vikunjaApiToken = null;
  for (const candidate of [process.env.CCSERVER_VIKUNJA_API_TOKEN, rawVikunja.apiToken]) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      vikunjaApiToken = candidate;
      break;
    }
  }
  const vikunjaProjectId = process.env.CCSERVER_VIKUNJA_PROJECT_ID || rawVikunja.projectId || null;
  const vikunjaTimeoutSecondsRaw = process.env.CCSERVER_VIKUNJA_TIMEOUT_SECONDS || rawVikunja.timeoutSeconds;
  const vikunjaTimeoutSeconds = Number.isFinite(Number(vikunjaTimeoutSecondsRaw)) && Number(vikunjaTimeoutSecondsRaw) > 0
    ? Number(vikunjaTimeoutSecondsRaw)
    : 15;
  const vikunjaVerifyTlsRaw = process.env.CCSERVER_VIKUNJA_VERIFY_TLS ?? rawVikunja.verifyTls;
  const vikunjaVerifyTls = !(vikunjaVerifyTlsRaw === false || vikunjaVerifyTlsRaw === 'false');
  const vikunjaStatusLabelPrefix = process.env.CCSERVER_VIKUNJA_STATUS_LABEL_PREFIX
    || (typeof rawVikunja.statusLabelPrefix === 'string' && rawVikunja.statusLabelPrefix ? rawVikunja.statusLabelPrefix : 'status-');
  const binds = Array.isArray(raw.binds) ? raw.binds : [];
  const env = (raw.env && typeof raw.env === 'object') ? raw.env : {};
  // How to launch claude. Overridable because the install location is
  // environment-specific (see resolveClaude). Env var wins over the config file.
  const claudeBin = process.env.CCSERVER_CLAUDE_BIN || (typeof raw.claudeBin === 'string' ? raw.claudeBin : null);
  // Which agent a new session launches when the client doesn't request one.
  // See appLaunch.js's APPS; anything else (including unset) falls back to
  // claude -- see sessionManager.js's defaultApp().
  const defaultApp = raw.defaultApp === 'opencode' || raw.defaultApp === 'copilot' || raw.defaultApp === 'codex' ? raw.defaultApp : 'claude';
  // Show the client's top-bar Usage button (Claude Code /usage spend). Off
  // for setups that don't want it; the client also hides the button on its
  // own when claude is not installed (the capture would never succeed).
  const showUsage = raw.showUsage !== false;
  // The Usage MCP is exposed to every Claude session, so keep it opt-in
  // independently of the UI's showUsage setting.
  const usageMcp = raw.usageMcp === true;
  return {
    docker, persistentHome, gpg, sshAgent, gitBroker, forceSandbox, binds, env, claudeBin, defaultApp, showUsage, usageMcp,
    notify: {
      discordWebhook, subscriptions, hostname: notifyHostname, attribution: notifyAttribution,
      vikunja: {
        baseUrl: vikunjaBaseUrl,
        apiToken: vikunjaApiToken,
        projectId: vikunjaProjectId,
        timeoutSeconds: vikunjaTimeoutSeconds,
        verifyTls: vikunjaVerifyTls,
        statusLabelPrefix: vikunjaStatusLabelPrefix,
      },
    },
    configPath,
  };
}

// Locate an executable named `cmd` on the given PATH (or return it as-is if
// it already looks like a path). Mirrors `command -v` without spawning a
// shell. Defaults to the sandbox's own runtime PATH (see SANDBOX_PATH) since
// that -- not the host ccserver process's PATH -- is what actually resolves
// the command once launched.
function which(cmd, pathEnv = SANDBOX_PATH) {
  if (!cmd) return null;
  // A path-form command (e.g. a configured claudeBin like "/usr/bin/claude")
  // must still exist and be executable on the host -- a stale config pointing
  // at a removed CLI would otherwise read as "found" and defeat the
  // availability detection that greys it out client-side.
  if (cmd.includes('/')) {
    try {
      const st = statSync(cmd);
      if (st.isFile() && (st.mode & 0o111)) return cmd;
    } catch { /* not here */ }
    return null;
  }
  for (const dir of (pathEnv || '').split(':')) {
    if (!dir) continue;
    const p = join(dir, cmd);
    try {
      const st = statSync(p);
      if (st.isFile() && (st.mode & 0o111)) return p;
    } catch { /* not here */ }
  }
  return null;
}

// Given the host path of an agent launcher, return the directory that must be
// exposed read-only inside the sandbox for it to actually run — or null if it
// already lives under an always-exposed tree.
//
// Distro/system installs often put a tiny shell wrapper on PATH (e.g.
// /usr/bin/claude) that execs the real, self-contained binary from elsewhere
// (e.g. /opt/claude-code/bin/claude). The sandbox binds /usr but not /opt, so
// the wrapper runs while its target is missing -> exit 127 ("No such file or
// directory"). We follow the wrapper to the real binary and bind its tree.
function appInstallDir(onHost) {
  let real = onHost;
  try { real = realpathSync(onHost); } catch { /* keep as given */ }

  // A small text file on PATH is almost certainly a shell wrapper; follow the
  // absolute path it execs to reach the real binary.
  try {
    const st = statSync(real);
    if (st.isFile() && st.size < 64 * 1024) {
      const text = readFileSync(real, 'utf-8');
      if (text.startsWith('#!')) {
        const m = text.match(/\bexec\s+"?(\/[^\s"']+)"?/);
        if (m) { try { real = realpathSync(m[1]); } catch { real = m[1]; } }
      }
    }
  } catch { /* binary / unreadable: not a wrapper */ }

  // Already reachable inside the sandbox? Nothing extra to bind.
  const exposed = ['/usr/', '/bin/', '/lib/', '/lib64/', '/etc/'];
  if (exposed.some((p) => real.startsWith(p))) return null;
  if (real.startsWith(`${join(HOME, '.local')}/`)) return null; // ~/.local/bin is bound

  // Bind the install root: the parent of a trailing bin/ (so sibling assets
  // come along), else the directory holding the binary.
  let dir = dirname(real);
  if (dir.endsWith('/bin')) dir = dirname(dir);
  return dir;
}

// Locate an agent CLI even when the server runs under a bare PATH that misses
// the install (e.g. systemd's default PATH lacks nvm's bin and ~/.local/bin):
// PATH first (bare name works inside the sandbox too), then the server
// process's own bin dir (node itself came from nvm), ~/.local/bin, and any
// app-specific extras. Returns { command, path } where `command` is the bare
// name when PATH resolves it, else an absolute path — or null if not found.
function resolveAgentCommand(cmd, extraDirs = []) {
  const onPath = which(cmd);
  if (onPath) return { command: cmd, path: onPath };

  const candidates = [
    dirname(process.execPath),
    join(HOME, '.local', 'bin'),
    '/opt/homebrew/bin',              // Homebrew (macOS Apple Silicon)
    '/home/linuxbrew/.linuxbrew/bin', // Linuxbrew
    ...extraDirs,
  ];
  for (const dir of candidates) {
    const p = join(dir, cmd);
    try {
      const st = statSync(p);
      if (st.isFile() && (st.mode & 0o111)) return { command: p, path: p };
    } catch { /* not here */ }
  }
  return null;
}

// Resolve how launches should invoke an agent CLI, plus the host path (if any)
// that must be exposed read-only in the sandbox for that invocation to work.
//   command    - argv[0] to run
//   installDir - extra ro-bind so the resolved binary is present, or null
//   found      - whether the CLI actually resolved somewhere searchable. When
//                false, `command` is only a fallback bare name that will fail
//                at spawn time (execvp ENOENT) -- callers should refuse the
//                launch up front instead (see sessionManager's not-installed
//                error and installedApps()).
//
// claude: "claude" (so the sandbox's PATH resolves it) unless overridden via
//   CCSERVER_CLAUDE_BIN / "claudeBin" in the sandbox config.
// opencode: the resolved absolute path. Its install (e.g. an nvm bin dir) is
//   typically NOT on the sandbox PATH, so the absolute path + installDir bind
//   is required for it to run inside the sandbox.
// copilot: like claude, a bare name first (its ~/.local/bin install is on
//   SANDBOX_PATH); falls back to an absolute path for installs PATH can't see.
export function resolveApp(app, configuredBin = loadSandboxConfig().claudeBin) {
  if (app === 'opencode') {
    const r = resolveAgentCommand('opencode', [join(HOME, '.opencode', 'bin')]);
    if (r) {
      let real = r.path;
      try { real = realpathSync(r.path); } catch { /* keep as given */ }
      return { command: real, installDir: appInstallDir(real), found: true };
    }
    return { command: process.platform === 'win32' ? 'opencode.exe' : 'opencode', installDir: null, found: false };
  }
  if (app === 'copilot') {
    const r = resolveAgentCommand('copilot', [join(HOME, '.local', 'bin')]);
    if (r) return { command: r.command, installDir: appInstallDir(r.path), found: true };
    return { command: process.platform === 'win32' ? 'copilot.exe' : 'copilot', installDir: null, found: false };
  }
  if (app === 'codex') {
    const r = resolveAgentCommand('codex', [join(HOME, '.local', 'bin')]);
    if (r) return { command: r.command, installDir: appInstallDir(r.path), found: true };
    return { command: process.platform === 'win32' ? 'codex.exe' : 'codex', installDir: null, found: false };
  }
  const command = configuredBin || (process.platform === 'win32' ? 'claude.exe' : 'claude');
  const r = resolveAgentCommand(command);
  // Keep the bare name when PATH resolves it (the sandbox PATH can too); use
  // an absolute path for installs PATH can't see (e.g. systemd).
  if (r) return { command: r.command, installDir: appInstallDir(r.path), found: true };
  return { command, installDir: null, found: false };
}

// Which agent CLIs are actually launchable on this host, keyed by app id.
// Exposed via GET /dirs/home so the client can grey out (and the server can
// refuse) launches of uninstalled apps. A few statSync calls per request --
// recomputed every call, no caching needed. claude respects the claudeBin
// override (resolveApp does), so a configured but missing path reads false.
export function installedApps() {
  return {
    claude: resolveApp('claude').found,
    opencode: resolveApp('opencode').found,
    copilot: resolveApp('copilot').found,
    codex: resolveApp('codex').found,
  };
}

// Backwards-compatible alias used by the claude-only /usage capture.
export function resolveClaude(configuredBin = loadSandboxConfig().claudeBin) {
  return resolveApp('claude', configuredBin);
}

// Swap a leading bare `claude`/`opencode`/`copilot` in a target command for
// the resolved launcher, leaving non-agent targets (e.g. a shell) untouched.
// Absolute commands (e.g. resolved opencode paths) pass through as-is.
function withClaude(targetCommand, command) {
  if (targetCommand[0] === 'claude' || targetCommand[0] === 'claude.exe'
    || targetCommand[0] === 'opencode' || targetCommand[0] === 'opencode.exe'
    || targetCommand[0] === 'copilot' || targetCommand[0] === 'copilot.exe'
    || targetCommand[0] === 'codex' || targetCommand[0] === 'codex.exe') {
    return [command, ...targetCommand.slice(1)];
  }
  return targetCommand;
}

// The host's gpg socket directory (e.g. /run/user/UID/gnupg), where the live
// gpg-agent / keyboxd sockets live.
function hostGpgSocketDir() {
  try {
    return execFileSync('gpgconf', ['--list-dirs', 'socketdir'], {
      timeout: 2000, encoding: 'utf-8',
    }).trim() || null;
  } catch {
    return null;
  }
}

function sshAddStatus(sock) {
  // ssh-add -l exit codes: 0 = identities listed, 1 = agent reachable but
  // empty, 2 = cannot connect.
  try {
    execFileSync('ssh-add', ['-l'], {
      env: { ...process.env, SSH_AUTH_SOCK: sock },
      timeout: 2000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return 0;
  } catch (err) {
    return typeof err.status === 'number' ? err.status : 2;
  }
}

// Discover a usable SSH agent socket owned by the current user. ccserver runs
// as a service, so its own SSH_AUTH_SOCK usually points at an empty systemd
// agent; the useful keys live in a forwarded agent whose path (typically under
// /tmp) changes per login. Scan the likely spots and prefer a socket that
// actually has identities loaded.
export function discoverSshAuthSock() {
  if (typeof process.getuid !== 'function') return null;
  const uid = process.getuid();
  const candidates = [];

  // Forwarded agents: /tmp/ssh-XXXX/agent.NNN
  try {
    for (const d of readdirSync('/tmp')) {
      if (!d.startsWith('ssh-')) continue;
      const dir = join('/tmp', d);
      try {
        for (const f of readdirSync(dir)) {
          if (f.startsWith('agent.')) candidates.push(join(dir, f));
        }
      } catch { /* unreadable dir */ }
    }
  } catch { /* ignore */ }

  // Well-known runtime sockets.
  for (const p of [
    join(XDG_RUNTIME_DIR, 'openssh_agent'),
    join(XDG_RUNTIME_DIR, 'ssh-agent.socket'),
    join(XDG_RUNTIME_DIR, 'keyring', 'ssh'),
    join(XDG_RUNTIME_DIR, 'gcr', 'ssh'),
  ]) candidates.push(p);

  // ccserver's own env, if any (often the empty agent — lowest priority).
  if (process.env.SSH_AUTH_SOCK) candidates.push(process.env.SSH_AUTH_SOCK);

  // Keep sockets owned by us; dedupe preserving order.
  const seen = new Set();
  const socks = [];
  for (const p of candidates) {
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      const st = statSync(p);
      if (st.isSocket() && st.uid === uid) socks.push(p);
    } catch { /* missing */ }
  }
  if (socks.length === 0) return null;

  // Prefer a socket with identities loaded; else the first reachable one.
  let firstReachable = null;
  for (const sock of socks) {
    const status = sshAddStatus(sock);
    if (status === 0) return sock;
    if (status === 1 && !firstReachable) firstReachable = sock;
  }
  return firstReachable || socks[0];
}

// Check that the tools needed for the docker-enabled sandbox are present.
export function dockerSandboxAvailable() {
  return [BWRAP, ROOTLESSKIT, '/usr/bin/slirp4netns', '/usr/bin/newuidmap']
    .every((p) => existsSync(p));
}

export function sandboxAvailable() {
  return existsSync(BWRAP);
}

// Build the bwrap arguments (everything after the `bwrap` executable, up to
// but not including the trailing `-- <cmd...>`).
//   homeDir - host path of the persistent per-project HOME to bind at HOME
//             (see persistentHomeDir), or null for a fresh tmpfs HOME.
function buildBwrapArgs({ cwd, docker, gpg, extraBinds, extraEnv, authSock, stateDir, claudeDir, gitBroker, mcpSocketPath, notifySocketPath, usageSocketPath, homeDir = null, orchestratorClaudeMdSrc = null, gitCommonDir = null, groupFilesDir = null }) {
  const args = [
    '--die-with-parent',
    // Own PID namespace so the whole sandbox tree is reaped as a unit. Without
    // it, the background dockerd is NOT a tracked --die-with-parent child: when
    // bwrap dies its descendants merely reparent (to systemd) and dockerd leaks,
    // keeping data-root/socket locks and blocking the next launch. With a pidns,
    // bwrap installs a reaper as pid 1 (reaps zombies from docker/containerd),
    // and the kernel SIGKILLs everything in the namespace once it exits.
    '--unshare-pid',
    // Read-only system
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/sbin', '/sbin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind', '/etc', '/etc',
    '--ro-bind', '/sys', '/sys',
    '--proc', '/proc',
    '--dev', '/dev',
  ];

  // /tmp: with a persistent per-project HOME the project's /tmp persists too,
  // so tooling an agent installs into /tmp (e.g. an extracted Node runtime)
  // survives relaunches instead of being wiped every session. It lives under
  // the persistent home dir, so the reuse/wipe/delete flows for the HOME
  // govern it as well. With a fresh tmpfs HOME (persistentHome off, or the
  // minimal throwaway /usage sandbox) /tmp stays a plain tmpfs.
  if (homeDir) {
    const tmpDir = join(homeDir, '.ccserver-tmp');
    mkdirSync(tmpDir, { recursive: true });
    args.push('--bind', tmpDir, '/tmp');
  } else {
    args.push('--tmpfs', '/tmp');
  }

  // HOME: either the persistent per-project dir (writable, survives relaunches)
  // or a fresh tmpfs. Only the config below is exposed on top either way.
  if (homeDir) {
    args.push('--bind', homeDir, HOME);
  } else {
    args.push('--tmpfs', HOME);
  }

  // Always give the sandbox its own private, writable /run (a fresh tmpfs).
  // We deliberately do NOT reuse the host's /run: rootlesskit's older approach
  // of copying-up /run replaced live agent sockets (gpg) with dead copies. By
  // keeping /run private here and binding only what's needed, live host
  // sockets under /run stay reachable as bind sources (see gpg forwarding).
  args.push('--tmpfs', '/run', '--dir', XDG_RUNTIME_DIR);
  if (docker) {
    // rootlesskit (outer) provides the user namespace and its state dir holds
    // the API socket dockerd needs; expose just that dir.
    args.push('--bind', stateDir, stateDir);
  } else {
    // No outer rootlesskit: bwrap creates the user namespace itself.
    args.push('--unshare-user');
  }

  // The project directory (read-write).
  args.push('--bind', cwd, cwd);

  // git worktree sessions (combo group workers, see worktree.js): a
  // worktree's own .git is just a file pointing at the main checkout's real
  // .git dir, where the object store, refs and .git/worktrees/<role>
  // metadata all actually live. Without also exposing that dir, `git
  // status` and everything else fails inside the sandbox even though cwd
  // itself is rw-bound (see plan section 2.4). rw, matching cwd's own bind
  // mode -- read-only would still block writes (index lock, ORIG_HEAD, ...)
  // that ordinary git operations from inside the worktree need to make.
  if (gitCommonDir) {
    args.push('--bind', gitCommonDir, gitCommonDir);
  }

  // Orchestrator sessions only: overlay a ro-bind of the freshly generated
  // (template + saved per-project custom instructions, merged host-side on
  // every launch -- see groupManager.generateOrchestratorClaudeMdSrc) content
  // onto CLAUDE.md/AGENTS.md. bwrap's last bind for a path wins, so placing
  // this after the rw --bind above shadows just these two files; the rest of
  // cwd (the orchestrator's own directory, still rw) is untouched scratch
  // space. This is what stops a prompt-injected orchestrator from persisting
  // an edit to its own operating rules.
  if (orchestratorClaudeMdSrc) {
    args.push('--ro-bind', orchestratorClaudeMdSrc, join(cwd, 'CLAUDE.md'));
    args.push('--ro-bind', orchestratorClaudeMdSrc, join(cwd, 'AGENTS.md'));
  }

  // Group file exchange: read-only bind of the group's blob directory at a
  // fixed in-sandbox path. Only for group members; standalone sessions have
  // groupFilesDir null and get no bind.
  if (groupFilesDir) {
    try { mkdirSync(groupFilesDir, { recursive: true }); } catch { /* ignore */ }
    args.push('--ro-bind-try', groupFilesDir, '/ccserver-group-files');
  }

  // Combo sessions (worker / orchestrator) get the group's MCP socket bound at
  // a fixed in-sandbox path, plus the byte-pipe wrapper that relays
  // stdin/stdout <-> the socket (see sandbox-mcp-wrapper.cjs). The wrapper's
  // shebang needs the node binary bound at SANDBOX_NODE_PATH -- that bind is
  // shared with the git-broker branch below, so it's pulled out there.
  if (mcpSocketPath) {
    args.push('--bind-try', mcpSocketPath, SANDBOX_MCP_SOCK_PATH);
    args.push('--setenv', 'CCSANDBOX_MCP_SOCK', SANDBOX_MCP_SOCK_PATH);
  }

  // ccserver-notify: the same wrapper script, reached with the 'notify' argv
  // so it reads CCSANDBOX_NOTIFY_MCP_SOCK (bound here) instead of
  // CCSANDBOX_MCP_SOCK. Independent of the group brokers: standalone sandboxes
  // (no mcpSocketPath) get notify on its own.
  if (notifySocketPath) {
    args.push('--bind-try', notifySocketPath, SANDBOX_NOTIFY_SOCK_PATH);
    args.push('--setenv', 'CCSANDBOX_NOTIFY_MCP_SOCK', SANDBOX_NOTIFY_SOCK_PATH);
  }

  // ccserver-usage: same wrapper script again, reached with the 'usage' argv
  // so it reads CCSANDBOX_USAGE_MCP_SOCK (bound here) instead. Independent of
  // both the group brokers and notify -- a claude session may have any
  // combination of the three sockets bound.
  if (usageSocketPath) {
    args.push('--bind-try', usageSocketPath, SANDBOX_USAGE_SOCK_PATH);
    args.push('--setenv', 'CCSANDBOX_USAGE_MCP_SOCK', SANDBOX_USAGE_SOCK_PATH);
  }

  // The bridge wrapper is shared by the group socket, the notify socket and
  // the usage socket (bound once -- a combo orchestrator may have all three)
  // and its node shebang lives at SANDBOX_NODE_PATH (ro-bound with the
  // git-broker branch below).
  if (mcpSocketPath || notifySocketPath || usageSocketPath) {
    args.push('--ro-bind', MCP_BRIDGE_SCRIPT, SANDBOX_MCP_BRIDGE_PATH);
  }

  // Agent CLI configuration + install dirs (claude + opencode + copilot + codex),
  // writable so sessions/auth state survive across sandbox launches and
  // conversations can be resumed. ~/.local/bin is exposed so the user's own
  // tools resolve. opencode's XDG state dir (~/.local/state/opencode) holds
  // TUI-selected state (model.json, kv.json, session.json); without it the
  // chosen model resets to the provider default on every launch. copilot's
  // auth (~/.config/github-copilot/hosts.json) and config (~/.copilot) are
  // bound writable so a sandboxed session keeps its login and model/session
  // state (session history lives under ~/.copilot, so `--continue` works).
  const opencodeState = join(HOME, '.local', 'state', 'opencode');
  mkdirSync(opencodeState, { recursive: true });
  const copilotConfig = join(HOME, '.config', 'github-copilot');
  const copilotHome = join(HOME, '.copilot');
  const codexHome = join(HOME, '.codex');
  mkdirSync(copilotConfig, { recursive: true });
  mkdirSync(copilotHome, { recursive: true });
  const appBinds = [
    [join(HOME, '.claude'), 'rw'],
    [join(HOME, '.claude.json'), 'rw'],
    [join(HOME, '.local', 'share', 'claude'), 'rw'],
    [join(HOME, '.config', 'opencode'), 'rw'],
    [join(HOME, '.local', 'share', 'opencode'), 'rw'],
    [opencodeState, 'rw'],
    [copilotConfig, 'rw'],
    [copilotHome, 'rw'],
    [codexHome, 'rw'],
  ];
  for (const [src, mode] of appBinds) {
    if (existsSync(src)) {
      args.push(mode === 'ro' ? '--ro-bind' : '--bind', src, src);
    }
  }

  // ~/.local/bin handling. With the legacy tmpfs HOME it is ro-bound at its
  // real path so the user's own tools resolve. With a persistent HOME that ro
  // bind would sit ON TOP of the persistent home's own writable .local/bin,
  // silently blocking agent-installed tools (pip/npm --user console scripts)
  // from ever persisting. Instead the host bin is exposed at a secondary path
  // (…/.local/bin-host) appended to PATH, so both the persistent home's
  // agent-installed tools AND the host user's tools resolve.
  const hostLocalBin = join(HOME, '.local', 'bin');
  let sandboxPath = SANDBOX_PATH;
  if (homeDir) {
    const hostBinDest = join(HOME, '.local', 'bin-host');
    mkdirSync(join(homeDir, '.local', 'bin-host'), { recursive: true });
    args.push('--ro-bind-try', hostLocalBin, hostBinDest);
    sandboxPath = `${SANDBOX_PATH}:${hostBinDest}`;
  } else if (existsSync(hostLocalBin)) {
    args.push('--ro-bind', hostLocalBin, hostLocalBin);
  }

  // The agent install itself, when it lives outside the exposed trees (e.g.
  // /opt/claude-code reached via a /usr/bin/claude wrapper, or an opencode
  // binary under nvm). See appInstallDir.
  if (claudeDir && existsSync(claudeDir)) {
    args.push('--ro-bind', claudeDir, claudeDir);
  }

  // Persistent per-project docker data-root, mounted at the default location.
  if (docker) {
    const dataRoot = join(dindRoot(), slugify(cwd));
    mkdirSync(dataRoot, { recursive: true });
    args.push('--bind', dataRoot, join(HOME, '.local', 'share', 'docker'));
  }

  // Forward the SSH agent socket. Its path is dynamic (per login / forwarded
  // agent), so we take it from the server's environment rather than config.
  // It typically lives under /tmp, which rootlesskit does not copy-up, so the
  // live socket is reachable even with docker enabled.
  if (authSock && existsSync(authSock)) {
    args.push('--bind-try', authSock, authSock);
    args.push('--setenv', 'SSH_AUTH_SOCK', authSock);
  }

  // gpg-agent forwarding: bind ~/.gnupg (keys/keybox) plus the live host
  // agent/keyboxd sockets so signing uses the host agent (which holds the
  // token). Inside rootlesskit we run as uid 0, so gpg looks for its sockets
  // in ~/.gnupg; without rootlesskit (uid unchanged) it uses the runtime dir.
  if (gpg) {
    const gnupgHome = join(HOME, '.gnupg');
    if (existsSync(gnupgHome)) args.push('--bind', gnupgHome, gnupgHome);
    const hostSockDir = hostGpgSocketDir();
    if (hostSockDir) {
      const targetDir = docker ? gnupgHome : join(XDG_RUNTIME_DIR, 'gnupg');
      for (const name of ['S.gpg-agent', 'S.gpg-agent.extra', 'S.keyboxd', 'S.dirmngr']) {
        const src = join(hostSockDir, name);
        if (existsSync(src)) args.push('--bind-try', src, join(targetDir, name));
      }
    }
  }

  // gh: replace wherever it resolves (host PATH or common install paths)
  // with a wrapper that relays to the git-broker instead of running for
  // real inside the sandbox (see sandbox-gh-wrapper.cjs / ghAllowlist.js).
  // gh's own API calls go straight to api.github.com over TLS, so they
  // can't be scoped by inspecting network traffic the way HTTPS/SSH git
  // access is below; instead the broker executes a safelisted subset of gh
  // subcommands itself, on the host, after checking the target repo against
  // the same allow-list.
  //
  // git broker: repo-scoped HTTPS credential helper + SSH gate + gh
  // passthrough, all over one socket. Computed once at session start from
  // the cwd's own remotes + checked-out submodules (see gitAllowlist.js);
  // gitBroker is the {sockPath, allowlistPath} bag returned by
  // startGitBroker(), or null when disabled/unavailable.
  // The helper/wrapper scripts are Node scripts (shebang points at this
  // fixed path); bind the actual node binary here rather than assume
  // /usr/bin/node exists, mirroring how resolveApp follows the real
  // agent binary instead of assuming a host layout. Shared between the
  // git-broker machinery and the MCP bridge wrapper.
  if (gitBroker || mcpSocketPath || notifySocketPath || usageSocketPath) {
    const nodeBin = realpathSync(process.execPath);
    args.push('--ro-bind', nodeBin, SANDBOX_NODE_PATH);
  }

  if (gitBroker) {
    const ghCandidates = new Set(
      [which('gh'), '/usr/bin/gh', '/usr/local/bin/gh', '/opt/homebrew/bin/gh', join(HOME, '.local', 'bin', 'gh')].filter(Boolean),
    );
    for (const ghPath of ghCandidates) {
      if (existsSync(ghPath)) args.push('--ro-bind', GH_WRAPPER_SCRIPT, ghPath);
    }

    args.push('--ro-bind', CRED_HELPER_SCRIPT, SANDBOX_CRED_HELPER_PATH);
    args.push('--ro-bind', gitBroker.allowlistPath, SANDBOX_ALLOWLIST_PATH);
    args.push('--bind-try', gitBroker.sockPath, SANDBOX_BROKER_SOCK_PATH);

    const realSsh = which('ssh');
    if (realSsh && existsSync(realSsh)) {
      args.push('--ro-bind', realpathSync(realSsh), SANDBOX_REAL_SSH_PATH);
      // Overrides the earlier whole-/usr ro-bind (bwrap: last bind for a
      // given destination wins), so every ssh invocation inside the
      // sandbox -- not just git's -- passes through the wrapper first.
      args.push('--ro-bind', SSH_WRAPPER_SCRIPT, realSsh);
      args.push('--setenv', 'CCSANDBOX_REAL_SSH', SANDBOX_REAL_SSH_PATH);
      // realSsh (e.g. /usr/bin/ssh) is the path git will invoke; inside the
      // sandbox that path now resolves to the wrapper (bound above), so
      // pointing GIT_SSH_COMMAND at it routes git's ssh calls through the
      // gate even if something clears the ssh binary override.
      args.push('--setenv', 'GIT_SSH_COMMAND', realSsh);

      // Pin the wrapper's own `ssh -F` to a config that skips system/user
      // ssh config (see sandbox-ssh-config for why: root-owned files under
      // /etc/ssh map to nobody in bwrap's user namespace, so OpenSSH
      // refuses to Include them -- "Bad owner or permissions") and points
      // known_hosts at a bound-in file instead of the never-exposed
      // ~/.ssh. The host's own ~/.ssh/known_hosts isn't a secret (just
      // public host keys), so it's bound too, ahead of the pinned default,
      // for any host beyond the ones we pin.
      const userKnownHosts = join(HOME, '.ssh', 'known_hosts');
      if (existsSync(userKnownHosts)) {
        args.push('--ro-bind', userKnownHosts, SANDBOX_KNOWN_HOSTS_USER_PATH);
      }
      args.push('--ro-bind', DEFAULT_KNOWN_HOSTS, SANDBOX_KNOWN_HOSTS_DEFAULT_PATH);
      args.push('--ro-bind', SSH_CONFIG_FILE, SANDBOX_SSH_CONFIG_PATH);
      args.push('--setenv', 'CCSANDBOX_SSH_CONFIG', SANDBOX_SSH_CONFIG_PATH);
    }

    // Generated gitconfig points credential.helper at our script and forces
    // useHttpPath (see sandbox-gitconfig for why). Bound over HOME/.gitconfig
    // (a fresh tmpfs normally, or the persistent home's -- an agent-written
    // one is shadowed on purpose so the broker's credential helper can't be
    // overridden by a config that would leak credentials).
    args.push('--ro-bind', GENERATED_GITCONFIG, join(HOME, '.gitconfig'));

    args.push(
      // /etc is ro-bound wholesale above, so a host /etc/gitconfig with its
      // own credential.helper would otherwise still apply inside the
      // sandbox, alongside (or instead of) ours.
      '--setenv', 'GIT_CONFIG_NOSYSTEM', '1',
      '--setenv', 'CCSANDBOX_GIT_BROKER_SOCK', SANDBOX_BROKER_SOCK_PATH,
      '--setenv', 'CCSANDBOX_GIT_ALLOWLIST', SANDBOX_ALLOWLIST_PATH,
    );
  }

  // User-configured extra binds (ssh keys, custom config, etc.). Use *-try
  // so a missing source is skipped rather than aborting the launch.
  //
  // Raw ~/.ssh (private keys) and ~/.config/gh (gh token) are always
  // blocked here, unconditionally (even if gitBroker is off): those are
  // exactly the unrestricted, any-repo credential exposures this feature
  // replaces, and a stale sandbox.config.json predating this change must
  // not silently reintroduce them.
  const BLOCKED_BIND_PATHS = [join(HOME, '.ssh'), join(HOME, '.config', 'gh')];
  for (const b of extraBinds) {
    if (!b || !b.src) continue;
    const src = expandHome(String(b.src));
    if (BLOCKED_BIND_PATHS.some((p) => src === p || src.startsWith(`${p}/`))) {
      console.warn(`[sandbox] ignoring configured bind of ${src}: raw ssh keys / gh config are no longer exposed to the sandbox (see the git broker)`);
      continue;
    }
    const dest = b.dest ? expandHome(String(b.dest)) : src;
    const flag = b.mode === 'rw' ? '--bind-try' : '--ro-bind-try';
    args.push(flag, src, dest);
  }

  // Environment.
  args.push(
    '--setenv', 'HOME', HOME,
    '--setenv', 'XDG_RUNTIME_DIR', XDG_RUNTIME_DIR,
    '--setenv', 'PATH', sandboxPath,
    '--setenv', 'CCSANDBOX_DOCKER', docker ? '1' : '0',
  );
  if (docker) {
    args.push(
      '--setenv', 'DOCKER_HOST', `unix://${XDG_RUNTIME_DIR}/docker.sock`,
      '--setenv', 'CCSANDBOX_DOCKER_DATAROOT', join(HOME, '.local', 'share', 'docker'),
      // The unique per-launch stateDir basename, reused as-is (see
      // newStateDir()) rather than minting a second UUID. The entrypoint
      // writes this into the data-root's status file iff it wins the dockerd
      // flock, so the host side can later tell "docker is available to ME"
      // apart from "in use by another session" (dockerdStatus/
      // dockerAvailability).
      '--setenv', 'CCSANDBOX_DOCKERD_TAG', basename(stateDir),
    );
  }

  // User-configured environment (e.g. SSH_AUTH_SOCK, GPG_TTY). Applied last so
  // it can override the defaults above.
  for (const [k, v] of Object.entries(extraEnv || {})) {
    if (typeof k === 'string' && k) {
      args.push('--setenv', k, expandHome(String(v)));
    }
  }

  args.push('--chdir', cwd);
  // Expose the entrypoint script read-only at a fixed path.
  args.push('--ro-bind', ENTRYPOINT, '/ccserver-sandbox-entrypoint.sh');

  return args;
}

// Minimal sandbox: just enough to launch an agent CLI in an isolated
// filesystem, with NO docker, gpg, ssh, or extra binds. bwrap creates its own
// user namespace (--unshare-user) and network stays shared with the host (so
// the CLI can still reach its API). Used for the lightweight background usage
// captures that don't need a real project: Claude's `/usage` TUI scrape (see
// server/usage.js) and Codex's `account/rateLimits/read` JSON-RPC call (see
// server/codexUsage.js). `app` selects which CLI's config/install dir gets
// resolved; defaults to 'claude' for the original caller.
export function buildMinimalSandboxSpawn({ cwd, targetCommand, app = 'claude' }) {
  const { command, installDir } = resolveApp(app);
  const bwrapArgs = buildBwrapArgs({
    cwd,
    docker: false,
    gpg: false,
    extraBinds: [],
    extraEnv: {},
    authSock: null,
    stateDir: null,
    claudeDir: installDir,
    gitBroker: null,
    mcpSocketPath: null,
    notifySocketPath: null,
    usageSocketPath: null,
    // The /usage capture is a throwaway read: it must not create (or depend
    // on) a persistent per-project HOME.
    homeDir: null,
  });
  const innerCmd = [BASH, '/ccserver-sandbox-entrypoint.sh', ...withClaude(targetCommand, command)];
  return {
    command: BWRAP,
    args: [...bwrapArgs, '--', ...innerCmd],
    docker: false,
    stateDir: null,
    gitBrokerProc: null,
    gitBrokerDir: null,
  };
}

// Returns { command, args } for pty.spawn, wrapping the given target command
// (e.g. ['claude', '--resume', id] or ['/bin/bash']) in the sandbox.
//   app         - selects which agent the install-dir resolution applies to.
//   sandboxOpts - optional per-launch override for the opt-in flags
//                 ({ gpg, sshAgent }, either key omittable). Lets a caller
//                 (the client, via the launch UI) pick these per session/
//                 directory instead of only through the shared config file;
//                 an omitted key falls back to loadSandboxConfig()'s value.
//   mcpSocketPath - host path of the group's control/handoff MCP socket to
//                 bind into the sandbox at a fixed path (combo sessions
//                 only). null for regular sessions.
//   notifySocketPath - host path of the process-global ccserver-notify socket
//                 to bind into the sandbox at a fixed path. null when the
//                 session gets no notify MCP injection.
//   usageSocketPath - host path of the process-global ccserver-usage socket
//                 to bind into the sandbox at a fixed path. null when the
//                 session gets no usage MCP injection.
//   reuseSandboxHome - false to start a *fresh* persistent HOME for this
//                 launch: the previous per-project HOME is wiped (via the same
//                 escalated removeTree as deleteSandboxHome) and recreated
//                 empty. True (default) keeps it. Only meaningful when
//                 persistentHome is enabled in the config; the caller
//                 (sessionManager) guards against wiping a HOME that another
//                 live sandboxed session is still using.
//   orchestratorClaudeMdSrc - host path of the freshly generated (template +
//                 saved custom instructions) CLAUDE.md/AGENTS.md content to
//                 ro-bind over cwd's copies (combo orchestrator sessions
//                 only). null for regular sessions and workers.
//   gitCommonDir - absolute path of cwd's git-common-dir (see worktree.js's
//                 resolveMemberWorktree), bound into the sandbox alongside
//                 cwd when cwd is a git worktree whose real .git lives
//                 elsewhere. null for regular sessions and non-worktree cwds.
export function buildSandboxSpawn({ cwd, targetCommand, app, sandboxOpts, mcpSocketPath = null, notifySocketPath = null, usageSocketPath = null, reuseSandboxHome = true, orchestratorClaudeMdSrc = null, gitCommonDir = null, groupFilesDir = null }) {
  const { docker: cfgDocker, persistentHome, gpg: cfgGpg, sshAgent: cfgSshAgent, gitBroker: gitBrokerEnabled, binds, env, claudeBin } = loadSandboxConfig();
  const docker = cfgDocker && dockerSandboxAvailable();
  const gpg = sandboxOpts?.gpg ?? cfgGpg;
  const sshAgent = sandboxOpts?.sshAgent ?? cfgSshAgent;

  // ssh-agent forwarding is opt-in (see loadSandboxConfig). When on, an
  // explicit env.SSH_AUTH_SOCK in the config wins; otherwise auto-discover.
  const authSock = sshAgent ? (env.SSH_AUTH_SOCK || discoverSshAuthSock()) : null;

  // Unique per launch (docker only); returned so the caller can remove it on
  // teardown. See newStateDir().
  const stateDir = docker ? newStateDir() : null;

  // Persistent per-project HOME. reuseSandboxHome=false wipes the previous
  // one first so the launch starts from a clean environment; the caller
  // (sessionManager) has already refused the wipe when another live sandboxed
  // session is still using this HOME (see sandboxHomeConflict).
  let homeDir = null;
  if (persistentHome) {
    homeDir = persistentHomeDir(cwd);
    if (!reuseSandboxHome) {
      // "新規作成" must start from a clean HOME. A plain rmSync silently
      // fails on subuid-owned files (a nested dockerd wrote to the /tmp-bound
      // .ccserver-tmp) and the --bind below would then expose the stale
      // content as if it were fresh. Use the same escalated removal as
      // deleteSandboxHome, and refuse the launch rather than boot into a
      // stale HOME (e.g. a planted .bashrc) if it still cannot be wiped.
      const wipeErr = removeTree(homeDir);
      if (wipeErr) {
        throw new Error(`failed to wipe the previous sandbox HOME (${wipeErr}); refusing a "fresh" launch over stale state`);
      }
    }
    mkdirSync(homeDir, { recursive: true });
    // Remember which project this HOME belongs to (settings-page labels).
    recordSandboxHome(cwd);
  }

  // Computes the repo/submodule allow-list once and spawns the host-side
  // broker for this launch; see git-broker.js. The caller (sessionManager)
  // holds onto gitBrokerProc/gitBrokerDir to tear them down alongside the
  // sandboxed pty.
  const gitBroker = gitBrokerEnabled ? startGitBroker({ cwd }) : null;

  // The git broker only gates /usr/bin/ssh and gh as seen by bwrap's own
  // filesystem. When docker is also on, code inside the sandbox can run its
  // own containers via the nested dockerd (see sandbox-entrypoint.sh); those
  // containers get their own image filesystem and do NOT inherit the ssh/gh
  // wrapper binds. This only turns into a live-credential bypass when
  // ssh-agent forwarding is also on (authSock set): a nested container can
  // then mount the forwarded socket (bound at a fixed, discoverable path)
  // directly, reaching the real ssh binary with the real forwarded agent,
  // unscoped. sshAgent defaults to off precisely to keep this door shut; see
  // README "Known limitations" before turning it on alongside docker.
  if (docker && gitBroker && authSock) {
    console.warn(
      '[sandbox] docker + gitBroker + sshAgent are all enabled: a process inside the sandbox '
      + 'can use `docker run` to bypass the git credential broker entirely (nested containers '
      + "don't inherit the ssh wrapper and can mount the forwarded ssh-agent socket "
      + 'directly). See README "Known limitations" before relying on gitBroker as a hard boundary.',
    );
  }

  const { command, installDir } = resolveApp(app, claudeBin);
  const bwrapArgs = buildBwrapArgs({ cwd, docker, gpg, extraBinds: binds, extraEnv: env, authSock, stateDir, claudeDir: installDir, gitBroker, mcpSocketPath, notifySocketPath, usageSocketPath, homeDir, orchestratorClaudeMdSrc, gitCommonDir, groupFilesDir });
  const innerCmd = [BASH, '/ccserver-sandbox-entrypoint.sh', ...withClaude(targetCommand, command)];

  const gitBrokerFields = {
    gitBrokerProc: gitBroker ? gitBroker.proc : null,
    gitBrokerDir: gitBroker ? gitBroker.dir : null,
  };

  if (docker) {
    return {
      command: ROOTLESSKIT,
      args: [
        `--state-dir=${stateDir}`,
        '--net=slirp4netns',
        '--mtu=65520',
        '--slirp4netns-sandbox=auto',
        '--slirp4netns-seccomp=auto',
        '--disable-host-loopback',
        '--port-driver=builtin',
        // Only /etc is copied-up (for resolv.conf). We intentionally do NOT
        // copy-up /run so live host sockets there remain usable as bind
        // sources; bwrap gives the sandbox its own private /run instead.
        '--copy-up=/etc',
        '--propagation=rslave',
        BWRAP,
        ...bwrapArgs,
        '--',
        ...innerCmd,
      ],
      docker,
      stateDir,
      ...gitBrokerFields,
    };
  }

  return {
    command: BWRAP,
    args: [...bwrapArgs, '--', ...innerCmd],
    docker,
    stateDir,
    ...gitBrokerFields,
  };
}
