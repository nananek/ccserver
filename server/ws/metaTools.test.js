// Unit tests for the META agent tool layer (metaTools.js). Everything is a
// fake: no DB, no ptys, no sockets -- deps are injected exactly the way
// metaAgent.ensureMetaAgentBroker assembles them, so a facade/real mismatch
// breaks these tests first. Focus:
//   - the destructive three's fixed order: validate -> SELF-TARGET GUARD
//     (fail closed, NO dialog) -> approval -> execute;
//   - approval outcomes (approved / user-rejected / timeout /
//     infrastructure-failure) never execute anything unless approved;
//   - privilege capping on every launch path against the meta agent's own
//     current sandboxOpts grant (silently downgraded, never an error);
//   - result-shape conventions ({ error: code, message } failures).
//
// MCP SDK / bwrap / browser / agent CLIs are NOT required.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as tools from './metaTools.js';

const MY_SESSION_ID = 'meta-session-0001';
const MY_GROUP_ID = null; // standalone launch (plan section 6-1)

function fakeIdentitySession(sandboxOpts = null) {
  return { id: MY_SESSION_ID, cwd: '/srv/meta', app: 'claude', shell: false, sandboxOpts };
}

function makeDeps({
  identity = { sessionId: MY_SESSION_ID, groupId: MY_GROUP_ID },
  mySandboxOpts = null,
} = {}) {
  const calls = {
    approvals: [],
    destroyedSessions: [],
    destroyedGroups: [],
    createdViaApi: [],
    launchedGroups: [],
    deletedHomes: [],
    beginDelete: [],
    endDelete: [],
    createdDirs: [],
    browsed: [],
  };

  const mySession = fakeIdentitySession(mySandboxOpts);
  const sessions = new Map([[MY_SESSION_ID, mySession]]);

  const groups = new Map();
  let dindLock = false;
  let deleteInFlight = false;
  let homeInUseCount = 0;

  const deps = {
    identity,
    connectionIsAlive: () => true,
    groupManager: {
      listGroups: () => [...groups.values()],
      getGroupSummary: (id) => groups.get(id) ?? null,
      destroyGroup: (id) => {
        calls.destroyedGroups.push(id);
        groups.delete(id);
      },
    },
    sessionManager: {
      listSessions: () => [...sessions.values()].map((s) => ({ id: s.id, cwd: s.cwd })),
      getSession: (id) => sessions.get(id) ?? null,
      destroySession: (id, opts = {}) => {
        calls.destroyedSessions.push([id, opts]);
        sessions.delete(id);
      },
      sandboxHomeInUsePath: () => homeInUseCount,
    },
    approvalsApi: {
      APPROVAL_KINDS: ['close_session', 'destroy_group', 'delete_sandbox'],
      APPROVAL_TIMEOUT_MS: 300000,
      requestApproval: async (input) => {
        calls.approvals.push(input);
        return { status: 'approved', approval: { id: 'a-1', status: 'approved' } };
      },
    },
    projectsApi: {
      listProjects: () => ({ ok: true, projects: [{ id: 'p1', cwd: '/srv/x' }] }),
      updateProjectLabel: (id, label) => ({ ok: true, project: { id, label } }),
    },
    workerPresetsApi: {
      listPresets: () => ({ ok: true, presets: [{ id: 'wp1' }] }),
      createPreset: (input) => ({ ok: true, preset: { id: 'wp-new', ...input } }),
      updatePreset: (id, input) => ({ ok: true, preset: { id, ...input } }),
      deletePreset: (id) => (id === 'missing'
        ? { ok: false, code: 'not-found', message: 'preset not found' }
        : { ok: true }),
    },
    launchPresetsApi: {
      presets: new Map(),
      listLaunchPresets: function () {
        return { ok: true, presets: [...this.presets.values()] };
      },
      getLaunchPreset: function (id) {
        const p = this.presets.get(id);
        return p ? { ok: true, preset: p } : { ok: false, code: 'not-found', message: 'preset not found' };
      },
      createLaunchPreset: (input) => ({ ok: true, preset: input }),
      updateLaunchPreset: (id, input) => ({ ok: true, preset: { id, ...input } }),
      deleteLaunchPreset: () => ({ ok: true }),
    },
    sandboxApi: {
      homes: [],
      listSandboxHomes: function () { return this.homes; },
      sandboxHomeSize: async () => 12345,
      deleteSandboxHome: async (slug) => {
        calls.deletedHomes.push(slug);
        return { ok: true };
      },
      dindLockHeld: () => dindLock,
      isSandboxDeleteInFlight: () => deleteInFlight,
      beginSandboxDelete: () => calls.beginDelete.push(slugNow),
      endSandboxDelete: () => calls.endDelete.push(slugNow),
      sandboxRemnantsExist: () => false,
    },
    dirsApi: {
      browseDirectory: async (...a) => {
        calls.browsed.push(a);
        return { ok: true, data: { current: a[0], dirs: [], files: [] } };
      },
      createDirectory: async (input) => {
        calls.createdDirs.push(input);
        return { ok: true, data: { path: `${input.parent}/${input.name}` } };
      },
    },
    sessionsApi: {
      createSessionViaApi: async (body) => {
        calls.createdViaApi.push(body);
        return {
          ok: true,
          body: { sessionId: 'new-session-1', cwd: body.cwd, app: body.app ?? 'claude', model: null, shell: false, sandbox: !!body.sandbox, sandboxOpts: body.sandboxOpts ?? null, isMetaAgent: false },
        };
      },
    },
    groupLaunchApi: {
      launchGroupFromSpec: async (body) => {
        calls.launchedGroups.push(body);
        return {
          ok: true,
          log: '',
          body: { groupId: 'g-new', cwd: body.cwd, members: [], currentTurn: null, lastHandoffAt: null },
        };
      },
    },

    // Test-side controls for the sandbox guards.
    controls: {
      addSession: (s) => sessions.set(s.id, s),
      addGroup: (id, extra = {}) => {
        const g = { groupId: id, cwd: `/srv/${id}`, createdAt: 0, members: [], currentTurn: null, lastHandoffAt: null, ...extra };
        groups.set(id, g);
        return g;
      },
      setDindLock: (v) => { dindLock = v; },
      setDeleteInFlight: (v) => { deleteInFlight = v; },
      setHomeInUse: (n) => { homeInUseCount = n; },
    },
    calls,
  };
  return deps;
}

// Deferred approval: lets a test flip guard state WHILE the dialog is "up"
// (the TOCTOU window between requestApproval and execution).
function deferredApprovalDeps(extra) {
  const deps = makeDeps(extra);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  deps.approvalsApi.requestApproval = async (input) => {
    deps.calls.approvals.push(input);
    await gate;
    return { status: 'approved', approval: { id: 'a-1', status: 'approved' } };
  };
  deps.controls.releaseApproval = release;
  return deps;
}

let slugNow = '';

// --- R -----------------------------------------------------------------------

test('R tools wrap their facades and map store failures', () => {
  const deps = makeDeps();
  assert.deepEqual(tools.listProjects(deps), { ok: true, projects: [{ id: 'p1', cwd: '/srv/x' }] });
  assert.deepEqual(tools.listGroups(deps), { groups: [] });
  assert.deepEqual(tools.listSessions(deps), { sessions: [{ id: MY_SESSION_ID, cwd: '/srv/meta' }] });
  assert.deepEqual(tools.listWorkerPresets(deps), { ok: true, presets: [{ id: 'wp1' }] });

  // Failure convention: { ok:false, code, message } -> { error: code, message }
  assert.deepEqual(tools.deleteWorkerPreset(deps, { presetId: 'missing' }), { error: 'not-found', message: 'preset not found' });
});

test('getGroup projects getGroupSummary and refuses unknown ids', () => {
  const deps = makeDeps();
  deps.controls.addGroup('g1', { members: [{ role: 'orchestrator' }] });
  const out = tools.getGroup(deps, { groupId: 'g1' });
  assert.equal(out.groupId, 'g1');
  assert.deepEqual(out.members, [{ role: 'orchestrator' }]);
  assert.ok(!('allowedCwds' in out) && !('orchestratorDir' in out), 'raw internals must stay unreachable');
  assert.deepEqual(tools.getGroup(deps, { groupId: 'nope' }), { error: 'not-found', message: 'group not found' });
});

test('listSandboxes joins homes with size/inUse/deleting', async () => {
  const deps = makeDeps();
  slugNow = '';
  deps.sandboxApi.homes = [{ name: 'home_x', path: '/homes/home_x', cwd: '/srv/x', projectLabel: 'X', gitRemote: 'git@x:y.git', lastUsedAt: 42 }];
  deps.controls.setHomeInUse(2);
  const out = await tools.listSandboxes(deps);
  assert.deepEqual(out.sandboxes, [{
    name: 'home_x', path: '/homes/home_x', cwd: '/srv/x', projectLabel: 'X',
    gitRemote: 'git@x:y.git', lastUsedAt: 42, size: 12345, inUse: 2,
    deleting: false, deleteError: null,
  }]);
});

test('browseDirectory and createDirectory pass through dirsApi results', async () => {
  const deps = makeDeps();
  const out = await tools.browseDirectory(deps, { path: '/srv', showHidden: true });
  assert.deepEqual(deps.calls.browsed, [['/srv', true]]);
  assert.deepEqual(out.data.current, '/srv');

  const made = await tools.createDirectory(deps, { parent: '/srv', name: 'newdir', gitInit: true });
  assert.deepEqual(deps.calls.createdDirs, [{ parent: '/srv', name: 'newdir', gitInit: true }]);
  assert.equal(made.data.path, '/srv/newdir');
});

// --- W-low -------------------------------------------------------------------

test('worker preset CRUD strips wire-only keys and passes codes through', () => {
  const deps = makeDeps();
  const created = tools.createWorkerPreset(deps, { name: 'N', role: 'workerX', app: 'claude' });
  assert.deepEqual(deps.calls.createdViaApi, []);
  assert.equal(created.preset.name, 'N');
  void created;

  const updated = tools.updateWorkerPreset(deps, { presetId: 'wp1', name: 'M', role: 'workerY', app: 'codex' });
  assert.deepEqual(updated.preset, { id: 'wp1', name: 'M', role: 'workerY', app: 'codex' });
});

// --- W-create: privilege capping ---------------------------------------------

test('launch_session caps sandboxOpts against the meta agent\'s own grant and attributes HOME rows', async () => {
  const deps = makeDeps({ mySandboxOpts: { gpg: true, sshAgent: false } });
  const out = await tools.launchSession(deps, {
    cwd: '/srv/proj', app: 'opencode', model: null, sandbox: true,
    sandboxOpts: { gpg: true, sshAgent: true }, // sshAgent over-request -> downgrade
  });
  assert.deepEqual(deps.calls.createdViaApi, [{
    cwd: '/srv/proj', app: 'opencode', model: null, sandbox: true,
    sandboxOpts: { gpg: true, sshAgent: false },
    requestedBy: `meta-agent:${MY_SESSION_ID}`,
  }]);
  assert.equal(out.sessionId, 'new-session-1');
  assert.deepEqual(out.sandboxOpts, { gpg: true, sshAgent: false }, 'result shows the EFFECTIVE grant');
});

test('launch_session omits sandboxOpts entirely when none requested; failures unwrap', async () => {
  const deps = makeDeps({ mySandboxOpts: { gpg: true, sshAgent: true } });
  await tools.launchSession(deps, { cwd: '/srv/p' });
  assert.equal(deps.calls.createdViaApi[0].sandboxOpts, undefined);
  assert.equal(deps.calls.createdViaApi[0].requestedBy, `meta-agent:${MY_SESSION_ID}`);

  deps.sessionsApi.createSessionViaApi = async () => ({ ok: false, code: 'validation', message: 'cwd must be an existing directory' });
  const err = await tools.launchSession(deps, { cwd: '/nope' });
  assert.deepEqual(err, { error: 'validation', message: 'cwd must be an existing directory' });
});

// Regression, same bypass class as sessionManager.test.js's REST-path test
// and federationServer.test.js's federation-RPC-path test (self-review round
// 3 on the pr-reviewer-mcp branch): launchSession builds createSessionViaApi's
// body from an explicit allowlist (cwd/app/model/sandbox/sandboxOpts/
// requestedBy) and never passes a 2nd argument at all, so a compromised or
// merely obedient-to-a-prompt-injection meta-agent LLM passing
// isReviewJob:true in launch_session's args can neither smuggle it into the
// body nor reach createSessionViaApi's trusted 2nd-parameter path (see
// routes/sessions.js's header comment -- only reviewer.js's runReview may set
// that). Exercises the meta-agent launch_session call site specifically.
test('launch_session ignores a caller-supplied isReviewJob -- it never reaches createSessionViaApi\'s body or 2nd argument', async () => {
  const deps = makeDeps();
  let sawExtraArg = false;
  deps.sessionsApi.createSessionViaApi = async (body, ...rest) => {
    if (rest.length > 0) sawExtraArg = true;
    deps.calls.createdViaApi.push(body);
    return {
      ok: true,
      body: { sessionId: 'new-session-1', cwd: body.cwd, app: 'claude', model: null, shell: false, sandbox: false, sandboxOpts: null, isMetaAgent: false },
    };
  };
  await tools.launchSession(deps, { cwd: '/srv/proj', isReviewJob: true });
  assert.equal(sawExtraArg, false, 'launchSession must never pass a 2nd argument to createSessionViaApi');
  assert.ok(!('isReviewJob' in deps.calls.createdViaApi[0]), 'isReviewJob must never appear in the body either');
});

test('launch_group caps the group flags and each worker spec\'s sandboxOpts', async () => {
  const deps = makeDeps({ mySandboxOpts: { gpg: false, sshAgent: true } });
  const out = await tools.launchGroup(deps, {
    cwd: '/srv/g',
    workers: [
      { role: 'workerA', app: 'claude', sandboxOpts: { gpg: true, sshAgent: true } },
      { role: 'workerB', app: 'codex', sandboxOpts: { gpg: true, sshAgent: false } },
    ],
    instructions: 'do things',
    orchestratorApp: 'opencode',
    orchestratorModel: 'm2',
    sandboxOpts: { gpg: true, sshAgent: true },
  });
  const body = deps.calls.launchedGroups[0];
  assert.deepEqual(body.sandboxOpts, { gpg: false, sshAgent: true });
  assert.deepEqual(body.workers[0].sandboxOpts, { gpg: false, sshAgent: true }); // gpg downgraded
  assert.deepEqual(body.workers[1].sandboxOpts, { gpg: false, sshAgent: false });
  assert.deepEqual(
    body.orchestrator,
    { app: 'opencode', model: 'm2', instructions: 'do things' },
    'orchestratorApp/orchestratorModel/instructions all ride the orchestrator spec -- these must reach launch_group\'s own wire schema too, not just launch_from_preset\'s',
  );
  assert.equal(body.instructions, undefined, 'top-level instructions must never be sent (route ignores it)');
  assert.equal(out.groupId, 'g-new');

  deps.groupLaunchApi.launchGroupFromSpec = async () => ({ ok: false, code: 'conflict', message: 'a group already exists' });
  const err = await tools.launchGroup(deps, { cwd: '/srv/g', workers: [{ role: 'workerA', app: 'claude' }] });
  assert.deepEqual(err, { error: 'conflict', message: 'a group already exists' });
});

test('launch_from_preset expands a snapshot NOW and caps expanded grants', async () => {
  const deps = makeDeps({ mySandboxOpts: { gpg: true, sshAgent: false } });
  deps.launchPresetsApi.presets.set('lp1', {
    id: 'lp1',
    name: 'combo',
    orchestratorApp: 'opencode',
    orchestratorModel: 'm1',
    instructions: 'be nice',
    workers: [
      { position: 0, role: 'workerA', app: 'claude', model: 'fast', name: 'Al', sandboxOpts: { gpg: true, sshAgent: true } },
      { position: 1, role: 'workerB', app: 'codex', model: null, name: null, sandboxOpts: null },
    ],
  });

  const out = await tools.launchFromPreset(deps, { presetId: 'lp1', cwd: '/srv/combo' });
  assert.equal(out.groupId, 'g-new');
  const body = deps.calls.launchedGroups[0];
  assert.equal(body.cwd, '/srv/combo');
  assert.deepEqual(body.orchestrator, { app: 'opencode', model: 'm1', instructions: 'be nice' });
  assert.equal(body.workers.length, 2);
  assert.deepEqual(body.workers[0], { role: 'workerA', app: 'claude', model: 'fast', name: 'Al', sandboxOpts: { gpg: true, sshAgent: false } });
  assert.deepEqual(body.workers[1], { role: 'workerB', app: 'codex' });

  const missing = await tools.launchFromPreset(deps, { presetId: 'ghost', cwd: '/srv/combo' });
  assert.deepEqual(missing, { error: 'not-found', message: 'preset not found' });
});

// --- close_session -----------------------------------------------------------

test('close_session: validation, existence, then self-target fail closed BEFORE any dialog', async () => {
  const deps = makeDeps({ mySandboxOpts: null });
  assert.deepEqual(
    await tools.closeSession(deps, { sessionId: '', reason: 'r' }),
    { error: 'bad-request', message: 'sessionId must be a non-empty string' },
  );
  assert.deepEqual(
    await tools.closeSession(deps, { sessionId: 'ghost', reason: 'r' }),
    { error: 'not-found', message: 'session not found' },
  );
  // Own session: refused outright -- no approval row, no destroy.
  const self = await tools.closeSession(deps, { sessionId: MY_SESSION_ID, reason: 'please kill me' });
  assert.deepEqual(self, { error: 'self-target', message: 'refusing to close your own session (the calling meta agent)' });
  assert.equal(deps.calls.approvals.length, 0);
  assert.equal(deps.calls.destroyedSessions.length, 0);

  // A group member of the caller's own group is equally off-limits (defensive
  // against identity confusion; the meta agent normally has no group).
  const groupedDeps = makeDeps({
    identity: { sessionId: MY_SESSION_ID, groupId: 'my-group' },
  });
  groupedDeps.controls.addGroup('my-group');
  groupedDeps.controls.addSession({ id: 'peer', cwd: '/srv/p', app: 'claude', shell: false, sandboxOpts: null });
  groupedDeps.groupManager.isSessionInGroup = (gid, sid) => gid === 'my-group' && sid === 'peer';
  const peerSelf = await tools.closeSession(groupedDeps, { sessionId: 'peer', reason: 'r' });
  assert.equal(peerSelf.error, 'self-target');
  assert.equal(groupedDeps.calls.approvals.length, 0);
});

test('close_session: approval outcomes control execution', async () => {
  const deps = makeDeps();
  deps.controls.addSession({ id: 'victim', cwd: '/srv/v', app: 'claude', shell: false, sandboxOpts: null });

  deps.approvalsApi.requestApproval = async (input) => {
    deps.calls.approvals.push(input);
    return { status: 'rejected', approval: { id: 'a', status: 'rejected' } };
  };
  assert.deepEqual(await tools.closeSession(deps, { sessionId: 'victim', reason: 'stuck' }), { approved: false, reason: 'user-rejected' });
  assert.equal(deps.calls.destroyedSessions.length, 0);

  deps.approvalsApi.requestApproval = async (input) => {
    deps.calls.approvals.push(input);
    return { status: 'expired', approval: { id: 'a', status: 'expired' } };
  };
  assert.deepEqual(await tools.closeSession(deps, { sessionId: 'victim', reason: 'stuck' }), { approved: false, expired: true, reason: 'timeout' });
  assert.equal(deps.calls.destroyedSessions.length, 0);

  deps.approvalsApi.requestApproval = async () => { throw new Error('db down'); };
  assert.equal((await tools.closeSession(deps, { sessionId: 'victim', reason: 'stuck' })).error, 'approval-failed');
  assert.equal(deps.calls.destroyedSessions.length, 0);

  deps.approvalsApi.requestApproval = async (input) => {
    deps.calls.approvals.push(input);
    return { status: 'approved', approval: { id: 'a', status: 'approved' } };
  };
  const ok = await tools.closeSession(deps, { sessionId: 'victim', reason: 'stuck' });
  assert.deepEqual(ok, { approved: true, closed: true, sessionId: 'victim' });
  assert.deepEqual(deps.calls.destroyedSessions, [['victim', { keepSchedule: false }]]);
  const req = deps.calls.approvals.at(-1);
  assert.equal(req.kind, 'close_session');
  assert.deepEqual(req.payload, { sessionId: 'victim' });
  assert.equal(req.requestedBy, MY_SESSION_ID);
  assert.match(req.summary, /^close_session: victim \(claude, \/srv\/v\) を強制終了 — 理由: stuck$/);
});

// --- destroy_group -----------------------------------------------------------

test('destroy_group: mirrors close_session\'s flow against identity.groupId', async () => {
  const deps = makeDeps({ identity: { sessionId: MY_SESSION_ID, groupId: 'mine' } });
  deps.controls.addGroup('mine');
  deps.controls.addGroup('other', { cwd: '/srv/other', members: [{}] });

  const self = await tools.destroyGroup(deps, { groupId: 'mine', reason: 'r' });
  assert.equal(self.error, 'self-target');
  assert.equal(deps.calls.approvals.length, 0);

  assert.deepEqual(
    await tools.destroyGroup(deps, { groupId: 'ghost', reason: 'r' }),
    { error: 'not-found', message: 'group not found' },
  );

  const ok = await tools.destroyGroup(deps, { groupId: 'other', reason: 'cleanup' });
  assert.deepEqual(ok, { approved: true, destroyed: true, groupId: 'other' });
  assert.deepEqual(deps.calls.destroyedGroups, ['other']);
  const req = deps.calls.approvals.at(-1);
  assert.equal(req.kind, 'destroy_group');
  assert.deepEqual(req.payload, { groupId: 'other' });
  assert.match(req.summary, /を破棄 — 理由: cleanup/);
});

// --- delete_sandbox ----------------------------------------------------------

test('delete_sandbox: pre-approval guards fail fast without any dialog', async () => {
  const deps = makeDeps();
  assert.deepEqual(
    await tools.deleteSandbox(deps, { slug: 'bad/slug', reason: 'r' }).then((r) => r),
    { error: 'bad-request', message: 'slug must be a bare sandbox name' },
  );
  assert.deepEqual(
    await tools.deleteSandbox(deps, { slug: 'ghost', reason: 'r' }),
    { error: 'not-found', message: 'sandbox not found' },
  );

  slugNow = 'home_x';
  deps.sandboxApi.homes = [{ name: 'home_x', path: '/homes/home_x', cwd: '/srv/x' }];
  deps.controls.setHomeInUse(1);
  assert.equal((await tools.deleteSandbox(deps, { slug: 'home_x', reason: 'r' })).error, 'in-use');
  deps.controls.setHomeInUse(0);
  deps.controls.setDindLock(true);
  assert.equal((await tools.deleteSandbox(deps, { slug: 'home_x', reason: 'r' })).error, 'docker-daemon-in-use');
  deps.controls.setDindLock(false);
  deps.controls.setDeleteInFlight(true);
  assert.equal((await tools.deleteSandbox(deps, { slug: 'home_x', reason: 'r' })).error, 'delete-in-progress');
  assert.equal(deps.calls.approvals.length, 0, 'guards fire before any approval row exists');
});

test('delete_sandbox: approved deletion runs begin/delete/end and reports failure', async () => {
  const deps = makeDeps();
  slugNow = 'home_x';
  deps.sandboxApi.homes = [{ name: 'home_x', path: '/homes/home_x', cwd: '/srv/x' }];

  const ok = await tools.deleteSandbox(deps, { slug: 'home_x', reason: 'unused' });
  assert.deepEqual(ok, { approved: true, deleted: true, slug: 'home_x' });
  assert.deepEqual(deps.calls.beginDelete, ['home_x']);
  assert.deepEqual(deps.calls.deletedHomes, ['home_x']);
  assert.deepEqual(deps.calls.endDelete, ['home_x'], 'end runs even around success');
  assert.match(deps.calls.approvals.at(-1).summary, /^delete_sandbox: home_x \(\/srv\/x\) を削除 — 理由: unused$/);

  // Failure still ends the in-flight marker and maps to a uniform error.
  deps.sandboxApi.deleteSandboxHome = async () => ({ ok: false, error: 'docker-daemon-in-use' });
  deps.calls.beginDelete.length = 0;
  deps.calls.endDelete.length = 0;
  const failed = await tools.deleteSandbox(deps, { slug: 'home_x', reason: 'retry' });
  assert.equal(failed.deleted, false);
  assert.equal(failed.error, 'delete-failed');
  assert.deepEqual(deps.calls.endDelete, ['home_x']);
});

test('delete_sandbox: TOCTOU re-check after approval refuses without deleting', async () => {
  const deps = deferredApprovalDeps();
  slugNow = 'home_x';
  deps.sandboxApi.homes = [{ name: 'home_x', path: '/homes/home_x', cwd: '/srv/x' }];
  const pending = tools.deleteSandbox(deps, { slug: 'home_x', reason: 'late-mount' });
  deps.controls.releaseApproval(); // approve...
  deps.controls.setHomeInUse(3); // ...but the HOME got mounted while waiting
  const out = await pending;
  assert.equal(out.approved, true);
  assert.equal(out.deleted, false);
  assert.equal(out.error, 'in-use');
  assert.deepEqual(deps.calls.deletedHomes, [], 'nothing removed while in use');
});
