import { useEffect, useRef } from 'react';

// Runs `callback` immediately and then every `ms`, skipping ticks while the
// browser tab is in the background (document.hidden) and catching up with
// one immediate call as soon as it becomes visible again. Without this, a
// tab left open for days keeps every poller running at full rate even
// though nobody can see the result (issue #123 #9/#10).
export function useVisiblePolling(callback, ms, enabled = true) {
  const callbackRef = useRef(callback);
  useEffect(() => { callbackRef.current = callback; }, [callback]);

  useEffect(() => {
    if (!enabled) return undefined;
    const tick = () => {
      if (!document.hidden) callbackRef.current();
    };
    tick();
    const timer = setInterval(tick, ms);
    const onVisible = () => { if (!document.hidden) callbackRef.current(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ms, enabled]);
}
