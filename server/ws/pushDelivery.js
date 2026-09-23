// Fan-out of one notification to every registered browser (plan:
// plan-notify-bridge, Step 4). Sits between notify.js's sendNotification and
// the per-subscription crypto in webPush.js.
//
// notify.js reaches this through a LAZY dynamic import, deliberately: this
// module pulls in pushSubscriptions.js and webPush.js, and both of those
// import notify.js (for the private-address classifier and the SSRF-safe
// dispatcher respectively). Loading it lazily keeps the static import graph
// acyclic -- the same trick notify.js already documents for mcpBroker.js.
//
// A push payload is not the Discord `content` string: the browser needs the
// title and body as separate fields so the Service Worker can pass them to
// showNotification(). The attribution that notify.js appends as a "_from:"
// footer is carried here as its own field instead, so the Service Worker can
// render it as the notification's body-tail rather than as part of the text.

import {
  listSubscriptionsForDelivery,
  pruneSubscription,
  markDelivered,
  ensureVapidKeys,
  countSubscriptions,
} from './pushSubscriptions.js';
import { deliverPush, MAX_PAYLOAD_BYTES } from './webPush.js';

// RFC 8292 §2.1: `sub` must be a mailto: or https: URI identifying whoever
// operates the application server, so a push service has someone to contact
// about a misbehaving sender. Nothing about it is authenticated, and it is
// deliberately NOT the operator's own address by default -- ccserver has no
// business inventing a contact address for its user, and putting a personal
// address into a header sent to Google/Mozilla is not a default anyone opted
// into. Override with CCSERVER_VAPID_SUBJECT if you want to be reachable.
const DEFAULT_VAPID_SUBJECT = 'https://github.com/nananek/ccserver';

export function vapidSubject() {
  const configured = process.env.CCSERVER_VAPID_SUBJECT;
  if (typeof configured === 'string' && /^(mailto:|https:\/\/)/.test(configured)) return configured;
  return DEFAULT_VAPID_SUBJECT;
}

export function webpushConfigured() {
  try {
    return countSubscriptions() > 0;
  } catch {
    // The DB may not be initialized yet (boot ordering, tests) -- "no
    // subscriptions" is the right answer either way.
    return false;
  }
}

// Keep the encrypted record inside one aes128gcm block. Titles and bodies are
// already bounded upstream (agentNotifyDetect caps them, the notify MCP tool's
// arguments are bounded by the transport), so this is a backstop rather than
// the primary limit -- but a payload that cannot be encrypted would otherwise
// fail per-subscription with a confusing error.
function buildPayload({ title, body, level, attribution, tag, url }) {
  const payload = {
    title: String(title ?? 'ccserver'),
    body: String(body ?? ''),
    level: level || 'info',
    attribution: attribution || null,
    tag: tag || 'ccserver',
    url: url || '/',
  };
  let json = JSON.stringify(payload);
  // Trim the body until the SERIALIZED form fits. Computing the overshoot once
  // is not enough: JSON escaping and multi-byte characters mean a character
  // removed is not always a byte removed, so this converges instead of
  // guessing. The body is the only field that can plausibly be long.
  const ELLIPSIS = '…';
  let trimmed = false;
  while (Buffer.byteLength(json, 'utf-8') > MAX_PAYLOAD_BYTES && payload.body.length > 0) {
    const over = Buffer.byteLength(json, 'utf-8') - MAX_PAYLOAD_BYTES;
    payload.body = payload.body.slice(0, Math.max(0, payload.body.length - Math.max(1, over)));
    trimmed = true;
    json = JSON.stringify({ ...payload, body: payload.body + ELLIPSIS });
  }
  if (trimmed) payload.body += ELLIPSIS;
  return JSON.stringify(payload);
}

/**
 * Deliver to every subscription. Never throws: a push failure must not change
 * what the caller reports for the other channels.
 * @returns {{sent: number, failed: number, pruned: number}}
 */
export async function deliverToSubscribers(notification, deps = {}) {
  const list = deps.listSubscriptions ? deps.listSubscriptions() : listSubscriptionsForDelivery();
  if (list.length === 0) return { sent: 0, failed: 0, pruned: 0 };

  let keys;
  try {
    keys = deps.vapidKeys || ensureVapidKeys();
  } catch (err) {
    console.warn(`[push] cannot deliver: VAPID keys unavailable (${err?.message || err})`);
    return { sent: 0, failed: list.length, pruned: 0 };
  }

  const payload = buildPayload(notification);
  const send = deps.deliverPush || deliverPush;
  const subject = vapidSubject();

  const results = await Promise.all(list.map(async (sub) => {
    const res = await send({ subscription: sub, payload, vapidKeys: keys, subject });
    if (res.ok) {
      try { (deps.markDelivered || markDelivered)(sub.id); } catch { /* bookkeeping only */ }
      return 'sent';
    }
    if (res.gone) {
      // RFC 8030: 404/410 are permanent. Dropping the row is the only way the
      // table does not fill with dead endpoints as browsers are reinstalled.
      try { (deps.pruneSubscription || pruneSubscription)(sub.id, `push service returned ${res.status}`); } catch { /* ignore */ }
      return 'pruned';
    }
    console.warn(`[push] delivery to subscription ${sub.id} failed: ${res.error || `HTTP ${res.status}`}`);
    return 'failed';
  }));

  return {
    sent: results.filter((r) => r === 'sent').length,
    failed: results.filter((r) => r === 'failed').length,
    pruned: results.filter((r) => r === 'pruned').length,
  };
}
