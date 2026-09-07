// UDS RPC/event server for pty-host (plan5 section 1.3): accepts connections
// from server本体, decodes length-prefixed JSON frames (see protocol.js),
// dispatches spawn/write/resize/kill/destroy/list/subscribe/unsubscribe/ping
// requests to a PtyStore, and forwards its push events (data/exit/destroyed)
// back to whichever connection(s) are currently subscribed.
//
// Socket lifecycle mirrors server/ws/mcpBroker.js's listenMcp(): remove a
// stale socket file left by an unclean previous exit before binding (a fresh
// EADDRINUSE would otherwise wedge every future start), and keep a permanent
// 'error' listener on the server so a later socket error logs instead of
// crashing the process.

import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { encodeFrame, FrameDecoder } from './protocol.js';

const RPC_TYPES = new Set(['spawn', 'write', 'resize', 'kill', 'destroy', 'list', 'subscribe', 'unsubscribe', 'ping']);

function send(socket, obj) {
  if (socket.destroyed) return;
  try {
    socket.write(encodeFrame(obj));
  } catch {
    // socket died between the destroyed check and the write -- drop it
  }
}

function dispatch(ptyStore, connId, { type, ...params }) {
  switch (type) {
    case 'ping':
      return { pong: true, now: Date.now() };
    case 'spawn':
      return ptyStore.spawn(params);
    case 'write': {
      const ok = ptyStore.write(params.id, params.data);
      if (!ok) throw new Error(`session "${params.id}" not found or already exited`);
      return { ok };
    }
    case 'resize': {
      const size = ptyStore.resize(params.id, params.cols, params.rows);
      if (!size) throw new Error(`session "${params.id}" not found`);
      return size;
    }
    case 'kill': {
      const ok = ptyStore.kill(params.id, params.signal);
      if (!ok) throw new Error(`session "${params.id}" not found or already exited`);
      return { ok };
    }
    case 'destroy': {
      const ok = ptyStore.destroy(params.id);
      if (!ok) throw new Error(`session "${params.id}" not found`);
      return { ok };
    }
    case 'list':
      return { sessions: ptyStore.list() };
    case 'subscribe': {
      const result = ptyStore.subscribe(params.id, connId, params.sinceSeq ?? null);
      if (!result) throw new Error(`session "${params.id}" not found`);
      return result;
    }
    case 'unsubscribe': {
      const ok = ptyStore.unsubscribe(params.id, connId);
      return { ok };
    }
    default:
      throw new Error(`unknown RPC type: ${type}`);
  }
}

export async function createRpcServer(ptyStore, { sockPath }) {
  try {
    rmSync(sockPath, { force: true });
  } catch {
    // best effort -- listen() below reports a real problem
  }

  const connections = new Map(); // connId -> socket

  const server = createServer((socket) => {
    const connId = randomUUID();
    connections.set(connId, socket);
    const decoder = new FrameDecoder();

    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        console.error(`[pty-host] connection ${connId} framing error: ${err.message}`);
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        const { reqId, type } = frame || {};
        if (!RPC_TYPES.has(type)) {
          send(socket, { reqId, ok: false, error: `unknown RPC type: ${type}` });
          continue;
        }
        try {
          const result = dispatch(ptyStore, connId, frame);
          send(socket, { reqId, ok: true, ...result });
        } catch (err) {
          send(socket, { reqId, ok: false, error: err.message });
        }
      }
    });

    socket.on('close', () => {
      connections.delete(connId);
      ptyStore.handleConnectionClose(connId);
    });
    socket.on('error', () => {
      // 'close' still fires after 'error' -- cleanup happens there.
    });
  });

  server.on('error', (err) => {
    console.error(`[pty-host] socket error: ${err.message}`);
  });

  await new Promise((resolve, reject) => {
    const onStartupError = (err) => reject(new Error(`[pty-host] listen failed: ${err.message}`));
    server.once('error', onStartupError);
    server.listen(sockPath, () => {
      server.off('error', onStartupError);
      resolve();
    });
  });

  // PtyStore push events (data/exit/destroyed) are addressed by connId; look
  // the live socket up here so PtyStore itself never touches net.Socket.
  ptyStore.setEventSink((connId, frameObj) => {
    const socket = connections.get(connId);
    if (socket) send(socket, frameObj);
  });

  return {
    server,
    sockPath,
    connectionCount: () => connections.size,
    close() {
      for (const socket of connections.values()) {
        try { socket.destroy(); } catch { /* already gone */ }
      }
      connections.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
