// ポップアップ / サイドバー共用のメニュー内キーボード移動
// (SessionTabMenu / SessionSidebar)。
// container 内の .session-menu-select / .session-menu-close 間を
// ArrowDown/Up・Home/End で循環フォーカス移動する。処理したら true を返す。
export function moveMenuFocus(container, key) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) return false;
  if (!container) return false;
  const buttons = [...container.querySelectorAll('button.session-menu-select, button.session-menu-close')];
  if (buttons.length === 0) return false;
  const idx = buttons.indexOf(document.activeElement);
  if (key === 'Home') { buttons[0].focus(); return true; }
  if (key === 'End') { buttons[buttons.length - 1].focus(); return true; }
  // フォーカスがボタン外にある場合 (idx === -1): Down は先頭、Up は末尾へ。
  // 正規化しないと Up が buttons[(idx - 1 + len) % len] で末尾から2番目に飛ぶ。
  if (idx < 0) {
    buttons[key === 'ArrowDown' ? 0 : buttons.length - 1].focus();
    return true;
  }
  const next = key === 'ArrowDown'
    ? buttons[(idx + 1) % buttons.length]
    : buttons[(idx - 1 + buttons.length) % buttons.length];
  next.focus();
  return true;
}
