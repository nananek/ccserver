import { useState, useCallback } from 'react';
import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';

// Full-screen gate shown by AuthGate.jsx when CCSERVER_AUTH_MODE=passkey and
// there's no live session yet (Issue #141 Step4). Two of the Issue's three
// login導線 live here -- ワンタイムトークン入力 (フロー1, recovery/first
// login) and パスキーでログイン (フロー3). The third (パスキー登録, フロー2)
// requires already being logged in, so it lives in SettingsView's
// PasskeysSection instead, not here.
export default function LoginView({ onLoggedIn }) {
  const [token, setToken] = useState('');
  const [tokenError, setTokenError] = useState(null);
  const [submittingToken, setSubmittingToken] = useState(false);
  const [passkeyError, setPasskeyError] = useState(null);
  const [authenticating, setAuthenticating] = useState(false);

  const submitToken = useCallback(async (e) => {
    e.preventDefault();
    const value = token.trim();
    if (!value || submittingToken) return;
    setSubmittingToken(true);
    setTokenError(null);
    try {
      const res = await fetch('/api/auth/login-token', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setTokenError(body.error || `ログインに失敗しました (HTTP ${res.status})`);
        return;
      }
      onLoggedIn();
    } catch (err) {
      setTokenError(err.message || '通信エラー');
    } finally {
      setSubmittingToken(false);
    }
  }, [token, submittingToken, onLoggedIn]);

  const loginWithPasskey = useCallback(async () => {
    if (authenticating) return;
    setAuthenticating(true);
    setPasskeyError(null);
    try {
      const optionsRes = await fetch('/api/auth/webauthn/authenticate-options', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!optionsRes.ok) {
        setPasskeyError(`開始に失敗しました (HTTP ${optionsRes.status})`);
        return;
      }
      const optionsJSON = await optionsRes.json();
      const assertion = await startAuthentication({ optionsJSON });
      const verifyRes = await fetch('/api/auth/webauthn/authenticate-verify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: assertion }),
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => ({}));
        setPasskeyError(body.error || `認証に失敗しました (HTTP ${verifyRes.status})`);
        return;
      }
      onLoggedIn();
    } catch (err) {
      // WebAuthnError (user cancelled the prompt, no authenticator present,
      // etc.) already carries a human-readable message.
      setPasskeyError(err.message || 'パスキー認証に失敗しました');
    } finally {
      setAuthenticating(false);
    }
  }, [authenticating, onLoggedIn]);

  return (
    <div className="login-view">
      <div className="login-card">
        <h1 className="login-title">ccserver</h1>
        <p className="login-subtitle">ログインが必要です</p>

        {browserSupportsWebAuthn() ? (
          <>
            <button
              type="button"
              className="btn btn-primary login-passkey-btn"
              onClick={loginWithPasskey}
              disabled={authenticating}
            >
              {authenticating ? '認証中…' : 'パスキーでログイン'}
            </button>
            {passkeyError && <p className="settings-error">{passkeyError}</p>}
            <div className="login-divider">または</div>
          </>
        ) : (
          <p className="settings-hint">
            このブラウザはパスキーに対応していません。ワンタイムトークンでログインしてください。
          </p>
        )}

        <form className="login-token-form" onSubmit={submitToken}>
          <label className="pairing-field">
            ワンタイムトークン
            <input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="SSHで `npm run login-token` を実行して発行"
              autoComplete="one-time-code"
              autoFocus
            />
          </label>
          {tokenError && <p className="settings-error">{tokenError}</p>}
          <button type="submit" className="btn btn-secondary" disabled={!token.trim() || submittingToken}>
            {submittingToken ? '確認中…' : 'トークンでログイン'}
          </button>
        </form>
      </div>
    </div>
  );
}
