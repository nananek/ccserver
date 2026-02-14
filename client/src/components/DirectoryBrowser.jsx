import { useState, useEffect, useCallback } from 'react';

const HOME_DIR = '/home/kts_sz';

export default function DirectoryBrowser({ onOpen }) {
  const [currentPath, setCurrentPath] = useState(HOME_DIR);
  const [dirs, setDirs] = useState([]);
  const [parentPath, setParentPath] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showHidden, setShowHidden] = useState(false);

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
