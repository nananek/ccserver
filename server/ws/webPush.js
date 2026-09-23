// Web Push transport (plan: plan-notify-bridge, Step 4): VAPID identification
// (RFC 8292), message encryption (RFC 8291 over the aes128gcm content coding
// of RFC 8188), and the POST to the push service (RFC 8030).
//
// Implemented directly on node:crypto rather than pulling in `web-push`. This
// repo hand-rolls its security-adjacent plumbing where it is a few well-
// understood lines (see server/index.js's CSP header block and
// authSessions.js's cookie handling for the same reasoning), and a dependency
// that gets handed the VAPID private key is not a small trust decision. The
// risk that trade buys -- that hand-rolled crypto is subtly wrong -- is paid
// off by webPush.test.js, which pins EVERY intermediate value and the final
// ciphertext against the official RFC 8291 test vector, plus the RFC 8292
// example JWT. If those pass, the wire format is right by construction.
//
// The algorithm, for review (RFC 8291 §3.4 then RFC 8188 §2.2):
//
//   ecdh_secret = ECDH(as_private, ua_public)
//   PRK_key     = HMAC-SHA-256(auth_secret, ecdh_secret)
//   key_info    = "WebPush: info" || 0x00 || ua_public || as_public
//   IKM         = HMAC-SHA-256(PRK_key, key_info || 0x01)
//   PRK         = HMAC-SHA-256(salt, IKM)
//   CEK         = HMAC-SHA-256(PRK, "Content-Encoding: aes128gcm" || 0x00 || 0x01)[0..15]
//   NONCE       = HMAC-SHA-256(PRK, "Content-Encoding: nonce"    || 0x00 || 0x01)[0..11]
//
// and the body is
//
//   salt(16) || rs(4, big-endian) || idlen(1) || as_public(65) || AES-128-GCM(plaintext || 0x02)
//
// where 0x02 is the last-record padding delimiter (RFC 8188 §2): ccserver
// always sends exactly one record, so there is no record-splitting logic here
// at all -- a payload larger than the record size is refused instead.

import {
  createECDH,
  createHmac,
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as signRaw,
  verify as verifyRaw,
} from 'node:crypto';
import { getSsrfSafeDispatcher } from './notify.js';

const CURVE = 'prime256v1';
// RFC 8188's record size. 4096 matches the RFC 8291 example and is what every
// push service accepts; the practical payload ceiling is this minus the
// 86-byte header, the 16-byte GCM tag and the 1-byte delimiter.
export const RECORD_SIZE = 4096;
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - 86 - 16 - 1;

const PUSH_TIMEOUT_MS = 10_000;
// RFC 8292 caps `exp` at 24h out. 12h leaves room for clock skew in both
// directions while still being a short-lived credential.
const JWT_TTL_SECONDS = 12 * 60 * 60;

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (str) => Buffer.from(String(str), 'base64url');

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

// HKDF-Expand with a single output block, which is all any step here needs
// (every output is <= 32 bytes). Written out rather than using
// crypto.hkdfSync so the intermediate values line up 1:1 with RFC 8291's
// Appendix A and can be asserted individually.
function hkdfExpandOneBlock(prk, info, length) {
  return hmac(prk, Buffer.concat([Buffer.from(info), Buffer.from([1])])).subarray(0, length);
}

// --- VAPID (RFC 8292) --------------------------------------------------------

// A P-256 keypair, stored (and served to browsers) in the shapes each side
// wants: the public key as the uncompressed EC point browsers pass as
// `applicationServerKey`, the private key as the bare `d` scalar.
export function generateVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: CURVE });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  return {
    publicKey: b64u(uncompressedPoint(pubJwk)),
    privateKey: privJwk.d,
  };
}

// 0x04 || X(32) || Y(32) -- the "uncompressed form [X9.62]" both RFCs use.
function uncompressedPoint(jwk) {
  return Buffer.concat([Buffer.from([0x04]), unb64u(jwk.x), unb64u(jwk.y)]);
}

// Rebuild a signing key from the stored private scalar. The public half is
// recomputed from it (via ECDH's point multiplication) so only `d` has to be
// persisted, and a mismatched stored public key can never silently sign with
// the wrong identity.
export function vapidKeyPair(privateKeyB64u) {
  const d = unb64u(privateKeyB64u);
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey(); // uncompressed
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: b64u(d),
    x: b64u(point.subarray(1, 33)),
    y: b64u(point.subarray(33, 65)),
  };
  return {
    privateKey: createPrivateKey({ key: jwk, format: 'jwk' }),
    publicKeyB64u: b64u(point),
    jwk,
  };
}

// The JWT RFC 8292 §2 describes. Claim order is aud, exp, sub -- the order the
// RFC's own example encodes, so the test can compare the encoded body byte for
// byte rather than re-parsing it.
export function buildVapidJwt({ audience, subject, privateKeyB64u, now = Date.now() }) {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(now / 1000) + JWT_TTL_SECONDS,
    sub: subject,
  })));
  const signingInput = `${header}.${body}`;
  const { privateKey } = vapidKeyPair(privateKeyB64u);
  // ES256 signatures are the raw r||s pair, not the DER structure Node emits
  // by default.
  const sig = signRaw('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64u(sig)}`;
}

export function verifyVapidJwt(token, publicKeyB64u) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return false;
  const point = unb64u(publicKeyB64u);
  if (point.length !== 65 || point[0] !== 0x04) return false;
  const key = createPublicKey({
    key: {
      kty: 'EC', crv: 'P-256',
      x: b64u(point.subarray(1, 33)),
      y: b64u(point.subarray(33, 65)),
    },
    format: 'jwk',
  });
  return verifyRaw('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, unb64u(parts[2]));
}

// The `aud` of the JWT is the push service's ORIGIN, not the full endpoint --
// the endpoint path is the subscription secret and must not travel in a token
// that the push service logs.
export function audienceFor(endpoint) {
  const u = new URL(endpoint);
  return `${u.protocol}//${u.host}`;
}

export function buildVapidHeaders({ endpoint, subject, keys, now = Date.now() }) {
  const token = buildVapidJwt({
    audience: audienceFor(endpoint), subject, privateKeyB64u: keys.privateKey, now,
  });
  return { Authorization: `vapid t=${token}, k=${keys.publicKey}` };
}

// --- payload encryption (RFC 8291 / RFC 8188) --------------------------------

/**
 * Encrypt one push message into a complete aes128gcm body.
 * `salt` and `asKeys` are injectable purely so the RFC's test vector can be
 * reproduced exactly; production callers omit both and get fresh randomness.
 */
export function encryptPayload({
  payload, p256dh, auth, salt = randomBytes(16), asPrivateKey = null, recordSize = RECORD_SIZE,
}) {
  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf-8');
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`push payload is ${plaintext.length} bytes, over the ${MAX_PAYLOAD_BYTES}-byte limit for one record`);
  }
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('subscription p256dh is not an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('subscription auth secret must be 16 bytes');

  const ecdh = createECDH(CURVE);
  let asPublic;
  if (asPrivateKey) {
    ecdh.setPrivateKey(unb64u(asPrivateKey));
    asPublic = ecdh.getPublicKey();
  } else {
    asPublic = ecdh.generateKeys();
  }

  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf-8'), uaPublic, asPublic]);
  const ikm = hkdfExpandOneBlock(prkKey, keyInfo, 32);

  const prk = hmac(salt, ikm);
  const cek = hkdfExpandOneBlock(prk, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdfExpandOneBlock(prk, 'Content-Encoding: nonce\0', 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 = "this is the last record" (RFC 8188 §2). ccserver never splits a
  // message across records, so it is always this and never 0x01.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final()]);
  const ciphertext = Buffer.concat([body, cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(recordSize, 0);
  const header = Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic]);

  return {
    body: Buffer.concat([header, ciphertext]),
    // Exposed for the RFC-vector test; nothing in production reads these.
    intermediates: { ecdhSecret, prkKey, ikm, prk, cek, nonce, header, ciphertext, asPublic },
  };
}

// --- delivery (RFC 8030) -----------------------------------------------------

// A push endpoint is a public web service (FCM, Mozilla autopush, WNS), but the
// endpoint string is supplied by whatever called POST /api/push/subscriptions.
// That is an authenticated browser rather than a sandboxed agent, so the threat
// is smaller than notify.js's `subscribe` tool -- but it is the same shape, so
// it gets the same two-layer treatment: https-only with literal private IPs
// rejected at registration (see pushSubscriptions.js), and the SSRF-safe
// dispatcher, which re-checks at actual connect time, here.
export async function deliverPush({
  subscription, payload, vapidKeys, subject, ttl = 2419200, urgency = 'normal',
  now = Date.now(), fetchImpl = null,
}) {
  const doFetch = fetchImpl || globalThis.fetch;
  let encrypted;
  try {
    encrypted = encryptPayload({ payload, p256dh: subscription.p256dh, auth: subscription.auth });
  } catch (err) {
    return { ok: false, gone: false, status: 0, error: `encrypt failed: ${err.message}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    const res = await doFetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        ...buildVapidHeaders({ endpoint: subscription.endpoint, subject, keys: vapidKeys, now }),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: urgency,
      },
      body: encrypted.body,
      signal: controller.signal,
      // Same posture as notify.js's webhook delivery: never follow a redirect
      // (it could point somewhere the endpoint check never saw), and validate
      // the resolved address at connect time.
      redirect: 'error',
      dispatcher: fetchImpl ? undefined : getSsrfSafeDispatcher(),
    });
    // RFC 8030 §7.3: 404 means the subscription never existed, 410 that it has
    // expired. Both are permanent -- the row is dropped rather than retried.
    return { ok: res.ok, gone: res.status === 404 || res.status === 410, status: res.status };
  } catch (err) {
    return { ok: false, gone: false, status: 0, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}
