// Shared plumbing for the git / gh children the SERVER runs on the host on
// behalf of the Files screen (routes/git.js: the repository indicator and
// clone). None of this is sandboxed, so it is written for a hostile input:
//
//   - The repository a request points at may have been written by a
//     sandboxed agent. `.git/config` is agent-writable (#214), and git
//     executes several of its keys (core.fsmonitor, core.sshCommand, ...).
//     Measured (git 2.55.0): `git status` / `git diff` run core.fsmonitor;
//     `rev-parse`, `symbolic-ref`, `config`, `branch --show-current` and
//     `remote -v` do not. Callers here only use the second group, and
//     runGit() still pins the execution-capable keys off as defense in depth.
//   - The server's own environment can carry things a child must not
//     inherit (GIT_DIR / GIT_CONFIG_* / GIT_SSH_COMMAND ...), so children get
//     an allowlisted environment instead of a copy of process.env.

import { execFile } from 'node:child_process';

// Always in front of every git invocation made here. Same set the combo
// reviewer template uses for its own fetch/checkout (#214's mitigation).
export const GIT_HARDEN_FLAGS = Object.freeze([
  '-c', 'core.fsmonitor=',
  '-c', 'core.sshCommand=',
  '-c', 'core.askpass=',
  '-c', 'protocol.ext.allow=never',
]);

// What a child may inherit. Everything else -- notably every GIT_* variable
// -- is dropped.
const BASE_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ',
];
// Only for a child that talks to the network as the operator (gh repo
// clone): the operator's own gh / git credentials come from HOME and the
// gh config dir, or from these when the service sets them. XDG_RUNTIME_DIR
// and DBUS_SESSION_BUS_ADDRESS are how gh reaches a keyring on a desktop
// host.
const NETWORK_ENV = [
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
];

export function buildChildEnv(source = process.env, { network = false, extra = {} } = {}) {
  const env = {};
  for (const key of network ? [...BASE_ENV, ...NETWORK_ENV] : BASE_ENV) {
    if (typeof source[key] === 'string') env[key] = source[key];
  }
  return { ...env, ...extra };
}

// GIT_CONFIG_COUNT / KEY_n / VALUE_n (git 2.31+): config that outranks every
// config file, including the host's ~/.gitconfig and the repository's own.
// `entries` is [[key, value], ...]; an empty value is valid (and is how a
// key such as core.fsmonitor is switched off).
export function gitConfigEnv(entries) {
  const env = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

export const GIT_READ_TIMEOUT_MS = 5_000;
// Enough for `config --get-regexp` over a config near the size cap that
// gitInfo.js applies; a larger reply is treated as a failure, not truncated.
const GIT_READ_MAX_BUFFER = 2 * 1024 * 1024;

// Runs `git <GIT_HARDEN_FLAGS> ...args`. Never throws: resolves
// { ok, code, stdout, stderr, timedOut, error }. `code` is the exit status
// (null when the process did not exit normally). A timeout kills the child
// with SIGKILL -- a git blocked opening a FIFO where `.git` should be is
// interruptible, but nothing here waits for it to be polite.
export function runGit(args, {
  cwd,
  timeoutMs = GIT_READ_TIMEOUT_MS,
  gitBin = 'git',
  env = buildChildEnv(),
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      child = execFile(
        gitBin,
        [...GIT_HARDEN_FLAGS, ...args],
        {
          cwd,
          env: { ...env, GIT_TERMINAL_PROMPT: '0' },
          encoding: 'utf-8',
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: GIT_READ_MAX_BUFFER,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (!error) {
            finish({ ok: true, code: 0, stdout, stderr, timedOut: false, error: null });
            return;
          }
          const timedOut = error.killed === true && error.signal === 'SIGKILL';
          finish({
            ok: false,
            code: typeof error.code === 'number' ? error.code : null,
            stdout: stdout || '',
            stderr: stderr || '',
            timedOut,
            error,
          });
        },
      );
    } catch (error) {
      finish({ ok: false, code: null, stdout: '', stderr: '', timedOut: false, error });
      return;
    }
    // git never reads stdin for these commands; do not leave it open.
    try { child.stdin?.end(); } catch { /* already closed */ }
  });
}
