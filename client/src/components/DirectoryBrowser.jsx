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

export default function DirectoryBrowser({ onOpen, onOpenShell, onOpenCombo, onSessionClick, initialPath }) {
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
  const [savedSessions, setSavedSessions] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const fileInputRef = useRef(null);
  const dragCountRef = useRef(0);
  const [sandboxDefault, setSandboxDefault] = useState(() => localStorage.getItem(SANDBOX_KEY) === '1');
  // 'claude' until the server's configured default (sandbox.config.json's
  // "defaultApp") arrives via /api/dirs/home, or the user picks explicitly.
  const [appDefault, setAppDefault] = useState(() => {
    const saved = localStorage.getItem(APP_KEY);
    return saved === 'opencode' || saved === 'claude' ? saved : 'claude';
  });
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const [launchMode, setLaunchMode] = useState('single'); // 'single' | 'combo'
  const [comboApps, setComboApps] = useState({ workerA: 'claude', workerB: 'opencode', orchestrator: 'claude' });
  const [orchestratorInstructions, setOrchestratorInstructions] = useState('');
  const [sandboxOpts, setSandboxOpts] = useState(() => loadSandboxOpts(currentPath));

  const chooseSandbox = useCallback((val) => {
    setSandboxDefault(val);
    localStorage.setItem(SANDBOX_KEY, val ? '1' : '0');
  }, []);

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
      if (!localStorage.getItem(APP_KEY) && (data.defaultApp === 'opencode' || data.defaultApp === 'claude')) {
        setAppDefault(data.defaultApp);
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
        setSessions(data.sessions);
        if (data.savedSessions) {
          setSavedSessions(data.savedSessions);
        }
      }
    } catch {
      // ignore — sessions panel is supplementary
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const handleSessionClick = useCallback((session) => {
    onSessionClick(session);
  }, [onSessionClick]);

  const handleSavedSessionClick = useCallback((saved) => {
    const app = saved.app === 'opencode' ? 'opencode' : 'claude';
    // Preserve the session's original sandbox setting; fall back to the current
    // default only for legacy saved entries that predate the persisted flag.
    const sandbox = saved.sandbox ?? sandboxDefault;
    const opts = saved.sandboxOpts ?? loadSandboxOpts(saved.cwd);
    if (app === 'opencode') {
      // opencode sessions resume the last session of the project via -c.
      onOpen(saved.cwd, { sandbox, sandboxOpts: opts, app, resume: true });
      return;
    }
    const claudeResumeKey = `ccserver-resume:claude:${saved.cwd}`;
    if (saved.claudeSessionId) {
      localStorage.setItem(claudeResumeKey, saved.claudeSessionId);
    }
    onOpen(saved.cwd, { sandbox, sandboxOpts: opts, app: 'claude' });
  }, [onOpen, sandboxDefault]);

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

  const handleDeleteSavedSession = useCallback(async (index) => {
    if (!window.confirm('保存済みセッションを削除しますか?')) return;
    try {
      const res = await authFetch(`/api/sessions/saved/${index}`, { method: 'DELETE' });
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
            {sandboxDefault ? '🔒 ' : ''}{appDefault === 'opencode' ? 'opencode' : 'Claude Code'}
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
        <div className="resume-overlay" onClick={() => setOpenMenuOpen(false)}>
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
                  className="open-menu-item"
                  onClick={() => chooseApp('claude')}
                >
                  <span className="open-menu-check">{appDefault === 'claude' ? '✓' : ''}</span>
                  Claude Code
                </div>
                <div
                  className="open-menu-item"
                  onClick={() => chooseApp('opencode')}
                >
                  <span className="open-menu-check">{appDefault === 'opencode' ? '✓' : ''}</span>
                  opencode
                </div>
                <div className="open-menu-sep" />
                <div
                  className="open-menu-item"
                  onClick={() => chooseSandbox(false)}
                >
                  <span className="open-menu-check">{!sandboxDefault ? '✓' : ''}</span>
                  通常起動
                </div>
                <div
                  className="open-menu-item"
                  onClick={() => chooseSandbox(true)}
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
                  サンドボックス: 隣接プロジェクトを隔離し、内部に rootless docker を用意。
                  GPG/ssh-agentは既定オフ、このディレクトリ ({currentPath}) に記憶されます。
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
                      className={`open-menu-app-btn${comboApps.workerA === app ? ' active' : ''}`}
                      onClick={() => setComboApps((c) => ({ ...c, workerA: app }))}
                    >
                      {app === 'claude' ? 'Claude Code' : 'opencode'}
                    </button>
                  ))}
                </div>
                <div className="open-menu-label">ワーカーB</div>
                <div className="open-menu-app-row">
                  {['claude', 'opencode'].map((app) => (
                    <button
                      key={app}
                      className={`open-menu-app-btn${comboApps.workerB === app ? ' active' : ''}`}
                      onClick={() => setComboApps((c) => ({ ...c, workerB: app }))}
                    >
                      {app === 'claude' ? 'Claude Code' : 'opencode'}
                    </button>
                  ))}
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
                <div className="open-menu-label">オーケストレーター</div>
                <div className="open-menu-app-row">
                  {['claude', 'opencode'].map((app) => (
                    <button
                      key={app}
                      className={`open-menu-app-btn${comboApps.orchestrator === app ? ' active' : ''}`}
                      onClick={() => setComboApps((c) => ({ ...c, orchestrator: app }))}
                    >
                      {app === 'claude' ? 'Claude Code' : 'opencode'}
                    </button>
                  ))}
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
              <button className="btn btn-secondary" onClick={() => setOpenMenuOpen(false)}>キャンセル</button>
              {launchMode === 'combo' ? (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setOpenMenuOpen(false);
                    onOpenCombo(currentPath, {
                      workerA: { app: comboApps.workerA },
                      workerB: { app: comboApps.workerB },
                      orchestrator: { app: comboApps.orchestrator, instructions: orchestratorInstructions },
                      sandboxOpts,
                    });
                  }}
                >
                  コンボ起動
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={() => { setOpenMenuOpen(false); onOpen(currentPath, { sandbox: sandboxDefault, sandboxOpts, app: appDefault }); }}
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

      {(sessions.length > 0 || savedSessions.length > 0) && (
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
              {session.sandbox && (
                <span className="session-badge sandbox" title="このセッションはサンドボックスで実行中">sandbox</span>
              )}
              <span className="session-status active">
                {session.shell
                  ? 'shell'
                  : `${session.app === 'opencode' ? 'opencode' : 'claude'} · ${session.connected ? 'connected' : 'idle'}`}
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
          {savedSessions.map((saved, i) => (
            <div
              key={`saved-${i}`}
              className="session-item"
              onClick={() => handleSavedSessionClick(saved)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSavedSessionClick(saved);
              }}
            >
              <span className="session-icon">{'\u21BB'}</span>
              <span className="session-cwd">{saved.cwd}</span>
              {saved.sandbox && (
                <span className="session-badge sandbox" title="保存時の起動設定: サンドボックス">sandbox</span>
              )}
              <span className="session-status resumable">
                {saved.app === 'opencode' ? 'opencode' : 'claude'} · resumable
              </span>
              <button
                className="btn btn-secondary session-delete-btn"
                onClick={(e) => { e.stopPropagation(); handleDeleteSavedSession(i); }}
                title="Remove saved session"
              >
                &#10005;
              </button>
            </div>
          ))}
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
