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
//   - `gh api` (any GitHub API endpoint, not repo-scoped at all -- could
//     read/write far beyond any single repo). Two narrow exceptions: a GET
//     against a LITERAL repos/{owner}/{repo}/actions/... endpoint, and a GET
//     against that repo's Security-tab alert endpoints -- code-scanning,
//     Dependabot, and secret-scanning alerts. Both are repo-scoped and
//     read-only, so they're allowed (see classifyGhApi below); every other
//     `gh api` call -- including the {owner}/{repo} placeholder form -- is
//     still refused. (Note: secret-scanning alert objects carry the leaked
//     secret's type/location/state, never the secret value itself -- gh
//     never returns that over this API -- so this is not a credential leak
//     the way `gh secret`/`gh auth` below would be. `dependabot/secrets`,
//     Dependabot's own repo-secret store, is deliberately NOT included here
//     for exactly that reason.)
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
  // 'upload' deliberately NOT included: its whole point is uploading
  // HOST-path files (`gh release upload <tag> <files>...`) as release assets,
  // with no --body-file-shaped flag to gate -- there is no argument here
  // that could ever be "a session-tree path" instead. Refused outright (H2
  // follow-up, review on #179 P1 item 1) until a design exists that stages
  // asset bytes through the sandbox rather than letting the host `gh` open
  // an arbitrary host path by name.
  release: new Set(['create', 'view', 'list', 'edit', 'delete', 'download', 'delete-asset']),
  workflow: new Set(['run', 'view', 'list', 'enable', 'disable']),
  run: new Set(['list', 'view', 'watch']),
  repo: new Set(['view']),
};

const URL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

// The only `gh api` endpoint shapes allowed: a GET on repos/OWNER/REPO/
// actions/... with LITERAL owner/repo strings (see classifyGhApi for why the
// "{owner}"/"{repo}" placeholder form is refused). The leading "/" is
// optional. Anything under actions/ is required (a bare "repos/o/r/actions"
// call has no real-world use, so it's not accepted). graphql, /user,
// /orgs/..., non-actions repos/... endpoints, and absolute URLs
// (https://api.github.com/...) all fail this regex and stay refused.
const API_ACTIONS_PATH_RE = /^\/?repos\/([^/]+)\/([^/]+)\/actions\/.+$/;

// The Security-tab counterpart of the above: a GET on repos/OWNER/REPO/ +
// one of the three alert-listing prefixes, again with LITERAL owner/repo.
// Unlike actions/, the bare prefix itself (no trailing path) is a real,
// commonly-used call -- "list alerts" -- so it's accepted with or without a
// trailing /<alert-number>[/...] segment (e.g. .../locations,
// .../dismissed-comment). Only these three prefixes: not
// "dependabot/secrets" (Dependabot's own repo secrets -- credential
// management, refused just like `gh secret`) and not
// "security-advisories" (can carry embargoed/private advisory text, a
// different risk than alert metadata).
const API_SECURITY_ALERTS_PATH_RE = /^\/?repos\/([^/]+)\/([^/]+)\/(?:code-scanning\/alerts|dependabot\/alerts|secret-scanning\/alerts)(?:\/.+)?$/;

// workflow run/enable/disable trigger/write operations (kick off CI, toggle
// a workflow's on/off state), so unlike every other subcommand they must NOT
// silently fall back to the cwd origin -- an explicit --repo/-R or a URL
// positional in argv is required. Read-only subcommands (pr/issue/release/
// repo view, run/workflow view+list, gh api Actions) keep the cwd fallback.
const REQUIRE_EXPLICIT_REPO = new Set(['workflow:run', 'workflow:enable', 'workflow:disable']);

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

// Find every -R/--repo value in argv, in any of gh's accepted forms
// (`-R owner/repo`, `-Rowner/repo`, `--repo owner/repo`, `--repo=owner/repo`).
// Returns an array (possibly empty). Every occurrence is collected, not just
// the first: gh (pflag) keeps only the LAST occurrence of a plain string flag
// like --repo, so checking only the first one would let `--repo allow/x
// --repo evil/y` sail through checked against allow/x while gh actually acts
// on evil/y. All values are required repo references instead (pitfall 2).
function parseRepoFlags(argv) {
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-R' || a === '--repo') {
      if (argv[i + 1]) values.push(argv[i + 1]);
      continue;
    }
    if (a.startsWith('--repo=')) {
      values.push(a.slice('--repo='.length));
      continue;
    }
    if (a.startsWith('-R') && a.length > 2) values.push(a.slice(2));
  }
  return values;
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

// `gh api`'s data flags (-f/--raw-field, -F/--field, --input) silently turn
// the default HTTP method into POST when no method is given, and the bundled
// short-flag hazard (-fX bundling -f with -X) can't be safely distinguished
// here -- so for `api` specifically, short flags are refused entirely (only
// long-form flags are accepted) and the data flags are always refused (v1:
// no GET-query-parameter via -f/--field yet -- could be relaxed later by
// allowing them when --method=GET is explicit). --hostname is refused too:
// it redirects the request to another host, where the repo/path allowlist
// check above is meaningless. (GH_HOST is an env var and never reaches the
// host gh process -- execGh forwards only argv+stdin -- so it can't be used
// for this; a host-side GH_HOST would just fail closed, see the literal
// github.com path below.) If --method is present its value (either form)
// must be GET (case-insensitive); omitting --method is fine since the data
// flags are already banned, so gh's default (GET) can't silently become POST.
// Returns true when the invocation must be refused.
function apiRejectsFlags(argv) {
  return argv.some((a, i) => {
    if (a === '-' || !a.startsWith('-')) return false;
    if (!a.startsWith('--')) return true; // any short-flag token is refused
    if (a === '--raw-field' || a.startsWith('--raw-field=') ||
        a === '--field' || a.startsWith('--field=') ||
        a === '--input' || a.startsWith('--input=')) return true;
    if (a === '--hostname' || a.startsWith('--hostname=')) return true;
    if (a === '--method') {
      const v = argv[i + 1];
      return !v || v.toUpperCase() !== 'GET';
    }
    if (a.startsWith('--method=')) return a.slice('--method='.length).toUpperCase() !== 'GET';
    return false;
  });
}

// The dedicated `gh api` path: only GETs on repos/OWNER/REPO/actions/... or
// repos/OWNER/REPO/{code-scanning,dependabot,secret-scanning}/alerts...
// (see API_ACTIONS_PATH_RE / API_SECURITY_ALERTS_PATH_RE) are allowed, with
// the owner/repo written out LITERALLY. The endpoint's own owner/repo is
// collected as the required repo reference (pitfall 2: an endpoint naming
// one repo plus a --repo flag naming another must have both checked by the
// caller).
//
// The "{owner}"/"{repo}" placeholder form is deliberately NOT supported. gh
// fills placeholders from its own base-repo resolution (the root --repo flag,
// the GH_REPO env var, or the cwd origin) and always sends the request to the
// host's default API host -- both of which can diverge from the repo we can
// see and check here. Concretely: with a cwd whose origin is a GHES remote,
// or a HOST/OWNER/REPO / URL --repo value, the placeholders would expand to
// owner/repo while the request goes to api.github.com/repos/<owner>/<repo>,
// i.e. a github.com repo we never checked (the cwd's own GHES origin is by
// definition allow-listed, so this sails through). Requiring the owner/repo
// literally means the checked repo is exactly the repo gh will call.
function classifyGhApi(argv) {
  const endpoint = argv[1];
  const match = endpoint && (API_ACTIONS_PATH_RE.exec(endpoint) || API_SECURITY_ALERTS_PATH_RE.exec(endpoint));
  if (!match) {
    return { allowed: false, repos: [], reason: 'subcommand-not-allowed' };
  }
  if (apiRejectsFlags(argv)) {
    return { allowed: false, repos: [], reason: 'ambiguous-flags' };
  }

  const [, owner, repo] = match;

  // A dot segment can change the effective URL path before the request is
  // handled, escaping the checked repo or the allowed scope. gh sends
  // the endpoint verbatim, and the API server percent-decodes the path once
  // (net/http then cleans ".." segments via redirect, which gh follows), so
  // the whole path is decoded once here -- exactly the server's view -- and
  // then split on "/". This catches not just bare/percent-encoded "." and
  // ".." segments but also a ".." smuggled inside one segment via an encoded
  // slash ("..%2f..", "%2e%2e%2f..."). The query string is excluded: it never
  // affects routing, and an encoded slash there can be legitimate (e.g.
  // "?head=feature%2Ffix"). Fail closed if the path isn't valid percent
  // encoding -- gh would send it through and the server would reject it too.
  const pathOnly = endpoint.split('?')[0];
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathOnly);
  } catch {
    return { allowed: false, repos: [], reason: 'subcommand-not-allowed' };
  }
  if (decodedPath.split('/').some((s) => s === '.' || s === '..')) {
    return { allowed: false, repos: [], reason: 'subcommand-not-allowed' };
  }

  // Any template ({owner}/{repo} in any slot, or their %7B/%7D forms) is
  // refused -- see the comment above: gh would fill it from a repo we can't
  // see, so the actual target could be a repo that was never checked.
  const hasTemplate = (value) => /[{}]|%7[bBdD]/i.test(value);
  if (hasTemplate(owner) || hasTemplate(repo)) {
    return { allowed: false, repos: [], reason: 'repo-unresolved' };
  }

  const repoFlagValues = parseRepoFlags(argv);
  const explicits = repoFlagValues.map((v) => normalizeOwnerRepoOrUrl(v));
  if (explicits.some((x) => !x)) return { allowed: false, repos: [], reason: 'repo-unresolved' };

  const repos = new Set();
  for (const e of explicits) repos.add(e);

  const literal = normalizeGitUrl(`https://github.com/${owner}/${repo}`);
  if (!literal) return { allowed: false, repos: [], reason: 'repo-unresolved' };
  repos.add(literal);

  return { allowed: true, repos: [...repos], reason: null };
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
//     'ambiguous-flags', 'repo-unresolved', or 'repo-must-be-explicit').
export function classifyGhInvocation(argv, resolveCwdOrigin) {
  const top = argv[0];
  const sub = argv[1];

  // `gh api` has no subcommand in the safelist sense -- its first positional
  // is the endpoint. Route it to its own dedicated (Actions-read-only-only)
  // classifier before the generic subcommand check below.
  if (top === 'api') {
    return classifyGhApi(argv);
  }

  if (!top || !ALLOWED[top] || !sub || !ALLOWED[top].has(sub)) {
    return { allowed: false, repos: [], reason: 'subcommand-not-allowed' };
  }
  if (hasAmbiguousShortFlag(argv)) {
    return { allowed: false, repos: [], reason: 'ambiguous-flags' };
  }

  const rest = argv.slice(2);
  const repoFlagValues = parseRepoFlags(argv);
  const explicits = repoFlagValues.map((v) => normalizeOwnerRepoOrUrl(v));
  if (explicits.some((x) => !x)) return { allowed: false, repos: [], reason: 'repo-unresolved' };

  const urlRefs = rest.filter((a) => URL_RE.test(a)).map((u) => repoFromUrl(u));
  if (urlRefs.some((u) => !u)) return { allowed: false, repos: [], reason: 'repo-unresolved' };

  // `repo view`'s positional accepts a bare owner/repo shorthand too (not
  // just a URL) -- everything else's non-URL positionals are numbers/branch
  // names/tags/workflow ids, never a repo reference, so this only applies here.
  let bareRepoRefs = [];
  if (top === 'repo') {
    bareRepoRefs = rest
      .filter((a) => !repoFlagValues.includes(a) && !a.startsWith('-') && !URL_RE.test(a))
      .map((a) => normalizeOwnerRepoOrUrl(a))
      .filter(Boolean); // tokens that don't parse as owner/repo are flag values etc. -- not a repo reference, ignored
  }

  const repos = new Set();
  for (const e of explicits) repos.add(e);
  for (const u of urlRefs) repos.add(u);
  for (const r of bareRepoRefs) repos.add(r);

  if (repos.size === 0) {
    if (REQUIRE_EXPLICIT_REPO.has(`${top}:${sub}`)) {
      return { allowed: false, repos: [], reason: 'repo-must-be-explicit' };
    }
    const fallback = normalizeGitUrl(resolveCwdOrigin() || '');
    if (!fallback) return { allowed: false, repos: [], reason: 'repo-unresolved' };
    repos.add(fallback);
  }

  return { allowed: true, repos: [...repos], reason: null };
}

// ---------------------------------------------------------------------------
// Message-text content/boundary guard (plan8 + H2, layered on top of the
// allow/deny decision above -- see git-broker.js's findBlockedGhText). Once a
// gh invocation is allow-listed, several subcommands carry free-form text
// (title/body/notes/comment) that could itself smuggle a `Claude-Session:`
// trailer or session URL into a shared PR/issue/release -- the exact leak
// commitGuard.js already blocks for local git commits, but gh's own text
// never goes through a git commit-msg hook. Separately, every file-valued
// field (--body-file/-F, --notes-file/-F) names a HOST path gh reads outside
// the sandbox, so git-broker.js always confines it to the session tree (H2).
// This section only locates WHERE that text lives in argv (and, for file
// fields, what kind of source it names); the pattern match reuses
// commitGuard.js's compiled patterns, in git-broker.js.
//
// Scoped per `gh <cmd> --help`: only the subcommands already on ALLOWED above
// whose flags were confirmed against their help output are listed. Anything
// not listed here is simply not checked -- extending coverage means adding
// another TEXT_FIELDS entry, not new parsing logic. H2's fix originally
// covered only `pr:*`, which let every other free-form-text subcommand
// (issue/release/close/reopen) carry an out-of-tree --body-file/--notes-file
// straight through; the issue:/release:/pr:merge/close/reopen entries below
// close that gap. NOTE the shared short flags are NOT uniform across
// subcommands: `gh pr review -c` is a boolean --comment, whereas
// close/reopen's `-c` takes a value -- hence the per-entry short/long pairs.
const TEXT_FIELDS = {
  'pr:create': [
    { field: 'title', short: '-t', long: '--title' },
    { field: 'body', short: '-b', long: '--body' },
    { field: 'body-file', short: '-F', long: '--body-file', file: true },
  ],
  'pr:edit': [
    { field: 'title', short: '-t', long: '--title' },
    { field: 'body', short: '-b', long: '--body' },
    { field: 'body-file', short: '-F', long: '--body-file', file: true },
  ],
  'pr:comment': [
    { field: 'body', short: '-b', long: '--body' },
    { field: 'body-file', short: '-F', long: '--body-file', file: true },
  ],
  'pr:review': [
    { field: 'body', short: '-b', long: '--body' },
    { field: 'body-file', short: '-F', long: '--body-file', file: true },
  ],
  'pr:merge': [
    { field: 'subject', short: '-t', long: '--subject' },
    { field: 'body', short: '-b', long: '--body' },
    { field: 'body-file', short: '-F', long: '--body-file', file: true },
  ],
  'pr:close': [
    { field: 'comment', short: '-c', long: '--comment' },
  ],
  'pr:reopen': [
    { field: 'comment', short: '-c', long: '--comment' },
  ],
  'issue:create': [
    { field: 'title', short: '-t', long: '--title' },
    { field: 'body', short: '-b', long: '--body' },
    { field: 'body-file', short: '-F', long: '--body-file', file: true },
  ],
  'issue:edit': [
    { field: 'title', short: '-t', long: '--title' },
    { field: 'body', short: '-b', long: '--body' },
    { field: 'body-file', short: '-F', long: '--body-file', file: true },
  ],
  'issue:comment': [
    { field: 'body', short: '-b', long: '--body' },
    { field: 'body-file', short: '-F', long: '--body-file', file: true },
  ],
  'issue:close': [
    { field: 'comment', short: '-c', long: '--comment' },
  ],
  'issue:reopen': [
    { field: 'comment', short: '-c', long: '--comment' },
  ],
  'release:create': [
    { field: 'title', short: '-t', long: '--title' },
    { field: 'notes', short: '-n', long: '--notes' },
    { field: 'notes-file', short: '-F', long: '--notes-file', file: true },
  ],
  'release:edit': [
    { field: 'title', short: '-t', long: '--title' },
    { field: 'notes', short: '-n', long: '--notes' },
    { field: 'notes-file', short: '-F', long: '--notes-file', file: true },
  ],
};

// Collects every value passed to `short`/`long` in argv. Only the
// space-separated ("-b value", "--body value") and "--body=value" forms are
// recognized -- an attached short form ("-bvalue") is already refused
// upstream by hasAmbiguousShortFlag (only "-R"/"-Rvalue" are ever accepted
// attached; every other multi-letter short-dash token is denied outright),
// so by the time this runs argv can't contain one. All occurrences are
// returned, not just the first/last -- same reasoning as parseRepoFlags
// above: which one gh actually uses is gh's business, ours is not to
// silently skip checking one of them.
function extractFlagValues(argv, short, long) {
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === short || a === long) {
      if (argv[i + 1] !== undefined) values.push(argv[i + 1]);
      continue;
    }
    if (a.startsWith(`${long}=`)) values.push(a.slice(long.length + 1));
  }
  return values;
}

// Returns every title/body-bearing value found in argv, tagged with where it
// came from: {field, kind:'literal', value} for a value given directly in
// argv, or {field, kind:'file', value: <"-"-or-path>} for --body-file ("-"
// means "read from stdin", anything else is a path to resolve against the
// session cwd). Resolving 'file' entries into actual text is the caller's
// job (git-broker.js has the stdin buffer and cwd; this module never touches
// the filesystem or decodes anything).
export function extractGhTextFields(argv) {
  const fields = TEXT_FIELDS[`${argv[0]}:${argv[1]}`];
  if (!fields) return [];
  const out = [];
  for (const f of fields) {
    for (const value of extractFlagValues(argv, f.short, f.long)) {
      out.push(f.file ? { field: f.field, kind: 'file', value } : { field: f.field, kind: 'literal', value });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Host file-argument boundary, independent of TEXT_FIELDS (H2 follow-up --
// review on PR #179, P1 item 1). TEXT_FIELDS/extractGhTextFields above only
// ever locates the flags it was told about (title/body/notes and their
// -file counterparts); several OTHER gh flags/positionals ALSO name a HOST
// path gh (unsandboxed, running on the host) opens directly, with no
// title/body-shaped field for that table to ever notice:
//   - `release create <tag> [<files>...]`: positional asset files/patterns.
//   - `release download --dir/-D` / `--output/-O <path>`: host-side WRITE
//     destinations (a related finding from the same review, tracked here
//     rather than separately since it's the same class of boundary).
//   - `workflow run -F/--field key=@path`: gh's own `@file` value syntax.
//   - `--attach <path>` (pr/issue create/edit/comment): a host file read as
//     an upload attachment.
//   - `pr checkout --worktree`: a host-side WRITE destination for the new
//     worktree.
// (`release upload`'s entire purpose is uploading host-path files with no
// gating flag to check at all -- see ALLOWED.release's comment -- so it's
// refused outright, upstream of this module, rather than parsed here.)
//
// Deliberately NOT a generic flag-shape scanner: every subcommand below is
// enumerated by name, its flags classified by hand against `gh <cmd>
// --help`. parseKnownArgs fails an invocation closed on any flag it doesn't
// recognize (see its own comment) rather than guess whether an unmodeled
// flag is boolean or value-taking and let a future gh version's new
// file-argument flag through unchecked.
//
// Called by git-broker.js's handleGhExec once classifyGhInvocation has
// already allowed the subcommand -- this is a filesystem boundary, not a
// content policy, so (like findBlockedGhText's file-arg-requires-stdin case)
// it is enforced unconditionally, independent of commitMessageGuard config.
// Returns {field, reason} for the first blocked shape found, or null.

// Splits `rest` (argv.slice(2), everything after "<top> <sub>") into
// positionals and flag-shaped tokens, consuming each known flag's value
// token when it takes one. `knownFlags`: array of {short?, long?, value}.
// Short tokens here are always exactly 2 chars or the attached "-Rvalue"
// form: classifyGhInvocation's hasAmbiguousShortFlag has already refused
// every other short-dash token (any short flag longer than 2 chars not
// starting with "-R") upstream of this ever running, so there is no
// "-Xvalue" attached-short-value form left to handle except -R's.
//
// `unknownFlag` is the first flag-shaped token matching neither a known
// short nor long name -- callers must fail the WHOLE invocation closed on
// this, not assume it takes no value: an unrecognized flag could itself be
// another file-argument flag, or could swallow the very positional this is
// trying to classify.
function parseKnownArgs(rest, knownFlags) {
  const shortMap = new Map();
  const longMap = new Map();
  for (const f of knownFlags) {
    if (f.short) shortMap.set(f.short, f);
    if (f.long) longMap.set(f.long, f);
  }
  const positionals = [];
  let sawDashDash = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (sawDashDash) { positionals.push(a); continue; }
    if (a === '--') { sawDashDash = true; continue; }
    if (a === '-' || !a.startsWith('-')) { positionals.push(a); continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      const f = longMap.get(name);
      if (!f) return { positionals, unknownFlag: a };
      if (f.value && eq === -1) i += 1;
      continue;
    }
    if (a.startsWith('-R') && a.length > 2) continue; // attached "-Rvalue"
    const f = shortMap.get(a);
    if (!f) return { positionals, unknownFlag: a };
    if (f.value) i += 1;
  }
  return { positionals, unknownFlag: null };
}

const RELEASE_CREATE_FLAGS = [
  { short: '-d', long: '--draft', value: false },
  { long: '--discussion-category', value: true },
  { long: '--generate-notes', value: false },
  { long: '--latest', value: false },
  { short: '-n', long: '--notes', value: true },
  { short: '-F', long: '--notes-file', value: true },
  { long: '--notes-from-tag', value: false },
  { short: '-p', long: '--prerelease', value: false },
  { short: '-R', long: '--repo', value: true },
  { long: '--target', value: true },
  { short: '-t', long: '--title', value: true },
  { long: '--verify-tag', value: false },
];

// `gh release create <tag> [<files>...] [flags]`: anything positional past
// the tag is an asset file/pattern gh uploads by opening it on the host.
function findBlockedReleaseCreateArgs(argv) {
  const { positionals, unknownFlag } = parseKnownArgs(argv.slice(2), RELEASE_CREATE_FLAGS);
  if (unknownFlag) return { field: 'release-create', reason: 'unrecognized-flag' };
  if (positionals.length > 1) return { field: 'release-create-assets', reason: 'release-assets-not-allowed' };
  return null;
}

// `gh release download`'s -D/--dir and -O/--output name a host-side WRITE
// destination outside the session tree; -O/--output is fine when its value
// is exactly "-" (stdout, relayed back through execGh's own stdout capture
// -- no host file involved).
function findBlockedReleaseDownloadArgs(argv) {
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-D' || a === '--dir' || a.startsWith('--dir=')) {
      return { field: 'release-download-dir', reason: 'release-download-dir-not-allowed' };
    }
    if (a === '-O' || a === '--output') {
      if (rest[i + 1] !== '-') return { field: 'release-download-output', reason: 'release-download-output-not-stdout' };
    } else if (a.startsWith('--output=')) {
      if (a.slice('--output='.length) !== '-') return { field: 'release-download-output', reason: 'release-download-output-not-stdout' };
    }
  }
  return null;
}

// `gh workflow run -F/--field key=value` type-infers the value and, per gh's
// own syntax, reads it from a HOST file when the value starts with "@" --
// "@-" means stdin (fine, no host file), any other "@path" is the same
// exfiltration shape as --body-file. -f/--raw-field is always a literal
// string (no "@file" interpretation), so it's left alone.
function findBlockedWorkflowRunArgs(argv) {
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    let raw;
    if (a === '-F' || a === '--field') raw = rest[i + 1];
    else if (a.startsWith('--field=')) raw = a.slice('--field='.length);
    else continue;
    if (raw === undefined) continue;
    const eq = raw.indexOf('=');
    const value = eq === -1 ? '' : raw.slice(eq + 1);
    if (value.startsWith('@') && value.slice(1) !== '-') {
      return { field: 'workflow-run-field', reason: 'workflow-field-file-not-allowed' };
    }
  }
  return null;
}

// `--attach <path>` (pr/issue create/edit/comment): reads a host file to
// upload as an attachment. No session-tree exception -- there's no
// sandbox-side wrapper yet that stages attachment bytes safely (see the
// review's suggested design), so it's refused outright for now.
function findBlockedAttachArg(argv) {
  if (argv.some((a) => a === '--attach' || a.startsWith('--attach='))) {
    return { field: 'attach', reason: 'attach-not-allowed' };
  }
  return null;
}

// `gh pr checkout --worktree`: creates the new worktree at a host-side path
// outside the session tree (unlike a plain checkout, which stays inside the
// already-allow-listed repo clone).
function findBlockedCheckoutWorktreeArg(argv) {
  if (argv.some((a) => a === '--worktree' || a.startsWith('--worktree='))) {
    return { field: 'checkout-worktree', reason: 'checkout-worktree-not-allowed' };
  }
  return null;
}

export function findBlockedGhFileArg(argv) {
  const top = argv[0];
  const sub = argv[1];
  if (top === 'release' && sub === 'create') return findBlockedReleaseCreateArgs(argv);
  if (top === 'release' && sub === 'download') return findBlockedReleaseDownloadArgs(argv);
  if (top === 'workflow' && sub === 'run') return findBlockedWorkflowRunArgs(argv);
  if ((top === 'pr' || top === 'issue') && (sub === 'create' || sub === 'edit' || sub === 'comment')) {
    return findBlockedAttachArg(argv);
  }
  if (top === 'pr' && sub === 'checkout') return findBlockedCheckoutWorktreeArg(argv);
  return null;
}
