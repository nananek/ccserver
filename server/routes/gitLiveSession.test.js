// POST /api/git/clone against REAL running sessions (#278, owner decision): a
// destination that is, or lies under, the working directory of a session that
// has not exited is refused with 409 before gh / git is started.
//
// ghClone.test.js covers the comparison with an injected list of directories;
// this file covers the wiring -- that the route hands the guard the actual
// session registry (sessionManager.liveSessionCwds) -- with real shell
// sessions, so a route that passed an empty list, or the wrong list, is red.
//
// Its own file because it needs sessionManager's environment set before that
// module is imported (same arrangement as ws/sessionSharingDisabled.test.js).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let sessionManager;
let app;
let base;
let called;
let counter = 0;
const created = [];

const uniq = (name) => join(base, `${name}-${counter++}`);

async function newShell(cwd, extra = {}) {
  const res = await sessionManager.createSession({ cwd, cols: 80, rows: 24, shell: true, sandbox: false, ...extra });
  assert.ok(res.session, 'shell session should spawn');
  created.push(res.sessionId);
  return res;
}

const clone = (parent, url = 'o/r') => app.inject({ method: 'POST', url: '/api/git/clone', payload: { parent, url } });

before(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ccserver-gitlive-')));
  process.env.XDG_RUNTIME_DIR = base;
  process.env.CCSERVER_GROUPS_PATH = join(base, 'saved-groups.json');
  process.env.CCSERVER_ORCHESTRATOR_GENERATED_ROOT = join(base, 'orchestrator-generated');
  sessionManager = await import('../ws/sessionManager.js');
  const { gitRoute } = await import('./git.js');

  called = join(base, 'gh-called');
  const gh = join(base, 'gh');
  writeFileSync(gh, `#!/bin/sh\ntouch '${called}'\nmkdir -p "$4"\ngit init -q -b main "$4"\ngit -C "$4" remote add origin "$3"\n`);
  chmodSync(gh, 0o755);
  app = Fastify();
  await app.register(gitRoute, { prefix: '/api', clone: { ghBin: gh, slots: { active: 0 } } });
});

after(async () => {
  for (const id of created) {
    try { sessionManager.destroySession(id, { reason: 'test' }); } catch { /* already gone */ }
  }
  sessionManager.destroyAllSessions();
  try { await app.close(); } catch { /* closed */ }
  rmSync(base, { recursive: true, force: true });
});

test('a shell session\'s cwd, and everything under it, cannot be cloned into while it runs', async () => {
  const cwd = uniq('project');
  const below = join(cwd, 'sub');
  mkdirSync(below, { recursive: true });
  const { sessionId } = await newShell(cwd);

  for (const parent of [cwd, below]) {
    const res = await clone(parent);
    assert.equal(res.statusCode, 409, `${parent}: ${res.body}`);
    assert.match(res.json().error, /running session/);
    assert.ok(!res.body.includes(cwd), 'the answer names no path');
    assert.ok(!res.body.includes(sessionId), 'and no session');
  }
  assert.ok(!existsSync(called), 'gh was never started');
  assert.ok(!existsSync(join(cwd, 'r')) && !existsSync(join(below, 'r')));
});

test('the check is by real path: the same directory reached through a symlink is refused too', async () => {
  const cwd = uniq('project');
  mkdirSync(cwd);
  const alias = uniq('alias');
  symlinkSync(cwd, alias);
  await newShell(cwd);
  const res = await clone(alias);
  assert.equal(res.statusCode, 409, res.body);
  assert.ok(!existsSync(join(cwd, 'r')));
});

test('a directory beside a session is not blocked; the guard lifts when the session ends', async () => {
  const cwd = uniq('project');
  const beside = uniq('beside');
  mkdirSync(cwd);
  mkdirSync(beside);
  const { sessionId } = await newShell(cwd);

  const other = await clone(beside);
  assert.equal(other.statusCode, 200, other.body);
  assert.ok(existsSync(join(beside, 'r', '.git')));

  assert.equal((await clone(cwd)).statusCode, 409);
  sessionManager.destroySession(sessionId, { reason: 'test' });
  assert.ok(!sessionManager.liveSessionCwds().includes(cwd), 'a destroyed session is not live');
  const after = await clone(cwd);
  assert.equal(after.statusCode, 200, after.body);
  assert.ok(existsSync(join(cwd, 'r', '.git')));
});

test('a session whose process has exited does not block, though it stays in the registry until it is destroyed', async () => {
  const cwd = uniq('project');
  mkdirSync(cwd);
  const { sessionId, session } = await newShell(cwd);
  assert.equal((await clone(cwd)).statusCode, 409, 'positive control: while it runs, it blocks');

  session.ptyProcess.kill();
  for (let i = 0; i < 250 && !session.exited; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(session.exited, true, 'the shell exited');
  assert.equal(sessionManager.getSession(sessionId), session, 'and its (dead) session is still registered');
  assert.ok(!sessionManager.liveSessionCwds().includes(cwd));

  const res = await clone(cwd);
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(existsSync(join(cwd, 'r', '.git')));
});

test('a combo-group member counts like any session: its worktree cwd, and what is under it', async () => {
  // Group members are created through the same createSession with a groupId /
  // groupRole and a server-synthesized cwd (scratchCwd), and live in the same
  // registry. A shell stands in for the agent: the registry entry is what matters.
  const worktree = uniq('worktree');
  const below = join(worktree, 'src');
  mkdirSync(below, { recursive: true });
  const { session } = await newShell(worktree, { groupId: 'g-test', groupRole: 'worker-x', scratchCwd: true });
  assert.equal(session.groupId, 'g-test', 'it is a group member');
  for (const parent of [worktree, below]) {
    const res = await clone(parent);
    assert.equal(res.statusCode, 409, `${parent}: ${res.body}`);
  }
  assert.ok(!existsSync(join(worktree, 'r')));
});
