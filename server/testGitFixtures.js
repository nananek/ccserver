// Throwaway-repository helpers for the git-facing tests (gitInfo.test.js,
// ghClone.test.js, routes/git.test.js). NOT a test file.
//
// The test process may itself run inside a ccserver sandbox, whose
// environment injects GIT_CONFIG_COUNT / KEY_n / VALUE_n (core.hooksPath,
// commit.gpgsign=true, ...). Those outrank every config file, so a fixture
// commit would try to GPG-sign and a hook path would leak in. Every git call
// here therefore starts from an environment with all GIT_* removed and the
// global / system config switched off.

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

export function fixtureGitEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    ...extra,
  };
}

export function git(cwd, args, extraEnv = {}) {
  return execFileSync('git', args, {
    cwd,
    env: fixtureGitEnv(extraEnv),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];

export function commit(dir, message = 'init') {
  git(dir, [...IDENTITY, 'commit', '-q', '--allow-empty', '-m', message]);
}

export function initRepo(dir, { branch = 'main', withCommit = true } = {}) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', branch]);
  if (withCommit) commit(dir);
  return dir;
}
