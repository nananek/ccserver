// MCP servers for combo groups, hosted in the main Node process (same process
// as the pty sessions, so tools can reach sessions/outputBuffers directly).
// Runs over a Unix socket via SocketTransport -- MCP's stdio framing is
// newline-delimited JSON, so no framing conversion is needed.
//
// Two distinct servers per group:
//   control (buildControlMcpServer)  -- reachable only by the orchestrator
//     socket. Tools can inspect/type into any member and wait for handoffs.
//   handoff (buildHandoffMcpServer)  -- one per worker socket, exposing only
//     handoffToOrchestrator. The worker cannot read other sessions.
//
// groupId / sessionId / role are bound in the per-connection closure; they are
// never taken from tool arguments (see mcpTools.js -- the authorization
// boundary depends on this).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as tools from './mcpTools.js';

export class SocketTransport {
  constructor(socket) {
    this.socket = socket;
    this._buf = '';
  }

  start() {
    this.socket.setEncoding('utf-8');
    this.socket.on('data', (chunk) => {
      this._buf += chunk;
      let nl;
      while ((nl = this._buf.indexOf('\n')) !== -1) {
        const line = this._buf.slice(0, nl);
        this._buf = this._buf.slice(nl + 1);
        if (line.trim()) {
          try {
            this.onmessage?.(JSON.parse(line));
          } catch {
            // drop malformed frames
          }
        }
      }
    });
    this.socket.on('close', () => this.onclose?.());
    this.socket.on('error', (e) => this.onerror?.(e));
  }

  send(message) {
    this.socket.write(`${JSON.stringify(message)}\n`);
    return Promise.resolve();
  }

  close() {
    this.socket.end();
  }
}

// deps: { groupId, groupManager, sessionManager }
export function buildControlMcpServer(deps) {
  const server = new McpServer({ name: 'ccserver-control', version: '1.0.0' });

  server.tool(
    'list_group_sessions',
    'List all sessions in this orchestration group (workers and orchestrator) with role, app, cwd and live status.',
    {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(tools.listGroupSessions(deps)) }] }),
  );

  server.tool(
    'read_output',
    'Read the recent terminal output of a group member session. Returns raw bytes and ANSI-stripped text. This is a fallback for inspecting a possibly-stuck member -- for normal flow, prefer wait_for_handoff.',
    { sessionId: z.string(), tail: z.number().optional() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(tools.readOutput(deps, args)) }] }),
  );

  server.tool(
    'send_input',
    'Type text into a group member session terminal, optionally submitting with Enter (submit defaults true). This sends keystrokes, not a shell command primitive.',
    { sessionId: z.string(), text: z.string(), submit: z.boolean().optional() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(tools.sendInput(deps, args)) }] }),
  );

  server.tool(
    'open_tab',
    'Open a new worker session inside this group (with its own handoff channel) and return its sessionId. role must be a worker role (workerA, workerB, ...) -- never orchestrator. cwd is restricted to the group project directory. sandboxOpts (gpg/ssh-agent forwarding) defaults to the group launch flags.',
    {
      role: z.string().regex(/^worker[A-Za-z0-9_-]+$/),
      app: z.enum(['claude', 'opencode']),
      cwd: z.string(),
      sandboxOpts: z.object({ gpg: z.boolean().optional(), sshAgent: z.boolean().optional() }).optional(),
    },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await tools.openTab(deps, args)) }] }),
  );

  server.tool(
    'close_tab',
    'Terminate a group member session (worker or orchestrator) and clean up its channel.',
    { sessionId: z.string() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(tools.closeTab(deps, args)) }] }),
  );

  server.tool(
    'get_tab_status',
    'Return the live status of a group member session (exited, connected, cwd, app).',
    { sessionId: z.string() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(tools.getTabStatus(deps, args)) }] }),
  );

  server.tool(
    'wait_for_handoff',
    'Block until a worker calls handoff_to_orchestrator, or the timeout elapses. Returns the structured handoff event (worker, summary, status) -- or {timedOut:true} on timeout, in which case simply call wait_for_handoff again. Call this once per turn instead of polling read_output.',
    { timeoutMs: z.number().optional() },
    async (args) => {
      const result = await tools.waitForHandoff(deps, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  return server;
}

// deps: { groupId, role, getSessionId, groupManager, sessionManager }
export function buildHandoffMcpServer(deps) {
  const server = new McpServer({ name: 'ccserver-handoff', version: '1.0.0' });

  server.tool(
    'handoff_to_orchestrator',
    'Notify the orchestrator that your task is complete, blocked, needs input, or hit an error. Call this exactly once when you finish a task or when you need the orchestrator to make a decision. The orchestrator is waiting on wait_for_handoff and will see the summary you provide here.',
    { summary: z.string(), status: z.enum(['done', 'blocked', 'needs_input', 'error']).optional(), nextRole: z.string().optional() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(tools.handoffToOrchestrator(deps, args)) }] }),
  );

  return server;
}
