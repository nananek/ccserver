import { useState, useCallback, useRef, useEffect, lazy, Suspense } from 'react';
import DirectoryBrowser from './components/DirectoryBrowser.jsx';
import SystemMonitor from './components/SystemMonitor.jsx';
import SettingsView from './components/SettingsView.jsx';
import ApprovalBanner from './components/ApprovalBanner.jsx';
import PairingRequestBanner from './components/PairingRequestBanner.jsx';
import UsageButton from './components/UsageButton.jsx';
import TabIcon from './components/TabIcon.jsx';
import GroupTabView from './components/GroupTabView.jsx';
import RemoteInstanceView from './components/RemoteInstanceView.jsx';
import { useNotifications } from './hooks/useNotifications.js';
import { authFetch } from './auth.js';
import { getTheme, loadThemeId, saveThemeId, applyThemeCss } from './themes.js';
import { isAppSelectable } from './appAvailability.js';

const TerminalView = lazy(() => import('./components/TerminalView.jsx'));

let tabIdCounter = 0;

export default function App() {
  const [tabs, setTabs] = useState([
    { id: 'browser', type: 'browser', label: 'Files' },
    { id: 'monitor', type: 'monitor', label: 'Monitor' },
    { id: 'remote', type: 'remote', label: 'Remote' },
  ]);
  const [activeTabId, setActiveTabId] = useState('browser');
  const [lastDir, setLastDir] = useState(() => localStorage.getItem('ccserver-last-dir'));
  const [resumePrompt, setResumePrompt] = useState(null);
  // Reuse dialog for a sandboxed launch when a previous persistent sandbox
  // exists for the project: { cwd, sandbox, sandboxOpts, app, model, resume,
  // skipResumePrompt, reuseSandboxHome, inUse }.
  const [sandboxPrompt, setSandboxPrompt] = useState(null);
  const [themeId, setThemeId] = useState(loadThemeId);
  const [closeConfirm, setCloseConfirm] = useState(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [groupActiveApp, setGroupActiveApp] = useState(null);
  // Bumped whenever a group is created / destroyed / re-opened, so the
  // directory browser's groups list refetches (it is otherwise fetch-on-mount).
  const [groupsVersion, setGroupsVersion] = useState(0);
  const [skipCloseConfirm, setSkipCloseConfirm] = useState(
    () => localStorage.getItem('ccserver-skip-close-confirm') === '1'
  );
  const pendingOpenRef = useRef(null);
  const { enabled: notifyEnabled, permission: notifyPermission, toggle: toggleNotify, notify } = useNotifications();
  // Server-side facts from /api/dirs/home: whether the Usage button is
  // enabled (sandbox.config.json's "showUsage") and which agent CLIs are
  // installed here (availableApps). Usage is only meaningful when claude
  // exists, so a missing claude hides the button regardless of showUsage.
  const [usagePrefs, setUsagePrefs] = useState({ showUsage: true, availableApps: null, hiddenApps: [] });
  const [metaAgentDir, setMetaAgentDir] = useState(null);

  useEffect(() => {
    applyThemeCss(themeId);
    saveThemeId(themeId);
  }, [themeId]);

  // Browser tab title: "<hostname> ccserver" (hostname resolved server-side
  // with the same precedence as the notify footer's _from: <host>). The
  // static index.html fallback is "ccserver"; this upgrades it once the API
  // answers. Silent on failure (e.g. token auth gate) -- the fallback stays.
  // Idempotent, so React StrictMode's double mount is harmless.
  useEffect(() => {
    authFetch('/api/dirs/home')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        if (data.hostname) document.title = `${data.hostname} ccserver`;
        // Absent keys (older server / default config) keep the button shown
        // and the app picker unrestricted.
        setUsagePrefs({
          showUsage: data.showUsage !== false,
          availableApps: data.availableApps || null,
          hiddenApps: Array.isArray(data.hiddenApps) ? data.hiddenApps : [],
        });
        if (data.metaAgentDir) setMetaAgentDir(data.metaAgentDir);
      })
      .catch(() => {});
  }, []);

  const openTerminalTab = useCallback((dirPath, { claudeSessionId = null, shell = false, sessionId = null, attachSessionId = null, sandbox = false, sandboxOpts = null, app = 'claude', model = null, resume = false, reuseSandboxHome = true, isMetaAgent = false } = {}) => {
    const id = `terminal-${++tabIdCounter}`;
    const dirName = dirPath.split(/[/\\]/).filter(Boolean).pop() || dirPath;
    // Meta-agent tabs carry a ⌘ prefix (plus their own tab icon): the
    // privileged session must be recognizable at a glance in the tab bar.
    const label = shell ? `$ ${dirName}` : isMetaAgent ? `⌘ ${dirName}` : dirName;
    setTabs((prev) => [
      ...prev,
      { id, type: 'terminal', label, cwd: dirPath, claudeSessionId, shell, sessionId, attachSessionId, sandbox, sandboxOpts, app, model, resume, reuseSandboxHome, isMetaAgent, exited: false },
    ]);
    setActiveTabId(id);
    if (!isMetaAgent) setLastDir(dirPath);
  }, []);

  // Remote (federated) counterpart of openTerminalTab: same tab shape, plus
  // `remote: {instanceId, label}` so TerminalView connects through
  // /ws/remote-terminal instead of /ws/terminal (see its remoteInstanceId
  // prop). `instance` is a paired_instances row (from RemoteInstanceView's
  // GET /api/federation/instances poll); `dirPath`/opts describe the REMOTE
  // session, so no local sandbox-reuse-dialog / resume-prompt detour applies
  // (Phase 1's remote launch surface is intentionally the plain REST shape,
  // see RemoteInstanceView.jsx's header comment) -- this always opens
  // directly, unlike handleOpen/continueOpen for local sessions.
  const openRemoteTerminalTab = useCallback((instance, dirPath, { shell = false, attachSessionId = null, sandbox = false, sandboxOpts = null, app = 'claude' } = {}) => {
    const id = `terminal-${++tabIdCounter}`;
    const dirName = (dirPath || '').split(/[/\\]/).filter(Boolean).pop() || dirPath || instance.label;
    const label = `⇄ ${dirName}`;
    setTabs((prev) => [
      ...prev,
      {
        id, type: 'terminal', label, cwd: dirPath, shell, attachSessionId, sandbox, sandboxOpts, app,
        exited: false,
        remote: { instanceId: instance.id, label: instance.label || instance.fingerprint?.slice(0, 8) },
      },
    ]);
    setActiveTabId(id);
  }, []);

  // The post-sandbox-dialog open flow: claude's resume prompt (if a saved
  // conversation exists), else a plain tab open. Carries the chosen
  // reuseSandboxHome through so a resumed conversation keeps the same HOME.
  const continueOpen = useCallback((dirPath, { sandbox = false, sandboxOpts = null, app = 'claude', model = null, resume = false, skipResumePrompt = false, reuseSandboxHome = true, isMetaAgent = false } = {}) => {
    // Only claude sessions carry a resumable conversation id (opencode resumes
    // the last session of the project itself via -c). Meta-agent opens skip
    // the prompt and always start fresh: the user just confirmed a privileged
    // launch, and resuming whatever worker conversation last ran in this
    // directory would graft ccserver-meta onto a context written without it.
    // Conscious returns to a specific meta session still work (sidebar
    // re-open, SESSION_NOT_FOUND re-init) -- those keep claudeSessionId.
    if (!skipResumePrompt && !isMetaAgent && app === 'claude') {
      const savedSessionId = localStorage.getItem(`ccserver-resume:claude:${dirPath}`);
      if (savedSessionId) {
        pendingOpenRef.current = dirPath;
        setResumePrompt({ cwd: dirPath, sessionId: savedSessionId, sandbox, sandboxOpts, app, model, reuseSandboxHome, isMetaAgent });
        return;
      }
    }
    openTerminalTab(dirPath, { sandbox, sandboxOpts, app, model, resume, reuseSandboxHome, isMetaAgent });
  }, [openTerminalTab]);

  // Sandboxed agent launch: before opening, ask the server whether a previous
  // persistent sandbox exists for this project; if so, show the reuse dialog
  // (existing resume prompt takes a back seat until the choice is made).
  const handleOpen = useCallback(async (dirPath, opts = {}) => {
    if (opts.sandbox) {
      try {
        const res = await authFetch(`/api/sandbox/status?cwd=${encodeURIComponent(dirPath)}`);
        const data = res.ok ? await res.json() : null;
        if (data?.enabled && data?.exists) {
          pendingOpenRef.current = dirPath;
          setSandboxPrompt({ cwd: dirPath, ...opts, inUse: data.inUse || 0 });
          return;
        }
      } catch {
        // older server / unreachable: proceed without the dialog
      }
    }
    continueOpen(dirPath, opts);
  }, [continueOpen]);

  const handleSandboxReuse = useCallback(() => {
    if (!sandboxPrompt) return;
    const p = sandboxPrompt;
    setSandboxPrompt(null);
    pendingOpenRef.current = null;
    continueOpen(p.cwd, { ...p, reuseSandboxHome: true });
  }, [sandboxPrompt, continueOpen]);

  const handleSandboxNew = useCallback(() => {
    if (!sandboxPrompt) return;
    const p = sandboxPrompt;
    setSandboxPrompt(null);
    pendingOpenRef.current = null;
    // Wiping happens server-side at launch; nothing to clean up client-side
    // except the persisted claude resume id has no bearing on the HOME.
    continueOpen(p.cwd, { ...p, reuseSandboxHome: false });
  }, [sandboxPrompt, continueOpen]);

  const cancelSandboxPrompt = useCallback(() => {
    setSandboxPrompt(null);
    pendingOpenRef.current = null;
  }, []);

  const handleOpenShell = useCallback((dirPath) => {
    openTerminalTab(dirPath, { shell: true });
  }, [openTerminalTab]);

  // Meta-agent opens always use the fixed server-side directory
  // (~/.local/share/ccserver-sandbox/meta-agent). The UI never asks the
  // user to pick a project dir for it; the app/model/sandbox come from the
  // dedicated dialog and the sandbox's reuse dialog (for the fixed dir) still
  // applies via handleOpen.
  const handleOpenMeta = useCallback(async ({ app, model, sandbox, metaAgentDir: dirFromCaller }) => {
    const dir = dirFromCaller || metaAgentDir;
    if (!dir) {
      window.alert('メタエージェントのディレクトリを取得できませんでした。ページを再読込してください。');
      return;
    }
    // Meta has no per-dir sandboxOpts (project-bound); pass null and let the
    // global sandboxDefault decide. The reuse dialog for the fixed dir is
    // still handled by handleOpen.
    await handleOpen(dir, { sandbox: !!sandbox, sandboxOpts: null, app, model, isMetaAgent: true });
  }, [metaAgentDir, handleOpen]);

  // Settings page as a tab (singleton): the gear button in the directory
  // browser opens/activates it; it is closable like any dynamic tab.
  const openSettingsTab = useCallback(() => {
    setTabs((prev) => {
      if (prev.some((t) => t.type === 'settings')) return prev;
      return [...prev, { id: 'settings', type: 'settings', label: 'Settings' }];
    });
    setActiveTabId('settings');
  }, []);

  // Combo launch: ask the server to spawn 2 workers + 1 orchestrator as one
  // group, then add a single group tab for all three (each member attaches
  // over the regular WS attach flow once its TerminalView mounts).
  const handleOpenCombo = useCallback(async (cwd, cfg) => {
    // A group tab is a single-slot UI per project directory: re-opening a
    // combo for a directory that already has an open group tab must just
    // activate that tab -- spawning a second group for the same project is
    // never intended, and attaching a second tab to the same sessions would
    // 'detach' the first one (the server replaces the old socket), leaving
    // the first tab stuck on "Session taken over". Guard on cwd: the server
    // assigns a fresh groupId per POST, so a groupId-based lookup could never
    // match an existing tab.
    const existing = tabs.find((t) => t.type === 'group' && t.cwd === cwd);
    if (existing) {
      setActiveTabId(existing.id);
      setLastDir(cwd);
      setGroupsVersion((v) => v + 1);
      return;
    }
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
        cwd,
        groupId: data.groupId,
        members: data.members || [],
      }]);
      setActiveTabId(id);
      setLastDir(cwd);
      setGroupsVersion((v) => v + 1);
    } catch (err) {
      // Surface launch failures in the directory browser (which owns the
      // combo modal); a failed group launch should not silently no-op.
      window.alert(`コンボ起動に失敗しました: ${err.message}`);
    }
  }, [tabs]);

  // Re-open a group (from the browser's groups list): fetch its current
  // membership, then add a group tab. Live members re-attach over the normal
  // WS flow; members whose pty died (server restart) show as exited and
  // re-launch via GroupTabView's re-init path.
  const handleOpenGroup = useCallback(async (groupId) => {
    try {
      const res = await authFetch(`/api/groups/${groupId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      // Same single-slot rule as handleOpenCombo: activating an existing tab
      // instead of attaching a second one to the same sessions.
      const existing = tabs.find((t) => t.type === 'group' && t.groupId === data.groupId);
      if (existing) {
        setActiveTabId(existing.id);
        setGroupsVersion((v) => v + 1);
        return;
      }
      const id = `group-${++tabIdCounter}`;
      const dirName = (data.cwd || '').split(/[/\\]/).filter(Boolean).pop() || data.groupId;
      setTabs((prev) => [...prev, {
        id,
        type: 'group',
        label: dirName,
        cwd: data.cwd,
        groupId: data.groupId,
        members: data.members || [],
      }]);
      setActiveTabId(id);
      setGroupsVersion((v) => v + 1);
    } catch (err) {
      window.alert(`グループを開けませんでした: ${err.message}`);
    }
  }, [tabs]);

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
      app: session.app === 'opencode' ? 'opencode' : session.app === 'copilot' ? 'copilot' : session.app === 'codex' ? 'codex' : session.app === 'commandcode' ? 'commandcode' : 'claude',
      model: session.model || null,
      sandbox: !!session.sandbox,
      sandboxOpts: session.sandboxOpts || null,
      // Needed by the SESSION_NOT_FOUND re-init path (TerminalView) so a
      // re-launched meta agent keeps its privilege request.
      isMetaAgent: !!session.isMetaAgent,
      // opencode/copilot/codex/commandcode re-launches resume the last session of
      // the project (-c / --continue / resume --last), so a continued
      // conversation survives the dead pty like claude's does.
      resume: session.app === 'opencode' || session.app === 'copilot' || session.app === 'codex' || session.app === 'commandcode',
    });
  }, [tabs, openTerminalTab]);

  const handleResume = useCallback(() => {
    if (resumePrompt) {
      openTerminalTab(resumePrompt.cwd, { claudeSessionId: resumePrompt.sessionId, sandbox: resumePrompt.sandbox, sandboxOpts: resumePrompt.sandboxOpts, app: resumePrompt.app || 'claude', model: resumePrompt.model || null, reuseSandboxHome: resumePrompt.reuseSandboxHome !== false, isMetaAgent: !!resumePrompt.isMetaAgent });
      setResumePrompt(null);
      pendingOpenRef.current = null;
    }
  }, [resumePrompt, openTerminalTab]);

  const handleNewSession = useCallback(() => {
    if (resumePrompt) {
      localStorage.removeItem(`ccserver-resume:claude:${resumePrompt.cwd}`);
      openTerminalTab(resumePrompt.cwd, { sandbox: resumePrompt.sandbox, sandboxOpts: resumePrompt.sandboxOpts, app: resumePrompt.app || 'claude', model: resumePrompt.model || null, reuseSandboxHome: resumePrompt.reuseSandboxHome !== false, isMetaAgent: !!resumePrompt.isMetaAgent });
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
      setGroupsVersion((v) => v + 1);
    } catch {
      // group teardown already happened server-side or is unreachable;
      // closing the tab is still the right move
    }
  }, []);

  const handleCloseTab = useCallback(async (tabId) => {
    // タブを閉じてもセッション自体はサーバー側で動き続けるが、
    // 再アタッチの手間があるため、稼働中のタブは閉じる前に確認する。
    // プロセスが終了済みのタブや「次回以降確認しない」設定時は確認なしで閉じる。
    // グループタブは3セッションを破棄するため、「次回以降確認しない」が
    // 設定されていない限り必ず確認する。
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.type === 'group') {
      if (skipCloseConfirm) {
        // サーバ側のグループ破棄は完了させてからタブを閉じる: 先にタブだけ
        // 閉じて DELETE が後追いで走ると、その間に Groups リストから再
        // オープンしたときにサーバ側 teardown と競合する (attach→404→
        // 再init→MCPソケット消失で復旧不能なエラー画面)。
        await destroyGroupTab(tab);
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

  // Lift a group's current turn into its top-level tab entry (GroupTabView
  // polls it while visible; the last-known value persists on the tab object
  // so the tab bar shows who's up even while the group tab is closed).
  const handleGroupTurnChange = useCallback((tabId, currentTurn) => {
    setTabs((prev) => prev.map((t) =>
      t.id === tabId ? { ...t, currentTurn } : t
    ));
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  // Usage covers claude (Claude Code's /usage) and codex (Codex's rate-limit
  // read); the popover itself now has tabs to switch between them, so the
  // button is no longer tied to whichever app the active terminal tab
  // happens to be running -- it stays visible on opencode/copilot terminals
  // too, as long as at least one of claude/codex is usable. It's hidden only
  // via sandbox.config.json's "showUsage": false, or when the server reports
  // neither CLI installed at all (the capture would never succeed for either).
  // `availableApps` null/absent (fetch pending or failed, older server) means
  // "unknown" -- both apps are assumed available in that case.
  const claudeAvailable = isAppSelectable('claude', usagePrefs.availableApps, usagePrefs.hiddenApps);
  const codexAvailable = isAppSelectable('codex', usagePrefs.availableApps, usagePrefs.hiddenApps);
  const usageHidden = !usagePrefs.showUsage || (!claudeAvailable && !codexAvailable);
  // First-run seed only: UsageButton remembers the app the user last picked
  // (localStorage), so this active-tab-derived default is used just when
  // nothing has been saved yet. codex wins over claude when the active tab is
  // a codex terminal and codex is actually installed.
  const activeTabApp = activeTab?.type === 'group' ? groupActiveApp : activeTab?.app;
  const usageDefaultApp = (activeTabApp === 'codex' && codexAvailable) ? 'codex'
    : (claudeAvailable ? 'claude' : 'codex');

  return (
    <div className="app">
      {/* Meta-agent approval requests (ccserver-meta): global banner above
          the tab bar so it is visible no matter which tab is active. */}
      <ApprovalBanner />
      {/* Cross-instance federation pairing requests (plan Phase 1): same
          always-visible placement, so an incoming pairing request from
          another ccserver instance can't be missed on any tab. */}
      <PairingRequestBanner />
      <div className="tab-bar">
        <div className="tab-list">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab-item${tab.id === activeTabId ? ' active' : ''}${tab.type === 'terminal' && !tab.shell && !tab.sandbox ? ' no-sandbox' : ''}`}
            title={tab.type === 'group' && tab.cwd ? tab.cwd : tab.remote ? `${tab.remote.label} — ${tab.cwd || ''}`.trim() : (tab.type === 'terminal' && tab.cwd ? tab.cwd : undefined)}
            onClick={() => handleTabClick(tab.id)}
          >
            <span className="tab-label">
              <TabIcon type={tab.type} app={tab.app} shell={tab.shell} isMetaAgent={!!tab.isMetaAgent} />
              {tab.label}
              {tab.type === 'group' && tab.currentTurn && (
                <span className="tab-turn-badge" title={`現在の手番: ${tab.currentTurn}`}>
                  {tab.currentTurn === 'orchestrator' ? 'ORCH' : tab.currentTurn.toUpperCase()}
                </span>
              )}
              {tab.type === 'terminal' && tab.remote && <span className="tab-remote-badge" title={`接続先: ${tab.remote.label} (${tab.remote.instanceId.slice(0, 8)})`}>⇄ {tab.remote.label}</span>}
            </span>
            {tab.type !== 'browser' && tab.type !== 'monitor' && tab.type !== 'remote' && (
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
        <UsageButton hidden={usageHidden} defaultApp={usageDefaultApp} availableApps={usagePrefs.availableApps} hiddenApps={usagePrefs.hiddenApps} />
      </div>
      <div className="tab-content">
        <div style={{ display: activeTabId === 'browser' ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}>
          <DirectoryBrowser onOpen={handleOpen} onOpenShell={handleOpenShell} onOpenCombo={handleOpenCombo} onOpenGroup={handleOpenGroup} onSessionClick={handleSessionClick} onOpenSettings={openSettingsTab} initialPath={lastDir} groupsVersion={groupsVersion} metaAgentDir={metaAgentDir} onOpenMeta={handleOpenMeta} />
        </div>
        <div style={{ display: activeTabId === 'monitor' ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}>
          <SystemMonitor visible={activeTabId === 'monitor'} />
        </div>
        <div style={{ display: activeTabId === 'remote' ? 'flex' : 'none', height: '100%', flexDirection: 'column', overflow: 'auto' }}>
          <RemoteInstanceView onOpenRemoteTerminal={openRemoteTerminalTab} visible={activeTabId === 'remote'} />
        </div>
        {tabs.some((t) => t.type === 'settings') && (
          <div style={{ display: activeTabId === 'settings' ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}>
            <SettingsView />
          </div>
        )}
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
                  reuseSandboxHome={tab.reuseSandboxHome !== false}
                  app={tab.app || 'claude'}
                  model={tab.model || null}
                  resume={!!tab.resume}
                  isMetaAgent={!!tab.isMetaAgent}
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
                  onFocusTab={() => handleTabClick(tab.id)}
                  remoteInstanceId={tab.remote?.instanceId || null}
                  remoteInstanceLabel={tab.remote?.label || null}
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
                projectCwd={tab.cwd}
                visible={activeTabId === tab.id}
                xtermTheme={getTheme(themeId).xterm}
                themeId={themeId}
                onThemeChange={setThemeId}
                notify={notify}
                notifyEnabled={notifyEnabled}
                notifyPermission={notifyPermission}
                onToggleNotify={toggleNotify}
                onActiveAppChange={setGroupActiveApp}
                onCurrentTurnChange={(turn) => handleGroupTurnChange(tab.id, turn)}
                tabId={tab.id}
                onFocusTab={() => handleTabClick(tab.id)}
              />
            </div>
          ))}
      </div>
      {sandboxPrompt && (
        <div className="resume-overlay" onClick={cancelSandboxPrompt}>
          <div className="resume-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>前回利用したサンドボックスがあります</h3>
            <p>
              このプロジェクトの前回のサンドボックス環境（インストール済みのツール・キャッシュ等）を引き継ぎますか？
            </p>
            <p className="sandbox-prompt-warn">
              「新規作成」は前回の環境を破棄して空の状態から始めます。
              {sandboxPrompt.inUse > 0
                ? '（このプロジェクトのサンドボックスを利用中のセッションがあるため選択できません）'
                : ''}
            </p>
            <div className="resume-actions">
              <button className="btn btn-primary" onClick={handleSandboxReuse}>
                使用する
              </button>
              <button
                className="btn btn-secondary"
                disabled={sandboxPrompt.inUse > 0}
                onClick={handleSandboxNew}
              >
                新規作成
              </button>
              <button className="btn btn-secondary" onClick={cancelSandboxPrompt}>
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
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
