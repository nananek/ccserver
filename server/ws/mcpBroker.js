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
import { SocketTransport, buildControlMcpServer, buildHandoffMcpServer, buildNotifyMcpServer, buildUsageMcpServer, buildMetaMcpServer, buildReviewerMcpServer, MAX_TRANSPORT_BUFFER_CHARS } from './mcpServer.js';

const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const RUNTIME_BASE = process.env.XDG_RUNTIME_DIR || `/run/user/${UID}`;

// How long to wait (non-blocking) for the socket file after listen() reports
// success, before giving up.
const SOCKET_FILE_WAIT_MS = 2000;
const SOCKET_FILE_POLL_MS = 20;

// How long to wait for the per-connection identity frame (the notify bridge's
// first line) before giving up on it. Bounded so a client that connects and
// sends nothing is handed to the transport within a short grace window, never
// held hostage on the frame.
const IDENTITY_FRAME_GRACE_MS = 1000;

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
// listening on. Pass an explicit `sockPath` to host a server at a path of
// your choosing (the process-global ccserver-notify socket, see notify.js);
// otherwise the path is derived from groupId + tag.
async function listenMcp({ groupId, tag, buildServer, sockPath }) {
  const target = sockPath || sockPathFor(groupId, tag);
  // A socket file left over from a crash (teardown never ran) would make
  // listen() fail with EADDRINUSE. The path is group-scoped and derived, so
  // a stale file can never belong to a live listener -- safe to drop. The
  // notify socket is single-instance per server process, so its stale file
  // is equally safe to drop.
  try {
    rmSync(target, { force: true });
  } catch {
    // best effort
  }
  const connections = new Set(); // accepted sockets, destroyed on stopBroker
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});

    // Per-connection identity handoff (see notify.js / mcpConfig.js): the
    // notify bridge wrapper writes one JSON line `{"ccserver": {...}}\n` as
    // the very first frame, before piping the agent's MCP bytes. Read up to
    // the first newline (bounded, with a short grace window so a client that
    // never sends is not held forever) and decide:
    //   - the first line parses as {"ccserver": <object>} -> that object is
    //     this connection's identity; the bytes after the newline are the
    //     MCP data.
    //   - anything else (legacy wrapper, direct MCP client) -> replay the
    //     whole buffer as MCP data and carry no identity.
    // control/handoff buildServer closures ignore the identity argument, so
    // this only feeds the notify server's attribution.
    let buf = '';
    let settled = false;
    let graceTimer = null;

    const settleConnection = (seed, identity) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      socket.removeListener('data', onFrameData);
      if (socket.destroyed) return;
      // Stop the flow while the transport takes over: data that arrived
      // after the frame read is buffered by the paused socket and replayed
      // to the transport's own handler once it starts.
      socket.pause();
      const transport = new SocketTransport(socket, seed);
      // Per-connection liveness oracle for tools that must not act on behalf
      // of a connection whose client is gone (e.g. wait_for_handoff must not
      // dequeue an event for a dead socket -- the event would be lost). The
      // transport is created before the server so the closure can observe its
      // close state; buildServer receives it as the second argument (control/
      // handoff servers thread it into their deps; the notify server ignores
      // it).
      const connectionIsAlive = () => !socket.destroyed && !transport._closed;
      const mcp = buildServer(identity, connectionIsAlive);
      // mcp.connect() is async (transport.start() + the MCP initialize
      // handshake). A rejected promise here must NOT become an unhandled
      // rejection (Node's default --unhandled-rejections=throw would crash the
      // whole server, every unrelated pty included) -- e.g. a sandbox torn
      // down right after accept leaves a socket that dies mid-handshake. Log
      // and close the connection; the broker itself stays up.
      mcp.connect(transport).catch((err) => {
        console.error(`[mcp-broker] ${tag} connection handshake failed: ${err.message}`);
        try { socket.destroy(); } catch { /* already gone */ }
      });
    };

    const onFrameData = (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        const rest = buf.slice(nl + 1);
        let identity = null;
        let seed = buf;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === 'object' && parsed.ccserver && typeof parsed.ccserver === 'object') {
            identity = parsed.ccserver;
            seed = rest;
          }
        } catch {
          // not JSON / not an identity frame -- replay the whole buffer
        }
        settleConnection(seed, identity);
      } else if (buf.length > MAX_TRANSPORT_BUFFER_CHARS) {
        // No newline but the buffer is at the transport's cap: this can't be
        // a small identity frame -- replay everything and let the transport's
        // own overflow handling drop the connection.
        settleConnection(buf, null);
      }
    };

    socket.setEncoding('utf-8');
    socket.pause();
    socket.on('data', onFrameData);
    socket.resume();

    // A client that connects but sends nothing must not hang the broker:
    // after a short grace the (possibly empty) buffer is replayed with no
    // identity, exactly like the legacy path.
    graceTimer = setTimeout(() => {
      settleConnection(buf, null);
    }, IDENTITY_FRAME_GRACE_MS);
  });
  // Permanent error handler: an EventEmitter 'error' with zero listeners
  // throws and crashes the whole process, so this must NEVER be removed once
  // the server exists. Startup failure detection uses a separate once-listener
  // that is explicitly removed on success (see below).
  server.on('error', (err) => {
    console.error(`[mcp-broker] ${tag} socket error: ${err.message}`);
  });
  await new Promise((resolve, reject) => {
    const onStartupError = (err) => {
      reject(new Error(`[mcp-broker] ${tag} listen failed: ${err.message}`));
    };
    server.once('error', onStartupError);
    server.listen(target, () => {
      // Listening succeeded -- detach the startup-only rejecter so it can't
      // linger and fire on a later, unrelated error.
      server.off('error', onStartupError);
      resolve();
    });
  });
  try {
    await waitForSocketFile(target, SOCKET_FILE_WAIT_MS);
  } catch (err) {
    for (const socket of connections) {
      try { socket.destroy(); } catch { /* already gone */ }
    }
    try { server.close(); } catch { /* not listening */ }
    throw err;
  }
  return { server, sockPath: target, dir: null, connections };
}

// deps: { groupId, groupManager, sessionManager }
export async function startControlBroker(deps) {
  return listenMcp({
    groupId: deps.groupId,
    tag: 'control',
    // Per-connection deps: the liveness closure differs per accepted socket,
    // so the server is built with a connection-specific deps object, not the
    // shared one (a shared deps could never carry per-connection state).
    buildServer: (identity, connectionIsAlive) => buildControlMcpServer({ ...deps, connectionIsAlive }),
  });
}

// deps: { groupId, role, getSessionId, groupManager, sessionManager }
export async function startHandoffChannel(deps) {
  return listenMcp({
    groupId: deps.groupId,
    tag: `handoff-${deps.role}`,
    buildServer: (identity, connectionIsAlive) => buildHandoffMcpServer({ ...deps, connectionIsAlive }),
  });
}

// The process-global notification broker (ccserver-notify, see notify.js).
// One per server process at the caller-provided sockPath (getNotifySockPath).
// NOT group-scoped: the notify tools are process-wide, so the socket is bound
// into every notify-enabled session's sandbox.
export async function startNotifyBroker({ notifyApi, sockPath }) {
  return listenMcp({
    sockPath,
    tag: 'notify',
    buildServer: (identity) => buildNotifyMcpServer({ notifyApi, identity }),
  });
}

// The process-global usage broker (ccserver-usage, see usageMcp.js). One per
// server process. NOT group-scoped, and NOT session-attributed (unlike
// notify) -- get_usage always returns the same server-wide snapshot
// regardless of which session asks.
export async function startUsageBroker({ usageApi, sockPath }) {
  return listenMcp({
    sockPath,
    tag: 'usage',
    buildServer: () => buildUsageMcpServer({ usageApi }),
  });
}

// The process-global meta-agent broker (ccserver-meta, see metaAgent.js). One
// per server process, NOT group-scoped -- this is the single PRIVILEGED
// socket through which the meta agent manages every group/session/sandbox.
// The per-connection identity frame (CCSERVER_META_IDENTITY via the bridge,
// same mechanism as notify) carries the caller's own sessionId/groupId for
// the tools' self-target guards; the trust boundary itself is that exactly
// one sandbox ever binds this socket.
export async function startMetaBroker({ metaDeps, sockPath }) {
  return listenMcp({
    sockPath,
    tag: 'meta',
    // Per-connection deps: the identity frame differs per accepted socket, so
    // the server is built with a connection-specific deps object (the shared
    // metaDeps carry only process-global managers).
    buildServer: (identity, connectionIsAlive) => buildMetaMcpServer({ ...metaDeps, identity, connectionIsAlive }),
  });
}

// The process-global reviewer broker (ccserver-reviewer, see reviewer.js).
// One per server process. NOT group-scoped, but DOES carry a per-connection
// identity frame (CCSERVER_REVIEWER_IDENTITY, same mechanism as notify/meta)
// -- unlike run_review/list_reviews/get_review (whose attribution, if any,
// rides in run_review's own `requestedBy` argument), finish_review needs to
// verify the CALLER is the very session the job launched, and the identity
// frame's sessionId is what it checks against.
export async function startReviewerBroker({ reviewerApi, sockPath }) {
  return listenMcp({
    sockPath,
    tag: 'reviewer',
    buildServer: (identity) => buildReviewerMcpServer({ reviewerApi, identity }),
  });
}

export function stopBroker({ server, sockPath, connections }) {
  // Drop established connections too: server.close() only stops accepting
  // new ones, and a lingering connected socket would keep its McpServer
  // (and its queued handoffs/waits) alive for as long as the client holds
  // the connection open.
  if (connections) {
    for (const socket of connections) {
      try {
        socket.destroy();
      } catch {
        // already gone
      }
    }
  }
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
