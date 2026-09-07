import { useState, useEffect, useRef, useCallback } from 'react';
import { authFetch } from '../../auth.js';
import { useVisiblePolling } from '../../hooks/useVisiblePolling.js';

const DEFAULT_INTERVAL = 2000;
const MIN_INTERVAL = 1000;

// localStorage の不正値 (NaN・0・負数・1秒未満) を弾き、
// 常に [MIN_INTERVAL, ∞) の有限値に正規化する。
function normalizeInterval(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL;
  return Math.max(MIN_INTERVAL, Math.floor(n));
}

export function useSystemStats(active) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [interval, setIntervalMs] = useState(() => {
    try {
      const saved = localStorage.getItem('monitor-interval');
      return saved ? normalizeInterval(saved) : DEFAULT_INTERVAL;
    } catch {
      return DEFAULT_INTERVAL;
    }
  });
  const [showIpmi, setShowIpmi] = useState(() => {
    try {
      const saved = localStorage.getItem('monitor-show-ipmi');
      return saved !== null ? saved === 'true' : true;
    } catch {
      return true;
    }
  });
  const showIpmiRef = useRef(showIpmi);
  useEffect(() => { showIpmiRef.current = showIpmi; }, [showIpmi]);
  // 応答が周期を超えた際の多重発行・逆転を防ぐ (遅延時は1周期分古くなる)。
  const inflightRef = useRef(false);

  const fetchStats = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const params = showIpmiRef.current ? '?ipmi=1' : '';
      const res = await authFetch(`/api/system-stats${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      inflightRef.current = false;
    }
  }, []);

  useVisiblePolling(fetchStats, interval, active);

  const setIntervalAndSave = useCallback((v) => {
    const normalized = normalizeInterval(v);
    setIntervalMs(normalized);
    try {
      localStorage.setItem('monitor-interval', String(normalized));
    } catch {
      // ignore (private mode etc.)
    }
  }, []);

  const setShowIpmiAndSave = useCallback((v) => {
    setShowIpmi(v);
    try {
      localStorage.setItem('monitor-show-ipmi', String(v));
    } catch {
      // ignore (private mode etc.)
    }
  }, []);

  return { data, error, interval, setInterval: setIntervalAndSave, showIpmi, setShowIpmi: setShowIpmiAndSave, refresh: fetchStats };
}
