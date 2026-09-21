// Login/auth REST surface (Issue #141 Step2/3/4). Registered under /api, so
// its full path is /api/auth/* -- server/index.js's onRequest hook
// allowlists specific paths under here (UNAUTHENTICATED_AUTH_ROUTES/
// isAuthRoute) that must work with no session yet: mode, login-token, and
// the two webauthn/authenticate-* endpoints below. webauthn/register-* is
// deliberately NOT on that allowlist -- registering a passkey requires
// already being logged in, and omitting it there means it simply falls
// through to the normal session check like any other route. session (Step4)
// is also deliberately not on it, for the opposite reason: it exists
// specifically to answer "does the normal session check pass".
//
// register-verify/authenticate-verify's ceremony-completing endpoints stay
// generic ("verification failed") on every failure path rather than echoing
// @simplewebauthn's own error text, matching login-token's flat "invalid,
// expired, or already-used" -- specific rejection reasons are exactly what
// you don't want to hand back to whoever's probing these endpoints.

import { hashLoginToken } from '../loginTokens.js';
import {
  createSession,
  sessionCookieHeader,
  getRequestSession,
  hasFreshStepUp,
  markStepUp,
  consumeRegistrationGrant,
} from '../authSessions.js';
import { reportSecurityEvent } from '../securityEvents.js';
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
//
// Exported for routes/gpgVault.js to reuse verbatim (rather than duplicating
// the check) -- the GPG vault is itself a passkey-only feature (plan:
// gpg-agent-vault), and two independent copies of this guard could drift.
export function requirePasskeyMode(reply) {
  if (resolveAuthMode() === 'passkey') return true;
  reply.code(400).send({ error: 'WebAuthn/one-time login tokens are only used when CCSERVER_AUTH_MODE=passkey' });
  return false;
}

export async function authRoute(fastify, opts) {
  // Issue #141 Step4: lets the client (client/src/auth.js) know which auth
  // mode it's dealing with before it can possibly have a session yet, so it
  // can decide whether to render LoginView at all. Unauthenticated in every
  // mode (server/index.js's UNAUTHENTICATED_AUTH_ROUTES) -- in `token` mode
  // that onRequest hook has no allowlist of its own and gates this route
  // like any other, so it only actually answers unauthenticated in `none`/
  // `passkey`; the client treats a failed call the same as `token` mode
  // (fall through to the pre-#141 prompt()-on-401 behavior), which is
  // exactly correct there since a valid request would need the token anyway.
  fastify.get('/auth/mode', async () => {
    return { mode: resolveAuthMode() };
  });

  // Issue #141 Step4: cheap "am I still logged in" check for the client's
  // AuthGate. Only meaningful in `passkey` mode (the only mode with a
  // session concept) -- there it falls through to the normal onRequest
  // session check like any other non-allowlisted route, so 200 vs 401 here
  // *is* the answer. In `token`/`none` mode nothing gates this route, so it
  // always returns 200, but the client never calls it there (mode !==
  // 'passkey' skips the session check entirely).
  fastify.get('/auth/session', async () => {
    return { success: true };
  });

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
    //
    // RETURNING reads the token's --allow-passkey-registration flag in the
    // SAME statement that consumes it (security audit F2): the resulting
    // session carries a single-use passkey-registration grant only if the
    // host operator explicitly asked for one when issuing the token.
    const db = getDb();
    const now = Date.now();
    const tokenHash = hashLoginToken(body.token);
    const consumed = db.prepare(
      'UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? '
      + 'RETURNING allow_passkey_registration'
    ).get(now, tokenHash, now);
    if (!consumed) {
      return reply.code(401).send({ error: 'invalid, expired, or already-used token' });
    }

    const sessionId = createSession({
      authMethod: 'login-token',
      registrationGrant: consumed.allow_passkey_registration === 1,
    });
    reply.header('Set-Cookie', sessionCookieHeader(sessionId, { secure: request.protocol === 'https' }));
    return { success: true };
  });

  // Registered-passkey list for SettingsView's passkey section (Issue #141
  // Step4). Requires an existing session, same reasoning as register-*
  // below (falls through to the normal onRequest check, not on
  // UNAUTHENTICATED_AUTH_ROUTES). Deliberately excludes public_key/counter
  // (verification internals, not useful to display) -- id is included only
  // as a stable React key on the client, not shown to the user.
  fastify.get('/auth/webauthn/credentials', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    const rows = getDb().prepare(
      'SELECT id, label, created_at, last_used_at FROM webauthn_credentials ORDER BY created_at ASC'
    ).all();
    return {
      credentials: rows.map((row) => ({
        id: row.id,
        label: row.label,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
      })),
    };
  });

  // Step-up (security audit F2): a fresh, user-verified assertion from any
  // already-registered passkey, recorded on THIS session (stepup_at). Needed
  // before registering another passkey, so a stolen session cookie alone can
  // no longer enroll the thief's own authenticator (which could then be
  // added to the GPG vault). Requires an existing session like register-*.
  fastify.post('/auth/webauthn/stepup-options', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    const allowCredentials = getDb().prepare('SELECT id FROM webauthn_credentials').all().map((row) => ({ id: row.id }));
    if (allowCredentials.length === 0) {
      return reply.code(404).send({ error: 'no passkey is registered yet' });
    }
    const options = await generateAuthenticationOptions({
      rpID: resolveRpID(request),
      allowCredentials,
      userVerification: 'required',
    });
    const flowId = startChallengeFlow('stepup', options.challenge);
    reply.header('Set-Cookie', flowCookieHeader(flowId, { secure: request.protocol === 'https' }));
    return options;
  });

  fastify.post('/auth/webauthn/stepup-verify', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    const session = getRequestSession(request);
    if (!session) return reply.code(401).send({ error: 'a login session is required' });
    const body = request.body || {};
    const response = body.response;
    if (!response || typeof response !== 'object' || typeof response.id !== 'string') {
      return reply.code(400).send({ error: 'response is required' });
    }
    const expectedChallenge = consumeChallengeFlow(request, 'stepup');
    reply.header('Set-Cookie', clearFlowCookieHeader());
    if (!expectedChallenge) {
      return reply.code(401).send({ error: 'step-up flow expired or not found -- request new options first' });
    }
    const row = getDb().prepare('SELECT id, public_key, counter FROM webauthn_credentials WHERE id = ?').get(response.id);
    if (!row) return reply.code(401).send({ error: 'verification failed' });
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: resolveOrigin(request),
        expectedRPID: resolveRpID(request),
        credential: { id: row.id, publicKey: row.public_key, counter: row.counter },
        requireUserVerification: true,
      });
    } catch {
      verification = { verified: false };
    }
    if (!verification.verified) return reply.code(401).send({ error: 'verification failed' });
    getDb().prepare('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?')
      .run(verification.authenticationInfo.newCounter, Date.now(), row.id);
    markStepUp(session.id, row.id);
    return { success: true };
  });

  // WebAuthn passkey registration (Issue #141 Step3, フロー2). Requires an
  // existing session -- absent from UNAUTHENTICATED_AUTH_ROUTES in
  // server/index.js, so it falls through to the normal onRequest check like
  // any other route (see header comment for why that matters).
  //
  // Security audit F2: a session alone is NOT enough. Registration needs
  // either a fresh step-up on this session (an existing passkey holder
  // adding another), or this session's single-use registration grant (only
  // ever minted from a CLI login token issued with
  // --allow-passkey-registration -- bootstrap / lost-all-passkeys recovery,
  // rooted in host access). No implicit exception when zero passkeys exist.
  fastify.post('/auth/webauthn/register-options', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    if (!registrationAllowed(request)) return rejectRegistration(reply);
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
      // Requests the PRF (hmac-secret) extension's capability at creation
      // time (plan: gpg-agent-vault) -- on most authenticators, PRF can only
      // be evaluated later (at a get() ceremony) for a credential that
      // requested it here at MakeCredential time. No eval salt needed yet;
      // routes/gpgVault.js's step-up ceremonies supply one later. Harmless
      // no-op for an authenticator/browser that doesn't support PRF at all.
      extensions: { prf: {} },
    });
    const flowId = startChallengeFlow('registration', options.challenge);
    reply.header('Set-Cookie', flowCookieHeader(flowId, { secure: request.protocol === 'https' }));
    return options;
  });

  fastify.post('/auth/webauthn/register-verify', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    const session = getRequestSession(request);
    if (!registrationAllowed(request, session)) return rejectRegistration(reply);
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

    // The grant is spent only on an actually-successful registration (and
    // atomically, so two concurrent ceremonies cannot both use it). A fresh
    // step-up is not consumed -- it simply expires.
    if (!hasFreshStepUp(session) && !consumeRegistrationGrant(session.id)) {
      return rejectRegistration(reply);
    }

    const { credential } = verification.registrationInfo;
    const label = typeof body.label === 'string' && body.label.length > 0 ? body.label : null;
    getDb().prepare(
      'INSERT INTO webauthn_credentials (id, public_key, counter, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, NULL)'
    ).run(credential.id, credential.publicKey, credential.counter, label, Date.now());
    reportSecurityEvent('新しいパスキーが登録されました', `label: ${label ?? '(なし)'}`);
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

    // Not a step-up (see createSession()): this ceremony's UV is only
    // 'preferred', so registering another passkey still needs stepup-*.
    const sessionId = createSession({ authMethod: 'passkey', credentialId: row.id });
    reply.header('Set-Cookie', sessionCookieHeader(sessionId, { secure: request.protocol === 'https' }));
    return { success: true };
  });
}

// See register-options' comment (security audit F2).
function registrationAllowed(request, session = getRequestSession(request)) {
  if (!session) return false;
  return hasFreshStepUp(session) || session.registration_grant === 1;
}

function rejectRegistration(reply) {
  return reply.code(403).send({
    error: 'passkey registration requires a fresh step-up with an existing passkey, '
      + 'or a login token issued with --allow-passkey-registration',
    code: 'PASSKEY_REGISTRATION_NOT_ALLOWED',
  });
}
