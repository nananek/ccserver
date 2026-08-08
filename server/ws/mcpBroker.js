// Unix-socket MCP brokers for combo groups, listening in the main Node
// process. Mirrors the git-broker pattern (fixed-path wrapper + socket bound
// into the sandbox) but WITHOUT a separate process: the MCP tools need direct
// access to in-memory sessions/pty/outputBuffers, so the listeners live in
// this process and hand each connection a fresh MCP server instance (MCP's
// initialize handshake is per-connection).
//
//   startControlBroker  -> orchestrator's socket (control tools)
//   startHandoffChannel -> one socket per worker (handoff_to_orchestrator only)
//   stopBroker          -> close listener + remove runtime dir
//
// Host socket paths live under XDG_RUNTIME_DIR (ccserver-mcp-<groupId>-<tag>),
// derived from the full dashless groupId so each group's channels are unique
// without a fresh UUID per channel -- Unix socket paths are limited to ~104
// chars, and a per-channel random UUID pushed control/handoff paths over it.

import { createServer } from 'node:net';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SocketTransport, buildControlMcpServer, buildHandoffMcpServer } from './mcpServer.js';

const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const RUNTIME_BASE = process.env.XDG_RUNTIME_DIR || `/run/user/${UID}`;

function sockPathFor(groupId, tag) {
  const id = String(groupId).replace(/-/g, '');
  return join(RUNTIME_BASE, `ccserver-mcp-${id}-${tag}`);
}

function listenMcp({ groupId, tag, buildServer }) {
  const sockPath = sockPathFor(groupId, tag);

  const server = createServer((socket) => {
    const mcp = buildServer();
    const transport = new SocketTransport(socket);
    mcp.connect(transport);
    socket.on('error', () => {});
  });
  server.on('error', (err) => {
    console.error(`[mcp-broker] ${tag} listen failed: ${err.message}`);
  });
  server.listen(sockPath);

  // bwrap's --bind-try snapshots the socket file at mount time, so the socket
  // must already exist before createSession()/buildSandboxSpawn() run. listen()
  // is async; busy-wait briefly until the file is there (same trick as
  // git-broker's startGitBroker).
  const deadline = Date.now() + 2000;
  while (!existsSync(sockPath) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }

  return { server, sockPath, dir: null };
}

// deps: { groupId, groupManager, sessionManager }
export function startControlBroker(deps) {
  const broker = listenMcp({
    groupId: deps.groupId,
    tag: 'control',
    buildServer: () => buildControlMcpServer(deps),
  });
  return { server: broker.server, sockPath: broker.sockPath, dir: broker.dir };
}

// deps: { groupId, role, getSessionId, groupManager, sessionManager }
export function startHandoffChannel(deps) {
  const broker = listenMcp({
    groupId: deps.groupId,
    tag: `handoff-${deps.role}`,
    buildServer: () => buildHandoffMcpServer(deps),
  });
  return { server: broker.server, sockPath: broker.sockPath, dir: broker.dir };
}

export function stopBroker({ server, sockPath }) {
  if (server) {
    try {
      server.close();
    } catch {
      // already closed / never started
    }
  }
  if (sockPath) {
    try {
      rmSync(sockPath, { force: true });
    } catch {
      // best effort
    }
  }
}
