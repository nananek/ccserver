import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAuthMode } from './authMode.js';

test('resolveAuthMode: defaults to none when nothing is set', () => {
  assert.equal(resolveAuthMode({}), 'none');
});

test('resolveAuthMode: defaults to token when only CCSERVER_TOKEN is set', () => {
  assert.equal(resolveAuthMode({ CCSERVER_TOKEN: 'secret' }), 'token');
});

test('resolveAuthMode: an explicit CCSERVER_AUTH_MODE always wins', () => {
  assert.equal(resolveAuthMode({ CCSERVER_AUTH_MODE: 'none', CCSERVER_TOKEN: 'secret' }), 'none');
  assert.equal(resolveAuthMode({ CCSERVER_AUTH_MODE: 'passkey', CCSERVER_TOKEN: 'secret' }), 'passkey');
  assert.equal(resolveAuthMode({ CCSERVER_AUTH_MODE: 'token' }), 'token');
});
