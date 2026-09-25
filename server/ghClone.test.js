// cloneRepository (ghClone.js): validation, the exact argv / environment /
// working directory gh receives, destination handling, TOCTOU, limits and
// cleanup. gh is replaced by a shell script (deps.ghBin) that records what it
// was given and, on success, fabricates the repository `gh repo clone
// --no-upstream` would have produced. No network is used.
//
// The last group exercises the environment against REAL git, to pin which of
// the pins actually bite (they were measured, not assumed).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  CLONE_GIT_CONFIG, buildCloneEnv, cloneRepository, parseCloneUrl, validateCloneName,
} from './ghClone.js';
import { buildChildEnv, gitConfigEnv } from './hostGit.js';
import { fixtureGitEnv, git, initRepo } from './testGitFixtures.js';

const execFileP = promisify(execFile);

let base;
let hostHome;
before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ccserver-ghclone-')));
  hostHome = join(base, 'home');
  mkdirSync(hostHome);
});
after(() => {
  rmSync(base, { recursive: true, force: true });
});

let counter = 0;
const uniq = (name) => join(base, `${name}-${counter++}`);

// A scratch area per test: `roots` is the allowed tree, `parent` a directory
// inside it, `rec` a directory for the fake gh's recordings.
function arena() {
  const root = uniq('arena');
  const parent = join(root, 'parent');
  const rec = join(root, 'rec');
  mkdirSync(parent, { recursive: true });
  mkdirSync(rec);
  return { root, parent, rec, roots: [root] };
}

// The default fake gh: record argv / env / cwd, then behave like
// `gh repo clone <url> <dir> --no-upstream`.
function ghBody(rec, { middle = '', build = true, exitCode = 0 } = {}) {
  return `#!/bin/sh
printf '%s\\n' "$@" > '${rec}/argv'
env > '${rec}/env'
pwd -P > '${rec}/cwd'
touch '${rec}/called'
${middle}
${build ? `mkdir -p "$4"
git init -q -b main "$4"
git -C "$4" remote add origin "$3"
git -C "$4" config remote.origin.gh-resolved base` : ''}
exit ${exitCode}
`;
}

function fakeGh(dir, body) {
  const path = join(dir, `gh-${counter++}`);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

const SOURCE_ENV = () => ({
  PATH: process.env.PATH,
  HOME: hostHome,
  GH_TOKEN: 'test-gh-token',
  // Things a child must NOT inherit from the server's environment.
  GIT_SSH_COMMAND: 'evil-ssh',
  GIT_DIR: '/nonexistent',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.pager',
  GIT_CONFIG_VALUE_0: 'evil-pager',
  LD_PRELOAD: '/tmp/evil.so',
  NODE_OPTIONS: '--evil',
  SECRET_CANARY: 'canary-value',
});

const fastSlots = () => ({ active: 0 });
async function clone(a, request, deps = {}) {
  return cloneRepository(request, a.roots, { slots: fastSlots(), sourceEnv: SOURCE_ENV(), ...deps });
}
const stagingLeft = (dir) => readdirSync(dir).filter((n) => n.startsWith('.ccserver-clone-'));
const readLines = (file) => readFileSync(file, 'utf-8').split('\n').filter(Boolean);
const waitFor = async (pred, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
};

// --- parseCloneUrl / validateCloneName ---------------------------------------

test('parseCloneUrl accepts OWNER/REPO and https://github.com/OWNER/REPO[.git] and normalizes both', () => {
  const expected = { ok: true, url: 'https://github.com/OWNER/REPO.git', owner: 'OWNER', repo: 'REPO' };
  for (const input of [
    'OWNER/REPO', 'OWNER/REPO.git', 'https://github.com/OWNER/REPO', 'https://github.com/OWNER/REPO.git',
    'HTTPS://GitHub.com/OWNER/REPO.git', '  OWNER/REPO  ',
  ]) {
    assert.deepEqual(parseCloneUrl(input), expected, input);
  }
  assert.equal(parseCloneUrl('o/.github').repo, '.github');
  assert.equal(parseCloneUrl('a-b/c_d.e').url, 'https://github.com/a-b/c_d.e.git');
});

test('parseCloneUrl refuses everything else', () => {
  const bad = [
    '', '   ', undefined, null, 42, {},
    '--upload-pack=touch /tmp/x', '-o/r', '--help',
    'ext::sh -c id', 'ext::sh -c "touch /tmp/x" %S',
    'file:///etc', 'file:///srv/repo.git', '/etc/passwd', '../x', './x', '~/x', 'C:\\repo',
    'https://user@github.com/o/r', 'https://user:pw@github.com/o/r', 'https://token@github.com/o/r.git',
    'http://github.com/o/r', 'ftp://github.com/o/r', 'git://github.com/o/r.git',
    'ssh://git@github.com/o/r.git', 'git@github.com:o/r.git', 'github.com:o/r',
    'https://evil.example/o/r', 'https://github.com.evil.example/o/r', 'https://evil.example/github.com/o/r',
    'https://github.com:8443/o/r', 'https://github.com/o/r?x=1', 'https://github.com/o/r#frag',
    'https://github.com/o/r/', 'https://github.com/o/r/tree/main', 'https://github.com/o',
    'https://github.com//o/r', 'https://github.com/o/r extra', 'o/r extra',
    'o/\x00r', 'o/r\x07', 'o\\r', 'o/r/extra', 'o', '/r', 'o/', '/',
    'o/..', 'o/.', 'o/.git', 'o/..git', '-x/y',
    `o/${'a'.repeat(101)}`, `${'a'.repeat(40)}/r`, `https://github.com/${'a'.repeat(400)}/r`,
    '$(touch /tmp/x)/r', 'o/`id`', 'o/r;id', 'o/r&id', 'o/r|id', 'o/r%00',
  ];
  for (const input of bad) {
    const res = parseCloneUrl(input);
    assert.equal(res.ok, false, `must refuse ${JSON.stringify(input)}, got ${JSON.stringify(res)}`);
    assert.equal(typeof res.message, 'string');
  }
});

test('validateCloneName: one path element, no . .. / \\ NUL controls or leading -', () => {
  for (const good of ['repo', 'my.repo', '.github', 'a b', 'a-b', 'ünï', 'x'.repeat(255)]) {
    assert.deepEqual(validateCloneName(good), { ok: true, name: good }, good);
  }
  for (const bad of ['', '.', '..', 'a/b', '/a', 'a/', 'a\\b', '-x', '--upload-pack=x', 'a\x00b', 'a\nb', 'a\x1bb', 'a\x7fb', 'x'.repeat(256), undefined, null, 5]) {
    assert.equal(validateCloneName(bad).ok, false, `must refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(validateCloneName('é'.repeat(128)).ok, false, 'the cap is in bytes (NAME_MAX), not characters');
});

// --- the child's argv / env / cwd -------------------------------------------------

test('a successful clone: fixed argv, pinned cwd, allowlisted env, final directory, nothing left behind', async () => {
  const a = arena();
  const ghBin = fakeGh(a.rec, ghBody(a.rec));
  const res = await clone(a, { parent: a.parent, url: 'OWNER/REPO' }, { ghBin });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.data.warnings, []);
  assert.equal(res.data.path, join(a.parent, 'REPO'));
  assert.equal(res.data.name, 'REPO');
  assert.equal(res.data.url, 'https://github.com/OWNER/REPO.git');
  assert.ok(existsSync(join(a.parent, 'REPO', '.git')));
  assert.deepEqual(stagingLeft(a.parent), []);
  assert.deepEqual(readdirSync(a.parent), ['REPO']);

  const argv = readLines(join(a.rec, 'argv'));
  assert.equal(argv.length, 5);
  assert.deepEqual([argv[0], argv[1], argv[2], argv[4]], ['repo', 'clone', 'https://github.com/OWNER/REPO.git', '--no-upstream']);
  assert.match(argv[3], /^\.ccserver-clone-[A-Za-z0-9]{6}$/, 'gh clones into a relative staging name');
  assert.equal(readLines(join(a.rec, 'cwd'))[0], realpathSync(a.parent), 'gh runs in the (pinned) parent directory');
});

test('the child environment is an allowlist plus the fixed pins', async () => {
  const a = arena();
  const ghBin = fakeGh(a.rec, ghBody(a.rec));
  assert.equal((await clone(a, { parent: a.parent, url: 'o/r' }, { ghBin })).ok, true);
  const env = Object.fromEntries(readLines(join(a.rec, 'env')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

  // What the server's own environment must NOT leak into the child.
  for (const key of ['GIT_SSH_COMMAND', 'GIT_DIR', 'LD_PRELOAD', 'NODE_OPTIONS', 'SECRET_CANARY']) {
    assert.ok(!(key in env), `${key} leaked into the child`);
  }
  // The operator's own gh / git identity does reach it.
  assert.equal(env.HOME, hostHome);
  assert.equal(env.GH_TOKEN, 'test-gh-token');
  assert.ok(env.PATH);
  // The pins.
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GH_PROMPT_DISABLED, '1');
  assert.equal(env.GIT_ALLOW_PROTOCOL, 'https');
  assert.equal(env.GIT_LFS_SKIP_SMUDGE, '1');
  assert.equal(env.GIT_CONFIG_COUNT, String(CLONE_GIT_CONFIG.length), 'the server\'s own GIT_CONFIG_COUNT must be replaced, not appended to');
  CLONE_GIT_CONFIG.forEach(([key, value], i) => {
    assert.equal(env[`GIT_CONFIG_KEY_${i}`], key);
    assert.equal(env[`GIT_CONFIG_VALUE_${i}`], value);
  });
  assert.ok(!Object.values(env).includes('evil-pager'));
});

test('the pinned config covers the hardening the owner listed', () => {
  const table = new Map(CLONE_GIT_CONFIG);
  assert.equal(table.get('core.hooksPath'), '/dev/null');
  assert.equal(table.get('protocol.ext.allow'), 'never');
  assert.equal(table.get('protocol.file.allow'), 'never');
  assert.equal(table.get('core.fsmonitor'), '');
  const env = buildCloneEnv(SOURCE_ENV());
  assert.equal(env.GIT_ALLOW_PROTOCOL, 'https');
});

test('an explicit name overrides the URL-derived one', async () => {
  const a = arena();
  const ghBin = fakeGh(a.rec, ghBody(a.rec));
  const res = await clone(a, { parent: a.parent, url: 'o/r', name: 'custom' }, { ghBin });
  assert.equal(res.ok, true);
  assert.equal(res.data.path, join(a.parent, 'custom'));
  assert.ok(existsSync(join(a.parent, 'custom', '.git')));
  assert.ok(!existsSync(join(a.parent, 'r')));
});

// --- hostile input never reaches gh ----------------------------------------------

test('hostile url / name values are rejected before gh is ever run', async () => {
  const a = arena();
  const ghBin = fakeGh(a.rec, ghBody(a.rec));
  const cases = [
    { url: '--upload-pack=touch /tmp/pwned' },
    { url: 'ext::sh -c "touch /tmp/pwned" %S' },
    { url: 'file:///etc' },
    { url: 'https://user:pw@github.com/o/r' },
    { url: 'https://github.com/o/r', name: '../escape' },
    { url: 'https://github.com/o/r', name: 'a/b' },
    { url: 'https://github.com/o/r', name: '..' },
    { url: 'https://github.com/o/r', name: '.' },
    { url: 'https://github.com/o/r', name: '-rf' },
    { url: 'https://github.com/o/r', name: 'a\x00b' },
    { url: 'https://github.com/o/r', name: 'x'.repeat(300) },
    { url: 'https://github.com/o/r', name: 42 },
    { url: 'o/-r' }, // derived directory name would start with "-": the user must give one
  ];
  for (const c of cases) {
    const res = await clone(a, { parent: a.parent, ...c }, { ghBin });
    assert.equal(res.ok, false, JSON.stringify(c));
    assert.equal(res.code, 'validation', JSON.stringify(c));
  }
  assert.ok(!existsSync(join(a.rec, 'called')), 'gh must not have been started');
  assert.deepEqual(readdirSync(a.parent), []);
  const derived = await clone(a, { parent: a.parent, url: 'o/-r' }, { ghBin });
  assert.match(derived.message, /enter a folder name/);
});

test('bad requests: no parent, non-string parent, missing url', async () => {
  const a = arena();
  for (const req of [{}, { url: 'o/r' }, { parent: 5, url: 'o/r' }, { parent: a.parent }, undefined, null]) {
    const res = await clone(a, req);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'validation');
  }
});

// --- destination -------------------------------------------------------------------

test('parent handling: outside browseRoots, missing, and not a directory', async () => {
  const a = arena();
  const ghBin = fakeGh(a.rec, ghBody(a.rec));
  const outside = uniq('outside');
  mkdirSync(outside);
  assert.equal((await clone(a, { parent: outside, url: 'o/r' }, { ghBin })).code, 'forbidden');
  assert.equal((await clone(a, { parent: join(a.parent, 'missing'), url: 'o/r' }, { ghBin })).code, 'not-found');
  const file = join(a.parent, 'afile');
  writeFileSync(file, 'x');
  assert.equal((await clone(a, { parent: file, url: 'o/r' }, { ghBin })).code, 'validation');
  const link = join(a.parent, 'escape');
  symlinkSync(outside, link);
  assert.equal((await clone(a, { parent: link, url: 'o/r' }, { ghBin })).code, 'forbidden', 'a symlink out of the roots');
  assert.ok(!existsSync(join(a.rec, 'called')));
  assert.deepEqual(readdirSync(outside), [], 'nothing is written outside the roots');
});

test('an existing non-empty directory, file, or symlink at the final name is a conflict; gh is not run', async () => {
  const a = arena();
  const ghBin = fakeGh(a.rec, ghBody(a.rec));
  mkdirSync(join(a.parent, 'full'));
  writeFileSync(join(a.parent, 'full', 'x'), '1');
  writeFileSync(join(a.parent, 'file'), '1');
  const target = uniq('symtarget');
  mkdirSync(target);
  symlinkSync(target, join(a.parent, 'link'));
  for (const name of ['full', 'file', 'link']) {
    const res = await clone(a, { parent: a.parent, url: 'o/r', name }, { ghBin });
    assert.equal(res.code, 'conflict', name);
  }
  assert.ok(!existsSync(join(a.rec, 'called')));
  assert.deepEqual(readdirSync(target), [], 'a symlink at the final name is never cloned through');
  assert.deepEqual(readdirSync(join(a.parent, 'full')), ['x']);
});

test('an existing EMPTY directory is replaced by the finished clone', async () => {
  const a = arena();
  const ghBin = fakeGh(a.rec, ghBody(a.rec));
  mkdirSync(join(a.parent, 'r'));
  const res = await clone(a, { parent: a.parent, url: 'o/r' }, { ghBin });
  assert.equal(res.ok, true);
  assert.ok(existsSync(join(a.parent, 'r', '.git')));
  assert.ok(res.data.warnings.includes('Replaced an existing empty directory'));
  assert.deepEqual(stagingLeft(a.parent), []);
});

test('the final name filling up while gh runs is a conflict and the staging directory is removed', async () => {
  const a = arena();
  const go = join(a.rec, 'go');
  const ghBin = fakeGh(a.rec, ghBody(a.rec, { middle: `touch '${a.rec}/started'\nwhile [ ! -f '${go}' ]; do sleep 0.05; done` }));
  mkdirSync(join(a.parent, 'r'));
  const pending = clone(a, { parent: a.parent, url: 'o/r' }, { ghBin });
  await waitFor(() => existsSync(join(a.rec, 'started')));
  writeFileSync(join(a.parent, 'r', 'planted'), 'x');
  writeFileSync(go, '');
  const res = await pending;
  assert.equal(res.code, 'conflict');
  assert.deepEqual(readdirSync(join(a.parent, 'r')), ['planted']);
  assert.deepEqual(stagingLeft(a.parent), []);
});

// --- TOCTOU --------------------------------------------------------------------------

test('swapping the parent path for a symlink while gh runs does not redirect the clone (Linux: pinned by fd)', { skip: process.platform !== 'linux' }, async () => {
  const a = arena();
  const outsideRoots = uniq('decoy');
  mkdirSync(outsideRoots);
  const go = join(a.rec, 'go');
  const ghBin = fakeGh(a.rec, ghBody(a.rec, {
    middle: `touch '${a.rec}/started'\nwhile [ ! -f '${go}' ]; do sleep 0.05; done\npwd -P > '${a.rec}/cwd-after'`,
  }));
  const pending = clone(a, { parent: a.parent, url: 'o/r' }, { ghBin });
  await waitFor(() => existsSync(join(a.rec, 'started')));

  // The attacker (an agent that can write the tree) swaps the checked path.
  const moved = `${a.parent}.moved`;
  renameSync(a.parent, moved);
  symlinkSync(outsideRoots, a.parent);
  writeFileSync(go, '');

  const res = await pending;
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(existsSync(join(moved, 'r', '.git')), 'the clone finished inside the directory that was checked');
  assert.deepEqual(readdirSync(outsideRoots), [], 'nothing was written through the swapped symlink');
  assert.equal(readLines(join(a.rec, 'cwd-after'))[0], realpathSync(moved), 'gh\'s cwd followed the directory, not the path');
  assert.deepEqual(stagingLeft(moved), []);
});

test('non-Linux fallback (path based): still contained and still works', async () => {
  const a = arena();
  const ghBin = fakeGh(a.rec, ghBody(a.rec));
  const res = await clone(a, { parent: a.parent, url: 'o/r' }, { ghBin, platform: 'darwin' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(existsSync(join(a.parent, 'r', '.git')));
  assert.equal(readLines(join(a.rec, 'cwd'))[0], realpathSync(a.parent));
  const outside = uniq('outside');
  mkdirSync(outside);
  assert.equal((await clone(a, { parent: outside, url: 'o/r' }, { ghBin, platform: 'darwin' })).code, 'forbidden');
  const failing = fakeGh(a.rec, ghBody(a.rec, { build: false, exitCode: 1 }));
  assert.equal((await clone(a, { parent: a.parent, url: 'o/x' }, { ghBin: failing, platform: 'darwin' })).code, 'clone-failed');
  assert.deepEqual(stagingLeft(a.parent), [], 'the fallback cleanup removes the staging directory too');
});

// --- failures, limits, cleanup ------------------------------------------------------------

test('gh failing: its message is surfaced (cleaned), the staging directory is gone, nothing is published', async () => {
  const a = arena();
  const ghBin = fakeGh(a.rec, ghBody(a.rec, {
    middle: `mkdir -p "$4"\ntouch "$4/partial"\nprintf '\\033[31mfatal: repository not found\\033[0m\\007\\n' >&2`,
    build: false,
    exitCode: 1,
  }));
  const res = await clone(a, { parent: a.parent, url: 'o/r' }, { ghBin });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'clone-failed');
  assert.match(res.message, /exit 1.*fatal: repository not found/);
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(res.message), 'control characters are stripped');
  assert.deepEqual(readdirSync(a.parent), [], 'no staging directory, no half-cloned directory');
});

test('gh exit code 4 (authentication) gets a hint', async () => {
  const a = arena();
  const ghBin = fakeGh(a.rec, ghBody(a.rec, { build: false, exitCode: 4 }));
  const res = await clone(a, { parent: a.parent, url: 'o/r' }, { ghBin });
  assert.equal(res.code, 'clone-failed');
  assert.match(res.message, /not authenticated/);
});

test('gh success without a repository is a failure, and is cleaned up', async () => {
  const a = arena();
  const ghBin = fakeGh(a.rec, ghBody(a.rec, { middle: 'mkdir -p "$4"', build: false }));
  const res = await clone(a, { parent: a.parent, url: 'o/r' }, { ghBin });
  assert.equal(res.code, 'clone-failed');
  assert.deepEqual(readdirSync(a.parent), []);
});

test('a missing gh binary is gh-unavailable, not a hang or a crash', async () => {
  const a = arena();
  const res = await clone(a, { parent: a.parent, url: 'o/r' }, { ghBin: join(base, 'no-such-gh') });
  assert.equal(res.code, 'gh-unavailable');
  assert.deepEqual(readdirSync(a.parent), []);
});

test('a clone that outlives the timeout is killed with everything it started, and cleaned up', async () => {
  const a = arena();
  const ghBin = fakeGh(a.rec, `#!/bin/sh
mkdir -p "$4"
touch "$4/partial"
sh -c 'echo $$ > "${a.rec}/grandchild"; exec sleep 60' &
touch '${a.rec}/started'
wait
`);
  const started = Date.now();
  const res = await clone(a, { parent: a.parent, url: 'o/r' }, { ghBin, timeoutMs: 400 });
  assert.equal(res.code, 'timeout');
  assert.ok(Date.now() - started < 8000);
  assert.deepEqual(readdirSync(a.parent), []);
  if (process.platform === 'linux') {
    const pid = Number(readFileSync(join(a.rec, 'grandchild'), 'utf-8').trim());
    assert.ok(pid > 1, 'the grandchild recorded its pid');
    const alive = () => {
      try {
        return readFileSync(`/proc/${pid}/stat`, 'utf-8').replace(/^.*\) /, '')[0] !== 'Z';
      } catch {
        return false;
      }
    };
    await waitFor(() => !alive(), 3000);
  }
});

test('output beyond the cap is dropped; the error message stays small', async () => {
  const a = arena();
  const ghBin = fakeGh(a.rec, ghBody(a.rec, {
    middle: `head -c 300000 /dev/zero | tr '\\000' 'x' >&2`,
    build: false,
    exitCode: 1,
  }));
  const res = await clone(a, { parent: a.parent, url: 'o/r' }, { ghBin, maxOutputBytes: 2000 });
  assert.equal(res.code, 'clone-failed');
  assert.ok(res.message.length < 1300, `message is ${res.message.length} chars`);
});

test('the concurrency cap answers busy and frees the slot afterwards', async () => {
  const a = arena();
  const go = join(a.rec, 'go');
  const slots = fastSlots();
  const slow = fakeGh(a.rec, ghBody(a.rec, { middle: `touch '${a.rec}/started'\nwhile [ ! -f '${go}' ]; do sleep 0.05; done` }));
  const quick = fakeGh(a.rec, ghBody(a.rec));
  const first = clone(a, { parent: a.parent, url: 'o/one' }, { ghBin: slow, slots, maxConcurrent: 1 });
  await waitFor(() => existsSync(join(a.rec, 'started')));
  const second = await clone(a, { parent: a.parent, url: 'o/two' }, { ghBin: quick, slots, maxConcurrent: 1 });
  assert.equal(second.code, 'busy');
  assert.ok(!existsSync(join(a.parent, 'two')));
  writeFileSync(go, '');
  assert.equal((await first).ok, true);
  assert.equal(slots.active, 0);
  assert.equal((await clone(a, { parent: a.parent, url: 'o/three' }, { ghBin: quick, slots, maxConcurrent: 1 })).ok, true);
  assert.equal(slots.active, 0);
});

test('a validation failure does not consume a slot', async () => {
  const a = arena();
  const slots = fastSlots();
  await clone(a, { parent: a.parent, url: 'nope' }, { slots, maxConcurrent: 1 });
  assert.equal(slots.active, 0);
});

// --- the --no-upstream check ----------------------------------------------------------

test('a clone whose origin is not gh\'s default is still published, with warnings', async () => {
  const a = arena();
  const ghBin = fakeGh(a.rec, ghBody(a.rec, {
    build: false,
    middle: `mkdir -p "$4"
git init -q -b main "$4"
git -C "$4" remote add origin "$3"
git -C "$4" remote add upstream https://github.com/up/r.git
git -C "$4" config remote.upstream.gh-resolved base`,
  }));
  const res = await clone(a, { parent: a.parent, url: 'o/r' }, { ghBin });
  assert.equal(res.ok, true);
  assert.ok(res.data.warnings.some((w) => /upstream remote exists/.test(w)), JSON.stringify(res.data.warnings));
  assert.ok(res.data.warnings.some((w) => /gh default is set on upstream/.test(w)), JSON.stringify(res.data.warnings));
});

test('origin without any gh-resolved (plain git clone shape) is fine: no warnings', async () => {
  const a = arena();
  const ghBin = fakeGh(a.rec, ghBody(a.rec, {
    build: false,
    middle: 'mkdir -p "$4"\ngit init -q -b main "$4"\ngit -C "$4" remote add origin "$3"',
  }));
  const res = await clone(a, { parent: a.parent, url: 'o/r' }, { ghBin });
  assert.deepEqual(res.data.warnings, []);
});

// --- the environment against REAL git -------------------------------------------------------

const withoutKeys = (env, pred) => Object.fromEntries(Object.entries(env).filter(([k]) => !pred(k)));
const isConfigKey = (k) => k === 'GIT_CONFIG_COUNT' || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k);

// A "host" whose ~/.gitconfig is hostile in the ways the pins address.
function hostileHost() {
  const home = uniq('host');
  mkdirSync(join(home, 'hooks'), { recursive: true });
  const marks = join(home, 'marks');
  mkdirSync(marks);
  const script = (name, file) => {
    const p = join(home, name);
    writeFileSync(p, `#!/bin/sh\necho ran >> '${join(marks, file)}'\ncat\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const hook = join(home, 'hooks', 'post-checkout');
  writeFileSync(hook, `#!/bin/sh\necho ran >> '${join(marks, 'HOOK')}'\n`);
  chmodSync(hook, 0o755);
  const src = initRepo(join(home, 'src'));
  writeFileSync(join(src, '.gitattributes'), 'l filter=lfs\n');
  writeFileSync(join(src, 'l'), 'pointer\n');
  git(src, ['add', '-A']);
  git(src, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'files']);
  writeFileSync(join(home, '.gitconfig'), [
    '[core]', `\thooksPath = ${join(home, 'hooks')}`,
    '[filter "lfs"]', `\tsmudge = ${script('lfs-smudge.sh', 'LFS')}`, '\trequired = true',
    `[url "file://${home}/"]`, '\tinsteadOf = https://github.com/',
    '',
  ].join('\n'));
  return { home, src, marks, ran: (m) => existsSync(join(marks, m)) };
}

async function realClone(env, url, dst) {
  try {
    await execFileP('git', ['clone', '-q', '--', url, dst], { env, encoding: 'utf-8' });
    return { ok: true, stderr: '' };
  } catch (err) {
    return { ok: false, stderr: String(err.stderr || err.message) };
  }
}

const hostEnv = (home) => ({ PATH: process.env.PATH, HOME: home });

test('GIT_ALLOW_PROTOCOL=https blocks every non-https transport (real git, checked against a control)', async () => {
  const h = hostileHost();
  const only = { ...withoutKeys(buildCloneEnv(hostEnv(h.home)), isConfigKey) };
  const control = withoutKeys(only, (k) => k === 'GIT_ALLOW_PROTOCOL');
  assert.equal((await realClone(control, `file://${h.src}`, uniq('dst'))).ok, true, 'control: the transport works without the pin');
  for (const url of [`file://${h.src}`, h.src, 'ssh://git@github.invalid/o/r.git', 'git@github.invalid:o/r.git', 'git://github.invalid/o/r.git', 'ext::sh -c true']) {
    const res = await realClone(only, url, uniq('dst'));
    assert.equal(res.ok, false, url);
    assert.match(res.stderr, /transport '.*' not allowed/, url);
  }
});

test('a host-level url.<x>.insteadOf that rewrites https to file:// is refused (protocol.file.allow=never bites)', async () => {
  const h = hostileHost();
  const env = buildCloneEnv(hostEnv(h.home));
  const withoutFilePin = gitConfigEnv(CLONE_GIT_CONFIG.filter(([k]) => k !== 'protocol.file.allow'));
  const control = { ...withoutKeys(env, (k) => isConfigKey(k) || k === 'GIT_ALLOW_PROTOCOL'), ...withoutFilePin };
  const cloned = await realClone(control, 'https://github.com/src', uniq('dst'));
  assert.equal(cloned.ok, true, `control: the rewrite must work without the pin: ${cloned.stderr}`);
  const refused = await realClone(withoutKeys(env, (k) => k === 'GIT_ALLOW_PROTOCOL'), 'https://github.com/src', uniq('dst'));
  assert.equal(refused.ok, false);
  assert.match(refused.stderr, /transport 'file' not allowed/);
});

test('a host-level core.hooksPath post-checkout hook does not run during the clone (core.hooksPath bites)', async () => {
  const h = hostileHost();
  const noFilePin = gitConfigEnv(CLONE_GIT_CONFIG.filter(([k]) => k !== 'protocol.file.allow'));
  const hardened = { ...withoutKeys(buildCloneEnv(hostEnv(h.home)), (k) => isConfigKey(k) || k === 'GIT_ALLOW_PROTOCOL'), ...noFilePin };
  const control = withoutKeys(hardened, isConfigKey);
  assert.equal((await realClone(control, `file://${h.src}`, uniq('dst'))).ok, true);
  assert.equal(h.ran('HOOK'), true, 'control: the host hook must run without the pin, or this test proves nothing');
  rmSync(join(h.marks, 'HOOK'));
  assert.equal((await realClone(hardened, `file://${h.src}`, uniq('dst'))).ok, true);
  assert.equal(h.ran('HOOK'), false, 'the hook ran despite core.hooksPath=/dev/null');
});

test('a host-level LFS smudge filter does not run, and the clone still succeeds (filter.lfs.* bites)', async () => {
  const h = hostileHost();
  const noFilePin = gitConfigEnv(CLONE_GIT_CONFIG.filter(([k]) => k !== 'protocol.file.allow'));
  const hardened = { ...withoutKeys(buildCloneEnv(hostEnv(h.home)), (k) => isConfigKey(k) || k === 'GIT_ALLOW_PROTOCOL'), ...noFilePin };
  const control = withoutKeys(hardened, isConfigKey);
  assert.equal((await realClone(control, `file://${h.src}`, uniq('dst'))).ok, true);
  assert.equal(h.ran('LFS'), true, 'control: the LFS driver must run without the pin');
  rmSync(join(h.marks, 'LFS'));
  const res = await realClone(hardened, `file://${h.src}`, uniq('dst'));
  assert.equal(res.ok, true, res.stderr);
  assert.equal(h.ran('LFS'), false, 'the smudge driver ran');
});

test('the empty core.* pins do not break a clone', async () => {
  const h = hostileHost();
  const noFilePin = gitConfigEnv(CLONE_GIT_CONFIG.filter(([k]) => k !== 'protocol.file.allow'));
  const env = { ...withoutKeys(buildCloneEnv(hostEnv(h.home)), (k) => isConfigKey(k) || k === 'GIT_ALLOW_PROTOCOL'), ...noFilePin };
  const dst = uniq('dst');
  assert.equal((await realClone(env, `file://${h.src}`, dst)).ok, true);
  assert.ok(existsSync(join(dst, '.git')));
});

test('buildChildEnv drops every GIT_* variable and unlisted secrets', () => {
  const env = buildChildEnv({ PATH: '/bin', HOME: '/h', GIT_DIR: '/x', GIT_ASKPASS: '/y', AWS_SECRET_ACCESS_KEY: 'k', GH_TOKEN: 't' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
  assert.deepEqual(buildChildEnv({ PATH: '/bin', GH_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 'k' }, { network: true }), { PATH: '/bin', GH_TOKEN: 't' });
});

// keep the fixture helper referenced so a lint pass does not flag it
void fixtureGitEnv;
