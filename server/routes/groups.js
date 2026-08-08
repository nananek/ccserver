// Combo launch: create/inspect/destroy a group of sessions (2 workers + 1
// orchestrator) sharing a project directory. Sessions are created server-side
// via the normal createSession() path (they are NOT a third app kind -- just
// sessions with groupId/groupRole set); the browser then attaches to all
// three over the regular WS attach flow.
//
// The orchestrator runs in its own isolated directory (orchestratorDir) with
// only CLAUDE.md/AGENTS.md, in a mandatory sandbox, with zero visibility of
// the project tree. Its only reach into the workers is the control MCP server
// socket (see mcpBroker.js / mcpTools.js).

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as groupManager from '../ws/groupManager.js';
import { createSession } from '../ws/sessionManager.js';
import { sandboxAvailable } from '../ws/sandbox.js';
import { isValidApp } from '../ws/appLaunch.js';

const ORCHESTRATOR_ROOT = join(homedir(), '.local', 'share', 'ccserver-sandbox', 'orchestrator');

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

You never have direct file access to the workers' project: all interaction
goes through these tools. You are only in the loop when a worker hands off
to you -- that is the intended division of labor.
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

export async function groupsRoute(fastify, opts) {
  fastify.post('/groups', async (request, reply) => {
    const body = request.body || {};
    const { cwd } = body;

    if (!validCwd(cwd)) {
      return reply.code(400).send({ error: 'cwd must be an existing directory (not /)' });
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
    const orchestratorDir = join(ORCHESTRATOR_ROOT, groupId);
    try {
      mkdirSync(orchestratorDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      return reply.code(500).send({ error: `Failed to create orchestrator dir: ${err.message}` });
    }

    const instructions = (body.orchestrator && typeof body.orchestrator.instructions === 'string'
      && body.orchestrator.instructions.trim())
      ? body.orchestrator.instructions
      : DEFAULT_ORCHESTRATOR_TEMPLATE;
    // Both files: opencode prefers AGENTS.md and falls back to CLAUDE.md;
    // claude reads CLAUDE.md. Same content either way.
    try {
      writeFileSync(join(orchestratorDir, 'CLAUDE.md'), instructions);
      writeFileSync(join(orchestratorDir, 'AGENTS.md'), instructions);
    } catch (err) {
      return reply.code(500).send({ error: `Failed to write orchestrator instructions: ${err.message}` });
    }

    groupManager.createGroup({ groupId, cwd, orchestratorDir });
    const controlBroker = groupManager.getGroup(groupId).controlBroker;

    // Roll back cleanly if any of the three spawns fails.
    const spawned = [];
    const fail = (message) => {
      groupManager.destroyGroup(groupId);
      return reply.code(400).send({ error: message });
    };

    for (const [role, app] of [['workerA', workerAApp], ['workerB', workerBApp]]) {
      const channel = groupManager.createMemberHandoffChannel(groupId, role);
      const res = createSession({
        cwd,
        cols: 80,
        rows: 24,
        sandbox: true,
        sandboxOpts,
        app,
        groupId,
        groupRole: role,
        mcpSocketPath: channel ? channel.sockPath : null,
      });
      if (res.error || !res.session) {
        return fail(`worker ${role} failed to launch: ${res.error || 'unknown error'}`);
      }
      groupManager.registerMember(groupId, role, res.sessionId);
      spawned.push(res.sessionId);
    }

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
    });
    if (orchRes.error || !orchRes.session) {
      return fail(`orchestrator failed to launch: ${orchRes.error || 'unknown error'}`);
    }
    groupManager.registerMember(groupId, 'orchestrator', orchRes.sessionId);
    spawned.push(orchRes.sessionId);

    fastify.log.info(`[groups] ${groupId} launched at ${cwd} (workers ${workerAApp}/${workerBApp}, orchestrator ${orchApp})`);
    return {
      groupId,
      cwd,
      members: groupManager.listGroupMembers(groupId),
    };
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
      controlBrokerSockPath: group.controlBroker ? group.controlBroker.sockPath : null,
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
