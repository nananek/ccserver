import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLOW_COOKIE_NAME,
  FLOW_TTL_MS,
  WEBAUTHN_USER_ID,
  WEBAUTHN_USER_NAME,
  startChallengeFlow,
  consumeChallengeFlow,
  flowCookieHeader,
  clearFlowCookieHeader,
  resolveRpID,
  resolveOrigin,
} from './webauthnChallenges.js';

const savedRpidEnv = process.env.CCSERVER_WEBAUTHN_RPID;

function fakeRequest({ hostname, host, protocol, cookie } = {}) {
  return { hostname, host, protocol, headers: { cookie } };
}

function requestWithFlowCookie(flowId) {
  return fakeRequest({ cookie: `${FLOW_COOKIE_NAME}=${flowId}` });
}

test('WEBAUTHN_USER_ID/WEBAUTHN_USER_NAME are fixed (single-user app, no user table)', () => {
  assert.equal(WEBAUTHN_USER_NAME, 'ccserver');
  assert.ok(WEBAUTHN_USER_ID instanceof Uint8Array);
  assert.ok(WEBAUTHN_USER_ID.length > 0);
});

test('resolveRpID: defaults to request.hostname (no port, no scheme)', () => {
  delete process.env.CCSERVER_WEBAUTHN_RPID;
  assert.equal(resolveRpID(fakeRequest({ hostname: 'my-box.ts.net' })), 'my-box.ts.net');
});

test('resolveRpID: CCSERVER_WEBAUTHN_RPID overrides request.hostname', () => {
  process.env.CCSERVER_WEBAUTHN_RPID = 'override.example.com';
  try {
    assert.equal(resolveRpID(fakeRequest({ hostname: 'my-box.ts.net' })), 'override.example.com');
  } finally {
    if (savedRpidEnv === undefined) delete process.env.CCSERVER_WEBAUTHN_RPID;
    else process.env.CCSERVER_WEBAUTHN_RPID = savedRpidEnv;
  }
});

test('resolveOrigin: protocol + host, keeping a non-default port that request.hostname would strip', () => {
  assert.equal(
    resolveOrigin(fakeRequest({ protocol: 'http', host: 'localhost:3001', hostname: 'localhost' })),
    'http://localhost:3001',
  );
});

test('resolveOrigin: not affected by CCSERVER_WEBAUTHN_RPID', () => {
  process.env.CCSERVER_WEBAUTHN_RPID = 'override.example.com';
  try {
    assert.equal(
      resolveOrigin(fakeRequest({ protocol: 'https', host: 'my-box.ts.net', hostname: 'my-box.ts.net' })),
      'https://my-box.ts.net',
    );
  } finally {
    if (savedRpidEnv === undefined) delete process.env.CCSERVER_WEBAUTHN_RPID;
    else process.env.CCSERVER_WEBAUTHN_RPID = savedRpidEnv;
  }
});

test('startChallengeFlow/consumeChallengeFlow: round-trips the challenge for a matching kind', () => {
  const flowId = startChallengeFlow('registration', 'chal-1');
  assert.equal(consumeChallengeFlow(requestWithFlowCookie(flowId), 'registration'), 'chal-1');
});

test('consumeChallengeFlow: one-time use -- a second consume of the same flow fails', () => {
  const flowId = startChallengeFlow('registration', 'chal-2');
  const request = requestWithFlowCookie(flowId);
  assert.equal(consumeChallengeFlow(request, 'registration'), 'chal-2');
  assert.equal(consumeChallengeFlow(request, 'registration'), null);
});

test('consumeChallengeFlow: kind mismatch is rejected (registration flow cookie against authenticate-verify)', () => {
  const flowId = startChallengeFlow('registration', 'chal-3');
  assert.equal(consumeChallengeFlow(requestWithFlowCookie(flowId), 'authentication'), null);
});

test('consumeChallengeFlow: null when there is no flow cookie at all', () => {
  assert.equal(consumeChallengeFlow(fakeRequest({}), 'registration'), null);
});

test('consumeChallengeFlow: null for an unknown flowId', () => {
  assert.equal(consumeChallengeFlow(requestWithFlowCookie('not-a-real-flow-id'), 'registration'), null);
});

test('consumeChallengeFlow: null once the flow has expired', async () => {
  const flowId = startChallengeFlow('registration', 'chal-4');
  const request = requestWithFlowCookie(flowId);
  const realNow = Date.now;
  Date.now = () => realNow() + FLOW_TTL_MS + 1000;
  try {
    assert.equal(consumeChallengeFlow(request, 'registration'), null);
  } finally {
    Date.now = realNow;
  }
});

test('flowCookieHeader: HttpOnly/SameSite=Lax/Max-Age, no Secure by default', () => {
  const header = flowCookieHeader('flow-abc');
  assert.match(header, new RegExp(`^${FLOW_COOKIE_NAME}=flow-abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=\\d+$`));
  assert.ok(!header.includes('Secure'));
  const maxAge = Number(header.match(/Max-Age=(\d+)/)[1]);
  assert.equal(maxAge, Math.floor(FLOW_TTL_MS / 1000));
});

test('flowCookieHeader: adds Secure when asked', () => {
  assert.ok(flowCookieHeader('flow-abc', { secure: true }).includes('; Secure'));
});

test('clearFlowCookieHeader: empties the value and expires immediately', () => {
  assert.equal(clearFlowCookieHeader(), `${FLOW_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
});
