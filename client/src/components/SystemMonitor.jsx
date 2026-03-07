import { useState, useEffect, useRef, useCallback } from 'react';
import { authFetch } from '../auth.js';

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatMb(mb) {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

function tempColor(temp) {
  if (temp >= 80) return 'var(--error)';
  if (temp >= 60) return '#fab387';
  if (temp >= 40) return '#f9e2af';
  return 'var(--success)';
}

function usageColor(pct) {
  if (pct >= 90) return 'var(--error)';
  if (pct >= 70) return '#fab387';
  if (pct >= 50) return '#f9e2af';
  return 'var(--accent)';
}

function Bar({ value, max, label, sublabel, color, format }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
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

function TempItem({ label, value }) {
  return (
    <div className="monitor-temp-item">
      <span className="monitor-temp-label">{label}</span>
      <span className="monitor-temp-value" style={{ color: tempColor(value) }}>{value}°C</span>
    </div>
  );
}

export default function SystemMonitor({ visible }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [interval, setIntervalMs] = useState(() => {
    const saved = localStorage.getItem('monitor-interval');
    return saved ? Number(saved) : 2000;
  });
  const [showIpmi, setShowIpmi] = useState(() => {
    const saved = localStorage.getItem('monitor-show-ipmi');
    return saved !== null ? saved === 'true' : true;
  });
  const timerRef = useRef(null);
  const showIpmiRef = useRef(showIpmi);
  useEffect(() => { showIpmiRef.current = showIpmi; }, [showIpmi]);

  const fetchStats = useCallback(async () => {
    try {
      const params = showIpmiRef.current ? '?ipmi=1' : '';
      const res = await authFetch(`/api/system-stats${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    if (!visible) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }
    fetchStats();
    timerRef.current = setInterval(fetchStats, interval);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [visible, interval, fetchStats]);

  if (error && !data) {
    return (
      <div className="system-monitor">
        <div className="error">Failed to load system stats: {error}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="system-monitor">
        <div className="loading">Loading system stats...</div>
      </div>
    );
  }

  const memUsedPct = data.memory.total > 0 ? (data.memory.used / data.memory.total) * 100 : 0;
  const swapUsedPct = data.memory.swapTotal > 0 ? (data.memory.swapUsed / data.memory.swapTotal) * 100 : 0;

  return (
    <div className="system-monitor">
      <div className="monitor-header">
        <h2>System Monitor</h2>
        <div className="monitor-meta">
          <span>Uptime: {formatUptime(data.uptime)}</span>
          <span>Load: {data.loadAvg.map((v) => v.toFixed(2)).join(' ')}</span>
          <select
            className="monitor-interval-select"
            value={interval}
            onChange={(e) => {
              const v = Number(e.target.value);
              setIntervalMs(v);
              localStorage.setItem('monitor-interval', v);
            }}
          >
            <option value={1000}>1s</option>
            <option value={2000}>2s</option>
            <option value={5000}>5s</option>
            <option value={10000}>10s</option>
          </select>
          <label className="monitor-toggle">
            <input
              type="checkbox"
              checked={showIpmi}
              onChange={(e) => {
                setShowIpmi(e.target.checked);
                localStorage.setItem('monitor-show-ipmi', e.target.checked);
              }}
            />
            IPMI
          </label>
        </div>
      </div>

      <div className="monitor-grid">
        {/* CPU Section */}
        <div className="monitor-card">
          <div className="monitor-card-title">CPU</div>
          <div className="monitor-card-subtitle">{data.cpu.model}</div>
          <Bar
            value={data.cpu.usage.total}
            max={100}
            label="Total"
            color={usageColor(data.cpu.usage.total)}
            format={`${data.cpu.usage.total.toFixed(1)}%`}
          />
          <div className="monitor-core-grid">
            {data.cpu.usage.cores.map((usage, i) => (
              <Bar
                key={i}
                value={usage}
                max={100}
                label={`Core ${i}`}
                format={`${usage.toFixed(1)}%`}
              />
            ))}
          </div>
        </div>

        {/* Memory Section */}
        <div className="monitor-card">
          <div className="monitor-card-title">Memory</div>
          <Bar
            value={data.memory.used}
            max={data.memory.total}
            label="RAM"
            format={`${formatMb(data.memory.used)} / ${formatMb(data.memory.total)}`}
          />
          <div className="monitor-mem-detail">
            <span>Available: {formatMb(data.memory.available)}</span>
            <span>Buffer/Cache: {formatMb(data.memory.bufferCache)}</span>
          </div>
          {data.memory.swapTotal > 0 && (
            <>
              <Bar
                value={data.memory.swapUsed}
                max={data.memory.swapTotal}
                label="Swap"
                format={`${formatMb(data.memory.swapUsed)} / ${formatMb(data.memory.swapTotal)}`}
              />
            </>
          )}
        </div>

        {/* Temperature Section */}
        <div className="monitor-card">
          <div className="monitor-card-title">Temperatures</div>
          {data.temperatures.cpu && (
            <div className="monitor-temp-group">
              <div className="monitor-temp-group-label">CPU</div>
              {data.temperatures.cpu.map((t) => (
                <TempItem key={t.label} label={t.label} value={t.value} />
              ))}
            </div>
          )}
          {data.temperatures.pch && (
            <div className="monitor-temp-group">
              <div className="monitor-temp-group-label">Chipset (PCH)</div>
              {data.temperatures.pch.map((t) => (
                <TempItem key={t.label} label={t.label} value={t.value} />
              ))}
            </div>
          )}
          {data.temperatures.other && (
            <div className="monitor-temp-group">
              <div className="monitor-temp-group-label">Other</div>
              {data.temperatures.other.map((t) => (
                <TempItem key={t.label} label={t.label} value={t.value} />
              ))}
            </div>
          )}
        </div>

        {/* GPU Section */}
        {data.gpu && (
          <div className="monitor-card">
            <div className="monitor-card-title">GPU</div>
            <div className="monitor-card-subtitle">{data.gpu.name}</div>
            <TempItem label="Temperature" value={data.gpu.temp} />
            <Bar
              value={data.gpu.utilization}
              max={100}
              label="Utilization"
              format={`${data.gpu.utilization}%`}
            />
            <Bar
              value={data.gpu.memoryUsed}
              max={data.gpu.memoryTotal}
              label="VRAM"
              format={`${formatMb(data.gpu.memoryUsed)} / ${formatMb(data.gpu.memoryTotal)}`}
            />
            <div className="monitor-gpu-detail">
              <span>Fan: {data.gpu.fanSpeed}%</span>
              <span>Power: {data.gpu.powerUsage}W / {data.gpu.powerCap}W</span>
            </div>
          </div>
        )}

        {/* IPMI Power Section */}
        {showIpmi && data.ipmi && data.ipmi.power.length > 0 && (
          <div className="monitor-card">
            <div className="monitor-card-title">Power (IPMI)</div>
            {data.ipmi.power.map((p) => (
              <div key={p.label} className="monitor-ipmi-row">
                <span className="monitor-ipmi-label">{p.label}</span>
                <span className="monitor-ipmi-value monitor-power-value">{p.value} W</span>
              </div>
            ))}
          </div>
        )}

        {/* IPMI Voltage Section */}
        {showIpmi && data.ipmi && data.ipmi.voltage.length > 0 && (
          <div className="monitor-card">
            <div className="monitor-card-title">Voltage (IPMI)</div>
            <div className="monitor-voltage-grid">
              {data.ipmi.voltage.map((v) => (
                <div key={v.label} className="monitor-ipmi-row">
                  <span className="monitor-ipmi-label">{v.label}</span>
                  <span className="monitor-ipmi-value">{v.value.toFixed(3)} V</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* IPMI Fan Section */}
        {showIpmi && data.ipmi && data.ipmi.fans.length > 0 && (
          <div className="monitor-card">
            <div className="monitor-card-title">Fans (IPMI)</div>
            {data.ipmi.fans.map((f) => (
              <div key={f.label} className="monitor-ipmi-row">
                <span className="monitor-ipmi-label">{f.label}</span>
                <span className="monitor-ipmi-value">{Math.round(f.value)} RPM</span>
              </div>
            ))}
          </div>
        )}

        {/* IPMI Temperature Section */}
        {showIpmi && data.ipmi && data.ipmi.temps.length > 0 && (
          <div className="monitor-card">
            <div className="monitor-card-title">Temperatures (IPMI)</div>
            {data.ipmi.temps.map((t) => (
              <TempItem key={t.label} label={t.label} value={t.value} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
