import { useState, useEffect, useCallback } from 'react';
import LoginView from './LoginView.jsx';
import { resolveAuthMode, authFetch, onAuthRequired } from '../auth.js';

// Wraps <App/> in main.jsx (Issue #141 Step4). `token`/`none` mode render
// App immediately, unchanged from pre-#141 -- `token` mode's existing
// prompt()-on-401 flow (auth.js's authFetch) keeps handling auth entirely on
// its own, same as before this feature existed. Only `passkey` mode adds a
// gate: check GET /api/auth/session, and render LoginView instead of App
// until it comes back 200.
export default function AuthGate({ children }) {
  const [authMode, setAuthMode] = useState(null); // null = not yet resolved
  const [loggedIn, setLoggedIn] = useState(false);

  const showLoginView = useCallback(() => setLoggedIn(false), []);

  useEffect(() => {
    // Registered before the initial check below fires so a 401 from that
    // very check (in-flight authFetch call) is also caught by it -- same
    // handler a session expiring mid-use later triggers.
    onAuthRequired(showLoginView);

    let cancelled = false;
    (async () => {
      const mode = await resolveAuthMode();
      if (cancelled) return;
      if (mode !== 'passkey') {
        setAuthMode(mode);
        setLoggedIn(true);
        return;
      }
      const res = await authFetch('/api/auth/session');
      if (cancelled) return;
      setAuthMode(mode);
      setLoggedIn(res.ok);
    })();
    return () => { cancelled = true; };
  }, [showLoginView]);

  if (authMode === null) {
    return <div className="authgate-loading">読み込み中…</div>;
  }
  if (authMode === 'passkey' && !loggedIn) {
    return <LoginView onLoggedIn={() => setLoggedIn(true)} />;
  }
  return children;
}
