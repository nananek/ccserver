import { useState, useCallback } from 'react';
import DirectoryBrowser from './components/DirectoryBrowser.jsx';
import TerminalView from './components/TerminalView.jsx';

export default function App() {
  const [selectedDir, setSelectedDir] = useState(null);

  const handleOpen = useCallback((dirPath) => {
    setSelectedDir(dirPath);
  }, []);

  const handleBack = useCallback(() => {
    setSelectedDir(null);
  }, []);

  return (
    <div className="app">
      {selectedDir === null ? (
        <DirectoryBrowser onOpen={handleOpen} />
      ) : (
        <TerminalView cwd={selectedDir} onBack={handleBack} />
      )}
    </div>
  );
}
