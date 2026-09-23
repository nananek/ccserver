import TabIcon from './TabIcon.jsx';
import { useGpgVaultStatusContext } from './GpgVaultStatusProvider.jsx';
import { gpgVaultBadgeState } from '../gpgVaultBadge.js';

export function baseName(path) {
  if (!path) return '';
  const parts = String(path).split(/[/\\]/).filter(Boolean);
  return parts.pop() || String(path);
}

export function appLabel(sessionOrTab) {
  if (sessionOrTab.shell) return 'shell';
  const app = sessionOrTab.app || 'claude';
  if (app === 'commandcode') return 'command-code';
  return app;
}

// セッション一覧の実体 (ポップアップ / 左サイドバーで共用するプレゼンテーショナル部品)。
// 外側ラッパー (.session-menu / .session-sidebar-list) や開閉ロジックは持たない。
// a11y: 行コンテナは role="none" の非対話要素とし、「選択」と「閉じる/終了」
// を独立した button で提供する (menuitem 内に button を入れ子にしない)。
// 各行の右クリックは onRowContextMenu(e, { id, currentLabel }) に委譲する
// (サーバー保存の表示名の設定用。サーバーセッション未確立のタブは対象外)。
export default function SessionList({
  sessionTabs,
  groupTabs = [],
  activeTabId,
  unopenedSessions,
  onSelectTab,
  onCloseTab,
  onOpenSession,
  onTerminateSession,
  unopenedRemoteSessions = [],
  onOpenRemoteSession,
  onTerminateRemoteSession,
  unopenedRemoteGroups = [],
  onOpenRemoteGroup,
  onDestroyRemoteGroup,
  customLabels,
  onRowContextMenu,
  unopenedGroups,
  onOpenGroup,
}) {
  const vaultStatus = useGpgVaultStatusContext();
  const handleRowContextMenu = (e, id, currentLabel) => {
    if (!id || !onRowContextMenu) return;
    e.preventDefault();
    onRowContextMenu(e, { id, currentLabel: currentLabel || null });
  };
  const hasOpened = sessionTabs.length > 0 || groupTabs.length > 0;
  return (
    <>
      <div className="session-menu-section" data-section="opened">
        <div className="session-menu-section-label">開いているセッション</div>
        {!hasOpened ? (
          <div className="session-menu-empty">開いているセッションはありません</div>
        ) : (
          <>
          {sessionTabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const stateClass = tab.exited ? 'is-exited' : 'is-running';
            // 状態(connected/idle/exited)は左線の色で表現するため文字では出さない。
            // 下段右端にはCLI名のみを出す。
            const statusText = appLabel(tab);
            // サーバー保存の表示名があれば優先する (未確立タブは sessionId 不在のため対象外)。
            const sessionId = tab.sessionId || tab.attachSessionId || null;
            const customLabel = sessionId ? (customLabels?.get(sessionId) ?? null) : null;
            // リモートタブのラベル先頭の「⇄ 」は一覧では出さない (ホストは下段バッジで示す)。
            const displayLabel = customLabel || (tab.remote ? String(tab.label).replace(/^⇄\s*/, '') : tab.label);
            return (
              <div
                key={tab.id}
                role="none"
                className={`session-menu-item${isActive ? ' active' : ''} ${stateClass}${tab.type === 'terminal' && !tab.shell && !tab.sandbox ? ' no-sandbox' : ''}`}
                title={tab.cwd || displayLabel}
                onContextMenu={(e) => handleRowContextMenu(e, sessionId, customLabel)}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="session-menu-select"
                  aria-label={`${tab.exited ? '終了済み' : '稼働中'}: ${displayLabel}`}
                  onClick={() => { onSelectTab(tab.id); }}
                >
                  <span className="session-menu-item-top">
                    <TabIcon type={tab.type} app={tab.app} shell={tab.shell} />
                    <span className="session-menu-label">{displayLabel}</span>
                    {(() => {
                      // 一覧では Vault ありで起動したセッションにだけ鍵を出す。
                      const badge = tab.gpgVaultActive ? gpgVaultBadgeState(tab, vaultStatus?.data) : null;
                      if (!badge) return null;
                      return <span className={`session-badge gpg-vault-${badge.state}`} title={badge.reason}>🔑</span>;
                    })()}
                    {!tab.shell && !tab.sandbox && <span className="session-badge no-sandbox">no sandbox</span>}
                    {tab.sandbox && <span className="session-badge sandbox">sandbox</span>}
                  </span>
                  <span className="session-menu-status">
                    {tab.remote && (
                      <span className="tab-remote-badge" title={`接続先: ${tab.remote.label}`}>⇄ {tab.remote.label}</span>
                    )}
                    <span className="session-menu-state">{statusText}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="tab-close session-menu-close"
                  title="タブを閉じる"
                  aria-label={`タブを閉じる: ${displayLabel}`}
                  onClick={() => { onCloseTab(tab.id); }}
                >
                  &#10005;
                </button>
              </div>
            );
          })}
          {groupTabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const memberCount = Array.isArray(tab.members) ? tab.members.length : 0;
            const turnText = tab.currentTurn === 'orchestrator' ? 'ORCH' : tab.currentTurn ? String(tab.currentTurn).toUpperCase() : null;
            const statusText = memberCount > 0 ? `${memberCount} members` : 'グループ';
            return (
              <div
                key={tab.id}
                role="none"
                className={`session-menu-item${isActive ? ' active' : ''} is-running`}
                data-tab-type="group"
                data-group-id={tab.groupId || ''}
                title={tab.cwd || tab.label}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="session-menu-select"
                  aria-label={turnText ? `グループ: ${tab.label}, ${statusText}, 現在の手番 ${turnText}` : `グループ: ${tab.label}, ${statusText}`}
                  onClick={() => { onSelectTab(tab.id); }}
                >
                  <span className="session-menu-item-top">
                    <TabIcon type="group" />
                    <span className="session-menu-label">{tab.label}</span>
                    {turnText && (
                      <span className="tab-turn-badge" title={`現在の手番: ${tab.currentTurn}`}>{turnText}</span>
                    )}
                  </span>
                  <span className="session-menu-status">
                    <span className="session-menu-state">{statusText}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="tab-close session-menu-close"
                  title="タブを閉じる"
                  aria-label={`タブを閉じる: ${tab.label}`}
                  onClick={() => { onCloseTab(tab.id); }}
                >
                  &#10005;
                </button>
              </div>
            );
          })}
          </>
        )}
      </div>
      {unopenedSessions.length > 0 && (
        <div className="session-menu-section" data-section="unopened">
          <div className="session-menu-sep" />
          <div className="session-menu-section-label">稼働中のセッション</div>
          {unopenedSessions.map((s) => (
            <div
              key={s.id}
              role="none"
              className={`session-menu-item ${s.connected ? 'is-running' : 'is-idle'}`}
              title={s.customLabel || s.cwd || s.id}
              onContextMenu={(e) => handleRowContextMenu(e, s.id, s.customLabel)}
            >
              <button
                type="button"
                role="menuitem"
                className="session-menu-select"
                aria-label={`${s.connected ? '稼働中' : 'アイドル'}: ${s.customLabel || s.cwd || s.id}`}
                onClick={() => { onOpenSession(s); }}
              >
                <span className="session-menu-item-top">
                  <TabIcon type="terminal" app={s.app} shell={!!s.shell} />
                  <span className="session-menu-label">{s.customLabel || baseName(s.cwd) || s.id.slice(0, 8)}</span>
                  {(() => {
                    const badge = s.gpgVaultActive ? gpgVaultBadgeState(s, vaultStatus?.data) : null;
                    if (!badge) return null;
                    return <span className={`session-badge gpg-vault-${badge.state}`} title={badge.reason}>🔑</span>;
                  })()}
                  {s.sandbox
                    ? <span className="session-badge sandbox">sandbox</span>
                    : (!s.shell ? <span className="session-badge no-sandbox">no sandbox</span> : null)}
                </span>
                <span className="session-menu-status">
                  <span className="session-menu-state">{appLabel(s)}</span>
                </span>
              </button>
              <button
                type="button"
                className="tab-close session-menu-close"
                title="セッションを終了する"
                aria-label={`セッションを終了する: ${s.cwd || s.id}`}
                onClick={() => { onTerminateSession(s); }}
              >
                &#10005;
              </button>
            </div>
          ))}
        </div>
      )}
      {unopenedRemoteSessions.length > 0 && (
        <div className="session-menu-section" data-section="unopened-remote">
          <div className="session-menu-sep" />
          <div className="session-menu-section-label">リモートのセッション</div>
          {unopenedRemoteSessions.map((entry) => {
            const { instance, session: s } = entry;
            const host = instance.label || instance.fingerprint?.slice(0, 8) || instance.id;
            const label = baseName(s.cwd) || s.id.slice(0, 8);
            return (
              <div
                key={`${instance.id}:${s.id}`}
                role="none"
                className={`session-menu-item ${s.connected === false ? 'is-idle' : 'is-running'}`}
                title={`${host}: ${s.cwd || s.id}`}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="session-menu-select"
                  aria-label={`リモート (${host}): ${s.cwd || s.id}`}
                  onClick={() => { onOpenRemoteSession(entry); }}
                >
                  <span className="session-menu-item-top">
                    <TabIcon type="terminal" app={s.app} shell={!!s.shell} />
                    <span className="session-menu-label">{label}</span>
                    {s.sandbox
                      ? <span className="session-badge sandbox">sandbox</span>
                      : (!s.shell ? <span className="session-badge no-sandbox">no sandbox</span> : null)}
                  </span>
                  <span className="session-menu-status">
                    <span className="tab-remote-badge" title={`接続先: ${host}`}>⇄ {host}</span>
                    <span className="session-menu-state">{appLabel(s)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="tab-close session-menu-close"
                  title="リモートセッションを終了する"
                  aria-label={`リモートセッションを終了する: ${host} ${s.cwd || s.id}`}
                  onClick={() => { onTerminateRemoteSession(entry); }}
                >
                  &#10005;
                </button>
              </div>
            );
          })}
        </div>
      )}
      {(unopenedGroups || []).length > 0 && (
        <div className="session-menu-section" data-section="unopened-groups">
          <div className="session-menu-sep" />
          <div className="session-menu-section-label">グループ</div>
          {unopenedGroups.map((g) => {
            const dirName = (g.cwd || '').split(/[/\\]/).filter(Boolean).pop() || g.groupId;
            const liveText = g.liveCount > 0
              ? `${g.memberCount} members · ${g.liveCount} live`
              : `${g.memberCount} members`;
            return (
              <div
                key={g.groupId}
                role="none"
                className={`session-menu-item ${g.liveCount > 0 ? 'is-running' : 'is-idle'}`}
                title={g.cwd || g.groupId}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="session-menu-select"
                  aria-label={`グループ: ${dirName}`}
                  onClick={() => { onOpenGroup(g.groupId); }}
                >
                  <span className="session-menu-item-top">
                    <TabIcon type="group" />
                    <span className="session-menu-label">{dirName}</span>
                  </span>
                  <span className="session-menu-status">
                    <span className="session-menu-state">{liveText}</span>
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
      {unopenedRemoteGroups.length > 0 && (
        <div className="session-menu-section" data-section="unopened-remote-groups">
          <div className="session-menu-sep" />
          <div className="session-menu-section-label">リモートのグループ</div>
          {unopenedRemoteGroups.map((entry) => {
            const { instance, group: g } = entry;
            const host = instance.label || instance.fingerprint?.slice(0, 8) || instance.id;
            const dirName = baseName(g.cwd) || g.groupId;
            const liveText = g.liveCount > 0
              ? `${g.memberCount} members · ${g.liveCount} live`
              : `${g.memberCount ?? ''} members`.trim();
            return (
              <div
                key={`${instance.id}:${g.groupId}`}
                role="none"
                className={`session-menu-item ${g.liveCount === 0 ? 'is-idle' : 'is-running'}`}
                title={`${host}: ${g.cwd || g.groupId}`}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="session-menu-select"
                  aria-label={`リモートグループ (${host}): ${dirName}`}
                  onClick={() => { onOpenRemoteGroup(entry); }}
                >
                  <span className="session-menu-item-top">
                    <TabIcon type="group" />
                    <span className="session-menu-label">{dirName}</span>
                  </span>
                  <span className="session-menu-status">
                    <span className="tab-remote-badge" title={`接続先: ${host}`}>⇄ {host}</span>
                    <span className="session-menu-state">{liveText}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="tab-close session-menu-close"
                  title="リモートグループを破棄する"
                  aria-label={`リモートグループを破棄する: ${host} ${g.cwd || g.groupId}`}
                  onClick={() => { onDestroyRemoteGroup(entry); }}
                >
                  &#10005;
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
