// GPG vault REST surface (plan: gpg-agent-vault). Registered under /api, so
// its full path is /api/gpg-vault/*. Every route here requires an existing
// session (falls through to server/index.js's normal onRequest check like
// any other route -- none of these are on UNAUTHENTICATED_AUTH_ROUTES), plus
// requirePasskeyMode() (reused from routes/auth.js, not duplicated -- see
// that file's comment on why two copies of the guard could drift).
//
// setup-verify/credentials/add-verify/unlock-verify additionally require a
// FRESH, successful WebAuthn PRF ceremony in the request body -- a plain
// session is necessary but not sufficient for those three. This is the
// actual "cannot decrypt without logging in" boundary: an attacker with a
// stolen session cookie alone cannot unlock the vault, only someone who can
// complete a live WebAuthn assertion (with the PRF extension) against an
// already-enrolled physical authenticator can.
//
// Every failure path here stays deliberately generic (mirrors auth.js's
// "verification failed" rather than echoing library error text) -- specific
// rejection reasons are exactly what you don't want to hand back to whoever
// is probing these endpoints. The one exception is unlockVault()/
// addCredentialToVault()'s own thrown messages, which are already generic
// by construction (see server/ws/gpgVaultAgent.js) and safe to relay as-is.

import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import {
  startChallengeFlow,
  consumeChallengeFlow,
  flowCookieHeader,
  clearFlowCookieHeader,
  resolveRpID,
  resolveOrigin,
} from '../webauthnChallenges.js';
import { getDb } from '../db.js';
import { requirePasskeyMode } from './auth.js';
import { GPG_VAULT_PRF_SALT } from '../gpgVaultCrypto.js';
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

// Builds the PRF-requesting WebAuthn authentication options shared by every
// step-up ceremony (setup/unlock/add-credential) -- only allowCredentials
// differs between callers. userVerification:'required' is deliberately
// stricter than the base login flow's 'preferred' (routes/auth.js), since
// this gates real secret material.
async function prfAuthenticationOptions(request, allowCredentials) {
  return generateAuthenticationOptions({
    rpID: resolveRpID(request),
    allowCredentials,
    userVerification: 'required',
    extensions: { prf: { eval: { first: GPG_VAULT_PRF_SALT.toString('base64url') } } },
  });
}

// Verifies a step-up ceremony's WebAuthn assertion (proving a live ceremony
// against a real, registered credential happened) and only then reads its
// PRF result. On any failure, sends the reply itself and returns null --
// callers just check `if (!stepUp) return;`. On success returns
// { credentialId, prfSecret } (prfSecret is caller's to zero when done).
async function verifyPrfResponse(request, reply, kind) {
  const body = request.body || {};
  const response = body.response;
  if (!response || typeof response !== 'object' || typeof response.id !== 'string') {
    reply.code(400).send({ error: 'response is required' });
    return null;
  }

  // Consumed (one-time) and the flow cookie cleared regardless of outcome,
  // same as auth.js's register-verify/authenticate-verify.
  const expectedChallenge = consumeChallengeFlow(request, kind);
  reply.header('Set-Cookie', clearFlowCookieHeader());
  if (!expectedChallenge) {
    reply.code(401).send({ error: 'ceremony expired or not found -- request new options first' });
    return null;
  }

  const row = getDb().prepare('SELECT id, public_key, counter FROM webauthn_credentials WHERE id = ?').get(response.id);
  if (!row) {
    reply.code(401).send({ error: 'verification failed' });
    return null;
  }

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
  if (!verification.verified) {
    reply.code(401).send({ error: 'verification failed' });
    return null;
  }

  // Replay defense, same as auth.js's authenticate-verify: persist the new
  // high-water mark regardless of what happens with the PRF result below.
  getDb().prepare('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?')
    .run(verification.authenticationInfo.newCounter, Date.now(), row.id);

  // Only NOW read the PRF extension result -- it is not covered by the
  // assertion signature (authenticatorData + clientDataHash only), so an
  // unsigned/spoofed value here cannot forge a successful unlock: it can
  // only make the AES-GCM unwrap in gpgVaultAgent.js fail closed. Verifying
  // the signature first proves a live, physical-authenticator ceremony
  // happened; the PRF output is then just decrypt-or-fail input.
  const prfFirst = response.clientExtensionResults?.prf?.results?.first;
  if (typeof prfFirst !== 'string' || prfFirst.length === 0) {
    reply.code(401).send({ error: 'このパスキーはPRF (クイックアンロック) に対応していません。別のパスキーで再試行してください。' });
    return null;
  }
  let prfSecret;
  try {
    prfSecret = Buffer.from(prfFirst, 'base64url');
  } catch {
    prfSecret = null;
  }
  if (!prfSecret || prfSecret.length < 16) {
    reply.code(400).send({ error: 'invalid PRF result' });
    return null;
  }

  return { credentialId: row.id, prfSecret };
}

export async function gpgVaultRoute(fastify, opts) {
  fastify.get('/gpg-vault/status', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    const exists = gpgVaultDb.vaultExists();
    const info = exists ? gpgVaultDb.getVaultPublicInfo() : null;
    return {
      exists,
      unlocked: gpgVaultAgent.isUnlocked(),
      toolsAvailable: gpgVaultAgent.gpgVaultToolsAvailable(),
      credentialCount: exists ? gpgVaultDb.countCredentialWraps() : 0,
      fingerprint: info?.fingerprint ?? null,
      keyId: info?.keyId ?? null,
    };
  });

  // Public artifacts only (see gpgVaultDb.getVaultPublicInfo) -- no PRF
  // step-up needed, unlocked or not: this is exactly what you'd paste into
  // GitHub's "GPG keys"/"SSH keys" settings, not a secret.
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

  fastify.post('/gpg-vault/setup-options', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    if (gpgVaultDb.vaultExists()) return reply.code(409).send({ error: 'a GPG vault already exists' });
    if (!gpgVaultAgent.gpgVaultToolsAvailable()) {
      return reply.code(500).send({ error: 'gpg/gpgconf are not available on this host' });
    }
    const options = await prfAuthenticationOptions(request, []);
    const flowId = startChallengeFlow('gpg-vault-setup', options.challenge);
    reply.header('Set-Cookie', flowCookieHeader(flowId, { secure: request.protocol === 'https' }));
    return options;
  });

  fastify.post('/gpg-vault/setup-verify', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    if (gpgVaultDb.vaultExists()) return reply.code(409).send({ error: 'a GPG vault already exists' });
    const body = request.body || {};
    const identity = validateIdentity(body.nameReal, body.nameEmail);
    if (!identity.ok) return reply.code(400).send({ error: identity.error });

    const stepUp = await verifyPrfResponse(request, reply, 'gpg-vault-setup');
    if (!stepUp) return;
    try {
      const vault = gpgVaultAgent.generateAndStoreVault({
        nameReal: identity.nameReal, nameEmail: identity.nameEmail,
        credentialId: stepUp.credentialId, prfSecret: stepUp.prfSecret,
      });
      return { success: true, vault };
    } catch (err) {
      request.log.error({ err }, 'GPG vault setup failed');
      return reply.code(500).send({ error: 'GPG vault setup failed' });
    } finally {
      stepUp.prfSecret.fill(0);
    }
  });

  fastify.post('/gpg-vault/unlock-options', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    if (!gpgVaultDb.vaultExists()) return reply.code(404).send({ error: 'no GPG vault has been set up yet' });
    if (gpgVaultAgent.isUnlocked()) return { alreadyUnlocked: true };
    const allowCredentials = gpgVaultDb.listUnlockableCredentialIds().map((id) => ({ id }));
    const options = await prfAuthenticationOptions(request, allowCredentials);
    const flowId = startChallengeFlow('gpg-vault-unlock', options.challenge);
    reply.header('Set-Cookie', flowCookieHeader(flowId, { secure: request.protocol === 'https' }));
    return options;
  });

  fastify.post('/gpg-vault/unlock-verify', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    if (!gpgVaultDb.vaultExists()) return reply.code(404).send({ error: 'no GPG vault has been set up yet' });
    const stepUp = await verifyPrfResponse(request, reply, 'gpg-vault-unlock');
    if (!stepUp) return;
    try {
      const vault = gpgVaultAgent.unlockVault({ credentialId: stepUp.credentialId, prfSecret: stepUp.prfSecret });
      return { success: true, vault };
    } catch (err) {
      // err.message is already generic-by-construction (gpgVaultAgent.js) --
      // safe to relay, unlike a raw library/exec error elsewhere in this file.
      request.log.warn({ err: err.message }, 'GPG vault unlock failed');
      return reply.code(401).send({ error: err.message || 'unlock failed' });
    } finally {
      stepUp.prfSecret.fill(0);
    }
  });

  fastify.post('/gpg-vault/lock', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    gpgVaultAgent.lockVault();
    return { success: true };
  });

  fastify.post('/gpg-vault/credentials/add-options', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    if (!gpgVaultDb.vaultExists()) return reply.code(404).send({ error: 'no GPG vault has been set up yet' });
    if (!gpgVaultAgent.isUnlocked()) {
      return reply.code(423).send({ error: 'the GPG vault must be unlocked before a new passkey can be added to it' });
    }
    const options = await prfAuthenticationOptions(request, []);
    const flowId = startChallengeFlow('gpg-vault-add-credential', options.challenge);
    reply.header('Set-Cookie', flowCookieHeader(flowId, { secure: request.protocol === 'https' }));
    return options;
  });

  fastify.post('/gpg-vault/credentials/add-verify', async (request, reply) => {
    if (!requirePasskeyMode(reply)) return;
    if (!gpgVaultAgent.isUnlocked()) {
      return reply.code(423).send({ error: 'the GPG vault must be unlocked before a new passkey can be added to it' });
    }
    const stepUp = await verifyPrfResponse(request, reply, 'gpg-vault-add-credential');
    if (!stepUp) return;
    try {
      gpgVaultAgent.addCredentialToVault({ credentialId: stepUp.credentialId, prfSecret: stepUp.prfSecret });
      return { success: true };
    } catch (err) {
      request.log.error({ err }, 'failed to add passkey to GPG vault');
      return reply.code(500).send({ error: 'failed to add passkey to the GPG vault' });
    } finally {
      stepUp.prfSecret.fill(0);
    }
  });
}
