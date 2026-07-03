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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(__dirname, 'sandbox-entrypoint.sh');

const BWRAP = '/usr/bin/bwrap';
const ROOTLESSKIT = '/usr/bin/rootlesskit';
const BASH = '/usr/bin/bash';

const HOME = homedir();
// process.getuid is undefined on Windows; the sandbox is Linux-only, but this
// module is imported unconditionally, so guard the top-level access.
const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || `/run/user/${UID}`;

// RootlessKit's state dir (holds the API socket dockerd connects to). It lives
// under the runtime dir on the host; bwrap binds it in so dockerd can reach it.
const ROOTLESSKIT_STATE_DIR = join(XDG_RUNTIME_DIR, 'dockerd-rootless');

// Where per-project docker data-roots (images/layers) live, so they persist
// across sessions of the same project.
const DIND_ROOT = join(HOME, '.local', 'share', 'ccserver-sandbox', 'dind');

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
  const binds = Array.isArray(raw.binds) ? raw.binds : [];
  const env = (raw.env && typeof raw.env === 'object') ? raw.env : {};
  return { docker, gpg, binds, env, configPath };
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
function buildBwrapArgs({ cwd, docker, gpg, extraBinds, extraEnv, authSock }) {
  const args = [
    '--die-with-parent',
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
    args.push('--bind', ROOTLESSKIT_STATE_DIR, ROOTLESSKIT_STATE_DIR);
  } else {
    // No outer rootlesskit: bwrap creates the user namespace itself.
    args.push('--unshare-user');
  }

  // The project directory (read-write).
  args.push('--bind', cwd, cwd);

  // Claude Code configuration + install.
  const claudeBinds = [
    [join(HOME, '.claude'), 'rw'],
    [join(HOME, '.claude.json'), 'rw'],
    [join(HOME, '.local', 'share', 'claude'), 'rw'],
    [join(HOME, '.local', 'bin'), 'ro'],
  ];
  for (const [src, mode] of claudeBinds) {
    if (existsSync(src)) {
      args.push(mode === 'ro' ? '--ro-bind' : '--bind', src, src);
    }
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

  // User-configured extra binds (gh config, ssh keys, etc.). Use *-try so a
  // missing source is skipped rather than aborting the launch.
  for (const b of extraBinds) {
    if (!b || !b.src) continue;
    const src = expandHome(String(b.src));
    const dest = b.dest ? expandHome(String(b.dest)) : src;
    const flag = b.mode === 'rw' ? '--bind-try' : '--ro-bind-try';
    args.push(flag, src, dest);
  }

  // Environment.
  args.push(
    '--setenv', 'HOME', HOME,
    '--setenv', 'XDG_RUNTIME_DIR', XDG_RUNTIME_DIR,
    '--setenv', 'PATH', `${join(HOME, '.local', 'bin')}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
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

// Returns { command, args } for pty.spawn, wrapping the given target command
// (e.g. ['claude', '--resume', id] or ['/bin/bash']) in the sandbox.
export function buildSandboxSpawn({ cwd, targetCommand }) {
  const { docker: cfgDocker, gpg, binds, env } = loadSandboxConfig();
  const docker = cfgDocker && dockerSandboxAvailable();

  // An explicit env.SSH_AUTH_SOCK in the config wins; otherwise auto-discover.
  const authSock = env.SSH_AUTH_SOCK || discoverSshAuthSock();

  const bwrapArgs = buildBwrapArgs({ cwd, docker, gpg, extraBinds: binds, extraEnv: env, authSock });
  const innerCmd = [BASH, '/ccserver-sandbox-entrypoint.sh', ...targetCommand];

  if (docker) {
    return {
      command: ROOTLESSKIT,
      args: [
        `--state-dir=${ROOTLESSKIT_STATE_DIR}`,
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
    };
  }

  return {
    command: BWRAP,
    args: [...bwrapArgs, '--', ...innerCmd],
    docker,
  };
}
