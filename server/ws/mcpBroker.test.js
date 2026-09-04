// Wire-level integration test of the MCP broker: exercises the real
// mcpBroker.js UDS listeners + mcpServer.js + SocketTransport against a raw
// socket client speaking the MCP JSON-RPC framing (initialize / tools/list /
// tools/call), exactly as Claude Code / opencode would. No agent CLIs, no
// bwrap, no browser needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
    raw: sock,
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

// Raw variant: returns the full tools/call result so tests can inspect
// isError / non-JSON error payloads (e.g. a handler exception surfacing as
// { content: [...], isError: true }).
async function callToolRaw(client, name, args) {
  return client.call('tools/call', { name, arguments: args });
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
  for (const expected of ['list_group_sessions', 'read_output', 'send_input', 'new_session', 'send_key', 'open_tab', 'close_tab', 'get_tab_status', 'wait_for_handoff']) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  // Tool schemas must not expose groupId/sessionId/role as identity inputs.
  const waitTool = tools.find((t) => t.name === 'wait_for_handoff');
  assert.ok(!('groupId' in waitTool.inputSchema.properties));
  c.close();
});

// new_session must take ONLY the target sessionId (role/app/model/cwd are
// resolved server-side from the closure-bound group); send_key must expose
// nothing beyond sessionId + the escape enum -- the wire can never carry a
// raw byte, another key, or an ANSI sequence (no generic keystroke channel).
test('new_session and send_key schemas: minimal inputs, no raw-key channel', async () => {
  const c = mcpClient(control.sockPath);
  await c.connected;
  const { tools } = await c.call('tools/list');

  const newSession = tools.find((t) => t.name === 'new_session');
  assert.ok(newSession, 'new_session is exposed');
  const newProps = newSession.inputSchema.properties;
  assert.ok('sessionId' in newProps, 'sessionId is the only target input');
  for (const forbidden of ['groupId', 'role', 'app', 'model', 'cwd', 'sandboxOpts']) {
    assert.ok(!(forbidden in newProps), `new_session must never take ${forbidden} from the wire`);
  }

  const sendKey = tools.find((t) => t.name === 'send_key');
  assert.ok(sendKey, 'send_key is exposed');
  const keyProps = sendKey.inputSchema.properties;
  assert.ok('sessionId' in keyProps);
  assert.deepEqual(keyProps.key.enum, ['escape'], 'the whitelist is exactly escape');
  for (const forbidden of ['groupId', 'text', 'bytes', 'sequence']) {
    assert.ok(!(forbidden in keyProps), `send_key must never take ${forbidden} from the wire`);
  }

  // The enum is enforced at the protocol layer: anything beyond it -- a named
  // key like ctrl-c or a literal control byte -- is rejected before any tool
  // code runs (the SDK surfaces zod failures as isError results).
  const namedKey = await callToolRaw(c, 'send_key', { sessionId: 'wire-sess-a', key: 'ctrl-c' });
  assert.equal(namedKey.isError, true, 'named non-whitelisted keys are rejected on the wire');
  assert.match(namedKey.content[0].text, /Invalid arguments for tool send_key/);
  const rawBytes = await callToolRaw(c, 'send_key', { sessionId: 'wire-sess-a', key: '\x1b' });
  assert.equal(rawBytes.isError, true, 'raw control bytes are rejected on the wire');
  const ctrlCByte = await callToolRaw(c, 'send_key', { sessionId: 'wire-sess-a', key: '\x03' });
  assert.equal(ctrlCByte.isError, true, 'Ctrl-C as a raw byte is not a whitelisted key either');
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

// open_tab accepts an optional model (string or null) and an optional app;
// cwd stays required and identity fields stay absent (model must not affect
// authorization). The persisted-role fallback for omitted values is exercised
// in mcpTools.test.js -- here the wire schema shape is asserted.
test('open_tab schema: optional model/app, required cwd, no identity inputs', async () => {
  const c = mcpClient(control.sockPath);
  await c.connected;
  const { tools } = await c.call('tools/list');
  const openTab = tools.find((t) => t.name === 'open_tab');
  assert.ok(openTab, 'open_tab is exposed');
  const props = openTab.inputSchema.properties;
  assert.ok('model' in props, 'model is a declared input');
  assert.equal(props.model.anyOf[0].type, 'string');
  assert.equal(props.model.anyOf[1].type, 'null');
  assert.equal(props.app.type, 'string');
  assert.deepEqual(props.app.enum, ['claude', 'opencode', 'codex']);
  assert.ok(openTab.inputSchema.required.includes('role'), 'role stays required (never defaulted)');
  assert.ok(openTab.inputSchema.required.includes('cwd'), 'cwd stays required');
  for (const forbidden of ['groupId', 'sessionId']) {
    assert.ok(!(forbidden in props), `open_tab must never take ${forbidden} from the wire`);
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

test('handoff socket: exposes ONLY handoff_to_orchestrator and the doc-sharing tools', async () => {
  const c = mcpClient(handoff.sockPath);
  await c.connected;
  const { tools } = await c.call('tools/list');
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['fetch_doc', 'fetch_file', 'handoff_to_orchestrator', 'list_docs', 'list_files', 'publish_doc', 'publish_file'].sort(),
  );
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

// The process-global notification broker (ccserver-notify, see notify.js /
// mcpServer.js's buildNotifyMcpServer): startNotifyBroker hosts it at the
// caller-supplied socket (not group-derived), exposes exactly the four notify
// tools, and stopBroker tears it down including the socket file.
test('notify broker: startNotifyBroker + stopBroker lifecycle on a supplied socket path', async () => {
  const notifyApi = {
    sendNotification: async () => ({ ok: true, delivered: { discord: false, webhooks: 1, failed: 0 } }),
    subscribe: () => ({ ok: true, subscription: { id: 'sub-1' } }),
    unsubscribe: () => ({ ok: true }),
    listSubscriptions: () => [{ id: 'sub-1', url: 'https://example.com/hook' }],
  };
  const notify = await broker.startNotifyBroker({
    notifyApi,
    sockPath: join(runtimeDir, 'ccserver-notify.sock'),
  });
  try {
    const c = mcpClient(notify.sockPath);
    await c.connected;
    const init = await c.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wire-test', version: '1' },
    });
    assert.equal(init.serverInfo.name, 'ccserver-notify');
    const { tools } = await c.call('tools/list');
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['list_subscriptions', 'notify', 'subscribe', 'unsubscribe'],
    );
    const out = await callTool(c, 'list_subscriptions', {});
    assert.deepEqual(out, { subscriptions: [{ id: 'sub-1', url: 'https://example.com/hook' }] });
    c.close();
  } finally {
    broker.stopBroker(notify);
    assert.equal(existsSync(notify.sockPath), false, 'stopBroker removes the socket file');
  }
});

// The notify bridge wrapper writes a single `{"ccserver": <identity>}\n`
// frame as the first bytes of a connection, before any MCP traffic. The
// broker must attribute that connection's notifications with it -- the notify
// tool's notifyApi.sendNotification receives it as its second argument. The
// tool's own schema stays { title, body, level? }; the identity rides the
// connection, never the wire.
test('notify broker: an identity frame on connect reaches the notify tool as connection identity', async () => {
  const seenIdentities = [];
  const identity = {
    sessionId: '0123456789abcdef',
    groupId: 'grp-12345678',
    groupRole: 'orchestrator',
    cwd: '/srv/proj',
    projectName: 'proj',
    app: 'claude',
  };
  const notifyApi = {
    sendNotification: async (args, connIdentity) => {
      seenIdentities.push(connIdentity);
      return { ok: true, delivered: { discord: false, webhooks: 0, failed: 0 } };
    },
    subscribe: () => ({ ok: true, subscription: { id: 'sub-1' } }),
    unsubscribe: () => ({ ok: true }),
    listSubscriptions: () => [],
  };
  const notify = await broker.startNotifyBroker({
    notifyApi,
    sockPath: join(runtimeDir, 'ccserver-notify-identity.sock'),
  });
  try {
    const c = mcpClient(notify.sockPath);
    await c.connected;
    // The identity frame must be written BEFORE the MCP initialize -- exactly
    // what the sandbox bridge does on connect.
    c.raw.write(`${JSON.stringify({ ccserver: identity })}\n`);
    await c.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wire-test', version: '1' },
    });
    await callTool(c, 'notify', { title: 'Build failed', body: 'details here', level: 'error' });
    assert.equal(seenIdentities.length, 1);
    assert.deepEqual(seenIdentities[0], identity, 'the frame identity is passed to sendNotification');
    c.close();
  } finally {
    broker.stopBroker(notify);
  }
});

// A client that skips the identity frame entirely (legacy wrapper without
// CCSERVER_NOTIFY_IDENTITY, or a direct MCP client) must still work: the first
// line is not an identity frame, so it is replayed as MCP data and the
// connection carries no identity (host-only attribution).
test('notify broker: frameless clients are replayed and carry no identity', async () => {
  const seenIdentities = [];
  const notifyApi = {
    sendNotification: async (args, connIdentity) => {
      seenIdentities.push(connIdentity);
      return { ok: true, delivered: { discord: false, webhooks: 0, failed: 0 } };
    },
    subscribe: () => ({ ok: true, subscription: { id: 'sub-1' } }),
    unsubscribe: () => ({ ok: true }),
    listSubscriptions: () => [],
  };
  const notify = await broker.startNotifyBroker({
    notifyApi,
    sockPath: join(runtimeDir, 'ccserver-notify-frameless.sock'),
  });
  try {
    const c = mcpClient(notify.sockPath);
    await c.connected;
    const init = await c.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wire-test', version: '1' },
    });
    assert.equal(init.serverInfo.name, 'ccserver-notify');
    const { tools } = await c.call('tools/list');
    assert.equal(tools.length, 4, 'all four notify tools exposed without a frame');
    await callTool(c, 'notify', { title: 'plain', body: 'message' });
    assert.deepEqual(seenIdentities, [null], 'no frame -> no connection identity');
    c.close();
  } finally {
    broker.stopBroker(notify);
  }
});

// A hostile identity frame must never crash the broker or leak into another
// connection: a frame that is not the {"ccserver": ...} shape is replayed as
// ordinary MCP bytes (dropped by the transport as malformed), and the
// connection serves a clean notify server.
test('notify broker: a non-ccserver first line is replayed, never treated as identity', async () => {
  const notifyApi = {
    sendNotification: async () => ({ ok: true, delivered: { discord: false, webhooks: 0, failed: 0 } }),
    subscribe: () => ({ ok: true, subscription: { id: 'sub-1' } }),
    unsubscribe: () => ({ ok: true }),
    listSubscriptions: () => [],
  };
  const notify = await broker.startNotifyBroker({
    notifyApi,
    sockPath: join(runtimeDir, 'ccserver-notify-junk.sock'),
  });
  try {
    const c = mcpClient(notify.sockPath);
    await c.connected;
    // {"ccserver": "not-an-object"} is not a valid identity frame.
    c.raw.write(`${JSON.stringify({ ccserver: 'junk' })}\n`);
    const init = await c.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wire-test', version: '1' },
    });
    assert.equal(init.serverInfo.name, 'ccserver-notify');
    const { tools } = await c.call('tools/list');
    assert.equal(tools.length, 4);
    c.close();
  } finally {
    broker.stopBroker(notify);
  }
});

// The process-global usage broker (ccserver-usage, see usageMcp.js /
// mcpServer.js's buildUsageMcpServer): startUsageBroker hosts it at the
// caller-supplied socket, exposes exactly the one get_usage tool, and carries
// no identity frame (unlike notify -- get_usage answers the same regardless
// of caller, so a plain MCP client with no frame at all works identically).
test('usage broker: startUsageBroker + stopBroker lifecycle on a supplied socket path', async () => {
  const calls = [];
  const usageApi = {
    getUsage: async (args) => {
      calls.push(args);
      return { usage: { limits: [{ label: 'Current session', pct: 42 }] }, updatedAt: 123, cached: true };
    },
  };
  const usage = await broker.startUsageBroker({
    usageApi,
    sockPath: join(runtimeDir, 'ccserver-usage.sock'),
  });
  try {
    const c = mcpClient(usage.sockPath);
    await c.connected;
    const init = await c.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wire-test', version: '1' },
    });
    assert.equal(init.serverInfo.name, 'ccserver-usage');
    const { tools } = await c.call('tools/list');
    assert.deepEqual(tools.map((t) => t.name), ['get_usage']);
    const out = await callTool(c, 'get_usage', {});
    assert.deepEqual(out, { usage: { limits: [{ label: 'Current session', pct: 42 }] }, updatedAt: 123, cached: true });
    assert.deepEqual(calls, [{ force: false }], 'no args -> force defaults to false');

    await callTool(c, 'get_usage', { force: true });
    assert.deepEqual(calls[1], { force: true });
    c.close();
  } finally {
    broker.stopBroker(usage);
    assert.equal(existsSync(usage.sockPath), false, 'stopBroker removes the socket file');
  }
});

// The process-global reviewer broker (ccserver-reviewer, see reviewer.js /
// mcpServer.js's buildReviewerMcpServer): startReviewerBroker hosts it at the
// caller-supplied socket and exposes run_review/list_reviews/get_review/
// finish_review. run_review/list_reviews/get_review carry no identity
// (attribution, if any, rides in run_review's own requestedBy argument);
// finish_review's caller-verification identity is covered separately below.
test('reviewer broker: startReviewerBroker + stopBroker lifecycle on a supplied socket path', async () => {
  const calls = [];
  const reviewerApi = {
    runReview: async (args) => {
      calls.push(['runReview', args]);
      return { ok: true, id: 'job-1', status: 'running', sessionId: 'sess-1', worktreePath: '/tmp/wt', mode: 'branch', resolvedRef: 'deadbeef' };
    },
    listReviews: (args) => {
      calls.push(['listReviews', args]);
      return { ok: true, reviews: [] };
    },
    getReview: (args) => {
      calls.push(['getReview', args]);
      return { ok: true, review: { id: args.id, status: 'done' } };
    },
    finishReview: async (args) => {
      calls.push(['finishReview', args]);
      return { ok: true, id: args.jobId, status: args.status };
    },
  };
  const reviewer = await broker.startReviewerBroker({
    reviewerApi,
    sockPath: join(runtimeDir, 'ccserver-reviewer.sock'),
  });
  try {
    const c = mcpClient(reviewer.sockPath);
    await c.connected;
    const init = await c.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wire-test', version: '1' },
    });
    assert.equal(init.serverInfo.name, 'ccserver-reviewer');
    const { tools } = await c.call('tools/list');
    assert.deepEqual(tools.map((t) => t.name).sort(), ['finish_review', 'get_review', 'list_reviews', 'run_review']);

    const runOut = await callTool(c, 'run_review', { cwd: '/srv/proj', headRef: 'feature', focus: 'security' });
    assert.equal(runOut.id, 'job-1');
    assert.deepEqual(calls[0], ['runReview', { cwd: '/srv/proj', headRef: 'feature', focus: 'security' }]);

    await callTool(c, 'list_reviews', {});
    assert.deepEqual(calls[1], ['listReviews', {}]);

    const getOut = await callTool(c, 'get_review', { id: 'job-1' });
    assert.equal(getOut.review.status, 'done');
    assert.deepEqual(calls[2], ['getReview', { id: 'job-1' }]);

    // No identity frame on this connection -> callerSessionId is null.
    const finishOut = await callTool(c, 'finish_review', { jobId: 'job-1', status: 'done', summary: 'looks fine' });
    assert.equal(finishOut.id, 'job-1');
    assert.deepEqual(calls[3], ['finishReview', { jobId: 'job-1', status: 'done', summary: 'looks fine', callerSessionId: null }]);
    c.close();
  } finally {
    broker.stopBroker(reviewer);
    assert.equal(existsSync(reviewer.sockPath), false, 'stopBroker removes the socket file');
  }
});

// finish_review's whole authorization model rests on the per-connection
// identity frame (CCSERVER_REVIEWER_IDENTITY via the bridge, same mechanism
// as notify -- see mcpBroker.js) actually reaching reviewerApi.finishReview
// as callerSessionId. This is the wire-level half of that guarantee;
// reviewer.test.js covers the authorization logic itself once callerSessionId
// arrives.
test('reviewer broker: an identity frame on connect reaches finish_review as callerSessionId', async () => {
  const seen = [];
  const reviewerApi = {
    runReview: async () => ({ ok: false, error: 'unused' }),
    listReviews: () => ({ ok: true, reviews: [] }),
    getReview: () => ({ ok: false, error: 'unused' }),
    finishReview: async (args) => {
      seen.push(args.callerSessionId);
      return { ok: true, id: args.jobId, status: args.status };
    },
  };
  const reviewer = await broker.startReviewerBroker({
    reviewerApi,
    sockPath: join(runtimeDir, 'ccserver-reviewer-identity.sock'),
  });
  try {
    const c = mcpClient(reviewer.sockPath);
    await c.connected;
    // Same as the sandbox bridge: the identity frame goes out BEFORE the MCP
    // initialize handshake.
    c.raw.write(`${JSON.stringify({ ccserver: { sessionId: 'sess-review-job-1' } })}\n`);
    await c.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wire-test', version: '1' },
    });
    await callTool(c, 'finish_review', { jobId: 'job-1', status: 'done' });
    assert.deepEqual(seen, ['sess-review-job-1']);
    c.close();
  } finally {
    broker.stopBroker(reviewer);
  }
});

// --- handoff reliability: events survive a dead wait (Issue: handoff loss)
// ---------------------------------------------------------------------------

// The root-cause regression test: production brokers inject the groupManager
// FACADE (not the full module), and repo_info calls deps.groupManager.getGroup.
// A facade missing getGroup made repo_info fail with a TypeError on every
// production call while the (full-module) unit tests stayed green. Over the
// wire this surfaces as an isError tools/call result -- assert it does not.
test('control socket: repo_info succeeds over the wire (facade carries getGroup)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-repo-wire-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'README.md'), '# Wire repo');
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: dir, orchestratorDir: join(dir, '..', 'wire-orch') });
  try {
    const ctrl = groupManager.getGroup(gid).controlBroker;
    const c = mcpClient(ctrl.sockPath);
    await c.connected;
    const result = await callToolRaw(c, 'repo_info', {});
    assert.equal(result.isError, undefined, 'repo_info must NOT surface as a tool error');
    const out = JSON.parse(result.content[0].text);
    assert.equal(out.error, undefined, out.content?.[0]?.text || 'no error field');
    assert.equal(out.cwd, dir);
    assert.ok(out.root.dirs.includes('src'), 'root listing returned');
    assert.equal(out.readme.file, 'README.md');
    assert.equal(out.readme.text, '# Wire repo');
    c.close();
  } finally {
    groupManager.destroyGroup(gid);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// The core no-loss scenario: an orchestrator waits, its connection dies, a
// worker hands off afterwards -- the event must NOT be consumed by the dead
// waiter (its response would be written to a destroyed socket and lost).
// The next orchestrator connection receives it.
test('a handoff is not lost when the waiting connection dies mid-wait', async () => {
  const waitA = mcpClient(control.sockPath);
  await waitA.connected;
  const deadWait = callTool(waitA, 'wait_for_handoff', { timeoutMs: 5000 });
  // Give the server a beat to register the waiter, then kill the connection.
  await new Promise((r) => setTimeout(r, 100));
  waitA.raw.destroy();
  // Wait until the close has propagated server-side, so the dead waiter's
  // liveness check is guaranteed to see the connection gone before the
  // handoff arrives.
  await new Promise((resolve) => waitA.raw.on('close', resolve));
  await new Promise((r) => setTimeout(r, 50));

  // The worker hands off only AFTER the orchestrator's connection died.
  const worker = mcpClient(handoff.sockPath);
  await worker.connected;
  const handoffRes = await callTool(worker, 'handoff_to_orchestrator', {
    summary: 'survives the dead wait',
    status: 'done',
  });
  assert.deepEqual(handoffRes, { ok: true });
  worker.close();

  // A fresh orchestrator connection receives the event.
  const waitB = mcpClient(control.sockPath);
  await waitB.connected;
  const ev = await callTool(waitB, 'wait_for_handoff', { timeoutMs: 3000 });
  assert.equal(ev.error, undefined);
  assert.equal(ev.summary, 'survives the dead wait');
  assert.equal(ev.fromRole, 'workerA');
  waitB.close();

  // The dead waiter was superseded: no waiter may linger in the group.
  assert.equal(groupManager.getGroup(groupId).pendingTakes.size, 0, 'no zombie waiter remains');
  // (The dead client never receives a response -- deadWait stays pending
  // client-side by design; the server-side waiter was settled.)
});
