import { useState, useEffect, useCallback } from 'react';

const HOME_DIR = '/home/kts_sz';

export default function DirectoryBrowser({ onOpen, initialPath }) {
  const [currentPath, setCurrentPath] = useState(initialPath || HOME_DIR);
  const [dirs, setDirs] = useState([]);
  const [parentPath, setParentPath] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showHidden, setShowHidden] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [sessions, setSessions] = useState([]);

  const fetchDirs = useCallback(async (path) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ path });
      if (showHidden) params.set('showHidden', '1');
      const res = await fetch(`/api/dirs?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setCurrentPath(data.current);
      setParentPath(data.parent);
      setDirs(data.dirs);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [showHidden]);

  useEffect(() => {
    fetchDirs(currentPath);
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
      const res = await fetch('/api/dirs', {
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
      const res = await fetch('/api/sessions');
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions);
      }
    } catch {
      // ignore — sessions panel is supplementary
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const handleSessionClick = useCallback((session) => {
    const storageKey = `ccserver-session:${session.cwd}`;
    sessionStorage.setItem(storageKey, session.id);
    onOpen(session.cwd, true);
  }, [onOpen]);

  const breadcrumbs = currentPath.split('/').filter(Boolean);

  return (
    <div className="directory-browser">
      <div className="browser-header">
        <h1>Select a Directory</h1>
        <p className="subtitle">Choose a working directory for Claude Code</p>
      </div>

      <nav className="breadcrumbs">
        <button className="breadcrumb-item" onClick={() => navigateTo('/')}>
          /
        </button>
        {breadcrumbs.map((segment, i) => {
          const path = '/' + breadcrumbs.slice(0, i + 1).join('/');
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
        <button className="btn btn-secondary" onClick={() => navigateTo(HOME_DIR)}>
          Home
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
        <label className="toggle-hidden">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
          />
          Show hidden
        </label>
        <button className="btn btn-primary open-btn" onClick={() => onOpen(currentPath)}>
          Open with Claude Code
        </button>
      </div>

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

      {sessions.length > 0 && (
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
                {session.exited ? '\u23F9' : session.connected ? '\u25B6' : '\u23F8'}
              </span>
              <span className="session-cwd">{session.cwd}</span>
              <span className={`session-status ${session.exited ? 'exited' : 'active'}`}>
                {session.exited
                  ? `exited (${session.exitCode})`
                  : session.connected
                    ? 'connected'
                    : 'idle'}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="dir-list">
        {loading && <div className="loading">Loading...</div>}
        {error && <div className="error">Error: {error}</div>}
        {!loading && !error && dirs.length === 0 && (
          <div className="empty">No subdirectories</div>
        )}
        {!loading &&
          !error &&
          dirs.map((dir) => (
            <div
              key={dir.path}
              className="dir-item"
              onClick={() => navigateTo(dir.path)}
              onDoubleClick={() => onOpen(dir.path)}
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
      </div>
    </div>
  );
}
