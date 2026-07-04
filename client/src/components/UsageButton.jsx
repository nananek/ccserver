import { useState, useRef, useEffect, useCallback } from 'react';
import { authFetch } from '../auth.js';

function pctClass(pct) {
  if (pct >= 80) return 'usage-bar-fill high';
  if (pct >= 50) return 'usage-bar-fill mid';
  return 'usage-bar-fill low';
}

function fmtAge(updatedAt) {
  if (!updatedAt) return '';
  const s = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  if (s < 60) return `${s}秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}分前`;
  return `${Math.round(m / 60)}時間前`;
}

export default function UsageButton() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);   // { usage, updatedAt, error, ... }
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef(null);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const res = await authFetch(`/api/usage${force ? '?force=1' : ''}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      setData({ error: String(err?.message || err) });
    } finally {
      setLoading(false);
    }
  }, []);

  // Prime the button (session % badge) once on mount, using the cache.
  useEffect(() => { load(false); }, [load]);

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

  const limits = data?.usage?.limits || [];
  const session = limits.find((l) => /session/i.test(l.label)) || limits[0];

  return (
    <div className="usage-picker" ref={wrapRef}>
      <button
        className="btn usage-btn"
        onClick={() => setOpen((v) => !v)}
        title="Claude 使用量"
      >
        <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 13h12M4 13V8M8 13V4M12 13V6" />
        </svg>
        <span className="usage-btn-label">Usage</span>
        {session && <span className={`usage-btn-pct${session.pct >= 80 ? ' high' : ''}`}>{session.pct}%</span>}
      </button>
      {open && (
        <div className="usage-menu">
          <div className="usage-menu-header">
            <span>Claude 使用量</span>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => load(true)}
              disabled={loading}
              title="最新の状態を取得"
            >
              {loading ? '取得中…' : '更新'}
            </button>
          </div>

          {data?.usage?.plan && (
            <div className="usage-plan">{data.usage.plan}</div>
          )}

          {limits.length > 0 ? (
            <div className="usage-limits">
              {limits.map((l, i) => (
                <div className="usage-limit" key={i}>
                  <div className="usage-limit-top">
                    <span className="usage-limit-label">{l.label}</span>
                    <span className="usage-limit-pct">{l.pct}%</span>
                  </div>
                  <div className="usage-bar">
                    <div className={pctClass(l.pct)} style={{ width: `${Math.min(100, l.pct)}%` }} />
                  </div>
                  {l.resets && <div className="usage-limit-reset">リセット: {l.resets}</div>}
                </div>
              ))}
            </div>
          ) : (
            <div className="usage-empty">
              {loading ? '読み込み中…' : (data?.error ? `取得できませんでした: ${data.error}` : 'データがありません')}
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
