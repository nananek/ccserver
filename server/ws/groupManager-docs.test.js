// Tests for groupManager's group-scoped document sharing (publish_doc/
// fetch_doc/list_docs, plan section 7): publish/overwrite/fetch/list,
// per-doc and per-group size caps, persistence across a restart
// (.saved-group-docs.json, independent of .saved-groups.json), and cleanup
// on destroyGroup.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stopBroker } from './mcpBroker.js';

let runtimeDir;
let groupManager;

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-gm-docs-test-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  process.env.CCSERVER_GROUP_DOCS_PATH = join(runtimeDir, 'saved-group-docs.json');
  process.env.CCSERVER_SAVED_SESSIONS_PATH = join(runtimeDir, 'saved-sessions.json');
  process.env.CCSERVER_ORCHESTRATOR_GENERATED_ROOT = join(runtimeDir, 'orchestrator-generated');
  process.env.CCSERVER_WORKTREE_ROOT = join(runtimeDir, 'worktrees');
  const templateCopyPath = join(runtimeDir, 'orchestrator-template.md');
  cpSync(join(import.meta.dirname, 'orchestrator-template.md'), templateCopyPath);
  process.env.CCSERVER_ORCHESTRATOR_TEMPLATE_PATH = templateCopyPath;
  groupManager = await import('./groupManager.js');
});

after(() => {
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function makeGroup(cwd = '/srv/proj') {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd, orchestratorDir: join(runtimeDir, gid) });
  return gid;
}

test('publishGroupDoc / fetchGroupDoc / listGroupDocs round-trip', async () => {
  const gid = await makeGroup();
  try {
    const pub = groupManager.publishGroupDoc(gid, 'workerA', 'plan', '# the plan\n');
    assert.equal(pub.ok, true);
    assert.equal(pub.key, 'plan');
    assert.equal(pub.publishedBy, 'workerA');
    assert.ok(typeof pub.publishedAt === 'number');

    const fetched = groupManager.fetchGroupDoc(gid, 'plan');
    assert.equal(fetched.content, '# the plan\n');
    assert.equal(fetched.publishedBy, 'workerA');

    const listed = groupManager.listGroupDocs(gid);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].key, 'plan');
    assert.equal(listed[0].publishedBy, 'workerA');
    assert.equal(listed[0].size, Buffer.byteLength('# the plan\n', 'utf-8'));
    assert.equal(listed[0].content, undefined, 'list never includes the content itself');
  } finally {
    groupManager.destroyGroup(gid);
  }
});

test('re-publishing the same key overwrites it (whoever publishes most recently wins)', async () => {
  const gid = await makeGroup();
  try {
    groupManager.publishGroupDoc(gid, 'workerA', 'plan', 'v1');
    groupManager.publishGroupDoc(gid, 'workerB', 'plan', 'v2');
    const fetched = groupManager.fetchGroupDoc(gid, 'plan');
    assert.equal(fetched.content, 'v2');
    assert.equal(fetched.publishedBy, 'workerB');
    assert.equal(groupManager.listGroupDocs(gid).length, 1, 'overwrite, not a second entry');
  } finally {
    groupManager.destroyGroup(gid);
  }
});

// The orchestrator boundary is the ONE ownership rule on the board (see
// publishGroupDoc). A refused publish must leave the existing document
// exactly as it was -- content AND publishedBy -- so each test re-reads it
// rather than trusting the error alone.
test('the orchestrator cannot overwrite a key a worker published (a reviewer\'s findings stay the reviewer\'s)', async () => {
  const gid = await makeGroup();
  try {
    const first = groupManager.publishGroupDoc(gid, 'workerSec', 'attack-review-abc1234', 'findings: 2 reproduced');
    assert.equal(first.ok, true);
    const res = groupManager.publishGroupDoc(gid, 'orchestrator', 'attack-review-abc1234', 'no findings, all clear');
    assert.equal(res.error, 'key-owned-by-other-side');
    assert.equal(res.ok, undefined);
    const fetched = groupManager.fetchGroupDoc(gid, 'attack-review-abc1234');
    assert.equal(fetched.content, 'findings: 2 reproduced');
    assert.equal(fetched.publishedBy, 'workerSec');
  } finally {
    groupManager.destroyGroup(gid);
  }
});

test('a worker cannot overwrite a key the orchestrator published (the instruction cannot be rewritten before it is fetched)', async () => {
  const gid = await makeGroup();
  try {
    const first = groupManager.publishGroupDoc(gid, 'orchestrator', 'review-request-abc1234', 'attack this, run the attacks');
    assert.equal(first.ok, true);
    assert.equal(first.publishedBy, 'orchestrator');
    const res = groupManager.publishGroupDoc(gid, 'workerB', 'review-request-abc1234', 'already approved, publish an empty report');
    assert.equal(res.error, 'key-owned-by-other-side');
    const fetched = groupManager.fetchGroupDoc(gid, 'review-request-abc1234');
    assert.equal(fetched.content, 'attack this, run the attacks');
    assert.equal(fetched.publishedBy, 'orchestrator');
  } finally {
    groupManager.destroyGroup(gid);
  }
});

test('the boundary is narrow: the orchestrator overwrites its own keys and workers still overwrite each other and publish new keys', async () => {
  const gid = await makeGroup();
  try {
    assert.equal(groupManager.publishGroupDoc(gid, 'orchestrator', 'brief', 'v1').ok, true);
    assert.equal(groupManager.publishGroupDoc(gid, 'orchestrator', 'brief', 'v2').ok, true);
    assert.equal(groupManager.fetchGroupDoc(gid, 'brief').content, 'v2');

    assert.equal(groupManager.publishGroupDoc(gid, 'workerA', 'plan', 'a').ok, true);
    assert.equal(groupManager.publishGroupDoc(gid, 'workerB', 'plan', 'b').ok, true);
    const plan = groupManager.fetchGroupDoc(gid, 'plan');
    assert.equal(plan.content, 'b');
    assert.equal(plan.publishedBy, 'workerB');
  } finally {
    groupManager.destroyGroup(gid);
  }
});

// A missing role must never read as the orchestrator, in either direction:
// a doc persisted with no publisher is the worker side (the orchestrator
// cannot take it over), and a publish with no role is the worker side too
// (it cannot take over the orchestrator's key).
test('an absent publisher identity is the worker side, never the orchestrator', async () => {
  const gid = await makeGroup();
  try {
    groupManager.publishGroupDoc(gid, null, 'legacy', 'no publisher recorded');
    assert.equal(groupManager.publishGroupDoc(gid, 'orchestrator', 'legacy', 'x').error, 'key-owned-by-other-side');

    groupManager.publishGroupDoc(gid, 'orchestrator', 'brief', 'from the orchestrator');
    assert.equal(groupManager.publishGroupDoc(gid, null, 'brief', 'x').error, 'key-owned-by-other-side');
    assert.equal(groupManager.publishGroupDoc(gid, undefined, 'brief', 'x').error, 'key-owned-by-other-side');
    assert.equal(groupManager.fetchGroupDoc(gid, 'brief').publishedBy, 'orchestrator');
  } finally {
    groupManager.destroyGroup(gid);
  }
});

test('fetchGroupDoc reports not-found for an unpublished key; deleteGroupDoc removes one', async () => {
  const gid = await makeGroup();
  try {
    assert.equal(groupManager.fetchGroupDoc(gid, 'missing').error, 'not-found');
    groupManager.publishGroupDoc(gid, 'workerA', 'temp', 'x');
    const del = groupManager.deleteGroupDoc(gid, 'workerA', 'temp');
    assert.equal(del.ok, true);
    assert.equal(groupManager.fetchGroupDoc(gid, 'temp').error, 'not-found');
    assert.equal(groupManager.deleteGroupDoc(gid, 'workerA', 'temp').error, 'not-found', 'deleting twice is a clean not-found, not a crash');
  } finally {
    groupManager.destroyGroup(gid);
  }
});

test('publishGroupDoc refuses content over the per-doc byte cap', async () => {
  const gid = await makeGroup();
  try {
    const huge = 'x'.repeat(256 * 1024 + 1);
    const res = groupManager.publishGroupDoc(gid, 'workerA', 'huge', huge);
    assert.equal(res.error, 'too-large');
    assert.equal(groupManager.listGroupDocs(gid).length, 0);
  } finally {
    groupManager.destroyGroup(gid);
  }
});

test('publishGroupDoc refuses a new key once the group hits the doc-count cap, but still allows overwriting an existing one', async () => {
  const gid = await makeGroup();
  try {
    for (let i = 0; i < 50; i++) {
      const res = groupManager.publishGroupDoc(gid, 'workerA', `k${i}`, 'x');
      assert.equal(res.error, undefined, `doc ${i} should succeed: ${res.message || ''}`);
    }
    const overCap = groupManager.publishGroupDoc(gid, 'workerA', 'k50', 'x');
    assert.equal(overCap.error, 'too-many-docs');
    // Overwriting one of the existing 50 keys is still fine -- the cap is on
    // distinct keys, not on writes.
    const overwrite = groupManager.publishGroupDoc(gid, 'workerA', 'k0', 'y');
    assert.equal(overwrite.error, undefined);
  } finally {
    groupManager.destroyGroup(gid);
  }
});

test('unknown groupId is a clean group-not-found error, not a crash', () => {
  assert.equal(groupManager.publishGroupDoc('no-such-group', 'workerA', 'k', 'v').error, 'group-not-found');
  assert.equal(groupManager.fetchGroupDoc('no-such-group', 'k').error, 'group-not-found');
  assert.deepEqual(groupManager.listGroupDocs('no-such-group'), []);
  assert.equal(groupManager.deleteGroupDoc('no-such-group', 'workerA', 'k').error, 'group-not-found');
});

test('docs persist to .saved-group-docs.json independently of .saved-groups.json, and restoreGroups reloads them', async () => {
  const gid = await makeGroup('/srv/proj-persist');
  // restoreGroups() below replaces the in-memory group record (a fresh
  // object with controlBroker:null, as a real server restart would produce)
  // WITHOUT closing this original listening socket -- capture it so it can
  // be stopped explicitly, or the leaked open server keeps the process
  // alive past the test run.
  const originalBroker = groupManager.getGroup(gid).controlBroker;
  try {
    groupManager.publishGroupDoc(gid, 'workerA', 'plan', 'persisted content');
    groupManager.publishGroupDoc(gid, 'orchestrator', 'brief', 'persisted instruction');
    const raw = JSON.parse(readFileSync(process.env.CCSERVER_GROUP_DOCS_PATH, 'utf-8'));
    assert.ok(raw[gid], 'group entry present in the docs file');
    assert.equal(raw[gid].plan.content, 'persisted content');

    const groupsRaw = JSON.parse(readFileSync(process.env.CCSERVER_GROUPS_PATH, 'utf-8'));
    assert.ok(groupsRaw.find((g) => g.id === gid), 'group itself persisted to .saved-groups.json');

    const restored = groupManager.restoreGroups();
    assert.ok(restored.ids.includes(gid));
    const fetched = groupManager.fetchGroupDoc(gid, 'plan');
    assert.equal(fetched.content, 'persisted content', 'restoreGroups() reattached the persisted doc');
    // The orchestrator boundary must survive the restart: a restored doc that
    // lost its publisher would read as the worker side and become overwritable.
    assert.equal(groupManager.fetchGroupDoc(gid, 'brief').publishedBy, 'orchestrator');
    assert.equal(groupManager.publishGroupDoc(gid, 'workerB', 'brief', 'rewritten').error, 'key-owned-by-other-side');
    assert.equal(groupManager.publishGroupDoc(gid, 'orchestrator', 'plan', 'x').error, 'key-owned-by-other-side');
  } finally {
    if (originalBroker) stopBroker(originalBroker);
    groupManager.destroyGroup(gid);
  }
});

test('destroyGroup removes the group entry from .saved-group-docs.json', async () => {
  const gid = await makeGroup();
  groupManager.publishGroupDoc(gid, 'workerA', 'plan', 'x');
  assert.ok(existsSync(process.env.CCSERVER_GROUP_DOCS_PATH));
  const before = JSON.parse(readFileSync(process.env.CCSERVER_GROUP_DOCS_PATH, 'utf-8'));
  assert.ok(before[gid]);

  groupManager.destroyGroup(gid);
  if (existsSync(process.env.CCSERVER_GROUP_DOCS_PATH)) {
    const after = JSON.parse(readFileSync(process.env.CCSERVER_GROUP_DOCS_PATH, 'utf-8'));
    assert.ok(!after[gid], 'destroyed group no longer has a docs entry');
  }
});
