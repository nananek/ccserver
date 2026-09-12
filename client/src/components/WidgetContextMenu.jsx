import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// ウィジェットの右クリックメニュー (汎用)。開閉は SessionContextMenu と同じ方式:
// 外側 mousedown で閉じる + Escape で閉じる。位置はクリック座標 (position: fixed)。
// 画面端では実寸を測ってはみ出さない位置へ寄せる。
//
// groups = [{ key, label, current, choices: [{ value, label }], onSelect: (value) => {} }]
// 将来他のウィジェットに項目を足すときもこの形で渡すだけにする。
export default function WidgetContextMenu({ x, y, groups = [], onClose }) {
  const menuRef = useRef(null);
  // まずクリック座標に出し、実寸を測って画面内へ寄せ直す。useLayoutEffect は
  // paint 前に走るのでちらつかない。項目数や文言が増えても勝手に追従する。
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const onDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose?.();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('mousedown', onDown);
    // iOS は非インタラクティブ要素のタップで mouse 系を出さないことがあるので、
    // タッチでも確実に閉じられるよう touchstart も見る。メニューを開いた
    // 長押しの touchstart はこの mount より前に済んでいるので自分では閉じない。
    document.addEventListener('touchstart', onDown, { passive: true });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 項目数も文言もウィジェット次第なので、幅・高さは決め打ちにせず測る。
  // .widget-context-item は white-space: nowrap なので、右端近くに出しても
  // 折り返しで縮まず rect は本来の幅を返す。
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - height - 4));
    setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
    // groups は毎レンダー新しい配列なので deps に入れない (無限ループになる)。
    // 内容が変わるのは開き直したときだけで、そのときは x/y も変わる。
  }, [x, y]);

  return (
    <div
      className="widget-context-menu"
      role="menu"
      aria-label="ウィジェットメニュー"
      ref={menuRef}
      style={{ left: pos.left, top: pos.top }}
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
