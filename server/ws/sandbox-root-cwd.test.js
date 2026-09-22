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
