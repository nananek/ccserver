// POST /api/sessions validation (the shared createSessionViaApi body). Only
// the paths that fail BEFORE a pty spawn are exercised here -- spawning real
// agent CLIs is exactly what these tests must never do. The happy path's
// spawn behavior belongs to sessionManager tests / e2e.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionsRoute, createSessionViaApi } from './sessions.js';

let tmpRoot;
let app;

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-sessions-route-'));
  app = Fastify();
  await app.register(sessionsRoute, { prefix: '/api' });
});

after(async () => {
  try { await app.close(); } catch { /* ignore */ }
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('POST /sessions rejects invalid bodies with 400 before touching a pty', async () => {
  for (const body of [
    {},                                     // no cwd
    { cwd: '' },
    { cwd: 42 },
    { cwd: '/definitely/not/a/real/dir', app: 'claude' }, // nonexistent dir
    { cwd: '/', shell: false, app: 'claude' },            // root refusal (createSession)
    { cwd: tmpRoot, app: 'not-an-app' },
    { cwd: tmpRoot, sandboxOpts: 'gpg please' },
  ]) {
    const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.ok(res.json().error);
  }
});

test('createSessionViaApi returns result objects, not HTTP replies', async () => {
  const bad = await createSessionViaApi({});
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'validation');

  const badApp = await createSessionViaApi({ cwd: tmpRoot, app: 'gemini' });
  assert.equal(badApp.ok, false);
});

test('GET /sessions still lists (empty) without any live session', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/sessions' });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json().sessions));
});

test('PATCH /sessions/:id validates without touching a pty', async () => {
  // Unknown id (no live session with it) -> 404, never spawns.
  const missing = await app.inject({ method: 'PATCH', url: '/api/sessions/no-such-id', payload: { customLabel: 'foo' } });
  assert.equal(missing.statusCode, 404);
  assert.ok(missing.json().error);

  // Missing key / wrong type -> 400 (the happy path needs a live session and
  // is covered by sessionManager.test.js's setSessionLabel test + e2e).
  const noKey = await app.inject({ method: 'PATCH', url: '/api/sessions/no-such-id', payload: {} });
  assert.equal(noKey.statusCode, 400);
  const badType = await app.inject({ method: 'PATCH', url: '/api/sessions/no-such-id', payload: { customLabel: 42 } });
  assert.equal(badType.statusCode, 400);
});

test('PATCH /sessions/:id rejects primitive JSON bodies with 400 (no 500)', async () => {
  // A truthy primitive body would throw in `'customLabel' in body` --
  // it must 400 like every other malformed body on this boundary.
  for (const payload of ['"foo"', '42', 'true', '[1]', 'null']) {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/no-such-id',
      payload,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 400, payload);
    assert.ok(res.json().error);
  }
});

// #253: the copy modal's source. The happy path needs a live pty, so it is
// covered by mcpTools.test.js (the shared helper) and the e2e spec; what is
// pinned here is that an unknown id is a clean 404 rather than a 500 -- the
// modal fires on a session the client believes exists, and a race with
// teardown must not surface as a server error.
test('GET /sessions/:id/text 404s for an unknown session', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/sessions/no-such-session/text' });
  assert.equal(res.statusCode, 404);
  assert.ok(res.json().error);
});
