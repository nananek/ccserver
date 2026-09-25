// POST /api/git/clone (routes/git.js): clone a GitHub repository into a new
// directory under the directory the Files screen is showing, by running
// `gh repo clone <url> <dir> --no-upstream` ON THE HOST as the user ccserver
// runs as (#278, owner decision (b)). The credentials are that user's gh /
// git setup; nothing here reads or forwards a token.
//
// PROVISIONAL DEFAULTS -- pending owner confirmation (Q2 / Q3). They are
// deliberately conservative and are not a decision:
//   Q2 destination: ONE new directory directly under the shown directory,
//      inside browseRoots; the name comes from the URL's last element or an
//      explicit override (one path element; no `/` `\` `.` `..`, control
//      characters, or leading `-`); an existing non-empty directory is refused.
//   Q3 URL: `OWNER/REPO` or `https://github.com/OWNER/REPO[.git]` only, host
//      github.com only; userinfo, a leading `-`, other schemes, local paths and
//      ssh are refused. The server normalizes the URL and hands gh THAT https
//      URL, so gh's git_protocol setting cannot turn it into an ssh clone.
//
// Why each piece is the way it is:
//
//   - argv is fixed: ['repo', 'clone', <normalized url>, <staging dir>,
//     '--no-upstream']. No user text becomes a gh or git flag, and nothing is
//     passed after `--` to git.
//   - The child's environment is an allowlist (hostGit.js), plus prompt /
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
//     can still interfere -- no path-based scheme closes that. Not addressed
//     here; noted for the owner.
//   - Limits: a timeout (the child's whole process group is killed), a cap on
//     concurrent clones, and a cap on captured output.
//   - After a successful clone the new repository's config is read (read-only,
//     `git config --file`) to confirm origin, and only origin, is what gh will
//     treat as the default (no `upstream` remote, no gh-resolved elsewhere).
//     That is what `--no-upstream` is documented to give; a mismatch is
//     reported as a warning, not an error -- the clone itself succeeded.
//   - Nothing is run inside the new repository (no `git status`, no submodule
//     update).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isContained, resolveWithinRoots } from './pathPolicy.js';
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

export function buildCloneEnv(source = process.env) {
  return buildChildEnv(source, {
    network: true,
    extra: {
      GIT_TERMINAL_PROMPT: '0',
      GH_PROMPT_DISABLED: '1',
      GIT_ALLOW_PROTOCOL: 'https',
      GIT_LFS_SKIP_SMUDGE: '1',
      ...gitConfigEnv(CLONE_GIT_CONFIG),
    },
  });
}

const ok = (data) => ({ ok: true, data });
const fail = (code, message) => ({ ok: false, code, message });

// ---------------------------------------------------------------------------
// Validation

// GitHub owner names: alphanumerics and hyphens, 1-39 chars, no hyphen at
// either end. Repository names: alphanumerics, `.`, `_`, `-`, up to 100.
const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?';
const REPO = '[A-Za-z0-9._-]{1,100}';
const SHORTHAND_RE = new RegExp(`^(${OWNER})/(${REPO})$`);
const HTTPS_RE = new RegExp(`^https://github\\.com/(${OWNER})/(${REPO})$`, 'i');
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/;
const WHITESPACE_RE = /\s/;
const USERINFO_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*@/;

const URL_HELP = 'Use OWNER/REPO or https://github.com/OWNER/REPO';

// -> { ok: true, url, owner, repo } | { ok: false, message }
export function parseCloneUrl(input) {
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
  const match = raw.match(SHORTHAND_RE) || raw.match(HTTPS_RE);
  if (!match) return { ok: false, message: `Unsupported url. ${URL_HELP}` };
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, '');
  if (!repo || repo === '.' || repo === '..') {
    return { ok: false, message: `Unsupported url. ${URL_HELP}` };
  }
  return { ok: true, url: `https://github.com/${owner}/${repo}.git`, owner, repo };
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

function tailText(text, max = 1000) {
  const cleaned = text.replace(ANSI_RE, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
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
//     conflict | busy | gh-unavailable | timeout | clone-failed | internal
// `deps` exists for tests: ghBin, gitBin, sourceEnv, timeoutMs,
// maxConcurrent, maxOutputBytes, platform, slots.
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

  if (typeof parent !== 'string' || !parent) return fail('validation', 'parent is required');
  const parsed = parseCloneUrl(url);
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
    return await cloneInto({ parent, dirName, url: parsed.url }, roots, opts);
  } finally {
    opts.slots.active -= 1;
  }
}

async function cloneInto({ parent, dirName, url }, roots, opts) {
  const pinned = await pinParent(parent, roots, opts.platform);
  if (!pinned.ok) return pinned;
  const pin = pinned.data;
  const env = buildCloneEnv(opts.sourceEnv);
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
    // Refuse early when the final name is taken: an existing non-empty
    // directory (or anything that is not a directory) is a conflict. An empty
    // directory may be replaced by the rename below, like git clone into one.
    const finalFs = join(pin.fsPath, dirName);
    let replacesEmptyDir = false;
    let existing = null;
    try {
      existing = await lstat(finalFs);
    } catch (err) {
      if (err.code === 'ENAMETOOLONG') return fail('validation', 'Folder name is too long');
      if (err.code !== 'ENOENT') throw err;
    }
    if (existing) {
      if (!existing.isDirectory()) return fail('conflict', 'A file with that name already exists');
      if ((await readdir(finalFs)).length > 0) return fail('conflict', 'Directory already exists and is not empty');
      replacesEmptyDir = true;
    }

    stageName = await makeStagingDir(pin.fsPath);

    const result = await runChild(
      opts.ghBin,
      ['repo', 'clone', url, stageName, '--no-upstream'],
      { pin, env, timeoutMs: opts.timeoutMs, maxOutputBytes: opts.maxOutputBytes },
    );
    if (result.spawnError) {
      await cleanup();
      if (result.spawnError.code === 'ENOENT') return fail('gh-unavailable', 'gh is not installed on this server');
      return fail('internal', `Could not run gh: ${result.spawnError.message}`);
    }
    if (result.timedOut) {
      await cleanup();
      return fail('timeout', `Clone timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
    }
    if (result.code !== 0) {
      const detail = tailText(result.stderr) || tailText(result.stdout);
      const hint = result.code === 4 ? ' (gh is not authenticated for the server user)' : '';
      await cleanup();
      return fail('clone-failed', `gh repo clone failed (exit ${result.code})${hint}${detail ? `: ${detail}` : ''}`);
    }

    // gh said it worked: make sure there is a repository before publishing it.
    const gitEntry = await lstat(join(pin.fsPath, stageName, '.git')).catch(() => null);
    if (!gitEntry) {
      await cleanup();
      return fail('clone-failed', 'gh reported success but no repository was created');
    }
    const warnings = await checkGhDefault(join(pin.realPath, stageName), opts);

    try {
      await rename(join(pin.fsPath, stageName), finalFs);
    } catch (err) {
      await cleanup();
      if (err.code === 'ENOTEMPTY' || err.code === 'EEXIST' || err.code === 'ENOTDIR') {
        return fail('conflict', 'Directory already exists and is not empty');
      }
      throw err;
    }
    stageName = null;
    if (replacesEmptyDir) warnings.push('Replaced an existing empty directory');
    return ok({ path: join(pin.realPath, dirName), name: dirName, url, warnings });
  } catch (err) {
    await cleanup();
    return fail('internal', err.message);
  } finally {
    await pin.close();
  }
}
