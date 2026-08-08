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
  const sock = net.createConnection(sockPath);
  sock.on('connect', () => {
    process.stdin.pipe(sock);
    sock.pipe(process.stdout);
  });
  sock.on('error', () => {
    if (attempt < 5) {
      setTimeout(() => connect(attempt + 1), 200);
    } else {
      process.stderr.write('sandbox: MCP broker unreachable\n');
      process.exit(1);
    }
  });
  sock.on('close', () => process.exit(0));
}
connect();
