import { useEffect, useRef } from 'react';

// ウィジェットの右クリックメニュー (汎用)。開閉は SessionContextMenu と同じ方式:
// 外側 mousedown で閉じる + Escape で閉じる。位置はクリック座標 (position: fixed)。
// 画面端ではメニューがはみ出さないよう簡易クランプする。
//
// groups = [{ key, label, current, choices: [{ value, label }], onSelect: (value) => {} }]
// 将来他のウィジェットに項目を足すときもこの形で渡すだけにする。
export default function WidgetContextMenu({ x, y, groups = [], onClose }) {
  const menuRef = useRef(null);

  useEffect(() => {
    const onDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose?.();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // セッション用 (200x80想定) より縦に長い (見出し+5項目) ため余白を大きめに取る。
  const left = Math.max(4, Math.min(x, window.innerWidth - 244));
  const top = Math.max(4, Math.min(y, window.innerHeight - 264));

  return (
    <div
      className="widget-context-menu"
      role="menu"
      aria-label="ウィジェットメニュー"
      ref={menuRef}
      style={{ left, top }}
    >
      {groups.map((group, gi) => (
        <div key={group.key} className="widget-context-group" role="group" aria-label={group.label}>
          <div className="widget-context-group-label">{group.label}</div>
          {group.choices.map((choice) => {
            const selected = choice.value === group.current;
            return (
              <button
                key={choice.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className="widget-context-item"
                autoFocus={gi === 0 && selected}
                onClick={() => { group.onSelect?.(choice.value); onClose?.(); }}
              >
                <span className="ctx-check">{selected ? '✓' : ''}</span>
                {choice.label}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
