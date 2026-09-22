// Orchestrator CLAUDE.md/AGENTS.md ro-bind overlay: when orchestratorClaudeMdSrc
// is passed, buildSandboxSpawn must ro-bind it over both files inside cwd,
// placed AFTER the rw --bind cwd cwd (bwrap's last bind for a path wins, so
// order is what actually makes this a read-only overlay -- see sandbox.js's
// buildBwrapArgs). Regular (non-orchestrator) sessions must get no such bind.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxSpawn } from './sandbox.js';

let cfgPath;
let tmpRoot;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-orch-claude-md-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, persistentHome: false }));
});

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('buildSandboxSpawn ro-binds orchestratorClaudeMdSrc over CLAUDE.md and AGENTS.md, after the rw cwd bind', async () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const src = join(tmpRoot, 'generated-orchestrator.md');
    writeFileSync(src, '# Orchestrator\n');
    const spawn = await buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
      orchestratorClaudeMdSrc: src,
    });
    const args = spawn.args;

    const cwdBindIdx = args.indexOf('--bind');
    assert.ok(cwdBindIdx >= 0 && args[cwdBindIdx + 1] === tmpRoot && args[cwdBindIdx + 2] === tmpRoot, 'the rw cwd bind is present');

    const claudeMdDest = join(tmpRoot, 'CLAUDE.md');
    const agentsMdDest = join(tmpRoot, 'AGENTS.md');
    const claudeIdx = args.indexOf(claudeMdDest);
    const agentsIdx = args.indexOf(agentsMdDest);
    assert.ok(claudeIdx > 0, 'CLAUDE.md ro-bind destination present');
    assert.ok(agentsIdx > 0, 'AGENTS.md ro-bind destination present');
    assert.equal(args[claudeIdx - 2], '--ro-bind');
    assert.equal(args[claudeIdx - 1], src);
    assert.equal(args[agentsIdx - 2], '--ro-bind');
    assert.equal(args[agentsIdx - 1], src);

    // Ordering is what makes this an overlay: bwrap's last bind for a given
    // path wins, so both ro-binds must come after the rw cwd bind.
    assert.ok(claudeIdx > cwdBindIdx, 'CLAUDE.md ro-bind comes after the rw cwd bind');
    assert.ok(agentsIdx > cwdBindIdx, 'AGENTS.md ro-bind comes after the rw cwd bind');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

test('buildSandboxSpawn without orchestratorClaudeMdSrc adds no CLAUDE.md/AGENTS.md bindings (regular/worker sessions)', async () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const spawn = await buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
    });
    const args = spawn.args;
    assert.ok(!args.includes(join(tmpRoot, 'CLAUDE.md')), 'no CLAUDE.md ro-bind destination');
    assert.ok(!args.includes(join(tmpRoot, 'AGENTS.md')), 'no AGENTS.md ro-bind destination');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});
