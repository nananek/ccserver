// Issue #119 Step7-3: isPtyHostEnabled() now defaults to ON (see
// ws/ptyHostClient.js), so an existing deployment that never started
// ccserver-pty-host.service must not have every session creation fail
// outright the moment it upgrades. index.js probes pty-host reachability
// once at boot (checkPtyHostReachable()) and, if it's not actually there,
// overrides process.env.CCSERVER_PTY_HOST='0' for the rest of that run.
//
// Same "spawn the real entrypoint" approach as startup-hidden-apps.test.js:
// this covers the actual wiring in index.js (import, ordering relative to
// initPtyHostDestroyedHandler() etc., the log message itself), not just the
// checkPtyHostReachable()/isPtyHostEnabled() unit tests already covered in
// ws/ptyHostClient.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(__dirname, 'index.js');

// Boots the real server, lets it run for `aliveForMs`, then asks it to stop
// -- a single 'exit' listener resolves the promise exactly once, whichever
// way the process actually ends, so this never hangs waiting for an 'exit'
// event that already fired before a listener was attached to catch it.
// `exitedEarly: true` means it died on its own before the alive-check
// window elapsed (a crash), not because this helper asked it to.
function runServerAndCapture(env, { aliveForMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    // This whole file's point is exercising isPtyHostEnabled()'s
    // unset-vs-explicit-value distinction, but `npm test` itself runs with
    // CCSERVER_PTY_HOST=0 pinned (server/package.json, Issue #119 Step7-2 --
    // every OTHER test file needs the pre-Step7 direct-spawn default, since
    // none of them start a pty-host process). That pin is inherited into
    // this test process's own `process.env`, so it must be stripped before
    // building the child's env here -- otherwise a test that wants the var
    // genuinely unset would silently inherit '0' instead, from the test
    // harness rather than from anything this test itself asked for.
    const childEnv = { ...process.env };
    delete childEnv.CCSERVER_PTY_HOST;
    Object.assign(childEnv, env);
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: __dirname,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killedByUs = false;
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ exitedEarly: !killedByUs, stdout, stderr });
    });
    const timer = setTimeout(() => {
      killedByUs = true;
      child.kill('SIGTERM');
    }, aliveForMs);
    timer.unref?.();
    // Safety net only -- gracefulShutdown() is expected to exit well within
    // this, and the 'exit' listener above already clears it on a normal
    // SIGTERM exit; this must never be the reason the suite hangs.
    const killTimer = setTimeout(() => child.kill('SIGKILL'), aliveForMs + 5000);
    killTimer.unref?.();
  });
}

function tempEnvPaths(dir) {
  return {
    CCSERVER_DB_PATH: join(dir, 'db.sqlite3'),
    CCSERVER_GROUPS_PATH: join(dir, 'groups.json'),
    CCSERVER_SAVED_SESSIONS_PATH: join(dir, 'sessions.json'),
    CCSERVER_PTY_HOST_SESSION_META_PATH: join(dir, 'pty-host-session-meta.json'),
    // Pin claude as "installed" via a real, always-executable file (same
    // trick startup-hidden-apps.test.js uses) so this test's outcome never
    // depends on whether claude happens to be on this host's PATH.
    CCSERVER_CLAUDE_BIN: process.execPath,
    PORT: '0',
  };
}

test('server falls back to direct spawn and logs a warning when pty-host is unreachable at boot (CCSERVER_PTY_HOST left unset)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-startup-ptyhost-fallback-'));
  try {
    // checkPtyHostReachable() now retries across its whole ~3000ms budget
    // before giving up on a genuinely-absent socket (Issue #119 Step7-3
    // follow-up: a single fail-fast attempt made that budget pointless
    // against a pty-host that's still starting up, see ptyHostClient.js) --
    // this test's default aliveForMs=4000 leaves too little margin for the
    // rest of boot (module load, SQLite init) on top of that under load, so
    // give it more room here specifically.
    const result = await runServerAndCapture({
      ...tempEnvPaths(dir),
      // A path that will never have anything listening on it -- CCSERVER_PTY_HOST
      // itself is deliberately left UNSET so isPtyHostEnabled()'s new
      // default-ON is what's actually under test here.
      CCSERVER_PTY_HOST_SOCK: join(dir, 'nothing-listens-here.sock'),
    }, { aliveForMs: 7000 });
    assert.equal(result.exitedEarly, false, `server must stay up despite the unreachable pty-host; stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(
      result.stdout + result.stderr,
      /pty-host unreachable at boot -- falling back to direct pty spawn/,
      'the fallback must explain itself in the log, not silently degrade'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server detects a reachable pty-host at boot and does not fall back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-startup-ptyhost-reachable-'));
  const sockPath = join(dir, 'pty-host.sock');
  let host;
  try {
    const { startPtyHost } = await import('./pty-host/index.js');
    host = await startPtyHost({ sockPath });

    const result = await runServerAndCapture({
      ...tempEnvPaths(dir),
      CCSERVER_PTY_HOST_SOCK: sockPath,
    });
    assert.equal(result.exitedEarly, false, `server must stay up; stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(
      result.stdout + result.stderr,
      /pty-host reachable at boot/,
      'a genuinely reachable pty-host must be detected as such, not silently ignored'
    );
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /pty-host unreachable at boot/,
      'a reachable pty-host must never trigger the fallback warning'
    );
  } finally {
    if (host) await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server never even probes when CCSERVER_PTY_HOST=0 is set explicitly (no fallback log, no reachable log)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-startup-ptyhost-explicit-off-'));
  try {
    const result = await runServerAndCapture({
      ...tempEnvPaths(dir),
      CCSERVER_PTY_HOST: '0',
      CCSERVER_PTY_HOST_SOCK: join(dir, 'nothing-listens-here.sock'),
    });
    assert.equal(result.exitedEarly, false, `server must stay up; stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /pty-host (un)?reachable at boot/,
      'an explicit opt-out must skip the probe entirely, not run it and then ignore the result'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
