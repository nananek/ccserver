const STORAGE_KEY = 'ccserver-token';

let cachedToken = localStorage.getItem(STORAGE_KEY) || '';

export function getToken() {
  return cachedToken;
}

export function setToken(token) {
  cachedToken = token;
  if (token) {
    localStorage.setItem(STORAGE_KEY, token);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

// Several pollers (ApprovalBanner, PairingRequestBanner, RemoteInstanceView,
// useSystemStats, GroupTabView) call authFetch independently and concurrently.
// Without this, a stale/rotated token makes every one of them pop its own
// blocking prompt() on the same tick, and again on every following tick
// after the user cancels (issue #123 #5). promptInFlight collapses
// concurrent 401s into a single prompt; suppressUntil stops re-prompting for
// a while after a cancel.
let promptInFlight = null;
let suppressUntil = 0;
const PROMPT_SUPPRESS_MS = 60000;

export async function authFetch(url, opts = {}) {
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
  if (!cachedToken) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(cachedToken)}`;
}
