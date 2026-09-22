// Tool provisioning (rtk / code-review-graph) for sandboxed sessions:
//   - resolveTools merges sandbox.config.json's `tools` (server fallback, off
//     unless enabled there) with the client's per-session sandboxOpts.tools --
//     the launch menu defaults these tools to ON per directory (see
//     DirectoryBrowser), and that choice overrides the fallback. True enables
//     a pinned default spec; the object form can override version/url/sha256.
//   - buildSandboxSpawn, when any tool is enabled, ro-binds the provisioner at
//     /ccserver-sandbox-provision.sh and passes the tool specs via env. With no
//     tool enabled nothing is added.
//
// Isolated via CCSERVER_SANDBOX_CONFIG and CCSERVER_SANDBOX_HOME_ROOT (no real
// bwrap/pty involved -- buildSandboxSpawn only assembles the argv).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildSandboxSpawn, buildMinimalSandboxSpawn, resolveTools } from './sandbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROVISION_PATH = '/ccserver-sandbox-provision.sh';
const PROVISION_SCRIPT = join(__dirname, 'sandbox-provision.sh');

let cfgPath;
let tmpRoot;
let rtkFixture;

function writeConfig(json) {
  writeFileSync(cfgPath, JSON.stringify(json));
}

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-provision-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
  rtkFixture = makeRtkFixture();
});

after(() => {
  delete process.env.CCSERVER_SANDBOX_CONFIG;
  delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Pull the provision-related env out of a buildSandboxSpawn argv.
function provisionEnv(args) {
  const out = {};
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--setenv' && args[i + 1].startsWith('CCSANDBOX_')) {
      out[args[i + 1]] = args[i + 2];
    }
  }
  return out;
}

test('resolveTools defaults to off when the config has no tools', () => {
  writeConfig({ docker: false, gitBroker: false });
  const tools = resolveTools();
  assert.equal(tools.rtk, false);
  assert.equal(tools.codeReviewGraph, false);
  assert.equal(tools.rtkSpec, null);
  assert.equal(tools.crgSpec, null);
});

test('resolveTools: config "rtk": true enables rtk with the pinned default spec', () => {
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: true } });
  const tools = resolveTools();
  assert.equal(tools.rtk, true);
  assert.equal(tools.codeReviewGraph, false);
  assert.ok(tools.rtkSpec.version.length > 0, 'pinned version present');
  assert.ok(tools.rtkSpec.url.startsWith('https://github.com/rtk-ai/rtk/releases/'), 'release URL');
  assert.equal(tools.rtkSpec.sha256.length, 64, 'pinned sha256 present');
});

test('resolveTools: object form overrides version/url/sha256', () => {
  writeConfig({ docker: false, gitBroker: false, tools: { 'code-review-graph': { enabled: true, version: '9.9.9' } } });
  const tools = resolveTools();
  assert.equal(tools.codeReviewGraph, true);
  assert.equal(tools.crgSpec.version, '9.9.9');
  assert.equal(tools.crgSpec.enabled, undefined, 'enabled is a toggle, not part of the spec');
});

test('resolveTools: object form with enabled:false disables the tool', () => {
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: { enabled: false, version: 'v9.9.9' } } });
  const tools = resolveTools();
  assert.equal(tools.rtk, false);
  assert.equal(tools.rtkSpec, null);
});

test('resolveTools: array values are invalid and disable the tool', () => {
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: [] } });
  assert.equal(resolveTools().rtk, false);
});

test('resolveTools: per-session object form is ignored (booleans only)', () => {
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: false } });
  // A crafted WS message must not be able to point the provisioner at an
  // arbitrary URL or skip the checksum: per-session values are on/off
  // toggles, object overrides come solely from sandbox.config.json.
  const tools = resolveTools({ tools: { rtk: { version: 'v9.9.9', url: 'https://example.invalid/evil.tar.gz', sha256: '' } } });
  assert.equal(tools.rtk, false, 'per-session object does not enable the tool');
  assert.equal(tools.rtkSpec, null);
});

test('resolveTools: per-session true uses the pinned default, not config overrides', () => {
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: { enabled: true, version: 'v9.9.9-custom' } } });
  const tools = resolveTools({ tools: { rtk: true } });
  assert.equal(tools.rtk, true);
  assert.notEqual(tools.rtkSpec.version, 'v9.9.9-custom', 'client toggle cannot select the version');
});

test('resolveTools: per-session sandboxOpts.tools overrides the config default', () => {
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: false } });
  const tools = resolveTools({ tools: { rtk: true, codeReviewGraph: false } });
  assert.equal(tools.rtk, true, 'session opts turn a config-disabled tool on');
  const off = resolveTools({ tools: { rtk: false } });
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: true } });
  assert.equal(resolveTools({ tools: { rtk: false } }).rtk, false, 'session opts turn a config-enabled tool off');
  assert.equal(off.codeReviewGraph, false);
});

test('resolveTools: threaded cfgTools avoids re-reading the config file', () => {
  // The on-disk config disables everything; the threaded snapshot enables rtk.
  // If resolveTools re-read the file, the threaded value would lose.
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: false } });
  const tools = resolveTools(null, { rtk: true });
  assert.equal(tools.rtk, true, 'threaded cfgTools wins over the file');
  assert.equal(tools.codeReviewGraph, false);
  assert.ok(tools.rtkSpec.version.length > 0, 'pinned version present');
  // And a threaded empty snapshot behaves like a tools-less config.
  const off = resolveTools({ tools: { rtk: true } }, {});
  assert.equal(off.rtk, true, 'per-session toggles still apply on top of the snapshot');
});

test('buildSandboxSpawn binds the provisioner + sets env when a tool is enabled', async () => {
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: true, 'code-review-graph': true } });
  const spawn = await buildSandboxSpawn({ cwd: join(tmpRoot, 'proj'), targetCommand: ['claude'], app: 'claude', sandboxOpts: null });
  const args = spawn.args;
  const provisionBind = args.findIndex((v, i) => v === '--ro-bind' && args[i + 1].endsWith('sandbox-provision.sh') && args[i + 2] === PROVISION_PATH);
  assert.ok(provisionBind > 0, 'provisioner ro-bound at the fixed path');
  const env = provisionEnv(args);
  assert.equal(env.CCSANDBOX_PROVISION_RTK, '1');
  assert.equal(env.CCSANDBOX_PROVISION_CRG, '1');
  assert.ok(env.CCSANDBOX_RTK_VERSION.length > 0);
  assert.ok(env.CCSANDBOX_RTK_URL.startsWith('https://'));
  assert.equal(env.CCSANDBOX_CRG_VERSION, '2.3.7');
});

test('buildSandboxSpawn adds no provision bind/env when tools are off', async () => {
  writeConfig({ docker: false, gitBroker: false });
  const spawn = await buildSandboxSpawn({ cwd: join(tmpRoot, 'proj2'), targetCommand: ['claude'], app: 'claude', sandboxOpts: null });
  assert.ok(!spawn.args.includes(PROVISION_PATH), 'no provisioner bind');
  assert.equal(provisionEnv(spawn.args).CCSANDBOX_PROVISION_RTK, undefined);
});

test('buildSandboxSpawn respects per-session sandboxOpts.tools over the config', async () => {
  writeConfig({ docker: false, gitBroker: false });
  const spawn = await buildSandboxSpawn({
    cwd: join(tmpRoot, 'proj3'), targetCommand: ['claude'], app: 'claude',
    sandboxOpts: { tools: { rtk: true, codeReviewGraph: false } },
  });
  const env = provisionEnv(spawn.args);
  assert.equal(env.CCSANDBOX_PROVISION_RTK, '1');
  assert.equal(env.CCSANDBOX_PROVISION_CRG, '0');
});

test('buildMinimalSandboxSpawn (usage capture) never provisions tools', () => {
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: true } });
  const spawn = buildMinimalSandboxSpawn({ cwd: join(tmpRoot, 'proj4'), targetCommand: ['claude'] });
  assert.ok(!spawn.args.includes(PROVISION_PATH), 'throwaway sandbox stays lean');
  assert.equal(provisionEnv(spawn.args).CCSANDBOX_PROVISION_RTK, undefined);
});

// ---------------------------------------------------------------------------
// Shell-level tests: run sandbox-provision.sh itself inside a stubbed HOME with
// a fake `python3` on PATH. There is no real venv/bwrap here -- the fake
// python3 materializes the $venv/bin/pip and $venv/bin/code-review-graph shims
// (the latter records its argv to a file and exits 0 / CRG_BUILD_EXIT), so we
// can verify the graph build step, the marker semantics, and the status lines
// the CLI shows while installing.
// ---------------------------------------------------------------------------

// Create a fake `python3` that handles `-m venv <path>` by writing the pip and
// code-review-graph shims the provisioner expects under the venv bin dir.
function makeFakePython3(binDir) {
  mkdirSync(binDir, { recursive: true });
  const py = join(binDir, 'python3');
  writeFileSync(py, `#!/usr/bin/env bash
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  venv="$3"
  mkdir -p "$venv/bin"
  printf '#!/usr/bin/env bash\\necho "$@" >> "\${PIP_CALL_LOG:-/dev/null}"\\nexit 0\\n' > "$venv/bin/pip"
  chmod +x "$venv/bin/pip"
  cat > "$venv/bin/code-review-graph" <<'SHIM'
#!/usr/bin/env bash
echo "$@" >> "\${CRG_BUILD_LOG:-/dev/null}"
exit "\${CRG_BUILD_EXIT:-0}"
SHIM
  chmod +x "$venv/bin/code-review-graph"
  exit 0
fi
echo "fake python3: unknown args: $*" >&2
exit 1
`);
  chmodSync(py, 0o755);
}

function runCrgProvisioner({ home, cwd, buildLog, buildExit = 0, pipLog = null }) {
  const binDir = join(tmpRoot, 'fakebin');
  makeFakePython3(binDir);
  mkdirSync(cwd, { recursive: true });
  return spawnSync('bash', [PROVISION_SCRIPT], {
    cwd,
    env: {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      CCSANDBOX_PROVISION_RTK: '0',
      CCSANDBOX_PROVISION_CRG: '1',
      CCSANDBOX_CRG_VERSION: '9.9.9',
      CRG_BUILD_LOG: buildLog,
      CRG_BUILD_EXIT: String(buildExit),
      ...(pipLog ? { PIP_CALL_LOG: pipLog } : {}),
    },
    encoding: 'utf8',
  });
}

function provisionLog(home) {
  return join(home, '.local', 'share', 'ccserver-tools', 'provision.log');
}

// ---------------------------------------------------------------------------
// rtk install path: a fake `curl` serves a locally built tarball (an
// executable `rtk` at the archive root) so install_rtk runs end to end
// without network. Covers the unpinned-sha256 terminal warning and the
// versioned-marker / single-binary skip semantics.
// ---------------------------------------------------------------------------

// Build a minimal rtk release tarball under tmpRoot; returns its path + sha256.
function makeRtkFixture() {
  const dir = mkdtempSync(join(tmpRoot, 'rtk-fixture-'));
  const bin = join(dir, 'rtk');
  writeFileSync(bin, '#!/usr/bin/env bash\necho rtk-fixture\n');
  chmodSync(bin, 0o755);
  const tarball = join(dir, 'rtk.tar.gz');
  const res = spawnSync('tar', ['-czf', tarball, '-C', dir, 'rtk']);
  assert.equal(res.status, 0, 'fixture tarball created');
  const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  return { tarball, sha };
}

// Fake `curl` handling the exact invocation download() uses
// (`curl -fsSL --retry 2 --connect-timeout 15 <url> -o <dest>`): copies the
// fixture tarball to <dest> regardless of <url>.
function makeFakeCurl(binDir, fixtureTarball) {
  mkdirSync(binDir, { recursive: true });
  const curl = join(binDir, 'curl');
  writeFileSync(curl, `#!/usr/bin/env bash
dest=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then dest="$a"; fi
  prev="$a"
done
[ -n "$dest" ] || exit 1
cp "${fixtureTarball}" "$dest"
`);
  chmodSync(curl, 0o755);
}

function runRtkProvisioner({ home, cwd, version, sha, breakFlock = false }) {
  // A broken-flock case gets its own PATH dir so the failing stub cannot
  // leak into the other tests sharing fakebin.
  const binDir = breakFlock ? mkdtempSync(join(tmpRoot, 'fakebin-noflock-')) : join(tmpRoot, 'fakebin');
  makeFakePython3(binDir);
  makeFakeCurl(binDir, rtkFixture.tarball);
  if (breakFlock) {
    // Shadow flock(1) with a failing stub: provisioning must fall back to
    // the unprotected behavior instead of aborting the session launch.
    const flock = join(binDir, 'flock');
    writeFileSync(flock, '#!/usr/bin/env bash\nexit 1\n');
    chmodSync(flock, 0o755);
  }
  mkdirSync(cwd, { recursive: true });
  return spawnSync('bash', [PROVISION_SCRIPT], {
    cwd,
    env: {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      CCSANDBOX_PROVISION_RTK: '1',
      CCSANDBOX_RTK_VERSION: version,
      CCSANDBOX_RTK_URL: 'https://example.invalid/rtk.tar.gz',
      CCSANDBOX_RTK_SHA256: sha,
      CCSANDBOX_PROVISION_CRG: '0',
    },
    encoding: 'utf8',
  });
}

function rtkMarker(home, version) {
  return join(home, '.local', 'share', 'ccserver-tools', 'markers', `rtk-${version}`);
}

function rtkBinary(home) {
  return join(home, '.local', 'bin', 'rtk');
}

test('provisioner warns on stderr when rtk sha256 is unpinned but still installs', () => {
  const home = join(tmpRoot, 'rtk-home-warn');
  const repo = join(tmpRoot, 'rtk-repo-warn');
  const res = runRtkProvisioner({ home, cwd: repo, version: 'v9.9.9-test', sha: '' });

  assert.equal(res.status, 0, `provisioner exited 0 (stderr: ${res.stderr})`);
  assert.match(res.stderr, /チェックサム検証をスキップ/, 'terminal warning emitted, not just the log');
  assert.match(readFileSync(provisionLog(home), 'utf8'), /skipping checksum/);
  assert.ok(existsSync(rtkBinary(home)), 'binary installed despite skipped checksum');
  assert.ok(existsSync(rtkMarker(home, 'v9.9.9-test')), 'marker written');
  assert.match(res.stdout, /rtk 導入完了/);
});

test('provisioner stays silent about checksums when rtk sha256 matches', () => {
  const home = join(tmpRoot, 'rtk-home-pinned');
  const repo = join(tmpRoot, 'rtk-repo-pinned');
  const res = runRtkProvisioner({ home, cwd: repo, version: 'v9.9.9-test', sha: rtkFixture.sha });

  assert.equal(res.status, 0, `provisioner exited 0 (stderr: ${res.stderr})`);
  assert.ok(!/チェックサム/.test(res.stderr), 'no checksum warning on a verified install');
  assert.ok(existsSync(rtkBinary(home)), 'binary installed');
});

test('provisioner: requesting a new rtk version reinstalls and sweeps the old marker', () => {
  const home = join(tmpRoot, 'rtk-home-switch');
  const repo = join(tmpRoot, 'rtk-repo-switch');
  const markers = join(home, '.local', 'share', 'ccserver-tools', 'markers');
  mkdirSync(markers, { recursive: true });
  writeFileSync(join(markers, 'rtk-v0.0.0-old'), '');
  const res = runRtkProvisioner({ home, cwd: repo, version: 'v9.9.9-test', sha: rtkFixture.sha });

  assert.equal(res.status, 0, `provisioner exited 0 (stderr: ${res.stderr})`);
  assert.match(res.stdout, /rtk をインストール中/, 'stale marker does not skip the new version');
  assert.ok(existsSync(rtkMarker(home, 'v9.9.9-test')), 'new version marker written');
  assert.ok(!existsSync(join(markers, 'rtk-v0.0.0-old')), 'stale marker swept');
});

test('provisioner: matching rtk marker plus the binary skips, a bare marker does not', () => {
  const home = join(tmpRoot, 'rtk-home-skip');
  const repo = join(tmpRoot, 'rtk-repo-skip');
  const first = runRtkProvisioner({ home, cwd: repo, version: 'v9.9.9-test', sha: rtkFixture.sha });
  assert.equal(first.status, 0);
  const second = runRtkProvisioner({ home, cwd: repo, version: 'v9.9.9-test', sha: rtkFixture.sha });
  assert.equal(second.status, 0);
  assert.ok(!/インストール中/.test(second.stdout), 'no reinstall when marker and binary both present');

  // Marker without the entity (e.g. hand-deleted HOME file) reinstalls.
  rmSync(rtkBinary(home));
  const third = runRtkProvisioner({ home, cwd: repo, version: 'v9.9.9-test', sha: rtkFixture.sha });
  assert.equal(third.status, 0, `provisioner exited 0 (stderr: ${third.stderr})`);
  assert.match(third.stdout, /rtk をインストール中/, 'missing binary reinstalls despite the marker');
  assert.ok(existsSync(rtkBinary(home)), 'binary restored');
});

test('provisioner proceeds when flock is unavailable (best-effort locking)', () => {
  const home = join(tmpRoot, 'rtk-home-noflock');
  const repo = join(tmpRoot, 'rtk-repo-noflock');
  const res = runRtkProvisioner({ home, cwd: repo, version: 'v9.9.9-test', sha: rtkFixture.sha, breakFlock: true });

  assert.equal(res.status, 0, `provisioner exited 0 without a working flock (stderr: ${res.stderr})`);
  assert.ok(existsSync(rtkBinary(home)), 'binary installed despite broken flock');
  assert.ok(existsSync(rtkMarker(home, 'v9.9.9-test')), 'marker written');
});

test('provisioner runs `code-review-graph build --repo "$PWD"` after install and only marks once both succeed', () => {
  const home = join(tmpRoot, 'crg-home-ok');
  const repo = join(tmpRoot, 'crg-repo-ok');
  const buildLog = join(tmpRoot, 'crg-build-ok.log');
  const marker = join(home, '.local', 'share', 'ccserver-tools', 'markers', 'code-review-graph-9.9.9');
  const res = runCrgProvisioner({ home, cwd: repo, buildLog });

  assert.equal(res.status, 0, `provisioner exited 0 (stderr: ${res.stderr})`);
  const calls = readFileSync(buildLog, 'utf8').trim().split('\n');
  assert.equal(calls.length, 1, 'build invoked exactly once');
  assert.equal(calls[0], `build --repo ${repo} --quiet`);
  assert.ok(existsSync(marker), 'marker written after install + build both succeed');
  assert.match(res.stdout, /code-review-graph をインストール中…/);
  assert.match(res.stdout, /code-review-graph のグラフを構築中…/);
  assert.match(res.stdout, /code-review-graph 導入完了/);
});

test('provisioner: marker is not written when the graph build fails (retried next launch)', () => {
  const home = join(tmpRoot, 'crg-home-fail');
  const repo = join(tmpRoot, 'crg-repo-fail');
  const buildLog = join(tmpRoot, 'crg-build-fail.log');
  const marker = join(home, '.local', 'share', 'ccserver-tools', 'markers', 'code-review-graph-9.9.9');
  const res = runCrgProvisioner({ home, cwd: repo, buildLog, buildExit: 7 });

  assert.equal(res.status, 1, 'provisioner reports failure via exit code');
  assert.ok(!existsSync(marker), 'no marker on build failure, so the next launch retries');
  assert.match(readFileSync(provisionLog(home), 'utf8'), /graph build failed/);});

test('provisioner: a matching marker plus the installed shim short-circuits before any install/build work', () => {
  const home = join(tmpRoot, 'crg-home-skip');
  const repo = join(tmpRoot, 'crg-repo-skip');
  const buildLog = join(tmpRoot, 'crg-build-skip.log');
  const markers = join(home, '.local', 'share', 'ccserver-tools', 'markers');
  mkdirSync(markers, { recursive: true });
  writeFileSync(join(markers, 'code-review-graph-9.9.9'), '');
  // The skip requires the installed entity too, not just the marker: a stale
  // marker from a version switch-back (or a hand-deleted venv) must reinstall.
  const binDir = join(home, '.local', 'bin');
  mkdirSync(binDir, { recursive: true });
  const shim = join(binDir, 'code-review-graph');
  writeFileSync(shim, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(shim, 0o755);
  const res = runCrgProvisioner({ home, cwd: repo, buildLog });

  assert.equal(res.status, 0);
  assert.ok(!existsSync(buildLog), 'build never invoked when the marker matches');
  assert.ok(!/インストール中/.test(res.stdout), 'no install status lines on the fast path');
});

test('provisioner: a matching marker without the shim reinstalls (stale marker)', () => {
  const home = join(tmpRoot, 'crg-home-stale');
  const repo = join(tmpRoot, 'crg-repo-stale');
  const buildLog = join(tmpRoot, 'crg-build-stale.log');
  const markers = join(home, '.local', 'share', 'ccserver-tools', 'markers');
  mkdirSync(markers, { recursive: true });
  writeFileSync(join(markers, 'code-review-graph-9.9.9'), '');
  const res = runCrgProvisioner({ home, cwd: repo, buildLog });

  assert.equal(res.status, 0, `provisioner exited 0 (stderr: ${res.stderr})`);
  assert.ok(existsSync(buildLog), 'build invoked: marker alone does not skip');
  assert.match(res.stdout, /code-review-graph をインストール中…/);
});

test('provisioner: a failed build retries only the build, not the pip install', () => {
  const home = join(tmpRoot, 'crg-home-retry');
  const repo = join(tmpRoot, 'crg-repo-retry');
  const buildLog = join(tmpRoot, 'crg-build-retry.log');
  const pipLog = join(tmpRoot, 'crg-pip-retry.log');
  const markers = join(home, '.local', 'share', 'ccserver-tools', 'markers');
  const installed = join(markers, 'code-review-graph-9.9.9.installed');
  const marker = join(markers, 'code-review-graph-9.9.9');

  const first = runCrgProvisioner({ home, cwd: repo, buildLog, pipLog, buildExit: 7 });
  assert.equal(first.status, 1, 'first run reports the build failure');
  assert.ok(existsSync(installed), 'install step is recorded despite the build failure');
  assert.ok(!existsSync(marker), 'full marker waits for the build');
  assert.equal(readFileSync(pipLog, 'utf8').trim().split('\n').length, 1, 'pip ran once');

  const second = runCrgProvisioner({ home, cwd: repo, buildLog, pipLog, buildExit: 0 });
  assert.equal(second.status, 0, `second run exited 0 (stderr: ${second.stderr})`);
  assert.equal(readFileSync(pipLog, 'utf8').trim().split('\n').length, 1, 'pip not redone on build retry');
  assert.equal(readFileSync(buildLog, 'utf8').trim().split('\n').length, 2, 'build retried');
  assert.ok(existsSync(marker), 'full marker written once the build succeeds');
});

test('provisioner: requesting a new version reinstalls and sweeps the old marker', () => {
  const home = join(tmpRoot, 'crg-home-switch');
  const repo = join(tmpRoot, 'crg-repo-switch');
  const buildLog = join(tmpRoot, 'crg-build-switch.log');
  const markers = join(home, '.local', 'share', 'ccserver-tools', 'markers');
  mkdirSync(markers, { recursive: true });
  writeFileSync(join(markers, 'code-review-graph-0.0.0-old'), '');
  const res = runCrgProvisioner({ home, cwd: repo, buildLog });

  assert.equal(res.status, 0, `provisioner exited 0 (stderr: ${res.stderr})`);
  const calls = readFileSync(buildLog, 'utf8').trim().split('\n');
  assert.equal(calls.length, 1, 'build invoked exactly once for the new version');
  assert.ok(existsSync(join(markers, 'code-review-graph-9.9.9')), 'new version marker written');
  assert.ok(!existsSync(join(markers, 'code-review-graph-0.0.0-old')), 'stale marker swept');
});
