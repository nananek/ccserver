// readGitInfo (gitInfo.js): the read-only repository / branch / remotes
// description behind GET /api/git/info. Fixtures are throwaway repositories
// built with real git (testGitFixtures.js).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIT_INFO_ARGS, pickDefaultRemote, readGitInfo, sanitizeText, stripUserinfo } from './gitInfo.js';
import { commit, fixtureGitEnv, git, initRepo } from './testGitFixtures.js';

let base; // realpath'd: the tmp dir may itself sit behind a symlink
before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ccserver-gitinfo-')));
});
after(() => {
  rmSync(base, { recursive: true, force: true });
});

let counter = 0;
const fresh = (name = 'repo') => join(base, `${name}-${counter++}`);
const info = async (dir, roots = []) => {
  const res = await readGitInfo(dir, roots);
  assert.equal(res.ok, true, `readGitInfo failed: ${JSON.stringify(res)}`);
  return res.data;
};

test('a plain repository: root, branch, origin as the default remote', async () => {
  const dir = initRepo(fresh());
  git(dir, ['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  const data = await info(dir);
  assert.equal(data.isRepo, true);
  assert.equal(data.root, dir);
  assert.equal(data.worktree, false);
  assert.deepEqual(data.head, { kind: 'branch', name: 'main' });
  assert.deepEqual(data.remotes, [
    { name: 'origin', url: 'https://github.com/o/r.git', pushUrl: null, isDefault: true },
  ]);
  assert.deepEqual(data.defaultRemote, { name: 'origin', source: 'origin' });
  assert.equal(data.truncated, false);
});

test('a subdirectory reports the repository root above it', async () => {
  const dir = initRepo(fresh());
  const sub = join(dir, 'a', 'b');
  mkdirSync(sub, { recursive: true });
  const data = await info(sub);
  assert.equal(data.isRepo, true);
  assert.equal(data.root, dir);
});

test('a directory that is not a repository is isRepo:false with no reason', async () => {
  const dir = fresh('plain');
  mkdirSync(dir);
  assert.deepEqual(await info(dir), { path: dir, isRepo: false });
});

test('a linked worktree: worktree:true, remotes come from the shared config', async () => {
  const main = initRepo(fresh('main'));
  git(main, ['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  const wt = fresh('wt');
  git(main, ['worktree', 'add', '-q', '-b', 'feature', wt]);
  const data = await info(wt);
  assert.equal(data.isRepo, true);
  assert.equal(data.root, wt);
  assert.equal(data.worktree, true);
  assert.deepEqual(data.head, { kind: 'branch', name: 'feature' });
  assert.deepEqual(data.remotes.map((r) => r.name), ['origin']);
});

test('detached HEAD: kind detached with the short commit', async () => {
  const dir = initRepo(fresh());
  const sha = git(dir, ['rev-parse', '--short', 'HEAD']).trim();
  git(dir, ['checkout', '-q', '--detach']);
  const data = await info(dir);
  assert.deepEqual(data.head, { kind: 'detached', commit: sha });
});

test('an unborn branch (git init, no commit) still names the branch', async () => {
  const dir = initRepo(fresh(), { branch: 'trunk', withCommit: false });
  const data = await info(dir);
  assert.deepEqual(data.head, { kind: 'branch', name: 'trunk' });
  assert.deepEqual(data.remotes, []);
});

test('no remotes: an empty list and no default', async () => {
  const data = await info(initRepo(fresh()));
  assert.deepEqual(data.remotes, []);
  assert.equal(data.defaultRemote, null);
});

test('several remotes: the current branch\'s remote wins, then remote.pushDefault, then origin', async () => {
  const dir = initRepo(fresh());
  git(dir, ['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  git(dir, ['remote', 'add', 'upstream', 'https://github.com/up/r.git']);
  git(dir, ['remote', 'add', 'fork', 'https://github.com/me/r.git']);

  let data = await info(dir);
  assert.deepEqual(data.defaultRemote, { name: 'origin', source: 'origin' });
  assert.deepEqual(data.remotes.map((r) => [r.name, r.isDefault]), [['origin', true], ['upstream', false], ['fork', false]]);

  git(dir, ['config', 'remote.pushDefault', 'fork']);
  data = await info(dir);
  assert.deepEqual(data.defaultRemote, { name: 'fork', source: 'pushDefault' });
  assert.deepEqual(data.remotes.map((r) => r.isDefault), [false, false, true]);

  git(dir, ['config', 'branch.main.remote', 'upstream']);
  data = await info(dir);
  assert.deepEqual(data.defaultRemote, { name: 'upstream', source: 'branch' });
  assert.deepEqual(data.remotes.map((r) => r.isDefault), [false, true, false]);
});

test('branch.<b>.remote of ANOTHER branch does not count, and "." is not a remote', async () => {
  const dir = initRepo(fresh());
  git(dir, ['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  git(dir, ['remote', 'add', 'upstream', 'https://github.com/up/r.git']);
  git(dir, ['config', 'branch.other.remote', 'upstream']);
  assert.deepEqual((await info(dir)).defaultRemote, { name: 'origin', source: 'origin' });
  git(dir, ['config', 'branch.main.remote', '.']);
  assert.deepEqual((await info(dir)).defaultRemote, { name: 'origin', source: 'origin' });
});

test('pickDefaultRemote follows branch -> pushDefault -> origin', () => {
  assert.deepEqual(pickDefaultRemote({ branchRemote: 'b', pushDefault: 'p' }), { name: 'b', source: 'branch' });
  assert.deepEqual(pickDefaultRemote({ branchRemote: null, pushDefault: 'p' }), { name: 'p', source: 'pushDefault' });
  assert.deepEqual(pickDefaultRemote({ branchRemote: '.', pushDefault: null }), { name: 'origin', source: 'origin' });
  assert.deepEqual(pickDefaultRemote({ branchRemote: '', pushDefault: '' }), { name: 'origin', source: 'origin' });
});

test('userinfo never reaches the response (scheme URL, scp-like, pushurl)', async () => {
  const dir = initRepo(fresh());
  git(dir, ['remote', 'add', 'origin', 'https://alice:s3cret-token@github.com/o/r.git']);
  git(dir, ['remote', 'add', 'ssh', 'git@github.com:o/r.git']);
  git(dir, ['config', 'remote.origin.pushurl', 'https://bob:pw2@example.com/x.git']);
  const data = await info(dir);
  assert.deepEqual(data.remotes.map((r) => [r.name, r.url, r.pushUrl]), [
    ['origin', 'https://github.com/o/r.git', 'https://example.com/x.git'],
    ['ssh', 'github.com:o/r.git', null],
  ]);
  const wire = JSON.stringify(data);
  for (const secret of ['s3cret-token', 'alice', 'pw2', 'bob']) {
    assert.ok(!wire.includes(secret), `${secret} leaked into ${wire}`);
  }
});

test('stripUserinfo: last @ of the authority wins; plain paths and other URLs are untouched', () => {
  assert.equal(stripUserinfo('https://u:p@ss@host/a/b'), 'https://host/a/b');
  assert.equal(stripUserinfo('ssh://git@host:2222/a.git'), 'ssh://host:2222/a.git');
  assert.equal(stripUserinfo('https://host/a@b'), 'https://host/a@b', '@ in the path is not userinfo');
  assert.equal(stripUserinfo('/srv/git/repo.git'), '/srv/git/repo.git');
  assert.equal(stripUserinfo('user@host:path/x'), 'host:path/x');
  assert.equal(stripUserinfo('../sibling'), '../sibling');
});

test('control and bidi characters are stripped from names and URLs, long values are capped', async () => {
  assert.equal(sanitizeText(`a\x07b\x1b[31mc${String.fromCharCode(0x202e)}d${String.fromCharCode(0x200b)}e`), 'ab[31mcde');
  assert.equal(sanitizeText('x'.repeat(400)).length, 301);
  const dir = initRepo(fresh());
  git(dir, ['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  git(dir, ['config', 'remote.origin.url', `https://github.com/o${String.fromCharCode(0x202e)}/r\x07.git`]);
  const data = await info(dir);
  assert.equal(data.remotes[0].url, 'https://github.com/o/r.git');
});

test('more remotes than the cap: truncated, first ones kept', async () => {
  const dir = initRepo(fresh());
  for (let i = 0; i < 70; i++) git(dir, ['remote', 'add', `r${String(i).padStart(2, '0')}`, `https://example.com/${i}.git`]);
  const data = await info(dir);
  assert.equal(data.remotes.length, 64);
  assert.equal(data.truncated, true);
  assert.equal(data.remotes[0].name, 'r00');
});

test('include.path in the config is not followed', async () => {
  const dir = initRepo(fresh());
  const extra = join(base, `extra-${counter++}.cfg`);
  writeFileSync(extra, '[remote "smuggled"]\n\turl = https://evil.example/x.git\n');
  git(dir, ['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  git(dir, ['config', '--add', 'include.path', extra]);
  assert.deepEqual((await info(dir)).remotes.map((r) => r.name), ['origin']);
});

test('a config over the size cap is reported, not parsed', async () => {
  const dir = initRepo(fresh());
  git(dir, ['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  writeFileSync(join(dir, '.git', 'config'), `${'# padding line to make the file large\n'.repeat(30_000)}`, { flag: 'a' });
  const data = await info(dir);
  assert.equal(data.isRepo, true);
  assert.equal(data.configTooLarge, true);
  assert.deepEqual(data.remotes, []);
});

test('a FIFO where .git should be is refused without ever blocking', async () => {
  const dir = fresh('fifo');
  mkdirSync(dir);
  execFileSync('mkfifo', [join(dir, '.git')]);
  const started = Date.now();
  const data = await info(dir);
  assert.deepEqual(data, { path: dir, isRepo: false, reason: 'unreadable' });
  assert.ok(Date.now() - started < 2000, 'must return promptly instead of waiting on the FIFO');
});

test('an oversized .git file is refused', async () => {
  const dir = fresh('bigfile');
  mkdirSync(dir);
  writeFileSync(join(dir, '.git'), `gitdir: ${'x'.repeat(70_000)}\n`);
  assert.deepEqual(await info(dir), { path: dir, isRepo: false, reason: 'unreadable' });
});

test('a git call that outlives its timeout is killed and reported', async () => {
  const dir = initRepo(fresh());
  const slow = join(base, `slow-git-${counter++}`);
  writeFileSync(slow, '#!/bin/sh\nsleep 30\n');
  chmodSync(slow, 0o755);
  const started = Date.now();
  const res = await readGitInfo(dir, [], { gitBin: slow, timeoutMs: 200 });
  assert.deepEqual(res.data, { path: dir, isRepo: false, reason: 'timeout' });
  assert.ok(Date.now() - started < 5000);
});

test('a missing git binary is reported, not thrown', async () => {
  const dir = initRepo(fresh());
  const res = await readGitInfo(dir, [], { gitBin: join(base, 'no-such-git') });
  assert.deepEqual(res.data, { path: dir, isRepo: false, reason: 'git-unavailable' });
});

// --- browseRoots ----------------------------------------------------------

test('a path outside browseRoots is refused; inside is described', async () => {
  const inside = initRepo(join(base, `roots-${counter++}`, 'in'));
  const roots = [join(inside, '..')];
  assert.equal((await readGitInfo(inside, roots)).data.isRepo, true);
  const outside = initRepo(fresh('out'));
  const res = await readGitInfo(outside, roots);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'forbidden');
});

test('a symlink inside the roots that points outside them is refused', async () => {
  const rootDir = join(base, `symroot-${counter++}`);
  mkdirSync(rootDir);
  const outside = initRepo(fresh('elsewhere'));
  symlinkSync(outside, join(rootDir, 'link'));
  const res = await readGitInfo(join(rootDir, 'link'), [rootDir]);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'forbidden');
});

test('a .git file that points at a repository outside browseRoots is not followed', async () => {
  const outside = initRepo(fresh('secret'));
  git(outside, ['remote', 'add', 'origin', 'https://github.com/private/thing.git']);
  const rootDir = join(base, `gitlink-${counter++}`);
  const trap = join(rootDir, 'trap');
  mkdirSync(trap, { recursive: true });
  writeFileSync(join(trap, '.git'), `gitdir: ${join(outside, '.git')}\n`);

  // Sanity: with no restriction the gitlink IS followed, so the refusal below
  // is the containment rule and not git failing to read it.
  const open = await readGitInfo(trap, []);
  assert.equal(open.data.isRepo, true);
  assert.equal(open.data.remotes[0].url, 'https://github.com/private/thing.git');

  const res = await readGitInfo(trap, [rootDir]);
  assert.deepEqual(res.data, { path: trap, isRepo: false, reason: 'outside-roots' });
  assert.ok(!JSON.stringify(res).includes('private/thing'));
});

test('an ancestor repository above browseRoots is not described', async () => {
  const outer = initRepo(fresh('outer'));
  const inner = join(outer, 'sub');
  mkdirSync(inner);
  const res = await readGitInfo(inner, [inner]);
  assert.deepEqual(res.data, { path: inner, isRepo: false, reason: 'outside-roots' });
});

test('a path that cannot name a directory (NUL byte, over-long name) is a validation error, not a crash', async () => {
  assert.equal((await readGitInfo(`${base}/a\0b`, [])).code, 'validation');
  assert.equal((await readGitInfo(`${base}/${'x'.repeat(5000)}`, [])).code, 'validation');
});

test('bad requests: no path, missing directory, a file', async () => {
  assert.equal((await readGitInfo(undefined, [])).code, 'validation');
  assert.equal((await readGitInfo('', [])).code, 'validation');
  assert.equal((await readGitInfo(join(base, 'does-not-exist'), [])).code, 'not-found');
  const file = join(base, `file-${counter++}`);
  writeFileSync(file, 'x');
  assert.equal((await readGitInfo(file, [])).code, 'validation');
});

// --- the reason this module exists: nothing repo-configured may execute ----

// Everything a hostile config could arm: fsmonitor (measured to run on
// status/diff), sshCommand, pager, an alias, an editor.
function armHostileConfig(dir) {
  const marker = join(dir, '..', `MARKER-${counter++}`);
  const hook = join(dir, '..', `hook-${counter++}.sh`);
  writeFileSync(hook, `#!/bin/sh\necho "$0 $*" >> '${marker}'\nprintf '\\0'\n`);
  chmodSync(hook, 0o755);
  for (const key of ['core.fsmonitor', 'core.sshCommand', 'core.pager', 'core.editor', 'core.askpass', 'core.gitProxy']) {
    git(dir, ['config', key, hook]);
  }
  git(dir, ['config', 'alias.symbolic-ref', `!'${hook}'`]);
  return marker;
}

test('POSITIVE CONTROL: the armed fixture really executes under `git status`', () => {
  const dir = initRepo(fresh());
  const marker = armHostileConfig(dir);
  git(dir, ['status', '--porcelain']);
  assert.ok(existsSync(marker), 'core.fsmonitor did not run under `git status`: the fixture proves nothing');
});

test('the git commands gitInfo uses run nothing from an armed repo, even WITHOUT the hardening flags', () => {
  const dir = initRepo(fresh());
  git(dir, ['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  const marker = armHostileConfig(dir);
  const raw = (args) => execFileSync('git', args, { cwd: dir, env: fixtureGitEnv(), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  raw(GIT_INFO_ARGS.layout);
  raw(GIT_INFO_ARGS.headRef);
  raw(GIT_INFO_ARGS.headShort);
  raw(GIT_INFO_ARGS.config(join(dir, '.git', 'config')));
  assert.ok(!existsSync(marker), 'one of the read commands executed a configured program');
});

test('readGitInfo on an armed repository runs nothing and still answers', async () => {
  const dir = initRepo(fresh());
  git(dir, ['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  const marker = armHostileConfig(dir);
  const data = await info(dir);
  assert.equal(data.isRepo, true);
  assert.equal(data.remotes[0].name, 'origin');
  assert.ok(!existsSync(marker), 'a configured program ran');
});

test('detached HEAD on an armed repository runs nothing either', async () => {
  const dir = initRepo(fresh());
  git(dir, ['checkout', '-q', '--detach']);
  const marker = armHostileConfig(dir);
  assert.equal((await info(dir)).head.kind, 'detached');
  assert.ok(!existsSync(marker));
});

test('commit() helper sanity: fixtures do not depend on the ambient identity or signing', () => {
  const dir = initRepo(fresh(), { withCommit: false });
  commit(dir, 'one');
  assert.equal(git(dir, ['log', '--format=%s']).trim(), 'one');
});
