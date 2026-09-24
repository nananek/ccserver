// Issue #212: every state-JSON restore path must refuse a non-regular file
// instead of blocking on it.
//
// A FIFO with no writer does not make readFileSync throw -- it makes it WAIT,
// synchronously, with the event loop stopped. The process cannot run its
// SIGTERM handler while it is in there, so `systemctl --user stop` does
// nothing and only SIGKILL ends it. Two of these run BEFORE fastify.listen()
// (loadSandboxConfig at index.js:407 and restoreNotify at :515), so the
// server never finishes booting at all; the rest run just after it, so the
// server is listening but wedged.
//
// Reading the test output: a FAILING run of this file does not print failures,
// it stops. That is the bug reproducing. Every case therefore carries an
// explicit timeout, which is the only mechanism that can end a synchronous
// block, and the reason these live in their own file -- a hang here does not
// take an unrelated suite's results with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { restoreGroups, groupsPath, groupDocsPath } from './groupManager.js';
import { getGroupFilesManifestPath } from './groupFiles.js';
import { restoreSchedules, peekSavedSessions, savedSessionsPath, schedulesPath } from './sessionManager.js';
import { restoreNotify, notifyPath } from './notify.js';
import { loadSandboxConfig } from './sandbox.js';

const CASE_TIMEOUT = 5000;

// Same skip shape as files.test.js:481 / pathMigration.test.js:405.
function mkfifo(t, path) {
  try {
    execFileSync('mkfifo', [path]);
    return true;
  } catch {
    t.skip('mkfifo unavailable');
    return false;
  }
}

// Point every state path at a fresh temp dir, plant a FIFO at ONE of them, and
// restore the environment afterwards. Everything not named is simply absent,
// which is the case each caller already handles.
const ENV_FOR = {
  savedGroups: 'CCSERVER_GROUPS_PATH',
  savedGroupDocs: 'CCSERVER_GROUP_DOCS_PATH',
  savedGroupFiles: 'CCSERVER_GROUP_FILES_PATH',
  scheduledPrompts: 'CCSERVER_SCHEDULES_PATH',
  savedSessions: 'CCSERVER_SAVED_SESSIONS_PATH',
  savedNotifications: 'CCSERVER_NOTIFY_PATH',
  sandboxConfig: 'CCSERVER_SANDBOX_CONFIG',
};

function withState(t, { fifoAt, files = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-fifo-'));
  const saved = {};
  for (const [id, envVar] of Object.entries(ENV_FOR)) {
    saved[envVar] = process.env[envVar];
    process.env[envVar] = join(dir, `${id}.json`);
  }
  t.after(() => {
    for (const [envVar, prev] of Object.entries(saved)) {
      if (prev === undefined) delete process.env[envVar];
      else process.env[envVar] = prev;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  for (const [id, body] of Object.entries(files)) {
    writeFileSync(join(dir, `${id}.json`), body);
  }
  return mkfifo(t, join(dir, `${fifoAt}.json`));
}

// --- before fastify.listen() -----------------------------------------------

test('#212: loadSandboxConfig refuses a FIFO at sandbox.config.json (pre-listen)',
  { timeout: CASE_TIMEOUT }, (t) => {
  if (!withState(t, { fifoAt: 'sandboxConfig' })) return;
  const cfg = loadSandboxConfig();
  // Deliberately NOT the "start empty" fallback the others get. This file
  // carries security settings (browseRoots, forceSandbox), so an unreadable
  // one is surfaced as configError and index.js refuses to boot -- silently
  // defaulting would drop a setting the operator had made. The pre-existing
  // ENOENT path (no file at all) is untouched and still means "use defaults".
  assert.ok(cfg.configError, 'an unreadable config must be reported, not defaulted away');
  assert.match(cfg.configError, /not a regular file/);
});

test('#212: restoreNotify refuses a FIFO at the notification registry (pre-listen)',
  { timeout: CASE_TIMEOUT }, (t) => {
  if (!withState(t, { fifoAt: 'savedNotifications' })) return;
  const res = restoreNotify();
  assert.ok(Array.isArray(res.subscriptions), 'restore falls back to the seed, as for a missing file');
});

// --- after fastify.listen() ------------------------------------------------

test('#212: restoreGroups refuses a FIFO at saved-groups.json', { timeout: CASE_TIMEOUT }, (t) => {
  if (!withState(t, { fifoAt: 'savedGroups' })) return;
  assert.deepEqual(restoreGroups(), { restored: 0, ids: [] });
});

test('#212: restoreGroups refuses a FIFO at saved-group-docs.json', { timeout: CASE_TIMEOUT }, (t) => {
  // saved-groups.json has to be readable, or the early return above means the
  // docs read is never reached and the case proves nothing.
  if (!withState(t, { fifoAt: 'savedGroupDocs', files: { savedGroups: '[]' } })) return;
  assert.deepEqual(restoreGroups(), { restored: 0, ids: [] });
});

test('#212: restoreGroups refuses a FIFO at saved-group-files.json', { timeout: CASE_TIMEOUT }, (t) => {
  if (!withState(t, { fifoAt: 'savedGroupFiles', files: { savedGroups: '[]' } })) return;
  assert.deepEqual(restoreGroups(), { restored: 0, ids: [] });
});

test('#212: restoreSchedules refuses a FIFO at scheduled-prompts.json', { timeout: CASE_TIMEOUT }, (t) => {
  if (!withState(t, { fifoAt: 'scheduledPrompts' })) return;
  assert.equal(restoreSchedules(), undefined);
});

test('#212: peekSavedSessions refuses a FIFO at saved-sessions.json', { timeout: CASE_TIMEOUT }, (t) => {
  if (!withState(t, { fifoAt: 'savedSessions' })) return;
  assert.equal(peekSavedSessions(), null);
});

// --- and the paths really are the ones production resolves -----------------

test('the env overrides above are the paths the restore code actually reads',
  { timeout: CASE_TIMEOUT }, (t) => {
  // Guards the cases above against going hollow: if a path id were ever
  // renamed, every FIFO would land somewhere nothing reads, the restores
  // would return their empty fallback for the boring reason, and the suite
  // would stay green while the block came back.
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-fifo-paths-'));
  const saved = {};
  for (const [id, envVar] of Object.entries(ENV_FOR)) {
    saved[envVar] = process.env[envVar];
    process.env[envVar] = join(dir, `${id}.json`);
  }
  t.after(() => {
    for (const [envVar, prev] of Object.entries(saved)) {
      if (prev === undefined) delete process.env[envVar];
      else process.env[envVar] = prev;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(groupsPath(), join(dir, 'savedGroups.json'));
  assert.equal(groupDocsPath(), join(dir, 'savedGroupDocs.json'));
  assert.equal(getGroupFilesManifestPath(), join(dir, 'savedGroupFiles.json'));
  assert.equal(schedulesPath(), join(dir, 'scheduledPrompts.json'));
  assert.equal(savedSessionsPath(), join(dir, 'savedSessions.json'));
  assert.equal(notifyPath(), join(dir, 'savedNotifications.json'));
  assert.equal(loadSandboxConfig().configPath, join(dir, 'sandboxConfig.json'));
});
