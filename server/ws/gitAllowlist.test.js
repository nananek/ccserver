import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeGitAllowlist, normalizeGitUrl, resolveOriginUrl } from './gitAllowlist.js';

describe('normalizeGitUrl', () => {
  test('https URL with .git suffix', () => {
    assert.equal(normalizeGitUrl('https://github.com/owner/repo.git'), 'github.com/owner/repo');
  });

  test('https URL without .git suffix', () => {
    assert.equal(normalizeGitUrl('https://github.com/owner/repo'), 'github.com/owner/repo');
  });

  test('host is lowercased, path case is preserved', () => {
    assert.equal(normalizeGitUrl('https://GitHub.com/Owner/Repo.git'), 'github.com/Owner/Repo');
  });

  test('scp-like shorthand (ssh, no scheme)', () => {
    assert.equal(normalizeGitUrl('git@github.com:owner/repo.git'), 'github.com/owner/repo');
  });

  test('ssh:// URL with explicit default port omits it', () => {
    assert.equal(normalizeGitUrl('ssh://git@github.com:22/owner/repo.git'), 'github.com/owner/repo');
  });

  test('ssh:// URL with non-default port keeps it', () => {
    assert.equal(normalizeGitUrl('ssh://git@example.com:2222/owner/repo.git'), 'example.com:2222/owner/repo');
  });

  test('IPv6 host in brackets', () => {
    assert.equal(normalizeGitUrl('https://[::1]/owner/repo.git'), '[::1]/owner/repo');
  });

  test('trailing slash and leading slashes are stripped', () => {
    assert.equal(normalizeGitUrl('https://github.com//owner/repo/'), 'github.com/owner/repo');
  });

  test('file:// URLs are rejected (local path, not network-scoped)', () => {
    assert.equal(normalizeGitUrl('file:///home/user/repo'), null);
  });

  test('a bare local filesystem path is rejected', () => {
    assert.equal(normalizeGitUrl('/home/user/repo'), null);
  });

  test('non-string / empty input is rejected', () => {
    assert.equal(normalizeGitUrl(''), null);
    assert.equal(normalizeGitUrl(null), null);
    assert.equal(normalizeGitUrl(undefined), null);
  });
});

// --- computeGitAllowlist / resolveOriginUrl: exercised against real git
// repos in a temp dir, since the whole point of this module is shelling out
// to `git` and reading .gitmodules the same way a real session would.

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
}

function initRepo(dir, originUrl) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  if (originUrl) git(dir, ['remote', 'add', 'origin', originUrl]);
  return dir;
}

describe('computeGitAllowlist / resolveOriginUrl', () => {
  let root;

  test('setup', () => {
    root = mkdtempSync(join(tmpdir(), 'ccserver-gitallowlist-test-'));
  });

  test('non-git cwd fails closed to an empty allow-list', () => {
    const dir = join(root, 'not-a-repo');
    mkdirSync(dir, { recursive: true });
    assert.deepEqual(computeGitAllowlist(dir), []);
  });

  test("own origin remote is included; resolveOriginUrl matches it", () => {
    const dir = initRepo(join(root, 'plain'), 'https://github.com/testowner/testrepo.git');
    assert.deepEqual(computeGitAllowlist(dir), ['github.com/testowner/testrepo']);
    assert.equal(resolveOriginUrl(dir), 'https://github.com/testowner/testrepo.git');
  });

  test('a checked-out submodule contributes its URL to the allow-list', () => {
    const dir = initRepo(join(root, 'with-submodule'), 'https://github.com/testowner/parent.git');
    writeFileSync(join(dir, '.gitmodules'), [
      '[submodule "legit"]',
      '\turl = https://github.com/testowner/legit-sub.git',
      '\tpath = sub',
      '',
    ].join('\n'));
    mkdirSync(join(dir, 'sub'));
    git(join(dir, 'sub'), ['init', '-q']);

    const list = computeGitAllowlist(dir);
    assert.ok(list.includes('github.com/testowner/parent'));
    assert.ok(list.includes('github.com/testowner/legit-sub'));
  });

  test('an UNchecked-out submodule URL is NOT trusted (security: .gitmodules is untrusted repo content)', () => {
    const dir = initRepo(join(root, 'with-fake-submodule'), 'https://github.com/testowner/parent2.git');
    writeFileSync(join(dir, '.gitmodules'), [
      '[submodule "evil"]',
      '\turl = https://github.com/victimorg/private-secrets.git',
      '\tpath = never-checked-out',
      '',
    ].join('\n'));
    // Deliberately do NOT create the "never-checked-out" directory.

    const list = computeGitAllowlist(dir);
    assert.ok(list.includes('github.com/testowner/parent2'));
    assert.ok(!list.includes('github.com/victimorg/private-secrets'));
  });

  test('teardown', () => {
    rmSync(root, { recursive: true, force: true });
  });
});
