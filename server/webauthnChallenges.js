// CCSERVER_AUTH_MODE=passkey WebAuthn registration/authentication (Issue #141
// Step3): in-memory challenge tracking for the options->verify two-step
// ceremony, plus rpID/origin resolution shared by both.
//
// Challenges live in a module-scope Map rather than a DB table (plan
// decision: this app already avoids DB-managed dynamic state wherever a
// restart-tolerant record isn't actually needed -- a WebAuthn ceremony
// completes within seconds, so losing an in-flight one on a server restart
// just means the browser retries generateRegistrationOptions()/
// generateAuthenticationOptions() from scratch). A short-lived flow cookie
// hands the browser an opaque flowId that keys into this Map; the actual
// challenge value never round-trips through the client.

import { randomBytes } from 'node:crypto';
import { parseCookieHeader } from './authSessions.js';

export const FLOW_COOKIE_NAME = 'ccserver_webauthn_flow';
export const FLOW_TTL_MS = 5 * 60 * 1000;

// Single ("the") user -- WebAuthn requires *a* userID/userName but this app
// has no user table to draw them from (Issue #141 design: no user_id column
// anywhere, single-user by design). Fixed values are fine since every
// credential registered belongs to the same account.
export const WEBAUTHN_USER_ID = new TextEncoder().encode('ccserver-user');
export const WEBAUTHN_USER_NAME = 'ccserver';

const flows = new Map(); // flowId -> { challenge, kind, expiresAt }

function sweepExpired(now) {
  for (const [flowId, flow] of flows) {
    if (flow.expiresAt <= now) flows.delete(flowId);
  }
}

// Starts a registration or authentication ceremony: stashes `challenge` (the
// base64url options.challenge that generateRegistrationOptions()/
// generateAuthenticationOptions() already produced) under a fresh random
// flowId, returned for the caller to put in a flow cookie. `kind`
// ('registration' | 'authentication') stops a flow cookie minted for one
// ceremony from being replayed against the other's verify endpoint.
export function startChallengeFlow(kind, challenge) {
  const now = Date.now();
  sweepExpired(now);
  const flowId = randomBytes(32).toString('base64url');
  flows.set(flowId, { challenge, kind, expiresAt: now + FLOW_TTL_MS });
  return flowId;
}

// Reads the flow cookie off `request`, and if it names a live flow of the
// expected `kind`, consumes it (one-time use, like login_tokens' use-once
// guarantee) and returns its challenge. Returns null for anything else (no
// cookie, unknown flowId, expired, or a kind mismatch) -- callers 400/401 on
// null without distinguishing why, same as login-token's flat error.
export function consumeChallengeFlow(request, kind) {
  const flowId = parseCookieHeader(request.headers.cookie)[FLOW_COOKIE_NAME];
  if (!flowId) return null;
  const flow = flows.get(flowId);
  if (!flow) return null;
  flows.delete(flowId);
  if (flow.kind !== kind || flow.expiresAt <= Date.now()) return null;
  return flow.challenge;
}

// Set-Cookie header value handing the browser a flowId. `secure` mirrors
// authSessions.js's sessionCookieHeader() for the same reason:
// request.protocol only reports 'https' correctly behind the
// loopback-scoped trustProxy set up in Issue #141 Step2 for Tailscale Serve.
export function flowCookieHeader(flowId, { secure = false } = {}) {
  const maxAgeSeconds = Math.floor(FLOW_TTL_MS / 1000);
  const attrs = [
    `${FLOW_COOKIE_NAME}=${flowId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

// Expires the flow cookie immediately -- sent after every register-verify/
// authenticate-verify attempt (success or failure) so a one-time flowId
// doesn't linger in the browser past its single use.
export function clearFlowCookieHeader() {
  return `${FLOW_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// rpID must be a plain domain name (no scheme, no port) per the WebAuthn
// spec, and must match (or be a registrable suffix of) whatever hostname the
// browser thinks it's on. request.hostname strips the port for us and,
// thanks to Step2's loopback-scoped trustProxy, already reflects
// X-Forwarded-Host from a Tailscale Serve-style reverse proxy rather than
// the proxy's own loopback address. CCSERVER_WEBAUTHN_RPID overrides this
// for deployments where that default derivation doesn't fit (see plan).
export function resolveRpID(request) {
  return process.env.CCSERVER_WEBAUTHN_RPID || request.hostname;
}

// Unlike rpID, origin must be exactly what the browser's location.origin is,
// port included when non-default -- so this uses request.host (keeps the
// port) rather than request.hostname (strips it), and is never overridden by
// CCSERVER_WEBAUTHN_RPID (that variable only relaxes the rpID/hostname
// relationship, not what origin the browser is actually on).
export function resolveOrigin(request) {
  return `${request.protocol}://${request.host}`;
}
