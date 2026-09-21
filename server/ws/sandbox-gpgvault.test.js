// GPG vault sandbox integration (plan: gpg-agent-vault): verifies
// buildSandboxSpawn's bwrap argv assembly when `gpgVault` is requested --
// same "no real bwrap/pty involved" convention as sandbox-commit-guard.test.js
// (buildSandboxSpawn only assembles argv). Requires a real, unlocked GPG
// vault, so this drives the actual gpgVaultAgent.js lifecycle against real
// gpg/gpgconf binaries -- skipped cleanly when unavailable (same posture as
// gpgVaultAgent.test.js).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildSandboxSpawn } from './sandbox.js';
import { getDb, closeDb } from '../db.js';
import {
  gpgVaultToolsAvailable,
  generateAndStoreVault,
  lockVault,
  isUnlocked,
} from './gpgVaultAgent.js';

const TOOLS_AVAILABLE = gpgVaultToolsAvailable();
const IS_LINUX_BWRAP = process.platform !== 'darwin';

let tmpRoot;
let cfgPath;
const savedDbPath = process.env.CCSERVER_DB_PATH;
const savedHomeRoot = process.env.CCSERVER_SANDBOX_HOME_ROOT;
const savedRuntimeDir = process.env.XDG_RUNTIME_DIR;
const savedSandboxConfig = process.env.CCSERVER_SANDBOX_CONFIG;
// This test's OWN scratch runtime dir -- see gpgVaultAgent.test.js's
// `testRuntimeDir` comment for why this must be a captured constant, never
// derived from process.env after a restore.
const testRuntimeDir = `/tmp/cgvsb${process.pid}`;

function spawnFor(json) {
  writeFileSync(cfgPath, JSON.stringify(json));
  return buildSandboxSpawn({ cwd: tmpRoot, targetCommand: ['claude'], app: 'claude', sandboxOpts: { gpgVault: true } });
}

function findSetenv(args, name) {
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === '--setenv' && args[i + 1] === name) return args[i + 2];
  }
  return null;
}

function cleanupSpawn(spawn) {
  if (!spawn) return;
  if (spawn.gitBrokerProc) { try { spawn.gitBrokerProc.kill('SIGKILL'); } catch { /* already dead */ } }
  if (spawn.gitBrokerDir) { try { rmSync(spawn.gitBrokerDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  if (spawn.commitGuardDir) { try { rmSync(spawn.commitGuardDir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-sb-gpgvault-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
  process.env.XDG_RUNTIME_DIR = testRuntimeDir;
});

after(() => {
  lockVault();
  closeDb();
  try { rmSync(testRuntimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (savedSandboxConfig === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG; else process.env.CCSERVER_SANDBOX_CONFIG = savedSandboxConfig;
  if (savedDbPath === undefined) delete process.env.CCSERVER_DB_PATH; else process.env.CCSERVER_DB_PATH = savedDbPath;
  if (savedHomeRoot === undefined) delete process.env.CCSERVER_SANDBOX_HOME_ROOT; else process.env.CCSERVER_SANDBOX_HOME_ROOT = savedHomeRoot;
  if (savedRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = savedRuntimeDir;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  lockVault();
  closeDb();
  const db = getDb();
  db.exec('DELETE FROM gpg_vault_credentials');
  db.exec('DELETE FROM gpg_vault');
  db.exec('DELETE FROM webauthn_credentials');
});

function setUpUnlockedVault() {
  getDb().prepare('INSERT INTO webauthn_credentials (id, public_key, counter, label, created_at) VALUES (?,?,?,?,?)')
    .run('cred-sb-1', Buffer.from('pk'), 0, null, Date.now());
  return generateAndStoreVault({
    nameReal: 'ccserver sandbox test', nameEmail: 'ccserver-sandbox-test@example.invalid',
    credentialId: 'cred-sb-1', prfSecret: randomBytes(32),
  });
}

test('gpgVault:true while no vault has been set up throws before any broker starts', { skip: !TOOLS_AVAILABLE }, () => {
  assert.throws(
    () => spawnFor({ docker: false, gitBroker: true, persistentHome: false }),
    /no GPG vault has been set up yet/,
  );
});

test('gpgVault:true while the vault is locked throws before any broker starts', { skip: !TOOLS_AVAILABLE }, () => {
  setUpUnlockedVault();
  lockVault();
  assert.throws(
    () => spawnFor({ docker: false, gitBroker: true, persistentHome: false }),
    /currently locked/,
  );
});

test('gpgVault:true while unlocked: binds public files+sockets, sets GNUPGHOME/SSH_AUTH_SOCK, injects git identity, and never exposes secret material', { skip: !TOOLS_AVAILABLE || !IS_LINUX_BWRAP }, () => {
  const vault = setUpUnlockedVault();
  const spawn = spawnFor({ docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: false } });
  try {
    const argsStr = spawn.args.join(' ');

    // Own target dir, distinct from the legacy gpg:true flag's ~/.gnupg.
    assert.ok(argsStr.includes('gnupg-vault'), 'uses its own gnupg-vault target dir');

    // Public files bound read-only (--ro-bind-try), sockets bound live (--bind-try).
    assert.ok(argsStr.includes('pubring.kbx'));
    const dashDashDir = spawn.args.indexOf('--dir');
    assert.ok(dashDashDir >= 0, '--dir creates the empty target directory node');

    assert.equal(findSetenv(spawn.args, 'GNUPGHOME')?.endsWith('gnupg-vault'), true);
    const sshAuthSock = findSetenv(spawn.args, 'SSH_AUTH_SOCK');
    assert.ok(sshAuthSock && sshAuthSock.includes('gnupg-vault'), 'SSH_AUTH_SOCK points at the in-sandbox bind target, not the host path');

    // Git identity injected via GIT_CONFIG_COUNT/KEY/VALUE (no commitGuard here, so gpgVault owns indices 0-4).
    assert.equal(findSetenv(spawn.args, 'GIT_CONFIG_COUNT'), '5');
    const gitConfig = {};
    for (let i = 0; i < 5; i++) {
      gitConfig[findSetenv(spawn.args, `GIT_CONFIG_KEY_${i}`)] = findSetenv(spawn.args, `GIT_CONFIG_VALUE_${i}`);
    }
    assert.equal(gitConfig['user.signingkey'], vault.fingerprint);
    assert.equal(gitConfig['commit.gpgsign'], 'true');
    assert.equal(gitConfig['gpg.program'], 'gpg');
    assert.equal(gitConfig['user.name'], 'ccserver sandbox test');
    assert.equal(gitConfig['user.email'], 'ccserver-sandbox-test@example.invalid');

    // Security-critical: the secret key material must NEVER appear as a bind
    // source/target anywhere in the generated argv.
    assert.ok(!argsStr.includes('private-keys-v1.d'), 'private-keys-v1.d must never be bound into the sandbox');
    assert.ok(!argsStr.includes('openpgp-revocs.d'), 'revocation certs must never be bound into the sandbox');
    assert.ok(!argsStr.includes('sshcontrol'), 'sshcontrol (host-only ssh-agent config) must never be bound into the sandbox');
  } finally {
    cleanupSpawn(spawn);
  }
});

test('gpgVault + commitMessageGuard both active: GIT_CONFIG_COUNT accounts for both, indices do not collide', { skip: !TOOLS_AVAILABLE || !IS_LINUX_BWRAP }, () => {
  setUpUnlockedVault();
  const spawn = spawnFor({ docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: true } });
  try {
    assert.equal(findSetenv(spawn.args, 'GIT_CONFIG_COUNT'), '6', 'core.hooksPath (1) + gpgVault (5) = 6');
    const gitConfig = {};
    for (let i = 0; i < 6; i++) {
      gitConfig[findSetenv(spawn.args, `GIT_CONFIG_KEY_${i}`)] = findSetenv(spawn.args, `GIT_CONFIG_VALUE_${i}`);
    }
    assert.equal(gitConfig['core.hooksPath'], '/ccserver-sandbox-git-hooks');
    assert.equal(gitConfig['commit.gpgsign'], 'true');
    assert.ok(spawn.commitGuardDir, 'commit guard runtime dir still created alongside gpgVault');
  } finally {
    cleanupSpawn(spawn);
    if (spawn?.commitGuardDir) { try { rmSync(spawn.commitGuardDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
});

test('gpgVault:true alongside the legacy gpg host-forwarding flag does not throw (warns, gpgVault wins)', { skip: !TOOLS_AVAILABLE || !IS_LINUX_BWRAP }, () => {
  setUpUnlockedVault();
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: false }, gpg: true }));
  const spawn = buildSandboxSpawn({ cwd: tmpRoot, targetCommand: ['claude'], app: 'claude', sandboxOpts: { gpgVault: true } });
  try {
    const sshAuthSock = findSetenv(spawn.args, 'SSH_AUTH_SOCK');
    assert.ok(sshAuthSock && sshAuthSock.includes('gnupg-vault'), 'gpgVault wins the SSH_AUTH_SOCK setenv (last bind wins)');
  } finally {
    cleanupSpawn(spawn);
  }
});

test('isUnlocked() reflects lock/unlock across the test helpers (sanity)', { skip: !TOOLS_AVAILABLE }, () => {
  assert.equal(isUnlocked(), false);
  setUpUnlockedVault();
  assert.equal(isUnlocked(), true);
  lockVault();
  assert.equal(isUnlocked(), false);
});
