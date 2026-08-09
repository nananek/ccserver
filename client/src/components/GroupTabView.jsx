import { useState, useEffect, useRef, lazy, Suspense } from 'react';
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
}) {
  const [members, setMembers] = useState(initialMembers || []);
  const [activeRole, setActiveRole] = useState(() => initialMembers?.[0]?.role || null);
  const membersRef = useRef(members);

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
        if (!res.ok) return;
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
  useEffect(() => {
    if (!visible) return;
    const active = members.find((m) => m.role === activeRole);
    const app = active?.app === 'opencode' ? 'opencode' : active?.app === 'claude' ? 'claude' : null;
    onActiveAppChange?.(app);
  }, [members, activeRole, visible, onActiveAppChange]);

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
            className={`group-subtab-item${m.role === activeRole ? ' active' : ''}${m.exited ? ' exited' : ''}`}
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
      </div>
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
                xtermTheme={xtermTheme}
                themeId={themeId}
                onThemeChange={onThemeChange}
                notify={notify}
                notifyEnabled={notifyEnabled}
                notifyPermission={notifyPermission}
                onToggleNotify={onToggleNotify}
              />
            </Suspense>
          </div>
        ))}
      </div>
    </div>
  );
}
