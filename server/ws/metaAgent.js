// ccserver-meta: the server-global MCP broker for the META agent -- a single
// privileged agent that can inspect and manage the whole ccserver process:
// every project, sandbox HOME, orchestration group and session (plan
// sections 4.x).
//
// Process-wide concept (NOT group-scoped like the control/handoff brokers):
// one Unix socket hosts it for the whole server process
// (${XDG_RUNTIME_DIR}/ccserver-meta.sock, see getMetaSockPath). Unlike
// notify/usage, the socket is bound into EXACTLY ONE sandbox: the session
// launched with isMetaAgent:true. That single-sandbox binding is the trust
// boundary -- which is also why this feature is opt-in via
// sandbox.config.json's "metaAgentMcp" (default false): the toolset itself
// must not exist unless explicitly enabled.
//
// Per-connection identity: the bridge wrapper writes the same kind of first
// frame as notify (from CCSERVER_META_IDENTITY, see mcpConfig.js), giving the
// connection's sessionId/groupId for self-target guards and approval
// attribution. Attribution and self-reference only -- never an authorization
// input.
//
// This module imports its collaborators LAZILY (dynamic import inside
// ensureMetaAgentBroker) so the static import graph stays acyclic,
// mirroring notify.js/usageMcp.js: sessionManager -> metaAgent -> (runtime
// only) everything else. The dynamic bag is also where the meta agent's
// closed facade (metaDeps) is assembled for buildMetaMcpServer.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, chmodSync } from 'node:fs';
import { loadSandboxConfig } from './sandbox.js';

const META_SOCKET_NAME = 'ccserver-meta.sock';

let metaBroker = null; // { server, sockPath, dir, connections } | null
let stopBrokerFn = null;

export function getMetaSockPath() {
  const base = process.env.XDG_RUNTIME_DIR
    || (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : '/tmp');
  return join(base, META_SOCKET_NAME);
}

// The fixed, project-outside directory every meta-agent session runs in.
// See the invariant in sessionManager.createSession: isMetaAgent:true +
// groupId-less sessions never use a client-supplied cwd -- they are forced
// here. ~-based (homedir()) like orchestratorDirForCwd, not XDG_DATA_HOME.
export function metaAgentDir() {
  return join(homedir(), '.local', 'share', 'ccserver-sandbox', 'meta-agent');
}

// Ensure the fixed meta-agent directory exists (mode 0o700), returning its
// path. Idempotent -- safe to call on every meta-agent launch.
export function ensureMetaAgentDir() {
  const dir = metaAgentDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  return dir;
}

// Whether the meta agent feature is on at all: an explicit opt-in flag in
// sandbox.config.json (default false). A privileged server-management
// toolset must never exist by accident (see README "ccserver-meta").
export function metaAgentEnabled() {
  return loadSandboxConfig().metaAgentMcp === true;
}

// Pure injection decision for createSession. Only sessions explicitly
// launched with isMetaAgent:true ever get this broker; shells and
// copilot/commandcode are excluded outright (no shell needs it; neither has
// CLI-arg/env MCP injection at all). Group members can never qualify because
// createSession additionally requires !groupId before even consulting this
// function -- stated here too so the invariant survives refactoring.
export function shouldInjectMetaAgent({ shell, app, isMetaAgent, metaAgentEnabled }) {
  return !shell && app != null && app !== 'copilot' && app !== 'commandcode' && !!isMetaAgent && !!metaAgentEnabled;
}

// Start (once) the global Unix-socket broker hosting ccserver-meta. Callers
// must await it before launching the meta agent session: bwrap's --bind-try
// snapshots the socket file at mount time, so the file must exist first.
// Safe to call repeatedly -- the second call is a no-op returning the
// existing socket path.
export async function ensureMetaAgentBroker() {
  if (metaBroker) return metaBroker.sockPath;
  const [
    brokerMod, gmMod, smMod,
    approvalsMod, projectsMod, presetsMod, launchPresetsMod, sandboxMod,
    dirsMod, groupsMod, sessionsMod,
  ] = await Promise.all([
    import('./mcpBroker.js'),
    import('./groupManager.js'),
    import('./sessionManager.js'),
    import('./approvals.js'),
    import('./projects.js'),
    import('./workerPresets.js'),
    import('./launchPresets.js'),
    import('./sandbox.js'),
    import('../routes/dirs.js'),
    import('../routes/groups.js'),
    import('../routes/sessions.js'),
  ]);
  stopBrokerFn = brokerMod.stopBroker;
  const maxWorkers = groupsMod.MAX_WORKERS;
  metaBroker = await brokerMod.startMetaBroker({
    sockPath: getMetaSockPath(),
    // Closed facade handed to every meta tool (see metaTools.js header for
    // the full contract). Assembled once here so unit tests can exercise the
    // same shape buildMetaMcpServer consumes.
    metaDeps: {
      identity: null,          // replaced per connection by startMetaBroker
      connectionIsAlive: null, // ditto
      groupManager: gmMod.getGroupManagerApi(),
      sessionManager: smMod.getSessionManagerApi(),
      approvalsApi: {
        requestApproval: approvalsMod.requestApproval,
        APPROVAL_KINDS: approvalsMod.APPROVAL_KINDS,
        APPROVAL_TIMEOUT_MS: approvalsMod.APPROVAL_TIMEOUT_MS,
      },
      projectsApi: {
        listProjects: projectsMod.listProjects,
        getProject: projectsMod.getProject,
        updateProjectLabel: projectsMod.updateProjectLabel,
        findOrCreateProjectByCwd: projectsMod.findOrCreateProjectByCwd,
        recordSandboxHome: projectsMod.recordSandboxHome,
      },
      workerPresetsApi: {
        listPresets: presetsMod.listPresets,
        getPreset: presetsMod.getPreset,
        createPreset: presetsMod.createPreset,
        updatePreset: presetsMod.updatePreset,
        deletePreset: presetsMod.deletePreset,
      },
      launchPresetsApi: {
        listLaunchPresets: launchPresetsMod.listLaunchPresets,
        getLaunchPreset: launchPresetsMod.getLaunchPreset,
        createLaunchPreset: (input) => launchPresetsMod.createLaunchPreset(input, { maxWorkers }),
        updateLaunchPreset: (id, input) => launchPresetsMod.updateLaunchPreset(id, input, { maxWorkers }),
        deleteLaunchPreset: launchPresetsMod.deleteLaunchPreset,
      },
      sandboxApi: {
        listSandboxHomes: sandboxMod.listSandboxHomes,
        sandboxHomeSize: sandboxMod.sandboxHomeSize,
        deleteSandboxHome: sandboxMod.deleteSandboxHome,
        dindLockHeld: sandboxMod.dindLockHeld,
        isSandboxDeleteInFlight: sandboxMod.isSandboxDeleteInFlight,
        beginSandboxDelete: sandboxMod.beginSandboxDelete,
        endSandboxDelete: sandboxMod.endSandboxDelete,
        sandboxRemnantsExist: sandboxMod.sandboxRemnantsExist,
      },
      dirsApi: {
        browseDirectory: dirsMod.browseDirectory,
        createDirectory: dirsMod.createDirectory,
      },
      sessionsApi: {
        createSessionViaApi: sessionsMod.createSessionViaApi,
      },
      groupLaunchApi: {
        launchGroupFromSpec: groupsMod.launchGroupFromSpec,
      },
    },
  });
  return metaBroker.sockPath;
}

// Whether the global broker is actually listening right now (same rationale
// as notifyBrokerRunning / usageBrokerRunning: injecting a socket nobody
// listens on would hand the agent a broken bridge).
export function metaBrokerRunning() {
  return !!metaBroker;
}

// Teardown for graceful shutdown. Synchronous (the stopBroker reference is
// cached on the first ensureMetaAgentBroker call). Best effort; a stale
// socket file is removed by the next boot's listenMcp anyway.
export function stopMetaAgentBroker() {
  if (!metaBroker) return;
  try {
    if (stopBrokerFn) stopBrokerFn(metaBroker);
  } catch {
    // best effort
  }
  metaBroker = null;
}
