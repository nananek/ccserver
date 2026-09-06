import { useRef, useCallback } from 'react';
import SessionList from './SessionList.jsx';
import { moveMenuFocus } from './sessionMenuNav.js';

// 左セッションサイドバー: 右ウィジェット (RightSidebar) と同じ挙動の常時表示パネル。
// - open でゲートし、閉じている間は null (RightSidebarInner と同一方針)
// - popup のような外側クリック / Escape では閉じない。閉じるのはタブバーの
//   トグルボタンのみ (デスクトップ overlay 時にトグルが埋もれないよう
//   .main-row 内 absolute に留める設計も右と同一)
// - 選択しても閉じない (popup は選択で閉じる)
// - キーボードの矢印/Home/End 移動は popup と同一パターン
export default function SessionSidebar({
  open,
  sessionTabs,
  groupTabs = [],
  activeTabId,
  unopenedSessions,
  unopenedGroups,
  onSelectTab,
  onCloseTab,
  onOpenSession,
  onTerminateSession,
  onOpenGroup,
  customLabels,
  onRowContextMenu,
}) {
  const listRef = useRef(null);

  const onListKeyDown = useCallback((e) => {
    if (moveMenuFocus(listRef.current, e.key)) e.preventDefault();
  }, []);

  if (!open) return null;

  const openedCount = sessionTabs.length + groupTabs.length;

  return (
    <aside className="left-sidebar" aria-label="セッションサイドバー">
      <div className="sidebar-header">
        <span className="sidebar-title">
          Sessions
          {openedCount > 0 && (
            <span className="session-menu-count" aria-hidden="true" style={{ marginLeft: 8 }}>{openedCount}</span>
          )}
        </span>
      </div>
      <div className="sidebar-widgets session-sidebar-list" ref={listRef} onKeyDown={onListKeyDown} role="menu" aria-label="セッション一覧">
        <SessionList
          sessionTabs={sessionTabs}
          groupTabs={groupTabs}
          activeTabId={activeTabId}
          unopenedSessions={unopenedSessions}
          unopenedGroups={unopenedGroups}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          onOpenSession={onOpenSession}
          onTerminateSession={onTerminateSession}
          onOpenGroup={onOpenGroup}
          customLabels={customLabels}
          onRowContextMenu={onRowContextMenu}
        />
      </div>
    </aside>
  );
}
