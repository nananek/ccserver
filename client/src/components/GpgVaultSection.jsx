import { useState, useEffect, useCallback } from 'react';
import { authFetch, resolveAuthMode } from '../auth.js';
import { getPrfAssertion } from '../gpgVaultWebauthn.js';

// "GPG連携" section (SettingsView.jsx 左メニュー, plan: gpg-agent-vault).
// パスキーログイン限定機能: サーバーが専用のGPG鍵を生成・暗号化保管し、
// PRF対応パスキーでのライブ認証儀式でのみ復号 (アンロック) できる。
// アンロック中はコミット署名・SSH push (サンドボックス起動時の「GPGボルトで
// 署名・SSH pushする」チェックボックス、GeneralSection.jsx/DirectoryBrowser.jsx)
// に使え、GitHub登録用の公開鍵情報もここに表示する。

async function readJsonError(res) {
  try {
    const body = await res.json();
    return body.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function writeClipboardText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error('clipboard unavailable'));
}

function CopyButton({ text, label }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    writeClipboardText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [text]);
  return (
    <button type="button" className="btn btn-secondary" onClick={handleCopy}>
      {copied ? 'コピーしました' : label}
    </button>
  );
}

export default function GpgVaultSection() {
  const [mode, setMode] = useState(null); // null = not yet resolved
  const [status, setStatus] = useState(null);
  const [githubInfo, setGithubInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [nameReal, setNameReal] = useState('');
  const [nameEmail, setNameEmail] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await authFetch('/api/gpg-vault/status');
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setStatus(data);
      setError(null);
      if (data.exists) {
        const ghRes = await authFetch('/api/gpg-vault/github-info');
        setGithubInfo(ghRes.ok ? await ghRes.json() : null);
      } else {
        setGithubInfo(null);
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

  // 共通: <kind>-options を取得 -> PRF儀式 -> <kind>-verify という3ステップの
  // ステップアップ儀式を1回実行する。setup-verify だけ追加のbodyフィールド
  // (nameReal/nameEmail) を持つため、verifyExtra で拡張できるようにする。
  const runStepUp = useCallback(async ({ optionsUrl, verifyUrl, verifyExtra = {} }) => {
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
  }, []);

  const handleSetup = useCallback(async () => {
    if (busy) return;
    const real = nameReal.trim();
    const email = nameEmail.trim();
    if (real.length < 5) {
      setActionError('名前は5文字以上で入力してください');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setActionError('メールアドレスの形式が正しくありません');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await runStepUp({
        optionsUrl: '/api/gpg-vault/setup-options',
        verifyUrl: '/api/gpg-vault/setup-verify',
        verifyExtra: { nameReal: real, nameEmail: email },
      });
      await refresh();
    } catch (err) {
      setActionError(err.message || 'Vaultの作成に失敗しました');
    } finally {
      setBusy(false);
    }
  }, [busy, nameReal, nameEmail, runStepUp, refresh]);

  const handleUnlock = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await runStepUp({ optionsUrl: '/api/gpg-vault/unlock-options', verifyUrl: '/api/gpg-vault/unlock-verify' });
      await refresh();
    } catch (err) {
      setActionError(err.message || 'アンロックに失敗しました');
    } finally {
      setBusy(false);
    }
  }, [busy, runStepUp, refresh]);

  const handleLock = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await authFetch('/api/gpg-vault/lock', { method: 'POST' });
      if (!res.ok) throw new Error(await readJsonError(res));
      await refresh();
    } catch (err) {
      setActionError(err.message || 'ロックに失敗しました');
    } finally {
      setBusy(false);
    }
  }, [busy, refresh]);

  const handleAddCredential = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await runStepUp({
        optionsUrl: '/api/gpg-vault/credentials/add-options',
        verifyUrl: '/api/gpg-vault/credentials/add-verify',
      });
      await refresh();
    } catch (err) {
      setActionError(err.message || 'パスキーの追加に失敗しました');
    } finally {
      setBusy(false);
    }
  }, [busy, runStepUp, refresh]);

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <h3>GPG連携</h3>
      </div>
      {mode !== null && mode !== 'passkey' && (
        <p className="settings-empty">
          GPGボルトはCCSERVER_AUTH_MODE=passkeyのときのみ利用できます(現在: {mode})。
        </p>
      )}
      {mode === 'passkey' && (
        <>
          {error && <p className="settings-error">読み込みに失敗しました: {error}</p>}
          {loading && <p className="settings-empty">読み込み中…</p>}
          {!loading && !error && status && (
            <>
              {status.toolsAvailable === false && (
                <p className="settings-error">
                  このホストには gpg / gpgconf がインストールされていません。GPGボルトは利用できません。
                </p>
              )}
              {actionError && <p className="settings-error">{actionError}</p>}

              {!status.exists && (
                <>
                  <p className="settings-hint">
                    サーバー専用のGPG鍵を新規生成します。秘密鍵はネットワーク/ブラウザを経由せず、
                    PRF対応パスキーでのライブ認証儀式でのみ復号できる形でサーバーに保管されます。
                  </p>
                  <div className="general-setting-row">
                    <label htmlFor="gpgvault-name-real">名前</label>
                    <input
                      id="gpgvault-name-real"
                      type="text"
                      value={nameReal}
                      onChange={(e) => setNameReal(e.target.value)}
                      placeholder="Taro Yamada"
                    />
                  </div>
                  <div className="general-setting-row">
                    <label htmlFor="gpgvault-name-email">メールアドレス</label>
                    <input
                      id="gpgvault-name-email"
                      type="email"
                      value={nameEmail}
                      onChange={(e) => setNameEmail(e.target.value)}
                      placeholder="taro@example.com"
                    />
                  </div>
                  <button type="button" className="btn btn-secondary" onClick={handleSetup} disabled={busy || status.toolsAvailable === false}>
                    {busy ? '作成中…' : 'GPGボルトを作成'}
                  </button>
                </>
              )}

              {status.exists && (
                <>
                  <p className="settings-hint">
                    状態: {status.unlocked ? 'アンロック中' : 'ロック中'}
                    {' / '}フィンガープリント: {status.fingerprint}
                    {' / '}登録済みパスキー: {status.credentialCount}個
                  </p>
                  {!status.unlocked && (
                    <button type="button" className="btn btn-secondary" onClick={handleUnlock} disabled={busy}>
                      {busy ? 'アンロック中…' : 'アンロック'}
                    </button>
                  )}
                  {status.unlocked && (
                    <>
                      <button type="button" className="btn btn-secondary" onClick={handleLock} disabled={busy}>
                        {busy ? 'ロック中…' : 'ロック'}
                      </button>
                      {' '}
                      <button type="button" className="btn btn-secondary" onClick={handleAddCredential} disabled={busy}>
                        {busy ? '追加中…' : 'このVaultを解錠できるパスキーを追加'}
                      </button>
                    </>
                  )}

                  {githubInfo && (
                    <div className="settings-subsection">
                      <h4 className="general-setting-subhead">GitHub登録用の情報</h4>
                      <p className="settings-hint">
                        GPG公開鍵はGitHubの Settings &gt; SSH and GPG keys &gt; New GPG key に、
                        SSH公開鍵は同ページの New SSH key に登録してください。
                      </p>
                      <div className="general-setting-row">
                        <label>GPG公開鍵</label>
                        <CopyButton text={githubInfo.publicKeyArmored} label="GPG公開鍵をコピー" />
                      </div>
                      <div className="general-setting-row">
                        <label>SSH公開鍵</label>
                        <CopyButton text={githubInfo.sshPublicKey} label="SSH公開鍵をコピー" />
                      </div>
                      <pre className="settings-code-block">{githubInfo.sshPublicKey}</pre>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
