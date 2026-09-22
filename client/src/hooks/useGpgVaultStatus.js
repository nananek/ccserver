import { useState, useEffect, useCallback, useRef } from 'react';
import { authFetch, resolveAuthMode } from '../auth.js';
import { useVisiblePolling } from './useVisiblePolling.js';

// Same "fetch/poll hook, consumed via a Context Provider" shape as
// widgets/useSystemStats.js -- shared by GpgVaultQuickUnlockButton.jsx (top
// bar), TerminalView.jsx and SessionList.jsx (per-session badges) via
// GpgVaultStatusProvider.jsx, so all three see the same polled status
// without each opening its own interval.
const POLL_MS = 8000;

export function useGpgVaultStatus() {
  const [mode, setMode] = useState(null); // null = not yet resolved
  const [data, setData] = useState(null); // { exists, unlocked, fingerprint, keyId, credentialCount, toolsAvailable }
  const [error, setError] = useState(null);
  const inflightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    resolveAuthMode().then((m) => {
      if (!cancelled) setMode(m);
    });
    return () => { cancelled = true; };
  }, []);

  const refresh = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const res = await authFetch('/api/gpg-vault/status');
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      setData(await res.json());
      setError(null);
    } catch (err) {
      setError(err.message || '読み込みに失敗しました');
    } finally {
      inflightRef.current = false;
    }
  }, []);

  // GPG Vaultはpasskeyログイン限定機能 -- 他モードでは常にfalse/nullのまま
  // ポーリングもしない(GpgVaultSection.jsx既存の`mode !== 'passkey'`ガードと
  // 同じ判断)。
  useVisiblePolling(refresh, POLL_MS, mode === 'passkey');

  return { data, error, mode, refresh };
}
