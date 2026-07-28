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

import { test, before, after } from 'node:test';
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
