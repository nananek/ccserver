// POST /api/auth/login-token (Issue #141 Step2) and /api/auth/webauthn/*
// (Issue #141 Step3): exchanging a CLI-issued one-time token, or a WebAuthn
// registration/authentication ceremony, for a session cookie.
//
// The WebAuthn tests below drive real registration->authentication round
// trips through @simplewebauthn/server's actual verification code, using
// webauthnTestAuthenticator.js to stand in for a browser + hardware
// authenticator (there's no navigator.credentials in this test environment).
// A fixed Host header (RP_HOST) makes resolveRpID()/resolveOrigin() (both
// request-derived) deterministic across requests within a test.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { getDb, closeDb } from '../db.js';
import { generateLoginToken, hashLoginToken } from '../loginTokens.js';
import { SESSION_COOKIE_NAME, createSession, markStepUp, STEPUP_WINDOW_MS } from '../authSessions.js';
import { FLOW_COOKIE_NAME } from '../webauthnChallenges.js';
import { generateAuthenticatorKeyPair, createRegistrationResponse, createAuthenticationResponse } from './webauthnTestAuthenticator.js';
import { authRoute } from './auth.js';

const RP_HOST = 'ccserver.test';
const ORIGIN = `http://${RP_HOST}`;

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

// A logged-in session with a fresh step-up (as right after a passkey
// login). Registration now requires one (security audit F2), so the
// registration-mechanics tests below run as this session; the gate itself
// is exercised separately at the end of this file.
let stepUpCookie;

// A passkey-login session that has also completed an explicit step-up.
function steppedUpSession() {
  const id = createSession({ authMethod: 'passkey' });
  markStepUp(id, null);
  return id;
}

beforeEach(() => {
  closeDb();
  const db = getDb();
  db.exec('DELETE FROM login_tokens');
  db.exec('DELETE FROM auth_sessions');
  db.exec('DELETE FROM webauthn_credentials');
  process.env.CCSERVER_AUTH_MODE = 'passkey';
  stepUpCookie = `${SESSION_COOKIE_NAME}=${steppedUpSession()}`;
});

function insertToken({ expiresInMs = 15 * 60 * 1000, usedAt = null, allowPasskeyRegistration = false } = {}) {
  const db = getDb();
  const { token, tokenHash } = generateLoginToken();
  const now = Date.now();
  db.prepare(
    'INSERT INTO login_tokens (id, token_hash, created_at, expires_at, used_at, allow_passkey_registration) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), tokenHash, now, now + expiresInMs, usedAt, allowPasskeyRegistration ? 1 : 0);
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

// ---------------------------------------------------------------------------
// /api/auth/mode, /api/auth/session (Issue #141 Step4)
//
// Both routes' actual unauthenticated-vs-session-gated behavior lives in
// server/index.js's onRequest hook (mode is on UNAUTHENTICATED_AUTH_ROUTES,
// session deliberately is not) -- this test app registers authRoute() alone
// with no such hook, so what's verified here is only the handlers'
// bodies, not the gating. There's no existing test harness in this repo that
// boots the full server/index.js app (it also opens ports, restores
// sessions, etc.), so that gating is verified by code review instead.

test('GET /api/auth/mode: reports the current CCSERVER_AUTH_MODE', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/mode' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { mode: 'passkey' });
});

test('GET /api/auth/mode: reflects a non-passkey mode too (no requirePasskeyMode gate on this route)', async () => {
  process.env.CCSERVER_AUTH_MODE = 'token';
  const res = await app.inject({ method: 'GET', url: '/api/auth/mode' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { mode: 'token' });
});

test('GET /api/auth/session: 200 with no body requirement (gating happens in server/index.js, not here)', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/session' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { success: true });
});

// ---------------------------------------------------------------------------
// /api/auth/webauthn/* (Issue #141 Step3)

function findCookie(res, name) {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return null;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  if (!match) return null;
  return match;
}

function flowIdFrom(res) {
  const cookie = findCookie(res, FLOW_COOKIE_NAME);
  return cookie ? cookie.match(new RegExp(`${FLOW_COOKIE_NAME}=([^;]+)`))[1] : null;
}

// Drives a full register-options -> register-verify round trip through a
// simulated authenticator and returns the credential's keypair/id so callers
// can go on to authenticate with it. Asserts only that registration itself
// succeeded; callers add their own assertions on top.
async function registerCredential({ label } = {}) {
  const optionsRes = await app.inject({
    method: 'POST',
    url: '/api/auth/webauthn/register-options',
    headers: { host: RP_HOST, cookie: stepUpCookie },
  });
  assert.equal(optionsRes.statusCode, 200);
  const options = optionsRes.json();
  const flowId = flowIdFrom(optionsRes);
  assert.ok(flowId, 'register-options sets a flow cookie');

  const { publicKey, privateKey } = generateAuthenticatorKeyPair();
  const credentialId = randomBytes(16);
  const response = createRegistrationResponse({
    rpID: RP_HOST,
    origin: ORIGIN,
    challenge: options.challenge,
    credentialId,
    publicKey,
  });

  const verifyRes = await app.inject({
    method: 'POST',
    url: '/api/auth/webauthn/register-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowId}; ${stepUpCookie}` },
    payload: label === undefined ? { response } : { response, label },
  });
  assert.equal(verifyRes.statusCode, 200, `register-verify failed: ${verifyRes.body}`);
  return { credentialId, privateKey, verifyRes };
}

test('GET /api/auth/webauthn/credentials: 400 when CCSERVER_AUTH_MODE is not passkey', async () => {
  process.env.CCSERVER_AUTH_MODE = 'token';
  const res = await app.inject({ method: 'GET', url: '/api/auth/webauthn/credentials' });
  assert.equal(res.statusCode, 400);
});

test('GET /api/auth/webauthn/credentials: empty list when nothing is registered', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/webauthn/credentials' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { credentials: [] });
});

test('GET /api/auth/webauthn/credentials: lists registered credentials without exposing public_key/counter', async () => {
  const { credentialId } = await registerCredential({ label: 'YubiKey' });
  const res = await app.inject({ method: 'GET', url: '/api/auth/webauthn/credentials' });
  assert.equal(res.statusCode, 200);
  const { credentials } = res.json();
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].id, credentialId.toString('base64url'));
  assert.equal(credentials[0].label, 'YubiKey');
  assert.ok(Number.isFinite(credentials[0].createdAt));
  assert.equal(credentials[0].lastUsedAt, null);
  assert.equal(credentials[0].public_key, undefined);
  assert.equal(credentials[0].counter, undefined);
});

test('POST /api/auth/webauthn/register-options: 400 when CCSERVER_AUTH_MODE is not passkey', async () => {
  process.env.CCSERVER_AUTH_MODE = 'token';
  const res = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: { host: RP_HOST, cookie: stepUpCookie } });
  assert.equal(res.statusCode, 400);
});

test('POST /api/auth/webauthn/register-options: returns discoverable-credential options and a flow cookie', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: { host: RP_HOST, cookie: stepUpCookie } });
  assert.equal(res.statusCode, 200);
  const options = res.json();
  assert.equal(options.rp.id, RP_HOST);
  assert.equal(options.user.name, 'ccserver');
  assert.equal(options.authenticatorSelection.residentKey, 'required');
  assert.ok(typeof options.challenge === 'string' && options.challenge.length > 0);
  assert.ok(flowIdFrom(res), 'a flow cookie was set');
  // plan: gpg-agent-vault -- new passkeys must request PRF capability at
  // creation time so a later GPG-vault step-up ceremony can evaluate it.
  // (options.extensions also carries simplewebauthn's own credProps:true
  // default -- irrelevant to this feature, not asserted on here.)
  assert.deepEqual(options.extensions.prf, {});
});

test('POST /api/auth/webauthn/register-options: excludes already-registered credential ids', async () => {
  const { credentialId } = await registerCredential();
  const res = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: { host: RP_HOST, cookie: stepUpCookie } });
  const options = res.json();
  const excludedIds = options.excludeCredentials.map((c) => c.id);
  assert.ok(excludedIds.includes(credentialId.toString('base64url')));
});

test('POST /api/auth/webauthn/register-verify: 400 when CCSERVER_AUTH_MODE is not passkey', async () => {
  process.env.CCSERVER_AUTH_MODE = 'token';
  const res = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-verify', payload: { response: {} } });
  assert.equal(res.statusCode, 400);
});

test('POST /api/auth/webauthn/register-verify: 400 when response is missing from the body', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-verify', headers: { cookie: stepUpCookie }, payload: {} });
  assert.equal(res.statusCode, 400);
});

test('POST /api/auth/webauthn/register-verify: 401 with no flow cookie at all', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-verify', headers: { cookie: stepUpCookie }, payload: { response: {} } });
  assert.equal(res.statusCode, 401);
});

test('POST /api/auth/webauthn/register-verify: 401 when the flow cookie is an authenticate (wrong-kind) flow', async () => {
  const optionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/authenticate-options', headers: { host: RP_HOST } });
  const flowId = flowIdFrom(optionsRes);
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/webauthn/register-verify',
    headers: { cookie: `${FLOW_COOKIE_NAME}=${flowId}; ${stepUpCookie}` },
    payload: { response: {} },
  });
  assert.equal(res.statusCode, 401);
});

test('POST /api/auth/webauthn/register-verify: 401 for a response that fails verification (bad signature/challenge)', async () => {
  const optionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: { host: RP_HOST, cookie: stepUpCookie } });
  const flowId = flowIdFrom(optionsRes);
  const { publicKey } = generateAuthenticatorKeyPair();
  const response = createRegistrationResponse({
    rpID: RP_HOST,
    origin: ORIGIN,
    challenge: 'not-the-real-challenge',
    credentialId: randomBytes(16),
    publicKey,
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/webauthn/register-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowId}; ${stepUpCookie}` },
    payload: { response },
  });
  assert.equal(res.statusCode, 401);
});

test('POST /api/auth/webauthn/register-verify: 401 when the response was built for a different rpID', async () => {
  const optionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: { host: RP_HOST, cookie: stepUpCookie } });
  const options = optionsRes.json();
  const flowId = flowIdFrom(optionsRes);
  const { publicKey } = generateAuthenticatorKeyPair();
  // Origin is left correct so this isolates the rpID (rpIdHash) check from
  // the origin check -- a real cross-site attempt would fail both.
  const response = createRegistrationResponse({
    rpID: 'attacker.example',
    origin: ORIGIN,
    challenge: options.challenge,
    credentialId: randomBytes(16),
    publicKey,
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/webauthn/register-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowId}; ${stepUpCookie}` },
    payload: { response },
  });
  assert.equal(res.statusCode, 401);
});

test('POST /api/auth/webauthn/register-verify: valid response inserts a webauthn_credentials row and clears the flow cookie', async () => {
  const { credentialId, verifyRes } = await registerCredential({ label: 'MacBook Touch ID' });
  assert.deepEqual(verifyRes.json(), { success: true });

  const clearedFlow = findCookie(verifyRes, FLOW_COOKIE_NAME);
  assert.ok(clearedFlow.includes('Max-Age=0'), 'flow cookie is expired after use');

  const row = getDb().prepare('SELECT id, counter, label, last_used_at FROM webauthn_credentials WHERE id = ?')
    .get(credentialId.toString('base64url'));
  assert.ok(row, 'credential row was inserted');
  assert.equal(row.counter, 0);
  assert.equal(row.label, 'MacBook Touch ID');
  assert.equal(row.last_used_at, null);
});

test('POST /api/auth/webauthn/register-verify: label is optional (stored as NULL when omitted)', async () => {
  const { credentialId } = await registerCredential();
  const row = getDb().prepare('SELECT label FROM webauthn_credentials WHERE id = ?').get(credentialId.toString('base64url'));
  assert.equal(row.label, null);
});

test('POST /api/auth/webauthn/register-verify: the flow cookie is one-time use', async () => {
  const optionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: { host: RP_HOST, cookie: stepUpCookie } });
  const options = optionsRes.json();
  const flowId = flowIdFrom(optionsRes);
  const { publicKey } = generateAuthenticatorKeyPair();
  const credentialId = randomBytes(16);
  const response = createRegistrationResponse({ rpID: RP_HOST, origin: ORIGIN, challenge: options.challenge, credentialId, publicKey });

  const cookieHeader = { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowId}; ${stepUpCookie}` };
  const first = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-verify', headers: cookieHeader, payload: { response } });
  assert.equal(first.statusCode, 200);
  const second = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-verify', headers: cookieHeader, payload: { response } });
  assert.equal(second.statusCode, 401);
});

test('POST /api/auth/webauthn/authenticate-options: 400 when CCSERVER_AUTH_MODE is not passkey', async () => {
  process.env.CCSERVER_AUTH_MODE = 'token';
  const res = await app.inject({ method: 'POST', url: '/api/auth/webauthn/authenticate-options', headers: { host: RP_HOST } });
  assert.equal(res.statusCode, 400);
});

test('POST /api/auth/webauthn/authenticate-options: returns empty allowCredentials (discoverable/usernameless) and a flow cookie', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/webauthn/authenticate-options', headers: { host: RP_HOST } });
  assert.equal(res.statusCode, 200);
  const options = res.json();
  assert.equal(options.rpId, RP_HOST);
  assert.deepEqual(options.allowCredentials, []);
  assert.ok(flowIdFrom(res), 'a flow cookie was set');
});

test('POST /api/auth/webauthn/authenticate-verify: 400 when response is missing/malformed', async () => {
  const missing = await app.inject({ method: 'POST', url: '/api/auth/webauthn/authenticate-verify', payload: {} });
  assert.equal(missing.statusCode, 400);
  const noId = await app.inject({ method: 'POST', url: '/api/auth/webauthn/authenticate-verify', payload: { response: {} } });
  assert.equal(noId.statusCode, 400);
});

test('POST /api/auth/webauthn/authenticate-verify: 401 with no flow cookie', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/webauthn/authenticate-verify',
    payload: { response: { id: 'unknown' } },
  });
  assert.equal(res.statusCode, 401);
});

test('POST /api/auth/webauthn/authenticate-verify: 401 for an unregistered credential id', async () => {
  const optionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/authenticate-options', headers: { host: RP_HOST } });
  const flowId = flowIdFrom(optionsRes);
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/webauthn/authenticate-verify',
    headers: { cookie: `${FLOW_COOKIE_NAME}=${flowId}; ${stepUpCookie}` },
    payload: { response: { id: 'not-a-registered-credential' } },
  });
  assert.equal(res.statusCode, 401);
});

test('POST /api/auth/webauthn/authenticate-verify: valid assertion sets a session cookie, clears the flow cookie, and advances the counter', async () => {
  const { credentialId, privateKey } = await registerCredential();

  const optionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/authenticate-options', headers: { host: RP_HOST } });
  const options = optionsRes.json();
  const flowId = flowIdFrom(optionsRes);
  const response = createAuthenticationResponse({
    rpID: RP_HOST,
    origin: ORIGIN,
    challenge: options.challenge,
    credentialId,
    privateKey,
    counter: 1,
  });

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/webauthn/authenticate-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowId}; ${stepUpCookie}` },
    payload: { response },
  });
  assert.equal(res.statusCode, 200, `authenticate-verify failed: ${res.body}`);
  assert.deepEqual(res.json(), { success: true });

  const sessionCookie = findCookie(res, SESSION_COOKIE_NAME);
  assert.ok(sessionCookie, 'a session cookie was set');
  assert.ok(sessionCookie.includes('HttpOnly'));

  const clearedFlow = findCookie(res, FLOW_COOKIE_NAME);
  assert.ok(clearedFlow.includes('Max-Age=0'));

  const row = getDb().prepare('SELECT counter, last_used_at FROM webauthn_credentials WHERE id = ?')
    .get(credentialId.toString('base64url'));
  assert.equal(row.counter, 1);
  assert.ok(row.last_used_at, 'last_used_at was updated');
});

test('POST /api/auth/webauthn/authenticate-verify: rejects a replayed/regressed counter and does not grant a session', async () => {
  const { credentialId, privateKey } = await registerCredential();

  // First, legitimate authentication advances the stored counter to 5.
  const firstOptionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/authenticate-options', headers: { host: RP_HOST } });
  const firstOptions = firstOptionsRes.json();
  const firstFlowId = flowIdFrom(firstOptionsRes);
  const firstResponse = createAuthenticationResponse({
    rpID: RP_HOST, origin: ORIGIN, challenge: firstOptions.challenge, credentialId, privateKey, counter: 5,
  });
  const firstRes = await app.inject({
    method: 'POST',
    url: '/api/auth/webauthn/authenticate-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${firstFlowId}` },
    payload: { response: firstResponse },
  });
  assert.equal(firstRes.statusCode, 200);

  // A second assertion (fresh challenge, as if a stolen/replayed authenticator
  // state produced it) claims a counter <= what's already stored -- this is
  // exactly the replay signal verifyAuthenticationResponse() checks for.
  const secondOptionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/authenticate-options', headers: { host: RP_HOST } });
  const secondOptions = secondOptionsRes.json();
  const secondFlowId = flowIdFrom(secondOptionsRes);
  const secondResponse = createAuthenticationResponse({
    rpID: RP_HOST, origin: ORIGIN, challenge: secondOptions.challenge, credentialId, privateKey, counter: 3,
  });
  const secondRes = await app.inject({
    method: 'POST',
    url: '/api/auth/webauthn/authenticate-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${secondFlowId}` },
    payload: { response: secondResponse },
  });
  assert.equal(secondRes.statusCode, 401);
  assert.ok(!findCookie(secondRes, SESSION_COOKIE_NAME), 'no session cookie on a rejected replay');

  const row = getDb().prepare('SELECT counter FROM webauthn_credentials WHERE id = ?').get(credentialId.toString('base64url'));
  assert.equal(row.counter, 5, 'counter is unchanged by the rejected replay');
});

test('POST /api/auth/webauthn/authenticate-verify: the flow cookie is one-time use', async () => {
  const { credentialId, privateKey } = await registerCredential();
  const optionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/authenticate-options', headers: { host: RP_HOST } });
  const options = optionsRes.json();
  const flowId = flowIdFrom(optionsRes);
  const response = createAuthenticationResponse({
    rpID: RP_HOST, origin: ORIGIN, challenge: options.challenge, credentialId, privateKey, counter: 1,
  });

  const cookieHeader = { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowId}; ${stepUpCookie}` };
  const first = await app.inject({ method: 'POST', url: '/api/auth/webauthn/authenticate-verify', headers: cookieHeader, payload: { response } });
  assert.equal(first.statusCode, 200);
  const second = await app.inject({ method: 'POST', url: '/api/auth/webauthn/authenticate-verify', headers: cookieHeader, payload: { response } });
  assert.equal(second.statusCode, 401);
});

// ---------------------------------------------------------------------------
// Security audit F2: registering a passkey needs more than a session.
// The audit's chain started with a session thief enrolling their own
// passkey with no re-authentication; everything below pins that shut.

// Logs in through the real login-token endpoint and returns the session
// cookie ("name=value").
async function loginWithToken({ allowPasskeyRegistration = false } = {}) {
  const token = insertToken({ allowPasskeyRegistration });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login-token', payload: { token } });
  assert.equal(res.statusCode, 200);
  const cookie = findCookie(res, SESSION_COOKIE_NAME);
  return cookie.split(';')[0];
}

async function tryRegister(sessionCookie) {
  const headersFor = (flowId) => ({ host: RP_HOST, cookie: [flowId && `${FLOW_COOKIE_NAME}=${flowId}`, sessionCookie].filter(Boolean).join('; ') });
  const optionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: headersFor(null) });
  if (optionsRes.statusCode !== 200) return { stage: 'options', res: optionsRes };
  const options = optionsRes.json();
  const { publicKey, privateKey } = generateAuthenticatorKeyPair();
  const credentialId = randomBytes(16);
  const response = createRegistrationResponse({ rpID: RP_HOST, origin: ORIGIN, challenge: options.challenge, credentialId, publicKey });
  const verifyRes = await app.inject({
    method: 'POST', url: '/api/auth/webauthn/register-verify',
    headers: headersFor(flowIdFrom(optionsRes)), payload: { response },
  });
  return { stage: 'verify', res: verifyRes, credentialId, privateKey };
}

function credentialCount() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM webauthn_credentials').get().c;
}

test('F2: register-options/verify with NO session at all -> 403, nothing registered', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: { host: RP_HOST } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, 'PASSKEY_REGISTRATION_NOT_ALLOWED');
  const verify = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-verify', payload: { response: {} } });
  assert.equal(verify.statusCode, 403);
});

test('F2: a plain login-token session (no --allow-passkey-registration) cannot register -- even when zero passkeys exist', async () => {
  assert.equal(credentialCount(), 0, 'precondition: bootstrap situation');
  const cookie = await loginWithToken();
  const attempt = await tryRegister(cookie);
  assert.equal(attempt.stage, 'options');
  assert.equal(attempt.res.statusCode, 403);
  assert.equal(credentialCount(), 0);
});

test('F2 (audit chain step 1): a stolen passkey-login session whose step-up has gone stale cannot enroll the thief\'s passkey', async () => {
  const sessionId = createSession({ authMethod: 'passkey' });
  getDb().prepare('UPDATE auth_sessions SET stepup_at = ? WHERE id = ?').run(Date.now() - STEPUP_WINDOW_MS - 1000, sessionId);
  const attempt = await tryRegister(`${SESSION_COOKIE_NAME}=${sessionId}`);
  assert.equal(attempt.res.statusCode, 403);
  assert.equal(credentialCount(), 0);
});

test('F2: step-up expiring between options and verify is re-checked at verify', async () => {
  const sessionId = steppedUpSession();
  const cookie = `${SESSION_COOKIE_NAME}=${sessionId}`;
  const optionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: { host: RP_HOST, cookie } });
  assert.equal(optionsRes.statusCode, 200);
  getDb().prepare('UPDATE auth_sessions SET stepup_at = ? WHERE id = ?').run(Date.now() - STEPUP_WINDOW_MS - 1000, sessionId);
  const { publicKey } = generateAuthenticatorKeyPair();
  const response = createRegistrationResponse({ rpID: RP_HOST, origin: ORIGIN, challenge: optionsRes.json().challenge, credentialId: randomBytes(16), publicKey });
  const verifyRes = await app.inject({
    method: 'POST', url: '/api/auth/webauthn/register-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowIdFrom(optionsRes)}; ${cookie}` }, payload: { response },
  });
  assert.equal(verifyRes.statusCode, 403);
  assert.equal(credentialCount(), 0);
});

test('F2: an --allow-passkey-registration token session registers exactly ONE passkey (bootstrap), then the grant is spent', async () => {
  const cookie = await loginWithToken({ allowPasskeyRegistration: true });
  const sessionId = cookie.split('=')[1];
  const row = getDb().prepare('SELECT auth_method, registration_grant FROM auth_sessions WHERE id = ?').get(sessionId);
  assert.equal(row.auth_method, 'login-token');
  assert.equal(row.registration_grant, 1);

  const first = await tryRegister(cookie);
  assert.equal(first.res.statusCode, 200, first.res.body);
  assert.equal(credentialCount(), 1);
  assert.equal(getDb().prepare('SELECT registration_grant FROM auth_sessions WHERE id = ?').get(sessionId).registration_grant, 0);

  const second = await tryRegister(cookie);
  assert.equal(second.res.statusCode, 403, 'grant is single-use');
  assert.equal(credentialCount(), 1);
});

test('F2: the grant is not spent by merely requesting options, and two concurrent ceremonies cannot both use it', async () => {
  const cookie = await loginWithToken({ allowPasskeyRegistration: true });
  const optsA = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: { host: RP_HOST, cookie } });
  const optsB = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: { host: RP_HOST, cookie } });
  assert.equal(optsA.statusCode, 200);
  assert.equal(optsB.statusCode, 200, 'options alone does not consume the grant');
  const verify = async (optsRes) => {
    const { publicKey } = generateAuthenticatorKeyPair();
    const response = createRegistrationResponse({ rpID: RP_HOST, origin: ORIGIN, challenge: optsRes.json().challenge, credentialId: randomBytes(16), publicKey });
    return app.inject({
      method: 'POST', url: '/api/auth/webauthn/register-verify',
      headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowIdFrom(optsRes)}; ${cookie}` }, payload: { response },
    });
  };
  const [a, b] = await Promise.all([verify(optsA), verify(optsB)]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 403]);
  assert.equal(credentialCount(), 1);
});

test('F2: a plain login-token session can register after a fresh passkey step-up (stepup-options/verify)', async () => {
  // An existing passkey (registered via the bootstrap grant).
  const bootstrap = await tryRegister(await loginWithToken({ allowPasskeyRegistration: true }));
  assert.equal(bootstrap.res.statusCode, 200);

  const cookie = await loginWithToken();
  assert.equal((await tryRegister(cookie)).res.statusCode, 403, 'no step-up yet');

  const optionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/stepup-options', headers: { host: RP_HOST, cookie } });
  assert.equal(optionsRes.statusCode, 200);
  const options = optionsRes.json();
  assert.equal(options.userVerification, 'required');
  assert.deepEqual(options.allowCredentials.map((c) => c.id), [bootstrap.credentialId.toString('base64url')]);
  const response = createAuthenticationResponse({
    rpID: RP_HOST, origin: ORIGIN, challenge: options.challenge,
    credentialId: bootstrap.credentialId, privateKey: bootstrap.privateKey, counter: 1,
  });
  const verifyRes = await app.inject({
    method: 'POST', url: '/api/auth/webauthn/stepup-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowIdFrom(optionsRes)}; ${cookie}` }, payload: { response },
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);

  const after = await tryRegister(cookie);
  assert.equal(after.res.statusCode, 200, after.res.body);
  assert.equal(credentialCount(), 2);
});

test('F2: stepup-verify rejects a forged assertion and grants nothing', async () => {
  const bootstrap = await tryRegister(await loginWithToken({ allowPasskeyRegistration: true }));
  const cookie = await loginWithToken();
  const optionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/stepup-options', headers: { host: RP_HOST, cookie } });
  const { privateKey: attackerKey } = generateAuthenticatorKeyPair();
  const response = createAuthenticationResponse({
    rpID: RP_HOST, origin: ORIGIN, challenge: optionsRes.json().challenge,
    credentialId: bootstrap.credentialId, privateKey: attackerKey, counter: 1, // wrong key
  });
  const verifyRes = await app.inject({
    method: 'POST', url: '/api/auth/webauthn/stepup-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowIdFrom(optionsRes)}; ${cookie}` }, payload: { response },
  });
  assert.equal(verifyRes.statusCode, 401);
  assert.equal((await tryRegister(cookie)).res.statusCode, 403);
});

test('F2: stepup-verify without a session -> 401', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/webauthn/stepup-verify', payload: { response: {} } });
  assert.equal(res.statusCode, 401);
});

test('F2: a passkey login alone is not a step-up -- registering another passkey still needs stepup-* (plan §2.3(b))', async () => {
  const cred = await tryRegister(await loginWithToken({ allowPasskeyRegistration: true }));
  const optionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/authenticate-options', headers: { host: RP_HOST } });
  const response = createAuthenticationResponse({
    rpID: RP_HOST, origin: ORIGIN, challenge: optionsRes.json().challenge,
    credentialId: cred.credentialId, privateKey: cred.privateKey, counter: 1,
  });
  const res = await app.inject({
    method: 'POST', url: '/api/auth/webauthn/authenticate-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowIdFrom(optionsRes)}` }, payload: { response },
  });
  assert.equal(res.statusCode, 200);
  const sessionId = findCookie(res, SESSION_COOKIE_NAME).split(';')[0].split('=')[1];
  const row = getDb().prepare('SELECT auth_method, credential_id, stepup_at, registration_grant FROM auth_sessions WHERE id = ?').get(sessionId);
  assert.equal(row.auth_method, 'passkey');
  assert.equal(row.credential_id, cred.credentialId.toString('base64url'));
  assert.equal(row.stepup_at, null);
  assert.equal(row.registration_grant, 0);
  const attempt = await tryRegister(`${SESSION_COOKIE_NAME}=${sessionId}`);
  assert.equal(attempt.res.statusCode, 403);
});
