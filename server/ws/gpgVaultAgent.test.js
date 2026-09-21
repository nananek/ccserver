// Integration tests for the GPG vault agent lifecycle. Requires real
// `gpg`/`gpgconf` binaries on the test host (this dev host has GnuPG 2.4.9;
// same posture as git-broker.test.js's dependency on a real `git` binary) --
// skipped cleanly via gpgVaultToolsAvailable() when unavailable, rather than
// failing CI on a host without GnuPG installed.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { getDb, closeDb } from '../db.js';
import {
  isUnlocked,
  vaultExists,
  gpgVaultToolsAvailable,
  generateAndStoreVault,
  addCredentialWithAuthorizer,
  unlockVault,
  lockVault,
  getUnlockedAgentInfo,
  isLegacyVault,
  deleteVault,
  verifyEnrolledCredential,
} from './gpgVaultAgent.js';
import { getCredentialWrap } from '../gpgVaultDb.js';

const TOOLS_AVAILABLE = gpgVaultToolsAvailable();

let tmpRoot;
const savedEnv = process.env.CCSERVER_DB_PATH;
const savedHomeRoot = process.env.CCSERVER_SANDBOX_HOME_ROOT;
const savedRuntimeDir = process.env.XDG_RUNTIME_DIR;

// This test's OWN scratch runtime dir, captured once so cleanup below can
// never accidentally target the real XDG_RUNTIME_DIR (see the incident this
// comment is here because of: an earlier version of this file restored
// process.env.XDG_RUNTIME_DIR to its saved/real value FIRST and then passed
// that same env var to rmSync, which deleted the host's real /run/user/<uid>
// -- including this very session's own live git-broker socket directory.
// Never derive a cleanup path from process.env after it's been restored;
// always use a value captured before the restore.
const testRuntimeDir = `/tmp/cgv${process.pid}`;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-gpgvaultagent-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
  // A SHORT, private runtime dir -- socket paths under it must stay well
  // under sockaddr_un's length limit (verified empirically while building
  // this feature: a merely "reasonable-looking" but longer override here
  // already pushed the longest socket name, S.gpg-agent.browser, over 108
  // bytes and made gpg-agent fail to start with a generic, misleading
  // error). Production's real hostRuntimeDir() (/run/user/<uid>) is this
  // short by construction; this override must match that, not be merely
  // short-ish. Not tmpRoot itself: that lives under the system tmpdir, whose
  // full path can already be long.
  process.env.XDG_RUNTIME_DIR = testRuntimeDir;
});

after(() => {
  closeDb();
  // Wipe our OWN scratch runtime dir using the captured constant -- NOT
  // process.env.XDG_RUNTIME_DIR, which is about to be restored to (or may
  // already need restoring to) the real value below. See testRuntimeDir's
  // header comment.
  try { rmSync(testRuntimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (savedEnv === undefined) delete process.env.CCSERVER_DB_PATH; else process.env.CCSERVER_DB_PATH = savedEnv;
  if (savedHomeRoot === undefined) delete process.env.CCSERVER_SANDBOX_HOME_ROOT; else process.env.CCSERVER_SANDBOX_HOME_ROOT = savedHomeRoot;
  if (savedRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = savedRuntimeDir;
  rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  lockVault();
  closeDb();
  const db = getDb();
  db.exec('DELETE FROM gpg_vault_credentials');
  db.exec('DELETE FROM gpg_vault');
  db.exec('DELETE FROM webauthn_credentials');
});

function insertCredential(id) {
  getDb().prepare('INSERT INTO webauthn_credentials (id, public_key, counter, label, created_at) VALUES (?,?,?,?,?)')
    .run(id, Buffer.from('pk'), 0, null, Date.now());
}

test('gpgVaultToolsAvailable reports true on a host with gpg/gpgconf', () => {
  assert.equal(typeof TOOLS_AVAILABLE, 'boolean');
});

test('full lifecycle: generate -> unlock -> sign -> ssh -> lock -> sockets gone', { skip: !TOOLS_AVAILABLE }, () => {
  insertCredential('cred-1');
  const prfSecret = randomBytes(32);

  assert.equal(vaultExists(), false);
  assert.equal(isUnlocked(), false);

  const info = generateAndStoreVault({
    nameReal: 'ccserver test', nameEmail: 'ccserver-test@example.invalid',
    credentialId: 'cred-1', prfSecret, prfSalt: randomBytes(32),
  });

  assert.equal(vaultExists(), true);
  assert.equal(isUnlocked(), true);
  assert.match(info.fingerprint, /^[0-9A-F]{40}$/);
  assert.match(info.publicKeyArmored, /-----BEGIN PGP PUBLIC KEY BLOCK-----/);
  assert.match(info.sshPublicKey, /^ssh-ed25519 /);
  assert.equal(info.nameReal, 'ccserver test');
  assert.equal(info.nameEmail, 'ccserver-test@example.invalid');

  const agentInfo = getUnlockedAgentInfo();
  assert.ok(existsSync(agentInfo.sockets.agent), 'S.gpg-agent must exist while unlocked');
  assert.ok(existsSync(agentInfo.sockets.agentSsh), 'S.gpg-agent.ssh must exist while unlocked');
  // The restricted socket the sandbox relay targets (security audit F1).
  assert.ok(existsSync(agentInfo.sockets.agentExtra), 'S.gpg-agent.extra must exist while unlocked');

  // Real signing round trip through the live socket.
  const msgPath = join(tmpRoot, 'msg.txt');
  execFileSync('sh', ['-c', `echo hello > ${msgPath}`]);
  execFileSync('gpg', [
    '--homedir', agentInfo.homeDir, '--batch', '--pinentry-mode', 'loopback',
    '--local-user', agentInfo.fingerprint, '--detach-sign', msgPath,
  ], { timeout: 10000 });
  assert.ok(existsSync(`${msgPath}.sig`), 'detached signature must be produced with no prompt');
  const verifyOut = execFileSync('gpg', ['--homedir', agentInfo.homeDir, '--verify', `${msgPath}.sig`, msgPath], {
    timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

  // Real SSH auth round trip through the ssh-support socket.
  const sshListOut = execFileSync('ssh-add', ['-l'], {
    timeout: 5000, encoding: 'utf8', env: { ...process.env, SSH_AUTH_SOCK: agentInfo.sockets.agentSsh },
  });
  assert.match(sshListOut, /ED25519/);

  lockVault();
  assert.equal(isUnlocked(), false);
  assert.equal(existsSync(agentInfo.sockets.agent), false, 'lock must remove the live socket');
  assert.throws(() => getUnlockedAgentInfo(), /locked/);
});

test('unlockVault with no vault set up throws GPG_VAULT_NOT_SET_UP', { skip: !TOOLS_AVAILABLE }, () => {
  assert.throws(
    () => unlockVault({ credentialId: 'nonexistent', prfSecret: randomBytes(32) }),
    (err) => err.code === 'GPG_VAULT_NOT_SET_UP',
  );
});

test('unlockVault with an unenrolled credential throws GPG_VAULT_CREDENTIAL_NOT_ENROLLED', { skip: !TOOLS_AVAILABLE }, () => {
  insertCredential('cred-a');
  insertCredential('cred-b');
  generateAndStoreVault({
    nameReal: 'x', nameEmail: 'x@example.invalid', credentialId: 'cred-a', prfSecret: randomBytes(32), prfSalt: randomBytes(32),
  });
  lockVault();
  assert.throws(
    () => unlockVault({ credentialId: 'cred-b', prfSecret: randomBytes(32) }),
    (err) => err.code === 'GPG_VAULT_CREDENTIAL_NOT_ENROLLED',
  );
});

test('unlockVault with the wrong PRF secret for an enrolled credential fails closed', { skip: !TOOLS_AVAILABLE }, () => {
  insertCredential('cred-c');
  generateAndStoreVault({
    nameReal: 'x', nameEmail: 'x@example.invalid', credentialId: 'cred-c', prfSecret: randomBytes(32), prfSalt: randomBytes(32),
  });
  lockVault();
  assert.throws(() => unlockVault({ credentialId: 'cred-c', prfSecret: randomBytes(32) }));
  assert.equal(isUnlocked(), false);
});

test('generateAndStoreVault refuses when a vault already exists', { skip: !TOOLS_AVAILABLE }, () => {
  insertCredential('cred-d');
  generateAndStoreVault({
    nameReal: 'x', nameEmail: 'x@example.invalid', credentialId: 'cred-d', prfSecret: randomBytes(32), prfSalt: randomBytes(32),
  });
  assert.throws(() => generateAndStoreVault({
    nameReal: 'y', nameEmail: 'y@example.invalid', credentialId: 'cred-d', prfSecret: randomBytes(32), prfSalt: randomBytes(32),
  }), /already exists/);
});

// Security audit F2: adding a passkey is authorized by an ENROLLED
// passkey's PRF decrypting its own wrap -- not by the vault being unlocked.
test('addCredentialWithAuthorizer: a second passkey can then unlock independently, and it works while LOCKED', { skip: !TOOLS_AVAILABLE }, () => {
  insertCredential('cred-e1');
  insertCredential('cred-e2');
  const secret1 = randomBytes(32);
  const secret2 = randomBytes(32);

  const info1 = generateAndStoreVault({
    nameReal: 'x', nameEmail: 'x@example.invalid', credentialId: 'cred-e1', prfSecret: secret1, prfSalt: randomBytes(32),
  });
  lockVault();
  addCredentialWithAuthorizer({
    authorizer: { credentialId: 'cred-e1', prfSecret: secret1 },
    candidate: { credentialId: 'cred-e2', prfSecret: secret2, prfSalt: randomBytes(32) },
  });
  assert.equal(isUnlocked(), false, 'adding a passkey never unlocks the vault');

  const info2 = unlockVault({ credentialId: 'cred-e2', prfSecret: secret2 });
  assert.equal(info2.fingerprint, info1.fingerprint, 'both credentials must unlock the same underlying key');
  lockVault();

  const info3 = unlockVault({ credentialId: 'cred-e1', prfSecret: secret1 });
  assert.equal(info3.fingerprint, info1.fingerprint);
});

test('addCredentialWithAuthorizer: refuses a wrong authorizer PRF even while the vault is UNLOCKED (audit F2 core)', { skip: !TOOLS_AVAILABLE }, () => {
  insertCredential('cred-g1');
  insertCredential('cred-attacker');
  generateAndStoreVault({
    nameReal: 'x', nameEmail: 'x@example.invalid', credentialId: 'cred-g1', prfSecret: randomBytes(32), prfSalt: randomBytes(32),
  });
  assert.equal(isUnlocked(), true, 'precondition: owner has the vault unlocked');
  assert.throws(() => addCredentialWithAuthorizer({
    authorizer: { credentialId: 'cred-g1', prfSecret: randomBytes(32) }, // attacker cannot produce the real PRF
    candidate: { credentialId: 'cred-attacker', prfSecret: randomBytes(32), prfSalt: randomBytes(32) },
  }));
  assert.equal(getCredentialWrap('cred-attacker'), null, 'attacker passkey was NOT enrolled');
});

test('addCredentialWithAuthorizer: an authorizer that is not itself enrolled is refused', { skip: !TOOLS_AVAILABLE }, () => {
  insertCredential('cred-h1');
  insertCredential('cred-h2');
  insertCredential('cred-h3');
  generateAndStoreVault({
    nameReal: 'x', nameEmail: 'x@example.invalid', credentialId: 'cred-h1', prfSecret: randomBytes(32), prfSalt: randomBytes(32),
  });
  assert.throws(() => addCredentialWithAuthorizer({
    authorizer: { credentialId: 'cred-h2', prfSecret: randomBytes(32) },
    candidate: { credentialId: 'cred-h3', prfSecret: randomBytes(32), prfSalt: randomBytes(32) },
  }), (err) => err.code === 'GPG_VAULT_CREDENTIAL_NOT_ENROLLED');
  assert.equal(getCredentialWrap('cred-h3'), null);
});

test('addCredentialWithAuthorizer: an already-enrolled candidate is never overwritten', { skip: !TOOLS_AVAILABLE }, () => {
  insertCredential('cred-i1');
  insertCredential('cred-i2');
  const s1 = randomBytes(32);
  const s2 = randomBytes(32);
  generateAndStoreVault({ nameReal: 'x', nameEmail: 'x@example.invalid', credentialId: 'cred-i1', prfSecret: s1, prfSalt: randomBytes(32) });
  addCredentialWithAuthorizer({
    authorizer: { credentialId: 'cred-i1', prfSecret: s1 },
    candidate: { credentialId: 'cred-i2', prfSecret: s2, prfSalt: randomBytes(32) },
  });
  const before = Buffer.from(getCredentialWrap('cred-i2').wrapped_key);
  assert.throws(() => addCredentialWithAuthorizer({
    authorizer: { credentialId: 'cred-i1', prfSecret: s1 },
    candidate: { credentialId: 'cred-i2', prfSecret: randomBytes(32), prfSalt: randomBytes(32) },
  }), (err) => err.code === 'GPG_VAULT_CREDENTIAL_ALREADY_ENROLLED');
  assert.deepEqual(Buffer.from(getCredentialWrap('cred-i2').wrapped_key), before);
  lockVault();
  assert.doesNotThrow(() => unlockVault({ credentialId: 'cred-i2', prfSecret: s2 }), 'original owner still unlocks');
});

// Security audit F6: a PRF output that has been used once stops working
// after the next unlock re-wraps under a new salt.
test('unlockVault with rotation: the previous PRF output no longer unlocks, the next one does', { skip: !TOOLS_AVAILABLE }, () => {
  insertCredential('cred-r');
  const s1 = randomBytes(32);
  const salt1 = randomBytes(32);
  generateAndStoreVault({ nameReal: 'x', nameEmail: 'x@example.invalid', credentialId: 'cred-r', prfSecret: s1, prfSalt: salt1 });
  lockVault();

  const s2 = randomBytes(32);
  const salt2 = randomBytes(32);
  const info = unlockVault({ credentialId: 'cred-r', prfSecret: s1, rotation: { nextSalt: salt2, nextPrfSecret: s2 } });
  assert.equal(info.rotated, true);
  assert.deepEqual(Buffer.from(getCredentialWrap('cred-r').prf_salt), salt2);
  lockVault();

  assert.throws(() => unlockVault({ credentialId: 'cred-r', prfSecret: s1 }), 'a captured old PRF output is dead');
  assert.equal(isUnlocked(), false);
  unlockVault({ credentialId: 'cred-r', prfSecret: s2 });
  assert.equal(isUnlocked(), true);
});

test('verifyEnrolledCredential: passes for the right PRF, throws for a wrong one, never unlocks', { skip: !TOOLS_AVAILABLE }, () => {
  insertCredential('cred-v');
  const s = randomBytes(32);
  generateAndStoreVault({ nameReal: 'x', nameEmail: 'x@example.invalid', credentialId: 'cred-v', prfSecret: s, prfSalt: randomBytes(32) });
  lockVault();
  assert.doesNotThrow(() => verifyEnrolledCredential({ credentialId: 'cred-v', prfSecret: s }));
  assert.throws(() => verifyEnrolledCredential({ credentialId: 'cred-v', prfSecret: randomBytes(32) }));
  assert.equal(isUnlocked(), false);
});

// Security audit F1.4: a pre-fix vault is disabled for good.
test('legacy (pre-fix) vault: unlock and add-credential are refused with GPG_VAULT_LEGACY_DISABLED; delete works', { skip: !TOOLS_AVAILABLE }, () => {
  insertCredential('cred-l1');
  insertCredential('cred-l2');
  const s1 = randomBytes(32);
  generateAndStoreVault({ nameReal: 'x', nameEmail: 'x@example.invalid', credentialId: 'cred-l1', prfSecret: s1, prfSalt: randomBytes(32) });
  lockVault();
  // What db.js v9 does to every vault that existed before the fix.
  getDb().prepare('UPDATE gpg_vault SET format_version = 1').run();
  assert.equal(isLegacyVault(), true);

  assert.throws(() => unlockVault({ credentialId: 'cred-l1', prfSecret: s1 }), (err) => err.code === 'GPG_VAULT_LEGACY_DISABLED');
  assert.equal(isUnlocked(), false, 'even the correct PRF cannot unlock a legacy vault');
  assert.throws(() => addCredentialWithAuthorizer({
    authorizer: { credentialId: 'cred-l1', prfSecret: s1 },
    candidate: { credentialId: 'cred-l2', prfSecret: randomBytes(32), prfSalt: randomBytes(32) },
  }), (err) => err.code === 'GPG_VAULT_LEGACY_DISABLED');

  deleteVault();
  assert.equal(vaultExists(), false);
  assert.equal(isLegacyVault(), false);
  // Recreate: a fresh post-fix vault is usable again.
  generateAndStoreVault({ nameReal: 'x', nameEmail: 'x@example.invalid', credentialId: 'cred-l1', prfSecret: s1, prfSalt: randomBytes(32) });
  assert.equal(isLegacyVault(), false);
  assert.equal(isUnlocked(), true);
});

test('lockVault is idempotent when already locked', { skip: !TOOLS_AVAILABLE }, () => {
  assert.equal(isUnlocked(), false);
  assert.doesNotThrow(() => lockVault());
  assert.equal(isUnlocked(), false);
});
