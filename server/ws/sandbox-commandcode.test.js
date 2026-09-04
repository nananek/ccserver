// commandcode auth persistence: buildSandboxSpawn must rw-bind
// ~/.commandcode (which holds auth.json with the API key) into the sandbox,
// otherwise every sandboxed commandcode launch prompts for the API key again.
// Same pattern as the existing ~/.codex / ~/.copilot binds.
//
// Isolated via CCSERVER_SANDBOX_CONFIG and CCSERVER_SANDBOX_HOME_ROOT (no real
// bwrap/pty involved -- buildSandboxSpawn only assembles the argv).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxSpawn } from './sandbox.js';

const HOME = homedir();
const COMMANDCODE_HOME = join(HOME, '.commandcode');

let cfgPath;
let tmpRoot;
let prevConfig;
let prevHomeRoot;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-commandcode-bind-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, persistentHome: false }));
  prevConfig = process.env.CCSERVER_SANDBOX_CONFIG;
  prevHomeRoot = process.env.CCSERVER_SANDBOX_HOME_ROOT;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
});

after(() => {
  if (prevConfig === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
  else process.env.CCSERVER_SANDBOX_CONFIG = prevConfig;
  if (prevHomeRoot === undefined) delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  else process.env.CCSERVER_SANDBOX_HOME_ROOT = prevHomeRoot;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function hasRwBind(args, src) {
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === '--bind' && args[i + 1] === src && args[i + 2] === src) return true;
  }
  return false;
}

test('buildSandboxSpawn rw-binds ~/.commandcode so the API key survives sandbox launches', () => {
  const spawn = buildSandboxSpawn({
    cwd: tmpRoot,
    targetCommand: ['command-code'],
    app: 'commandcode',
    sandboxOpts: null,
  });
  assert.ok(
    hasRwBind(spawn.args, COMMANDCODE_HOME),
    `expected --bind ${COMMANDCODE_HOME} ${COMMANDCODE_HOME} in sandbox args`,
  );
});

test('buildSandboxSpawn binds ~/.commandcode for non-commandcode apps too (shared auth state, like ~/.claude)', () => {
  const spawn = buildSandboxSpawn({
    cwd: tmpRoot,
    targetCommand: ['claude'],
    app: 'claude',
    sandboxOpts: null,
  });
  assert.ok(
    hasRwBind(spawn.args, COMMANDCODE_HOME),
    `expected --bind ${COMMANDCODE_HOME} ${COMMANDCODE_HOME} in sandbox args`,
  );
});
