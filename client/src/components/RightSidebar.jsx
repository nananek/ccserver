import { useState, useRef, useEffect } from 'react';
import { useWidgetPrefs } from '../hooks/useWidgetPrefs.js';
import { useSystemStatsContext } from './widgets/SystemStatsProvider.jsx';
import { CpuCard, MemoryCard, StorageCard, TempCard, GpuCard, IpmiCards, SystemCard, hasCpuUsage, hasGpuMetrics, hasSystemMetrics, hasMemory, hasStorage, hasTemperatures, hasIpmiData } from './widgets/MonitorCards.jsx';
import UsageWidget from './widgets/UsageWidget.jsx';

const WIDGET_DEFS = [
  { id: 'usage', title: 'Usage', defaultVisible: true },
  { id: 'system', title: 'System', defaultVisible: true },
  { id: 'cpu', title: 'CPU', defaultVisible: true },
  { id: 'memory', title: 'Memory', defaultVisible: true },
  { id: 'storage', title: 'Storage', defaultVisible: true },
  { id: 'temps', title: 'Temperatures', defaultVisible: false },
  { id: 'gpu', title: 'GPU', defaultVisible: true },
  { id: 'ipmi', title: 'IPMI', defaultVisible: false },
];

const INTERVAL_OPTIONS = [
  { value: 1000, label: '1秒' },
  { value: 2000, label: '2秒' },
  { value: 5000, label: '5秒' },
  { value: 10000, label: '10秒' },
];

function WidgetShell({ title, onHide, onMoveUp, onMoveDown, canMoveUp = true, canMoveDown = true, children }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="widget-card">
      <header className="widget-card-header">
        <button
          type="button"
          className="widget-card-title"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? '展開' : '折りたたみ'}
          aria-expanded={!collapsed}
        >
          <span className="widget-collapse-mark">{collapsed ? '▸' : '▾'}</span>
          {title}
        </button>
        <span className="widget-card-actions">
          <button type="button" className="widget-icon-btn" onClick={onMoveUp} title="上へ" aria-label={`${title}を上へ移動`} disabled={!canMoveUp}>↑</button>
          <button type="button" className="widget-icon-btn" onClick={onMoveDown} title="下へ" aria-label={`${title}を下へ移動`} disabled={!canMoveDown}>↓</button>
          <button type="button" className="widget-icon-btn" onClick={onHide} title="非表示" aria-label={`${title}を非表示`}>✕</button>
        </span>
      </header>
      {!collapsed && <div className="widget-card-body">{children}</div>}
    </section>
  );
}

function RightSidebarInner({ usageProps = {}, prefs }) {
  const { open, visibleWidgets, hiddenWidgets, setWidgetVisible, moveWidget, overlay, setOverlay } = prefs;
  const [addOpen, setAddOpen] = useState(false);
  const [intervalOpen, setIntervalOpen] = useState(false);
  const addWrapRef = useRef(null);
  const intervalWrapRef = useRef(null);
  const stats = useSystemStatsContext();

  useEffect(() => {
    if (!addOpen && !intervalOpen) return;
    const onClick = (e) => {
      if (addWrapRef.current && addWrapRef.current.contains(e.target)) return;
      if (intervalWrapRef.current && intervalWrapRef.current.contains(e.target)) return;
      setAddOpen(false);
      setIntervalOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setAddOpen(false);
        setIntervalOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [addOpen, intervalOpen]);

  if (!open) return null;

  // Usage機能が無効な環境では Usage を表示対象から除外する
  // (枠だけの「データがありません」を出さない。＋メニューにも出ない)。
  // ただし CLI未インストール (emptyReason 'no-cli') は枠を残して親切
  // メッセージを出すため除外しない。通常ウィジェット同様に隠す/移動/
  // 追加の対象になる。showUsage:false や hiddenApps起因の不可視は
  // hidden=true のまま完全除外される (App.jsx)。
  const usageFullyHidden = !!usageProps?.hidden;
  const shownWidgets = usageFullyHidden
    ? visibleWidgets.filter((w) => w.id !== 'usage')
    : visibleWidgets;
  const addableWidgets = usageFullyHidden
    ? hiddenWidgets.filter((w) => w.id !== 'usage')
    : hiddenWidgets;

  const renderWidgetBody = (id) => {
    if (id === 'usage') {
      if (usageProps?.emptyReason === 'no-cli') {
        return (
          <div className="usage-empty">
            <div>CLIがインストールされていません</div>
            <div className="usage-error-hint">
              Claude / Codex CLIをインストールするか、OpenCode Goキーを設定すると使用量を表示できます
            </div>
          </div>
        );
      }
      return <UsageWidget {...usageProps} />;
    }
    const data = stats?.data;
    const showIpmi = stats?.showIpmi;
    // data 未取得時の扱い:
    // - ローディング中 (!error) は枠を作らず、上部の単一ローディング表示に任せる。
    // - 取得失敗時 (error) は可視モニターウィジェットごとに枠を作り、
    //   枠内にエラーを出す。単一バナーに集約すると枠が0件になり
    //   隠す/移動/追加の操作対象が消えるため。
    if (!data) {
      // ipmi は showIpmi=false (無効/未対応) なら成功パス(下の switch)と同じく
      // 常に非表示。ここで漏らすと、取得成功時とエラー時で挙動が非対称になる。
      if (stats?.error && id === 'ipmi' && !showIpmi) return null;
      if (stats?.error && MONITOR_WIDGET_IDS.includes(id)) {
        return <div className="error">Failed to load system stats: {stats.error}</div>;
      }
      return null;
    }
    // data 取得済みなら可視ウィジェットは必ず枠 (WidgetShell) を出す。
    // データ欠落時は中身を空 (<></>) にして枠だけ残す。null を返すと
    // 下流の `.filter(body !== null)` で枠ごと消え、＋メニューにも戻らず
    // 隠す/移動の操作対象が消えるため (IPMI非対応時の不具合)。
    // バックエンドが部分200 + errors を返した項目は、欠測として隠すのではなく
    // 枠内に項目別エラーを出す (HTTP 500時の !data 分岐と対になる処理)。
    const sectionError = (section) => data?.errors?.[section] ?? null;
    const sectionErrorBody = (section) => {
      const msg = sectionError(section);
      if (msg == null || msg === '') return null;
      return <div className="error">Failed to load {section}: {msg}</div>;
    };
    switch (id) {
      case 'system': {
        if (!hasSystemMetrics(data)) return sectionErrorBody('system') ?? <></>;
        return <SystemCard data={data} hideTitle bare />;
      }
      case 'cpu':
        if (!hasCpuUsage(data)) return sectionErrorBody('cpu') ?? <></>;
        return <CpuCard data={data} hideTitle bare />;
      case 'memory':
        if (!hasMemory(data)) return sectionErrorBody('memory') ?? <></>;
        return <MemoryCard data={data} hideTitle bare />;
      case 'storage': {
        if (!hasStorage(data)) return <></>;
        return <StorageCard data={data} hideTitle bare />;
      }
      case 'temps': {
        if (!hasTemperatures(data)) return <></>;
        return <TempCard data={data} hideTitle bare />;
      }
      case 'gpu':
        if (!hasGpuMetrics(data)) return <></>;
        return <GpuCard data={data} hideTitle bare />;
      case 'ipmi': {
        if (!showIpmi || !hasIpmiData(data)) return <></>;
        return <IpmiCards data={data} showIpmi={showIpmi} hideTitle />;
      }
      default:
        return null;
    }
  };

  const showMonitorStatus = shownWidgets.some((w) => MONITOR_WIDGET_IDS.includes(w.id));

  // 可視ウィジェットはデータ欠落時も空枠として残す (renderWidgetBody は
  // data取得済みなら null を返さない)。null になるのはローディング中・
  // 未知IDのみ。取得済みで0件の場合は下の空メッセージで空白回避する。
  const renderedWidgets = shownWidgets
    .map((w) => ({ w, body: renderWidgetBody(w.id) }))
    .filter(({ body }) => body !== null);

  // 描画されなかった可視ウィジェットを挟んだ移動も無反応に見えるため、
  // moveWidget には「非表示 or 今回非描画」を飛ばす述語を渡す。
  const renderedIds = new Set(renderedWidgets.map(({ w }) => w.id));
  const skipMoveIds = new Set([
    ...hiddenWidgets.map((w) => w.id),
    ...shownWidgets.filter((w) => !renderedIds.has(w.id)).map((w) => w.id),
    ...(usageFullyHidden ? ['usage'] : []),
  ]);

  return (
    <aside className="right-sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Widgets</span>
        <span className="sidebar-header-actions">
          <button
            type="button"
            className="widget-icon-btn sidebar-pin-btn"
            onClick={() => setOverlay(!overlay)}
            aria-pressed={!overlay}
            title={!overlay ? 'ピン留めを解除して前面に重ねて表示' : 'ピン留めして固定表示'}
            aria-label={!overlay ? 'ピン留めを解除して前面に重ねて表示' : 'ピン留めして固定表示'}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill={!overlay ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="5" r="3" />
              <path d="M8 8.5v6" />
            </svg>
          </button>
          {stats?.setInterval && (
            <span className="sidebar-add-wrap" ref={intervalWrapRef}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => { setIntervalOpen((v) => !v); setAddOpen(false); }}
                title="更新頻度"
                aria-label="更新頻度"
                aria-haspopup="menu"
                aria-expanded={intervalOpen}
              >
                {INTERVAL_OPTIONS.find((o) => o.value === stats.interval)?.label ?? `${stats.interval / 1000}s`}
              </button>
              {intervalOpen && (
                <span className="sidebar-add-menu" role="menu">
                  {INTERVAL_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      role="menuitem"
                      className="sidebar-add-item"
                      onClick={() => { stats.setInterval(o.value); setIntervalOpen(false); }}
                    >
                      {o.value === stats.interval ? '✓ ' : ''}{o.label}
                    </button>
                  ))}
                </span>
              )}
            </span>
          )}
          {addableWidgets.length > 0 && (
            <span className="sidebar-add-wrap" ref={addWrapRef}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => { setAddOpen((v) => !v); setIntervalOpen(false); }}
                title="非表示のウィジェットを追加"
                aria-label="非表示のウィジェットを追加"
                aria-haspopup="menu"
                aria-expanded={addOpen}
              >
                ＋
              </button>
              {addOpen && (
                <span className="sidebar-add-menu" role="menu">
                  {addableWidgets.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      role="menuitem"
                      className="sidebar-add-item"
                      onClick={() => { setWidgetVisible(w.id, true); setAddOpen(false); }}
                    >
                      {w.title}
                    </button>
                  ))}
                </span>
              )}
            </span>
          )}
        </span>
      </div>
      <div className="sidebar-widgets">
        {showMonitorStatus && !stats?.error && !stats?.data && (
          <div className="loading">Loading system stats...</div>
        )}
        {renderedWidgets.map(({ w, body }, i) => (
          <WidgetShell
            key={w.id}
            title={w.title}
            onHide={() => setWidgetVisible(w.id, false)}
            onMoveUp={() => moveWidget(w.id, 'up', (x) => skipMoveIds.has(x))}
            onMoveDown={() => moveWidget(w.id, 'down', (x) => skipMoveIds.has(x))}
            canMoveUp={i > 0}
            canMoveDown={i < renderedWidgets.length - 1}
          >
            {body}
          </WidgetShell>
        ))}
        {renderedWidgets.length === 0 && shownWidgets.length > 0 && stats?.data && (
          <div className="sidebar-empty">
            {addableWidgets.length > 0
              ? '表示できるデータがありません。＋から追加してください。'
              : '表示できるデータがありません。'}
          </div>
        )}
        {shownWidgets.length === 0 && (
          <div className="sidebar-empty">表示中のウィジェットがありません。＋から追加してください。</div>
        )}
      </div>
    </aside>
  );
}

export { WIDGET_DEFS };

export const MONITOR_WIDGET_IDS = ['system', 'cpu', 'memory', 'storage', 'temps', 'gpu', 'ipmi'];

function RightSidebarWithInternalPrefs({ usageProps }) {
  const prefs = useWidgetPrefs(WIDGET_DEFS);
  return <RightSidebarInner usageProps={usageProps} prefs={prefs} />;
}

export default function RightSidebar({ usageProps = {}, prefs }) {
  if (prefs) return <RightSidebarInner usageProps={usageProps} prefs={prefs} />;
  return <RightSidebarWithInternalPrefs usageProps={usageProps} />;
}
