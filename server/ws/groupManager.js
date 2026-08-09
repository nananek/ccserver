// In-memory registry of combo launch groups: a group binds two workers and
// one orchestrator (roles workerA/workerB/orchestrator, orthogonal to the
// app) around a shared project directory, plus the MCP broker channels that
// let the orchestrator reach them.
//
// Authorization: isSessionInGroup(groupId, sessionId) is the single chokepoint
// used by every MCP tool (see mcpTools.js). Members are only ever registered
// here, by this process, never declared by clients.

import { EventEmitter } from 'node:events';
import { getSession, destroySession, createSession, writeToSession, setSessionExitListener, setSessionCreateListener, setMcpSocketResolver } from './sessionManager.js';
import { startControlBroker, startHandoffChannel, stopBroker } from './mcpBroker.js';
import { isValidApp } from './appLaunch.js';

const groups = new Map(); // groupId -> group (see createGroup)

// Roles an orchestrator may open via open_tab: workerA/workerB plus any
// similarly-shaped worker role (workerC, worker-extra, ...). The
// orchestrator's own role is deliberately excluded -- an orchestrator must
// never be able to spawn/replace "itself".
const WORKER_ROLE_RE = /^worker[A-Za-z0-9_-]+$/;

// FIFO handoff queue cap: workers pushing while the orchestrator is gone must
// not grow the queue without bound.
const MAX_HANDOFF_QUEUE = 100;

export async function createGroup({ groupId, cwd, orchestratorDir, sandboxOpts = null }) {
  const group = {
    id: groupId,
    createdAt: Date.now(),
    cwd,
    allowedCwds: new Set([cwd]),
    members: new Map(), // role -> sessionId
    orchestratorDir,
    // Per-launch sandbox flags (gpg/sshAgent) the group's workers launched
    // with; open_tab workers inherit them unless the tool overrides.
    sandboxOpts,
    controlBroker: null, // { server, sockPath, dir } | null
    handoffChannels: new Map(), // role -> { server, sockPath, dir, role, sessionId }
    handoffQueue: [],
    handoffEmitter: new EventEmitter(),
  };
  groups.set(groupId, group);

  // The orchestrator's own socket; hosts the control MCP server. Created at
  // group creation so the orchestrator session can be launched with it.
  try {
    group.controlBroker = await startControlBroker({
      groupId,
      groupManager: groupManagerApi,
      sessionManager: sessionApi,
    });
  } catch (err) {
    groups.delete(groupId);
    throw err;
  }

  return group;
}

export function getGroup(groupId) {
  return groups.get(groupId) || null;
}

// Bind a member sessionId to a role. Also wires the role's handoff channel
// (created before the session exists) to the now-known sessionId.
export function registerMember(groupId, role, sessionId) {
  const group = groups.get(groupId);
  if (!group) return false;
  group.members.set(role, sessionId);
  const channel = group.handoffChannels.get(role);
  if (channel) channel.sessionId = sessionId;
  return true;
}

// Resolve member sessions against sessionManager; a session that is gone from
// the manager (destroyed) shows up as exited with its cached fields.
export function listGroupMembers(groupId) {
  const group = groups.get(groupId);
  if (!group) return [];
  const out = [];
  for (const [role, sessionId] of group.members) {
    const session = getSession(sessionId);
    out.push({
      role,
      sessionId,
      app: session?.app ?? null,
      cwd: session?.cwd ?? null,
      exited: session ? !!session.exited : true,
      connected: !!(session?.socket),
    });
  }
  return out;
}

// The authorization chokepoint: is `sessionId` a member of this group?
export function isSessionInGroup(groupId, sessionId) {
  const group = groups.get(groupId);
  if (!group) return false;
  return [...group.members.values()].includes(sessionId);
}

// Create a handoff socket for a (future) member session. The sessionId isn't
// known yet -- the channel resolves it from the group's member registry at
// MCP-connection time, so the socket can be bound into the sandbox before
// createSession() runs.
export async function createMemberHandoffChannel(groupId, role) {
  const group = groups.get(groupId);
  if (!group) return null;
  const channel = await startHandoffChannel({
    groupId,
    role,
    getSessionId: () => group.members.get(role) || null,
    groupManager: groupManagerApi,
    sessionManager: sessionApi,
  });
  channel.role = role;
  channel.sessionId = null;
  group.handoffChannels.set(role, channel);
  return channel;
}

// Provide the MCP socket a (re)created member session should be launched
// with -- used by the scheduled-prompt auto-resume path. A dead worker gets a
// fresh handoff channel; the orchestrator gets its control broker back (it
// was stopped when the orchestrator exited). Returns null when the group is
// gone or the broker can't be (re)started -- the caller then launches without
// MCP, which the member's own MCP client would never connect anyway.
export async function resolveGroupMcpSocket(groupId, groupRole) {
  const group = groups.get(groupId);
  if (!group) return null;
  if (groupRole === 'orchestrator') {
    if (group.controlBroker) return group.controlBroker.sockPath;
    try {
      group.controlBroker = await startControlBroker({
        groupId,
        groupManager: groupManagerApi,
        sessionManager: sessionApi,
      });
      return group.controlBroker.sockPath;
    } catch {
      return null;
    }
  }
  const existing = group.handoffChannels.get(groupRole);
  if (existing) return existing.sockPath;
  try {
    const channel = await createMemberHandoffChannel(groupId, groupRole);
    return channel ? channel.sockPath : null;
  } catch {
    return null;
  }
}

// open_tab: add a new worker session to the group. cwd is restricted to
// allowedCwds (initialized to the shared project dir). Reuses the same
// channel-then-session flow as the initial trio. Returns { sessionId, app }
// or { error, message }.
export async function addMember(groupId, role, { app, cwd, sandboxOpts = null }) {
  const group = groups.get(groupId);
  if (!group) return { error: 'group-not-found', message: 'group not found' };
  if (!isValidApp(app)) return { error: 'bad-request', message: 'app must be claude or opencode' };
  if (!WORKER_ROLE_RE.test(role)) {
    return {
      error: 'invalid-role',
      message: 'role must be a worker role (e.g. workerA, workerB), never orchestrator',
    };
  }
  if (!group.allowedCwds.has(cwd)) {
    return { error: 'cwd-not-allowed', message: `cwd must be one of: ${[...group.allowedCwds].join(', ')}` };
  }

  // A role is single-slot: replacing it destroys the previous occupant and
  // its handoff channel (a fresh channel for the role is created below).
  const prevSessionId = group.members.get(role);
  if (prevSessionId) destroySession(prevSessionId, { keepSchedule: false });
  const prevChannel = group.handoffChannels.get(role);
  if (prevChannel) {
    stopBroker(prevChannel);
    group.handoffChannels.delete(role);
  }

  const channel = await createMemberHandoffChannel(groupId, role).catch(() => null);
  if (!channel) {
    return { error: 'channel-failed', message: 'failed to create handoff channel' };
  }
  const res = createSession({
    cwd,
    cols: 80,
    rows: 24,
    sandbox: true,
    // Inherit the flags the group's workers were launched with unless the
    // tool call overrides them.
    sandboxOpts: sandboxOpts ?? group.sandboxOpts,
    app,
    groupId,
    groupRole: role,
    mcpSocketPath: channel.sockPath,
  });
  if (res.error || !res.session) {
    stopBroker(channel);
    group.handoffChannels.delete(role);
    return { error: 'spawn-failed', message: res.error || 'session creation failed' };
  }
  registerMember(groupId, role, res.sessionId);
  return { sessionId: res.sessionId, app };
}

// close_tab / explicit removal: destroy the session and its handoff channel.
export function removeMember(groupId, sessionId) {
  const group = groups.get(groupId);
  if (!group) return;
  destroySession(sessionId, { keepSchedule: false });
  cleanupMemberChannels(group, sessionId);
  for (const [role, sid] of group.members) {
    if (sid === sessionId) group.members.delete(role);
  }
}

// FIFO handoff queue + EventEmitter: workers push, orchestrator takes. The
// queue is capped so workers pushing while the orchestrator is away (crashed,
// not waiting) can't grow memory without bound -- oldest hands off first.
export function pushHandoff(groupId, event) {
  const group = groups.get(groupId);
  if (!group) return false;
  if (group.handoffQueue.length >= MAX_HANDOFF_QUEUE) {
    group.handoffQueue.shift();
  }
  group.handoffQueue.push(event);
  group.handoffEmitter.emit('handoff');
  return true;
}

// Resolves with the next handoff event, or { timedOut: true } when timeoutMs
// elapses with the queue still empty (timeoutMs <= 0 means never).
export function takeHandoff(groupId, timeoutMs) {
  const group = groups.get(groupId);
  if (!group) return Promise.resolve({ error: 'group-not-found' });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      group.handoffEmitter.off('handoff', onHandoff);
      resolve(val);
    };
    const onHandoff = () => {
      if (group.handoffQueue.length > 0) finish(group.handoffQueue.shift());
    };
    const timer = timeoutMs > 0
      ? setTimeout(() => finish({ timedOut: true }), timeoutMs)
      : null;
    group.handoffEmitter.on('handoff', onHandoff);
    onHandoff();
  });
}

// Stop only the control broker (orchestrator exited) -- the workers stay
// alive so the human can keep working in them.
export function onOrchestratorExit(groupId) {
  const group = groups.get(groupId);
  if (!group) return;
  if (group.controlBroker) {
    stopBroker(group.controlBroker);
    group.controlBroker = null;
  }
}

// Destroy the whole group: all member sessions + all brokers. The
// orchestratorDir (CLAUDE.md/AGENTS.md) is intentionally left in place.
export function destroyGroup(groupId) {
  const group = groups.get(groupId);
  if (!group) return;
  for (const sessionId of [...group.members.values()]) {
    try {
      destroySession(sessionId, { keepSchedule: false });
    } catch {
      // best effort
    }
  }
  group.members.clear();
  if (group.controlBroker) {
    stopBroker(group.controlBroker);
    group.controlBroker = null;
  }
  for (const channel of [...group.handoffChannels.values()]) {
    stopBroker(channel);
  }
  group.handoffChannels.clear();
  group.handoffQueue = [];
  group.handoffEmitter.removeAllListeners();
  groups.delete(groupId);
}

// --- session-exit / session-create observation (no import cycle: sessionManager
// never imports this module; we subscribe via the listener setters) ----------

function onSessionExit(session) {
  if (!session?.groupId) return;
  const group = groups.get(session.groupId);
  if (!group) return;
  if (session.groupRole === 'orchestrator') {
    // Orchestrator died: stop its control broker. Workers keep running.
    onOrchestratorExit(session.groupId);
  } else {
    // Worker died: its handoff channel is useless (its MCP client is gone) --
    // stop it so no listener leaks, but keep the member registered so the
    // orchestrator can still inspect its status/output (exited: true).
    cleanupMemberChannels(group, session.id);
  }
  // A group whose every member session is gone is dead weight: it was not
  // torn down via DELETE /api/groups/:id (browser crash, idle timeouts, all
  // ptys exited on their own) and must not linger in the registry -- the
  // brokers are already stopped, so this just drops the Map entry.
  const liveCount = [...group.members.values()].some((sid) => {
    const s = getSession(sid);
    return s && !s.exited;
  });
  if (!liveCount) destroyGroup(session.groupId);
}

// A session was created with a groupId/groupRole (e.g. a scheduled prompt
// auto-resuming a group member after its pty exited): re-bind the role to the
// new sessionId so the member isn't orphaned from the group. Idempotent --
// the explicit registerMember() calls in the launch paths set the same
// values.
function onSessionCreate(session) {
  if (!session?.groupId || !session?.groupRole) return;
  const group = groups.get(session.groupId);
  if (!group) return;
  registerMember(session.groupId, session.groupRole, session.id);
}

function cleanupMemberChannels(group, sessionId) {
  for (const [role, channel] of [...group.handoffChannels]) {
    if (channel.sessionId === sessionId) {
      stopBroker(channel);
      group.handoffChannels.delete(role);
    }
  }
}

// Public facade passed into broker servers (avoids exposing the module
// namespace's internals / keeps tool deps explicit).
const groupManagerApi = {
  listGroupMembers,
  isSessionInGroup,
  pushHandoff,
  takeHandoff,
  addMember,
  removeMember,
};

const sessionApi = {
  getSession,
  writeToSession,
};

setSessionExitListener(onSessionExit);
setSessionCreateListener(onSessionCreate);
setMcpSocketResolver(resolveGroupMcpSocket);
