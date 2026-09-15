import { useEffect } from 'react';

// ポップアップメニュー系の共通 dismiss 処理。
// 外側 mousedown + touchstart で閉じる + Escape で閉じる。
// SessionContextMenu / WidgetContextMenu で共有する。
// (2つの実装が乖離し始めていたため切り出し。touchstart 対応は両方に効く。)
//
// 使い方: useDismissableMenu(menuRef, onClose)
// - menuRef: メニュー要素の ref
// - onClose: メニュー外操作・Escape で呼ぶコールバック
// - opts.enabled: false の間はリスナを張らない
//   (マウントされっ放しで開閉だけ切り替える SessionTabMenu 用)
export function useDismissableMenu(menuRef, onClose, { enabled = true } = {}) {
  useEffect(() => {
    if (!enabled) return;
    const onDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose?.();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('mousedown', onDown);
    // iOS は非インタラクティブ要素のタップで mouse 系を出さないことがあるので、
    // タッチでも確実に閉じられるよう touchstart も見る。
    document.addEventListener('touchstart', onDown, { passive: true });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuRef, onClose, enabled]);
}

// 右クリック (contextmenu) を汎用メニューの入口にする共通オープナー。
// SessionList の handleRowContextMenu と同じく preventDefault してから開く。
// 右クリックと長押しで座標の出どころが違うだけなので、開く処理は呼び出し側に寄せる。
export function openMenuAtEvent(e, open) {
  e.preventDefault();
  open(e.clientX, e.clientY);
}
