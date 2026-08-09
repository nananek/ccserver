// App-agnostic launch logic for the terminal sessions: which executable to
// run, how to resume a conversation, and how to recognize app-specific TUI
// output (resume ids, permission prompts). Everything here is pure — host
// lookup (which/realpath) lives in sandbox.js, I/O in sessionManager.js.

export const APPS = ['claude', 'opencode'];

// Which app new sessions launch when none is requested is configured, not
// hardcoded here -- see sandbox.js's loadSandboxConfig() / sessionManager.js's
// defaultApp() (sandbox.config.json's "defaultApp", default 'claude').

export function isValidApp(app) {
  return APPS.includes(app);
}

export function appDisplayName(app) {
  return app === 'opencode' ? 'opencode' : 'Claude Code';
}

// CLI args to start `app` fresh, or to resume a conversation:
//   claude   -> claude [--resume <id>]
//   opencode -> opencode [--session <id>] | opencode -c (resume last, used when
//               no session id is known, e.g. scheduled prompts / server
//               restart where the TUI never exposed an id)
export function appResumeArgs(app, resumeId, { resumeLast = false } = {}) {
  if (app === 'opencode') {
    if (resumeId) return ['--session', resumeId];
    if (resumeLast) return ['-c'];
    return [];
  }
  if (resumeId) return ['--resume', resumeId];
  if (resumeLast) return ['--continue'];
  return [];
}

// Try to recover a conversation id from recent (ANSI-stripped) terminal
// output, so an exiting session can be resumed later. claude prints
// `claude --resume <id>`; opencode's TUI never exposes its session id in the
// byte stream, so its resume goes through `opencode -c` instead (null here).
export function extractResumeSessionId(app, rawText) {
  const clean = rawText.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  if (app === 'opencode') return null;

  const matches = [...clean.matchAll(/claude\s+(?:--resume|-r)\s+([a-zA-Z0-9_-]+)/gi)];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

// Detect a permission prompt in a space-collapsed ANSI-stripped output buffer.
// claude uses Ink's select UI; opencode renders a box titled "Permission
// required" with "Allow once" / "Allow always" / "Reject" (Enter accepts the
// default "Allow once", matching the Enter we send).
//
// Verified against real opencode 1.18.15 TUI output (captured via node-pty,
// Aug 2026): the box shows `△ Permission required`, a description
// (`← Access external directory ...`), patterns, and the option row. The
// default focus is "Allow once" (amber highlight) even for destructive
// commands like `rm -f` — Enter auto-approves. claude's Ink select, by
// contrast, defaults to the proceed/yes side, so both agents approve on
// Enter. The box title alone is the signal: the option labels in model prose
// (a plan mentioning "allow once"/"allow always") would be a false positive,
// and the trailing-border lookahead keeps model prose like "permission
// required." from matching (a real box has a border/glyph right after the
// title, prose has a word or punctuation).
export function detectPermissionPrompt(app, bufNoSpace) {
  if (app === 'opencode') {
    return /Permissionrequired(?![\w.,!?;:\u3001\u3002\uff01\uff1f\u2014-])/i.test(bufNoSpace);
  }
  return (
    /Doyouwantto(proceed|makethisedit|use)/i.test(bufNoSpace) ||
    /Yes,allow/i.test(bufNoSpace) ||
    /Claudewantsto(fetch|search|call)/i.test(bufNoSpace)
  );
}
