// Builds the MCP server registration injected into a session -- never written
// to a file on the host or in the repo. Which servers are registered:
//   ccserver        - the group's control/handoff broker (combo sessions only,
//                     i.e. when `groupMcp` is true and mcpSocketPath was set).
//                     The CLI runs the bridge script at the fixed in-sandbox
//                     path; which broker it reaches is decided solely by which
//                     host socket got bound to /ccserver-sandbox-mcp.sock in
//                     the sandbox (see sandbox.js / mcpBroker.js). Absent for
//                     standalone sessions -- they have no group socket, so
//                     registering it would hand the agent a broken server.
//   ccserver-notify - the process-global notification server (see notify.js),
//                     registered when the `{ notify }` descriptor is passed.
//   ccserver-usage  - the process-global usage server (see usageMcp.js),
//                     registered when the `{ usage }` descriptor is passed.
//                     claude sessions only (sessionManager never passes it
//                     for opencode/copilot -- see usageMcp.js's
//                     shouldInjectUsage).
//
//   claude   -> CLI arg `--mcp-config '<inline JSON>'` (process-scoped, does
//               not touch ~/.claude.json's shared projects key, so parallel
//               sessions in the same cwd cannot collide).
//   opencode -> OPENCODE_CONFIG_CONTENT env var (deep-merged with project
//               config, no file written).
//   codex    -> CLI `-c mcp_servers.<name>={...}` overrides (process-scoped,
//               does not touch ~/.codex/config.toml).
//   copilot  -> nothing. copilot has no CLI-arg/env MCP injection (its config
//               is file-based only), so no injection is assembled for it.
//   commandcode -> nothing. No CLI-arg/env MCP injection is verified for the
//               command-code CLI, so assembling one would risk an "unknown
//               option" launch failure like copilot's.
//
// The function is the single assembly point, so refusing here guarantees
// no copilot/commandcode launch path ever injects (group launches already
// refuse these at normalizeWorkers / addMember).
//
// The optional `{ notify }` descriptor adds the ccserver-notify MCP server:
//   { mode, sockPath, identity? }
//     mode     - 'sandbox' (run the in-sandbox bridge, args ['notify']) or
//                'host' (run <node> <bridge script> notify on the host --
//                used by non-sandboxed sessions, where the fixed in-sandbox
//                path and shebang don't exist).
//     sockPath - host path of the process-global notify socket, injected as
//                CCSANDBOX_NOTIFY_MCP_SOCK so the wrapper can reach it (bwrap
//                --setenv overrides it with the in-sandbox path when sandboxed).
//     identity - optional per-connection attribution
//                ({ sessionId, groupId, groupRole, cwd, projectName, app },
//                see sessionManager / mcpBroker). Injected as the JSON
//                CCSERVER_NOTIFY_IDENTITY env the bridge wrapper attaches to
//                its first socket frame; absent -> no env key, the wrapper
//                sends an empty frame and the notification carries host-only
//                attribution.
//
// The optional `{ usage }` descriptor adds the ccserver-usage MCP server
// (get_usage, see usageMcp.js): `{ mode, sockPath }`, same mode/sockPath
// shape as notify but with no identity (get_usage carries no per-connection
// attribution). Only ever passed for claude sessions (sessionManager gates
// it on shouldInjectUsage), but the assembly here doesn't need to know that.
//
// The optional `{ meta }` descriptor adds the ccserver-meta MCP server
// (see metaAgent.js): `{ mode, sockPath, identity? }`, same shape as notify.
// Only ever passed for the single isMetaAgent session; the identity becomes
// CCSERVER_META_IDENTITY, which the bridge wrapper attaches to its first
// socket frame so the meta tools can run their self-target guards and stamp
// approval attribution.
//
// The optional `{ reviewer }` descriptor adds the ccserver-reviewer MCP
// server (run_review/list_reviews/get_review/finish_review, see
// reviewer.js): `{ mode, sockPath, identity? }`, same shape as notify/meta.
// The identity here carries just `{ sessionId }` -- unlike notify/meta it is
// only ever set for the ONE session a review job itself launches, and its
// sole purpose is finish_review's caller-verification (the job's own
// sessionId, recorded in pr_reviews, must match the calling connection's
// identity). Injected as CCSERVER_REVIEWER_IDENTITY, same bridge-wrapper
// mechanism as CCSERVER_NOTIFY_IDENTITY/CCSERVER_META_IDENTITY.
//
// Returns { args, env } for sessionManager to splice into the pty spawn.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MCP_BRIDGE_COMMAND = '/ccserver-sandbox-mcp-bridge';
const NOTIFY_BRIDGE_SCRIPT = join(__dirname, 'sandbox-mcp-wrapper.cjs');
const USAGE_BRIDGE_ARG = ['usage'];
const META_BRIDGE_ARG = ['meta'];
const REVIEWER_BRIDGE_ARG = ['reviewer'];

// The { base, args } invocation for the notify server: the in-sandbox bridge
// when the session is sandboxed, else the host node binary running the bridge
// script directly (the script's shebang only exists inside the sandbox).
function notifyInvocation(notify) {
  if (notify.mode === 'host') {
    return { command: process.execPath, args: [NOTIFY_BRIDGE_SCRIPT, 'notify'] };
  }
  return { command: MCP_BRIDGE_COMMAND, args: ['notify'] };
}

// Same shape as notifyInvocation, for the ccserver-usage bridge (the wrapper
// script is shared -- it picks its socket env by argv, see
// sandbox-mcp-wrapper.cjs).
function usageInvocation(usage) {
  if (usage.mode === 'host') {
    return { command: process.execPath, args: [NOTIFY_BRIDGE_SCRIPT, ...USAGE_BRIDGE_ARG] };
  }
  return { command: MCP_BRIDGE_COMMAND, args: USAGE_BRIDGE_ARG };
}

// Same shape again, for the ccserver-meta bridge (wrapper arg 'meta').
function metaInvocation(meta) {
  if (meta.mode === 'host') {
    return { command: process.execPath, args: [NOTIFY_BRIDGE_SCRIPT, ...META_BRIDGE_ARG] };
  }
  return { command: MCP_BRIDGE_COMMAND, args: META_BRIDGE_ARG };
}

// Same shape again, for the ccserver-reviewer bridge (wrapper arg 'reviewer').
function reviewerInvocation(reviewer) {
  if (reviewer.mode === 'host') {
    return { command: process.execPath, args: [NOTIFY_BRIDGE_SCRIPT, ...REVIEWER_BRIDGE_ARG] };
  }
  return { command: MCP_BRIDGE_COMMAND, args: REVIEWER_BRIDGE_ARG };
}

export function buildMcpConfigArgsAndEnv(app, { groupMcp = true, notify, usage, meta, reviewer } = {}) {
  const notifySockEnv = notify ? { CCSANDBOX_NOTIFY_MCP_SOCK: notify.sockPath } : {};
  const notifyIdentityEnv = notify?.identity ? { CCSERVER_NOTIFY_IDENTITY: JSON.stringify(notify.identity) } : {};
  const usageSockEnv = usage ? { CCSANDBOX_USAGE_MCP_SOCK: usage.sockPath } : {};
  const metaSockEnv = meta ? { CCSANDBOX_META_MCP_SOCK: meta.sockPath } : {};
  const metaIdentityEnv = meta?.identity ? { CCSERVER_META_IDENTITY: JSON.stringify(meta.identity) } : {};
  const reviewerSockEnv = reviewer ? { CCSANDBOX_REVIEWER_MCP_SOCK: reviewer.sockPath } : {};
  const reviewerIdentityEnv = reviewer?.identity ? { CCSERVER_REVIEWER_IDENTITY: JSON.stringify(reviewer.identity) } : {};

  if (app === 'copilot' || app === 'commandcode') {
    return { args: [], env: {} };
  }

  if (app === 'codex') {
    const servers = {};
    // Codex can start MCP commands with a restricted environment. Explicitly
    // forward the bridge variables it needs instead of relying on implicit
    // child-process inheritance. `env_vars` preserves the value set by bwrap
    // in sandboxed sessions (the fixed in-sandbox socket path) and the host
    // socket path in non-sandboxed sessions.
    if (groupMcp) {
      servers.ccserver = {
        command: MCP_BRIDGE_COMMAND,
        args: [],
        env_vars: ['CCSANDBOX_MCP_SOCK'],
      };
    }
    if (notify) {
      const inv = notifyInvocation(notify);
      servers['ccserver-notify'] = {
        command: inv.command,
        args: inv.args,
        env_vars: ['CCSANDBOX_NOTIFY_MCP_SOCK', 'CCSERVER_NOTIFY_IDENTITY'],
      };
    }
    if (usage) {
      const inv = usageInvocation(usage);
      servers['ccserver-usage'] = {
        command: inv.command,
        args: inv.args,
        env_vars: ['CCSANDBOX_USAGE_MCP_SOCK'],
      };
    }
    if (meta) {
      const inv = metaInvocation(meta);
      servers['ccserver-meta'] = {
        command: inv.command,
        args: inv.args,
        env_vars: ['CCSANDBOX_META_MCP_SOCK', 'CCSERVER_META_IDENTITY'],
      };
    }
    if (reviewer) {
      const inv = reviewerInvocation(reviewer);
      servers['ccserver-reviewer'] = {
        command: inv.command,
        args: inv.args,
        env_vars: ['CCSANDBOX_REVIEWER_MCP_SOCK', 'CCSERVER_REVIEWER_IDENTITY'],
      };
    }
    const args = [];
    for (const [name, server] of Object.entries(servers)) {
      // JSON strings/arrays are valid TOML basic strings/arrays, which keeps
      // paths safely quoted while using Codex's per-process config override.
      args.push(
        '-c',
        `mcp_servers.${name}={command=${JSON.stringify(server.command)},args=${JSON.stringify(server.args)},env_vars=${JSON.stringify(server.env_vars)}}`,
      );
    }
    return {
      args,
      env: {
        ...notifySockEnv,
        ...notifyIdentityEnv,
        ...usageSockEnv,
        ...metaSockEnv,
        ...metaIdentityEnv,
        ...reviewerSockEnv,
        ...reviewerIdentityEnv,
      },
    };
  }

  if (app === 'opencode') {
    const mcp = {};
    if (groupMcp) mcp.ccserver = { type: 'local', command: [MCP_BRIDGE_COMMAND] };
    if (notify) {
      const inv = notifyInvocation(notify);
      mcp['ccserver-notify'] = { type: 'local', command: [inv.command, ...inv.args] };
    }
    if (usage) {
      const inv = usageInvocation(usage);
      mcp['ccserver-usage'] = { type: 'local', command: [inv.command, ...inv.args] };
    }
    if (meta) {
      const inv = metaInvocation(meta);
      mcp['ccserver-meta'] = { type: 'local', command: [inv.command, ...inv.args] };
    }
    if (reviewer) {
      const inv = reviewerInvocation(reviewer);
      mcp['ccserver-reviewer'] = { type: 'local', command: [inv.command, ...inv.args] };
    }
    return {
      args: [],
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          mcp,
        }),
        ...notifySockEnv,
        ...notifyIdentityEnv,
        ...usageSockEnv,
        ...metaSockEnv,
        ...metaIdentityEnv,
        ...reviewerSockEnv,
        ...reviewerIdentityEnv,
      },
    };
  }

  const mcpServers = {};
  if (groupMcp) mcpServers.ccserver = { type: 'stdio', command: MCP_BRIDGE_COMMAND, args: [] };
  if (notify) {
    const inv = notifyInvocation(notify);
    mcpServers['ccserver-notify'] = { type: 'stdio', command: inv.command, args: inv.args };
  }
  if (usage) {
    const inv = usageInvocation(usage);
    mcpServers['ccserver-usage'] = { type: 'stdio', command: inv.command, args: inv.args };
  }
  if (meta) {
    const inv = metaInvocation(meta);
    mcpServers['ccserver-meta'] = { type: 'stdio', command: inv.command, args: inv.args };
  }
  if (reviewer) {
    const inv = reviewerInvocation(reviewer);
    mcpServers['ccserver-reviewer'] = { type: 'stdio', command: inv.command, args: inv.args };
  }
  return {
    args: [
      '--mcp-config',
      JSON.stringify({ mcpServers }),
    ],
    env: {
      ...notifySockEnv,
      ...notifyIdentityEnv,
      ...usageSockEnv,
      ...metaSockEnv,
      ...metaIdentityEnv,
      ...reviewerSockEnv,
      ...reviewerIdentityEnv,
    },
  };
}
