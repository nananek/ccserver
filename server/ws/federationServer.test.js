// Two layers of coverage:
//  1. authorizeRequest() -- the pure authorization decision -- tested
//     directly with synthetic rows, no networking at all.
//  2. A real mTLS integration suite against a live federation listener
//     (ensureFederationServer with port:0), driven by a second, independently
//     generated key/cert pair playing "the peer" (deliberately NOT going
//     through federationIdentity.js's module-level identity cache, which
//     belongs to "this instance" / the server under test -- a second real
//     identity has to come from its own openssl-generated files to avoid
//     fighting that singleton). Skips the whole live-network suite when
//     openssl is unavailable, same as federationIdentity.test.js.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect as tlsConnect } from 'node:tls';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeDb } from '../db.js';
import * as pairing from './federationPairing.js';
import { opensslAvailable, _resetIdentityCacheForTests } from './federationIdentity.js';
import {
  authorizeRequest, ensureFederationServer, stopFederationServer, _resetFederationServerForTests,
} from './federationServer.js';

test('authorizeRequest: unknown peer may only call pairing.propose', () => {
  assert.equal(authorizeRequest({ kind: 'rpc', method: 'pairing.propose' }, null, false).ok, true);
  assert.equal(authorizeRequest({ kind: 'rpc', method: 'sessions.list' }, null, false).ok, false);
  assert.equal(authorizeRequest({ kind: 'terminal' }, null, false).ok, false);
});

test('authorizeRequest: pending rows may call pairing.propose/pairing.status only', () => {
  const pending = { status: 'pending_local_approval' };
  assert.equal(authorizeRequest({ kind: 'rpc', method: 'pairing.propose' }, pending, false).ok, true);
  assert.equal(authorizeRequest({ kind: 'rpc', method: 'pairing.status' }, pending, false).ok, true);
  assert.equal(authorizeRequest({ kind: 'rpc', method: 'sessions.list' }, pending, false).ok, false);
  assert.equal(authorizeRequest({ kind: 'terminal' }, pending, false).ok, false);
});

test('authorizeRequest: active rows may call anything', () => {
  const active = { status: 'active' };
  assert.equal(authorizeRequest({ kind: 'rpc', method: 'sessions.list' }, active, false).ok, true);
  assert.equal(authorizeRequest({ kind: 'rpc', method: 'groups.create' }, active, false).ok, true);
  assert.equal(authorizeRequest({ kind: 'terminal' }, active, false).ok, true);
});

test('authorizeRequest: revoked rows are refused for everything, including a re-propose', () => {
  const revoked = { status: 'revoked' };
  assert.equal(authorizeRequest({ kind: 'rpc', method: 'pairing.propose' }, revoked, false).ok, false);
  assert.equal(authorizeRequest({ kind: 'rpc', method: 'sessions.list' }, revoked, false).ok, false);
});

test('authorizeRequest: selfPairing overrides everything', () => {
  assert.equal(authorizeRequest({ kind: 'rpc', method: 'pairing.propose' }, null, true).ok, false);
  assert.equal(authorizeRequest({ kind: 'rpc', method: 'sessions.list' }, { status: 'active' }, true).ok, false);
});

// ---------------------------------------------------------------------
// Live mTLS integration suite

const skip = !opensslAvailable();
let tmpRoot;
let serverPort;
let peerKey;
let peerCert;
const savedHome = process.env.CCSERVER_FEDERATION_HOME;
const savedPort = process.env.CCSERVER_FEDERATION_PORT;

before(async () => {
  if (skip) return;
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-federation-server-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
  process.env.CCSERVER_FEDERATION_HOME = join(tmpRoot, 'self-federation');
  _resetIdentityCacheForTests();

  const server = await ensureFederationServer({ port: 0, log: console });
  serverPort = server.address().port;

  // A second, fully independent identity ("the peer"), generated directly
  // with openssl rather than through federationIdentity.js's singleton.
  const peerDir = join(tmpRoot, 'peer');
  mkdirSync(peerDir, { recursive: true });
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ed25519', '-days', '36500', '-nodes',
    '-keyout', join(peerDir, 'peer.key'), '-out', join(peerDir, 'peer.crt'), '-subj', '/CN=peer',
  ], { stdio: 'ignore', cwd: tmpRoot });
});

after(() => {
  if (skip) return;
  stopFederationServer();
  _resetFederationServerForTests();
  _resetIdentityCacheForTests();
  closeDb();
  delete process.env.CCSERVER_DB_PATH;
  delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  if (savedHome === undefined) delete process.env.CCSERVER_FEDERATION_HOME; else process.env.CCSERVER_FEDERATION_HOME = savedHome;
  if (savedPort === undefined) delete process.env.CCSERVER_FEDERATION_PORT; else process.env.CCSERVER_FEDERATION_PORT = savedPort;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function dial({ withCert = true } = {}) {
  const opts = { host: '127.0.0.1', port: serverPort, rejectUnauthorized: false };
  if (withCert) {
    if (!peerKey) peerKey = readFileSync(join(tmpRoot, 'peer', 'peer.key'));
    if (!peerCert) peerCert = readFileSync(join(tmpRoot, 'peer', 'peer.crt'));
    opts.key = peerKey;
    opts.cert = peerCert;
  }
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(opts, () => resolve(socket));
    socket.once('error', reject);
  });
}

function readOneLine(socket, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('timed out waiting for a line')), timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString('utf-8');
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      clearTimeout(timer);
      socket.off('data', onData);
      resolve(JSON.parse(buf.slice(0, idx)));
    };
    socket.on('data', onData);
    socket.once('close', () => { clearTimeout(timer); reject(new Error('socket closed before a line arrived')); });
  });
}

async function rpc(socket, method, params) {
  const id = randomUUID();
  socket.write(`${JSON.stringify({ v: 1, kind: 'rpc', id, method, params })}\n`);
  return readOneLine(socket);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function peerFingerprint() {
  return execFileSync('openssl', ['x509', '-in', join(tmpRoot, 'peer', 'peer.crt'), '-noout', '-fingerprint', '-sha256'])
    .toString()
    .split('=')[1]
    .trim();
}

test('a connection with no client certificate is closed without a response', { skip }, async () => {
  const socket = await dial({ withCert: false });
  await new Promise((resolve) => socket.once('close', resolve));
});

test('an unknown fingerprint may only call pairing.propose', { skip }, async () => {
  const socket = await dial();
  const resp = await rpc(socket, 'sessions.list', {});
  assert.equal(resp.ok, false);
  assert.match(resp.error, /unknown peer/);
  socket.destroy();
});

test('pairing.propose creates a pending_local_approval row for the peer, reachable by fingerprint', { skip }, async () => {
  const socket = await dial();
  const resp = await rpc(socket, 'pairing.propose', { hostnameLabel: 'peer-host' });
  assert.equal(resp.ok, true);
  assert.ok(resp.requestId);
  assert.ok(resp.myFingerprint);
  socket.destroy();

  const row = pairing.getRawByFingerprint(peerFingerprint());
  assert.ok(row);
  assert.equal(row.status, 'pending_local_approval');
  assert.equal(row.direction, 'inbound_initiated');
});

test('sessions.list stays refused until BOTH decisions are approved, then works', { skip }, async () => {
  const row = pairing.getRawByFingerprint(peerFingerprint());

  let socket = await dial();
  let resp = await rpc(socket, 'sessions.list', {});
  assert.equal(resp.ok, false, 'still pending -- not active yet');
  socket.destroy();

  pairing.recordLocalDecision(row.id, 'approved');
  socket = await dial();
  resp = await rpc(socket, 'sessions.list', {});
  assert.equal(resp.ok, false, 'local approved but remote not yet learned -- still not active');
  socket.destroy();

  pairing.recordRemoteDecision(row.id, 'approved');
  assert.equal(pairing.getInstance(row.id).status, 'active');
  socket = await dial();
  resp = await rpc(socket, 'sessions.list', {});
  assert.equal(resp.ok, true);
  assert.ok(Array.isArray(resp.sessions));
  socket.destroy();
});

// Regression for the gap the REST-only fix (routes/sessions.js stripping
// body.isReviewJob) missed: rpcSessionsCreate spreads the peer's `params`
// straight into createSessionViaApi's body, so a paired/active peer is just
// as capable of trying to set isReviewJob as an HTTP client is. The bypass
// only stays closed because createSessionViaApi now takes isReviewJob as a
// separate, trusted 2nd parameter that no caller here ever forwards from
// untrusted input (see createSessionViaApi's header comment in
// routes/sessions.js) -- this test exercises that boundary over the actual
// federation RPC path, not just the REST one.
test('sessions.create over federation ignores a peer-supplied isReviewJob', { skip }, async () => {
  const binDir = mkdtempSync(join(tmpdir(), 'ccserver-fake-agent-'));
  const fakeBin = join(binDir, 'fake-claude');
  writeFileSync(fakeBin, '#!/bin/bash\nprintf "%s\\n" "$CCSERVER_REVIEWER_IDENTITY"\n', { mode: 0o755 });
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-fake-cfg-'));
  const cfgPath = join(cfgDir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, reviewerMcp: false }));
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_CLAUDE_BIN = fakeBin;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  const reviewer = await import('./reviewer.js');
  const sessionManager = await import('./sessionManager.js');
  await reviewer.ensureReviewerBroker();
  let sessionId = null;
  try {
    assert.equal(reviewer.reviewerEnabled(), false, 'sanity: reviewerMcp really is off in this config');
    const socket = await dial();
    const resp = await rpc(socket, 'sessions.create', {
      cwd: tmpRoot, shell: false, sandbox: false, app: 'claude', isReviewJob: true,
    });
    assert.equal(resp.ok, true, JSON.stringify(resp));
    sessionId = resp.session.sessionId;
    socket.destroy();
    await sleep(500);
    const session = sessionManager.getSession(sessionId);
    assert.equal(
      session.outputBuffer.join('').trim(),
      '',
      'isReviewJob sent over federation sessions.create must be ignored',
    );
  } finally {
    if (sessionId) sessionManager.destroySession(sessionId, { keepSchedule: false });
    reviewer.stopReviewerBroker();
    if (prevBin === undefined) delete process.env.CCSERVER_CLAUDE_BIN;
    else process.env.CCSERVER_CLAUDE_BIN = prevBin;
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    try { rmSync(binDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('a terminal-open relay on an active pair answers a plain ping/pong without spawning a session', { skip }, async () => {
  const socket = await dial();
  socket.write(`${JSON.stringify({ v: 1, kind: 'terminal-open' })}\n`);
  socket.write(`${JSON.stringify({ type: 'ping' })}\n`);
  const line = await readOneLine(socket);
  assert.deepEqual(line, { type: 'pong' });
  socket.destroy();
});

test('after revoke, every RPC (including pairing.status) is refused', { skip }, async () => {
  const row = pairing.getRawByFingerprint(peerFingerprint());
  pairing.revoke(row.id);

  const socket = await dial();
  const resp = await rpc(socket, 'pairing.status', {});
  assert.equal(resp.ok, false);
  assert.match(resp.error, /revoked/);
  socket.destroy();
});

test('a peer presenting our own certificate is refused as self-pairing', { skip }, async () => {
  const selfKey = readFileSync(join(process.env.CCSERVER_FEDERATION_HOME, 'instance.key'));
  const selfCert = readFileSync(join(process.env.CCSERVER_FEDERATION_HOME, 'instance.crt'));
  const socket = await new Promise((resolve, reject) => {
    const s = tlsConnect({ host: '127.0.0.1', port: serverPort, key: selfKey, cert: selfCert, rejectUnauthorized: false }, () => resolve(s));
    s.once('error', reject);
  });
  const resp = await rpc(socket, 'pairing.propose', { hostnameLabel: 'me-again' });
  assert.equal(resp.ok, false);
  assert.match(resp.error, /yourself/);
  socket.destroy();
});
