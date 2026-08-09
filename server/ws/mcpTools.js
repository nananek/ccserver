// Pure MCP tool implementations for combo-launched groups. No MCP SDK
// dependency and no imports of the app's mutable modules -- every function
// receives its dependencies (`deps`) explicitly, so these can be unit-tested
// directly with node --test (see mcpTools.test.js).
//
// SECURITY: no function here ever accepts `groupId`, `sessionId` or `role`
// from the wire as an identity. The control server's deps carry the groupId
// (closure-bound at connection time); the handoff server's deps carry the
// role and resolve the sessionId from the group's own member registry. A
// client-supplied sessionId is only ever a *target* of a request, and every
// tool that takes one first checks groupManager.isSessionInGroup() -- the
// single authorization chokepoint. Breaking this shape (e.g. accepting a
// groupId argument) nullifies the whole isolation boundary.

const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()][A-Z0-9]|[>=<]|#[0-9])/g;

// Handoff summaries are orchestrator input (context) -- cap their size so a
// noisy worker can't balloon the queue's memory beyond the count cap.
const MAX_HANDOFF_SUMMARY_CHARS = 32 * 1024;

export function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}

// deps: { groupId, groupManager, sessionManager }
export function listGroupSessions(deps) {
  return { members: deps.groupManager.listGroupMembers(deps.groupId) };
}

// Read recent terminal output of a group member. The raw bytes and an
// ANSI-stripped text view are both returned; prefer `text` for feeding the
// orchestrator's context. This is a fallback for stuck-member inspection --
// the recommended flow is wait_for_handoff.
export function readOutput(deps, { sessionId, tail = 4000 }) {
  const n = Math.min(Math.max(Number.isFinite(tail) ? tail : 4000, 1), 100000);
  if (!deps.groupManager.isSessionInGroup(deps.groupId, sessionId)) {
    return { error: 'unauthorized', message: 'session is not a member of this group' };
  }
  const session = deps.sessionManager.getSession(sessionId);
  if (!session) {
    return { error: 'not-found', message: 'session not found' };
  }
  const raw = session.outputBuffer.slice(-n).join('');
  return {
    sessionId,
    cwd: session.cwd,
    app: session.app,
    exited: !!session.exited,
    raw,
    text: stripAnsi(raw),
  };
}

// Type text into a group member's terminal (optionally submitting with
// Enter). Not a shell command execution primitive -- just keystrokes.
export function sendInput(deps, { sessionId, text, submit = true }) {
  if (!deps.groupManager.isSessionInGroup(deps.groupId, sessionId)) {
    return { error: 'unauthorized', message: 'session is not a member of this group' };
  }
  const ok = deps.sessionManager.writeToSession(sessionId, String(text), { submit: !!submit });
  return ok
    ? { ok: true }
    : { error: 'not-found', message: 'session not found or exited' };
}

// Open a new member session (worker role) inside the group, with its own
// handoff channel. cwd is restricted to the group's allowedCwds (initialized
// to the shared project directory -- see groupManager). sandboxOpts (gpg /
// ssh-agent forwarding) defaults to the group's launch flags; an explicit
// override is honored.
export async function openTab(deps, { role, app, cwd, sandboxOpts = null }) {
  const res = await deps.groupManager.addMember(deps.groupId, role, { app, cwd, sandboxOpts });
  if (res.error) return { error: res.error, message: res.message };
  return { sessionId: res.sessionId, role, cwd, app: res.app };
}

export function closeTab(deps, { sessionId }) {
  if (!deps.groupManager.isSessionInGroup(deps.groupId, sessionId)) {
    return { error: 'unauthorized', message: 'session is not a member of this group' };
  }
  deps.groupManager.removeMember(deps.groupId, sessionId);
  return { ok: true };
}

export function getTabStatus(deps, { sessionId }) {
  if (!deps.groupManager.isSessionInGroup(deps.groupId, sessionId)) {
    return { error: 'unauthorized', message: 'session is not a member of this group' };
  }
  const session = deps.sessionManager.getSession(sessionId);
  if (!session) {
    return { error: 'not-found', message: 'session not found' };
  }
  return {
    sessionId,
    cwd: session.cwd,
    app: session.app,
    exited: !!session.exited,
    exitCode: session.exitCode ?? null,
    connected: !!session.socket,
  };
}

// Block until a worker hands off, or the timeout elapses. Returns the FIFO
// handoff event (or a tiny { timedOut: true } on timeout -- NOT an error, so
// the orchestrator can simply call wait_for_handoff again). This is the
// recommended wait primitive: one structured call instead of polling
// read_output.
export function waitForHandoff(deps, { timeoutMs = 900000 }) {
  return deps.groupManager.takeHandoff(deps.groupId, Math.max(Number(timeoutMs) || 0, 0));
}

// Handoff (worker-only): notify the orchestrator that the worker's task is
// done / blocked / needs input. sessionId/role come from the handoff server's
// closure, never from the wire -- only summary/status are worker input.
export function handoffToOrchestrator(deps, { summary, status = 'done', nextRole = null }) {
  const sessionId = typeof deps.getSessionId === 'function'
    ? deps.getSessionId()
    : (deps.sessionId || null);
  const statuses = ['done', 'blocked', 'needs_input', 'error'];
  if (!statuses.includes(status)) {
    return { error: 'bad-request', message: `status must be one of: ${statuses.join(', ')}` };
  }
  const ok = deps.groupManager.pushHandoff(deps.groupId, {
    fromSessionId: sessionId,
    fromRole: deps.role || null,
    summary: String(summary || '').slice(0, MAX_HANDOFF_SUMMARY_CHARS),
    status,
    nextRole: nextRole || null,
    at: Date.now(),
  });
  return ok ? { ok: true } : { error: 'group-not-found' };
}
