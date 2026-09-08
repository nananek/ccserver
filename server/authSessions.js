// CCSERVER_AUTH_MODE=passkey session management (Issue #141). Step1 added the
// read/verify/extend side (verifySessionCookie) that server/index.js's
// onRequest hook needs; Step2 (server/routes/auth.js's login-token endpoint)
// adds the creation side (createSession/sessionCookieHeader) below.
//
// No @fastify/cookie dependency: creating a session only needs one
// Set-Cookie header on one response, and verifying only needs to read one
// cookie value back out later, so a minimal manual implementation of both
// avoids pulling in a plugin for what's a handful of lines.

import { randomBytes } from 'node:crypto';
import { getDb } from './db.js';

export const SESSION_COOKIE_NAME = 'ccserver_session';

// Sliding expiration (plan decision 2): 30 days, refreshed on use.
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Throttle for the expires_at-extending UPDATE: only re-extend once per hour
// of use rather than on every single authenticated request.
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

function parseCookieHeader(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      cookies[name] = part.slice(eq + 1).trim();
    }
  }
  return cookies;
}

// Looks up sessionId in auth_sessions; if valid (exists, not expired),
// throttled-extends expires_at and returns true. Returns false for a
// missing/unknown/expired session -- callers 401 on false.
function touchSession(sessionId) {
  const db = getDb();
  const now = Date.now();
  const row = db.prepare('SELECT expires_at, last_seen_at FROM auth_sessions WHERE id = ?').get(sessionId);
  if (!row || row.expires_at <= now) return false;
  if (!row.last_seen_at || now - row.last_seen_at >= SESSION_TOUCH_INTERVAL_MS) {
    db.prepare('UPDATE auth_sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?')
      .run(now + SESSION_TTL_MS, now, sessionId);
  }
  return true;
}

// Verifies the session cookie on a Fastify request. Returns true/false; never
// throws for a missing/malformed cookie (that's just "not authenticated").
export function verifySessionCookie(request) {
  const cookies = parseCookieHeader(request.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) return false;
  return touchSession(sessionId);
}

// Creates a new row in auth_sessions and returns its id -- the value that
// goes into the session cookie. 32 bytes of CSPRNG output, base64url-encoded,
// same reasoning as loginTokens.js's generateLoginToken(): this id alone
// grants access, so randomUUID()'s 128 bits (some fixed) would be weaker.
export function createSession() {
  const db = getDb();
  const id = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare(
    'INSERT INTO auth_sessions (id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, NULL)'
  ).run(id, now, now + SESSION_TTL_MS);
  return id;
}

// Serializes a Set-Cookie header value for a session id. `secure` should
// reflect whether the request that will carry this response arrived over
// HTTPS (request.protocol === 'https') -- WebAuthn's own rpID constraint
// (see plan) means passkey-mode deployments are expected to be HTTPS
// (Tailscale Serve) or localhost, but localhost dev/testing over plain HTTP
// must still be able to log in, so this only asserts Secure when the
// connection is actually encrypted rather than hardcoding it.
export function sessionCookieHeader(sessionId, { secure = false } = {}) {
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  const attrs = [
    `${SESSION_COOKIE_NAME}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
