import { authFetch } from './auth.js';
import { getPrfAssertion } from './gpgVaultWebauthn.js';

// Shared with GpgVaultSection.jsx (Settings screen) and
// GpgVaultQuickUnlockButton.jsx (top bar) -- extracted so the top bar button
// doesn't need to duplicate the setup/unlock/add-credential step-up ceremony.
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
