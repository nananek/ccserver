// End-to-end coverage of sandbox-commit-msg-hook.cjs against a REAL git
// commit-msg hook invocation -- no bwrap/sandbox is involved (this hook's
// logic doesn't care whether it's running inside bwrap or not; it only
// reads a message file path from argv and a config path from an env var,
// both of which bwrap normally supplies as fixed paths -- see sandbox.js).
//
// The hook script's shebang (#!/ccserver-sandbox-node) only resolves inside
// the sandbox, where that path is bound to the real node binary; on the
// host it doesn't exist, so git's hooksPath dir here holds a tiny shim that
// execs the real, unmodified .cjs file via `node` directly -- exactly what
// the OS's shebang resolution does inside the sandbox, just without
// depending on that bind existing on the test host.
//
// buildSandboxSpawn's bwrap argv assembly for this feature (paths, env
// vars, the independent-of-gitBroker toggle) is covered separately in
// sandbox-commit-guard.test.js.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HOOK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'sandbox-commit-msg-hook.cjs');

let repoDir;
let hooksDir;
let configPath;

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8', ...opts });
}

// Runs `git commit`. When expectBlocked is true, asserts it fails and
// returns the error (so callers can inspect stderr/status); otherwise
// asserts it succeeds and returns null. config: null means "unset the env
// var entirely" -- distinct from omitting the option (which defaults to
// configPath) -- a default parameter only fires on an omitted/undefined
// property, so `undefined` can't itself serve as that sentinel.
function commit(message, { config = configPath, expectBlocked = false } = {}) {
  const env = { ...process.env };
  if (config === null) delete env.CCSANDBOX_COMMIT_GUARD_CONFIG;
  else env.CCSANDBOX_COMMIT_GUARD_CONFIG = config;

  try {
    git(['commit', '--allow-empty', '-m', message], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(!expectBlocked, 'expected the commit to be blocked, but it succeeded');
    return null;
  } catch (err) {
    assert.ok(expectBlocked, `expected the commit to succeed, but it failed: ${err.stderr}`);
    return err;
  }
}

before(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'ccserver-commit-hook-'));
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoDir });

  hooksDir = join(repoDir, '.ccserver-test-hooks');
  mkdirSync(hooksDir, { recursive: true });
  const shimPath = join(hooksDir, 'commit-msg');
  writeFileSync(shimPath, `#!/bin/sh\nexec node "${HOOK_SCRIPT}" "$1"\n`);
  chmodSync(shimPath, 0o755);
  execFileSync('git', ['config', 'core.hooksPath', hooksDir], { cwd: repoDir });

  configPath = join(repoDir, 'commit-guard.json');
  writeFileSync(configPath, JSON.stringify({
    patterns: ['^Claude-Session:', 'https://claude\\.ai/code/session_'],
  }));
});

after(() => {
  try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('an ordinary commit message is allowed', () => {
  commit('fix: correct off-by-one in pagination\n');
  assert.match(git(['log', '-1', '--format=%s']), /fix: correct off-by-one/);
});

test('a Claude-Session: trailer is blocked, and no commit is created', () => {
  const before_ = git(['rev-parse', 'HEAD']);
  const err = commit('fix: x\n\nClaude-Session: https://claude.ai/code/session_01ABC\n', { expectBlocked: true });
  assert.equal(err.status, 1);
  assert.match(err.stderr.toString(), /commit blocked/);
  assert.match(err.stderr.toString(), /\^Claude-Session:/);
  assert.equal(git(['rev-parse', 'HEAD']), before_, 'HEAD must not move when the hook blocks the commit');
});

test('a bare session URL without the Claude-Session: label is also blocked', () => {
  const err = commit('wip\n\nsee https://claude.ai/code/session_01XYZ\n', { expectBlocked: true });
  assert.match(err.stderr.toString(), /commit blocked/);
});

test('Co-Authored-By: ... noreply@anthropic.com is NOT blocked by the built-in patterns (opt-in only)', () => {
  commit('fix: y\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n');
  assert.match(git(['log', '-1', '--format=%s']), /fix: y/);
});

test('fails open when CCSANDBOX_COMMIT_GUARD_CONFIG is unset', () => {
  commit('fix: z\n\nClaude-Session: https://claude.ai/code/session_should_pass\n', { config: null });
  assert.match(git(['log', '-1', '--format=%s']), /fix: z/);
});

test('fails open when the config file is missing', () => {
  commit('fix: w\n\nClaude-Session: https://claude.ai/code/session_should_pass\n', { config: join(repoDir, 'does-not-exist.json') });
  assert.match(git(['log', '-1', '--format=%s']), /fix: w/);
});

test('fails open when the config file is malformed JSON', () => {
  const badConfig = join(repoDir, 'bad-config.json');
  writeFileSync(badConfig, 'not json');
  commit('fix: v\n\nClaude-Session: https://claude.ai/code/session_should_pass\n', { config: badConfig });
  assert.match(git(['log', '-1', '--format=%s']), /fix: v/);
});

test('an invalid regex pattern is skipped, valid sibling patterns in the same config still block', () => {
  const mixedConfig = join(repoDir, 'mixed-config.json');
  writeFileSync(mixedConfig, JSON.stringify({ patterns: ['(unterminated', '^Claude-Session:'] }));
  const err = commit('fix: u\n\nClaude-Session: https://claude.ai/code/session_01DEF\n', { config: mixedConfig, expectBlocked: true });
  assert.match(err.stderr.toString(), /ignoring invalid pattern/);
  assert.match(err.stderr.toString(), /commit blocked/);
});

test('an operator-added blockedPattern (e.g. Co-Authored-By) is enforced the same way as a built-in', () => {
  const optInConfig = join(repoDir, 'opt-in-config.json');
  writeFileSync(optInConfig, JSON.stringify({
    patterns: ['^Claude-Session:', 'Co-Authored-By:.*noreply@anthropic\\.com'],
  }));
  const err = commit('fix: t\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n', { config: optInConfig, expectBlocked: true });
  assert.match(err.stderr.toString(), /commit blocked/);
});

test('--no-verify bypasses the hook entirely (documented known limitation)', () => {
  const env = { ...process.env, CCSANDBOX_COMMIT_GUARD_CONFIG: configPath };
  git(['commit', '--allow-empty', '--no-verify', '-m', 'fix: s\n\nClaude-Session: https://claude.ai/code/session_bypassed\n'], { env });
  assert.match(git(['log', '-1', '--format=%s']), /fix: s/);
});
