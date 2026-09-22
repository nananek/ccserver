// gitCommonDir sandbox bind (combo group workers running in their own git
// worktree, see worktree.js): buildSandboxSpawn must additionally rw-bind
// the worktree's git-common-dir (where the real .git object store, refs and
// .git/worktrees/<role> metadata live) alongside the cwd bind, or `git
// status` etc. fail inside the sandbox even though cwd itself is rw-bound
// -- see sandbox.js's buildBwrapArgs and plan section 2.4.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxSpawn } from './sandbox.js';

let cfgPath;
let tmpRoot;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-git-common-dir-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, persistentHome: false }));
});

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('buildSandboxSpawn rw-binds gitCommonDir when provided', async () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const worktreeCwd = join(tmpRoot, 'worker-cwd');
    const gitCommonDir = join(tmpRoot, 'main-repo', '.git');
    const spawn = await buildSandboxSpawn({
      cwd: worktreeCwd,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
      gitCommonDir,
    });
    const args = spawn.args;
    const idx = args.indexOf(gitCommonDir);
    assert.ok(idx > 0, 'gitCommonDir appears as a bind source/destination');
    assert.equal(args[idx - 1], '--bind', 'gitCommonDir is bound rw (not ro) -- git needs to write index locks etc.');
    assert.equal(args[idx + 1], gitCommonDir, 'bound at the same path inside the sandbox (no path translation)');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

test('buildSandboxSpawn without gitCommonDir adds no extra .git bind', async () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const worktreeCwd = join(tmpRoot, 'worker-cwd-2');
    const gitCommonDir = join(tmpRoot, 'main-repo-2', '.git');
    const withoutBind = await buildSandboxSpawn({ cwd: worktreeCwd, targetCommand: ['claude'], app: 'claude', sandboxOpts: null });
    const withBind = await buildSandboxSpawn({ cwd: worktreeCwd, targetCommand: ['claude'], app: 'claude', sandboxOpts: null, gitCommonDir });
    assert.ok(!withoutBind.args.includes(gitCommonDir), 'no gitCommonDir bind when the option is omitted');
    // The only difference between the two spawns should be exactly the
    // 3-token '--bind gitCommonDir gitCommonDir' triple.
    assert.equal(withBind.args.length, withoutBind.args.length + 3);
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});
