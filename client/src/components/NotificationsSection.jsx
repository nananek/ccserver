import { useState, useEffect, useCallback } from 'react';
import { authFetch } from '../auth.js';

// 「通知」メニュー: エージェント通知ブリッジ (sandbox.config.json の
// notify.bridge) の GUI 編集。サンドボックス内の AI CLI がターミナルへ吐く
// デスクトップ通知のエスケープシーケンスを ccserver 側で拾い、Discord /
// 購読 webhook / PWA 通知へ転送する機能の設定。
//
// NetworkIsolationSection と同じ作法:
//   - マスタースイッチ (有効にする) だけは即時保存。残りは明示的な「保存」
//     ボタンでまとめて送る (数値やリストは fat-finger しやすいため)。
//   - 保存はファイルへの書き込み。捕捉まわり (対象アプリ・設定注入) は
//     起動時ポリシーなので次回起動から、配信まわり (配信先・間引き) は
//     通知ごとにファイルを読み直すので即時に効く。
//
// PWA 通知 (Web Push) の購読 UI はこの下に別ブロックとして後から入る。
// それまで webpush チャネルは選べるが配信先としては未到達 (サーバーが
// channelsAvailable.webpush=false を返す)。

const APP_LABELS = {
  claude: 'Claude Code',
  opencode: 'opencode',
  copilot: 'GitHub Copilot',
  codex: 'OpenAI Codex',
  commandcode: 'Command Code',
};

const CHANNEL_LABELS = {
  discord: 'Discord webhook / 購読 webhook',
  webpush: 'PWA 通知 (Web Push)',
};

const CHANNEL_UNAVAILABLE_HINT = {
  discord: 'notify.discordWebhook も購読 webhook も未設定です。設定するまで配信されません。',
  webpush: 'この端末の購読がまだありません (Web Push は準備中)。',
};

const LEVEL_LABELS = {
  info: 'info (作業中の報告)',
  success: 'success (完了)',
  warning: 'warning (要確認)',
  error: 'error (要対応)',
};

// 捕捉の可否は CLI ごとに事情が違うので、選択肢の横に一言添える。
const APP_NOTES = {
  claude: '起動時に通知チャネル設定を注入して吐かせます (検証済み)',
  opencode: '既定で OSC 777 を吐きます (検証済み)',
  codex: 'このホストで未検証のため既定オフ。吐けば拾えます',
  copilot: '設定注入の手段がありません。吐けば拾えるだけです',
  commandcode: '設定注入の手段がありません。吐けば拾えるだけです',
};

const NUMBER_FIELDS = [
  {
    key: 'minIntervalMs',
    label: '最小送信間隔 (ミリ秒)',
    hint: '同じセッションからの連投をこの間隔まで間引きます。',
  },
  {
    key: 'dedupeWindowMs',
    label: '重複抑制の窓 (ミリ秒)',
    hint: '同じ内容の通知をこの時間内は 1 回だけ送ります。',
  },
  {
    key: 'maxPerHour',
    label: '1 セッションあたりの上限 (件/時)',
    hint: 'エージェントが通知を連打して配信先を溢れさせないための上限です。',
  },
];

export default function NotificationsSection() {
  const [settings, setSettings] = useState(null);
  const [choices, setChoices] = useState(null);
  const [available, setAvailable] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [enabledSaving, setEnabledSaving] = useState(false);
  const [enabledSaveError, setEnabledSaveError] = useState(null);

  const applyResponse = useCallback((data) => {
    if (data.settings) setSettings(data.settings);
    if (data.choices) setChoices(data.choices);
    if (data.channelsAvailable) setAvailable(data.channelsAvailable);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const res = await authFetch('/api/notify-settings');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      applyResponse(await res.json());
    } catch (err) {
      setError(err.message || '設定の読み込みに失敗しました');
    } finally {
      setLoading(false);
    }
  }, [applyResponse]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // マスタースイッチだけは即時保存 (NetworkIsolationSection の isolate と
  // 同じ理由: オン/オフは他の項目のレビューとは独立に効いてほしい)。
  const handleEnabledToggle = async (checked) => {
    const prev = settings;
    setSettings({ ...settings, enabled: checked });
    setEnabledSaving(true);
    setEnabledSaveError(null);
    try {
      const res = await authFetch('/api/notify-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: checked }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      applyResponse(body);
    } catch (err) {
      setSettings(prev);
      setEnabledSaveError(err.message || '保存に失敗しました');
    } finally {
      setEnabledSaving(false);
    }
  };

  const update = (key, value) => setSettings((s) => ({ ...s, [key]: value }));

  const toggleInList = (key, value, checked) => {
    setSettings((s) => {
      const list = Array.isArray(s[key]) ? s[key] : [];
      return { ...s, [key]: checked ? [...new Set([...list, value])] : list.filter((v) => v !== value) };
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await authFetch('/api/notify-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apps: settings.apps,
          injectConfig: settings.injectConfig,
          channels: settings.channels,
          captureBell: settings.captureBell,
          minIntervalMs: settings.minIntervalMs,
          dedupeWindowMs: settings.dedupeWindowMs,
          maxPerHour: settings.maxPerHour,
          level: settings.level,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      applyResponse(body);
      setSaved(true);
    } catch (err) {
      setSaveError(err.message || '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <section className="settings-section"><h3>通知</h3><div className="loading">Loading...</div></section>;
  }
  if (!settings || !choices) {
    return (
      <section className="settings-section">
        <h3>通知</h3>
        {error && <div className="error">Error: {error}</div>}
        <div className="resume-actions">
          <button className="btn btn-secondary" onClick={refresh}>再読込</button>
        </div>
      </section>
    );
  }

  const off = !settings.enabled;
  const limits = choices.limits || {};

  return (
    <section className="settings-section">
      <h3>通知</h3>
      {error && <div className="error">Error: {error}</div>}

      <h4 className="general-setting-subhead">エージェント通知の転送</h4>
      <label className="general-setting-check">
        <input
          type="checkbox"
          checked={!!settings.enabled}
          disabled={enabledSaving}
          onChange={(e) => handleEnabledToggle(e.target.checked)}
        />
        エージェントのデスクトップ通知を転送する
        {enabledSaving ? ' (保存中...)' : ''}
      </label>
      {enabledSaveError && <div className="error">Error: {enabledSaveError}</div>}
      <p className="settings-hint">
        サンドボックス内の AI CLI はホストの通知デーモンに届かないため、ターミナルへ吐かれる通知用エスケープシーケンスを ccserver が拾って転送します。
        オフの間は捕捉も設定注入も行わず、CLI の起動コマンドは現状と完全に同一です。変更は即座に保存されます。
      </p>

      <div className="general-setting-row">
        <label htmlFor="notify-level-select">転送時の重要度 (level)</label>
        <select
          id="notify-level-select"
          value={settings.level}
          disabled={off}
          onChange={(e) => update('level', e.target.value)}
        >
          {(choices.levels || []).map((lv) => (
            <option key={lv} value={lv}>{LEVEL_LABELS[lv] || lv}</option>
          ))}
        </select>
      </div>
      <p className="settings-hint">
        転送される通知に付く重要度です。エージェントが何を吐いたかに関わらずこの値が使われます。
      </p>

      <h4 className="general-setting-subhead">対象のエージェント CLI</h4>
      {(choices.apps || []).map((app) => (
        <label key={app} className={`general-setting-check${off ? ' general-setting-check-disabled' : ''}`}>
          <input
            type="checkbox"
            disabled={off}
            checked={(settings.apps || []).includes(app)}
            onChange={(e) => toggleInList('apps', app, e.target.checked)}
          />
          {APP_LABELS[app] || app}
          {APP_NOTES[app] ? `（${APP_NOTES[app]}）` : ''}
        </label>
      ))}
      <label className={`general-setting-check${off ? ' general-setting-check-disabled' : ''}`}>
        <input
          type="checkbox"
          disabled={off}
          checked={!!settings.injectConfig}
          onChange={(e) => update('injectConfig', e.target.checked)}
        />
        通知を吐かせる設定を起動時に注入する
      </label>
      <p className="settings-hint">
        Claude Code は既定 (auto) だと ccserver のターミナル種別では通知を一切出さないため、起動引数でチャネルを指定する必要があります。
        注入はそのプロセス限りで、ホストの ~/.claude/settings.json は書き換えません。
        オフにすると、既定で通知を吐く CLI しか拾えなくなります。
      </p>
      <label className={`general-setting-check${off ? ' general-setting-check-disabled' : ''}`}>
        <input
          type="checkbox"
          disabled={off}
          checked={!!settings.captureBell}
          onChange={(e) => update('captureBell', e.target.checked)}
        />
        ベル (BEL) も通知として扱う
      </label>
      <p className="settings-hint">
        シェルの補完音や <code>printf &apos;\a&apos;</code> と区別できないため、既定ではオフです。
      </p>

      <h4 className="general-setting-subhead">配信先</h4>
      {(choices.channels || []).map((ch) => {
        const unavailable = available && available[ch] === false;
        return (
          <div key={ch}>
            <label className={`general-setting-check${off ? ' general-setting-check-disabled' : ''}`}>
              <input
                type="checkbox"
                disabled={off}
                checked={(settings.channels || []).includes(ch)}
                onChange={(e) => toggleInList('channels', ch, e.target.checked)}
              />
              {CHANNEL_LABELS[ch] || ch}
              {unavailable ? '（未設定）' : ''}
            </label>
            {unavailable && (settings.channels || []).includes(ch) && (
              <p className="settings-hint">{CHANNEL_UNAVAILABLE_HINT[ch]}</p>
            )}
          </div>
        );
      })}
      <p className="settings-hint">
        「Discord webhook / 購読 webhook」は設定 (sandbox.config.json の notify) 側で設定した webhook 全部をまとめて指します。
        配信先を 1 つも選ばないとどこにも届きません。
      </p>

      <h4 className="general-setting-subhead">流量の制限</h4>
      <p className="settings-hint">
        通知の中身はサンドボックス内のエージェントが完全に制御できるため、連打で配信先を溢れさせられないように上限を設けます。
      </p>
      {NUMBER_FIELDS.map((f) => (
        <div key={f.key}>
          <div className="general-setting-row">
            <label htmlFor={`notify-${f.key}-input`}>{f.label}</label>
            <input
              id={`notify-${f.key}-input`}
              type="number"
              disabled={off}
              min={limits[f.key]?.min}
              max={limits[f.key]?.max}
              value={settings[f.key]}
              onChange={(e) => update(f.key, e.target.value === '' ? '' : Number(e.target.value))}
            />
          </div>
          <p className="settings-hint">
            {f.hint}
            {limits[f.key] ? ` (${limits[f.key].min}〜${limits[f.key].max})` : ''}
          </p>
        </div>
      ))}

      <div className="resume-actions">
        <button className="btn btn-secondary" onClick={refresh} disabled={saving}>再読込</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving || off}>
          {saving ? '保存中...' : '保存'}
        </button>
      </div>
      {saveError && <div className="error">Error: {saveError}</div>}
      <p className="settings-hint">
        {saved ? '保存しました。' : ''}
        対象アプリと設定注入の変更は次回起動から、配信先と流量の制限は即座に適用されます。
      </p>
    </section>
  );
}
