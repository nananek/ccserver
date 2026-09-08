import { useState, useEffect, useCallback } from 'react';
import LoginView from './LoginView.jsx';
import { resolveAuthMode, authFetch, onAuthRequired } from '../auth.js';

// Wraps <App/> in main.jsx (Issue #141 Step4). `token`/`none` mode must
// render App on the very first pass, with no gate at all -- not just
// "no LoginView", but no wait on GET /api/auth/mode either. An earlier
// version awaited resolveAuthMode() before rendering anything (a shared
// "読み込み中…" placeholder for all three modes), which delayed App's --
// and therefore DirectoryBrowser's -- mount by one network round trip even
// in `token`/`none` mode. DirectoryBrowser seeds its initial directory from
// localStorage and immediately writes it back
// (client/src/components/DirectoryBrowser.jsx's `fetchDirs`/`currentPath`
// effect), so delaying that mount widened the window in which something
// else touching the same localStorage key right after a page load (e.g.
// tests/breadcrumb-nested.spec.js's openAtNestedDir seeding
// ccserver-last-dir between two page.goto('/') calls) could land between
// the seed and DirectoryBrowser's own read, and get silently overwritten --
// observed as intermittent E2E failures (breadcrumb-nested/file-preview/
// settings-menu specs, PR #154). Rendering `children` unconditionally from
// the first render restores that exact pre-#141 timing for `token`/`none`
// (App mounts synchronously, same tick as before this feature existed);
// `token` mode's existing prompt()-on-401 flow (auth.js's authFetch) keeps
// handling auth entirely on its own, same as before. Only `passkey` mode
// still gates: once resolveAuthMode() confirms it, a failed GET
// /api/auth/session swaps to LoginView. Children may render for one frame
// first in that mode (their own authFetch calls just 401 until then, same
// cooldown-guarded onAuthRequired callback below would catch it too) --
// no real data is exposed, only the app chrome.
export default function AuthGate({ children }) {
  const [needsLogin, setNeedsLogin] = useState(false);

  const showLoginView = useCallback(() => setNeedsLogin(true), []);

  useEffect(() => {
    // Registered before the check below fires so a 401 from that very
    // check (in-flight authFetch call) is also caught by it -- same handler
    // a session expiring mid-use later triggers.
    onAuthRequired(showLoginView);

    let cancelled = false;
    (async () => {
      const mode = await resolveAuthMode();
      if (cancelled || mode !== 'passkey') return;
      const res = await authFetch('/api/auth/session');
      if (cancelled) return;
      if (!res.ok) setNeedsLogin(true);
    })();
    return () => { cancelled = true; };
  }, [showLoginView]);

  if (needsLogin) {
    return <LoginView onLoggedIn={() => setNeedsLogin(false)} />;
  }
  return children;
}
