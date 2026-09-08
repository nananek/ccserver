import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, closeDb } from './db.js';
import {
  verifySessionCookie,
  createSession,
  sessionCookieHeader,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from './authSessions.js';

let tmpRoot;
const savedEnv = process.env.CCSERVER_DB_PATH;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-authsessions-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
});

after(() => {
  closeDb();
  if (savedEnv === undefined) delete process.env.CCSERVER_DB_PATH;
  else process.env.CCSERVER_DB_PATH = savedEnv;
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  closeDb();
  getDb().exec('DELETE FROM auth_sessions');
});

function requestWithCookie(cookieHeader) {
  return { headers: { cookie: cookieHeader } };
}

test('verifySessionCookie: false when there is no cookie header at all', () => {
  assert.equal(verifySessionCookie({ headers: {} }), false);
});

test('verifySessionCookie: false when the cookie names a session that does not exist', () => {
  assert.equal(verifySessionCookie(requestWithCookie(`${SESSION_COOKIE_NAME}=unknown`)), false);
});

test('verifySessionCookie: true for a live session, parsed out of a multi-cookie header', () => {
  const db = getDb();
  const now = Date.now();
  db.prepare('INSERT INTO auth_sessions (id, created_at, expires_at, last_seen_at) VALUES (?,?,?,NULL)')
    .run('s1', now, now + SESSION_TTL_MS);
  assert.equal(
    verifySessionCookie(requestWithCookie(`other=1; ${SESSION_COOKIE_NAME}=s1; another=2`)),
    true,
  );
});

test('verifySessionCookie: false for an expired session', () => {
  const db = getDb();
  const now = Date.now();
  db.prepare('INSERT INTO auth_sessions (id, created_at, expires_at, last_seen_at) VALUES (?,?,?,NULL)')
    .run('expired', now - 1000, now - 1);
  assert.equal(verifySessionCookie(requestWithCookie(`${SESSION_COOKIE_NAME}=expired`)), false);
});

test('verifySessionCookie: sliding expiration extends expires_at when last_seen_at is stale (or NULL)', () => {
  const db = getDb();
  const now = Date.now();
  db.prepare('INSERT INTO auth_sessions (id, created_at, expires_at, last_seen_at) VALUES (?,?,?,NULL)')
    .run('s2', now, now + 1000);
  assert.equal(verifySessionCookie(requestWithCookie(`${SESSION_COOKIE_NAME}=s2`)), true);
  const row = db.prepare('SELECT expires_at, last_seen_at FROM auth_sessions WHERE id = ?').get('s2');
  assert.ok(row.expires_at >= now + SESSION_TTL_MS, 'expires_at was pushed out to ~now+30d');
  assert.ok(row.last_seen_at !== null, 'last_seen_at was stamped');
});

test('verifySessionCookie: throttles the extending UPDATE when last_seen_at is recent', () => {
  const db = getDb();
  const now = Date.now();
  const recentSeen = now - Math.floor(SESSION_TOUCH_INTERVAL_MS / 2);
  const originalExpiry = now + 1000;
  db.prepare('INSERT INTO auth_sessions (id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?)')
    .run('s3', now, originalExpiry, recentSeen);
  assert.equal(verifySessionCookie(requestWithCookie(`${SESSION_COOKIE_NAME}=s3`)), true);
  const row = db.prepare('SELECT expires_at, last_seen_at FROM auth_sessions WHERE id = ?').get('s3');
  assert.equal(row.expires_at, originalExpiry, 'still within the throttle window -- no extending write');
  assert.equal(row.last_seen_at, recentSeen);
});

test('createSession: inserts a row that verifySessionCookie then accepts', () => {
  const id = createSession();
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0);
  assert.equal(verifySessionCookie(requestWithCookie(`${SESSION_COOKIE_NAME}=${id}`)), true);
});

test('createSession: two calls never produce the same id', () => {
  const a = createSession();
  const b = createSession();
  assert.notEqual(a, b);
});

test('sessionCookieHeader: includes HttpOnly/SameSite=Lax/Max-Age but not Secure by default', () => {
  const header = sessionCookieHeader('abc');
  assert.match(header, new RegExp(`^${SESSION_COOKIE_NAME}=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=\\d+$`));
  assert.ok(!header.includes('Secure'));
  const maxAge = Number(header.match(/Max-Age=(\d+)/)[1]);
  assert.equal(maxAge, Math.floor(SESSION_TTL_MS / 1000));
});

test('sessionCookieHeader: adds Secure when asked', () => {
  const header = sessionCookieHeader('abc', { secure: true });
  assert.ok(header.includes('; Secure'));
});
