// Web Push state: the host's VAPID identity and the browsers subscribed to it
// (plan: plan-notify-bridge, Step 4). Backed by the host-singleton SQLite DB
// (see db.js migration v10), not a .saved-*.json sidecar, because one of these
// is a private key and all of it must survive a `git clean` of the checkout.
//
// Registration validates the endpoint the same way notify.js validates a
// subscribed webhook URL: https only, and a literal private/loopback/reserved
// IP host is refused outright. That check is weaker here in threat terms (the
// caller is an authenticated browser, not a sandboxed agent) but it is exactly
// the same shape of request -- "store a URL the server will later POST to" --
// so it gets the same treatment. The connect-time half lives in webPush.js's
// deliverPush, which uses notify.js's SSRF-safe dispatcher.

import { randomUUID, createPublicKey } from 'node:crypto';
import { getDb } from '../db.js';
import { isPrivateOrReservedAddress, isIpLiteralHost } from './notify.js';
import { generateVapidKeys } from './webPush.js';

// A label/user-agent is only ever shown back to the operator in the Settings
// list, so it needs no more than a sane bound and no control characters.
const LABEL_MAX = 80;
const UA_MAX = 255;
// Endpoints are long (FCM's carry a large token) but not unbounded.
const ENDPOINT_MAX = 2048;
// base64url of 65 and 16 raw bytes respectively, with a little slack.
const P256DH_MAX = 128;
const AUTH_MAX = 64;
// Attacker review F4: an authenticated client could register unbounded
// distinct endpoints. A human has a handful of devices; this is generous for
// that and still bounds the table (and the fan-out of every notification).
export const MAX_SUBSCRIPTIONS = 32;

// Labels and user agents are rendered in the operator's settings list. React
// escapes markup, but bidi overrides reorder what is displayed, so they are
// stripped here alongside the control characters (attacker review F6).
const INVISIBLE_RE = new RegExp('[\\u00ad\\u061c\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff]', 'g');

function clean(value, max) {
  if (typeof value !== 'string') return null;
  const t = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(INVISIBLE_RE, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

// Same rule as notify.js's isValidWebhookUrl, kept as its own function because
// the failure messages differ (this one is shown to the operator's browser).
export function validateEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) return 'endpoint is required';
  if (endpoint.length > ENDPOINT_MAX) return `endpoint must be at most ${ENDPOINT_MAX} characters`;
  if (!endpoint.startsWith('https://')) return 'endpoint must be an https:// URL';
  let host;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return 'endpoint is not a valid URL';
  }
  // Hostname only (attacker review F1). Every real push service -- FCM,
  // Mozilla autopush, WNS -- is reached by name, so an IP literal is never
  // legitimate here. It is also the exact shape the connect-time SSRF guard
  // cannot see: undici never calls its `lookup` hook for a literal, so the
  // registration check is the ONLY layer for those. Refusing them outright
  // removes a whole class of bypass rather than trying to classify every
  // spelling of every private range.
  if (isIpLiteralHost(host)) return 'endpoint must use a hostname, not an IP literal';
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isPrivateOrReservedAddress(bare, bare.includes(':') ? 6 : 4)) {
    return 'endpoint must not be a private, loopback or reserved address';
  }
  return null;
}

// A 65-byte 0x04-prefixed blob is not necessarily a point ON the curve. An
// off-curve key used to be stored happily and then fail every delivery
// afterwards, with the browser having been told it succeeded.
//
// createPublicKey does the same curve validation OpenSSL already knows how to
// do, without ECDH.setPublicKey's DEP0031 deprecation warning (which fired on
// every registration, and which a future Node may turn into a removal).
function isOnCurveP256(uncompressed) {
  try {
    createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: uncompressed.subarray(1, 33).toString('base64url'),
        y: uncompressed.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
    return true;
  } catch {
    return false;
  }
}

// base64url, decoding to exactly the length RFC 8291 requires. Checked here
// rather than only at encrypt time so a malformed subscription is rejected
// while the browser is still there to be told about it, instead of failing
// silently on every later notification.
function validateKey(value, name, rawLength, max) {
  if (typeof value !== 'string' || value.length === 0) return `${name} is required`;
  if (value.length > max) return `${name} is too long`;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return `${name} must be base64url`;
  const raw = Buffer.from(value, 'base64url');
  if (raw.length !== rawLength) return `${name} must decode to ${rawLength} bytes`;
  if (name === 'p256dh') {
    if (raw[0] !== 0x04) return 'p256dh must be an uncompressed P-256 point';
    if (!isOnCurveP256(raw)) return 'p256dh is not a point on the P-256 curve';
  }
  return null;
}

// --- VAPID identity ----------------------------------------------------------

// Read the host's VAPID keypair, generating it on first use. Called at boot so
// the public key is ready before any browser asks for it, and idempotent so a
// concurrent call cannot mint a second identity (the CHECK (id = 1) plus
// INSERT OR IGNORE makes the first writer win).
export function ensureVapidKeys() {
  const db = getDb();
  const row = db.prepare('SELECT public_key, private_key FROM push_vapid WHERE id = 1').get();
  if (row) return { publicKey: row.public_key, privateKey: row.private_key };
  const keys = generateVapidKeys();
  db.prepare('INSERT OR IGNORE INTO push_vapid (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)')
    .run(keys.publicKey, keys.privateKey, Date.now());
  const after = db.prepare('SELECT public_key, private_key FROM push_vapid WHERE id = 1').get();
  return { publicKey: after.public_key, privateKey: after.private_key };
}

// The half a browser is allowed to see.
export function vapidPublicKey() {
  return ensureVapidKeys().publicKey;
}

// --- subscriptions -----------------------------------------------------------

function rowToPublic(row) {
  return {
    id: row.id,
    label: row.label,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastOkAt: row.last_ok_at,
    // The endpoint is the subscription's bearer secret -- anyone holding it
    // can push to that browser -- so it is never sent back to the client. Only
    // its origin is, which is enough to tell "this is my Firefox" apart from
    // "this is my phone's Chrome".
    endpointOrigin: (() => {
      try { return new URL(row.endpoint).origin; } catch { return null; }
    })(),
  };
}

export function listSubscriptions() {
  return getDb().prepare('SELECT * FROM push_subscriptions ORDER BY created_at ASC').all().map(rowToPublic);
}

// Everything delivery needs. Internal only -- carries the endpoint.
export function listSubscriptionsForDelivery() {
  return getDb().prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions ORDER BY created_at ASC').all();
}

export function countSubscriptions() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n;
}

/**
 * Register (or refresh) a browser subscription.
 * Re-subscribing the same browser yields the same endpoint, so the endpoint is
 * the identity: an existing row is updated in place rather than duplicated,
 * which is what keeps a page reload from growing the table.
 * @returns {{ok: true, subscription}|{ok: false, message: string}}
 */
export function addSubscription({ endpoint, p256dh, auth, label, userAgent }) {
  const endpointError = validateEndpoint(endpoint);
  if (endpointError) return { ok: false, message: endpointError };
  const keyError = validateKey(p256dh, 'p256dh', 65, P256DH_MAX) || validateKey(auth, 'auth', 16, AUTH_MAX);
  if (keyError) return { ok: false, message: keyError };

  const db = getDb();
  const now = Date.now();
  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  if (!existing && countSubscriptions() >= MAX_SUBSCRIPTIONS) {
    return { ok: false, message: `at most ${MAX_SUBSCRIPTIONS} devices can be subscribed; remove one first` };
  }
  if (existing) {
    db.prepare('UPDATE push_subscriptions SET p256dh = ?, auth = ?, label = ?, user_agent = ? WHERE id = ?')
      .run(p256dh, auth, clean(label, LABEL_MAX), clean(userAgent, UA_MAX), existing.id);
    return { ok: true, subscription: rowToPublic(db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(existing.id)) };
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, label, user_agent, created_at, last_ok_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
    .run(id, endpoint, p256dh, auth, clean(label, LABEL_MAX), clean(userAgent, UA_MAX), now);
  return { ok: true, subscription: rowToPublic(db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id)) };
}

export function removeSubscription(id) {
  const info = getDb().prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
  return info.changes > 0;
}

// Drop a subscription the push service reported as permanently gone (404/410).
// Separate from removeSubscription so the log line can say why.
export function pruneSubscription(id, reason) {
  if (removeSubscription(id)) {
    console.warn(`[push] dropped subscription ${id}: ${reason}`);
    return true;
  }
  return false;
}

export function markDelivered(id) {
  getDb().prepare('UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?').run(Date.now(), id);
}
