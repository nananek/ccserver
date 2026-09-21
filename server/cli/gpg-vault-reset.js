// Host-side GPG vault reset (security audit F1.4). Deletes the vault and
// every passkey wrap of it, straight from the DB (same "no HTTP, works with
// the server down" posture as issue-login-token.js) -- the recovery path
// when the owner cannot, or no longer wants to, authorize the deletion in
// the browser, and the documented way out of a pre-fix vault that the server
// has disabled.
//
// Usage: node server/cli/gpg-vault-reset.js [--yes]
//
// Without --yes it only prints what would be deleted (fingerprint and SSH
// public key -- exactly what must also be removed from GitHub) and exits.
// Stop the server first, or restart it afterwards: a running server that
// had this vault unlocked keeps its in-memory agent until it locks.

import { initDb } from '../db.js';
import * as gpgVaultDb from '../gpgVaultDb.js';

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--yes');
if (unknown.length > 0) {
  console.error(`不明な引数: ${unknown.join(' ')}`);
  console.error('使い方: node server/cli/gpg-vault-reset.js [--yes]');
  process.exit(2);
}

initDb();
if (!gpgVaultDb.vaultExists()) {
  console.log('GPGボルトは存在しません。削除するものはありません。');
  process.exit(0);
}

const info = gpgVaultDb.getVaultPublicInfo();
const legacy = gpgVaultDb.isLegacyVault();
console.log(`GPGボルト: ${info.nameReal} <${info.nameEmail}>`);
console.log(`  fingerprint: ${info.fingerprint}`);
console.log(`  SSH公開鍵:   ${info.sshPublicKey}`);
console.log(`  登録パスキー数: ${gpgVaultDb.countCredentialWraps()}`);
if (legacy) {
  console.log('  状態: 修正前に作成されたボルトのため無効化されています (秘密鍵が漏洩した可能性があります)。');
}
console.log('');
console.log('GitHub の GPG keys / SSH keys (Deploy Key) から上記の鍵を削除してください。');

if (!args.includes('--yes')) {
  console.log('');
  console.log('削除するには --yes を付けて再実行してください。');
  process.exit(0);
}

gpgVaultDb.deleteVault();
console.log('');
console.log('GPGボルトを削除しました。サーバーを再起動し、設定画面からボルトを再作成してください。');
