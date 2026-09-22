// POST/GET /api/gpg-vault/* (plan: gpg-agent-vault): drives real
// register->PRF-step-up round trips through @simplewebauthn/server's actual
// verification code (webauthnTestAuthenticator.js stands in for a browser +
// PRF-capable authenticator, with simulatePrf() as a deterministic
// hmac-secret), and, where the ceremony succeeds, exercises the real
// gpgVaultAgent.js lifecycle against real gpg/gpgconf binaries -- skipped
// cleanly on a host without them (same posture as gpgVaultAgent.test.js).
//
// The "F2"/"F6"/"F1.4" tests replay the security audit's attack chains
// (doc "security-audit-passkey-prf-gpgvault") against the remediated routes.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getDb, closeDb } from '../db.js';
import { FLOW_COOKIE_NAME } from '../webauthnChallenges.js';
import { SESSION_COOKIE_NAME, createSession, markStepUp, STEPUP_WINDOW_MS } from '../authSessions.js';
import {
  generateAuthenticatorKeyPair,
  createRegistrationResponse,
  createAuthenticationResponse,
  simulatePrf,
} from './webauthnTestAuthenticator.js';
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

// The owner's browser session: logged in with a passkey moments ago, so it
// carries a fresh step-up (and may therefore register passkeys).
let ownerCookie;

// A passkey-login session that has also completed an explicit step-up.
function steppedUpSession() {
  const id = createSession({ authMethod: 'passkey' });
  markStepUp(id, null);
  return id;
}

beforeEach(() => {
  lockVault();
  closeDb();
  const db = getDb();
  db.exec('DELETE FROM gpg_vault_credentials');
  db.exec('DELETE FROM gpg_vault');
  db.exec('DELETE FROM webauthn_credentials');
  db.exec('DELETE FROM auth_sessions');
  process.env.CCSERVER_AUTH_MODE = 'passkey';
  ownerCookie = `${SESSION_COOKIE_NAME}=${steppedUpSession()}`;
});

function findCookie(res, name) {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return null;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  return cookies.find((c) => c.startsWith(`${name}=`)) || null;
}

function flowIdFrom(res) {
  const cookie = findCookie(res, FLOW_COOKIE_NAME);
  return cookie ? cookie.match(new RegExp(`${FLOW_COOKIE_NAME}=([^;]+)`))[1] : null;
}

function headers(flowId, sessionCookie = ownerCookie) {
  return { host: RP_HOST, cookie: [flowId && `${FLOW_COOKIE_NAME}=${flowId}`, sessionCookie].filter(Boolean).join('; ') };
}

// Registers a passkey via the real auth.js flow as the owner's session and
// returns a simulated authenticator: keypair, id, its own PRF secret, and a
// monotonically increasing signature counter.
async function registerCredential(sessionCookie = ownerCookie) {
  const optionsRes = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: headers(null, sessionCookie) });
  assert.equal(optionsRes.statusCode, 200, `register-options failed: ${optionsRes.body}`);
  const { publicKey, privateKey } = generateAuthenticatorKeyPair();
  const credentialId = randomBytes(16);
  const response = createRegistrationResponse({ rpID: RP_HOST, origin: ORIGIN, challenge: optionsRes.json().challenge, credentialId, publicKey });
  const verifyRes = await app.inject({
    method: 'POST', url: '/api/auth/webauthn/register-verify',
    headers: headers(flowIdFrom(optionsRes), sessionCookie), payload: { response },
  });
  assert.equal(verifyRes.statusCode, 200, `register-verify failed: ${verifyRes.body}`);
  return { credentialId, id: credentialId.toString('base64url'), privateKey, prfSecret: randomBytes(32), counter: 0 };
}

// The PRF salts the server asked this credential to evaluate, from either
// evalByCredential (enrolled-credential ceremonies) or eval (setup /
// add-credential's candidate).
function saltsFor(options, cred) {
  const prf = options.extensions?.prf || {};
  return prf.evalByCredential?.[cred.id] ?? prf.eval ?? null;
}

// What the authenticator would return for `options`: a signed assertion plus
// PRF results over the requested salts. `prfFirst`/`prfSecond` override the
// honest values (to forge or replay).
function assertion(cred, options, { prfFirst, prfSecond, noPrf = false } = {}) {
  const salts = saltsFor(options, cred);
  cred.counter += 1;
  return createAuthenticationResponse({
    rpID: RP_HOST, origin: ORIGIN, challenge: options.challenge,
    credentialId: cred.credentialId, privateKey: cred.privateKey, counter: cred.counter,
    prfResultFirst: noPrf ? undefined : (prfFirst ?? (salts?.first && simulatePrf(cred.prfSecret, salts.first))),
    prfResultSecond: noPrf ? undefined : (prfSecond ?? (salts?.second && simulatePrf(cred.prfSecret, salts.second))),
  });
}

async function post(url, { flowId = null, payload, sessionCookie = ownerCookie } = {}) {
  return app.inject({ method: 'POST', url, headers: headers(flowId, sessionCookie), payload });
}

const IDENTITY = { nameReal: 'ccserver test', nameEmail: 'ccserver-test@example.invalid' };

async function setUpVault(cred) {
  const optsRes = await post('/api/gpg-vault/setup-options');
  assert.equal(optsRes.statusCode, 200, optsRes.body);
  const res = await post('/api/gpg-vault/setup-verify', {
    flowId: flowIdFrom(optsRes), payload: { response: assertion(cred, optsRes.json()), ...IDENTITY },
  });
  assert.equal(res.statusCode, 200, `setup-verify failed: ${res.body}`);
  return res.json().vault;
}

async function unlock(cred, overrides = {}) {
  const optsRes = await post('/api/gpg-vault/unlock-options');
  assert.equal(optsRes.statusCode, 200, optsRes.body);
  const options = optsRes.json();
  const response = assertion(cred, options, overrides);
  const res = await post('/api/gpg-vault/unlock-verify', { flowId: flowIdFrom(optsRes), payload: { response } });
  return { res, options, response };
}

async function addCredential(authorizerCred, candidateCred, { authorizerOverrides = {}, candidateOverrides = {} } = {}) {
  const optsRes = await post('/api/gpg-vault/credentials/add-options');
  if (optsRes.statusCode !== 200) return optsRes;
  const { authorizer, candidate } = optsRes.json();
  return post('/api/gpg-vault/credentials/add-verify', {
    flowId: flowIdFrom(optsRes),
    payload: {
      authorizer: assertion(authorizerCred, authorizer, authorizerOverrides),
      candidate: assertion(candidateCred, candidate, candidateOverrides),
    },
  });
}

function wrapRow(cred) {
  return getDb().prepare('SELECT wrapped_key, prf_salt FROM gpg_vault_credentials WHERE credential_id = ?').get(cred.id);
}

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
    ['POST', '/api/gpg-vault/delete-options'],
    ['POST', '/api/gpg-vault/delete'],
  ];
  for (const [method, url] of routes) {
    const res = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
    assert.equal(res.statusCode, 400, `${method} ${url} should 400 outside passkey mode`);
  }
});

test('GET /api/gpg-vault/status: reports exists:false/unlocked:false/legacyDisabled:false before any setup', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/gpg-vault/status' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    exists: false, unlocked: false, legacyDisabled: false, toolsAvailable: TOOLS_AVAILABLE, credentialCount: 0, fingerprint: null, keyId: null,
  });
});

test('GET /api/gpg-vault/github-info: 404 before any setup', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/gpg-vault/github-info' });
  assert.equal(res.statusCode, 404);
});

test('POST /api/gpg-vault/unlock-options: 404 when no vault has been set up yet', async () => {
  const res = await post('/api/gpg-vault/unlock-options');
  assert.equal(res.statusCode, 404);
});

test('POST /api/gpg-vault/setup-verify: 400 for an invalid identity (short name / bad email), without consuming the ceremony', { skip: !TOOLS_AVAILABLE }, async () => {
  const cred = await registerCredential();
  const optsRes = await post('/api/gpg-vault/setup-options');
  const res = await post('/api/gpg-vault/setup-verify', {
    flowId: flowIdFrom(optsRes), payload: { response: assertion(cred, optsRes.json()), nameReal: 'ab', nameEmail: 'not-an-email' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(isUnlocked(), false);
});

test('POST /api/gpg-vault/setup-verify: 401 when the authenticator has no PRF result', { skip: !TOOLS_AVAILABLE }, async () => {
  const cred = await registerCredential();
  const optsRes = await post('/api/gpg-vault/setup-options');
  const res = await post('/api/gpg-vault/setup-verify', {
    flowId: flowIdFrom(optsRes), payload: { response: assertion(cred, optsRes.json(), { noPrf: true }), ...IDENTITY },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(isUnlocked(), false);
});

test('F6: setup uses a fresh random per-ceremony PRF salt, stored with the wrap; the vault is post-fix (format 2)', { skip: !TOOLS_AVAILABLE }, async () => {
  const cred = await registerCredential();
  const a = (await post('/api/gpg-vault/setup-options')).json();
  const optsRes = await post('/api/gpg-vault/setup-options');
  const b = optsRes.json();
  assert.notEqual(a.extensions.prf.eval.first, b.extensions.prf.eval.first, 'no fixed public salt any more');
  const res = await post('/api/gpg-vault/setup-verify', { flowId: flowIdFrom(optsRes), payload: { response: assertion(cred, b), ...IDENTITY } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(Buffer.from(wrapRow(cred).prf_salt).toString('base64url'), b.extensions.prf.eval.first);
  assert.equal(getDb().prepare('SELECT format_version FROM gpg_vault').get().format_version, 2);
});

test('full happy path: setup -> status -> github-info -> add-credential -> lock -> unlock-options scoped to enrolled creds -> second credential unlocks', { skip: !TOOLS_AVAILABLE }, async () => {
  const cred1 = await registerCredential();
  const vault = await setUpVault(cred1);
  assert.match(vault.sshPublicKey, /^ssh-ed25519 /);
  assert.equal(vault.nameEmail, IDENTITY.nameEmail);
  assert.equal(isUnlocked(), true, 'setup leaves the vault unlocked');

  const status = (await app.inject({ method: 'GET', url: '/api/gpg-vault/status' })).json();
  assert.equal(status.exists, true);
  assert.equal(status.unlocked, true);
  assert.equal(status.legacyDisabled, false);
  assert.equal(status.credentialCount, 1);
  assert.equal(status.fingerprint, vault.fingerprint);

  const githubInfo = (await app.inject({ method: 'GET', url: '/api/gpg-vault/github-info' })).json();
  assert.equal(githubInfo.sshPublicKey, vault.sshPublicKey);
  assert.equal('encryptedSecretKey' in githubInfo, false);

  const cred2 = await registerCredential();
  const addRes = await addCredential(cred1, cred2);
  assert.equal(addRes.statusCode, 200, `add-verify failed: ${addRes.body}`);
  assert.equal((await app.inject({ method: 'GET', url: '/api/gpg-vault/status' })).json().credentialCount, 2);

  assert.equal((await post('/api/gpg-vault/lock')).statusCode, 200);
  assert.equal(isUnlocked(), false);

  const unlockOpts = (await post('/api/gpg-vault/unlock-options')).json();
  assert.deepEqual(unlockOpts.allowCredentials.map((c) => c.id).sort(), [cred1.id, cred2.id].sort());
  assert.deepEqual(Object.keys(unlockOpts.extensions.prf.evalByCredential).sort(), [cred1.id, cred2.id].sort());

  const { res } = await unlock(cred2);
  assert.equal(res.statusCode, 200, `unlock-verify failed: ${res.body}`);
  assert.equal(res.json().vault.fingerprint, vault.fingerprint);
  assert.equal(isUnlocked(), true);
});

test('POST /api/gpg-vault/unlock-verify: wrong PRF secret for an enrolled credential fails closed (401), vault stays locked', { skip: !TOOLS_AVAILABLE }, async () => {
  const cred = await registerCredential();
  await setUpVault(cred);
  await post('/api/gpg-vault/lock');
  const { res } = await unlock(cred, { prfFirst: randomBytes(32) });
  assert.equal(res.statusCode, 401);
  assert.equal(isUnlocked(), false);
});

test('POST /api/gpg-vault/setup-options: 409 once a vault already exists', { skip: !TOOLS_AVAILABLE }, async () => {
  await setUpVault(await registerCredential());
  assert.equal((await post('/api/gpg-vault/setup-options')).statusCode, 409);
});

// ---------------------------------------------------------------------------
// PRF salt rotation is DISABLED (vuln_scan M4, decision 2026-09-22).

test('rotation disabled: unlock keeps the same salt and wrap, rotated=false', { skip: !TOOLS_AVAILABLE }, async () => {
  const cred = await registerCredential();
  await setUpVault(cred);
  await post('/api/gpg-vault/lock');
  const saltBefore = Buffer.from(wrapRow(cred).prf_salt);

  const first = await unlock(cred);
  assert.equal(first.res.statusCode, 200, first.res.body);
  assert.equal(first.res.json().vault.rotated, false);
  assert.deepEqual(Buffer.from(wrapRow(cred).prf_salt), saltBefore, 'salt unchanged');

  // The same PRF output keeps unlocking afterwards (no expiry).
  await post('/api/gpg-vault/lock');
  const again = await unlock(cred);
  assert.equal(again.res.statusCode, 200, again.res.body);
});

test('unlock-options no longer requests a second (next-salt) PRF evaluation', { skip: !TOOLS_AVAILABLE }, async () => {
  const cred = await registerCredential();
  await setUpVault(cred);
  await post('/api/gpg-vault/lock');
  const optsRes = await post('/api/gpg-vault/unlock-options');
  assert.equal(optsRes.statusCode, 200, optsRes.body);
  const entry = optsRes.json().extensions?.prf?.evalByCredential?.[cred.id];
  assert.ok(entry?.first, 'first (current salt) requested');
  assert.equal(entry.second, undefined, 'no second salt requested (rotation disabled)');
});

test('M4: a fabricated PRF `second` cannot re-wrap the vault key (no permanent lockout)', { skip: !TOOLS_AVAILABLE }, async () => {
  const cred = await registerCredential();
  await setUpVault(cred);
  await post('/api/gpg-vault/lock');
  const saltBefore = Buffer.from(wrapRow(cred).prf_salt);
  const wrapBefore = Buffer.from(wrapRow(cred).wrapped_key);

  // The client lies about a `second` value: previously this re-wrapped the
  // vault key under the forged value, so the owner's authenticator could
  // never unlock again (vuln_scan p8 PoC).
  const forgedSecond = randomBytes(32);
  const first = await unlock(cred, { prfSecond: forgedSecond });
  assert.equal(first.res.statusCode, 200, first.res.body);
  assert.equal(first.res.json().vault.rotated, false);
  assert.deepEqual(Buffer.from(wrapRow(cred).prf_salt), saltBefore, 'salt not replaced');
  assert.deepEqual(Buffer.from(wrapRow(cred).wrapped_key), wrapBefore, 'wrap not re-wrapped');

  // No lockout: the honest authenticator (real PRF over the SAME salt)
  // still unlocks, and the forged value never became an unlock key.
  await post('/api/gpg-vault/lock');
  const honest = await unlock(cred);
  assert.equal(honest.res.statusCode, 200, honest.res.body);
  await post('/api/gpg-vault/lock');
  const forgedReplay = await unlock(cred, { prfFirst: forgedSecond });
  assert.equal(forgedReplay.res.statusCode, 401, 'forged value is not a wrapping key');
});

// ---------------------------------------------------------------------------
// F2: add-credential authorization. Replays the audit chain: a session thief
// (1) registers their own passkey, (2) add-verifies it with a forged PRF
// value while the owner has the vault unlocked, (3) unlocks alone later.

test('F2 audit chain: a session thief cannot enroll a passkey in the vault, even while the owner has it unlocked', { skip: !TOOLS_AVAILABLE }, async () => {
  const owner = await registerCredential();
  await setUpVault(owner);
  assert.equal(isUnlocked(), true, 'precondition: owner has the vault unlocked');

  // The thief's copy of the session: a real passkey-login session whose
  // step-up has aged out (they did not perform the login themselves).
  const stolenId = createSession({ authMethod: 'passkey' });
  getDb().prepare('UPDATE auth_sessions SET stepup_at = ? WHERE id = ?').run(Date.now() - STEPUP_WINDOW_MS - 1000, stolenId);
  const stolen = `${SESSION_COOKIE_NAME}=${stolenId}`;

  // (1) Registering the thief's own passkey: refused.
  const regOpts = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: headers(null, stolen) });
  assert.equal(regOpts.statusCode, 403);

  // Suppose the thief's passkey got registered anyway (belt and braces --
  // simulated through the owner's session so the stored public key is
  // genuine): the vault still refuses to enroll it.
  const { publicKey, privateKey } = generateAuthenticatorKeyPair();
  const thiefId = randomBytes(16);
  const reg = await (async () => {
    const o = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register-options', headers: headers(null, ownerCookie) });
    const r = createRegistrationResponse({ rpID: RP_HOST, origin: ORIGIN, challenge: o.json().challenge, credentialId: thiefId, publicKey });
    return app.inject({ method: 'POST', url: '/api/auth/webauthn/register-verify', headers: headers(flowIdFrom(o), ownerCookie), payload: { response: r } });
  })();
  assert.equal(reg.statusCode, 200);
  const thief = { credentialId: thiefId, id: thiefId.toString('base64url'), privateKey, prfSecret: randomBytes(32), counter: 0 };

  // (2a) The OLD request shape (one assertion + forged PRF): rejected.
  const oldOpts = await post('/api/gpg-vault/credentials/add-options', { sessionCookie: stolen });
  const old = await post('/api/gpg-vault/credentials/add-verify', {
    flowId: flowIdFrom(oldOpts), sessionCookie: stolen,
    payload: { response: assertion(thief, oldOpts.json().candidate, { prfFirst: randomBytes(32) }) },
  });
  assert.notEqual(old.statusCode, 200);

  // (2b) Thief as its own authorizer (with a PRF value of its choosing): not
  //      enrolled -> refused before the candidate is even considered.
  const selfAuth = await addCredential(thief, thief, {
    authorizerOverrides: { prfFirst: randomBytes(32) }, candidateOverrides: { prfFirst: randomBytes(32) },
  });
  assert.equal(selfAuth.statusCode, 401);

  // (2c) Thief claims the owner's credential id as authorizer, but can only
  //      sign with their own key -> signature check fails.
  const forgedOwner = { ...owner, privateKey: thief.privateKey, prfSecret: randomBytes(32) };
  const forged = await addCredential(forgedOwner, thief);
  assert.equal(forged.statusCode, 401);

  assert.equal(wrapRow(thief), undefined, 'thief passkey never got a wrap');
  assert.equal((await app.inject({ method: 'GET', url: '/api/gpg-vault/status' })).json().credentialCount, 1);

  // (3) After lock, the thief cannot unlock alone.
  await post('/api/gpg-vault/lock');
  const unlockOpts = (await post('/api/gpg-vault/unlock-options', { sessionCookie: stolen })).json();
  assert.deepEqual(unlockOpts.allowCredentials.map((c) => c.id), [owner.id], 'thief is not even offered');
  const optsRes = await post('/api/gpg-vault/unlock-options', { sessionCookie: stolen });
  const res = await post('/api/gpg-vault/unlock-verify', {
    flowId: flowIdFrom(optsRes), sessionCookie: stolen,
    payload: { response: assertion(thief, optsRes.json(), { prfFirst: randomBytes(32) }) },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(isUnlocked(), false);
});

test('F2: the authorizer PRF must actually decrypt its wrap -- a valid signature with a forged PRF is refused', { skip: !TOOLS_AVAILABLE }, async () => {
  const owner = await registerCredential();
  await setUpVault(owner);
  const cand = await registerCredential();
  const res = await addCredential(owner, cand, { authorizerOverrides: { prfFirst: randomBytes(32) } });
  assert.equal(res.statusCode, 401);
  assert.equal(wrapRow(cand), undefined);
});

test('F2: add-credential works while the vault is LOCKED (authorization is proof, not server state)', { skip: !TOOLS_AVAILABLE }, async () => {
  const owner = await registerCredential();
  const vault = await setUpVault(owner);
  await post('/api/gpg-vault/lock');
  const cand = await registerCredential();
  const res = await addCredential(owner, cand);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(isUnlocked(), false, 'adding a passkey does not unlock');
  const { res: unlockRes } = await unlock(cand);
  assert.equal(unlockRes.statusCode, 200, unlockRes.body);
  assert.equal(unlockRes.json().vault.fingerprint, vault.fingerprint);
});

test('F2: an already-enrolled passkey cannot be re-added (its wrap is never overwritten)', { skip: !TOOLS_AVAILABLE }, async () => {
  const owner = await registerCredential();
  await setUpVault(owner);
  const second = await registerCredential();
  assert.equal((await addCredential(owner, second)).statusCode, 200);
  const before = Buffer.from(wrapRow(second).wrapped_key);

  // add-options now has no candidate left.
  const opts = await post('/api/gpg-vault/credentials/add-options');
  assert.equal(opts.statusCode, 409);
  assert.equal(opts.json().code, 'GPG_VAULT_NO_CANDIDATE');

  // Forcing an enrolled credential in as the candidate anyway -> 409.
  const third = await registerCredential();
  const optsRes = await post('/api/gpg-vault/credentials/add-options');
  const { authorizer, candidate } = optsRes.json();
  const res = await post('/api/gpg-vault/credentials/add-verify', {
    flowId: flowIdFrom(optsRes),
    payload: { authorizer: assertion(owner, authorizer), candidate: assertion(second, candidate, { prfFirst: randomBytes(32) }) },
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(Buffer.from(wrapRow(second).wrapped_key), before, 'wrap untouched');
  assert.equal(wrapRow(third), undefined);

  // And the original owner of that wrap still unlocks.
  await post('/api/gpg-vault/lock');
  assert.equal((await unlock(second)).res.statusCode, 200);
});

test('F2: add-verify consumes its flow (one-time) and rejects a missing candidate', { skip: !TOOLS_AVAILABLE }, async () => {
  const owner = await registerCredential();
  await setUpVault(owner);
  const cand = await registerCredential();
  const optsRes = await post('/api/gpg-vault/credentials/add-options');
  const { authorizer } = optsRes.json();
  const noCand = await post('/api/gpg-vault/credentials/add-verify', {
    flowId: flowIdFrom(optsRes), payload: { authorizer: assertion(owner, authorizer) },
  });
  assert.equal(noCand.statusCode, 400);
  // Same flow again -> gone.
  const again = await post('/api/gpg-vault/credentials/add-verify', {
    flowId: flowIdFrom(optsRes), payload: { authorizer: assertion(owner, authorizer), candidate: {} },
  });
  assert.equal(again.statusCode, 401);
  assert.equal(wrapRow(cand), undefined);
});

// ---------------------------------------------------------------------------
// F1.4: pre-fix vaults are disabled; delete + recreate is the way out.

async function makeLegacy() {
  const owner = await registerCredential();
  const vault = await setUpVault(owner);
  await post('/api/gpg-vault/lock');
  // Exactly what db.js v9 does to every vault that existed before the fix.
  getDb().prepare('UPDATE gpg_vault SET format_version = 1').run();
  return { owner, vault };
}

test('F1.4: a legacy vault reports legacyDisabled and refuses unlock/add with 423, even with the correct PRF', { skip: !TOOLS_AVAILABLE }, async () => {
  const { owner, vault } = await makeLegacy();

  const status = (await app.inject({ method: 'GET', url: '/api/gpg-vault/status' })).json();
  assert.equal(status.exists, true);
  assert.equal(status.legacyDisabled, true);
  assert.equal(status.unlocked, false);

  const unlockOpts = await post('/api/gpg-vault/unlock-options');
  assert.equal(unlockOpts.statusCode, 423);
  assert.equal(unlockOpts.json().code, 'GPG_VAULT_LEGACY_DISABLED');
  assert.equal((await post('/api/gpg-vault/unlock-verify', { payload: { response: {} } })).statusCode, 423);
  assert.equal((await post('/api/gpg-vault/credentials/add-options')).statusCode, 423);
  assert.equal((await post('/api/gpg-vault/credentials/add-verify', { payload: {} })).statusCode, 423);
  assert.equal(isUnlocked(), false);

  // github-info still works: the owner needs it to remove the old key from GitHub.
  const info = await app.inject({ method: 'GET', url: '/api/gpg-vault/github-info' });
  assert.equal(info.statusCode, 200);
  assert.equal(info.json().fingerprint, vault.fingerprint);

  // A flow started BEFORE the vault became legacy cannot be finished either.
  getDb().prepare('UPDATE gpg_vault SET format_version = 2').run();
  const optsRes = await post('/api/gpg-vault/unlock-options');
  getDb().prepare('UPDATE gpg_vault SET format_version = 1').run();
  const res = await post('/api/gpg-vault/unlock-verify', { flowId: flowIdFrom(optsRes), payload: { response: assertion(owner, optsRes.json()) } });
  assert.equal(res.statusCode, 423);
  assert.equal(isUnlocked(), false);
});

test('F1.4: an unsalted wrap alone also marks the vault legacy', { skip: !TOOLS_AVAILABLE }, async () => {
  const owner = await registerCredential();
  await setUpVault(owner);
  await post('/api/gpg-vault/lock');
  getDb().prepare('UPDATE gpg_vault_credentials SET prf_salt = NULL').run();
  assert.equal((await app.inject({ method: 'GET', url: '/api/gpg-vault/status' })).json().legacyDisabled, true);
  assert.equal((await post('/api/gpg-vault/unlock-options')).statusCode, 423);
});

test('F1.4: deleting a legacy vault needs a fresh step-up; afterwards setup creates a usable post-fix vault', { skip: !TOOLS_AVAILABLE }, async () => {
  const { owner, vault } = await makeLegacy();

  assert.deepEqual((await post('/api/gpg-vault/delete-options')).json(), { legacy: true, stepUpRequired: true });

  const staleId = createSession({ authMethod: 'passkey' });
  getDb().prepare('UPDATE auth_sessions SET stepup_at = ? WHERE id = ?').run(Date.now() - STEPUP_WINDOW_MS - 1000, staleId);
  const denied = await post('/api/gpg-vault/delete', { sessionCookie: `${SESSION_COOKIE_NAME}=${staleId}` });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, 'STEPUP_REQUIRED');
  assert.equal((await app.inject({ method: 'GET', url: '/api/gpg-vault/status' })).json().exists, true);

  const ok = await post('/api/gpg-vault/delete'); // ownerCookie: fresh step-up
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().deletedFingerprint, vault.fingerprint);
  const status = (await app.inject({ method: 'GET', url: '/api/gpg-vault/status' })).json();
  assert.equal(status.exists, false);
  assert.equal(status.legacyDisabled, false);

  const fresh = await setUpVault(owner);
  assert.notEqual(fresh.fingerprint, vault.fingerprint, 'a brand new key, not the leaked one');
  assert.equal(isUnlocked(), true);
});

test('F1.4: deleting a post-fix vault needs an enrolled passkey whose PRF decrypts its wrap', { skip: !TOOLS_AVAILABLE }, async () => {
  const owner = await registerCredential();
  await setUpVault(owner);

  // A fresh session step-up alone is NOT enough for a post-fix vault.
  assert.equal((await post('/api/gpg-vault/delete')).statusCode, 401);

  const badOpts = await post('/api/gpg-vault/delete-options');
  const bad = await post('/api/gpg-vault/delete', {
    flowId: flowIdFrom(badOpts), payload: { response: assertion(owner, badOpts.json(), { prfFirst: randomBytes(32) }) },
  });
  assert.equal(bad.statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/gpg-vault/status' })).json().exists, true);

  const optsRes = await post('/api/gpg-vault/delete-options');
  const res = await post('/api/gpg-vault/delete', { flowId: flowIdFrom(optsRes), payload: { response: assertion(owner, optsRes.json()) } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(isUnlocked(), false, 'delete locks first');
  assert.equal((await app.inject({ method: 'GET', url: '/api/gpg-vault/status' })).json().exists, false);
});
