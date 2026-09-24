// webPush.js -- VAPID (RFC 8292) and payload encryption (RFC 8291 over the
// aes128gcm coding of RFC 8188).
//
// This suite is the justification for implementing the crypto here instead of
// depending on `web-push`: it pins the implementation against the RFCs' own
// published test vectors, every intermediate value included. If a refactor
// breaks the wire format, one of these fails with the exact step that drifted
// rather than with "the push service returned 400".
//
// Vectors transcribed from:
//   RFC 8291 §5 + Appendix A  (encryption, with all intermediates)
//   RFC 8292 §2.4 Figure 1/2  (the VAPID Authorization header and its JWT)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createHmac, createDecipheriv } from 'node:crypto';
import {
  encryptPayload,
  buildVapidJwt,
  verifyVapidJwt,
  vapidKeyPair,
  generateVapidKeys,
  buildVapidHeaders,
  audienceFor,
  deliverPush,
  validateDeliveryEndpoint,
  b64u,
  unb64u,
  MAX_PAYLOAD_BYTES,
} from './webPush.js';

// --- RFC 8291 §5 / Appendix A ------------------------------------------------

const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  // Appendix A intermediates
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  prkKey: 'Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  prk: '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  // §5: the complete request body
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

function encryptRfcVector() {
  return encryptPayload({
    payload: RFC8291.plaintext,
    p256dh: RFC8291.uaPublic,
    auth: RFC8291.authSecret,
    salt: unb64u(RFC8291.salt),
    asPrivateKey: RFC8291.asPrivate,
  });
}

test('RFC 8291: the complete encrypted body matches the published example', () => {
  const { body } = encryptRfcVector();
  assert.equal(b64u(body), RFC8291.body);
});

test('RFC 8291 Appendix A: every intermediate value matches', () => {
  const { intermediates: iv } = encryptRfcVector();
  assert.equal(b64u(iv.ecdhSecret), RFC8291.ecdhSecret, 'ecdh_secret');
  assert.equal(b64u(iv.prkKey), RFC8291.prkKey, 'PRK_key');
  assert.equal(b64u(iv.ikm), RFC8291.ikm, 'IKM');
  assert.equal(b64u(iv.prk), RFC8291.prk, 'PRK');
  assert.equal(b64u(iv.cek), RFC8291.cek, 'CEK');
  assert.equal(b64u(iv.nonce), RFC8291.nonce, 'NONCE');
  assert.equal(b64u(iv.header), RFC8291.header, 'header');
  assert.equal(b64u(iv.ciphertext), RFC8291.ciphertext, 'ciphertext');
});

test('RFC 8291: the header is the documented 86 octets and carries the sender key', () => {
  const { intermediates: iv } = encryptRfcVector();
  assert.equal(iv.header.length, 86);
  assert.equal(iv.header.subarray(0, 16).toString('base64url'), RFC8291.salt, 'salt first');
  assert.equal(iv.header.readUInt32BE(16), 4096, 'record size');
  assert.equal(iv.header[20], 65, 'key id length');
  assert.equal(b64u(iv.header.subarray(21)), RFC8291.asPublic, 'the application server public key');
});

test('the receiver can actually decrypt what we produce', () => {
  // The RFC vector proves byte equality against a fixed sender key; this
  // proves the same pipeline works with a RANDOM ephemeral key, by running the
  // receiver half (which is what a browser does) and recovering the plaintext.
  const { body } = encryptPayload({
    payload: 'hello from ccserver',
    p256dh: RFC8291.uaPublic,
    auth: RFC8291.authSecret,
  });
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);

  const ua = createECDH('prime256v1');
  ua.setPrivateKey(unb64u(RFC8291.uaPrivate));
  const shared = ua.computeSecret(asPublic);
  const hmac = (k, d) => createHmac('sha256', k).update(d).digest();
  const expand = (prk, info, len) => hmac(prk, Buffer.concat([Buffer.from(info), Buffer.from([1])])).subarray(0, len);
  const prkKey = hmac(unb64u(RFC8291.authSecret), shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), unb64u(RFC8291.uaPublic), asPublic]);
  const prk = hmac(salt, expand(prkKey, keyInfo, 32));
  const cek = expand(prk, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = expand(prk, 'Content-Encoding: nonce\0', 12);

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const out = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  assert.equal(out[out.length - 1], 0x02, 'last-record padding delimiter');
  assert.equal(out.subarray(0, out.length - 1).toString('utf-8'), 'hello from ccserver');
});

test('each encryption uses a fresh salt and ephemeral key', () => {
  const a = encryptPayload({ payload: 'x', p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret });
  const b = encryptPayload({ payload: 'x', p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret });
  assert.notEqual(b64u(a.body.subarray(0, 16)), b64u(b.body.subarray(0, 16)), 'salt must not repeat');
  assert.notEqual(b64u(a.intermediates.asPublic), b64u(b.intermediates.asPublic), 'ephemeral key must not repeat');
});

test('malformed subscription keys are rejected, not silently mis-encrypted', () => {
  assert.throws(() => encryptPayload({ payload: 'x', p256dh: b64u(Buffer.alloc(65)), auth: RFC8291.authSecret }),
    /uncompressed P-256 point/, 'a point that does not start with 0x04');
  assert.throws(() => encryptPayload({ payload: 'x', p256dh: b64u(Buffer.alloc(10)), auth: RFC8291.authSecret }),
    /uncompressed P-256 point/, 'wrong length');
  assert.throws(() => encryptPayload({ payload: 'x', p256dh: RFC8291.uaPublic, auth: b64u(Buffer.alloc(8)) }),
    /auth secret must be 16 bytes/);
});

test('an oversized payload is refused rather than silently truncated', () => {
  assert.throws(
    () => encryptPayload({ payload: 'x'.repeat(MAX_PAYLOAD_BYTES + 1), p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret }),
    /over the .* limit for one record/,
  );
  assert.doesNotThrow(
    () => encryptPayload({ payload: 'x'.repeat(MAX_PAYLOAD_BYTES), p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret }),
  );
});

// --- RFC 8292 §2.4 -----------------------------------------------------------

const RFC8292 = {
  jwt: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA',
  k: 'BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs',
  x: 'DUfHPKLVFQzVvnCPGyfucbECzPDa7rWbXriLcysAjEc',
  y: 'F6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs',
  aud: 'https://push.example.net',
  sub: 'mailto:push@example.com',
  exp: 1453523768,
};

test("RFC 8292: the example's own JWT verifies against the example's key", () => {
  // This exercises the verify path end to end -- JWK import, the uncompressed
  // point split, and the raw r||s signature encoding -- against a signature
  // this code did not produce. ES256 is randomized, so re-signing could never
  // reproduce the RFC's bytes; verifying them is the check that is possible.
  assert.equal(verifyVapidJwt(RFC8292.jwt, RFC8292.k), true);
});

test('RFC 8292: the example key is 0x04 || x || y', () => {
  const point = unb64u(RFC8292.k);
  assert.equal(point.length, 65);
  assert.equal(point[0], 0x04);
  assert.equal(b64u(point.subarray(1, 33)), RFC8292.x);
  assert.equal(b64u(point.subarray(33, 65)), RFC8292.y);
});

test('RFC 8292: our header and claims encode exactly as the example does', () => {
  const keys = generateVapidKeys();
  // exp is `now + 12h`, so pin `now` to land on the example's exp.
  const now = (RFC8292.exp - 12 * 60 * 60) * 1000;
  const jwt = buildVapidJwt({
    audience: RFC8292.aud, subject: RFC8292.sub, privateKeyB64u: keys.privateKey, now,
  });
  const [header, body] = jwt.split('.');
  const [rfcHeader, rfcBody] = RFC8292.jwt.split('.');
  assert.equal(header, rfcHeader, 'the JOSE header must be byte-identical');
  assert.equal(body, rfcBody, 'claim names, order and values must be byte-identical');
});

test('a signature we produce verifies, and is the 64-byte P-1363 form', () => {
  const keys = generateVapidKeys();
  const jwt = buildVapidJwt({ audience: RFC8292.aud, subject: RFC8292.sub, privateKeyB64u: keys.privateKey });
  assert.equal(verifyVapidJwt(jwt, keys.publicKey), true);
  assert.equal(unb64u(jwt.split('.')[2]).length, 64, 'r||s, not DER');
  const other = generateVapidKeys();
  assert.equal(verifyVapidJwt(jwt, other.publicKey), false, 'another key must not verify it');
});

test('the public key is recomputed from the stored private scalar', () => {
  // Only `d` is persisted; a stored public key that disagreed would otherwise
  // let the server advertise one identity and sign with another.
  const keys = generateVapidKeys();
  assert.equal(vapidKeyPair(keys.privateKey).publicKeyB64u, keys.publicKey);
});

test('a tampered JWT does not verify', () => {
  const keys = generateVapidKeys();
  const jwt = buildVapidJwt({ audience: RFC8292.aud, subject: RFC8292.sub, privateKeyB64u: keys.privateKey });
  const [h, b, s] = jwt.split('.');
  const forged = b64u(Buffer.from(JSON.stringify({ aud: 'https://evil.example', exp: 1, sub: 'mailto:x@y' })));
  assert.equal(verifyVapidJwt(`${h}.${forged}.${s}`, keys.publicKey), false);
  assert.equal(verifyVapidJwt('not.a.jwt', keys.publicKey), false);
  assert.equal(verifyVapidJwt('onlyonepart', keys.publicKey), false);
});

test('the audience is the push service origin, never the endpoint path', () => {
  // The path IS the subscription secret; it must not end up inside a token the
  // push service can log.
  assert.equal(audienceFor('https://push.example.net/p/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV'), 'https://push.example.net');
  assert.equal(audienceFor('https://fcm.googleapis.com:443/fcm/send/abc'), 'https://fcm.googleapis.com');
});

test('the Authorization header is the vapid scheme with t and k', () => {
  const keys = generateVapidKeys();
  const { Authorization } = buildVapidHeaders({
    endpoint: 'https://push.example.net/p/secret', subject: 'mailto:ops@example.com', keys,
  });
  const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(Authorization);
  assert.ok(m, `unexpected header: ${Authorization}`);
  assert.equal(m[2], keys.publicKey);
  assert.equal(verifyVapidJwt(m[1], keys.publicKey), true);
  assert.ok(!Authorization.includes('secret'), 'the endpoint path must not leak into the header');
});

// --- delivery ----------------------------------------------------------------

const SUB = {
  endpoint: 'https://push.example.net/p/abc',
  p256dh: RFC8291.uaPublic,
  auth: RFC8291.authSecret,
};

test('delivery sends the aes128gcm body with the RFC 8030 headers', async () => {
  const keys = generateVapidKeys();
  let seen = null;
  const res = await deliverPush({
    subscription: SUB, payload: 'hi', vapidKeys: keys, subject: 'mailto:ops@example.com',
    fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true, status: 201 }; },
  });
  assert.deepEqual(res, { ok: true, gone: false, status: 201 });
  assert.equal(seen.url, SUB.endpoint);
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(seen.opts.headers['Content-Type'], 'application/octet-stream');
  assert.equal(seen.opts.headers.TTL, '2419200');
  assert.equal(seen.opts.headers.Urgency, 'normal');
  assert.match(seen.opts.headers.Authorization, /^vapid t=/);
  assert.equal(seen.opts.redirect, 'error', 'a redirect must never be followed');
  assert.ok(Buffer.isBuffer(seen.opts.body));
  assert.equal(seen.opts.body.readUInt32BE(16), 4096, 'the body is a well-formed aes128gcm record');
});

test('404 and 410 report the subscription as gone, other failures do not', async () => {
  const keys = generateVapidKeys();
  const call = (status) => deliverPush({
    subscription: SUB, payload: 'hi', vapidKeys: keys, subject: 'mailto:ops@example.com',
    fetchImpl: async () => ({ ok: false, status }),
  });
  assert.equal((await call(404)).gone, true, 'never existed');
  assert.equal((await call(410)).gone, true, 'expired');
  assert.equal((await call(429)).gone, false, 'rate limited -- keep the subscription');
  assert.equal((await call(500)).gone, false, 'server error -- keep the subscription');
});

test('a network failure is reported, never thrown', async () => {
  const keys = generateVapidKeys();
  const res = await deliverPush({
    subscription: SUB, payload: 'hi', vapidKeys: keys, subject: 'mailto:ops@example.com',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(res.ok, false);
  assert.equal(res.gone, false, 'a transport failure must not delete the subscription');
  assert.match(res.error, /ECONNREFUSED/);
});

test('an unencryptable subscription fails without deleting it', async () => {
  const keys = generateVapidKeys();
  let called = false;
  const res = await deliverPush({
    subscription: { ...SUB, auth: b64u(Buffer.alloc(4)) },
    payload: 'hi', vapidKeys: keys, subject: 'mailto:ops@example.com',
    fetchImpl: async () => { called = true; return { ok: true, status: 201 }; },
  });
  assert.equal(res.ok, false);
  assert.equal(res.gone, false);
  assert.match(res.error, /encrypt failed/);
  assert.equal(called, false, 'nothing is sent when the payload cannot be built');
});

// --- attacker-review regressions (attack-review-webpush-3fcddf7) -------------

test('F5: a malformed VAPID private scalar is refused, not silently used', () => {
  // A 1-byte "key" (d=1) used to produce a perfectly valid-looking signing
  // identity -- guessable, and indistinguishable from a real one downstream.
  for (const bad of ['AQ', '', b64u(Buffer.alloc(32)), b64u(Buffer.alloc(33, 1)), '!!!not-base64!!!']) {
    assert.throws(() => vapidKeyPair(bad), /32-byte scalar|must not be zero|out of range/,
      `d=${JSON.stringify(bad)} must be rejected`);
  }
  // The order itself is out of range (valid scalars are 1 .. n-1).
  const order = Buffer.from('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551', 'hex');
  assert.throws(() => vapidKeyPair(b64u(order)), /out of range/);
  // A real key still works.
  assert.doesNotThrow(() => vapidKeyPair(generateVapidKeys().privateKey));
});

test('F3: verification returns false rather than throwing on a bad key', () => {
  const offCurve = b64u(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]));
  const keys = generateVapidKeys();
  const jwt = buildVapidJwt({ audience: 'https://push.example.net', subject: 'mailto:a@b.c', privateKeyB64u: keys.privateKey });
  assert.equal(verifyVapidJwt(jwt, offCurve), false, 'an off-curve key must not throw');
  assert.equal(verifyVapidJwt(jwt, 'not-base64!!'), false);
  assert.equal(verifyVapidJwt(null, keys.publicKey), false);
});

test('F3: exp and aud are checked when asked for', () => {
  const keys = generateVapidKeys();
  const now = 1_700_000_000_000;
  const jwt = buildVapidJwt({
    audience: 'https://push.example.net', subject: 'mailto:a@b.c', privateKeyB64u: keys.privateKey, now,
  });
  assert.equal(verifyVapidJwt(jwt, keys.publicKey), true, 'signature only, as before');
  assert.equal(verifyVapidJwt(jwt, keys.publicKey, { now: now + 1000 }), true, 'still fresh');
  assert.equal(verifyVapidJwt(jwt, keys.publicKey, { now: now + 13 * 60 * 60 * 1000 }), false, 'expired');
  assert.equal(verifyVapidJwt(jwt, keys.publicKey, { audience: 'https://push.example.net' }), true);
  assert.equal(verifyVapidJwt(jwt, keys.publicKey, { audience: 'https://evil.example' }), false);
});

test('F6: a recordSize that cannot hold the payload is refused', () => {
  // The header advertises `rs`; a record that overflows it is unparseable for
  // the receiver, so this used to produce a silently-broken message.
  assert.throws(
    () => encryptPayload({ payload: 'x'.repeat(500), p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret, recordSize: 100 }),
    /cannot hold a 500-byte payload/,
  );
  assert.doesNotThrow(
    () => encryptPayload({ payload: 'x'.repeat(500), p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret, recordSize: 517 }),
  );
});
