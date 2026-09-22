// Regression coverage for mcpServer.js's tool input schemas.
//
// mcpTools.js's capSandboxOpts and groupManager.js's normalizeSandboxOpts were
// fixed (PR#114 review) to stop dropping sandboxOpts.tools -- but both only
// ever see whatever the MCP SDK's own zod parsing lets through. The SDK
// parses incoming tool arguments against the exact zod object each
// server.tool(...) call was registered with (mcp.js: safeParseAsync(schema,
// args) -> parseResult.data is what the handler receives), and a bare
// z.object({...}) silently STRIPS any key that isn't in its shape. Every
// sandboxOpts schema here used to be `{ gpg, sshAgent }` only, so even after
// capSandboxOpts/normalizeSandboxOpts learned about tools, a real MCP call
// (open_tab) would have its sandboxOpts.tools silently vanish before
// capSandboxOpts ever ran -- these tests exercise that exact parse step, not
// just the capping logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildControlMcpServer, sandboxOptsSchema } from './mcpServer.js';

const TOOLS_PAYLOAD = { gpg: true, sshAgent: true, tools: { rtk: true, codeReviewGraph: true } };

test('sandboxOptsSchema (shared by open_tab/launch_session/launch_group) preserves tools through parsing', async () => {
  const res = await sandboxOptsSchema.safeParseAsync(TOOLS_PAYLOAD);
  assert.ok(res.success, res.error?.message);
  assert.deepEqual(res.data, TOOLS_PAYLOAD);
});

test('sandboxOptsSchema still omits an unrequested tools key (no key invented out of nothing)', async () => {
  const res = await sandboxOptsSchema.safeParseAsync({ gpg: true, sshAgent: false });
  assert.ok(res.success, res.error?.message);
  assert.deepEqual(res.data, { gpg: true, sshAgent: false });
});

// Reaches into McpServer's internal tool registry (_registeredTools) to grab
// the ACTUAL zod object each tool was registered with -- the same object the
// SDK runs safeParseAsync against for a real tools/call request (see
// mcp.js's callTool). This is the most direct way to prove the wire-level
// bug is fixed without standing up a full socket transport (mcpBroker.test.js
// already covers that for the group control server's open_tab over a real
// UDS).
function inputSchemaFor(server, toolName) {
  const tool = server._registeredTools[toolName];
  assert.ok(tool, `${toolName} must be registered`);
  return tool.inputSchema;
}

test('open_tab (control server) input schema preserves sandboxOpts.tools', async () => {
  const server = buildControlMcpServer({});
  const res = await inputSchemaFor(server, 'open_tab').safeParseAsync({
    role: 'workerA',
    cwd: '/srv/project',
    sandboxOpts: TOOLS_PAYLOAD,
  });
  assert.ok(res.success, res.error?.message);
  assert.deepEqual(res.data.sandboxOpts, TOOLS_PAYLOAD);
});
