// Filesystem-root sandbox builds: a sandbox with "/" as projectDir is
// fail-open -- seatbelt's subtrees('/') compiles to "^/(/.*)?$" and bwrap
// would rw-bind "/" itself -- so buildSandboxSpawn must refuse it outright
// (defense in depth behind sessionManager's cwd='/' launch refusal). See
// docs/seatbelt-root-read-abort-diagnosis.md.
//
// No config pinning needed: the guard throws before loadSandboxConfig() so
// the test is independent of any machine sandbox.config.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxSpawn } from './sandbox.js';

test('buildSandboxSpawn refuses the filesystem root as cwd', async () => {
  await assert.rejects(
    () => buildSandboxSpawn({ cwd: '/', targetCommand: ['claude'], app: 'claude', sandboxOpts: null }),
    /Cannot build a sandbox for the filesystem root/,
  );
});

test('buildSandboxSpawn refuses path spellings that resolve to the root', async () => {
  await assert.rejects(
    () => buildSandboxSpawn({ cwd: '/tmp/..', targetCommand: ['claude'], app: 'claude', sandboxOpts: null }),
    /Cannot build a sandbox for the filesystem root/,
  );
});

// browseRoots (issue #189) defense in depth: buildSandboxSpawn re-checks
// containment itself, the same way it re-checks cwd==='/' above, rather than
// trusting sessionManager's own check to have run. Unlike the '/' guard,
// this DOES read loadSandboxConfig(), so it needs CCSERVER_SANDBOX_CONFIG
// pinned at a temp file for the duration of the test.
test('buildSandboxSpawn refuses a cwd outside browseRoots when browseRoots is configured', async () => {
  const allowed = mkdtempSync(join(tmpdir(), 'ccserver-sbroot-allowed-'));
  const outside = mkdtempSync(join(tmpdir(), 'ccserver-sbroot-outside-'));
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-sbroot-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ browseRoots: [allowed] }));
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    await assert.rejects(
      () => buildSandboxSpawn({ cwd: outside, targetCommand: ['claude'], app: 'claude', sandboxOpts: null }),
      /Cannot build a sandbox: working directory is outside the allowed browseRoots/,
    );
  } finally {
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    rmSync(allowed, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
  }
});
