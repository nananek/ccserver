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

// How long to wait (non-blocking) for the socket file after listen() reports
// success, before giving up.
const SOCKET_FILE_WAIT_MS = 2000;
const SOCKET_FILE_POLL_MS = 20;

function sockPathFor(groupId, tag) {
  const id = String(groupId).replace(/-/g, '');
  return join(RUNTIME_BASE, `ccserver-mcp-${id}-${tag}`);
}

// bwrap's --bind-try snapshots the socket file at mount time, so the file
// must exist before createSession()/buildSandboxSpawn() run. listen()'s
// callback fires once the socket is bound (the file exists by then), but
// poll non-blockingly for a short window anyway so a caller can never race
// the bind with a sandbox launch.
function waitForSocketFile(sockPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (existsSync(sockPath)) return resolve();
      if (Date.now() >= deadline) {
        return reject(new Error(`socket file ${sockPath} never appeared`));
      }
      setTimeout(poll, SOCKET_FILE_POLL_MS);
    };
    poll();
  });
}

// Async: resolves { server, sockPath, dir } once the socket is actually
// listening, or rejects with the listen error (or a timeout waiting for the
// socket file). Callers must propagate the rejection -- a silent failure
// here would leave sessions sandboxed with a bind to a socket nobody is
// listening on.
async function listenMcp({ groupId, tag, buildServer }) {
  const sockPath = sockPathFor(groupId, tag);
  const server = createServer((socket) => {
    const mcp = buildServer();
    const transport = new SocketTransport(socket);
    mcp.connect(transport);
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      reject(new Error(`[mcp-broker] ${tag} listen failed: ${err.message}`));
    });
    server.listen(sockPath, () => resolve());
  });
  try {
    await waitForSocketFile(sockPath, SOCKET_FILE_WAIT_MS);
  } catch (err) {
    try { server.close(); } catch { /* not listening */ }
    throw err;
  }
  return { server, sockPath, dir: null };
}

// deps: { groupId, groupManager, sessionManager }
export async function startControlBroker(deps) {
  return listenMcp({
    groupId: deps.groupId,
    tag: 'control',
    buildServer: () => buildControlMcpServer(deps),
  });
}

// deps: { groupId, role, getSessionId, groupManager, sessionManager }
export async function startHandoffChannel(deps) {
  return listenMcp({
    groupId: deps.groupId,
    tag: `handoff-${deps.role}`,
    buildServer: () => buildHandoffMcpServer(deps),
  });
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
