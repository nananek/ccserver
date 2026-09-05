// App-agnostic launch logic for the terminal sessions: which executable to
// run, how to resume a conversation, and how to recognize app-specific TUI
// output (resume ids, permission prompts). Everything here is pure — host
// lookup (which/realpath) lives in sandbox.js, I/O in sessionManager.js.

// The launchable agent CLIs. Any session launcher (WS init, combo groups,
// scheduled prompts, orchestrator restarts) keys its behavior off these ids;
// unknown ids are rejected / fall back to the configured default app.
export const APPS = ['claude', 'opencode', 'copilot', 'codex', 'commandcode'];

// Which app new sessions launch when none is requested is configured, not
// hardcoded here -- see sandbox.js's loadSandboxConfig() / sessionManager.js's
// defaultApp() (sandbox.config.json's "defaultApp", default 'claude').

export function isValidApp(app) {
  return APPS.includes(app);
}

export function appDisplayName(app) {
  if (app === 'copilot') return 'GitHub Copilot';
  if (app === 'opencode') return 'opencode';
  if (app === 'codex') return 'OpenAI Codex';
  if (app === 'commandcode') return 'Command Code';
  return 'Claude Code';
}

// CLI args to start `app` fresh, or to resume a conversation:
//   claude   -> claude [--resume <id>] | claude --continue (resume last)
//   opencode -> opencode [--session <id>] | opencode -c (resume last)
//   copilot  -> copilot (no id-based resume; the TUI keeps its own session
//               list) | copilot --continue (resume last)
// resumeLast ("resume the most recent conversation in the cwd") is used when
// no session id is known, e.g. scheduled prompts / orchestrator restart where
// the TUI never exposed an id.
export function appResumeArgs(app, resumeId, { resumeLast = false } = {}) {
  if (app === 'opencode') {
    if (resumeId) return ['--session', resumeId];
    if (resumeLast) return ['-c'];
    return [];
  }
  if (app === 'copilot') {
    // copilot exposes no conversation id in its byte stream (extractResumeSessionId
    // returns null), so an explicit id never reaches this branch in practice.
    if (resumeLast) return ['--continue'];
    return [];
  }
  if (app === 'codex') {
    const args = resumeId ? ['resume', resumeId] : resumeLast ? ['resume', '--last'] : [];
    return args;
  }
  if (app === 'commandcode') {
    if (resumeId) return ['--resume', resumeId];
    if (resumeLast) return ['-c'];
    return [];
  }
  if (resumeId) return ['--resume', resumeId];
  if (resumeLast) return ['--continue'];
  return [];
}

// Whether the given app's CLI is known to accept `--model <provider/model>`.
// Verified on this host:
//   opencode --help -> `-m, --model <provider/model>`
//   copilot --help  -> `--model <model>` (confirmed on the real binary, Aug
//                      2026; if real launches ever fail on this flag, flip
//                      copilot back to false)
// The local `claude` wrapper resolves to a missing /opt/claude-code/bin/claude,
// so Claude's --model support cannot be verified here; the flag is NOT emitted
// for claude by default (an unsupported argument would make every launch fail).
// Deployments whose real Claude binary is confirmed to support `--model` opt in
// via CCSERVER_CLAUDE_MODEL=1.
export function appSupportsModelFlag(app) {
  if (app === 'opencode') return true;
  if (app === 'copilot') return true;
  if (app === 'codex') return true;
  if (app === 'commandcode') return true;
  if (app === 'claude') return process.env.CCSERVER_CLAUDE_MODEL === '1';
  return false;
}

// CLI args selecting the launch model: `--model <model>` for apps whose CLI
// supports it, and only when `model` is a non-empty string. Empty/absent/null
// models never emit a flag (the app's own persisted/default model applies);
// a model is never sent to an app that can't accept it.
export function appModelArgs(app, model) {
  if (!appSupportsModelFlag(app)) return [];
  if (typeof model !== 'string' || model.length === 0) return [];
  return ['--model', model];
}

// Permission mode for commandcode launches: 'standard' (default, no flag),
// 'auto-accept' (--auto-accept), or 'yolo' (--yolo, alias for
// --dangerously-skip-permissions). Verified against `command-code --help`
// (bundled v1.47.0 and latest v1.49.1, Sep 2026): both flags exist in both
// versions. Only commandcode honors it -- every other app (and shells, which
// carry no app id) always yields no flag, so a stale or mismatched value can
// never break another CLI's launch. Unknown/absent values normalize to
// 'standard' (no flag), mirroring how model normalization coerces invalid
// values to null instead of emitting a broken flag.
export const PERMISSION_MODES = ['standard', 'auto-accept', 'yolo'];

export function normalizePermissionMode(mode) {
  return PERMISSION_MODES.includes(mode) ? mode : 'standard';
}

export function appPermissionArgs(app, mode) {
  if (app !== 'commandcode') return [];
  if (mode === 'yolo') return ['--yolo'];
  if (mode === 'auto-accept') return ['--auto-accept'];
  return [];
}

// Combines the three launch-arg helpers above in the exact order
// sessionManager.createSession pushes them (resume, then model, then
// permission). Shared by sessionManager and this file's own tests so a
// reordering in the real launch path can't drift away from what's tested --
// see PR#108 review.
export function appLaunchArgs(app, { resumeId, resumeLast, model, permissionMode } = {}) {
  return [
    ...appResumeArgs(app, resumeId, { resumeLast }),
    ...appModelArgs(app, model),
    ...appPermissionArgs(app, permissionMode),
  ];
}

// The keystroke that submits the current prompt in each app's TUI, sent by
// sessionManager.writeToSession({ submit: true }) after the typed text.
// Every supported CLI accepts CR today (verified against all four TUIs; CR
// is also what a terminal's Enter key emits), so the table is uniform -- it
// exists so a future app needing a different submit key changes only its
// row here instead of a literal buried in the write path. LF is never a
// submit key: several TUIs treat it as a soft newline / continuation.
const APP_SUBMIT_KEYS = {
  claude: '\r',
  opencode: '\r',
  copilot: '\r',
  codex: '\r',
  commandcode: '\r',
};

export function appSubmitKey(app) {
  // Unknown apps (and plain shells, whose sessions carry no app id) fall
  // back to CR -- the same byte this path has always sent.
  return APP_SUBMIT_KEYS[app] || '\r';
}

// Try to recover a conversation id from recent (ANSI-stripped) terminal
// output, so an exiting session can be resumed later. claude prints
// `claude --resume <id>`; opencode's, copilot's, codex's and commandcode's
// TUIs never expose their session id in the byte stream, so their resume goes
// through `opencode -c` / `copilot --continue` / `codex resume --last` /
// `commandcode -c` instead (null here).
export function extractResumeSessionId(app, rawText) {
  const clean = rawText.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  if (app === 'opencode' || app === 'copilot' || app === 'codex' || app === 'commandcode') return null;

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
  if (app === 'copilot') {
    // copilot renders numbered permission choices (docs.github.com, Aug
    // 2026): `1. Yes` / `2. Yes, and approve TOOL for the rest of the
    // running session` / `3. No, and tell Copilot what to do differently`.
    // In the space-collapsed buffer those are `1.Yes` / `2.Yes,andapprove...
    // running session`. Enter accepts the default (Yes), matching the Enter
    // we send. The real renderer frame is unverified (needs a logged-in
    // session -- see the plan's §6.5); tune against a captured frame if it
    // ever misdetects.
    return /1\.Yes/i.test(bufNoSpace) || /runningsession/i.test(bufNoSpace);
  }
  if (app === 'codex') {
    // Codex presents both local-command and MCP-tool approval menus. Enter
    // accepts the initially highlighted one-time approval in either case.
    // Require the question plus its corresponding option rather than matching
    // generic permission prose that a model might emit.
    const commandPrompt = /Wouldyouliketorunthefollowingcommand.*1\.Yes,proceed\(y\)/i;
    const mcpToolPrompt = /Allowthe\S+MCPserver(?:torun)?tool["“][^"”]+["”].*1\.Allow/i;
    return commandPrompt.test(bufNoSpace) || mcpToolPrompt.test(bufNoSpace);
  }
  // commandcode approval rendering is not verified on this host either --
  // same policy: never auto-approve an unverified frame.
  if (app === 'commandcode') return false;
  return (
    /Doyouwantto(proceed|makethisedit|use)/i.test(bufNoSpace) ||
    /Yes,allow/i.test(bufNoSpace) ||
    /Claudewantsto(fetch|search|call)/i.test(bufNoSpace)
  );
}
