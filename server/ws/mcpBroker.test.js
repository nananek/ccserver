// Wire-level integration test of the MCP broker: exercises the real
// mcpBroker.js UDS listeners + mcpServer.js + SocketTransport against a raw
// socket client speaking the MCP JSON-RPC framing (initialize / tools/list /
// tools/call), exactly as Claude Code / opencode would. No agent CLIs, no
// bwrap, no browser needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let runtimeDir;
let groupManager;
let broker;
let groupId;
let control;
let handoff;

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-mcp-wire-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  // Group persistence must never touch the repo-root state file during tests.
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  groupManager = await import('./groupManager.js');
  broker = await import('./mcpBroker.js');

  groupId = randomUUID();
  await groupManager.createGroup({ groupId, cwd: '/srv/proj', orchestratorDir: '/srv/orch' });
  groupManager.registerMember(groupId, 'workerA', 'wire-sess-a');
  groupManager.registerMember(groupId, 'orchestrator', 'wire-sess-o');
  control = groupManager.getGroup(groupId).controlBroker;
  handoff = await groupManager.createMemberHandoffChannel(groupId, 'workerA');
  handoff.sessionId = 'wire-sess-a';
});

after(() => {
  groupManager.destroyGroup(groupId);
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Newline-delimited JSON-RPC client over the UDS (MCP stdio framing).
function mcpClient(sockPath) {
  let id = 0;
  const pending = new Map();
  const sock = net.createConnection(sockPath);
  let buf = '';
  sock.setEncoding('utf-8');
  sock.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    }
  });
  return {
    connected: new Promise((resolve, reject) => {
      sock.on('connect', resolve);
      sock.on('error', reject);
    }),
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const reqId = ++id;
        pending.set(reqId, { resolve, reject });
        sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params })}\n`);
      });
    },
    close() { sock.end(); },
  };
}

async function callTool(client, name, args) {
  const result = await client.call('tools/call', { name, arguments: args });
  return JSON.parse(result.content[0].text);
}

test('control socket: MCP initialize handshake works over the UDS', async () => {
  const c = mcpClient(control.sockPath);
  await c.connected;
  const init = await c.call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'wire-test', version: '1' },
  });
  assert.equal(init.serverInfo.name, 'ccserver-control');
  assert.ok(init.capabilities.tools);
  c.close();
});

test('control socket: tools/list exposes all control tools', async () => {
  const c = mcpClient(control.sockPath);
  await c.connected;
  const { tools } = await c.call('tools/list');
  const names = tools.map((t) => t.name);
  for (const expected of ['list_group_sessions', 'read_output', 'send_input', 'open_tab', 'close_tab', 'get_tab_status', 'wait_for_handoff']) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  // Tool schemas must not expose groupId/sessionId/role as identity inputs.
  const waitTool = tools.find((t) => t.name === 'wait_for_handoff');
  assert.ok(!('groupId' in waitTool.inputSchema.properties));
  c.close();
});

// The whole isolation boundary rests on identity being closure-bound: no
// control tool may ever take a groupId from the wire. Structural check over
// EVERY tool's schema, so a future tool (or a schema edit to an existing one)
// that adds a groupId input fails this test instead of silently opening a
// cross-group hole.
test('no control tool schema accepts a groupId from the wire', async () => {
  const c = mcpClient(control.sockPath);
  await c.connected;
  const { tools } = await c.call('tools/list');
  for (const t of tools) {
    const props = t.inputSchema?.properties || {};
    assert.ok(
      !('groupId' in props),
      `${t.name} must never take groupId from the wire (identity is closure-bound)`,
    );
  }
  c.close();
});

// The handoff tool's only inputs are summary/status/nextRole -- a worker
// must not be able to declare its own identity.
test('handoff tool schema exposes only summary/status/nextRole (no identity inputs)', async () => {
  const c = mcpClient(handoff.sockPath);
  await c.connected;
  const { tools } = await c.call('tools/list');
  const props = tools[0].inputSchema.properties;
  for (const forbidden of ['sessionId', 'groupId', 'role']) {
    assert.ok(
      !(forbidden in props),
      `handoff_to_orchestrator must never accept ${forbidden} from the wire`,
    );
  }
  c.close();
});

test('control socket: tools/call list_group_sessions over the wire', async () => {
  const c = mcpClient(control.sockPath);
  await c.connected;
  const out = await callTool(c, 'list_group_sessions', {});
  assert.equal(out.members.length, 2);
  assert.deepEqual(out.members.map((m) => m.role).sort(), ['orchestrator', 'workerA']);
  c.close();
});

test('handoff socket: exposes ONLY handoff_to_orchestrator', async () => {
  const c = mcpClient(handoff.sockPath);
  await c.connected;
  const { tools } = await c.call('tools/list');
  assert.deepEqual(tools.map((t) => t.name), ['handoff_to_orchestrator']);
  c.close();
});

test('handoff socket: worker handoff reaches the control socket wait_for_handoff', async () => {
  const worker = mcpClient(handoff.sockPath);
  const orch = mcpClient(control.sockPath);
  await Promise.all([worker.connected, orch.connected]);

  const waitPromise = callTool(orch, 'wait_for_handoff', { timeoutMs: 2000 });
  const handoffRes = await callTool(worker, 'handoff_to_orchestrator', {
    summary: 'worker A finished the plan',
    status: 'done',
  });
  assert.deepEqual(handoffRes, { ok: true });

  const ev = await waitPromise;
  assert.equal(ev.fromSessionId, 'wire-sess-a');
  assert.equal(ev.fromRole, 'workerA');
  assert.equal(ev.summary, 'worker A finished the plan');
  assert.equal(ev.status, 'done');
  worker.close();
  orch.close();
});

// The handoff's fromSessionId/fromRole must come from the socket's closure
// even if a hostile worker tries to declare a different identity on the wire.
test('handoff socket: wire-supplied identity fields are ignored (closure wins)', async () => {
  const worker = mcpClient(handoff.sockPath);
  const orch = mcpClient(control.sockPath);
  await Promise.all([worker.connected, orch.connected]);

  const waitPromise = callTool(orch, 'wait_for_handoff', { timeoutMs: 2000 });
  const res = await callTool(worker, 'handoff_to_orchestrator', {
    summary: 'tampered attempt',
    status: 'done',
    sessionId: 'evil-session',
    groupId: 'evil-group',
    role: 'orchestrator',
  });
  assert.deepEqual(res, { ok: true });

  const ev = await waitPromise;
  assert.equal(ev.fromSessionId, 'wire-sess-a', 'identity must come from the socket closure, not the wire');
  assert.equal(ev.fromRole, 'workerA');
  assert.equal(ev.groupId, undefined, 'no groupId field may exist at all');
  worker.close();
  orch.close();
});

test('control socket: cross-group session refused over the wire (authorization boundary)', async () => {
  const otherGroupId = randomUUID();
  await groupManager.createGroup({ groupId: otherGroupId, cwd: '/srv/other', orchestratorDir: '/srv/other-orch' });
  groupManager.registerMember(otherGroupId, 'workerA', 'other-sess-x');

  const c = mcpClient(control.sockPath);
  await c.connected;
  const out = await callTool(c, 'read_output', { sessionId: 'other-sess-x', tail: 100 });
  assert.equal(out.error, 'unauthorized');
  c.close();
  groupManager.destroyGroup(otherGroupId);
});

test('control socket: wait_for_handoff times out quietly with timedOut:true', async () => {
  const c = mcpClient(control.sockPath);
  await c.connected;
  const out = await callTool(c, 'wait_for_handoff', { timeoutMs: 80 });
  assert.deepEqual(out, { timedOut: true });
  c.close();
});

// Regression: the startup wait used a once('error') rejecter that stayed
// attached after a successful listen; the first post-startup 'error' removed
// it (once), leaving the net.Server with ZERO 'error' listeners -- and an
// EventEmitter 'error' with no listeners throws, crashing the whole process
// on the SECOND error. A permanent handler must remain for the server's
// lifetime.
test('post-startup errors on the broker server never crash the process (permanent error handler)', async () => {
  const c = mcpClient(control.sockPath);
  await c.connected;
  c.close();

  const server = control.server;
  // Two consecutive errors: without the permanent handler the second one
  // throws synchronously.
  assert.doesNotThrow(() => {
    server.emit('error', new Error('first post-startup error'));
  });
  assert.doesNotThrow(() => {
    server.emit('error', new Error('second post-startup error'));
  });

  // The server still serves connections.
  const c2 = mcpClient(control.sockPath);
  await c2.connected;
  const { tools } = await c2.call('tools/list');
  assert.ok(tools.length > 0);
  c2.close();
});

// A client that drops its socket mid-handshake must never take the process
// down (the handshake promise would otherwise become an unhandled rejection)
// and the broker must keep serving new connections.
test('abrupt disconnect during handshake does not crash the broker', async () => {
  const sock = net.createConnection(control.sockPath);
  await new Promise((resolve, reject) => {
    sock.on('connect', resolve);
    sock.on('error', reject);
  });
  // Fire off an initialize frame, then slam the connection shut before the
  // handshake can complete.
  sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'rude', version: '1' } } })}\n`);
  sock.destroy();

  // Give the handshake a beat to (try to) settle, then confirm the broker
  // still accepts a normal client -- reaching here at all means no crash.
  await new Promise((r) => setTimeout(r, 100));
  const c = mcpClient(control.sockPath);
  await c.connected;
  const { tools } = await c.call('tools/list');
  assert.ok(tools.length > 0);
  c.close();
});

// The transport buffer must be bounded: a peer that never sends a newline
// must be dropped instead of pinning unbounded memory server-side.
test('oversized newline-less frame gets the connection dropped (buffer cap)', async () => {
  const sock = net.createConnection(control.sockPath);
  const closed = new Promise((resolve) => sock.on('close', resolve));
  await new Promise((resolve, reject) => {
    sock.on('connect', resolve);
    sock.on('error', reject);
  });
  sock.write('x'.repeat(1024 * 1024 + 1));
  await closed;

  // Broker still alive and serving.
  const c = mcpClient(control.sockPath);
  await c.connected;
  const { tools } = await c.call('tools/list');
  assert.ok(tools.length > 0);
  c.close();
});

// stopBroker must destroy established connections, not just stop accepting
// new ones: a lingering client socket would otherwise keep its McpServer
// alive after teardown.
test('stopBroker destroys established connections', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: '/srv/stop-test', orchestratorDir: '/srv/stop-test-orch' });
  const channel = await groupManager.createMemberHandoffChannel(gid, 'workerA');

  // One connection to observe the server-initiated close; a second one just
  // proves connections were fully established (accepted) before teardown.
  const closedByServer = new Promise((resolve) => {
    const raw = net.createConnection(channel.sockPath);
    raw.on('connect', () => {});
    raw.on('close', resolve);
    raw.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    const raw2 = net.createConnection(channel.sockPath);
    raw2.on('connect', resolve);
    raw2.on('error', reject);
  });

  broker.stopBroker(channel);
  await closedByServer;
  groupManager.destroyGroup(gid);
});
