// Issue #119 Step8: shared env-var parsing for the session destroy timeouts
// (CCSERVER_SESSION_TIMEOUT_MS / CCSERVER_SESSION_EXITED_TIMEOUT_MS).
//
// server本体 (server/ws/sessionManager.js) and pty-host
// (server/pty-host/timeouts.js) each manage timeouts for their OWN sessions
// independently -- Step7 made direct-spawn a permanent parallel mode rather
// than something pty-host would eventually replace, so neither timer owner
// goes away and this is not a "merge two call sites into one" refactor.
// What used to be duplicated (a full second copy of parseTimeoutEnv() and
// the same three default/floor constants, originally forked in Step1 when
// pty-host was written to depend on nothing from the module it was meant to
// replace) is only the parsing RULES themselves, which must stay identical
// between the two -- both sides expose the same env var names as one public
// contract. That's what lives here now; each caller still owns its own
// resolveSessionTimeoutMs()/resolveExitedTimeoutMs() wrapper and its own
// module-load-time SESSION_TIMEOUT_MS/SESSION_EXITED_TIMEOUT_MS constants.

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

// `logPrefix` (e.g. '[session]' / '[pty-host]') keeps warnings attributable
// to whichever process actually parsed the bad value -- server本体 and
// pty-host are separate processes/log streams, so a bare, unattributed
// warning would be ambiguous about which one to go fix.
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
