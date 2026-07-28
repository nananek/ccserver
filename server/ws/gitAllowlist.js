// Computes the set of repositories a sandboxed session is allowed to reach
// over git (HTTPS credential helper + SSH wrapper), so a compromised or
// runaway process inside the sandbox cannot use forwarded credentials
// against unrelated repos.
//
// The allow-list is derived once, at sandbox launch, from:
//   - the session cwd's own git remotes (.git/config)
//   - every submodule URL reachable from .gitmodules, walked recursively
//     (submodules of submodules), read directly from the .gitmodules file
//     so it works even for submodules that haven't been checked out yet
//
// Entries are normalized to a canonical "host[:port]/path" string (no
// scheme) so the same repo reached via SSH or HTTPS matches one entry. See
// normalizeGitUrl for the exact rules.

import { existsSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

const MAX_DEPTH = 10;

// Turn an scp-like git URL ([user@]host:path) into a URL-parseable form
// (ssh://[user@]host/path) so relative-URL resolution can reuse the WHATWG
// URL class. Anything that already has a scheme, or isn't scp-like, is
// returned unchanged.
function toUrlLike(raw) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return raw;
  const m = raw.match(/^(?:([^@/]+)@)?([^:/]+):(.+)$/);
  if (!m) return raw;
  const [, user, host, path] = m;
  return `ssh://${user ? `${user}@` : ''}${host}/${path}`;
}

// .gitmodules may declare a submodule URL relative to the parent's own
// remote URL (e.g. "../sibling.git"). Resolve it against the parent's
// origin URL so it normalizes to the same repo a direct URL would.
function resolveRelativeSubmoduleUrl(parentUrl, subUrl) {
  if (!/^\.\.?\//.test(subUrl) || !parentUrl) return subUrl;
  try {
    const base = toUrlLike(parentUrl);
    return new URL(subUrl, base.endsWith('/') ? base : `${base}/`).href;
  } catch {
    return subUrl;
  }
}

// Normalize a git remote URL to a canonical "host[:port]/path" string, or
// null if it can't be parsed as a network URL (e.g. a local filesystem
// path, which is out of scope for credential/ssh gating).
export function normalizeGitUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const url = rawUrl.trim();
  let host;
  let port = null;
  let path;

  const schemeMatch = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === 'file') return null;
    let rest = schemeMatch[2];

    const slashIdx = rest.indexOf('/');
    const atIdx = rest.indexOf('@');
    if (atIdx !== -1 && (slashIdx === -1 || atIdx < slashIdx)) {
      rest = rest.slice(atIdx + 1);
    }

    const pathIdx = rest.indexOf('/');
    if (pathIdx === -1) return null;
    let hostport = rest.slice(0, pathIdx);
    path = rest.slice(pathIdx + 1);

    if (hostport.startsWith('[')) {
      const closeIdx = hostport.indexOf(']');
      if (closeIdx === -1) return null;
      host = hostport.slice(0, closeIdx + 1);
      const remainder = hostport.slice(closeIdx + 1);
      if (remainder.startsWith(':')) port = remainder.slice(1);
    } else {
      const colonIdx = hostport.indexOf(':');
      if (colonIdx !== -1) {
        host = hostport.slice(0, colonIdx);
        port = hostport.slice(colonIdx + 1);
      } else {
        host = hostport;
      }
    }

    const defaultPort = scheme === 'https' ? '443' : scheme === 'http' ? '80' : scheme === 'ssh' ? '22' : null;
    if (port && port === defaultPort) port = null;
  } else {
    // scp-like shorthand: [user@]host:path (no scheme, no port possible).
    const m = url.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
    if (!m) return null; // e.g. a bare local path — not a network URL.
    [, host, path] = m;
  }

  if (!host || !path) return null;
  host = host.toLowerCase();
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!path) return null;

  return port ? `${host}:${port}/${path}` : `${host}/${path}`;
}

function gitConfigGetAll(file, pattern) {
  try {
    const out = execFileSync('git', ['config', '-f', file, '--get-regexp', pattern], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(Boolean).map((line) => {
      const idx = line.indexOf(' ');
      return idx === -1 ? [line, ''] : [line.slice(0, idx), line.slice(idx + 1)];
    });
  } catch {
    return [];
  }
}

function resolveGitDir(dir) {
  try {
    let gitDir = execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir'], {
      encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!gitDir) return null;
    if (!isAbsolute(gitDir)) gitDir = join(dir, gitDir);
    return gitDir;
  } catch {
    return null;
  }
}

// Recursively collect canonical "host/path" allow-list entries starting at
// repoRoot. Submodules are only recursed into when actually checked out
// (their working dir exists); an uninitialized submodule's own nested
// submodules simply cannot be discovered without a checkout — an accepted
// limitation, since the allow-list is computed once at launch anyway.
function walk(dir, depth, entries, visited) {
  if (depth > MAX_DEPTH) return;
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    return;
  }
  if (visited.has(real)) return;
  visited.add(real);

  let parentUrl = null;
  const gitDir = resolveGitDir(dir);
  if (gitDir) {
    const remotes = gitConfigGetAll(join(gitDir, 'config'), '^remote\\..*\\.url$');
    for (const [, url] of remotes) {
      const norm = normalizeGitUrl(url);
      if (norm) entries.add(norm);
    }
    const origin = remotes.find(([key]) => key === 'remote.origin.url');
    parentUrl = origin ? origin[1] : (remotes[0] ? remotes[0][1] : null);
  }

  const gitmodulesPath = join(dir, '.gitmodules');
  if (existsSync(gitmodulesPath)) {
    const pairs = gitConfigGetAll(gitmodulesPath, '^submodule\\..*\\.(url|path)$');
    const submodules = new Map();
    for (const [key, value] of pairs) {
      const m = key.match(/^submodule\.(.+)\.(url|path)$/);
      if (!m) continue;
      const [, name, field] = m;
      if (!submodules.has(name)) submodules.set(name, {});
      submodules.get(name)[field] = value;
    }
    for (const { url, path } of submodules.values()) {
      if (!url) continue;
      const resolved = resolveRelativeSubmoduleUrl(parentUrl, url);
      const norm = normalizeGitUrl(resolved);
      if (norm) entries.add(norm);
      if (!path) continue;
      const childDir = join(dir, path);
      try {
        if (statSync(childDir).isDirectory()) walk(childDir, depth + 1, entries, visited);
      } catch {
        // Not checked out — its own nested submodules are undiscoverable.
      }
    }
  }
}

// Compute the allow-list for a sandbox session rooted at cwd. Returns an
// empty array (deny everything) if cwd isn't inside a git repo at all —
// fail closed rather than skip the check.
export function computeGitAllowlist(cwd) {
  let repoRoot;
  try {
    repoRoot = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return [];
  }
  if (!repoRoot) return [];

  const entries = new Set();
  walk(repoRoot, 0, entries, new Set());
  return [...entries].sort();
}
