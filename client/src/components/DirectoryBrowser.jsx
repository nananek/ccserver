import { useState, useEffect, useCallback, useRef } from 'react';
import { authFetch, getToken } from '../auth.js';

const LAST_DIR_KEY = 'ccserver-last-dir';
const SANDBOX_KEY = 'ccserver-sandbox-default';
const SANDBOX_OPTS_PREFIX = 'ccserver-sandbox-opts:';
const APP_KEY = 'ccserver-app-default';

// Per-directory opt-in sandbox flags (gpg / sshAgent), remembered separately
// per cwd rather than as one server-wide default -- see server/sandbox.config.json's
// `gpg`/`sshAgent` for the fallback these override at launch.
function loadSandboxOpts(path) {
  try {
    const raw = localStorage.getItem(SANDBOX_OPTS_PREFIX + path);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { gpg: !!parsed.gpg, sshAgent: !!parsed.sshAgent };
    }
  } catch { /* ignore */ }
  return { gpg: false, sshAgent: false };
}

function saveSandboxOpts(path, opts) {
  try {
    localStorage.setItem(SANDBOX_OPTS_PREFIX + path, JSON.stringify(opts));
  } catch { /* ignore */ }
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${i === 0 ? val : val.toFixed(1)} ${units[i]}`;
}

export default function DirectoryBrowser({ onOpen, onOpenShell, onOpenCombo, onOpenGroup, onSessionClick, initialPath, groupsVersion }) {
  const [currentPath, setCurrentPath] = useState(initialPath || localStorage.getItem(LAST_DIR_KEY) || '/');
  const [homeDir, setHomeDir] = useState(null);
  const [dirs, setDirs] = useState([]);
  const [files, setFiles] = useState([]);
  const [parentPath, setParentPath] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showHidden, setShowHidden] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [sessions, setSessions] = useState([]);
  const [groups, setGroups] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const fileInputRef = useRef(null);
  const dragCountRef = useRef(0);
  const [sandboxDefault, setSandboxDefault] = useState(() => localStorage.getItem(SANDBOX_KEY) === '1');
  // Server-enforced sandbox (sandbox.config.json's "forceSandbox"): when on,
  // the sandbox toggle is overridden -- every launch is sandboxed and the
  // "通常起動" choice is disabled. Set from /api/dirs/home.
  const [forceSandbox, setForceSandbox] = useState(false);
  // Which agent CLIs the server can actually launch ({ claude, opencode,
  // copilot } booleans), from /api/dirs/home. null until the fetch resolves;
  // while null every picker entry stays enabled (old-server fallback).
  const [availableApps, setAvailableApps] = useState(null);
  // 'claude' until the server's configured default (sandbox.config.json's
  // "defaultApp") arrives via /api/dirs/home, or the user picks explicitly.
  const [appDefault, setAppDefault] = useState(() => {
    const saved = localStorage.getItem(APP_KEY);
    return saved === 'opencode' || saved === 'copilot' || saved === 'claude' ? saved : 'claude';
  });
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const [launchMode, setLaunchMode] = useState('single'); // 'single' | 'combo'
  const [comboApps, setComboApps] = useState({ workerA: 'claude', workerB: 'opencode', orchestrator: 'claude' });
  // Free-form per-role model identifiers; empty string = omitted (server uses
  // the persisted role preference, then the app default). null would mean
  // "explicitly the app default", which the text input doesn't produce -- an
  // omitted value is the practical equivalent.
  const [comboModels, setComboModels] = useState({ workerA: '', workerB: '', orchestrator: '' });
  // Per-role sandbox overrides; null = inherit the group-level common flags.
  const [comboRoleSandbox, setComboRoleSandbox] = useState({ workerA: null, workerB: null, orchestrator: null });
  const [orchestratorInstructions, setOrchestratorInstructions] = useState('');
  const [sandboxOpts, setSandboxOpts] = useState(() => loadSandboxOpts(currentPath));

  // Combo-mode state is per-launch, not sticky: leaving the modal (cancel,
  // overlay click, or a launch) must return it to the plain single mode,
  // otherwise the user's next "起動" -- possibly for a different project --
  // would silently fire a full combo spawn with the previous instructions.
  // One close path for every exit route so future routes can't forget.
  const closeOpenMenu = useCallback(() => {
    setLaunchMode('single');
    setOrchestratorInstructions('');
    setComboModels({ workerA: '', workerB: '', orchestrator: '' });
    setComboRoleSandbox({ workerA: null, workerB: null, orchestrator: null });
    setOpenMenuOpen(false);
  }, []);

  const chooseSandbox = useCallback((val) => {
    if (forceSandbox) return; // server forbids unsandboxed launches
    setSandboxDefault(val);
    localStorage.setItem(SANDBOX_KEY, val ? '1' : '0');
  }, [forceSandbox]);

  const chooseApp = useCallback((val) => {
    setAppDefault(val);
    localStorage.setItem(APP_KEY, val);
  }, []);

  // gpg/sshAgent are remembered per directory, not globally -- reload whenever
  // the browser navigates to a different one.
  useEffect(() => {
    setSandboxOpts(loadSandboxOpts(currentPath));
  }, [currentPath]);

  const updateSandboxOpts = useCallback((path, next) => {
    setSandboxOpts(next);
    saveSandboxOpts(path, next);
  }, []);

  const fetchDirs = useCallback(async (path) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ path });
      if (showHidden) params.set('showHidden', '1');
      const res = await authFetch(`/api/dirs?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setCurrentPath(data.current);
      setParentPath(data.parent);
      setDirs(data.dirs);
      setFiles(data.files || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [showHidden]);

  useEffect(() => {
    authFetch('/api/dirs/home').then(r => r.json()).then(data => {
      setHomeDir(data.home);
      if (!initialPath && !localStorage.getItem(LAST_DIR_KEY)) {
        setCurrentPath(data.home);
      }
      // Seed the app picker from the server's configured default, but only
      // if the user hasn't explicitly picked one on this browser yet.
      if (!localStorage.getItem(APP_KEY) && (data.defaultApp === 'opencode' || data.defaultApp === 'copilot' || data.defaultApp === 'claude')) {
        setAppDefault(data.defaultApp);
      }
      // Server-enforced sandbox: force the toggle on and lock it.
      if (data.forceSandbox) {
        setForceSandbox(true);
        setSandboxDefault(true);
      }
      // Server-side install detection: grey out picker entries for CLIs that
      // don't exist here, and correct a stale default (localStorage
      // ccserver-app-default, or the server's defaultApp) that points at an
      // uninstalled app -- the launch button label and modal checkmark must
      // never advertise an app that cannot start.
      if (data.availableApps) {
        setAvailableApps(data.availableApps);
        const avail = ['claude', 'opencode', 'copilot'].filter((a) => data.availableApps[a]);
        if (avail.length > 0 && !data.availableApps[appDefault]) {
          setAppDefault(avail[0]);
        }
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetchDirs(currentPath);
    localStorage.setItem(LAST_DIR_KEY, currentPath);
  }, [currentPath, fetchDirs]);

  const navigateTo = useCallback((path) => {
    setCurrentPath(path);
  }, []);

  const navigateUp = useCallback(() => {
    if (parentPath) setCurrentPath(parentPath);
  }, [parentPath]);

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) return;
    try {
      const res = await authFetch('/api/dirs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: currentPath, name: newFolderName.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setCreatingFolder(false);
      setNewFolderName('');
      setCurrentPath(data.path);
    } catch (err) {
      setError(err.message);
    }
  }, [currentPath, newFolderName]);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await authFetch('/api/sessions');
      if (res.ok) {
        const data = await res.json();
        // Group members (workerA/workerB/orchestrator) are reached through
        // the combo group's own sub-tab UI; listing them here would let a
        // click attach the same sessionId from a second tab, detaching the
        // live one inside the group (attachSocket replaces the old socket).
        setSessions((data.sessions || []).filter((s) => s.groupId == null));
      }
    } catch {
      // ignore — sessions panel is supplementary
    }
    // Combo groups live in their own tab UI; list them here so a reloaded
    // browser can re-open a group (live members re-attach, restored ones
    // resume). A running group's members are filtered from the session list
    // above, so this is the only way back in after a page reload.
    try {
      const res = await authFetch('/api/groups');
      if (res.ok) {
        const data = await res.json();
        setGroups((data.groups || []).filter((g) => g.liveCount > 0 || g.memberCount > 0));
      }
    } catch {
      // ignore — groups panel is supplementary
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions, groupsVersion]);

  const handleSessionClick = useCallback((session) => {
    onSessionClick(session);
  }, [onSessionClick]);

  const handleDeleteSession = useCallback(async (session) => {
    if (!window.confirm(`セッションを終了しますか?\n${session.cwd}`)) return;
    try {
      const res = await authFetch(`/api/sessions/${session.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err.message);
    }
    fetchSessions();
  }, [fetchSessions]);

  const handleDownload = useCallback((file) => {
    const a = document.createElement('a');
    const token = getToken();
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
    a.href = `/api/files?path=${encodeURIComponent(file.path)}${tokenParam}`;
    a.download = file.name;
    a.click();
  }, []);

  const uploadFiles = useCallback(async (fileList) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setUploadProgress(`Uploading ${fileList.length} file(s)...`);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('destination', currentPath);
      for (const file of fileList) {
        formData.append('files', file);
      }
      const res = await authFetch('/api/files', { method: 'POST', body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setUploadProgress(`Uploaded ${data.uploaded.length} file(s)`);
      fetchDirs(currentPath);
      setTimeout(() => setUploadProgress(''), 3000);
    } catch (err) {
      setError(err.message);
      setUploadProgress('');
    } finally {
      setUploading(false);
    }
  }, [currentPath, fetchDirs]);

  const handleFileInputChange = useCallback((e) => {
    uploadFiles(e.target.files);
    e.target.value = '';
  }, [uploadFiles]);

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    dragCountRef.current++;
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    dragCountRef.current--;
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0;
      setDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    dragCountRef.current = 0;
    setDragOver(false);
    uploadFiles(e.dataTransfer.files);
  }, [uploadFiles]);

  const pathRoot = currentPath.match(/^([a-zA-Z]:\\|\/)/)?.[0] || '/';
  const breadcrumbs = currentPath.slice(pathRoot.length).split(/[/\\]/).filter(Boolean);

  return (
    <div
      className="directory-browser"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="browser-header">
        <h1>Select a Directory</h1>
        <p className="subtitle">Choose a working directory</p>
      </div>

      <nav className="breadcrumbs">
        <button className="breadcrumb-item" onClick={() => navigateTo(pathRoot)}>
          {pathRoot}
        </button>
        {breadcrumbs.map((segment, i) => {
          const sep = pathRoot.includes('\\') ? '\\' : '/';
          const path = pathRoot + breadcrumbs.slice(0, i + 1).join(sep);
          return (
            <span key={path}>
              <span className="breadcrumb-sep">/</span>
              <button className="breadcrumb-item" onClick={() => navigateTo(path)}>
                {segment}
              </button>
            </span>
          );
        })}
      </nav>

      <div className="browser-toolbar">
        <button className="btn btn-secondary" onClick={navigateUp} disabled={!parentPath}>
          Up
        </button>
        <button className="btn btn-secondary" onClick={() => homeDir && navigateTo(homeDir)} disabled={!homeDir}>
          Home
        </button>
        <button className="btn btn-secondary" onClick={() => { fetchDirs(currentPath); fetchSessions(); }} disabled={loading}>
          Refresh
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => {
            setCreatingFolder(true);
            setNewFolderName('');
          }}
        >
          New Folder
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          Upload
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileInputChange}
          style={{ display: 'none' }}
        />
        <label className="toggle-hidden">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
          />
          Show hidden
        </label>
        <button className="btn btn-secondary open-btn" onClick={() => onOpenShell(currentPath)}>
          Terminal
        </button>
        <div className="open-split">
          <button
            className="btn btn-primary open-btn open-split-main"
            onClick={() => onOpen(currentPath, { sandbox: sandboxDefault, sandboxOpts, app: appDefault })}
            title={sandboxDefault ? 'サンドボックスで起動' : '通常起動'}
          >
            {sandboxDefault ? '🔒 ' : ''}{appDefault === 'claude' ? 'Claude Code' : appDefault === 'copilot' ? 'GitHub Copilot' : 'opencode'}
          </button>
          <button
            className="btn btn-primary open-btn open-split-caret"
            onClick={() => setOpenMenuOpen(true)}
            title="起動方法を選択"
            aria-label="起動方法を選択"
          >
            &#9662;
          </button>
        </div>
      </div>

      {openMenuOpen && (
        // Modal instead of an anchored dropdown: a dropdown positioned off
        // .open-split (position: absolute; right: 0) has no way to know
        // when it no longer fits a narrow viewport, and reliably ran off
        // the right edge on iPhone. A centered, viewport-relative modal
        // (same pattern as the close/resume dialogs below) sidesteps that
        // entirely.
        <div className="resume-overlay" onClick={closeOpenMenu}>
          <div className="resume-dialog open-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>起動方法を選択</h3>
            <div className="launch-mode-toggle">
              <button
                className={`launch-mode-btn${launchMode === 'single' ? ' active' : ''}`}
                onClick={() => setLaunchMode('single')}
              >
                通常起動
              </button>
              <button
                className={`launch-mode-btn${launchMode === 'combo' ? ' active' : ''}`}
                onClick={() => setLaunchMode('combo')}
              >
                コンボ起動
              </button>
            </div>

            {launchMode === 'single' ? (
              <>
                <div className="open-menu-label">アプリ</div>
                <div
                  className={`open-menu-item${availableApps && !availableApps.claude ? ' open-menu-item-disabled' : ''}`}
                  onClick={() => chooseApp('claude')}
                  title={availableApps && !availableApps.claude ? 'サーバーに未インストール' : ''}
                >
                  <span className="open-menu-check">{appDefault === 'claude' ? '✓' : ''}</span>
                  Claude Code
                </div>
                <div
                  className={`open-menu-item${availableApps && !availableApps.opencode ? ' open-menu-item-disabled' : ''}`}
                  onClick={() => chooseApp('opencode')}
                  title={availableApps && !availableApps.opencode ? 'サーバーに未インストール' : ''}
                >
                  <span className="open-menu-check">{appDefault === 'opencode' ? '✓' : ''}</span>
                  opencode
                </div>
                <div
                  className={`open-menu-item${availableApps && !availableApps.copilot ? ' open-menu-item-disabled' : ''}`}
                  onClick={() => chooseApp('copilot')}
                  title={availableApps && !availableApps.copilot ? 'サーバーに未インストール' : ''}
                >
                  <span className="open-menu-check">{appDefault === 'copilot' ? '✓' : ''}</span>
                  GitHub Copilot
                </div>
                <div className="open-menu-sep" />
                <div
                  className={`open-menu-item${forceSandbox ? ' open-menu-item-disabled' : ''}`}
                  onClick={() => chooseSandbox(false)}
                  title={forceSandbox ? 'サーバー設定でサンドボックス外の起動は禁止されています' : ''}
                >
                  <span className="open-menu-check">{!sandboxDefault ? '✓' : ''}</span>
                  通常起動
                </div>
                <div
                  className="open-menu-item"
                  onClick={() => chooseSandbox(true)}
                  title={forceSandbox ? 'サーバー設定で強制' : ''}
                >
                  <span className="open-menu-check">{sandboxDefault ? '✓' : ''}</span>
                  🔒 サンドボックスで起動
                </div>
                <div className="open-menu-suboptions">
                  <label className="open-menu-suboption">
                    <input
                      type="checkbox"
                      checked={sandboxOpts.gpg}
                      onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, gpg: e.target.checked })}
                    />
                    GPG署名を使う
                  </label>
                  <label className="open-menu-suboption">
                    <input
                      type="checkbox"
                      checked={sandboxOpts.sshAgent}
                      onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, sshAgent: e.target.checked })}
                    />
                    ssh-agentを転送する
                  </label>
                </div>
                <p className="open-menu-note">
                  {forceSandbox
                    ? 'サンドボックスがサーバー設定 (forceSandbox) で強制されています。通常起動はできません。'
                    : `サンドボックス: 隣接プロジェクトを隔離し、内部に rootless docker を用意。GPG/ssh-agentは既定オフ、このディレクトリ (${currentPath}) に記憶されます。`}
                </p>
              </>
            ) : (
              <>
                <p className="open-menu-note">
                  コンボ起動: 1つのプロジェクトディレクトリで動く2つのワーカーと、
                  それらをMCP経由で操作するオーケストレーターをセットで起動します。
                  全セッション常時サンドボックスです ({currentPath})。
                </p>
                <div className="open-menu-label">ワーカーA</div>
                <div className="open-menu-app-row">
                  {['claude', 'opencode'].map((app) => (
                    <button
                      key={app}
                      className={`open-menu-app-btn${comboApps.workerA === app ? ' active' : ''}${availableApps && !availableApps[app] ? ' open-menu-item-disabled' : ''}`}
                      onClick={() => { if (!availableApps || availableApps[app]) setComboApps((c) => ({ ...c, workerA: app })); }}
                      title={availableApps && !availableApps[app] ? 'サーバーに未インストール' : ''}
                    >
                      {app === 'claude' ? 'Claude Code' : 'opencode'}
                    </button>
                  ))}
                </div>
                <div className="open-menu-model-row">
                  <input
                    type="text"
                    className="open-menu-model-input"
                    placeholder="モデル (空=既定/保存済み設定)"
                    value={comboModels.workerA}
                    onChange={(e) => setComboModels((c) => ({ ...c, workerA: e.target.value }))}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>
                <div className="open-menu-label">ワーカーB</div>
                <div className="open-menu-app-row">
                  {['claude', 'opencode'].map((app) => (
                    <button
                      key={app}
                      className={`open-menu-app-btn${comboApps.workerB === app ? ' active' : ''}${availableApps && !availableApps[app] ? ' open-menu-item-disabled' : ''}`}
                      onClick={() => { if (!availableApps || availableApps[app]) setComboApps((c) => ({ ...c, workerB: app })); }}
                      title={availableApps && !availableApps[app] ? 'サーバーに未インストール' : ''}
                    >
                      {app === 'claude' ? 'Claude Code' : 'opencode'}
                    </button>
                  ))}
                </div>
                <div className="open-menu-model-row">
                  <input
                    type="text"
                    className="open-menu-model-input"
                    placeholder="モデル (空=既定/保存済み設定)"
                    value={comboModels.workerB}
                    onChange={(e) => setComboModels((c) => ({ ...c, workerB: e.target.value }))}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>
                <div className="open-menu-suboptions">
                  <label className="open-menu-suboption">
                    <input
                      type="checkbox"
                      checked={sandboxOpts.gpg}
                      onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, gpg: e.target.checked })}
                    />
                    GPG署名を使う (両ワーカー共通)
                  </label>
                  <label className="open-menu-suboption">
                    <input
                      type="checkbox"
                      checked={sandboxOpts.sshAgent}
                      onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, sshAgent: e.target.checked })}
                    />
                    ssh-agentを転送する (両ワーカー共通)
                  </label>
                </div>
                {(['workerA', 'workerB']).map((role) => (
                  <div key={role} className="open-menu-role-sandbox">
                    <label className="open-menu-suboption">
                      <input
                        type="checkbox"
                        checked={comboRoleSandbox[role] !== null}
                        onChange={(e) => setComboRoleSandbox((s) => ({
                          ...s,
                          [role]: e.target.checked ? { ...sandboxOpts } : null,
                        }))}
                      />
                      {role} のサンドボックスを個別設定
                    </label>
                    {comboRoleSandbox[role] !== null && (
                      <div className="open-menu-suboptions">
                        <label className="open-menu-suboption">
                          <input
                            type="checkbox"
                            checked={comboRoleSandbox[role].gpg}
                            onChange={(e) => setComboRoleSandbox((s) => ({
                              ...s,
                              [role]: { ...s[role], gpg: e.target.checked },
                            }))}
                          />
                          {role} GPG
                        </label>
                        <label className="open-menu-suboption">
                          <input
                            type="checkbox"
                            checked={comboRoleSandbox[role].sshAgent}
                            onChange={(e) => setComboRoleSandbox((s) => ({
                              ...s,
                              [role]: { ...s[role], sshAgent: e.target.checked },
                            }))}
                          />
                          {role} ssh-agent
                        </label>
                      </div>
                    )}
                  </div>
                ))}
                <div className="open-menu-label">オーケストレーター</div>
                <div className="open-menu-app-row">
                  {['claude', 'opencode'].map((app) => (
                    <button
                      key={app}
                      className={`open-menu-app-btn${comboApps.orchestrator === app ? ' active' : ''}${availableApps && !availableApps[app] ? ' open-menu-item-disabled' : ''}`}
                      onClick={() => { if (!availableApps || availableApps[app]) setComboApps((c) => ({ ...c, orchestrator: app })); }}
                      title={availableApps && !availableApps[app] ? 'サーバーに未インストール' : ''}
                    >
                      {app === 'claude' ? 'Claude Code' : 'opencode'}
                    </button>
                  ))}
                </div>
                <div className="open-menu-model-row">
                  <input
                    type="text"
                    className="open-menu-model-input"
                    placeholder="モデル (空=既定/保存済み設定)"
                    value={comboModels.orchestrator}
                    onChange={(e) => setComboModels((c) => ({ ...c, orchestrator: e.target.value }))}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>
                <div className="open-menu-role-sandbox">
                  <label className="open-menu-suboption">
                    <input
                      type="checkbox"
                      checked={comboRoleSandbox.orchestrator !== null}
                      onChange={(e) => setComboRoleSandbox((s) => ({
                        ...s,
                        orchestrator: e.target.checked ? { ...sandboxOpts } : null,
                      }))}
                    />
                    オーケストレーターのサンドボックスを個別設定
                  </label>
                  {comboRoleSandbox.orchestrator !== null && (
                    <div className="open-menu-suboptions">
                      <label className="open-menu-suboption">
                        <input
                          type="checkbox"
                          checked={comboRoleSandbox.orchestrator.gpg}
                          onChange={(e) => setComboRoleSandbox((s) => ({
                            ...s,
                            orchestrator: { ...s.orchestrator, gpg: e.target.checked },
                          }))}
                        />
                        オーケストレーター GPG
                      </label>
                      <label className="open-menu-suboption">
                        <input
                          type="checkbox"
                          checked={comboRoleSandbox.orchestrator.sshAgent}
                          onChange={(e) => setComboRoleSandbox((s) => ({
                            ...s,
                            orchestrator: { ...s.orchestrator, sshAgent: e.target.checked },
                          }))}
                        />
                        オーケストレーター ssh-agent
                      </label>
                    </div>
                  )}
                </div>
                <p className="open-menu-note">
                  オーケストレーターは専用の隔離ディレクトリで動作し、プロジェクトへの
                  直接アクセスはありません。操作はすべてMCPツール経由です。
                </p>
                <div className="open-menu-label">オーケストレーターへの指示</div>
                <textarea
                  className="open-menu-instructions"
                  placeholder="空の場合は既定テンプレートが使われます"
                  value={orchestratorInstructions}
                  onChange={(e) => setOrchestratorInstructions(e.target.value)}
                  rows={5}
                />
              </>
            )}

            <div className="resume-actions">
              <button className="btn btn-secondary" onClick={closeOpenMenu}>キャンセル</button>
              {launchMode === 'combo' ? (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    // Build the payload BEFORE closing the menu: closeOpenMenu
                    // resets the draft model/sandbox state, and React state
                    // reads inside this handler only see the pre-update
                    // values. Only send options the user explicitly chose: an
                    // empty model is omitted (server falls back to the
                    // persisted role preference), and a null per-role sandbox
                    // means "inherit the group-level flags". `app` is always
                    // sent because it's a required choice in this UI.
                    const roleSpec = (role) => {
                      const spec = { app: comboApps[role] };
                      if (comboModels[role].trim()) spec.model = comboModels[role].trim();
                      if (comboRoleSandbox[role]) spec.sandboxOpts = comboRoleSandbox[role];
                      return spec;
                    };
                    onOpenCombo(currentPath, {
                      workerA: roleSpec('workerA'),
                      workerB: roleSpec('workerB'),
                      orchestrator: { ...roleSpec('orchestrator'), instructions: orchestratorInstructions },
                      sandboxOpts,
                    });
                    closeOpenMenu();
                  }}
                >
                  コンボ起動
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={() => { closeOpenMenu(); onOpen(currentPath, { sandbox: sandboxDefault, sandboxOpts, app: appDefault }); }}
                >
                  起動
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {uploadProgress && (
        <div className="upload-progress">{uploadProgress}</div>
      )}

      {creatingFolder && (
        <div className="new-folder-bar">
          <input
            type="text"
            className="new-folder-input"
            placeholder="Folder name"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateFolder();
              if (e.key === 'Escape') setCreatingFolder(false);
            }}
            autoFocus
          />
          <button className="btn btn-primary" onClick={handleCreateFolder}>
            Create
          </button>
          <button className="btn btn-secondary" onClick={() => setCreatingFolder(false)}>
            Cancel
          </button>
        </div>
      )}

      {(sessions.length > 0 || groups.length > 0) && (
        <div className="session-list">
          <div className="session-list-header">Active Sessions</div>
          {sessions.map((session) => (
            <div
              key={session.id}
              className="session-item"
              onClick={() => handleSessionClick(session)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSessionClick(session);
              }}
            >
              <span className="session-icon">
                {session.connected ? '\u25B6' : '\u23F8'}
              </span>
              <span className="session-cwd">{session.cwd}</span>
              {session.sandbox ? (
                <span className="session-badge sandbox" title="このセッションはサンドボックスで実行中">sandbox</span>
              ) : !session.shell ? (
                <span className="session-badge no-sandbox" title="このセッションはサンドボックス外で実行中">no sandbox</span>
              ) : null}
              <span className="session-status active">
                {session.shell
                  ? 'shell'
                  : `${session.app === 'claude' ? 'claude' : session.app === 'copilot' ? 'copilot' : 'opencode'} · ${session.connected ? 'connected' : 'idle'}`}
              </span>
              <button
                className="btn btn-secondary session-delete-btn"
                onClick={(e) => { e.stopPropagation(); handleDeleteSession(session); }}
                title="Terminate session"
              >
                &#10005;
              </button>
            </div>
          ))}
          {groups.length > 0 && (
            <>
              <div className="session-list-header">Groups</div>
              {groups.map((g) => (
                <div
                  key={g.groupId}
                  className="session-item"
                  onClick={() => onOpenGroup(g.groupId)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onOpenGroup(g.groupId);
                  }}
                >
                  <span className="session-icon">{'\u26A1'}</span>
                  <span className="session-cwd">{g.cwd}</span>
                  <span className="session-status resumable">
                    {g.liveCount > 0
                      ? `group · ${g.memberCount} members · ${g.liveCount} live`
                      : `group · ${g.memberCount} members · closed (click to reopen)`}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      <div className={`dir-list${dragOver ? ' drag-over' : ''}`}>
        {loading && <div className="loading">Loading...</div>}
        {error && <div className="error">Error: {error}</div>}
        {!loading && !error && dirs.length === 0 && files.length === 0 && (
          <div className="empty">No entries</div>
        )}
        {!loading &&
          !error &&
          dirs.map((dir) => (
            <div
              key={dir.path}
              className="dir-item"
              onClick={() => navigateTo(dir.path)}
              onDoubleClick={() => onOpen(dir.path, { sandbox: sandboxDefault, sandboxOpts: loadSandboxOpts(dir.path), app: appDefault })}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') navigateTo(dir.path);
              }}
            >
              <span className="dir-icon">&#128193;</span>
              <span className="dir-name">{dir.name}</span>
            </div>
          ))}
        {!loading &&
          !error &&
          files.map((file) => (
            <div key={file.path} className="file-item">
              <span className="file-icon">&#128196;</span>
              <span className="file-name">{file.name}</span>
              <span className="file-size">{formatSize(file.size)}</span>
              <button
                className="btn btn-secondary file-download-btn"
                onClick={() => handleDownload(file)}
                title="Download"
              >
                &#8595;
              </button>
            </div>
          ))}
      </div>

      {dragOver && (
        <div className="drag-overlay">
          <div className="drag-overlay-text">Drop files to upload</div>
        </div>
      )}
    </div>
  );
}
