// Tests for groupManager's group-scoped document sharing (publish_doc/
// fetch_doc/list_docs/delete_doc, plan section 7): publish/overwrite/fetch/
// list/delete (delete is the orchestrator's alone), per-doc and per-group
// size caps, persistence across a restart
// (.saved-group-docs.json, independent of .saved-groups.json), and cleanup
// on destroyGroup.

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, existsSync, rmSync } from 'node:fs';
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
    const del = groupManager.deleteGroupDoc(gid, 'orchestrator', 'temp');
    assert.equal(del.ok, true);
    assert.equal(groupManager.fetchGroupDoc(gid, 'temp').error, 'not-found');
    assert.equal(groupManager.deleteGroupDoc(gid, 'orchestrator', 'temp').error, 'not-found', 'deleting twice is a clean not-found, not a crash');
  } finally {
    groupManager.destroyGroup(gid);
  }
});

// Deleting is the orchestrator's alone (#276), and it reaches every document:
// the publish-side ownership boundary does not apply to it.
test('the orchestrator deletes any document, its own and every worker\'s', async () => {
  const gid = await makeGroup();
  try {
    groupManager.publishGroupDoc(gid, 'workerA', 'plan', 'a');
    groupManager.publishGroupDoc(gid, 'workerSec', 'attack-review-abc1234', 'findings');
    groupManager.publishGroupDoc(gid, 'orchestrator', 'brief', 'b');
    for (const key of ['plan', 'attack-review-abc1234', 'brief']) {
      assert.deepEqual(groupManager.deleteGroupDoc(gid, 'orchestrator', key), { ok: true }, `delete ${key}`);
      assert.equal(groupManager.fetchGroupDoc(gid, key).error, 'not-found');
    }
    assert.equal(groupManager.listGroupDocs(gid).length, 0);
  } finally {
    groupManager.destroyGroup(gid);
  }
});

test('no role but the orchestrator can delete, and a refused delete leaves the document intact', async () => {
  const gid = await makeGroup();
  try {
    groupManager.publishGroupDoc(gid, 'workerA', 'plan', 'worker doc');
    groupManager.publishGroupDoc(gid, 'orchestrator', 'brief', 'orchestrator doc');
    // A worker role (its own doc and the orchestrator's), an absent role, and
    // near-misses of the string: none of them is the orchestrator.
    for (const role of ['workerA', 'workerSec', null, undefined, '', 'Orchestrator', 'orchestrator ', 'orchestrator\n']) {
      for (const key of ['plan', 'brief']) {
        const res = groupManager.deleteGroupDoc(gid, role, key);
        assert.equal(res.error, 'forbidden', `role ${JSON.stringify(role)} deleting ${key}`);
        assert.equal(res.ok, undefined);
      }
    }
    assert.equal(groupManager.fetchGroupDoc(gid, 'plan').content, 'worker doc');
    assert.equal(groupManager.fetchGroupDoc(gid, 'brief').content, 'orchestrator doc');
    assert.equal(groupManager.fetchGroupDoc(gid, 'brief').publishedBy, 'orchestrator');
    assert.equal(groupManager.listGroupDocs(gid).length, 2);
    // Refused before the group is looked up, so a forged role learns nothing
    // about which groups exist.
    assert.equal(groupManager.deleteGroupDoc('no-such-group', 'workerA', 'k').error, 'forbidden');
  } finally {
    groupManager.destroyGroup(gid);
  }
});

test('a deleted key is free again: a worker publishes it, and so does the orchestrator', async () => {
  const gid = await makeGroup();
  try {
    // orchestrator's key -> a worker takes it over (it could not while it was held)
    groupManager.publishGroupDoc(gid, 'orchestrator', 'brief', 'first');
    assert.equal(groupManager.publishGroupDoc(gid, 'workerB', 'brief', 'x').error, 'key-owned-by-other-side');
    assert.equal(groupManager.deleteGroupDoc(gid, 'orchestrator', 'brief').ok, true);
    const taken = groupManager.publishGroupDoc(gid, 'workerB', 'brief', 'worker text');
    assert.equal(taken.ok, true);
    assert.equal(groupManager.fetchGroupDoc(gid, 'brief').publishedBy, 'workerB');

    // worker's key -> the orchestrator takes it over, and what it publishes is
    // recorded as the orchestrator's, never as the reviewer's
    groupManager.publishGroupDoc(gid, 'workerSec', 'attack-review-abc1234', 'reviewer findings');
    assert.equal(groupManager.publishGroupDoc(gid, 'orchestrator', 'attack-review-abc1234', 'all clear').error, 'key-owned-by-other-side');
    assert.equal(groupManager.deleteGroupDoc(gid, 'orchestrator', 'attack-review-abc1234').ok, true);
    const replaced = groupManager.publishGroupDoc(gid, 'orchestrator', 'attack-review-abc1234', 'all clear');
    assert.equal(replaced.ok, true);
    assert.equal(replaced.publishedBy, 'orchestrator');
    assert.equal(groupManager.fetchGroupDoc(gid, 'attack-review-abc1234').publishedBy, 'orchestrator');
    assert.notEqual(groupManager.fetchGroupDoc(gid, 'attack-review-abc1234').publishedBy, 'workerSec');
  } finally {
    groupManager.destroyGroup(gid);
  }
});

test('getGroupDocUsage reports count and the group limit, and follows publish and delete', async () => {
  const gid = await makeGroup();
  try {
    assert.deepEqual(groupManager.getGroupDocUsage(gid), { count: 0, limit: 50 });
    groupManager.publishGroupDoc(gid, 'workerA', 'a', 'x');
    groupManager.publishGroupDoc(gid, 'orchestrator', 'b', 'x');
    groupManager.publishGroupDoc(gid, 'workerA', 'a', 'again');
    assert.deepEqual(groupManager.getGroupDocUsage(gid), { count: 2, limit: 50 }, 'an overwrite is not a second document');
    groupManager.deleteGroupDoc(gid, 'orchestrator', 'a');
    assert.deepEqual(groupManager.getGroupDocUsage(gid), { count: 1, limit: 50 });
    assert.deepEqual(groupManager.getGroupDocUsage('no-such-group'), { count: 0, limit: 50 });
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

// #276: the orchestrator has no ceiling of its own (#274's 20 was removed).
// The one limit is the group's 50, whoever the documents belong to; the
// orchestrator keeps under it by deleting, and sees the usage in list_docs.
test('the orchestrator has no ceiling of its own: the 21st document and beyond are accepted, up to the group limit', async () => {
  const gid = await makeGroup();
  try {
    for (let i = 0; i < 50; i++) {
      const res = groupManager.publishGroupDoc(gid, 'orchestrator', `o${i}`, 'x');
      assert.equal(res.error, undefined, `orchestrator doc ${i} should succeed: ${res.message || ''}`);
    }
    assert.equal(groupManager.listGroupDocs(gid).length, 50);
    assert.deepEqual(groupManager.getGroupDocUsage(gid), { count: 50, limit: 50 });
    // 50 is the group limit for everyone: the 51st is refused for either side
    const over = groupManager.publishGroupDoc(gid, 'orchestrator', 'o50', 'x');
    assert.equal(over.error, 'too-many-docs');
    assert.equal(groupManager.publishGroupDoc(gid, 'workerB', 'w0', 'x').error, 'too-many-docs');
    assert.equal(groupManager.fetchGroupDoc(gid, 'o50').error, 'not-found', 'the refused doc was not stored');
    // ... and it says who can fix it and how
    assert.match(over.message, /50 published documents/);
    assert.match(over.message, /only the orchestrator can free a slot/);
    assert.match(over.message, /list_docs/);
    assert.match(over.message, /delete_doc/);
    // overwriting an existing key adds no document, so it still works at the limit
    assert.equal(groupManager.publishGroupDoc(gid, 'orchestrator', 'o0', 'y').ok, true);
    // deleting one frees exactly one slot, for a worker or for the orchestrator
    assert.equal(groupManager.deleteGroupDoc(gid, 'orchestrator', 'o1').ok, true);
    assert.equal(groupManager.publishGroupDoc(gid, 'workerB', 'w0', 'x').ok, true);
    assert.equal(groupManager.publishGroupDoc(gid, 'orchestrator', 'o50', 'x').error, 'too-many-docs', 'the freed slot went to the worker');
    assert.deepEqual(groupManager.getGroupDocUsage(gid), { count: 50, limit: 50 });
  } finally {
    groupManager.destroyGroup(gid);
  }
});

test('unknown groupId is a clean group-not-found error, not a crash', () => {
  assert.equal(groupManager.publishGroupDoc('no-such-group', 'workerA', 'k', 'v').error, 'group-not-found');
  assert.equal(groupManager.fetchGroupDoc('no-such-group', 'k').error, 'group-not-found');
  assert.deepEqual(groupManager.listGroupDocs('no-such-group'), []);
  assert.equal(groupManager.deleteGroupDoc('no-such-group', 'orchestrator', 'k').error, 'group-not-found');
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

test('a deleted doc stays deleted after a restart, and its key is free to publish again', async () => {
  const gid = await makeGroup('/srv/proj-persist-delete');
  const originalBroker = groupManager.getGroup(gid).controlBroker;
  try {
    groupManager.publishGroupDoc(gid, 'workerA', 'plan', 'kept');
    groupManager.publishGroupDoc(gid, 'workerSec', 'attack-review-abc1234', 'findings to delete');
    groupManager.publishGroupDoc(gid, 'orchestrator', 'brief', 'instruction to delete');
    assert.equal(groupManager.deleteGroupDoc(gid, 'orchestrator', 'attack-review-abc1234').ok, true);
    assert.equal(groupManager.deleteGroupDoc(gid, 'orchestrator', 'brief').ok, true);

    // the file already reflects it -- persisted at delete time, not at exit
    const raw = JSON.parse(readFileSync(process.env.CCSERVER_GROUP_DOCS_PATH, 'utf-8'));
    assert.deepEqual(Object.keys(raw[gid]), ['plan']);

    // restart: the in-memory group is rebuilt from disk
    const restored = groupManager.restoreGroups();
    assert.ok(restored.ids.includes(gid));
    assert.equal(groupManager.fetchGroupDoc(gid, 'plan').content, 'kept');
    assert.equal(groupManager.fetchGroupDoc(gid, 'attack-review-abc1234').error, 'not-found', 'the deleted doc did not come back');
    assert.equal(groupManager.fetchGroupDoc(gid, 'brief').error, 'not-found', 'the deleted doc did not come back');
    assert.deepEqual(groupManager.getGroupDocUsage(gid), { count: 1, limit: 50 });
    // and the keys are free for a worker, after the restart too
    assert.equal(groupManager.publishGroupDoc(gid, 'workerB', 'brief', 'worker text').ok, true);
    assert.equal(groupManager.publishGroupDoc(gid, 'workerSec', 'attack-review-abc1234', 'new findings').ok, true);

    // deleting the last remaining docs leaves nothing to restore
    for (const key of ['plan', 'brief', 'attack-review-abc1234']) groupManager.deleteGroupDoc(gid, 'orchestrator', key);
    if (existsSync(process.env.CCSERVER_GROUP_DOCS_PATH)) {
      assert.ok(!JSON.parse(readFileSync(process.env.CCSERVER_GROUP_DOCS_PATH, 'utf-8'))[gid], 'no docs entry left for the group');
    }
    groupManager.restoreGroups();
    assert.deepEqual(groupManager.listGroupDocs(gid), []);
  } finally {
    const current = groupManager.getGroup(gid);
    if (current && current.controlBroker && current.controlBroker !== originalBroker) stopBroker(current.controlBroker);
    if (originalBroker) stopBroker(originalBroker);
    groupManager.destroyGroup(gid);
  }
});

// --- a failed write to disk is reported, not swallowed (#280) ---------------
// delete_doc's description promises the deletion survives a restart. When the
// write behind that promise fails, the caller has to be told: otherwise the
// document is back after the next restart and nobody ever learned it might be.
// The success shape is unchanged ({ ok: true }); `persisted: false` is only
// ADDED when the file could not be written.

// Runs fn with the docs file pointed at a DIRECTORY (writeFileSync and
// unlinkSync on it both fail, whoever the user is), collecting console.warn.
async function withUnwritableDocsFile(fn) {
  const dir = join(runtimeDir, `docs-file-is-a-dir-${randomUUID()}`);
  mkdirSync(dir);
  const good = process.env.CCSERVER_GROUP_DOCS_PATH;
  const warnings = [];
  const realWarn = console.warn;
  process.env.CCSERVER_GROUP_DOCS_PATH = dir;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    return await fn(warnings);
  } finally {
    console.warn = realWarn;
    process.env.CCSERVER_GROUP_DOCS_PATH = good;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('publish_doc: a failed write to disk is logged and reported as persisted:false; the success shape is unchanged', async () => {
  const gid = await makeGroup();
  try {
    const good = groupManager.publishGroupDoc(gid, 'workerA', 'ok', 'x');
    assert.equal(good.ok, true);
    assert.equal('persisted' in good, false, 'control: a successful write adds nothing to the result');

    await withUnwritableDocsFile((warnings) => {
      const res = groupManager.publishGroupDoc(gid, 'workerA', 'not-on-disk', 'y');
      assert.equal(res.ok, true, 'the document is published (in memory)');
      assert.equal(res.persisted, false);
      assert.equal(res.key, 'not-on-disk');
      assert.equal(groupManager.fetchGroupDoc(gid, 'not-on-disk').content, 'y');
      assert.match(warnings.join('\n'), /could not persist the group docs/);
    });
  } finally {
    groupManager.destroyGroup(gid);
  }
});

test('delete_doc: a failed write is reported, and the deleted document does come back after a restart -- which is what the flag warns about', async () => {
  const gid = await makeGroup('/srv/proj-persist-fail');
  const originalBroker = groupManager.getGroup(gid).controlBroker;
  try {
    groupManager.publishGroupDoc(gid, 'workerA', 'plan', 'on disk');
    assert.deepEqual(groupManager.publishGroupDoc(gid, 'workerA', 'other', 'x').persisted, undefined, 'control: writes work');
    assert.ok(JSON.parse(readFileSync(process.env.CCSERVER_GROUP_DOCS_PATH, 'utf-8'))[gid].plan, 'control: it is on disk');

    await withUnwritableDocsFile((warnings) => {
      assert.deepEqual(groupManager.deleteGroupDoc(gid, 'orchestrator', 'plan'), { ok: true, persisted: false });
      assert.equal(groupManager.fetchGroupDoc(gid, 'plan').error, 'not-found', 'deleted in memory');
      assert.match(warnings.join('\n'), /could not persist the group docs/);
    });

    // the file still has it: a restart brings the "deleted" document back
    groupManager.restoreGroups();
    assert.equal(groupManager.fetchGroupDoc(gid, 'plan').content, 'on disk');
  } finally {
    const current = groupManager.getGroup(gid);
    if (current && current.controlBroker && current.controlBroker !== originalBroker) stopBroker(current.controlBroker);
    if (originalBroker) stopBroker(originalBroker);
    groupManager.destroyGroup(gid);
  }
});

test('delete_doc of the last document: a stale file that cannot be removed is reported too; a file that is simply absent is not a failure', async () => {
  const gid = await makeGroup();
  try {
    groupManager.publishGroupDoc(gid, 'workerA', 'only', 'x');
    await withUnwritableDocsFile(() => {
      assert.deepEqual(groupManager.deleteGroupDoc(gid, 'orchestrator', 'only'), { ok: true, persisted: false }, 'nothing left to write, but the old file cannot be removed');
    });

    groupManager.publishGroupDoc(gid, 'workerA', 'again', 'x');
    rmSync(process.env.CCSERVER_GROUP_DOCS_PATH, { force: true });
    assert.deepEqual(groupManager.deleteGroupDoc(gid, 'orchestrator', 'again'), { ok: true }, 'no file to remove is the normal case');
  } finally {
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

test('re-publishing keeps createdAt (first publish) while publishedAt follows the overwrite; list and fetch both report it', async () => {
  const gid = await makeGroup();
  const now = mock.method(Date, 'now', () => 1_000);
  try {
    const first = groupManager.publishGroupDoc(gid, 'workerA', 'plan', 'v1');
    assert.equal(first.createdAt, 1_000);
    assert.equal(first.publishedAt, 1_000);

    now.mock.mockImplementation(() => 5_000);
    const second = groupManager.publishGroupDoc(gid, 'workerB', 'plan', 'v2');
    assert.equal(second.createdAt, 1_000, 'overwrite must not move createdAt');
    assert.equal(second.publishedAt, 5_000, 'publishedAt keeps meaning "last publish"');

    const fetched = groupManager.fetchGroupDoc(gid, 'plan');
    assert.equal(fetched.createdAt, 1_000);
    assert.equal(fetched.publishedAt, 5_000);
    const [listed] = groupManager.listGroupDocs(gid);
    assert.equal(listed.createdAt, 1_000);
    assert.equal(listed.publishedAt, 5_000);

    // A different key published later gets its own createdAt.
    now.mock.mockImplementation(() => 9_000);
    assert.equal(groupManager.publishGroupDoc(gid, 'workerA', 'other', 'x').createdAt, 9_000);
  } finally {
    now.mock.restore();
    groupManager.destroyGroup(gid);
  }
});

test('createdAt is persisted and restored; a doc saved before createdAt existed falls back to its publishedAt', async () => {
  const gid = await makeGroup('/srv/proj-created-at');
  const originalBroker = groupManager.getGroup(gid).controlBroker;
  const now = mock.method(Date, 'now', () => 1_000);
  try {
    groupManager.publishGroupDoc(gid, 'workerA', 'kept', 'v1');
    now.mock.mockImplementation(() => 5_000);
    groupManager.publishGroupDoc(gid, 'workerA', 'kept', 'v2');
    now.mock.mockImplementation(() => 2_000);
    groupManager.publishGroupDoc(gid, 'workerA', 'legacy', 'old');
    now.mock.restore();

    const raw = JSON.parse(readFileSync(process.env.CCSERVER_GROUP_DOCS_PATH, 'utf-8'));
    assert.equal(raw[gid].kept.createdAt, 1_000, 'createdAt is written to the docs file');
    // Rewrite the file the way a pre-createdAt server left it.
    delete raw[gid].legacy.createdAt;
    writeFileSync(process.env.CCSERVER_GROUP_DOCS_PATH, JSON.stringify(raw));

    groupManager.restoreGroups();
    const kept = groupManager.fetchGroupDoc(gid, 'kept');
    assert.equal(kept.createdAt, 1_000);
    assert.equal(kept.publishedAt, 5_000);
    const legacy = groupManager.fetchGroupDoc(gid, 'legacy');
    assert.equal(legacy.publishedAt, 2_000);
    assert.equal(legacy.createdAt, 2_000, 'no recorded createdAt -> publishedAt');
  } finally {
    now.mock.restore();
    if (originalBroker) stopBroker(originalBroker);
    groupManager.destroyGroup(gid);
  }
});

test('restoreGroups treats a non-finite createdAt/publishedAt as missing (JSON.parse turns 1e999 into Infinity)', async () => {
  const gid = await makeGroup('/srv/proj-non-finite');
  const originalBroker = groupManager.getGroup(gid).controlBroker;
  try {
    // JSON.stringify writes Infinity as null, so plant the literals by hand.
    const doc = (publishedAt, createdAt) => ({ content: 'x', publishedBy: 'workerA', publishedAt, createdAt });
    const text = JSON.stringify({
      [gid]: {
        bothPosInf: doc('+INF', '+INF'),
        publishedNegInf: doc('-INF', 5_000),
        createdPosInf: doc(4_000, '+INF'),
        createdNegInf: doc(4_000, '-INF'),
      },
    }).replaceAll('"+INF"', '1e999').replaceAll('"-INF"', '-1e999');
    writeFileSync(process.env.CCSERVER_GROUP_DOCS_PATH, text);
    const planted = JSON.parse(text)[gid];
    assert.equal(planted.bothPosInf.createdAt, Infinity, 'the fixture really carries Infinity');
    assert.equal(planted.publishedNegInf.publishedAt, -Infinity);

    const t0 = Date.now();
    groupManager.restoreGroups();
    const t1 = Date.now();

    const get = (key) => groupManager.fetchGroupDoc(gid, key);
    for (const key of ['bothPosInf', 'publishedNegInf', 'createdPosInf', 'createdNegInf']) {
      assert.ok(get(key).content === 'x', `${key} was restored from the file`);
      assert.ok(Number.isFinite(get(key).publishedAt), `${key}.publishedAt is finite`);
      assert.ok(Number.isFinite(get(key).createdAt), `${key}.createdAt is finite`);
    }
    // publishedAt: same as a missing one -- the restore time.
    for (const key of ['bothPosInf', 'publishedNegInf']) {
      assert.ok(get(key).publishedAt >= t0 && get(key).publishedAt <= t1, `${key}.publishedAt falls back to now`);
    }
    // createdAt: same as a missing one -- the doc's publishedAt; a finite one is kept.
    assert.equal(get('bothPosInf').createdAt, get('bothPosInf').publishedAt);
    assert.equal(get('publishedNegInf').createdAt, 5_000);
    assert.equal(get('createdPosInf').createdAt, 4_000);
    assert.equal(get('createdNegInf').createdAt, 4_000);
  } finally {
    if (originalBroker) stopBroker(originalBroker);
    groupManager.destroyGroup(gid);
  }
});
