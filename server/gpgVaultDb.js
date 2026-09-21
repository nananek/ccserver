// DB access for the GPG vault (plan: gpg-agent-vault). Thin wrapper style,
// same as authSessions.js -- no crypto/process logic here, just CRUD against
// the gpg_vault / gpg_vault_credentials tables (see db.js v8).

import { getDb } from './db.js';

// Fixed singleton id, same convention as webauthnChallenges.js's
// WEBAUTHN_USER_ID/WEBAUTHN_USER_NAME -- there is only ever one vault.
export const GPG_VAULT_ID = 'default';

export function vaultExists() {
  return !!getDb().prepare('SELECT 1 FROM gpg_vault WHERE id = ?').get(GPG_VAULT_ID);
}

// Full row including encrypted_secret_key -- internal use only (gpgVaultAgent.js
// during unlock). Never returned from a route handler as-is.
export function getVaultRow() {
  return getDb().prepare('SELECT * FROM gpg_vault WHERE id = ?').get(GPG_VAULT_ID) || null;
}

// Public artifacts only -- safe to return from a route with no unlock check
// (see routes/gpgVault.js's github-info handler). nameReal/nameEmail are
// included here (not just fingerprint/keys) because sandbox.js's git-identity
// injection (user.name/user.email alongside user.signingkey) needs them too,
// and they are exactly as public as the rest of this row -- see db.js v8's
// comment on why the same values back both the GPG UID and git's identity.
export function getVaultPublicInfo() {
  const row = getDb().prepare(
    'SELECT fingerprint, key_id, name_real, name_email, public_key_armored, ssh_public_key, created_at FROM gpg_vault WHERE id = ?'
  ).get(GPG_VAULT_ID);
  if (!row) return null;
  return {
    fingerprint: row.fingerprint,
    keyId: row.key_id,
    nameReal: row.name_real,
    nameEmail: row.name_email,
    publicKeyArmored: row.public_key_armored,
    sshPublicKey: row.ssh_public_key,
    createdAt: row.created_at,
  };
}

// Inserts the singleton vault row. Throws (UNIQUE/PK violation) if a vault
// already exists -- callers (gpgVaultAgent.generateAndStoreVault) must check
// vaultExists() first and treat a throw here as a genuine bug, not a
// expected-and-handled race (vault setup is itself gated behind a PRF
// step-up ceremony a single browser tab drives, so no concurrent-setup race
// is expected in practice).
export function createVault({ fingerprint, keyId, nameReal, nameEmail, publicKeyArmored, sshPublicKey, encryptedSecretKey, encryptionNonce, encryptionTag }) {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO gpg_vault
      (id, fingerprint, key_id, name_real, name_email, public_key_armored, ssh_public_key, encrypted_secret_key, encryption_nonce, encryption_tag, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(GPG_VAULT_ID, fingerprint, keyId, nameReal, nameEmail, publicKeyArmored, sshPublicKey, encryptedSecretKey, encryptionNonce, encryptionTag, now);
  return now;
}

export function getCredentialWrap(credentialId) {
  return getDb().prepare(
    'SELECT credential_id, vault_id, wrapped_key, wrap_nonce, wrap_tag, created_at FROM gpg_vault_credentials WHERE credential_id = ?'
  ).get(credentialId) || null;
}

export function listUnlockableCredentialIds() {
  return getDb().prepare('SELECT credential_id FROM gpg_vault_credentials').all().map((r) => r.credential_id);
}

export function countCredentialWraps() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM gpg_vault_credentials').get().c;
}

// Idempotent on a PK collision (re-adding the same credential is treated as
// success, not an error) -- INSERT OR REPLACE lets a credential's wrap be
// re-derived (e.g. after a vault key rotation, not yet built) without a
// separate update path.
export function addCredentialWrap({ credentialId, wrappedKey, wrapNonce, wrapTag }) {
  const now = Date.now();
  getDb().prepare(`
    INSERT OR REPLACE INTO gpg_vault_credentials
      (credential_id, vault_id, wrapped_key, wrap_nonce, wrap_tag, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(credentialId, GPG_VAULT_ID, wrappedKey, wrapNonce, wrapTag, now);
  return now;
}
