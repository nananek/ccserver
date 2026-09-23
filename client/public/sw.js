const CACHE_NAME = 'ccserver-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) {
    return;
  }

  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// --- Web Push (plan: plan-notify-bridge) -------------------------------------
//
// The payload is the JSON server/ws/pushDelivery.js builds:
//   { title, body, level, attribution, tag, url }
// `title` is always composed server-side (the agent cannot set it), `body` is
// the agent's own text, and `attribution` says which host/project/session it
// came from. Keeping them in separate fields is what lets the title stay
// trustworthy here rather than being spliced into one string upstream.

const LEVEL_BADGE = {
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  error: '🚨',
};

self.addEventListener('push', (event) => {
  // A push with no data, or with data that is not our JSON, still has to show
  // something: `userVisibleOnly: true` means the browser may show its own
  // generic "site updated in the background" notice if we show nothing at all.
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'ccserver';
  const badge = LEVEL_BADGE[payload.level] || '';
  const lines = [payload.body, payload.attribution].filter(Boolean);

  event.waitUntil(
    self.registration.showNotification(`${badge}${badge ? ' ' : ''}${title}`, {
      body: lines.join('\n'),
      // One notification per session replaces the previous one instead of
      // stacking -- otherwise a busy session buries the phone.
      tag: payload.tag || 'ccserver',
      renotify: true,
      timestamp: Date.now(),
      data: { url: payload.url || '/' },
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      // Prefer focusing a tab that is already open on this origin: opening a
      // second ccserver tab per notification would be its own kind of spam.
      for (const client of windows) {
        if (new URL(client.url).origin === target.origin && 'focus' in client) {
          if ('navigate' in client && client.url !== target.href) {
            return client.navigate(target.href).then((c) => (c || client).focus());
          }
          return client.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(target.href) : undefined;
    })
  );
});
