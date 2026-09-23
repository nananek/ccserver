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
import { Agent, fetch as undiciFetch } from 'undici';
import { getSsrfSafeDispatcher } from './notify.js';
import { deliverPush, generateVapidKeys, validateDeliveryEndpoint, b64u } from './webPush.js';

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

test('globalThis.fetch would NOT accept it (the trap this guards against)', async () => {
  // Documents the incompatibility rather than relying on remembering it. If a
  // future Node ships the same undici we depend on, this starts passing and
  // the assertion below can be relaxed -- but until then, using
  // globalThis.fetch with our Agent is a silent outage.
  let failed = false;
  try {
    await globalThis.fetch(`http://127.0.0.1:${port}/global-fetch`, {
      method: 'POST', body: 'x', dispatcher: new Agent(),
    });
  } catch (err) {
    failed = true;
    assert.match(String(err.cause?.code || err.message), /UND_ERR_INVALID_ARG|invalid onError/);
  }
  assert.equal(failed, true, 'if this ever passes, re-check which fetch deliverPush should use');
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

test('validateDeliveryEndpoint mirrors the registration rules', () => {
  assert.equal(validateDeliveryEndpoint('https://push.example.net/p/abc'), null);
  assert.match(validateDeliveryEndpoint('http://push.example.net/p/abc'), /https/);
  assert.match(validateDeliveryEndpoint('https://[::ffff:169.254.169.254]/p'), /IP literal/);
  assert.match(validateDeliveryEndpoint('not a url'), /not a valid URL/);
});
