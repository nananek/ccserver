// In-memory registry of combo launch groups: a group binds two workers and
// one orchestrator (roles workerA/workerB/orchestrator, orthogonal to the
// app) around a shared project directory, plus the MCP broker channels that
// let the orchestrator reach them.
//
// Authorization: isSessionInGroup(groupId, sessionId) is the single chokepoint
// used by every MCP tool (see mcpTools.js). Members are only ever registered
// here, by this process, never declared by clients.

import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, copyFileSync, statSync, rmSync, renameSync, openSync, closeSync, readSync, writeSync, readlinkSync, fstatSync, realpathSync } from 'node:fs';
import { constants as fsConstants } from 'node:fs';

// Test seams for deterministic failure injection
let commitRenameSyncImpl = renameSync;
export function setCommitRenameSyncForTests(fn) {
  commitRenameSyncImpl = fn || renameSync;
}
let agentPublishHook = null;
export function setAgentPublishHookForTests(fn) {
  agentPublishHook = fn || null;
}
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getSession, destroySession, createSession, writeToSession, waitUntilSettled, setSessionExitListener, setSessionCreateListener, setMcpSocketResolver, setOrchestratorClaudeMdResolver, setMemberCwdResolver, peekSavedSessions, dockerAvailability } from './sessionManager.js';
import { startControlBroker, startHandoffChannel, stopBroker } from './mcpBroker.js';
import { isValidApp } from './appLaunch.js';
import { loadSandboxConfig } from './sandbox.js';
import { resolveMemberWorktree, removeMemberWorktree, listWorktreeDirs } from './worktree.js';
import { sendNotification } from './notify.js';
import {
  getGroupFilesRoot,
  getGroupFilesDir,
  ensureGroupFilesDir,
  sanitizeDisplayName,
  mimeForName,
  generateFileId,
  storedNameForId,
  blobPathFor,
  sandboxPathFor,
  checkQuotaBeforeAdd,
  resolveAgentSourcePath,
  safeGroupFilesDirForDelete,
  MAX_FILE_BYTES,
  MAX_FILES_PER_GROUP,
  MAX_GROUP_BYTES,
  SANDBOX_GROUP_FILES_PATH,
} from './groupFiles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Groups survive a server restart via this file (groupId, member roles,
// orchestrator dir/app/instructions -- see persistGroups). Overridable for
// tests, which must never touch the real repo-root state file.
const GROUPS_PATH = process.env.CCSERVER_GROUPS_PATH || join(__dirname, '..', '..', '.saved-groups.json');
// Group-scoped published documents (publish_doc/fetch_doc/list_docs, see
// section 7 of the plan), kept in their own file rather than folded into
// GROUPS_PATH: persistGroups() is called far more often (every member
// registration / pref change) than documents are published, and mixing the
// two would mean re-serializing every doc's content on each of those
// unrelated writes.
const GROUP_DOCS_PATH = process.env.CCSERVER_GROUP_DOCS_PATH || join(__dirname, '..', '..', '.saved-group-docs.json');
const GROUP_FILES_PATH = process.env.CCSERVER_GROUP_FILES_PATH || join(__dirname, '..', '..', '.saved-group-files.json');

// Orchestrator CLAUDE.md/AGENTS.md source: a repo-tracked template, read
// fresh on every (re)spawn (never cached at module load) so an edit to the
// file lands the next time an orchestrator launches -- no ccserver restart
// needed. See generateOrchestratorClaudeMdSrc. Overridable (same pattern as
// ORCHESTRATOR_GENERATED_ROOT below) so a test can exercise "template edit
// lands on the next generation" against a throwaway copy instead of
// mutating this real, repo-tracked file in place -- other test files read
// it concurrently as their content oracle (node --test runs files in
// parallel by default).
const ORCHESTRATOR_TEMPLATE_PATH = process.env.CCSERVER_ORCHESTRATOR_TEMPLATE_PATH
  || join(__dirname, 'orchestrator-template.md');
// Merged (template + saved per-project instructions) output lives entirely
// outside orchestratorDir, which is bind-mounted rw into the sandbox -- if
// the generated file lived inside it, the orchestrator could see (and get
// confused by, or attempt to reference) its own overlay source. This dir is
// never mounted into any sandbox. Overridable (same pattern as sandbox.js's
// CCSERVER_SANDBOX_HOME_ROOT) so tests never write under the real home dir.
const ORCHESTRATOR_GENERATED_ROOT = process.env.CCSERVER_ORCHESTRATOR_GENERATED_ROOT
  || join(homedir(), '.local', 'share', 'ccserver-sandbox', 'orchestrator-generated');

const groups = new Map(); // groupId -> group (see createGroup)

// Roles an orchestrator may open via open_tab: workerA/workerB plus any
// similarly-shaped worker role (workerC, worker-extra, ...). The
// orchestrator's own role is deliberately excluded -- an orchestrator must
// never be able to spawn/replace "itself". Shared (exported, never copied)
// with worker preset validation and POST /groups' workers[] normalization,
// so a preset role is always a role addMember() will accept.
export const WORKER_ROLE_RE = /^worker[A-Za-z0-9_-]+$/;

// FIFO handoff queue cap: workers pushing while the orchestrator is gone must
// not grow the queue without bound.
const MAX_HANDOFF_QUEUE = 100;

// Group size cap: an orchestrator (a live LLM, subject to prompt injection
// via worker output) must not be able to spawn members without bound and
// exhaust pty/sandbox/socket resources. Includes the orchestrator itself.
// Exported: POST /groups' canonical workers[] validation derives its
// "max initial workers" from it (cap minus one for the orchestrator).
export const MAX_GROUP_MEMBERS = 8;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

function defaultApp() {
  return loadSandboxConfig().defaultApp || 'claude';
}

function normalizeModel(model) {
  return typeof model === 'string' && model.length > 0 ? model : null;
}

// Optional display name ("実装担当") kept alongside a member's technical role.
// Same shape rules as workerPresets' name field, but silent: memberPrefs
// arrive from already-validated launch paths (POST /groups' workers[]) or MCP
// calls, and a display-name typo must never fail a launch -- an invalid value
// simply degrades to null (the UI falls back to showing the role).
function normalizeDisplayName(name) {
  if (typeof name !== 'string') return null;
  const t = name.trim();
  return t && t.length <= 80 && !/[\u0000-\u001f\u007f]/.test(t) ? t : null;
}

function normalizeSandboxOpts(opts) {
  if (!opts || typeof opts !== 'object') return null;
  return { gpg: !!opts.gpg, sshAgent: !!opts.sshAgent };
}

function normalizeMemberPref(pref, fallback = {}) {
  const source = pref && typeof pref === 'object' ? pref : {};
  const name = hasOwn(source, 'name') ? normalizeDisplayName(source.name) : normalizeDisplayName(fallback.name);
  const app = isValidApp(source.app) ? source.app : (isValidApp(fallback.app) ? fallback.app : null);
  const model = hasOwn(source, 'model') ? normalizeModel(source.model) : normalizeModel(fallback.model);
  const sandboxOpts = hasOwn(source, 'sandboxOpts')
    ? normalizeSandboxOpts(source.sandboxOpts)
    : normalizeSandboxOpts(fallback.sandboxOpts);
  return { name, app, model, sandboxOpts };
}

function normalizeMemberPrefs(memberPrefs, legacyOrchestratorApp = null, groupSandboxOpts = null) {
  const source = memberPrefs && typeof memberPrefs === 'object' ? memberPrefs : {};
  const roles = ['workerA', 'workerB', 'orchestrator'];
  const out = Object.fromEntries(roles.map((role) => {
    const legacy = role === 'orchestrator' && isValidApp(legacyOrchestratorApp)
      ? { app: legacyOrchestratorApp }
      : {};
    const fallback = role === 'orchestrator' ? {} : { sandboxOpts: groupSandboxOpts };
    return [role, normalizeMemberPref(source[role], { ...fallback, ...legacy })];
  }));
  // Roles beyond the fixed trio (workerC, worker-extra, ...) are created by
  // open_tab; addMember persists their preferences, so a restart must restore
  // them too (same group-sandbox fallback as the two built-in workers), or
  // replacement of such a role would silently lose its model/app/sandbox.
  for (const [role, pref] of Object.entries(source)) {
    if (!(role in out)) out[role] = normalizeMemberPref(pref, { sandboxOpts: groupSandboxOpts });
  }
  return out;
}

function readOrchestratorTemplate() {
  return readFileSync(ORCHESTRATOR_TEMPLATE_PATH, 'utf-8');
}

// Template (always included) + the project's saved custom instructions (if
// any), simply appended -- never substituted -- so a user's custom
// instructions can never silently drop the template's handoff/notification
// discipline.
function mergeOrchestratorInstructions(customInstructions) {
  const template = readOrchestratorTemplate();
  if (!customInstructions) return template;
  return `${template}\n\n---\n\n## プロジェクト固有の指示 (ユーザー設定)\n\n${customInstructions}\n`;
}

// orchestratorDir's basename is already the cwd hash (orchestratorDirForCwd
// in routes/groups.js) -- no need to re-hash cwd here.
function generatedClaudeMdPath(orchestratorDir) {
  return join(ORCHESTRATOR_GENERATED_ROOT, `${basename(orchestratorDir)}.md`);
}

// Called right before every orchestrator (re)spawn (initial launch, restart,
// scheduled-prompt auto-resume). Merges the template with the group's saved
// instructions and writes the result to a host-only path outside
// orchestratorDir; the caller ro-binds that path over CLAUDE.md/AGENTS.md in
// the sandbox (see sandbox.js's buildBwrapArgs), so the running orchestrator
// can never persist an edit to its own operating rules. Returns null when
// the group or its orchestratorDir is unknown.
export function generateOrchestratorClaudeMdSrc(groupId) {
  const group = groups.get(groupId);
  if (!group || !group.orchestratorDir) return null;
  const content = mergeOrchestratorInstructions(group.instructions);
  const dest = generatedClaudeMdPath(group.orchestratorDir);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  writeFileSync(dest, content);
  return dest;
}

export async function createGroup({ groupId, cwd, orchestratorDir, sandboxOpts = null, orchestratorApp = null, orchestratorModel, orchestratorSandboxOpts, memberPrefs = null, instructions = null }) {
  const normalizedGroupSandboxOpts = normalizeSandboxOpts(sandboxOpts);
  const normalizedMemberPrefs = normalizeMemberPrefs(memberPrefs, orchestratorApp, normalizedGroupSandboxOpts);
  if (isValidApp(orchestratorApp)) normalizedMemberPrefs.orchestrator.app = orchestratorApp;
  // orchestratorModel/orchestratorSandboxOpts default to undefined: an absent
  // value must NOT clobber the orchestrator's memberPrefs (it stays the
  // authoritative source for the launch preference).
  if (orchestratorModel !== undefined) normalizedMemberPrefs.orchestrator.model = normalizeModel(orchestratorModel);
  if (orchestratorSandboxOpts !== undefined) normalizedMemberPrefs.orchestrator.sandboxOpts = normalizeSandboxOpts(orchestratorSandboxOpts);
  const group = {
    id: groupId,
    createdAt: Date.now(),
    cwd,
    allowedCwds: new Set([cwd]),
    members: new Map(), // role -> sessionId
    // Set while the group is still being assembled (the initial trio is
    // spawned after createGroup returns, see routes/groups.js). During
    // assembly the auto-destroy in onSessionExit is suppressed: a member
    // whose pty crashes before its siblings exist must not take the whole
    // half-built group (and its control broker) down with it.
    assembling: true,
    orchestratorDir,
    // App the orchestrator was launched with; used by the orchestrator
    // restart endpoint (POST /api/groups/:id/orchestrator).
    orchestratorApp: isValidApp(orchestratorApp) ? orchestratorApp : normalizedMemberPrefs.orchestrator.app,
    orchestratorModel: normalizedMemberPrefs.orchestrator.model,
    // Project-specific custom instructions (launcher UI's "オーケストレーター
    // への指示" field), appended to the template on every (re)spawn --
    // see generateOrchestratorClaudeMdSrc. Tied to this group record's own
    // lifetime: destroyGroup drops it along with everything else (see
    // routes/groups.js's threat-model comment for why the orchestrator no
    // longer gets a writable copy of its own operating rules).
    instructions,
    // Per-launch sandbox flags (gpg/sshAgent) the group's workers launched
    // with; open_tab workers inherit them unless the tool overrides.
    sandboxOpts: normalizedGroupSandboxOpts,
    memberPrefs: normalizedMemberPrefs,
    // role -> { path, gitCommonDir, branch } for every non-orchestrator role
    // that has ever been resolved to its own git worktree (see
    // resolveMemberLaunchCwd / worktree.js). Absent for a role whose project
    // isn't a git repo (worktree resolution falls back to sharing cwd, see
    // plan section 2.8) or that has never been spawned yet.
    memberWorktrees: new Map(),
    // key(string) -> { content, publishedBy(role), publishedAt(epoch ms) } --
    // the group-scoped "message board" (publish_doc/fetch_doc/list_docs, see
    // plan section 7), letting workers hand off content to each other
    // directly without going through the orchestrator or a shared ./tmp/
    // (each role's ./tmp/ lives in its own git worktree now and is not
    // visible to the others).
    docs: new Map(),
    // id(string) -> { id, name, size, mimeType, direction, publishedBy, publishedAt, storedName } --
    // group-scoped file exchange (browser <-> agent, agent <-> browser).
    files: new Map(),
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
    // Who has the turn now ('orchestrator' | a worker role | null). Updated
    // on pushHandoff (turn -> orchestrator, or the event's explicit nextRole)
    // and on sendInput (turn -> the targeted worker). Surfaced through
    // GET /groups/:id for the tab UI's polling; lastHandoffAt is the
    // Date.now() of the most recent handoff (for a "n min ago" display).
    currentTurn: null,
    lastHandoffAt: null,
  };
  groups.set(groupId, group);

  // Ensure the group's file blob directory exists (read-only bound at
  // /ccserver-group-files for every live member).
  try {
    ensureGroupFilesDir(groupId);
  } catch {
    // best effort -- file exchange is not critical to group creation
  }

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

// Facade-only lookup for the MCP layer: repo_info needs the group's project
// directory (and nothing else), so the facade exposes just the cwd instead of
// the raw group object (which carries controlBroker socket paths, handoff
// channels, handoffQueue, allowedCwds -- internals an LLM-facing tool must not
// reach).
export function getGroupCwd(groupId) {
  return groups.get(groupId)?.cwd ?? null;
}

// Declare a group fully assembled (all initial members spawned): from here on
// the "no live members" auto-destroy in onSessionExit applies. Called by the
// POST /groups handler after the last member is registered. No-op for groups
// that are already assembled or gone.
export function markGroupAssembled(groupId) {
  const group = groups.get(groupId);
  if (group) group.assembling = false;
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
    const session = sessionApi.getSession(sessionId);
    const saved = group.memberSaved.get(role);
    out.push({
      role,
      sessionId,
      // Display name chosen at launch (from a worker preset snapshot);
      // null for legacy members -- the UI falls back to the role label.
      name: group.memberPrefs[role]?.name ?? null,
      app: session?.app ?? saved?.app ?? group.memberPrefs[role]?.app ?? null,
      model: session?.model ?? saved?.model ?? group.memberPrefs[role]?.model ?? null,
      cwd: session?.cwd ?? saved?.cwd ?? null,
      exited: session ? !!session.exited : true,
      connected: !!(session?.socket),
      // Activity: ms since the member last produced output (null when there
      // is no live session to timestamp, e.g. a restored member).
      lastOutputAt: session?.lastOutputAt ?? null,
      idleForMs: session?.lastOutputAt != null ? Date.now() - session.lastOutputAt : null,
      // Auto-Y (automatic permission-approval) state of the live session;
      // null when there is no live session (e.g. a restored member).
      autoYes: session?.autoYes ?? null,
      // Resume info: a live-but-exited session carries its extracted
      // conversation id; a restored member carries the saved one.
      claudeSessionId: session?.claudeSessionId ?? saved?.claudeSessionId ?? null,
      sandbox: session?.sandbox ?? saved?.sandbox ?? false,
      sandboxOpts: session?.sandboxOpts ?? saved?.sandboxOpts ?? group.memberPrefs[role]?.sandboxOpts ?? null,
      // true when the member only exists via the restart restore, i.e. its
      // pty is gone and a re-launch (resume) is the only way back.
      restored: !session && !!saved,
      // Whether this member can use docker right now (see
      // sessionManager.dockerAvailability). A restored member has no live
      // dockerd/state to judge -- null/null (unknown), not a guess.
      ...(session ? sessionApi.dockerAvailability(session) : { dockerAvailable: null, dockerReason: null }),
    });
  }
  // The orchestrator is always the first tab (UI default-active) and the first
  // entry for the MCP list_group_sessions, regardless of registration order
  // (the POST /groups launch registers the workers first and the orchestrator
  // last -- see routes/groups.js). Stable sort -- V8 -- keeps the other roles
  // in insertion order.
  return out.slice().sort((a, b) => {
    if (a.role === 'orchestrator') return -1;
    if (b.role === 'orchestrator') return 1;
    return 0;
  });
}

// Resolve the orchestrator's *current* effective sandboxOpts (gpg/sshAgent):
// the live session's value when connected, else the last-known/persisted
// preference. Used by openTab (mcpTools.js) to cap what a genuinely new
// member can be granted -- the orchestrator is a live LLM reachable by
// prompt injection (see MAX_GROUP_MEMBERS above) and must not be able to
// grant a new member more than it itself currently holds. Mirrors
// listGroupMembers' own resolution order (session -> saved -> memberPrefs)
// so the answer always matches what the UI would show for the
// orchestrator's row.
export function getOrchestratorSandboxOpts(groupId) {
  const group = groups.get(groupId);
  if (!group) return null;
  const sessionId = group.members.get('orchestrator');
  const session = sessionId ? sessionApi.getSession(sessionId) : null;
  const saved = group.memberSaved.get('orchestrator');
  return session?.sandboxOpts ?? saved?.sandboxOpts ?? group.memberPrefs.orchestrator?.sandboxOpts ?? null;
}

// Whether `role` is already a registered member of the group, and if so its
// last-known effective sandboxOpts (same session -> saved -> memberPrefs
// resolution as above). Used by openTab to tell a genuine new-member request
// apart from a restart of an already-registered role: a restart must keep
// exactly the privileges the member already had, regardless of what the
// tool call requests (see the sandboxOpts privilege-escalation fix plan).
export function getRegisteredMemberSandboxOpts(groupId, role) {
  const group = groups.get(groupId);
  if (!group || !group.members.has(role)) return { registered: false, sandboxOpts: null };
  const sessionId = group.members.get(role);
  const session = sessionId ? sessionApi.getSession(sessionId) : null;
  const saved = group.memberSaved.get(role);
  return {
    registered: true,
    sandboxOpts: session?.sandboxOpts ?? saved?.sandboxOpts ?? group.memberPrefs[role]?.sandboxOpts ?? null,
  };
}

// Compact public listing for GET /api/groups (client "groups" section).
export function listGroups() {
  return [...groups.values()].map((g) => ({
    groupId: g.id,
    cwd: g.cwd,
    createdAt: g.createdAt,
    memberCount: g.members.size,
    liveCount: [...g.members.values()].filter((sid) => {
      const s = sessionApi.getSession(sid);
      return s && !s.exited;
    }).length,
  }));
}

// Public per-group summary for the meta agent's get_group tool (and any other
// privileged consumer): the same fields the GET /api/groups/:id route returns,
// MINUS the internals that facade deliberately withholds (orchestratorDir /
// allowedCwds -- host paths and scope internals an LLM-facing tool must not
// reach; see getGroupManagerApi's comment). null when the group is gone.
export function getGroupSummary(groupId) {
  const group = groups.get(groupId);
  if (!group) return null;
  return {
    groupId: group.id,
    cwd: group.cwd,
    createdAt: group.createdAt,
    members: listGroupMembers(groupId),
    currentTurn: group.currentTurn ?? null,
    lastHandoffAt: group.lastHandoffAt ?? null,
  };
}

export function getMemberPrefs(groupId, role = null) {
  const group = groups.get(groupId);
  if (!group) return null;
  if (role) return group.memberPrefs[role] ? { ...group.memberPrefs[role] } : null;
  return structuredClone(group.memberPrefs);
}

export function setMemberPrefs(groupId, role, pref) {
  const group = groups.get(groupId);
  if (!group || typeof role !== 'string') return false;
  const current = group.memberPrefs[role] || {};
  const normalized = normalizeMemberPref(pref, current);
  group.memberPrefs[role] = normalized;
  if (role === 'orchestrator') {
    group.orchestratorApp = normalized.app;
    group.orchestratorModel = normalized.model;
  }
  persistGroups();
  return true;
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
        orchestratorModel: g.orchestratorModel || null,
        instructions: g.instructions || null,
        sandboxOpts: g.sandboxOpts || null,
        memberPrefs: g.memberPrefs || {},
        members: Object.fromEntries([...g.members]),
        memberWorktrees: Object.fromEntries([...g.memberWorktrees]),
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
// is re-created (empty -- CLAUDE.md/AGENTS.md are generated fresh at the next
// actual spawn, see generateOrchestratorClaudeMdSrc) so a scheduled
// auto-resume or an orchestrator restart can use it as cwd again.
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
      // Restored groups are complete by definition (they were persisted
      // after assembly finished): never subject them to the assembly grace.
      assembling: false,
      orchestratorDir: typeof e.orchestratorDir === 'string' ? e.orchestratorDir : null,
      orchestratorApp: typeof e.orchestratorApp === 'string' ? e.orchestratorApp : null,
      orchestratorModel: normalizeModel(e.orchestratorModel),
      instructions: typeof e.instructions === 'string' ? e.instructions : null,
      sandboxOpts: e.sandboxOpts || null,
      memberPrefs: normalizeMemberPrefs(e.memberPrefs, e.orchestratorApp, e.sandboxOpts),
      memberWorktrees: new Map(),
      docs: new Map(),
      files: new Map(),
      controlBroker: null,
      handoffChannels: new Map(),
      handoffQueue: [],
      handoffEmitter: new EventEmitter(),
      pendingTakes: new Set(),
      memberSaved: new Map(),
    };
    if (e.memberWorktrees && typeof e.memberWorktrees === 'object') {
      for (const [role, wt] of Object.entries(e.memberWorktrees)) {
        if (wt && typeof wt === 'object' && typeof wt.path === 'string') {
          group.memberWorktrees.set(role, {
            path: wt.path,
            gitCommonDir: typeof wt.gitCommonDir === 'string' ? wt.gitCommonDir : null,
            branch: typeof wt.branch === 'string' ? wt.branch : null,
          });
        }
      }
    }
    if (group.orchestratorModel != null && !hasOwn(e.memberPrefs?.orchestrator, 'model')) {
      group.memberPrefs.orchestrator.model = group.orchestratorModel;
    }
    if (!group.orchestratorApp) group.orchestratorApp = group.memberPrefs.orchestrator.app;
    if (e.members && typeof e.members === 'object') {
      for (const [role, sid] of Object.entries(e.members)) {
        if (typeof sid === 'string') group.members.set(role, sid);
      }
    }
    for (const s of savedSessions) {
      if (s && s.groupId === group.id && typeof s.groupRole === 'string') {
        group.memberSaved.set(s.groupRole, {
          app: typeof s.app === 'string' ? s.app : null,
          model: normalizeModel(s.model),
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
    }
    groups.set(group.id, group);
    ids.push(group.id);
    restored++;
  }
  // Independent of the .saved-groups.json restore above (a corrupt/missing
  // docs file must not block group restoration, and vice versa -- see plan
  // section 7.3): docs are plain persisted text with no filesystem
  // counterpart, so this can never fail for the same reasons a worktree
  // restore could.
  try {
    const rawDocs = JSON.parse(readFileSync(GROUP_DOCS_PATH, 'utf-8'));
    if (rawDocs && typeof rawDocs === 'object') {
      for (const [gid, docsObj] of Object.entries(rawDocs)) {
        const group = groups.get(gid);
        if (!group || !docsObj || typeof docsObj !== 'object') continue;
        for (const [key, doc] of Object.entries(docsObj)) {
          if (doc && typeof doc === 'object' && typeof doc.content === 'string') {
            group.docs.set(key, {
              content: doc.content,
              publishedBy: typeof doc.publishedBy === 'string' ? doc.publishedBy : null,
              publishedAt: typeof doc.publishedAt === 'number' ? doc.publishedAt : Date.now(),
            });
          }
        }
      }
    }
  } catch {
    // no persisted docs yet / unreadable -- groups still restore fine
  }
  // Restore group files manifest (independent of docs/groups): stale entries
  // whose blob is missing or not a regular file under the group's root are
  // ignored.
  try {
    const rawFiles = JSON.parse(readFileSync(GROUP_FILES_PATH, 'utf-8'));
    if (rawFiles && typeof rawFiles === 'object') {
      for (const [gid, filesObj] of Object.entries(rawFiles)) {
        const group = groups.get(gid);
        if (!group || !filesObj || typeof filesObj !== 'object') continue;
        // Ensure the group's blob directory exists so later binds succeed.
        try { ensureGroupFilesDir(gid); } catch { /* ignore */ }
        const dir = getGroupFilesDir(gid);
        for (const [fid, meta] of Object.entries(filesObj)) {
          if (!meta || typeof meta !== 'object') continue;
          if (typeof meta.id !== 'string' || typeof meta.name !== 'string') continue;
          if (typeof meta.storedName !== 'string') continue;
          const blobPath = join(dir, meta.storedName);
          try {
            const st = statSync(blobPath);
            if (!st.isFile()) continue;
            // Verify containment (storedName was server-generated, but be safe).
            const resolved = resolve(blobPath);
            const rootResolved = resolve(dir);
            if (resolved !== rootResolved && !resolved.startsWith(rootResolved + '/')) continue;
          } catch {
            continue; // blob missing -- stale manifest entry
          }
          group.files.set(fid, {
            id: meta.id,
            name: sanitizeDisplayName(meta.name),
            size: typeof meta.size === 'number' ? meta.size : 0,
            mimeType: typeof meta.mimeType === 'string' ? meta.mimeType : mimeForName(meta.name),
            direction: meta.direction === 'agent' ? 'agent' : 'user',
            publishedBy: typeof meta.publishedBy === 'string' ? meta.publishedBy : null,
            publishedAt: typeof meta.publishedAt === 'number' ? meta.publishedAt : Date.now(),
            storedName: meta.storedName,
          });
        }
      }
    }
  } catch {
    // no persisted files yet / unreadable -- groups still restore fine
  }
  return { restored, ids };
}

// Startup orphan scan (plan section 3.7-3): warns (never deletes) about any
// `<projectHash>/<role>` directory under worktree.js's worktreeRoot() that
// isn't claimed by any currently known group. Meant to be called once, right
// after restoreGroups() (server/index.js) -- a directory only becomes
// orphaned through a removal that failed (see cleanupMemberWorktree, which
// deliberately never `--force`s) or a crash between creation and the next
// persistGroups(), so this is purely diagnostic: the human decides whether
// to inspect/remove it by hand. Returns the list of orphaned paths (for
// tests / callers that want to log a count).
export function detectOrphanWorktrees() {
  const claimed = new Set();
  for (const group of groups.values()) {
    for (const wt of group.memberWorktrees.values()) {
      if (wt?.path) claimed.add(resolve(wt.path));
    }
  }
  const orphans = listWorktreeDirs().filter((dir) => !claimed.has(resolve(dir)));
  for (const dir of orphans) {
    console.warn(`[groupManager] orphaned worktree directory (belongs to no known group): ${dir}`);
  }
  return orphans;
}

// The authorization chokepoint: is `sessionId` a member of this group?
export function isSessionInGroup(groupId, sessionId) {
  const group = groups.get(groupId);
  if (!group) return false;
  return [...group.members.values()].includes(sessionId);
}

// Record that the turn has moved to `role` (e.g. a worker that sendInput just
// targeted). No-op when the group or the role is unknown. Used by the MCP
// sendInput path so the tab UI's polling sees who's up next.
export function setCurrentTurn(groupId, role) {
  const group = groups.get(groupId);
  if (!group) return false;
  if (!group.members.has(role)) return false;
  group.currentTurn = role;
  return true;
}

// Reverse of isSessionInGroup: which role does `sessionId` hold, if any?
export function getRoleForSession(groupId, sessionId) {
  const group = groups.get(groupId);
  if (!group) return null;
  for (const [role, sid] of group.members) {
    if (sid === sessionId) return role;
  }
  return null;
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
  channel.sessionId = group.members.get(role) || null;
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

// Single canonical resolver for "what cwd (and git-common-dir sandbox bind)
// should this group member launch with" -- called from every (re)spawn site
// (addMember above, terminal.js's `init` reconnect, sessionManager's
// scheduled-prompt auto-resume) so they can never disagree (plan section
// 3.6.1). The orchestrator always gets its stable orchestratorDir (no
// worktree involved); every other role gets its own git worktree via
// resolveMemberWorktree, or -- when the project isn't a git repo -- falls
// back to sharing the project cwd exactly like every role did before this
// feature existed (plan section 2.8).
//
// Returns { cwd, gitCommonDir } or null when the group is unknown or
// worktree resolution itself threw (a real git failure, not just "not a
// repo") -- callers must treat that the same as any other unresolvable-
// launch-target case (refuse the spawn rather than launch into a guess).
export function resolveMemberLaunchCwd(groupId, role) {
  const group = groups.get(groupId);
  if (!group) return null;
  if (role === 'orchestrator') {
    return group.orchestratorDir ? { cwd: group.orchestratorDir, gitCommonDir: null } : null;
  }
  if (!group.cwd) return null;
  let resolution;
  try {
    const hintBranch = group.memberWorktrees.get(role)?.branch || null;
    resolution = resolveMemberWorktree(group.cwd, role, hintBranch);
  } catch (err) {
    console.warn(`[groupManager] worktree resolution failed for ${groupId}/${role}: ${err.message}`);
    return null;
  }
  if (resolution.usedWorktree) {
    group.memberWorktrees.set(role, { path: resolution.cwd, gitCommonDir: resolution.gitCommonDir, branch: resolution.branch });
    if (!group.allowedCwds.has(resolution.cwd)) group.allowedCwds.add(resolution.cwd);
    persistGroups();
    if (resolution.lostWork) {
      console.warn(`[groupManager] worktree for ${groupId}/${role} was recreated and lost uncommitted work -- notifying`);
      notifyWorktreeDataLoss(group, role, resolution);
    }
  }
  return { cwd: resolution.cwd, gitCommonDir: resolution.gitCommonDir };
}

// Human must always learn when a worktree recreation discarded an agent's
// in-progress work -- never silently, log-only (plan section 3.6.1: this
// mirrors why notify was made mandatory over idle-heuristic detection in the
// first place). Best-effort and non-blocking: sendNotification degrades
// gracefully with no channels configured (see notify.js), so this is safe to
// call unconditionally and must never make the caller (a session spawn path)
// wait on webhook delivery.
function notifyWorktreeDataLoss(group, role, resolution) {
  const identity = {
    groupId: group.id,
    groupRole: role,
    cwd: group.cwd,
    projectName: group.cwd ? basename(group.cwd) : null,
  };
  sendNotification({
    title: `Worktree for ${role} was recreated`,
    body: resolution.branch
      ? `Its working branch "${resolution.branch}" survived, but uncommitted/untracked changes in the worktree were lost when it had to be recreated from disk.`
      : 'Its working branch and any uncommitted work were lost when the worktree had to be recreated from scratch.',
    level: 'warning',
  }, identity).catch(() => { /* best effort, see notify.js */ });
}

// open_tab: add a new worker session to the group. Reuses the same
// channel-then-session flow as the initial trio. Returns { sessionId, app,
// cwd } or { error, message }.
export async function addMember(groupId, role, options = {}) {
  const group = groups.get(groupId);
  if (!group) return { error: 'group-not-found', message: 'group not found' };
  const pref = group.memberPrefs[role] || normalizeMemberPref(null);
  let app = hasOwn(options, 'app') && options.app !== undefined
    ? options.app
    : (pref.app || defaultApp());
  // copilot/commandcode have no CLI-arg/env MCP injection (config-file only
  // / unverified), so a combo member could never use the group's broker
  // tools. An explicit request is refused; a fallback is corrected to claude.
  if (app === 'copilot' || app === 'commandcode') {
    if (hasOwn(options, 'app') && options.app !== undefined) {
      return { error: 'bad-request', message: 'app must be claude, opencode, or codex (copilot is not supported in groups; commandcode neither)' };
    }
    app = 'claude';
  }
  const model = hasOwn(options, 'model') ? normalizeModel(options.model) : normalizeModel(pref.model);
  const sandboxOpts = hasOwn(options, 'sandboxOpts')
    ? normalizeSandboxOpts(options.sandboxOpts)
    : (pref.sandboxOpts || group.sandboxOpts);
  if (!isValidApp(app) || app === 'copilot' || app === 'commandcode') return { error: 'bad-request', message: 'app must be claude, opencode, or codex (copilot is not supported in groups; commandcode neither)' };
  if (!WORKER_ROLE_RE.test(role)) {
    return {
      error: 'invalid-role',
      message: 'role must be a worker role (e.g. workerA, workerB), never orchestrator',
    };
  }
  // The orchestrator (a live LLM, reachable by prompt injection through the
  // workers) must not be able to grow the group without bound.
  if (!group.members.has(role) && group.members.size >= MAX_GROUP_MEMBERS) {
    return {
      error: 'too-many-members',
      message: `group is full (max ${MAX_GROUP_MEMBERS} members)`,
    };
  }

  // options.cwd (accepted at the wire layer for open_tab -- see mcpTools.js
  // and mcpServer.js's tool description) is intentionally never read here:
  // the server always assigns this role its own dedicated git worktree (or
  // falls back to the shared project cwd when it isn't a git repo), the
  // same "orchestrator-requested value is capped/ignored, server decides"
  // pattern already used for sandboxOpts -- see plan section 3.3.
  const cwdRes = resolveMemberLaunchCwd(groupId, role);
  if (!cwdRes) {
    return { error: 'cwd-resolution-failed', message: 'failed to resolve a working directory for this role' };
  }
  const { cwd, gitCommonDir } = cwdRes;

  // A role is single-slot: replacing it retires the previous occupant. The
  // replacement is atomic -- the old session is only destroyed AFTER the new
  // channel and session exist, so a failure anywhere leaves the old member
  // untouched instead of a ghost role with a destroyed session.
  const prevSessionId = group.members.get(role);
  const prevChannel = group.handoffChannels.get(role);

  // The replacement channel shares the role's deterministic socket path with
  // its predecessor, so the old channel is retired FIRST: leaving it around
  // would have stopBroker() remove the replacement's own socket file (both
  // channels use the same path), orphaning the new listener's file. If the
  // replacement fails, the old channel is re-listened -- the old session is
  // never touched until the new one exists.
  if (prevChannel) stopBroker(prevChannel);

  const channel = await createMemberHandoffChannel(groupId, role).catch(() => null);
  if (!channel) {
    if (prevChannel) await ensureHandoffChannel(group, role).catch(() => { /* best effort */ });
    return { error: 'channel-failed', message: 'failed to create handoff channel' };
  }
  const res = sessionApi.createSession({
    cwd,
    cols: 80,
    rows: 24,
    sandbox: true,
    // Inherit the flags the group's workers were launched with unless the
    // tool call overrides them.
    sandboxOpts,
    app,
    model,
    groupId,
    groupRole: role,
    mcpSocketPath: channel.sockPath,
    gitCommonDir,
  });
  if (res.error || !res.session) {
    stopBroker(channel);
    if (prevChannel) await ensureHandoffChannel(group, role).catch(() => { /* best effort */ });
    else group.handoffChannels.delete(role);
    return { error: 'spawn-failed', message: res.error || 'session creation failed' };
  }

  // New member is fully in place -- only now retire the previous occupant.
  if (prevSessionId) sessionApi.destroySession(prevSessionId, { keepSchedule: false });
  registerMember(groupId, role, res.sessionId);
  // normalizeMemberPref's fallback merge keeps a display name across open_tab
  // replacements unless the call explicitly passes a new one.
  group.memberPrefs[role] = normalizeMemberPref(
    {
      app,
      model,
      sandboxOpts,
      ...(hasOwn(options, 'name') ? { name: options.name } : {}),
    },
    group.memberPrefs[role] || {},
  );
  if (role === 'orchestrator') {
    group.orchestratorApp = app;
    group.orchestratorModel = model;
  }
  persistGroups();
  return { sessionId: res.sessionId, app, model, sandboxOpts: normalizeSandboxOpts(sandboxOpts), cwd };
}

// (Re)listen a role's handoff channel and re-register it in the group. Used
// to bring a retired channel back when a member replacement fails -- the
// previous member keeps working (and can still hand off) untouched.
async function ensureHandoffChannel(group, role) {
  const channel = await startHandoffChannel({
    groupId: group.id,
    role,
    getSessionId: () => group.members.get(role) || null,
    groupManager: groupManagerApi,
    sessionManager: sessionApi,
  });
  channel.role = role;
  channel.sessionId = group.members.get(role) || null;
  group.handoffChannels.set(role, channel);
  return channel;
}

// close_tab / explicit removal: destroy the session, its handoff channel,
// and (if it had one) its git worktree.
export function removeMember(groupId, sessionId) {
  const group = groups.get(groupId);
  if (!group) return;
  sessionApi.destroySession(sessionId, { keepSchedule: false });
  cleanupMemberChannels(group, sessionId);
  let removedRole = null;
  for (const [role, sid] of group.members) {
    if (sid === sessionId) {
      group.members.delete(role);
      removedRole = role;
    }
  }
  if (removedRole) cleanupMemberWorktree(group, removedRole);
  persistGroups();
}

// One centralized cleanup path for a role's worktree (plan section 3.7-1),
// used by both removeMember (this role is being fully retired from the
// group) and destroyGroup (every role is). Best-effort like the sibling
// sandboxStateDir/git-broker cleanup in sessionManager.destroySession -- a
// worktree removal failure must never abort the rest of teardown. Never
// `--force`s the underlying `git worktree remove` (see worktree.js):
// on failure the directory is left on disk for the startup orphan scan
// (detectOrphanWorktrees) to flag, rather than risk destroying in-progress
// work.
function cleanupMemberWorktree(group, role) {
  if (role === 'orchestrator' || !group.cwd || !group.memberWorktrees.has(role)) return;
  try {
    if (!removeMemberWorktree(group.cwd, role)) {
      console.warn(`[groupManager] failed to remove worktree for ${group.id}/${role} (uncommitted changes?) -- left on disk`);
    }
  } catch (err) {
    console.warn(`[groupManager] error removing worktree for ${group.id}/${role}: ${err.message}`);
  }
  group.memberWorktrees.delete(role);
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
  // A worker handed off: the turn moves to the orchestrator -- or, when the
  // handoff declares an explicit nextRole, straight to that role.
  group.currentTurn = event.nextRole || 'orchestrator';
  group.lastHandoffAt = Date.now();
  group.handoffEmitter.emit('handoff');
  return true;
}

// Resolves with the next handoff event, or { timedOut: true } when timeoutMs
// elapses with the queue still empty (timeoutMs <= 0 means never).
//
// Reliability contract (the orchestrator's wait_for_handoff depends on it):
// an event is only ever dequeued by a waiter that can be reasonably expected
// to deliver it. A waiter whose client connection is dead or whose request
// was cancelled must not remove an event from the queue -- the event stays
// queued and the next wait_for_handoff receives it.
//
// Only one waiter per group is ever meaningful (the orchestrator calls
// wait_for_handoff one at a time). A client-side cancelled MCP request leaves
// its takeHandoff promise -- and its listener -- alive server-side for up to
// timeoutMs (15 min by default), and such a "zombie" listener, being older,
// would consume the next pushHandoff before the real waiter ever sees it.
// So a new takeHandoff first settles every still-pending waiter for the same
// group as { timedOut: true } (each finish tears its own listener/timer
// down), then registers the fresh waiter as the sole consumer.
//
// opts.isAlive (a function, optional): checked right before a dequeue. When
// it returns false the waiter leaves the queue alone -- the event belongs to
// the next waiter whose connection is actually alive. The waiter itself is
// left pending (it cannot consume anything) until superseded or timed out.
//
// Dequeue is not the same as delivery: the waiter claims an event, then
// commits the delivery on the next macrotask. A supersede arriving in the
// same turn can still reclaim the claimed event (its connection may have died
// or its request been cancelled between the claim and the send), so the
// event is re-queued instead of being lost with the stale waiter. The same
// reclaim runs when the orchestrator exits (onOrchestratorExit) or a timeout
// fires while an event is claimed.
export function takeHandoff(groupId, timeoutMs, opts = {}) {
  const group = groups.get(groupId);
  if (!group) return Promise.resolve({ error: 'group-not-found' });
  if (group.pendingTakes.size > 0) {
    console.warn(`[groupManager] takeHandoff(${groupId}): superseding ${group.pendingTakes.size} still-pending waiter(s)`);
  }
  settlePendingTakes(group, { timedOut: true });
  return new Promise((resolve) => {
    const waiter = { consumed: null, finish: null, onHandoff: null };
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      group.pendingTakes.delete(waiter);
      group.handoffEmitter.off('handoff', waiter.onHandoff);
      resolve(val);
    };
    waiter.finish = finish;
    waiter.onHandoff = () => {
      if (group.handoffQueue.length === 0 || waiter.consumed) return;
      if (opts.isAlive && !opts.isAlive()) return;
      waiter.consumed = group.handoffQueue.shift();
      // Commit the delivery on the next macrotask, not inline: a supersede
      // (a newer takeHandoff in the same turn) must be able to reclaim the
      // event from this waiter, so it is never delivered to a connection
      // whose request may already be gone.
      setTimeout(() => finish(waiter.consumed), 0);
    };
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          reclaimConsumed(group, waiter);
          finish({ timedOut: true });
        }, timeoutMs)
      : null;
    group.pendingTakes.add(waiter);
    group.handoffEmitter.on('handoff', waiter.onHandoff);
    waiter.onHandoff();
  });
}

// Give back an event a (still-pending) waiter claimed but has not committed:
// its delivery is suspect (dead connection, cancelled request), so the event
// must reach the next waiter. Reference-guarded against re-queueing an event
// that already sits in the queue.
function reclaimConsumed(group, waiter) {
  if (!waiter.consumed) return;
  if (!group.handoffQueue.includes(waiter.consumed)) {
    group.handoffQueue.unshift(waiter.consumed);
  }
  waiter.consumed = null;
}

// Settle every pending waiter for the group with `val`, reclaiming any event
// a waiter already claimed. Used by supersede (a newer takeHandoff) and by
// onOrchestratorExit (the control broker went away: no zombie waiter may
// linger for the full timeout).
function settlePendingTakes(group, val) {
  for (const stale of [...group.pendingTakes]) {
    reclaimConsumed(group, stale);
    stale.finish(val);
  }
}

// Stop only the control broker (orchestrator exited) -- the workers stay
// alive so the human can keep working in them. Pending wait_for_handoff
// waiters (created by the now-destroyed control connections) are settled
// with { timedOut: true } so no 15-minute zombie survives the broker
// teardown; the events themselves stay in the queue (any claimed-but-
// undelivered event is reclaimed by settlePendingTakes), so the next
// orchestrator's wait_for_handoff still receives them.
export function onOrchestratorExit(groupId) {
  const group = groups.get(groupId);
  if (!group) return;
  if (group.pendingTakes.size > 0) {
    settlePendingTakes(group, { timedOut: true });
  }
  if (group.controlBroker) {
    stopBroker(group.controlBroker);
    group.controlBroker = null;
  }
}

// Destroy the whole group: all member sessions + all brokers, then remove the
// persisted entry. The orchestratorDir is intentionally left in place -- it
// is a per-project resource (see routes/groups.js), reused as the cwd for the
// next group launched for the same project. Note this drops group.instructions
// (the project's saved custom orchestrator instructions) along with the rest
// of the group record -- see the `instructions` field comment in createGroup.
export function destroyGroup(groupId) {
  const group = groups.get(groupId);
  if (!group) return;
  for (const waiter of [...group.pendingTakes]) {
    waiter.finish({ error: 'group-destroyed' });
  }
  group.pendingTakes.clear();
  for (const sessionId of [...group.members.values()]) {
    try {
      sessionApi.destroySession(sessionId, { keepSchedule: false });
    } catch {
      // best effort
    }
  }
  group.members.clear();
  // Every role's worktree is removed here, unlike orchestratorDir (kept as a
  // per-project resource, see the header comment above) -- worktrees are
  // deliberately NOT reused across group launches, so the "delete by
  // default" policy from plan section 3.7 applies even on a routine destroy.
  for (const role of [...group.memberWorktrees.keys()]) {
    cleanupMemberWorktree(group, role);
  }
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
  // Cleanup group file blobs (verified path only).
  try {
    const dir = safeGroupFilesDirForDelete(groupId);
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort -- never touch arbitrary host paths
  }

  groups.delete(groupId);
  persistGroups();
  // persistGroupDocs() serializes docs for every group still in `groups`
  // (mirrors persistGroups() above); the group is already removed from that
  // map, so this naturally drops its entry from .saved-group-docs.json too.
  persistGroupDocs();
  persistGroupFiles();
}

// --- group-scoped document sharing (publish_doc/fetch_doc/list_docs, plan
// section 7): a simple key-value "message board" any member can publish to
// and any member (including the orchestrator) can read, replacing the
// pre-worktree convention of handing off content via a shared ./tmp/ (each
// role's ./tmp/ now lives inside its own git worktree and is invisible to
// the others) --------------------------------------------------------------

// Per-doc/per-group caps mirroring repo_info's "shallow by design, capped in
// size" posture: an MCP tool argument is untrusted-ish input from a live LLM
// (reachable via prompt injection through worker/orchestrator output), so
// the group's memory footprint must stay bounded regardless of how it's used.
const MAX_DOC_BYTES = 256 * 1024;
const MAX_DOCS_PER_GROUP = 50;

// Re-publishing the same key overwrites it (whoever published most recently
// wins) -- kept deliberately simple for a "message board", no per-key
// ownership or versioning. See plan section 7.6 for what's left open here.
export function publishGroupDoc(groupId, role, key, content) {
  const group = groups.get(groupId);
  if (!group) return { error: 'group-not-found', message: 'group not found' };
  if (typeof key !== 'string' || !key) {
    return { error: 'bad-request', message: 'key must be a non-empty string' };
  }
  const text = typeof content === 'string' ? content : '';
  const byteLength = Buffer.byteLength(text, 'utf-8');
  if (byteLength > MAX_DOC_BYTES) {
    return { error: 'too-large', message: `content exceeds the ${MAX_DOC_BYTES} byte limit (got ${byteLength} bytes)` };
  }
  if (!group.docs.has(key) && group.docs.size >= MAX_DOCS_PER_GROUP) {
    return { error: 'too-many-docs', message: `group already has the maximum of ${MAX_DOCS_PER_GROUP} published documents` };
  }
  const doc = { content: text, publishedBy: role, publishedAt: Date.now() };
  group.docs.set(key, doc);
  persistGroupDocs();
  return { ok: true, key, publishedBy: doc.publishedBy, publishedAt: doc.publishedAt };
}

export function fetchGroupDoc(groupId, key) {
  const group = groups.get(groupId);
  if (!group) return { error: 'group-not-found', message: 'group not found' };
  const doc = group.docs.get(key);
  if (!doc) return { error: 'not-found', message: `no document published under key "${key}"` };
  return { key, content: doc.content, publishedBy: doc.publishedBy, publishedAt: doc.publishedAt };
}

// Never includes `content` -- same "list is cheap, fetch is deliberate"
// design as repo_info, so a member can see what's available without every
// list_docs call hauling every document's full content into its context.
export function listGroupDocs(groupId) {
  const group = groups.get(groupId);
  if (!group) return [];
  return [...group.docs.entries()].map(([key, doc]) => ({
    key,
    publishedBy: doc.publishedBy,
    publishedAt: doc.publishedAt,
    size: Buffer.byteLength(doc.content, 'utf-8'),
  }));
}

export function deleteGroupDoc(groupId, role, key) {
  const group = groups.get(groupId);
  if (!group) return { error: 'group-not-found', message: 'group not found' };
  if (!group.docs.has(key)) return { error: 'not-found', message: `no document published under key "${key}"` };
  group.docs.delete(key);
  persistGroupDocs();
  return { ok: true };
}

// Best effort, same pattern as persistGroups(): re-serializes every group's
// docs on each call, but this is only ever called from publish/deleteGroupDoc
// (not from the frequent member/pref-mutation paths that call persistGroups()),
// so the write rate stays tied to how often documents actually change (plan
// section 7.3).
function persistGroupDocs() {
  try {
    const out = {};
    for (const g of groups.values()) {
      if (g.docs.size === 0) continue;
      out[g.id] = Object.fromEntries([...g.docs]);
    }
    if (Object.keys(out).length > 0) {
      writeFileSync(GROUP_DOCS_PATH, JSON.stringify(out));
    } else {
      try { unlinkSync(GROUP_DOCS_PATH); } catch { /* nothing to remove */ }
    }
  } catch {
    // best effort -- persistence must never crash a publish/delete call
  }
}

// --- group-scoped file exchange (browser <-> agent, agent <-> browser) -----
// Blobs are stored under <groupFilesRoot>/<groupId>/<storedName> (generated),
// never using the upload filename as a path component. Metadata lives in
// group.files Map and is persisted to .saved-group-files.json.

export function listGroupFiles(groupId) {
  const group = groups.get(groupId);
  if (!group) return { error: 'group-not-found', message: 'group not found' };
  const files = [...group.files.values()].map((m) => ({
    id: m.id,
    name: m.name,
    size: m.size,
    mimeType: m.mimeType,
    direction: m.direction,
    publishedBy: m.publishedBy,
    publishedAt: m.publishedAt,
  }));
  return { files };
}

export function fetchGroupFile(groupId, fileId) {
  const group = groups.get(groupId);
  if (!group) return { error: 'group-not-found', message: 'group not found' };
  const meta = group.files.get(fileId);
  if (!meta) return { error: 'not-found', message: 'file not found' };
  const blobPath = blobPathFor(groupId, meta.storedName);
  try {
    const st = statSync(blobPath);
    if (!st.isFile()) return { error: 'not-found', message: 'file not found' };
  } catch {
    return { error: 'not-found', message: 'file not found' };
  }
  return {
    id: meta.id,
    name: meta.name,
    size: meta.size,
    mimeType: meta.mimeType,
    direction: meta.direction,
    publishedBy: meta.publishedBy,
    publishedAt: meta.publishedAt,
    storedName: meta.storedName,
    blobPath,
    sandboxPath: sandboxPathFor(meta.storedName),
  };
}

export function deleteGroupFile(groupId, fileId) {
  const group = groups.get(groupId);
  if (!group) return { error: 'group-not-found', message: 'group not found' };
  const meta = group.files.get(fileId);
  if (!meta) return { error: 'not-found', message: 'file not found' };
  const blobPath = blobPathFor(groupId, meta.storedName);
  try { unlinkSync(blobPath); } catch { /* best effort */ }
  group.files.delete(fileId);
  persistGroupFiles();
  return { ok: true };
}

// Browser upload: data is a Buffer, name is the original filename.
export function publishGroupFilesFromUpload(groupId, files, publishedBy = null) {
  const group = groups.get(groupId);
  if (!group) return { error: 'group-not-found', message: 'group not found' };
  if (!Array.isArray(files) || files.length === 0) {
    return { error: 'bad-request', message: 'no files provided' };
  }
  // Pre-check quotas atomically for the batch.
  let batchBytes = 0;
  for (const f of files) batchBytes += f.data ? f.data.length : 0;
  // Check count: batch size must not exceed per-group limit alone, nor with existing.
  if (files.length > MAX_FILES_PER_GROUP || group.files.size + files.length > MAX_FILES_PER_GROUP) {
    return { error: 'too-many-files', message: `group already has the maximum of ${MAX_FILES_PER_GROUP} files` };
  }
  const total = [...group.files.values()].reduce((s, m) => s + m.size, 0);
  if (total + batchBytes > MAX_GROUP_BYTES) {
    return { error: 'quota-exceeded', message: `group storage quota exceeded (${MAX_GROUP_BYTES} bytes)` };
  }
  for (const f of files) {
    const sz = f.data ? f.data.length : 0;
    if (sz > MAX_FILE_BYTES) {
      return { error: 'too-large', message: `file ${f.name} exceeds the ${MAX_FILE_BYTES} byte limit (got ${sz} bytes)` };
    }
  }
  const dir = ensureGroupFilesDir(groupId);
  const metas = [];
  for (const f of files) {
    const name = sanitizeDisplayName(f.name);
    const mimeType = f.mimeType || mimeForName(name);
    const size = f.data.length;
    const id = generateFileId();
    const storedName = storedNameForId(id);
    const blobPath = join(dir, storedName);
    // Atomic write: temp file then rename.
    const tmpPath = join(dir, `.tmp-${storedName}`);
    try {
      writeFileSync(tmpPath, f.data);
      renameSync(tmpPath, blobPath);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      return { error: 'internal', message: `failed to store file ${name}: ${err.message}` };
    }
    const meta = {
      id,
      name,
      size,
      mimeType,
      direction: 'user',
      publishedBy: null,
      publishedAt: Date.now(),
      storedName,
    };
    group.files.set(id, meta);
    metas.push({ id, name, size, mimeType, direction: 'user', publishedBy: null, publishedAt: meta.publishedAt });
  }
  persistGroupFiles();
  return { ok: true, files: metas };
}

// Browser upload via staged temp files (streamed route): staged = [{ name, mimeType, tempPath, size }]
// The caller has already streamed each part to tempPath with per-file size cap.
// This function re-validates quotas atomically against current group state,
// then atomically promotes each temp file to its final blob path.
export function commitStagedUploads(groupId, staged) {
  const group = groups.get(groupId);
  if (!group) return { error: 'group-not-found', message: 'group not found' };
  if (!Array.isArray(staged) || staged.length === 0) {
    return { error: 'bad-request', message: 'no files provided' };
  }
  // Atomic quota validation (re-check against live state to handle races).
  let batchBytes = 0;
  for (const f of staged) batchBytes += f.size || 0;
  if (staged.length > MAX_FILES_PER_GROUP || group.files.size + staged.length > MAX_FILES_PER_GROUP) {
    return { error: 'too-many-files', message: `group already has the maximum of ${MAX_FILES_PER_GROUP} files` };
  }
  const total = [...group.files.values()].reduce((s, m) => s + m.size, 0);
  if (total + batchBytes > MAX_GROUP_BYTES) {
    return { error: 'quota-exceeded', message: `group storage quota exceeded (${MAX_GROUP_BYTES} bytes)` };
  }
  for (const f of staged) {
    if ((f.size || 0) > MAX_FILE_BYTES) {
      return { error: 'too-large', message: `file ${f.name} exceeds the ${MAX_FILE_BYTES} byte limit (got ${f.size} bytes)` };
    }
  }
  const dir = ensureGroupFilesDir(groupId);
  // Prepare all metadata first; do not mutate group.files until every rename succeeds.
  const entries = staged.map((f) => {
    const name = sanitizeDisplayName(f.name);
    const mimeType = f.mimeType || mimeForName(name);
    const size = f.size;
    const id = generateFileId();
    const storedName = storedNameForId(id);
    const blobPath = join(dir, storedName);
    return { f, name, mimeType, size, id, storedName, blobPath };
  });
  const promoted = [];
  try {
    for (const e of entries) {
      commitRenameSyncImpl(e.f.tempPath, e.blobPath);
      promoted.push(e);
    }
  } catch (err) {
    // Roll back any blobs already promoted and clean up all staged temps.
    for (const e of promoted) {
      try { unlinkSync(e.blobPath); } catch { /* ignore */ }
    }
    for (const e of entries) {
      try { unlinkSync(e.f.tempPath); } catch { /* already moved or already cleaned */ }
    }
    const failed = entries[promoted.length];
    const failedName = failed ? failed.name : 'file';
    return { error: 'internal', message: `failed to store file ${failedName}: ${err.message}` };
  }
  // All renames succeeded — now mutate in-memory map and persist atomically.
  const metas = [];
  for (const e of entries) {
    const meta = {
      id: e.id,
      name: e.name,
      size: e.size,
      mimeType: e.mimeType,
      direction: 'user',
      publishedBy: null,
      publishedAt: Date.now(),
      storedName: e.storedName,
    };
    group.files.set(e.id, meta);
    metas.push({ id: e.id, name: e.name, size: e.size, mimeType: e.mimeType, direction: 'user', publishedBy: null, publishedAt: meta.publishedAt });
  }
  persistGroupFiles();
  return { ok: true, files: metas };
}

// Agent publish: relative path inside the agent's own worktree.
// Uses O_NOFOLLOW + fstat + descriptor-based copy to avoid TOCTOU where a
// validated pathname is reopened after a symlink/size swap.
export function publishGroupFileFromAgent(groupId, role, relativePath) {
  const group = groups.get(groupId);
  if (!group) return { error: 'group-not-found', message: 'group not found' };
  const sessionId = group.members.get(role);
  const session = sessionId ? sessionApi.getSession(sessionId) : null;
  const cwd = session?.cwd || group.memberSaved.get(role)?.cwd || null;
  if (!cwd) return { error: 'bad-request', message: 'agent worktree not found' };

  // Basic syntax checks (mirrors resolveAgentSourcePath early gates).
  if (typeof relativePath !== 'string' || !relativePath || relativePath.startsWith('/') || relativePath.includes('\0')) {
    return { error: 'bad-request', message: 'path must be relative and not absolute' };
  }
  const joined = join(cwd, relativePath);
  const resolved = resolve(joined);
  const cwdResolved = resolve(cwd);
  if (resolved !== cwdResolved && !resolved.startsWith(cwdResolved + '/')) {
    return { error: 'bad-request', message: 'path escapes the worktree' };
  }
  let realCwd;
  try {
    realCwd = realpathSync(cwdResolved);
  } catch {
    return { error: 'bad-request', message: 'worktree not found' };
  }
  // Pre-check: ensure the target exists and is not an obvious symlink escape.
  // This is not authoritative for TOCTOU; the descriptor open below is.
  let preReal;
  try {
    preReal = realpathSync(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') return { error: 'not-found', message: 'file not found' };
    return { error: 'bad-request', message: `cannot resolve path: ${err.message}` };
  }
  if (preReal !== realCwd && !preReal.startsWith(realCwd + '/')) {
    return { error: 'bad-request', message: 'path escapes the worktree (symlink)' };
  }
  let preStat;
  try {
    preStat = statSync(preReal);
  } catch {
    return { error: 'not-found', message: 'file not found' };
  }
  if (!preStat.isFile()) {
    return { error: 'bad-request', message: 'not a regular file' };
  }

  // Test hook for TOCTOU regression: allows a test to swap the final component
  // to a symlink or mutate the file between validation and open.
  if (agentPublishHook) {
    try { agentPublishHook({ cwd, relativePath, resolved, realCwd, preReal }); } catch { /* ignore hook errors */ }
  }

  const O_RDONLY = fsConstants.O_RDONLY;
  const O_NOFOLLOW = fsConstants.O_NOFOLLOW || 0;
  const O_WRONLY = fsConstants.O_WRONLY;
  const O_CREAT = fsConstants.O_CREAT;
  const O_EXCL = fsConstants.O_EXCL;

  let srcFd = null;
  let tmpFd = null;
  let tmpPath = null;
  let blobPath = null;
  let dir = null;
  let name = null;
  let mimeType = null;
  let id = null;
  let storedName = null;
  let actualSize = null;

  try {
    // Open with O_NOFOLLOW so a swapped-in symlink fails with ELOOP.
    srcFd = openSync(resolved, O_RDONLY | O_NOFOLLOW);
    const st = fstatSync(srcFd);
    if (!st.isFile()) {
      throw Object.assign(new Error('not a regular file'), { code: 'EBADFD' });
    }
    actualSize = st.size;
    if (actualSize > MAX_FILE_BYTES) {
      try { closeSync(srcFd); } catch {}
      srcFd = null;
      return { error: 'too-large', message: `file exceeds the ${MAX_FILE_BYTES} byte limit (got ${actualSize} bytes)` };
    }

    // Containment check via /proc/self/fd symlink (Linux). If unavailable, fall back to pre-check.
    try {
      const link = readlinkSync(`/proc/self/fd/${srcFd}`);
      let p = link;
      if (p.endsWith(' (deleted)')) p = p.slice(0, -10);
      if (p.startsWith('/')) {
        let fdReal;
        try { fdReal = realpathSync(p); } catch { fdReal = p; }
        if (fdReal !== realCwd && !fdReal.startsWith(realCwd + '/')) {
          throw Object.assign(new Error('path escapes the worktree (symlink)'), { code: 'ESYMLNK' });
        }
      }
    } catch (e) {
      if (e && (e.code === 'ESYMLNK' || e.message.includes('escapes'))) throw e;
      // ignore readlink failures (non-Linux, etc.) — pre-check already covered
    }

    const quotaErr = checkQuotaBeforeAdd(group.files, actualSize);
    if (quotaErr) {
      try { closeSync(srcFd); } catch {}
      srcFd = null;
      return quotaErr;
    }

    dir = ensureGroupFilesDir(groupId);
    name = sanitizeDisplayName(basename(relativePath));
    mimeType = mimeForName(name);
    id = generateFileId();
    storedName = storedNameForId(id);
    blobPath = join(dir, storedName);
    tmpPath = join(dir, `.tmp-${storedName}`);

    tmpFd = openSync(tmpPath, O_WRONLY | O_CREAT | O_EXCL, 0o600);

    // Copy from descriptor, not pathname, so a swapped symlink cannot be followed.
    const buf = Buffer.alloc(64 * 1024);
    let bytesRead;
    while ((bytesRead = readSync(srcFd, buf, 0, buf.length, null)) !== 0) {
      let written = 0;
      while (written < bytesRead) {
        written += writeSync(tmpFd, buf, written, bytesRead - written);
      }
    }

    // Close src early; keep tmpFd open until we validate size.
    try { closeSync(srcFd); } catch {}
    srcFd = null;

    try { closeSync(tmpFd); } catch {}
    tmpFd = null;

    // Validate completed temp blob size before promotion.
    const tmpSt = statSync(tmpPath);
    if (!tmpSt.isFile()) throw new Error('not a regular file');
    if (tmpSt.size !== actualSize) throw new Error(`size mismatch after copy (expected ${actualSize}, got ${tmpSt.size})`);
    if (tmpSt.size > MAX_FILE_BYTES) throw new Error(`file exceeds the ${MAX_FILE_BYTES} byte limit`);

    renameSync(tmpPath, blobPath);
    tmpPath = null; // promoted
  } catch (err) {
    if (srcFd !== null) { try { closeSync(srcFd); } catch {} }
    if (tmpFd !== null) { try { closeSync(tmpFd); } catch {} }
    if (tmpPath) { try { unlinkSync(tmpPath); } catch {} }
    if (err && err.code === 'ELOOP') {
      return { error: 'bad-request', message: 'path escapes the worktree (symlink)' };
    }
    if (err && err.code === 'ESYMLNK') {
      return { error: 'bad-request', message: 'path escapes the worktree (symlink)' };
    }
    if (err && err.code === 'EBADFD') {
      return { error: 'bad-request', message: 'not a regular file' };
    }
    // Preserve quota/too-large already returned above; other errors are internal.
    if (err && err.message && err.message.includes('escapes')) {
      return { error: 'bad-request', message: err.message };
    }
    return { error: 'internal', message: `failed to publish file: ${err.message}` };
  }

  const meta = {
    id,
    name,
    size: actualSize,
    mimeType,
    direction: 'agent',
    publishedBy: role,
    publishedAt: Date.now(),
    storedName,
  };
  group.files.set(id, meta);
  persistGroupFiles();
  return { ok: true, id, name, size: meta.size, mimeType, direction: 'agent', publishedBy: role, publishedAt: meta.publishedAt };
}

function persistGroupFiles() {
  try {
    const out = {};
    for (const g of groups.values()) {
      if (g.files.size === 0) continue;
      out[g.id] = Object.fromEntries([...g.files]);
    }
    const tmp = GROUP_FILES_PATH + '.tmp';
    if (Object.keys(out).length > 0) {
      writeFileSync(tmp, JSON.stringify(out));
      renameSync(tmp, GROUP_FILES_PATH);
    } else {
      try { unlinkSync(GROUP_FILES_PATH); } catch { /* nothing to remove */ }
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  } catch {
    // best effort
  }
}

export function getGroupFilesDirForGroup(groupId) {
  return getGroupFilesDir(groupId);
}

// --- session-exit / session-create observation (no import cycle: sessionManager
// never imports this module; we subscribe via the listener setters) ----------

// Exporting for tests: groupManager.test.js drives the assembly-race path
// directly (no real pty available to trigger the listener organically).
export function onSessionExit(session) {
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
  // brokers are already stopped, so this just drops the Map entry. Groups
  // still being assembled are exempt: their members are registered one by
  // one, so "no live members" is expected mid-flight (see `assembling`).
  const liveCount = [...group.members.values()].some((sid) => {
    const s = sessionApi.getSession(sid);
    return s && !s.exited;
  });
  if (!group.assembling && !liveCount) destroyGroup(session.groupId);
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
// namespace's internals / keeps tool deps explicit). This IS the shape the
// production MCP tools receive -- keep it in sync with what mcpTools.js
// calls: a function used by a tool but missing here fails in production
// (TypeError) while the full-module tests stay green. Every tool added to
// mcpServer/mcpTools must have its backing groupManager function in this
// facade, and tests must inject this facade (getGroupManagerApi), not the
// full module.
// Deliberately NOT in this facade: getGroup (the raw group object carries
// controlBroker socket paths, handoff channels, the handoff queue and
// allowedCwds -- internals LLM-facing tools must never reach; repo_info
// needs only the project dir, which getGroupCwd provides).
const groupManagerApi = {
  listGroupMembers,
  isSessionInGroup,
  getRoleForSession,
  getGroupCwd,
  setCurrentTurn,
  pushHandoff,
  takeHandoff,
  addMember,
  removeMember,
  getOrchestratorSandboxOpts,
  getRegisteredMemberSandboxOpts,
  publishGroupDoc,
  fetchGroupDoc,
  listGroupDocs,
  deleteGroupDoc,
  listGroupFiles,
  fetchGroupFile,
  deleteGroupFile,
  publishGroupFileFromAgent,
  publishGroupFilesFromUpload,
  commitStagedUploads,
  getGroupFilesDirForGroup,
  // Meta-agent extensions (see ws/metaAgent.js): the meta broker is a
  // process-global PRIVILEGED socket, so its facade legitimately spans every
  // group -- unlike the per-group control server above, which must never see
  // beyond its own groupId. getGroupSummary (not raw getGroup) keeps
  // orchestratorDir/allowedCwds out of LLM reach even here.
  listGroups,
  getGroupSummary,
  destroyGroup,
};

// Test seam: returns the exact facade the broker servers receive. Unit tests
// must inject this -- never the full module -- so a facade/real mismatch
// (a missing function) is caught by the tests, not only in production.
export function getGroupManagerApi() {
  return groupManagerApi;
}

// Session-manager facade. A `let` so tests can swap in fakes (see
// setSessionApiForTests) to exercise addMember's spawn/teardown paths without
// real ptys. All references go through this binding (function bodies only),
// so the swap takes effect on the next call.
const defaultSessionApi = {
  getSession,
  destroySession,
  createSession,
  writeToSession,
  waitUntilSettled,
  dockerAvailability,
};
let sessionApi = defaultSessionApi;

// Test seam: replace the session facade (or pass null/undefined to restore
// the real one). Never called outside tests.
export function setSessionApiForTests(api) {
  sessionApi = api || defaultSessionApi;
}

setSessionExitListener(onSessionExit);
setSessionCreateListener(onSessionCreate);
setMcpSocketResolver(resolveGroupMcpSocket);
setOrchestratorClaudeMdResolver(generateOrchestratorClaudeMdSrc);
setMemberCwdResolver(resolveMemberLaunchCwd);
