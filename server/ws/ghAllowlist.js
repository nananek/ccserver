// Decides whether a `gh` invocation from inside the sandbox may be forwarded
// to the host and actually executed (by git-broker.js, over the same socket
// used for git HTTPS credentials -- see that file's protocol comment).
//
// gh's own API surface can't be repo-scoped by terminating/proxying its TLS
// traffic (that's why plain `gh` is bound-over inside the sandbox at all --
// see sandbox.js), so instead of trying to inspect network traffic we run
// specific, known-safe gh subcommands ourselves, on the host, after
// resolving which repo(s) they target and checking every one of them
// against the same allow-list already computed for git (gitAllowlist.js).
// Anything not explicitly named in ALLOWED is refused -- most importantly:
//   - `gh api` (arbitrary GitHub API endpoint, not repo-scoped at all --
//     could read/write far beyond any single repo)
//   - `gh auth` / `gh secret` / `gh variable` / `gh ssh-key` / `gh gpg-key`
//     (credential/secret management, not a repo operation)
//   - `gh repo clone` / `fork` / `create` / `delete` / `rename` (the target
//     repo is a bare positional argument with subcommand-specific parsing;
//     rather than reimplement that parsing to gate it, these are refused --
//     `gh repo view` is allowed since its target is only --repo/cwd/a bare
//     owner-repo positional, all handled below)
//
// This is an allow-list, not a deny-list: a new gh subcommand is refused by
// default until someone deliberately adds it here.
//
// Two argument-shape pitfalls this module exists to close (found in review,
// before this ever shipped -- see git history for the concrete repro):
//
//   1. Bundled short flags. gh uses pflag/Cobra, which bundles short flags
//      into one token (`-wR value` == `-w -R value`, R's value taken from
//      the rest of the token or the next one). If we don't recognize a
//      bundled "-R", we'd resolve/check the WRONG repo (falling back to cwd)
//      while the real `gh` binary -- parsing the same argv with its own,
//      complete grammar -- still finds and acts on the hidden -R's actual
//      target. Rather than reimplement gh's full short-flag grammar
//      (fragile, drifts as gh's flags change -- see the ssh wrapper's argv
//      parser for the same class of problem), any short token that could
//      possibly be bundling something is refused outright: only a lone "-R"
//      or the unambiguous attached form "-Rvalue" are accepted; standalone
//      2-char short flags (e.g. "-w", "-t") are harmless (nothing to bundle
//      in a single letter) and left alone.
//
//   2. Positional URLs. Several allowed subcommands accept
//      `<number>|<url>|<branch>` (pr view/checkout/diff/merge/close/edit/...,
//      issue view/close/edit/...) or `[HOST/]OWNER/REPO|<url>` (repo view).
//      When given a URL (or, for `repo view`, a bare owner/repo), gh
//      resolves the repo FROM THAT ARGUMENT, ignoring --repo/-R and the
//      cwd's remote entirely -- e.g. `gh pr merge <url-to-unrelated-repo>`
//      would otherwise sail through as "repo resolved from cwd, allowed"
//      while actually merging a PR in a completely different, unchecked
//      repo. Every URL-shaped token anywhere in argv, and (for `repo view`
//      only, where a bare positional is meaningful) every bare
//      owner/repo-shaped token, is therefore treated as its own required
//      repo reference.

import { normalizeGitUrl } from './gitAllowlist.js';

const ALLOWED = {
  pr: new Set(['create', 'view', 'list', 'edit', 'comment', 'merge', 'close', 'reopen', 'ready', 'review', 'checks', 'diff', 'status', 'checkout']),
  issue: new Set(['create', 'view', 'list', 'edit', 'comment', 'close', 'reopen', 'status']),
  release: new Set(['create', 'view', 'list', 'edit', 'delete', 'upload', 'download', 'delete-asset']),
  workflow: new Set(['run', 'view', 'list', 'enable', 'disable']),
  repo: new Set(['view']),
};

const URL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

// See pitfall (1) above. Only a bare "-R" or the attached "-Rvalue" form are
// unambiguous; any other multi-letter short-dash token (length > 2, not
// starting with "-R") could be bundling flags we don't know about, possibly
// including a hidden "-R". A 2-char short flag ("-w", "-t", ...) can't bundle
// anything -- there's only one letter -- so those are left alone.
function hasAmbiguousShortFlag(argv) {
  return argv.some((a) => {
    if (a === '-' || !a.startsWith('-') || a.startsWith('--')) return false;
    if (a === '-R' || a.length <= 2) return false;
    return !a.startsWith('-R');
  });
}

// Find the value of -R/--repo in argv, in any of gh's accepted forms
// (`-R owner/repo`, `-Rowner/repo`, `--repo owner/repo`, `--repo=owner/repo`).
function parseRepoFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-R' || a === '--repo') return argv[i + 1] || null;
    if (a.startsWith('--repo=')) return a.slice('--repo='.length);
    if (a.startsWith('-R') && a.length > 2) return a.slice(2);
  }
  return null;
}

// A PR/issue/discussion URL (https://github.com/owner/repo/pull/123) points
// at a repo just as much as a plain repo URL does, but has extra path
// segments after owner/repo -- normalizeGitUrl alone would keep them as
// part of the "path" and never match the plain "host/owner/repo" allow-list
// entry. Take only the first two path segments (owner/repo) from the URL,
// then run those through normalizeGitUrl for the actual host normalization.
function repoFromUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  return normalizeGitUrl(`https://${u.host}/${segments[0]}/${segments[1]}`);
}

// gh's -R/--repo (and repo view's bare positional) accepts "OWNER/REPO"
// (assumed github.com), "HOST/OWNER/REPO", or a full URL.
function normalizeOwnerRepoOrUrl(raw) {
  if (!raw) return null;
  if (URL_RE.test(raw)) return repoFromUrl(raw);
  const parts = raw.split('/').filter(Boolean);
  if (parts.length === 2) return normalizeGitUrl(`https://github.com/${parts[0]}/${parts[1]}`);
  if (parts.length === 3) return normalizeGitUrl(`https://${parts[0]}/${parts[1]}/${parts[2]}`);
  return null;
}

// Classify a gh invocation. `resolveCwdOrigin` is a callback returning the
// session cwd's raw origin remote URL (or null) -- called lazily, only when
// no repo reference is found anywhere in argv, since it shells out to git.
//
// Returns { allowed, repos, reason }:
//   - allowed: whether the subcommand is on the safelist AND every repo
//     reference found in argv could be resolved. This does NOT check the
//     resolved repo(s) against the session's git allow-list -- callers must
//     do that themselves (see git-broker.js), since this module only knows
//     about gh's own argument shape.
//   - repos: array of normalized "host[:port]/path" targets that must ALL be
//     allow-listed (usually one entry; can be more if e.g. both --repo and a
//     URL positional are present).
//   - reason: set when allowed is false ('subcommand-not-allowed',
//     'ambiguous-flags', or 'repo-unresolved').
export function classifyGhInvocation(argv, resolveCwdOrigin) {
  const top = argv[0];
  const sub = argv[1];
  if (!top || !ALLOWED[top] || !sub || !ALLOWED[top].has(sub)) {
    return { allowed: false, repos: [], reason: 'subcommand-not-allowed' };
  }
  if (hasAmbiguousShortFlag(argv)) {
    return { allowed: false, repos: [], reason: 'ambiguous-flags' };
  }

  const rest = argv.slice(2);
  const repoFlagValue = parseRepoFlag(argv);
  const explicit = repoFlagValue ? normalizeOwnerRepoOrUrl(repoFlagValue) : null;
  if (repoFlagValue && !explicit) return { allowed: false, repos: [], reason: 'repo-unresolved' };

  const urlRefs = rest.filter((a) => URL_RE.test(a)).map((u) => repoFromUrl(u));
  if (urlRefs.some((u) => !u)) return { allowed: false, repos: [], reason: 'repo-unresolved' };

  // `repo view`'s positional accepts a bare owner/repo shorthand too (not
  // just a URL) -- everything else's non-URL positionals are numbers/branch
  // names/tags/workflow ids, never a repo reference, so this only applies here.
  let bareRepoRefs = [];
  if (top === 'repo') {
    bareRepoRefs = rest
      .filter((a) => a !== repoFlagValue && !a.startsWith('-') && !URL_RE.test(a))
      .map((a) => normalizeOwnerRepoOrUrl(a))
      .filter(Boolean); // tokens that don't parse as owner/repo are flag values etc. -- not a repo reference, ignored
  }

  const repos = new Set();
  if (explicit) repos.add(explicit);
  for (const u of urlRefs) repos.add(u);
  for (const r of bareRepoRefs) repos.add(r);

  if (repos.size === 0) {
    const fallback = normalizeGitUrl(resolveCwdOrigin() || '');
    if (!fallback) return { allowed: false, repos: [], reason: 'repo-unresolved' };
    repos.add(fallback);
  }

  return { allowed: true, repos: [...repos], reason: null };
}
