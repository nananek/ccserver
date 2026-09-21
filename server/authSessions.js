// CCSERVER_AUTH_MODE=passkey session management (Issue #141). Step1 added the
// read/verify/extend side (verifySessionCookie) that server/index.js's
// onRequest hook needs; Step2 (server/routes/auth.js's login-token endpoint)
// adds the creation side (createSession/sessionCookieHeader) below.
//
// No @fastify/cookie dependency: creating a session only needs one
// Set-Cookie header on one response, and verifying only needs to read one
// cookie value back out later, so a minimal manual implementation of both
// avoids pulling in a plugin for what's a handful of lines.

import { randomBytes, createHash } from 'node:crypto';
import { getDb } from './db.js';

export const SESSION_COOKIE_NAME = 'ccserver_session';

// L2 fix (vuln_scan report): auth_sessions.id used to BE the raw session
// cookie value, stored in the clear -- anyone with read access to the
// SQLite file (a different local user, a backup, an unrelated file-read
// bug) could lift a row's id and use it as a live session cookie with no
// further work, exactly like loginTokens.js already avoids for
// login_tokens (see its header comment). Same fix here: only the SHA-256
// digest of the session id is ever persisted; the raw value lives only in
// the Set-Cookie header and the request that carries it back.
export function hashSessionId(rawSessionId) {
  return createHash('sha256').update(rawSessionId).digest('hex');
}

// Sliding expiration (plan decision 2): 30 days, refreshed on use.
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Throttle for the expires_at-extending UPDATE: only re-extend once per hour
// of use rather than on every single authenticated request.
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

// Exported for webauthnChallenges.js's flow cookie (Issue #141 Step3), which
// needs the exact same manual parse for a different cookie name.
export function parseCookieHeader(header) {
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
  const idHash = hashSessionId(sessionId);
  const row = db.prepare('SELECT expires_at, last_seen_at FROM auth_sessions WHERE id = ?').get(idHash);
  if (!row || row.expires_at <= now) return false;
  if (!row.last_seen_at || now - row.last_seen_at >= SESSION_TOUCH_INTERVAL_MS) {
    db.prepare('UPDATE auth_sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?')
      .run(now + SESSION_TTL_MS, now, idHash);
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
//
// Security audit F2: the session also records HOW it was created
// (authMethod 'login-token' | 'passkey', and which passkey), and whether it
// carries a single-use passkey-registration grant (only ever from a CLI
// token issued with --allow-passkey-registration). A passkey login does NOT
// count as a step-up: the login ceremony only asks for userVerification
// 'preferred', and the plan (remediation-plan r2 §2.3(b)) requires a
// passkey-login-only session to step up explicitly before registering.
export function createSession({ authMethod = null, credentialId = null, registrationGrant = false } = {}) {
  const db = getDb();
  const id = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare(
    'INSERT INTO auth_sessions (id, created_at, expires_at, last_seen_at, auth_method, credential_id, stepup_at, registration_grant) '
    + 'VALUES (?, ?, ?, NULL, ?, ?, NULL, ?)'
  ).run(hashSessionId(id), now, now + SESSION_TTL_MS, authMethod, credentialId, registrationGrant ? 1 : 0);
  return id;
}

// How long a step-up (a fresh user-verified passkey assertion) authorizes
// sensitive operations on the same session: registering another passkey
// (routes/auth.js) and deleting a pre-fix GPG vault (routes/gpgVault.js).
export const STEPUP_WINDOW_MS = 5 * 60 * 1000;

// The session id from the request's cookie, or null. Routes behind
// server/index.js's onRequest hook already know the session is valid; this
// only identifies WHICH session so per-session state can be read/written.
export function getRequestSessionId(request) {
  return parseCookieHeader(request.headers.cookie)[SESSION_COOKIE_NAME] || null;
}

// The live (unexpired) auth_sessions row for this request, or null.
export function getRequestSession(request) {
  const id = getRequestSessionId(request);
  if (!id) return null;
  const row = getDb().prepare(
    'SELECT id, created_at, expires_at, auth_method, credential_id, stepup_at, registration_grant FROM auth_sessions WHERE id = ?'
  ).get(hashSessionId(id));
  if (!row || row.expires_at <= Date.now()) return null;
  // row.id is the stored HASH, not the raw cookie value -- callers that need
  // to feed a session id back into another lookup (markStepUp,
  // consumeRegistrationGrant) must use getRequestSessionId(request) instead,
  // never this field. Kept on the object for identification/logging, not
  // reuse as a fresh WHERE id = ? argument.
  return row;
}

export function hasFreshStepUp(session, now = Date.now()) {
  return !!session && typeof session.stepup_at === 'number' && now - session.stepup_at < STEPUP_WINDOW_MS;
}

// `sessionId` must be the RAW cookie value (e.g. getRequestSessionId(request)),
// never a session row's .id field (which is the stored hash) -- this hashes
// its input itself, so passing an already-hashed value would hash it twice
// and silently match nothing.
export function markStepUp(sessionId, credentialId) {
  getDb().prepare('UPDATE auth_sessions SET stepup_at = ?, credential_id = COALESCE(?, credential_id) WHERE id = ?')
    .run(Date.now(), credentialId, hashSessionId(sessionId));
}

// Single-use: atomically clears the grant, returning true only if this call
// is the one that consumed it (two concurrent registrations cannot both use
// the same grant).
// `sessionId` must be the RAW cookie value -- see markStepUp's comment.
export function consumeRegistrationGrant(sessionId) {
  const result = getDb().prepare(
    'UPDATE auth_sessions SET registration_grant = 0 WHERE id = ? AND registration_grant = 1'
  ).run(hashSessionId(sessionId));
  return result.changes === 1;
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
