import { useState } from 'react';

export function formatUptime(seconds) {
  // 非有限値・負数は欠測として '—' 表示 (GpuCard の numOrNull 方針と一致)。
  // 右サイドバー側の呼び出しもこのガードで安全になる。
  const n = numOrNull(seconds);
  if (n == null || n < 0) return '—';
  const s = Math.floor(n);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// 有効な load 値だけを "0.50 0.40" 形式にする。1つもなければ null。
export function formatLoadAvg(loadAvg) {
  if (!Array.isArray(loadAvg)) return null;
  const vals = loadAvg.filter((v) => numOrNull(v) != null);
  if (vals.length === 0) return null;
  return vals.map((v) => Number(v).toFixed(2)).join(' ');
}

export function formatMb(mb) {
  // 非有限値 (欠測のnull/undefined、JSON化されたNaNなど) は'—'表示にする。
  const n = numOrNull(mb);
  if (n == null) return '—';
  if (n >= 1024) return `${(n / 1024).toFixed(1)} GB`;
  return `${n} MB`;
}

export function tempColor(temp) {
  if (temp >= 80) return 'var(--error)';
  if (temp >= 60) return '#fab387';
  if (temp >= 40) return '#f9e2af';
  return 'var(--success)';
}

export function usageColor(pct) {
  if (pct >= 90) return 'var(--error)';
  if (pct >= 70) return '#fab387';
  if (pct >= 50) return '#f9e2af';
  return 'var(--accent)';
}

export function Bar({ value, max, label, sublabel, color, format }) {
  const pct = max > 0 ? Math.max(0, Math.min((value / max) * 100, 100)) : 0;
  const barColor = color || usageColor(pct);
  return (
    <div className="monitor-bar-row">
      <div className="monitor-bar-label">
        <span>{label}</span>
        {sublabel && <span className="monitor-bar-sublabel">{sublabel}</span>}
      </div>
      <div className="monitor-bar-track">
        <div className="monitor-bar-fill" style={{ width: `${pct}%`, background: barColor }} />
      </div>
      <div className="monitor-bar-value">{format || `${pct.toFixed(1)}%`}</div>
    </div>
  );
}

export function TempItem({ label, value }) {
  // hwmonのparse失敗はwire上でnullになる。欠測行は描画しない
  // (GpuCardのnumOrNull方針と一致。tempColor(null)はsuccessに倒れるため色も誤る)。
  const temp = numOrNull(value);
  if (temp == null) return null;
  return (
    <div className="monitor-temp-item">
      <span className="monitor-temp-label">{label}</span>
      <span className="monitor-temp-value" style={{ color: tempColor(temp) }}>{temp}°C</span>
    </div>
  );
}

export function hasSystemMetrics(data) {
  const uptime = numOrNull(data?.uptime);
  const loadAvg = data?.loadAvg;
  if (uptime == null && !Array.isArray(loadAvg)) return false;
  if (uptime == null && loadAvg.length === 0) return false;
  if (uptime == null && !loadAvg.some((v) => numOrNull(v) != null)) return false;
  return true;
}

export function SystemCard({ data, hideTitle = false, bare = false }) {
  if (!hasSystemMetrics(data)) return null;
  const uptime = numOrNull(data.uptime);
  const load = formatLoadAvg(data.loadAvg);
  const body = (
    <>
      {!hideTitle && !bare && <div className="monitor-card-title">System</div>}
      {uptime != null && (
        <div className="monitor-ipmi-row">
          <span className="monitor-ipmi-label">Uptime</span>
          <span className="monitor-ipmi-value">{formatUptime(uptime)}</span>
        </div>
      )}
      {load != null && (
        <div className="monitor-ipmi-row">
          <span className="monitor-ipmi-label">Load Average</span>
          <span className="monitor-ipmi-value">{load}</span>
        </div>
      )}
    </>
  );
  if (bare) return body;
  return (
    <div className="monitor-card">
      {body}
    </div>
  );
}

export function hasCpuUsage(data) {
  const usage = data?.cpu?.usage;
  // total は有限数値であること (NaN/Infinity・JSON化された欠測nullを弾く)。
  // cores の要素は描画側で numOrNull フィルタするため配列であることだけ見る。
  return !!data?.cpu && numOrNull(usage?.total) != null && Array.isArray(usage?.cores);
}

// コア表示の選択肢。localStorage の検証にも使うため単一の定義を共有する。
// 'auto' はコア数に応じて bars/heatmap に倒す (resolveCoreView)。
export const AUTO_HEATMAP_CORE_THRESHOLD = 8; // これを超えたらヒートマップ
export const CPU_CORE_VIEWS = [
  { value: 'auto', label: '自動 (8コア超でヒートマップ)' },
  { value: 'bars', label: '通常モード' },
  { value: 'compact', label: 'コンパクトモード' },
  { value: 'heatmap', label: 'ヒートマップモード' },
  { value: 'total', label: 'Total のみ' },
];

export const DEFAULT_CPU_CORE_VIEW = 'auto';

// 'auto' (および未知値・undefined) をコア数に応じて解決する。
// 明示モードはそのまま返す。欠測込みの配列長で判定する。
export function resolveCoreView(coreView, coreCount) {
  if (coreView !== 'bars' && coreView !== 'compact' && coreView !== 'heatmap' && coreView !== 'total') {
    return coreCount > AUTO_HEATMAP_CORE_THRESHOLD ? 'heatmap' : 'bars';
  }
  return coreView;
}

// 欠測コア (null/非数値) は値を null にしたまま配列に残す。詰めてしまうと
// 以降の Core 番号が物理コアとずれるため、描画側で位置を保ったまま除外する。
function coreEntries(cores) {
  return cores.map((core, i) => ({ i, v: numOrNull(core) }));
}

// 1コア=1マスの格子。コア数が増えても折り返しで横に伸びるため、
// カードの高さはコア数にほぼ依存しない (多コア機での縦伸び対策)。
function CoreHeatmap({ cores }) {
  // 値ではなくインデックスだけを持つ。data は数秒ごとに更新されるため、
  // 値を state に入れると読み出し欄に古い数値が残る。
  const [activeIdx, setActiveIdx] = useState(null);
  const entries = coreEntries(cores);
  const valid = entries.filter((e) => e.v != null);
  const active = activeIdx == null ? null : entries.find((e) => e.i === activeIdx && e.v != null);
  const peak = valid.reduce((a, b) => (a == null || b.v > a.v ? b : a), null);
  let readout;
  if (active) readout = `Core ${active.i}  ${active.v.toFixed(1)}%`;
  else if (peak) readout = `${valid.length} cores · max Core ${peak.i} ${peak.v.toFixed(1)}%`;
  else readout = `${entries.length} cores`;
  return (
    <div className="monitor-core-heatmap-wrap">
      <div className="monitor-core-heatmap">
        {entries.map(({ i, v }) =>
          v == null ? (
            <span key={i} className="monitor-core-cell is-missing" title={`Core ${i}: —`} />
          ) : (
            <span
              key={i}
              className="monitor-core-cell"
              role="img"
              tabIndex={0}
              title={`Core ${i}: ${v.toFixed(1)}%`}
              aria-label={`Core ${i}: ${v.toFixed(1)}%`}
              onPointerEnter={() => setActiveIdx(i)}
              onPointerLeave={() => setActiveIdx((cur) => (cur === i ? null : cur))}
              onFocus={() => setActiveIdx(i)}
              onBlur={() => setActiveIdx((cur) => (cur === i ? null : cur))}
            >
              {/* 閾値色 (usageColor) と濃淡の二重符号化。4色だけより差が読める */}
              <span
                className="monitor-core-cell-fill"
                style={{ background: usageColor(v), opacity: 0.18 + (v / 100) * 0.82 }}
              />
            </span>
          )
        )}
      </div>
      {/* ホバーできないタッチ環境でも、フォーカスで同じ値を読めるようにする */}
      <div className="monitor-core-readout">{readout}</div>
    </div>
  );
}

// バー表現を保ったまま多段化する中間モード。番号と整数値のみに切り詰める。
function CoreCompactGrid({ cores }) {
  return (
    <div className="monitor-core-compact">
      {coreEntries(cores).map(({ i, v }) => {
        if (v == null) return null;
        return (
          <div key={i} className="monitor-core-compact-item" title={`Core ${i}: ${v.toFixed(1)}%`}>
            <span className="monitor-core-compact-label">{i}</span>
            <span className="monitor-bar-track">
              <span className="monitor-bar-fill" style={{ width: `${v}%`, background: usageColor(v) }} />
            </span>
            <span className="monitor-core-compact-value">{Math.round(v)}</span>
          </div>
        );
      })}
    </div>
  );
}

function CoreBars({ cores }) {
  return (
    <div className="monitor-core-grid">
      {coreEntries(cores).map(({ i, v }) => {
        // 欠測コア (null/非数値) は行ごと描画しない ("NaN%"/0%誤表示の防止)。
        if (v == null) return null;
        return (
          <Bar
            key={i}
            value={v}
            max={100}
            label={`Core ${i}`}
            format={`${v.toFixed(1)}%`}
          />
        );
      })}
    </div>
  );
}

export function CpuCard({ data, hideTitle = false, bare = false, coreView = DEFAULT_CPU_CORE_VIEW }) {
  if (!hasCpuUsage(data)) return null;
  const usage = data.cpu.usage;
  const total = numOrNull(usage.total);
  const resolvedView = resolveCoreView(coreView, usage.cores.length);
  const body = (
    <>
      {!hideTitle && !bare && <div className="monitor-card-title">CPU</div>}
      <div className="monitor-card-subtitle">{data.cpu.model}</div>
      <Bar
        value={total}
        max={100}
        label="Total"
        color={usageColor(total)}
        format={`${total.toFixed(1)}%`}
      />
      {resolvedView === 'bars' && <CoreBars cores={usage.cores} />}
      {resolvedView === 'compact' && <CoreCompactGrid cores={usage.cores} />}
      {resolvedView === 'heatmap' && <CoreHeatmap cores={usage.cores} />}
    </>
  );
  if (bare) return body;
  return (
    <div className="monitor-card">
      {body}
    </div>
  );
}

// 正規化済みメモリ値。used/total のいずれかが欠測ならカード全体を出さない。
function usableMemory(memory) {
  if (!memory) return null;
  const used = numOrNull(memory.used);
  const total = numOrNull(memory.total);
  if (used == null || total == null) return null;
  return {
    used,
    total,
    available: numOrNull(memory.available),
    bufferCache: numOrNull(memory.bufferCache),
    swapUsed: numOrNull(memory.swapUsed),
    swapTotal: numOrNull(memory.swapTotal),
  };
}

export function hasMemory(data) {
  return usableMemory(data?.memory) != null;
}

export function hasStorage(data) {
  return visibleStorageRows(data).length > 0;
}

export function MemoryCard({ data, hideTitle = false, bare = false }) {
  const mem = usableMemory(data?.memory);
  if (!mem) return null;
  const body = (
    <>
      {!hideTitle && !bare && <div className="monitor-card-title">Memory</div>}
      <Bar
        value={mem.used}
        max={mem.total}
        label="RAM"
        format={`${formatMb(mem.used)} / ${formatMb(mem.total)}`}
      />
      <div className="monitor-mem-detail">
        <span>Available: {formatMb(mem.available)}</span>
        <span>Buffer/Cache: {formatMb(mem.bufferCache)}</span>
      </div>
      {mem.swapTotal != null && mem.swapTotal > 0 && mem.swapUsed != null && (
        <Bar
          value={mem.swapUsed}
          max={mem.swapTotal}
          label="Swap"
          format={`${formatMb(mem.swapUsed)} / ${formatMb(mem.swapTotal)}`}
        />
      )}
    </>
  );
  if (bare) return body;
  return (
    <div className="monitor-card">
      {body}
    </div>
  );
}

// used/total がともに有効数値のエントリだけを残す。Bar の pct が
// NaN/負値になるのを防止する (CpuCard/GpuCard/MemoryCard と同一方針)。
export function visibleStorageRows(data) {
  if (!Array.isArray(data?.storage)) return [];
  return data.storage.filter(
    (s) => s && numOrNull(s.used) != null && numOrNull(s.total) != null && s.total > 0
  );
}

export function StorageCard({ data, hideTitle = false, bare = false }) {
  const rows = visibleStorageRows(data);
  if (rows.length === 0) return null;
  const body = (
    <>
      {!hideTitle && !bare && <div className="monitor-card-title">Storage</div>}
      {rows.map((s, i) => (
        <Bar
          key={`${s.mount}#${i}`}
          value={s.used}
          max={s.total}
          label={s.mount}
          sublabel={s.device}
          format={`${formatMb(s.used)} / ${formatMb(s.total)}`}
        />
      ))}
    </>
  );
  if (bare) return body;
  return (
    <div className="monitor-card">
      {body}
    </div>
  );
}

function visibleTempItems(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((item) => numOrNull(item?.value) != null);
}

export function hasTemperatures(data) {
  const t = data?.temperatures;
  if (!t) return false;
  return visibleTempItems(t.cpu).length > 0 || visibleTempItems(t.pch).length > 0 || visibleTempItems(t.other).length > 0;
}

export function TempCard({ data, hideTitle = false, bare = false }) {
  if (!hasTemperatures(data)) return null;
  const t = data.temperatures;
  // 欠測値 (null) の行は描画せず、全件欠測のグループは見出しごと出さない。
  // hasTemperatures が有効行の存在を保証するため、ここでは空にならない。
  const cpu = visibleTempItems(t.cpu);
  const pch = visibleTempItems(t.pch);
  const other = visibleTempItems(t.other);
  const body = (
    <>
      {!hideTitle && !bare && <div className="monitor-card-title">Temperatures</div>}
      {cpu.length > 0 && (
        <div className="monitor-temp-group">
          <div className="monitor-temp-group-label">CPU</div>
          {cpu.map((item, i) => (
            <TempItem key={`${item.label}#${i}`} label={item.label} value={item.value} />
          ))}
        </div>
      )}
      {pch.length > 0 && (
        <div className="monitor-temp-group">
          <div className="monitor-temp-group-label">Chipset (PCH)</div>
          {pch.map((item, i) => (
            <TempItem key={`${item.label}#${i}`} label={item.label} value={item.value} />
          ))}
        </div>
      )}
      {other.length > 0 && (
        <div className="monitor-temp-group">
          <div className="monitor-temp-group-label">Other</div>
          {other.map((item, i) => (
            <TempItem key={`${item.label}#${i}`} label={item.label} value={item.value} />
          ))}
        </div>
      )}
    </>
  );
  if (bare) return body;
  return (
    <div className="monitor-card">
      {body}
    </div>
  );
}

function numOrNull(v) {
  // Number(null)/Number('') は 0 になるため先に弾く。NaN は JSON 化で
  // null になるので、ここでは null/undefined/''/非有限値を一律「欠測」とする。
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// nvidia-smi は数値でない項目 (例: ファンレス GPU の Fan Speed 'N/A') を
// 返すことがあり、server はそれを NaN 混じりの gpu オブジェクトとして返す
// (parts.length >= 8 を満たすため)。NaN のまま描画すると「NaN°C」表示や
// バー崩れになるため、主要メトリクスで描画可否を判定し、各値は正規化する。
export function hasGpuMetrics(data) {
  const g = data?.gpu;
  if (!g) return false;
  return numOrNull(g.temp) != null || numOrNull(g.utilization) != null || numOrNull(g.memoryUsed) != null;
}

export function GpuCard({ data, hideTitle = false, bare = false }) {
  if (!hasGpuMetrics(data)) return null;
  const g = data.gpu;
  const temp = numOrNull(g.temp);
  const utilization = numOrNull(g.utilization);
  const memoryUsed = numOrNull(g.memoryUsed);
  const memoryTotal = numOrNull(g.memoryTotal);
  const fanSpeed = numOrNull(g.fanSpeed);
  const powerUsage = numOrNull(g.powerUsage);
  const powerCap = numOrNull(g.powerCap);
  const body = (
    <>
      {!hideTitle && !bare && <div className="monitor-card-title">GPU</div>}
      <div className="monitor-card-subtitle">{g.name}</div>
      {temp != null && <TempItem label="Temperature" value={temp} />}
      {utilization != null && (
        <Bar
          value={utilization}
          max={100}
          label="Utilization"
          format={`${utilization.toFixed(1)}%`}
        />
      )}
      {memoryUsed != null && memoryTotal != null && (
        <Bar
          value={memoryUsed}
          max={memoryTotal}
          label="VRAM"
          format={`${formatMb(memoryUsed)} / ${formatMb(memoryTotal)}`}
        />
      )}
      <div className="monitor-gpu-detail">
        <span>Fan: {fanSpeed != null ? `${fanSpeed}%` : '—'}</span>
        <span>Power: {powerUsage != null ? `${powerUsage}W` : '—'} / {powerCap != null ? `${powerCap}W` : '—'}</span>
      </div>
    </>
  );
  if (bare) return body;
  return (
    <div className="monitor-card">
      {body}
    </div>
  );
}

// 有効な値を持つIPMI行だけを残す。要素自体のnull・値の欠測を除外する
// (TempCardのvisibleTempItemsと同一方針)。
function visibleIpmiRows(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((e) => e && numOrNull(e.value) != null);
}

function IpmiCard({ data, field, title, format, grid = false, valueClassName = 'monitor-ipmi-value', hideTitle = false }) {
  const rows = visibleIpmiRows(data?.ipmi?.[field]);
  if (rows.length === 0) return null;
  const body = rows.map((r, i) => (
    <div key={`${r.label}#${i}`} className="monitor-ipmi-row">
      <span className="monitor-ipmi-label">{r.label}</span>
      <span className={valueClassName}>{format(numOrNull(r.value))}</span>
    </div>
  ));
  return (
    <div className="monitor-card">
      {!hideTitle && <div className="monitor-card-title">{title}</div>}
      {grid ? <div className="monitor-voltage-grid">{body}</div> : body}
    </div>
  );
}

function IpmiPowerCard({ data, hideTitle = false }) {
  return (
    <IpmiCard
      data={data}
      field="power"
      title="Power (IPMI)"
      format={(v) => `${v.toFixed(1)} W`}
      valueClassName="monitor-ipmi-value monitor-power-value"
      hideTitle={hideTitle}
    />
  );
}

function IpmiVoltageCard({ data, hideTitle = false }) {
  return (
    <IpmiCard
      data={data}
      field="voltage"
      title="Voltage (IPMI)"
      grid
      format={(v) => `${v.toFixed(3)} V`}
      hideTitle={hideTitle}
    />
  );
}

function IpmiFansCard({ data, hideTitle = false }) {
  return (
    <IpmiCard
      data={data}
      field="fans"
      title="Fans (IPMI)"
      format={(v) => `${Math.round(v)} RPM`}
      hideTitle={hideTitle}
    />
  );
}

function IpmiTempsCard({ data, hideTitle = false }) {
  // TempItem自体も欠測値を描画しないが、要素自体のnullはここで除外する。
  const rows = visibleIpmiRows(data?.ipmi?.temps);
  if (rows.length === 0) return null;
  return (
    <div className="monitor-card">
      {!hideTitle && <div className="monitor-card-title">Temperatures (IPMI)</div>}
      {rows.map((t, i) => (
        <TempItem key={`${t.label}#${i}`} label={t.label} value={t.value} />
      ))}
    </div>
  );
}

export function hasIpmiData(data) {
  const ipmi = data?.ipmi;
  if (!ipmi) return false;
  const valid = (arr) => visibleIpmiRows(arr).length > 0;
  return valid(ipmi.power) || valid(ipmi.voltage) || valid(ipmi.fans) || valid(ipmi.temps);
}

export function IpmiCards({ data, showIpmi, hideTitle = false }) {
  if (!showIpmi || !hasIpmiData(data)) return null;
  return (
    <>
      <IpmiPowerCard data={data} hideTitle={hideTitle} />
      <IpmiVoltageCard data={data} hideTitle={hideTitle} />
      <IpmiFansCard data={data} hideTitle={hideTitle} />
      <IpmiTempsCard data={data} hideTitle={hideTitle} />
    </>
  );
}
