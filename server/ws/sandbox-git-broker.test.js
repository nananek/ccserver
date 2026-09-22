import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSandboxSpawn } from './sandbox.js';

let tmpRoot;
let cfgPath;
let mainRepo;
let workerRepo;

function git(cwd, args) { execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }); }

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-sb-broker-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: true, persistentHome: false }));
  mainRepo = join(tmpRoot, 'main');
  mkdirSync(mainRepo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: mainRepo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: mainRepo });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: mainRepo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/nananek/ccserver.git'], { cwd: mainRepo });
  writeFileSync(join(mainRepo, 'README.md'), '# hi\n');
  git(mainRepo, ['add', 'README.md']);
  git(mainRepo, ['commit', '-qm', 'init']);
  workerRepo = join(tmpRoot, 'worker');
  execFileSync('git', ['worktree', 'add', '--detach', workerRepo], { cwd: mainRepo });
});

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

test('linked worktree cwd gets a broker with allowlist, non-git cwd gets no broker', async () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  let spawn1;
  let spawn2;
  try {
    spawn1 = await buildSandboxSpawn({ cwd: workerRepo, targetCommand: ['/bin/true'], app: 'claude' });
    // Should have broker fields populated
    assert.ok(spawn1.gitBrokerProc, 'linked worktree should have broker proc');
    assert.ok(spawn1.gitBrokerDir, 'linked worktree should have broker dir');
    assert.ok(existsSync(spawn1.gitBrokerDir), 'broker dir exists');
    // Check bwrap args contain broker bind
    assert.ok(spawn1.args.join(' ').includes('broker.sock'), 'bwrap args bind broker sock');
    // Cleanup proc for this spawn
    try { spawn1.gitBrokerProc.kill('SIGKILL'); } catch {}
    // Non-git cwd
    const nonGit = join(tmpRoot, 'not-a-repo');
    mkdirSync(nonGit, { recursive: true });
    spawn2 = await buildSandboxSpawn({ cwd: nonGit, targetCommand: ['/bin/true'], app: 'claude' });
    assert.equal(spawn2.gitBrokerProc, null, 'non-git cwd must not get a broker');
    assert.equal(spawn2.gitBrokerDir, null);
    assert.ok(!spawn2.args.join(' ').includes('broker.sock'), 'no broker bind for non-git');
  } finally {
    try { if (spawn1 && spawn1.gitBrokerProc) spawn1.gitBrokerProc.kill('SIGKILL'); } catch {}
    try { if (spawn1 && spawn1.gitBrokerDir) rmSync(spawn1.gitBrokerDir, { recursive: true, force: true }); } catch {}
    try { if (spawn2 && spawn2.gitBrokerDir) rmSync(spawn2.gitBrokerDir, { recursive: true, force: true }); } catch {}
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG; else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

test('broker startup failure is propagated as launch error (no silent dead wrapper)', async () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  // Simulate failure by making RUNTIME_BASE unwritable to force mkdir fail
  // Instead we test that startGitBroker throws for a git repo when runtime dir is broken:
  // Use an invalid runtime base via env XDG_RUNTIME_DIR pointing to a file
  const origRuntime = process.env.XDG_RUNTIME_DIR;
  const filePath = join(tmpRoot, 'file-not-dir');
  writeFileSync(filePath, 'x');
  process.env.XDG_RUNTIME_DIR = filePath;
  try {
    // This should throw because broker dir creation will fail or socket cannot be created
    await assert.rejects(
      () => buildSandboxSpawn({ cwd: workerRepo, targetCommand: ['/bin/true'], app: 'claude' }),
      /git broker|Failed to build sandbox/,
    );
  } finally {
    if (origRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = origRuntime;
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG; else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});
