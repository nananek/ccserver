import { useState, useCallback, useRef } from 'react';
import { authFetch } from '../auth.js';
import { useVisiblePolling } from './useVisiblePolling.js';

const POLL_MS = 5000;

// セッション一覧 (サイドバー / ポップアップ) 用: ACTIVE なペアリング先
// インスタンスそれぞれの稼働中セッションを集めて [{ instance, session }] で返す。
// RemoteInstanceView と同じ federation REST を叩くが、あちらは選択中の
// 1インスタンスのみ・Remote タブ表示中のみのポーリングなので別に持つ。
// 取得に失敗したインスタンスは前回値を維持する (一時的な通信断で一覧が
// ちらつかないように)。
export function useRemoteSessions(enabled = true) {
  const [entries, setEntries] = useState([]);
  const refreshingRef = useRef(false);
  const lastByInstanceRef = useRef(new Map());

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const res = await authFetch('/api/federation/instances');
      if (!res.ok) return;
      const data = await res.json();
      const active = (Array.isArray(data.instances) ? data.instances : []).filter((i) => i.status === 'active');
      const results = await Promise.all(active.map(async (instance) => {
        try {
          const r = await authFetch(`/api/federation/instances/${encodeURIComponent(instance.id)}/sessions`);
          if (!r.ok) return [instance, lastByInstanceRef.current.get(instance.id) || []];
          const sessions = (await r.json()).sessions || [];
          return [instance, sessions];
        } catch {
          return [instance, lastByInstanceRef.current.get(instance.id) || []];
        }
      }));
      const next = new Map();
      const flat = [];
      for (const [instance, sessions] of results) {
        next.set(instance.id, sessions);
        for (const session of sessions) flat.push({ instance, session });
      }
      lastByInstanceRef.current = next;
      setEntries(flat);
    } catch {
      // transient failure -- keep the last known list
    } finally {
      refreshingRef.current = false;
    }
  }, []);

  // 終了直後、次のポーリングを待たずに一覧から外す (タブを閉じた同じ tick で
  // 「リモートのセッション」に一瞬出るのを防ぐ)。
  const dropRemoteSession = useCallback((instanceId, sessionId) => {
    const prev = lastByInstanceRef.current.get(instanceId);
    if (prev) lastByInstanceRef.current.set(instanceId, prev.filter((s) => s.id !== sessionId));
    setEntries((cur) => cur.filter((e) => !(e.instance.id === instanceId && e.session.id === sessionId)));
  }, []);

  useVisiblePolling(refresh, POLL_MS, enabled);

  return { remoteSessions: entries, refreshRemoteSessions: refresh, dropRemoteSession };
}
