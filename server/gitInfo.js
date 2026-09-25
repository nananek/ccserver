// Read-only description of the git repository around a directory, for the
// Files screen's indicator (GET /api/git/info, routes/git.js): repository
// root, current branch, and the remotes with the one git treats as the
// default.
//
// What makes this module different from a `git status` wrapper is who wrote
// the repository. A sandboxed agent can write any repo it works in -- its
// `.git/config` included (#214) -- and this runs on the HOST, outside every
// sandbox. So:
//
//   - Only commands that do not run repository-configured programs are used
//     (GIT_INFO_ARGS below). Measured with git 2.55.0: `git status` and
//     `git diff` execute core.fsmonitor from the repo's config; `rev-parse`,
//     `symbolic-ref` and `config` do not. There is deliberately NO dirty flag:
//     it would need `status`. gitInfo.test.js pins both halves (the commands
//     used stay inert, and `status` is still the one that is not).
//   - runGit() additionally pins core.fsmonitor / core.sshCommand /
//     core.askpass / protocol.ext.allow off on every call.
//   - The remotes come from `git config --file <common dir>/config`, the
//     same source gitAllowlist.js derives the credential allow-list from, so
//     what is shown is what the next launch will be derived from.
//   - Everything read is untrusted text: control and bidi characters are
//     stripped, lengths are capped, and userinfo is removed from URLs so a
//     token embedded in a remote URL is never sent to the browser.
//   - The repository must lie wholly inside browseRoots. A `.git` file can
//     point anywhere (`gitdir: /elsewhere`); following it would read a
//     repository the file APIs refuse to show.
//   - `.git` being a FIFO / device (a read blocks forever), an oversized
//     `.git` file, or an oversized config are refused before or instead of
//     handing them to git; the git calls themselves also carry a timeout.

import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isContained, resolveWithinRoots } from './pathPolicy.js';
import { buildChildEnv, runGit, GIT_READ_TIMEOUT_MS } from './hostGit.js';

export const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_GITFILE_BYTES = 64 * 1024;
const MAX_REMOTES = 64;
const MAX_TEXT = 300;
const MAX_PATH_TEXT = 1000;

// The keys read from the config file: remote URLs, the branch -> remote
// mapping, and remote.pushDefault (git lower-cases the variable name).
const CONFIG_KEY_RE = '^(remote\\..+\\.(url|pushurl)|remote\\.pushdefault|branch\\..+\\.remote)$';

// Every git invocation this module makes. Exported so the test can run each
// one WITHOUT runGit's hardening flags and prove they are inert on their own.
export const GIT_INFO_ARGS = Object.freeze({
  layout: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
  headRef: ['symbolic-ref', '--quiet', 'HEAD'],
  headShort: ['rev-parse', '--short', 'HEAD'],
  config: (file) => ['config', '--file', file, '--null', '--get-regexp', CONFIG_KEY_RE],
});

const ok = (data) => ({ ok: true, data });
const fail = (code, message) => ({ ok: false, code, message });

// Control characters, bidi overrides / isolates and zero-width marks: none
// belong in a name or URL, and the bidi ones can make a URL read as another
// host. React renders text, not markup, so this is about spoofing and log
// hygiene rather than XSS.
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export function sanitizeText(value, max = MAX_TEXT) {
  const text = String(value ?? '').replace(UNSAFE_TEXT_RE, '');
  return text.length > max ? `${text.slice(0, max)}\u2026` : text;
}

// Removes the userinfo from a remote URL for display. scheme://user:pw@host
// and scp-like user@host:path both lose it; the last '@' of the authority
// wins (a password may contain '@'). Anything else is returned untouched.
export function stripUserinfo(raw) {
  const text = String(raw ?? '');
  const withScheme = text.match(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)([\s\S]*)$/);
  if (withScheme) {
    const at = withScheme[2].lastIndexOf('@');
    return withScheme[1] + (at === -1 ? withScheme[2] : withScheme[2].slice(at + 1)) + withScheme[3];
  }
  const scp = text.match(/^[^@/:\s]+@([^:/\s]+:[\s\S]*)$/);
  return scp ? scp[1] : text;
}

function displayUrl(raw) {
  return sanitizeText(stripUserinfo(raw));
}

// `config --null --get-regexp` prints "key\nvalue\0" per entry (a valueless
// key has no newline).
function parseConfigEntries(stdout) {
  const entries = [];
  for (const chunk of stdout.split('\0')) {
    if (!chunk) continue;
    const nl = chunk.indexOf('\n');
    entries.push(nl === -1 ? [chunk, ''] : [chunk.slice(0, nl), chunk.slice(nl + 1)]);
  }
  return entries;
}

// remotes: insertion-ordered by first appearance in the file. url is the
// first fetch URL (git allows several; only the first is shown), pushUrl the
// first pushurl. `branch.<current>.remote` and remote.pushdefault feed the
// default; a later value wins for those, as in git.
function summarizeConfig(entries, branchName) {
  const remotes = new Map();
  const remote = (name) => {
    if (!remotes.has(name)) remotes.set(name, { name, url: null, pushUrl: null });
    return remotes.get(name);
  };
  let pushDefault = null;
  let branchRemote = null;
  const branchKey = branchName === null ? null : `branch.${branchName}.remote`;
  for (const [key, value] of entries) {
    if (key === 'remote.pushdefault') {
      pushDefault = value;
    } else if (key.startsWith('remote.') && key.endsWith('.pushurl')) {
      const name = key.slice('remote.'.length, -'.pushurl'.length);
      const r = remote(name);
      if (r.pushUrl === null) r.pushUrl = value;
    } else if (key.startsWith('remote.') && key.endsWith('.url')) {
      const name = key.slice('remote.'.length, -'.url'.length);
      const r = remote(name);
      if (r.url === null) r.url = value;
    } else if (branchKey !== null && key === branchKey) {
      branchRemote = value;
    }
  }
  // A remote is a remote because it has a fetch URL.
  const list = [...remotes.values()].filter((r) => r.url !== null);
  return { list, pushDefault, branchRemote };
}

// The remote git falls back to: the current branch's remote, else
// remote.pushDefault, else origin. "." is git's spelling of "this
// repository" for branch.<b>.remote, not a remote.
export function pickDefaultRemote({ branchRemote, pushDefault }) {
  if (branchRemote && branchRemote !== '.') return { name: branchRemote, source: 'branch' };
  if (pushDefault) return { name: pushDefault, source: 'pushDefault' };
  return { name: 'origin', source: 'origin' };
}

// True when `.git` (looked at from `dir` itself; an ancestor's is git's to
// find) is something a git call can safely be pointed at.
async function gitEntryUsable(dir) {
  let st;
  try {
    st = await lstat(join(dir, '.git'));
  } catch {
    return true;
  }
  if (st.isSymbolicLink()) {
    try {
      st = await stat(join(dir, '.git'));
    } catch {
      return false;
    }
  }
  if (st.isDirectory()) return true;
  if (st.isFile()) return st.size <= MAX_GITFILE_BYTES;
  return false; // FIFO, socket, device
}

const notRepo = (dir, reason) => ok({ path: dir, isRepo: false, ...(reason ? { reason } : {}) });

export async function readGitInfo(requestedPath, roots, opts = {}) {
  const {
    gitBin = 'git',
    timeoutMs = GIT_READ_TIMEOUT_MS,
    maxConfigBytes = MAX_CONFIG_BYTES,
    env = buildChildEnv(),
  } = opts;

  if (typeof requestedPath !== 'string' || !requestedPath) {
    return fail('validation', 'path is required');
  }
  const resolved = resolveWithinRoots(requestedPath, roots);
  if (!resolved.ok) {
    return fail('forbidden', 'Path is outside the allowed browseRoots');
  }

  let dir;
  try {
    dir = await realpath(resolved.path);
    if (!(await stat(dir)).isDirectory()) return fail('validation', 'Not a directory');
  } catch (err) {
    if (err.code === 'ENOENT') return fail('not-found', 'Directory not found');
    if (err.code === 'ENOTDIR') return fail('validation', 'Not a directory');
    if (err.code === 'EACCES') return fail('forbidden', 'Permission denied');
    throw err;
  }
  // The realpath actually used, not the one checked a moment ago.
  if (!isContained(dir, roots)) {
    return fail('forbidden', 'Path is outside the allowed browseRoots');
  }

  if (!(await gitEntryUsable(dir))) return notRepo(dir, 'unreadable');

  const run = (args) => runGit(args, { cwd: dir, timeoutMs, gitBin, env });

  const layout = await run(GIT_INFO_ARGS.layout);
  if (!layout.ok) {
    if (layout.error?.code === 'ENOENT') return notRepo(dir, 'git-unavailable');
    if (layout.timedOut) return notRepo(dir, 'timeout');
    return notRepo(dir); // not a repository (or one git refuses: unsafe owner, bare, ...)
  }
  const lines = layout.stdout.replace(/\n$/, '').split('\n');
  if (lines.length !== 3 || lines.some((l) => !l)) return notRepo(dir, 'unreadable');
  const toplevel = lines[0];
  const gitDir = lines[1];
  const commonDir = isAbsolute(lines[2]) ? lines[2] : resolve(dir, lines[2]);

  // browseRoots must cover the whole repository, not just the directory the
  // request named: a gitlink or an ancestor repository can lead outside it.
  if (roots.length > 0 && !(isContained(toplevel, roots) && isContained(gitDir, roots) && isContained(commonDir, roots))) {
    return notRepo(dir, 'outside-roots');
  }

  const [realGitDir, realCommonDir] = await Promise.all([
    realpath(gitDir).catch(() => gitDir),
    realpath(commonDir).catch(() => commonDir),
  ]);

  let head;
  // The raw ref name is what a `branch.<name>.remote` key is spelled with;
  // the copy sent to the browser is sanitized.
  let rawBranch = null;
  const sym = await run(GIT_INFO_ARGS.headRef);
  if (sym.ok) {
    const ref = sym.stdout.trim();
    rawBranch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    head = { kind: 'branch', name: sanitizeText(rawBranch) };
  } else if (sym.code === 1) {
    // `--quiet` exits 1 exactly when HEAD is not a symbolic ref: detached.
    const short = await run(GIT_INFO_ARGS.headShort);
    const sha = short.ok ? short.stdout.trim() : '';
    head = { kind: 'detached', commit: /^[0-9a-f]{4,64}$/.test(sha) ? sha : null };
  } else {
    head = { kind: 'unknown' };
  }

  let summary = { list: [], pushDefault: null, branchRemote: null };
  let configTooLarge = false;
  let configError = false;
  const cfgPath = join(commonDir, 'config');
  const cfgStat = await lstat(cfgPath).catch(() => null);
  if (cfgStat && cfgStat.isFile()) {
    if (cfgStat.size > maxConfigBytes) {
      configTooLarge = true;
    } else {
      const cfg = await run(GIT_INFO_ARGS.config(cfgPath));
      if (cfg.ok) summary = summarizeConfig(parseConfigEntries(cfg.stdout), rawBranch);
      else if (cfg.code !== 1) configError = true; // 1 = no matching key
    }
  }

  const def = summary.list.length > 0 ? pickDefaultRemote(summary) : null;
  const remotes = summary.list.slice(0, MAX_REMOTES).map((r) => ({
    name: sanitizeText(r.name),
    url: displayUrl(r.url),
    pushUrl: r.pushUrl === null ? null : displayUrl(r.pushUrl),
    isDefault: def !== null && r.name === def.name,
  }));

  return ok({
    path: dir,
    isRepo: true,
    root: sanitizeText(toplevel, MAX_PATH_TEXT),
    worktree: realGitDir !== realCommonDir,
    head,
    remotes,
    truncated: summary.list.length > MAX_REMOTES,
    defaultRemote: def === null ? null : { name: sanitizeText(def.name), source: def.source },
    ...(configTooLarge ? { configTooLarge: true } : {}),
    ...(configError ? { configError: true } : {}),
  });
}
