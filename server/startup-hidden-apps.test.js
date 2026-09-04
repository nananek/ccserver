// The "全滅ケース" (issue #105): sandbox.config.json's hiddenApps must not be
// able to hide every agent CLI silently -- if the intersection of "installed"
// and "not hidden" (selectableAppIds(), see ws/sandbox.js) is empty, every one
// of the 5 launch screens would offer nothing to start. index.js checks this
// right after initDb() and refuses to boot (process.exit(1)) rather than
// serving a UI with an empty picker.
//
// This spawns the real server entrypoint (not a unit-level call) so the
// assertion covers the actual boot sequence, not just the pure helper. A temp
// config/DB/groups/sessions path keeps it independent of -- and harmless to --
// whatever sandbox.config.json this host actually has.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { APP_IDS } from './ws/sandbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(__dirname, 'index.js');

function runServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: __dirname,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not exit within timeout; stdout=${stdout}\nstderr=${stderr}`));
    }, 20_000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('server refuses to start when hiddenApps hides every installed app id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-startup-hidden-apps-'));
  try {
    const cfgPath = join(dir, 'sandbox.config.json');
    writeFileSync(cfgPath, JSON.stringify({ hiddenApps: [...APP_IDS] }));

    // Pin claude as "installed" (same trick as the boots-fine test below) so
    // this exercises the hiddenApps-caused-the-emptiness case specifically,
    // not the unrelated "nothing is installed at all" case index.js now lets
    // boot regardless of hiddenApps.
    const result = await runServer({
      CCSERVER_SANDBOX_CONFIG: cfgPath,
      CCSERVER_CLAUDE_BIN: process.execPath,
      CCSERVER_DB_PATH: join(dir, 'db.sqlite3'),
      CCSERVER_GROUPS_PATH: join(dir, 'groups.json'),
      CCSERVER_SAVED_SESSIONS_PATH: join(dir, 'sessions.json'),
      PORT: '0',
    });

    assert.notEqual(result.code, 0, `server must exit non-zero; stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(
      result.stdout + result.stderr,
      /hiddenApps/,
      'the failure must explain itself in terms of hiddenApps, not fail silently/opaquely'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server boots normally when hiddenApps leaves at least one app selectable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-startup-hidden-apps-ok-'));
  try {
    const cfgPath = join(dir, 'sandbox.config.json');
    // Hide everything except claude, and pin CCSERVER_CLAUDE_BIN at a real,
    // always-executable file (the running node binary) so claude reads as
    // installed regardless of this host's actual PATH -- same deterministic
    // trick sandbox-config.test.js's selectableAppIds tests use. Without
    // this, the test's pass/fail would depend on whether claude happens to
    // be installed on whatever machine runs it.
    writeFileSync(cfgPath, JSON.stringify({ hiddenApps: ['opencode', 'copilot', 'codex'] }));

    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: __dirname,
      env: {
        ...process.env,
        CCSERVER_SANDBOX_CONFIG: cfgPath,
        CCSERVER_CLAUDE_BIN: process.execPath,
        CCSERVER_DB_PATH: join(dir, 'db.sqlite3'),
        CCSERVER_GROUPS_PATH: join(dir, 'groups.json'),
        CCSERVER_SAVED_SESSIONS_PATH: join(dir, 'sessions.json'),
        PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let exited = false;
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', () => { exited = true; });

    // Give it a few seconds to either boot (stays alive) or crash; a clean
    // boot never exits on its own, so absence of an early exit is the signal.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    assert.equal(exited, false, `server exited early when it should have booted; stdout=${stdout}\nstderr=${stderr}`);
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('exit', resolve));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
