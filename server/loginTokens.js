// SSH-issued one-time login token: generation + hashing (Issue #141 Step1).
// Shared by server/cli/issue-login-token.js (issuance) and the future
// server/routes/auth.js verification endpoint (Step2) so both sides hash the
// same way -- the DB only ever stores the digest (see db.js v7 migration).

import { randomBytes, createHash } from 'node:crypto';

// Short-lived by design (recovery-login use case, not a session) -- see
// Issue #141 design summary.
export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;

export function hashLoginToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// 32 bytes of CSPRNG output, base64url-encoded -- higher entropy than
// randomUUID() (128 bits, some of them fixed version/variant bits), which
// matters here since this token alone grants a login.
export function generateLoginToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashLoginToken(token) };
}
