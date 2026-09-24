// dockerdStatus() (see sessionManager.dockerAvailability) reads the status
// file sandbox-entrypoint.sh writes the instant its background dockerd wins
// this project's data-root flock, so the host side can tell "docker is
// available to ME" apart from "a different session of this project has it"
// (see tmp/docker-availability-visibility-plan.md). Isolated via
// CCSERVER_SANDBOX_DIND_ROOT so this never touches the real
// ~/.local/share/ccserver-sandbox/dind.
//
// buildSandboxSpawn only assembles bwrap argv (pure, no process is spawned --
// same pattern as sandbox-persistent-home.test.js); its docker path does need
// real bwrap/rootlesskit/slirp4netns/newuidmap (dockerSandboxAvailable(), see
// sandbox.js), so the CCSANDBOX_DOCKERD_TAG wiring below is skipped rather
// than mocked when those are missing.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { basename, join } from 'node:path';
import { dockerdStatus, dindLockHeld, buildSandboxSpawn, dockerSandboxAvailable } from './sandbox.js';

let tmpRoot;
let dindRoot;
let cfgPath;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-dind-status-'));
  dindRoot = join(tmpRoot, 'dind');
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  process.env.CCSERVER_SANDBOX_DIND_ROOT = dindRoot;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
});

after(() => {
  delete process.env.CCSERVER_SANDBOX_DIND_ROOT;
  delete process.env.CCSERVER_SANDBOX_CONFIG;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('dockerdStatus: null before any status file exists for this cwd', () => {
  assert.equal(dockerdStatus('/srv/docker-status-proj-a'), null);
  assert.equal(dockerdStatus('/srv/docker-status-proj-a/'), null, 'still null -- no file was written');
});

// --bind <src> <dest> pairs in the assembled bwrap args (see
// sandbox-persistent-home.test.js's findBindHome for the same pattern).
function findBindSrc(args, dest) {
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === '--bind' && args[i + 2] === dest) return args[i + 1];
  }
  return null;
}

function findSetenv(args, name) {
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === '--setenv' && args[i + 1] === name) return args[i + 2];
  }
  return null;
}

test('await buildSandboxSpawn(docker:true): CCSANDBOX_DOCKERD_TAG is the stateDir basename, and writing it to the data-root status file round-trips through dockerdStatus', async (t) => {
  if (!dockerSandboxAvailable()) {
    t.skip('bwrap/rootlesskit/slirp4netns/newuidmap not installed in this environment');
    return;
  }
  writeFileSync(cfgPath, JSON.stringify({ docker: true, gitBroker: false }));
  const cwd = '/srv/docker-status-proj-b';
  const spawn = await buildSandboxSpawn({ cwd, targetCommand: ['claude'], app: 'claude', sandboxOpts: null });
  assert.equal(spawn.docker, true, 'docker tooling is available in this environment');

  const dockerHomeDest = join(homedir(), '.local', 'share', 'docker');
  const dataRoot = findBindSrc(spawn.args, dockerHomeDest);
  assert.ok(dataRoot, 'a docker data-root --bind must be present when docker is on');

  const tag = findSetenv(spawn.args, 'CCSANDBOX_DOCKERD_TAG');
  assert.ok(tag, 'CCSANDBOX_DOCKERD_TAG must be set when docker is on');
  assert.equal(tag, basename(spawn.stateDir), 'the tag reuses the per-launch stateDir basename, not a fresh id');

  assert.equal(dockerdStatus(cwd), null, 'nothing written yet for this cwd');
  // buildSandboxSpawn already created dataRoot (see buildBwrapArgs' docker
  // branch); mirror sandbox-entrypoint.sh's
  // `echo "$CCSANDBOX_DOCKERD_TAG" > "$DATA_ROOT/.ccserver-dockerd.status"`.
  writeFileSync(join(dataRoot, '.ccserver-dockerd.status'), `${tag}\n`);
  assert.equal(dockerdStatus(cwd), tag, 'dockerdStatus reads back exactly the tag the entrypoint would have written');
});

test('dockerdStatus: isolated per cwd, trims surrounding whitespace', async (t) => {
  if (!dockerSandboxAvailable()) {
    t.skip('bwrap/rootlesskit/slirp4netns/newuidmap not installed in this environment');
    return;
  }
  writeFileSync(cfgPath, JSON.stringify({ docker: true, gitBroker: false }));
  const cwdA = '/srv/docker-status-proj-c';
  const cwdB = '/srv/docker-status-proj-d';
  const dockerHomeDest = join(homedir(), '.local', 'share', 'docker');
  const specA = await buildSandboxSpawn({ cwd: cwdA, targetCommand: ['claude'], app: 'claude', sandboxOpts: null });
  const dataRootA = findBindSrc(specA.args, dockerHomeDest);
  writeFileSync(join(dataRootA, '.ccserver-dockerd.status'), '  tag-a  \n');
  assert.equal(dockerdStatus(cwdA), 'tag-a');
  assert.equal(dockerdStatus(cwdB), null, 'a different project has no status of its own');
});


// ---------------------------------------------------------------------------
// #212: the data-root is bind-mounted READ-WRITE into the sandbox
// ---------------------------------------------------------------------------
//
// This is the difference between these two cases and the eight state-JSON
// readers this PR also fixed. Those live under the config and state roots,
// which buildBwrapArgs does NOT bind -- measured from inside a sandbox,
// ~/.config/ccserver and ~/.local/state/ccserver do not even exist there. The
// docker data-root DOES get bound, rw, at ~/.local/share/docker:
//
//   /proc/self/mountinfo:
//     ... /ccserver-sandbox/dind/<slug> /home/kts_sz/.local/share/docker rw ...
//   $ test -w ~/.local/share/docker/.ccserver-dockerd.status  -> writable
//   $ rm f && mkfifo f                                        -> succeeds
//
// So a session can replace its own status/lock file with a FIFO. These are
// the only #212 sites reachable that way.
//
// A regression does NOT fail these -- it hangs the runner (a synchronous open
// cannot be interrupted from inside the process). See the header of
// stateRestoreFifo.test.js.

// Mirrors sandbox.js's slugify() (it is not exported). The live-read
// assertion in each case below is what catches it if the two ever drift --
// otherwise the FIFO would land somewhere nothing reads and the case would
// pass for the boring reason.
function slugFor(p) {
  return p.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root';
}

function mkfifoAt(t, path) {
  try {
    execFileSync('mkfifo', [path]);
    return true;
  } catch {
    t.skip('mkfifo unavailable');
    return false;
  }
}

test('#212: dockerdStatus refuses a FIFO status file instead of blocking', { timeout: 15000 }, (t) => {
  const cwd = '/srv/docker-status-fifo-proj';
  const dir = join(dindRoot, slugFor(cwd));
  mkdirSync(dir, { recursive: true });
  const statusFile = join(dir, '.ccserver-dockerd.status');

  // Prove the read path is live at this exact path FIRST, so a slug drift
  // cannot turn this case into a hollow pass.
  writeFileSync(statusFile, 'tag-live\n');
  assert.equal(dockerdStatus(cwd), 'tag-live', 'the read path is live at this path');

  rmSync(statusFile);
  if (!mkfifoAt(t, statusFile)) return;
  // Pre-fix this was readFileSync, which does not throw on a FIFO -- it waits
  // for a writer that never comes, with the host's event loop stopped.
  assert.equal(dockerdStatus(cwd), null, 'a FIFO reads as "no tag", exactly like a missing file');
});

test('#212: dindLockHeld refuses a FIFO lock file instead of blocking', { timeout: 15000 }, (t) => {
  const name = 'dind-lock-fifo-proj';
  const dir = join(dindRoot, name);
  mkdirSync(dir, { recursive: true });
  const lockFile = join(dir, '.ccserver-dockerd.lock');

  // Live-read proof: a real, unheld lock file answers false through the real
  // flock(1), so we know this path is the one dindLockHeld consults.
  writeFileSync(lockFile, '');
  try {
    execFileSync('flock', ['-n', lockFile, 'true'], { stdio: 'ignore' });
  } catch {
    t.skip('flock unavailable');
    return;
  }
  assert.equal(dindLockHeld(name), false, 'an unheld regular lock file is not held');

  rmSync(lockFile);
  if (!mkfifoAt(t, lockFile)) return;
  // existsSync says yes to a FIFO, and flock(1) then blocks in open(2)
  // forever -- through execFileSync that is the host's event loop, not just
  // the child's. A FIFO is not a lock file, so it reads as "not held", the
  // same answer a missing one gives.
  assert.equal(dindLockHeld(name), false, 'a FIFO lock file is not a held lock');
});
