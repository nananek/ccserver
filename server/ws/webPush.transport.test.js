// The transport half of Web Push and webhook delivery, exercised against a
// REAL local listener with NO fetch injection (plan: plan-notify-bridge,
// Step 4; attacker review F2).
//
// Why this file exists: webPush.test.js and notify.test.js both stub the fetch
// they call, so they were 19/25 green while delivery could not work at all in
// production. The cause was that ccserver built its SSRF-guarding `Agent` from
// the `undici` package, then handed it to `globalThis.fetch`, which on Node >=
// 24 is backed by Node's OWN bundled undici and rejects a foreign Agent with
// "UND_ERR_INVALID_ARG: invalid onError method". Every delivery failed with a
// bare "fetch failed", and -- worse -- the connect-time SSRF guard never ran,
// because the request died before reaching the dispatcher.
//
// So these cases deliberately go through the real thing: real sockets, real
// dispatcher, real Agent. They are what tells the difference between "the
// guard blocked it" and "the plumbing is broken".

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createECDH, randomBytes } from 'node:crypto';
import { Agent, fetch as undiciFetch } from 'undici';
import { getSsrfSafeDispatcher } from './notify.js';
import { deliverPush, deliveryFetch, generateVapidKeys, validateDeliveryEndpoint, b64u } from './webPush.js';

let server;
let port;
const received = [];

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('the Agent we build is actually usable by the fetch we call', async () => {
  // THE regression test for F2. If the dispatcher and the fetch implementation
  // ever drift apart again, this fails immediately and unambiguously, instead
  // of every delivery silently returning "fetch failed" in production while
  // the mocked suites stay green.
  const res = await undiciFetch(`http://127.0.0.1:${port}/agent-compat`, {
    method: 'POST',
    body: 'x',
    dispatcher: new Agent(),
  });
  assert.equal(res.status, 201);
  assert.ok(received.some((r) => r.url === '/agent-compat'), 'the request really arrived');
});

test('deliverPush calls the undici our Agent comes from, not the platform fetch', () => {
  // THE cross-runtime form of F2's guard.
  //
  // This used to assert the opposite thing: that globalThis.fetch REJECTS our
  // Agent. That is not a fact about ccserver, it is a fact about whichever
  // undici the running Node happens to bundle -- true on Node 26, FALSE on
  // Node 22, whose bundled undici still accepts a 6.x Agent. CI runs Node 22,
  // so the suite failed there on correct code, and the failure said nothing
  // about whether anything was wrong.
  //
  // Worse, it was asymmetric in the dangerous direction: on Node 22 a switch
  // BACK to globalThis.fetch would have kept CI green, because on Node 22 that
  // switch genuinely is not yet fatal -- and then broken production on Node 26.
  // That is the exact path this regression took the first time.
  //
  // What must hold on every runtime is that the fetch deliverPush calls and
  // the Agent getSsrfSafeDispatcher() builds come from the SAME undici. That
  // is a property of our code, so assert it by identity.
  assert.equal(deliveryFetch(), undiciFetch,
    'deliverPush must call the `undici` package fetch, the one our Agent belongs to');
  assert.notEqual(deliveryFetch(), globalThis.fetch,
    'the platform fetch is backed by Node\'s own bundled undici, not the one we build Agents from');
});

test('the platform/dependency undici drift is recorded, not asserted', async (t) => {
  // The drift is still worth knowing -- it broke every webhook and push
  // delivery for two Node majors before anyone noticed -- so it is reported on
  // whatever runtime the suite runs on. It is an observation about the
  // environment, so it never fails the build.
  let outcome;
  try {
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/global-fetch`, {
      method: 'POST', body: 'x', dispatcher: new Agent(),
    });
    outcome = `ACCEPTED our Agent (HTTP ${res.status})`;
  } catch (err) {
    outcome = `refused our Agent (${err.cause?.code || err.message})`;
  }
  t.diagnostic(`${process.version}: globalThis.fetch ${outcome}`);
  // The probe has to have actually run, or the diagnostic means nothing.
  assert.ok(outcome, 'the drift probe produced no result');
});

test('the SSRF guard actually fires on a hostname that resolves to loopback', async () => {
  // With the plumbing fixed, the request reaches the dispatcher and the
  // connect-time lookup refuses it. Before the fix this failed too -- but with
  // "fetch failed", i.e. for the wrong reason, which is exactly how a dead
  // guard hides.
  let message = '';
  try {
    await undiciFetch(`https://localhost:${port}/guarded`, {
      method: 'POST', body: 'x', dispatcher: getSsrfSafeDispatcher(),
    });
  } catch (err) {
    message = String(err.cause?.message || err.message);
  }
  assert.match(message, /private\/reserved address|SSRF guard/,
    `expected the guard to refuse, got: ${message}`);
  assert.ok(!received.some((r) => r.url === '/guarded'), 'and nothing reached the listener');
});

test('deliverPush refuses an IP-literal endpoint before opening a socket', async () => {
  // The third layer: undici never calls its lookup hook for a literal host, so
  // neither the connect-time guard nor DNS can help here.
  const keys = generateVapidKeys();
  for (const endpoint of [
    `https://127.0.0.1:${port}/literal`,
    `https://[::1]:${port}/literal`,
    `https://[::ffff:127.0.0.1]:${port}/literal`,
    `https://[::ffff:7f00:1]:${port}/literal`,
  ]) {
    const res = await deliverPush({
      subscription: { endpoint, p256dh: b64u(Buffer.concat([Buffer.from([4]), Buffer.alloc(64)])), auth: b64u(Buffer.alloc(16)) },
      payload: 'x',
      vapidKeys: keys,
      subject: 'mailto:ops@example.com',
    });
    assert.equal(res.ok, false, endpoint);
    assert.match(res.error, /IP literal|private or reserved/, endpoint);
  }
  assert.ok(!received.some((r) => r.url === '/literal'), 'nothing reached the listener');
});

test('deliverPush itself is guarded: the dispatcher is live on the real path', async () => {
  // Stronger than probing the dispatcher in isolation (the case above builds
  // the request by hand). This one goes through deliverPush with NO fetch
  // seam, so it fails if the production path ever stops passing the
  // dispatcher, or passes it to a fetch that quietly ignores it -- which is
  // what "fetch failed" looked like when F2 was live.
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const res = await deliverPush({
    subscription: {
      endpoint: `https://localhost:${port}/real-path`,
      p256dh: b64u(ecdh.getPublicKey()),
      auth: b64u(randomBytes(16)),
    },
    payload: 'x',
    vapidKeys: generateVapidKeys(),
    subject: 'mailto:ops@example.com',
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /private\/reserved address|SSRF guard/,
    `expected the connect-time guard to refuse, got: ${res.error}`);
  assert.ok(!received.some((r) => r.url === '/real-path'), 'nothing reached the listener');
});

test('validateDeliveryEndpoint mirrors the registration rules', () => {
  assert.equal(validateDeliveryEndpoint('https://push.example.net/p/abc'), null);
  assert.match(validateDeliveryEndpoint('http://push.example.net/p/abc'), /https/);
  assert.match(validateDeliveryEndpoint('https://[::ffff:169.254.169.254]/p'), /IP literal/);
  assert.match(validateDeliveryEndpoint('not a url'), /not a valid URL/);
});
