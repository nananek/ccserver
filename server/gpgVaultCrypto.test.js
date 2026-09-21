import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  GPG_VAULT_PRF_SALT,
  deriveWrappingKey,
  generateVaultKey,
  aesGcmEncrypt,
  aesGcmDecrypt,
} from './gpgVaultCrypto.js';

test('GPG_VAULT_PRF_SALT is exactly 32 bytes', () => {
  assert.equal(GPG_VAULT_PRF_SALT.length, 32);
});

test('deriveWrappingKey is deterministic for the same secret+credentialId', () => {
  const prfSecret = randomBytes(32);
  const k1 = deriveWrappingKey(prfSecret, 'cred-a');
  const k2 = deriveWrappingKey(prfSecret, 'cred-a');
  assert.equal(k1.length, 32);
  assert.deepEqual(k1, k2);
});

test('deriveWrappingKey differs across credential ids for the same secret', () => {
  const prfSecret = randomBytes(32);
  const k1 = deriveWrappingKey(prfSecret, 'cred-a');
  const k2 = deriveWrappingKey(prfSecret, 'cred-b');
  assert.notDeepEqual(k1, k2);
});

test('deriveWrappingKey differs across PRF secrets for the same credential id', () => {
  const k1 = deriveWrappingKey(randomBytes(32), 'cred-a');
  const k2 = deriveWrappingKey(randomBytes(32), 'cred-a');
  assert.notDeepEqual(k1, k2);
});

test('generateVaultKey returns 32 random bytes, different each call', () => {
  const a = generateVaultKey();
  const b = generateVaultKey();
  assert.equal(a.length, 32);
  assert.equal(b.length, 32);
  assert.notDeepEqual(a, b);
});

test('aesGcmEncrypt/aesGcmDecrypt round trip with and without AAD', () => {
  const key = randomBytes(32);
  const plaintext = Buffer.from('super secret gpg key bytes');
  const { ciphertext, iv, tag } = aesGcmEncrypt(key, plaintext, 'aad-context');
  const decrypted = aesGcmDecrypt(key, ciphertext, iv, tag, 'aad-context');
  assert.deepEqual(decrypted, plaintext);

  const { ciphertext: c2, iv: iv2, tag: tag2 } = aesGcmEncrypt(key, plaintext);
  const d2 = aesGcmDecrypt(key, c2, iv2, tag2);
  assert.deepEqual(d2, plaintext);
});

test('aesGcmDecrypt throws on wrong key', () => {
  const key = randomBytes(32);
  const wrongKey = randomBytes(32);
  const { ciphertext, iv, tag } = aesGcmEncrypt(key, Buffer.from('data'), 'x');
  assert.throws(() => aesGcmDecrypt(wrongKey, ciphertext, iv, tag, 'x'));
});

test('aesGcmDecrypt throws on tampered ciphertext', () => {
  const key = randomBytes(32);
  const { ciphertext, iv, tag } = aesGcmEncrypt(key, Buffer.from('data'), 'x');
  const tampered = Buffer.from(ciphertext);
  tampered[0] ^= 0xff;
  assert.throws(() => aesGcmDecrypt(key, tampered, iv, tag, 'x'));
});

test('aesGcmDecrypt throws on tampered tag', () => {
  const key = randomBytes(32);
  const { ciphertext, iv, tag } = aesGcmEncrypt(key, Buffer.from('data'), 'x');
  const tamperedTag = Buffer.from(tag);
  tamperedTag[0] ^= 0xff;
  assert.throws(() => aesGcmDecrypt(key, ciphertext, iv, tamperedTag, 'x'));
});

test('aesGcmDecrypt throws on mismatched AAD', () => {
  const key = randomBytes(32);
  const { ciphertext, iv, tag } = aesGcmEncrypt(key, Buffer.from('data'), 'right-aad');
  assert.throws(() => aesGcmDecrypt(key, ciphertext, iv, tag, 'wrong-aad'));
});

test('VK wrap/unwrap round trip via a credential-derived wrapping key', () => {
  const prfSecret = randomBytes(32);
  const credentialId = 'cred-xyz';
  const wrappingKey = deriveWrappingKey(prfSecret, credentialId);
  const vk = generateVaultKey();

  const wrapped = aesGcmEncrypt(wrappingKey, vk, credentialId);
  const unwrapped = aesGcmDecrypt(wrappingKey, wrapped.ciphertext, wrapped.iv, wrapped.tag, credentialId);
  assert.deepEqual(unwrapped, vk);

  // A different credential's wrapping key must not unwrap it.
  const otherWrappingKey = deriveWrappingKey(prfSecret, 'cred-other');
  assert.throws(() => aesGcmDecrypt(otherWrappingKey, wrapped.ciphertext, wrapped.iv, wrapped.tag, credentialId));
});
