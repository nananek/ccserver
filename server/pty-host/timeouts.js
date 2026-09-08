// Idle/exited destroy-timeout policy for pty-host's own sessions (plan5
// section 2.2: pty-host holds this timer itself now, not sessionManager.js).
//
// Issue #119 Step8: the env var parsing rules themselves (parseTimeoutEnv and
// the shared defaults/floor) now live in server/timeoutEnv.js, imported by
// both this file and server/ws/sessionManager.js -- previously a byte-for-
// byte duplicate copy here, forked in Step1 so pty-host would depend on
// nothing from the module it was then meant to eventually replace. Step7
// made direct-spawn a permanent parallel mode rather than something pty-host
// replaces, so that rationale for duplicating no longer applies, while the
// underlying need for THIS file to keep resolving its own timeouts
// independently of sessionManager.js's copy has not changed (see below).

import {
  parseTimeoutEnv,
  DEFAULT_SESSION_TIMEOUT_MS,
  DEFAULT_SESSION_EXITED_TIMEOUT_MS,
  MIN_SESSION_EXITED_TIMEOUT_MS,
} from '../timeoutEnv.js';

// 0 or negative disables idle destruction entirely -- the session then lives
// until the pty exits or someone explicitly destroys it.
export function resolveSessionTimeoutMs(env = process.env) {
  return parseTimeoutEnv(env.CCSERVER_SESSION_TIMEOUT_MS, {
    name: 'CCSERVER_SESSION_TIMEOUT_MS',
    fallback: DEFAULT_SESSION_TIMEOUT_MS,
    min: 0,
    logPrefix: '[pty-host]',
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
    logPrefix: '[pty-host]',
  });
}
