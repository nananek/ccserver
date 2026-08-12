import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveApp, installedApps, SANDBOX_PATH } from './sandbox.js';

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

// installedApps() must agree with resolveApp on every app id -- host- and
// install-state-independent (it is a pure mirror of the per-app resolution).
test('installedApps mirrors resolveApp found flags for all three apps', () => {
  const installed = installedApps();
  assert.deepEqual(Object.keys(installed).sort(), ['claude', 'copilot', 'opencode']);
  for (const app of ['claude', 'opencode', 'copilot']) {
    assert.equal(installed[app], resolveApp(app).found, `${app} flag must match resolveApp`);
  }
});
