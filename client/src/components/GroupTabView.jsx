import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { authFetch } from '../auth.js';
import TabIcon from './TabIcon.jsx';

const TerminalView = lazy(() => import('./TerminalView.jsx'));

// A combo group's tab body: a second-level sub-tab bar (one entry per member:
// workerA / workerB / orchestrator) above always-mounted TerminalViews, one
// per member session, switched by display exactly like the top-level tabs.
//
// Membership is discovered ONLY from GET /api/groups/:id (polled while
// visible) -- the orchestrator's open_tab additions appear here after the
// next poll. No sessionId is ever constructed client-side; the authorization
// boundary lives server-side (groupManager.isSessionInGroup).
export default function GroupTabView({
  groupId,
  initialMembers,
  visible,
  xtermTheme,
  themeId,
  onThemeChange,
  notify,
  notifyEnabled,
  notifyPermission,
  onToggleNotify,
  onActiveAppChange,
  tabId,
  onAttention,
  onFocusTab,
}) {
  const [members, setMembers] = useState(initialMembers || []);
  const [activeRole, setActiveRole] = useState(() => initialMembers?.[0]?.role || null);
  const [restartingOrch, setRestartingOrch] = useState(false);
  const [groupGone, setGroupGone] = useState(false);
  const membersRef = useRef(members);
  const wasVisibleRef = useRef(visible);

  useEffect(() => { membersRef.current = members; }, [members]);

  useEffect(() => {
    if (initialMembers && (!activeRole || !initialMembers.some((m) => m.role === activeRole))) {
      setActiveRole(initialMembers[0]?.role || null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMembers]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await authFetch(`/api/groups/${groupId}`);
        if (res.status === 404) {
          // The group is gone server-side (torn down from another client /
          // the server restarted and the group was destroyed): nothing left
          // to poll. Show a banner instead of silently staying stale.
          setGroupGone(true);
          return;
        }
        if (!res.ok) return;
        setGroupGone(false);
        const data = await res.json();
        if (cancelled) return;
        const next = data.members || [];
        const prev = membersRef.current;
        if (JSON.stringify(next) !== JSON.stringify(prev)) {
          setMembers(next);
          setActiveRole((role) => {
            if (role && next.some((m) => m.role === role)) return role;
            return next[0]?.role || null;
          });
        }
      } catch {
        // poll is best effort; the next tick retries
      }
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible, groupId]);

  // Report the active member's app upward (App uses it to hide the Usage
  // button for opencode). While this tab is visible it emits on every change
  // -- no per-instance dedup: App's single shared state must always reflect
  // the currently visible group tab, and multiple group tabs stay mounted
  // while hidden (their own last-reported value would otherwise go stale).
  // On becoming hidden it emits null so switching tabs never leaves a stale
  // group's app in App's state.
  useEffect(() => {
    if (!visible) {
      if (wasVisibleRef.current) {
        wasVisibleRef.current = false;
        onActiveAppChange?.(null);
      }
      return;
    }
    wasVisibleRef.current = true;
    const active = members.find((m) => m.role === activeRole);
    const app = active?.app === 'opencode' ? 'opencode' : active?.app === 'claude' ? 'claude' : null;
    onActiveAppChange?.(app);
  }, [members, activeRole, visible, onActiveAppChange]);

  // Restart a dead orchestrator: the server spawns a fresh orchestrator
  // session in the group's own dir and re-creates the control broker. The
  // poll loop picks the new member up on the next tick.
  const restartOrchestrator = useCallback(async () => {
    if (restartingOrch) return;
    setRestartingOrch(true);
    try {
      const res = await authFetch(`/api/groups/${groupId}/orchestrator`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      window.alert(`オーケストレーターを再起動できませんでした: ${err.message}`);
    } finally {
      setRestartingOrch(false);
    }
  }, [groupId, restartingOrch]);

  const orchestrator = members.find((m) => m.role === 'orchestrator');

  const roleLabel = (role) => {
    if (role === 'orchestrator') return 'Orchestrator';
    if (role === 'workerA') return 'Worker A';
    if (role === 'workerB') return 'Worker B';
    return role;
  };

  return (
    <div className="group-tab-view">
      <div className="group-subtab-bar">
        {members.map((m) => (
          <div
            key={m.role}
            className={`group-subtab-item${m.role === activeRole ? ' active' : ''}${m.exited ? ' exited' : ''}${!m.sandbox ? ' no-sandbox' : ''}`}
            onClick={() => setActiveRole(m.role)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setActiveRole(m.role);
            }}
          >
            <span className="group-subtab-label">
              <TabIcon type="terminal" app={m.app === 'opencode' ? 'opencode' : 'claude'} shell={false} />
              {roleLabel(m.role)}
              {m.exited && <span className="group-subtab-exited" title="exited">&#10005;</span>}
            </span>
          </div>
        ))}
        {orchestrator?.exited && (
          <button
            className="btn btn-secondary group-restart-orch-btn"
            onClick={restartOrchestrator}
            disabled={restartingOrch}
            title="オーケストレーターが終了しています。再起動しますか?"
          >
            {restartingOrch ? '再起動中...' : 'Orchestrator 再起動'}
          </button>
        )}
      </div>
      {groupGone && (
        <div className="group-gone-banner">
          このグループはサーバー上で削除されています。このタブを閉じてください。
        </div>
      )}
      <div className="group-subtab-body">
        {members.map((m) => (
          <div
            key={m.sessionId}
            style={{ display: m.role === activeRole && visible ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}
          >
            <Suspense fallback={null}>
              <TerminalView
                cwd={m.cwd}
                app={m.app === 'opencode' ? 'opencode' : 'claude'}
                attachSessionId={m.sessionId}
                visible={m.role === activeRole && visible}
                // Resume settings for a dead member (exited after a restart
                // or on its own): the attach fails with SESSION_NOT_FOUND and
                // TerminalView re-launches with these, keeping the member's
                // group membership (groupId/groupRole) and conversation
                // (claudeSessionId / opencode resume) intact.
                claudeSessionId={m.claudeSessionId}
                sandbox={m.sandbox}
                sandboxOpts={m.sandboxOpts}
                resume={m.app === 'opencode'}
                groupId={groupId}
                groupRole={m.role}
                xtermTheme={xtermTheme}
                themeId={themeId}
                onThemeChange={onThemeChange}
                notify={notify}
                notifyEnabled={notifyEnabled}
                notifyPermission={notifyPermission}
                onToggleNotify={onToggleNotify}
                tabId={tabId}
                onAttention={onAttention}
                onFocusTab={() => {
                  // Bring up this group tab AND the specific member whose
                  // notification was clicked.
                  setActiveRole(m.role);
                  onFocusTab?.();
                }}
              />
            </Suspense>
          </div>
        ))}
      </div>
    </div>
  );
}
