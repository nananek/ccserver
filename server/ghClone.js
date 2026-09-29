// POST /api/git/clone (routes/git.js): clone a repository into a new
// directory under the directory the Files screen is showing, ON THE HOST as the
// user ccserver runs as (#278, owner decision (b)). The credentials are that
// user's gh / git setup; nothing here reads or forwards a token.
//
//   tool "gh"   `gh repo clone <url> <dir> --no-upstream`. GitHub / GHES only:
//               gh cannot talk to anything else. --no-upstream is what keeps a
//               fork's origin the default (gh would otherwise add `upstream`).
//   tool "git"  `git clone -- <url> <dir>`, for Gitea and any other host. A
//               plain clone creates neither `upstream` nor gh's `gh-resolved`,
//               so origin is the default without any extra flag.
//
// Which hosts, and which tool for each, comes from sandbox.config.json's
// "clone" block (cloneConfig.js; default: github.com with gh). The URL you
// give is only ever matched against that list, exactly.
//
// PROVISIONAL DEFAULTS -- pending owner confirmation (Q2 / Q3). They are
// deliberately conservative and are not a decision:
//   Q2 destination: ONE new directory directly under the shown directory,
//      inside browseRoots; the name comes from the URL's last element or an
//      explicit override (one path element; no `/` `\` `.` `..`, control
//      characters, or leading `-`); anything already at that name is refused.
//      (Owner decision: also refused when a running session's working
//      directory is the shown directory or one of its parents.)
//   Q3 URL: `OWNER/REPO` (always github.com) or `https://HOST/OWNER/REPO[.git]`
//      with HOST a configured host, exactly (case-folded; no port, no trailing
//      dot, no Unicode); userinfo, a leading `-`, other schemes, local paths
//      and ssh are refused. The server normalizes the URL and hands the tool
//      THAT https URL, so a git_protocol setting cannot turn it into ssh.
//
// Why each piece is the way it is:
//
//   - argv is fixed per tool: gh ['repo', 'clone', <normalized url>, <staging
//     dir>, '--no-upstream'], git ['clone', '--', <normalized url>, <staging
//     dir>]. No user text becomes a gh or git flag: the URL is rebuilt from a
//     matched host and two validated path elements, the directory is our own
//     random name. Both tools get the same environment, pins, pinned parent,
//     staging directory, limits and cleanup.
//   - The child's environment is an allowlist (hostGit.js; GH_TOKEN /
//     GITHUB_TOKEN only for gh or github.com, see buildCloneEnv), plus prompt /
//     protocol / config pins: GIT_TERMINAL_PROMPT=0, GH_PROMPT_DISABLED=1,
//     GIT_ALLOW_PROTOCOL=https, GIT_LFS_SKIP_SMUDGE=1 and GIT_CONFIG_COUNT
//     entries (CLONE_GIT_CONFIG). Config from the environment outranks the
//     host's ~/.gitconfig, so a global core.hooksPath or url.<x>.insteadOf
//     cannot redirect or arm the clone. Which of these actually bite was
//     measured with git 2.55.0 (see ghClone.test.js).
//   - TOCTOU: the parent directory is opened and PINNED by file descriptor
//     (the shape of routes/files.js's upload); the containment check is made
//     on the pinned directory, and the child runs with that directory as its
//     working directory through /proc/self/fd/3 (Linux), so swapping the path
//     for a symlink afterwards changes nothing. The clone itself runs in a
//     freshly mkdir'd staging directory inside the pinned parent and is renamed to
//     its final name only after it succeeded. That was chosen over "let git
//     create the final directory" because (1) no half-cloned directory ever
//     appears under the final name, whatever kills the clone; (2) git never
//     meets a pre-existing, possibly agent-planted entry at the final name;
//     (3) failure cleanup only touches a directory this call created.
//     Residual: an agent that can write INSIDE the staging directory while the
//     clone runs (a live sandbox session whose tree contains the destination)
//     can interfere -- no path-based scheme closes that. So a destination that
//     is, or lies under, the working directory of a running session is refused
//     up front (owner decision), before anything is created or run. Not closed:
//     a session LAUNCHED into such a directory while the clone runs, and rw
//     binds other than the cwd (sandbox.config.json "binds", a worktree's
//     shared git dir).
//   - Limits: a timeout (the child's whole process group is killed), a cap on
//     concurrent clones, and a cap on captured output.
//   - After a successful `gh` clone the new repository's config is read
//     (read-only, `git config --file`) to confirm origin, and only origin, is
//     what gh will treat as the default (no `upstream` remote, no gh-resolved
//     elsewhere). That is what `--no-upstream` is documented to give; a
//     mismatch is reported as a warning, not an error -- the clone itself
//     succeeded. A plain `git clone` cannot produce either, so nothing is read.
//   - Nothing is run inside the new repository (no `git status`, no submodule
//     update).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isContained, resolveWithinRoots } from './pathPolicy.js';
import { DEFAULT_CLONE_HOSTS } from './cloneConfig.js';
import { buildChildEnv, gitConfigEnv, runGit } from './hostGit.js';

// Provisional values (owner: "timeout / concurrency / output caps" were asked
// for; the numbers are not specified). Injectable through cloneRepository's
// third argument.
export const CLONE_DEFAULTS = Object.freeze({
  timeoutMs: 10 * 60 * 1000,
  maxConcurrent: 2,
  maxOutputBytes: 64 * 1024,
});

const MAX_URL_LENGTH = 300;
const MAX_NAME_BYTES = 255; // NAME_MAX on the filesystems this runs on
const STAGING_PREFIX = '.ccserver-clone-';

// Config the clone's git processes see from the environment.
// Measured effect (git 2.55.0, host-style global config): core.hooksPath
// stops a global post-checkout hook; protocol.file.allow=never stops a
// url.<x>.insteadOf that rewrites https to file://; the empty core.* keys are
// harmless; an empty filter.lfs.smudge fails the clone unless
// filter.lfs.required=false is set alongside it.
export const CLONE_GIT_CONFIG = Object.freeze([
  ['core.hooksPath', '/dev/null'],
  ['protocol.ext.allow', 'never'],
  ['protocol.file.allow', 'never'],
  ['core.fsmonitor', ''],
  ['core.sshCommand', ''],
  ['core.askpass', ''],
  ['filter.lfs.smudge', ''],
  ['filter.lfs.process', ''],
  ['filter.lfs.required', 'false'],
]);

// GH_TOKEN / GITHUB_TOKEN are GitHub's. gh keeps them off other hosts itself; a
// plain git never reads them, but every credential helper it starts inherits
// them, so a git clone of anything but github.com runs without (`githubToken:
// false`) rather than hand a GitHub token to whatever that host's helper is.
const GITHUB_TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN'];

export function buildCloneEnv(source = process.env, { githubToken = true } = {}) {
  const env = buildChildEnv(source, {
    network: true,
    extra: {
      GIT_TERMINAL_PROMPT: '0',
      GH_PROMPT_DISABLED: '1',
      GIT_ALLOW_PROTOCOL: 'https',
      GIT_LFS_SKIP_SMUDGE: '1',
      ...gitConfigEnv(CLONE_GIT_CONFIG),
    },
  });
  if (!githubToken) for (const key of GITHUB_TOKEN_VARS) delete env[key];
  return env;
}

const ok = (data) => ({ ok: true, data });
const fail = (code, message) => ({ ok: false, code, message });

// What an unexpected failure becomes for the client. The message of a raw fs
// error names the /proc/self/fd/N path the call went through (and the staging
// name), which means nothing to the caller; the ordinary "cannot write here"
// cases get their own answer, the rest is logged and reported by code alone.
export function fsFailure(err) {
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return fail('forbidden', 'Permission denied');
  if (err?.code === 'EROFS') return fail('forbidden', 'Read-only file system');
  if (err?.code === 'ENOSPC') return fail('internal', 'No space left on device');
  console.error(`[git-clone] unexpected failure: ${err?.stack || err}`);
  return fail('internal', `Clone failed unexpectedly${err?.code ? ` (${err.code})` : ''}; see the server log`);
}

// ---------------------------------------------------------------------------
// Validation

// GitHub owner names: alphanumerics and hyphens, 1-39 chars, no hyphen at
// either end. Elsewhere (Gitea and friends) a user or organization may also
// contain `.` and `_`, so the shape is wider there -- but it still starts and
// ends with an alphanumeric, which is what rules out `.` / `..` as an owner.
// Repository names: alphanumerics, `.`, `_`, `-`, up to 100.
const GITHUB_HOST = 'github.com';
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const OTHER_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
// The host is captured as plain ASCII, then matched EXACTLY (lower-cased)
// against the configured list. Anything else in that position -- a port, an
// `@`, a Unicode look-alike, a `%`-escape -- does not match and is refused.
const HTTPS_URL_RE = /^https:\/\/([A-Za-z0-9.-]+)\/([^/]+)\/([^/]+)$/i;
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/;
const WHITESPACE_RE = /\s/;
const USERINFO_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*@/;

function urlHelp(hosts) {
  const names = hosts.map((h) => h.host);
  const shorthand = names.includes(GITHUB_HOST) ? 'OWNER/REPO (github.com) or ' : '';
  return `Use ${shorthand}https://HOST/OWNER/REPO with HOST one of: ${names.join(', ') || '(none)'}`;
}

// hosts: the configured [{ host, tool }] (cloneConfig.js).
// -> { ok: true, url, owner, repo, host, tool } | { ok: false, message }
export function parseCloneUrl(input, hosts = DEFAULT_CLONE_HOSTS) {
  if (typeof input !== 'string') return { ok: false, message: 'url is required' };
  const raw = input.trim();
  if (!raw) return { ok: false, message: 'url is required' };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, message: 'url is too long' };
  if (CONTROL_RE.test(raw) || WHITESPACE_RE.test(raw)) {
    return { ok: false, message: 'url must not contain whitespace or control characters' };
  }
  if (raw.startsWith('-')) return { ok: false, message: 'url must not start with "-"' };
  if (USERINFO_RE.test(raw)) {
    return { ok: false, message: 'url must not contain credentials (user:password@)' };
  }
  const unsupported = { ok: false, message: `Unsupported url. ${urlHelp(hosts)}` };
  const allowed = new Map(hosts.map((h) => [h.host, h]));

  let entry;
  let owner;
  let repo;
  const shorthand = raw.match(/^([^/]+)\/([^/]+)$/);
  if (shorthand) {
    // OWNER/REPO has always meant GitHub; it does not follow the list order.
    if (!GITHUB_OWNER_RE.test(shorthand[1]) || !REPO_RE.test(shorthand[2])) return unsupported;
    entry = allowed.get(GITHUB_HOST);
    if (!entry) {
      return { ok: false, message: `OWNER/REPO means github.com, which is not an allowed host here. ${urlHelp(hosts)}` };
    }
    [, owner, repo] = shorthand;
  } else {
    const match = raw.match(HTTPS_URL_RE);
    if (!match) return unsupported;
    const host = match[1].toLowerCase();
    entry = allowed.get(host);
    if (!entry) return { ok: false, message: `Host "${host}" is not allowed. ${urlHelp(hosts)}` };
    const ownerRe = host === GITHUB_HOST ? GITHUB_OWNER_RE : OTHER_OWNER_RE;
    if (!ownerRe.test(match[2]) || !REPO_RE.test(match[3])) return unsupported;
    [, , owner, repo] = match;
  }
  repo = repo.replace(/\.git$/i, '');
  if (!repo || repo === '.' || repo === '..') return unsupported;
  return { ok: true, url: `https://${entry.host}/${owner}/${repo}.git`, owner, repo, host: entry.host, tool: entry.tool };
}

// -> { ok: true, name } | { ok: false, message }
export function validateCloneName(name) {
  if (typeof name !== 'string' || !name) return { ok: false, message: 'Folder name is required' };
  if (name === '.' || name === '..') return { ok: false, message: 'Invalid folder name' };
  if (name.includes('/') || name.includes('\\')) {
    return { ok: false, message: 'Folder name must be a single path element' };
  }
  if (CONTROL_RE.test(name)) return { ok: false, message: 'Folder name must not contain control characters' };
  if (name.startsWith('-')) return { ok: false, message: 'Folder name must not start with "-"' };
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    return { ok: false, message: 'Folder name is too long' };
  }
  return { ok: true, name };
}

// ---------------------------------------------------------------------------
// The pinned parent directory

// Opens the requested parent and returns what the rest of the flow needs.
//   realPath   the directory's real location, for the path returned to the UI
//   fsPath     what to use for fs calls (a /proc/self/fd path on Linux)
//   childCwd / childFd   how a child gets the SAME directory as its cwd
// On Linux the directory is pinned by fd, containment is judged from the fd,
// and later path swaps cannot redirect anything. Elsewhere there is no
// portable equivalent (same limitation routes/files.js documents for upload):
// the path is realpath'd and re-checked right before use, which narrows the
// window but does not close it.
async function pinParent(parent, roots, platform) {
  const resolved = resolveWithinRoots(parent, roots, parent);
  if (!resolved.ok) return fail('forbidden', 'Parent directory is outside the allowed browseRoots');

  const mapError = (err) => {
    if (err.code === 'ENOENT') return fail('not-found', 'Parent directory not found');
    if (err.code === 'ENOTDIR') return fail('validation', 'Parent is not a directory');
    if (err.code === 'EACCES') return fail('forbidden', 'Permission denied');
    // A NUL byte or an over-long name never names a directory.
    if (err.code === 'ERR_INVALID_ARG_VALUE' || err.code === 'ENAMETOOLONG') return fail('validation', 'Invalid parent path');
    return null;
  };

  if (platform === 'linux') {
    let handle;
    try {
      handle = await open(resolved.path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    } catch (err) {
      const mapped = mapError(err);
      if (mapped) return mapped;
      throw err;
    }
    try {
      const realPath = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!isContained(realPath, roots)) {
        await handle.close();
        return fail('forbidden', 'Parent directory is outside the allowed browseRoots');
      }
      return ok({
        realPath,
        fsPath: `/proc/self/fd/${handle.fd}`,
        childCwd: '/proc/self/fd/3',
        childFd: handle.fd,
        close: () => handle.close().catch(() => {}),
      });
    } catch (err) {
      await handle.close().catch(() => {});
      throw err;
    }
  }

  try {
    const realPath = await realpath(resolved.path);
    if (!(await stat(realPath)).isDirectory()) return fail('validation', 'Parent is not a directory');
    if (!isContained(realPath, roots)) {
      return fail('forbidden', 'Parent directory is outside the allowed browseRoots');
    }
    return ok({ realPath, fsPath: realPath, childCwd: realPath, childFd: null, close: async () => {} });
  } catch (err) {
    const mapped = mapError(err);
    if (mapped) return mapped;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Running the child

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// scheme://userinfo@host: the URL gh / git echo in an error can carry a token
// when the operator's own config rewrites github.com to one that has it. The
// last '@' of the authority ends the userinfo (a password may contain '@').
const USERINFO_IN_TEXT_RE = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#]*@/g;

function tailText(text, max = 1000) {
  const cleaned = text
    .replace(ANSI_RE, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(USERINFO_IN_TEXT_RE, '$1')
    .trim();
  return cleaned.length > max ? `...${cleaned.slice(-max)}` : cleaned;
}

// Runs `bin args` with cwd = the pinned directory. Resolves
// { code, signal, stdout, stderr, timedOut, outputTruncated, spawnError }.
function runChild(bin, args, { pin, env, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve) => {
    const stdio = pin.childFd === null
      ? ['ignore', 'pipe', 'pipe']
      : ['ignore', 'pipe', 'pipe', pin.childFd];
    let child;
    try {
      // detached: the child leads its own process group, so a timeout can
      // take gh and the git / git-remote-https it spawned down together.
      child = spawn(bin, args, { cwd: pin.childCwd, env, stdio, detached: true, shell: false, windowsHide: true });
    } catch (spawnError) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, outputTruncated: false, spawnError });
      return;
    }

    const chunks = { out: [], err: [] };
    const sizes = { out: 0, err: 0 };
    let outputTruncated = false;
    const collect = (kind) => (data) => {
      const room = maxOutputBytes - sizes[kind];
      if (room <= 0) { outputTruncated = true; return; }
      const piece = data.length > room ? data.subarray(0, room) : data;
      if (piece.length < data.length) outputTruncated = true;
      chunks[kind].push(piece);
      sizes[kind] += piece.length;
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));

    let timedOut = false;
    let spawnError = null;
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(chunks.out).toString('utf-8'),
        stderr: Buffer.concat(chunks.err).toString('utf-8'),
        timedOut,
        outputTruncated,
        spawnError,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }, timeoutMs);
    // A spawn failure (gh missing) reports 'error' and may never report
    // 'close'; do not wait for it.
    child.on('error', (err) => { spawnError = err; if (child.pid === undefined) finish(null, null); });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

// A new, unpredictably named directory in the pinned parent. mkdir (not
// mkdtemp) on purpose: mkdtemp creates it 0700, git keeps an existing
// directory's mode, and the finished clone would come out 0700 where a plain
// `git clone` gives the umask-derived mode (measured: 700 vs 755).
async function makeStagingDir(fsPath) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const name = `${STAGING_PREFIX}${randomBytes(6).toString('hex')}`;
    try {
      await mkdir(join(fsPath, name));
      return name;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('could not create a staging directory');
}

// ---------------------------------------------------------------------------
// After the clone

// Read-only look at the new repository's config: is origin, and only origin,
// what gh will treat as the default? Returns a list of warnings (empty = fine).
async function checkGhDefault(clonedDir, { gitBin }) {
  const cfgPath = join(clonedDir, '.git', 'config');
  const st = await lstat(cfgPath).catch(() => null);
  if (!st || !st.isFile() || st.size > 1024 * 1024) return ['Could not verify gh default remote'];
  const res = await runGit(
    ['config', '--file', cfgPath, '--null', '--get-regexp', '^remote\\..+\\.(url|gh-resolved)$'],
    { cwd: tmpdir(), gitBin, timeoutMs: 5000 },
  );
  if (!res.ok && res.code !== 1) return ['Could not verify gh default remote'];

  const urls = new Set();
  const resolved = new Map();
  for (const chunk of res.stdout.split('\0')) {
    if (!chunk) continue;
    const nl = chunk.indexOf('\n');
    const key = nl === -1 ? chunk : chunk.slice(0, nl);
    const value = nl === -1 ? '' : chunk.slice(nl + 1);
    if (key.endsWith('.gh-resolved')) resolved.set(key.slice('remote.'.length, -'.gh-resolved'.length), value);
    else if (key.endsWith('.url')) urls.add(key.slice('remote.'.length, -'.url'.length));
  }
  const warnings = [];
  if (!urls.has('origin')) warnings.push('The clone has no origin remote');
  if (urls.has('upstream')) warnings.push('An upstream remote exists, so gh will treat it as the default repository');
  const elsewhere = [...resolved.keys()].filter((name) => name !== 'origin');
  if (elsewhere.length > 0) warnings.push(`gh default is set on ${elsewhere.join(', ')}, not origin`);
  return warnings;
}

// ---------------------------------------------------------------------------

const defaultSlots = { active: 0 };

// cloneRepository({ parent, url, name? }, roots, deps?) ->
//   { ok: true, data: { path, name, url, warnings } }
//   { ok: false, code, message }   code: validation | forbidden | not-found |
//     conflict | busy | tool-unavailable | timeout | clone-failed | internal
// deps:
//   hosts            the configured [{ host, tool }] (default: github.com / gh)
//   liveSessionCwds  REQUIRED: () => the working directories of the running
//                    sessions. There is no default on purpose: a caller that
//                    forgot it would silently lose the running-session guard,
//                    so without it every clone is refused.
//   ghBin, gitBin, sourceEnv, timeoutMs, maxConcurrent, maxOutputBytes,
//   platform, slots  test seams.
export async function cloneRepository(request, roots, deps = {}) {
  const opts = {
    ghBin: 'gh',
    gitBin: 'git',
    sourceEnv: process.env,
    platform: process.platform,
    slots: defaultSlots,
    ...CLONE_DEFAULTS,
    ...deps,
  };
  const { parent, url, name } = request || {};

  if (typeof opts.liveSessionCwds !== 'function') {
    return fail('internal', 'Clone is not wired to the running-session check, so it is refused');
  }
  if (typeof parent !== 'string' || !parent) return fail('validation', 'parent is required');
  const parsed = parseCloneUrl(url, opts.hosts);
  if (!parsed.ok) return fail('validation', parsed.message);
  if (name !== undefined && name !== null && typeof name !== 'string') {
    return fail('validation', 'name must be a string');
  }
  const explicitName = typeof name === 'string' && name !== '';
  const checkedName = validateCloneName(explicitName ? name : parsed.repo);
  if (!checkedName.ok) {
    return fail('validation', explicitName ? checkedName.message : `${checkedName.message} (enter a folder name)`);
  }
  const dirName = checkedName.name;

  if (opts.slots.active >= opts.maxConcurrent) {
    return fail('busy', 'Too many clones are already running; try again shortly');
  }
  opts.slots.active += 1;
  try {
    return await cloneInto({ parent, dirName, url: parsed.url, tool: parsed.tool, host: parsed.host }, roots, opts);
  } finally {
    opts.slots.active -= 1;
  }
}

// True when `realDir` is one of `cwds` or lies beneath one of them (owner
// decision: a running session can write anywhere under its working directory,
// the staging directory included). Both spellings of each cwd are tried: the
// real one is where a symlinked cwd actually is, and the lexical one still
// counts when the real one cannot be resolved (a cwd removed since), so that
// failing to resolve never lets a destination through.
async function insideLiveSessionCwd(realDir, cwds) {
  for (const cwd of cwds) {
    if (typeof cwd !== 'string' || !cwd) continue;
    const spellings = [resolve(cwd)];
    try { spellings.push(await realpath(cwd)); } catch { /* the lexical spelling stands */ }
    for (const base of spellings) {
      const rel = relative(base, realDir);
      if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return true;
    }
  }
  return false;
}

// What each tool is run as. The URL and the staging name are the only
// variable parts, and neither is user text.
function commandFor(tool, url, stageName, opts) {
  if (tool === 'git') return { name: 'git', label: 'git clone', bin: opts.gitBin, args: ['clone', '--', url, stageName] };
  return { name: 'gh', label: 'gh repo clone', bin: opts.ghBin, args: ['repo', 'clone', url, stageName, '--no-upstream'] };
}

async function cloneInto({ parent, dirName, url, tool, host }, roots, opts) {
  const pinned = await pinParent(parent, roots, opts.platform).catch(fsFailure);
  if (!pinned.ok) return pinned;
  const pin = pinned.data;
  const env = buildCloneEnv(opts.sourceEnv, { githubToken: tool === 'gh' || host === GITHUB_HOST });
  let stageName = null;

  // Removes the staging directory. `rm` runs with the pinned directory as
  // its cwd and a relative name; GNU/BSD rm walk with fd-relative calls, so a
  // symlink swapped in mid-delete is not followed (a JS recursive rm is
  // path-based and would be).
  const cleanup = async () => {
    if (stageName === null) return;
    const name = stageName;
    stageName = null;
    try {
      if (pin.childFd !== null) {
        const res = await runChild('rm', ['-rf', '--', name], {
          pin, env: buildChildEnv(opts.sourceEnv), timeoutMs: 60_000, maxOutputBytes: 4096,
        });
        if (res.code !== 0) throw res.spawnError || new Error(`rm exited ${res.code}`);
      } else {
        await rm(join(pin.fsPath, name), { recursive: true, force: true });
      }
    } catch (err) {
      console.warn(`[git-clone] could not remove staging directory ${name}: ${err.message}`);
    }
  };

  try {
    // Owner decision: a destination inside the working directory of a running
    // session is refused before anything is created or run. The message says
    // why, and nothing about which session or where.
    if (await insideLiveSessionCwd(pin.realPath, await opts.liveSessionCwds())) {
      return fail('conflict', 'Cannot clone here: a running session uses this directory (or one above it) as its working directory. Close that session, or clone somewhere else.');
    }

    // Refuse early when the final name is taken by anything at all: the
    // destination is a NEW directory. (rename below would replace an empty
    // directory that appears in the meantime; that is all the race can cost.)
    const finalFs = join(pin.fsPath, dirName);
    try {
      await lstat(finalFs);
      return fail('conflict', 'A file or directory with that name already exists');
    } catch (err) {
      if (err.code === 'ENAMETOOLONG') return fail('validation', 'Folder name is too long');
      if (err.code !== 'ENOENT') throw err;
    }

    stageName = await makeStagingDir(pin.fsPath);

    const command = commandFor(tool, url, stageName, opts);
    const result = await runChild(
      command.bin,
      command.args,
      { pin, env, timeoutMs: opts.timeoutMs, maxOutputBytes: opts.maxOutputBytes },
    );
    if (result.spawnError) {
      await cleanup();
      if (result.spawnError.code === 'ENOENT') return fail('tool-unavailable', `${command.name} is not installed on this server`);
      return fail('internal', `Could not run ${command.name}: ${result.spawnError.message}`);
    }
    if (result.timedOut) {
      await cleanup();
      return fail('timeout', `Clone timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
    }
    if (result.code !== 0) {
      const detail = tailText(result.stderr) || tailText(result.stdout);
      const hint = command.name === 'gh' && result.code === 4 ? ' (gh is not authenticated for the server user)' : '';
      await cleanup();
      return fail('clone-failed', `${command.label} failed (exit ${result.code})${hint}${detail ? `: ${detail}` : ''}`);
    }

    // The tool said it worked: make sure there is a repository before publishing it.
    const gitEntry = await lstat(join(pin.fsPath, stageName, '.git')).catch(() => null);
    if (!gitEntry) {
      await cleanup();
      return fail('clone-failed', `${command.name} reported success but no repository was created`);
    }
    const warnings = command.name === 'gh' ? await checkGhDefault(join(pin.realPath, stageName), opts) : [];

    try {
      await rename(join(pin.fsPath, stageName), finalFs);
    } catch (err) {
      await cleanup();
      if (err.code === 'ENOTEMPTY' || err.code === 'EEXIST' || err.code === 'ENOTDIR') {
        return fail('conflict', 'A file or directory with that name already exists');
      }
      throw err;
    }
    stageName = null;
    return ok({ path: join(pin.realPath, dirName), name: dirName, url, warnings });
  } catch (err) {
    await cleanup();
    return fsFailure(err);
  } finally {
    await pin.close();
  }
}
