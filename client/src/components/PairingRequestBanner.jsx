import { useState, useEffect, useCallback, useRef } from 'react';
import { authFetch } from '../auth.js';
import { useVisiblePolling } from '../hooks/useVisiblePolling.js';

// Global banner for cross-instance federation pairing requests (plan Phase
// 1). Polls GET /api/federation/pending and lets the user approve/reject
// each one via POST /api/federation/pending/:id/decide. Rendered at the App
// level (above the tab bar, alongside ApprovalBanner) so it is visible no
// matter which tab is active -- this is the ONLY place a human ever sees the
// peer's fingerprint before deciding whether to trust it (plan section 4.2).
//
// Unlike ApprovalBanner's fixed 5-minute timeout, a pairing request has no
// countdown here: the server only expires it after 7 days (plan section
// 4.3), so this banner just shows "待機中" rather than a ticking clock -- an
// unattended peer is the expected case, not an edge case.
//
// The backend may not exist / federation may be disabled: any non-OK
// response or fetch error is treated as "nothing pending", mirroring
// ApprovalBanner.jsx.

const POLL_MS = 4000;

const DIRECTION_LABELS = {
  inbound_initiated: '相手から接続',
  outbound_initiated: '自分から接続',
};

function shortFingerprint(fp) {
  if (typeof fp !== 'string') return '';
  const parts = fp.split(':');
  return parts.length > 4 ? `${parts.slice(0, 4).join(':')}…` : fp;
}

export default function PairingRequestBanner() {
  const [pending, setPending] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(null); // { id, message }
  const refreshingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const res = await authFetch('/api/federation/pending');
      if (!res.ok) return;
      const data = await res.json();
      setPending(Array.isArray(data?.pending) ? data.pending.filter((r) => r && r.id) : []);
    } catch {
      // unreachable server / feature disabled: keep showing the last known list
    } finally {
      refreshingRef.current = false;
    }
  }, []);

  useVisiblePolling(refresh, POLL_MS);

  const decide = useCallback(async (id, decision) => {
    if (busyId) return;
    setBusyId(id);
    setActionError(null);
    try {
      const res = await authFetch(`/api/federation/pending/${encodeURIComponent(id)}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setActionError({ id, message: body.error || `HTTP ${res.status}` });
      }
    } catch (err) {
      setActionError({ id, message: err.message || '通信エラー' });
    } finally {
      setBusyId(null);
      refresh();
    }
  }, [busyId, refresh]);

  if (pending.length === 0) return null;

  return (
    <div className="approval-banner-stack" role="alert">
      <div className="approval-banner-title">
        インスタンスからペアリング要求が届いています(相手のfingerprintを確認してから承認してください)
      </div>
      {pending.map((r) => {
        // A row stays in the pending list after THIS side approves (status
        // moves to pending_remote_approval, still "pending" -- see
        // federationPairing.deriveStatus) until the peer's decision is also
        // learned; a reject, by contrast, leaves the pending list on its very
        // next poll (status becomes 'rejected'), so that outcome never shows
        // here. Buttons stay disabled once approved so a second click can't
        // fire a redundant decide call while waiting on the peer.
        const alreadyApproved = r.localDecision === 'approved';
        return (
          <div key={r.id} className="approval-banner">
            <div className="approval-banner-main">
              <span className="approval-banner-kind">ペアリング要求</span>
              <span className="pairing-banner-fingerprint" title={r.fingerprint}>
                {shortFingerprint(r.fingerprint)}
              </span>
              <span className="approval-banner-meta">
                {r.hostnameClaimed && <span title="相手の自己申告ホスト名(認証には使われません)">{r.hostnameClaimed}</span>}
                <span>{DIRECTION_LABELS[r.direction] || r.direction}</span>
                <span>{alreadyApproved ? '承認済み・相手待ち' : '未対応'}</span>
              </span>
            </div>
            <div className="approval-banner-actions">
              <button
                className="btn btn-primary"
                disabled={busyId === r.id || alreadyApproved}
                onClick={() => decide(r.id, 'approved')}
              >
                承認
              </button>
              <button
                className="btn btn-secondary approval-reject-btn"
                disabled={busyId === r.id || alreadyApproved}
                onClick={() => decide(r.id, 'rejected')}
              >
                却下
              </button>
            </div>
            {actionError?.id === r.id && (
              <p className="approval-banner-error">処理に失敗しました: {actionError.message}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
