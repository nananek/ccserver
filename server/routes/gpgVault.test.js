// POST/GET /api/gpg-vault/* (plan: gpg-agent-vault): drives real
// register->PRF-step-up round trips through @simplewebauthn/server's actual
// verification code (webauthnTestAuthenticator.js stands in for a browser +
// PRF-capable authenticator), and, where the ceremony succeeds, exercises
// the real gpgVaultAgent.js lifecycle against real gpg/gpgconf binaries --
// skipped cleanly on a host without them (this dev host has GnuPG 2.4.9,
// same posture as gpgVaultAgent.test.js).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getDb, closeDb } from '../db.js';
import { FLOW_COOKIE_NAME } from '../webauthnChallenges.js';
import { generateAuthenticatorKeyPair, createRegistrationResponse, createAuthenticationResponse } from './webauthnTestAuthenticator.js';
import { authRoute } from './auth.js';
import { gpgVaultRoute } from './gpgVault.js';
import { gpgVaultToolsAvailable, isUnlocked, lockVault } from '../ws/gpgVaultAgent.js';

const RP_HOST = 'ccserver.test';
const ORIGIN = `http://${RP_HOST}`;
const TOOLS_AVAILABLE = gpgVaultToolsAvailable();

let tmpRoot;
let app;
const savedDbPath = process.env.CCSERVER_DB_PATH;
const savedAuthMode = process.env.CCSERVER_AUTH_MODE;
const savedRuntimeDir = process.env.XDG_RUNTIME_DIR;
const savedHomeRoot = process.env.CCSERVER_SANDBOX_HOME_ROOT;

// This test's OWN scratch runtime dir, captured once so cleanup below can
// never accidentally target the real XDG_RUNTIME_DIR -- see
// gpgVaultAgent.test.js's identical `testRuntimeDir` comment for the
// incident (a real /run/user/<uid> deletion) this guards against. Always
// derive a cleanup rmSync path from a captured constant, never from
// process.env after it may have been restored.
const testRuntimeDir = `/tmp/cgvr${process.pid}`;

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-gpgvault-route-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  // Isolates the v2 migration's legacy-sidecar-index read from any real host
  // state (see db.test.js, which does the same for the same reason).
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
  // Short, private runtime dir -- see gpgVaultAgent.test.js's header comment
  // on why this must be short, not merely short-ish.
  process.env.XDG_RUNTIME_DIR = testRuntimeDir;
  app = Fastify();
  await app.register(authRoute, { prefix: '/api' });
  await app.register(gpgVaultRoute, { prefix: '/api' });
});

after(async () => {
  await app.close();
  closeDb();
  try { rmSync(testRuntimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (savedDbPath === undefined) delete process.env.CCSERVER_DB_PATH; else process.env.CCSERVER_DB_PATH = savedDbPath;
  if (savedAuthMode === undefined) delete process.env.CCSERVER_AUTH_MODE; else process.env.CCSERVER_AUTH_MODE = savedAuthMode;
  if (savedRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = savedRuntimeDir;
  if (savedHomeRoot === undefined) delete process.env.CCSERVER_SANDBOX_HOME_ROOT; else process.env.CCSERVER_SANDBOX_HOME_ROOT = savedHomeRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  lockVault();
  closeDb();
  const db = getDb();
  db.exec('DELETE FROM gpg_vault_credentials');
  db.exec('DELETE FROM gpg_vault');
  db.exec('DELETE FROM webauthn_credentials');
  db.exec('DELETE FROM auth_sessions');
  process.env.CCSERVER_AUTH_MODE = 'passkey';
});

function findCookie(res, name) {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return null;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match || null;
}

function flowIdFrom(res) {
  const cookie = findCookie(res, FLOW_COOKIE_NAME);
  return cookie ? cookie.match(new RegExp(`${FLOW_COOKIE_NAME}=([^;]+)`))[1] : null;
}

// Registers a passkey via the real auth.js flow (so it exists in
// webauthn_credentials just like a real login would create it) and returns
// its keypair/id for driving later PRF step-up ceremonies.
async function registerCredential() {
  const optionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: { host: RP_HOST } });
  const options = optionsRes.json();
  const flowId = flowIdFrom(optionsRes);
  const { publicKey, privateKey } = generateAuthenticatorKeyPair();
  const credentialId = randomBytes(16);
  const response = createRegistrationResponse({ rpID: RP_HOST, origin: ORIGIN, challenge: options.challenge, credentialId, publicKey });
  const verifyRes = await app.inject({
    method: 'POST', url: '/api/auth/webauthn/register-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowId}` },
    payload: { response },
  });
  assert.equal(verifyRes.statusCode, 200, `register-verify failed: ${verifyRes.body}`);
  return { credentialId, privateKey };
}

// Drives a full <kind>-options -> PRF assertion round trip against
// `optionsUrl`, faking a PRF result on the assertion (see
// webauthnTestAuthenticator.js's header comment on why this is legitimate).
async function prfStepUp(optionsUrl, { credentialId, privateKey, prfResultFirst }) {
  const optionsRes = await app.inject({ method: 'POST', url: optionsUrl, headers: { host: RP_HOST } });
  const options = optionsRes.json();
  const flowId = flowIdFrom(optionsRes);
  const response = createAuthenticationResponse({
    rpID: RP_HOST, origin: ORIGIN, challenge: options.challenge,
    credentialId, privateKey, counter: 1, prfResultFirst,
  });
  return { flowId, response };
}

const IDENTITY = { nameReal: 'ccserver test', nameEmail: 'ccserver-test@example.invalid' };

test('gpgVaultToolsAvailable is a boolean (sanity)', () => {
  assert.equal(typeof TOOLS_AVAILABLE, 'boolean');
});

test('every /api/gpg-vault/* route rejects with 400 outside passkey mode', async () => {
  process.env.CCSERVER_AUTH_MODE = 'token';
  const routes = [
    ['GET', '/api/gpg-vault/status'],
    ['GET', '/api/gpg-vault/github-info'],
    ['POST', '/api/gpg-vault/setup-options'],
    ['POST', '/api/gpg-vault/setup-verify'],
    ['POST', '/api/gpg-vault/unlock-options'],
    ['POST', '/api/gpg-vault/unlock-verify'],
    ['POST', '/api/gpg-vault/lock'],
    ['POST', '/api/gpg-vault/credentials/add-options'],
    ['POST', '/api/gpg-vault/credentials/add-verify'],
  ];
  for (const [method, url] of routes) {
    const res = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
    assert.equal(res.statusCode, 400, `${method} ${url} should 400 outside passkey mode`);
  }
});

test('GET /api/gpg-vault/status: reports exists:false/unlocked:false before any setup', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/gpg-vault/status' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    exists: false, unlocked: false, toolsAvailable: TOOLS_AVAILABLE, credentialCount: 0, fingerprint: null, keyId: null,
  });
});

test('GET /api/gpg-vault/github-info: 404 before any setup', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/gpg-vault/github-info' });
  assert.equal(res.statusCode, 404);
});

test('POST /api/gpg-vault/setup-verify: 400 for an invalid identity (short name / bad email), without consuming the ceremony', { skip: !TOOLS_AVAILABLE }, async () => {
  const { credentialId, privateKey } = await registerCredential();
  const { flowId, response } = await prfStepUp('/api/gpg-vault/setup-options', {
    credentialId, privateKey, prfResultFirst: randomBytes(32),
  });
  const res = await app.inject({
    method: 'POST', url: '/api/gpg-vault/setup-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowId}` },
    payload: { response, nameReal: 'ab', nameEmail: 'not-an-email' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(isUnlocked(), false);
});

test('POST /api/gpg-vault/setup-verify: 401 when the authenticator has no PRF result', { skip: !TOOLS_AVAILABLE }, async () => {
  const { credentialId, privateKey } = await registerCredential();
  const { flowId, response } = await prfStepUp('/api/gpg-vault/setup-options', { credentialId, privateKey }); // no prfResultFirst
  const res = await app.inject({
    method: 'POST', url: '/api/gpg-vault/setup-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${flowId}` },
    payload: { response, ...IDENTITY },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(isUnlocked(), false);
});

test('full happy path: setup -> status -> github-info -> lock -> unlock-options scoped to enrolled creds -> unlock -> add-credential -> second credential unlocks', { skip: !TOOLS_AVAILABLE }, async () => {
  const cred1 = await registerCredential();
  const secret1 = randomBytes(32);

  const setup = await prfStepUp('/api/gpg-vault/setup-options', { ...cred1, prfResultFirst: secret1 });
  const setupRes = await app.inject({
    method: 'POST', url: '/api/gpg-vault/setup-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${setup.flowId}` },
    payload: { response: setup.response, ...IDENTITY },
  });
  assert.equal(setupRes.statusCode, 200, `setup-verify failed: ${setupRes.body}`);
  const setupBody = setupRes.json();
  assert.equal(setupBody.success, true);
  assert.match(setupBody.vault.sshPublicKey, /^ssh-ed25519 /);
  assert.equal(setupBody.vault.nameEmail, IDENTITY.nameEmail);
  assert.equal(isUnlocked(), true, 'setup leaves the vault unlocked');

  const statusRes = await app.inject({ method: 'GET', url: '/api/gpg-vault/status' });
  const status = statusRes.json();
  assert.equal(status.exists, true);
  assert.equal(status.unlocked, true);
  assert.equal(status.credentialCount, 1);
  assert.equal(status.fingerprint, setupBody.vault.fingerprint);

  const githubInfoRes = await app.inject({ method: 'GET', url: '/api/gpg-vault/github-info' });
  assert.equal(githubInfoRes.statusCode, 200);
  const githubInfo = githubInfoRes.json();
  assert.equal(githubInfo.sshPublicKey, setupBody.vault.sshPublicKey);
  assert.equal('encryptedSecretKey' in githubInfo, false);

  // A second, not-yet-enrolled credential.
  const cred2 = await registerCredential();
  const secret2 = randomBytes(32);

  // add-credential requires the vault to be unlocked -- it is, right now.
  const addOpts = await prfStepUp('/api/gpg-vault/credentials/add-options', { ...cred2, prfResultFirst: secret2 });
  const addRes = await app.inject({
    method: 'POST', url: '/api/gpg-vault/credentials/add-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${addOpts.flowId}` },
    payload: { response: addOpts.response },
  });
  assert.equal(addRes.statusCode, 200, `add-verify failed: ${addRes.body}`);
  assert.equal((await app.inject({ method: 'GET', url: '/api/gpg-vault/status' })).json().credentialCount, 2);

  // Lock, then confirm unlock-options is scoped to enrolled credentials only.
  const lockRes = await app.inject({ method: 'POST', url: '/api/gpg-vault/lock' });
  assert.equal(lockRes.statusCode, 200);
  assert.equal(isUnlocked(), false);

  const unlockOptsRes = await app.inject({ method: 'POST', url: '/api/gpg-vault/unlock-options', headers: { host: RP_HOST } });
  const unlockOpts = unlockOptsRes.json();
  const allowedIds = unlockOpts.allowCredentials.map((c) => c.id).sort();
  assert.deepEqual(allowedIds, [cred1.credentialId.toString('base64url'), cred2.credentialId.toString('base64url')].sort());

  // Unlock with the SECOND credential -- proves both independently unlock the same vault.
  const unlockFlowId = flowIdFrom(unlockOptsRes);
  const unlockResponse = createAuthenticationResponse({
    rpID: RP_HOST, origin: ORIGIN, challenge: unlockOpts.challenge,
    credentialId: cred2.credentialId, privateKey: cred2.privateKey, counter: 2, prfResultFirst: secret2,
  });
  const unlockRes = await app.inject({
    method: 'POST', url: '/api/gpg-vault/unlock-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${unlockFlowId}` },
    payload: { response: unlockResponse },
  });
  assert.equal(unlockRes.statusCode, 200, `unlock-verify failed: ${unlockRes.body}`);
  assert.equal(unlockRes.json().vault.fingerprint, setupBody.vault.fingerprint);
  assert.equal(isUnlocked(), true);
});

test('POST /api/gpg-vault/unlock-verify: wrong PRF secret for an enrolled credential fails closed (401), vault stays locked', { skip: !TOOLS_AVAILABLE }, async () => {
  const cred1 = await registerCredential();
  const secret1 = randomBytes(32);
  const setup = await prfStepUp('/api/gpg-vault/setup-options', { ...cred1, prfResultFirst: secret1 });
  await app.inject({
    method: 'POST', url: '/api/gpg-vault/setup-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${setup.flowId}` },
    payload: { response: setup.response, ...IDENTITY },
  });
  await app.inject({ method: 'POST', url: '/api/gpg-vault/lock' });
  assert.equal(isUnlocked(), false);

  const unlockOptsRes = await app.inject({ method: 'POST', url: '/api/gpg-vault/unlock-options', headers: { host: RP_HOST } });
  const unlockOpts = unlockOptsRes.json();
  const unlockFlowId = flowIdFrom(unlockOptsRes);
  const wrongResponse = createAuthenticationResponse({
    rpID: RP_HOST, origin: ORIGIN, challenge: unlockOpts.challenge,
    credentialId: cred1.credentialId, privateKey: cred1.privateKey, counter: 5, prfResultFirst: randomBytes(32), // wrong secret
  });
  const res = await app.inject({
    method: 'POST', url: '/api/gpg-vault/unlock-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${unlockFlowId}` },
    payload: { response: wrongResponse },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(isUnlocked(), false);
});

test('POST /api/gpg-vault/credentials/add-options: 423 while the vault is locked', { skip: !TOOLS_AVAILABLE }, async () => {
  const cred1 = await registerCredential();
  const setup = await prfStepUp('/api/gpg-vault/setup-options', { ...cred1, prfResultFirst: randomBytes(32) });
  await app.inject({
    method: 'POST', url: '/api/gpg-vault/setup-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${setup.flowId}` },
    payload: { response: setup.response, ...IDENTITY },
  });
  await app.inject({ method: 'POST', url: '/api/gpg-vault/lock' });
  const res = await app.inject({ method: 'POST', url: '/api/gpg-vault/credentials/add-options', headers: { host: RP_HOST } });
  assert.equal(res.statusCode, 423);
});

test('POST /api/gpg-vault/setup-options: 409 once a vault already exists', { skip: !TOOLS_AVAILABLE }, async () => {
  const cred1 = await registerCredential();
  const setup = await prfStepUp('/api/gpg-vault/setup-options', { ...cred1, prfResultFirst: randomBytes(32) });
  await app.inject({
    method: 'POST', url: '/api/gpg-vault/setup-verify',
    headers: { host: RP_HOST, cookie: `${FLOW_COOKIE_NAME}=${setup.flowId}` },
    payload: { response: setup.response, ...IDENTITY },
  });
  const res = await app.inject({ method: 'POST', url: '/api/gpg-vault/setup-options', headers: { host: RP_HOST } });
  assert.equal(res.statusCode, 409);
});

test('POST /api/gpg-vault/unlock-options: 404 when no vault has been set up yet', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/gpg-vault/unlock-options', headers: { host: RP_HOST } });
  assert.equal(res.statusCode, 404);
});
