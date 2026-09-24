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
//
// WHICH FIELDS ARE TRUSTWORTHY, precisely -- an earlier version of this comment
// claimed the title is always server-composed, and an attacker review showed
// that is only true of one of the two paths:
//
//   attribution  ALWAYS server-set. The host / project / session the
//                notification really came from. This is the trust anchor.
//   title        server-composed for a notification the pty bridge captured
//                ("<app> · <project>"); AGENT-CHOSEN for one an agent sent
//                itself through the `notify` MCP tool. So a title alone does
//                not tell you who is speaking -- read `attribution` for that.
//   body         agent text in both cases.
//
// Both paths are sanitized server-side before they get here (control and
// invisible characters removed, the "_from:" footer marker defanged so the
// text cannot impersonate ccserver's own attribution line, lengths capped),
// but sanitized is not the same as trusted.

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

  // Defence in depth: resolve the payload's url against our own origin and
  // refuse anything that lands elsewhere. Nothing currently sets `url` to
  // anything but '/', but the field travels inside an agent-influenced
  // payload, and "open any site on notification click" is not a capability
  // worth leaving one refactor away.
  let target = new URL('/', self.location.origin);
  try {
    const requested = new URL(event.notification.data?.url || '/', self.location.origin);
    if (requested.origin === self.location.origin) target = requested;
  } catch {
    // keep the root fallback
  }

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
