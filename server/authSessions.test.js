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
  STEPUP_WINDOW_MS,
  getRequestSession,
  hasFreshStepUp,
  markStepUp,
  consumeRegistrationGrant,
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

// Security audit F2: per-session auth metadata.
function reqFor(id) {
  return { headers: { cookie: `${SESSION_COOKIE_NAME}=${id}` } };
}

test('createSession records auth_method; neither a passkey login nor a token login starts with a step-up', () => {
  const passkey = getRequestSession(reqFor(createSession({ authMethod: 'passkey', credentialId: 'c1' })));
  assert.equal(passkey.auth_method, 'passkey');
  assert.equal(passkey.credential_id, 'c1');
  assert.equal(hasFreshStepUp(passkey), false);

  const token = getRequestSession(reqFor(createSession({ authMethod: 'login-token' })));
  assert.equal(token.auth_method, 'login-token');
  assert.equal(hasFreshStepUp(token), false);
  assert.equal(token.registration_grant, 0);
});

test('hasFreshStepUp honours the window; markStepUp refreshes it', () => {
  const id = createSession({ authMethod: 'login-token' });
  getDb().prepare('UPDATE auth_sessions SET stepup_at = ? WHERE id = ?').run(Date.now() - STEPUP_WINDOW_MS - 1, id);
  assert.equal(hasFreshStepUp(getRequestSession(reqFor(id))), false);
  markStepUp(id, 'c9');
  const row = getRequestSession(reqFor(id));
  assert.equal(hasFreshStepUp(row), true);
  assert.equal(row.credential_id, 'c9');
});

test('consumeRegistrationGrant is single-use', () => {
  const id = createSession({ authMethod: 'login-token', registrationGrant: true });
  assert.equal(getRequestSession(reqFor(id)).registration_grant, 1);
  assert.equal(consumeRegistrationGrant(id), true);
  assert.equal(consumeRegistrationGrant(id), false);
  assert.equal(consumeRegistrationGrant(createSession()), false, 'no grant, nothing to consume');
});

test('getRequestSession: null for no cookie, an unknown id, or an expired session', () => {
  assert.equal(getRequestSession({ headers: {} }), null);
  assert.equal(getRequestSession(reqFor('nope')), null);
  const id = createSession();
  getDb().prepare('UPDATE auth_sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1, id);
  assert.equal(getRequestSession(reqFor(id)), null);
});
