import { useRef } from 'react';
import { useDismissableMenu } from '../hooks/useDismissableMenu.js';

// セッション行の右クリックメニュー (ポップアップ / 左サイドバー共用)。
// 開閉は SessionTabMenu と同じ方式: 外側 mousedown で閉じる + Escape で閉じる。
// 位置はクリック座標 (position: fixed)。画面端ではメニューがはみ出さないよう
// 簡易クランプする (メニュー概形 200x80 を想定)。
export default function SessionContextMenu({
  x,
  y,
  hasCustomLabel,
  onRename,
  onClear,
  onClose,
}) {
  const menuRef = useRef(null);

  // 開閉は WidgetContextMenu と共通 (useDismissableMenu):
  // 外側 mousedown/touchstart で閉じる + Escape で閉じる。
  useDismissableMenu(menuRef, onClose);

  const left = Math.max(4, Math.min(x, window.innerWidth - 204));
  const top = Math.max(4, Math.min(y, window.innerHeight - 84));

  return (
    <div
      className="session-context-menu"
      role="menu"
      aria-label="セッションメニュー"
      ref={menuRef}
      style={{ left, top }}
    >
      <button
        type="button"
        role="menuitem"
        className="session-context-item"
        autoFocus
        onClick={() => { onRename?.(); }}
      >
        名前を設定
      </button>
      {hasCustomLabel && (
        <button
          type="button"
          role="menuitem"
          className="session-context-item"
          onClick={() => { onClear?.(); }}
        >
          名前をクリア
        </button>
      )}
    </div>
  );
}
