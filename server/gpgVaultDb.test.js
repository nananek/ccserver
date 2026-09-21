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
} from './gpgVaultDb.js';

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

  addCredentialWrap({ credentialId: 'credA', wrappedKey: Buffer.from('wA'), wrapNonce: Buffer.from('nA'), wrapTag: Buffer.from('tA') });
  addCredentialWrap({ credentialId: 'credB', wrappedKey: Buffer.from('wB'), wrapNonce: Buffer.from('nB'), wrapTag: Buffer.from('tB') });

  assert.equal(countCredentialWraps(), 2);
  const ids = listUnlockableCredentialIds().sort();
  assert.deepEqual(ids, ['credA', 'credB']);

  const wrap = getCredentialWrap('credA');
  assert.deepEqual(Buffer.from(wrap.wrapped_key), Buffer.from('wA'));
  assert.equal(wrap.vault_id, GPG_VAULT_ID);

  assert.equal(getCredentialWrap('nonexistent'), null);
});

test('addCredentialWrap is idempotent (re-adding the same credential replaces, not errors)', () => {
  createVault(vaultFixture({ fingerprint: 'FPR4', keyId: 'KEYID4', sshPublicKey: 'ssh-ed25519 DDD' }));
  insertCredential('credC');
  addCredentialWrap({ credentialId: 'credC', wrappedKey: Buffer.from('v1'), wrapNonce: Buffer.from('n1'), wrapTag: Buffer.from('t1') });
  addCredentialWrap({ credentialId: 'credC', wrappedKey: Buffer.from('v2'), wrapNonce: Buffer.from('n2'), wrapTag: Buffer.from('t2') });
  assert.equal(countCredentialWraps(), 1);
  assert.deepEqual(Buffer.from(getCredentialWrap('credC').wrapped_key), Buffer.from('v2'));
});

test('deleting the underlying webauthn_credentials row cascades to gpg_vault_credentials', () => {
  createVault(vaultFixture({ fingerprint: 'FPR5', keyId: 'KEYID5', sshPublicKey: 'ssh-ed25519 EEE' }));
  insertCredential('credD');
  addCredentialWrap({ credentialId: 'credD', wrappedKey: Buffer.from('w'), wrapNonce: Buffer.from('n'), wrapTag: Buffer.from('t') });
  assert.equal(countCredentialWraps(), 1);
  getDb().prepare('DELETE FROM webauthn_credentials WHERE id = ?').run('credD');
  assert.equal(countCredentialWraps(), 0);
});
