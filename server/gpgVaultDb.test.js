import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, closeDb } from './db.js';
import {
  GPG_VAULT_ID,
  vaultExists,
  getVaultRow,
  getVaultPublicInfo,
  createVault,
  getCredentialWrap,
  listUnlockableCredentialIds,
  countCredentialWraps,
  addCredentialWrap,
  rotateCredentialWrap,
  listUnlockableCredentials,
  isLegacyVault,
  deleteVault,
  VAULT_FORMAT_VERSION,
} from './gpgVaultDb.js';

const SALT = Buffer.alloc(32, 7);

let tmpRoot;
const savedEnv = process.env.CCSERVER_DB_PATH;
const savedHomeRoot = process.env.CCSERVER_SANDBOX_HOME_ROOT;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-gpgvaultdb-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  // Isolates the v2 migration's legacy-sidecar-index read from any real
  // host state (see db.test.js, which does the same for the same reason).
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
});

after(() => {
  closeDb();
  if (savedEnv === undefined) delete process.env.CCSERVER_DB_PATH;
  else process.env.CCSERVER_DB_PATH = savedEnv;
  if (savedHomeRoot === undefined) delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  else process.env.CCSERVER_SANDBOX_HOME_ROOT = savedHomeRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
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

// Shared fixture fields so each test only needs to override what it cares
// about (fingerprint must stay unique per test, everything else is boilerplate).
function vaultFixture(overrides) {
  return {
    fingerprint: 'FPR', keyId: 'KEYID',
    nameReal: 'ccserver', nameEmail: 'ccserver@example.com',
    publicKeyArmored: '-----BEGIN-----', sshPublicKey: 'ssh-ed25519 AAA',
    encryptedSecretKey: Buffer.from('ct'), encryptionNonce: Buffer.from('n'), encryptionTag: Buffer.from('t'),
    ...overrides,
  };
}

test('vaultExists is false before creation, true after', () => {
  assert.equal(vaultExists(), false);
  createVault(vaultFixture());
  assert.equal(vaultExists(), true);
});

test('createVault + getVaultRow round trip, id is the fixed singleton', () => {
  createVault(vaultFixture({
    fingerprint: 'FPR1', keyId: 'KEYID1',
    encryptedSecretKey: Buffer.from('ciphertext'), encryptionNonce: Buffer.from('nonce12'), encryptionTag: Buffer.from('tag123'),
  }));
  const row = getVaultRow();
  assert.equal(row.id, GPG_VAULT_ID);
  assert.equal(row.fingerprint, 'FPR1');
  assert.equal(row.name_real, 'ccserver');
  assert.equal(row.name_email, 'ccserver@example.com');
  assert.deepEqual(Buffer.from(row.encrypted_secret_key), Buffer.from('ciphertext'));
});

test('getVaultPublicInfo never includes secret material, includes name/email for git-identity injection', () => {
  createVault(vaultFixture({
    fingerprint: 'FPR2', keyId: 'KEYID2', nameReal: 'Alice Example', nameEmail: 'alice@example.com',
    sshPublicKey: 'ssh-ed25519 BBB',
  }));
  const info = getVaultPublicInfo();
  assert.equal(info.fingerprint, 'FPR2');
  assert.equal(info.sshPublicKey, 'ssh-ed25519 BBB');
  assert.equal(info.nameReal, 'Alice Example');
  assert.equal(info.nameEmail, 'alice@example.com');
  assert.equal('encryptedSecretKey' in info, false);
  assert.equal('encryptionNonce' in info, false);
});

test('getVaultPublicInfo/getVaultRow return null when no vault exists', () => {
  assert.equal(getVaultPublicInfo(), null);
  assert.equal(getVaultRow(), null);
});

test('addCredentialWrap + getCredentialWrap round trip, listUnlockableCredentialIds, countCredentialWraps', () => {
  createVault(vaultFixture({ fingerprint: 'FPR3', keyId: 'KEYID3', sshPublicKey: 'ssh-ed25519 CCC' }));
  insertCredential('credA');
  insertCredential('credB');
  assert.equal(countCredentialWraps(), 0);

  addCredentialWrap({ credentialId: 'credA', wrappedKey: Buffer.from('wA'), wrapNonce: Buffer.from('nA'), wrapTag: Buffer.from('tA'), prfSalt: SALT });
  addCredentialWrap({ credentialId: 'credB', wrappedKey: Buffer.from('wB'), wrapNonce: Buffer.from('nB'), wrapTag: Buffer.from('tB'), prfSalt: SALT });

  assert.equal(countCredentialWraps(), 2);
  const ids = listUnlockableCredentialIds().sort();
  assert.deepEqual(ids, ['credA', 'credB']);

  const wrap = getCredentialWrap('credA');
  assert.deepEqual(Buffer.from(wrap.wrapped_key), Buffer.from('wA'));
  assert.equal(wrap.vault_id, GPG_VAULT_ID);

  assert.equal(getCredentialWrap('nonexistent'), null);
});

// Security audit F2: the old INSERT OR REPLACE let add-credential overwrite
// a legitimate passkey's wrap with an attacker-chosen value.
test('addCredentialWrap never overwrites an existing wrap (throws, original kept)', () => {
  createVault(vaultFixture({ fingerprint: 'FPR4', keyId: 'KEYID4', sshPublicKey: 'ssh-ed25519 DDD' }));
  insertCredential('credC');
  addCredentialWrap({ credentialId: 'credC', wrappedKey: Buffer.from('v1'), wrapNonce: Buffer.from('n1'), wrapTag: Buffer.from('t1'), prfSalt: SALT });
  assert.throws(() => addCredentialWrap({ credentialId: 'credC', wrappedKey: Buffer.from('v2'), wrapNonce: Buffer.from('n2'), wrapTag: Buffer.from('t2'), prfSalt: SALT }));
  assert.equal(countCredentialWraps(), 1);
  assert.deepEqual(Buffer.from(getCredentialWrap('credC').wrapped_key), Buffer.from('v1'));
});

test('addCredentialWrap requires a PRF salt (audit F6: no unsalted post-fix wraps)', () => {
  createVault(vaultFixture({ fingerprint: 'FPR6', keyId: 'KEYID6', sshPublicKey: 'ssh-ed25519 FFF' }));
  insertCredential('credE');
  assert.throws(() => addCredentialWrap({ credentialId: 'credE', wrappedKey: Buffer.from('w'), wrapNonce: Buffer.from('n'), wrapTag: Buffer.from('t') }), /prfSalt/);
});

test('rotateCredentialWrap replaces only when the expected old tag still matches (optimistic lock)', () => {
  createVault(vaultFixture({ fingerprint: 'FPR7', keyId: 'KEYID7', sshPublicKey: 'ssh-ed25519 GGG' }));
  insertCredential('credR');
  addCredentialWrap({ credentialId: 'credR', wrappedKey: Buffer.from('w1'), wrapNonce: Buffer.from('n1'), wrapTag: Buffer.from('t1'), prfSalt: SALT });
  const salt2 = Buffer.alloc(32, 9);
  assert.equal(rotateCredentialWrap({ credentialId: 'credR', expectedOldTag: Buffer.from('stale'), wrappedKey: Buffer.from('wX'), wrapNonce: Buffer.from('nX'), wrapTag: Buffer.from('tX'), prfSalt: salt2 }), false);
  assert.deepEqual(Buffer.from(getCredentialWrap('credR').wrapped_key), Buffer.from('w1'));
  assert.equal(rotateCredentialWrap({ credentialId: 'credR', expectedOldTag: Buffer.from('t1'), wrappedKey: Buffer.from('w2'), wrapNonce: Buffer.from('n2'), wrapTag: Buffer.from('t2'), prfSalt: salt2 }), true);
  const row = getCredentialWrap('credR');
  assert.deepEqual(Buffer.from(row.wrapped_key), Buffer.from('w2'));
  assert.deepEqual(Buffer.from(row.prf_salt), salt2);
  assert.deepEqual(listUnlockableCredentials(), [{ credentialId: 'credR', prfSalt: salt2 }]);
});

test('isLegacyVault: false for no vault and for a post-fix vault; true for format_version 1 or an unsalted wrap', () => {
  assert.equal(isLegacyVault(), false);
  createVault(vaultFixture({ fingerprint: 'FPR8', keyId: 'KEYID8', sshPublicKey: 'ssh-ed25519 HHH' }));
  assert.equal(getVaultRow().format_version, VAULT_FORMAT_VERSION);
  insertCredential('credL');
  addCredentialWrap({ credentialId: 'credL', wrappedKey: Buffer.from('w'), wrapNonce: Buffer.from('n'), wrapTag: Buffer.from('t'), prfSalt: SALT });
  assert.equal(isLegacyVault(), false);

  getDb().prepare('UPDATE gpg_vault_credentials SET prf_salt = NULL').run();
  assert.equal(isLegacyVault(), true, 'an unsalted wrap marks the vault as pre-fix');

  getDb().prepare('UPDATE gpg_vault_credentials SET prf_salt = ?').run(SALT);
  getDb().prepare('UPDATE gpg_vault SET format_version = 1').run();
  assert.equal(isLegacyVault(), true, 'format_version 1 marks the vault as pre-fix');
});

test('deleteVault removes the vault and every wrap', () => {
  createVault(vaultFixture({ fingerprint: 'FPR9', keyId: 'KEYID9', sshPublicKey: 'ssh-ed25519 III' }));
  insertCredential('credZ');
  addCredentialWrap({ credentialId: 'credZ', wrappedKey: Buffer.from('w'), wrapNonce: Buffer.from('n'), wrapTag: Buffer.from('t'), prfSalt: SALT });
  deleteVault();
  assert.equal(vaultExists(), false);
  assert.equal(countCredentialWraps(), 0);
  assert.equal(isLegacyVault(), false);
});

test('deleting the underlying webauthn_credentials row cascades to gpg_vault_credentials', () => {
  createVault(vaultFixture({ fingerprint: 'FPR5', keyId: 'KEYID5', sshPublicKey: 'ssh-ed25519 EEE' }));
  insertCredential('credD');
  addCredentialWrap({ credentialId: 'credD', wrappedKey: Buffer.from('w'), wrapNonce: Buffer.from('n'), wrapTag: Buffer.from('t'), prfSalt: SALT });
  assert.equal(countCredentialWraps(), 1);
  getDb().prepare('DELETE FROM webauthn_credentials WHERE id = ?').run('credD');
  assert.equal(countCredentialWraps(), 0);
});
