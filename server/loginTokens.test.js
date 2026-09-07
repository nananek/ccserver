import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateLoginToken, hashLoginToken, LOGIN_TOKEN_TTL_MS } from './loginTokens.js';

test('generateLoginToken: tokenHash is the sha256 hex digest of token', () => {
  const { token, tokenHash } = generateLoginToken();
  assert.equal(typeof token, 'string');
  assert.ok(token.length > 0);
  assert.equal(tokenHash, createHash('sha256').update(token).digest('hex'));
});

test('generateLoginToken: two calls never produce the same token', () => {
  const a = generateLoginToken();
  const b = generateLoginToken();
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.tokenHash, b.tokenHash);
});

test('hashLoginToken: matches generateLoginToken for the same input', () => {
  const { token, tokenHash } = generateLoginToken();
  assert.equal(hashLoginToken(token), tokenHash);
});

test('LOGIN_TOKEN_TTL_MS: is 15 minutes', () => {
  assert.equal(LOGIN_TOKEN_TTL_MS, 15 * 60 * 1000);
});
