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

// --- increment review (attack-review-notify-f30ee36), M1 ---------------------
//
// The F3 cases above assert "no lone surrogate" and "within budget". A trim to
// a SINGLE ellipsis satisfies both, and that is exactly what the loop did to
// Japanese text: `over` is a count of BYTES and it was spent as a count of
// CODE POINTS, so every 3-byte character freed three bytes' worth of quota.
// Measured on the defect: 1900 Japanese characters in -> 110 out, 1950 -> 10,
// 1955 and up -> the ellipsis alone, 87 bytes of a 3993-byte budget. Emoji
// (4 bytes) collapsed the same way from 1303 characters up.
//
// So these assert the REMAINING AMOUNT is worth the budget, which is the only
// shape of assertion that fails on that defect.

// What the envelope costs, so the tests can talk about the body's real budget
// instead of hard-coding a number that moves when a field is added.
const ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({
  title: 'T', body: '', level: 'info', attribution: null, tag: 'ccserver', url: '/',
}), 'utf-8');
const ELLIPSIS_BYTES = 3;
// sanitizePushText's cap, which bites before the byte-trim for 1-byte text.
const PUSH_BODY_MAX_CODE_POINTS = 2000;

// How many characters of `ch` SHOULD survive, if the trim gives up nothing it
// does not have to.
function idealKeep(ch) {
  return Math.floor((MAX_PAYLOAD_BYTES - ENVELOPE_BYTES - ELLIPSIS_BYTES) / Buffer.byteLength(ch, 'utf-8'));
}

async function trimmedBody(body) {
  const h = harness();
  await deliverToSubscribers({ title: 'T', body }, h.deps);
  return { raw: h.sent[0].payload, body: JSON.parse(h.sent[0].payload).body };
}

test('M1: a long Japanese body keeps what the budget can pay for', async () => {
  const ideal = idealKeep('あ');           // 1302 at a 3993-byte budget
  const res = await trimmedBody('あ'.repeat(1900));
  const kept = Array.from(res.body).length - 1; // less the ellipsis
  const bytes = Buffer.byteLength(res.raw, 'utf-8');

  assert.ok(bytes <= MAX_PAYLOAD_BYTES, `payload is ${bytes} bytes`);
  // The actual regression: the defect produced 110. Anything in that
  // neighbourhood is a re-introduction, whatever the exact arithmetic.
  assert.ok(kept >= ideal - 2,
    `kept ${kept} of a possible ${ideal} Japanese characters (the defect kept 110)`);
  // Said the other way round: an over-trim leaves the budget unspent.
  assert.ok(MAX_PAYLOAD_BYTES - bytes <= 4,
    `${MAX_PAYLOAD_BYTES - bytes} bytes of the budget went unused`);
  assert.ok(res.body.endsWith('…'));
});

test('M1: the sizes the review measured no longer collapse', async () => {
  // 1955+ was the cliff where the body became nothing but an ellipsis.
  for (const n of [1900, 1950, 1955, 2000, 4000]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await trimmedBody('あ'.repeat(n));
    const kept = Array.from(res.body).length - 1;
    assert.ok(kept >= idealKeep('あ') - 2, `n=${n} kept only ${kept} characters`);
  }
});

test('M1: a long emoji body likewise keeps what the budget can pay for', async () => {
  const ideal = idealKeep('🎉');           // 976 at a 3993-byte budget
  const res = await trimmedBody('🎉'.repeat(1400));
  const kept = Array.from(res.body).length - 1;
  const bytes = Buffer.byteLength(res.raw, 'utf-8');

  assert.ok(bytes <= MAX_PAYLOAD_BYTES, `payload is ${bytes} bytes`);
  assert.ok(kept >= ideal - 2,
    `kept ${kept} of a possible ${ideal} emoji (the defect kept 10 at this size)`);
  // 4 bytes per code point, so the budget cannot always be spent to the byte.
  assert.ok(MAX_PAYLOAD_BYTES - bytes <= 5,
    `${MAX_PAYLOAD_BYTES - bytes} bytes of the budget went unused`);
  assert.ok(!LONE_SURROGATE.test(res.body));
});

test('M1: every script fills the budget, across sizes and mixtures', async () => {
  // One sweep covering the three byte-widths and a mixture, because the trim
  // walks backwards through whatever code points happen to be at the end.
  const mixed = Array.from({ length: 2400 }, (_, i) => ['a', 'あ', '🎉', 'é'][i % 4]).join('');
  const bodies = [
    ['ascii', 'x'.repeat(6000)],
    ['japanese', 'あ'.repeat(3000)],
    ['emoji', '🎉'.repeat(2500)],
    ['latin-1 supplement', 'é'.repeat(4000)],
    ['mixed', mixed],
    ['japanese with an ascii tail', 'あ'.repeat(1800) + 'tail'.repeat(50)],
  ];
  for (const [name, body] of bodies) {
    // eslint-disable-next-line no-await-in-loop
    const res = await trimmedBody(body);
    const bytes = Buffer.byteLength(res.raw, 'utf-8');
    const kept = Array.from(res.body).length;
    // What sanitizePushText's code-point cap alone would have left. Both caps
    // append an ellipsis, so the ellipsis does NOT tell them apart -- a body
    // shorter than this is one the byte-trim really cut.
    const capAllows = Math.min(Array.from(body).length, PUSH_BODY_MAX_CODE_POINTS);

    assert.ok(bytes <= MAX_PAYLOAD_BYTES, `${name}: ${bytes} bytes is over budget`);
    assert.ok(!LONE_SURROGATE.test(res.body), `${name}: lone surrogate`);
    if (kept < capAllows) {
      // The byte-trim ran, so it has to have spent the budget it was given.
      assert.ok(MAX_PAYLOAD_BYTES - bytes <= 5,
        `${name}: byte-trimmed to ${kept} code points but left ${MAX_PAYLOAD_BYTES - bytes} bytes of budget unused`);
    }
  }
});

test('M1: the trim converges in a bounded number of passes', async () => {
  // Spending byte-overshoot as code points at least terminated. Measuring each
  // code point could not, if it under-shot -- so pin that it does not: JSON
  // escaping only ever lengthens a code point, so one pass covers the
  // overshoot and the second pays for the ellipsis.
  let calls = 0;
  const realByteLength = Buffer.byteLength;
  Buffer.byteLength = (...args) => { calls += 1; return realByteLength.apply(Buffer, args); };
  try {
    await trimmedBody('あ'.repeat(4000));
  } finally {
    Buffer.byteLength = realByteLength;
  }
  // One measurement per code point examined plus a handful per pass. The
  // defect's compounding loop, or an under-shooting one, runs far more.
  assert.ok(calls < 4000, `the trim took ${calls} byte-length measurements`);
});
