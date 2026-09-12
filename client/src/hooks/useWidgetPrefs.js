import { useState, useCallback, useEffect } from 'react';
import { NARROW_DRAWER_QUERY } from './viewportQuery.js';

const SIDEBAR_OPEN_KEY = 'ccserver-sidebar-open';
const SIDEBAR_OVERLAY_KEY = 'ccserver-sidebar-overlay';
const ORDER_KEY = 'ccserver-widget-order';
const VIS_KEY_PREFIX = 'ccserver-widget:';
const VIS_SUFFIX = ':visible';

function loadOpen() {
  try {
    const stored = localStorage.getItem(SIDEBAR_OPEN_KEY);
    // 保存済み設定はviewportに関わらず尊重する。
    if (stored !== null) return stored !== '0';
    // 初回のみ狭幅 (NARROW_DRAWER_QUERY = app.css のドロワー化境界) では
    // 閉じておく。開いたままだと画面の約85%を覆い、背後の操作を塞ぐ。
    if (typeof window !== 'undefined' && window.matchMedia?.(NARROW_DRAWER_QUERY).matches) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function migrateLegacyMemoryStorage(defaultIds) {
  // 'memory-storage' -> 'memory' + 'storage' 分離の移行。
  // 旧 order 上の位置を維持したまま置換し、旧 visibility を両方へ継承する。
  try {
    if (!defaultIds.includes('memory') || !defaultIds.includes('storage')) return;
    const legacyKey = `${VIS_KEY_PREFIX}memory-storage${VIS_SUFFIX}`;
    const raw = localStorage.getItem(ORDER_KEY);
    if (raw && raw.includes('memory-storage')) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.includes('memory-storage')) {
          const next = [];
          for (const id of parsed) {
            if (id === 'memory-storage') {
              if (!next.includes('memory')) next.push('memory');
              if (!next.includes('storage')) next.push('storage');
            } else if (!next.includes(id)) {
              next.push(id);
            }
          }
          localStorage.setItem(ORDER_KEY, JSON.stringify(next));
        }
      } catch {
        // ignore (loadOrder がデフォルトにフォールバックする)
      }
    }
    const legacyVis = localStorage.getItem(legacyKey);
    if (legacyVis !== null) {
      for (const id of ['memory', 'storage']) {
        const cur = localStorage.getItem(`${VIS_KEY_PREFIX}${id}${VIS_SUFFIX}`);
        if (cur === null) {
          try {
            localStorage.setItem(`${VIS_KEY_PREFIX}${id}${VIS_SUFFIX}`, legacyVis);
          } catch {
            // ignore
          }
        }
      }
      try {
        localStorage.removeItem(legacyKey);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore (private mode etc.)
  }
}

function loadOrder(defaultIds) {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return defaultIds;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultIds;
    const known = new Set(defaultIds);
    const seen = new Set();
    const ordered = parsed.filter(
      (id) => known.has(id) && !seen.has(id) && (seen.add(id), true)
    );
    for (const id of defaultIds) {
      if (!ordered.includes(id)) ordered.push(id);
    }
    return ordered;
  } catch {
    return defaultIds;
  }
}

function loadVisibility(id, defaultVisible) {
  try {
    const v = localStorage.getItem(`${VIS_KEY_PREFIX}${id}${VIS_SUFFIX}`);
    if (v === null) return defaultVisible;
    return v === '1';
  } catch {
    return defaultVisible;
  }
}

// ウィジェット別オプションは可視状態と同じ名前空間だが、`:opt:` を挿んで分ける
// (ccserver-widget:<id>:opt:<key>)。挿まないと key が 'visible' のとき
// 可視状態のキー (ccserver-widget:<id>:visible) と衝突して壊す。
// 値は列挙型のみを想定し、未知の値 (古いビルドの保存値・手書き) は既定へ倒す。
const OPT_INFIX = ':opt:';

function optionKey(id, key) {
  return `${VIS_KEY_PREFIX}${id}${OPT_INFIX}${key}`;
}

function loadWidgetOption(id, key, choices, fallback) {
  try {
    const v = localStorage.getItem(optionKey(id, key));
    return choices.some((c) => c.value === v) ? v : fallback;
  } catch {
    return fallback;
  }
}

// widgetDefs の options 定義から `<id>:<key>` をキーにした一枚のマップを作る。
function loadWidgetOptions(widgetDefs) {
  const map = {};
  for (const w of widgetDefs) {
    for (const [key, def] of Object.entries(w.options ?? {})) {
      map[`${w.id}:${key}`] = loadWidgetOption(w.id, key, def.choices, def.default);
    }
  }
  return map;
}

export function useWidgetPrefs(widgetDefs) {
  const defaultIds = widgetDefs.map((w) => w.id);
  const [open, setOpenState] = useState(loadOpen);
  // デスクトップ幅でもサイドバーを in-flow ではなく前面オーバーレイで
  // 表示する (CLI領域をリサイズしない)。狭幅 (<=900px) は従来通り常時
  // オーバーレイのため、この設定は広幅時のみ効く。
  const [overlay, setOverlayState] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_OVERLAY_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [order, setOrderState] = useState(() => {
    migrateLegacyMemoryStorage(defaultIds);
    return loadOrder(defaultIds);
  });
  const [options, setOptionsState] = useState(() => loadWidgetOptions(widgetDefs));
  const [hiddenIds, setHiddenIds] = useState(() => {
    const hidden = new Set();
    for (const w of widgetDefs) {
      if (!loadVisibility(w.id, w.defaultVisible !== false)) hidden.add(w.id);
    }
    return hidden;
  });

  const setOpen = useCallback((v) => {
    setOpenState(v);
    try {
      localStorage.setItem(SIDEBAR_OPEN_KEY, v ? '1' : '0');
    } catch {
      // ignore
    }
  }, []);

  const setOverlay = useCallback((v) => {
    setOverlayState(v);
    try {
      localStorage.setItem(SIDEBAR_OVERLAY_KEY, v ? '1' : '0');
    } catch {
      // ignore
    }
  }, []);

  const setWidgetVisible = useCallback((id, visible) => {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(id);
      else next.add(id);
      return next;
    });
    try {
      localStorage.setItem(`${VIS_KEY_PREFIX}${id}${VIS_SUFFIX}`, visible ? '1' : '0');
    } catch {
      // ignore
    }
  }, []);

  const setWidgetOption = useCallback((id, key, value) => {
    setOptionsState((prev) => ({ ...prev, [`${id}:${key}`]: value }));
    try {
      localStorage.setItem(optionKey(id, key), value);
    } catch {
      // ignore
    }
  }, []);

  const getWidgetOption = useCallback((id, key) => options[`${id}:${key}`], [options]);

  const moveWidget = useCallback((id, dir, isSkippable) => {
    if (dir !== 'up' && dir !== 'down') return;
    setOrderState((prev) => {
      const idx = prev.indexOf(id);
      if (idx < 0) return prev;
      const step = dir === 'up' ? -1 : 1;
      // 非表示ウィジェットを飛ばして可視同士を入れ替える。
      // 隣が非表示だけの場合も可視順序が1つ動くため、無反応に見えない。
      // 呼び出し側は「今回描画されていない可視ウィジェット」も飛ばせる。
      const skip = isSkippable || ((x) => hiddenIds.has(x));
      let j = idx + step;
      while (j >= 0 && j < prev.length && skip(prev[j])) j += step;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }, [hiddenIds]);

  // updaterはpureに保ち、永続化はここに一本化する (setOpen /
  // setWidgetVisible と同じ形。初回マウント時の書き込みは冪等)。
  useEffect(() => {
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(order));
    } catch {
      // ignore (private mode etc.)
    }
  }, [order]);

  const visibleWidgets = order
    .map((id) => widgetDefs.find((w) => w.id === id))
    .filter((w) => w && !hiddenIds.has(w.id));
  const hiddenWidgets = widgetDefs.filter((w) => hiddenIds.has(w.id));

  return { open, setOpen, overlay, setOverlay, order, visibleWidgets, hiddenWidgets, setWidgetVisible, moveWidget, getWidgetOption, setWidgetOption };
}
