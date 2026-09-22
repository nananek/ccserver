// Pure crypto helpers for the GPG vault (plan: gpg-agent vault). No DB/fs/
// process dependencies here on purpose -- everything in this file is a plain
// function of its inputs, so it's trivially unit-testable in isolation from
// SQLite, WebAuthn, or gpg-agent itself.
//
// Key hierarchy (see server/ws/gpgVaultAgent.js for how these are used):
//
//   prf_salt_C (32B random per credential; NOT rotated per unlock --
//     rotation is disabled, see rotationFor in routes/gpgVault.js / M4)
//     --[live WebAuthn PRF ceremony against credential C]--> prfSecret (32B)
//     --[HKDF-SHA256(ikm=prfSecret, salt=empty, info=...credentialId)]--> wrappingKey_C
//     --[AES-256-GCM(wrappingKey_C)]--> wraps/unwraps VK (32B random, made once)
//   VK --[AES-256-GCM(VK)]--> encrypts/decrypts the `gpg --export-secret-keys` blob
//
// Two different "salt" concepts appear here and must not be confused: the
// per-credential PRF salt is an input to the *authenticator* (WebAuthn's PRF
// `eval.first`) that scopes its PRF output; HKDF's own `salt` parameter below
// is deliberately left empty since the PRF output is already a uniformly
// distributed 32-byte value (RFC 5869) -- context separation instead comes
// from HKDF's `info` parameter, bound to the credential id.

import { randomBytes, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';

// Fresh random PRF salt (security audit F6). Replaces the old fixed, public
// constant sha256("ccserver-gpg-vault-prf-salt-v1"): with one fixed salt the
// PRF output of a credential never changed, so one leaked output (XSS + a
// single tap) was a permanent unlock key. Each credential's wrap now has its
// own salt, so one credential's leaked output never decrypts another
// credential's wrap. The F6 rotation half -- re-wrapping under a NEW salt on
// every unlock so a captured output expires -- was later disabled
// (vuln_scan M4, see rotationFor in routes/gpgVault.js), so a captured
// output no longer expires automatically. Wraps with no salt (the old
// constant) only exist in pre-fix vaults, which are disabled outright
// (gpgVaultDb.isLegacyVault()).
export function generatePrfSalt() {
  return randomBytes(32);
}

// Derives this credential's wrapping key from its live PRF output. Same
// prfSecret + credentialId always yields the same wrappingKey (HKDF is
// deterministic) -- that determinism is exactly what lets a later ceremony
// against the same credential unwrap the same VK again.
export function deriveWrappingKey(prfSecret, credentialId) {
  return Buffer.from(hkdfSync(
    'sha256',
    prfSecret,
    Buffer.alloc(0),
    Buffer.from(`ccserver-gpg-vault-wrap-key-v1:${credentialId}`, 'utf8'),
    32,
  ));
}

export function generateVaultKey() {
  return randomBytes(32);
}

// AES-256-GCM encrypt/decrypt with a random 12-byte IV and an optional AAD
// string (bound into the auth tag, not encrypted). Decrypt throws on any
// tag/key/AAD mismatch -- callers treat that as "wrong key", never as a
// distinct error path (a wrong PRF value, a tampered DB row, and a bug all
// look identical from here, which is the point: fail closed).
export function aesGcmEncrypt(key, plaintext, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function aesGcmDecrypt(key, ciphertext, iv, tag, aad) {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
