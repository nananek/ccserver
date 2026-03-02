import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import DirectoryBrowser from './components/DirectoryBrowser.jsx';
import TerminalView from './components/TerminalView.jsx';
import SystemMonitor from './components/SystemMonitor.jsx';
import { useNotifications } from './hooks/useNotifications.js';
import { getThemeIds, getTheme, loadThemeId, saveThemeId, applyThemeCss } from './themes.js';

let tabIdCounter = 0;

export default function App() {
  const [tabs, setTabs] = useState([
    { id: 'browser', type: 'browser', label: 'Files' },
    { id: 'monitor', type: 'monitor', label: 'Monitor' },
  ]);
  const [activeTabId, setActiveTabId] = useState('browser');
  const [lastDir, setLastDir] = useState(null);
  const [resumePrompt, setResumePrompt] = useState(null);
  const [themeId, setThemeId] = useState(loadThemeId);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef(null);
  const pendingOpenRef = useRef(null);
  const { enabled: notifyEnabled, permission: notifyPermission, toggle: toggleNotify, notify } = useNotifications();

  useEffect(() => {
    applyThemeCss(themeId);
    saveThemeId(themeId);
  }, [themeId]);

  useEffect(() => {
    if (!themeMenuOpen) return;
    const handleClick = (e) => {
      if (themeMenuRef.current && !themeMenuRef.current.contains(e.target)) {
        setThemeMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [themeMenuOpen]);

  const themeIds = useMemo(() => getThemeIds(), []);

  const openTerminalTab = useCallback((dirPath, { claudeSessionId = null, shell = false, sessionId = null, attachSessionId = null } = {}) => {
    const id = `terminal-${++tabIdCounter}`;
    const dirName = dirPath.split('/').filter(Boolean).pop() || '/';
    const label = shell ? `$ ${dirName}` : dirName;
    setTabs((prev) => [
      ...prev,
      { id, type: 'terminal', label, cwd: dirPath, claudeSessionId, shell, sessionId, attachSessionId },
    ]);
    setActiveTabId(id);
    setLastDir(dirPath);
  }, []);

  const handleOpen = useCallback((dirPath, skipResumePrompt = false) => {
    if (!skipResumePrompt) {
      const savedSessionId = localStorage.getItem(`ccserver-claude-resume:${dirPath}`);
      if (savedSessionId) {
        pendingOpenRef.current = dirPath;
        setResumePrompt({ cwd: dirPath, sessionId: savedSessionId });
        return;
      }
    }
    openTerminalTab(dirPath);
  }, [openTerminalTab]);

  const handleOpenShell = useCallback((dirPath) => {
    openTerminalTab(dirPath, { shell: true });
  }, [openTerminalTab]);

  const handleSessionClick = useCallback((session) => {
    // Check if a tab is already open for this session
    const existingTab = tabs.find((t) => t.sessionId === session.id);
    if (existingTab) {
      setActiveTabId(existingTab.id);
      return;
    }
    openTerminalTab(session.cwd, { shell: !!session.shell, sessionId: session.id, attachSessionId: session.id });
  }, [tabs, openTerminalTab]);

  const handleResume = useCallback(() => {
    if (resumePrompt) {
      openTerminalTab(resumePrompt.cwd, { claudeSessionId: resumePrompt.sessionId });
      setResumePrompt(null);
      pendingOpenRef.current = null;
    }
  }, [resumePrompt, openTerminalTab]);

  const handleNewSession = useCallback(() => {
    if (resumePrompt) {
      localStorage.removeItem(`ccserver-claude-resume:${resumePrompt.cwd}`);
      openTerminalTab(resumePrompt.cwd);
      setResumePrompt(null);
      pendingOpenRef.current = null;
    }
  }, [resumePrompt, openTerminalTab]);

  const handleCloseTab = useCallback((tabId) => {
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

  const handleTabClick = useCallback((tabId) => {
    setActiveTabId(tabId);
  }, []);

  const handleTabSessionId = useCallback((tabId, sessionId) => {
    setTabs((prev) => prev.map((t) =>
      t.id === tabId ? { ...t, sessionId } : t
    ));
  }, []);

  return (
    <div className="app">
      <div className="tab-bar">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab-item${tab.id === activeTabId ? ' active' : ''}`}
            onClick={() => handleTabClick(tab.id)}
          >
            <span className="tab-label">
              {tab.type === 'browser' ? '\u{1F4C1} ' : tab.type === 'monitor' ? '\u{1F4CA} ' : ''}{tab.label}
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
        <div className="theme-picker" ref={themeMenuRef}>
          <button
            className="btn theme-btn"
            onClick={() => setThemeMenuOpen((v) => !v)}
            title="Theme"
          >
            &#x1F3A8;
          </button>
          {themeMenuOpen && (
            <div className="theme-menu">
              {themeIds.map((id) => (
                <div
                  key={id}
                  className={`theme-menu-item${id === themeId ? ' active' : ''}`}
                  onClick={() => {
                    setThemeId(id);
                    setThemeMenuOpen(false);
                  }}
                >
                  {getTheme(id).name}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="tab-content">
        <div style={{ display: activeTabId === 'browser' ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}>
          <DirectoryBrowser onOpen={handleOpen} onOpenShell={handleOpenShell} onSessionClick={handleSessionClick} initialPath={lastDir} />
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
              <TerminalView
                cwd={tab.cwd}
                onClose={() => handleCloseTab(tab.id)}
                claudeSessionId={tab.claudeSessionId}
                shell={tab.shell}
                notify={notify}
                notifyEnabled={notifyEnabled}
                notifyPermission={notifyPermission}
                onToggleNotify={toggleNotify}
                visible={activeTabId === tab.id}
                onSessionId={(sid) => handleTabSessionId(tab.id, sid)}
                attachSessionId={tab.attachSessionId}
                xtermTheme={getTheme(themeId).xterm}
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
    </div>
  );
}
