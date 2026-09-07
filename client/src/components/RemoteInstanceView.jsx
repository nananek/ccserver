import { useState, useEffect, useCallback, useRef } from 'react';
import { authFetch } from '../auth.js';
import { useVisiblePolling } from '../hooks/useVisiblePolling.js';

// "Remote" tab (plan Phase 1, section 9): browse an ACTIVE paired peer's
// sessions/groups, launch new ones, and open a terminal tab that relays
// through /ws/remote-terminal (see App.jsx's onOpenRemoteTerminal /
// TerminalView.jsx's remoteInstanceId prop). Deliberately a separate,
// self-contained view rather than merging into DirectoryBrowser.jsx: that
// component's local launch UI (combo presets, meta-agent mode, sandbox
// option matrix) is already large, and a remote peer's launch surface is
// intentionally much smaller (Phase 1 only proxies the plain REST shape --
// see server/routes/federation.js) -- keeping them apart avoids threading
// "is this remote?" through DirectoryBrowser's every code path for Phase 1's
// sake.
//
// Remote GROUP members open as ordinary individual remote terminal tabs
// (same relay as a standalone session -- a group member IS just a session
// with groupId/groupRole set, see server/ws/sessionManager.js), not as a
// combined 3-pane GroupTabView: the live hand-off/turn-taking machinery
// GroupTabView drives is entirely local to the peer's own MCP brokers, so
// there is nothing for a second, separate combined view to coordinate here.

const INSTANCES_POLL_MS = 4000;
const CONTENT_POLL_MS = 4000;
const APPS = ['claude', 'opencode', 'copilot', 'codex'];

function formatCwd(cwd) {
  return cwd || '/';
}

function shortFingerprint(fp) {
  if (typeof fp !== 'string') return '';
  const parts = fp.split(':');
  return parts.length > 4 ? `${parts.slice(0, 4).join(':')}…` : fp;
}

export default function RemoteInstanceView({ onOpenRemoteTerminal, visible }) {
  const [instances, setInstances] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [groups, setGroups] = useState([]);
  const [expandedGroupId, setExpandedGroupId] = useState(null);
  const [groupMembers, setGroupMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchKind, setLaunchKind] = useState('session'); // 'session' | 'group'
  const [launchCwd, setLaunchCwd] = useState('');
  const [launchApp, setLaunchApp] = useState('claude');
  const [launchShell, setLaunchShell] = useState(false);
  const [launchSandbox, setLaunchSandbox] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState(null);
  const [dirListing, setDirListing] = useState(null); // { current, parent, dirs }
  const instancesRefreshingRef = useRef(false);
  const contentRefreshingRef = useRef(false);

  const refreshInstances = useCallback(async () => {
    if (instancesRefreshingRef.current) return;
    instancesRefreshingRef.current = true;
    try {
      const res = await authFetch('/api/federation/instances');
      if (!res.ok) return;
      const data = await res.json();
      const active = (Array.isArray(data.instances) ? data.instances : []).filter((i) => i.status === 'active');
      setInstances(active);
      setSelectedId((prev) => (prev && active.some((i) => i.id === prev)) ? prev : (active[0]?.id ?? null));
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load paired instances');
    } finally {
      instancesRefreshingRef.current = false;
      setLoading(false);
    }
  }, []);

  // Previously ran unconditionally regardless of `visible`/tab focus, firing
  // every 4s even when the Remote tab was never opened and the browser tab
  // itself was backgrounded for days (issue #123 #9).
  useVisiblePolling(refreshInstances, INSTANCES_POLL_MS, visible);

  const refreshContent = useCallback(async () => {
    if (!selectedId || contentRefreshingRef.current) return;
    contentRefreshingRef.current = true;
    try {
      const [sessRes, groupsRes] = await Promise.all([
        authFetch(`/api/federation/instances/${encodeURIComponent(selectedId)}/sessions`),
        authFetch(`/api/federation/instances/${encodeURIComponent(selectedId)}/groups`),
      ]);
      if (sessRes.ok) setSessions((await sessRes.json()).sessions || []);
      if (groupsRes.ok) setGroups((await groupsRes.json()).groups || []);
    } catch {
      // transient network failure -- keep showing the last known list
    } finally {
      contentRefreshingRef.current = false;
    }
  }, [selectedId]);

  useEffect(() => {
    setSessions([]);
    setGroups([]);
    setExpandedGroupId(null);
  }, [selectedId]);

  useVisiblePolling(refreshContent, CONTENT_POLL_MS, visible && !!selectedId);

  const toggleGroup = useCallback(async (groupId) => {
    if (expandedGroupId === groupId) {
      setExpandedGroupId(null);
      setGroupMembers([]);
      return;
    }
    setExpandedGroupId(groupId);
    setGroupMembers([]);
    try {
      const res = await authFetch(`/api/federation/instances/${encodeURIComponent(selectedId)}/groups/${encodeURIComponent(groupId)}/members`);
      if (res.ok) setGroupMembers((await res.json()).members || []);
    } catch {
      // leave the member list empty on failure
    }
  }, [selectedId, expandedGroupId]);

  const instance = instances.find((i) => i.id === selectedId) || null;

  const openSessionTab = useCallback((session) => {
    if (!instance) return;
    onOpenRemoteTerminal(instance, session.cwd, {
      shell: !!session.shell,
      attachSessionId: session.id,
      app: session.app || 'claude',
      sandbox: !!session.sandbox,
      sandboxOpts: session.sandboxOpts || null,
    });
  }, [instance, onOpenRemoteTerminal]);

  const openMemberTab = useCallback((member) => {
    if (!instance || !member.sessionId || member.exited) return;
    onOpenRemoteTerminal(instance, member.cwd, {
      attachSessionId: member.sessionId,
      app: member.app || 'claude',
      sandbox: !!member.sandbox,
      sandboxOpts: member.sandboxOpts || null,
    });
  }, [instance, onOpenRemoteTerminal]);

  const destroySession = useCallback(async (session) => {
    if (!instance) return;
    if (!window.confirm(`リモートセッション "${session.cwd}" を終了しますか?`)) return;
    try {
      await authFetch(`/api/federation/instances/${encodeURIComponent(instance.id)}/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
      refreshContent();
    } catch (err) {
      window.alert(`終了に失敗しました: ${err.message}`);
    }
  }, [instance, refreshContent]);

  const destroyGroup = useCallback(async (group) => {
    if (!instance) return;
    if (!window.confirm(`リモートグループ "${group.cwd}" を破棄しますか?(全メンバーのセッションが終了します)`)) return;
    try {
      await authFetch(`/api/federation/instances/${encodeURIComponent(instance.id)}/groups/${encodeURIComponent(group.groupId)}`, { method: 'DELETE' });
      refreshContent();
    } catch (err) {
      window.alert(`破棄に失敗しました: ${err.message}`);
    }
  }, [instance, refreshContent]);

  const openLaunch = useCallback((kind) => {
    setLaunchKind(kind);
    setLaunchCwd('');
    setLaunchApp('claude');
    setLaunchShell(false);
    setLaunchSandbox(false);
    setLaunchError(null);
    setDirListing(null);
    setLaunchOpen(true);
  }, [instance]);

  const browseDir = useCallback(async (path) => {
    if (!instance) return;
    try {
      const res = await authFetch(`/api/federation/instances/${encodeURIComponent(instance.id)}/dirs?path=${encodeURIComponent(path || '/')}`);
      if (!res.ok) return;
      const data = await res.json();
      setDirListing(data);
      setLaunchCwd(data.current);
    } catch {
      // leave the current listing (if any) as-is
    }
  }, [instance]);

  const submitLaunch = useCallback(async (e) => {
    e.preventDefault();
    if (!instance || !launchCwd.trim() || launching) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      const path = launchKind === 'session' ? 'sessions' : 'groups';
      const body = launchKind === 'session'
        ? { cwd: launchCwd.trim(), app: launchShell ? null : launchApp, shell: launchShell, sandbox: launchSandbox }
        : { cwd: launchCwd.trim() };
      const res = await authFetch(`/api/federation/instances/${encodeURIComponent(instance.id)}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLaunchError(data.error || `HTTP ${res.status}`);
        return;
      }
      setLaunchOpen(false);
      if (launchKind === 'session') {
        onOpenRemoteTerminal(instance, launchCwd.trim(), {
          attachSessionId: data.sessionId,
          app: data.app || launchApp,
          shell: launchShell,
          sandbox: !!data.sandbox,
          sandboxOpts: data.sandboxOpts || null,
        });
      }
      refreshContent();
    } catch (err) {
      setLaunchError(err.message || '通信エラー');
    } finally {
      setLaunching(false);
    }
  }, [instance, launchKind, launchCwd, launchApp, launchShell, launchSandbox, launching, onOpenRemoteTerminal, refreshContent]);

  if (!visible) return null;

  return (
    <div className="remote-instance-view">
      {loading && <p className="settings-empty">読み込み中…</p>}
      {error && <p className="settings-error">読み込みに失敗しました: {error}</p>}
      {!loading && instances.length === 0 && (
        <p className="settings-empty">
          アクティブなペアリング済みインスタンスがありません。Settings タブでインスタンスをペアリングしてください。
        </p>
      )}
      {instances.length > 0 && (
        <>
          <div className="remote-instance-picker">
            {instances.map((i) => (
              <button
                key={i.id}
                className={`remote-instance-tab${i.id === selectedId ? ' active' : ''}`}
                onClick={() => setSelectedId(i.id)}
              >
                {i.label || i.fingerprint.slice(0, 8)}
              </button>
            ))}
          </div>

          {instance && (
            <div className="remote-instance-header" data-testid="remote-instance-header">
              <span className="remote-instance-header-label" title={instance.fingerprint}>{instance.label || '(名前未設定)'}</span>
              <span className="pairing-status-badge pairing-status-active">接続中</span>
              <span className="pairing-addr" title={instance.addr}>{instance.addr}</span>
              {instance.hostnameClaimed && <span className="pairing-hostname" title="相手の自己申告ホスト名">{instance.hostnameClaimed}</span>}
              <span className="pairing-fingerprint" title={instance.fingerprint}>{shortFingerprint(instance.fingerprint)}</span>
            </div>
          )}

          {instance && (
            <div className="remote-instance-body">
              <div className="remote-instance-actions">
                <button className="btn btn-secondary" onClick={() => openLaunch('session')}>+ セッションを起動</button>
                <button className="btn btn-secondary" onClick={() => openLaunch('group')}>+ コンボを起動</button>
              </div>

              <h3>セッション</h3>
              {sessions.length === 0 && <p className="settings-empty">実行中のセッションはありません。</p>}
              {sessions.length > 0 && (
                <ul className="sandbox-list">
                  {sessions.map((s) => (
                    <li key={s.id} className="sandbox-row">
                      <div className="sandbox-body" onClick={() => openSessionTab(s)} style={{ cursor: 'pointer' }}>
                        <div className="sandbox-item-top">
                          <span className="pairing-status-badge pairing-status-active">{s.app || 'shell'}</span>
                          {s.groupId && <span className="pairing-addr">group {s.groupId.slice(0, 8)}/{s.groupRole}</span>}
                        </div>
                        <div className="sandbox-info">
                          <span className="sandbox-name">{formatCwd(s.cwd)}</span>
                        </div>
                      </div>
                      <button className="sandbox-delete-btn" onClick={() => destroySession(s)} title="セッションを終了" aria-label="セッションを終了">
                        &#10005;
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <h3>コンボ (グループ)</h3>
              {groups.length === 0 && <p className="settings-empty">実行中のコンボはありません。</p>}
              {groups.length > 0 && (
                <ul className="sandbox-list">
                  {groups.map((g) => (
                    <li key={g.groupId} className="sandbox-row remote-group-row">
                      <div className="sandbox-body" onClick={() => toggleGroup(g.groupId)} style={{ cursor: 'pointer' }}>
                        <div className="sandbox-item-top">
                          <span className="pairing-status-badge pairing-status-active">{g.liveCount}/{g.memberCount}</span>
                        </div>
                        <div className="sandbox-info">
                          <span className="sandbox-name">{formatCwd(g.cwd)}</span>
                        </div>
                        {expandedGroupId === g.groupId && (
                          <ul className="remote-group-members">
                            {groupMembers.map((m) => (
                              <li key={m.role}>
                                <button
                                  className="pairing-label-btn"
                                  disabled={m.exited}
                                  onClick={(e) => { e.stopPropagation(); openMemberTab(m); }}
                                >
                                  {m.role} ({m.app || 'claude'}){m.exited ? ' -- 終了済み' : ''}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <button className="sandbox-delete-btn" onClick={() => destroyGroup(g)} title="コンボを破棄" aria-label="コンボを破棄">
                        &#10005;
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      {launchOpen && instance && (
        <div className="resume-overlay" onClick={() => !launching && setLaunchOpen(false)}>
          <form className="resume-dialog pairing-dialog remote-launch-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitLaunch}>
            <h3>{launchKind === 'session' ? 'リモートセッションを起動' : 'リモートコンボを起動'}</h3>
            <p className="pairing-modal-hint">起動先: {instance.label || instance.fingerprint.slice(0, 8)}</p>
            <label className="pairing-field">
              作業ディレクトリ (相手インスタンス上のパス)
              <input type="text" value={launchCwd} onChange={(e) => setLaunchCwd(e.target.value)} placeholder="/home/user/project" required autoFocus />
            </label>
            <div className="remote-dir-browse">
              <button type="button" className="btn btn-secondary" onClick={() => browseDir(launchCwd || '/')}>参照</button>
              {dirListing && (
                <div className="remote-dir-listing">
                  <div className="remote-dir-current">{dirListing.current}</div>
                  {dirListing.parent && (
                    <button type="button" className="pairing-label-btn" onClick={() => browseDir(dirListing.parent)}>.. (親へ)</button>
                  )}
                  {(dirListing.dirs || []).map((d) => (
                    <button type="button" key={d.path} className="pairing-label-btn" onClick={() => browseDir(d.path)}>
                      {d.name}/
                    </button>
                  ))}
                </div>
              )}
            </div>
            {launchKind === 'session' && (
              <>
                <label className="pairing-field pairing-field--checkbox">
                  <input type="checkbox" checked={launchShell} onChange={(e) => setLaunchShell(e.target.checked)} /> シェル
                </label>
                {!launchShell && (
                  <label className="pairing-field">
                    アプリ
                    <select value={launchApp} onChange={(e) => setLaunchApp(e.target.value)}>
                      {APPS.map((a) => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </label>
                )}
                <label className="pairing-field pairing-field--checkbox">
                  <input type="checkbox" checked={launchSandbox} onChange={(e) => setLaunchSandbox(e.target.checked)} /> サンドボックス
                </label>
              </>
            )}
            {launchError && <p className="settings-error">{launchError}</p>}
            <div className="resume-actions">
              <button type="submit" className="btn btn-primary" disabled={launching || !launchCwd.trim()}>
                {launching ? '起動中…' : '起動'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setLaunchOpen(false)} disabled={launching}>
                キャンセル
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
