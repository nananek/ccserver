import { useState, useRef, useEffect, useCallback } from 'react';
import { authFetch } from '../auth.js';
import { isAppVisible } from '../appAvailability.js';

function pctClass(pct) {
  if (pct >= 80) return 'usage-bar-fill high';
  if (pct >= 50) return 'usage-bar-fill mid';
  return 'usage-bar-fill low';
}

// Where an "even" pace would put you right now: the fraction of the current
// session/week window that has already elapsed, as a 0–100 position on the bar.
function paceMark(l, now) {
  if (!l.resetAt || !l.windowMs) return null;
  const frac = 1 - (l.resetAt - now) / l.windowMs;
  return Math.max(0, Math.min(100, frac * 100));
}

function fmtAge(updatedAt) {
  if (!updatedAt) return '';
  const s = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  if (s < 60) return `${s}秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}分前`;
  return `${Math.round(m / 60)}時間前`;
}

// Last app the user picked in the popover, remembered per browser so opening
// or focusing an OpenCode (or any) terminal no longer resets the view back to
// claude. Same per-browser convention as DirectoryBrowser's keys.
const USAGE_APP_KEY = 'ccserver-usage-app';

const USAGE_APPS = ['claude', 'codex', 'opencode'];

// A /api/usage capture holds one HTTP connection open for up to 30s
// (server/usage.js CAPTURE_TIMEOUT_MS), which is long enough for a tunnelled
// or roaming path (Tailscale switching DERP relays, a phone moving between
// WiFi and cellular) to drop it -- surfacing as a bare "NetworkError when
// attempting to fetch resource." from fetch() itself. The server's capture is
// independent of our request: it completes anyway and writes the result to a
// 60s cache (server/usage.js getUsage), so one short retry almost always
// lands on that warm cache instead of starting another 30s capture.
const RETRY_DELAY_MS = 3000;

const USAGE_APP_LABELS = {
  claude: 'Claude 使用量',
  codex: 'Codex 使用量',
  opencode: 'OpenCode Go 使用量',
};

const USAGE_TAB_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
};

function loadSavedUsageApp() {
  try {
    const v = window.localStorage.getItem(USAGE_APP_KEY);
    return USAGE_APPS.includes(v) ? v : null;
  } catch {
    return null;
  }
}

function saveUsageApp(app) {
  try {
    window.localStorage.setItem(USAGE_APP_KEY, app);
  } catch {
    // Storage unavailable (private mode etc.) -- selection just won't persist.
  }
}

export default function UsageButton({ hidden = false, defaultApp = 'claude', availableApps = null, hiddenApps = [] }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);   // { usage, updatedAt, error, ... }
  const [loading, setLoading] = useState(false);
  const [, setTick] = useState(0);   // re-render so pace/age stay live while open
  // Selectable = installed (availableApps !== false; opencode Go = toggle on
  // + Go key present) AND not hidden via sandbox.config.json's hiddenApps
  // (issue #105). isAppVisible is shared with App.jsx's button visibility
  // (see appAvailability.js) so the two definitions can't drift.
  const isSelectable = useCallback(
    (app) => isAppVisible(app, availableApps, hiddenApps),
    [availableApps, hiddenApps]
  );
  // Which app the popover is currently showing. The persisted choice wins:
  // defaultApp (the active terminal tab's app) only seeds the very first view
  // when nothing valid has been saved yet. Availability is still respected --
  // a saved app that isn't installed or is hidden falls back below.
  const [tab, setTab] = useState(() => {
    const saved = loadSavedUsageApp();
    if (saved && isSelectable(saved)) return saved;
    if (USAGE_APPS.includes(defaultApp) && isSelectable(defaultApp)) return defaultApp;
    return 'claude';
  });
  const wrapRef = useRef(null);
  const retryTimerRef = useRef(null);
  // Ticket handed to each load(); only the newest one may touch state.
  const loadSeqRef = useRef(0);

  const visibleApps = USAGE_APPS.filter((a) => isSelectable(a));

  // Tracks the tab actually showing right now, read inside load()'s async
  // continuations below -- a plain closure over `tab` would freeze the value
  // from when load() was created, which is exactly the stale value a race
  // needs to detect.
  const tabRef = useRef(tab);
  useEffect(() => { tabRef.current = tab; }, [tab]);

  // A slow response for a tab the user has since switched away from must not
  // clobber whatever the now-current tab already displays -- opencode's
  // external HTTPS round trip makes this race easy to hit in practice (an
  // in-flight opencode fetch outlasting a quick switch to codex).
  const load = useCallback(async (force = false, attempt = 0) => {
    const forTab = tab;
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
      const res = await authFetch(`/api/usage?app=${forTab}${force ? '&force=1' : ''}`);
      const json = await res.json();
      if (superseded()) return;
      setData(json);
      setLoading(false);
    } catch (err) {
      // Only transport-level failures reach here: an application-level one
      // (capture timeout, CLI hidden, ...) comes back as HTTP 200 with an
      // `error` field, so everything caught here is worth one retry.
      if (superseded()) return;
      if (attempt === 0) {
        // Stay in the loading state across the backoff so the popover keeps
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
  }, [tab]);

  // Do NOT follow defaultApp here anymore: switching to (or focusing) a
  // terminal running another app used to reset the view and discard the
  // user's pick. defaultApp is only the first-run seed above.
  //
  // Instead, reconcile against availability: when it becomes known (it starts
  // as null while /api/dirs/home is in flight) or changes later, prefer the
  // persisted choice if that app is still usable, and otherwise move to the
  // other installed app -- persisting the fallback so it doesn't flap back.
  useEffect(() => {
    if (!availableApps) return;
    const saved = loadSavedUsageApp();
    setTab((cur) => {
      if (saved && saved !== cur && isSelectable(saved)) return saved;
      if (isSelectable(cur)) return cur;
      const fallback = USAGE_APPS.find((a) => a !== cur && isSelectable(a));
      if (fallback) {
        saveUsageApp(fallback);
        return fallback;
      }
      return cur;
    });
  }, [availableApps, hiddenApps, isSelectable]);

  // Prime the button (session % badge) once on mount, using the cache, and
  // again whenever the viewed app changes -- reset first so a tab switch
  // never flashes the other app's stale numbers under the new label.
  useEffect(() => { setData(null); load(false); }, [tab, load]);

  // Fetch fresh-ish data whenever the popover opens.
  useEffect(() => {
    if (open) load(false);
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, [open]);

  // A backoff outliving the component would retry (and setState) after unmount.
  useEffect(() => () => clearTimeout(retryTimerRef.current), []);

  const limits = data?.usage?.limits || [];
  // Claude's first limit is the session window; Codex/Go label their
  // windows differently (5時間/週次/月次), so fall back to the first row.
  const session = limits.find((l) => /session/i.test(l.label)) || limits[0];
  const now = Date.now();
  const appLabel = USAGE_APP_LABELS[tab] || USAGE_APP_LABELS.claude;

  // `hidden` is decided by the caller (showUsage pref / neither app installed).
  if (hidden) return null;

  return (
    <div className="usage-picker" ref={wrapRef}>
      <button
        className="btn usage-btn"
        onClick={() => setOpen((v) => !v)}
        title={appLabel}
      >
        <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 13h12M4 13V8M8 13V4M12 13V6" />
        </svg>
        <span className="usage-btn-label">Usage</span>
        {session && <span className={`usage-btn-pct${session.pct >= 80 ? ' high' : ''}`}>{session.pct}%</span>}
        <span className="usage-btn-app">({tab})</span>
      </button>
      {open && (
        <div className="usage-menu">
          <div className="usage-menu-header">
            <span>{appLabel}</span>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => load(true)}
              disabled={loading}
              title="最新の状態を取得"
            >
              {loading ? '取得中…' : '更新'}
            </button>
          </div>

          {visibleApps.length > 1 && (
            <div className="usage-tabs">
              {visibleApps.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={`usage-tab${tab === a ? ' active' : ''}`}
                  onClick={() => { saveUsageApp(a); setTab(a); }}
                >{USAGE_TAB_LABELS[a]}</button>
              ))}
            </div>
          )}

          {data?.usage?.plan && (
            <div className="usage-plan">{data.usage.plan}</div>
          )}

          {limits.length > 0 ? (
            <div className="usage-limits">
              {limits.map((l, i) => {
                const pace = paceMark(l, now);
                const over = pace != null && l.pct > pace + 1;
                return (
                  <div className="usage-limit" key={i}>
                    <div className="usage-limit-top">
                      <span className="usage-limit-label">{l.label}</span>
                      <span className="usage-limit-pct">{l.pct}%</span>
                    </div>
                    <div className="usage-bar-wrap">
                      <div className="usage-bar">
                        <div className={pctClass(l.pct)} style={{ width: `${Math.min(100, l.pct)}%` }} />
                      </div>
                      {pace != null && (
                        <div
                          className={`usage-pace${over ? ' over' : ''}`}
                          style={{ left: `${pace}%` }}
                          title={`妥当なペースの目安 ${Math.round(pace)}%（経過時間ぶん）${over ? ' · ペース超過' : ''}`}
                        />
                      )}
                    </div>
                    {(l.resets || pace != null) && (
                      <div className="usage-limit-reset">
                        {l.resets && `リセット: ${l.resets}`}
                        {pace != null && `${l.resets ? ' · ' : ''}目安 ${Math.round(pace)}%`}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="usage-empty">
              {loading ? '読み込み中…' : data?.transient ? (
                <div className="usage-error">
                  <div className="usage-error-title">サーバーに接続できませんでした</div>
                  <div className="usage-error-hint">
                    ネットワークが不安定な可能性があります (Tailscale 経由の場合は接続の切り替わり中など)。自動再試行も失敗しました。
                  </div>
                  {/* The raw message is what let the original report pin this on
                      the transport layer, so it stays -- behind a tap rather
                      than a hover, since the phone on the flaky tunnel is
                      exactly the device that has no hover. */}
                  <details className="usage-error-detail">
                    <summary>詳細</summary>
                    <div className="usage-error-raw">{data.error}</div>
                  </details>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => load(false)}
                    title="キャッシュを使って接続し直す"
                  >再試行</button>
                </div>
              ) : data?.error ? `取得できませんでした: ${data.error}` : 'データがありません'}
            </div>
          )}

          {data?.usage?.cost && data.usage.cost !== '$0.0000' && (
            <div className="usage-cost">セッション費用: {data.usage.cost}</div>
          )}

          <div className="usage-footer">
            {data?.updatedAt ? `更新 ${fmtAge(data.updatedAt)}` : ''}
            {data?.sandboxed ? ' · 🔒 サンドボックス' : ''}
          </div>
        </div>
      )}
    </div>
  );
}
