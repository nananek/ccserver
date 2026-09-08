// POST /api/auth/login-token (Issue #141 Step2): exchanging a CLI-issued
// one-time token for a session cookie.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb, closeDb } from '../db.js';
import { generateLoginToken, hashLoginToken } from '../loginTokens.js';
import { SESSION_COOKIE_NAME } from '../authSessions.js';
import { authRoute } from './auth.js';

let tmpRoot;
let app;
const savedDbPath = process.env.CCSERVER_DB_PATH;
const savedAuthMode = process.env.CCSERVER_AUTH_MODE;

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-auth-route-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  app = Fastify();
  await app.register(authRoute, { prefix: '/api' });
});

after(async () => {
  await app.close();
  closeDb();
  if (savedDbPath === undefined) delete process.env.CCSERVER_DB_PATH; else process.env.CCSERVER_DB_PATH = savedDbPath;
  if (savedAuthMode === undefined) delete process.env.CCSERVER_AUTH_MODE; else process.env.CCSERVER_AUTH_MODE = savedAuthMode;
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  closeDb();
  const db = getDb();
  db.exec('DELETE FROM login_tokens');
  db.exec('DELETE FROM auth_sessions');
  process.env.CCSERVER_AUTH_MODE = 'passkey';
});

function insertToken({ expiresInMs = 15 * 60 * 1000, usedAt = null } = {}) {
  const db = getDb();
  const { token, tokenHash } = generateLoginToken();
  const now = Date.now();
  db.prepare(
    'INSERT INTO login_tokens (id, token_hash, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?)'
  ).run(randomUUID(), tokenHash, now, now + expiresInMs, usedAt);
  return token;
}

test('POST /api/auth/login-token: 400 when CCSERVER_AUTH_MODE is not passkey', async () => {
  process.env.CCSERVER_AUTH_MODE = 'token';
  const token = insertToken();
  const res = await app.inject({ method: 'POST', url: '/api/auth/login-token', payload: { token } });
  assert.equal(res.statusCode, 400);
});

test('POST /api/auth/login-token: 400 when token is missing from the body', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login-token', payload: {} });
  assert.equal(res.statusCode, 400);
});

test('POST /api/auth/login-token: 401 for a token that does not exist', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login-token', payload: { token: 'nope' } });
  assert.equal(res.statusCode, 401);
});

test('POST /api/auth/login-token: 401 for an expired token', async () => {
  const token = insertToken({ expiresInMs: -1000 });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login-token', payload: { token } });
  assert.equal(res.statusCode, 401);
});

test('POST /api/auth/login-token: 401 for an already-used token', async () => {
  const token = insertToken({ usedAt: Date.now() - 1000 });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login-token', payload: { token } });
  assert.equal(res.statusCode, 401);
});

test('POST /api/auth/login-token: valid token sets a session cookie and marks the token used', async () => {
  const token = insertToken();
  const res = await app.inject({ method: 'POST', url: '/api/auth/login-token', payload: { token } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { success: true });

  const setCookie = res.headers['set-cookie'];
  assert.ok(setCookie, 'Set-Cookie header is present');
  assert.match(setCookie, new RegExp(`^${SESSION_COOKIE_NAME}=`));
  assert.ok(setCookie.includes('HttpOnly'));
  assert.ok(!setCookie.includes('Secure'), 'plain-HTTP inject() request should not get Secure');

  const db = getDb();
  const row = db.prepare('SELECT expires_at, last_seen_at FROM auth_sessions').get();
  assert.ok(row, 'a session row was created');

  const sessionId = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))[1];
  const tokenRow = db.prepare('SELECT used_at FROM login_tokens WHERE token_hash = ?')
    .get(hashLoginToken(token));
  assert.ok(tokenRow.used_at, 'token is marked used');
  assert.ok(sessionId.length > 0);
});

test('POST /api/auth/login-token: a token can only be redeemed once', async () => {
  const token = insertToken();
  const first = await app.inject({ method: 'POST', url: '/api/auth/login-token', payload: { token } });
  assert.equal(first.statusCode, 200);
  const second = await app.inject({ method: 'POST', url: '/api/auth/login-token', payload: { token } });
  assert.equal(second.statusCode, 401);
});
