import { useState, useCallback } from 'react';
import { NARROW_DRAWER_QUERY } from './viewportQuery.js';
import { loadEnumPref } from './enumPref.js';

// 左セッション表示の設定 (右ウィジェットとは独立したフラグ群)。
// - mode: 'sidebar' (既定・常時表示の左サイドバー) | 'popup' (従来のポップアップ)
// - open: サイドバーモード時の開閉 (永続化。狭幅初回は閉じておく)
// - overlay: デスクトップ幅でもCLIをリサイズせず前面に重ねる (右とは別キー)
const MODE_KEY = 'ccserver-session-mode';
const OPEN_KEY = 'ccserver-session-sidebar-open';
const OVERLAY_KEY = 'ccserver-session-sidebar-overlay';

function loadMode() {
  // 許可値検証つき読み取りは enumPref に一本化 (useWidgetPrefs と共有)。
  return loadEnumPref(MODE_KEY, ['popup', 'sidebar'], 'sidebar');
}

function loadOpen() {
  try {
    const stored = localStorage.getItem(OPEN_KEY);
    if (stored !== null) return stored !== '0';
    // 初回のみ狭幅 (NARROW_DRAWER_QUERY = app.css のドロワー化境界) では
    // 閉じておく。開いたままだと画面の約85%を覆い、背後の操作を塞ぐ。
    // (useWidgetPrefs.js の右サイドバーと同一方針)
    if (typeof window !== 'undefined' && window.matchMedia?.(NARROW_DRAWER_QUERY).matches) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function loadOverlay() {
  try {
    return localStorage.getItem(OVERLAY_KEY) === '1';
  } catch {
    return false;
  }
}

export function useSessionSidebarPrefs() {
  const [mode, setModeState] = useState(loadMode);
  const [open, setOpenState] = useState(loadOpen);
  const [overlay, setOverlayState] = useState(loadOverlay);

  const setMode = useCallback((v) => {
    const next = v === 'popup' ? 'popup' : 'sidebar';
    setModeState(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  const setOpen = useCallback((v) => {
    setOpenState(v);
    try {
      localStorage.setItem(OPEN_KEY, v ? '1' : '0');
    } catch {
      // ignore
    }
  }, []);

  const setOverlay = useCallback((v) => {
    setOverlayState(v);
    try {
      localStorage.setItem(OVERLAY_KEY, v ? '1' : '0');
    } catch {
      // ignore
    }
  }, []);

  return { mode, setMode, open, setOpen, overlay, setOverlay };
}
