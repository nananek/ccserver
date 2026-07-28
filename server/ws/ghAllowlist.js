// Decides whether a `gh` invocation from inside the sandbox may be forwarded
// to the host and actually executed (by git-broker.js, over the same socket
// used for git HTTPS credentials -- see that file's protocol comment).
//
// gh's own API surface can't be repo-scoped by terminating/proxying its TLS
// traffic (that's why plain `gh` is bound-over inside the sandbox at all --
// see sandbox.js), so instead of trying to inspect network traffic we run
// specific, known-safe gh subcommands ourselves, on the host, after
// resolving which repo they target and checking that repo against the same
// allow-list already computed for git (gitAllowlist.js). Anything not
// explicitly named in ALLOWED is refused -- most importantly:
//   - `gh api` (arbitrary GitHub API endpoint, not repo-scoped at all --
//     could read/write far beyond any single repo)
//   - `gh auth` / `gh secret` / `gh variable` / `gh ssh-key` / `gh gpg-key`
//     (credential/secret management, not a repo operation)
//   - `gh repo clone` / `fork` / `create` / `delete` / `rename` (the target
//     repo is a bare positional argument with subcommand-specific parsing;
//     rather than reimplement that parsing to gate it, these are refused --
//     `gh repo view` is allowed since it only ever targets --repo/cwd)
//
// This is an allow-list, not a deny-list: a new gh subcommand is refused by
// default until someone deliberately adds it here.

import { normalizeGitUrl } from './gitAllowlist.js';

const ALLOWED = {
  pr: new Set(['create', 'view', 'list', 'edit', 'comment', 'merge', 'close', 'reopen', 'ready', 'review', 'checks', 'diff', 'status', 'checkout']),
  issue: new Set(['create', 'view', 'list', 'edit', 'comment', 'close', 'reopen', 'status']),
  release: new Set(['create', 'view', 'list', 'edit', 'delete', 'upload', 'download', 'delete-asset']),
  workflow: new Set(['run', 'view', 'list', 'enable', 'disable']),
  repo: new Set(['view']),
};

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

// gh's -R/--repo accepts "OWNER/REPO" (assumed github.com), "HOST/OWNER/REPO",
// or a full URL. Reuses normalizeGitUrl (via a synthetic https:// URL) so the
// result matches the same canonical form the git allow-list uses.
function normalizeGhRepoFlag(raw) {
  if (!raw) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return normalizeGitUrl(raw);
  const parts = raw.split('/').filter(Boolean);
  if (parts.length === 2) return normalizeGitUrl(`https://github.com/${parts[0]}/${parts[1]}`);
  if (parts.length === 3) return normalizeGitUrl(`https://${parts[0]}/${parts[1]}/${parts[2]}`);
  return null;
}

// Classify a gh invocation. `resolveCwdOrigin` is a callback returning the
// session cwd's raw origin remote URL (or null) -- called lazily, only when
// no explicit -R/--repo is present, since it shells out to git.
//
// Returns { allowed, repo, reason }:
//   - allowed: whether the subcommand is on the safelist AND a repo could be
//     resolved. This does NOT check the resolved repo against the session's
//     git allow-list -- callers must do that themselves (see git-broker.js),
//     since this module only knows about gh's own argument shape.
//   - repo: the normalized "host[:port]/path" target, or null.
//   - reason: set when allowed is false ('subcommand-not-allowed' or
//     'repo-unresolved').
export function classifyGhInvocation(argv, resolveCwdOrigin) {
  const top = argv[0];
  const sub = argv[1];
  if (!top || !ALLOWED[top] || !sub || !ALLOWED[top].has(sub)) {
    return { allowed: false, repo: null, reason: 'subcommand-not-allowed' };
  }

  const repoFlag = parseRepoFlag(argv);
  const repo = repoFlag ? normalizeGhRepoFlag(repoFlag) : normalizeGitUrl(resolveCwdOrigin() || '');
  if (!repo) return { allowed: false, repo: null, reason: 'repo-unresolved' };

  return { allowed: true, repo, reason: null };
}
