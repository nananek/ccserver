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
import { defangFooterMarker } from './notify.js';

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
// Every push payload is sanitized HERE, whatever produced it. The pty bridge
// already hands over single-line, control-stripped text, but the `notify` MCP
// tool does not: its title and body are whatever the agent passed, and a final
// attacker review caught them reaching the payload verbatim -- newlines, a
// forged "_from:" line and all. Doing it at this one choke point is what makes
// the guarantee true for BOTH paths rather than only the one that was designed
// for it.
//
// Newlines survive (unlike in the detector): a push body is rendered
// multi-line by showNotification, and that is genuinely useful for an agent's
// own message. What does not survive is anything that lets the text pretend to
// be ccserver speaking -- the footer marker -- or anything invisible.
const PUSH_CONTROL_RE = new RegExp('[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f]', 'g');
const PUSH_INVISIBLE_RE = new RegExp('[\\u00ad\\u061c\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff]', 'g');
// A lone surrogate survives JSON.stringify as an escape but renders as U+FFFD
// and can break stricter consumers; replace it rather than ship it.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function sanitizePushText(value, { maxCodePoints }) {
  let text = String(value ?? '')
    .replace(PUSH_CONTROL_RE, ' ')
    .replace(PUSH_INVISIBLE_RE, '')
    .replace(LONE_SURROGATE_RE, '\uFFFD');
  text = defangFooterMarker(text);
  const cps = Array.from(text);
  if (cps.length > maxCodePoints) text = `${cps.slice(0, maxCodePoints - 1).join('')}\u2026`;
  return text.trim();
}

// Matches the detector's own caps so a bridge notification is not re-truncated
// to a different length than a Discord one.
const PUSH_TITLE_MAX = 200;
const PUSH_BODY_MAX = 2000;

function buildPayload({ title, body, level, attribution, tag, url }) {
  const payload = {
    title: sanitizePushText(title ?? 'ccserver', { maxCodePoints: PUSH_TITLE_MAX }) || 'ccserver',
    body: sanitizePushText(body, { maxCodePoints: PUSH_BODY_MAX }),
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
  //
  // Trimming by CODE POINT, not by UTF-16 unit: an attacker review found this
  // loop re-introducing the very lone surrogates sanitizePushText had just
  // replaced, because slicing `over` units off the end can land in the middle
  // of a surrogate pair ('🎉'x1900 + 'a'x200 lost a low surrogate in 14 of 400
  // random bodies). Dropping whole code points cannot split a pair.
  //
  // But the AMOUNT to drop is a count of BYTES, and a later review caught this
  // loop spending it as a count of CODE POINTS. Every Japanese character frees
  // three bytes, so "drop `over` code points" over-trimmed threefold and then
  // compounded across iterations: a 1900-character Japanese body came out at
  // 110 characters, 1950 at 10, and anything past 1955 at the ellipsis alone --
  // 87 bytes spent of a 3993-byte budget. Emoji (4 bytes) failed the same way
  // from 1303 characters up. So measure each code point as it goes and stop as
  // soon as the overshoot is covered.
  //
  // This cannot under-shoot: JSON escaping only ever makes a code point longer
  // than its UTF-8 form (an unescaped non-ASCII character serializes as itself),
  // so freeing `over` UTF-8 bytes removes at least `over` bytes of JSON. The
  // outer loop is still a loop because appending the ellipsis adds bytes back.
  const ELLIPSIS = '…';
  const cps = Array.from(payload.body);
  let trimmed = false;
  while (Buffer.byteLength(json, 'utf-8') > MAX_PAYLOAD_BYTES && cps.length > 0) {
    let over = Buffer.byteLength(json, 'utf-8') - MAX_PAYLOAD_BYTES;
    while (over > 0 && cps.length > 0) {
      over -= Buffer.byteLength(cps.pop(), 'utf-8');
    }
    payload.body = cps.join('');
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
