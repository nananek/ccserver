// Environment handed to processes ccserver launches on the user's behalf
// (session PTYs, the usage probes). The server's own process environment is
// the base, minus the variables that only mean something to ccserver itself:
//
// - NODE_ENV: set to "production" by the documented systemd unit. Inherited
//   into a session it makes every `npm install` / `npm ci` in that session
//   skip devDependencies, so builds fail with e.g. `vite: not found`.
// - PORT: ccserver's own listen port; an app started inside a session would
//   otherwise try to bind the same port.
// - CCSERVER_*: server configuration, including CCSERVER_TOKEN. Sessions
//   (sandboxed ones included -- bwrap inherits the environment) have no use
//   for it. Per-session values such as CCSERVER_NOTIFY_IDENTITY are added by
//   the callers after this base, so they are unaffected.
// - SSH_AUTH_SOCK / SSH_AGENT_PID: forwarded ssh-agent state; sessions get
//   their own via the sandbox / launch options, and a stale socket confuses
//   tools.
//
// Names are matched case-insensitively. Windows environment variable names
// are case-insensitive: a server started with `node_env=production` or
// `ccserver_token=...` has those values in effect (Node resolves
// process.env.NODE_ENV / CCSERVER_TOKEN to them) while Object.entries lists
// them under the lower-case spelling, so a case-sensitive match would let
// them through. The same rule is applied on every platform to keep it
// simple; on POSIX it additionally drops lower/mixed-case spellings that no
// ccserver component reads, which errs on the side of not leaking.

export const SERVER_ONLY_ENV_KEYS = Object.freeze(['NODE_ENV', 'PORT', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID']);
export const SERVER_ONLY_ENV_PREFIXES = Object.freeze(['CCSERVER_']);

/**
 * Whether an environment variable name is server-only and must not reach a
 * launched process. The comparison ignores case (see the note above).
 * @param {string} key
 * @returns {boolean}
 */
export function isServerOnlyEnvKey(key) {
  const name = String(key).toUpperCase();
  if (SERVER_ONLY_ENV_KEYS.includes(name)) return true;
  return SERVER_ONLY_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Build the base environment for a process launched on behalf of a session.
 * Returns a new object; `env` is left untouched.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {Record<string, string | undefined>}
 */
export function buildSessionEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (isServerOnlyEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
}
