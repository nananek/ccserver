// CCSERVER_AUTH_MODE resolution (Issue #141), shared by server/index.js and
// server/cli/issue-login-token.js so the two never disagree on the effective
// mode when CCSERVER_AUTH_MODE is left unset.
//
// Unset defaults to 'token' when CCSERVER_TOKEN is set, 'none' otherwise --
// matching the pre-#141 behavior where CCSERVER_TOKEN alone turned auth on.
// An explicitly-set CCSERVER_AUTH_MODE (including 'none') always wins.
export function resolveAuthMode(env = process.env) {
  return env.CCSERVER_AUTH_MODE || (env.CCSERVER_TOKEN ? 'token' : 'none');
}
