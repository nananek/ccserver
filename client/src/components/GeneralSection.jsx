import { useState, useEffect } from 'react';
import { getThemeIds, getTheme } from '../themes.js';
import { resolveAuthMode } from '../auth.js';

// "一般" メニュー: テーマ・終了確認・戻る/進むガード・セッション表示・
// デスクトップ通知・サンドボックス既定値。
// いずれも即時反映し、localStorage に永続化される (保存先の詳細は
// 各 setter 側 = App.jsx / useSessionSidebarPrefs.js / themes.js / sandboxDefaults.js を参照)。
// なお左右パネルの「ピン留め (固定表示/前面に重ねて表示の切替)」設定は各パネルの
// ヘッダーのピン留めボタン (RightSidebar.jsx / SessionSidebar.jsx) に移設済みで、
// ここには無い。
export default function GeneralSection({
  themeId,
  onThemeChange,
  confirmBeforeClose,
  onConfirmBeforeCloseChange,
  sessionMode,
  onSessionModeChange,
  sandboxDefaults,
  onSandboxDefaultsChange,
  toolsAvailable,
  navGuardMode,
  onNavGuardModeChange,
  notifyEnabled,
  notifyPermission,
  onToggleNotify,
}) {
  const updateSandboxDefault = (key, value) => {
    onSandboxDefaultsChange({ ...sandboxDefaults, [key]: value });
  };
  // gpgVault (plan: gpg-agent-vault) is a passkey-login-only feature -- this
  // section has no other reason to know authMode, so it resolves it locally
  // rather than threading a new prop through SettingsView, same independent-
  // resolution pattern PasskeysSection.jsx already uses.
  const [authMode, setAuthMode] = useState(null);
  useEffect(() => {
    let cancelled = false;
    resolveAuthMode().then((m) => { if (!cancelled) setAuthMode(m); });
    return () => { cancelled = true; };
  }, []);
  // rtk / code-review-graph are unavailable on macOS (seatbelt has no
  // provisioner -- /api/dirs/home's toolsAvailable). null/absent (older
  // server) leaves both enabled. See issue #22.
  const toolDisabled = (id) => toolsAvailable ? toolsAvailable[id] === false : false;
  const TOOL_UNAVAILABLE_NOTE = 'この ccserver ホスト (macOS) では非対応です';
  return (
    <section className="settings-section">
      <h3>一般</h3>
      <div className="general-setting-row">
        <label htmlFor="general-theme-select">テーマ</label>
        <select
          id="general-theme-select"
          value={themeId}
          onChange={(e) => onThemeChange(e.target.value)}
        >
          {getThemeIds().map((id) => (
            <option key={id} value={id}>
              {getTheme(id).name}
            </option>
          ))}
        </select>
      </div>
      <label className="general-setting-check">
        <input
          type="checkbox"
          checked={confirmBeforeClose}
          onChange={(e) => onConfirmBeforeCloseChange(e.target.checked)}
        />
        タブを閉じる前に確認する
      </label>
      <p className="settings-hint">
        オフにすると、稼働中のタブも確認なしで閉じます
        (終了確認ダイアログの「次回以降確認しない」と同じ設定です)。
      </p>
      <div className="general-setting-row">
        <label htmlFor="general-nav-guard-select">ブラウザの戻る・進む操作</label>
        <select
          id="general-nav-guard-select"
          value={navGuardMode ?? 'confirm'}
          onChange={(e) => onNavGuardModeChange(e.target.value)}
        >
          <option value="confirm">確認ダイアログを出す</option>
          <option value="suppress">確認なしで抑制する</option>
          <option value="allow">抑制しない</option>
        </select>
      </div>
      <p className="settings-hint">
        キー入力中の表示を残すため、ブラウザの履歴操作による離脱を抑止します。
        入力欄・ターミナルにフォーカスがある間のショートカットは常に抑止され、
        ターミナル操作として扱われます。
      </p>
      <div className="general-setting-row">
        <label htmlFor="general-session-mode-select">セッション表示</label>
        <select
          id="general-session-mode-select"
          value={sessionMode ?? 'sidebar'}
          onChange={(e) => onSessionModeChange(e.target.value)}
        >
          <option value="sidebar">サイドバー</option>
          <option value="popup">ポップアップ</option>
        </select>
      </div>
      <p className="settings-hint">
        サイドバーは右ウィジェットと同じ常時表示パネルです。
        ポップアップはタブバー左端の☰ボタンから開く従来表示です。
      </p>
      <label className="general-setting-check">
        <input
          type="checkbox"
          checked={!!notifyEnabled}
          disabled={notifyPermission === 'denied' || notifyPermission === 'unsupported'}
          onChange={onToggleNotify}
        />
        デスクトップ通知を有効にする
      </label>
      <p className="settings-hint">
        {notifyPermission === 'denied'
          ? 'ブラウザの通知権限がブロックされています。ブラウザ側の設定から許可してください。'
          : notifyPermission === 'unsupported'
            ? 'このブラウザは通知に対応していません。'
            : 'セッションの入力待ちなどをブラウザ通知でお知らせします。'}
      </p>
      <h4 className="general-setting-subhead">サンドボックス起動の既定値</h4>
      <label className="general-setting-check">
        <input
          type="checkbox"
          checked={!!sandboxDefaults.gpg}
          onChange={(e) => updateSandboxDefault('gpg', e.target.checked)}
        />
        GPG署名を使う
      </label>
      <label className="general-setting-check">
        <input
          type="checkbox"
          checked={!!sandboxDefaults.sshAgent}
          onChange={(e) => updateSandboxDefault('sshAgent', e.target.checked)}
        />
        ssh-agentを転送する
      </label>
      <label className={`general-setting-check${authMode !== 'passkey' ? ' general-setting-check-disabled' : ''}`}>
        <input
          type="checkbox"
          disabled={authMode !== 'passkey'}
          checked={authMode !== 'passkey' ? false : !!sandboxDefaults.gpgVault}
          onChange={(e) => updateSandboxDefault('gpgVault', e.target.checked)}
        />
        GPG Vaultで署名・SSH pushする{authMode !== 'passkey' ? '（パスキーログイン限定）' : ''}
      </label>
      <p className="settings-hint">
        サーバーが保持する専用のGPG鍵でコミット署名とSSH pushを行います。設定 &gt; GPG連携でVaultの作成・アンロックが必要です。
      </p>
      <label className={`general-setting-check${toolDisabled('rtk') ? ' general-setting-check-disabled' : ''}`}>
        <input
          type="checkbox"
          disabled={toolDisabled('rtk')}
          checked={toolDisabled('rtk') ? false : !!sandboxDefaults.rtk}
          onChange={(e) => updateSandboxDefault('rtk', e.target.checked)}
        />
        rtk を導入する{toolDisabled('rtk') ? `（${TOOL_UNAVAILABLE_NOTE}）` : ''}
      </label>
      <label className={`general-setting-check${toolDisabled('codeReviewGraph') ? ' general-setting-check-disabled' : ''}`}>
        <input
          type="checkbox"
          disabled={toolDisabled('codeReviewGraph')}
          checked={toolDisabled('codeReviewGraph') ? false : !!sandboxDefaults.codeReviewGraph}
          onChange={(e) => updateSandboxDefault('codeReviewGraph', e.target.checked)}
        />
        code-review-graph MCP を導入する{toolDisabled('codeReviewGraph') ? `（${TOOL_UNAVAILABLE_NOTE}）` : ''}
      </label>
      <p className="settings-hint">
        ディレクトリ別に記憶済みの場所には適用されず、
        未設定のディレクトリの初期値として使われます。
      </p>
    </section>
  );
}
