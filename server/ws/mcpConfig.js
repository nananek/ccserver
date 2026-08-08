// Builds the MCP server registration that combo-launched sessions (workers and
// orchestrator) get injected with -- never written to a file on the host or in
// the repo. Both CLIs get the same fixed config: "run the bridge script at the
// fixed in-sandbox path". Whether that bridge reaches the control broker or a
// handoff channel is decided solely by which host socket got bound to
// /ccserver-sandbox-mcp.sock in the sandbox (see sandbox.js / mcpBroker.js).
//
//   claude   -> CLI arg `--mcp-config '<inline JSON>'` (process-scoped, does
//               not touch ~/.claude.json's shared projects key, so parallel
//               sessions in the same cwd cannot collide).
//   opencode -> OPENCODE_CONFIG_CONTENT env var (deep-merged with project
//               config, no file written).
//
// Returns { args, env } for sessionManager to splice into the pty spawn.

const MCP_BRIDGE_COMMAND = '/ccserver-sandbox-mcp-bridge';

export function buildMcpConfigArgsAndEnv(app) {
  if (app === 'opencode') {
    return {
      args: [],
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          mcp: {
            ccserver: { type: 'local', command: [MCP_BRIDGE_COMMAND] },
          },
        }),
      },
    };
  }
  return {
    args: [
      '--mcp-config',
      JSON.stringify({
        mcpServers: {
          ccserver: { type: 'stdio', command: MCP_BRIDGE_COMMAND, args: [] },
        },
      }),
    ],
    env: {},
  };
}
