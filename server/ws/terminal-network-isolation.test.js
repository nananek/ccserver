// Exercises attachTerminalHandler's set_network_isolation/get_network_isolation
// cases against a REAL running network-broker (network-broker.test.js already
// proves the broker's own enforce/open mechanics; this file proves terminal.js
// actually wires up to it correctly, end to end through a real WS-shaped
// handler).
//
// A real (shell) session stands in for a sandboxed one -- no sandbox/bwrap
// required to spawn it (same precedent as sessionManager.test.js's header
// comment) -- with a real broker's port/token attached onto the live session
// record afterward, exactly the shape buildSandboxSpawn would have set had
// this been a real bwrap launch with isolation enabled.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createSession, getSession, destroySession } from './sessionManager.js';
import { attachTerminalHandler } from './terminal.js';
import { startNetworkBroker } from './network-broker.js';

const cleanupSessionIds = [];
const cleanupBrokers = [];

after(() => {
  for (const id of cleanupSessionIds) { try { destroySession(id); } catch { /* already gone */ } }
  for (const b of cleanupBrokers) {
    try { b.proc.kill('SIGKILL'); } catch { /* already dead */ }
    try { rmSync(b.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// Minimal fake `chan` matching what attachTerminalHandler needs: .send(json),
// .close(), a numeric .readyState (1 = open, the WebSocket convention).
function fakeChan() {
  const sent = [];
  return {
    sent,
    readyState: 1,
    send(json) { sent.push(JSON.parse(json)); },
    close() { this.readyState = 3; },
  };
}

async function isolationEnabledSession() {
  const res = await createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  assert.equal(res.error, undefined, res.error);
  cleanupSessionIds.push(res.sessionId);
  const broker = startNetworkBroker({ allowedHosts: [] }); // starts in 'enforce' with nothing allowed
  cleanupBrokers.push(broker);
  const session = getSession(res.sessionId);
  // Same shape buildSandboxSpawn's bwrap branch would have set -- see
  // sandbox.js's buildSandboxSpawn and sessionManager.js's buildSessionRecord.
  session.networkIsolateArmed = true;
  session.networkBrokerPort = broker.port;
  session.networkBrokerToken = broker.token;
  session.networkIsolateMode = 'enforce';
  return { sessionId: res.sessionId, session, broker };
}

test('init sends network_isolation_state (armed:false) for a non-isolated session', async () => {
  const res = await createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  cleanupSessionIds.push(res.sessionId);
  const chan = fakeChan();
  const handler = attachTerminalHandler(chan);
  // Re-attach (not re-init) to the already-created session, the same way a
  // second browser tab would -- avoids re-spawning a second real pty.
  await handler.handleMessage({ type: 'attach', sessionId: res.sessionId });
  const msg = chan.sent.find((m) => m.type === 'network_isolation_state');
  assert.ok(msg, 'attach must proactively send network_isolation_state');
  assert.equal(msg.armed, false);
  assert.equal(msg.enabled, false);
});

test('attach sends network_isolation_state (armed:true, enabled reflects live mode) for an isolation-enabled session', async () => {
  const { sessionId } = await isolationEnabledSession();
  const chan = fakeChan();
  const handler = attachTerminalHandler(chan);
  await handler.handleMessage({ type: 'attach', sessionId });
  const msg = chan.sent.find((m) => m.type === 'network_isolation_state');
  assert.ok(msg);
  assert.equal(msg.armed, true);
  assert.equal(msg.enabled, true, 'starts in enforce');
});

test('set_network_isolation flips the real broker and echoes the new state', async () => {
  const { sessionId, session, broker } = await isolationEnabledSession();
  const chan = fakeChan();
  const handler = attachTerminalHandler(chan);
  await handler.handleMessage({ type: 'attach', sessionId });

  await handler.handleMessage({ type: 'set_network_isolation', enabled: false });
  const flipped = chan.sent.findLast((m) => m.type === 'network_isolation_state');
  assert.equal(flipped.armed, true);
  assert.equal(flipped.enabled, false);
  assert.equal(flipped.ok, true);
  assert.equal(session.networkIsolateMode, 'open', 'the session record itself is updated, not just the echo');

  // Real proof this reached the actual broker process, not just local state:
  // a raw CONNECT through it should now succeed even though allowedHosts is
  // empty (mirrors network-broker.test.js's own live-toggle assertion).
  const net = await import('node:net');
  const probe = await new Promise((resolve) => {
    const sock = net.connect(broker.port, '127.0.0.1');
    let buf = '';
    sock.on('connect', () => {
      const auth = `Basic ${Buffer.from(`x:${broker.token}`).toString('base64')}`;
      sock.write(`CONNECT example.com:443 HTTP/1.1\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) { sock.destroy(); resolve(buf.split('\r\n')[0]); }
    });
    sock.on('error', () => resolve('ERROR'));
  });
  assert.match(probe, /^HTTP\/1\.1 200/, 'broker really is in open mode now, not just the session record');

  await handler.handleMessage({ type: 'set_network_isolation', enabled: true });
  assert.equal(session.networkIsolateMode, 'enforce', 'flips back');
});

test('set_network_isolation on a session without isolation echoes armed:false, ok:false (nothing to flip)', async () => {
  const res = await createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  cleanupSessionIds.push(res.sessionId);
  const chan = fakeChan();
  const handler = attachTerminalHandler(chan);
  await handler.handleMessage({ type: 'attach', sessionId: res.sessionId });
  await handler.handleMessage({ type: 'set_network_isolation', enabled: true });
  const msg = chan.sent.findLast((m) => m.type === 'network_isolation_state');
  assert.equal(msg.armed, false);
  assert.equal(msg.ok, false);
});

test('get_network_isolation reports the current live state without mutating it', async () => {
  const { sessionId, session } = await isolationEnabledSession();
  const chan = fakeChan();
  const handler = attachTerminalHandler(chan);
  await handler.handleMessage({ type: 'attach', sessionId });
  await handler.handleMessage({ type: 'get_network_isolation' });
  const msg = chan.sent.findLast((m) => m.type === 'network_isolation_state');
  assert.equal(msg.armed, true);
  assert.equal(msg.enabled, true);
  assert.equal(session.networkIsolateMode, 'enforce', 'a plain get never changes the mode');
});
