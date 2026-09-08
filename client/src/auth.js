// Auth mode is env-var-driven server-side (CCSERVER_AUTH_MODE=none/token/
// passkey, Issue #141) but the client only learns which one is live by
// asking GET /api/auth/mode. Every export below keeps its pre-#141 shape
// (getToken/setToken/authFetch/authWsUrl are called from 23+ places --
// ApprovalBanner, DirectoryBrowser, TerminalView, useSystemStats, etc. --
// none of which needed to change for this) and just branches internally on
// the resolved mode.

const STORAGE_KEY = 'ccserver-token';

let cachedToken = localStorage.getItem(STORAGE_KEY) || '';

// null = not yet resolved. Resolved once per page load and cached for the
// session -- CCSERVER_AUTH_MODE only changes via a server restart (Issue
// #141 design: no DB-backed dynamic mode switch), so there's nothing to
// invalidate this cache for.
let cachedAuthMode = null;
let authModeInFlight = null;

// Only `passkey` mode changes any of the branches below; `token` and `none`
// both fall through to the exact pre-#141 behavior, so this is the only
// check that matters anywhere in this file.
function isPasskeyMode() {
  return cachedAuthMode === 'passkey';
}

// GET /api/auth/mode is unauthenticated in `none`/`passkey` mode (it's on
// server/index.js's UNAUTHENTICATED_AUTH_ROUTES) but NOT in `token` mode --
// that mode's onRequest hook gates every /api/* route uniformly with no
// allowlist. So a request here failing (network error, or a 401 because no
// token is cached yet) can only mean `token` mode, and defaulting to
// 'token' in that case is exactly correct, not just a safe fallback: it
// keeps the pre-#141 prompt()-on-401 path (below) fully intact for anyone
// running token auth with a fresh browser profile.
export async function resolveAuthMode() {
  if (cachedAuthMode) return cachedAuthMode;
  if (!authModeInFlight) {
    authModeInFlight = fetch('/api/auth/mode', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        cachedAuthMode = data && typeof data.mode === 'string' ? data.mode : 'token';
      })
      .catch(() => {
        cachedAuthMode = 'token';
      })
      .finally(() => {
        authModeInFlight = null;
      })
      .then(() => cachedAuthMode);
  }
  return authModeInFlight;
}

export function getToken() {
  // passkey mode authenticates via the httpOnly session cookie, never a
  // bearer token -- returning null here (rather than whatever's left in
  // localStorage from a prior token-mode run) is what makes the
  // <a href>-based download links in DirectoryBrowser/GroupTabView work
  // unmodified: no token param gets appended, and the browser's normal
  // same-origin navigation sends the session cookie on its own.
  return isPasskeyMode() ? null : cachedToken;
}

export function setToken(token) {
  cachedToken = token;
  if (token) {
    localStorage.setItem(STORAGE_KEY, token);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

// Registered by AuthGate.jsx; called when authFetch sees a 401 in passkey
// mode (session expired / not logged in yet) so AuthGate can swap back to
// LoginView. A no-op until AuthGate mounts and registers one.
let authRequiredCb = null;

export function onAuthRequired(cb) {
  authRequiredCb = cb;
}

// Both branches below need to collapse concurrent 401s from the several
// independent pollers that call authFetch (ApprovalBanner,
// PairingRequestBanner, RemoteInstanceView, useSystemStats, GroupTabView --
// same set as issue #123 #5) into a single interrupt instead of one per
// poller, and again suppress re-triggering for a while after that interrupt
// resolves. promptInFlight/suppressUntil already do this for the `token`
// path below; authRequiredSuppressUntil applies the same cooldown to the
// passkey path's onAuthRequired callback (that callback just flips a
// boolean in AuthGate's state, so unlike the token path there's no
// async prompt to collapse concurrent callers onto -- a cooldown alone is
// enough to stop every poller re-firing it on every 401 they each get).
let promptInFlight = null;
let suppressUntil = 0;
let authRequiredSuppressUntil = 0;
const PROMPT_SUPPRESS_MS = 60000;

export async function authFetch(url, opts = {}) {
  const mode = await resolveAuthMode();

  if (mode === 'passkey') {
    const res = await fetch(url, { ...opts, credentials: 'same-origin' });
    if (res.status === 401 && Date.now() >= authRequiredSuppressUntil) {
      authRequiredSuppressUntil = Date.now() + PROMPT_SUPPRESS_MS;
      authRequiredCb?.();
    }
    return res;
  }

  // token/none mode: unchanged from pre-#141.
  if (cachedToken) {
    opts.headers = { ...opts.headers, Authorization: `Bearer ${cachedToken}` };
  }
  const res = await fetch(url, opts);
  if (res.status === 401) {
    if (Date.now() < suppressUntil) return res;
    if (!promptInFlight) {
      promptInFlight = Promise.resolve()
        .then(() => prompt('Token required:'))
        .finally(() => { promptInFlight = null; });
    }
    const token = await promptInFlight;
    if (token) {
      setToken(token);
      opts.headers = { ...opts.headers, Authorization: `Bearer ${token}` };
      return fetch(url, opts);
    }
    suppressUntil = Date.now() + PROMPT_SUPPRESS_MS;
  }
  return res;
}

export function authWsUrl(url) {
  // Cookie auth applies to the WS upgrade request the same as any other
  // same-origin request -- nothing to append.
  if (isPasskeyMode()) return url;
  if (!cachedToken) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(cachedToken)}`;
}
