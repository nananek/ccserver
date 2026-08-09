#!/ccserver-sandbox-node
// Runs INSIDE the sandbox (bound at /ccserver-sandbox-mcp-bridge, see
// sandbox.js). Relays the agent CLI's MCP stdio transport to the host-side
// MCP broker over a Unix socket: stdin -> socket, socket -> stdout. Both
// sides use newline-delimited JSON (MCP's stdio framing), so this is a plain
// byte pipe with no protocol logic.
//
// Which broker (control vs handoff) this reaches is decided entirely by which
// host socket was bound at CCSANDBOX_MCP_SOCK (see mcpBroker.js) -- the
// wrapper itself is role-agnostic.
'use strict';
const net = require('net');
const sockPath = process.env.CCSANDBOX_MCP_SOCK;
if (!sockPath) {
  process.stderr.write('sandbox: MCP bridge not configured\n');
  process.exit(1);
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
