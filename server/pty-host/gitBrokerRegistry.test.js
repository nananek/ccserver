import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { GitBrokerRegistry } from './gitBrokerRegistry.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'ccserver-gitbroker-test-'));
}

test('record + forget persist and clear the registry file', () => {
  const dir = tmpDir();
  const regPath = join(dir, 'registry.json');
  try {
    const reg = new GitBrokerRegistry(regPath);
    reg.record('session-1', { pid: 999999, dir: join(dir, 'broker-1') });
    assert.ok(existsSync(regPath));

    // A fresh instance re-reads from disk -- proves the write actually
    // landed, not just in-memory state.
    const reg2 = new GitBrokerRegistry(regPath);
    reg2.forget('session-1');
    assert.ok(!existsSync(regPath), 'registry file is removed once empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reapOrphans kills a still-alive pid and removes its dir', async () => {
  const dir = tmpDir();
  const regPath = join(dir, 'registry.json');
  const brokerDir = join(dir, 'broker-alive');
  mkdirSync(brokerDir, { recursive: true });
  // A real long-lived process standing in for a leaked git-broker child.
  const proc = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  try {
    await new Promise((resolve) => proc.once('spawn', resolve));
    writeFileSync(regPath, JSON.stringify({ 'session-orphan': { pid: proc.pid, dir: brokerDir } }));

    const reg = new GitBrokerRegistry(regPath);
    const result = reg.reapOrphans();
    assert.equal(result.found, 1);
    assert.equal(result.killed, 1);

    await new Promise((resolve) => {
      proc.once('exit', resolve);
      setTimeout(resolve, 2000); // safety net if the signal is somehow missed
    });
    assert.throws(() => process.kill(proc.pid, 0), 'orphan process was actually killed');
    assert.ok(!existsSync(brokerDir), 'orphan broker dir was removed');
    assert.ok(!existsSync(regPath), 'registry is cleared after reaping');
  } finally {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reapOrphans tolerates an entry whose pid is already dead', () => {
  const dir = tmpDir();
  const regPath = join(dir, 'registry.json');
  try {
    // A pid essentially guaranteed not to exist.
    writeFileSync(regPath, JSON.stringify({ 'session-dead': { pid: 999999, dir: join(dir, 'gone') } }));
    const reg = new GitBrokerRegistry(regPath);
    const result = reg.reapOrphans();
    assert.equal(result.found, 1);
    assert.equal(result.killed, 0);
    assert.ok(!existsSync(regPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reapOrphans on a missing/empty registry is a safe no-op', () => {
  const dir = tmpDir();
  try {
    const reg = new GitBrokerRegistry(join(dir, 'does-not-exist.json'));
    const result = reg.reapOrphans();
    assert.deepEqual(result, { found: 0, killed: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
