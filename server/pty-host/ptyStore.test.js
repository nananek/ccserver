// Real (non-mocked) bash ptys exercise the store's actual lifecycle -- same
// approach as server/ws/sessionManager.test.js's shell-based sessions. The
// sandboxed-spawn test additionally needs a real bwrap, so it's skipped
// where that's unavailable (see sandbox-resolve.test.js's { skip } pattern).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtyStore } from './ptyStore.js';
import { GitBrokerRegistry } from './gitBrokerRegistry.js';
import { sandboxAvailable } from '../ws/sandbox.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(check, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await sleep(intervalMs);
  }
}

function shellSpawn(store, extra = {}) {
  return store.spawn({
    cwd: process.env.HOME || '/tmp',
    cols: 80,
    rows: 24,
    command: process.env.SHELL || '/bin/bash',
    args: [],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'xterm-256color' },
    ...extra,
  });
}

test('spawn returns pid/cols/rows and write/onData round-trips through a real shell', async () => {
  const events = [];
  const store = new PtyStore({ onEvent: (connId, frame) => events.push([connId, frame]) });
  const { id, pid, cols, rows } = shellSpawn(store);
  assert.ok(pid > 0);
  assert.equal(cols, 80);
  assert.equal(rows, 24);

  store.subscribe(id, 'conn-1');
  store.write(id, 'echo PTY_HOST_MARKER_$((1+1))\n');

  let seen = '';
  await waitFor(() => {
    seen = events.filter(([c]) => c === 'conn-1').map(([, f]) => f.data).join('');
    return seen.includes('PTY_HOST_MARKER_2');
  });

  store.destroy(id);
});

test('spawn rejects a duplicate explicit id', () => {
  const store = new PtyStore();
  const { id } = shellSpawn(store, { id: 'fixed-id' });
  assert.equal(id, 'fixed-id');
  assert.throws(() => shellSpawn(store, { id: 'fixed-id' }), /already exists/);
  store.destroy(id);
});

test('write/resize/kill return false/null for an unknown id, never throw', () => {
  const store = new PtyStore();
  assert.equal(store.write('nope', 'x'), false);
  assert.equal(store.resize('nope', 10, 10), null);
  assert.equal(store.kill('nope'), false);
  assert.equal(store.destroy('nope'), false);
  assert.equal(store.subscribe('nope', 'c'), null);
  assert.equal(store.unsubscribe('nope', 'c'), false);
});

test('resize applies one authoritative size and list() reflects it', () => {
  const store = new PtyStore();
  const { id } = shellSpawn(store);
  const size = store.resize(id, 120, 40);
  assert.deepEqual(size, { cols: 120, rows: 40 });
  const row = store.list().find((s) => s.id === id);
  assert.equal(row.cols, 120);
  assert.equal(row.rows, 40);
  store.destroy(id);
});

test('kill signals the process but keeps the record; destroy removes it', async () => {
  const events = [];
  const store = new PtyStore({ onEvent: (c, f) => events.push(f) });
  const { id } = shellSpawn(store);
  store.subscribe(id, 'c1');

  assert.equal(store.kill(id), true);
  await waitFor(() => events.some((f) => f.event === 'exit'));
  assert.ok(store.list().some((s) => s.id === id && s.exited === true), 'record survives kill()');

  // A session record that survives kill() must reject a second signal --
  // there is no process left to receive it.
  assert.equal(store.kill(id), false);

  assert.equal(store.destroy(id), true);
  assert.equal(store.list().some((s) => s.id === id), false);
  assert.ok(events.some((f) => f.event === 'destroyed'));
});

test('destroy() on a still-running, viewer-less session does not let the late onExit re-arm a timer (zombie-entry regression)', async () => {
  // Regression coverage for the race _handleExit()'s identity check guards
  // against: destroy() removes the entry from _sessions and returns well
  // before node-pty's onExit for the killed process actually fires. Without
  // the "is this still the live entry for this id" check, that late onExit
  // would re-arm a timer keyed by entry.id -- and if a new session later
  // reuses the same id, the zombie's timer would destroy IT instead.
  const store = new PtyStore({ sessionTimeoutMs: 300, exitedTimeoutMs: 300 });
  const { id } = shellSpawn(store); // no subscribers; pty is still running
  assert.equal(store.destroy(id), true);
  assert.equal(store.list().some((s) => s.id === id), false);

  // Give the killed process's onExit time to fire late (well under the
  // 300ms timer window, so a mis-armed zombie timer is still pending when
  // id2 spawns below rather than having already fired against nothing).
  await sleep(50);

  const { id: id2 } = shellSpawn(store, { id }); // reuse the same id
  await sleep(400); // past the 300ms window a mis-armed zombie timer would use
  assert.ok(store.list().some((s) => s.id === id2), 'new session with the reused id must not be hijacked by the old ptys late exit');
  store.destroy(id2);
});

test('list() reports viewers as the current subscriber count', () => {
  const store = new PtyStore();
  const { id } = shellSpawn(store);
  assert.equal(store.list().find((s) => s.id === id).viewers, 0);
  store.subscribe(id, 'c1');
  store.subscribe(id, 'c2');
  assert.equal(store.list().find((s) => s.id === id).viewers, 2);
  store.unsubscribe(id, 'c1');
  assert.equal(store.list().find((s) => s.id === id).viewers, 1);
  store.destroy(id);
});

test('subscribe replays buffered output; sinceSeq filters to only newer chunks', async () => {
  const store = new PtyStore();
  const { id } = shellSpawn(store);
  store.subscribe(id, 'watcher'); // so data actually gets buffered/pushed while "unseen"
  store.write(id, 'echo AAA\n');
  await waitFor(() => {
    const r = store.subscribe(id, 'peek');
    store.unsubscribe(id, 'peek');
    return r.backlog.some((c) => c.data.includes('AAA'));
  });

  const full = store.subscribe(id, 'late-joiner', null);
  assert.ok(full.backlog.length > 0);
  assert.equal(full.truncated, false);
  const lastSeq = full.lastSeq;

  store.write(id, 'echo BBB\n');
  await waitFor(() => {
    const r = store.subscribe(id, 'peek2', lastSeq);
    store.unsubscribe(id, 'peek2');
    return r.backlog.some((c) => c.data.includes('BBB'));
  });

  const sinceLatest = store.subscribe(id, 'catchup', lastSeq);
  assert.ok(sinceLatest.backlog.every((c) => c.seq > lastSeq));
  assert.ok(sinceLatest.backlog.some((c) => c.data.includes('BBB')));
  assert.ok(!sinceLatest.backlog.some((c) => c.data.includes('AAA')), 'AAA was already before sinceSeq');

  store.destroy(id);
});

test('outputBuffer eviction reports truncated:true once bytes fall off the ring', async () => {
  const store = new PtyStore({ outputBufferMaxBytes: 64 });
  const { id } = shellSpawn(store);
  store.subscribe(id, 'watcher');
  const first = store.subscribe(id, 'baseline');
  const firstSeq = first.lastSeq;

  // Push well past the tiny 64-byte cap so the earliest chunk(s) evict.
  for (let i = 0; i < 20; i++) {
    store.write(id, `echo line-${i}-${'x'.repeat(20)}\n`);
    await sleep(15);
  }

  const late = store.subscribe(id, 'rejoin', firstSeq);
  assert.equal(late.truncated, true);
  store.destroy(id);
});

test('viewer-count timers: idle timeout destroys a running session with no subscribers', async () => {
  const store = new PtyStore({ sessionTimeoutMs: 30, exitedTimeoutMs: 30 });
  const { id } = shellSpawn(store);
  store.subscribe(id, 'c1');
  store.unsubscribe(id, 'c1'); // 0 subscribers -> arms the running-session timer
  await waitFor(() => !store.list().some((s) => s.id === id), { timeoutMs: 2000 });
});

test('a fresh subscribe cancels a pending idle-destroy timer', async () => {
  const store = new PtyStore({ sessionTimeoutMs: 150, exitedTimeoutMs: 150 });
  const { id } = shellSpawn(store);
  store.subscribe(id, 'c1');
  store.unsubscribe(id, 'c1');
  await sleep(50); // well inside the 150ms window
  store.subscribe(id, 'c2'); // must cancel the pending timer
  await sleep(200); // past the original deadline
  assert.ok(store.list().some((s) => s.id === id), 'still alive: the timer was cancelled by subscribe()');
  store.destroy(id);
});

test('exited-timeout (not the running one) applies once the pty has exited', async () => {
  const store = new PtyStore({ sessionTimeoutMs: 5000, exitedTimeoutMs: 30 });
  const { id } = shellSpawn(store);
  store.subscribe(id, 'c1');
  store.kill(id);
  await waitFor(() => store.list().find((s) => s.id === id)?.exited === true);
  store.unsubscribe(id, 'c1'); // 0 subscribers on an EXITED session -> the short timer, not the 5s one
  await waitFor(() => !store.list().some((s) => s.id === id), { timeoutMs: 2000 });
});

test('handleConnectionClose is treated as an implicit unsubscribe, never a destroy', async () => {
  const store = new PtyStore({ sessionTimeoutMs: 30, exitedTimeoutMs: 30 });
  const { id } = shellSpawn(store);
  store.subscribe(id, 'conn-a');
  store.handleConnectionClose('conn-a');
  assert.ok(store.list().some((s) => s.id === id), 'destroyed only after the timer, not synchronously');
  await waitFor(() => !store.list().some((s) => s.id === id), { timeoutMs: 2000 });
});

test('timeoutMs <= 0 disables that tier: a viewer-less running session lives on', async () => {
  const store = new PtyStore({ sessionTimeoutMs: 0, exitedTimeoutMs: 30 });
  const { id } = shellSpawn(store);
  store.subscribe(id, 'c1');
  store.unsubscribe(id, 'c1');
  await sleep(200);
  assert.ok(store.list().some((s) => s.id === id), 'sessionTimeoutMs=0 means never auto-destroyed while running');
  store.destroy(id);
});

// --- sandbox integration (plan5 2.1: pty-host owns sandbox construction) ---

let sandboxTmpRoot;
let sandboxCfgPath;

before(() => {
  sandboxTmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-pty-host-sandbox-'));
  sandboxCfgPath = join(sandboxTmpRoot, 'sandbox.config.json');
  writeFileSync(sandboxCfgPath, JSON.stringify({ docker: false, gitBroker: false, persistentHome: false }));
  process.env.CCSERVER_SANDBOX_CONFIG = sandboxCfgPath;
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(sandboxTmpRoot, 'home');
});

after(() => {
  delete process.env.CCSERVER_SANDBOX_CONFIG;
  delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  try { rmSync(sandboxTmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('spawn({sandbox:true}) runs the real command inside a bwrap sandbox', { skip: !sandboxAvailable() }, async () => {
  const events = [];
  const store = new PtyStore({ onEvent: (c, f) => events.push(f) });
  const cwd = mkdtempSync(join(tmpdir(), 'ccserver-pty-host-proj-'));
  try {
    const { id, sandbox } = store.spawn({
      cwd,
      cols: 80,
      rows: 24,
      command: '/bin/echo',
      args: ['SANDBOXED_MARKER'],
      env: { PATH: '/usr/bin:/bin' },
      sandbox: true,
      app: 'claude',
    });
    assert.equal(sandbox.active, true);

    store.subscribe(id, 'watcher');
    await waitFor(() => events.some((f) => f.event === 'data' && f.data.includes('SANDBOXED_MARKER')));
    await waitFor(() => events.some((f) => f.event === 'exit'));
    store.destroy(id);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('spawn({sandbox:true}) without "app" is refused before touching the sandbox builder', () => {
  const store = new PtyStore();
  assert.throws(
    () => store.spawn({ cwd: '/tmp', cols: 80, rows: 24, command: '/bin/echo', args: [], sandbox: true }),
    /"app" is required/,
  );
});

test('destroy() calls the git-broker registry\'s forget() safely for a sandboxed session', { skip: !sandboxAvailable() }, async () => {
  const regPath = join(sandboxTmpRoot, 'gitbroker-registry.json');
  const registry = new GitBrokerRegistry(regPath);
  const store = new PtyStore({ gitBrokerRegistry: registry });
  // gitBroker is off in sandboxCfgPath above, so this session's sandbox
  // object carries no gitBrokerProc -- this test only proves the destroy()
  // -> registry.forget() wiring never throws when there was nothing to
  // forget. A real gitBroker:true run needs a git repo cwd + ssh/gh plumbing
  // well beyond a unit test's scope; git-broker.test.js covers that module
  // directly, and gitBrokerRegistry.test.js covers record()/reapOrphans().
  const cwd = mkdtempSync(join(tmpdir(), 'ccserver-pty-host-proj2-'));
  try {
    const { id } = store.spawn({
      cwd, cols: 80, rows: 24, command: '/bin/echo', args: ['x'], env: { PATH: '/usr/bin:/bin' },
      sandbox: true, app: 'claude',
    });
    assert.doesNotThrow(() => store.destroy(id));
    assert.equal(existsSync(regPath), false, 'nothing was ever recorded, so nothing is left behind');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
