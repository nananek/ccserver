import { useState, useEffect, useCallback } from 'react';
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { authFetch, resolveAuthMode } from '../auth.js';

// "パスキー" section (SettingsView.jsx 左メニュー, Issue #141 Step4). The
// third of the Issue's three login導線 -- パスキー登録 (フロー2) -- lives
// here rather than LoginView because it requires already being logged in.
// Registered-credential list + new-registration only; deletion is out of
// scope (Issue本文のStep4に明記が無いため見送り、plan-141-step4参照)。

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function PasskeysSection() {
  const [mode, setMode] = useState(null); // null = not yet resolved
  const [credentials, setCredentials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const res = await authFetch('/api/auth/webauthn/credentials');
      if (res.ok) {
        const data = await res.json();
        setCredentials(Array.isArray(data.credentials) ? data.credentials : []);
        setError(null);
      } else {
        setError(`HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err.message || '読み込みに失敗しました');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    resolveAuthMode().then((m) => {
      if (cancelled) return;
      setMode(m);
      if (m !== 'passkey') setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (mode === 'passkey') refresh();
  }, [mode, refresh]);

  const handleRegister = useCallback(async () => {
    if (registering) return;
    setRegistering(true);
    setRegisterError(null);
    try {
      const optionsRes = await authFetch('/api/auth/webauthn/register-options', { method: 'POST' });
      if (!optionsRes.ok) {
        const body = await optionsRes.json().catch(() => ({}));
        setRegisterError(body.error || `開始に失敗しました (HTTP ${optionsRes.status})`);
        return;
      }
      const optionsJSON = await optionsRes.json();
      // Cancelling this prompt (null) still proceeds with the registration --
      // only the label is optional, not the ceremony itself.
      const label = window.prompt('このパスキーの表示名 (任意、後から変更不可)', '');
      const attestation = await startRegistration({ optionsJSON });
      const verifyRes = await authFetch('/api/auth/webauthn/register-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: attestation, label: label || undefined }),
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => ({}));
        setRegisterError(body.error || `登録に失敗しました (HTTP ${verifyRes.status})`);
        return;
      }
      await refresh();
    } catch (err) {
      // WebAuthnError (user cancelled, no authenticator, etc.) already
      // carries a human-readable message.
      setRegisterError(err.message || 'パスキー登録に失敗しました');
    } finally {
      setRegistering(false);
    }
  }, [registering, refresh]);

  const webauthnSupported = browserSupportsWebAuthn();

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <h3>パスキー</h3>
        <button
          className="btn btn-secondary"
          onClick={handleRegister}
          disabled={mode !== 'passkey' || !webauthnSupported || registering}
        >
          {registering ? '登録中…' : '新しいパスキーを登録'}
        </button>
      </div>
      {mode !== null && mode !== 'passkey' && (
        <p className="settings-empty">
          パスキーはCCSERVER_AUTH_MODE=passkeyのときのみ利用できます(現在: {mode})。
        </p>
      )}
      {mode === 'passkey' && !webauthnSupported && (
        <p className="settings-empty">このブラウザはパスキーに対応していません。</p>
      )}
      {registerError && <p className="settings-error">{registerError}</p>}
      {mode === 'passkey' && (
        <>
          {error && <p className="settings-error">読み込みに失敗しました: {error}</p>}
          {loading && <p className="settings-empty">読み込み中…</p>}
          {!loading && !error && credentials.length === 0 && (
            <p className="settings-empty">登録済みのパスキーはありません。</p>
          )}
          {!loading && credentials.length > 0 && (
            <ul className="sandbox-list">
              {credentials.map((cred) => (
                <li key={cred.id} className="sandbox-row">
                  <div className="sandbox-body">
                    <div className="sandbox-info">
                      <span>{cred.label || '(名前未設定)'}</span>
                    </div>
                    <div className="sandbox-item-top">
                      <span className="sandbox-last-used">
                        登録: {formatTime(cred.createdAt) || '-'}
                        {cred.lastUsedAt ? ` / 最終使用: ${formatTime(cred.lastUsedAt)}` : ''}
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
