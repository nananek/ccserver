// Combo launch: create/inspect/destroy a group of sessions (2 workers + 1
// orchestrator) sharing a project directory. Sessions are created server-side
// via the normal createSession() path (they are NOT a third app kind -- just
// sessions with groupId/groupRole set); the browser then attaches to all
// three over the regular WS attach flow.
//
// The orchestrator runs in its own isolated directory (orchestratorDir) with
// only CLAUDE.md/AGENTS.md, in a mandatory sandbox. Its reach into the workers
// is the control MCP server socket (see mcpBroker.js / mcpTools.js) -- basic
// project facts are obtained through the repo_info tool, never by direct
// filesystem access. CLAUDE.md/AGENTS.md are generated fresh on every
// (re)spawn from server/ws/orchestrator-template.md plus the group's saved
// custom instructions, then ro-bind mounted over the two files -- see
// groupManager.generateOrchestratorClaudeMdSrc and sandbox.js's
// buildBwrapArgs. The orchestrator (a live LLM reachable through prompt
// injection from worker output) can never persist an edit to its own
// operating rules.
//
// orchestratorDir is deterministic per project (hashed from the resolved cwd),
// so it survives group launches and server restarts for the same project.
// Concurrent groups for one cwd are refused at creation time, so at most one
// live group ever owns a dir at once.

import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import * as groupManager from '../ws/groupManager.js';
import { createSession, getSession } from '../ws/sessionManager.js';
import { sandboxAvailable } from '../ws/sandbox.js';
import { isValidApp } from '../ws/appLaunch.js';
import { projectHashForCwd } from '../ws/projectHash.js';
import { normalizePresetInput } from '../ws/workerPresets.js';

const ORCHESTRATOR_ROOT = join(homedir(), '.local', 'share', 'ccserver-sandbox', 'orchestrator');

// Initial workers per group: MAX_GROUP_MEMBERS includes the orchestrator, so
// the canonical workers[] payload accepts at most that many minus one.
export const MAX_WORKERS = groupManager.MAX_GROUP_MEMBERS - 1;

// The orchestrator dir is derived deterministically from the project path
// (not the random groupId), so it can be reused as the orchestrator's cwd
// (scratch space) across the group being destroyed and a new group launching
// for the same project -- see destroyGroup's comment in groupManager.js.
// CLAUDE.md/AGENTS.md themselves are never persisted here (see the header
// comment above); only the dir itself is reused.
export function orchestratorDirForCwd(cwd) {
  return join(ORCHESTRATOR_ROOT, projectHashForCwd(cwd));
}

// Pure duplicate-project detection for POST /groups: two groups for the same
// project would share one orchestratorDir, cross-talking through resumeLast
// and fighting over CLAUDE.md. `groups` is a listGroups() listing; resolve()
// keeps cwd spelling variants from slipping past the check. Exposed for tests.
export function groupExistsForCwd(cwd, groups) {
  const target = resolve(cwd);
  return groups.find((g) => resolve(g.cwd) === target) || null;
}

function validCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd === '/') return false;
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

function memberSpecFromBody(spec) {
  const source = spec && typeof spec === 'object' ? spec : {};
  const result = {};
  if (Object.prototype.hasOwnProperty.call(source, 'app')) {
    result.app = typeof source.app === 'string' && isValidApp(source.app) ? source.app : null;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'model')) {
    if (source.model !== null && typeof source.model !== 'string') result.model = undefined;
    else result.model = source.model;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'sandboxOpts')) {
    result.sandboxOpts = source.sandboxOpts && typeof source.sandboxOpts === 'object'
      ? { gpg: !!source.sandboxOpts.gpg, sshAgent: !!source.sandboxOpts.sshAgent }
      : null;
  }
  return result;
}

// Canonical initial-member normalization for POST /groups (pure; exported for
// tests).
//
// `workers` present -> the canonical path: a validated snapshot array of
// { name?, role, app?, model?, sandboxOpts? } entries. Validation reuses the
// preset input rules so a preset and its expanded snapshot can never diverge;
// name/app stay optional there (absent -> null -> role label / defaultApp),
// while an explicit copilot or unknown app is refused exactly like here.
//
// `workers` absent -> the legacy adapter: workerA/workerB specs through
// memberSpecFromBody, wrapped as the same two-element shape. Existing
// clients, E2E and external API callers keep working unchanged.
export function normalizeWorkers(body) {
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
  const workersRaw = body?.workers;

  if (workersRaw !== undefined && workersRaw !== null) {
    if (!Array.isArray(workersRaw)) {
      return { error: 'workers must be an array' };
    }
    if (workersRaw.length < 1) {
      return { error: 'workers must contain at least one worker' };
    }
    if (workersRaw.length > MAX_WORKERS) {
      return { error: `too many workers (max ${MAX_WORKERS}; groups are capped at ${groupManager.MAX_GROUP_MEMBERS} members including the orchestrator)` };
    }
    const seen = new Set();
    const out = [];
    for (const [i, raw] of workersRaw.entries()) {
      const src = raw && typeof raw === 'object' ? raw : {};
      const n = normalizePresetInput(src, { allowMissingName: true, allowMissingApp: true });
      if (!n.ok) {
        return { error: `workers[${i}]: ${n.errors.join('; ')}` };
      }
      if (seen.has(n.value.role)) {
        return { error: `duplicate worker role: ${n.value.role}` };
      }
      seen.add(n.value.role);
      const spec = {};
      if (hasOwn(src, 'name')) spec.name = n.value.name;
      if (hasOwn(src, 'app')) spec.app = n.value.app;
      if (hasOwn(src, 'model')) spec.model = n.value.model;
      if (hasOwn(src, 'sandboxOpts')) {
        spec.sandboxOpts = src.sandboxOpts && typeof src.sandboxOpts === 'object'
          ? { gpg: !!src.sandboxOpts.gpg, sshAgent: !!src.sandboxOpts.sshAgent }
          : null;
      }
      out.push({ role: n.value.role, spec });
    }
    return { workers: out };
  }

  // Legacy payload: fixed workerA/workerB tuple, presence-based member specs.
  return {
    workers: [
      { role: 'workerA', spec: memberSpecFromBody(body?.workerA) },
      { role: 'workerB', spec: memberSpecFromBody(body?.workerB) },
    ],
  };
}

// Session options for the orchestrator-restart route. Extracted (and pure)
// so the resume policy is unit-testable: the restart always continues the
// group's most recent orchestrator conversation (orchestratorDir is exclusive
// to the project (cwd); concurrent groups for the same project are refused at
// creation time, so at most one live group ever owns it at a time --
// `resumeLast` maps 1:1 onto "the previous conversation"). projectName is the
// real project's basename: the session's cwd is the hashed orchestratorDir,
// which must not leak into the notify footer (see sessionManager).
export function orchestratorRestartSessionOpts({ group, app, model = null, sandboxOpts = null, mcpSocketPath, orchestratorClaudeMdSrc = null }) {
  return {
    cwd: group.orchestratorDir,
    cols: 80,
    rows: 24,
    sandbox: true,
    sandboxOpts,
    app,
    model,
    resumeLast: true,
    groupId: group.id,
    groupRole: 'orchestrator',
    projectName: group.cwd ? basename(group.cwd) : null,
    mcpSocketPath,
    orchestratorClaudeMdSrc,
  };
}

// Shared combo-launch implementation for POST /groups and the meta agent's
// launch_group tool (plan section 4.3): one body so the HTTP surface and the
// MCP surface can never drift. Takes the SAME canonical payload as the route
// (cwd/workers/orchestrator/instructions/sandboxOpts -- legacy workerA/
// workerB shapes included via normalizeWorkers) and returns result objects:
//   { ok: true, body }   -> the exact JSON the route used to send
//   { ok: false, code, message } with codes 'validation' | 'conflict' |
//   'internal' (the route maps them to 400/409/500).
export async function launchGroupFromSpec(body) {
  const input = body || {};
  const { cwd } = input;

  if (!validCwd(cwd)) {
    return { ok: false, code: 'validation', message: 'cwd must be an existing directory (not /)' };
  }
  // The orchestrator dir is derived from cwd, so a second group for the same
  // project would share it (cross-talk through resumeLast, CLAUDE.md fights).
  // Refuse up front -- live or closed -- and point at the existing group.
  const existingGroup = groupExistsForCwd(cwd, groupManager.listGroups());
  if (existingGroup) {
    return {
      ok: false,
      code: 'conflict',
      message: existingGroup.liveCount > 0
        ? `a group is already running for this project (${existingGroup.groupId}); use it instead of creating a new one`
        : `a group already exists for this project (${existingGroup.groupId}, currently closed); reopen it instead of creating a new one`,
    };
  }
  if (!sandboxAvailable()) {
    return { ok: false, code: 'validation', message: 'combo launch requires the sandbox (bwrap not found on this host)' };
  }

  // Canonical workers[] snapshot or the legacy workerA/workerB adapter --
  // see normalizeWorkers above.
  const workersNorm = normalizeWorkers(input);
  if (workersNorm.error) {
    return { ok: false, code: 'validation', message: workersNorm.error };
  }
  const { workers } = workersNorm;
  const orchestrator = memberSpecFromBody(input.orchestrator);
  // copilot/commandcode have no CLI-arg/env MCP injection (config-file only
  // / unverified), so combo members can never use the group's broker tools --
  // refuse them explicitly here. Codex supports process-scoped -c MCP
  // overrides. (The canonical path's whitelist already refused copilot inside
  // normalizeWorkers; this also covers the legacy specs' "present but not a
  // known app" shape.)
  const invalidApp = (spec) => Object.prototype.hasOwnProperty.call(spec || {}, 'app')
    && (!spec.app || spec.app === 'copilot' || spec.app === 'commandcode');
  if (workers.some(({ spec }) => invalidApp(spec)) || invalidApp(orchestrator)) {
    // Keep "copilot is not supported in groups" verbatim: the E2E suite
    // matches on that substring for the long-standing contract (see
    // tests/copilot-launch.spec.js).
    return { ok: false, code: 'validation', message: 'worker app must be claude, opencode, or codex (copilot is not supported in groups; commandcode neither)' };
  }
  const badModel = (spec) => Object.prototype.hasOwnProperty.call(spec || {}, 'model') && spec.model === undefined;
  if (workers.some(({ spec }) => badModel(spec)) || badModel(orchestrator)) {
    return { ok: false, code: 'validation', message: 'member model must be a string or null' };
  }
  const sandboxOpts = (input.sandboxOpts && typeof input.sandboxOpts === 'object')
    ? { gpg: !!input.sandboxOpts.gpg, sshAgent: !!input.sandboxOpts.sshAgent }
    : null;

  const groupId = randomUUID();
  const orchestratorDir = orchestratorDirForCwd(cwd);
  // Only a dir this request created is cleaned up on failure: a reused dir
  // is a per-project resource (see the header comment) that must survive a
  // failed launch.
  const dirAlreadyExisted = existsSync(orchestratorDir);
  try {
    mkdirSync(orchestratorDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return { ok: false, code: 'internal', message: `Failed to create orchestrator dir: ${err.message}` };
  }

  const instructions = (input.orchestrator && typeof input.orchestrator.instructions === 'string'
    && input.orchestrator.instructions.trim())
    ? input.orchestrator.instructions
    : null;

  // Broker start failures (socket path collision, permission errors, ...)
  // must surface as a launch error, not a silent "success".
  // memberPrefs are seeded from the launch snapshot itself (role -> name/
  // app/model/sandboxOpts), keyed by the workers' actual roles -- the
  // fixed workerA/workerB pair is just the legacy adapter's two roles.
  try {
    await groupManager.createGroup({
      groupId,
      cwd,
      orchestratorDir,
      sandboxOpts,
      orchestratorApp: orchestrator.app,
      orchestratorModel: orchestrator.model,
      orchestratorSandboxOpts: orchestrator.sandboxOpts ?? null,
      memberPrefs: {
        ...Object.fromEntries(workers.map(({ role, spec }) => [role, spec])),
        orchestrator,
      },
      instructions,
    });
  } catch (err) {
    if (!dirAlreadyExisted) { try { rmSync(orchestratorDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    return { ok: false, code: 'internal', message: `Failed to start control broker: ${err.message}` };
  }
  const controlBroker = groupManager.getGroup(groupId).controlBroker;

  // Roll back cleanly if any of the three spawns fails.
  const fail = (message) => {
    groupManager.destroyGroup(groupId);
    if (!dirAlreadyExisted) { try { rmSync(orchestratorDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    return { ok: false, code: 'validation', message };
  };

  // Merge the template with `instructions` and write the result to the
  // host-only overlay path; sandbox.js ro-binds it over CLAUDE.md/AGENTS.md
  // (see the header comment). Generated only now that the group record
  // exists (group.instructions is what the merge reads).
  let orchestratorClaudeMdSrc;
  try {
    orchestratorClaudeMdSrc = groupManager.generateOrchestratorClaudeMdSrc(groupId);
  } catch (err) {
    return fail(`failed to generate orchestrator instructions: ${err.message}`);
  }
  // A null return (group/orchestratorDir unexpectedly missing) is just as
  // fatal as a thrown error here: launching with orchestratorClaudeMdSrc
  // unset means createSession skips the ro-bind entirely and the
  // orchestrator gets a plain writable CLAUDE.md/AGENTS.md -- silently
  // reopening the self-modification hole this whole mechanism exists to
  // close. Fail closed, matching the auto-resume resolver in
  // sessionManager.js's fireSchedule.
  if (!orchestratorClaudeMdSrc) {
    return fail('failed to generate orchestrator instructions: no CLAUDE.md overlay was produced');
  }

  // Workers reuse addMember (the open_tab path) so validation, channel
  // creation, session spawn and registration can't drift between the
  // initial members and later open_tab additions. All workers in parallel.
  const workerResults = await Promise.all(
    workers.map(async ({ role, spec }) => ({
      role,
      res: await groupManager.addMember(groupId, role, { ...spec, cwd }),
    })),
  );
  for (const { role, res } of workerResults) {
    if (res.error) return fail(`worker ${role} failed to launch: ${res.message || res.error}`);
  }

  const orchRes = createSession({
    cwd: orchestratorDir,
    cols: 80,
    rows: 24,
    sandbox: true,
    sandboxOpts: orchestrator.sandboxOpts ?? null,
    // An absent orchestrator app must not fall through to createSession's
    // defaultApp(): a config defaulting to copilot would launch a group
    // member copilot can't run (no MCP injection). claude is the group
    // default.
    app: orchestrator.app || 'claude',
    model: orchestrator.model ?? null,
    groupId,
    groupRole: 'orchestrator',
    // The session's cwd is the hashed orchestratorDir; the notify footer
    // must attribute the orchestrator to the real project instead.
    projectName: basename(cwd),
    mcpSocketPath: controlBroker ? controlBroker.sockPath : null,
    orchestratorClaudeMdSrc,
  });
  if (orchRes.error || !orchRes.session) {
    return fail(`orchestrator failed to launch: ${orchRes.error || 'unknown error'}`);
  }
  groupManager.registerMember(groupId, 'orchestrator', orchRes.sessionId);
  groupManager.setMemberPrefs(groupId, 'orchestrator', {
    app: orchRes.session.app,
    model: orchRes.session.model,
    sandboxOpts: orchestrator.sandboxOpts ?? null,
  });
  // Assembly is complete: the group is now subject to the "no live members"
  // auto-destroy in onSessionExit. Before this point a member crash must
  // not tear the half-built group (and its control broker) down.
  groupManager.markGroupAssembled(groupId);

  return {
    ok: true,
    log: `[groups] ${groupId} launched at ${cwd} (workers ${workers.map(({ role, spec }) => `${role}:${spec.app || 'default'}`).join(', ')}, orchestrator ${orchRes.session.app})`,
    body: {
      groupId,
      cwd,
      members: groupManager.listGroupMembers(groupId),
      currentTurn: groupManager.getGroup(groupId)?.currentTurn ?? null,
      lastHandoffAt: groupManager.getGroup(groupId)?.lastHandoffAt ?? null,
    },
  };
}

const STATUS_FOR_CODE = { validation: 400, conflict: 409, internal: 500 };

export async function groupsRoute(fastify, opts) {
  fastify.post('/groups', async (request, reply) => {
    const res = await launchGroupFromSpec(request.body);
    if (!res.ok) {
      return reply.code(STATUS_FOR_CODE[res.code] || 500).send({ error: res.message });
    }
    if (res.log) fastify.log.info(res.log);
    return res.body;
  });

  fastify.get('/groups', async (request, reply) => {
    return { groups: groupManager.listGroups() };
  });

  fastify.get('/groups/:id', async (request, reply) => {
    const group = groupManager.getGroup(request.params.id);
    if (!group) {
      return reply.code(404).send({ error: 'Group not found' });
    }
    return {
      groupId: group.id,
      cwd: group.cwd,
      allowedCwds: [...group.allowedCwds],
      orchestratorDir: group.orchestratorDir,
      members: groupManager.listGroupMembers(group.id),
      currentTurn: group.currentTurn,
      lastHandoffAt: group.lastHandoffAt,
    };
  });

  // Restart a dead orchestrator: recreate the control broker and spawn a new
  // orchestrator session in the group's own directory. Workers stay as they
  // are. 404 when the group is gone; 409 while an orchestrator still lives.
  fastify.post('/groups/:id/orchestrator', async (request, reply) => {
    const group = groupManager.getGroup(request.params.id);
    if (!group) {
      return reply.code(404).send({ error: 'Group not found' });
    }
    const existing = group.members.get('orchestrator');
    if (existing) {
      const s = getSession(existing);
      if (s && !s.exited) {
        return reply.code(409).send({ error: 'orchestrator is still running' });
      }
    }

    // Prefer the persisted launch app; fall back to the restored member's
    // saved app (legacy groups persisted before orchestratorApp existed).
    const orchMember = groupManager.listGroupMembers(request.params.id).find((m) => m.role === 'orchestrator');
    const pref = groupManager.getMemberPrefs(request.params.id, 'orchestrator') || {};
    const app = pref.app || group.orchestratorApp || orchMember?.app || 'claude';
    const model = pref.model ?? orchMember?.model ?? group.orchestratorModel ?? null;
    const sandboxOpts = pref.sandboxOpts ?? orchMember?.sandboxOpts ?? null;
    if (!isValidApp(app)) {
      return reply.code(400).send({ error: 'orchestrator app unavailable for restart' });
    }
    if (!group.orchestratorDir) {
      return reply.code(400).send({ error: 'orchestrator dir missing' });
    }

    const mcpSocketPath = await groupManager.resolveGroupMcpSocket(request.params.id, 'orchestrator');
    if (!mcpSocketPath) {
      return reply.code(500).send({ error: 'failed to re-create the control broker' });
    }

    // Regenerated on every restart (see groupManager.generateOrchestratorClaudeMdSrc):
    // picks up any template edit since the orchestrator's last launch, and
    // always overrides whatever it may have tried to write to the previous
    // (ro-bound) CLAUDE.md/AGENTS.md.
    let orchestratorClaudeMdSrc;
    try {
      orchestratorClaudeMdSrc = groupManager.generateOrchestratorClaudeMdSrc(group.id);
    } catch (err) {
      return reply.code(500).send({ error: `failed to generate orchestrator instructions: ${err.message}` });
    }
    // See the same guard in POST /groups: a null return must not fall
    // through to a restart without the ro-bind overlay.
    if (!orchestratorClaudeMdSrc) {
      return reply.code(500).send({ error: 'failed to generate orchestrator instructions: no CLAUDE.md overlay was produced' });
    }

    const res = createSession(orchestratorRestartSessionOpts({ group, app, model, sandboxOpts, mcpSocketPath, orchestratorClaudeMdSrc }));
    if (res.error || !res.session) {
      // createSession()'s error is always a rejection of the request as given
      // (hiddenApps, not-installed, invalid cwd, ...), never an internal
      // server fault -- matching POST /groups' fail() helper, which maps the
      // identical createSession() rejection to 400, not 500.
      return reply.code(400).send({ error: `orchestrator restart failed: ${res.error || 'unknown error'}` });
    }
    groupManager.registerMember(group.id, 'orchestrator', res.sessionId);
    groupManager.setMemberPrefs(group.id, 'orchestrator', { app, model: res.session.model, sandboxOpts });
    fastify.log.info(`[groups] ${group.id} orchestrator restarted (${app})`);
    return {
      groupId: group.id,
      members: groupManager.listGroupMembers(group.id),
    };
  });

  fastify.delete('/groups/:id', async (request, reply) => {
    const group = groupManager.getGroup(request.params.id);
    if (!group) {
      return reply.code(404).send({ error: 'Group not found' });
    }
    groupManager.destroyGroup(request.params.id);
    return { success: true, groupId: request.params.id };
  });
}
