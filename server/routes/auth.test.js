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
import { SESSION_COOKIE_NAME } from '../authSessions.js';
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

beforeEach(() => {
  closeDb();
  const db = getDb();
  db.exec('DELETE FROM login_tokens');
  db.exec('DELETE FROM auth_sessions');
  db.exec('DELETE FROM webauthn_credentials');
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
    headers: { host: RP_HOST },
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
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowId}` },
    payload: label === undefined ? { response } : { response, label },
  });
  assert.equal(verifyRes.statusCode, 200, `register-verify failed: ${verifyRes.body}`);
  return { credentialId, privateKey, verifyRes };
}

test('POST /api/auth/webauthn/register-options: 400 when CCSERVER_AUTH_MODE is not passkey', async () => {
  process.env.CCSERVER_AUTH_MODE = 'token';
  const res = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: { host: RP_HOST } });
  assert.equal(res.statusCode, 400);
});

test('POST /api/auth/webauthn/register-options: returns discoverable-credential options and a flow cookie', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: { host: RP_HOST } });
  assert.equal(res.statusCode, 200);
  const options = res.json();
  assert.equal(options.rp.id, RP_HOST);
  assert.equal(options.user.name, 'ccserver');
  assert.equal(options.authenticatorSelection.residentKey, 'required');
  assert.ok(typeof options.challenge === 'string' && options.challenge.length > 0);
  assert.ok(flowIdFrom(res), 'a flow cookie was set');
});

test('POST /api/auth/webauthn/register-options: excludes already-registered credential ids', async () => {
  const { credentialId } = await registerCredential();
  const res = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: { host: RP_HOST } });
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
  const res = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-verify', payload: {} });
  assert.equal(res.statusCode, 400);
});

test('POST /api/auth/webauthn/register-verify: 401 with no flow cookie at all', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-verify', payload: { response: {} } });
  assert.equal(res.statusCode, 401);
});

test('POST /api/auth/webauthn/register-verify: 401 when the flow cookie is an authenticate (wrong-kind) flow', async () => {
  const optionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/authenticate-options', headers: { host: RP_HOST } });
  const flowId = flowIdFrom(optionsRes);
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/webauthn/register-verify',
    headers: { cookie: `${FLOW_COOKIE_NAME}=${flowId}` },
    payload: { response: {} },
  });
  assert.equal(res.statusCode, 401);
});

test('POST /api/auth/webauthn/register-verify: 401 for a response that fails verification (bad signature/challenge)', async () => {
  const optionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: { host: RP_HOST } });
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
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowId}` },
    payload: { response },
  });
  assert.equal(res.statusCode, 401);
});

test('POST /api/auth/webauthn/register-verify: 401 when the response was built for a different rpID', async () => {
  const optionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: { host: RP_HOST } });
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
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowId}` },
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
  const optionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: { host: RP_HOST } });
  const options = optionsRes.json();
  const flowId = flowIdFrom(optionsRes);
  const { publicKey } = generateAuthenticatorKeyPair();
  const credentialId = randomBytes(16);
  const response = createRegistrationResponse({ rpID: RP_HOST, origin: ORIGIN, challenge: options.challenge, credentialId, publicKey });

  const cookieHeader = { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowId}` };
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
    headers: { cookie: `${FLOW_COOKIE_NAME}=${flowId}` },
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
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowId}` },
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

  const cookieHeader = { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowId}` };
  const first = await app.inject({ method: 'POST', url: '/api/auth/webauthn/authenticate-verify', headers: cookieHeader, payload: { response } });
  assert.equal(first.statusCode, 200);
  const second = await app.inject({ method: 'POST', url: '/api/auth/webauthn/authenticate-verify', headers: cookieHeader, payload: { response } });
  assert.equal(second.statusCode, 401);
});
