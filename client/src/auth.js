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

export async function authFetch(url, opts = {}) {
  if (cachedToken) {
    opts.headers = { ...opts.headers, Authorization: `Bearer ${cachedToken}` };
  }
  const res = await fetch(url, opts);
  if (res.status === 401) {
    const token = prompt('Token required:');
    if (token) {
      setToken(token);
      opts.headers = { ...opts.headers, Authorization: `Bearer ${token}` };
      return fetch(url, opts);
    }
  }
  return res;
}

export function authWsUrl(url) {
  if (!cachedToken) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(cachedToken)}`;
}
