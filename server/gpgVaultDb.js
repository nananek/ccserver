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
// Current on-disk vault format. 1 = pre-fix (security audit F1: created
// while the sandbox relay exposed the agent's main socket, so the secret key
// must be assumed leaked); 2 = post-fix (created with per-credential PRF
// salts, only ever exposed through the restricted relay).
export const VAULT_FORMAT_VERSION = 2;

export function createVault({ fingerprint, keyId, nameReal, nameEmail, publicKeyArmored, sshPublicKey, encryptedSecretKey, encryptionNonce, encryptionTag }) {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO gpg_vault
      (id, fingerprint, key_id, name_real, name_email, public_key_armored, ssh_public_key, encrypted_secret_key, encryption_nonce, encryption_tag, created_at, format_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(GPG_VAULT_ID, fingerprint, keyId, nameReal, nameEmail, publicKeyArmored, sshPublicKey, encryptedSecretKey, encryptionNonce, encryptionTag, now, VAULT_FORMAT_VERSION);
  return now;
}

// Security audit F1.4: a vault created before the fix is treated as leaked
// and permanently disabled -- it can be inspected (public info) and deleted,
// never unlocked or extended again. Detected by the explicit format_version
// (db.js v9 marks every pre-existing row as 1) and, as a consistency check,
// by any wrap lacking a PRF salt (every post-fix wrap is created with one).
export function isLegacyVault() {
  const row = getDb().prepare(`
    SELECT format_version,
           EXISTS (SELECT 1 FROM gpg_vault_credentials WHERE vault_id = gpg_vault.id AND prf_salt IS NULL) AS unsalted
    FROM gpg_vault WHERE id = ?
  `).get(GPG_VAULT_ID);
  if (!row) return false;
  return row.format_version < VAULT_FORMAT_VERSION || row.unsalted === 1;
}

// Removes the vault and every wrap of it, atomically. The only way out of a
// legacy (disabled) vault, and the prerequisite for re-running setup.
export function deleteVault() {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM gpg_vault_credentials WHERE vault_id = ?').run(GPG_VAULT_ID);
    db.prepare('DELETE FROM gpg_vault WHERE id = ?').run(GPG_VAULT_ID);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already unwound */ }
    throw err;
  }
}

export function getCredentialWrap(credentialId) {
  return getDb().prepare(
    'SELECT credential_id, vault_id, wrapped_key, wrap_nonce, wrap_tag, prf_salt, created_at FROM gpg_vault_credentials WHERE credential_id = ?'
  ).get(credentialId) || null;
}

export function listUnlockableCredentialIds() {
  return getDb().prepare('SELECT credential_id FROM gpg_vault_credentials').all().map((r) => r.credential_id);
}

// [{ credentialId, prfSalt: Buffer|null }] -- what a PRF ceremony needs to
// build per-credential evalByCredential salts.
export function listUnlockableCredentials() {
  return getDb().prepare('SELECT credential_id, prf_salt FROM gpg_vault_credentials').all()
    .map((r) => ({ credentialId: r.credential_id, prfSalt: r.prf_salt ? Buffer.from(r.prf_salt) : null }));
}

export function countCredentialWraps() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM gpg_vault_credentials').get().c;
}

// Plain INSERT (security audit F2): adding a wrap for a credential that
// already has one throws instead of silently replacing it. The old INSERT OR
// REPLACE let anyone who could reach add-credential overwrite a legitimate
// passkey's wrap with a value of their choosing, locking the owner out.
// Replacing a wrap is only ever done by rotateCredentialWrap() below.
export function addCredentialWrap({ credentialId, wrappedKey, wrapNonce, wrapTag, prfSalt }) {
  if (!prfSalt) throw new Error('addCredentialWrap: prfSalt is required');
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO gpg_vault_credentials
      (credential_id, vault_id, wrapped_key, wrap_nonce, wrap_tag, prf_salt, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(credentialId, GPG_VAULT_ID, wrappedKey, wrapNonce, wrapTag, prfSalt, now);
  return now;
}

// Salt rotation (security audit F6): replaces a credential's wrap with one
// under a new PRF salt, but only if the wrap is still the one the caller just
// decrypted (optimistic lock on wrap_tag -- a concurrent rotation wins, this
// one becomes a no-op). Returns true iff the row was replaced.
//
// Dormant: rotation is disabled by policy (vuln_scan M4, see rotationFor in
// routes/gpgVault.js), so no current caller passes a rotation. Kept as the
// DB half of the rotation mechanism for a future verifiable design.
export function rotateCredentialWrap({ credentialId, expectedOldTag, wrappedKey, wrapNonce, wrapTag, prfSalt }) {
  if (!prfSalt) throw new Error('rotateCredentialWrap: prfSalt is required');
  const result = getDb().prepare(`
    UPDATE gpg_vault_credentials
       SET wrapped_key = ?, wrap_nonce = ?, wrap_tag = ?, prf_salt = ?
     WHERE credential_id = ? AND wrap_tag = ?
  `).run(wrappedKey, wrapNonce, wrapTag, prfSalt, credentialId, expectedOldTag);
  return result.changes === 1;
}
