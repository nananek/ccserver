// buildSandboxSpawn -> buildBwrapArgs (Linux): the operator-configured
// `binds` list must never re-expose ~/.ssh or ~/.config/gh, even when a stale
// config predates the git broker and even when a `..` in the path collapses
// onto one of them. The Seatbelt equivalent is covered by
// sandbox-seatbelt.test.js ("skips blocked extra binds like bwrap does");
// this pins the bwrap side, which had no test.
//
// buildSandboxSpawn's macOS branch needs a real sandbox_apply, so these run on
// Linux CI only; on macOS they skip.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxSpawn } from './sandbox.js';

const HOME = homedir();
const SKIP = process.platform === 'darwin' ? { skip: 'buildSandboxSpawn needs bwrap; macOS path needs a real sandbox_apply' } : {};

let cfgPath;
let tmpRoot;
let prevConfig;
let prevHomeRoot;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-blocked-binds-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({
    docker: false,
    gitBroker: false,
    persistentHome: false,
    // Off so buildSandboxSpawn is deterministic across calls: an enabled
    // guard mints a fresh `ccserver-commit-guard-<uuid>` runtime dir per
    // call, which would make the null-vs-claude deepEqual below spuriously
    // fail on the guard-config bind path.
    commitMessageGuard: { enabled: false },
    binds: [
      { src: '~/.ssh', mode: 'ro' },
      { src: '~/.config/gh', mode: 'ro' },
      { src: '~/.config/../.ssh/id_ed25519', mode: 'ro' },
      { src: `${HOME}/.ssh/../.ssh`, mode: 'rw' },
      { src: '/srv/ccserver-ok', mode: 'rw' },
    ],
  }));
  prevConfig = process.env.CCSERVER_SANDBOX_CONFIG;
  prevHomeRoot = process.env.CCSERVER_SANDBOX_HOME_ROOT;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
});

after(() => {
  if (prevConfig === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
  else process.env.CCSERVER_SANDBOX_CONFIG = prevConfig;
  if (prevHomeRoot === undefined) delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  else process.env.CCSERVER_SANDBOX_HOME_ROOT = prevHomeRoot;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Any bwrap bind flag whose SOURCE arg is `p` or lives under `p/`.
function bindsUnder(args, p) {
  const flags = new Set(['--bind', '--bind-try', '--ro-bind', '--ro-bind-try', '--dev-bind', '--dev-bind-try']);
  const hits = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (flags.has(args[i]) && (args[i + 1] === p || String(args[i + 1]).startsWith(`${p}/`))) hits.push(args[i + 1]);
  }
  return hits;
}

test('~/.ssh and ~/.config/gh are never bound, including via a `..` that collapses onto them', SKIP, async () => {
  const spawn = await buildSandboxSpawn({ cwd: tmpRoot, targetCommand: ['claude'], app: 'claude', sandboxOpts: null });
  assert.deepEqual(bindsUnder(spawn.args, join(HOME, '.ssh')), [], 'no bind under ~/.ssh (raw key path via `..` must be caught too)');
  assert.deepEqual(bindsUnder(spawn.args, join(HOME, '.config', 'gh')), [], 'no bind under ~/.config/gh');
});

test('a legitimate configured bind still goes through', SKIP, async () => {
  const spawn = await buildSandboxSpawn({ cwd: tmpRoot, targetCommand: ['claude'], app: 'claude', sandboxOpts: null });
  const ok = bindsUnder(spawn.args, '/srv/ccserver-ok');
  assert.ok(ok.includes('/srv/ccserver-ok'), 'the non-blocked bind is present');
});

test('buildSandboxSpawn tolerates a missing/null app (normalizes to claude)', SKIP, async () => {
  // buildSandboxSpawn does `app = app || 'claude'` up front so the later
  // `app === 'claude'` checks (incl. the macOS Keychain seed gate) never see a
  // raw null. On Linux the observable proof is that it does not throw and
  // still assembles a claude launch.
  const withNull = await buildSandboxSpawn({ cwd: tmpRoot, targetCommand: ['claude'], app: null, sandboxOpts: null });
  const explicit = await buildSandboxSpawn({ cwd: tmpRoot, targetCommand: ['claude'], app: 'claude', sandboxOpts: null });
  assert.equal(withNull.command, explicit.command);
  assert.deepEqual(withNull.args, explicit.args, 'null app produces the same launch as app:"claude"');
});
