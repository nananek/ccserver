// Login/auth REST surface (Issue #141 Step2). Registered under /api, so its
// full path is /api/auth/* -- server/index.js's onRequest hook allowlists
// this specific path (UNAUTHENTICATED_AUTH_ROUTES/isAuthRoute) so it's
// reachable without a session of its own; it's the thing that *creates* one.
//
// Step3 will add /api/auth/webauthn/* here for passkey registration and
// authentication. Registration (adding a passkey while already logged in)
// must NOT be added to UNAUTHENTICATED_AUTH_ROUTES -- unlike
// login-token/webauthn-authentication, which must work with no session yet,
// registration should require one and will simply fall through to the normal
// session check by being absent from that allowlist.

import { hashLoginToken } from '../loginTokens.js';
import { createSession, sessionCookieHeader } from '../authSessions.js';
import { getDb } from '../db.js';
import { resolveAuthMode } from '../authMode.js';

export async function authRoute(fastify, opts) {
  // Exchanges a CLI-issued one-time token (server/cli/issue-login-token.js,
  // フロー1) for a session cookie. Only meaningful in passkey mode: in
  // token/none mode no login_tokens row can ever exist (the CLI itself
  // refuses to issue one outside passkey mode), so this stays a clear 400
  // rather than a confusing "invalid token" for every possible input.
  fastify.post('/auth/login-token', async (request, reply) => {
    if (resolveAuthMode() !== 'passkey') {
      return reply.code(400).send({ error: 'one-time login tokens are only used when CCSERVER_AUTH_MODE=passkey' });
    }
    const body = request.body || {};
    if (typeof body.token !== 'string' || body.token.length === 0) {
      return reply.code(400).send({ error: 'token is required' });
    }

    // Single UPDATE ... WHERE used_at IS NULL AND expires_at > now, checked
    // via the affected-row count, rather than SELECT-then-UPDATE: two
    // concurrent redemption attempts for the same token must not both see
    // "unused" and both succeed (this is exactly the use-once guarantee the
    // token exists to provide).
    const db = getDb();
    const now = Date.now();
    const tokenHash = hashLoginToken(body.token);
    const result = db.prepare(
      'UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?'
    ).run(now, tokenHash, now);
    if (result.changes === 0) {
      return reply.code(401).send({ error: 'invalid, expired, or already-used token' });
    }

    const sessionId = createSession();
    reply.header('Set-Cookie', sessionCookieHeader(sessionId, { secure: request.protocol === 'https' }));
    return { success: true };
  });
}
