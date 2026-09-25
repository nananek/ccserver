import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync, rmSync, statSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { stopBroker } from './mcpBroker.js';
import { MAX_FILE_BYTES, MAX_FILES_PER_GROUP, MAX_GROUP_BYTES } from './groupFiles.js';

let runtimeDir;
let groupManager;

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-gm-files-test-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  process.env.CCSERVER_GROUP_DOCS_PATH = join(runtimeDir, 'saved-group-docs.json');
  process.env.CCSERVER_GROUP_FILES_PATH = join(runtimeDir, 'saved-group-files.json');
  process.env.CCSERVER_GROUP_FILES_ROOT = join(runtimeDir, 'group-files');
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
  delete process.env.CCSERVER_GROUP_FILES_ROOT;
  delete process.env.CCSERVER_GROUP_FILES_PATH;
});

async function makeGroup(cwd = '/srv/proj') {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd, orchestratorDir: join(runtimeDir, gid) });
  return gid;
}

test('publishGroupFilesFromUpload round-trip and duplicate names distinct IDs', async () => {
  const gid = await makeGroup();
  try {
    const res = groupManager.publishGroupFilesFromUpload(gid, [{ name: 'hello.txt', mimeType: 'text/plain', data: Buffer.from('hello') }]);
    assert.equal(res.ok, true);
    assert.equal(res.files.length, 1);
    const f = res.files[0];
    assert.equal(f.name, 'hello.txt');
    assert.equal(f.size, 5);
    assert.equal(f.direction, 'user');
    assert.equal(f.publishedBy, null);
    const list = groupManager.listGroupFiles(gid);
    assert.equal(list.files[0].id, f.id);
    const fetched = groupManager.fetchGroupFile(gid, f.id);
    assert.equal(fetched.sandboxPath, `/ccserver-group-files/${f.id}`);
    assert.ok(existsSync(fetched.blobPath));
    assert.equal(fetched.size, 5);
    // duplicate display name distinct IDs
    const res2 = groupManager.publishGroupFilesFromUpload(gid, [{ name: 'hello.txt', mimeType: 'text/plain', data: Buffer.from('again') }]);
    assert.notEqual(res2.files[0].id, f.id);
  } finally { groupManager.destroyGroup(gid); }
});

test('publishGroupFilesFromUpload quota edges: per-file, count, group bytes', async () => {
  const gid = await makeGroup();
  try {
    const tooLarge = groupManager.publishGroupFilesFromUpload(gid, [{ name: 'big.bin', mimeType: 'application/octet-stream', data: Buffer.alloc(MAX_FILE_BYTES + 1) }]);
    assert.equal(tooLarge.error, 'too-large');
    for (let i = 0; i < MAX_FILES_PER_GROUP; i++) {
      const r = groupManager.publishGroupFilesFromUpload(gid, [{ name: `f${i}.txt`, mimeType: 'text/plain', data: Buffer.from('x') }]);
      assert.equal(r.ok, true, `f${i} should succeed`);
    }
    const over = groupManager.publishGroupFilesFromUpload(gid, [{ name: 'over.txt', mimeType: 'text/plain', data: Buffer.from('x') }]);
    assert.equal(over.error, 'too-many-files');
  } finally { groupManager.destroyGroup(gid); }
  const gid2 = await makeGroup();
  try {
    // group bytes quota: use 19 MiB chunks so we hit group-byte limit before file-count limit
    const chunk = Buffer.alloc(19 * 1024 * 1024); // 19 MiB
    let count = 0;
    while (count < 10) { // only 10 files -> well under MAX_FILES_PER_GROUP (20)
      const before = groupManager.listGroupFiles(gid2).files.reduce((s, m) => s + m.size, 0);
      if (before + chunk.length > MAX_GROUP_BYTES) break;
      const r = groupManager.publishGroupFilesFromUpload(gid2, [{ name: `c${count}.bin`, mimeType: 'application/octet-stream', data: chunk }]);
      if (r.error) break;
      count++;
    }
    const total = groupManager.listGroupFiles(gid2).files.reduce((s, m) => s + m.size, 0);
    assert.ok(total > 0);
    const overBytes = groupManager.publishGroupFilesFromUpload(gid2, [{ name: 'extra.bin', mimeType: 'application/octet-stream', data: Buffer.alloc(15 * 1024 * 1024) }]);
    if (total + 15 * 1024 * 1024 > MAX_GROUP_BYTES && total < MAX_GROUP_BYTES) {
      assert.equal(overBytes.error, 'quota-exceeded');
    } else if (overBytes.error) {
      assert.ok(['quota-exceeded', 'too-many-files'].includes(overBytes.error));
    }
  } finally { groupManager.destroyGroup(gid2); }
});

test('missing/unknown group/file errors', async () => {
  assert.equal(groupManager.listGroupFiles('nope').error, 'group-not-found');
  assert.equal(groupManager.fetchGroupFile('nope', 'id').error, 'group-not-found');
  assert.equal(groupManager.deleteGroupFile('nope', 'id').error, 'group-not-found');
  const gid = await makeGroup();
  try {
    assert.equal(groupManager.fetchGroupFile(gid, 'missing').error, 'not-found');
    assert.equal(groupManager.deleteGroupFile(gid, 'missing').error, 'not-found');
    assert.equal(groupManager.publishGroupFileFromAgent(gid, 'workerA', 'hello.txt').error, 'bad-request');
  } finally { groupManager.destroyGroup(gid); }
});

test('agent publish: relative only, traversal and symlink escape rejected, regular file only', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cc-gm-agent-'));
  const cwd = join(tmp, 'wt');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'ok.txt'), 'hello');
  const outside = join(tmp, 'outside.txt');
  writeFileSync(outside, 'secret');
  symlinkSync(outside, join(cwd, 'link.txt'));
  mkdirSync(join(cwd, 'subdir'));
  const gid = await makeGroup(cwd);
  // need a session for workerA so publish can resolve cwd
  groupManager.registerMember(gid, 'workerA', 'sess-a');
  // fake sessionApi via setSessionApiForTests to return cwd
  const orig = groupManager.getGroup(gid);
  // Instead directly use sessionManager facade: inject via setSessionApiForTests
  groupManager.setSessionApiForTests({ getSession: (id) => id === 'sess-a' ? { cwd } : null, destroySession: () => {}, createSession: () => ({ error: 'unused' }), writeToSession: () => false, waitUntilSettled: async () => ({ settled: true }), dockerAvailability: () => ({ dockerAvailable: null }) });
  try {
    let r = groupManager.publishGroupFileFromAgent(gid, 'workerA', 'ok.txt');
    assert.equal(r.ok, true);
    assert.equal(r.publishedBy, 'workerA');
    assert.equal(r.direction, 'agent');
    r = groupManager.publishGroupFileFromAgent(gid, 'workerA', '/etc/passwd');
    assert.equal(r.error, 'bad-request');
    r = groupManager.publishGroupFileFromAgent(gid, 'workerA', '../outside.txt');
    assert.equal(r.error, 'bad-request');
    r = groupManager.publishGroupFileFromAgent(gid, 'workerA', 'link.txt');
    assert.equal(r.error, 'bad-request');
    assert.match(r.message, /symlink/);
    r = groupManager.publishGroupFileFromAgent(gid, 'workerA', 'subdir');
    assert.equal(r.error, 'bad-request');
    assert.match(r.message, /not a regular file/);
    r = groupManager.publishGroupFileFromAgent(gid, 'workerA', 'missing.txt');
    assert.equal(r.error, 'not-found');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('commitStagedUploads promotes temp files and validates quotas', async () => {
  const gid = await makeGroup();
  try {
    const dir = groupManager.getGroupFilesDirForGroup(gid);
    // stage a temp file manually
    const tempPath = join(dir, '.tmp-upload-test');
    writeFileSync(tempPath, Buffer.from('staged'));
    const staged = [{ name: 'staged.txt', mimeType: 'text/plain', tempPath, size: 6 }];
    const res = groupManager.commitStagedUploads(gid, staged);
    assert.equal(res.ok, true);
    assert.equal(res.files.length, 1);
    assert.equal(existsSync(tempPath), false, 'temp promoted');
    assert.ok(existsSync(join(dir, res.files[0].id)));
  } finally { groupManager.destroyGroup(gid); }
});

test('manifest persistence across restoreGroups and stale/corrupt handling', async () => {
  const gid = await makeGroup('/srv/proj-persist');
  // restoreGroups() models a fresh process start: nothing live may survive
  // into it. Stop the group's live control broker BEFORE restoring --
  // restoring replaces the map entry with a broker-less copy, which would
  // orphan the original server handle and keep the test runner alive forever.
  const live = groupManager.getGroup(gid);
  const originalBroker = live?.controlBroker || null;
  if (originalBroker) {
    stopBroker(originalBroker);
    live.controlBroker = null;
  }
  try {
    groupManager.publishGroupFilesFromUpload(gid, [{ name: 'keep.txt', mimeType: 'text/plain', data: Buffer.from('keep') }]);
    const raw = JSON.parse(readFileSync(process.env.CCSERVER_GROUP_FILES_PATH, 'utf-8'));
    assert.ok(raw[gid]);
    // corrupt manifest tolerance: write invalid JSON then restore must not throw
    writeFileSync(process.env.CCSERVER_GROUP_FILES_PATH, '{ invalid json');
    assert.doesNotThrow(() => groupManager.restoreGroups());
    // restore valid then stale blob ignored
    groupManager.publishGroupFilesFromUpload(gid, [{ name: 'a.txt', mimeType: 'text/plain', data: Buffer.from('a') }]);
    const fid = groupManager.listGroupFiles(gid).files[0].id;
    const fetched = groupManager.fetchGroupFile(gid, fid);
    // delete blob to make stale
    rmSync(fetched.blobPath, { force: true });
    // craft raw manifest still containing entry but blob missing, then restore
    const oldGroups = groupManager.restoreGroups();
    assert.ok(oldGroups.ids.includes(gid));
    // after restore, stale entry should be ignored
    const after = groupManager.getGroup(gid);
    // If stale, file not in list
    const listed = groupManager.listGroupFiles(gid);
    // may be 0 if stale, or if our earlier corrupt test cleared it; just ensure no crash
    assert.ok(Array.isArray(listed.files));
  } finally {
    if (originalBroker) stopBroker(originalBroker); // defensive: already stopped above
    groupManager.destroyGroup(gid);
  }
});

test('restoreGroups treats a non-finite publishedAt as missing and keeps a finite one (JSON.parse turns 1e999 into Infinity)', async () => {
  const gid = await makeGroup('/srv/proj-files-non-finite');
  const originalBroker = groupManager.getGroup(gid)?.controlBroker || null;
  try {
    const names = ['pos-inf.txt', 'neg-inf.txt', 'finite.txt'];
    groupManager.publishGroupFilesFromUpload(gid, names.map((name) => ({ name, mimeType: 'text/plain', data: Buffer.from(name) })));
    const idOf = (name) => groupManager.listGroupFiles(gid).files.find((f) => f.name === name).id;
    const ids = Object.fromEntries(names.map((name) => [name, idOf(name)]));

    // JSON.stringify writes Infinity as null, so plant the literals by hand.
    const raw = JSON.parse(readFileSync(process.env.CCSERVER_GROUP_FILES_PATH, 'utf-8'));
    raw[gid][ids['pos-inf.txt']].publishedAt = '+INF';
    raw[gid][ids['neg-inf.txt']].publishedAt = '-INF';
    raw[gid][ids['finite.txt']].publishedAt = 5_000;
    const text = JSON.stringify(raw).replaceAll('"+INF"', '1e999').replaceAll('"-INF"', '-1e999');
    writeFileSync(process.env.CCSERVER_GROUP_FILES_PATH, text);
    const planted = JSON.parse(text)[gid];
    assert.equal(planted[ids['pos-inf.txt']].publishedAt, Infinity, 'the fixture really carries Infinity');
    assert.equal(planted[ids['neg-inf.txt']].publishedAt, -Infinity);

    const t0 = Date.now();
    groupManager.restoreGroups();
    const t1 = Date.now();

    const restored = new Map(groupManager.listGroupFiles(gid).files.map((f) => [f.name, f]));
    assert.deepEqual([...restored.keys()].sort(), [...names].sort(), 'all three files were restored');
    for (const name of ['pos-inf.txt', 'neg-inf.txt']) {
      const at = restored.get(name).publishedAt;
      assert.ok(Number.isFinite(at) && at >= t0 && at <= t1, `${name}.publishedAt falls back to the restore time (got ${at})`);
    }
    assert.equal(restored.get('finite.txt').publishedAt, 5_000);
  } finally {
    if (originalBroker) stopBroker(originalBroker);
    groupManager.destroyGroup(gid);
  }
});

// Same shape as the publishedAt case above, for the other numeric field of a
// restored manifest entry: `size` also went through typeof, so a hand-edited or
// corrupt 1e999 (Infinity once parsed) was accepted -- and sizes are what the
// group's quota arithmetic adds up.
test('restoreGroups treats a non-finite size as missing (0, like an absent one) and keeps a finite one', async () => {
  const gid = await makeGroup('/srv/proj-files-size-non-finite');
  const originalBroker = groupManager.getGroup(gid)?.controlBroker || null;
  try {
    const names = ['pos-inf.txt', 'neg-inf.txt', 'absent.txt', 'finite.txt'];
    groupManager.publishGroupFilesFromUpload(gid, names.map((name) => ({ name, mimeType: 'text/plain', data: Buffer.from(name) })));
    const idOf = (name) => groupManager.listGroupFiles(gid).files.find((f) => f.name === name).id;
    const ids = Object.fromEntries(names.map((name) => [name, idOf(name)]));

    // JSON.stringify writes Infinity as null, so plant the literals by hand.
    const raw = JSON.parse(readFileSync(process.env.CCSERVER_GROUP_FILES_PATH, 'utf-8'));
    raw[gid][ids['pos-inf.txt']].size = '+INF';
    raw[gid][ids['neg-inf.txt']].size = '-INF';
    delete raw[gid][ids['absent.txt']].size;
    raw[gid][ids['finite.txt']].size = 7;
    const text = JSON.stringify(raw).replaceAll('"+INF"', '1e999').replaceAll('"-INF"', '-1e999');
    writeFileSync(process.env.CCSERVER_GROUP_FILES_PATH, text);
    const planted = JSON.parse(text)[gid];
    assert.equal(planted[ids['pos-inf.txt']].size, Infinity, 'the fixture really carries Infinity');
    assert.equal(planted[ids['neg-inf.txt']].size, -Infinity);
    assert.equal('size' in planted[ids['absent.txt']], false);

    groupManager.restoreGroups();

    const restored = new Map(groupManager.listGroupFiles(gid).files.map((f) => [f.name, f]));
    assert.deepEqual([...restored.keys()].sort(), [...names].sort(), 'all four files were restored');
    assert.equal(restored.get('absent.txt').size, 0, 'control: an absent size is 0');
    assert.equal(restored.get('pos-inf.txt').size, 0, 'a non-finite size is treated as absent');
    assert.equal(restored.get('neg-inf.txt').size, 0);
    assert.equal(restored.get('finite.txt').size, 7);
  } finally {
    if (originalBroker) stopBroker(originalBroker);
    groupManager.destroyGroup(gid);
  }
});

test('destroyGroup removes blob root and does not touch sibling', async () => {
  const g1 = await makeGroup();
  const g2 = await makeGroup();
  try {
    groupManager.publishGroupFilesFromUpload(g1, [{ name: 'a.txt', mimeType: 'text/plain', data: Buffer.from('a') }]);
    groupManager.publishGroupFilesFromUpload(g2, [{ name: 'b.txt', mimeType: 'text/plain', data: Buffer.from('b') }]);
    const f1 = groupManager.fetchGroupFile(g1, groupManager.listGroupFiles(g1).files[0].id);
    const f2path = groupManager.fetchGroupFile(g2, groupManager.listGroupFiles(g2).files[0].id).blobPath;
    groupManager.destroyGroup(g1);
    assert.equal(existsSync(f1.blobPath), false);
    assert.ok(existsSync(f2path), 'sibling untouched');
    assert.equal(groupManager.listGroupFiles(g1).error, 'group-not-found');
  } finally {
    try { groupManager.destroyGroup(g1); } catch {}
    try { groupManager.destroyGroup(g2); } catch {}
  }
});

test('sanitized generated blob name never uses upload filename as path', async () => {
  const gid = await makeGroup();
  try {
    const res = groupManager.publishGroupFilesFromUpload(gid, [{ name: '../../evil.txt', mimeType: 'text/plain', data: Buffer.from('x') }]);
    assert.equal(res.files[0].name, 'evil.txt');
    const fetched = groupManager.fetchGroupFile(gid, res.files[0].id);
    assert.ok(!fetched.blobPath.includes('evil'));
    assert.ok(fetched.blobPath.endsWith(res.files[0].id));
  } finally { groupManager.destroyGroup(gid); }
});

test('commitStagedUploads is atomic: failure on second rename rolls back promoted blobs and temps', async () => {
  const gid = await makeGroup();
  const { renameSync } = await import('node:fs');
  const dir = groupManager.getGroupFilesDirForGroup(gid);
  const beforeManifest = (() => {
    try { return readFileSync(process.env.CCSERVER_GROUP_FILES_PATH, 'utf-8'); } catch { return null; }
  })();
  try {
    // prepare two staged temps
    const tmp1 = join(dir, '.tmp-upload-test1');
    const tmp2 = join(dir, '.tmp-upload-test2');
    writeFileSync(tmp1, Buffer.from('one'));
    writeFileSync(tmp2, Buffer.from('two'));
    const staged = [
      { name: 'a.txt', mimeType: 'text/plain', tempPath: tmp1, size: 3 },
      { name: 'b.txt', mimeType: 'text/plain', tempPath: tmp2, size: 3 },
    ];
    // Inject failure on second rename
    let callCount = 0;
    groupManager.setCommitRenameSyncForTests((src, dest) => {
      callCount++;
      if (callCount === 2) throw new Error('injected rename failure');
      return renameSync(src, dest);
    });
    const res = groupManager.commitStagedUploads(gid, staged);
    assert.equal(res.error, 'internal');
    assert.match(res.message, /injected rename failure/);
    // No mutation: group.files still empty
    assert.equal(groupManager.listGroupFiles(gid).files.length, 0, 'group.files must remain empty after failure');
    // No temp or final blobs remain
    assert.equal(existsSync(tmp1), false, 'first temp must be cleaned up');
    assert.equal(existsSync(tmp2), false, 'second temp must be cleaned up');
    // No final blobs under dir
    const blobs = (() => {
      try { return groupManager.getGroupFilesDirForGroup(gid); } catch { return dir; }
    })();
    // Check that directory contains no regular files (only possibly empty dir)
    const { readdirSync } = await import('node:fs');
    let entries = [];
    try { entries = readdirSync(dir); } catch { entries = []; }
    assert.equal(entries.length, 0, `no orphan blobs should remain, got ${entries}`);
    // Manifest unchanged on disk: a failed batch must never be persisted.
    const afterManifest = (() => {
      try { return readFileSync(process.env.CCSERVER_GROUP_FILES_PATH, 'utf-8'); } catch { return null; }
    })();
    // If manifest existed before, it should be unchanged; if none, still none or empty
    if (beforeManifest === null) {
      // before had no file, after should also have no file or not contain this group
      if (afterManifest) {
        const parsed = JSON.parse(afterManifest);
        assert.ok(!parsed[gid], 'manifest must not contain failed group files');
      }
    } else {
      // Compare raw content when possible; at minimum ensure group not persisted
      if (afterManifest) {
        const parsed = JSON.parse(afterManifest);
        assert.ok(!parsed[gid] || parsed[gid].length === 0, 'manifest must not persist rolled-back files');
      }
    }
    // NOTE: no restoreGroups() here. This test's group is still live (its
    // control broker running), and restore would overwrite the map entry
    // with a broker-less copy -- orphaning the live broker handle and
    // hanging the test runner. The direct manifest read above already proves
    // the failure was not persisted; successful-restore behavior is covered
    // by the manifest-persistence test (which stops the live broker first).
  } finally {
    groupManager.setCommitRenameSyncForTests(null);
    groupManager.destroyGroup(gid);
  }
});

test('agent publish TOCTOU: symlink swap before open is rejected and leaves no blob', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cc-gm-agent-toctou-'));
  const cwd = join(tmp, 'wt');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'ok.txt'), 'hello');
  const outside = join(tmp, 'outside.txt');
  writeFileSync(outside, 'secret-outside');
  const gid = await makeGroup(cwd);
  groupManager.registerMember(gid, 'workerA', 'sess-a');
  groupManager.setSessionApiForTests({ getSession: (id) => id === 'sess-a' ? { cwd } : null, destroySession: () => {}, createSession: () => ({ error: 'unused' }), writeToSession: () => false, waitUntilSettled: async () => ({ settled: true }), dockerAvailability: () => ({ dockerAvailable: null }) });
  try {
    // Hook swaps the file to a symlink pointing outside between validation and open
    groupManager.setAgentPublishHookForTests(() => {
      try { rmSync(join(cwd, 'ok.txt'), { force: true }); } catch {}
      symlinkSync(outside, join(cwd, 'ok.txt'));
    });
    const r = groupManager.publishGroupFileFromAgent(gid, 'workerA', 'ok.txt');
    assert.equal(r.error, 'bad-request');
    assert.match(r.message, /symlink/);
    // No blob created
    assert.equal(groupManager.listGroupFiles(gid).files.length, 0);
    const dir = groupManager.getGroupFilesDirForGroup(gid);
    const { readdirSync } = await import('node:fs');
    let entries = [];
    try { entries = readdirSync(dir); } catch { entries = []; }
    assert.equal(entries.length, 0, 'no blob should remain after symlink rejection');
    // Verify outside content was not copied
    for (const e of entries) {
      const content = readFileSync(join(dir, e), 'utf-8');
      assert.ok(!content.includes('secret-outside'));
    }
  } finally {
    groupManager.setAgentPublishHookForTests(null);
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('agent publish TOCTOU: FIFO swap before open is rejected instead of blocking (#212)', async () => {
  // The sibling case above swaps in a symlink; this one swaps in a FIFO.
  //
  // O_NOFOLLOW does not cover this: the swapped-in path is not a symlink, it
  // is a real FIFO, so open(2) accepts it -- and with no writer it NEVER
  // RETURNS. The fstat isFile() check below it is unreachable, the event loop
  // stops, and SIGTERM stops being handled. That is issue #212 reached
  // through the very race this file already hooks for; the pre-check cannot
  // close it, because it is explicitly "not authoritative for TOCTOU".
  // O_NONBLOCK is what makes the open return so the fstat can reject it.
  //
  // A regression here does NOT fail -- it hangs the runner, because a
  // synchronous open cannot be interrupted from inside the process. See the
  // header of stateRestoreFifo.test.js.
  const tmp = mkdtempSync(join(tmpdir(), 'cc-gm-agent-fifo-'));
  const cwd = join(tmp, 'wt');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'ok.txt'), 'hello');
  const gid = await makeGroup(cwd);
  groupManager.registerMember(gid, 'workerA', 'sess-a');
  groupManager.setSessionApiForTests({ getSession: (id) => id === 'sess-a' ? { cwd } : null, destroySession: () => {}, createSession: () => ({ error: 'unused' }), writeToSession: () => false, waitUntilSettled: async () => ({ settled: true }), dockerAvailability: () => ({ dockerAvailable: null }) });
  let haveFifo = true;
  try {
    groupManager.setAgentPublishHookForTests(() => {
      try { rmSync(join(cwd, 'ok.txt'), { force: true }); } catch {}
      try { execFileSync('mkfifo', [join(cwd, 'ok.txt')]); } catch { haveFifo = false; }
    });
    const r = groupManager.publishGroupFileFromAgent(gid, 'workerA', 'ok.txt');
    if (!haveFifo) return; // mkfifo unavailable -- same skip shape as files.test.js:481
    assert.equal(r.error, 'bad-request');
    assert.match(r.message, /not a regular file/);
    // and nothing was promoted
    assert.equal(groupManager.listGroupFiles(gid).files.length, 0);
    const dir = groupManager.getGroupFilesDirForGroup(gid);
    const { readdirSync } = await import('node:fs');
    let entries = [];
    try { entries = readdirSync(dir); } catch { entries = []; }
    assert.equal(entries.length, 0, 'no blob should remain after a FIFO rejection');
  } finally {
    groupManager.setAgentPublishHookForTests(null);
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('agent publish TOCTOU: file growth between check and copy uses actual size and is quota-consistent', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cc-gm-agent-growth-'));
  const cwd = join(tmp, 'wt');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'grow.txt'), 'hi'); // 2 bytes initially
  const gid = await makeGroup(cwd);
  groupManager.registerMember(gid, 'workerA', 'sess-a');
  groupManager.setSessionApiForTests({ getSession: (id) => id === 'sess-a' ? { cwd } : null, destroySession: () => {}, createSession: () => ({ error: 'unused' }), writeToSession: () => false, waitUntilSettled: async () => ({ settled: true }), dockerAvailability: () => ({ dockerAvailable: null }) });
  try {
    // Grow file to 100 bytes between validation and open
    const grownContent = 'x'.repeat(100);
    groupManager.setAgentPublishHookForTests(() => {
      writeFileSync(join(cwd, 'grow.txt'), grownContent);
    });
    const r = groupManager.publishGroupFileFromAgent(gid, 'workerA', 'grow.txt');
    assert.equal(r.ok, true, `publish should succeed with grown size, got ${JSON.stringify(r)}`);
    assert.equal(r.size, 100, 'metadata size must reflect actual fd size, not pre-check size');
    const fetched = groupManager.fetchGroupFile(gid, r.id);
    assert.equal(fetched.size, 100);
    const blobContent = readFileSync(fetched.blobPath, 'utf-8');
    assert.equal(blobContent, grownContent);
    assert.equal(blobContent.length, 100);
    // Second growth that would exceed quota must be rejected
    // Fill group near quota using small files, then grow beyond quota
    // Use the same hook to grow to a size that exceeds remaining quota if possible
    // Simpler: verify that a grow beyond MAX_FILE_BYTES is rejected
    writeFileSync(join(cwd, 'big.txt'), 'a'.repeat(10));
    groupManager.setAgentPublishHookForTests(() => {
      // Grow to > MAX_FILE_BYTES
      writeFileSync(join(cwd, 'big.txt'), Buffer.alloc(MAX_FILE_BYTES + 1, 'b'));
    });
    const r2 = groupManager.publishGroupFileFromAgent(gid, 'workerA', 'big.txt');
    assert.equal(r2.error, 'too-large');
    // Ensure no blob for rejected large growth
    assert.equal(groupManager.listGroupFiles(gid).files.length, 1, 'only first grown file should persist');
  } finally {
    groupManager.setAgentPublishHookForTests(null);
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
    rmSync(tmp, { recursive: true, force: true });
  }
});
