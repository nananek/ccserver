// Federation's own slice of sandbox.config.json, read the same way
// sandbox.js's loadSandboxConfig() reads every other feature's config
// (CCSERVER_SANDBOX_CONFIG env override, else server/sandbox.config.json) --
// kept as its own tiny reader rather than folded into loadSandboxConfig
// itself so a mistake here can't touch the much larger, security-sensitive
// sandbox-launch config parser that every session spawn depends on.
//
// Shape: { "federation": { "requireTokenForPairing": true } }

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// M8 fix (vuln_scan report): requireTokenForPairing used to send the raw
// CCSERVER_TOKEN itself over the TOFU bootstrap connection -- which, by
// definition, has no pinned peer certificate yet (that's what TOFU means):
// an on-path attacker positioned for the same MITM this feature's fingerprint
// verification (see M5) exists to catch could also just read the admin API
// token straight off this exchange. This derives a one-way, pairing-only
// value from the shared token instead: both sides can compute the SAME
// derived value iff they hold the SAME raw token (preserving the existing
// "prove you know the secret" semantics exactly), but the derived value
// itself is useless against the actual /api/* endpoints (which require the
// raw token) and cannot be reversed back into it.
export function derivePairingToken(rawToken) {
  if (typeof rawToken !== 'string' || !rawToken) return null;
  return createHmac('sha256', rawToken).update('ccserver-federation-pairing-v1').digest('hex');
}

export function federationConfig() {
  const configPath = process.env.CCSERVER_SANDBOX_CONFIG
    || join(__dirname, '..', 'sandbox.config.json');
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    raw = {};
  }
  const federation = (raw.federation && typeof raw.federation === 'object') ? raw.federation : {};
  return {
    // Gates the bootstrap POST /pairing-requests-equivalent (pairing.propose
    // RPC, see federationServer.js) on the SAME shared secret the browser
    // already uses (CCSERVER_TOKEN) -- opt-in, default off (plan section 7).
    // This never grants trust by itself: a token-gated propose still only
    // reaches 'pending_local_approval', identical to an ungated one.
    requireTokenForPairing: federation.requireTokenForPairing === true,
  };
}
