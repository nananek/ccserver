import { useState, useCallback, useRef } from 'react';
import { authFetch } from '../auth.js';
import { useVisiblePolling } from './useVisiblePolling.js';

const POLL_MS = 5000;

// セッション一覧 (サイドバー / ポップアップ) 用: ACTIVE なペアリング先
// インスタンスそれぞれの稼働中セッション ([{ instance, session }]、コンボの
// メンバーは除く) とコンボ ([{ instance, group }]) を集めて返す。
// RemoteInstanceView と同じ federation REST を叩くが、あちらは選択中の
// 1インスタンスのみ・Remote タブ表示中のみのポーリングなので別に持つ。
// 取得に失敗したインスタンスは前回値を維持する (一時的な通信断で一覧が
// ちらつかないように)。
//
// グループメンバー (groupId != null) は一覧に載せない: ローカルの一覧
// (App.jsx の fetchServerSessions) と同じ規則で、bare なタブで attach すると
// グループの生きたソケットを奪い、✕でグループの一部だけを終了させてしまう
// ため。コンボはメンバー単位ではなく groups 側の1行として返し、ローカル
// 同様にグループタブで開く。
export function useRemoteSessions(enabled = true) {
  const [entries, setEntries] = useState([]);
  const refreshingRef = useRef(false);
  const [groupEntries, setGroupEntries] = useState([]);
  const refreshQueuedRef = useRef(false);
  const lastByInstanceRef = useRef(new Map());
  const lastGroupsByInstanceRef = useRef(new Map());
  // 直前のポーリング結果のシグネチャ。内容が同じなら setEntries しない
  // (5秒ごとに無条件で App 全体を再レンダーしないため)。
  const signatureRef = useRef(null);
  const groupSignatureRef = useRef(null);

  const refresh = useCallback(async () => {
    // Regular polling ticks are deliberately dropped while a refresh is in
    // flight. A federation request may wait up to the peer/RPC timeout, which
    // is longer than POLL_MS; queueing every overlapping interval tick would
    // otherwise make the finally block start another slow request immediately
    // and keep polling continuously with no POLL_MS pause.
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const res = await authFetch('/api/federation/instances');
      if (!res.ok) return;
      const data = await res.json();
      const active = (Array.isArray(data.instances) ? data.instances : []).filter((i) => i.status === 'active');
      const results = await Promise.all(active.map(async (instance) => {
        const base = `/api/federation/instances/${encodeURIComponent(instance.id)}`;
        const fetchList = async (path, key, lastRef) => {
          try {
            const r = await authFetch(`${base}/${path}`);
            if (!r.ok) return lastRef.current.get(instance.id) || [];
            return (await r.json())[key] || [];
          } catch {
            return lastRef.current.get(instance.id) || [];
          }
        };
        const [sessions, groups] = await Promise.all([
          fetchList('sessions', 'sessions', lastByInstanceRef),
          fetchList('groups', 'groups', lastGroupsByInstanceRef),
        ]);
        // id が文字列でない要素は描画側 (s.id.slice 等) を壊すので捨てる。
        return [
          instance,
          sessions.filter((s) => s && typeof s.id === 'string'),
          groups.filter((g) => g && typeof g.groupId === 'string'),
        ];
      }));
      const next = new Map();
      const nextGroups = new Map();
      const flat = [];
      const flatGroups = [];
      for (const [instance, sessions, groups] of results) {
        next.set(instance.id, sessions);
        nextGroups.set(instance.id, groups);
        // コンボのメンバーはローカル同様に個別行へ出さず、グループ1行にまとめる。
        for (const session of sessions) if (session.groupId == null) flat.push({ instance, session });
        for (const group of groups) flatGroups.push({ instance, group });
      }
      lastByInstanceRef.current = next;
      lastGroupsByInstanceRef.current = nextGroups;
      // 一覧の描画に効く値だけを比較する (instance 行には last_seen_at のような
      // 無関係な可変カラムもあるため、オブジェクト全体は比較しない)。
      const signature = JSON.stringify(flat.map(({ instance, session }) => [instance.id, instance.label || null, session]));
      if (signature !== signatureRef.current) {
        signatureRef.current = signature;
        setEntries(flat);
      }
      const groupSignature = JSON.stringify(flatGroups.map(({ instance, group }) => [instance.id, instance.label || null, group]));
      if (groupSignature !== groupSignatureRef.current) {
        groupSignatureRef.current = groupSignature;
        setGroupEntries(flatGroups);
      }
    } catch {
      // transient failure -- keep the last known list
    } finally {
      refreshingRef.current = false;
      // 実行中に来た要求 (終了直後の refreshRemoteSessions など) は
      // 取りこぼさず、1回だけ後追いで実行する。これをしないと in-flight の
      // ポーリング結果が後から setEntries して、終了済みセッションが
      // 一瞬復活しうる。
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        refresh();
      }
    }
  }, []);

  // Unlike an ordinary polling tick, an explicit refresh after DELETE must
  // not be lost behind an in-flight request: its older response may still
  // contain the just-removed session. Coalesce any number of those explicit
  // requests into the single follow-up consumed by refresh()'s finally block.
  const refreshAfterMutation = useCallback(() => {
    if (refreshingRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refresh();
  }, [refresh]);

  // 終了直後、次のポーリングを待たずに一覧から外す (タブを閉じた同じ tick で
  // 「リモートのセッション」に一瞬出るのを防ぐ)。
  const dropRemoteSession = useCallback((instanceId, sessionId) => {
    const prev = lastByInstanceRef.current.get(instanceId);
    if (prev) lastByInstanceRef.current.set(instanceId, prev.filter((s) => s.id !== sessionId));
    setEntries((cur) => cur.filter((e) => !(e.instance.id === instanceId && e.session.id === sessionId)));
  }, []);

  const dropRemoteGroup = useCallback((instanceId, groupId) => {
    const prev = lastGroupsByInstanceRef.current.get(instanceId);
    if (prev) lastGroupsByInstanceRef.current.set(instanceId, prev.filter((g) => g.groupId !== groupId));
    setGroupEntries((cur) => cur.filter((e) => !(e.instance.id === instanceId && e.group.groupId === groupId)));
  }, []);

  useVisiblePolling(refresh, POLL_MS, enabled);

  return { remoteSessions: entries, remoteGroups: groupEntries, refreshRemoteSessions: refreshAfterMutation, dropRemoteSession, dropRemoteGroup };
}
