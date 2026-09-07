// Decides whether a commit message matches a pattern that must never land in
// real history -- most importantly a `Claude-Session:` trailer or a
// claude.ai/code/session_ URL, either of which hands out live access to the
// conversation that produced the commit. This module is pure logic (no fs/
// process access) so it's unit-testable on its own; the actual enforcement
// point is sandbox-commit-msg-hook.cjs, which runs INSIDE the sandbox as
// git's commit-msg hook and re-implements the same small matching contract
// (compile-with-'im', first-match-wins) against the JSON this module builds
// -- see that file's header for why the logic is duplicated there rather
// than imported (the hook is a standalone CommonJS script bound at a fixed
// sandbox path; this module is ESM).
//
// This only ever sees the final commit message text, so it works
// identically regardless of how that text was produced (-m, -F, an editor,
// a template, --amend, a squash merge, ...) and is blind to everything
// else. See docs-site/.../sandbox/credentials.md "known limitations" for
// what it can't catch (--no-verify, a locally overridden core.hooksPath).

// Built-in, always-on patterns (regex source strings, compiled with 'im' --
// see compilePatterns). Deliberately narrow: only things that leak a live
// session URL. A generic `Co-Authored-By: Claude ...` trailer is NOT
// included here -- many workflows want that kept, so it's opt-in via
// sandbox.config.json's commitMessageGuard.blockedPatterns instead (see
// buildGuardConfig).
export const DEFAULT_BLOCKED_PATTERNS = [
  '^Claude-Session:',
  'https://claude\\.ai/code/session_',
];

// Compiles pattern source strings into { source, regex } pairs. 'im' makes
// '^'/'$' match line boundaries within a multi-line message (a squash-merge
// commit can carry the same trailer more than once, one per squashed
// sub-message) and matching case-insensitive. A source string that isn't
// valid regex is reported via onInvalid and otherwise dropped -- one
// operator typo in sandbox.config.json's blockedPatterns must not take down
// every other pattern (or, if guarded by one broad try/catch instead, take
// down commits entirely); the caller decides what "reported" means.
export function compilePatterns(sources, onInvalid = (source, err) => {
  console.warn(`[commitGuard] ignoring invalid pattern ${JSON.stringify(source)}: ${err.message}`);
}) {
  const out = [];
  for (const source of sources) {
    if (typeof source !== 'string' || !source) continue;
    try {
      out.push({ source, regex: new RegExp(source, 'im') });
    } catch (err) {
      onInvalid(source, err);
    }
  }
  return out;
}

// Returns { source, matchedLine } for the first compiled pattern that
// matches `message`, or null if none do. matchedLine is the first line of
// the message the pattern actually matches, for a clear diagnostic; falls
// back to the whole match text in the (should-never-happen) case no single
// line reproduces it.
export function findBlockedMatch(message, compiled) {
  for (const { source, regex } of compiled) {
    const m = regex.exec(message);
    if (!m) continue;
    const matchedLine = message.split('\n').find((line) => regex.test(line)) ?? m[0];
    return { source, matchedLine };
  }
  return null;
}

// Builds the JSON payload written to the sandbox-visible guard config file
// (see sandbox.js's SANDBOX_COMMIT_GUARD_CONFIG_PATH): the built-in patterns
// plus the operator's own additions from sandbox.config.json's
// commitMessageGuard.blockedPatterns. Kept as source strings, not compiled
// RegExps -- compilation (and its fail-safe invalid-pattern handling)
// happens once, inside the sandbox, in sandbox-commit-msg-hook.cjs, so a
// hand-edited config file on disk gets the exact same fail-safe treatment
// as this one.
export function buildGuardConfig(userPatterns = []) {
  const extra = Array.isArray(userPatterns)
    ? userPatterns.filter((p) => typeof p === 'string' && p)
    : [];
  return { patterns: [...DEFAULT_BLOCKED_PATTERNS, ...extra] };
}
