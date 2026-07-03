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
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
  const binds = Array.isArray(raw.binds) ? raw.binds : [];
  return { docker, binds, configPath };
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
function buildBwrapArgs({ cwd, docker, extraBinds }) {
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

  if (docker) {
    // Reuse rootlesskit's (copied-up) /run so dockerd finds its state dir and
    // the RootlessKit API socket. rootlesskit provides the user namespace, so
    // bwrap must NOT create its own.
    args.push('--bind', '/run', '/run');
  } else {
    // No outer rootlesskit: bwrap creates the user namespace itself and we
    // provide a private runtime dir.
    args.push('--unshare-user', '--tmpfs', '/run', '--dir', XDG_RUNTIME_DIR);
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

  // User-configured extra binds (gpg/ssh/gh etc.). Use *-try so a missing
  // source is skipped rather than aborting the launch.
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

  args.push('--chdir', cwd);
  // Expose the entrypoint script read-only at a fixed path.
  args.push('--ro-bind', ENTRYPOINT, '/ccserver-sandbox-entrypoint.sh');

  return args;
}

// Returns { command, args } for pty.spawn, wrapping the given target command
// (e.g. ['claude', '--resume', id] or ['/bin/bash']) in the sandbox.
export function buildSandboxSpawn({ cwd, targetCommand }) {
  const { docker: cfgDocker, binds } = loadSandboxConfig();
  const docker = cfgDocker && dockerSandboxAvailable();

  const bwrapArgs = buildBwrapArgs({ cwd, docker, extraBinds: binds });
  const innerCmd = [BASH, '/ccserver-sandbox-entrypoint.sh', ...targetCommand];

  if (docker) {
    return {
      command: ROOTLESSKIT,
      args: [
        `--state-dir=${XDG_RUNTIME_DIR}/dockerd-rootless`,
        '--net=slirp4netns',
        '--mtu=65520',
        '--slirp4netns-sandbox=auto',
        '--slirp4netns-seccomp=auto',
        '--disable-host-loopback',
        '--port-driver=builtin',
        '--copy-up=/etc',
        '--copy-up=/run',
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
