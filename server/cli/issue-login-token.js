// SSH-triggered one-time login token issuance (Issue #141 Step1, フロー1).
// DB-direct access (imports db.js's getDb()/initDb() straight, no HTTP) --
// the whole point is recovering access without the server needing to be up.
//
// Usage: node server/cli/issue-login-token.js  (or: npm run login-token)

import { randomUUID } from 'node:crypto';
import { initDb, getDb } from '../db.js';
import { generateLoginToken, LOGIN_TOKEN_TTL_MS } from '../loginTokens.js';
import { resolveAuthMode } from '../authMode.js';

const authMode = resolveAuthMode();
if (authMode !== 'passkey') {
  console.error(
    `このサーバーは CCSERVER_AUTH_MODE=${authMode} で動作しています。`
    + 'このモードではワンタイムログイントークンは使われません '
    + '(CCSERVER_AUTH_MODE=passkey のときのみ有効です)。'
  );
  process.exit(1);
}

initDb();
const db = getDb();

const { token, tokenHash } = generateLoginToken();
const now = Date.now();
const expiresAt = now + LOGIN_TOKEN_TTL_MS;

db.prepare(
  'INSERT INTO login_tokens (id, token_hash, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)'
).run(randomUUID(), tokenHash, now, expiresAt);

console.log('ログイントークンを発行しました (一度だけ使用可能・15分で失効):');
console.log(token);
console.log(`有効期限: ${new Date(expiresAt).toISOString()}`);
