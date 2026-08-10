// Sandbox argument building for combo sessions: when an mcpSocketPath is
// passed, buildSandboxSpawn must bind the host socket at the fixed in-sandbox
// path, ro-bind the bridge wrapper, set CCSANDBOX_MCP_SOCK, and share the
// node-binary bind with the git-broker machinery (the wrapper's shebang).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSandboxSpawn } from './sandbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SANDBOX_MCP_SOCK_PATH = '/ccserver-sandbox-mcp.sock';
const SANDBOX_MCP_BRIDGE_PATH = '/ccserver-sandbox-mcp-bridge';
const SANDBOX_NODE_PATH = '/ccserver-sandbox-node';

let cfgPath;
let tmpRoot;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-mcp-sandbox-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false }));
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
    const idxBind = args.indexOf(SANDBOX_MCP_SOCK_PATH);
    const idxBridge = args.indexOf(SANDBOX_MCP_BRIDGE_PATH);
    const idxNode = args.indexOf(SANDBOX_NODE_PATH);
    assert.ok(idxBind > 0, 'in-sandbox MCP socket path present');
    assert.equal(args[idxBind - 2], '--bind-try');
    assert.equal(args[idxBind - 1], sockPath);
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

test('buildSandboxSpawn mounts roBinds read-only at /workers/<role>', () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const srcA = join(tmpRoot, 'proj-a');
    const srcB = join(tmpRoot, 'proj-b');
    const spawn = buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
      roBinds: [
        { src: srcA, dest: '/workers/workerA' },
        { src: srcB, dest: '/workers/workerB' },
      ],
    });
    const args = spawn.args;
    const idxA = args.indexOf('/workers/workerA');
    const idxB = args.indexOf('/workers/workerB');
    assert.ok(idxA > 0, '/workers/workerA destination present');
    assert.equal(args[idxA - 2], '--ro-bind-try');
    assert.equal(args[idxA - 1], srcA);
    assert.ok(idxB > 0, '/workers/workerB destination present');
    assert.equal(args[idxB - 2], '--ro-bind-try');
    assert.equal(args[idxB - 1], srcB);
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

test('buildSandboxSpawn with no/empty roBinds adds no worker mounts', () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    for (const roBinds of [undefined, []]) {
      const spawn = buildSandboxSpawn({
        cwd: tmpRoot,
        targetCommand: ['claude'],
        app: 'claude',
        sandboxOpts: null,
        ...(roBinds === undefined ? {} : { roBinds }),
      });
      assert.ok(!spawn.args.includes('--ro-bind-try'), 'no ro worker mounts when roBinds is empty/absent');
      assert.ok(!spawn.args.some((a) => typeof a === 'string' && a.startsWith('/workers/')), 'no /workers/* destination');
    }
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});
