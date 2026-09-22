// Session REST surface: list, terminate, and CREATE a standalone session
// over HTTP.
//
// POST /api/sessions exists to give headless callers a stateless "launch
// exactly one session" primitive: until now standalone sessions could
// only be created through the browser's WS `init` message, which no headless
// caller can use. The handler body lives in createSessionViaApi() so the
// federation "sessions.create" RPC calls the SAME function instead of
// duplicating the validation (REST and RPC launches can never drift).

import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import { createSession, getSession, destroySession, listSessions, setSessionLabel } from '../ws/sessionManager.js';
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
    destroySession(id, { keepSchedule: false, reason: 'request' });
    return { success: true, id };
  });

  // Operator-assigned display name (client right-click rename). Body:
  //   { customLabel: string | null }  (missing key / wrong type -> 400,
  //   empty-after-trim clears the name, overlong -> 400)
  fastify.patch('/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    const body = request.body || {};
    // Guard the `in` check: a truthy primitive JSON body (e.g. `"foo"` or
    // `42`) would otherwise throw a TypeError and surface as a 500 instead
    // of a 400. Arrays fall through to the missing-key 400 below.
    if (typeof body !== 'object' || body === null || !('customLabel' in body)) {
      return reply.code(400).send({ error: 'customLabel is required' });
    }
    // Shape-check before the lookup so malformed bodies 400 even for
    // unknown ids (length/emptiness rules live in setSessionLabel).
    if (body.customLabel !== null && typeof body.customLabel !== 'string') {
      return reply.code(400).send({ error: 'customLabel must be a string or null' });
    }
    const res = setSessionLabel(id, body.customLabel);
    if (!res.ok) {
      const status = res.code === 'not-found' ? 404 : 400;
      return reply.code(status).send({ error: res.message });
    }
    return { success: true, id, customLabel: res.session.customLabel };
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

// Shared implementation for POST /api/sessions and the federation
// "sessions.create" RPC. body:
//   { cwd?, app?, model?, permissionMode?, shell?, sandbox?, sandboxOpts?,
//     resume?, reuseSandboxHome?, requestedBy? }
// `permissionMode` ('standard' | 'auto-accept' | 'yolo', default 'standard')
// selects the commandcode permission-bypass flag (--auto-accept / --yolo);
// any other value is coerced to 'standard' downstream, and other apps ignore
// it entirely.
// `cwd` is required and must be an existing directory.
//
// `isReviewJob` (2nd param) is DELIBERATELY not part of `body`. It forces
// reviewer MCP injection regardless of the live reviewerMcp config (see
// sessionManager.js's useReviewer comment) -- a real privilege bypass, unlike
// every field actually read from `body`. Every caller of this function
// forwards a network- or IPC-facing request body more or less as-is (REST
// route above, federationServer.js's rpcSessionsCreate) -- if isReviewJob
// were just another body key, each of those boundaries would have to
// remember to strip it, and missing even one hands a remote peer an MCP
// injection it was never meant to have. Keeping it a separate parameter that
// only an in-process caller can pass (reviewer.js's runReview -- the ONLY
// legitimate setter) makes that whole class of boundary omission impossible
// instead of relying on every boundary remembering to filter its input.
// `scratchCwd` (2nd param, same trusted-parameter pattern) allows a
// server-synthesized cwd under ~/.local/share/ccserver-sandbox to skip the
// browseRoots containment check (combo worktrees / review worktrees). Only
// reviewer.js's runReview sets it today; both options are unreachable from
// any network-facing caller.
// Returns { ok:true, body } or { ok:false, code:'validation'|'internal',
// message }. Spawning happens synchronously inside createSession; a failed
// spawn surfaces as validation-shaped 400 (the client-visible contract of
// every other launch path).
export async function createSessionViaApi(body, { isReviewJob = false, scratchCwd = false } = {}) {
  const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : null;
  let cwdIsDir = false;
  try { cwdIsDir = statSync(cwd).isDirectory(); } catch { /* missing */ }
  if (!cwd || !cwdIsDir) {
    return { ok: false, code: 'validation', message: 'cwd must be an existing directory' };
  }
  if (body.app !== undefined && body.app !== null && !isValidApp(body.app)) {
    return { ok: false, code: 'validation', message: 'app must be one of claude, opencode, copilot, codex, commandcode' };
  }
  if (body.sandboxOpts !== undefined && body.sandboxOpts !== null
    && (typeof body.sandboxOpts !== 'object' || Array.isArray(body.sandboxOpts))) {
    return { ok: false, code: 'validation', message: 'sandboxOpts must be an object ({ gpg, sshAgent })' };
  }
  // isReviewJob / scratchCwd are deliberately NOT read from `body` here --
  // see this function's header comment. They come only from the trusted 2nd
  // parameter, so no network-facing caller can mint a scratch-cwd exemption.
  const result = await createSession({
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
    isReviewJob: isReviewJob === true,
    scratchCwd: scratchCwd === true,
    // Attribution for the sandbox HOME bookkeeping row ('user' | ...).
    // Display only.
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
      home: homedir(), // convenience for clients that resolve ~ in cwds
    },
  };
}
