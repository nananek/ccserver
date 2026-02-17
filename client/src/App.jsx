import { useState, useCallback, useRef } from 'react';
import DirectoryBrowser from './components/DirectoryBrowser.jsx';
import TerminalView from './components/TerminalView.jsx';
import { useNotifications } from './hooks/useNotifications.js';

let tabIdCounter = 0;

export default function App() {
  const [tabs, setTabs] = useState([
    { id: 'browser', type: 'browser', label: 'Files' },
  ]);
  const [activeTabId, setActiveTabId] = useState('browser');
  const [lastDir, setLastDir] = useState(null);
  const [resumePrompt, setResumePrompt] = useState(null);
  const pendingOpenRef = useRef(null);
  const { enabled: notifyEnabled, permission: notifyPermission, toggle: toggleNotify, notify } = useNotifications();

  const openTerminalTab = useCallback((dirPath, { claudeSessionId = null, shell = false } = {}) => {
    const id = `terminal-${++tabIdCounter}`;
    const dirName = dirPath.split('/').filter(Boolean).pop() || '/';
    const label = shell ? `$ ${dirName}` : dirName;
    setTabs((prev) => [
      ...prev,
      { id, type: 'terminal', label, cwd: dirPath, claudeSessionId, shell },
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
              {tab.type === 'browser' ? '\u{1F4C1} ' : ''}{tab.label}
            </span>
            {tab.type !== 'browser' && (
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
      </div>
      <div className="tab-content">
        <div style={{ display: activeTabId === 'browser' ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}>
          <DirectoryBrowser onOpen={handleOpen} onOpenShell={handleOpenShell} initialPath={lastDir} />
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
