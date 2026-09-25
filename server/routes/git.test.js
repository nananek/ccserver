// Route-level tests for GET /api/git/info and POST /api/git/clone (#278):
// status mapping, browseRoots, and that a bad request never reaches gh.
// gh is a shell script injected through the plugin's `clone` option.

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitRoute } from './git.js';
import { git, initRepo } from '../testGitFixtures.js';

// Same pattern as dirs.test.js: point loadSandboxConfig() at a temp config.
function withConfig(json, fn) {
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-git-cfg-'));
  const path = join(cfgDir, 'sandbox.config.json');
  return (async () => {
    try {
      writeFileSync(path, typeof json === 'string' ? json : JSON.stringify(json));
      const prev = process.env.CCSERVER_SANDBOX_CONFIG;
      process.env.CCSERVER_SANDBOX_CONFIG = path;
      try {
        return await fn();
      } finally {
        if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
        else process.env.CCSERVER_SANDBOX_CONFIG = prev;
      }
    } finally {
      rmSync(cfgDir, { recursive: true, force: true });
    }
  })();
}

let base;
let app;
let ghDir;
let counter = 0;
const uniq = (name) => join(base, `${name}-${counter++}`);

function fakeGh(script) {
  const path = join(ghDir, `gh-${counter++}`);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

const OK_GH = (rec) => `#!/bin/sh
touch '${rec}'
mkdir -p "$4"
git init -q -b main "$4"
git -C "$4" remote add origin "$3"
git -C "$4" config remote.origin.gh-resolved base
`;

async function buildApp(cloneDeps) {
  const fastify = Fastify();
  await fastify.register(gitRoute, { prefix: '/api', clone: cloneDeps });
  return fastify;
}

before(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ccserver-gitroute-')));
  ghDir = join(base, 'bin');
  mkdirSync(ghDir);
  app = await buildApp({ ghBin: fakeGh(OK_GH(join(base, 'gh-called'))), slots: { active: 0 } });
});
after(async () => {
  try { await app.close(); } catch { /* already closed */ }
  rmSync(base, { recursive: true, force: true });
});

// --- GET /git/info -------------------------------------------------------------

test('GET /git/info describes a repository', async () => {
  const dir = initRepo(uniq('repo'));
  git(dir, ['remote', 'add', 'origin', 'https://tok:en@github.com/o/r.git']);
  const res = await app.inject({ method: 'GET', url: `/api/git/info?path=${encodeURIComponent(dir)}` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.isRepo, true);
  assert.deepEqual(body.head, { kind: 'branch', name: 'main' });
  assert.deepEqual(body.remotes, [{ name: 'origin', url: 'https://github.com/o/r.git', pushUrl: null, isDefault: true }]);
  assert.ok(!res.body.includes('tok:en'), 'userinfo never leaves the server');
});

test('GET /git/info on a plain directory: 200 with isRepo:false', async () => {
  const dir = uniq('plain');
  mkdirSync(dir);
  const res = await app.inject({ method: 'GET', url: `/api/git/info?path=${encodeURIComponent(dir)}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().isRepo, false);
});

test('GET /git/info: 400 without a path, 404 for a missing directory', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/git/info' })).statusCode, 400);
  const missing = join(base, 'nope');
  assert.equal((await app.inject({ method: 'GET', url: `/api/git/info?path=${encodeURIComponent(missing)}` })).statusCode, 404);
});

test('GET /git/info honours browseRoots: outside is 403, inside is described', async () => {
  const inside = initRepo(join(uniq('roots'), 'in'));
  const outside = initRepo(uniq('out'));
  await withConfig({ browseRoots: [join(inside, '..')] }, async () => {
    const ok = await app.inject({ method: 'GET', url: `/api/git/info?path=${encodeURIComponent(inside)}` });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().isRepo, true);
    const denied = await app.inject({ method: 'GET', url: `/api/git/info?path=${encodeURIComponent(outside)}` });
    assert.equal(denied.statusCode, 403);
  });
});

test('a present-but-invalid browseRoots fails both endpoints closed (503)', async () => {
  const dir = uniq('inv');
  mkdirSync(dir);
  await withConfig({ browseRoots: 'not-an-array' }, async () => {
    const info = await app.inject({ method: 'GET', url: `/api/git/info?path=${encodeURIComponent(dir)}` });
    assert.equal(info.statusCode, 503);
    const cl = await app.inject({ method: 'POST', url: '/api/git/clone', payload: { parent: dir, url: 'o/r' } });
    assert.equal(cl.statusCode, 503);
  });
  assert.ok(!existsSync(join(dir, 'r')));
});

// --- POST /git/clone --------------------------------------------------------------

test('POST /git/clone clones into a new directory and returns its path', async () => {
  const parent = uniq('parent');
  mkdirSync(parent);
  const res = await app.inject({ method: 'POST', url: '/api/git/clone', payload: { parent, url: 'https://github.com/o/r' } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.path, join(parent, 'r'));
  assert.equal(body.url, 'https://github.com/o/r.git');
  assert.deepEqual(body.warnings, []);
  assert.ok(existsSync(join(parent, 'r', '.git')));
});

test('POST /git/clone maps failures to statuses and never runs gh for bad input', async () => {
  const rec = join(base, `called-${counter++}`);
  const local = await buildApp({ ghBin: fakeGh(OK_GH(rec)), slots: { active: 0 } });
  try {
    const parent = uniq('parent');
    mkdirSync(parent);
    mkdirSync(join(parent, 'taken'));
    writeFileSync(join(parent, 'taken', 'x'), '1');
    const post = (payload) => local.inject({ method: 'POST', url: '/api/git/clone', payload });

    for (const payload of [
      { parent, url: '--upload-pack=x' },
      { parent, url: 'ext::sh -c id' },
      { parent, url: 'https://user:pw@github.com/o/r' },
      { parent, url: 'o/r', name: '../up' },
      { url: 'o/r' },
      { parent },
    ]) {
      const res = await post(payload);
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(typeof res.json().error, 'string');
    }
    assert.equal((await post({ parent, url: 'o/r', name: 'taken' })).statusCode, 409);
    assert.equal((await post({ parent: uniq('outside-nonexistent'), url: 'o/r' })).statusCode, 404);
    for (const body of ['"a string"', '[1]', 'null']) {
      const res = await local.inject({ method: 'POST', url: '/api/git/clone', headers: { 'content-type': 'application/json' }, payload: body });
      assert.equal(res.statusCode, 400, body);
    }
    assert.ok(!existsSync(rec), 'gh was started for a request that should have been refused');
    assert.deepEqual(readdirSync(parent), ['taken']);
  } finally {
    await local.close();
  }
});

test('POST /git/clone: parent outside browseRoots is 403 and nothing is written', async () => {
  const inside = uniq('roots');
  mkdirSync(inside);
  const outside = uniq('out');
  mkdirSync(outside);
  await withConfig({ browseRoots: [inside] }, async () => {
    const res = await app.inject({ method: 'POST', url: '/api/git/clone', payload: { parent: outside, url: 'o/r' } });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(readdirSync(outside), []);
    const ok = await app.inject({ method: 'POST', url: '/api/git/clone', payload: { parent: inside, url: 'o/r' } });
    assert.equal(ok.statusCode, 200, ok.body);
  });
});

test('POST /git/clone: gh failing is 502, gh missing is 500, a timeout is 504, too many at once is 429', async () => {
  const parent = uniq('parent');
  mkdirSync(parent);
  const post = (a, payload) => a.inject({ method: 'POST', url: '/api/git/clone', payload });

  const failing = await buildApp({ ghBin: fakeGh('#!/bin/sh\necho "fatal: nope" >&2\nexit 1\n'), slots: { active: 0 } });
  const failed = await post(failing, { parent, url: 'o/r' });
  assert.equal(failed.statusCode, 502);
  assert.match(failed.json().error, /fatal: nope/);
  await failing.close();

  const missing = await buildApp({ ghBin: join(base, 'no-such-gh'), slots: { active: 0 } });
  assert.equal((await post(missing, { parent, url: 'o/r' })).statusCode, 500);
  await missing.close();

  const slow = await buildApp({ ghBin: fakeGh('#!/bin/sh\nsleep 30\n'), slots: { active: 0 }, timeoutMs: 300 });
  assert.equal((await post(slow, { parent, url: 'o/r' })).statusCode, 504);
  await slow.close();

  const busy = await buildApp({ ghBin: fakeGh('#!/bin/sh\nsleep 1\nmkdir -p "$4"\ngit init -q "$4"\n'), slots: { active: 0 }, maxConcurrent: 1 });
  const first = post(busy, { parent, url: 'o/first' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await post(busy, { parent, url: 'o/second' })).statusCode, 429);
  assert.equal((await first).statusCode, 200);
  await busy.close();

  assert.deepEqual(readdirSync(parent).filter((n) => n.startsWith('.ccserver-clone-')), []);
});

// --- which hosts Clone may use (sandbox.config.json "clone") ---------------------------

const GITEA_CONFIG = {
  clone: { hosts: [{ host: 'github.com', tool: 'gh' }, { host: 'gitea.example.org', tool: 'git' }] },
};
const postClone = (a, payload) => a.inject({ method: 'POST', url: '/api/git/clone', payload });

test('by default only github.com is allowed: a Gitea URL is 400 and starts nothing', async () => {
  const ghRec = join(base, `called-${counter++}`);
  const gitRec = join(base, `called-${counter++}`);
  const local = await buildApp({ ghBin: fakeGh(OK_GH(ghRec)), gitBin: fakeGh(OK_GH(gitRec)), slots: { active: 0 } });
  try {
    const parent = uniq('parent');
    mkdirSync(parent);
    const res = await postClone(local, { parent, url: 'https://gitea.example.org/o/r' });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.json().error, /not allowed/);
    assert.ok(!existsSync(ghRec) && !existsSync(gitRec), 'neither tool was started');
    assert.deepEqual(readdirSync(parent), []);
  } finally {
    await local.close();
  }
});

test('a configured Gitea host is cloned with git, github.com still with gh, each without the other', async () => {
  await withConfig(GITEA_CONFIG, async () => {
    const ghRec = join(base, `called-${counter++}`);
    const gitRec = join(base, `called-${counter++}`);
    const local = await buildApp({ ghBin: fakeGh(OK_GH(ghRec)), gitBin: fakeGh(OK_GH(gitRec)), slots: { active: 0 } });
    try {
      const parent = uniq('parent');
      mkdirSync(parent);
      const viaGit = await postClone(local, { parent, url: 'https://gitea.example.org/o/r' });
      assert.equal(viaGit.statusCode, 200, viaGit.body);
      assert.equal(viaGit.json().url, 'https://gitea.example.org/o/r.git');
      assert.ok(existsSync(gitRec) && !existsSync(ghRec), 'a git host starts git, not gh');
      assert.ok(existsSync(join(parent, 'r', '.git')));

      const viaGh = await postClone(local, { parent, url: 'https://github.com/o/r2' });
      assert.equal(viaGh.statusCode, 200, viaGh.body);
      assert.ok(existsSync(ghRec), 'github.com starts gh');
      // a host that is not on the list is still refused, and the shorthand is still github.com
      assert.equal((await postClone(local, { parent, url: 'https://evil.example/o/r' })).statusCode, 400);
      assert.equal((await postClone(local, { parent, url: 'https://gitea.example.org.evil.example/o/r' })).statusCode, 400);
      assert.equal((await postClone(local, { parent, url: 'https://gitea.example.org:3000/o/r' })).statusCode, 400);
      assert.equal((await postClone(local, { parent, url: 'o/r3' })).statusCode, 200);
    } finally {
      await local.close();
    }
  });
});

test('the host list is read once, when the routes are registered: editing the file needs a restart', async () => {
  const parent = uniq('parent');
  mkdirSync(parent);
  const started = () => fakeGh(OK_GH(join(base, `called-${counter++}`)));

  // registered WITH gitea; the file then loses it
  let local = await withConfig(GITEA_CONFIG, () => buildApp({ ghBin: started(), gitBin: started(), slots: { active: 0 } }));
  try {
    await withConfig({}, async () => {
      assert.equal((await postClone(local, { parent, url: 'https://gitea.example.org/o/r' })).statusCode, 200);
    });
  } finally {
    await local.close();
  }

  // registered WITHOUT it; the file then gains it
  local = await withConfig({}, () => buildApp({ ghBin: started(), gitBin: started(), slots: { active: 0 } }));
  try {
    await withConfig(GITEA_CONFIG, async () => {
      assert.equal((await postClone(local, { parent, url: 'https://gitea.example.org/o/r2' })).statusCode, 400);
    });
  } finally {
    await local.close();
  }
});

test('a clone block that cannot be used disables Clone (503 with the reason); it is not repaired into the default', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    await withConfig({ clone: { hosts: [{ host: 'gitea.example.org:3000', tool: 'git' }] } }, async () => {
      const ghRec = join(base, `called-${counter++}`);
      const local = await buildApp({ ghBin: fakeGh(OK_GH(ghRec)), slots: { active: 0 } });
      try {
        assert.ok(warn.mock.calls.some((c) => /"clone" "hosts"\[0\]\.host/.test(String(c.arguments[0])) && /disabled/.test(String(c.arguments[0]))),
          'the operator is told at startup');
        const parent = uniq('parent');
        mkdirSync(parent);
        // github.com is the DEFAULT, and the default must not come back for a broken block
        const res = await postClone(local, { parent, url: 'https://github.com/o/r' });
        assert.equal(res.statusCode, 503, res.body);
        assert.match(res.json().error, /"clone" "hosts"\[0\]\.host/);
        assert.ok(!existsSync(ghRec) && readdirSync(parent).length === 0);
        // nothing else is affected
        const info = await local.inject({ method: 'GET', url: `/api/git/info?path=${encodeURIComponent(parent)}` });
        assert.equal(info.statusCode, 200);
      } finally {
        await local.close();
      }
    });
  } finally {
    warn.mock.restore();
  }
});
