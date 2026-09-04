// buildMcpConfigArgsAndEnv -- the per-CLI MCP registration injection for
// combo-launched sessions. claude gets an inline `--mcp-config <JSON>` CLI
// arg (process-scoped, no ~/.claude.json mutation); opencode gets an
// OPENCODE_CONFIG_CONTENT env var (deep-merged, no file written). Both point
// at the fixed in-sandbox bridge command. Pure function -- no deps, no I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpConfigArgsAndEnv } from './mcpConfig.js';

test('claude gets an inline --mcp-config JSON pointing at the sandbox bridge', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('claude');
  assert.equal(args[0], '--mcp-config');
  assert.equal(args.length, 2, 'exactly one flag + one inline JSON argument');
  const cfg = JSON.parse(args[1]);
  assert.deepEqual(cfg.mcpServers.ccserver, {
    type: 'stdio',
    command: '/ccserver-sandbox-mcp-bridge',
    args: [],
  });
  assert.deepEqual(env, {}, 'claude needs no env injection');
});

test('opencode gets OPENCODE_CONFIG_CONTENT env (local command bridge), no CLI args', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('opencode');
  assert.deepEqual(args, []);
  const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(cfg.mcp.ccserver.type, 'local');
  assert.deepEqual(cfg.mcp.ccserver.command, ['/ccserver-sandbox-mcp-bridge']);
});

test('unknown app falls back to the claude-style CLI arg (default branch)', () => {
  const { args } = buildMcpConfigArgsAndEnv('shell');
  assert.equal(args[0], '--mcp-config');
  assert.ok(JSON.parse(args[1]).mcpServers.ccserver);
});

// copilot has no CLI-arg/env MCP injection (file-based config only), so the
// assembly point must produce nothing for it -- otherwise the `--mcp-config`
// flag reaches the binary and it errors with "unknown option".
test('copilot gets no injection at all: empty args and env, even with groupMcp', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('copilot');
  assert.deepEqual(args, [], 'no CLI args (--mcp-config must never appear)');
  assert.deepEqual(env, {}, 'no env injection');
  assert.ok(!args.join(' ').includes('--mcp-config'));
});

test('copilot + notify(sandbox): nothing is assembled for either server', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('copilot', {
    groupMcp: true,
    notify: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-notify.sock', identity },
  });
  assert.deepEqual(args, [], 'no CLI args (--mcp-config must never appear)');
  assert.deepEqual(env, {}, 'no env injection');
});

test('copilot + notify(host): nothing is assembled for either server', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('copilot', {
    notify: { mode: 'host', sockPath: '/run/user/1000/ccserver-notify.sock', identity },
  });
  assert.deepEqual(args, [], 'no CLI args (--mcp-config must never appear)');
  assert.deepEqual(env, {}, 'no env injection');
});

// ccserver-notify injection (see notify.js): the optional `{ notify }`
// descriptor adds the notify server to the same registration, with the bridge
// command switching on the session's sandbox mode. sessionManager always
// passes the descriptor's `identity` (the per-connection attribution); it is
// carried to the bridge as the JSON env CCSERVER_NOTIFY_IDENTITY.

const identity = {
  sessionId: 'sess-01234567-89ab',
  groupId: 'grp-1',
  groupRole: 'orchestrator',
  cwd: '/srv/proj',
  projectName: 'proj',
  app: 'claude',
};

test('claude + notify(sandbox): ccserver and ccserver-notify both registered via the in-sandbox bridge', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('claude', {
    notify: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-notify.sock', identity },
  });
  assert.equal(args[0], '--mcp-config');
  const cfg = JSON.parse(args[1]);
  assert.ok(cfg.mcpServers.ccserver, 'ccserver stays registered alongside notify');
  assert.deepEqual(cfg.mcpServers['ccserver-notify'], {
    type: 'stdio',
    command: '/ccserver-sandbox-mcp-bridge',
    args: ['notify'],
  });
  assert.deepEqual(env, {
    CCSANDBOX_NOTIFY_MCP_SOCK: '/run/user/1000/ccserver-notify.sock',
    CCSERVER_NOTIFY_IDENTITY: JSON.stringify(identity),
  });
});

test('opencode + notify(sandbox): ccserver-notify is a local bridge command with the notify argv', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('opencode', {
    notify: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-notify.sock', identity },
  });
  assert.deepEqual(args, []);
  const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(cfg.mcp['ccserver-notify'].command, ['/ccserver-sandbox-mcp-bridge', 'notify']);
  assert.equal(env.CCSANDBOX_NOTIFY_MCP_SOCK, '/run/user/1000/ccserver-notify.sock');
  assert.equal(env.CCSERVER_NOTIFY_IDENTITY, JSON.stringify(identity));
});

test('notify(host): the notify server runs as node <bridge script> notify on the host', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('claude', {
    notify: { mode: 'host', sockPath: '/run/user/1000/ccserver-notify.sock', identity },
  });
  const cfg = JSON.parse(args[1]);
  const n = cfg.mcpServers['ccserver-notify'];
  assert.equal(n.command, process.execPath, 'host mode invokes the node binary directly');
  assert.ok(n.args[0].endsWith('sandbox-mcp-wrapper.cjs'), `bridge script path (got ${n.args[0]})`);
  assert.equal(n.args[1], 'notify');
  assert.equal(env.CCSANDBOX_NOTIFY_MCP_SOCK, '/run/user/1000/ccserver-notify.sock');
  assert.equal(env.CCSERVER_NOTIFY_IDENTITY, JSON.stringify(identity));
});

test('no notify descriptor -> unchanged (ccserver only)', () => {
  const { args } = buildMcpConfigArgsAndEnv('claude');
  const cfg = JSON.parse(args[1]);
  assert.deepEqual(Object.keys(cfg.mcpServers), ['ccserver']);
});

// A descriptor without an identity (legacy caller, or a notify descriptor
// built before the attribution work) must not add the env key -- the bridge
// wrapper then sends an empty frame and notifications carry host-only
// attribution.
test('notify descriptor without identity -> no CCSERVER_NOTIFY_IDENTITY env key', () => {
  const { env } = buildMcpConfigArgsAndEnv('claude', {
    notify: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-notify.sock' },
  });
  assert.deepEqual(env, { CCSANDBOX_NOTIFY_MCP_SOCK: '/run/user/1000/ccserver-notify.sock' });
});

// Standalone notify session (no group socket, mcpSocketPath null): only
// ccserver-notify is registered -- a ccserver entry would point its bridge at
// /ccserver-sandbox-mcp.sock which is never bound for a standalone session
// (the wrapper would exit "not configured", or the host path would not exist).
test('notify(host) without a group socket registers ccserver-notify only (no ccserver)', () => {
  const { args } = buildMcpConfigArgsAndEnv('claude', {
    groupMcp: false,
    notify: { mode: 'host', sockPath: '/run/user/1000/ccserver-notify.sock' },
  });
  const cfg = JSON.parse(args[1]);
  assert.deepEqual(Object.keys(cfg.mcpServers), ['ccserver-notify'], 'standalone gets no ccserver entry');
  assert.equal(cfg.mcpServers['ccserver-notify'].command, process.execPath);
});

test('opencode notify without a group socket registers ccserver-notify only', () => {
  const { env } = buildMcpConfigArgsAndEnv('opencode', {
    groupMcp: false,
    notify: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-notify.sock' },
  });
  const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(Object.keys(cfg.mcp), ['ccserver-notify']);
  assert.deepEqual(cfg.mcp['ccserver-notify'].command, ['/ccserver-sandbox-mcp-bridge', 'notify']);
});

// ccserver-usage injection (see usageMcp.js): the optional `{ usage }`
// descriptor adds the usage server, same mode/sockPath shape as notify but
// with no identity (get_usage carries no per-connection attribution). Only
// ever passed for claude sessions by sessionManager, but buildMcpConfigArgsAndEnv
// itself does not enforce that -- it just assembles what it's given.

test('claude + usage(sandbox): ccserver-usage registered via the in-sandbox bridge with the usage argv', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('claude', {
    usage: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-usage.sock' },
  });
  assert.equal(args[0], '--mcp-config');
  const cfg = JSON.parse(args[1]);
  assert.ok(cfg.mcpServers.ccserver, 'ccserver stays registered alongside usage');
  assert.deepEqual(cfg.mcpServers['ccserver-usage'], {
    type: 'stdio',
    command: '/ccserver-sandbox-mcp-bridge',
    args: ['usage'],
  });
  assert.deepEqual(env, { CCSANDBOX_USAGE_MCP_SOCK: '/run/user/1000/ccserver-usage.sock' });
});

test('claude + usage(host): the usage server runs as node <bridge script> usage on the host', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('claude', {
    usage: { mode: 'host', sockPath: '/run/user/1000/ccserver-usage.sock' },
  });
  const cfg = JSON.parse(args[1]);
  const u = cfg.mcpServers['ccserver-usage'];
  assert.equal(u.command, process.execPath, 'host mode invokes the node binary directly');
  assert.ok(u.args[0].endsWith('sandbox-mcp-wrapper.cjs'), `bridge script path (got ${u.args[0]})`);
  assert.equal(u.args[1], 'usage');
  assert.equal(env.CCSANDBOX_USAGE_MCP_SOCK, '/run/user/1000/ccserver-usage.sock');
});

test('claude + notify + usage together: both servers registered independently', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('claude', {
    notify: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-notify.sock', identity },
    usage: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-usage.sock' },
  });
  const cfg = JSON.parse(args[1]);
  assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['ccserver', 'ccserver-notify', 'ccserver-usage']);
  assert.deepEqual(env, {
    CCSANDBOX_NOTIFY_MCP_SOCK: '/run/user/1000/ccserver-notify.sock',
    CCSERVER_NOTIFY_IDENTITY: JSON.stringify(identity),
    CCSANDBOX_USAGE_MCP_SOCK: '/run/user/1000/ccserver-usage.sock',
  });
});

test('no usage descriptor -> unchanged (ccserver only)', () => {
  const { args } = buildMcpConfigArgsAndEnv('claude');
  const cfg = JSON.parse(args[1]);
  assert.deepEqual(Object.keys(cfg.mcpServers), ['ccserver']);
});

test('copilot + usage: nothing is assembled (copilot has no MCP injection at all)', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('copilot', {
    usage: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-usage.sock' },
  });
  assert.deepEqual(args, []);
  assert.deepEqual(env, {});
});

test('codex gets per-process MCP config overrides without writing config.toml', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('codex', {
    groupMcp: true,
    notify: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-notify.sock' },
  });
  assert.deepEqual(args, [
    '-c', 'mcp_servers.ccserver={command="/ccserver-sandbox-mcp-bridge",args=[],env_vars=["CCSANDBOX_MCP_SOCK"]}',
    '-c', 'mcp_servers.ccserver-notify={command="/ccserver-sandbox-mcp-bridge",args=["notify"],env_vars=["CCSANDBOX_NOTIFY_MCP_SOCK","CCSERVER_NOTIFY_IDENTITY"]}',
  ]);
  assert.deepEqual(env, { CCSANDBOX_NOTIFY_MCP_SOCK: '/run/user/1000/ccserver-notify.sock' });
});

// ccserver-meta injection (see metaAgent.js): the optional `{ meta }`
// descriptor adds the privileged meta server, same mode/sockPath shape as
// notify (plus an identity for the self-target guards / approval attribution).
// Only ever passed for the single isMetaAgent session by sessionManager, but
// buildMcpConfigArgsAndEnv itself just assembles what it's given.

const metaIdentity = {
  sessionId: 'meta-01234567-89ab',
  groupId: null,
  groupRole: null,
  cwd: '/srv/proj',
  projectName: 'proj',
  app: 'claude',
};

test('claude + meta(sandbox): ccserver-meta registered via the bridge with the meta argv', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('claude', {
    meta: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-meta.sock', identity: metaIdentity },
  });
  const cfg = JSON.parse(args[1]);
  assert.deepEqual(cfg.mcpServers['ccserver-meta'], {
    type: 'stdio',
    command: '/ccserver-sandbox-mcp-bridge',
    args: ['meta'],
  });
  assert.equal(env.CCSANDBOX_META_MCP_SOCK, '/run/user/1000/ccserver-meta.sock');
  assert.equal(env.CCSERVER_META_IDENTITY, JSON.stringify(metaIdentity));
});

test('claude + meta(host): node <bridge script> meta on the host', () => {
  const { args } = buildMcpConfigArgsAndEnv('claude', {
    meta: { mode: 'host', sockPath: '/run/user/1000/ccserver-meta.sock' },
  });
  const m = JSON.parse(args[1]).mcpServers['ccserver-meta'];
  assert.equal(m.command, process.execPath);
  assert.ok(m.args[0].endsWith('sandbox-mcp-wrapper.cjs'));
  assert.equal(m.args[1], 'meta');
});

test('opencode + codex assemble ccserver-meta too (the meta agent may run either)', () => {
  const oc = buildMcpConfigArgsAndEnv('opencode', {
    meta: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-meta.sock' },
  });
  const ocCfg = JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(ocCfg.mcp['ccserver-meta'].command, ['/ccserver-sandbox-mcp-bridge', 'meta']);
  assert.equal(oc.env.CCSANDBOX_META_MCP_SOCK, '/run/user/1000/ccserver-meta.sock');

  const cx = buildMcpConfigArgsAndEnv('codex', {
    meta: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-meta.sock' },
  });
  assert.ok(cx.args.some((a) => a.includes('mcp_servers.ccserver-meta=')));
  assert.equal(cx.env.CCSANDBOX_META_MCP_SOCK, '/run/user/1000/ccserver-meta.sock');
});

test('no meta descriptor -> unchanged registrations', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('claude');
  const cfg = JSON.parse(args[1]);
  assert.equal(cfg.mcpServers['ccserver-meta'], undefined);
  assert.equal(env.CCSANDBOX_META_MCP_SOCK, undefined);
});

// ccserver-reviewer injection (see reviewer.js): the optional `{ reviewer }`
// descriptor, same mode/sockPath/identity shape as meta -- but unlike meta's
// richer identity, reviewer's only ever carries `{ sessionId }` (see
// sessionManager.js), used by finish_review to verify its caller is the
// review job's own session.

const reviewerIdentity = { sessionId: 'review-job-session-01' };

test('claude + reviewer(sandbox): ccserver-reviewer registered via the bridge, with the identity env set', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('claude', {
    reviewer: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-reviewer.sock', identity: reviewerIdentity },
  });
  const cfg = JSON.parse(args[1]);
  assert.deepEqual(cfg.mcpServers['ccserver-reviewer'], {
    type: 'stdio',
    command: '/ccserver-sandbox-mcp-bridge',
    args: ['reviewer'],
  });
  assert.equal(env.CCSANDBOX_REVIEWER_MCP_SOCK, '/run/user/1000/ccserver-reviewer.sock');
  assert.equal(env.CCSERVER_REVIEWER_IDENTITY, JSON.stringify(reviewerIdentity));
});

test('claude + reviewer(sandbox) with no identity: sock env set, no identity env at all', () => {
  const { env } = buildMcpConfigArgsAndEnv('claude', {
    reviewer: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-reviewer.sock' },
  });
  assert.equal(env.CCSANDBOX_REVIEWER_MCP_SOCK, '/run/user/1000/ccserver-reviewer.sock');
  assert.equal(env.CCSERVER_REVIEWER_IDENTITY, undefined);
});

test('claude + reviewer(host): node <bridge script> reviewer on the host', () => {
  const { args } = buildMcpConfigArgsAndEnv('claude', {
    reviewer: { mode: 'host', sockPath: '/run/user/1000/ccserver-reviewer.sock' },
  });
  const r = JSON.parse(args[1]).mcpServers['ccserver-reviewer'];
  assert.equal(r.command, process.execPath);
  assert.ok(r.args[0].endsWith('sandbox-mcp-wrapper.cjs'));
  assert.equal(r.args[1], 'reviewer');
});

test('opencode + codex assemble ccserver-reviewer too, identity env included', () => {
  const oc = buildMcpConfigArgsAndEnv('opencode', {
    reviewer: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-reviewer.sock', identity: reviewerIdentity },
  });
  const ocCfg = JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(ocCfg.mcp['ccserver-reviewer'].command, ['/ccserver-sandbox-mcp-bridge', 'reviewer']);
  assert.equal(oc.env.CCSERVER_REVIEWER_IDENTITY, JSON.stringify(reviewerIdentity));

  const cx = buildMcpConfigArgsAndEnv('codex', {
    reviewer: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-reviewer.sock', identity: reviewerIdentity },
  });
  assert.ok(cx.args.some((a) => a.includes('mcp_servers.ccserver-reviewer=') && a.includes('CCSERVER_REVIEWER_IDENTITY')));
  assert.equal(cx.env.CCSERVER_REVIEWER_IDENTITY, JSON.stringify(reviewerIdentity));
});

test('no reviewer descriptor -> unchanged registrations', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('claude');
  const cfg = JSON.parse(args[1]);
  assert.equal(cfg.mcpServers['ccserver-reviewer'], undefined);
  assert.equal(env.CCSANDBOX_REVIEWER_MCP_SOCK, undefined);
  assert.equal(env.CCSERVER_REVIEWER_IDENTITY, undefined);
});
