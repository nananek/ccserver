// Regression test for a real hang reported in production use: gh commands
// relayed through sandbox-gh-wrapper.cjs could block indefinitely if stdin
// wasn't a literal TTY but also never sent EOF on its own (e.g. an fd
// shared with a longer-lived shell/pty) -- the overwhelming majority of gh
// invocations don't read stdin at all (flags carry the input), so
// readStdin() must give up quickly rather than wait forever for an EOF that
// may never come. See sandbox-gh-wrapper.cjs's readStdin() comment.
//
// This spawns the wrapper as a real child process (as sandbox.js would run
// it inside the sandbox) against a real broker + fake `gh` on PATH, with
// different stdin shapes, and asserts it always completes promptly.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGitBroker } from './git-broker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(__dirname, 'sandbox-gh-wrapper.cjs');

let root;
let repoDir;
let broker;

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'ccserver-gh-wrapper-test-'));
  repoDir = join(root, 'repo');
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q']);
  git(repoDir, ['remote', 'add', 'origin', 'https://github.com/testowner/testrepo.git']);

  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeGh = join(binDir, 'gh');
  writeFileSync(fakeGh, [
    '#!/usr/bin/env bash',
    'if [ "$1" = "auth" ] && [ "$2" = "token" ]; then echo "fake-token"; exit 0; fi',
    'echo "GH_ARGS:$*"',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(fakeGh, 0o755);

  process.env.PATH = `${binDir}:${process.env.PATH}`;
  broker = startGitBroker({ cwd: repoDir });
});

after(async () => {
  if (broker) {
    broker.proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    rmSync(broker.dir, { recursive: true, force: true });
  }
  rmSync(root, { recursive: true, force: true });
});

function runWrapper(argv, feedStdin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WRAPPER, ...argv], {
      cwd: repoDir,
      env: { ...process.env, CCSANDBOX_GIT_BROKER_SOCK: broker.sockPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const start = Date.now();
    child.on('close', (code) => resolve({ code, out, ms: Date.now() - start }));
    feedStdin(child.stdin);
  });
}

test('stdin that is open but never sends data or EOF does not hang the wrapper', async () => {
  // Simulates a non-TTY fd shared with a longer-lived shell/pty: never
  // written to, never closed. Before the fix this blocked forever.
  const r = await runWrapper(['pr', 'view', '1'], () => { /* leave stdin open, untouched */ });
  assert.equal(r.code, 0);
  assert.equal(r.out, 'GH_ARGS:pr view 1\n');
  assert.ok(r.ms < 3000, `expected the 200ms grace period to apply, took ${r.ms}ms`);
});

test('stdin closed immediately with no data resolves quickly', async () => {
  const r = await runWrapper(['pr', 'view', '1'], (stdin) => stdin.end());
  assert.equal(r.code, 0);
  assert.ok(r.ms < 2000, `took ${r.ms}ms`);
});

test('real piped stdin content is still forwarded correctly (not broken by the timeout)', async () => {
  const r = await runWrapper(['pr', 'create', '--body-file', '-'], (stdin) => {
    stdin.write('body from stdin\n');
    stdin.end();
  });
  assert.equal(r.code, 0);
  assert.equal(r.out, 'GH_ARGS:pr create --body-file -\n');
  assert.ok(r.ms < 2000, `took ${r.ms}ms`);
});
