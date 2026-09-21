// Shared env-var parsing for the session destroy timeouts
// (CCSERVER_SESSION_TIMEOUT_MS / CCSERVER_SESSION_EXITED_TIMEOUT_MS), used by
// server/ws/sessionManager.js. Kept separate from its caller so the parsing
// rules themselves stay directly testable.

export const DEFAULT_SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2h: no viewer attached, pty still running
// Raised from 30s: a pty that dies while nobody is attached used to take the
// whole session with it half a minute later, so reopening the tab found
// SESSION_NOT_FOUND and had to relaunch+resume with no way to see why the
// process had gone. Five minutes is long enough to come back and read the
// exit code.
export const DEFAULT_SESSION_EXITED_TIMEOUT_MS = 5 * 60 * 1000;
export const MIN_SESSION_EXITED_TIMEOUT_MS = 1000;
// setTimeout's 32-bit ceiling (~24.8 days). Node does not reject a longer
// delay -- it warns (TimeoutOverflowWarning) and silently uses 1ms instead,
// so an operator setting a huge value to keep sessions around for a long
// time would get the exact opposite: immediate teardown.
const MAX_TIMEOUT_MS = 2147483647;

// `logPrefix` (e.g. '[session]') keeps warnings attributable to whichever
// caller actually parsed the bad value.
export function parseTimeoutEnv(raw, { name, fallback, min, logPrefix }) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`${logPrefix} ignoring invalid ${name}=${raw} (not a number); using ${fallback}ms`);
    return fallback;
  }
  const ms = Math.trunc(n);
  if (ms > MAX_TIMEOUT_MS) {
    console.warn(
      `${logPrefix} ${name}=${raw} exceeds setTimeout's ${MAX_TIMEOUT_MS}ms ceiling; `
      + 'clamping to it (set 0 to disable the timeout instead of using a huge value)'
    );
    return MAX_TIMEOUT_MS;
  }
  return Math.max(min, ms);
}
