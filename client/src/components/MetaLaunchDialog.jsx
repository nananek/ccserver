import { useState, useEffect } from 'react';
import { authFetch } from '../auth.js';

const META_APP_KEY = 'ccserver-meta-app';
const META_APPS = ['claude', 'opencode', 'codex'];
const APP_LABELS = { claude: 'Claude Code', opencode: 'opencode', codex: 'OpenAI Codex' };

function loadMetaApp() {
  try {
    const v = localStorage.getItem(META_APP_KEY);
    return META_APPS.includes(v) ? v : null;
  } catch { /* ignore */ }
  return null;
}

export default function MetaLaunchDialog({ open, onClose, onLaunch, availableApps, hiddenApps = [], defaultApp, metaAgentDir }) {
  const [metaApp, setMetaApp] = useState(loadMetaApp);
  const [metaModel, setMetaModel] = useState('');

  // Sync from localStorage when dialog opens (in case another tab changed it)
  useEffect(() => {
    if (open) setMetaApp(loadMetaApp());
  }, [open]);

  const chooseMetaApp = (val) => {
    if (hiddenApps.includes(val)) return; // operator hid this app
    if (availableApps && !availableApps[val]) return;
    setMetaApp(val);
    try { localStorage.setItem(META_APP_KEY, val); } catch { /* ignore */ }
  };

  // Apps hidden via sandbox.config.json's hiddenApps (issue #105): removed
  // from this picker entirely, unlike a not-installed app (still shown
  // greyed out below).
  const visibleMetaApps = META_APPS.filter((app) => !hiddenApps.includes(app));

  const handleLaunch = async () => {
    let enabled = false;
    try {
      const res = await authFetch('/api/dirs/home');
      enabled = (await res.json()).metaAgentEnabled === true;
    } catch { /* unreachable -> disabled */ }
    if (!enabled) {
      window.alert('メタエージェントは現在サーバー設定で無効です (sandbox.config.json の "metaAgentMcp": true で有効化できます)。');
      return;
    }
    const app = metaApp || defaultApp;
    if (app === 'copilot') {
      window.alert('GitHub Copilot はMCP注入に対応していないため、メタエージェントでは起動できません。アプリを選択してください。');
      return;
    }
    try {
      const res = await authFetch('/api/sessions');
      const data = await res.json();
      const live = (data.sessions || []).filter((s) => s.isMetaAgent);
      if (live.length > 0 && !window.confirm(`すでに稼働中のメタエージェントが ${live.length} 件あります。\n新たにもう1つ起動しますか?`)) {
        return;
      }
    } catch { /* session list unavailable -> fall through */ }
    if (!window.confirm('メタエージェントを起動しますか?\nサーバー全体(全プロジェクト/サンドボックス/セッション)を操作できる特権 MCP (ccserver-meta) がこのセッションに付与されます。')) {
      return;
    }
    const model = app === 'codex' ? metaModel.trim() || null : null;
    onLaunch({ app, model });
  };

  if (!open) return null;

  const effectiveApp = metaApp || defaultApp;

  return (
    <div className="resume-overlay" onClick={onClose}>
      <div className="resume-dialog open-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="メタエージェント起動">
        <h3>メタエージェントを起動</h3>
        <p className="open-menu-note">
          メタエージェント: サーバー全体(全プロジェクト/サンドボックス/セッション)を操作できる特権 MCP
          (ccserver-meta) を持って起動します。破壊的な操作はブラウザ上部のバナーでの承認を求めます。
          起動のたびに確認ダイアログが表示されます。
          {metaAgentDir ? ` プロジェクト外の専用ディレクトリ (${metaAgentDir}) で起動されます。` : ''}
        </p>
        <div className="open-menu-label">アプリ</div>
        {visibleMetaApps.map((appKey) => (
          <div
            key={appKey}
            className={`open-menu-item${availableApps && !availableApps[appKey] ? ' open-menu-item-disabled' : ''}`}
            onClick={() => chooseMetaApp(appKey)}
            title={availableApps && !availableApps[appKey] ? 'サーバーに未インストール' : ''}
          >
            <span className="open-menu-check">{effectiveApp === appKey ? '✓' : ''}</span>
            {APP_LABELS[appKey]}
          </div>
        ))}
        {effectiveApp === 'codex' && (
          <div className="open-menu-model-row">
            <input
              type="text"
              className="open-menu-model-input"
              placeholder="Codexモデル (空=既定)"
              value={metaModel}
              onChange={(e) => setMetaModel(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
        )}
        <div className="resume-actions">
          <button className="btn btn-secondary" onClick={onClose}>キャンセル</button>
          <button className="btn btn-primary" onClick={handleLaunch}>
            メタエージェントを起動
          </button>
        </div>
      </div>
    </div>
  );
}
