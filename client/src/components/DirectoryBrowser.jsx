import { useState, useEffect, useCallback, useRef } from 'react';

const HOME_DIR = '/home/kts_sz';

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${i === 0 ? val : val.toFixed(1)} ${units[i]}`;
}

export default function DirectoryBrowser({ onOpen, onOpenShell, onSessionClick, initialPath }) {
  const [currentPath, setCurrentPath] = useState(initialPath || HOME_DIR);
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
      setFiles(data.files || []);
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
    const claudeResumeKey = `ccserver-claude-resume:${saved.cwd}`;
    localStorage.setItem(claudeResumeKey, saved.claudeSessionId);
    onOpen(saved.cwd);
  }, [onOpen]);

  const handleDeleteSession = useCallback(async (session) => {
    if (!window.confirm(`セッションを終了しますか?\n${session.cwd}`)) return;
    try {
      const res = await fetch(`/api/sessions/${session.id}`, { method: 'DELETE' });
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
      const res = await fetch(`/api/sessions/saved/${index}`, { method: 'DELETE' });
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
    a.href = `/api/files?path=${encodeURIComponent(file.path)}`;
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
      const res = await fetch('/api/files', { method: 'POST', body: formData });
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

  const breadcrumbs = currentPath.split('/').filter(Boolean);

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
        <button className="btn btn-primary open-btn" onClick={() => onOpen(currentPath)}>
          Claude Code
        </button>
      </div>

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
              <span className="session-status active">
                {session.shell ? 'shell' : session.connected ? 'connected' : 'idle'}
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
              <span className="session-status resumable">resumable</span>
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
