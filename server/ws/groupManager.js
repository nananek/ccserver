// In-memory registry of combo launch groups: a group binds two workers and
// one orchestrator (roles workerA/workerB/orchestrator, orthogonal to the
// app) around a shared project directory, plus the MCP broker channels that
// let the orchestrator reach them.
//
// Authorization: isSessionInGroup(groupId, sessionId) is the single chokepoint
// used by every MCP tool (see mcpTools.js). Members are only ever registered
// here, by this process, never declared by clients.

import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSession, destroySession, createSession, writeToSession, setSessionExitListener, setSessionCreateListener, setMcpSocketResolver, peekSavedSessions } from './sessionManager.js';
import { startControlBroker, startHandoffChannel, stopBroker } from './mcpBroker.js';
import { isValidApp } from './appLaunch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Groups survive a server restart via this file (groupId, member roles,
// orchestrator dir/app/instructions -- see persistGroups). Overridable for
// tests, which must never touch the real repo-root state file.
const GROUPS_PATH = process.env.CCSERVER_GROUPS_PATH || join(__dirname, '..', '..', '.saved-groups.json');

const groups = new Map(); // groupId -> group (see createGroup)

// Roles an orchestrator may open via open_tab: workerA/workerB plus any
// similarly-shaped worker role (workerC, worker-extra, ...). The
// orchestrator's own role is deliberately excluded -- an orchestrator must
// never be able to spawn/replace "itself".
const WORKER_ROLE_RE = /^worker[A-Za-z0-9_-]+$/;

// FIFO handoff queue cap: workers pushing while the orchestrator is gone must
// not grow the queue without bound.
const MAX_HANDOFF_QUEUE = 100;

// Group size cap: an orchestrator (a live LLM, subject to prompt injection
// via worker output) must not be able to spawn members without bound and
// exhaust pty/sandbox/socket resources. Includes the orchestrator itself.
const MAX_GROUP_MEMBERS = 8;

export async function createGroup({ groupId, cwd, orchestratorDir, sandboxOpts = null, orchestratorApp = null, instructions = null }) {
  const group = {
    id: groupId,
    createdAt: Date.now(),
    cwd,
    allowedCwds: new Set([cwd]),
    members: new Map(), // role -> sessionId
    orchestratorDir,
    // App the orchestrator was launched with; used by the orchestrator
    // restart endpoint (POST /api/groups/:id/orchestrator).
    orchestratorApp,
    // Starting text for the orchestrator's CLAUDE.md/AGENTS.md, re-written on
    // restore so a restarted server can bring the orchestrator dir back.
    instructions,
    // Per-launch sandbox flags (gpg/sshAgent) the group's workers launched
    // with; open_tab workers inherit them unless the tool overrides.
    sandboxOpts,
    controlBroker: null, // { server, sockPath, dir } | null
    handoffChannels: new Map(), // role -> { server, sockPath, dir, role, sessionId }
    handoffQueue: [],
    handoffEmitter: new EventEmitter(),
    // takeHandoff() waiters, so destroyGroup can settle them instead of
    // leaving the closure attached to the emitter forever.
    pendingTakes: new Set(),
    // role -> { app, cwd, claudeSessionId, sandbox, sandboxOpts } -- the last
    // known launch/resume info of each member, matched from the graceful-
    // shutdown .saved-sessions.json at restore time. Lets a restarted server
    // show members as resumable even though their pty sessions are gone.
    memberSaved: new Map(),
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

  persistGroups();
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
  persistGroups();
  return true;
}

// Resolve member sessions against sessionManager; a session that is gone from
// the manager (destroyed) shows up as exited with its cached fields. After a
// restart there are no sessions at all -- the member's last-known launch
// info (from .saved-sessions.json via restoreGroups) is returned instead so
// the UI can offer a resumable re-launch.
export function listGroupMembers(groupId) {
  const group = groups.get(groupId);
  if (!group) return [];
  const out = [];
  for (const [role, sessionId] of group.members) {
    const session = getSession(sessionId);
    const saved = group.memberSaved.get(role);
    out.push({
      role,
      sessionId,
      app: session?.app ?? saved?.app ?? null,
      cwd: session?.cwd ?? saved?.cwd ?? null,
      exited: session ? !!session.exited : true,
      connected: !!(session?.socket),
      // Resume info: a live-but-exited session carries its extracted
      // conversation id; a restored member carries the saved one.
      claudeSessionId: session?.claudeSessionId ?? saved?.claudeSessionId ?? null,
      sandbox: session?.sandbox ?? saved?.sandbox ?? false,
      sandboxOpts: session?.sandboxOpts ?? saved?.sandboxOpts ?? null,
      // true when the member only exists via the restart restore, i.e. its
      // pty is gone and a re-launch (resume) is the only way back.
      restored: !session && !!saved,
    });
  }
  return out;
}

// Compact public listing for GET /api/groups (client "groups" section).
export function listGroups() {
  return [...groups.values()].map((g) => ({
    groupId: g.id,
    cwd: g.cwd,
    createdAt: g.createdAt,
    memberCount: g.members.size,
    liveCount: [...g.members.values()].filter((sid) => {
      const s = getSession(sid);
      return s && !s.exited;
    }).length,
  }));
}

// --- persistence (groups survive a server restart) -------------------------

// Best effort: group state must never crash the launch/teardown paths.
function persistGroups() {
  try {
    const arr = [];
    for (const g of groups.values()) {
      arr.push({
        id: g.id,
        createdAt: g.createdAt,
        cwd: g.cwd,
        allowedCwds: [...g.allowedCwds],
        orchestratorDir: g.orchestratorDir,
        orchestratorApp: g.orchestratorApp || null,
        instructions: g.instructions || null,
        sandboxOpts: g.sandboxOpts || null,
        members: Object.fromEntries([...g.members]),
      });
    }
    if (arr.length > 0) {
      writeFileSync(GROUPS_PATH, JSON.stringify(arr));
    } else {
      try { unlinkSync(GROUPS_PATH); } catch { /* nothing to remove */ }
    }
  } catch {
    // best effort -- persistence must never crash the session manager
  }
}

// Rebuild the in-memory registry at startup from .saved-groups.json. The
// member ptys are gone (a restart kills them all), so members are registered
// from the persisted map and their resume info is matched from the graceful-
// shutdown .saved-sessions.json (see peekSavedSessions). The orchestrator dir
// is re-created (with its instruction files) so a scheduled auto-resume or an
// orchestrator restart can use it as cwd again.
export function restoreGroups() {
  let arr;
  try {
    arr = JSON.parse(readFileSync(GROUPS_PATH, 'utf-8'));
  } catch {
    return { restored: 0, ids: [] }; // no file / unreadable
  }
  if (!Array.isArray(arr)) return { restored: 0, ids: [] };

  const savedSessions = peekSavedSessions() || [];
  const ids = [];
  let restored = 0;
  for (const e of arr) {
    if (!e || typeof e.id !== 'string') continue;
    const group = {
      id: e.id,
      createdAt: e.createdAt || Date.now(),
      cwd: typeof e.cwd === 'string' ? e.cwd : null,
      allowedCwds: new Set(Array.isArray(e.allowedCwds) ? e.allowedCwds.filter((c) => typeof c === 'string') : []),
      members: new Map(),
      orchestratorDir: typeof e.orchestratorDir === 'string' ? e.orchestratorDir : null,
      orchestratorApp: typeof e.orchestratorApp === 'string' ? e.orchestratorApp : null,
      instructions: typeof e.instructions === 'string' ? e.instructions : null,
      sandboxOpts: e.sandboxOpts || null,
      controlBroker: null,
      handoffChannels: new Map(),
      handoffQueue: [],
      handoffEmitter: new EventEmitter(),
      pendingTakes: new Set(),
      memberSaved: new Map(),
    };
    if (e.members && typeof e.members === 'object') {
      for (const [role, sid] of Object.entries(e.members)) {
        if (typeof sid === 'string') group.members.set(role, sid);
      }
    }
    for (const s of savedSessions) {
      if (s && s.groupId === group.id && typeof s.groupRole === 'string') {
        group.memberSaved.set(s.groupRole, {
          app: typeof s.app === 'string' ? s.app : null,
          cwd: typeof s.cwd === 'string' ? s.cwd : null,
          claudeSessionId: typeof s.claudeSessionId === 'string' ? s.claudeSessionId : null,
          sandbox: !!s.sandbox,
          sandboxOpts: s.sandboxOpts || null,
        });
      }
    }
    if (group.orchestratorDir) {
      try {
        mkdirSync(group.orchestratorDir, { recursive: true, mode: 0o700 });
      } catch { /* nothing to do */ }
      if (group.instructions) {
        try {
          writeFileSync(join(group.orchestratorDir, 'CLAUDE.md'), group.instructions);
          writeFileSync(join(group.orchestratorDir, 'AGENTS.md'), group.instructions);
        } catch { /* best effort */ }
      }
    }
    groups.set(group.id, group);
    ids.push(group.id);
    restored++;
  }
  return { restored, ids };
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
// gone or the broker can't be (re)started -- the caller (fireSchedule) then
// drops the prompt instead of spawning a member that could never hand off.
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
  // The orchestrator (a live LLM, reachable by prompt injection through the
  // workers) must not be able to grow the group without bound.
  if (!group.members.has(role) && group.members.size >= MAX_GROUP_MEMBERS) {
    return {
      error: 'too-many-members',
      message: `group is full (max ${MAX_GROUP_MEMBERS} members)`,
    };
  }

  // A role is single-slot: replacing it retires the previous occupant. The
  // replacement is atomic -- the old session/channel are only destroyed AFTER
  // the new channel and session exist, so a failure anywhere leaves the old
  // member untouched instead of a ghost role with a destroyed session.
  const prevSessionId = group.members.get(role);
  const prevChannel = group.handoffChannels.get(role);

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
    if (prevChannel) group.handoffChannels.set(role, prevChannel); // restore the old slot
    else group.handoffChannels.delete(role);
    return { error: 'spawn-failed', message: res.error || 'session creation failed' };
  }

  // New member is fully in place -- only now retire the previous occupant.
  if (prevChannel) stopBroker(prevChannel);
  if (prevSessionId) destroySession(prevSessionId, { keepSchedule: false });
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
  persistGroups();
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
      group.pendingTakes.delete(finish);
      group.handoffEmitter.off('handoff', onHandoff);
      resolve(val);
    };
    const onHandoff = () => {
      if (group.handoffQueue.length > 0) finish(group.handoffQueue.shift());
    };
    const timer = timeoutMs > 0
      ? setTimeout(() => finish({ timedOut: true }), timeoutMs)
      : null;
    group.pendingTakes.add(finish);
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

// Destroy the whole group: all member sessions + all brokers, then remove the
// persisted entry. The orchestratorDir is removed with it -- a destroyed
// group can never be resumed (its schedules were cancelled with its member
// sessions), so leaving the dir behind would only litter disk. Guarded by the
// basename==groupId check so a malformed/foreign path is never deleted.
export function destroyGroup(groupId) {
  const group = groups.get(groupId);
  if (!group) return;
  for (const finish of [...group.pendingTakes]) {
    finish({ error: 'group-destroyed' });
  }
  group.pendingTakes.clear();
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
  if (group.orchestratorDir && basename(group.orchestratorDir) === group.id) {
    try {
      rmSync(group.orchestratorDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  persistGroups();
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
