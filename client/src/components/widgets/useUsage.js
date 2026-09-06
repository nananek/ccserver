import { useState, useEffect, useCallback, useRef } from 'react';
import { authFetch } from '../../auth.js';
import { isAppVisible } from '../../appAvailability.js';

export function pctClass(pct) {
  if (pct >= 80) return 'usage-bar-fill high';
  if (pct >= 50) return 'usage-bar-fill mid';
  return 'usage-bar-fill low';
}

export function paceMark(l, now) {
  if (!l.resetAt || !l.windowMs) return null;
  const frac = 1 - (l.resetAt - now) / l.windowMs;
  return Math.max(0, Math.min(100, frac * 100));
}

export function fmtAge(updatedAt) {
  if (!updatedAt) return '';
  const s = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  if (s < 60) return `${s}秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}分前`;
  return `${Math.round(m / 60)}時間前`;
}

const USAGE_APP_KEY = 'ccserver-usage-app';

// Apps with a Usage tab. opencode Go needs no binary (Go subscription only),
// so visibility follows isAppVisible's Go rule (toggle + key), not install
// detection. Shared by UsageButton and UsageWidget so the tab sets agree.
export const USAGE_APPS = ['claude', 'codex', 'opencode'];

export const USAGE_APP_LABELS = {
  claude: 'Claude 使用量',
  codex: 'Codex 使用量',
  opencode: 'OpenCode Go 使用量',
};

export const USAGE_TAB_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
};

export function loadSavedUsageApp(validApps = USAGE_APPS) {
  try {
    const v = window.localStorage.getItem(USAGE_APP_KEY);
    return validApps.includes(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveUsageApp(app) {
  try {
    window.localStorage.setItem(USAGE_APP_KEY, app);
  } catch {
    // Storage unavailable (private mode etc.) -- selection just won't persist.
  }
  // 同一ドキュメント内の他インスタンス (UsageButton/UsageWidget) へ通知。
  // storage イベントは同一ドキュメントに届かないため CustomEvent を使う。
  window.dispatchEvent(new CustomEvent(USAGE_APP_KEY, { detail: app }));
}

export function useUsageTab({ defaultApp = 'claude', availableApps = null, hiddenApps = [], apps = USAGE_APPS } = {}) {
  // isAppVisible covers opencode Go's toggle+key rule on top of
  // isAppSelectable's claude/codex rule (see appAvailability.js), so the
  // Usage tabs and App.jsx's button visibility can't drift.
  const isSelectable = useCallback(
    (app) => isAppVisible(app, availableApps, hiddenApps),
    [availableApps, hiddenApps]
  );
  const [tab, setTabState] = useState(() => {
    const saved = loadSavedUsageApp(apps);
    if (saved && isAppVisible(saved, availableApps, hiddenApps)) return saved;
    if (apps.includes(defaultApp) && isAppVisible(defaultApp, availableApps, hiddenApps)) return defaultApp;
    return apps.find((a) => isAppVisible(a, availableApps, hiddenApps)) ?? apps[0];
  });

  useEffect(() => {
    if (!availableApps) return;
    const saved = loadSavedUsageApp(apps);
    setTabState((cur) => {
      if (saved && saved !== cur && isAppVisible(saved, availableApps, hiddenApps)) return saved;
      if (isAppVisible(cur, availableApps, hiddenApps)) return cur;
      const fallback = apps.find((a) => a !== cur && isAppVisible(a, availableApps, hiddenApps));
      if (fallback) {
        saveUsageApp(fallback);
        return fallback;
      }
      return cur;
    });
  }, [availableApps, hiddenApps, apps]);

  const setTab = useCallback((app) => {
    saveUsageApp(app);
    setTabState(app);
  }, []);

  // 他インスタンスでのタブ切替を反映する (同一ドキュメント内)。
  // 発信元自身も受信するが同値 set のため React が bailout する。
  useEffect(() => {
    const onChange = (e) => {
      const app = e?.detail;
      if (typeof app !== 'string' || !apps.includes(app)) return;
      setTabState((cur) => {
        if (app === cur) return cur;
        if (!isAppVisible(app, availableApps, hiddenApps)) return cur;
        return app;
      });
    };
    window.addEventListener(USAGE_APP_KEY, onChange);
    return () => window.removeEventListener(USAGE_APP_KEY, onChange);
  }, [apps, availableApps, hiddenApps]);

  const visibleApps = apps.filter((a) => isSelectable(a));

  return { tab, setTab, isSelectable, visibleApps };
}

// A /api/usage capture holds one HTTP connection open for up to 30s
// (server/usage.js CAPTURE_TIMEOUT_MS), which is long enough for a tunnelled
// or roaming path (Tailscale switching DERP relays, a phone moving between
// WiFi and cellular) to drop it -- surfacing as a bare "NetworkError when
// attempting to fetch resource." from fetch() itself. The server's capture is
// independent of our request: it completes anyway and writes the result to a
// 60s cache (server/usage.js getUsage), so one short retry almost always
// lands on that warm cache instead of starting another 30s capture.
export const RETRY_DELAY_MS = 3000;

// 同一appへの同時リクエストを一本化するためのin-flight共有マップ
// (app -> Promise)。UsageButtonとUsageWidgetのマウント時など、
// 同タイミングの同一クエリが2本飛ぶのを防ぐ。settledら除去し、
// 結果のキャッシュはしない (stalenessを持ち込まない)。
const inflightUsage = new Map();

export function useUsageData(tab, { enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const tabRef = useRef(tab);
  const retryTimerRef = useRef(null);
  // Ticket handed to each load(); only the newest one may touch state.
  const loadSeqRef = useRef(0);

  useEffect(() => { tabRef.current = tab; });

  // A slow response for a tab the user has since switched away from must not
  // clobber whatever the now-current tab already displays -- opencode's
  // external HTTPS round trip makes this race easy to hit in practice (an
  // in-flight opencode fetch outlasting a quick switch to codex).
  const load = useCallback(async (force = false, attempt = 0) => {
    const forTab = tabRef.current;
    const seq = ++loadSeqRef.current;
    // This call is no longer the one being awaited once the user has moved to
    // another tab, or once a newer load() for the same tab has taken over --
    // a popover open or 更新 while this one is still hanging. Either way it
    // must not write state: a slow failure landing after the load that
    // replaced it succeeded would otherwise schedule a retry over good data.
    const superseded = () => forTab !== tabRef.current || seq !== loadSeqRef.current;
    // Any newer call (tab switch, popover open, 更新/再試行) takes over a
    // pending backoff, so a timer-driven retry never races a user-driven one.
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    setLoading(true);
    try {
      let pending = !force ? inflightUsage.get(forTab) : null;
      if (!pending) {
        pending = (async () => {
          const res = await authFetch(`/api/usage?app=${forTab}${force ? '&force=1' : ''}`);
          // HTTPエラーは再試行しない (通常エラーとして表示)。バックオフの
          // 対象はfetch自体のreject (切断) のみ -- #112 の方針通り。
          if (!res.ok) return { usage: null, error: `HTTP ${res.status}`, updatedAt: Date.now() };
          return res.json();
        })();
        // force時は共有マップを汚さない (明示更新は常に新規取得)。
        if (!force) inflightUsage.set(forTab, pending);
        try {
          await pending;
        } finally {
          if (inflightUsage.get(forTab) === pending) inflightUsage.delete(forTab);
        }
      }
      const json = await pending;
      if (superseded()) return;
      setData(json);
      setLoading(false);
    } catch (err) {
      // Only transport-level failures reach here: an application-level one
      // (capture timeout, CLI hidden, ...) comes back as HTTP 200 with an
      // `error` field, so everything caught here is worth one retry.
      if (superseded()) return;
      if (attempt === 0) {
        // Stay in the loading state across the backoff so the UI keeps
        // saying 取得中… instead of flashing an error we are about to retry.
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          if (superseded()) return;
          // Always without force: the point is to pick up the result the
          // server finished for us, not to start a second 30s capture.
          load(false, 1);
        }, RETRY_DELAY_MS);
        return;
      }
      setData({ error: String(err?.message || err), transient: true });
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setData(null);
    load(false);
  }, [tab, load, enabled]);

  // A backoff outliving the component would retry (and setState) after unmount.
  useEffect(() => () => clearTimeout(retryTimerRef.current), []);

  return { data, loading, load };
}
