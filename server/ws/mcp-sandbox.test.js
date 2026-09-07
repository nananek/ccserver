// Sandbox argument building for combo sessions: when an mcpSocketPath is
// passed, buildSandboxSpawn must bind the host socket's DIRECTORY at the
// fixed in-sandbox path's directory (Issue #143 problem 1 -- a directory
// bind survives the host socket file being replaced across a server本体
// restart, unlike the old file-level bind), ro-bind the bridge wrapper, set
// CCSANDBOX_MCP_SOCK to the unchanged fixed file path, and share the
// node-binary bind with the git-broker machinery (the wrapper's shebang).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSandboxSpawn } from './sandbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SANDBOX_MCP_SOCK_PATH = '/ccserver-sandbox-mcp.d/sock';
const SANDBOX_NOTIFY_SOCK_PATH = '/ccserver-sandbox-notify.d/sock';
const SANDBOX_USAGE_SOCK_PATH = '/ccserver-sandbox-usage.d/sock';
const SANDBOX_MCP_BRIDGE_PATH = '/ccserver-sandbox-mcp-bridge';
const SANDBOX_NODE_PATH = '/ccserver-sandbox-node';

let cfgPath;
let tmpRoot;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-mcp-sandbox-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  // persistentHome off: the "no ro mounts" assertions must stay about the MCP
  // machinery, not the persistent-home bin-host bind.
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, persistentHome: false }));
});

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('buildSandboxSpawn binds the MCP socket, wrapper and node binary when mcpSocketPath is set', () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const sockPath = join(tmpRoot, 'fake-mcp.sock');
    const spawn = buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
      mcpSocketPath: sockPath,
    });
    const args = spawn.args;
    const idxBindDir = args.indexOf(dirname(SANDBOX_MCP_SOCK_PATH));
    const idxBridge = args.indexOf(SANDBOX_MCP_BRIDGE_PATH);
    const idxNode = args.indexOf(SANDBOX_NODE_PATH);
    assert.ok(idxBindDir > 0, 'in-sandbox MCP socket directory present');
    assert.equal(args[idxBindDir - 2], '--bind-try');
    assert.equal(args[idxBindDir - 1], dirname(sockPath));
    assert.ok(idxBridge > 0, 'bridge wrapper path present');
    assert.equal(args[idxBridge - 2], '--ro-bind');
    assert.equal(args[idxBridge - 1], join(__dirname, 'sandbox-mcp-wrapper.cjs'));
    const sockEnv = args.indexOf('CCSANDBOX_MCP_SOCK');
    assert.ok(sockEnv > 0, 'CCSANDBOX_MCP_SOCK set');
    assert.equal(args[sockEnv + 1], SANDBOX_MCP_SOCK_PATH);
    assert.ok(idxNode > 0, 'node binary bind present (wrapper shebang)');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

test('buildSandboxSpawn without mcpSocketPath adds no MCP bindings', () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const spawn = buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
    });
    assert.ok(!spawn.args.includes('--bind-try') || !spawn.args.includes(SANDBOX_MCP_SOCK_PATH));
    assert.ok(!spawn.args.includes('CCSANDBOX_MCP_SOCK'));
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

test('buildSandboxSpawn adds no /workers mounts (worker-dir roBinds removed)', () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const spawn = buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
    });
    assert.ok(!spawn.args.includes('--ro-bind-try'), 'no ro mounts at all without an MCP socket');
    assert.ok(!spawn.args.some((a) => typeof a === 'string' && a.startsWith('/workers/')), 'no /workers/* destination');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

// ccserver-notify in a STANDALONE sandbox: notifySocketPath set but no group
// mcpSocketPath (standalone sessions carry no group broker). The notify socket
// must be bound, the wrapper ro-bound, CCSANDBOX_NOTIFY_MCP_SOCK set, and the
// node binary bound for the wrapper's shebang -- without any group-socket
// bindings leaking in.
test('buildSandboxSpawn binds the notify socket + wrapper when notifySocketPath is set (no group socket)', () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const notifySock = join(tmpRoot, 'fake-notify.sock');
    const spawn = buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
      notifySocketPath: notifySock,
    });
    const args = spawn.args;
    const idxBind = args.indexOf(dirname(SANDBOX_NOTIFY_SOCK_PATH));
    assert.ok(idxBind > 0, 'in-sandbox notify socket directory present');
    assert.equal(args[idxBind - 2], '--bind-try');
    assert.equal(args[idxBind - 1], dirname(notifySock));
    const sockEnv = args.indexOf('CCSANDBOX_NOTIFY_MCP_SOCK');
    assert.ok(sockEnv > 0, 'CCSANDBOX_NOTIFY_MCP_SOCK set');
    assert.equal(args[sockEnv + 1], SANDBOX_NOTIFY_SOCK_PATH);
    const idxBridge = args.indexOf(SANDBOX_MCP_BRIDGE_PATH);
    assert.ok(idxBridge > 0, 'bridge wrapper ro-bound for notify');
    assert.equal(args[idxBridge - 2], '--ro-bind');
    assert.equal(args[idxBridge - 1], join(__dirname, 'sandbox-mcp-wrapper.cjs'));
    const idxNode = args.indexOf(SANDBOX_NODE_PATH);
    assert.ok(idxNode > 0, 'node binary bind present (wrapper shebang)');
    assert.ok(!args.includes(SANDBOX_MCP_SOCK_PATH), 'no group MCP socket bind (standalone)');
    assert.ok(!args.includes('CCSANDBOX_MCP_SOCK'), 'no group socket env (standalone)');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

test('buildSandboxSpawn without notifySocketPath adds no notify bindings', () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const spawn = buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
    });
    assert.ok(!spawn.args.includes(SANDBOX_NOTIFY_SOCK_PATH), 'no notify socket path');
    assert.ok(!spawn.args.includes('CCSANDBOX_NOTIFY_MCP_SOCK'), 'no notify socket env');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

// ccserver-usage (see usageMcp.js): same shape as the notify socket bindings
// above, independent of both the group socket and the notify socket -- a
// claude session may carry any combination of the three.
test('buildSandboxSpawn binds the usage socket + wrapper when usageSocketPath is set (no group/notify socket)', () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const usageSock = join(tmpRoot, 'fake-usage.sock');
    const spawn = buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
      usageSocketPath: usageSock,
    });
    const args = spawn.args;
    const idxBind = args.indexOf(dirname(SANDBOX_USAGE_SOCK_PATH));
    assert.ok(idxBind > 0, 'in-sandbox usage socket directory present');
    assert.equal(args[idxBind - 2], '--bind-try');
    assert.equal(args[idxBind - 1], dirname(usageSock));
    const sockEnv = args.indexOf('CCSANDBOX_USAGE_MCP_SOCK');
    assert.ok(sockEnv > 0, 'CCSANDBOX_USAGE_MCP_SOCK set');
    assert.equal(args[sockEnv + 1], SANDBOX_USAGE_SOCK_PATH);
    const idxBridge = args.indexOf(SANDBOX_MCP_BRIDGE_PATH);
    assert.ok(idxBridge > 0, 'bridge wrapper ro-bound for usage');
    const idxNode = args.indexOf(SANDBOX_NODE_PATH);
    assert.ok(idxNode > 0, 'node binary bind present (wrapper shebang)');
    assert.ok(!args.includes(SANDBOX_MCP_SOCK_PATH), 'no group MCP socket bind');
    assert.ok(!args.includes(SANDBOX_NOTIFY_SOCK_PATH), 'no notify socket bind');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

test('buildSandboxSpawn without usageSocketPath adds no usage bindings', () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const spawn = buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
    });
    assert.ok(!spawn.args.includes(SANDBOX_USAGE_SOCK_PATH), 'no usage socket path');
    assert.ok(!spawn.args.includes('CCSANDBOX_USAGE_MCP_SOCK'), 'no usage socket env');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});
