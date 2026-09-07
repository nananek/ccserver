// Idle/exited destroy-timeout policy for pty-host's own sessions (plan5
// section 2.2: pty-host holds this timer itself now, not sessionManager.js).
// Ported from server/ws/sessionManager.js's resolveSessionTimeoutMs /
// resolveExitedTimeoutMs -- deliberately a fresh copy rather than an import:
// pty-host must work with zero dependency on the module it is meant to
// eventually replace, and the env var names/semantics are the public
// contract being carried over, not the old implementation.

const DEFAULT_SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2h: no viewer attached, pty still running
const DEFAULT_SESSION_EXITED_TIMEOUT_MS = 5 * 60 * 1000; // 5m: no viewer attached, pty already exited
const MIN_SESSION_EXITED_TIMEOUT_MS = 1000;
// setTimeout's 32-bit ceiling (~24.8 days). Node does not reject a longer
// delay -- it warns and silently uses 1ms instead, which would be the exact
// opposite of an operator's intent when setting a huge "keep it forever"
// value.
const MAX_TIMEOUT_MS = 2147483647;

function parseTimeoutEnv(raw, { name, fallback, min }) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[pty-host] ignoring invalid ${name}=${raw} (not a number); using ${fallback}ms`);
    return fallback;
  }
  const ms = Math.trunc(n);
  if (ms > MAX_TIMEOUT_MS) {
    console.warn(
      `[pty-host] ${name}=${raw} exceeds setTimeout's ${MAX_TIMEOUT_MS}ms ceiling; `
      + 'clamping to it (set 0 to disable the timeout instead of using a huge value)'
    );
    return MAX_TIMEOUT_MS;
  }
  return Math.max(min, ms);
}

// 0 or negative disables idle destruction entirely -- the session then lives
// until the pty exits or someone explicitly destroys it.
export function resolveSessionTimeoutMs(env = process.env) {
  return parseTimeoutEnv(env.CCSERVER_SESSION_TIMEOUT_MS, {
    name: 'CCSERVER_SESSION_TIMEOUT_MS',
    fallback: DEFAULT_SESSION_TIMEOUT_MS,
    min: 0,
  });
}

// Never disabled: an exited pty has no process left, so a viewer-less exited
// session must always eventually be reaped or the session list would fill
// with rows nobody can ever attach to again.
export function resolveExitedTimeoutMs(env = process.env) {
  return parseTimeoutEnv(env.CCSERVER_SESSION_EXITED_TIMEOUT_MS, {
    name: 'CCSERVER_SESSION_EXITED_TIMEOUT_MS',
    fallback: DEFAULT_SESSION_EXITED_TIMEOUT_MS,
    min: MIN_SESSION_EXITED_TIMEOUT_MS,
  });
}
