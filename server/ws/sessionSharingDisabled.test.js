// Session sharing (server/ws/sessionSharing.test.js) is opt-in via
// CCSERVER_SESSION_SHARING, off by default. This file runs with it left
// unset, and pins ccserver's original behavior for that default: attaching a
// second client evicts the incumbent (code 4001, a 'detached' notice) instead
// of joining it, so the pty size negotiation this module also owns never
// actually sees more than one viewport.
//
// Why this matters: a viewer that is attached but not actually on screen (a
// background browser tab, a stale reconnect) has no way to signal that to the
// server, and a hidden container can still yield a small non-zero size from
// the client's fit addon. With sharing on, that invisible client's viewport
// stays in the negotiation and can pin every real viewer's screen to a tiny
// size indefinitely. Restricting to one viewer by default sidesteps the whole
// class of bug: there is nothing left to negotiate against.
//
// Test files get their own process under `node --test`, so leaving the env
// var unset here does not race sessionSharing.test.js setting it to '1'.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sessionManager;
let runtimeDir;

function fakeSocket() {
  return {
    readyState: 1,
    sent: [],
    closedWith: null,
    send(m) { this.sent.push(m); },
    close(code, reason) { this.closedWith = { code, reason }; this.readyState = 3; },
    messages(type) {
      return this.sent
        .map((m) => { try { return JSON.parse(m); } catch { return null; } })
        .filter((m) => m && (!type || m.type === type));
    },
  };
}

async function newShell() {
  const res = await sessionManager.createSession({
    cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false,
  });
  assert.ok(res.session, 'shell session should spawn');
  return res;
}

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-sharing-disabled-test-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  process.env.CCSERVER_ORCHESTRATOR_GENERATED_ROOT = join(runtimeDir, 'orchestrator-generated');
  delete process.env.CCSERVER_SESSION_SHARING;
  sessionManager = await import('./sessionManager.js');
});

after(() => {
  sessionManager.destroyAllSessions();
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('a second client evicts the incumbent by default', async () => {
  const { sessionId, session } = await newShell();
  const desktop = fakeSocket();
  const phone = fakeSocket();
  try {
    sessionManager.attachSocket(sessionId, desktop);
    sessionManager.attachSocket(sessionId, phone);

    assert.equal(session.sockets.size, 1, 'only the newest client remains attached');
    assert.equal(session.sockets.has(phone), true, 'the newcomer took over');
    assert.equal(session.sockets.has(desktop), false, 'the incumbent was dropped');
    assert.deepEqual(desktop.closedWith, { code: 4001, reason: 'Replaced by new client' },
      'the incumbent is closed exactly like pre-sharing ccserver');
    assert.deepEqual(desktop.messages('detached'), [{ type: 'detached', reason: 'replaced' }],
      'the incumbent is told why');
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

test('a lone client is never evicted by its own attach', async () => {
  const { sessionId, session } = await newShell();
  const solo = fakeSocket();
  try {
    sessionManager.attachSocket(sessionId, solo, { cols: 100, rows: 30 });
    assert.equal(session.sockets.size, 1);
    assert.equal(solo.closedWith, null);
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

test('the pty size follows the sole attached client, with nothing to negotiate against', async () => {
  const { sessionId, session } = await newShell();
  const desktop = fakeSocket();
  const phone = fakeSocket();
  try {
    sessionManager.attachSocket(sessionId, desktop, { cols: 120, rows: 40 });
    assert.equal(session.cols, 120, 'the only client gets exactly its own size');

    // A hidden/background client reporting a degenerate viewport would, under
    // sharing, drag the pty down and keep it there -- this is exactly what
    // eviction-by-default prevents: the newcomer simply replaces it.
    sessionManager.attachSocket(sessionId, phone, { cols: 2, rows: 1 });
    assert.equal(session.sockets.size, 1, 'still only one viewer');
    assert.equal(session.cols, 2, "the new (sole) client's own request, not a negotiated minimum");
    assert.equal(session.rows, 1);
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});
