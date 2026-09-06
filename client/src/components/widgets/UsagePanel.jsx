import { fmtAge } from './useUsage.js';
import UsageLimits from './UsageLimits.jsx';

// UsageButton (popover) と UsageWidget (sidebar) で共有するパネル本体。
// 見た目の差異は作らないこと (UsageLimits のコメントと同一方針)。
export default function UsagePanel({ tabLabel, tabs, tab, setTab, tabLabels, data, loading, load, limits, now }) {
  return (
    <>
      <div className="usage-menu-header">
        <span>{tabLabel}</span>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => load(true)}
          disabled={loading}
          title="最新の状態を取得"
        >
          {loading ? '取得中…' : '更新'}
        </button>
      </div>

      {tabs.length > 1 && (
        <div className="usage-tabs">
          {tabs.map((a) => (
            <button
              key={a}
              type="button"
              className={`usage-tab${tab === a ? ' active' : ''}`}
              onClick={() => setTab(a)}
            >{tabLabels[a]}</button>
          ))}
        </div>
      )}

      {data?.usage?.plan && (
        <div className="usage-plan">{data.usage.plan}</div>
      )}

      <UsageLimits limits={limits} loading={loading} data={data} onRetry={() => load(false)} now={now} />

      {data?.usage?.cost && data.usage.cost !== '$0.0000' && (
        <div className="usage-cost">セッション費用: {data.usage.cost}</div>
      )}

      <div className="usage-footer">
        {data?.updatedAt ? `更新 ${fmtAge(data.updatedAt)}` : ''}
        {data?.sandboxed ? ' · 🔒 サンドボックス' : ''}
      </div>
    </>
  );
}
