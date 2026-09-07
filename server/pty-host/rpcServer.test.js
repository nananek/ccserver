// End-to-end test over the real Unix socket: a raw net.Socket client talks
// the actual length-prefixed NDJSON protocol (protocol.js) to a real
// PtyStore fronting a real bash pty. This is the one test file that proves
// the wire protocol itself works, not just PtyStore's in-process API
// (ptyStore.test.js) or the framing math in isolation (protocol.test.js).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PtyStore } from './ptyStore.js';
import { createRpcServer } from './rpcServer.js';
import { encodeFrame, FrameDecoder } from './protocol.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(check, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await sleep(intervalMs);
  }
}

// Minimal RPC client: call() resolves the matching reqId's response; every
// frame (responses AND push events) is also appended to .events so a test
// can assert on unsolicited `data`/`exit`/`destroyed` pushes.
function connectClient(sockPath) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sockPath);
    const decoder = new FrameDecoder();
    const pending = new Map();
    const events = [];

    socket.once('connect', () => resolve(client));
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      for (const frame of decoder.push(chunk)) {
        events.push(frame);
        if (frame.reqId && pending.has(frame.reqId)) {
          pending.get(frame.reqId)(frame);
          pending.delete(frame.reqId);
        }
      }
    });

    const client = {
      events,
      call(type, params = {}) {
        const reqId = randomUUID();
        return new Promise((res) => {
          pending.set(reqId, res);
          socket.write(encodeFrame({ reqId, type, ...params }));
        });
      },
      close() {
        socket.destroy();
      },
    };
  });
}

let sockDir;
let sockPath;

before(() => {
  sockDir = mkdtempSync(join(tmpdir(), 'ccserver-pty-host-uds-'));
  sockPath = join(sockDir, 'pty-host.sock');
});

after(() => {
  try { rmSync(sockDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('spawn/write/subscribe/resize/kill/destroy/list/ping round-trip over the real socket', async () => {
  const store = new PtyStore();
  const rpc = await createRpcServer(store, { sockPath });
  try {
    const client = await connectClient(sockPath);
    try {
      const pong = await client.call('ping');
      assert.equal(pong.ok, true);
      assert.equal(pong.pong, true);

      const spawned = await client.call('spawn', {
        cwd: process.env.HOME || '/tmp',
        cols: 80,
        rows: 24,
        command: process.env.SHELL || '/bin/bash',
        args: [],
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
      assert.equal(spawned.ok, true);
      assert.ok(spawned.pid > 0);
      const { id } = spawned;

      const sub = await client.call('subscribe', { id });
      assert.equal(sub.ok, true);
      assert.equal(sub.exited, false);

      const wrote = await client.call('write', { id, data: 'echo UDS_MARKER_$((3+4))\n' });
      assert.equal(wrote.ok, true);

      await waitFor(() => client.events.some(
        (f) => f.type === 'event' && f.event === 'data' && f.id === id && f.data.includes('UDS_MARKER_7')
      ));

      const resized = await client.call('resize', { id, cols: 100, rows: 30 });
      assert.deepEqual({ cols: resized.cols, rows: resized.rows }, { cols: 100, rows: 30 });

      const listed = await client.call('list');
      assert.ok(listed.sessions.some((s) => s.id === id && s.cols === 100));

      const killed = await client.call('kill', { id });
      assert.equal(killed.ok, true);
      await waitFor(() => client.events.some((f) => f.type === 'event' && f.event === 'exit' && f.id === id));

      const destroyed = await client.call('destroy', { id });
      assert.equal(destroyed.ok, true);
      await waitFor(() => client.events.some((f) => f.type === 'event' && f.event === 'destroyed' && f.id === id));

      const listedAfter = await client.call('list');
      assert.ok(!listedAfter.sessions.some((s) => s.id === id));
    } finally {
      client.close();
    }
  } finally {
    await rpc.close();
  }
});

test('an unknown session id fails with ok:false and a message, not a thrown/crashed connection', async () => {
  const store = new PtyStore();
  const rpc = await createRpcServer(store, { sockPath: join(sockDir, 'pty-host-2.sock') });
  try {
    const client = await connectClient(join(sockDir, 'pty-host-2.sock'));
    try {
      const res = await client.call('write', { id: 'does-not-exist', data: 'x' });
      assert.equal(res.ok, false);
      assert.match(res.error, /not found/);
    } finally {
      client.close();
    }
  } finally {
    await rpc.close();
  }
});

test('an unrecognized RPC type is rejected without touching PtyStore', async () => {
  const store = new PtyStore();
  const rpc = await createRpcServer(store, { sockPath: join(sockDir, 'pty-host-3.sock') });
  try {
    const client = await connectClient(join(sockDir, 'pty-host-3.sock'));
    try {
      const res = await client.call('not-a-real-rpc');
      assert.equal(res.ok, false);
      assert.match(res.error, /unknown RPC type/);
    } finally {
      client.close();
    }
  } finally {
    await rpc.close();
  }
});

test('closing the connection does not destroy its live session (passive teardown guarantee)', async () => {
  const sp = join(sockDir, 'pty-host-4.sock');
  const store = new PtyStore();
  const rpc = await createRpcServer(store, { sockPath: sp });
  try {
    const client = await connectClient(sp);
    const spawned = await client.call('spawn', {
      cwd: process.env.HOME || '/tmp',
      cols: 80,
      rows: 24,
      command: process.env.SHELL || '/bin/bash',
      args: [],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    await client.call('subscribe', { id: spawned.id });
    client.close();
    await sleep(100); // give the server's 'close' handler a moment to run

    assert.ok(store.list().some((s) => s.id === spawned.id), 'session survives its viewer connection dropping');
    store.destroy(spawned.id);
  } finally {
    await rpc.close();
  }
});

test('multiple frames written back-to-back in one flush are all processed', async () => {
  const sp = join(sockDir, 'pty-host-5.sock');
  const store = new PtyStore();
  const rpc = await createRpcServer(store, { sockPath: sp });
  try {
    const client = await connectClient(sp);
    try {
      const [a, b, c] = await Promise.all([
        client.call('ping'),
        client.call('ping'),
        client.call('ping'),
      ]);
      assert.ok(a.ok && b.ok && c.ok);
    } finally {
      client.close();
    }
  } finally {
    await rpc.close();
  }
});
