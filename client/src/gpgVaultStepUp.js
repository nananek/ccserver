import { startAuthentication } from '@simplewebauthn/browser';
import { authFetch } from './auth.js';
import { getPrfAssertion } from './gpgVaultWebauthn.js';

// Shared with GpgVaultSection.jsx (Settings screen), PasskeysSection.jsx and
// GpgVaultQuickUnlockButton.jsx (top bar) -- extracted so the top bar button
// doesn't need to duplicate the setup/unlock step-up ceremony.
// React-independent by design (no hooks, no component state): just
// authFetch + the WebAuthn PRF ceremony, callable from anywhere.

export async function readJsonError(res) {
  try {
    const body = await res.json();
    return body.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

// 共通: <kind>-options を取得 -> PRF儀式 -> <kind>-verify という3ステップの
// ステップアップ儀式を1回実行する。setup-verify だけ追加のbodyフィールド
// (nameReal/nameEmail) を持つため、verifyExtra で拡張できるようにする。
export async function runGpgVaultStepUp({ optionsUrl, verifyUrl, verifyExtra = {} }) {
  const optionsRes = await authFetch(optionsUrl, { method: 'POST' });
  if (!optionsRes.ok) {
    throw new Error(await readJsonError(optionsRes));
  }
  const optionsJSON = await optionsRes.json();
  if (optionsJSON.alreadyUnlocked) {
    return optionsJSON;
  }
  const response = await getPrfAssertion(optionsJSON);
  const verifyRes = await authFetch(verifyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response, ...verifyExtra }),
  });
  if (!verifyRes.ok) {
    throw new Error(await readJsonError(verifyRes));
  }
  return verifyRes.json();
}

async function postJson(url, body) {
  const res = await authFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    throw new Error(await readJsonError(res));
  }
  return res.json();
}

// パスキー追加 (セキュリティ監査 F2): 2回の儀式が必要。
//   1回目 (authorizer): 既にこのVaultを解錠できるパスキーで認証 -- そのPRFが
//       自分のwrapを実際に復号できることをサーバーが確認する。
//   2回目 (candidate):  追加したいパスキーで認証。
// 「サーバーがアンロック中であること」は根拠にしないため、ロック中でも追加できる。
export async function runGpgVaultAddCredential({ onStep } = {}) {
  const optionsRes = await authFetch('/api/gpg-vault/credentials/add-options', { method: 'POST' });
  if (!optionsRes.ok) {
    throw new Error(await readJsonError(optionsRes));
  }
  const { authorizer, candidate } = await optionsRes.json();
  onStep?.('authorizer');
  const authorizerResponse = await getPrfAssertion(authorizer);
  onStep?.('candidate');
  const candidateResponse = await getPrfAssertion(candidate);
  return postJson('/api/gpg-vault/credentials/add-verify', {
    authorizer: authorizerResponse,
    candidate: candidateResponse,
  });
}

// セッションのステップアップ (セキュリティ監査 F2): 登録済みパスキーでの
// ユーザー検証付き認証を行い、このセッションに「5分以内に再認証済み」を
// 記録する。新しいパスキーの登録や、修正前Vaultの削除の前提条件。
export async function runPasskeyStepUp() {
  const optionsRes = await authFetch('/api/auth/webauthn/stepup-options', { method: 'POST' });
  if (!optionsRes.ok) {
    throw new Error(await readJsonError(optionsRes));
  }
  const optionsJSON = await optionsRes.json();
  const response = await startAuthentication({ optionsJSON });
  return postJson('/api/auth/webauthn/stepup-verify', { response });
}

// Vault削除 (セキュリティ監査 F1.4)。修正前Vault (legacy) はセッションの
// ステップアップで、通常のVaultは登録済みパスキーのPRF儀式で認可する。
export async function runGpgVaultDelete() {
  const optionsRes = await authFetch('/api/gpg-vault/delete-options', { method: 'POST' });
  if (!optionsRes.ok) {
    throw new Error(await readJsonError(optionsRes));
  }
  const optionsJSON = await optionsRes.json();
  if (optionsJSON.legacy) {
    await runPasskeyStepUp();
    return postJson('/api/gpg-vault/delete', {});
  }
  const response = await getPrfAssertion(optionsJSON);
  return postJson('/api/gpg-vault/delete', { response });
}
