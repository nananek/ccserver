// Combo launch: create/inspect/destroy a group of sessions (2 workers + 1
// orchestrator) sharing a project directory. Sessions are created server-side
// via the normal createSession() path (they are NOT a third app kind -- just
// sessions with groupId/groupRole set); the browser then attaches to all
// three over the regular WS attach flow.
//
// The orchestrator runs in its own isolated directory (orchestratorDir) with
// only CLAUDE.md/AGENTS.md, in a mandatory sandbox. Its reach into the workers
// is the control MCP server socket (see mcpBroker.js / mcpTools.js) plus each
// worker's project directory mounted READ-ONLY at /workers/<role> -- basic
// facts (README, file listing, git log) are directly readable there, but
// nothing is writable. See DEFAULT_ORCHESTRATOR_TEMPLATE below.
//
// orchestratorDir is deterministic per project (hashed from the resolved cwd),
// so the orchestrator's CLAUDE.md/AGENTS.md edits survive group launches and
// server restarts for the same project. Concurrent groups for one cwd are
// refused at creation time, so at most one live group ever owns a dir at once.

import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import * as groupManager from '../ws/groupManager.js';
import { createSession, getSession } from '../ws/sessionManager.js';
import { sandboxAvailable } from '../ws/sandbox.js';
import { isValidApp } from '../ws/appLaunch.js';

const ORCHESTRATOR_ROOT = join(homedir(), '.local', 'share', 'ccserver-sandbox', 'orchestrator');

// The orchestrator dir is derived deterministically from the project path
// (not the random groupId), so the orchestrator's CLAUDE.md/AGENTS.md edits
// survive the group being destroyed and a new group launching for the same
// project. resolve() normalizes spelling variants (trailing slash, "..", ...)
// so they all map to the same dir. 24 hex chars (96 bits) of the sha256 is
// plenty of collision headroom for a handful of projects.
export function orchestratorDirForCwd(cwd) {
  const hash = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 24);
  return join(ORCHESTRATOR_ROOT, hash);
}

// Pure duplicate-project detection for POST /groups: two groups for the same
// project would share one orchestratorDir, cross-talking through resumeLast
// and fighting over CLAUDE.md. `groups` is a listGroups() listing; resolve()
// keeps cwd spelling variants from slipping past the check. Exposed for tests.
export function groupExistsForCwd(cwd, groups) {
  const target = resolve(cwd);
  return groups.find((g) => resolve(g.cwd) === target) || null;
}

// A starting text for the orchestrator's CLAUDE.md/AGENTS.md -- nothing more.
// ccserver holds NO opinion on workflows: this is a scratch template the user
// edits in the launch modal (or later, directly in the orchestrator's
// CLAUDE.md). It is never parsed or branched on.
const DEFAULT_ORCHESTRATOR_TEMPLATE = `# Orchestrator

You orchestrate the two worker agents in this group (workerA / workerB) via
the MCP server "ccserver" that is already configured in this session.

Each worker is a full terminal session you can inspect and control:

- list_group_sessions -- see the members of this group.
- read_output -- read a member's recent terminal output (fallback for
  inspecting a stuck member; avoid polling it).
- send_input -- type text into a member's terminal (submit defaults to true).
- open_tab / close_tab -- add or terminate worker sessions.
- get_tab_status -- quick status of a member.

Recommended turn pattern (keeps your context small):

1. send_input to a worker with the next step.
2. Call wait_for_handoff once and await the result.
3. The worker calls handoff_to_orchestrator when its task is done, blocked,
   or needs input -- wait_for_handoff returns that structured summary.
4. Decide the next action from the summary alone; only read_output when
   something looks stuck.

Your own sandbox has each worker's project directory mounted **read-only**
at /workers/workerA and /workers/workerB -- basic facts (README, file
listing, git log, etc.) are directly readable there, so you don't need to
ask a worker just to see what's already in its checkout. This does not
change how you actually work with them, though: the mount is read-only (you
cannot edit anything there), and everything that requires a worker to think
or act -- running commands, writing code, deciding what to do next -- still
goes exclusively through the tools below. You are only in the loop when a
worker hands off to you -- that is the intended division of labor. Note: a
worker opened via open_tab after your own session started will not appear
under /workers/<role> until you are restarted (the mount is fixed at your
own sandbox's startup).

## Division of labor

- workerA (claude): writes the implementation plan (placed under \`./tmp/\`
  in the worker's repo) and creates the working branch. After workerB's
  self-review stage passes, workerA does the final diff review, pushes, and
  opens the PR.
- workerB (opencode): implements and commits against workerA's plan, then
  runs its own self-review stage (below) before handing off for final
  review.

## Self-review stage (after opencode reports implementation done)

Do not hand a freshly implemented change straight to workerA (claude) for
review -- that makes claude do all the quality gatekeeping. Instead, make
opencode raise the quality bar on its own first:

1. When workerB (opencode) hands off reporting the implementation done,
   send \`/new\` to workerB to start a fresh session (a clean context avoids
   the bias of reviewing its own just-written reasoning).
2. In that new session, have it review the diff it just produced against:
   plan compliance, correctness/bugs, and unnecessary complexity/verbosity.
3. If it finds issues, have it fix and commit them, then repeat from step 1.
4. Cap this loop at 3 rounds. If issues remain after 3 rounds, hand off to
   workerA (claude) anyway with the outstanding issues noted, rather than
   looping forever.
5. Once the self-review comes back clean (or the cap is hit), hand off to
   workerA (claude) for the final review -> push -> PR stage.

## Handoff discipline

Confirmed in practice, not just a theoretical risk: a worker can finish its
task, sit idle at a clean prompt, and never call \`handoff_to_orchestrator\`
on its own -- even when the instruction you sent explicitly said to hand
off when done. \`wait_for_handoff\` then blocks forever with no notification,
because the tool only returns when the worker actually calls it. Do not
rely on a human manually nudging it in the worker's terminal -- the
orchestrator should catch this itself.

- Every instruction sent via \`send_input\` MUST end with an explicit
  reminder to call \`handoff_to_orchestrator\` once done, blocked, or in
  need of input.
- After sending a step, don't just trust \`wait_for_handoff\` to eventually
  notify you -- it only returns once the worker actually calls the tool,
  and nothing forces that to happen. When you get any other opportunity to
  act (a new user message, another worker's handoff, etc.) while one is
  still pending, spend one \`read_output\` call checking whether it's
  sitting at an idle/finished prompt without having handed off; if so,
  nudge it via \`send_input\` ("done? call handoff_to_orchestrator"). Don't
  invent a polling loop (e.g. \`ScheduleWakeup\`) just to check sooner --
  that mechanism belongs to the \`/loop\` skill, not ad hoc waiting here.
`;

function validCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd === '/') return false;
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

function appFromBody(spec, fallback) {
  if (spec && typeof spec === 'object' && typeof spec.app === 'string') {
    return isValidApp(spec.app) ? spec.app : null;
  }
  return fallback;
}

// Session options for the orchestrator-restart route. Extracted (and pure)
// so the resume policy is unit-testable: the restart always continues the
// group's most recent orchestrator conversation (orchestratorDir is exclusive
// to the project (cwd); concurrent groups for the same project are refused at
// creation time, so at most one live group ever owns it at a time --
// `resumeLast` maps 1:1 onto "the previous conversation").
export function orchestratorRestartSessionOpts({ group, app, mcpSocketPath, roBinds = [] }) {
  return {
    cwd: group.orchestratorDir,
    cols: 80,
    rows: 24,
    sandbox: true,
    sandboxOpts: null,
    app,
    resumeLast: true,
    groupId: group.id,
    groupRole: 'orchestrator',
    mcpSocketPath,
    roBinds,
  };
}

export async function groupsRoute(fastify, opts) {
  fastify.post('/groups', async (request, reply) => {
    const body = request.body || {};
    const { cwd } = body;

    if (!validCwd(cwd)) {
      return reply.code(400).send({ error: 'cwd must be an existing directory (not /)' });
    }
    // The orchestrator dir is derived from cwd, so a second group for the same
    // project would share it (cross-talk through resumeLast, CLAUDE.md fights).
    // Refuse up front -- live or closed -- and point at the existing group.
    const existingGroup = groupExistsForCwd(cwd, groupManager.listGroups());
    if (existingGroup) {
      return reply.code(409).send({
        error: existingGroup.liveCount > 0
          ? `a group is already running for this project (${existingGroup.groupId}); use it instead of creating a new one`
          : `a group already exists for this project (${existingGroup.groupId}, currently closed); reopen it instead of creating a new one`,
      });
    }
    if (!sandboxAvailable()) {
      return reply.code(400).send({ error: 'combo launch requires the sandbox (bwrap not found on this host)' });
    }

    const workerAApp = appFromBody(body.workerA, 'claude');
    const workerBApp = appFromBody(body.workerB, 'claude');
    const orchApp = appFromBody(body.orchestrator, 'claude');
    if (!workerAApp || !workerBApp || !orchApp) {
      return reply.code(400).send({ error: 'workerA/workerB/orchestrator app must be claude or opencode' });
    }
    const sandboxOpts = (body.sandboxOpts && typeof body.sandboxOpts === 'object')
      ? { gpg: !!body.sandboxOpts.gpg, sshAgent: !!body.sandboxOpts.sshAgent }
      : null;

    const groupId = randomUUID();
    const orchestratorDir = orchestratorDirForCwd(cwd);
    // Only a dir this request created is cleaned up on failure or overwritten
    // with the default template: a reused dir holds the project's accumulated
    // orchestrator notes and must survive a failed launch.
    const dirAlreadyExisted = existsSync(orchestratorDir);
    try {
      mkdirSync(orchestratorDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      return reply.code(500).send({ error: `Failed to create orchestrator dir: ${err.message}` });
    }

    const explicitInstructions = (body.orchestrator && typeof body.orchestrator.instructions === 'string'
      && body.orchestrator.instructions.trim())
      ? body.orchestrator.instructions
      : null;
    // Reusing an existing dir: keep whatever the orchestrator wrote there
    // (CLAUDE.md/AGENTS.md) unless the user explicitly supplied instructions
    // for this launch. A fresh dir gets the default template.
    const instructions = explicitInstructions || (dirAlreadyExisted ? null : DEFAULT_ORCHESTRATOR_TEMPLATE);
    // Both files: opencode prefers AGENTS.md and falls back to CLAUDE.md;
    // claude reads CLAUDE.md. Same content either way.
    if (instructions) {
      try {
        writeFileSync(join(orchestratorDir, 'CLAUDE.md'), instructions);
        writeFileSync(join(orchestratorDir, 'AGENTS.md'), instructions);
      } catch (err) {
        if (!dirAlreadyExisted) { try { rmSync(orchestratorDir, { recursive: true, force: true }); } catch { /* best effort */ } }
        return reply.code(500).send({ error: `Failed to write orchestrator instructions: ${err.message}` });
      }
    }

    // Broker start failures (socket path collision, permission errors, ...)
    // must surface as a launch error, not a silent "success".
    try {
      await groupManager.createGroup({ groupId, cwd, orchestratorDir, sandboxOpts, orchestratorApp: orchApp, instructions });
    } catch (err) {
      if (!dirAlreadyExisted) { try { rmSync(orchestratorDir, { recursive: true, force: true }); } catch { /* best effort */ } }
      return reply.code(500).send({ error: `Failed to start control broker: ${err.message}` });
    }
    const controlBroker = groupManager.getGroup(groupId).controlBroker;

    // Roll back cleanly if any of the three spawns fails.
    const fail = (message) => {
      groupManager.destroyGroup(groupId);
      if (!dirAlreadyExisted) { try { rmSync(orchestratorDir, { recursive: true, force: true }); } catch { /* best effort */ } }
      return reply.code(400).send({ error: message });
    };

    // Workers reuse addMember (the open_tab path) so validation, channel
    // creation, session spawn and registration can't drift between the
    // initial trio and later open_tab additions. Two workers in parallel.
    const workerResults = await Promise.all(
      [['workerA', workerAApp], ['workerB', workerBApp]].map(async ([role, app]) => ({
        role,
        res: await groupManager.addMember(groupId, role, { app, cwd, sandboxOpts }),
      })),
    );
    for (const { role, res } of workerResults) {
      if (res.error) return fail(`worker ${role} failed to launch: ${res.message || res.error}`);
    }

    // Both workers are registered by now (addMember calls registerMember
    // internally), so the orchestrator's ro-mounts can be derived from the
    // live registry: each worker's cwd is mounted read-only at /workers/<role>.
    // resolveWorkerRoBinds re-validates each role against WORKER_ROLE_RE
    // before it becomes a mount destination (defense in depth -- roles can
    // also enter the registry through client-controlled re-init paths).
    const roBinds = groupManager.resolveWorkerRoBinds(groupId, 'orchestrator');

    const orchRes = createSession({
      cwd: orchestratorDir,
      cols: 80,
      rows: 24,
      sandbox: true,
      sandboxOpts: null,
      app: orchApp,
      groupId,
      groupRole: 'orchestrator',
      mcpSocketPath: controlBroker ? controlBroker.sockPath : null,
      roBinds,
    });
    if (orchRes.error || !orchRes.session) {
      return fail(`orchestrator failed to launch: ${orchRes.error || 'unknown error'}`);
    }
    groupManager.registerMember(groupId, 'orchestrator', orchRes.sessionId);
    // Assembly is complete: the group is now subject to the "no live members"
    // auto-destroy in onSessionExit. Before this point a member crash must
    // not tear the half-built group (and its control broker) down.
    groupManager.markGroupAssembled(groupId);

    fastify.log.info(`[groups] ${groupId} launched at ${cwd} (workers ${workerAApp}/${workerBApp}, orchestrator ${orchApp})`);
    return {
      groupId,
      cwd,
      members: groupManager.listGroupMembers(groupId),
      currentTurn: groupManager.getGroup(groupId)?.currentTurn ?? null,
      lastHandoffAt: groupManager.getGroup(groupId)?.lastHandoffAt ?? null,
    };
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
    const app = group.orchestratorApp || orchMember?.app || 'claude';
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

    // Re-validate roles via resolveWorkerRoBinds (WORKER_ROLE_RE) -- the same
    // filter the scheduler path uses, so a crafted role can never become a
    // /workers/<role> mount destination.
    const roBinds = groupManager.resolveWorkerRoBinds(group.id, 'orchestrator');

    const res = createSession(orchestratorRestartSessionOpts({ group, app, mcpSocketPath, roBinds }));
    if (res.error || !res.session) {
      return reply.code(500).send({ error: `orchestrator restart failed: ${res.error || 'unknown error'}` });
    }
    groupManager.registerMember(group.id, 'orchestrator', res.sessionId);
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
