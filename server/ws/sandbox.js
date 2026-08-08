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
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
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
// CLIs are told to run via --mcp-config / OPENCODE_CONFIG_CONTENT.
const SANDBOX_MCP_SOCK_PATH = '/ccserver-sandbox-mcp.sock';
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
// across sessions of the same project.
const DIND_ROOT = join(HOME, '.local', 'share', 'ccserver-sandbox', 'dind');

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
  const binds = Array.isArray(raw.binds) ? raw.binds : [];
  const env = (raw.env && typeof raw.env === 'object') ? raw.env : {};
  // How to launch claude. Overridable because the install location is
  // environment-specific (see resolveClaude). Env var wins over the config file.
  const claudeBin = process.env.CCSERVER_CLAUDE_BIN || (typeof raw.claudeBin === 'string' ? raw.claudeBin : null);
  // Which agent a new session launches when the client doesn't request one.
  // See appLaunch.js's APPS; anything else (including unset) falls back to
  // claude -- see sessionManager.js's defaultApp().
  const defaultApp = raw.defaultApp === 'opencode' ? 'opencode' : 'claude';
  return { docker, gpg, sshAgent, gitBroker, binds, env, claudeBin, defaultApp, configPath };
}

// Locate an executable named `cmd` on the given PATH (or return it as-is if
// it already looks like a path). Mirrors `command -v` without spawning a
// shell. Defaults to the sandbox's own runtime PATH (see SANDBOX_PATH) since
// that -- not the host ccserver process's PATH -- is what actually resolves
// the command once launched.
function which(cmd, pathEnv = SANDBOX_PATH) {
  if (!cmd) return null;
  if (cmd.includes('/')) return cmd;
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
//
// claude: "claude" (so the sandbox's PATH resolves it) unless overridden via
//   CCSERVER_CLAUDE_BIN / "claudeBin" in the sandbox config.
// opencode: the resolved absolute path. Its install (e.g. an nvm bin dir) is
//   typically NOT on the sandbox PATH, so the absolute path + installDir bind
//   is required for it to run inside the sandbox.
export function resolveApp(app, configuredBin = loadSandboxConfig().claudeBin) {
  if (app === 'opencode') {
    const r = resolveAgentCommand('opencode', [join(HOME, '.opencode', 'bin')]);
    if (r) {
      let real = r.path;
      try { real = realpathSync(r.path); } catch { /* keep as given */ }
      return { command: real, installDir: appInstallDir(real) };
    }
    return { command: process.platform === 'win32' ? 'opencode.exe' : 'opencode', installDir: null };
  }
  const command = configuredBin || (process.platform === 'win32' ? 'claude.exe' : 'claude');
  const r = resolveAgentCommand(command);
  // Keep the bare name when PATH resolves it (the sandbox PATH can too); use
  // an absolute path for installs PATH can't see (e.g. systemd).
  if (r) return { command: r.command, installDir: appInstallDir(r.path) };
  return { command, installDir: null };
}

// Backwards-compatible alias used by the claude-only /usage capture.
export function resolveClaude(configuredBin = loadSandboxConfig().claudeBin) {
  return resolveApp('claude', configuredBin);
}

// Swap a leading bare `claude`/`opencode` in a target command for the resolved
// launcher, leaving non-agent targets (e.g. a shell) untouched. Absolute
// commands (e.g. resolved opencode paths) pass through as-is.
function withClaude(targetCommand, command) {
  if (targetCommand[0] === 'claude' || targetCommand[0] === 'claude.exe'
    || targetCommand[0] === 'opencode' || targetCommand[0] === 'opencode.exe') {
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
function buildBwrapArgs({ cwd, docker, gpg, extraBinds, extraEnv, authSock, stateDir, claudeDir, gitBroker, mcpSocketPath }) {
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
    '--tmpfs', '/tmp',
    // Empty writable HOME; only the config below is exposed.
    '--tmpfs', HOME,
  ];

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

  // Combo sessions (worker / orchestrator) get the group's MCP socket bound at
  // a fixed in-sandbox path, plus the byte-pipe wrapper that relays
  // stdin/stdout <-> the socket (see sandbox-mcp-wrapper.cjs). The wrapper's
  // shebang needs the node binary bound at SANDBOX_NODE_PATH -- that bind is
  // shared with the git-broker branch below, so it's pulled out there.
  if (mcpSocketPath) {
    args.push('--bind-try', mcpSocketPath, SANDBOX_MCP_SOCK_PATH);
    args.push('--ro-bind', MCP_BRIDGE_SCRIPT, SANDBOX_MCP_BRIDGE_PATH);
    args.push('--setenv', 'CCSANDBOX_MCP_SOCK', SANDBOX_MCP_SOCK_PATH);
  }

  // Agent CLI configuration + install dirs (claude + opencode), writable so
  // sessions/auth state survive across sandbox launches and conversations can
  // be resumed. ~/.local/bin is exposed so the user's own tools resolve.
  // opencode's XDG state dir (~/.local/state/opencode) holds TUI-selected
  // state (model.json, kv.json, session.json); without it the chosen model
  // resets to the provider default on every launch.
  const opencodeState = join(HOME, '.local', 'state', 'opencode');
  mkdirSync(opencodeState, { recursive: true });
  const appBinds = [
    [join(HOME, '.claude'), 'rw'],
    [join(HOME, '.claude.json'), 'rw'],
    [join(HOME, '.local', 'share', 'claude'), 'rw'],
    [join(HOME, '.config', 'opencode'), 'rw'],
    [join(HOME, '.local', 'share', 'opencode'), 'rw'],
    [opencodeState, 'rw'],
    [join(HOME, '.local', 'bin'), 'ro'],
  ];
  for (const [src, mode] of appBinds) {
    if (existsSync(src)) {
      args.push(mode === 'ro' ? '--ro-bind' : '--bind', src, src);
    }
  }

  // The agent install itself, when it lives outside the exposed trees (e.g.
  // /opt/claude-code reached via a /usr/bin/claude wrapper, or an opencode
  // binary under nvm). See appInstallDir.
  if (claudeDir && existsSync(claudeDir)) {
    args.push('--ro-bind', claudeDir, claudeDir);
  }

  // Persistent per-project docker data-root, mounted at the default location.
  if (docker) {
    const dataRoot = join(DIND_ROOT, slugify(cwd));
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
  if (gitBroker || mcpSocketPath) {
    const nodeBin = realpathSync(process.execPath);
    args.push('--ro-bind', nodeBin, SANDBOX_NODE_PATH);
  }

  if (gitBroker) {
    const ghCandidates = new Set(
      [which('gh'), '/usr/bin/gh', '/usr/local/bin/gh', join(HOME, '.local', 'bin', 'gh')].filter(Boolean),
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
    // useHttpPath (see sandbox-gitconfig for why). HOME is a fresh tmpfs
    // (above) with nothing else binding ~/.gitconfig, so this is a plain
    // bind, no merge/override gymnastics needed.
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
    '--setenv', 'PATH', SANDBOX_PATH,
    '--setenv', 'CCSANDBOX_DOCKER', docker ? '1' : '0',
  );
  if (docker) {
    args.push(
      '--setenv', 'DOCKER_HOST', `unix://${XDG_RUNTIME_DIR}/docker.sock`,
      '--setenv', 'CCSANDBOX_DOCKER_DATAROOT', join(HOME, '.local', 'share', 'docker'),
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

// Minimal sandbox: just enough to launch claude in an isolated filesystem, with
// NO docker, gpg, ssh, or extra binds. bwrap creates its own user namespace
// (--unshare-user) and network stays shared with the host (so claude can still
// reach the API). Used for the lightweight background `/usage` capture, which
// only needs Claude's own config bound in — see server/usage.js.
export function buildMinimalSandboxSpawn({ cwd, targetCommand }) {
  const { command, installDir } = resolveClaude();
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
export function buildSandboxSpawn({ cwd, targetCommand, app, sandboxOpts, mcpSocketPath = null }) {
  const { docker: cfgDocker, gpg: cfgGpg, sshAgent: cfgSshAgent, gitBroker: gitBrokerEnabled, binds, env, claudeBin } = loadSandboxConfig();
  const docker = cfgDocker && dockerSandboxAvailable();
  const gpg = sandboxOpts?.gpg ?? cfgGpg;
  const sshAgent = sandboxOpts?.sshAgent ?? cfgSshAgent;

  // ssh-agent forwarding is opt-in (see loadSandboxConfig). When on, an
  // explicit env.SSH_AUTH_SOCK in the config wins; otherwise auto-discover.
  const authSock = sshAgent ? (env.SSH_AUTH_SOCK || discoverSshAuthSock()) : null;

  // Unique per launch (docker only); returned so the caller can remove it on
  // teardown. See newStateDir().
  const stateDir = docker ? newStateDir() : null;

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
  const bwrapArgs = buildBwrapArgs({ cwd, docker, gpg, extraBinds: binds, extraEnv: env, authSock, stateDir, claudeDir: installDir, gitBroker, mcpSocketPath });
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
