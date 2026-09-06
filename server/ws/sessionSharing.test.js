// Multi-client session sharing: a session is watched by a SET of clients, not
// a single socket. Before this, attachSocket evicted the incumbent (closing it
// with code 4001), so opening a session from a second device kicked the first
// one off it. These tests pin the sharing behavior and the pty size
// negotiation that comes with it -- one pty has one size, so it runs at the
// smallest viewport among the attached clients.
//
// The size assertions read the size back through `stty size` inside the shell
// itself, not just session.cols, so a change that updates the bookkeeping
// without actually resizing the pty fails here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sessionManager;
let terminal;
let runtimeDir;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Minimal stand-in for a browser WebSocket: the same surface the broadcast
// path uses (`readyState`, `send`), plus `close` so a test can prove nobody
// called it.
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
    text() {
      return this.messages('output').map((m) => m.data).join('');
    },
  };
}

function newShell() {
  const res = sessionManager.createSession({
    cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false,
  });
  assert.ok(res.session, 'shell session should spawn');
  return res;
}

// Asks the shell for the pty's real dimensions and waits for the answer.
// Returns "<rows> <cols>" as stty prints it.
async function ptySize(sessionId, socket) {
  const marker = `SZ${Math.random().toString(36).slice(2, 8)}`;
  const before = socket.sent.length;
  sessionManager.writeToSession(sessionId, `echo ${marker}-$(stty size | tr ' ' 'x')`, { submit: true });
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const out = socket.sent.slice(before)
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter((m) => m?.type === 'output')
      .map((m) => m.data)
      .join('');
    // Skip the echoed command line itself (it contains "$(stty size...)"),
    // match only the expanded result.
    const hit = out.match(new RegExp(`${marker}-(\\d+)x(\\d+)`));
    if (hit) return { rows: Number(hit[1]), cols: Number(hit[2]) };
  }
  throw new Error(`pty size never reported for ${sessionId}`);
}

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-sharing-test-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  process.env.CCSERVER_ORCHESTRATOR_GENERATED_ROOT = join(runtimeDir, 'orchestrator-generated');
  sessionManager = await import('./sessionManager.js');
  terminal = await import('./terminal.js');
});

after(() => {
  sessionManager.destroyAllSessions();
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('a second client joins the session instead of evicting the first', async () => {
  const { sessionId, session } = newShell();
  const desktop = fakeSocket();
  const phone = fakeSocket();
  try {
    sessionManager.attachSocket(sessionId, desktop);
    sessionManager.attachSocket(sessionId, phone);

    assert.equal(session.sockets.size, 2, 'both clients are attached');
    assert.equal(desktop.closedWith, null, 'the incumbent is never closed');
    assert.deepEqual(desktop.messages('detached'), [], 'no takeover notice is sent');

    await sleep(300);
    const marker = `BOTH${Date.now()}`;
    sessionManager.writeToSession(sessionId, `echo ${marker}`, { submit: true });
    await sleep(800);

    assert.match(desktop.text(), new RegExp(marker), 'first client still receives output');
    assert.match(phone.text(), new RegExp(marker), 'second client receives the same output');
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

test('the destroy timer is armed only once the LAST client detaches', async () => {
  const { sessionId, session } = newShell();
  const a = fakeSocket();
  const b = fakeSocket();
  try {
    sessionManager.attachSocket(sessionId, a);
    sessionManager.attachSocket(sessionId, b);

    sessionManager.detachSocket(sessionId, b);
    assert.equal(session.sockets.size, 1, 'one client remains');
    assert.equal(session.timeoutTimer, null, 'no destroy timer while someone is watching');

    await sleep(200);
    const marker = `STILL${Date.now()}`;
    sessionManager.writeToSession(sessionId, `echo ${marker}`, { submit: true });
    await sleep(800);
    assert.match(a.text(), new RegExp(marker), 'the remaining client keeps receiving output');

    sessionManager.detachSocket(sessionId, a);
    assert.equal(session.sockets.size, 0, 'no client remains');
    assert.notEqual(session.timeoutTimer, null, 'destroy timer armed once nobody is watching');
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

test('detaching a socket that was never attached leaves the session alone', async () => {
  const { sessionId, session } = newShell();
  const attached = fakeSocket();
  const stranger = fakeSocket();
  try {
    sessionManager.attachSocket(sessionId, attached);
    const notices = attached.messages('viewers').length;

    sessionManager.detachSocket(sessionId, stranger);
    assert.equal(session.sockets.size, 1, 'the real viewer is untouched');
    assert.equal(session.timeoutTimer, null, 'no destroy timer armed by a stranger detach');
    assert.equal(attached.messages('viewers').length, notices,
      'a detach of a socket that was never attached is a no-op, not a viewer-count event');
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

test('the pty runs at the smallest attached viewport, and widens when that client leaves', async () => {
  const { sessionId, session } = newShell();
  const desktop = fakeSocket();
  const phone = fakeSocket();
  try {
    sessionManager.attachSocket(sessionId, desktop, { cols: 120, rows: 40 });
    await sleep(300);
    assert.deepEqual(await ptySize(sessionId, desktop), { rows: 40, cols: 120 },
      'a lone client gets exactly its own size');

    sessionManager.attachSocket(sessionId, phone, { cols: 80, rows: 24 });
    assert.equal(session.cols, 80, 'negotiated cols is the minimum');
    assert.equal(session.rows, 24, 'negotiated rows is the minimum');
    assert.deepEqual(await ptySize(sessionId, desktop), { rows: 24, cols: 80 },
      'the pty itself is resized down to the smaller client');

    // Both clients are told the agreed size, including the one that did not
    // ask for it -- otherwise the desktop would keep drawing at 120x40.
    const sizeMsgs = desktop.messages('size');
    assert.ok(sizeMsgs.length > 0, 'the incumbent is told the new agreed size');
    assert.deepEqual(sizeMsgs.at(-1), { type: 'size', cols: 80, rows: 24 });

    sessionManager.detachSocket(sessionId, phone);
    assert.equal(session.cols, 120, 'the constraint lifts when the small client leaves');
    assert.deepEqual(await ptySize(sessionId, desktop), { rows: 40, cols: 120 },
      'the pty is resized back up');
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

test('setSocketViewport reports the size in force even when the request loses', async () => {
  const { sessionId } = newShell();
  const desktop = fakeSocket();
  const phone = fakeSocket();
  try {
    sessionManager.attachSocket(sessionId, desktop, { cols: 100, rows: 30 });
    sessionManager.attachSocket(sessionId, phone, { cols: 80, rows: 24 });

    const inForce = sessionManager.setSocketViewport(sessionId, desktop, 200, 60);
    assert.deepEqual(inForce, { cols: 80, rows: 24 },
      'the loser is told the negotiated size, not its own request');

    const won = sessionManager.setSocketViewport(sessionId, phone, 90, 26);
    assert.deepEqual(won, { cols: 90, rows: 26 },
      'raising the smallest viewport raises the negotiated size');

    assert.equal(sessionManager.setSocketViewport(sessionId, fakeSocket(), 10, 10), null,
      'an unattached socket cannot steer the pty size');
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

test('viewer count is broadcast on join and on leave', async () => {
  const { sessionId } = newShell();
  const a = fakeSocket();
  const b = fakeSocket();
  try {
    sessionManager.attachSocket(sessionId, a);
    assert.deepEqual(a.messages('viewers').at(-1), { type: 'viewers', count: 1 });

    sessionManager.attachSocket(sessionId, b);
    assert.deepEqual(a.messages('viewers').at(-1), { type: 'viewers', count: 2 },
      'the incumbent learns someone joined');

    sessionManager.detachSocket(sessionId, b);
    assert.deepEqual(a.messages('viewers').at(-1), { type: 'viewers', count: 1 },
      'and learns when they leave');
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

test('listSessions reports connected/viewers from the attached set', async () => {
  const { sessionId } = newShell();
  const a = fakeSocket();
  const b = fakeSocket();
  const row = () => sessionManager.listSessions().find((s) => s.id === sessionId);
  try {
    assert.equal(row().connected, false);
    assert.equal(row().viewers, 0);

    sessionManager.attachSocket(sessionId, a);
    sessionManager.attachSocket(sessionId, b);
    assert.equal(row().connected, true);
    assert.equal(row().viewers, 2);

    sessionManager.detachSocket(sessionId, a);
    assert.equal(row().connected, true, 'still connected while one client remains');
    assert.equal(row().viewers, 1);
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

test('a dead client does not stop the others from receiving output', async () => {
  const { sessionId, session } = newShell();
  const alive = fakeSocket();
  const broken = fakeSocket();
  broken.send = () => { throw new Error('socket is gone'); };
  const closed = fakeSocket();
  closed.readyState = 3;
  try {
    sessionManager.attachSocket(sessionId, broken);
    sessionManager.attachSocket(sessionId, closed);
    sessionManager.attachSocket(sessionId, alive);

    await sleep(300);
    const marker = `ALIVE${Date.now()}`;
    sessionManager.writeToSession(sessionId, `echo ${marker}`, { submit: true });
    await sleep(800);

    assert.match(alive.text(), new RegExp(marker), 'a throwing/closed peer is skipped, not fatal');
    assert.deepEqual(closed.messages(), [], 'a closed socket is never written to');
    // Both failure modes must also leave the viewer set, or they would keep
    // the session pinned as "connected" and its destroy timer disarmed.
    assert.equal(session.sockets.has(broken), false, 'a socket that throws on send is pruned');
    assert.equal(session.sockets.has(closed), false, 'a closed socket is pruned');
    assert.equal(session.sockets.has(alive), true, 'the healthy viewer is kept');
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

// End-to-end through the /ws/terminal dispatcher: two clients, one session.
test('two /ws/terminal clients share one session; resize answers with the size in force', async () => {
  const desktop = fakeSocket();
  const phone = fakeSocket();
  const desktopHandler = terminal.attachTerminalHandler(desktop);
  const phoneHandler = terminal.attachTerminalHandler(phone);
  let sessionId = null;
  try {
    await desktopHandler.handleMessage({
      type: 'init', cwd: '/tmp', cols: 120, rows: 40, shell: true,
    });
    const opened = desktop.messages('session').at(-1);
    assert.ok(opened?.sessionId, 'init opened a session');
    sessionId = opened.sessionId;
    assert.equal(opened.viewers, 1, 'the opener is the only viewer');

    await phoneHandler.handleMessage({
      type: 'attach', sessionId, cols: 80, rows: 24,
    });
    const joined = phone.messages('session').at(-1);
    assert.equal(joined.isReconnect, true);
    assert.equal(joined.viewers, 2, 'the joiner is told the session is shared');
    assert.deepEqual(await ptySize(sessionId, desktop), { rows: 24, cols: 80 },
      'attaching a smaller client shrinks the pty for everyone');

    // The desktop asks for its full size and does not get it -- but must be
    // told what the pty is actually running at.
    await desktopHandler.handleMessage({ type: 'resize', cols: 120, rows: 40 });
    assert.deepEqual(desktop.messages('size').at(-1), { type: 'size', cols: 80, rows: 24 },
      'a losing resize is answered with the negotiated size');
    assert.deepEqual(await ptySize(sessionId, desktop), { rows: 24, cols: 80 },
      'and the pty is left at the negotiated size');

    // Typing on one device is seen on both.
    const marker = `E2E${Date.now()}`;
    await phoneHandler.handleMessage({ type: 'input', data: `echo ${marker}\r` });
    await sleep(900);
    assert.match(desktop.text(), new RegExp(marker), 'input from one client shows on the other');

    // The phone leaving lifts the constraint for the client still attached.
    phoneHandler.handleClose();
    assert.deepEqual(await ptySize(sessionId, desktop), { rows: 40, cols: 120 },
      'the remaining client gets its full size back');
  } finally {
    if (sessionId) sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

// The point of these logs is post-hoc diagnosis: "my session died early" was
// previously unanswerable because nothing recorded which path took it.
test('pty exit, viewer loss and teardown are all logged with enough to diagnose them', async () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  let sessionId = null;
  try {
    const res = newShell();
    sessionId = res.sessionId;
    const socket = fakeSocket();
    sessionManager.attachSocket(sessionId, socket);
    await sleep(300);

    sessionManager.detachSocket(sessionId, socket);
    const detachLog = lines.find((l) => l.includes(sessionId) && l.includes('last viewer left'));
    assert.ok(detachLog, 'losing the last viewer is logged');
    assert.match(detachLog, /destroying in \d+ms/, 'with the deadline that was armed');

    sessionManager.attachSocket(sessionId, socket);
    sessionManager.writeToSession(sessionId, 'exit', { submit: true });
    for (let i = 0; i < 40 && !res.session.exited; i++) await sleep(100);
    assert.equal(res.session.exited, true, 'the shell exited');

    const exitLog = lines.find((l) => l.includes(sessionId) && l.includes('pty exited'));
    assert.ok(exitLog, 'the pty exit itself is logged');
    assert.match(exitLog, /code=\d+/, 'with the exit code');
    assert.match(exitLog, /cwd=\/tmp/, 'and the directory it was running in');

    sessionManager.destroySession(sessionId, { reason: 'test-teardown' });
    const gone = sessionId;
    sessionId = null;
    const destroyLog = lines.find((l) => l.includes(gone) && l.includes('destroyed'));
    assert.ok(destroyLog, 'the teardown is logged');
    assert.match(destroyLog, /reason=test-teardown/, 'with WHICH path tore it down');
    assert.match(destroyLog, /uptime=\d+ms/, 'and how long it had been alive');
  } finally {
    console.log = originalLog;
    if (sessionId) sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

// Regression guard for the viewer set itself: with a single socket per
// session a stale one was overwritten by the next attach, but a set keeps
// whatever nobody removed. A session whose set never empties never arms its
// destroy timer, so a socket that dies without a 'close' handler would keep
// the pty alive forever.
test('a socket that dies without detaching is pruned, releasing the destroy timer', async () => {
  const { sessionId, session } = newShell();
  const abandoned = fakeSocket();
  try {
    sessionManager.attachSocket(sessionId, abandoned, { cols: 80, rows: 24 });
    assert.equal(session.timeoutTimer, null, 'a live viewer suppresses the timer');

    // The socket dies with nobody calling detachSocket for it.
    abandoned.readyState = 3;

    await sleep(200);
    sessionManager.writeToSession(sessionId, 'echo prune', { submit: true });
    await sleep(900); // any output broadcast notices the dead socket

    assert.equal(session.sockets.size, 0, 'the dead viewer was pruned');
    assert.notEqual(session.timeoutTimer, null,
      'and the destroy timer is armed, so the session cannot outlive its viewers');
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

test('pruning a dead viewer restores the pty size for the client still attached', async () => {
  const { sessionId, session } = newShell();
  const desktop = fakeSocket();
  const phone = fakeSocket();
  try {
    sessionManager.attachSocket(sessionId, desktop, { cols: 120, rows: 40 });
    sessionManager.attachSocket(sessionId, phone, { cols: 80, rows: 24 });
    assert.equal(session.cols, 80, 'the small client constrains the pty');

    phone.readyState = 3; // dies without detaching

    await sleep(200);
    sessionManager.writeToSession(sessionId, 'echo widen', { submit: true });
    await sleep(900);

    assert.equal(session.sockets.size, 1, 'only the live viewer remains');
    assert.deepEqual(await ptySize(sessionId, desktop), { rows: 40, cols: 120 },
      'a dead client must not keep the pty shrunk');
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});
