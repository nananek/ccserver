import { useState, useCallback } from 'react';
import DirectoryBrowser from './components/DirectoryBrowser.jsx';
import TerminalView from './components/TerminalView.jsx';
import { useNotifications } from './hooks/useNotifications.js';

export default function App() {
  const [selectedDir, setSelectedDir] = useState(null);
  const [lastDir, setLastDir] = useState(null);
  const [resumePrompt, setResumePrompt] = useState(null);
  const [claudeSessionId, setClaudeSessionId] = useState(null);
  const { enabled: notifyEnabled, permission: notifyPermission, toggle: toggleNotify, notify } = useNotifications();

  const handleOpen = useCallback((dirPath, skipResumePrompt = false) => {
    if (!skipResumePrompt) {
      const savedSessionId = localStorage.getItem(`ccserver-claude-resume:${dirPath}`);
      if (savedSessionId) {
        setResumePrompt({ cwd: dirPath, sessionId: savedSessionId });
        return;
      }
    }
    setSelectedDir(dirPath);
    setLastDir(dirPath);
    setClaudeSessionId(null);
  }, []);

  const handleResume = useCallback(() => {
    if (resumePrompt) {
      setClaudeSessionId(resumePrompt.sessionId);
      setSelectedDir(resumePrompt.cwd);
      setLastDir(resumePrompt.cwd);
      setResumePrompt(null);
    }
  }, [resumePrompt]);

  const handleNewSession = useCallback(() => {
    if (resumePrompt) {
      localStorage.removeItem(`ccserver-claude-resume:${resumePrompt.cwd}`);
      setClaudeSessionId(null);
      setSelectedDir(resumePrompt.cwd);
      setLastDir(resumePrompt.cwd);
      setResumePrompt(null);
    }
  }, [resumePrompt]);

  const handleBack = useCallback(() => {
    setSelectedDir(null);
    setClaudeSessionId(null);
  }, []);

  return (
    <div className="app">
      {selectedDir === null ? (
        <DirectoryBrowser onOpen={handleOpen} initialPath={lastDir} />
      ) : (
        <TerminalView
          cwd={selectedDir}
          onBack={handleBack}
          claudeSessionId={claudeSessionId}
          notify={notify}
          notifyEnabled={notifyEnabled}
          notifyPermission={notifyPermission}
          onToggleNotify={toggleNotify}
        />
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
    </div>
  );
}
