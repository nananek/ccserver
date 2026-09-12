import { useCallback, useEffect, useRef } from 'react';

// タッチの長押しを右クリック (contextmenu) 相当として拾うフック。
// iOS は 13 以降、長押しで contextmenu を発火しない (OSのテキスト選択/callout に
// なる) ため、タッチ端末でメニューを開くには自前で検出するしかない。
// Android Chrome は長押しで contextmenu を合成するので両方走りうるが、
// contextmenu 側は同じメニューを同じ座標に開き直すだけなので害はない。
//
// 閾値は以前 TerminalView にあった長押し選択の実装 (53747de) と揃える。
export const LONG_PRESS_MS = 450;
export const LONG_PRESS_MOVE_PX = 10;

// 返り値をそのまま対象要素へ spread して使う。onLongPress が無ければ何もしない
// (項目を持たないウィジェットに配線しても無反応のまま)。
export function useLongPress(onLongPress, { ms = LONG_PRESS_MS, movePx = LONG_PRESS_MOVE_PX } = {}) {
  const timerRef = useRef(null);
  const startRef = useRef(null);
  const firedRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // アンマウント時にタイマーを残さない (消えた要素のメニューを開かない)。
  useEffect(() => cancel, [cancel]);

  const onTouchStart = useCallback((e) => {
    cancel();
    if (!onLongPress) return;
    // 2本指以降はピンチ/スクロールなので長押しとして扱わない。
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    startRef.current = { x: t.clientX, y: t.clientY };
    firedRef.current = false;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      firedRef.current = true;
      onLongPress({ x: startRef.current.x, y: startRef.current.y });
    }, ms);
  }, [onLongPress, ms, cancel]);

  const onTouchMove = useCallback((e) => {
    const start = startRef.current;
    const t = e.touches[0];
    if (!start || !t || !timerRef.current) return;
    // 指が動いたらスクロール意図。React の touchmove は passive なので
    // preventDefault はできない (する必要もない) — タイマーを畳むだけ。
    if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > movePx) cancel();
  }, [movePx, cancel]);

  const onTouchEnd = useCallback((e) => {
    cancel();
    if (!firedRef.current) return;
    firedRef.current = false;
    // 長押しが成立したときだけ既定動作を止める。これがないと指を離した瞬間に
    // ブラウザが同じ座標へ mousedown/click を合成し、そこにはもうメニューが
    // 出ているので即座に項目をタップしたことになる (または外側判定で閉じる)。
    // React は touchend を非 passive で張るので preventDefault が効く。
    e.preventDefault();
  }, [cancel]);

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd };
}
