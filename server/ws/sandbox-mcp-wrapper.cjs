#!/ccserver-sandbox-node
// Runs INSIDE the sandbox (bound at /ccserver-sandbox-mcp-bridge, see
// sandbox.js). Relays the agent CLI's MCP stdio transport to the host-side
// MCP broker over a Unix socket: stdin -> socket, socket -> stdout. Both
// sides use newline-delimited JSON (MCP's stdio framing), so this is a plain
// byte pipe with no protocol logic.
//
// Which broker this reaches is decided by argv + which host socket was bound
// in (see mcpBroker.js / notify.js / usageMcp.js / metaAgent.js / reviewer.js):
//   plain      -> CCSANDBOX_MCP_SOCK  (the group's control / handoff socket)
//   'notify'   -> CCSANDBOX_NOTIFY_MCP_SOCK (the process-global notify socket)
//   'usage'    -> CCSANDBOX_USAGE_MCP_SOCK (the process-global usage socket)
//   'meta'     -> CCSANDBOX_META_MCP_SOCK (the process-global meta-agent socket)
//   'reviewer' -> CCSANDBOX_REVIEWER_MCP_SOCK (the process-global reviewer socket)
// The wrapper itself is role-agnostic.
//
// In notify mode the wrapper additionally writes a single JSON line
// `{"ccserver": <identity>}\n` as the FIRST frame on connect -- before any
// MCP bytes -- so the server can attribute this connection's notifications
// (see mcpBroker.js). The identity comes from the CCSERVER_NOTIFY_IDENTITY
// env set by mcpConfig.js; absent or unparseable it sends an empty object
// (host-only attribution). Meta mode writes the same kind of frame from
// CCSERVER_META_IDENTITY: the per-connection sessionId/groupId there power
// the meta tools' self-target guards and approval attribution. Reviewer mode
// writes the same kind of frame from CCSERVER_REVIEWER_IDENTITY: the
// per-connection sessionId there is how finish_review verifies the caller IS
// the review job it claims to be (see reviewer.js). Usage mode carries no
// identity at all (get_usage answers the same regardless of caller).
'use strict';
const net = require('net');
const mode = process.argv[2];
const IDENTITY_ENV = {
  notify: 'CCSERVER_NOTIFY_IDENTITY',
  meta: 'CCSERVER_META_IDENTITY',
  reviewer: 'CCSERVER_REVIEWER_IDENTITY',
};
const wantsIdentityFrame = !!IDENTITY_ENV[mode];
const MODE_SOCK_ENV = {
  notify: 'CCSANDBOX_NOTIFY_MCP_SOCK',
  usage: 'CCSANDBOX_USAGE_MCP_SOCK',
  meta: 'CCSANDBOX_META_MCP_SOCK',
  reviewer: 'CCSANDBOX_REVIEWER_MCP_SOCK',
};
const sockPath = process.env[MODE_SOCK_ENV[mode] || 'CCSANDBOX_MCP_SOCK'];
if (!sockPath) {
  process.stderr.write('sandbox: MCP bridge not configured\n');
  process.exit(1);
}

function parseIdentity(envValue) {
  if (!envValue) return {};
  try {
    const parsed = JSON.parse(envValue);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function connect(attempt = 0) {
  // A failed connect() fires 'error' and then immediately 'close'. The
  // close handler must NOT exit while a retry is scheduled, or the reconnect
  // logic would be dead on arrival (the very race this wrapper exists to
  // survive: the broker socket may not be in place yet at bind-try snapshot
  // time). `retrying` is how 'close' knows 'error' already scheduled one.
  let retrying = false;
  let established = false;
  const sock = net.createConnection(sockPath);
  sock.on('connect', () => {
    established = true;
    if (wantsIdentityFrame) {
      sock.write(`${JSON.stringify({ ccserver: parseIdentity(process.env[IDENTITY_ENV[mode]]) })}\n`);
    }
    process.stdin.pipe(sock);
    sock.pipe(process.stdout);
  });
  sock.on('error', () => {
    if (attempt < 5) {
      retrying = true;
      setTimeout(() => connect(attempt + 1), 200);
    } else {
      process.stderr.write('sandbox: MCP broker unreachable\n');
      process.exit(1);
    }
  });
  sock.on('close', () => {
    if (retrying) return; // 'error' already scheduled the next attempt
    if (established) process.exit(0); // broker teardown: relay over
    if (attempt < 5) setTimeout(() => connect(attempt + 1), 200);
    else process.exit(1);
  });
}
connect();
