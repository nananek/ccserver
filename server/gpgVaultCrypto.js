// Pure crypto helpers for the GPG vault (plan: gpg-agent vault). No DB/fs/
// process dependencies here on purpose -- everything in this file is a plain
// function of its inputs, so it's trivially unit-testable in isolation from
// SQLite, WebAuthn, or gpg-agent itself.
//
// Key hierarchy (see server/ws/gpgVaultAgent.js for how these are used):
//
//   GPG_VAULT_PRF_SALT (fixed constant below)
//     --[live WebAuthn PRF ceremony against credential C]--> prfSecret (32B)
//     --[HKDF-SHA256(ikm=prfSecret, salt=empty, info=...credentialId)]--> wrappingKey_C
//     --[AES-256-GCM(wrappingKey_C)]--> wraps/unwraps VK (32B random, made once)
//   VK --[AES-256-GCM(VK)]--> encrypts/decrypts the `gpg --export-secret-keys` blob
//
// Two different "salt" concepts appear here and must not be confused:
// GPG_VAULT_PRF_SALT is an input to the *authenticator* (WebAuthn's PRF
// `eval.first`) that scopes its PRF output; HKDF's own `salt` parameter below
// is deliberately left empty since the PRF output is already a uniformly
// distributed 32-byte value (RFC 5869) -- context separation instead comes
// from HKDF's `info` parameter, bound to the credential id.

import { randomBytes, hkdfSync, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

// sha256("ccserver-gpg-vault-prf-salt-v1"). Fixed, public (it is sent to the
// browser on every step-up ceremony), single-purpose -- never reused as an
// HKDF salt or for anything else.
export const GPG_VAULT_PRF_SALT = createHash('sha256')
  .update('ccserver-gpg-vault-prf-salt-v1')
  .digest();

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
