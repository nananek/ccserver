import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, chmodSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveApp, installedApps, SANDBOX_PATH, opencodeSupportsStandalone } from './sandbox.js';

// which() (used by resolveApp/resolveAgentCommand) resolves against
// SANDBOX_PATH -- a fixed constant, not the calling process's own PATH -- so
// that detection matches what the sandboxed runtime's PATH will actually
// resolve at launch (see SANDBOX_PATH's own doc comment for why: a host
// process env with an unrelated PATH shim ahead of the real install, e.g.
// systemd's bare PATH missing nvm's bin, must not throw off detection).
// That means resolveApp's result no longer depends on process.env.PATH at
// all: a caller-side PATH override (the old way this test simulated "bare
// systemd PATH") has no effect. What's worth asserting instead is that the
// resolved command actually launches -- either an absolute existing path, or
// a bare name that SANDBOX_PATH itself resolves.
function resolvesToRealBinary(command) {
  if (command.startsWith('/')) return existsSync(command);
  return SANDBOX_PATH.split(':').some((dir) => dir && existsSync(join(dir, command)));
}

// Neither agent CLI is guaranteed to be installed on every machine this suite
// runs on -- notably, plain CI runners (e.g. this repo's ubuntu-latest
// GitHub Actions job) have neither. Skip rather than fail when an app is
// genuinely absent everywhere resolveApp looks, for either app.
function isInstalled(app) {
  return resolvesToRealBinary(resolveApp(app).command);
}

test('resolveApp finds claude via SANDBOX_PATH or its fallback dirs', { skip: !isInstalled('claude') }, () => {
  const r = resolveApp('claude');
  assert.ok(resolvesToRealBinary(r.command), `command does not resolve to a real binary: ${r.command}`);
});

test('resolveApp finds opencode via SANDBOX_PATH or its fallback dirs', { skip: !isInstalled('opencode') }, () => {
  const r = resolveApp('opencode');
  assert.ok(resolvesToRealBinary(r.command), `command does not resolve to a real binary: ${r.command}`);
});

test('resolveApp finds copilot via SANDBOX_PATH or its fallback dirs', { skip: !isInstalled('copilot') }, () => {
  const r = resolveApp('copilot');
  assert.ok(resolvesToRealBinary(r.command), `command does not resolve to a real binary: ${r.command}`);
});

test('resolveApp finds codex via SANDBOX_PATH or its fallback dirs', { skip: !isInstalled('codex') }, () => {
  const r = resolveApp('codex');
  assert.ok(resolvesToRealBinary(r.command), `command does not resolve to a real binary: ${r.command}`);
});

// Homebrew installs live outside SANDBOX_PATH: /opt/homebrew/bin on macOS
// Apple Silicon (Intel Macs use /usr/local/bin, already on SANDBOX_PATH) and
// /home/linuxbrew/.linuxbrew/bin for Linuxbrew. resolveAgentCommand must
// still find them via its fallback dirs. Host-dependent: skip unless a
// Homebrew install is actually present.
const HOMEBREW_BINS = ['/opt/homebrew/bin', '/home/linuxbrew/.linuxbrew/bin'];

test('resolveApp finds opencode via the Homebrew fallback dirs', { skip: !HOMEBREW_BINS.some((dir) => existsSync(join(dir, 'opencode'))) }, () => {
  const r = resolveApp('opencode');
  assert.equal(r.found, true, 'a Homebrew opencode install must report found: true');
  assert.ok(resolvesToRealBinary(r.command), `command does not resolve to a real binary: ${r.command}`);
});

test('resolveApp keeps the bare command name when SANDBOX_PATH resolves it', { skip: !isInstalled('claude') }, () => {
  const r = resolveApp('claude');
  // /usr/bin, /bin etc. are all on SANDBOX_PATH, so a claude install visible
  // there (the common case) should resolve to the bare name, not an absolute
  // path -- the sandbox's own PATH will resolve it identically at launch.
  if (SANDBOX_PATH.split(':').some((dir) => dir && existsSync(join(dir, 'claude')))) {
    assert.ok(['claude', 'claude.exe'].includes(r.command), `expected bare name, got: ${r.command}`);
  }
});

// found: an installed app must report found: true (the launch is a real
// binary), while a genuinely missing one reports found: false with only the
// fallback bare command name -- the signal the server uses to refuse the
// launch and the client to grey out the picker entry.
test('resolveApp reports found: true for an installed app', { skip: !isInstalled('claude') }, () => {
  assert.equal(resolveApp('claude').found, true);
});

test('resolveApp reports found: false when the app is genuinely missing', { skip: isInstalled('claude') }, () => {
  const r = resolveApp('claude');
  assert.equal(r.found, false);
  assert.equal(typeof r.command, 'string', 'the fallback bare name is still returned');
});

// The configured-claudeBin variant of the above: an absolute path pointing at
// a removed CLI (stale "claudeBin" in sandbox.config.json, or
// CCSERVER_CLAUDE_BIN) must read found: false just like a bare name no PATH
// dir resolves -- the availability detection depends on it. Deterministic:
// the env override runs on every host, no claude install needed.
test('resolveApp reports found: false for a configured claudeBin that does not exist', () => {
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  process.env.CCSERVER_CLAUDE_BIN = '/no/such/claude-xyz';
  try {
    const r = resolveApp('claude');
    assert.equal(r.found, false, 'a path-form claudeBin that does not exist must read as not found');
    assert.equal(r.command, '/no/such/claude-xyz', 'the configured bin is kept as the fallback command');
  } finally {
    if (prevBin === undefined) delete process.env.CCSERVER_CLAUDE_BIN;
    else process.env.CCSERVER_CLAUDE_BIN = prevBin;
  }
});

// hostCommand: the absolute host path for NON-sandboxed spawns. resolveApp's
// `command` is resolved against SANDBOX_PATH, which can see installs the
// server process's own PATH cannot (e.g. ~/.local/bin missing from a
// GUI/systemd-launched server's PATH) -- spawning that bare name on the host
// then dies immediately with exit 1 and no output (shells use absolute
// /bin/bash, so only agent CLIs break). hostCommand must therefore always be
// an existing absolute path when found, independent of process.env.PATH
// (resolveApp never reads it -- see the header comment above).
test('resolveApp reports an absolute, existing hostCommand for every installed app', () => {
  let checked = 0;
  for (const app of ['claude', 'opencode', 'copilot', 'codex', 'commandcode']) {
    const r = resolveApp(app);
    if (!r.found) continue;
    checked++;
    assert.ok(r.hostCommand, `${app}: hostCommand must be set when found`);
    assert.ok(
      r.hostCommand.startsWith('/'),
      `${app}: hostCommand must be absolute, got: ${r.hostCommand}`
    );
    assert.ok(
      existsSync(r.hostCommand),
      `${app}: hostCommand must exist on the host: ${r.hostCommand}`
    );
  }
  // Vacuous pass on hosts with no agent CLI (same skip philosophy as above:
  // plain CI runners have neither binary); the per-app tests above cover
  // hosts that do.
  assert.ok(checked >= 0);
});

test('resolveApp hostCommand is null when the app is genuinely missing', { skip: isInstalled('claude') }, () => {
  assert.equal(resolveApp('claude').hostCommand, null);
});

// installedApps() must agree with resolveApp on every app id -- host- and
// install-state-independent (it is a pure mirror of the per-app resolution).
test('installedApps mirrors resolveApp found flags for all supported apps', () => {
  const installed = installedApps();
  assert.deepEqual(Object.keys(installed).sort(), ['claude', 'codex', 'commandcode', 'copilot', 'opencode']);
  for (const app of ['claude', 'opencode', 'copilot', 'codex', 'commandcode']) {
    assert.equal(installed[app], resolveApp(app).found, `${app} flag must match resolveApp`);
  }
});

// opencodeSupportsStandalone gates appLaunch.js's --standalone flag (see its
// comment): an opencode <2.0.0 CLI is a strict yargs parser that rejects an
// unrecognized --standalone outright (usage + exit 1, no launch at all) --
// verified by hand against a cached 1.18.29 binary. These tests use small
// fixture scripts instead of the host's real opencode install (which may be
// absent, e.g. on CI, and whose version shifts over time) so the parsing and
// caching logic itself is exercised deterministically everywhere.
function fixtureBin(versionOutput) {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-opencode-fixture-'));
  const path = join(dir, 'opencode-fixture');
  writeFileSync(path, `#!/bin/sh\necho '${versionOutput}'\n`);
  chmodSync(path, 0o755);
  return { dir, path };
}

test('opencodeSupportsStandalone: true for 2.x version output ("opencode v2.0.12" style)', () => {
  const { dir, path } = fixtureBin('opencode v2.0.12');
  try {
    assert.equal(opencodeSupportsStandalone(path), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opencodeSupportsStandalone: false for 1.x version output (bare "1.18.29" style, no --standalone support)', () => {
  const { dir, path } = fixtureBin('1.18.29');
  try {
    assert.equal(opencodeSupportsStandalone(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opencodeSupportsStandalone: false for a missing binary and for unparseable --version output', () => {
  assert.equal(opencodeSupportsStandalone('/no/such/opencode-xyz'), false);
  assert.equal(opencodeSupportsStandalone(null), false);
  const { dir, path } = fixtureBin('not a version at all');
  try {
    assert.equal(opencodeSupportsStandalone(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Cache correctness: results are memoized by resolved path + mtime (see the
// sandbox.js comment -- --version is too slow, ~0.2-1s observed, to pay on
// every session launch) but an in-place upgrade (pacman/npm overwriting the
// same path, e.g. 1.x -> 2.x) changes mtime and must be picked up without a
// ccserver restart.
test('opencodeSupportsStandalone: an in-place binary upgrade (same path, new mtime) invalidates the cache', () => {
  const { dir, path } = fixtureBin('1.18.29');
  try {
    assert.equal(opencodeSupportsStandalone(path), false, 'first read: old version, unsupported');
    writeFileSync(path, `#!/bin/sh\necho 'opencode v2.0.12'\n`);
    chmodSync(path, 0o755);
    // Force a distinct mtime -- some filesystems have coarse timestamp
    // resolution, and the write above could otherwise land in the same tick.
    const bumped = new Date(Date.now() + 5000);
    utimesSync(path, bumped, bumped);
    assert.equal(opencodeSupportsStandalone(path), true, 'mtime changed: must re-probe and pick up the new version');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
