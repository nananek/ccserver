import { useState, useCallback, useRef, useEffect, lazy, Suspense } from 'react';
import DirectoryBrowser from './components/DirectoryBrowser.jsx';
import SettingsView from './components/SettingsView.jsx';
import ApprovalBanner from './components/ApprovalBanner.jsx';
import PairingRequestBanner from './components/PairingRequestBanner.jsx';
import UsageButton from './components/UsageButton.jsx';
import TabIcon from './components/TabIcon.jsx';
import SessionTabMenu from './components/SessionTabMenu.jsx';
import SessionSidebar from './components/SessionSidebar.jsx';
import SessionContextMenu from './components/SessionContextMenu.jsx';
import SessionRenameDialog from './components/SessionRenameDialog.jsx';
import GroupTabView from './components/GroupTabView.jsx';
import RemoteInstanceView from './components/RemoteInstanceView.jsx';
import RightSidebar, { WIDGET_DEFS, MONITOR_WIDGET_IDS } from './components/RightSidebar.jsx';
import { SystemStatsProvider } from './components/widgets/SystemStatsProvider.jsx';
import { useWidgetPrefs } from './hooks/useWidgetPrefs.js';
import { useSessionSidebarPrefs } from './hooks/useSessionSidebarPrefs.js';
import { NARROW_DRAWER_QUERY } from './hooks/viewportQuery.js';
import { useNotifications } from './hooks/useNotifications.js';
import { loadNavGuardMode, saveNavGuardMode, useNavGuard } from './hooks/useNavGuard.js';
import { authFetch } from './auth.js';
import { getTheme, loadThemeId, saveThemeId, applyThemeCss } from './themes.js';
import { loadSandboxDefaults, saveSandboxDefaults } from './sandboxDefaults.js';
import { isAppSelectable, isAppVisible } from './appAvailability.js';

const TerminalView = lazy(() => import('./components/TerminalView.jsx'));

let tabIdCounter = 0;

export default function App() {
  const [tabs, setTabs] = useState([
    { id: 'browser', type: 'browser', label: 'Files' },
    { id: 'remote', type: 'remote', label: 'Remote' },
  ]);
  const [activeTabId, setActiveTabId] = useState('browser');
  const [lastDir, setLastDir] = useState(() => localStorage.getItem('ccserver-last-dir'));
  const [resumePrompt, setResumePrompt] = useState(null);
  // Reuse dialog for a sandboxed launch when a previous persistent sandbox
  // exists for the project: { cwd, sandbox, sandboxOpts, app, model,
  // permissionMode, resume, skipResumePrompt, reuseSandboxHome, inUse }.
  const [sandboxPrompt, setSandboxPrompt] = useState(null);
  const [themeId, setThemeId] = useState(loadThemeId);
  const [closeConfirm, setCloseConfirm] = useState(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  // "セッションを終了" (terminateSessionAndCloseTab) is async: while its
  // DELETE is in flight the dialog buttons are disabled and re-entry is
  // ignored, so a double-click can't fire a duplicate DELETE (whose 404
  // would surface a bogus failure alert after a successful termination).
  // The guard is a ref (not just the state below): setState applies
  // asynchronously, so two clicks before the next render would both see a
  // stale `false` and slip through. The state remains for the disabled UI.
  const isTerminatingRef = useRef(false);
  const [isTerminatingSession, setIsTerminatingSession] = useState(false);
  const [groupActiveApp, setGroupActiveApp] = useState(null);
  // Bumped whenever a group is created / destroyed / re-opened, so the
  // directory browser's groups list refetches (it is otherwise fetch-on-mount).
  const [groupsVersion, setGroupsVersion] = useState(0);
  const [skipCloseConfirm, setSkipCloseConfirm] = useState(() => {
    try {
      return localStorage.getItem('ccserver-skip-close-confirm') === '1';
    } catch {
      return false;
    }
  });
  // 終了確認スキップの永続化付き setter (一般設定タブと終了確認ダイアログ
  // の「次回以降確認しない」から共有する)。
  const setSkipCloseConfirmPersisted = useCallback((v) => {
    setSkipCloseConfirm(v);
    try {
      if (v) localStorage.setItem('ccserver-skip-close-confirm', '1');
      else localStorage.removeItem('ccserver-skip-close-confirm');
    } catch {
      // ignore (private mode etc.)
    }
  }, []);
  const pendingOpenRef = useRef(null);
  // ブラウザの「戻る / 進む」履歴操作ガード (Settings > 一般で変更。
  // confirm: 確認ダイアログ / suppress: 黙って抑制 / allow: 無効)。
  const [navGuardMode, setNavGuardMode] = useState(loadNavGuardMode);
  const setNavGuardModePersisted = useCallback((v) => {
    setNavGuardMode(v);
    saveNavGuardMode(v);
  }, []);
  useNavGuard(navGuardMode);
  // サンドボックス起動フラグのグローバル既定値 (Settings > 一般で変更。
  // ディレクトリ別記憶が無い場合の初期値として DirectoryBrowser が使う)。
  const [sandboxDefaults, setSandboxDefaults] = useState(loadSandboxDefaults);
  const setSandboxDefaultsPersisted = useCallback((next) => {
    setSandboxDefaults(next);
    saveSandboxDefaults(next);
  }, []);
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

  const openTerminalTab = useCallback((dirPath, { claudeSessionId = null, shell = false, sessionId = null, attachSessionId = null, sandbox = false, sandboxOpts = null, app = 'claude', model = null, permissionMode = 'standard', resume = false, reuseSandboxHome = true, isMetaAgent = false } = {}) => {
    const id = `terminal-${++tabIdCounter}`;
    const dirName = dirPath.split(/[/\\]/).filter(Boolean).pop() || dirPath;
    // Meta-agent tabs carry a ⌘ prefix (plus their own tab icon): the
    // privileged session must be recognizable at a glance in the tab bar.
    const label = shell ? `$ ${dirName}` : isMetaAgent ? `⌘ ${dirName}` : dirName;
    setTabs((prev) => [
      ...prev,
      { id, type: 'terminal', label, cwd: dirPath, claudeSessionId, shell, sessionId, attachSessionId, sandbox, sandboxOpts, app, model, permissionMode, resume, reuseSandboxHome, isMetaAgent, exited: false },
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
  const continueOpen = useCallback((dirPath, { sandbox = false, sandboxOpts = null, app = 'claude', model = null, permissionMode = 'standard', resume = false, skipResumePrompt = false, reuseSandboxHome = true, isMetaAgent = false } = {}) => {
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
        setResumePrompt({ cwd: dirPath, sessionId: savedSessionId, sandbox, sandboxOpts, app, model, permissionMode, reuseSandboxHome, isMetaAgent });
        return;
      }
    }
    openTerminalTab(dirPath, { sandbox, sandboxOpts, app, model, permissionMode, resume, reuseSandboxHome, isMetaAgent });
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
      permissionMode: session.permissionMode || 'standard',
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
      openTerminalTab(resumePrompt.cwd, { claudeSessionId: resumePrompt.sessionId, sandbox: resumePrompt.sandbox, sandboxOpts: resumePrompt.sandboxOpts, app: resumePrompt.app || 'claude', model: resumePrompt.model || null, permissionMode: resumePrompt.permissionMode || 'standard', reuseSandboxHome: resumePrompt.reuseSandboxHome !== false, isMetaAgent: !!resumePrompt.isMetaAgent });
      setResumePrompt(null);
      pendingOpenRef.current = null;
    }
  }, [resumePrompt, openTerminalTab]);

  const handleNewSession = useCallback(() => {
    if (resumePrompt) {
      localStorage.removeItem(`ccserver-resume:claude:${resumePrompt.cwd}`);
      openTerminalTab(resumePrompt.cwd, { sandbox: resumePrompt.sandbox, sandboxOpts: resumePrompt.sandboxOpts, app: resumePrompt.app || 'claude', model: resumePrompt.model || null, permissionMode: resumePrompt.permissionMode || 'standard', reuseSandboxHome: resumePrompt.reuseSandboxHome !== false, isMetaAgent: !!resumePrompt.isMetaAgent });
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
      setSkipCloseConfirmPersisted(true);
    }
    const tab = tabs.find((t) => t.id === closeConfirm.tabId);
    if (tab?.type === 'group') {
      await destroyGroupTab(tab);
    }
    doCloseTab(closeConfirm.tabId);
    setCloseConfirm(null);
  }, [closeConfirm, dontAskAgain, tabs, doCloseTab, destroyGroupTab, setSkipCloseConfirmPersisted]);

  const handleTabClick = useCallback((tabId) => {
    setActiveTabId(tabId);
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

  // Session hamburger menu: terminal + group (combo) tabs are listed
  // vertically in the menu, while browser/remote/settings tabs stay horizontal.
  // 表示モードは設定で切替: 'popup' (従来のポップアップ) | 'sidebar' (既定・
  // 右ウィジェットと同じ挙動の左常時表示パネル。開閉・重ね表示は右と別フラグ)。
  const sessionSidebarPrefs = useSessionSidebarPrefs();
  const sessionSidebarMode = sessionSidebarPrefs.mode;
  const sessionSidebarOpen = sessionSidebarPrefs.open;
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [serverSessions, setServerSessions] = useState([]);
  const sessionsRefreshingRef = useRef(false);
  const sessionsRefreshQueuedRef = useRef(false);
  const fetchServerSessions = useCallback(async () => {
    if (sessionsRefreshingRef.current) { sessionsRefreshQueuedRef.current = true; return; }
    sessionsRefreshingRef.current = true;
    try {
      const res = await authFetch('/api/sessions');
      if (!res.ok) return;
      const data = await res.json();
      // Same filter as DirectoryBrowser: group members attach only through
      // the combo group's own sub-tab UI. Listing them here would detach
      // the live socket inside the group.
      setServerSessions((data.sessions || []).filter((s) => s.groupId == null));
    } catch {
      // supplementary panel: keep the last-known list on failure
    } finally {
      sessionsRefreshingRef.current = false;
      if (sessionsRefreshQueuedRef.current) {
        sessionsRefreshQueuedRef.current = false;
        fetchServerSessions();
      }
    }
  }, []);
  // tabs全体ではなくセッション構成に影響する安定キーのみ監視する
  // (手番ポーリング等の無関係なsetTabsで/api/sessionsを叩かない)。
  // グループ一覧 (左セッション一覧の第3セクション用)。Files画面の
  // .session-list 撤去に伴い、再オープン動線はこちらに移設した。
  // セッション取得と同じタイミングで更新する。
  const [serverGroups, setServerGroups] = useState([]);
  const fetchServerGroups = useCallback(async () => {
    try {
      const res = await authFetch('/api/groups');
      if (!res.ok) return;
      const data = await res.json();
      setServerGroups((data.groups || []).filter((g) => g.liveCount > 0 || g.memberCount > 0));
    } catch {
      // supplementary panel: keep the last-known list on failure
    }
  }, []);
  const sessionTabsKey = tabs.map((t) => `${t.id}:${t.sessionId || ''}:${t.attachSessionId || ''}`).join(',');
  // サイドバーモードではパネル開表示の間、ポップアップモードではメニュー開表示の間
  // 一覧を更新する。タブ構成変化時も下段 (稼働中) との付け替えを反映する。
  const sessionPanelOpen = sessionSidebarMode === 'sidebar' ? sessionSidebarOpen : sessionMenuOpen;
  useEffect(() => {
    if (sessionPanelOpen) {
      fetchServerSessions();
      fetchServerGroups();
    }
    // closing a tab moves its server-side session from the upper section
    // to the lower one while the menu stays open, so the list must refresh
    // on tab changes too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPanelOpen, sessionSidebarMode, fetchServerSessions, fetchServerGroups, groupsVersion, sessionTabsKey]);
  const closeSessionMenu = useCallback(() => setSessionMenuOpen(false), []);
  const toggleSessionMenu = useCallback(() => {
    setSessionMenuOpen((v) => !v);
  }, []);
  // サイドバー表示中に開く操作をした際、重ね表示のときだけ閉じる。
  // in-flow表示はCLIをリサイズ済みのため開いたままにする。重ね表示とは
  // 設定ONのデスクトップオーバーレイと、狭幅ドロワー (NARROW_DRAWER_QUERY・
  // 常時前面) の両方を指す。狭幅判定はクリック時に都度行う (リサイズ対応の
  // ため購読はしない)。
  const closeSessionSidebarIfOverlay = useCallback(() => {
    if (sessionSidebarPrefs.overlay) {
      sessionSidebarPrefs.setOpen(false);
      return;
    }
    if (typeof window !== 'undefined' && window.matchMedia?.(NARROW_DRAWER_QUERY).matches) {
      sessionSidebarPrefs.setOpen(false);
    }
  }, [sessionSidebarPrefs.overlay, sessionSidebarPrefs.setOpen]);
  // ポップアップは選択で閉じる。サイドバーは重ね表示のときだけ閉じ、
  // in-flow表示では常時表示のため閉じない (ターミナルタブとグループタブ共通)。
  const handleSelectSessionTab = useCallback((tabId) => {
    setActiveTabId(tabId);
    if (sessionSidebarPrefs.mode !== 'sidebar') setSessionMenuOpen(false);
    else closeSessionSidebarIfOverlay();
  }, [sessionSidebarPrefs.mode, closeSessionSidebarIfOverlay]);
  const handleCloseSessionTab = useCallback((tabId) => {
    handleCloseTab(tabId);
  }, [handleCloseTab]);
  const handleOpenUnopenedSession = useCallback((session) => {
    if (sessionSidebarPrefs.mode !== 'sidebar') setSessionMenuOpen(false);
    else closeSessionSidebarIfOverlay();
    handleSessionClick(session);
  }, [handleSessionClick, sessionSidebarPrefs.mode, closeSessionSidebarIfOverlay]);
  // グループ再オープン (Files画面のGroups一覧から移設)。セッションと同様、
  // ポップアップでは選択で閉じる。サイドバーは重ね表示のときだけ閉じる。
  const handleOpenGroupFromList = useCallback((groupId) => {
    if (sessionSidebarPrefs.mode !== 'sidebar') setSessionMenuOpen(false);
    else closeSessionSidebarIfOverlay();
    handleOpenGroup(groupId);
  }, [handleOpenGroup, sessionSidebarPrefs.mode, closeSessionSidebarIfOverlay]);
  // Lower section's X: terminate the server-side session (tab close keeps
  // the session alive, so this is the only destructive action here).
  const handleTerminateUnopenedSession = useCallback(async (session) => {
    const label = session.cwd || session.id;
    if (!window.confirm(`セッションを終了しますか?\n${label}`)) return;
    try {
      const res = await authFetch(`/api/sessions/${session.id}`, { method: 'DELETE' });
      if (res.status === 404) {
        // Session already gone server-side: termination is effectively done.
      } else if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      window.alert(`セッションを終了できませんでした: ${err.message}`);
    }
    fetchServerSessions();
  }, [fetchServerSessions]);

  // Close-confirm dialog's "セッションを終了": fully terminate the
  // server-side session (DELETE /api/sessions/:id -- the same primitive as
  // the lower-section X above) and close the tab as well. Unlike
  // confirmCloseTab ("閉じる") the session does not linger for re-attach.
  // Shown only for local terminal tabs with a known session id: group tabs
  // already destroy their members on close, and remote tabs belong to another
  // instance (a local DELETE would 404 or hit the wrong session).
  // NOTE: this must stay below fetchServerSessions/follow-ups in source
  // order -- the deps array below is evaluated during render, so referencing
  // a later const would throw a TDZ ReferenceError and blank the whole app.
  const terminateSessionAndCloseTab = useCallback(async () => {
    if (!closeConfirm || isTerminatingRef.current) return;
    const tab = tabs.find((t) => t.id === closeConfirm.tabId);
    const sessionId = tab?.sessionId || tab?.attachSessionId || null;
    if (!tab || !sessionId) return;
    isTerminatingRef.current = true;
    setIsTerminatingSession(true);
    try {
      const res = await authFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
      if (res.status === 404) {
        // Session already gone server-side: termination is effectively done,
        // fall through and close the tab.
      } else if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      window.alert(`セッションを終了できませんでした: ${err.message}`);
      return;
    } finally {
      isTerminatingRef.current = false;
      setIsTerminatingSession(false);
    }
    // Persist "don't ask again" only after a successful termination: on
    // failure the session is still alive, and a persisted skip would
    // silently switch future closes to the keep-alive path.
    if (dontAskAgain) {
      setSkipCloseConfirmPersisted(true);
    }
    doCloseTab(closeConfirm.tabId);
    setCloseConfirm(null);
    fetchServerSessions();
  }, [closeConfirm, dontAskAgain, tabs, doCloseTab, setSkipCloseConfirmPersisted, fetchServerSessions]);

  // セッション表示名 (右クリック改名): サーバー保存の customLabel を
  // sessionId で引くマップ。一覧の上段・ターミナルヘッダーで使う。
  // 下段 (未オープン) は serverSessions 要素の customLabel を直接使う。
  const labelBySessionId = new Map();
  for (const s of serverSessions) {
    if (s.customLabel) labelBySessionId.set(s.id, s.customLabel);
  }
  const resolveTabLabel = (tab) => {
    const sid = tab.sessionId || tab.attachSessionId;
    return (sid && labelBySessionId.get(sid)) || null;
  };
  // 右クリックメニューと改名ダイアログの表示状態。contextMenu: { x, y, id,
  // currentLabel }、renameTarget: { id, currentLabel }。
  const [contextMenu, setContextMenu] = useState(null);
  const [renameTarget, setRenameTarget] = useState(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const handleRowContextMenu = useCallback((e, target) => {
    setContextMenu({ x: e.clientX, y: e.clientY, id: target.id, currentLabel: target.currentLabel });
  }, []);
  const handleRenameSession = useCallback(async (id, name) => {
    try {
      const res = await authFetch(`/api/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customLabel: name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      window.alert(`セッション名を設定できませんでした: ${err.message}`);
    }
    setRenameTarget(null);
    fetchServerSessions();
  }, [fetchServerSessions]);
  const handleClearSessionLabel = useCallback((id) => {
    setContextMenu(null);
    handleRenameSession(id, null);
  }, [handleRenameSession]);
  const handleOpenRenameDialog = useCallback(() => {
    if (!contextMenu) return;
    setRenameTarget({ id: contextMenu.id, currentLabel: contextMenu.currentLabel });
    setContextMenu(null);
  }, [contextMenu]);

  const sessionTabs = tabs.filter((t) => t.type === 'terminal');
  const groupTabs = tabs.filter((t) => t.type === 'group');
  const openedTabCount = sessionTabs.length + groupTabs.length;
  const barTabs = tabs.filter((t) => t.type === 'browser' || t.type === 'remote' || t.type === 'settings');
  const openedSessionIds = new Set();
  for (const t of tabs) {
    if (t.sessionId) openedSessionIds.add(t.sessionId);
    if (t.attachSessionId) openedSessionIds.add(t.attachSessionId);
  }
  const unopenedSessions = serverSessions.filter((s) => !openedSessionIds.has(s.id));
  // 開き済みグループタブのあるグループを除いた未オープン一覧。
  const openedGroupIds = new Set();
  for (const t of tabs) {
    if (t.type === 'group' && t.groupId) openedGroupIds.add(t.groupId);
  }
  const unopenedGroups = serverGroups.filter((g) => !openedGroupIds.has(g.groupId));

  const activeTab = tabs.find((t) => t.id === activeTabId);
  // Close-confirm dialog's "セッションを終了" availability: local terminal
  // tabs with a known server-side session id only (group tabs destroy their
  // members on close already; remote tabs belong to another instance).
  const closeConfirmTab = closeConfirm ? tabs.find((t) => t.id === closeConfirm.tabId) : null;
  const canTerminateCloseConfirm = !!closeConfirmTab && closeConfirm?.kind === 'terminal'
    && !closeConfirmTab.remote && !!(closeConfirmTab.sessionId || closeConfirmTab.attachSessionId);
  // Usage covers claude (Claude Code's /usage), codex (Codex's rate-limit
  // read) and opencode Go (the zen/go quota API); the popover itself has
  // tabs to switch between them, so the button is no longer tied to
  // whichever app the active terminal tab happens to be running -- it stays
  // visible on opencode/copilot terminals too, as long as at least one
  // source is usable. It's hidden only via sandbox.config.json's
  // "showUsage": false, or when the server reports nothing usable at all
  // (no CLI installed AND no Go key, accounting for hiddenApps).
  // `availableApps` null/absent (fetch pending or failed, older server)
  // means "unknown" -- every tab is assumed available in that case (unless
  // hidden via hiddenApps). Note `opencodeGo` is not the opencode CLI
  // install flag: it means toggle on + Go API key present. Unlike
  // claude/codex (whose keys predate this feature), a PRESENT object
  // without the opencodeGo key is an older server, so Go stays hidden
  // there (see appAvailability.js's isAppVisible, shared with UsageButton).
  // hiddenApps 'opencode' hides the Go tab as well (issue #105).
  const claudeAvailable = isAppSelectable('claude', usagePrefs.availableApps, usagePrefs.hiddenApps);
  const codexAvailable = isAppSelectable('codex', usagePrefs.availableApps, usagePrefs.hiddenApps);
  const opencodeGoAvailable = isAppVisible('opencode', usagePrefs.availableApps, usagePrefs.hiddenApps);
  const usageHidden = !usagePrefs.showUsage || (!claudeAvailable && !codexAvailable && !opencodeGoAvailable);
  // First-run seed only: UsageButton remembers the app the user last picked
  // (localStorage), so this active-tab-derived default is used just when
  // nothing has been saved yet. The active tab's app wins when that source
  // is actually usable, else claude, else whichever of codex/Go is usable.
  const activeTabApp = activeTab?.type === 'group' ? groupActiveApp : activeTab?.app;
  const usageDefaultApp = (activeTabApp === 'codex' && codexAvailable) ? 'codex'
    : (activeTabApp === 'opencode' && opencodeGoAvailable) ? 'opencode'
    : (claudeAvailable ? 'claude' : (codexAvailable ? 'codex' : (opencodeGoAvailable ? 'opencode' : 'claude')));
  const sidebarPrefs = useWidgetPrefs(WIDGET_DEFS);
  const monitorWidgetsVisible = sidebarPrefs.open
    && sidebarPrefs.visibleWidgets.some((w) => MONITOR_WIDGET_IDS.includes(w.id));
  const statsActive = monitorWidgetsVisible;
  const usageWidgetProps = { hidden: usageHidden, defaultApp: usageDefaultApp, availableApps: usagePrefs.availableApps, hiddenApps: usagePrefs.hiddenApps };

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
        {sessionSidebarMode === 'popup' ? (
          <SessionTabMenu
            open={sessionMenuOpen}
            onToggle={toggleSessionMenu}
            onClose={closeSessionMenu}
            sessionTabs={sessionTabs}
            groupTabs={groupTabs}
            activeTabId={activeTabId}
            unopenedSessions={unopenedSessions}
            unopenedGroups={unopenedGroups}
            onSelectTab={handleSelectSessionTab}
            onCloseTab={handleCloseSessionTab}
            onOpenSession={handleOpenUnopenedSession}
            onTerminateSession={handleTerminateUnopenedSession}
            onOpenGroup={handleOpenGroupFromList}
            customLabels={labelBySessionId}
            onRowContextMenu={handleRowContextMenu}
          />
        ) : (
          <button
            type="button"
            className="btn session-menu-btn"
            onClick={() => sessionSidebarPrefs.setOpen(!sessionSidebarOpen)}
            title={openedTabCount > 0 ? `セッション (${openedTabCount})` : 'セッション'}
            aria-label={sessionSidebarOpen ? 'セッションサイドバーを閉じる' : 'セッションサイドバーを開く'}
            aria-expanded={sessionSidebarOpen}
          >
            <span aria-hidden="true">☰</span>
            {openedTabCount > 0 && (
              <span className="session-menu-count" aria-hidden="true">{openedTabCount}</span>
            )}
          </button>
        )}
        <div className="tab-list">
        {barTabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab-item${tab.id === activeTabId ? ' active' : ''}`}
            title={tab.remote ? `${tab.remote.label} — ${tab.cwd || ''}`.trim() : undefined}
            onClick={() => handleTabClick(tab.id)}
          >
            <span className="tab-label">
              <TabIcon type={tab.type} app={tab.app} shell={tab.shell} isMetaAgent={!!tab.isMetaAgent} />
              {tab.label}
              {tab.remote && <span className="tab-remote-badge" title={`接続先: ${tab.remote.label} (${tab.remote.instanceId.slice(0, 8)})`}>⇄ {tab.remote.label}</span>}
            </span>
            {tab.type !== 'browser' && tab.type !== 'remote' && (
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
        <button
          type="button"
          className="btn sidebar-toggle-btn"
          onClick={() => sidebarPrefs.setOpen(!sidebarPrefs.open)}
          title={sidebarPrefs.open ? 'サイドバーを閉じる' : 'サイドバーを開く'}
          aria-label={sidebarPrefs.open ? 'サイドバーを閉じる' : 'サイドバーを開く'}
          aria-expanded={sidebarPrefs.open}
        >
          {sidebarPrefs.open ? '▶' : '◀'}
        </button>
      </div>
      <SystemStatsProvider active={statsActive}>
      <div className={`main-row${sidebarPrefs.open ? ' sidebar-open' : ''}${sidebarPrefs.overlay ? ' sidebar-overlay' : ''}${sessionSidebarMode === 'sidebar' && sessionSidebarOpen ? ' session-open' : ''}${sessionSidebarMode === 'sidebar' && sessionSidebarPrefs.overlay ? ' session-overlay' : ''}`}>
      {sessionSidebarMode === 'sidebar' && sessionSidebarOpen && (
        <button
          type="button"
          className="session-backdrop"
          aria-label="セッションサイドバーを閉じる"
          tabIndex={-1}
          onClick={() => sessionSidebarPrefs.setOpen(false)}
        />
      )}
      {sessionSidebarMode === 'sidebar' && (
        <SessionSidebar
          open={sessionSidebarOpen}
          sessionTabs={sessionTabs}
          groupTabs={groupTabs}
          activeTabId={activeTabId}
          unopenedSessions={unopenedSessions}
          unopenedGroups={unopenedGroups}
          onSelectTab={handleSelectSessionTab}
          onCloseTab={handleCloseSessionTab}
          onOpenSession={handleOpenUnopenedSession}
          onTerminateSession={handleTerminateUnopenedSession}
          onOpenGroup={handleOpenGroupFromList}
          customLabels={labelBySessionId}
          onRowContextMenu={handleRowContextMenu}
        />
      )}
      <div className="tab-content">
        <div style={{ display: activeTabId === 'browser' ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}>
          <DirectoryBrowser onOpen={handleOpen} onOpenShell={handleOpenShell} onOpenCombo={handleOpenCombo} onOpenSettings={openSettingsTab} initialPath={lastDir} metaAgentDir={metaAgentDir} onOpenMeta={handleOpenMeta} sandboxDefaults={sandboxDefaults} />
        </div>
        <div style={{ display: activeTabId === 'remote' ? 'flex' : 'none', height: '100%', flexDirection: 'column', overflow: 'auto' }}>
          <RemoteInstanceView onOpenRemoteTerminal={openRemoteTerminalTab} visible={activeTabId === 'remote'} />
        </div>
        {tabs.some((t) => t.type === 'settings') && (
          <div style={{ display: activeTabId === 'settings' ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}>
            <SettingsView
              themeId={themeId}
              onThemeChange={setThemeId}
              confirmBeforeClose={!skipCloseConfirm}
              onConfirmBeforeCloseChange={(v) => setSkipCloseConfirmPersisted(!v)}
              sidebarOverlay={sidebarPrefs.overlay}
              onSidebarOverlayChange={sidebarPrefs.setOverlay}
              sessionMode={sessionSidebarPrefs.mode}
              onSessionModeChange={sessionSidebarPrefs.setMode}
              sessionOverlay={sessionSidebarPrefs.overlay}
              onSessionOverlayChange={sessionSidebarPrefs.setOverlay}
              sandboxDefaults={sandboxDefaults}
              onSandboxDefaultsChange={setSandboxDefaultsPersisted}
              navGuardMode={navGuardMode}
              onNavGuardModeChange={setNavGuardModePersisted}
            />
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
                  permissionMode={tab.permissionMode || 'standard'}
                  resume={!!tab.resume}
                  isMetaAgent={!!tab.isMetaAgent}
                  customLabel={resolveTabLabel(tab)}
                  notify={notify}
                  notifyEnabled={notifyEnabled}
                  notifyPermission={notifyPermission}
                  onToggleNotify={toggleNotify}
                  visible={activeTabId === tab.id}
                  onSessionId={(sid) => handleTabSessionId(tab.id, sid)}
                  onExited={(exited) => handleTabExited(tab.id, exited)}
                  attachSessionId={tab.attachSessionId}
                  xtermTheme={getTheme(themeId).xterm}
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
      {sidebarPrefs.open && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="サイドバーを閉じる"
          tabIndex={-1}
          onClick={() => sidebarPrefs.setOpen(false)}
        />
      )}
      <RightSidebar usageProps={usageWidgetProps} prefs={sidebarPrefs} />
      </div>
      </SystemStatsProvider>
      {contextMenu && (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          hasCustomLabel={!!contextMenu.currentLabel}
          onRename={handleOpenRenameDialog}
          onClear={() => handleClearSessionLabel(contextMenu.id)}
          onClose={closeContextMenu}
        />
      )}
      {renameTarget && (
        <SessionRenameDialog
          initialName={renameTarget.currentLabel}
          onSubmit={(name) => handleRenameSession(renameTarget.id, name)}
          onClose={() => setRenameTarget(null)}
        />
      )}
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
        <div className="resume-overlay" onClick={() => { if (!isTerminatingSession) setCloseConfirm(null); }}>
          <div className="resume-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{closeConfirm.kind === 'group' ? 'グループを閉じますか?' : 'タブを閉じますか?'}</h3>
            <p>{closeConfirm.kind === 'group'
              ? 'グループの3つのセッション（ワーカー2つとオーケストレーター）を終了します。'
              : 'セッションは背後で動き続け、セッション一覧から再接続できます。'}</p>
            <label className="close-confirm-checkbox">
              <input
                type="checkbox"
                checked={dontAskAgain}
                disabled={isTerminatingSession}
                onChange={(e) => setDontAskAgain(e.target.checked)}
              />
              次回以降確認しない
            </label>
            <div className="resume-actions">
              {canTerminateCloseConfirm && (
                <button className="btn btn-danger btn-left" onClick={terminateSessionAndCloseTab} disabled={isTerminatingSession}>
                  {isTerminatingSession ? '終了中...' : 'セッションを終了'}
                </button>
              )}
              <button className="btn btn-secondary" onClick={() => setCloseConfirm(null)} disabled={isTerminatingSession}>
                キャンセル
              </button>
              <button className="btn btn-primary" onClick={confirmCloseTab} disabled={isTerminatingSession}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
