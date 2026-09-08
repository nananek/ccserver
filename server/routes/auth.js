// Login/auth REST surface (Issue #141 Step2/Step3). Registered under /api,
// so its full path is /api/auth/* -- server/index.js's onRequest hook
// allowlists specific paths under here (UNAUTHENTICATED_AUTH_ROUTES/
// isAuthRoute) that must work with no session yet: login-token and the two
// webauthn/authenticate-* endpoints below. webauthn/register-* is
// deliberately NOT on that allowlist -- registering a passkey requires
// already being logged in, and omitting it there means it simply falls
// through to the normal session check like any other route.
//
// register-verify/authenticate-verify's ceremony-completing endpoints stay
// generic ("verification failed") on every failure path rather than echoing
// @simplewebauthn's own error text, matching login-token's flat "invalid,
// expired, or already-used" -- specific rejection reasons are exactly what
// you don't want to hand back to whoever's probing these endpoints.

import { hashLoginToken } from '../loginTokens.js';
import { createSession, sessionCookieHeader } from '../authSessions.js';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import {
  WEBAUTHN_USER_ID,
  WEBAUTHN_USER_NAME,
  startChallengeFlow,
  consumeChallengeFlow,
  flowCookieHeader,
  clearFlowCookieHeader,
  resolveRpID,
  resolveOrigin,
} from '../webauthnChallenges.js';
import { getDb } from '../db.js';
import { resolveAuthMode } from '../authMode.js';

// Every route here (except its 400 guard) is only meaningful in passkey
// mode: in token/none mode none of login_tokens/webauthn_credentials can
// have a row (the CLI/other routes that would create one all refuse outside
// passkey mode too), so this stays a clear 400 rather than a confusing
// "invalid"/"verification failed" for every possible input.
function requirePasskeyMode(reply) {
  if (resolveAuthMode() === 'passkey') return true;
  reply.code(400).send({ error: 'WebAuthn/one-time login tokens are only used when CCSERVER_AUTH_MODE=passkey' });
  return false;
}

export async function authRoute(fastify, opts) {
  // Exchanges a CLI-issued one-time token (server/cli/issue-login-token.js,
  // フロー1) for a session cookie.
  fastify.post('/auth/login-token', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
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

  // WebAuthn passkey registration (Issue #141 Step3, フロー2). Requires an
  // existing session -- absent from UNAUTHENTICATED_AUTH_ROUTES in
  // server/index.js, so it falls through to the normal onRequest check like
  // any other route (see header comment for why that matters).
  fastify.post('/auth/webauthn/register-options', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    const existing = getDb().prepare('SELECT id FROM webauthn_credentials').all();
    const options = await generateRegistrationOptions({
      rpName: 'ccserver',
      rpID: resolveRpID(request),
      userID: WEBAUTHN_USER_ID,
      userName: WEBAUTHN_USER_NAME,
      attestationType: 'none',
      excludeCredentials: existing.map((row) => ({ id: row.id })),
      // Discoverable credential (plan decision: passkey login with no
      // username prompt) -- authenticate-options below relies on this by
      // sending allowCredentials: [] and letting the browser offer whatever
      // ccserver passkeys it already has for this rpID.
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    const flowId = startChallengeFlow('registration', options.challenge);
    reply.header('Set-Cookie', flowCookieHeader(flowId, { secure: request.protocol === 'https' }));
    return options;
  });

  fastify.post('/auth/webauthn/register-verify', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    const body = request.body || {};
    if (!body.response || typeof body.response !== 'object') {
      return reply.code(400).send({ error: 'response is required' });
    }

    // Consumed (one-time) and the flow cookie cleared regardless of what
    // follows -- a register-verify attempt, successful or not, always ends
    // this ceremony rather than leaving a flowId usable a second time.
    const expectedChallenge = consumeChallengeFlow(request, 'registration');
    reply.header('Set-Cookie', clearFlowCookieHeader());
    if (!expectedChallenge) {
      return reply.code(401).send({ error: 'registration flow expired or not found -- request new options first' });
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge,
        expectedOrigin: resolveOrigin(request),
        expectedRPID: resolveRpID(request),
      });
    } catch {
      verification = { verified: false };
    }
    if (!verification.verified) {
      return reply.code(401).send({ error: 'registration verification failed' });
    }

    const { credential } = verification.registrationInfo;
    const label = typeof body.label === 'string' && body.label.length > 0 ? body.label : null;
    getDb().prepare(
      'INSERT INTO webauthn_credentials (id, public_key, counter, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, NULL)'
    ).run(credential.id, credential.publicKey, credential.counter, label, Date.now());
    return { success: true };
  });

  // WebAuthn passkey authentication (Issue #141 Step3, フロー3). No session
  // required -- this and authenticate-verify below are the two routes this
  // Step adds to UNAUTHENTICATED_AUTH_ROUTES, since they're what *creates* a
  // session (same reasoning as login-token).
  fastify.post('/auth/webauthn/authenticate-options', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    const options = await generateAuthenticationOptions({
      rpID: resolveRpID(request),
      // Empty (not omitted) allowCredentials, matching the discoverable-
      // credential registration above -- the browser offers whichever
      // ccserver passkey it already has stored, with no username step.
      allowCredentials: [],
      userVerification: 'preferred',
    });
    const flowId = startChallengeFlow('authentication', options.challenge);
    reply.header('Set-Cookie', flowCookieHeader(flowId, { secure: request.protocol === 'https' }));
    return options;
  });

  fastify.post('/auth/webauthn/authenticate-verify', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    const body = request.body || {};
    const response = body.response;
    if (!response || typeof response !== 'object' || typeof response.id !== 'string') {
      return reply.code(400).send({ error: 'response is required' });
    }

    // Same one-time-consume-regardless-of-outcome treatment as register-verify.
    const expectedChallenge = consumeChallengeFlow(request, 'authentication');
    reply.header('Set-Cookie', clearFlowCookieHeader());
    if (!expectedChallenge) {
      return reply.code(401).send({ error: 'authentication flow expired or not found -- request new options first' });
    }

    const row = getDb().prepare('SELECT id, public_key, counter FROM webauthn_credentials WHERE id = ?').get(response.id);
    if (!row) {
      return reply.code(401).send({ error: 'authentication verification failed' });
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: resolveOrigin(request),
        expectedRPID: resolveRpID(request),
        credential: { id: row.id, publicKey: row.public_key, counter: row.counter },
      });
    } catch {
      verification = { verified: false };
    }
    if (!verification.verified) {
      return reply.code(401).send({ error: 'authentication verification failed' });
    }

    // Counter update (replay defense, plan point 6): verifyAuthenticationResponse
    // already rejected any response whose counter didn't advance past what's
    // stored, so this write is just persisting the new high-water mark.
    getDb().prepare('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?')
      .run(verification.authenticationInfo.newCounter, Date.now(), row.id);

    const sessionId = createSession();
    reply.header('Set-Cookie', sessionCookieHeader(sessionId, { secure: request.protocol === 'https' }));
    return { success: true };
  });
}
