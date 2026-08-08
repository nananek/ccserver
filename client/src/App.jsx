import { useState, useCallback, useRef, useEffect, lazy, Suspense } from 'react';
import DirectoryBrowser from './components/DirectoryBrowser.jsx';
import SystemMonitor from './components/SystemMonitor.jsx';
import UsageButton from './components/UsageButton.jsx';
import TabIcon from './components/TabIcon.jsx';
import GroupTabView from './components/GroupTabView.jsx';
import { useNotifications } from './hooks/useNotifications.js';
import { authFetch } from './auth.js';
import { getTheme, loadThemeId, saveThemeId, applyThemeCss } from './themes.js';

const TerminalView = lazy(() => import('./components/TerminalView.jsx'));

let tabIdCounter = 0;

export default function App() {
  const [tabs, setTabs] = useState([
    { id: 'browser', type: 'browser', label: 'Files' },
    { id: 'monitor', type: 'monitor', label: 'Monitor' },
  ]);
  const [activeTabId, setActiveTabId] = useState('browser');
  const [lastDir, setLastDir] = useState(() => localStorage.getItem('ccserver-last-dir'));
  const [resumePrompt, setResumePrompt] = useState(null);
  const [themeId, setThemeId] = useState(loadThemeId);
  const [attentionTabs, setAttentionTabs] = useState(new Set());
  const [closeConfirm, setCloseConfirm] = useState(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [groupActiveApp, setGroupActiveApp] = useState(null);
  const [skipCloseConfirm, setSkipCloseConfirm] = useState(
    () => localStorage.getItem('ccserver-skip-close-confirm') === '1'
  );
  const pendingOpenRef = useRef(null);
  const { enabled: notifyEnabled, permission: notifyPermission, toggle: toggleNotify, notify } = useNotifications();

  useEffect(() => {
    applyThemeCss(themeId);
    saveThemeId(themeId);
  }, [themeId]);

  const openTerminalTab = useCallback((dirPath, { claudeSessionId = null, shell = false, sessionId = null, attachSessionId = null, sandbox = false, sandboxOpts = null, app = 'claude', resume = false } = {}) => {
    const id = `terminal-${++tabIdCounter}`;
    const dirName = dirPath.split(/[/\\]/).filter(Boolean).pop() || dirPath;
    const label = shell ? `$ ${dirName}` : dirName;
    setTabs((prev) => [
      ...prev,
      { id, type: 'terminal', label, cwd: dirPath, claudeSessionId, shell, sessionId, attachSessionId, sandbox, sandboxOpts, app, resume, exited: false },
    ]);
    setActiveTabId(id);
    setLastDir(dirPath);
  }, []);

  const handleOpen = useCallback((dirPath, { sandbox = false, sandboxOpts = null, app = 'claude', resume = false, skipResumePrompt = false } = {}) => {
    // Only claude sessions carry a resumable conversation id (opencode resumes
    // the last session of the project itself via -c).
    if (!skipResumePrompt && app === 'claude') {
      const savedSessionId = localStorage.getItem(`ccserver-resume:claude:${dirPath}`);
      if (savedSessionId) {
        pendingOpenRef.current = dirPath;
        setResumePrompt({ cwd: dirPath, sessionId: savedSessionId, sandbox, sandboxOpts, app });
        return;
      }
    }
    openTerminalTab(dirPath, { sandbox, sandboxOpts, app, resume });
  }, [openTerminalTab]);

  const handleOpenShell = useCallback((dirPath) => {
    openTerminalTab(dirPath, { shell: true });
  }, [openTerminalTab]);

  // Combo launch: ask the server to spawn 2 workers + 1 orchestrator as one
  // group, then add a single group tab for all three (each member attaches
  // over the regular WS attach flow once its TerminalView mounts).
  const handleOpenCombo = useCallback(async (cwd, cfg) => {
    try {
      const res = await authFetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, ...cfg }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const id = `group-${++tabIdCounter}`;
      const dirName = cwd.split(/[/\\]/).filter(Boolean).pop() || cwd;
      setTabs((prev) => [...prev, {
        id,
        type: 'group',
        label: dirName,
        groupId: data.groupId,
        members: data.members || [],
      }]);
      setActiveTabId(id);
      setLastDir(cwd);
    } catch (err) {
      // Surface launch failures in the directory browser (which owns the
      // combo modal); a failed group launch should not silently no-op.
      window.alert(`コンボ起動に失敗しました: ${err.message}`);
    }
  }, []);

  const handleSessionClick = useCallback((session) => {
    // Check if a tab is already open for this session
    const existingTab = tabs.find((t) => t.sessionId === session.id);
    if (existingTab) {
      setActiveTabId(existingTab.id);
      return;
    }
    // Carry the session's launch settings over so a re-launch after the
    // original pty is gone (SESSION_NOT_FOUND -> re-init in TerminalView)
    // keeps the sandbox instead of silently dropping it.
    openTerminalTab(session.cwd, {
      shell: !!session.shell,
      sessionId: session.id,
      attachSessionId: session.id,
      app: session.app === 'opencode' ? 'opencode' : 'claude',
      sandbox: !!session.sandbox,
      sandboxOpts: session.sandboxOpts || null,
      // opencode re-launches resume the last session of the project (-c), so
      // a continued conversation survives the dead pty like claude's does.
      resume: session.app === 'opencode',
    });
  }, [tabs, openTerminalTab]);

  const handleResume = useCallback(() => {
    if (resumePrompt) {
      openTerminalTab(resumePrompt.cwd, { claudeSessionId: resumePrompt.sessionId, sandbox: resumePrompt.sandbox, sandboxOpts: resumePrompt.sandboxOpts, app: resumePrompt.app || 'claude' });
      setResumePrompt(null);
      pendingOpenRef.current = null;
    }
  }, [resumePrompt, openTerminalTab]);

  const handleNewSession = useCallback(() => {
    if (resumePrompt) {
      localStorage.removeItem(`ccserver-resume:claude:${resumePrompt.cwd}`);
      openTerminalTab(resumePrompt.cwd, { sandbox: resumePrompt.sandbox, sandboxOpts: resumePrompt.sandboxOpts, app: resumePrompt.app || 'claude' });
      setResumePrompt(null);
      pendingOpenRef.current = null;
    }
  }, [resumePrompt, openTerminalTab]);

  const doCloseTab = useCallback((tabId) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      const next = prev.filter((t) => t.id !== tabId);
      // If we're closing the active tab, switch to an adjacent tab
      if (tabId === activeTabId) {
        const newActive = next[Math.min(idx, next.length - 1)];
        setActiveTabId(newActive ? newActive.id : 'browser');
      }
      return next;
    });
  }, [activeTabId]);

  // Server-side teardown for a group tab: DELETE /api/groups/:id destroys the
  // 3 member sessions + MCP brokers. Must run even when the close-confirm is
  // skipped ("次回以降確認しない"), otherwise the sessions and their Unix
  // sockets leak for as long as the server runs.
  const destroyGroupTab = useCallback(async (tab) => {
    try {
      await authFetch(`/api/groups/${tab.groupId}`, { method: 'DELETE' });
    } catch {
      // group teardown already happened server-side or is unreachable;
      // closing the tab is still the right move
    }
  }, []);

  const handleCloseTab = useCallback((tabId) => {
    // タブを閉じてもセッション自体はサーバー側で動き続けるが、
    // 再アタッチの手間があるため、稼働中のタブは閉じる前に確認する。
    // プロセスが終了済みのタブや「次回以降確認しない」設定時は確認なしで閉じる。
    // グループタブは3セッションを破棄するため必ず確認する。
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.type === 'group') {
      if (skipCloseConfirm) {
        destroyGroupTab(tab);
        doCloseTab(tabId);
      } else {
        setDontAskAgain(false);
        setCloseConfirm({ tabId, kind: 'group' });
      }
      return;
    }
    if (tab && tab.type === 'terminal' && !tab.exited && !skipCloseConfirm) {
      setDontAskAgain(false);
      setCloseConfirm({ tabId, kind: 'terminal' });
      return;
    }
    doCloseTab(tabId);
  }, [tabs, skipCloseConfirm, doCloseTab, destroyGroupTab]);

  const confirmCloseTab = useCallback(async () => {
    if (!closeConfirm) return;
    if (dontAskAgain) {
      localStorage.setItem('ccserver-skip-close-confirm', '1');
      setSkipCloseConfirm(true);
    }
    const tab = tabs.find((t) => t.id === closeConfirm.tabId);
    if (tab?.type === 'group') {
      await destroyGroupTab(tab);
    }
    doCloseTab(closeConfirm.tabId);
    setCloseConfirm(null);
  }, [closeConfirm, dontAskAgain, tabs, doCloseTab, destroyGroupTab]);

  const handleTabClick = useCallback((tabId) => {
    setActiveTabId(tabId);
    setAttentionTabs((prev) => {
      if (!prev.has(tabId)) return prev;
      const next = new Set(prev);
      next.delete(tabId);
      return next;
    });
  }, []);

  const handleTabExited = useCallback((tabId, exited) => {
    setTabs((prev) => prev.map((t) =>
      t.id === tabId ? { ...t, exited } : t
    ));
  }, []);

  const handleTabSessionId = useCallback((tabId, sessionId) => {
    setTabs((prev) => prev.map((t) =>
      t.id === tabId ? { ...t, sessionId } : t
    ));
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  // Usage (Claude spend) is only meaningful for claude sessions; hide it for
  // opencode terminals and for a group tab whose active sub-tab is opencode.
  const usageHidden = (activeTab?.type === 'terminal' && activeTab.app === 'opencode')
    || (activeTab?.type === 'group' && groupActiveApp === 'opencode');

  return (
    <div className="app">
      <div className="tab-bar">
        <div className="tab-list">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab-item${tab.id === activeTabId ? ' active' : ''}${attentionTabs.has(tab.id) ? ' attention' : ''}`}
            onClick={() => handleTabClick(tab.id)}
          >
            <span className="tab-label">
              <TabIcon type={tab.type} app={tab.app} shell={tab.shell} />
              {tab.label}
            </span>
            {tab.type !== 'browser' && tab.type !== 'monitor' && (
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseTab(tab.id);
                }}
                title="Close"
              >
                &#10005;
              </button>
            )}
          </div>
        ))}
        <div className="tab-bar-spacer" />
        </div>
        <UsageButton hidden={usageHidden} />
      </div>
      <div className="tab-content">
        <div style={{ display: activeTabId === 'browser' ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}>
          <DirectoryBrowser onOpen={handleOpen} onOpenShell={handleOpenShell} onOpenCombo={handleOpenCombo} onSessionClick={handleSessionClick} initialPath={lastDir} />
        </div>
        <div style={{ display: activeTabId === 'monitor' ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}>
          <SystemMonitor visible={activeTabId === 'monitor'} />
        </div>
        {tabs
          .filter((t) => t.type === 'terminal')
          .map((tab) => (
            <div
              key={tab.id}
              style={{ display: activeTabId === tab.id ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}
            >
              <Suspense fallback={null}>
                <TerminalView
                  cwd={tab.cwd}
                  onClose={() => handleCloseTab(tab.id)}
                  claudeSessionId={tab.claudeSessionId}
                  shell={tab.shell}
                  sandbox={tab.sandbox}
                  sandboxOpts={tab.sandboxOpts}
                  app={tab.app || 'claude'}
                  resume={!!tab.resume}
                  notify={notify}
                  notifyEnabled={notifyEnabled}
                  notifyPermission={notifyPermission}
                  onToggleNotify={toggleNotify}
                  visible={activeTabId === tab.id}
                  onSessionId={(sid) => handleTabSessionId(tab.id, sid)}
                  onExited={(exited) => handleTabExited(tab.id, exited)}
                  attachSessionId={tab.attachSessionId}
                  xtermTheme={getTheme(themeId).xterm}
                  themeId={themeId}
                  onThemeChange={setThemeId}
                  tabId={tab.id}
                  onAttention={() => {
                    if (activeTabId !== tab.id) {
                      setAttentionTabs((prev) => new Set(prev).add(tab.id));
                    }
                  }}
                  onFocusTab={() => handleTabClick(tab.id)}
                />
              </Suspense>
            </div>
          ))}
        {tabs
          .filter((t) => t.type === 'group')
          .map((tab) => (
            <div
              key={tab.id}
              style={{ display: activeTabId === tab.id ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}
            >
              <GroupTabView
                groupId={tab.groupId}
                initialMembers={tab.members}
                visible={activeTabId === tab.id}
                xtermTheme={getTheme(themeId).xterm}
                themeId={themeId}
                onThemeChange={setThemeId}
                notify={notify}
                notifyEnabled={notifyEnabled}
                notifyPermission={notifyPermission}
                onToggleNotify={toggleNotify}
                onActiveAppChange={setGroupActiveApp}
              />
            </div>
          ))}
      </div>
      {resumePrompt && (
        <div className="resume-overlay" onClick={handleNewSession}>
          <div className="resume-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Resume previous session?</h3>
            <p className="resume-session-id">{resumePrompt.sessionId}</p>
            <div className="resume-actions">
              <button className="btn btn-primary" onClick={handleResume}>
                Resume
              </button>
              <button className="btn btn-secondary" onClick={handleNewSession}>
                New Session
              </button>
            </div>
          </div>
        </div>
      )}
      {closeConfirm && (
        <div className="resume-overlay" onClick={() => setCloseConfirm(null)}>
          <div className="resume-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{closeConfirm.kind === 'group' ? 'グループを閉じますか?' : 'タブを閉じますか?'}</h3>
            <p>{closeConfirm.kind === 'group'
              ? 'グループの3つのセッション（ワーカー2つとオーケストレーター）を終了します。'
              : 'セッションは背後で動き続け、セッション一覧から再接続できます。'}</p>
            <label className="close-confirm-checkbox">
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={(e) => setDontAskAgain(e.target.checked)}
              />
              次回以降確認しない
            </label>
            <div className="resume-actions">
              <button className="btn btn-secondary" onClick={() => setCloseConfirm(null)}>
                キャンセル
              </button>
              <button className="btn btn-primary" onClick={confirmCloseTab}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
