// CCSERVER_AUTH_MODE=passkey session verification (Issue #141 Step1). Reads
// the httpOnly session cookie off an incoming request and checks it against
// auth_sessions (db.js v7 migration), applying sliding expiration.
//
// Session *creation* (the login-token/WebAuthn endpoints that actually INSERT
// into auth_sessions) is Step2/Step3 scope -- this module only implements the
// read/verify/extend side that server/index.js's onRequest hook needs now.
//
// No @fastify/cookie dependency: we only ever need to read one cookie value
// here, so a minimal manual parse avoids pulling in a plugin before Step2
// actually needs reply.setCookie().

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
