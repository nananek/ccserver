#!/ccserver-sandbox-node
// Runs INSIDE the sandbox as git's commit-msg hook (bound at a fixed path
// under core.hooksPath; see sandbox.js's commit-message guard wiring). git
// invokes this with one argument -- the path of a temp file holding the
// fully-resolved commit message -- regardless of whether that message came
// from -m, -F, an interactive editor, a template, or --amend, so there is no
// argv/CLI-grammar surface to get wrong here (unlike the gh/ssh wrappers).
//
// Blocks the commit (prints a reason to stderr, exits 1) when the message
// matches a pattern from $CCSANDBOX_COMMIT_GUARD_CONFIG (a fixed path, JSON
// { patterns: [...] } written by sandbox.js from commitGuard.js's
// buildGuardConfig -- built-in patterns, e.g. a Claude-Session: trailer or a
// claude.ai/code/session_ URL, plus whatever the operator added via
// sandbox.config.json's commitMessageGuard.blockedPatterns).
//
// This is a standalone CommonJS script (fixed shebang path, bound in
// wholesale by sandbox.js -- no shared import from the ESM server code), so
// the matching contract (compile each pattern with 'im', first match wins)
// is duplicated from commitGuard.js by hand rather than imported; keep the
// two in sync (commitGuard.test.js is the source of truth for the exact
// semantics -- case-insensitivity, per-line ^/$ matching, invalid-pattern
// handling).
//
// Fails OPEN, not closed: any problem reading/parsing the message or the
// config (missing env var, unreadable file, malformed JSON, a bad regex in
// one pattern) lets the commit through rather than blocking it. This is a
// best-effort guard against an accidental leak, not a hard security
// boundary (see docs-site's sandbox/credentials.md "known limitations" --
// --no-verify or a locally overridden core.hooksPath already bypass it
// outright) -- an availability outage over a config typo or an unexpected
// message encoding would be a much worse trade than occasionally missing a
// pattern.
'use strict';

const fs = require('fs');

function readMessage(path) {
  try {
    return fs.readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function loadPatterns(configPath) {
  if (!configPath) return null;
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.patterns)) return null;
  return parsed.patterns;
}

// See commitGuard.js's compilePatterns: 'im' so '^'/'$' match line
// boundaries (a squash-merge message can repeat the same trailer once per
// squashed sub-commit) and matching is case-insensitive. A single invalid
// pattern is skipped, not fatal -- an operator typo in one entry must not
// either block every commit or (via one broad try/catch) silently drop
// every other pattern too.
function compilePatterns(sources) {
  const out = [];
  for (const source of sources) {
    if (typeof source !== 'string' || !source) continue;
    try {
      out.push({ source, regex: new RegExp(source, 'im') });
    } catch (err) {
      process.stderr.write(`[ccserver] commit-msg guard: ignoring invalid pattern ${JSON.stringify(source)}: ${err.message}\n`);
    }
  }
  return out;
}

function findBlockedMatch(message, compiled) {
  for (const { source, regex } of compiled) {
    const m = regex.exec(message);
    if (!m) continue;
    const matchedLine = message.split('\n').find((line) => regex.test(line)) ?? m[0];
    return { source, matchedLine };
  }
  return null;
}

function main() {
  const msgPath = process.argv[2];
  if (!msgPath) process.exit(0); // git always passes this; nothing to check without it -- fail open

  const message = readMessage(msgPath);
  if (message === null) process.exit(0); // couldn't read the message git itself just wrote -- fail open

  const patterns = loadPatterns(process.env.CCSANDBOX_COMMIT_GUARD_CONFIG);
  if (patterns === null) process.exit(0); // no/unreadable/malformed config -- fail open, not closed

  const compiled = compilePatterns(patterns);
  const blocked = findBlockedMatch(message, compiled);
  if (!blocked) process.exit(0);

  process.stderr.write(
    `[ccserver] commit blocked: message matches a blocked pattern (${blocked.source}).\n`
    + `  matched line: ${blocked.matchedLine}\n`
    + '  See sandbox.config.json\'s commitMessageGuard, or use --no-verify to override if you understand the risk.\n',
  );
  process.exit(1);
}

main();
