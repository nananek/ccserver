// Tests for groupManager's persistence/restore lifecycle and the teardown
// fixes:
//   - groups survive a server restart (persistGroups writes the registry,
//     restoreGroups rebuilds it with the orchestrator dir + instructions)
//   - destroyGroup settles pending takeHandoff waiters instead of leaving
//     them attached to the (now removed) emitter
//   - addMember refuses to grow a full group (member cap) before any spawn
//   - destroyGroup leaves the orchestratorDir in place (it is a per-project
//     resource reused across group launches for the same project)
//   - restoreGroups no longer writes CLAUDE.md/AGENTS.md (generation moved to
//     generateOrchestratorClaudeMdSrc, called right before every spawn)
//   - generateOrchestratorClaudeMdSrc merges the repo template with the
//     group's saved custom instructions and writes it to a host-only path,
//     picking up template edits and instruction changes on every call
//   - groupExistsForCwd (routes/groups.js) matches a real registered group,
//     i.e. POST /groups's 409 duplicate-project check sees the live listing
//
// Real control brokers listen on UDS during createGroup (same as
// mcpBroker.test.js); no agent CLIs, no bwrap, no browser needed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, cpSync, statSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { classifyActivity } from './activity.js';

// sessionManager.activitySnapshot is a thin wrapper around activity.js's pure
// classifier; a fake session facade runs the REAL classifier over its fake
// session object rather than hand-rolling the result shape. (activity.js is
// safe to import at the top here -- it touches no env and no disk.)
const fakeActivitySnapshot = (session) => classifyActivity({
  app: session?.app ?? null,
  live: !!session,
  exited: !!session?.exited,
  shell: !!session?.shell,
});

let runtimeDir;
let groupManager;
let worktreePathForTest;
let groupsToDestroy = [];
// A throwaway copy of the real template, seeded from it once up front. The
// "template edit lands on the next generation" test below mutates this copy
// (never the real, repo-tracked server/ws/orchestrator-template.md): other
// test files (e.g. sessionManager.test.js) read that real file concurrently
// as their content oracle, and node --test runs files in parallel by
// default, so mutating it in place would be a cross-file race.
let templateCopyPath;

before(async () => {
  // Short base: the broker sockets (ccserver-mcp-<32hex>-<tag>.d/sock) under a
  // /var/folders/... macOS tmpdir() overflow sockaddr_un's 104-byte limit and
  // listen() then never binds. hostRuntimeDir() picks a short /tmp base on
  // darwin for the same reason.
  runtimeDir = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'ccs-gm-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  process.env.CCSERVER_SAVED_SESSIONS_PATH = join(runtimeDir, 'saved-sessions.json');
  // generateOrchestratorClaudeMdSrc's output dir must never land under the
  // real home directory during tests -- see the env override in groupManager.js.
  process.env.CCSERVER_ORCHESTRATOR_GENERATED_ROOT = join(runtimeDir, 'orchestrator-generated');
  templateCopyPath = join(runtimeDir, 'orchestrator-template.md');
  cpSync(join(import.meta.dirname, 'orchestrator-template.md'), templateCopyPath);
  process.env.CCSERVER_ORCHESTRATOR_TEMPLATE_PATH = templateCopyPath;
  groupManager = await import('./groupManager.js');
  ({ worktreePathFor: worktreePathForTest } = await import('./worktree.js'));
});

after(() => {
  for (const id of groupsToDestroy) groupManager.destroyGroup(id);
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function makeGroup(cwd = '/srv/proj') {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd, orchestratorDir: join(runtimeDir, gid) });
  groupsToDestroy.push(gid);
  return gid;
}

test('persistGroups writes the member registry; destroyGroup removes the entry', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({
    groupId: gid,
    cwd: '/srv/proj',
    orchestratorDir: join(runtimeDir, gid),
    orchestratorApp: 'opencode',
  });
  groupManager.registerMember(gid, 'workerA', 'sess-a1');
  groupManager.registerMember(gid, 'orchestrator', 'sess-o');

  const saved = JSON.parse(readFileSync(process.env.CCSERVER_GROUPS_PATH, 'utf-8'));
  const entry = saved.find((g) => g.id === gid);
  assert.ok(entry, 'group persisted');
  assert.deepEqual(entry.members, { workerA: 'sess-a1', orchestrator: 'sess-o' });
  assert.equal(entry.orchestratorApp, 'opencode');

  // The orchestratorDir is a per-project resource: destroying the group must
  // not remove it (it is reused as the cwd for the next group on the project;
  // CLAUDE.md/AGENTS.md are generated fresh at that group's own spawn time).
  const orchDir = join(runtimeDir, gid);
  mkdirSync(orchDir, { recursive: true });
  groupManager.destroyGroup(gid);
  assert.equal(existsSync(orchDir), true, 'orchestratorDir survives destroyGroup');
  // No groups remain, so the persisted file is unlinked entirely (not just
  // pruned) -- the group entry must be gone either way.
  let after = [];
  try {
    after = JSON.parse(readFileSync(process.env.CCSERVER_GROUPS_PATH, 'utf-8'));
  } catch {
    // file unlinked when the registry became empty -- expected
  }
  assert.equal(after.some((g) => g.id === gid), false, 'destroyed group is gone from the persisted file');
});

test('restoreGroups rebuilds a group from the persisted file (restart survival)', async () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `orch-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1234,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    orchestratorApp: 'claude',
    instructions: '# Orchestrator instructions',
    sandboxOpts: null,
    members: { workerA: 'dead-sess-a', orchestrator: 'dead-sess-o' },
  }]));

  const info = groupManager.restoreGroups();
  assert.equal(info.restored, 1);
  assert.deepEqual(info.ids, [gid]);

  const group = groupManager.getGroup(gid);
  assert.ok(group, 'group re-registered');
  assert.equal(group.cwd, '/srv/proj');
  assert.equal(group.orchestratorApp, 'claude');
  assert.deepEqual(
    [...group.members],
    [['workerA', 'dead-sess-a'], ['orchestrator', 'dead-sess-o']],
  );
  assert.equal(group.controlBroker, null, 'brokers are recreated lazily');
  // Instructions metadata is restored -- generation into an actual
  // CLAUDE.md/AGENTS.md happens only at the next real (re)spawn, via
  // generateOrchestratorClaudeMdSrc (see the dedicated tests below).
  assert.equal(group.instructions, '# Orchestrator instructions');

  // Session-less members surface as exited (skeleton only -- no saved-session
  // entry to match in this test).
  const workerA = groupManager.listGroupMembers(gid).find((m) => m.role === 'workerA');
  assert.equal(workerA.exited, true);
  assert.equal(workerA.restored, false);

  groupManager.destroyGroup(gid);
});

test('restoreGroups does not write CLAUDE.md/AGENTS.md (generation happens only at actual spawn time)', async () => {
  const gid = randomUUID();
  // What a real saved file carries: the dir derived from the project cwd (a
  // unique cwd, so the dir is this test's own). An arbitrary persisted path is
  // NOT created -- see the tampered-file tests below.
  const cwd = `/srv/proj-nowrite-${gid}`;
  const orchDir = groupManager.orchestratorDirForCwd(cwd);
  rmSync(orchDir, { recursive: true, force: true });
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd,
    allowedCwds: [cwd],
    orchestratorDir: orchDir,
    orchestratorApp: 'claude',
    instructions: '# Orchestrator instructions',
    sandboxOpts: null,
    members: { workerA: 'dead-sess-a', orchestrator: 'dead-sess-o' },
  }]));

  const info = groupManager.restoreGroups();
  assert.equal(info.restored, 1);
  assert.equal(existsSync(orchDir), true, 'orchestratorDir itself is still (re)created');
  assert.equal(existsSync(join(orchDir, 'CLAUDE.md')), false, 'restoreGroups no longer writes CLAUDE.md');
  assert.equal(existsSync(join(orchDir, 'AGENTS.md')), false, 'restoreGroups no longer writes AGENTS.md');
  groupsToDestroy.push(gid);
});

// --- restoreGroups admits a saved group by the rules a NEW group had to meet ---
// (#279 made a restart an ordinary way for a group to come back, so the saved
// file is input to everything restoreGroups sets up). Each case below is one
// field of a hand-edited saved-groups.json; the control (an untouched entry)
// is asserted first in each, so a "not restored" result cannot be the fixture
// being wrong.

// Restores from `entries` (an array, or raw JSON text for keys JSON.stringify
// cannot write, like an own "__proto__"), collecting console.warn.
function restoreFrom(entries) {
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, typeof entries === 'string' ? entries : JSON.stringify(entries));
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    return { info: groupManager.restoreGroups(), warnings };
  } finally {
    console.warn = realWarn;
  }
}

// A saved entry exactly as the running server writes it for `cwd`.
function savedEntry(cwd, extra = {}) {
  const id = randomUUID();
  groupsToDestroy.push(id);
  return {
    id,
    createdAt: 1,
    cwd,
    allowedCwds: [cwd],
    orchestratorDir: typeof cwd === 'string' ? groupManager.orchestratorDirForCwd(cwd) : null,
    orchestratorApp: 'claude',
    instructions: null,
    sandboxOpts: null,
    members: { workerA: 'dead-a', orchestrator: 'dead-o' },
    ...extra,
  };
}

// browseRoots for the duration of fn: an allowed root, a sibling outside it,
// and symlinks INSIDE the allowed root that point at the outside one and at "/".
async function withBrowseRoots(fn) {
  const base = mkdtempSync(join(tmpdir(), 'ccs-restore-roots-'));
  const allowed = join(base, 'allowed');
  const outside = join(base, 'outside');
  mkdirSync(allowed);
  mkdirSync(outside);
  symlinkSync(outside, join(allowed, 'link-out'));
  symlinkSync('/', join(allowed, 'link-fs-root'));
  const cfg = join(base, 'sandbox.config.json');
  writeFileSync(cfg, JSON.stringify({ browseRoots: [allowed] }));
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfg;
  try {
    return await fn({ base, allowed, outside, cfg });
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG; else process.env.CCSERVER_SANDBOX_CONFIG = prev;
    rmSync(base, { recursive: true, force: true });
  }
}

// A saved group's id becomes part of paths (its group-files directory, its MCP socket
// names). POST /groups makes it with randomUUID() -- a lowercase 8-4-4-4-12 -- and has
// done since combo launch existed, so that is the only form a saved file is admitted in.
test('restoreGroups admits only an id in the form POST /groups creates (a lowercase UUID), and says why for any other', async () => {
  const cwd = `/srv/proj-ids-${randomUUID()}`;
  const control = restoreFrom([savedEntry(cwd)]);
  assert.equal(control.info.restored, 1, `control: an ordinary randomUUID() id is restored (${control.warnings.join(' | ')})`);
  assert.deepEqual(control.warnings, []);

  const good = randomUUID();
  const bad = {
    'a path out of the files root': '../ESCAPED-DIR',
    'a slash': '/',
    'a nested path': 'a/b',
    'NUL': '\0',
    'a UUID with a NUL after it': `${good}\0`,
    'a UUID followed by a newline': `${good}\n`,
    'a UUID with a trailing space': `${good} `,
    'dot-dot': '..',
    'dot': '.',
    'empty': '',
    'a very long string': 'a'.repeat(200000),
    'the same UUID in uppercase': good.toUpperCase(),
    'mixed case': `${good.slice(0, 8).toUpperCase()}${good.slice(8)}`,
    'a UUID without dashes': good.replaceAll('-', ''),
    'a UUID in braces': `{${good}}`,
    'a urn': `urn:uuid:${good}`,
    'a non-hex UUID-shaped string': 'gggggggg-gggg-gggg-gggg-gggggggggggg',
    '__proto__': '__proto__',
    'a UUID with a path after it': `${good}/../x`,
  };
  for (const [what, id] of Object.entries(bad)) {
    const { info, warnings } = restoreFrom([savedEntry(`/srv/proj-ids-${randomUUID()}`, { id })]);
    assert.equal(info.restored, 0, `${what}: not restored`);
    assert.equal(groupManager.listGroups().some((g) => g.groupId === id), false, `${what}: no such group exists`);
    const text = warnings.join('\n');
    assert.match(text, /not restoring a saved group: its id .* is not a group id/, `${what}: says why`);
    assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f]/, `${what}: the id is quoted (JSON.stringify), never written raw into the log`);
  }
  // a saved file with a bad entry does not stop the good one after it
  const mixed = restoreFrom([savedEntry(`/srv/proj-ids-${randomUUID()}`, { id: '../ESCAPED-DIR' }), savedEntry(`/srv/proj-ids-${randomUUID()}`)]);
  assert.equal(mixed.info.restored, 1);
});

test('restoreGroups refuses a group whose cwd creation would have refused (not absolute, "/", outside browseRoots, a ".." or a symlink out of them)', async () => {
  await withBrowseRoots(async ({ allowed, outside }) => {
    const inside = join(allowed, 'proj');
    mkdirSync(inside);
    const control = restoreFrom([savedEntry(inside)]);
    assert.equal(control.info.restored, 1, `control: an untouched entry inside browseRoots is restored (${control.warnings.join(' | ')})`);
    assert.deepEqual(control.warnings, [], 'and restoring it says nothing');

    const bad = {
      '/etc': '/etc',
      '"/"': '/',
      relative: 'srv/proj',
      empty: '',
      'not a string': 12,
      '.. out of browseRoots': `${allowed}/../outside`,
      'symlink out of browseRoots': join(allowed, 'link-out'),
      'symlink out, then a child': join(allowed, 'link-out', 'child'),
      // ".." after a symlink goes to where the link POINTS (the kernel's rule; see pathPolicy.test.js)
      'symlink to "/", then ..': `${allowed}/link-fs-root/..`,
      'symlink to "/", then ../etc': `${allowed}/link-fs-root/../etc`,
      'symlink out, then ..': `${allowed}/link-out/..`,
    };
    for (const [what, cwd] of Object.entries(bad)) {
      const { info, warnings } = restoreFrom([savedEntry(cwd)]);
      assert.equal(info.restored, 0, `${what}: not restored`);
      assert.match(warnings.join('\n'), /not restoring saved group/, `${what}: says why`);
    }
    assert.equal(existsSync(outside), true);
  });
});

// POST /groups (launchGroupFromSpec) and restoreGroups both ask validateGroupCwd, and a
// group's cwd is later handed to the kernel exactly as saved (git -C, bwrap's --bind,
// a spawn's cwd). So "<root>/<symlink>/.." has to be judged where the symlink points --
// with a link to "/", the group's project directory is "/" itself.
test('validateGroupCwd: "<root>/<symlink>/.." is refused when the symlink points outside browseRoots (with or without the existence check)', async () => {
  await withBrowseRoots(async ({ allowed }) => {
    const inside = join(allowed, 'proj');
    mkdirSync(inside);
    // control: ".." through real directories is still fine, and the trap is armed --
    // the kernel takes each of these for a directory, so only the containment check
    // can tell they are not inside
    assert.equal(groupManager.validateGroupCwd(`${inside}/..`).ok, true, 'control: a real ".." inside the root passes');
    for (const cwd of [`${allowed}/link-fs-root/..`, `${allowed}/link-out/..`]) {
      assert.equal(statSync(cwd).isDirectory(), true, `control: the kernel accepts ${cwd} as a directory`);
    }
    for (const cwd of [`${allowed}/link-fs-root/..`, `${allowed}/link-fs-root/../etc`, `${allowed}/link-out/..`]) {
      for (const opts of [undefined, { requireDirectory: false }]) {
        const res = groupManager.validateGroupCwd(cwd, opts);
        assert.equal(res.ok, false, `${cwd} ${JSON.stringify(opts ?? {})}: refused`);
        assert.equal(res.code, 'outside-browse-roots');
      }
    }
  });
});

test('restoreGroups still restores a group whose project directory is not there right now (an unmounted disk is not a tampered file)', async () => {
  const cwd = `/srv/proj-missing-${randomUUID()}`;
  const { info } = restoreFrom([savedEntry(cwd)]);
  assert.equal(info.restored, 1);
});

test('restoreGroups with an unreadable browseRoots config restores the group, with a warning, instead of dropping every saved group', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ccs-restore-badcfg-'));
  const cfg = join(base, 'sandbox.config.json');
  writeFileSync(cfg, JSON.stringify({ browseRoots: 'not-an-array' }));
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfg;
  try {
    const cwd = join(base, 'proj');
    mkdirSync(cwd);
    // creation refuses in this state; restoring must not lose the group over it
    assert.equal(groupManager.validateGroupCwd(cwd).code, 'browse-roots-invalid', 'control: the config really is unusable');
    const { info, warnings } = restoreFrom([savedEntry(cwd)]);
    assert.equal(info.restored, 1);
    assert.match(warnings.join('\n'), /without the browseRoots containment check/);
    // ... while the checks that do not need the config still apply
    assert.equal(restoreFrom([savedEntry('/')]).info.restored, 0);
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG; else process.env.CCSERVER_SANDBOX_CONFIG = prev;
    rmSync(base, { recursive: true, force: true });
  }
});

test('restoreGroups never creates an orchestratorDir the saved file names: it derives it from cwd, as creation does', async () => {
  const cwd = `/srv/proj-orchdir-${randomUUID()}`;
  const derived = groupManager.orchestratorDirForCwd(cwd);
  rmSync(derived, { recursive: true, force: true });
  const control = restoreFrom([savedEntry(cwd)]);
  assert.equal(control.info.restored, 1);
  assert.equal(groupManager.getGroup(control.info.ids[0]).orchestratorDir, derived, 'control: the derived dir is the one used');
  assert.equal(existsSync(derived), true);
  assert.deepEqual(control.warnings, []);

  const evilRoot = mkdtempSync(join(tmpdir(), 'ccs-restore-evil-'));
  try {
    for (const evil of [join(evilRoot, 'made', 'by', 'a-saved-file'), '/proc/ccs-should-never-exist', `${derived}/../../escaped-${randomUUID()}`]) {
      const { info, warnings } = restoreFrom([savedEntry(cwd, { orchestratorDir: evil })]);
      assert.equal(info.restored, 1, `the group is still restored (${evil})`);
      assert.equal(groupManager.getGroup(info.ids[0]).orchestratorDir, derived, 'and uses the derived dir');
      assert.equal(existsSync(evil), false, `the path the file named was not created (${evil})`);
      assert.match(warnings.join('\n'), /not the one derived from its cwd/);
    }
    assert.deepEqual(readdirSync(evilRoot), [], 'nothing was created under the tampered location');
  } finally {
    rmSync(evilRoot, { recursive: true, force: true });
  }
});

test('restoreGroups normalizes sandboxOpts like createGroup: known flags as booleans, everything else gone', async () => {
  const cwd = `/srv/proj-opts-${randomUUID()}`;
  const tampered = { gpgVault: 'yes', gpg: 1, sshAgent: { x: 1 }, evil: true, bindEverything: '/', tools: { rtk: 1, codeReviewGraph: '', extra: true } };
  const { info } = restoreFrom([savedEntry(cwd, { sandboxOpts: tampered })]);
  const group = groupManager.getGroup(info.ids[0]);
  assert.deepEqual(group.sandboxOpts, groupManager.normalizeSandboxOpts(tampered));
  assert.deepEqual(group.sandboxOpts, { gpg: true, sshAgent: true, gpgVault: true, tools: { rtk: true, codeReviewGraph: false } });
  for (const junk of ['a string', 42, ['x'], true]) {
    const r = restoreFrom([savedEntry(`/srv/proj-opts-junk-${randomUUID()}`, { sandboxOpts: junk })]);
    assert.deepEqual(groupManager.getGroup(r.info.ids[0]).sandboxOpts, groupManager.normalizeSandboxOpts(junk), `${JSON.stringify(junk)} normalizes the way creation would`);
  }
});

test('restoreGroups keeps only members that addMember could have created (no "__proto__", no path-shaped role)', async () => {
  const cwd = `/srv/proj-members-${randomUUID()}`;
  const entry = savedEntry(cwd);
  const text = JSON.stringify([entry]).replace(
    '"members":{"workerA":"dead-a","orchestrator":"dead-o"}',
    '"members":{"workerA":"dead-a","orchestrator":"dead-o","__proto__":"dead-p","../escape":"dead-e","workerB/../x":"dead-x","worker":"dead-w","":"dead-empty","workerC":"dead-c"}',
  );
  assert.match(text, /"__proto__":"dead-p"/, 'control: the fixture really carries an own __proto__ key');
  const { info, warnings } = restoreFrom(text);
  assert.equal(info.restored, 1);
  assert.deepEqual([...groupManager.getGroup(info.ids[0]).members.keys()].sort(), ['orchestrator', 'workerA', 'workerC']);
  assert.equal(warnings.filter((w) => /dropping member/.test(w)).length, 5);
});

test('restoreGroups keeps allowedCwds and memberWorktrees to what creation can produce: the cwd and its own per-role worktrees', async () => {
  const cwd = `/srv/proj-wt-${randomUUID()}`;
  const good = worktreePathForTest(cwd, 'workerA');
  const control = restoreFrom([savedEntry(cwd, {
    allowedCwds: [cwd, good],
    memberWorktrees: { workerA: { path: good, gitCommonDir: '/srv/x/.git', branch: 'feat/a' } },
  })]);
  const g0 = groupManager.getGroup(control.info.ids[0]);
  assert.deepEqual([...g0.allowedCwds].sort(), [cwd, good].sort(), 'control: the legitimate entries are kept');
  assert.deepEqual([...g0.memberWorktrees.keys()], ['workerA']);
  assert.deepEqual(control.warnings, []);

  const { info, warnings } = restoreFrom([savedEntry(cwd, {
    // '..' and a trailing '/..' matter for more than being wrong: their basename
    // is '..', which worktreePathFor refuses by THROWING, so an entry like that
    // must be turned away by the role check before it ever gets there -- or one
    // saved group would abort the whole restore, and with it every group after it.
    allowedCwds: [cwd, good, '/etc', '/', worktreePathForTest(`${cwd}-other`, 'workerA'), `${good}/../../elsewhere`, '..', `${cwd}/..`, `${good}/..`, 7, null],
    memberWorktrees: {
      workerA: { path: good, gitCommonDir: null, branch: null },
      workerB: { path: '/etc', gitCommonDir: null, branch: null },
      '../escape': { path: worktreePathForTest(cwd, 'workerZ'), gitCommonDir: null, branch: null },
      orchestrator: { path: worktreePathForTest(cwd, 'orchestrator'), gitCommonDir: null, branch: null },
    },
  })]);
  const g = groupManager.getGroup(info.ids[0]);
  assert.deepEqual([...g.allowedCwds].sort(), [cwd, good].sort());
  assert.deepEqual([...g.memberWorktrees.keys()], ['workerA']);
  assert.ok(warnings.some((w) => /dropping allowed cwd/.test(w)));
  assert.ok(warnings.some((w) => /dropping worktree entry/.test(w)));
});

test('groupExistsForCwd matches a real registered group (POST /groups 409 detection)', async () => {
  const { groupExistsForCwd } = await import('../routes/groups.js');
  // Unique cwd: only this test's group can match it (other tests leave
  // '/srv/proj' groups in the registry until the after() cleanup).
  const cwd = `/srv/proj-${randomUUID()}`;
  const gid = await makeGroup(cwd);
  const listing = groupManager.listGroups();
  const hit = groupExistsForCwd(`${cwd}/`, listing);
  assert.ok(hit, 'the live listGroups() listing must be matched');
  assert.equal(hit.groupId, gid);
  assert.equal(groupExistsForCwd('/srv/other', listing), null, 'a different project must not match');
});

test('a newer takeHandoff supersedes a still-pending one (no zombie listener)', async () => {
  const gid = await makeGroup();

  // Call A: a pending wait that never resolves on its own (timeoutMs <= 0).
  const waitA = groupManager.takeHandoff(gid, 0);
  // Call B: the real waiter arriving while A is still unresolved. Under the
  // pre-fix implementation A's listener would stay attached and consume the
  // next pushHandoff, leaving B stuck until timeout; now A is superseded
  // first.
  const waitB = groupManager.takeHandoff(gid, 0);

  const event = { type: 'done', from: 'workerA' };
  assert.equal(groupManager.pushHandoff(gid, event), true);

  const [resA, resB] = await Promise.all([waitA, waitB]);
  assert.deepEqual(resA, { timedOut: true }, 'superseded waiter settles as timedOut, not by stealing the event');
  assert.deepEqual(resB, event, 'the latest waiter receives the pushed event');
});

test('a superseded waiter is removed from pendingTakes (no zombie listener left behind)', async () => {
  const gid = await makeGroup();

  const waitA = groupManager.takeHandoff(gid, 0);
  assert.equal(groupManager.getGroup(gid).pendingTakes.size, 1);

  // The newer waiter supersedes A, which must not linger in pendingTakes --
  // otherwise its listener would consume the next pushHandoff before waitB.
  const waitB = groupManager.takeHandoff(gid, 0);
  assert.equal(groupManager.getGroup(gid).pendingTakes.size, 1, 'superseded A must not linger');
  assert.deepEqual(await waitA, { timedOut: true });

  groupManager.pushHandoff(gid, { type: 'first' });
  assert.deepEqual(await waitB, { type: 'first' });
  assert.equal(groupManager.getGroup(gid).pendingTakes.size, 0, 'resolved waiter cleans up');
});

// The supersede reclaim: a waiter that already dequeued an event (its
// delivery is committed only on the next macrotask) gives it back to the
// queue when superseded -- the event must reach the fresh waiter instead of
// being lost with the stale one.
test('supersede reclaims an event a stale waiter already consumed', async () => {
  const gid = await makeGroup();

  const waitA = groupManager.takeHandoff(gid, 0);
  const event = { type: 'done', from: 'workerA', summary: 'E1' };
  groupManager.pushHandoff(gid, event); // A dequeues it (delivery not yet committed)

  const waitB = groupManager.takeHandoff(gid, 0); // supersedes A, reclaiming the event
  const [resA, resB] = await Promise.all([waitA, waitB]);
  assert.deepEqual(resA, { timedOut: true }, 'the stale waiter settles as timedOut without the event');
  assert.deepEqual(resB, event, 'the reclaimed event reaches the new waiter');
});

// The core no-loss guarantee: a waiter whose connection is dead must not
// dequeue anything -- the event stays queued for the next (live) waiter.
test('a dead (isAlive:false) waiter never consumes; the next live waiter receives the event', async () => {
  const gid = await makeGroup();

  const deadWait = groupManager.takeHandoff(gid, 0, { isAlive: () => false });
  groupManager.pushHandoff(gid, { type: 'done', from: 'workerA', summary: 'survives death' });
  // The dead waiter has not consumed: the queue still holds the event and a
  // live waiter supersedes the dead one and receives it.
  const liveWait = groupManager.takeHandoff(gid, 0, { isAlive: () => true });
  const [resDead, resLive] = await Promise.all([deadWait, liveWait]);
  assert.deepEqual(resDead, { timedOut: true });
  assert.deepEqual(resLive, { type: 'done', from: 'workerA', summary: 'survives death' });
});

// #245: liveness is re-read at COMMIT, not only at claim. A waiter claims the
// event, then commits one macrotask later; a connection that dies inside that
// gap would otherwise carry the event out with it into a socket nobody reads.
// The issue lists this as the sibling of the cancellation path and never
// reproduced it at the wire; here it is, deterministically.
test('#245: a connection that dies between claim and commit gives the event back', async () => {
  const gid = await makeGroup();

  let alive = true;
  const dying = groupManager.takeHandoff(gid, 0, { isAlive: () => alive });
  // The claim happens synchronously inside pushHandoff's emit...
  groupManager.pushHandoff(gid, { type: 'done', from: 'workerA', summary: 'claimed then orphaned' });
  // ...and the commit is a macrotask later. Kill the connection in between.
  alive = false;

  // Settle the dying waiter on its OWN before taking the next one: a second
  // takeHandoff here would supersede it and reclaim the event that way, which
  // would pass whether or not the commit re-check exists.
  assert.deepEqual(await dying, { timedOut: true }, 'the dying waiter delivers nothing');
  assert.deepEqual(await groupManager.takeHandoff(gid, 200),
    { type: 'done', from: 'workerA', summary: 'claimed then orphaned' },
    'and the event it had already claimed is back for the next waiter');
});

// #245: the same guarantee for a cancelled REQUEST rather than a dead
// connection. takeHandoff takes the request's AbortSignal, so an abort both
// returns anything claimed and retires the waiter -- otherwise it lingers for
// the full timeoutMs as the group's sole consumer.
test('#245: aborting a wait returns its claimed event and retires the waiter', async () => {
  const gid = await makeGroup();

  const ac = new AbortController();
  const aborted = groupManager.takeHandoff(gid, 60000, { signal: ac.signal });
  groupManager.pushHandoff(gid, { type: 'done', from: 'workerA', summary: 'reclaimed on abort' });
  ac.abort();

  assert.deepEqual(await aborted, { timedOut: true });
  assert.equal(groupManager.getGroup(gid).pendingTakes.size, 0,
    'an aborted waiter must not linger as a consumer');
  const next = await groupManager.takeHandoff(gid, 200);
  assert.deepEqual(next, { type: 'done', from: 'workerA', summary: 'reclaimed on abort' });
});

// An already-aborted signal must never register a consumer at all. Note the
// timeoutMs of 0 (= never times out on its own): it has to be the aborted
// check that settles this, not a timer. Adding an 'abort' listener to a signal
// that has ALREADY fired does nothing (the event is long gone), so without the
// up-front check this waiter would hang forever as the group's sole consumer.
test('#245: a wait whose signal is already aborted consumes nothing', async () => {
  const gid = await makeGroup();

  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await groupManager.takeHandoff(gid, 0, { signal: ac.signal }), { timedOut: true });
  assert.equal(groupManager.getGroup(gid).pendingTakes.size, 0);

  groupManager.pushHandoff(gid, { type: 'done', from: 'workerA', summary: 'still here' });
  assert.deepEqual(await groupManager.takeHandoff(gid, 200), { type: 'done', from: 'workerA', summary: 'still here' });
});

// #245: the tool description and the docs both promised undelivered handoffs
// survive a restart. Nothing was saving them: persistGroups() left the queue
// out entirely and restoreGroups() rebuilt it empty, so a restart threw away
// work every sender had been told {ok:true} for.
test('#245: an undelivered handoff survives a restart', async () => {
  const gid = await makeGroup();
  groupManager.pushHandoff(gid, { type: 'done', from: 'workerA', summary: 'must outlive the process' });

  // Simulate the restart the way restoreGroups() actually sees it: the file on
  // disk is the only thing that crosses the process boundary.
  const onDisk = JSON.parse(readFileSync(process.env.CCSERVER_GROUPS_PATH, 'utf-8'));
  const saved = onDisk.find((g) => g.id === gid);
  assert.ok(saved, 'the group reached disk');
  assert.deepEqual(saved.handoffQueue, [{ type: 'done', from: 'workerA', summary: 'must outlive the process' }],
    'the queue is part of what is persisted');

  // Restart simulation. Two things matter: destroyGroup also rewrites the
  // file, so the on-disk state has to be put back; and the file accumulates
  // every group this suite made, so restoreGroups() is pointed at THIS group
  // alone -- resurrecting the rest would leave their brokers and timers behind
  // and the test process would never exit.
  groupManager.destroyGroup(gid);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([saved]));
  groupManager.restoreGroups();
  assert.deepEqual(await groupManager.takeHandoff(gid, 200),
    { type: 'done', from: 'workerA', summary: 'must outlive the process' },
    'and the restored group still has it to hand out');
  groupManager.destroyGroup(gid);
});

// The other half: a handoff that WAS delivered must not come back.
test('#245: a delivered handoff does not reappear after a restart', async () => {
  const gid = await makeGroup();
  groupManager.pushHandoff(gid, { type: 'done', from: 'workerA', summary: 'delivered once' });
  assert.equal((await groupManager.takeHandoff(gid, 200)).summary, 'delivered once');

  const saved = JSON.parse(readFileSync(process.env.CCSERVER_GROUPS_PATH, 'utf-8')).find((g) => g.id === gid);
  assert.deepEqual(saved.handoffQueue, [], 'the delivery was written through');
  groupManager.destroyGroup(gid);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([saved]));
  groupManager.restoreGroups();
  assert.deepEqual(await groupManager.takeHandoff(gid, 200), { timedOut: true },
    'a restart must not resurrect an already-delivered handoff');
  groupManager.destroyGroup(gid);
});

// --- #245 review findings ----------------------------------------------------

// Delivery is at-least-once by design, so the receiver needs a way to tell a
// repeat from a second real handoff. Nothing else in the event does it: two
// workers can legitimately send the same summary with the same status.
test('#245: every handoff carries a unique id', async () => {
  const gid = await makeGroup();
  const api = groupManager.getGroupManagerApi();
  const tools = await import('./mcpTools.js');
  const deps = { groupId: gid, role: 'workerA', sessionId: 's1', groupManager: api };

  tools.handoffToOrchestrator(deps, { summary: 'same text', status: 'done' });
  tools.handoffToOrchestrator(deps, { summary: 'same text', status: 'done' });
  const a = await groupManager.takeHandoff(gid, 200);
  const b = await groupManager.takeHandoff(gid, 200);

  assert.equal(typeof a.id, 'string');
  assert.notEqual(a.id, b.id, 'two identical-looking handoffs are still distinguishable');

  // ...and a re-queue hands back the SAME id, which is what makes "same id =
  // already handled" work for the duplicate this branch deliberately allows.
  api.requeueHandoff(gid, a);
  assert.equal((await groupManager.takeHandoff(gid, 200)).id, a.id);
  groupManager.destroyGroup(gid);
});

// The documented ceiling is "the newest 100 and 32KB". restoreGroups enforced
// only the count, so a hand-edited or corrupted file could reintroduce an
// event the normal path could never produce.
test('#245: restore applies the 32KB summary cap, not just the count cap', async () => {
  const gid = await makeGroup();
  groupManager.pushHandoff(gid, { fromRole: 'workerA', summary: 'x', status: 'done' });
  const saved = JSON.parse(readFileSync(process.env.CCSERVER_GROUPS_PATH, 'utf-8')).find((g) => g.id === gid);
  saved.handoffQueue = [{ fromRole: 'workerA', summary: 'y'.repeat(200000), status: 'done' }];

  groupManager.destroyGroup(gid);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([saved]));
  groupManager.restoreGroups();

  const ev = await groupManager.takeHandoff(gid, 200);
  assert.equal(ev.summary.length, 32 * 1024, 'an oversized summary in the file is cut to the documented cap');
  groupManager.destroyGroup(gid);
});

// A re-queue put the queue at 101 and left it there.
test('#245: re-queueing a recovered event still honours the 100 cap', async () => {
  const gid = await makeGroup();
  const api = groupManager.getGroupManagerApi();
  for (let i = 0; i < 100; i += 1) groupManager.pushHandoff(gid, { fromRole: 'workerA', summary: `e${i}` });
  assert.equal(groupManager.getGroup(gid).handoffQueue.length, 100);

  api.requeueHandoff(gid, { fromRole: 'workerA', summary: 'recovered' });
  assert.equal(groupManager.getGroup(gid).handoffQueue.length, 100, 'the cap holds');
  assert.equal(groupManager.getGroup(gid).handoffQueue[0].summary, 'recovered',
    'and the recovered event is the next one out, not the one dropped');
  groupManager.destroyGroup(gid);
});

// #245 put persistGroups on the handoff hot path, so its write has to be safe
// to run there: not blockable, atomic, and not world-readable.
test('#245: the state file is written atomically, 0600, and never onto a planted path', async () => {
  const gid = await makeGroup();
  groupManager.pushHandoff(gid, { fromRole: 'workerA', summary: 'persisted' });

  const mode = statSync(process.env.CCSERVER_GROUPS_PATH).mode & 0o777;
  assert.equal(mode, 0o600, `the queue holds agent-written summaries; got ${mode.toString(8)}`);

  // No temp file is left behind on the happy path.
  const dir = dirname(process.env.CCSERVER_GROUPS_PATH);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [],
    'the temp file is renamed into place, not left lying around');
  groupManager.destroyGroup(gid);
});

// A file that exists but does not parse is total loss of every group AND every
// undelivered handoff -- the thing this branch promises survives a restart.
// index.js only logs when something WAS restored, so silence here made a total
// loss look exactly like a fresh install.
test('#245: an unparseable state file is reported, not silently dropped', () => {
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, '{ this is not json');
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...a) => { warnings.push(a.join(' ')); };
  try {
    assert.deepEqual(groupManager.restoreGroups(), { restored: 0, ids: [] });
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.length, 1, 'losing every group must not be silent');
  assert.match(warnings[0], /does not parse/);
  assert.match(warnings[0], /undelivered handoff/, 'and it must say what was lost');
});

test('onOrchestratorExit settles pending waiters as timedOut (no 15-min zombie)', async () => {
  const gid = await makeGroup();

  const wait = groupManager.takeHandoff(gid, 0); // never times out on its own
  assert.equal(groupManager.getGroup(gid).pendingTakes.size, 1);
  groupManager.onOrchestratorExit(gid);
  assert.equal(groupManager.getGroup(gid).pendingTakes.size, 0, 'waiters settled on orchestrator exit');
  const res = await Promise.race([
    wait,
    new Promise((r) => setTimeout(() => r('still-pending'), 500)),
  ]);
  assert.deepEqual(res, { timedOut: true });

  // The queue is untouched: a worker handoff after the exit is still
  // received by the next waiter.
  groupManager.pushHandoff(gid, { summary: 'after exit' });
  const next = await groupManager.takeHandoff(gid, 200);
  assert.deepEqual(next, { summary: 'after exit' });
});

test('destroyGroup settles pending takeHandoff waiters', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: '/srv/proj', orchestratorDir: '/srv/orch' });
  const wait = groupManager.takeHandoff(gid, 0); // never times out on its own
  groupManager.destroyGroup(gid);
  const res = await Promise.race([
    wait,
    new Promise((r) => setTimeout(() => r('still-pending'), 500)),
  ]);
  assert.deepEqual(res, { error: 'group-destroyed' });
});

test('pushHandoff records the turn moving to the orchestrator (with lastHandoffAt)', async () => {
  const gid = await makeGroup();
  groupManager.registerMember(gid, 'workerA', 'sess-a');
  groupManager.registerMember(gid, 'orchestrator', 'sess-o');

  assert.equal(groupManager.getGroup(gid).currentTurn, null);
  assert.equal(groupManager.getGroup(gid).lastHandoffAt, null);

  assert.equal(groupManager.pushHandoff(gid, { type: 'done', from: 'workerA', summary: 'x' }), true);
  const group = groupManager.getGroup(gid);
  assert.equal(group.currentTurn, 'orchestrator');
  assert.ok(group.lastHandoffAt, 'lastHandoffAt is stamped');
  assert.ok(group.lastHandoffAt <= Date.now());
});

test('pushHandoff honors an explicit nextRole for the incoming turn', async () => {
  const gid = await makeGroup();
  groupManager.registerMember(gid, 'workerA', 'sess-a');
  groupManager.registerMember(gid, 'workerB', 'sess-b');
  groupManager.registerMember(gid, 'orchestrator', 'sess-o');

  groupManager.pushHandoff(gid, { type: 'done', from: 'workerA', summary: 'passing to B', nextRole: 'workerB' });
  assert.equal(groupManager.getGroup(gid).currentTurn, 'workerB');
});

test('setCurrentTurn moves the turn to a registered role only', async () => {
  const gid = await makeGroup();
  groupManager.registerMember(gid, 'workerA', 'sess-a');
  groupManager.registerMember(gid, 'orchestrator', 'sess-o');

  assert.equal(groupManager.setCurrentTurn(gid, 'workerA'), true);
  assert.equal(groupManager.getGroup(gid).currentTurn, 'workerA');

  // Unknown role / unknown group are no-ops.
  assert.equal(groupManager.setCurrentTurn(gid, 'ghost'), false);
  assert.equal(groupManager.getGroup(gid).currentTurn, 'workerA');
  assert.equal(groupManager.setCurrentTurn('no-such-group', 'workerA'), false);
});

test('getRoleForSession maps a sessionId back to its role', async () => {
  const gid = await makeGroup();
  groupManager.registerMember(gid, 'workerA', 'sess-a');
  assert.equal(groupManager.getRoleForSession(gid, 'sess-a'), 'workerA');
  assert.equal(groupManager.getRoleForSession(gid, 'sess-unknown'), null);
  assert.equal(groupManager.getRoleForSession('no-such-group', 'sess-a'), null);
});

test('addMember refuses to grow a full group (member cap)', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: `/srv/proj-${gid}`, orchestratorDir: `/srv/orch-${gid}` });
  groupManager.registerMember(gid, 'orchestrator', 'sess-o');
  for (let i = 0; i < 7; i++) {
    groupManager.registerMember(gid, `worker${String.fromCharCode(65 + i)}`, `sess-${i}`);
  }
  assert.equal(groupManager.listGroupMembers(gid).length, 8);

  const res = await groupManager.addMember(gid, 'workerH', { app: 'claude', cwd: `/srv/proj-${gid}` });
  assert.equal(res.error, 'too-many-members');
  // The existing members are untouched.
  assert.equal(groupManager.listGroupMembers(gid).length, 8);

  groupManager.destroyGroup(gid);
});

// M1 (vuln_scan report / PoC p9): resolveMemberLaunchCwd/resolveGroupMcpSocket
// are the two resolvers a client-supplied groupRole reaches through
// terminal.js's `init` reconnect with no validation of its own (see
// terminal.js). Both must reject a malformed role outright -- WORKER_ROLE_RE's
// charset structurally excludes '/' and '.', so a match can never escape
// wherever it's later joined onto (worktreePathFor / sockPathFor).
test('M1: resolveMemberLaunchCwd rejects a malformed/traversal role', async () => {
  const gid = await makeGroup('/srv/proj');
  groupManager.registerMember(gid, 'workerA', 'sess-a1');
  for (const bad of ['../../../escape', 'a/../../../evil2', '../evil', 'worker/evil', 'not-worker-prefixed']) {
    assert.equal(groupManager.resolveMemberLaunchCwd(gid, bad), null, `${bad} must be rejected`);
  }
  // A well-formed role still resolves normally (this fixture's cwd is not a
  // real git repo, so it falls back to sharing it as-is -- see worktree.js).
  assert.deepEqual(groupManager.resolveMemberLaunchCwd(gid, 'workerA'), { cwd: '/srv/proj', gitCommonDir: null });
});

test('M1: resolveGroupMcpSocket rejects a malformed/traversal role', async () => {
  const gid = await makeGroup('/srv/proj');
  groupManager.registerMember(gid, 'workerA', 'sess-a1');
  for (const bad of ['../../../escape', 'a/../../../evil2']) {
    assert.equal(await groupManager.resolveGroupMcpSocket(gid, bad), null, `${bad} must be rejected`);
  }
});

test('destroyGroup never removes the orchestratorDir (per-project resource)', async () => {
  const gid = randomUUID();
  const dir = join(runtimeDir, `project-dir-${gid}`);
  mkdirSync(dir, { recursive: true });
  await groupManager.createGroup({ groupId: gid, cwd: '/srv/proj', orchestratorDir: dir });
  groupManager.destroyGroup(gid);
  assert.equal(existsSync(dir), true, 'orchestratorDir must survive the group being destroyed');
});

test('listGroups reports membership and live-ness', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: '/srv/proj', orchestratorDir: '/srv/orch' });
  groupManager.registerMember(gid, 'workerA', 'sess-a');

  const entry = groupManager.listGroups().find((g) => g.groupId === gid);
  assert.ok(entry);
  assert.equal(entry.cwd, '/srv/proj');
  assert.equal(entry.memberCount, 1);
  assert.equal(entry.liveCount, 0, 'a fake session id is not a live session');

  groupManager.destroyGroup(gid);
  assert.equal(groupManager.listGroups().some((g) => g.groupId === gid), false);
});

// The assembly race (routes/groups.js): workerA's pty crashes while workerB
// and the orchestrator are still being spawned. Before markGroupAssembled()
// the "no live members" auto-destroy in onSessionExit must NOT fire -- the
// half-built group (and its control broker) has to survive so the remaining
// members can still be registered.
test('a member exiting mid-assembly does not auto-destroy the group; it does after assembly', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: '/srv/proj', orchestratorDir: '/srv/orch' });
  groupManager.registerMember(gid, 'workerA', 'sess-a');
  groupsToDestroy.push(gid);

  // workerA died right after registering; siblings don't exist yet. The
  // group (and the control broker created by createGroup) must survive.
  groupManager.onSessionExit({ id: 'sess-a', groupId: gid, groupRole: 'workerA', exited: true });
  assert.ok(groupManager.getGroup(gid), 'assembling group must survive a member crash');

  // Once assembly completes, the normal rule applies again: all dead -> gone.
  groupManager.registerMember(gid, 'workerB', 'sess-b');
  groupManager.registerMember(gid, 'orchestrator', 'sess-o');
  groupManager.markGroupAssembled(gid);
  groupManager.onSessionExit({ id: 'sess-a', groupId: gid, groupRole: 'workerA', exited: true });
  groupManager.onSessionExit({ id: 'sess-b', groupId: gid, groupRole: 'workerB', exited: true });
  groupManager.onSessionExit({ id: 'sess-o', groupId: gid, groupRole: 'orchestrator', exited: true });
  assert.equal(groupManager.getGroup(gid), null, 'assembled group with no live members self-destructs');
});

test('restoreGroups matches member resume info from .saved-sessions.json (restored members)', async () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `restore-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    orchestratorApp: 'claude',
    instructions: '# Orch',
    sandboxOpts: { gpg: true },
    members: { workerA: 'dead-sess-a', orchestrator: 'dead-sess-o' },
  }]));
  // A graceful shutdown saved these with their group membership; the
  // 'another-group' entry must NOT leak into this group's members.
  writeFileSync(process.env.CCSERVER_SAVED_SESSIONS_PATH, JSON.stringify([
    { cwd: '/srv/proj', claudeSessionId: 'conv-1', sandbox: true, sandboxOpts: { gpg: true }, app: 'claude', groupId: gid, groupRole: 'workerA' },
    { cwd: orchDir, claudeSessionId: null, sandbox: true, sandboxOpts: null, app: 'opencode', groupId: gid, groupRole: 'orchestrator' },
    { cwd: '/other', claudeSessionId: 'conv-x', sandbox: true, sandboxOpts: null, app: 'claude', groupId: 'another-group', groupRole: 'workerA' },
  ]));
  groupsToDestroy.push(gid);

  const info = groupManager.restoreGroups();
  assert.equal(info.restored, 1);

  const members = groupManager.listGroupMembers(gid);
  const workerA = members.find((m) => m.role === 'workerA');
  assert.equal(workerA.restored, true, 'pty gone but resume info matched from the saved session');
  assert.equal(workerA.claudeSessionId, 'conv-1');
  assert.equal(workerA.app, 'claude');
  assert.equal(workerA.sandbox, true);
  assert.equal(workerA.sandboxOpts.gpg, true);
  const orch = members.find((m) => m.role === 'orchestrator');
  assert.equal(orch.restored, true);
  assert.equal(orch.app, 'opencode');
  assert.equal(workerA.cwd, '/srv/proj');
  // Restored members have no live pty, hence no activity timestamp (Issue #16).
  assert.equal(workerA.lastOutputAt, null);
  assert.equal(workerA.idleForMs, null);
  assert.equal(workerA.autoYes, null, 'restored member has no live session -> autoYes null');
  assert.equal(orch.lastOutputAt, null);
  assert.equal(orch.idleForMs, null);
});

// Issue #16: live members carry their activity timestamp through
// list_group_sessions so the orchestrator can scan the whole group for a
// stuck member in one call (fake session facade -- no real pty needed).
test('listGroupMembers: live sessions report lastOutputAt/idleForMs; session-less members report null', async () => {
  const gid = await makeGroup();
  const lastOutputAt = Date.now() - 3000;
  const fake = {
    getSession: (id) => (id === 'live-sess' ? { exited: false, socket: null, lastOutputAt, autoYes: true } : null),
    createSession: () => { throw new Error('unused'); },
    destroySession: () => {},
    writeToSession: () => false,
    dockerAvailability: () => ({ dockerAvailable: null, dockerReason: null }),
    activitySnapshot: fakeActivitySnapshot,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.registerMember(gid, 'workerA', 'live-sess');
    groupManager.registerMember(gid, 'orchestrator', 'dead-sess');
    const members = groupManager.listGroupMembers(gid);
    const workerA = members.find((m) => m.role === 'workerA');
    const orch = members.find((m) => m.role === 'orchestrator');
    assert.equal(workerA.lastOutputAt, lastOutputAt);
    assert.ok(workerA.idleForMs >= 3000 && workerA.idleForMs <= 4000, `idleForMs must be the time since the last output (got ${workerA.idleForMs})`);
    assert.equal(workerA.autoYes, true, 'live session carries its autoYes state');
    assert.equal(orch.lastOutputAt, null, 'no live session -> no timestamp');
    assert.equal(orch.idleForMs, null);
    assert.equal(orch.autoYes, null, 'no live session -> autoYes null');
    // The tab-colour reading rides along on the same listing (activity.js).
    assert.equal(workerA.activity.level, 'idle', 'a live member with nothing drawn yet is the user\'s turn');
    assert.equal(orch.activity.level, null, 'no live session -> no level to show');
    assert.equal(orch.activity.reason, 'no-session');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

// The orchestrator must always be the leftmost/active tab and the first
// list_group_sessions entry, even though the real launch order (routes/groups.js)
// registers the workers first and the orchestrator last.
test('listGroupMembers: orchestrator is always first regardless of registration order', async () => {
  const gid = await makeGroup();
  const fake = {
    getSession: () => null,
    createSession: () => { throw new Error('unused'); },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    // Real launch order (routes/groups.js): workers first, orchestrator last;
    // open_tab appends workerC.
    groupManager.registerMember(gid, 'workerA', 'sess-a');
    groupManager.registerMember(gid, 'workerB', 'sess-b');
    groupManager.registerMember(gid, 'orchestrator', 'sess-o');
    groupManager.registerMember(gid, 'workerC', 'sess-c');
    assert.deepEqual(
      groupManager.listGroupMembers(gid).map((m) => m.role),
      ['orchestrator', 'workerA', 'workerB', 'workerC'],
      'orchestrator must sort to the front; other roles keep insertion order',
    );
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

test('listGroupMembers keeps the orchestrator first after restoreGroups', async () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `restore-first-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    orchestratorApp: 'claude',
    instructions: null,
    sandboxOpts: null,
    members: { workerA: 'dead-a', workerB: 'dead-b', orchestrator: 'dead-o' },
  }]));
  groupsToDestroy.push(gid);

  groupManager.restoreGroups();
  const members = groupManager.listGroupMembers(gid);
  assert.deepEqual(
    members.map((m) => m.role),
    ['orchestrator', 'workerA', 'workerB'],
    'restored members keep the orchestrator first',
  );
});
// --- getOrchestratorSandboxOpts / getRegisteredMemberSandboxOpts: the
// resolution helpers openTab (mcpTools.js) uses to cap a genuinely new
// member's sandboxOpts against the orchestrator's own current grant, and to
// keep an already-registered member's sandboxOpts unchanged across a restart
// (see the sandboxOpts privilege-escalation fix plan).

test('getOrchestratorSandboxOpts: prefers the live orchestrator session sandboxOpts', async () => {
  const gid = await makeGroup();
  const fake = {
    getSession: (id) => (id === 'orch-sess' ? { sandboxOpts: { gpg: true, sshAgent: false } } : null),
    createSession: () => { throw new Error('unused'); },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.registerMember(gid, 'orchestrator', 'orch-sess');
    assert.deepEqual(groupManager.getOrchestratorSandboxOpts(gid), { gpg: true, sshAgent: false });
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

test('getOrchestratorSandboxOpts: falls back to memberSaved when no live session', async () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `orch-saved-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    orchestratorApp: 'claude',
    instructions: null,
    sandboxOpts: null,
    members: { orchestrator: 'dead-orch-sess' },
  }]));
  writeFileSync(process.env.CCSERVER_SAVED_SESSIONS_PATH, JSON.stringify([
    { cwd: orchDir, claudeSessionId: null, sandbox: true, sandboxOpts: { gpg: false, sshAgent: true }, app: 'claude', groupId: gid, groupRole: 'orchestrator' },
  ]));
  groupsToDestroy.push(gid);

  groupManager.restoreGroups();
  assert.deepEqual(groupManager.getOrchestratorSandboxOpts(gid), { gpg: false, sshAgent: true });
});

test('getOrchestratorSandboxOpts: falls back to memberPrefs.orchestrator.sandboxOpts when no session or saved info', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({
    groupId: gid,
    cwd: '/srv/proj',
    orchestratorDir: join(runtimeDir, gid),
    orchestratorSandboxOpts: { gpg: true, sshAgent: true },
  });
  groupsToDestroy.push(gid);
  assert.deepEqual(groupManager.getOrchestratorSandboxOpts(gid), { gpg: true, sshAgent: true, gpgVault: false });
});

test('getOrchestratorSandboxOpts: unknown groupId returns null', () => {
  assert.equal(groupManager.getOrchestratorSandboxOpts('no-such-group'), null);
});

test('getRegisteredMemberSandboxOpts: unregistered role reports registered:false, sandboxOpts:null', async () => {
  const gid = await makeGroup();
  assert.deepEqual(groupManager.getRegisteredMemberSandboxOpts(gid, 'workerA'), { registered: false, sandboxOpts: null });
});

test('getRegisteredMemberSandboxOpts: registered role prefers the live session sandboxOpts', async () => {
  const gid = await makeGroup();
  const fake = {
    getSession: (id) => (id === 'live-worker' ? { sandboxOpts: { gpg: true, sshAgent: true } } : null),
    createSession: () => { throw new Error('unused'); },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.registerMember(gid, 'workerA', 'live-worker');
    assert.deepEqual(groupManager.getRegisteredMemberSandboxOpts(gid, 'workerA'), {
      registered: true,
      sandboxOpts: { gpg: true, sshAgent: true },
    });
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

test('getRegisteredMemberSandboxOpts: dead session falls back to memberSaved (the restart case)', async () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `worker-saved-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    orchestratorApp: 'claude',
    instructions: null,
    sandboxOpts: null,
    members: { workerA: 'dead-worker-sess' },
  }]));
  writeFileSync(process.env.CCSERVER_SAVED_SESSIONS_PATH, JSON.stringify([
    { cwd: '/srv/proj', claudeSessionId: 'conv-1', sandbox: true, sandboxOpts: { gpg: true, sshAgent: false }, app: 'claude', groupId: gid, groupRole: 'workerA' },
  ]));
  groupsToDestroy.push(gid);

  groupManager.restoreGroups();
  assert.deepEqual(groupManager.getRegisteredMemberSandboxOpts(gid, 'workerA'), {
    registered: true,
    sandboxOpts: { gpg: true, sshAgent: false },
  });
});

// --- addMember (open_tab) spawn/teardown paths, exercised with a fake
// session facade (no real ptys): the atomic-replacement invariant -- the old
// member is only destroyed AFTER the new channel + session exist, and a
// failure anywhere leaves the old member fully usable.

test('addMember refuses copilot/commandcode explicitly and corrects the fallback to claude', async () => {
  const gid = await makeGroup();
  let seenApp = null;
  const fake = {
    getSession: () => null,
    createSession: (opts) => { seenApp = opts.app; return { sessionId: 'sess-c', session: {} }; },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    // An explicit copilot request is refused before any spawn.
    const res = await groupManager.addMember(gid, 'workerA', { app: 'copilot', cwd: '/srv/proj' });
    assert.equal(res.error, 'bad-request');
    assert.match(res.message, /not supported in groups/);
    assert.equal(seenApp, null, 'no spawn attempt for the refused member');
    // Same for commandcode (no verified MCP injection).
    const resCc = await groupManager.addMember(gid, 'workerA', { app: 'commandcode', cwd: '/srv/proj' });
    assert.equal(resCc.error, 'bad-request');
    assert.match(resCc.message, /not supported in groups/);
    assert.match(resCc.message, /commandcode/);
    assert.equal(seenApp, null, 'no spawn attempt for the refused member');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }

  // A persisted member pref landing on copilot (legacy group) is corrected to
  // claude instead of failing the launch.
  const gid2 = randomUUID();
  await groupManager.createGroup({
    groupId: gid2,
    cwd: '/srv/proj',
    orchestratorDir: join(runtimeDir, gid2),
    memberPrefs: { workerB: { app: 'copilot' } },
  });
  groupsToDestroy.push(gid2);
  groupManager.setSessionApiForTests(fake);
  try {
    const res = await groupManager.addMember(gid2, 'workerB', { cwd: '/srv/proj' });
    assert.equal(res.error, undefined, `fallback-resolved addMember should not fail: ${res.message || ''}`);
    assert.equal(seenApp, 'claude', 'copilot fallback corrected to claude');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid2);
  }
});

test('addMember spawns a session and registers it with a handoff channel (open_tab path)', async () => {
  const gid = await makeGroup();
  let seenOpts = null;
  const fake = {
    getSession: () => null,
    createSession: (opts) => { seenOpts = opts; return { sessionId: 'sess-new', session: {} }; },
    destroySession: () => { throw new Error('nothing to destroy on a fresh role'); },
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    const res = await groupManager.addMember(gid, 'workerA', { app: 'claude', cwd: '/srv/proj' });
    assert.equal(res.sessionId, 'sess-new');
    assert.equal(seenOpts.groupRole, 'workerA');
    assert.equal(seenOpts.sandbox, true);
    assert.equal(seenOpts.cwd, '/srv/proj');
    assert.ok(seenOpts.mcpSocketPath, 'session launched with the channel socket bound');
    assert.equal(groupManager.isSessionInGroup(gid, 'sess-new'), true);
    const ch = groupManager.getGroup(gid).handoffChannels.get('workerA');
    assert.ok(ch, 'handoff channel created');
    assert.equal(ch.sessionId, 'sess-new', 'channel bound to the new member');
    assert.ok(existsSync(ch.sockPath), 'channel socket file exists on disk');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

test('addMember replacing an existing role is atomic: old session destroyed only after the new one is in place', async () => {
  const gid = await makeGroup();
  groupManager.registerMember(gid, 'workerA', 'sess-old');
  await groupManager.createMemberHandoffChannel(gid, 'workerA'); // as a launched member would have
  const oldChannel = groupManager.getGroup(gid).handoffChannels.get('workerA');
  assert.equal(oldChannel.sessionId, 'sess-old');

  const destroyed = [];
  const fake = {
    getSession: () => null,
    createSession: (opts) => {
      assert.equal(opts.groupRole, 'workerA');
      return { sessionId: 'sess-new', session: {} };
    },
    destroySession: (sid) => destroyed.push(sid),
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    const res = await groupManager.addMember(gid, 'workerA', { app: 'claude', cwd: '/srv/proj' });
    assert.equal(res.sessionId, 'sess-new');
    assert.equal(groupManager.isSessionInGroup(gid, 'sess-old'), false, 'old member unregistered');
    assert.equal(groupManager.isSessionInGroup(gid, 'sess-new'), true);
    assert.deepEqual(destroyed, ['sess-old'], 'old session destroyed exactly once, after the swap');
    const ch = groupManager.getGroup(gid).handoffChannels.get('workerA');
    assert.ok(ch && ch !== oldChannel, 'channel replaced');
    assert.equal(ch.sessionId, 'sess-new');
    assert.ok(existsSync(ch.sockPath), 'replacement channel socket file exists');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

test('addMember spawn failure leaves the previous member and its channel intact', async () => {
  const gid = await makeGroup();
  groupManager.registerMember(gid, 'workerA', 'sess-old');
  await groupManager.createMemberHandoffChannel(gid, 'workerA');

  const fake = {
    getSession: () => null,
    createSession: () => ({ error: 'spawn failed' }),
    destroySession: () => { throw new Error('the old session must never be destroyed on spawn failure'); },
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    const res = await groupManager.addMember(gid, 'workerA', { app: 'claude', cwd: '/srv/proj' });
    assert.equal(res.error, 'spawn-failed');
    assert.equal(groupManager.isSessionInGroup(gid, 'sess-old'), true, 'old member untouched');
    const ch = groupManager.getGroup(gid).handoffChannels.get('workerA');
    assert.ok(ch, 'channel restored for the old member');
    assert.equal(ch.sessionId, 'sess-old');
    assert.ok(existsSync(ch.sockPath), 'restored channel is listening again (socket file recreated)');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

// --- memberPrefs: per-role launch preferences (app/model/sandboxOpts) -------

test('createGroup persists memberPrefs for all three roles; workers fall back to the group sandbox flags', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({
    groupId: gid,
    cwd: '/srv/proj',
    orchestratorDir: join(runtimeDir, gid),
    sandboxOpts: { gpg: true, sshAgent: false },
    memberPrefs: {
      workerA: { app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: false, sshAgent: true } },
      workerB: { app: 'claude', model: null, sandboxOpts: null },
      orchestrator: { app: 'claude', model: 'gpt-5', sandboxOpts: null },
    },
  });
  groupsToDestroy.push(gid);

  const prefs = groupManager.getMemberPrefs(gid);
  assert.deepEqual(prefs.workerA, { name: null, app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: false, sshAgent: true, gpgVault: false } });
  assert.deepEqual(prefs.workerB, { name: null, app: 'claude', model: null, sandboxOpts: null });
  assert.deepEqual(prefs.orchestrator, { name: null, app: 'claude', model: 'gpt-5', sandboxOpts: null });

  const group = groupManager.getGroup(gid);
  assert.equal(group.orchestratorApp, 'claude');
  assert.equal(group.orchestratorModel, 'gpt-5');

  // The persisted file carries memberPrefs (survives a restart).
  const saved = JSON.parse(readFileSync(process.env.CCSERVER_GROUPS_PATH, 'utf-8'));
  const entry = saved.find((g) => g.id === gid);
  assert.deepEqual(entry.memberPrefs.workerA, { name: null, app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: false, sshAgent: true, gpgVault: false } });
});

// Issue #182: normalizeSandboxOpts's allowlist copied only gpg/sshAgent(/tools),
// silently dropping gpgVault -- every combo/group launch path funnels
// sandboxOpts through this one function, so a per-role gpgVault:true request
// from the client was thrown away here before sandbox.js ever saw it, and
// sandbox.js's own `sandboxOpts?.gpgVault ?? cfgGpgVault` fallback then
// silently launched without the vault (no error, no warning) -- exactly the
// "silent downgrade of what the caller requested" sandbox.js's own gpgVault
// gate comment says must never happen. Single (non-group) launches never go
// through this function (routes/sessions.js passes body.sandboxOpts through
// unmodified), so this is a group/combo-launch-only gap.
test('normalizeSandboxOpts carries gpgVault through, same as gpg/sshAgent (issue #182)', () => {
  assert.deepEqual(groupManager.normalizeSandboxOpts({ gpgVault: true }), { gpg: false, sshAgent: false, gpgVault: true });
  assert.deepEqual(groupManager.normalizeSandboxOpts({ gpg: true, sshAgent: true, gpgVault: true }),
    { gpg: true, sshAgent: true, gpgVault: true });
  // Absent/falsy still normalizes to false, same as gpg/sshAgent -- never
  // undefined, which sandbox.js would treat as "unspecified" and fall back
  // to the server's global default instead of the caller's explicit false.
  assert.equal(groupManager.normalizeSandboxOpts({ gpg: true }).gpgVault, false);
  assert.equal(groupManager.normalizeSandboxOpts(null), null);
});

test('memberPrefs defaults: omitted worker sandboxOpts inherit the group flags, orchestrator has none', async () => {
  const gid = await makeGroup();
  const prefs = groupManager.getMemberPrefs(gid);
  // Default group has no sandboxOpts, so workers fall back to null.
  assert.deepEqual(prefs.workerA, { name: null, app: null, model: null, sandboxOpts: null });
  assert.deepEqual(prefs.orchestrator, { name: null, app: null, model: null, sandboxOpts: null });
});

test('setMemberPrefs updates a role and keeps orchestratorApp/orchestratorModel in sync', async () => {
  const gid = await makeGroup();
  assert.equal(groupManager.setMemberPrefs(gid, 'workerA', { app: 'opencode', model: 'gpt-5' }), true);
  assert.deepEqual(groupManager.getMemberPrefs(gid, 'workerA'), { name: null, app: 'opencode', model: 'gpt-5', sandboxOpts: null });

  groupManager.setMemberPrefs(gid, 'orchestrator', { app: 'opencode', model: 'claude-opus', sandboxOpts: { gpg: true } });
  const group = groupManager.getGroup(gid);
  assert.equal(group.orchestratorApp, 'opencode');
  assert.equal(group.orchestratorModel, 'claude-opus');

  assert.equal(groupManager.setMemberPrefs('no-such-group', 'workerA', {}), false);
});

test('restoreGroups rebuilds memberPrefs (with legacy orchestratorApp migration)', async () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `prefs-restore-${gid}`);
  // Legacy shape: orchestratorApp exists but no memberPrefs field.
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    orchestratorApp: 'opencode',
    instructions: '# Orch',
    sandboxOpts: { gpg: true },
    members: { workerA: 'dead-a', workerB: 'dead-b', orchestrator: 'dead-o' },
  }]));
  groupsToDestroy.push(gid);

  groupManager.restoreGroups();
  const prefs = groupManager.getMemberPrefs(gid);
  // Legacy orchestratorApp migrates into the orchestrator preference.
  assert.equal(prefs.orchestrator.app, 'opencode');
  // Workers have no app preference (legacy groups had none) but inherit the
  // group sandboxOpts fallback.
  assert.deepEqual(prefs.workerA.sandboxOpts, { gpg: true, sshAgent: false, gpgVault: false });
  assert.equal(groupManager.getGroup(gid).orchestratorApp, 'opencode');
});

test('restoreGroups: persisted memberPrefs round-trip (model preserved)', async () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `prefs-rt-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    orchestratorApp: 'claude',
    instructions: '# Orch',
    sandboxOpts: null,
    memberPrefs: {
      workerA: { app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: false, sshAgent: true } },
      workerB: { app: 'claude', model: null, sandboxOpts: null },
      orchestrator: { app: 'claude', model: 'gpt-5', sandboxOpts: null },
    },
    members: { workerA: 'dead-a', workerB: 'dead-b', orchestrator: 'dead-o' },
  }]));
  groupsToDestroy.push(gid);

  groupManager.restoreGroups();
  const prefs = groupManager.getMemberPrefs(gid);
  assert.deepEqual(prefs.workerA, { name: null, app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: false, sshAgent: true, gpgVault: false } });
  assert.deepEqual(prefs.workerB, { name: null, app: 'claude', model: null, sandboxOpts: null });
  assert.deepEqual(prefs.orchestrator, { name: null, app: 'claude', model: 'gpt-5', sandboxOpts: null });
});

test('restoreGroups: open_tab-created extra roles keep their memberPrefs (workerC survives restart)', async () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `prefs-extra-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    orchestratorApp: 'claude',
    instructions: null,
    sandboxOpts: { gpg: true, sshAgent: false },
    memberPrefs: {
      workerA: { app: 'opencode', model: null, sandboxOpts: { gpg: true, sshAgent: false } },
      workerB: { app: 'opencode', model: null, sandboxOpts: { gpg: true, sshAgent: false } },
      orchestrator: { app: 'claude', model: null, sandboxOpts: null },
      workerC: { app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: false, sshAgent: true } },
    },
    members: { workerA: 'dead-a', workerB: 'dead-b', orchestrator: 'dead-o', workerC: 'dead-c' },
  }]));
  groupsToDestroy.push(gid);

  groupManager.restoreGroups();
  const prefs = groupManager.getMemberPrefs(gid);
  assert.deepEqual(prefs.workerC, { name: null, app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: false, sshAgent: true, gpgVault: false } },
    'a non-fixed-trio worker role must not lose its preference on restore');
  assert.ok('workerA' in prefs, 'the fixed trio is still normalized');
});


test('addMember resolves options by precedence: explicit > memberPrefs > defaults', async () => {
  const gid = await makeGroup();
  const fake = {
    getSession: () => null,
    createSession: (opts) => {
      seenOpts = opts;
      return { sessionId: `sess-${opts.app}-${opts.model || 'null'}-${opts.sandboxOpts?.gpg ?? 'null'}-${opts.sandboxOpts?.sshAgent ?? 'null'}`, session: {} };
    },
    destroySession: () => {},
    writeToSession: () => false,
  };
  let seenOpts = null;
  groupManager.setSessionApiForTests(fake);
  try {
    // No memberPrefs, no explicit options: app falls back to the sandbox
    // config default, model null, sandboxOpts to the group level (null here).
    const r1 = await groupManager.addMember(gid, 'workerA', { cwd: '/srv/proj' });
    assert.equal(r1.error, undefined, `default-resolved addMember should not fail: ${r1.message || ''}`);
    assert.equal(seenOpts.model, null);
    assert.equal(seenOpts.sandboxOpts, null);
    assert.equal(r1.model, null);

    // Set a preference, then omit the option: preference wins.
    groupManager.setMemberPrefs(gid, 'workerA', { app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: true, sshAgent: false } });
    const r2 = await groupManager.addMember(gid, 'workerA', { cwd: '/srv/proj' });
    assert.equal(seenOpts.app, 'opencode');
    assert.equal(seenOpts.model, 'gpt-5');
    assert.deepEqual(seenOpts.sandboxOpts, { gpg: true, sshAgent: false, gpgVault: false });
    assert.deepEqual(r2.sandboxOpts, { gpg: true, sshAgent: false, gpgVault: false });

    // Explicit options beat the preference.
    const r3 = await groupManager.addMember(gid, 'workerA', { app: 'claude', model: 'claude-sonnet', cwd: '/srv/proj', sandboxOpts: { gpg: false, sshAgent: true } });
    assert.equal(seenOpts.app, 'claude');
    assert.equal(seenOpts.model, 'claude-sonnet');
    assert.deepEqual(seenOpts.sandboxOpts, { gpg: false, sshAgent: true, gpgVault: false });

    // Explicit model null means "app default" -- must override the preference.
    const r4 = await groupManager.addMember(gid, 'workerA', { model: null, cwd: '/srv/proj' });
    assert.equal(seenOpts.model, null);
    assert.equal(r4.model, null);

    // A failed replacement must not clobber the preference: after r4 the
    // stored pref is app=claude/model=null (r3's app + r4's explicit null
    // model), and the failed explicit spawn (claude/claude-sonnet) must leave
    // it alone.
    const failing = { getSession: () => null, createSession: () => ({ error: 'boom' }), destroySession: () => {}, writeToSession: () => false };
    groupManager.setSessionApiForTests(failing);
    await groupManager.addMember(gid, 'workerA', { app: 'claude', model: 'claude-sonnet', cwd: '/srv/proj' });
    assert.deepEqual(groupManager.getMemberPrefs(gid, 'workerA'), { name: null, app: 'claude', model: null, sandboxOpts: { gpg: false, sshAgent: true, gpgVault: false } }, 'failed spawn must leave the old preference untouched');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

test('addMember stores the effective launch data as the role preference (atomic with registration)', async () => {
  const gid = await makeGroup();
  const fake = {
    getSession: () => null,
    createSession: () => ({ sessionId: 'sess-new', session: { model: 'gpt-5' } }),
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    const res = await groupManager.addMember(gid, 'workerA', { app: 'opencode', model: 'gpt-5', cwd: '/srv/proj', sandboxOpts: { gpg: true } });
    assert.equal(res.error, undefined);
    assert.deepEqual(groupManager.getMemberPrefs(gid, 'workerA'), { name: null, app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: true, sshAgent: false, gpgVault: false } });
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

// generateOrchestratorClaudeMdSrc: merges server/ws/orchestrator-template.md
// with the group's saved custom instructions and writes the result to a
// host-only path (see sandbox.js's ro-bind overlay). templateCopyPath (set
// in before()) is a throwaway copy seeded from the real template via
// CCSERVER_ORCHESTRATOR_TEMPLATE_PATH -- the "template edit lands on the
// next generation" case below edits it in place, which would race with
// other test files reading the real, repo-tracked template concurrently if
// it targeted that file directly.

test('generateOrchestratorClaudeMdSrc: no custom instructions -> content is exactly the template', async () => {
  const gid = await makeGroup();
  const dest = groupManager.generateOrchestratorClaudeMdSrc(gid);
  assert.ok(dest, 'a destination path is returned');
  const template = readFileSync(templateCopyPath, 'utf-8');
  assert.equal(readFileSync(dest, 'utf-8'), template);
});

test('generateOrchestratorClaudeMdSrc: custom instructions are appended under a dedicated heading, template stays intact', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({
    groupId: gid,
    cwd: '/srv/proj-custom',
    orchestratorDir: join(runtimeDir, gid),
    instructions: '# My custom project notes',
  });
  groupsToDestroy.push(gid);
  const dest = groupManager.generateOrchestratorClaudeMdSrc(gid);
  const content = readFileSync(dest, 'utf-8');
  const template = readFileSync(templateCopyPath, 'utf-8');
  assert.ok(content.startsWith(template), 'template is included verbatim (never substituted)');
  assert.match(content, /## プロジェクト固有の指示 \(ユーザー設定\)/);
  assert.match(content, /# My custom project notes/);
});

test('generateOrchestratorClaudeMdSrc: same orchestratorDir -> same path, regenerated content reflects a template edit', async () => {
  const gid = await makeGroup('/srv/proj-regen');
  const destA = groupManager.generateOrchestratorClaudeMdSrc(gid);
  const destB = groupManager.generateOrchestratorClaudeMdSrc(gid);
  assert.equal(destA, destB, 'the generated path is stable for a given orchestratorDir');

  const original = readFileSync(templateCopyPath, 'utf-8');
  try {
    writeFileSync(templateCopyPath, '# Edited Orchestrator Template\n');
    const destC = groupManager.generateOrchestratorClaudeMdSrc(gid);
    assert.equal(destC, destA, 'still the same path');
    assert.equal(
      readFileSync(destC, 'utf-8'),
      '# Edited Orchestrator Template\n',
      'a template edit lands on the very next generation, no caching',
    );
  } finally {
    writeFileSync(templateCopyPath, original);
  }
});

test('generateOrchestratorClaudeMdSrc: unknown groupId returns null', () => {
  assert.equal(groupManager.generateOrchestratorClaudeMdSrc(randomUUID()), null);
});

test('an arbitrary worker role keeps its display name in memberPrefs, persistence and listGroupMembers', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({
    groupId: gid,
    cwd: '/srv/proj',
    orchestratorDir: join(runtimeDir, gid),
    // POST /groups' workers[] path passes name/app/model/sandboxOpts keyed by
    // the (arbitrary) worker role.
    memberPrefs: {
      workerImplement: { name: '実装担当', app: 'codex', model: 'gpt-5.4', sandboxOpts: null },
      orchestrator: { app: 'claude', model: null, sandboxOpts: null },
    },
  });
  groupsToDestroy.push(gid);
  groupManager.registerMember(gid, 'workerImplement', 'sess-impl');

  const member = groupManager.listGroupMembers(gid).find((m) => m.role === 'workerImplement');
  assert.equal(member.name, '実装担当');

  const saved = JSON.parse(readFileSync(process.env.CCSERVER_GROUPS_PATH, 'utf-8'));
  const entry = saved.find((g) => g.id === gid);
  assert.equal(entry.memberPrefs.workerImplement.name, '実装担当', 'display name persisted');

  // setMemberPrefs without a name keeps the existing one (fallback merge).
  groupManager.setMemberPrefs(gid, 'workerImplement', { app: 'claude', model: null, sandboxOpts: null });
  assert.equal(groupManager.getMemberPrefs(gid, 'workerImplement').name, '実装担当');
  // An explicit new name wins.
  groupManager.setMemberPrefs(gid, 'workerImplement', { name: '実装二番手', app: 'claude' });
  assert.equal(groupManager.getMemberPrefs(gid, 'workerImplement').name, '実装二番手');
});

test('restoreGroups: legacy records without a display name restore with name null (role fallback)', () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `orch-name-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    members: { workerA: 'dead-a' },
    memberPrefs: { workerA: { app: 'opencode', model: null, sandboxOpts: null } },
  }]));
  const info = groupManager.restoreGroups();
  assert.ok(info.ids.includes(gid));
  const member = groupManager.listGroupMembers(gid).find((m) => m.role === 'workerA');
  assert.equal(member.name, null, 'no name in the old record -> null, UI shows the role');
  assert.equal(member.app, 'opencode');
});

test('restoreGroups: a persisted display name survives a restart for arbitrary roles', () => {
  const gid = randomUUID();
  const orchDir = join(runtimeDir, `orch-name2-${gid}`);
  writeFileSync(process.env.CCSERVER_GROUPS_PATH, JSON.stringify([{
    id: gid,
    createdAt: 1,
    cwd: '/srv/proj',
    allowedCwds: ['/srv/proj'],
    orchestratorDir: orchDir,
    members: { workerReview: 'dead-r' },
    memberPrefs: { workerReview: { name: 'レビュー担当', app: 'claude', model: 'm', sandboxOpts: null } },
  }]));
  groupManager.restoreGroups();
  const member = groupManager.listGroupMembers(gid).find((m) => m.role === 'workerReview');
  assert.equal(member.name, 'レビュー担当');
});
