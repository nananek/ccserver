// Session REST surface: list, terminate, and (new with the meta-agent work)
// CREATE a standalone session over HTTP.
//
// POST /api/sessions exists because the meta agent needs a stateless
// "launch exactly one session" primitive: until now standalone sessions could
// only be created through the browser's WS `init` message, which no headless
// caller can use. The handler body lives in createSessionViaApi() so the meta
// agent's launch_session tool calls the SAME function instead of duplicating
// the validation (REST and MCP launches can never drift).

import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import { createSession, getSession, destroySession, listSessions } from '../ws/sessionManager.js';
import { isValidApp } from '../ws/appLaunch.js';

export async function sessionsRoute(fastify, opts) {
  fastify.get('/sessions', async (request, reply) => {
    const activeSessions = listSessions();
    return { sessions: activeSessions };
  });

  fastify.post('/sessions', async (request, reply) => {
    const res = await createSessionViaApi(request.body || {});
    if (!res.ok) {
      const status = res.code === 'validation' ? 400 : 500;
      return reply.code(status).send({ error: res.message });
    }
    return res.body;
  });

  fastify.delete('/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    const session = getSession(id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    // Explicit teardown: also cancel any scheduled prompt for this session.
    destroySession(id, { keepSchedule: false });
    return { success: true, id };
  });

  if (process.env.CCSERVER_DEBUG) {
    fastify.get('/sessions/:id/buffer', async (request, reply) => {
      const { id } = request.params;
      const session = getSession(id);
      if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
      const raw = session.outputBuffer.slice(-20).join('');
      return { raw: raw.slice(-5000), stripped: stripAnsi(raw).slice(-5000) };
    });
  }
}

// Shared implementation for POST /api/sessions, the meta agent's
// launch_session tool, and the federation "sessions.create" RPC. body:
//   { cwd?, app?, model?, permissionMode?, shell?, sandbox?, sandboxOpts?,
//     resume?, reuseSandboxHome?, isMetaAgent?, requestedBy? }
// `permissionMode` ('standard' | 'auto-accept' | 'yolo', default 'standard')
// selects the commandcode permission-bypass flag (--auto-accept / --yolo);
// any other value is coerced to 'standard' downstream, and other apps ignore
// it entirely.
// `cwd` is required for normal launches, but when `isMetaAgent:true` it is
// optional/ignored: createSession forces the fixed meta-agent directory
// server-side (see sessionManager.createSession), so a client-supplied cwd
// (even a missing/non-existent one) is never used.
//
// `isReviewJob` (2nd param) is DELIBERATELY not part of `body`. It forces
// reviewer MCP injection regardless of the live reviewerMcp config (see
// sessionManager.js's useReviewer comment) -- a real privilege bypass, unlike
// every field actually read from `body` (isMetaAgent included: it is inert
// unless the metaAgentMcp config AND the broker are both already on). Every
// caller of this function forwards a network- or IPC-facing request body more
// or less as-is (REST route above, metaTools.launchSession, federationServer
// .js's rpcSessionsCreate) -- if isReviewJob were just another body key, each
// of those boundaries would have to remember to strip it, and missing even
// one (as the federation RPC did) hands a remote peer an MCP injection it was
// never meant to have. Keeping it a separate parameter that only an
// in-process caller can pass (reviewer.js's runReview -- the ONLY legitimate
// setter) makes that whole class of boundary omission impossible instead of
// relying on every boundary remembering to filter its input.
// Returns { ok:true, body } or { ok:false, code:'validation'|'internal',
// message }. Spawning happens synchronously inside createSession; a failed
// spawn surfaces as validation-shaped 400 (the client-visible contract of
// every other launch path).
export async function createSessionViaApi(body, { isReviewJob = false } = {}) {
  const isMetaAgent = body.isMetaAgent === true;
  const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : null;
  // Normal launches require an existing directory. Meta-agent launches skip
  // this: the cwd is forced to the fixed meta-agent dir server-side, so any
  // client-supplied value (including absent/nonexistent) is ignored.
  if (!isMetaAgent) {
    let cwdIsDir = false;
    try { cwdIsDir = statSync(cwd).isDirectory(); } catch { /* missing */ }
    if (!cwd || !cwdIsDir) {
      return { ok: false, code: 'validation', message: 'cwd must be an existing directory' };
    }
  }
  if (body.app !== undefined && body.app !== null && !isValidApp(body.app)) {
    return { ok: false, code: 'validation', message: 'app must be one of claude, opencode, copilot, codex, commandcode' };
  }
  if (body.sandboxOpts !== undefined && body.sandboxOpts !== null
    && (typeof body.sandboxOpts !== 'object' || Array.isArray(body.sandboxOpts))) {
    return { ok: false, code: 'validation', message: 'sandboxOpts must be an object ({ gpg, sshAgent })' };
  }
  // isMetaAgent is only meaningful through this REST boundary's meta callers;
  // a plain HTTP client may set it, but it has no effect unless the config
  // enables the feature AND the broker is listening (see shouldInjectMetaAgent).
  // isReviewJob is deliberately NOT read from `body` here -- see this
  // function's header comment. It comes only from the trusted 2nd parameter.
  const result = createSession({
    cwd,
    cols: 80,
    rows: 24,
    claudeSessionId: null,
    shell: !!body.shell,
    sandbox: !!body.sandbox,
    sandboxOpts: body.sandboxOpts || null,
    app: body.app || null,
    model: typeof body.model === 'string' ? body.model : null,
    permissionMode: typeof body.permissionMode === 'string' ? body.permissionMode : 'standard',
    resumeLast: !!body.resume,
    reuseSandboxHome: body.reuseSandboxHome !== false,
    isMetaAgent: !!body.isMetaAgent,
    isReviewJob: isReviewJob === true,
    // Attribution for the sandbox HOME bookkeeping row ('user' |
    // 'meta-agent:<sessionId>' | ...). Display only.
    sandboxHomeCreatedBy: typeof body.requestedBy === 'string' && body.requestedBy ? body.requestedBy : 'user',
  });
  if (result.error || !result.session) {
    return { ok: false, code: 'validation', message: result.error || 'failed to create session' };
  }
  return {
    ok: true,
    body: {
      sessionId: result.sessionId,
      cwd: result.session.cwd,
      app: result.session.app,
      model: result.session.model,
      permissionMode: result.session.permissionMode,
      shell: result.session.shell,
      sandbox: result.session.sandbox,
      sandboxOpts: result.session.sandboxOpts,
      isMetaAgent: result.session.isMetaAgent,
      home: homedir(), // convenience for clients that resolve ~ in cwds
    },
  };
}
