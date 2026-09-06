// Pure MCP tool implementations for the META agent (ccserver-meta broker).
//
// SECURITY / TRUST MODEL -- READ BEFORE EDITING (plan section 4.2):
// Unlike mcpTools.js, the functions in this file DO take their target
// groupId/sessionId/slug from the WIRE. That is sound only because this
// module is wired to exactly one consumer: the process-global ccserver-meta
// socket (see metaAgent.js / mcpBroker.startMetaBroker), which is bound into
// the single sandbox launched with isMetaAgent:true and nothing else. Never
// register these functions on a group-scoped server.
//
// The per-connection identity frame ({ sessionId, groupId, groupRole, cwd,
// projectName, app } -- CCSERVER_META_IDENTITY via the bridge) arrives as
// deps.identity. It powers ONLY self-reference (the close_session /
// destroy_group self-target guards) and approval attribution
// (requestedBy) -- never an authorization input; the socket binding is the
// boundary.
//
// Conventions:
//   - Every function is pure with respect to imports: all mutable state is
//     reached through `deps` (assembled by ensureMetaAgentBroker), so unit
//     tests can inject fakes without real ptys or sockets.
//   - Results are plain JSON-able objects returned to the LLM verbatim.
//     Failures follow { error: code, message }; store/route results that use
//     the { ok:false, code, message } convention are mapped through unwrap()
//     so every failure reaching the LLM has the same shape. Success payloads
//     pass through verbatim.
//
// STATUS: implemented (all 22 tools). The destructive three follow the fixed
// order self-target guard -> existence/validation -> approvalsApi.
// requestApproval -> execute; a timeout resolves as "do nothing" (plan
// sections 3.1-6/7).

import { capSandboxOpts } from './mcpTools.js';

export { capSandboxOpts };

// ---------------------------------------------------------------------------
// deps (assembled by metaAgent.ensureMetaAgentBroker; tests inject fakes):
//   identity          - { sessionId, groupId, groupRole, cwd, projectName,
//                       app } | null (per-connection identity frame)
//   connectionIsAlive - () => boolean (true while the caller's socket lives)
//   groupManager      - extended facade (getGroupManagerApi() PLUS listGroups,
//                       getGroupSummary(groupId), destroyGroup(groupId))
//   sessionManager    - { listSessions(), getSession(id), destroySession(id),
//                       sandboxHomeInUsePath(homePath) }
//   approvalsApi      - { requestApproval({ kind, summary, payload,
//                       requestedBy }) -> Promise<{ status, approval }>,
//                       APPROVAL_KINDS, APPROVAL_TIMEOUT_MS }
//   projectsApi       - { listProjects(), getProject(id), updateProjectLabel(
//                       id, label), findOrCreateProjectByCwd(cwd),
//                       recordSandboxHome(cwd, { createdBy }) }
//   workerPresetsApi  - { listPresets, getPreset, createPreset, updatePreset,
//                       deletePreset } (workerPresets.js result objects)
//   launchPresetsApi  - { listLaunchPresets, getLaunchPreset,
//                       createLaunchPreset(input), updateLaunchPreset(id,
//                       input), deleteLaunchPreset(id) } -- maxWorkers bound
//                       to groups.js's MAX_WORKERS
//   sandboxApi        - { listSandboxHomes(), sandboxHomeSize(path),
//                       deleteSandboxHome(slug), dindLockHeld(slug),
//                       isSandboxDeleteInFlight(slug), beginSandboxDelete(slug),
//                       endSandboxDelete(slug), sandboxRemnantsExist(slug) }
//   dirsApi           - { browseDirectory(path, showHidden),
//                       createDirectory({ parent, name, gitInit }) }
//   sessionsApi       - { createSessionViaApi(body) }: routes/sessions.js's
//                       shared POST /api/sessions implementation -- the ONLY
//                       sanctioned way to spawn sessions here, so REST and
//                       MCP launches cannot drift
// ---------------------------------------------------------------------------

const MAX_REASON_CHARS = 500;

// Store/route result objects ({ ok, ...payload } / { ok:false, code, message })
// -> success passes through verbatim; failure becomes the uniform tool-layer
// shape { error: code, message }. A failure can still carry a `data` payload
// (e.g. createDirectory's git-init-failed: the directory WAS created) -- the
// REST route forwards that as `path` on the error response, so do the same
// here rather than silently dropping it.
function unwrap(res) {
  if (res && res.ok) return res;
  return {
    error: res?.code || 'internal',
    message: res?.message || 'request failed',
    ...(res?.data ? { data: res.data } : {}),
  };
}

function mySessionId(deps) {
  return deps.identity?.sessionId ?? null;
}

function myGroupId(deps) {
  return deps.identity?.groupId ?? null;
}

// The meta agent's OWN current sandboxOpts grant -- the cap for everything it
// launches (plan sections 4.1 / 6-7). Resolved live from its session record,
// exactly like openTab caps against the orchestrator's current grant.
function mySandboxOpts(deps) {
  const id = mySessionId(deps);
  return (id ? deps.sessionManager.getSession(id)?.sandboxOpts : null) ?? null;
}

function requestedBy(deps) {
  const id = mySessionId(deps);
  return id ? `meta-agent:${id}` : 'meta-agent';
}

// One-line human-readable approval summary: kind + target + reason in a row
// (the browser banner renders this directly). reason is wire-required
// (z.string().min(1)) but direct callers may pass junk -- normalize here too.
function approvalSummary(kind, targetDesc, reason) {
  const r = String(reason ?? '').trim().slice(0, MAX_REASON_CHARS);
  return `${kind}: ${targetDesc} — 理由: ${r || '(理由の記載なし)'}`;
}

// Run one destructive operation through the pending_approvals flow. Never
// executes `act` unless the human approved; infrastructure failures reject
// the promise and are reported WITHOUT executing anything (fail safe).
async function withApproval(deps, { kind, summary, payload }, act) {
  let decision;
  try {
    decision = await deps.approvalsApi.requestApproval({
      kind,
      summary,
      payload,
      requestedBy: mySessionId(deps),
    });
  } catch (err) {
    return { error: 'approval-failed', message: err?.message || 'approval flow failed' };
  }
  if (decision?.status !== 'approved') {
    return decision?.status === 'expired'
      ? { approved: false, expired: true, reason: 'timeout' }
      : { approved: false, reason: 'user-rejected' };
  }
  return act();
}

// --- R (read-only) ----------------------------------------------------------

export function listProjects(deps) {
  return unwrap(deps.projectsApi.listProjects());
}

// routes/sandboxes.js GET's per-row assembly (+ project metadata from the
// DB-backed listSandboxHomes), minus the route-private lastErrors map: a row
// carries deleteError:null here -- in-flight deletions kicked by THIS tool
// complete synchronously before the result returns, and REST-side errors stay
// visible on the settings page where they were raised.
export async function listSandboxes(deps) {
  const homes = deps.sandboxApi.listSandboxHomes();
  const sandboxes = await Promise.all(homes.map(async (h) => ({
    name: h.name,
    path: h.path,
    cwd: h.cwd ?? null,
    projectLabel: h.projectLabel ?? null,
    gitRemote: h.gitRemote ?? null,
    lastUsedAt: h.lastUsedAt ?? null,
    size: await deps.sandboxApi.sandboxHomeSize(h.path),
    inUse: deps.sessionManager.sandboxHomeInUsePath(h.path),
    deleting: deps.sandboxApi.isSandboxDeleteInFlight(h.name),
    deleteError: null,
  })));
  return { sandboxes };
}

export async function browseDirectory(deps, { path, showHidden } = {}) {
  return unwrap(await deps.dirsApi.browseDirectory(path || '/', !!showHidden));
}

export function listGroups(deps) {
  return { groups: deps.groupManager.listGroups() };
}

// getGroupSummary (NOT the raw group object): orchestratorDir/allowedCwds and
// broker internals must not reach any LLM, even this privileged one --
// mirrors GET /groups/:id's projection.
export function getGroup(deps, { groupId } = {}) {
  if (typeof groupId !== 'string' || !groupId) {
    return { error: 'bad-request', message: 'groupId must be a non-empty string' };
  }
  const summary = deps.groupManager.getGroupSummary(groupId);
  if (!summary) return { error: 'not-found', message: 'group not found' };
  return summary;
}

export function listSessions(deps) {
  return { sessions: deps.sessionManager.listSessions() };
}

// Store passthroughs: successes keep the exact objects REST serves
// ({ ok, presets|preset }); failures are mapped by unwrap.

export function listWorkerPresets(deps) {
  return unwrap(deps.workerPresetsApi.listPresets());
}

export function listLaunchPresets(deps) {
  return unwrap(deps.launchPresetsApi.listLaunchPresets());
}

// --- W-low (config CRUD) ----------------------------------------------------

export function createWorkerPreset(deps, args = {}) {
  return unwrap(deps.workerPresetsApi.createPreset(args));
}

export function updateWorkerPreset(deps, { presetId, name, role, app, model } = {}) {
  return unwrap(deps.workerPresetsApi.updatePreset(presetId, {
    name,
    role,
    app,
    ...(model !== undefined ? { model } : {}),
  }));
}

export function deleteWorkerPreset(deps, { presetId } = {}) {
  return unwrap(deps.workerPresetsApi.deletePreset(presetId));
}

export function createLaunchPreset(deps, args = {}) {
  return unwrap(deps.launchPresetsApi.createLaunchPreset(args));
}

export function updateLaunchPreset(deps, { presetId, ...fields } = {}) {
  return unwrap(deps.launchPresetsApi.updateLaunchPreset(presetId, fields));
}

export function deleteLaunchPreset(deps, { presetId } = {}) {
  return unwrap(deps.launchPresetsApi.deleteLaunchPreset(presetId));
}

export function updateProjectLabel(deps, { projectId, label } = {}) {
  return unwrap(deps.projectsApi.updateProjectLabel(projectId, label));
}

export async function createDirectory(deps, args = {}) {
  return unwrap(await deps.dirsApi.createDirectory({
    parent: args.parent,
    name: args.name,
    gitInit: args.gitInit === true,
  }));
}

// --- W-create (resource creation) -------------------------------------------
//
// Every granted sandboxOpts -- the group flags, each worker spec's own, and
// launch_session's -- is capped against the meta agent's OWN current grant
// (capSandboxOpts): a flag the meta agent does not hold is silently
// downgraded to false, never an error (plan sections 4.1 / 6-7).

export async function launchSession(deps, args = {}) {
  const capped = capSandboxOpts(args.sandboxOpts, mySandboxOpts(deps));
  const res = await deps.sessionsApi.createSessionViaApi({
    cwd: args.cwd,
    ...(args.app !== undefined ? { app: args.app } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.sandbox !== undefined ? { sandbox: args.sandbox } : {}),
    ...(capped !== undefined ? { sandboxOpts: capped } : {}),
    // HOME bookkeeping attribution ('meta-agent:<sessionId>').
    requestedBy: requestedBy(deps),
  });
  if (!res.ok) return unwrap(res);
  // res.body carries the EFFECTIVE app/model/sandboxOpts, so the caller can
  // see whether/how sandboxOpts was capped -- same policy as open_tab.
  return res.body;
}

// Build the canonical POST /groups payload with every privilege grant capped.
// Keys must never be present with undefined/null where routes/groups.js keys
// off hasOwnProperty (an explicit null app reads as copilot-refusal there) --
// absent optionals are omitted outright.
export async function launchGroup(deps, args = {}) {
  const cap = mySandboxOpts(deps);
  const body = { cwd: args.cwd };
  if (Array.isArray(args.workers)) {
    body.workers = args.workers.map((w) => (w && typeof w === 'object'
      ? {
        ...w,
        ...(w.sandboxOpts !== undefined
          ? { sandboxOpts: capSandboxOpts(w.sandboxOpts, cap) }
          : {}),
      }
      : w));
  }
  if (args.instructions != null || args.orchestratorApp || args.orchestratorModel != null) {
    // launchGroupFromSpec reads instructions ONLY from input.orchestrator
    // (POST /groups' own shape) -- never put a top-level instructions key.
    body.orchestrator = {};
    if (args.orchestratorApp) body.orchestrator.app = args.orchestratorApp;
    if (args.orchestratorModel != null) body.orchestrator.model = args.orchestratorModel;
    if (args.instructions != null) body.orchestrator.instructions = args.instructions;
  }
  if (args.sandboxOpts !== undefined) {
    body.sandboxOpts = capSandboxOpts(args.sandboxOpts, cap);
  }
  const res = await deps.groupLaunchApi.launchGroupFromSpec(body);
  if (!res.ok) return unwrap(res);
  return res.body;
}

// Snapshot expansion happens NOW (launch time): editing the preset afterwards
// does not affect this group ("the server never re-reads a preset at launch
// time" -- workerPresets.js policy, applied in reverse). Delegates to
// launchGroup so the capping above applies to expanded workers too.
export async function launchFromPreset(deps, { presetId, cwd } = {}) {
  const got = deps.launchPresetsApi.getLaunchPreset(presetId);
  if (!got.ok) return unwrap(got);
  const p = got.preset;
  const workers = (p.workers || []).map((w) => ({
    role: w.role,
    app: w.app,
    ...(w.model != null ? { model: w.model } : {}),
    ...(w.name != null ? { name: w.name } : {}),
    ...(w.sandboxOpts ? { sandboxOpts: w.sandboxOpts } : {}),
  }));
  return launchGroup(deps, {
    cwd,
    workers,
    instructions: p.instructions ?? undefined,
    orchestratorApp: p.orchestratorApp ?? undefined,
    orchestratorModel: p.orchestratorModel ?? undefined,
  });
}

// --- W-destructive (ALWAYS through approvals; self-targets fail closed) -----
//
// Fixed order (plan section 3.1): validation/existence -> SELF-TARGET GUARD
// (immediate refusal, NO approval dialog ever) -> requestApproval -> execute.

export async function closeSession(deps, { sessionId, reason } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) {
    return { error: 'bad-request', message: 'sessionId must be a non-empty string' };
  }
  const session = deps.sessionManager.getSession(sessionId);
  if (!session) return { error: 'not-found', message: 'session not found' };
  if (sessionId === mySessionId(deps)) {
    // Fail closed BEFORE any dialog: the meta agent never asks "may I kill
    // myself?" and can never be terminated through its own channel.
    return { error: 'self-target', message: 'refusing to close your own session (the calling meta agent)' };
  }
  // Plan section 3.1-7: targets inside the caller's OWN group are equally
  // off-limits (normally unreachable -- a standalone meta agent has no
  // groupId -- but it must hold under identity confusion too).
  const ownGroup = myGroupId(deps);
  if (ownGroup && deps.groupManager.isSessionInGroup(ownGroup, sessionId)) {
    return { error: 'self-target', message: 'refusing to close a member of your own group (use destroy_group)' };
  }
  return withApproval(deps, {
    kind: 'close_session',
    summary: approvalSummary(
      'close_session',
      `${sessionId.slice(0, 8)} (${session.app ?? 'shell'}, ${session.cwd}) を強制終了`,
      reason,
    ),
    payload: { sessionId },
  }, () => {
    // Note the two unrelated `reason`s: this tool's own `reason` argument is
    // the agent's free-text justification shown in the approval prompt, while
    // destroySession's is a fixed identifier for the teardown log. The agent's
    // text is deliberately NOT forwarded there -- a free-form string (newlines
    // included) has no business inside a structured log line.
    deps.sessionManager.destroySession(sessionId, { keepSchedule: false, reason: 'meta-agent' });
    return { approved: true, closed: true, sessionId };
  });
}

export async function destroyGroup(deps, { groupId, reason } = {}) {
  if (typeof groupId !== 'string' || !groupId) {
    return { error: 'bad-request', message: 'groupId must be a non-empty string' };
  }
  const summary0 = deps.groupManager.getGroupSummary(groupId);
  if (!summary0) return { error: 'not-found', message: 'group not found' };
  if (myGroupId(deps) && groupId === myGroupId(deps)) {
    return { error: 'self-target', message: 'refusing to destroy the group you belong to (the calling meta agent\'s own group)' };
  }
  return withApproval(deps, {
    kind: 'destroy_group',
    summary: approvalSummary(
      'destroy_group',
      `${groupId.slice(0, 8)} (${summary0.cwd}, メンバー ${summary0.members.length} 人) を破棄`,
      reason,
    ),
    payload: { groupId },
  }, () => {
    deps.groupManager.destroyGroup(groupId);
    return { approved: true, destroyed: true, groupId };
  });
}

// No dedicated self-target guard: if YOUR OWN HOME lives at that slug,
// sandboxHomeInUsePath > 0 refuses it both before and after the approval.
export async function deleteSandbox(deps, { slug, reason } = {}) {
  if (typeof slug !== 'string' || !/^[A-Za-z0-9_]+$/.test(slug)) {
    return { error: 'bad-request', message: 'slug must be a bare sandbox name' };
  }
  const home = deps.sandboxApi.listSandboxHomes().find((h) => h.name === slug);
  if (!home && !deps.sandboxApi.sandboxRemnantsExist(slug)) {
    return { error: 'not-found', message: 'sandbox not found' };
  }
  // Pre-approval guards, fail fast (a pointless dialog is worse than an
  // immediate no): same checks as the DELETE route.
  if (home && deps.sessionManager.sandboxHomeInUsePath(home.path) > 0) {
    return { error: 'in-use', message: 'このサンドボックスを利用中のセッションがあるため削除できません。先にセッションを終了してください。' };
  }
  if (deps.sandboxApi.dindLockHeld(slug)) {
    return { error: 'docker-daemon-in-use', message: 'このサンドボックスの docker デーモンがまだ起動中のため削除できません。' };
  }
  if (deps.sandboxApi.isSandboxDeleteInFlight(slug)) {
    return { error: 'delete-in-progress', message: 'このサンドボックスの削除はすでに進行中です。' };
  }

  const desc = home
    ? `${slug} (${home.cwd ?? 'project 不明'})`
    : `${slug} (残骸のみ -- HOMEは既にありません)`;
  const decision = await withApproval(deps, {
    kind: 'delete_sandbox',
    summary: approvalSummary('delete_sandbox', `${desc} を削除`, reason),
    payload: { slug },
  }, async () => {
    // Re-check after approval (TOCTOU: a session may have mounted the HOME,
    // or a dockerd started, while the dialog was up), mirroring the route's
    // begin/end pattern around the actual removal.
    if (home && deps.sessionManager.sandboxHomeInUsePath(home.path) > 0) {
      return { approved: true, deleted: false, error: 'in-use', message: '承認待ちの間にサンドボックスが使用中になりました。' };
    }
    if (deps.sandboxApi.dindLockHeld(slug)) {
      return { approved: true, deleted: false, error: 'docker-daemon-in-use', message: '承認待ちの間に docker デーモンが起動しました。' };
    }
    if (deps.sandboxApi.isSandboxDeleteInFlight(slug)) {
      return { approved: true, deleted: false, error: 'delete-in-progress', message: '削除がすでに進行中です。' };
    }
    deps.sandboxApi.beginSandboxDelete(slug);
    let res;
    try {
      // Synchronous completion (unlike the backgrounding REST route): the
      // caller learns the final outcome immediately instead of polling.
      res = await deps.sandboxApi.deleteSandboxHome(slug);
    } finally {
      deps.sandboxApi.endSandboxDelete(slug);
    }
    if (!res.ok) {
      return { approved: true, deleted: false, error: 'delete-failed', message: `削除に失敗しました: ${res.error}` };
    }
    return { approved: true, deleted: true, slug };
  });
  return decision;
}
