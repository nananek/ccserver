// Commit-message guard (commitGuard.js / sandbox-commit-msg-hook.cjs):
// verifies buildSandboxSpawn's bwrap argv assembly and the runtime config
// file it writes -- no real bwrap/pty is involved (buildSandboxSpawn only
// assembles argv; see sandbox-persistent-home.test.js's same convention).
// End-to-end coverage of the hook script itself (a real `git commit` really
// being blocked/allowed) lives in sandbox-commit-msg-hook.test.js.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxSpawn, buildMinimalSandboxSpawn } from './sandbox.js';
import { DEFAULT_BLOCKED_PATTERNS } from './commitGuard.js';

let tmpRoot;
let cfgPath;

function spawnFor(json) {
  writeFileSync(cfgPath, JSON.stringify(json));
  return buildSandboxSpawn({ cwd: tmpRoot, targetCommand: ['claude'], app: 'claude', sandboxOpts: null });
}

function findSetenv(args, name) {
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === '--setenv' && args[i + 1] === name) return args[i + 2];
  }
  return null;
}

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-sb-commit-guard-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
});

after(() => {
  delete process.env.CCSERVER_SANDBOX_CONFIG;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('enabled by default: hook/config are bound, core.hooksPath is wired via GIT_CONFIG_*, and the runtime dir is returned', () => {
  const spawn = spawnFor({ docker: false, gitBroker: false, persistentHome: false });
  try {
    assert.ok(spawn.commitGuardDir, 'a commit guard runtime dir must be created even with gitBroker off (independent flags)');
    assert.ok(existsSync(spawn.commitGuardDir), 'the runtime dir actually exists on disk');

    const argsStr = spawn.args.join(' ');
    assert.ok(argsStr.includes('/ccserver-sandbox-git-hooks/commit-msg'), 'the commit-msg hook is bound at the fixed hooksPath location');
    assert.ok(argsStr.includes('/ccserver-sandbox-commit-guard.json'), 'the guard config is bound at its fixed path');

    assert.equal(findSetenv(spawn.args, 'GIT_CONFIG_COUNT'), '1');
    assert.equal(findSetenv(spawn.args, 'GIT_CONFIG_KEY_0'), 'core.hooksPath');
    assert.equal(findSetenv(spawn.args, 'GIT_CONFIG_VALUE_0'), '/ccserver-sandbox-git-hooks');
    assert.equal(findSetenv(spawn.args, 'CCSANDBOX_COMMIT_GUARD_CONFIG'), '/ccserver-sandbox-commit-guard.json');

    // The hook script's shebang needs the sandbox node binary bound too, even
    // though nothing else in this config (gitBroker off, no MCP sockets,
    // app !== commandcode) would otherwise trigger that bind.
    assert.ok(argsStr.includes('/ccserver-sandbox-node'), 'sandbox node binary is bound so the hook script (a Node script) can run');
  } finally {
    if (spawn.commitGuardDir) { try { rmSync(spawn.commitGuardDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
});

test('commitMessageGuard.enabled: false disables the whole feature, independent of gitBroker', () => {
  const spawn = spawnFor({ docker: false, gitBroker: true, persistentHome: false, commitMessageGuard: { enabled: false } });
  try {
    assert.equal(spawn.commitGuardDir, null);
    const argsStr = spawn.args.join(' ');
    assert.ok(!argsStr.includes('/ccserver-sandbox-git-hooks/commit-msg'));
    assert.equal(findSetenv(spawn.args, 'GIT_CONFIG_COUNT'), null, 'GIT_CONFIG_COUNT must not be set when the guard is off (would silently redirect core.hooksPath to an empty dir)');
  } finally {
    if (spawn.gitBrokerProc) { try { spawn.gitBrokerProc.kill('SIGKILL'); } catch { /* already dead */ } }
    if (spawn.gitBrokerDir) { try { rmSync(spawn.gitBrokerDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
});

test('the written config file contains the built-in patterns plus configured blockedPatterns, in order', () => {
  const extra = 'Co-Authored-By:.*noreply@anthropic\\.com';
  const spawn = spawnFor({ docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { blockedPatterns: [extra] } });
  try {
    assert.ok(spawn.commitGuardDir);
    const configPath = join(spawn.commitGuardDir, 'commit-guard.json');
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.deepEqual(written.patterns, [...DEFAULT_BLOCKED_PATTERNS, extra]);
  } finally {
    if (spawn.commitGuardDir) { try { rmSync(spawn.commitGuardDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
});

test('buildMinimalSandboxSpawn (the throwaway /usage capture sandbox) never wires the commit guard', () => {
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false }));
  const spawn = buildMinimalSandboxSpawn({ cwd: tmpRoot, targetCommand: ['/bin/true'], app: 'claude' });
  assert.equal(spawn.commitGuardDir, null);
  assert.ok(!spawn.args.join(' ').includes('/ccserver-sandbox-git-hooks/commit-msg'));
});
