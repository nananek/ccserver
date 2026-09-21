// GPG vault REST surface (plan: gpg-agent-vault). Registered under /api, so
// its full path is /api/gpg-vault/*. Every route here requires an existing
// session (falls through to server/index.js's normal onRequest check like
// any other route -- none of these are on UNAUTHENTICATED_AUTH_ROUTES), plus
// requirePasskeyMode() (reused from routes/auth.js, not duplicated -- see
// that file's comment on why two copies of the guard could drift).
//
// setup/unlock/add-credential/delete additionally require a FRESH,
// successful WebAuthn PRF ceremony in the request body -- a plain session is
// necessary but not sufficient. This is the actual "cannot decrypt without
// logging in" boundary: an attacker with a stolen session cookie alone
// cannot unlock the vault, only someone who can complete a live WebAuthn
// assertion (with the PRF extension) against an already-enrolled physical
// authenticator can.
//
// Security audit remediation (doc "remediation-plan" r2, P0):
//  - F2: adding a passkey to the vault is authorized by an ENROLLED
//    passkey's PRF actually decrypting its own wrap in the same request
//    (two ceremonies: authorizer + candidate), never by the server-wide
//    "unlocked" flag. PRF results are not covered by the assertion
//    signature, so any PRF value a client sends for a NOT-yet-enrolled
//    credential is unverifiable; what gates enrolment is the authorizer.
//  - F6: every wrap has its own random PRF salt, chosen by the server and
//    kept server-side in the challenge flow (never trusted from the client),
//    and every unlock re-wraps under a new salt (PRF `second`).
//  - F1.4: a pre-fix vault (gpgVaultDb.isLegacyVault()) is disabled: unlock
//    and add-credential answer 423 GPG_VAULT_LEGACY_DISABLED; status,
//    github-info and delete keep working so the owner can clean up.
//
// Every failure path here stays deliberately generic (mirrors auth.js's
// "verification failed" rather than echoing library error text) -- specific
// rejection reasons are exactly what you don't want to hand back to whoever
// is probing these endpoints. The exception is gpgVaultAgent.js's own thrown
// messages, which are generic by construction and safe to relay as-is.

import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import {
  startChallengeFlow,
  consumeChallengeFlowData,
  flowCookieHeader,
  clearFlowCookieHeader,
  resolveRpID,
  resolveOrigin,
} from '../webauthnChallenges.js';
import { getDb } from '../db.js';
import { requirePasskeyMode } from './auth.js';
import { getRequestSession, hasFreshStepUp } from '../authSessions.js';
import { generatePrfSalt } from '../gpgVaultCrypto.js';
import { reportSecurityEvent } from '../securityEvents.js';
import * as gpgVaultDb from '../gpgVaultDb.js';
import * as gpgVaultAgent from '../ws/gpgVaultAgent.js';

const MAX_IDENTITY_LEN = 200;

// Rejects obviously-invalid input and, critically, anything containing a
// newline -- nameReal/nameEmail get interpolated verbatim into a GPG batch
// key-generation parameter block (gpgVaultAgent.generateAndStoreVault), and
// a newline there would let the value inject additional parameter lines
// (e.g. a second Key-Type/override of %no-protection). Loose email-shape
// check, not full RFC 5322 -- good enough to reject garbage, not a general
// email validator.
function validateIdentity(nameReal, nameEmail) {
  if (typeof nameReal !== 'string' || typeof nameEmail !== 'string') {
    return { ok: false, error: 'nameReal and nameEmail are required strings' };
  }
  const real = nameReal.trim();
  const email = nameEmail.trim();
  if (/[\r\n]/.test(real) || /[\r\n]/.test(email)) {
    return { ok: false, error: 'nameReal/nameEmail must not contain newlines' };
  }
  if (real.length < 5 || real.length > MAX_IDENTITY_LEN) {
    return { ok: false, error: 'nameReal must be between 5 and 200 characters' };
  }
  if (email.length > MAX_IDENTITY_LEN || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'nameEmail must look like a valid email address' };
  }
  return { ok: true, nameReal: real, nameEmail: email };
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// PRF-requesting authentication options shared by every step-up ceremony.
// userVerification:'required' is deliberately stricter than the base login
// flow's 'preferred' (routes/auth.js), since this gates real secret
// material. `prf` is either { eval: {first[, second]} } (one salt for
// whichever credential answers) or { evalByCredential: { id: {...} } }.
async function prfAuthenticationOptions(request, allowCredentials, prf) {
  return generateAuthenticationOptions({
    rpID: resolveRpID(request),
    allowCredentials,
    userVerification: 'required',
    extensions: { prf },
  });
}

// Options for an ENROLLED-credential ceremony (unlock / add-credential's
// authorizer / delete): each enrolled credential is asked for PRF over its
// own stored salt (`first`), and -- when `rotate` -- over a freshly chosen
// next salt (`second`) so the wrap can be rotated in the same tap. Returns
// { options, nextSalts } where nextSalts (credentialId -> base64url salt)
// must be kept server-side in the flow.
async function enrolledPrfOptions(request, { rotate }) {
  const creds = gpgVaultDb.listUnlockableCredentials();
  const evalByCredential = {};
  const nextSalts = {};
  for (const { credentialId, prfSalt } of creds) {
    const entry = { first: b64u(prfSalt) };
    if (rotate) {
      nextSalts[credentialId] = b64u(generatePrfSalt());
      entry.second = nextSalts[credentialId];
    }
    evalByCredential[credentialId] = entry;
  }
  const options = await prfAuthenticationOptions(
    request,
    creds.map(({ credentialId }) => ({ id: credentialId })),
    { evalByCredential },
  );
  return { options, nextSalts };
}

function parsePrfResult(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const buf = Buffer.from(value, 'base64url');
  return buf.length >= 16 ? buf : null;
}

// Verifies one assertion against `expectedChallenge` (proving a live
// user-verified ceremony against a real, registered credential happened),
// then reads its PRF results. Returns { credentialId, prfFirst, prfSecond }
// on success (prf* Buffers are the caller's to zero; prfSecond may be null)
// or { status, error } on failure.
async function verifyPrfAssertion(request, response, expectedChallenge) {
  if (!response || typeof response !== 'object' || typeof response.id !== 'string') {
    return { status: 400, error: 'response is required' };
  }
  const row = getDb().prepare('SELECT id, public_key, counter FROM webauthn_credentials WHERE id = ?').get(response.id);
  if (!row) return { status: 401, error: 'verification failed' };

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
  if (!verification.verified) return { status: 401, error: 'verification failed' };

  // Replay defense, same as auth.js's authenticate-verify: persist the new
  // high-water mark regardless of what happens with the PRF result below
  // (the signature check above already consumed this assertion).
  getDb().prepare('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?')
    .run(verification.authenticationInfo.newCounter, Date.now(), row.id);

  // Only NOW read the PRF extension results -- they are NOT covered by the
  // assertion signature (authenticatorData + clientDataHash only), so the
  // client can send any value here. For an ENROLLED credential that is
  // harmless (a wrong value only makes the AES-GCM unwrap fail closed); for
  // a credential being newly enrolled it is inherently unverifiable, which
  // is why enrolment is authorized separately (see add-verify).
  const results = response.clientExtensionResults?.prf?.results;
  const prfFirst = parsePrfResult(results?.first);
  if (!prfFirst) {
    return { status: 401, error: 'このパスキーはPRF (クイックアンロック) に対応していません。別のパスキーで再試行してください。' };
  }
  return { credentialId: row.id, prfFirst, prfSecond: parsePrfResult(results?.second) };
}

function zero(...bufs) {
  for (const b of bufs) if (b) b.fill(0);
}

// Consumes the flow and clears its cookie regardless of outcome (one-time
// use), same as auth.js's register-verify/authenticate-verify.
function consumeFlow(request, reply, kind) {
  const flow = consumeChallengeFlowData(request, kind);
  reply.header('Set-Cookie', clearFlowCookieHeader());
  if (!flow) {
    reply.code(401).send({ error: 'ceremony expired or not found -- request new options first' });
    return null;
  }
  return flow;
}

function startFlow(request, reply, kind, challenge, data) {
  const flowId = startChallengeFlow(kind, challenge, data);
  reply.header('Set-Cookie', flowCookieHeader(flowId, { secure: request.protocol === 'https' }));
}

function rejectLegacy(reply) {
  return reply.code(423).send({ error: gpgVaultAgent.LEGACY_VAULT_MESSAGE, code: 'GPG_VAULT_LEGACY_DISABLED' });
}

// The rotation input for one verified enrolled-credential assertion, or null
// when the authenticator did not return PRF `second` (older browsers): the
// unlock still succeeds, only the salt stays as is.
function rotationFor(stepUp, nextSalts) {
  const nextSalt = nextSalts?.[stepUp.credentialId];
  if (!nextSalt || !stepUp.prfSecond) return null;
  return { nextSalt: Buffer.from(nextSalt, 'base64url'), nextPrfSecret: stepUp.prfSecond };
}

export async function gpgVaultRoute(fastify, opts) {
  fastify.get('/gpg-vault/status', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    const exists = gpgVaultDb.vaultExists();
    const info = exists ? gpgVaultDb.getVaultPublicInfo() : null;
    return {
      exists,
      unlocked: gpgVaultAgent.isUnlocked(),
      legacyDisabled: exists ? gpgVaultDb.isLegacyVault() : false,
      toolsAvailable: gpgVaultAgent.gpgVaultToolsAvailable(),
      credentialCount: exists ? gpgVaultDb.countCredentialWraps() : 0,
      fingerprint: info?.fingerprint ?? null,
      keyId: info?.keyId ?? null,
    };
  });

  // Public artifacts only (see gpgVaultDb.getVaultPublicInfo) -- no PRF
  // step-up needed, unlocked or not: this is exactly what you'd paste into
  // GitHub's "GPG keys"/"SSH keys" settings, not a secret. Kept working for
  // a disabled legacy vault too: it is how the owner identifies which old key
  // to remove from GitHub.
  fastify.get('/gpg-vault/github-info', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    const info = gpgVaultDb.getVaultPublicInfo();
    if (!info) return reply.code(404).send({ error: 'no GPG vault has been set up yet' });
    return {
      publicKeyArmored: info.publicKeyArmored,
      sshPublicKey: info.sshPublicKey,
      fingerprint: info.fingerprint,
      keyId: info.keyId,
    };
  });

  // Setup: any registered passkey (discoverable, allowCredentials: []) with a
  // fresh server-chosen PRF salt. A session thief can no longer reach this
  // with their own authenticator, since registering a passkey now needs a
  // step-up or a CLI-issued registration grant (routes/auth.js).
  fastify.post('/gpg-vault/setup-options', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    if (gpgVaultDb.vaultExists()) return reply.code(409).send({ error: 'a GPG vault already exists' });
    if (!gpgVaultAgent.gpgVaultToolsAvailable()) {
      return reply.code(500).send({ error: 'gpg/gpgconf are not available on this host' });
    }
    const salt = b64u(generatePrfSalt());
    const options = await prfAuthenticationOptions(request, [], { eval: { first: salt } });
    startFlow(request, reply, 'gpg-vault-setup', options.challenge, { salt });
    return options;
  });

  fastify.post('/gpg-vault/setup-verify', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    if (gpgVaultDb.vaultExists()) return reply.code(409).send({ error: 'a GPG vault already exists' });
    const body = request.body || {};
    const identity = validateIdentity(body.nameReal, body.nameEmail);
    if (!identity.ok) return reply.code(400).send({ error: identity.error });

    const flow = consumeFlow(request, reply, 'gpg-vault-setup');
    if (!flow) return;
    const stepUp = await verifyPrfAssertion(request, body.response, flow.challenge);
    if (stepUp.error) return reply.code(stepUp.status).send({ error: stepUp.error });
    try {
      const vault = gpgVaultAgent.generateAndStoreVault({
        nameReal: identity.nameReal, nameEmail: identity.nameEmail,
        credentialId: stepUp.credentialId, prfSecret: stepUp.prfFirst,
        prfSalt: Buffer.from(flow.data.salt, 'base64url'),
      });
      reportSecurityEvent('GPGボルトが作成されました', `fingerprint: ${vault.fingerprint}`);
      return { success: true, vault };
    } catch (err) {
      request.log.error({ err }, 'GPG vault setup failed');
      return reply.code(500).send({ error: 'GPG vault setup failed' });
    } finally {
      zero(stepUp.prfFirst, stepUp.prfSecond);
    }
  });

  fastify.post('/gpg-vault/unlock-options', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    if (!gpgVaultDb.vaultExists()) return reply.code(404).send({ error: 'no GPG vault has been set up yet' });
    if (gpgVaultDb.isLegacyVault()) return rejectLegacy(reply);
    if (gpgVaultAgent.isUnlocked()) return { alreadyUnlocked: true };
    const { options, nextSalts } = await enrolledPrfOptions(request, { rotate: true });
    startFlow(request, reply, 'gpg-vault-unlock', options.challenge, { nextSalts });
    return options;
  });

  fastify.post('/gpg-vault/unlock-verify', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    if (!gpgVaultDb.vaultExists()) return reply.code(404).send({ error: 'no GPG vault has been set up yet' });
    if (gpgVaultDb.isLegacyVault()) return rejectLegacy(reply);
    const flow = consumeFlow(request, reply, 'gpg-vault-unlock');
    if (!flow) return;
    const stepUp = await verifyPrfAssertion(request, (request.body || {}).response, flow.challenge);
    if (stepUp.error) return reply.code(stepUp.status).send({ error: stepUp.error });
    try {
      const vault = gpgVaultAgent.unlockVault({
        credentialId: stepUp.credentialId, prfSecret: stepUp.prfFirst,
        rotation: rotationFor(stepUp, flow.data?.nextSalts),
      });
      return { success: true, vault };
    } catch (err) {
      if (err.code === 'GPG_VAULT_LEGACY_DISABLED') return rejectLegacy(reply);
      // err.message is already generic-by-construction (gpgVaultAgent.js) --
      // safe to relay, unlike a raw library/exec error elsewhere in this file.
      request.log.warn({ err: err.message }, 'GPG vault unlock failed');
      return reply.code(401).send({ error: err.message || 'unlock failed' });
    } finally {
      zero(stepUp.prfFirst, stepUp.prfSecond);
    }
  });

  fastify.post('/gpg-vault/lock', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    gpgVaultAgent.lockVault();
    return { success: true };
  });

  // Add-credential (security audit F2): TWO ceremonies in one flow.
  //   authorizer - an ENROLLED passkey; its PRF must decrypt its own wrap.
  //   candidate  - a registered, NOT yet enrolled passkey, evaluated over a
  //                fresh server-chosen salt that becomes its wrap's salt.
  // Works whether the vault is locked or unlocked (VK comes from the
  // authorizer's unwrap, not from the running agent).
  fastify.post('/gpg-vault/credentials/add-options', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    if (!gpgVaultDb.vaultExists()) return reply.code(404).send({ error: 'no GPG vault has been set up yet' });
    if (gpgVaultDb.isLegacyVault()) return rejectLegacy(reply);
    const enrolled = new Set(gpgVaultDb.listUnlockableCredentialIds());
    const candidates = getDb().prepare('SELECT id FROM webauthn_credentials').all()
      .map((r) => r.id).filter((id) => !enrolled.has(id));
    if (candidates.length === 0) {
      return reply.code(409).send({
        error: 'every registered passkey is already enrolled -- register a new passkey first',
        code: 'GPG_VAULT_NO_CANDIDATE',
      });
    }
    const { options: authorizer, nextSalts } = await enrolledPrfOptions(request, { rotate: true });
    const candidateSalt = b64u(generatePrfSalt());
    const candidate = await prfAuthenticationOptions(
      request,
      candidates.map((id) => ({ id })),
      { eval: { first: candidateSalt } },
    );
    startFlow(request, reply, 'gpg-vault-add-credential', authorizer.challenge, {
      nextSalts,
      candidateChallenge: candidate.challenge,
      candidateSalt,
    });
    return { authorizer, candidate };
  });

  fastify.post('/gpg-vault/credentials/add-verify', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    if (!gpgVaultDb.vaultExists()) return reply.code(404).send({ error: 'no GPG vault has been set up yet' });
    if (gpgVaultDb.isLegacyVault()) return rejectLegacy(reply);
    const body = request.body || {};
    const flow = consumeFlow(request, reply, 'gpg-vault-add-credential');
    if (!flow) return;

    const authorizer = await verifyPrfAssertion(request, body.authorizer, flow.challenge);
    if (authorizer.error) return reply.code(authorizer.status).send({ error: authorizer.error });
    const candidate = await verifyPrfAssertion(request, body.candidate, flow.data.candidateChallenge);
    if (candidate.error) {
      zero(authorizer.prfFirst, authorizer.prfSecond);
      return reply.code(candidate.status).send({ error: candidate.error });
    }
    try {
      gpgVaultAgent.addCredentialWithAuthorizer({
        authorizer: {
          credentialId: authorizer.credentialId, prfSecret: authorizer.prfFirst,
          rotation: rotationFor(authorizer, flow.data.nextSalts),
        },
        candidate: {
          credentialId: candidate.credentialId, prfSecret: candidate.prfFirst,
          prfSalt: Buffer.from(flow.data.candidateSalt, 'base64url'),
        },
      });
      reportSecurityEvent('GPGボルトにパスキーが追加されました', `credential: ${candidate.credentialId.slice(0, 12)}…`);
      return { success: true };
    } catch (err) {
      switch (err.code) {
        case 'GPG_VAULT_LEGACY_DISABLED': return rejectLegacy(reply);
        case 'GPG_VAULT_CREDENTIAL_ALREADY_ENROLLED':
          return reply.code(409).send({ error: err.message, code: err.code });
        default:
          // Authorizer not enrolled, or its PRF did not decrypt its wrap.
          request.log.warn({ err: err.message }, 'GPG vault add-credential rejected');
          return reply.code(401).send({ error: 'verification failed' });
      }
    } finally {
      zero(authorizer.prfFirst, authorizer.prfSecond, candidate.prfFirst, candidate.prfSecond);
    }
  });

  // Delete (security audit F1.4). For a post-fix vault, the same proof as
  // add-credential's authorizer: an enrolled passkey's PRF must decrypt its
  // wrap (delete-options + delete with `response`). For a disabled legacy
  // vault the key is presumed leaked already, so guarding it with PRF buys
  // nothing and could strand the owner; a fresh session step-up
  // (routes/auth.js stepup-*, a user-verified passkey assertion within the
  // last 5 minutes) is required instead.
  fastify.post('/gpg-vault/delete-options', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    if (!gpgVaultDb.vaultExists()) return reply.code(404).send({ error: 'no GPG vault has been set up yet' });
    if (gpgVaultDb.isLegacyVault()) return { legacy: true, stepUpRequired: true };
    const { options } = await enrolledPrfOptions(request, { rotate: false });
    startFlow(request, reply, 'gpg-vault-delete', options.challenge, null);
    return options;
  });

  fastify.post('/gpg-vault/delete', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    if (!gpgVaultDb.vaultExists()) return reply.code(404).send({ error: 'no GPG vault has been set up yet' });
    const info = gpgVaultDb.getVaultPublicInfo();

    if (gpgVaultDb.isLegacyVault()) {
      if (!hasFreshStepUp(getRequestSession(request))) {
        return reply.code(403).send({
          error: 'deleting the vault requires a fresh passkey step-up (within 5 minutes)',
          code: 'STEPUP_REQUIRED',
        });
      }
    } else {
      const flow = consumeFlow(request, reply, 'gpg-vault-delete');
      if (!flow) return;
      const stepUp = await verifyPrfAssertion(request, (request.body || {}).response, flow.challenge);
      if (stepUp.error) return reply.code(stepUp.status).send({ error: stepUp.error });
      try {
        gpgVaultAgent.verifyEnrolledCredential({ credentialId: stepUp.credentialId, prfSecret: stepUp.prfFirst });
      } catch {
        return reply.code(401).send({ error: 'verification failed' });
      } finally {
        zero(stepUp.prfFirst, stepUp.prfSecond);
      }
    }

    gpgVaultAgent.deleteVault();
    reportSecurityEvent('GPGボルトが削除されました', `fingerprint: ${info?.fingerprint ?? '?'}`);
    return { success: true, deletedFingerprint: info?.fingerprint ?? null };
  });
}
