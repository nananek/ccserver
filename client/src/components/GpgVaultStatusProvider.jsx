import { createContext, useContext, useMemo } from 'react';
import { useGpgVaultStatus } from '../hooks/useGpgVaultStatus.js';

// Same shape as widgets/SystemStatsProvider.jsx. Mounted once near the
// App.jsx root (not scoped to Settings) so the top bar's quick-unlock button
// and every open session tab's badge share one poller instead of each
// opening its own.
const GpgVaultStatusContext = createContext(null);

export function GpgVaultStatusProvider({ children }) {
  const status = useGpgVaultStatus();
  const value = useMemo(() => status, [status.data, status.error, status.mode]);
  return (
    <GpgVaultStatusContext.Provider value={value}>
      {children}
    </GpgVaultStatusContext.Provider>
  );
}

export function useGpgVaultStatusContext() {
  return useContext(GpgVaultStatusContext);
}
