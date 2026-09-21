// SSH-triggered one-time login token issuance (Issue #141 Step1, フロー1).
// DB-direct access (imports db.js's getDb()/initDb() straight, no HTTP) --
// the whole point is recovering access without the server needing to be up.
//
// Usage: node server/cli/issue-login-token.js [--allow-passkey-registration]
//        (or: npm run login-token [-- --allow-passkey-registration])
//
// --allow-passkey-registration (security audit F2): the session created from
// this token may register ONE passkey. Without it the token only logs in --
// registering a passkey otherwise needs a fresh step-up with an existing
// passkey, so a stolen session cookie cannot enroll an attacker's
// authenticator. Required for the very first passkey too (no implicit
// "zero passkeys" exception) and for recovery after losing every passkey.

import { randomUUID } from 'node:crypto';
import { initDb, getDb } from '../db.js';
import { generateLoginToken, LOGIN_TOKEN_TTL_MS } from '../loginTokens.js';
import { resolveAuthMode } from '../authMode.js';

const KNOWN_FLAGS = new Set(['--allow-passkey-registration']);
const args = process.argv.slice(2);
const unknown = args.filter((a) => !KNOWN_FLAGS.has(a));
if (unknown.length > 0) {
  console.error(`不明な引数: ${unknown.join(' ')}`);
  console.error('使い方: npm run login-token [-- --allow-passkey-registration]');
  process.exit(2);
}
const allowPasskeyRegistration = args.includes('--allow-passkey-registration');

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
  'INSERT INTO login_tokens (id, token_hash, created_at, expires_at, used_at, allow_passkey_registration) VALUES (?, ?, ?, ?, NULL, ?)'
).run(randomUUID(), tokenHash, now, expiresAt, allowPasskeyRegistration ? 1 : 0);

console.log('ログイントークンを発行しました (一度だけ使用可能・15分で失効):');
console.log(token);
console.log(`有効期限: ${new Date(expiresAt).toISOString()}`);
if (allowPasskeyRegistration) {
  console.log('このトークンでログインしたセッションは、パスキーを1つだけ登録できます (--allow-passkey-registration)。');
} else {
  console.log('このトークンはログインのみ可能です。パスキーを登録する場合は --allow-passkey-registration を付けて再発行してください。');
}
