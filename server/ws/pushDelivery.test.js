// pushDelivery.js -- the fan-out from one notification to every subscribed
// browser. The crypto is covered by webPush.test.js against the RFC vectors;
// this suite is about the fan-out policy: what happens to a dead endpoint, a
// transient failure, an oversized payload, and how the result is reported.
//
// Every dependency is injected, so nothing here opens the database or a socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverToSubscribers, vapidSubject, sanitizePushText } from './pushDelivery.js';
import { MAX_PAYLOAD_BYTES } from './webPush.js';

const KEYS = { publicKey: 'BPub', privateKey: 'Priv' };
const SUBS = [
  { id: 's1', endpoint: 'https://push.example/1', p256dh: 'x', auth: 'y' },
  { id: 's2', endpoint: 'https://push.example/2', p256dh: 'x', auth: 'y' },
  { id: 's3', endpoint: 'https://push.example/3', p256dh: 'x', auth: 'y' },
];

function harness({ results = {}, subscriptions = SUBS } = {}) {
  const pruned = [];
  const delivered = [];
  const sent = [];
  return {
    pruned,
    delivered,
    sent,
    deps: {
      listSubscriptions: () => subscriptions,
      vapidKeys: KEYS,
      pruneSubscription: (id, reason) => pruned.push({ id, reason }),
      markDelivered: (id) => delivered.push(id),
      deliverPush: async ({ subscription, payload, subject, vapidKeys }) => {
        sent.push({ id: subscription.id, payload, subject, vapidKeys });
        return results[subscription.id] || { ok: true, gone: false, status: 201 };
      },
    },
  };
}

test('delivers to every subscription and records the successes', async () => {
  const h = harness();
  const res = await deliverToSubscribers({ title: 'T', body: 'B' }, h.deps);
  assert.deepEqual(res, { sent: 3, failed: 0, pruned: 0 });
  assert.deepEqual(h.sent.map((s) => s.id), ['s1', 's2', 's3']);
  assert.deepEqual(h.delivered, ['s1', 's2', 's3']);
});

test('a 404/410 subscription is pruned, the rest still get the message', async () => {
  const h = harness({
    results: {
      s2: { ok: false, gone: true, status: 410 },
    },
  });
  const res = await deliverToSubscribers({ title: 'T', body: 'B' }, h.deps);
  assert.deepEqual(res, { sent: 2, failed: 0, pruned: 1 });
  assert.equal(h.pruned.length, 1);
  assert.equal(h.pruned[0].id, 's2');
  assert.match(h.pruned[0].reason, /410/);
  assert.ok(!h.delivered.includes('s2'));
});

test('a transient failure counts as failed and keeps the subscription', async () => {
  const h = harness({ results: { s1: { ok: false, gone: false, status: 429 } } });
  const res = await deliverToSubscribers({ title: 'T', body: 'B' }, h.deps);
  assert.deepEqual(res, { sent: 2, failed: 1, pruned: 0 });
  assert.deepEqual(h.pruned, [], 'a rate-limited push service must not cost the subscription');
});

test('no subscriptions means no work and no VAPID lookup', async () => {
  let keysRead = false;
  const res = await deliverToSubscribers({ title: 'T', body: 'B' }, {
    listSubscriptions: () => [],
    get vapidKeys() { keysRead = true; return KEYS; },
    deliverPush: async () => { throw new Error('must not be called'); },
  });
  assert.deepEqual(res, { sent: 0, failed: 0, pruned: 0 });
  assert.equal(keysRead, false);
});

test('the payload is JSON the Service Worker can render directly', async () => {
  const h = harness();
  await deliverToSubscribers({
    title: 'Claude Code · proj', body: 'Waiting for your input', level: 'warning',
    attribution: 'ayaka · proj · session abc12345', tag: 'ccserver-abc12345',
  }, h.deps);
  const payload = JSON.parse(h.sent[0].payload);
  assert.deepEqual(payload, {
    title: 'Claude Code · proj',
    body: 'Waiting for your input',
    level: 'warning',
    attribution: 'ayaka · proj · session abc12345',
    tag: 'ccserver-abc12345',
    url: '/',
  });
});

test('an oversized body is trimmed so the record still encrypts', async () => {
  const h = harness();
  await deliverToSubscribers({ title: 'T', body: 'x'.repeat(MAX_PAYLOAD_BYTES * 2) }, h.deps);
  const raw = h.sent[0].payload;
  assert.ok(Buffer.byteLength(raw, 'utf-8') <= MAX_PAYLOAD_BYTES,
    `payload is ${Buffer.byteLength(raw, 'utf-8')} bytes`);
  assert.ok(JSON.parse(raw).body.endsWith('…'), 'and the trim is visible');
});

test('the same payload and subject go to every subscription', async () => {
  const h = harness();
  await deliverToSubscribers({ title: 'T', body: 'B' }, h.deps);
  assert.equal(new Set(h.sent.map((s) => s.payload)).size, 1);
  assert.equal(new Set(h.sent.map((s) => s.subject)).size, 1);
});

test('the VAPID subject is a valid RFC 8292 contact URI', () => {
  // Not the operator's own address by default: ccserver has no business
  // inventing one, and it is sent to third-party push services.
  assert.match(vapidSubject(), /^(mailto:|https:\/\/)/);
  const prev = process.env.CCSERVER_VAPID_SUBJECT;
  try {
    process.env.CCSERVER_VAPID_SUBJECT = 'mailto:ops@example.com';
    assert.equal(vapidSubject(), 'mailto:ops@example.com');
    process.env.CCSERVER_VAPID_SUBJECT = 'not-a-uri';
    assert.match(vapidSubject(), /^https:\/\//, 'a malformed override falls back');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_VAPID_SUBJECT;
    else process.env.CCSERVER_VAPID_SUBJECT = prev;
  }
});

test('a missing VAPID identity is reported, not thrown', async () => {
  const res = await deliverToSubscribers({ title: 'T', body: 'B' }, {
    listSubscriptions: () => SUBS,
    get vapidKeys() { throw new Error('db is gone'); },
    deliverPush: async () => ({ ok: true, gone: false, status: 201 }),
  });
  assert.deepEqual(res, { sent: 0, failed: 3, pruned: 0 });
});

// --- increment review (attack-review-notify-579a096) -------------------------

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('F3: the byte-trim never re-introduces a lone surrogate', async () => {
  // sanitizePushText replaces lone surrogates, but the size-convergence loop
  // used to slice by UTF-16 unit and split a pair right back open. This is the
  // exact body an attacker review reported it on.
  const h = harness();
  await deliverToSubscribers({ title: 'T', body: '\u{1F389}'.repeat(1900) + 'a'.repeat(200) }, h.deps);
  const payload = JSON.parse(h.sent[0].payload);
  assert.ok(!LONE_SURROGATE.test(payload.body), 'no lone surrogate may survive the trim');
  assert.ok(Buffer.byteLength(h.sent[0].payload, 'utf-8') <= MAX_PAYLOAD_BYTES);
  assert.ok(payload.body.endsWith('…'));
});

test('F3: emoji-only bodies of many sizes all stay well-formed and in budget', async () => {
  // The trim length depends on where the multi-byte characters fall, so sweep
  // sizes rather than trusting one.
  for (let n = 900; n <= 2100; n += 97) {
    const h = harness();
    // eslint-disable-next-line no-await-in-loop
    await deliverToSubscribers({ title: 'T', body: '\u{1F389}'.repeat(n) }, h.deps);
    const raw = h.sent[0].payload;
    assert.ok(Buffer.byteLength(raw, 'utf-8') <= MAX_PAYLOAD_BYTES, `n=${n} over budget`);
    assert.ok(!LONE_SURROGATE.test(JSON.parse(raw).body), `n=${n} produced a lone surrogate`);
  }
});

test('F1: the push sanitizer defangs a marker with invisibles inside it', () => {
  for (const probe of ['_from​:', '_fr​om:', '_from͏:', '_from️:']) {
    const out = sanitizePushText(`x ${probe} y`, { maxCodePoints: 500 });
    assert.ok(!out.includes('_from'), `${JSON.stringify(probe)} -> ${JSON.stringify(out)}`);
  }
});
