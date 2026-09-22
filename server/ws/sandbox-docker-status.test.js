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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, join } from 'node:path';
import { dockerdStatus, buildSandboxSpawn, dockerSandboxAvailable } from './sandbox.js';

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
