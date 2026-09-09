import { useState, useEffect, useCallback, useRef } from 'react';
import { authFetch } from '../auth.js';

// "ペアリング済みインスタンス" section (SettingsView.jsx の左メニューから
// 表示される。plan Phase 1, section 9). Lists every paired_instances row (all statuses -- active,
// still-pending in either direction, revoked/rejected/expired as an audit
// trail) and lets the user start a new pairing or revoke an existing one.
// Approving/rejecting an INCOMING request is PairingRequestBanner's job, not
// this section's -- this is the durable list, that banner is the transient
// notification.

const POLL_MS = 4000;

const STATUS_LABELS = {
  active: 'アクティブ',
  pending_local_approval: '自分の承認待ち',
  pending_remote_approval: '相手の承認待ち',
  revoked: '取り消し済み',
  rejected: '却下済み',
  expired: '期限切れ',
};

function fullFingerprint(fp) {
  return typeof fp === 'string' ? fp : '';
}

function shortFingerprint(fp) {
  if (typeof fp !== 'string') return '';
  const parts = fp.split(':');
  return parts.length > 4 ? `${parts.slice(0, 4).join(':')}…` : fp;
}

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function PairedInstancesSection() {
  const [enabled, setEnabled] = useState(null); // null = unknown yet
  const [myFingerprint, setMyFingerprint] = useState(null);
  const [keyPermissionsSafe, setKeyPermissionsSafe] = useState(null);
  const [instances, setInstances] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [revokingId, setRevokingId] = useState(null);
  const [forgettingId, setForgettingId] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [remoteAddr, setRemoteAddr] = useState('');
  const [remoteToken, setRemoteToken] = useState('');
  const [label, setLabel] = useState('');
  const [pairError, setPairError] = useState(null);
  const [pairing, setPairing] = useState(false);
  const refreshingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const [identityRes, instancesRes] = await Promise.all([
        authFetch('/api/federation/identity'),
        authFetch('/api/federation/instances'),
      ]);
      if (identityRes.ok) {
        const idData = await identityRes.json();
        setEnabled(!!idData.enabled);
        setMyFingerprint(idData.fingerprint || null);
        setKeyPermissionsSafe(idData.keyPermissionsSafe ?? null);
      } else {
        setEnabled(false);
      }
      if (instancesRes.ok) {
        const data = await instancesRes.json();
        setInstances(Array.isArray(data.instances) ? data.instances : []);
        setError(null);
      }
    } catch (err) {
      setError(err.message || 'Failed to load paired instances');
    } finally {
      refreshingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const openModal = useCallback(() => {
    setRemoteAddr('');
    setRemoteToken('');
    setLabel('');
    setPairError(null);
    setModalOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    if (pairing) return;
    setModalOpen(false);
  }, [pairing]);

  const submitPairing = useCallback(async (e) => {
    e.preventDefault();
    if (!remoteAddr.trim() || pairing) return;
    setPairing(true);
    setPairError(null);
    try {
      const res = await authFetch('/api/federation/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remoteAddr: remoteAddr.trim(),
          remoteToken: remoteToken.trim() || undefined,
          label: label.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPairError(body.error || `HTTP ${res.status}`);
        return;
      }
      setModalOpen(false);
      await refresh();
    } catch (err) {
      setPairError(err.message || '通信エラー');
    } finally {
      setPairing(false);
    }
  }, [remoteAddr, remoteToken, label, pairing, refresh]);

  const handleRevoke = useCallback(async (instance) => {
    const name = instance.label || shortFingerprint(instance.fingerprint);
    if (!window.confirm(`インスタンス "${name}" のペアリングを取り消しますか?\n以後このインスタンスからの接続は全て拒否されます(相手側には通知されません)。\nこの操作は取り消せません。再ペアリングするには、双方のインスタンスで取り消し後に「完全に削除」する必要があります。`)) return;
    setRevokingId(instance.id);
    try {
      const res = await authFetch(`/api/federation/instances/${encodeURIComponent(instance.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        window.alert(body.error || `取り消しに失敗しました (HTTP ${res.status})`);
        return;
      }
      await refresh();
    } catch (err) {
      window.alert(`取り消しに失敗しました: ${err.message}`);
    } finally {
      setRevokingId(null);
    }
  }, [refresh]);

  // Issue #161: a revoked row is otherwise stuck forever (upsertPeerRow
  // refuses to reuse a 'revoked' row on its own) -- this is the explicit,
  // separate follow-up action that hard-deletes it so the same fingerprint
  // can be re-paired from scratch.
  const handleForget = useCallback(async (instance) => {
    const name = instance.label || shortFingerprint(instance.fingerprint);
    if (!window.confirm(`インスタンス "${name}" を完全に削除しますか?\nこの操作は元に戻せません。このインスタンス上の記録が消え、次に接続してきた際は新規ペアリングとして扱われます。\n再ペアリングするには、相手側でも同様に「完全に削除」する必要があります(片方だけ削除すると、もう片方は相手を拒否したままになります)。`)) return;
    setForgettingId(instance.id);
    try {
      const res = await authFetch(`/api/federation/instances/${encodeURIComponent(instance.id)}/forget`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        window.alert(body.error || `削除に失敗しました (HTTP ${res.status})`);
        return;
      }
      await refresh();
    } catch (err) {
      window.alert(`削除に失敗しました: ${err.message}`);
    } finally {
      setForgettingId(null);
    }
  }, [refresh]);

  const handleRename = useCallback(async (instance) => {
    const next = window.prompt('表示名を変更', instance.label || '');
    if (next === null) return;
    try {
      await authFetch(`/api/federation/instances/${encodeURIComponent(instance.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: next.trim() || null }),
      });
      await refresh();
    } catch {
      // best effort -- the next poll will show whatever the server has
    }
  }, [refresh]);

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <h3>ペアリング済みインスタンス</h3>
        <button className="btn btn-secondary" onClick={openModal} disabled={enabled === false}>
          新しいインスタンスとペアリング
        </button>
      </div>
      {enabled === false && (
        <p className="settings-empty">
          federationは無効です(CCSERVER_FEDERATION_PORT が設定されていません)。
        </p>
      )}
      {enabled && myFingerprint && (
        <p className="pairing-my-fingerprint" title="このインスタンス自身のfingerprint -- ペアリング時に相手の画面で照合してください">
          自分のfingerprint: <code>{fullFingerprint(myFingerprint)}</code>
          {keyPermissionsSafe === false && (
            <span className="pairing-key-warning"> ⚠ 秘密鍵のパーミッションが0600ではありません</span>
          )}
        </p>
      )}
      {error && <p className="settings-error">読み込みに失敗しました: {error}</p>}
      {loading && <p className="settings-empty">読み込み中…</p>}
      {!loading && enabled && instances.length === 0 && (
        <p className="settings-empty">ペアリング済みのインスタンスはありません。</p>
      )}
      {!loading && instances.length > 0 && (
        <ul className="sandbox-list">
          {instances.map((inst) => (
            <li key={inst.id} className="sandbox-row">
              <div className="sandbox-body">
                <div className="sandbox-item-top">
                  <span className={`pairing-status-badge pairing-status-${inst.status}`}>
                    {STATUS_LABELS[inst.status] || inst.status}
                  </span>
                  {inst.lastSeenAt && (
                    <span className="sandbox-last-used" title={`最終通信: ${formatTime(inst.lastSeenAt)}`}>
                      最終通信 {formatTime(inst.lastSeenAt)}
                    </span>
                  )}
                </div>
                <div className="sandbox-info">
                  <button className="pairing-label-btn" onClick={() => handleRename(inst)} title="クリックして表示名を変更">
                    {inst.label || '(名前未設定)'}
                  </button>
                  <span className="pairing-fingerprint" title={fullFingerprint(inst.fingerprint)}>
                    {shortFingerprint(inst.fingerprint)}
                  </span>
                  {inst.hostnameClaimed && (
                    <span className="pairing-hostname" title="相手の自己申告ホスト名(認証には使われません)">
                      {inst.hostnameClaimed}
                    </span>
                  )}
                  <span className="pairing-addr">{inst.addr}</span>
                </div>
              </div>
              {inst.status === 'revoked' ? (
                <button
                  className="sandbox-delete-btn"
                  onClick={() => handleForget(inst)}
                  disabled={forgettingId === inst.id}
                  title="このピアを完全に削除(元に戻せません)"
                  aria-label={`${inst.label || inst.fingerprint} を完全に削除`}
                >
                  &#128465;
                </button>
              ) : (
                <button
                  className="sandbox-delete-btn"
                  onClick={() => handleRevoke(inst)}
                  disabled={revokingId === inst.id}
                  title="ペアリングを取り消す"
                  aria-label={`${inst.label || inst.fingerprint} のペアリングを取り消す`}
                >
                  &#10005;
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {modalOpen && (
        <div className="resume-overlay" onClick={closeModal}>
          <form className="resume-dialog pairing-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitPairing}>
            <h3>新しいインスタンスとペアリング</h3>
            <p className="pairing-modal-hint">
              相手インスタンスの federation ポート (host:port) を入力してください。
              接続後、双方の人間がそれぞれの画面でfingerprintを確認して承認するまで有効になりません。
            </p>
            <label className="pairing-field">
              接続先 (host:port)
              <input
                type="text"
                value={remoteAddr}
                onChange={(e) => setRemoteAddr(e.target.value)}
                placeholder="100.x.y.z:3210"
                autoFocus
                required
              />
            </label>
            <label className="pairing-field">
              表示名 (任意)
              <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="my-desktop" />
            </label>
            <label className="pairing-field">
              相手のCCSERVER_TOKEN (相手が要求する場合のみ)
              <input type="password" value={remoteToken} onChange={(e) => setRemoteToken(e.target.value)} />
            </label>
            {pairError && <p className="settings-error">{pairError}</p>}
            <div className="resume-actions">
              <button type="submit" className="btn btn-primary" disabled={pairing || !remoteAddr.trim()}>
                {pairing ? '接続中…' : 'ペアリング開始'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={closeModal} disabled={pairing}>
                キャンセル
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
