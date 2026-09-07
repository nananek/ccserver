// ccserver-meta gating (see metaAgent.js): pure injection decision + config
// flag parsing. The broker lifecycle itself needs real sockets, so it is
// exercised only indirectly (metaBrokerRunning false until started).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, statSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldInjectMetaAgent, metaAgentEnabled, getMetaSockPath, metaBrokerRunning, metaAgentDir, ensureMetaAgentDir } from './metaAgent.js';

let tmpRoot;
let savedConfigEnv;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-meta-agent-'));
  savedConfigEnv = process.env.CCSERVER_SANDBOX_CONFIG;
});

after(() => {
  if (savedConfigEnv === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
  else process.env.CCSERVER_SANDBOX_CONFIG = savedConfigEnv;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function withConfig(obj) {
  const file = join(tmpRoot, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(obj));
  process.env.CCSERVER_SANDBOX_CONFIG = file;
}

test('shouldInjectMetaAgent requires the explicit isMetaAgent flag (and nothing else)', () => {
  const on = true;
  for (const app of ['claude', 'opencode', 'codex']) {
    assert.equal(shouldInjectMetaAgent({ shell: false, app, isMetaAgent: true, metaAgentEnabled: on }), true, app);
    assert.equal(shouldInjectMetaAgent({ shell: false, app, isMetaAgent: false, metaAgentEnabled: on }), false, `${app} without the flag`);
  }
  // Never for shells, copilot, or a disabled feature -- even WITH the flag.
  assert.equal(shouldInjectMetaAgent({ shell: true, app: null, isMetaAgent: true, metaAgentEnabled: on }), false);
  assert.equal(shouldInjectMetaAgent({ shell: false, app: 'copilot', isMetaAgent: true, metaAgentEnabled: on }), false);
  assert.equal(shouldInjectMetaAgent({ shell: false, app: 'claude', isMetaAgent: true, metaAgentEnabled: false }), false);
});

test('metaAgentEnabled is opt-in via sandbox.config.json metaAgentMcp:true only', () => {
  withConfig({});
  assert.equal(metaAgentEnabled(), false, 'default off');
  withConfig({ usageMcp: true });
  assert.equal(metaAgentEnabled(), false, 'unrelated flags do not enable it');
  withConfig({ metaAgentMcp: false });
  assert.equal(metaAgentEnabled(), false);
  withConfig({ metaAgentMcp: true });
  assert.equal(metaAgentEnabled(), true);
});

test('the socket path lives under XDG_RUNTIME_DIR and the broker starts stopped', () => {
  const savedRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = '/tmp/meta-agent-test-rt';
  try {
    assert.match(getMetaSockPath(), /\/tmp\/meta-agent-test-rt\/ccserver-meta\.d\/sock$/);
  } finally {
    if (savedRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = savedRuntime;
  }
  assert.equal(metaBrokerRunning(), false, 'nothing started in this test run');
});

test('metaAgentDir is the fixed project-outside path; ensureMetaAgentDir creates it 0o700 and is idempotent', () => {
  assert.equal(
    metaAgentDir(),
    join(homedir(), '.local', 'share', 'ccserver-sandbox', 'meta-agent'),
    'the dir is homedir-based, matching orchestratorDirForCwd\'s convention',
  );
  const dir = metaAgentDir();
  const existed = existsSync(dir);
  const first = ensureMetaAgentDir();
  const second = ensureMetaAgentDir();
  assert.equal(first, dir);
  assert.equal(second, dir);
  assert.equal(existsSync(dir), true);
  assert.equal(statSync(dir).mode & 0o777, 0o700, 'private to the server user');
  // Politeness only: remove the dir again when this run created it (and it
  // stayed empty -- a real deployment's dir carries state and must survive).
  if (!existed) {
    try { rmdirSync(dir); } catch { /* non-empty or gone: leave it */ }
  }
});
