import { pctClass, paceMark } from './useUsage.js';

// UsageButton (popover) と UsageWidget (sidebar) で共有する limits/empty
// 表示。二重管理による乖離を避けるため、見た目の差異は作らないこと。
export default function UsageLimits({ limits, loading, data, onRetry, now = Date.now() }) {
  const error = data?.error;
  if (limits.length === 0) {
    return (
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
              <div className="usage-error-raw">{error}</div>
            </details>
            <button
              className="btn btn-secondary btn-sm"
              onClick={onRetry}
              title="キャッシュを使って接続し直す"
            >再試行</button>
          </div>
        ) : (error ? `取得できませんでした: ${error}` : 'データがありません')}
      </div>
    );
  }
  return (
    <div className="usage-limits">
      {limits.map((l, i) => {
        const pace = paceMark(l, now);
        const over = pace != null && l.pct > pace + 1;
        return (
          <div className="usage-limit" key={`${l.label}#${i}`}>
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
  );
}
