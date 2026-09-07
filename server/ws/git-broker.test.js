// End-to-end test of the broker's Unix-socket protocol: real startGitBroker()
// process, real git repo, a fake `gh` on PATH (so no network/real credentials
// are involved) standing in for the host's actual gh CLI.
//
// This is also the regression test for the allowHalfOpen bug found in
// review: gh-exec responses are written asynchronously (after awaiting the
// fake `gh` child process), and without `{ allowHalfOpen: true }` on the
// broker's net.createServer, Node silently discarded the response as soon
// as the client half-closed its write side -- every gh-exec request would
// hang/return nothing. The credential-request tests alone would NOT have
// caught this (they respond synchronously, in the same tick).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGitBroker } from './git-broker.js';

let root;
let repoDir;
let broker;
let originalPath;

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
}

function request(sockPath, req) {
  return new Promise((resolve) => {
    const sock = net.createConnection(sockPath);
    const chunks = [];
    sock.on('connect', () => sock.end(`${JSON.stringify(req)}\n`));
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        resolve({ ok: false, reason: `test-harness-parse-error:${e.message}:${JSON.stringify(raw)}` });
      }
    });
    sock.on('error', (e) => resolve({ ok: false, reason: `test-harness-sock-error:${e.message}` }));
  });
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'ccserver-git-broker-test-'));
  repoDir = join(root, 'repo');
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q']);
  git(repoDir, ['remote', 'add', 'origin', 'https://github.com/testowner/testrepo.git']);

  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeGh = join(binDir, 'gh');
  writeFileSync(fakeGh, [
    '#!/usr/bin/env bash',
    'if [ "$1" = "auth" ] && [ "$2" = "token" ]; then echo "fake-token-123"; exit 0; fi',
    'echo "GH_ARGS:$*"',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(fakeGh, 0o755);

  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath}`;

  broker = startGitBroker({ cwd: repoDir });
});

after(async () => {
  process.env.PATH = originalPath;
  if (broker) {
    broker.proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    rmSync(broker.dir, { recursive: true, force: true });
  }
  rmSync(root, { recursive: true, force: true });
});

test('startGitBroker computes the allow-list from the repo cwd', () => {
  assert.deepEqual(broker.allowlist, ['github.com/testowner/testrepo']);
});

test('credential: allow-listed repo gets a token', async () => {
  const r = await request(broker.sockPath, { op: 'credential', protocol: 'https', host: 'github.com', path: 'testowner/testrepo.git' });
  assert.equal(r.ok, true);
  assert.equal(r.username, 'x-access-token');
  assert.equal(r.password, 'fake-token-123');
});

test('credential: non-allow-listed repo is denied, no token leaked', async () => {
  const r = await request(broker.sockPath, { op: 'credential', protocol: 'https', host: 'github.com', path: 'someoneelse/unrelated.git' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-allowlisted');
  assert.equal(r.password, undefined);
});

test('credential: malformed request fails closed', async () => {
  const r = await request(broker.sockPath, { op: 'nonsense' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-request');
});

// gh-exec: also the allowHalfOpen regression coverage (see file header) --
// this response only arrives after awaiting a real child process exit, so a
// hang or an empty response here would mean that bug is back.
test('gh-exec: allowed subcommand executes the fake gh and relays stdout/exit code', async () => {
  const r = await request(broker.sockPath, { op: 'gh-exec', argv: ['pr', 'view', '1'] });
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(Buffer.from(r.stdout, 'base64').toString(), 'GH_ARGS:pr view 1\n');
});

test('gh-exec: gh api is refused before ever touching the real gh binary', async () => {
  const r = await request(broker.sockPath, { op: 'gh-exec', argv: ['api', '/user'] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'subcommand-not-allowed');
});

test('gh-exec: an allowed literal Actions GET executes through the fake gh', async () => {
  const r = await request(broker.sockPath, { op: 'gh-exec', argv: ['api', 'repos/testowner/testrepo/actions/runs'] });
  assert.equal(r.ok, true);
  assert.equal(Buffer.from(r.stdout, 'base64').toString(), 'GH_ARGS:api repos/testowner/testrepo/actions/runs\n');
});

test('gh-exec: a placeholder gh api Actions endpoint is refused at the broker (would target a repo the allow-list never saw)', async () => {
  const r = await request(broker.sockPath, { op: 'gh-exec', argv: ['api', 'repos/{owner}/{repo}/actions/runs'] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'repo-unresolved');
});

test('gh-exec: a dot-segment-smuggled gh api endpoint is refused (encoded-slash .. traversal)', async () => {
  const r = await request(broker.sockPath, { op: 'gh-exec', argv: ['api', 'repos/testowner/testrepo/actions/runs/..%2f..%2fissues'] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'subcommand-not-allowed');
});

test('gh-exec: a --hostname gh api invocation is refused', async () => {
  const r = await request(broker.sockPath, { op: 'gh-exec', argv: ['api', 'repos/testowner/testrepo/actions/runs', '--hostname', 'ghe.example.com'] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous-flags');
});

test('gh-exec: explicit --repo pointing outside the allow-list is denied', async () => {
  const r = await request(broker.sockPath, { op: 'gh-exec', argv: ['pr', 'view', '1', '--repo', 'someoneelse/unrelated'] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-allowlisted');
});

test('gh-exec: bundled short flag hiding -R is refused (see git-broker.test.js file header / ghAllowlist.test.js)', async () => {
  const r = await request(broker.sockPath, { op: 'gh-exec', argv: ['pr', 'view', '-wR', 'someoneelse/unrelated', '5'] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous-flags');
});

test('gh-exec: a PR URL to an unrelated repo is denied even though cwd itself is allow-listed', async () => {
  const r = await request(broker.sockPath, { op: 'gh-exec', argv: ['pr', 'merge', 'https://github.com/someoneelse/unrelated/pull/999', '--squash'] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-allowlisted');
});

test('gh-exec: malformed argv fails closed', async () => {
  const r = await request(broker.sockPath, { op: 'gh-exec', argv: 'not-an-array' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-request');
});

test('startGitBroker returns null for non-git cwd (no dead wrapper)', () => {
  const dir = join(root, 'not-a-repo2');
  mkdirSync(dir, { recursive: true });
  const b = startGitBroker({ cwd: dir });
  assert.equal(b, null);
});

test('linked worktree broker allowlist matches main checkout', async () => {
  const main = join(root, 'main-for-broker');
  mkdirSync(main, { recursive: true });
  git(main, ['init', '-q']);
  git(main, ['config', 'user.email', 'test@example.com']);
  git(main, ['config', 'user.name', 'test']);
  git(main, ['remote', 'add', 'origin', 'https://github.com/nananek/ccserver.git']);
  writeFileSync(join(main, 'README.md'), '# hi\n');
  git(main, ['add', 'README.md']);
  git(main, ['commit', '-qm', 'init']);
  const worker = join(root, 'worker-for-broker');
  execFileSync('git', ['worktree', 'add', '--detach', worker], { cwd: main });
  const wb = startGitBroker({ cwd: worker });
  try {
    assert.ok(wb, 'broker should start for linked worktree');
    assert.deepEqual(wb.allowlist, ['github.com/nananek/ccserver']);
    // implicit origin request should succeed
    const r1 = await request(wb.sockPath, { op: 'gh-exec', argv: ['pr', 'view', '1'] });
    assert.equal(r1.ok, true);
    // explicit allowed repo succeeds
    const r2 = await request(wb.sockPath, { op: 'gh-exec', argv: ['pr', 'view', '1', '--repo', 'nananek/ccserver'] });
    assert.equal(r2.ok, true);
    // unrelated repo denied
    const r3 = await request(wb.sockPath, { op: 'gh-exec', argv: ['pr', 'view', '1', '--repo', 'someoneelse/unrelated'] });
    assert.equal(r3.ok, false);
    assert.equal(r3.reason, 'not-allowlisted');
  } finally {
    if (wb) { wb.proc.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 200)); rmSync(wb.dir, { recursive: true, force: true }); }
    rmSync(main, { recursive: true, force: true });
    rmSync(worker, { recursive: true, force: true });
  }
});

test('broker readiness probe: socket responds to probe op', async () => {
  const r = await request(broker.sockPath, { op: 'probe' });
  // any JSON response means broker is speaking; probe op is not a real op so bad-request is expected
  assert.equal(typeof r.ok, 'boolean');
  assert.ok('reason' in r || 'ok' in r);
});

// plan8: PR-body guard. `broker` above was started without blockedPatterns
// (the pre-plan8 call shape), so it never checks PR text -- these tests use
// their own instance with the guard enabled to cover both "guard on" and,
// via `broker` itself in the tests above (e.g. plain 'pr view'), "guard off"
// behaves identically to before.
describe('gh-exec PR-body guard (plan8)', () => {
  let guardedBroker;

  before(() => {
    guardedBroker = startGitBroker({ cwd: repoDir, blockedPatterns: [] });
  });

  after(async () => {
    if (guardedBroker) {
      guardedBroker.proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 200));
      rmSync(guardedBroker.dir, { recursive: true, force: true });
    }
  });

  test('pr create --body containing a Claude-Session: trailer is denied, fake gh never runs', async () => {
    const r = await request(guardedBroker.sockPath, {
      op: 'gh-exec',
      argv: ['pr', 'create', '--title', 'x', '--body', 'See also.\nClaude-Session: https://claude.ai/code/session_abc123\n'],
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'blocked-message');
    assert.equal(r.field, 'body');
  });

  test('pr create --title containing a session URL is denied', async () => {
    // The URL is embedded mid-string (not the whole token) so this doesn't
    // also trip classifyGhInvocation's own "a bare URL token is a repo
    // reference" scan (a pre-existing, unrelated quirk -- see plan8 section
    // 2.4 -- that a title/body value which IS itself exactly one bare URL
    // token can hit).
    const r = await request(guardedBroker.sockPath, {
      op: 'gh-exec',
      argv: ['pr', 'create', '--title', 'Leaked: https://claude.ai/code/session_abc123', '--body', 'fine'],
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'blocked-message');
    assert.equal(r.field, 'title');
  });

  test('a clean pr create is allowed and reaches the fake gh', async () => {
    const r = await request(guardedBroker.sockPath, {
      op: 'gh-exec',
      argv: ['pr', 'create', '--title', 'Fix bug', '--body', 'Nothing sensitive here.'],
    });
    assert.equal(r.ok, true);
    assert.equal(r.exitCode, 0);
  });

  test('pr comment --body-file - reads the blocked pattern from stdin', async () => {
    const stdin = Buffer.from('Claude-Session: https://claude.ai/code/session_xyz\n').toString('base64');
    const r = await request(guardedBroker.sockPath, { op: 'gh-exec', argv: ['pr', 'comment', '1', '--body-file', '-'], stdin });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'blocked-message');
    assert.equal(r.field, 'body-file');
  });

  test('pr edit --body-file <path> reads the blocked pattern from the repo cwd', async () => {
    writeFileSync(join(repoDir, 'pr-body.txt'), 'Claude-Session: https://claude.ai/code/session_frompath\n');
    const r = await request(guardedBroker.sockPath, { op: 'gh-exec', argv: ['pr', 'edit', '1', '--body-file', 'pr-body.txt'] });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'blocked-message');
    assert.equal(r.field, 'body-file');
  });

  test('an unreadable --body-file fails open (skips that field, does not deny the command)', async () => {
    const r = await request(guardedBroker.sockPath, { op: 'gh-exec', argv: ['pr', 'edit', '1', '--body-file', 'does-not-exist.txt'] });
    assert.equal(r.ok, true);
  });

  test('startGitBroker without blockedPatterns (pre-plan8 call shape) never checks PR text', async () => {
    // `broker` (module-level, started as `startGitBroker({ cwd: repoDir })`
    // in this file's before()) has no guard config at all.
    const r = await request(broker.sockPath, {
      op: 'gh-exec',
      argv: ['pr', 'create', '--title', 'x', '--body', 'Claude-Session: https://claude.ai/code/session_should-not-matter'],
    });
    assert.equal(r.ok, true);
  });
});
