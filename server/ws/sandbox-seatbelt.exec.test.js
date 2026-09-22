// macOS Seatbelt backend (sandbox-exec): REAL execution tests.
//
// Unlike sandbox-seatbelt.test.js (pure profile-string assembly, runs on Linux
// CI too), every test here spawns the real `/usr/bin/sandbox-exec -f <profile>
// /usr/bin/env ... <cmd>` and is therefore darwin-only. On any other platform
// -- or when sandbox-exec is missing -- all exec cases skip (the single
// cwd=/ fail-closed case at the bottom runs everywhere, it never spawns).
//
// Isolated via CCSERVER_SANDBOX_SEATBELT_TMP pointing at a fresh dir under
// os.tmpdir() (production-like: inside the broad tmp allow trees, so the
// sibling deny pins are genuinely exercised). Failing profiles are copied to
// a separate tmp root (RUNNER_TEMP on CI) preserved in after(). Each case
// builds its own project cwd (+ fake HOME where needed) so parallel CI runs
// never share state.
//
// Debugging failures on CI: the failure messages include the profile path,
// exit status/signal, stdout and stderr. Failing profiles are copied to
// <tmpRoot>/failures/ and the temp root is preserved (see after()), and the
// workflow uploads it as an artifact, so the exact SBPL text is available
// post-run.
//
// NOTE: nested sandbox-exec is not permitted by Seatbelt: when this file runs
// from inside an already-sandboxed shell (e.g. a ccserver sandbox session --
// even `(allow default)` then fails with `sandbox_apply: Operation not
// permitted`), every exec case skips with an explanation instead of failing.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn as spawnFn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildSeatbeltLaunch, seatbeltEnvArgs } from './sandbox-seatbelt.js';
import { SANDBOX_PATH, buildSandboxSpawn } from './sandbox.js';
import * as gpgVaultRelay from './gpgVaultRelay.js';
import { createServer } from 'node:net';
import { startNetworkBroker } from './network-broker.js';

const HOME = homedir();
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const SHOULD_SKIP = process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC);
const SKIP_OPTS = SHOULD_SKIP
  ? { skip: 'requires macOS with /usr/bin/sandbox-exec' }
  : {};

let tmpRoot;
// Production-like seatbelt base (always under os.tmpdir(), i.e. inside the
// broad tmp allow trees -- exactly what the sibling deny pins must beat).
// Distinct from tmpRoot, which only holds failure profiles for upload.
let seatbeltBase;
let prevSeatbeltTmp;
// NOTE: DIRS/trackDir must be declared BEFORE before(): node:test runs root
// hooks during module evaluation, so anything the hook touches must already
// be initialized (TDZ otherwise).
const DIRS = [];
function trackDir(d) {
  DIRS.push(d);
  return d;
}
// Set in before() when even `(allow default)` cannot be applied (nested
// sandbox): every exec case then skips via checkRunnable(t).
let nestedReason = null;
// Set by the assert helpers on any failure: after() then preserves tmpRoot
// (with failing profiles under failures/) for the CI artifact upload.
let hadFailure = false;

function baselineApplies() {
  try {
    const probe = join(tmpRoot, 'baseline.sb');
    writeFileSync(probe, '(version 1)\n(allow default)\n');
    const res = spawnSync(SANDBOX_EXEC, ['-f', probe, '/bin/echo', 'ok'], { encoding: 'utf-8', timeout: 15000 });
    return res.status === 0 && (res.signal ?? null) === null;
  } catch {
    return false;
  }
}

before(() => {
  // tmpRoot holds failure profiles for the CI artifact upload: prefer
  // RUNNER_TEMP on GitHub Actions so the upload can scope to
  // ${{ runner.temp }}/ccserver-sbexec-test-* (a /var/folders/** glob walks
  // other users' dirs and EACCES-fails the upload step).
  tmpRoot = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'ccserver-sbexec-test-'));
  seatbeltBase = trackDir(mkdtempSync(join(tmpdir(), 'ccserver-sbexec-seatbeltbase-')));
  prevSeatbeltTmp = process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  process.env.CCSERVER_SANDBOX_SEATBELT_TMP = seatbeltBase;
  if (!SHOULD_SKIP && !baselineApplies()) {
    nestedReason = 'sandbox-exec cannot apply profiles in this shell (nested sandbox? sandbox_apply EPERM) -- skipping exec cases';
  }
});

after(() => {
  for (const d of DIRS) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (prevSeatbeltTmp === undefined) delete process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  else process.env.CCSERVER_SANDBOX_SEATBELT_TMP = prevSeatbeltTmp;
  if (hadFailure) {
    console.log(`[sbexec] failures preserved under ${tmpRoot} (failing profiles in failures/)`);
    return;
  }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function checkRunnable(t) {
  if (nestedReason) {
    t.skip(nestedReason);
    return false;
  }
  return true;
}

function baseOpts(over = {}) {
  const cwd = trackDir(mkdtempSync(join(tmpdir(), 'ccserver-sbexec-cwd-')));
  return {
    cwd,
    hostHome: HOME,
    homeDir: null,
    sandboxPathBase: SANDBOX_PATH,
    nodeBin: realpathSync(process.execPath),
    scripts: {
      ghWrapper: join(import.meta.dirname, 'sandbox-gh-wrapper.cjs'),
      credHelper: join(import.meta.dirname, 'sandbox-git-credential-helper.cjs'),
      sshWrapper: join(import.meta.dirname, 'sandbox-ssh-wrapper.cjs'),
      commitHook: join(import.meta.dirname, 'sandbox-commit-msg-hook.cjs'),
      entrypoint: join(import.meta.dirname, 'sandbox-entrypoint.sh'),
      mcpBridge: join(import.meta.dirname, 'sandbox-mcp-wrapper.cjs'),
    },
    ssh: { realSsh: null, configFile: '/nonexistent-ssh-config', knownHostsDefault: '/nonexistent-known-hosts', userKnownHosts: null },
    gitBroker: null,
    commitGuard: null,
    sockets: {},
    extraBinds: [],
    extraEnv: {},
    authSock: null,
    claudeDir: null,
    orchestratorClaudeMdSrc: null,
    gitCommonDir: null,
    groupFilesDir: null,
    tools: null,
    ...over,
  };
}

// Spawn argv inside the seatbelt profile. Mirrors sandbox.js's darwin branch:
// sandbox-exec -f <profile> /usr/bin/env K=V ... <cmd>. Array-form spawn, so
// values with spaces are passed literally (no shell).
function runInSeatbelt(sb, argv, { cwd = null, timeout = 15000 } = {}) {
  return spawnSync(
    SANDBOX_EXEC,
    ['-f', sb.profilePath, '/usr/bin/env', ...seatbeltEnvArgs(sb.env), ...argv],
    { cwd: cwd || sb.cwd || undefined, encoding: 'utf-8', timeout },
  );
}

function fmtResult(res) {
  return JSON.stringify({
    status: res.status,
    signal: res.signal ?? null,
    error: res.error ? String(res.error) : null,
    stdout: (res.stdout || '').slice(0, 2000),
    stderr: (res.stderr || '').slice(0, 2000),
  });
}

// Allow-path assertion: must exit 0 with no signal. An abort (exit 134 /
// SIGABRT -- the "startup kill" shape from
// docs/seatbelt-root-read-abort-diagnosis.md) fails here with the profile path
// attached so CI artifacts can be correlated.
function preserveProfile(sb, label) {
  hadFailure = true;
  try {
    const dir = join(tmpRoot, 'failures');
    mkdirSync(dir, { recursive: true });
    copyFileSync(sb.profilePath, join(dir, `${String(label).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 80)}.sb`));
  } catch { /* best effort */ }
}

function assertAllowed(res, sb, label) {
  try {
    assert.equal(res.error ?? null, null, `${label}: spawn error: ${res.error} [profile ${sb.profilePath}]`);
    assert.equal(res.signal ?? null, null, `${label}: killed by signal (abort shape?) ${fmtResult(res)} [profile ${sb.profilePath}]`);
    assert.equal(res.status, 0, `${label}: expected exit 0, got ${fmtResult(res)} [profile ${sb.profilePath}]`);
  } catch (err) {
    preserveProfile(sb, label);
    throw err;
  }
}

// Deny-path assertion: anything but a clean exit 0. Covers EPERM exits (1),
// exec denies (71) and aborts (134) -- all are "not allowed".
function assertDenied(res, sb, label) {
  try {
    if (res.error && String(res.error).includes('ETIMEDOUT')) {
      assert.fail(`${label}: timed out (neither allowed nor denied?) ${fmtResult(res)} [profile ${sb.profilePath}]`);
    }
    const denied = (res.signal ?? null) !== null || res.status !== 0;
    assert.ok(denied, `${label}: expected non-zero exit/signal, got ${fmtResult(res)} [profile ${sb.profilePath}]`);
  } catch (err) {
    preserveProfile(sb, label);
    throw err;
  }
}

test('smoke: profile compiles and /bin/echo runs', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const res = runInSeatbelt(sb, ['/bin/echo', 'hello-seatbelt'], { cwd: opts.cwd });
  assertAllowed(res, sb, 'echo');
  assert.match(res.stdout.trim(), /^hello-seatbelt$/);
});

test('smoke via entrypoint: bash + entrypoint + echo', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  // Closest shape to the real launch (sandbox.js darwin branch) short of a
  // pty: MACOS_BASH ENTRYPOINT <cmd>. Exercises the entrypoint's
  // XDG_RUNTIME_DIR mkdir -p plus the entrypoint's own read allow.
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const res = runInSeatbelt(
    sb,
    ['/bin/bash', opts.scripts?.entrypoint ?? join(import.meta.dirname, 'sandbox-entrypoint.sh'), '/bin/echo', 'via-entrypoint'],
    { cwd: opts.cwd },
  );
  assertAllowed(res, sb, 'entrypoint echo');
  assert.ok(res.stdout.includes('via-entrypoint'), `unexpected output: ${fmtResult(res)}`);
});

test('smoke: a fully-loaded profile (broker + guard + gnupg + overlay + sock denies) compiles and runs', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  // The baseOpts() smoke tests only compile the minimal profile -- a syntax
  // error in a clause emitted only under a rare combination would slip through
  // to a real launch ("compile error fails closed for every launch"). Turn on
  // everything at once and run a real sandbox-exec.
  const brokerDir = trackDir(mkdtempSync(join(tmpdir(), 'ccserver-sbexec-full-broker-')));
  const sockDir = trackDir(mkdtempSync(join(tmpdir(), 'ccserver-sbexec-full-socks-')));
  const homeDir = trackDir(mkdtempSync(join(tmpdir(), 'ccserver-sbexec-full-home-')));
  const orch = join(sockDir, 'CLAUDE.md');
  writeFileSync(orch, '# orchestrator overlay\n');
  const opts = baseOpts({
    homeDir,
    gitBroker: { sockPath: join(brokerDir, 'b.sock'), allowlistPath: join(brokerDir, 'a.json'), dir: brokerDir, token: 'tok-abc' },
    commitGuard: { configPath: join(brokerDir, 'guard.json') },
    gnupg: true,
    authSock: join(sockDir, 'agent.sock'),
    orchestratorClaudeMdSrc: orch,
    ghPaths: ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'],
    controlSockDenies: [join(sockDir, 'ccserver-control.sock'), join(sockDir, 'meta', 'meta.sock')],
    sockets: { mcp: join(sockDir, 'mcp.sock'), notify: join(sockDir, 'notify.sock') },
    extraBinds: [{ src: '/srv/shared', mode: 'rw' }, { src: '~/.ssh', mode: 'ro' }],
  });
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  for (const c of sb.ruleCopies || []) trackDir(c);
  sb.cwd = opts.cwd;
  const res = runInSeatbelt(sb, ['/bin/echo', 'full-profile-ok'], { cwd: opts.cwd });
  assertAllowed(res, sb, 'full-profile echo');
  assert.match(res.stdout.trim(), /^full-profile-ok$/);
});

test('root literal: /bin/ls / starts (no startup abort)', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  // Regression for docs/seatbelt-root-read-abort-diagnosis.md: without
  // `(allow file-read* (literal "/"))` every child dies at startup (abort).
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const res = runInSeatbelt(sb, ['/bin/ls', '/'], { cwd: opts.cwd });
  assertAllowed(res, sb, 'ls /');
});

test('project file is readable', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const opts = baseOpts();
  const probe = join(opts.cwd, 'hello.txt');
  writeFileSync(probe, 'seatbelt-read-ok\n');
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const res = runInSeatbelt(sb, ['/bin/cat', probe], { cwd: opts.cwd });
  assertAllowed(res, sb, 'cat project file');
  assert.ok(res.stdout.includes('seatbelt-read-ok'), `unexpected output: ${fmtResult(res)}`);
});

test('node realpathSync works (ancestor lstat regression)', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  // Without ancestorExactRegexes, userspace realpath dies with EPERM lstat
  // '/Volumes' / '/Users' / '/private' (verified on hardware).
  const opts = baseOpts();
  writeFileSync(join(opts.cwd, 'package.json'), '{"name":"x"}\n');
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const res = runInSeatbelt(
    sb,
    [sb.nodeBin, '-e', "const fs=require('fs');console.log(fs.realpathSync('package.json'))"],
    { cwd: opts.cwd },
  );
  assertAllowed(res, sb, 'node realpathSync');
  assert.ok(res.stdout.includes('package.json'), `unexpected output: ${fmtResult(res)}`);
});

test('a node shim script loads from the server tree (module-loader realpath)', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  // The gh / credential-helper / ssh / commit-hook / MCP shims are
  // `#!/bin/sh exec <node> <serverdir>/server/ws/*.cjs`. node's loader
  // realpathSync's the entry script -> lstat-walks <serverdir> + parents,
  // which the exact `.cjs` read pins do NOT cover. Regression: every such
  // shim died `EPERM lstat '<serverdir>'` unless the server sat under
  // /opt|/usr/local. Run the real gh wrapper's --help-ish path: it must at
  // least LOAD (a broker-unreachable error is fine; an EPERM/MODULE_NOT_FOUND
  // crash is the bug).
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const res = runInSeatbelt(
    sb,
    [sb.nodeBin, '-e', `require('fs').realpathSync(${JSON.stringify(opts.scripts.ghWrapper)}); console.log('loaded-ok')`],
    { cwd: opts.cwd },
  );
  assertAllowed(res, sb, 'load shim script');
  assert.ok(res.stdout.includes('loaded-ok'), `shim script not loadable: ${fmtResult(res)}`);
});

test('ancestor dirs are metadata-only: real $HOME resolves but does not readdir (#3)', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  // A throwaway-HOME launch (like a /usage capture) still allow-lists the real
  // ~/.claude etc., which forces an ancestor rule for the real $HOME. That rule
  // is file-read-METADATA only: lstat/realpath through it must work, but
  // `ls ~` (readdir) must be refused -- otherwise the capture can enumerate the
  // host home's top-level entries.
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const lstatOk = runInSeatbelt(sb, [sb.nodeBin, '-e', `console.log(require('fs').lstatSync(${JSON.stringify(HOME)}).isDirectory())`], { cwd: opts.cwd });
  assertAllowed(lstatOk, sb, 'lstat real $HOME');
  assert.ok(lstatOk.stdout.includes('true'), `lstat of $HOME failed: ${fmtResult(lstatOk)}`);
  const readdir = runInSeatbelt(sb, [sb.nodeBin, '-e', `try{require('fs').readdirSync(${JSON.stringify(HOME)});console.log('LISTED')}catch(e){console.log('DENIED '+e.code)}`], { cwd: opts.cwd });
  assert.ok(readdir.stdout.includes('DENIED'), `real $HOME must not be listable: ${fmtResult(readdir)}`);
});

test('node binary dir is not readable as a tree (#4)', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  // bwrap ro-binds just the node FILE; the seatbelt profile must not read-allow
  // its whole directory (a shared bin dir would expose every unrelated tool).
  // The binary itself must still exec (covered by the realpath test above).
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const dir = dirname(sb.nodeBin);
  const res = runInSeatbelt(sb, [sb.nodeBin, '-e', `try{const l=require('fs').readdirSync(${JSON.stringify(dir)});console.log('LISTED '+l.length)}catch(e){console.log('DENIED '+e.code)}`], { cwd: opts.cwd });
  assert.ok(res.stdout.includes('DENIED'), `node bin dir must not be listable: ${fmtResult(res)}`);
});

test('project dir is writable', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const target = join(opts.cwd, 'from-sandbox.txt');
  const res = runInSeatbelt(sb, ['/bin/sh', '-c', 'echo written-by-sandbox > "$1"', 'sh', target], { cwd: opts.cwd });
  assertAllowed(res, sb, 'write project file');
  assert.equal(readFileSync(target, 'utf-8'), 'written-by-sandbox\n');
});

test('throwaway HOME and /tmp are writable', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  assert.ok(sb.homeDir.startsWith(`${sb.dir}/`), 'throwaway HOME expected for this case');
  for (const target of [join(sb.homeDir, 'home-write.txt'), join(tmpdir(), `ccserver-sbexec-tmp-${Date.now()}.txt`)]) {
    const res = runInSeatbelt(sb, ['/bin/sh', '-c', 'echo ok > "$1"', 'sh', target], { cwd: opts.cwd });
    try {
      assertAllowed(res, sb, `write ${target}`);
      assert.ok(existsSync(target), `${target} was not created`);
    } finally {
      try { rmSync(target, { force: true }); } catch { /* ignore */ }
    }
  }
});

test('raw keys stay denied: ~/.ssh and ~/.config/gh unreadable', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  // Fake HOME so the test never touches the runner's real keys -- placed
  // directly under the real $HOME like production, NEVER under os.tmpdir():
  // tmpdir sits inside the profile's broad tmp read allows, which would make
  // these secrets readable and the test vacuous. A real $HOME is outside
  // every allow tree, so reads are default-denied and writes pin-denied.
  const fakeHome = trackDir(mkdtempSync(join(HOME, 'ccserver-sbexec-fakehome-')));
  mkdirSync(join(fakeHome, '.ssh'), { recursive: true });
  writeFileSync(join(fakeHome, '.ssh', 'secret.txt'), 'top-secret\n');
  mkdirSync(join(fakeHome, '.config', 'gh'), { recursive: true });
  writeFileSync(join(fakeHome, '.config', 'gh', 'hosts.yml'), 'github.com: {token: x}\n');
  const opts = baseOpts({ hostHome: fakeHome });
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  for (const f of [join(fakeHome, '.ssh', 'secret.txt'), join(fakeHome, '.config', 'gh', 'hosts.yml')]) {
    const res = runInSeatbelt(sb, ['/bin/cat', f], { cwd: opts.cwd });
    assertDenied(res, sb, `cat ${f}`);
    const wres = runInSeatbelt(sb, ['/bin/sh', '-c', 'echo pwned > "$1"', 'sh', f], { cwd: opts.cwd });
    assertDenied(wres, sb, `write ${f}`);
  }
  assert.equal(readFileSync(join(fakeHome, '.ssh', 'secret.txt'), 'utf-8'), 'top-secret\n', 'secret must be unchanged');
});

test('claude credentials: keychain stays unreachable, plaintext fallback stays readable', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  // The macOS login Keychain is not allow-listed, so Claude Code cannot use it
  // inside the sandbox -- it must fall back to <CLAUDE_CONFIG_DIR>/.credentials.json,
  // which buildSeatbeltLaunch points at the host ~/.claude (allow-listed rw).
  // Fake HOME directly under the real $HOME (see the raw-keys test for why not
  // tmpdir): ~/.claude is only reachable because appConfigDirs allow-lists it,
  // not because it sits in a broad tmp allow.
  const fakeHome = trackDir(mkdtempSync(join(HOME, 'ccserver-sbexec-credhome-')));
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  const credsPath = join(fakeHome, '.claude', '.credentials.json');
  writeFileSync(credsPath, '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-fake"}}\n', { mode: 0o600 });
  const opts = baseOpts({ hostHome: fakeHome });
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;

  assert.equal(sb.env.CLAUDE_CONFIG_DIR, join(fakeHome, '.claude'));

  // Fallback file is readable inside the sandbox.
  const readRes = runInSeatbelt(sb, ['/bin/cat', credsPath], { cwd: opts.cwd });
  assertAllowed(readRes, sb, `cat ${credsPath}`);
  assert.ok(String(readRes.stdout).includes('sk-ant-oat01-fake'), 'credentials file contents readable');

  // The login Keychain is dead: `security` finds no default keychain / no item.
  // (Non-zero exit, not a crash -- Claude's store treats this as "fall back to
  // the file".) This pins the behavior the fallback design depends on.
  const kcRes = runInSeatbelt(
    sb,
    ['/usr/bin/security', 'find-generic-password', '-s', 'Claude Code-credentials'],
    { cwd: opts.cwd },
  );
  assert.notEqual(kcRes.status, 0, `security must not succeed in the sandbox ${fmtResult(kcRes)}`);
});

test('KERN_PROCARGS2 (other processes argv/env): denied inside, or a documented limitation', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  // Same-UID KERN_PROCARGS2 leaks a process's full command line AND environment
  // (CCSERVER_TOKEN, API keys, other sessions' tokens). Compile a tiny probe,
  // confirm it CAN read outside the sandbox (else the test is vacuous), then
  // check the same read inside: assert it is refused, or -- on a macOS where
  // the numeric-MIB path is unmediated (14+, see below) -- skip with the
  // limitation noted rather than fail.
  const probeSrc = join(tmpRoot, 'procargs2-probe.c');
  const probeBin = join(tmpRoot, 'procargs2-probe');
  // The probe dumps the buffer so we can assert a same-UID secret does not
  // leak, not just that a size was returned.
  writeFileSync(probeSrc, [
    '#include <sys/sysctl.h>',
    '#include <stdio.h>',
    '#include <stdlib.h>',
    '#include <unistd.h>',
    'int main(int argc, char **argv){',
    '  int pid = argc > 1 ? atoi(argv[1]) : 1;',
    '  int mib[3] = { CTL_KERN, KERN_PROCARGS2, pid };',
    '  size_t sz = 0;',
    '  if (sysctl(mib, 3, NULL, &sz, NULL, 0) != 0) { printf("DENIED\\n"); return 3; }',
    '  char *buf = calloc(1, sz + 1);',
    '  if (sysctl(mib, 3, buf, &sz, NULL, 0) != 0) { printf("DENIED\\n"); return 3; }',
    '  printf("READABLE %zu\\n", sz);',
    '  fwrite(buf, 1, sz, stdout);',
    '  return 0;',
    '}',
  ].join('\n'));
  try {
    execFileSync('cc', ['-O0', '-o', probeBin, probeSrc], { stdio: 'ignore', timeout: 30000 });
  } catch {
    t.skip('no working cc to build the KERN_PROCARGS2 probe');
    return;
  }

  // A dedicated same-UID sibling that OUTLIVES the sandboxed read and carries a
  // marker in its env -- exactly the cross-session leak shape (a peer session /
  // the ccserver server holding CCSERVER_TOKEN). Use `node` (not `sh -c`): a
  // shell can exec into a state where KERN_PROCARGS2 does not expose the prefix
  // env var, making the outside sanity check below flaky; a node process
  // reliably carries its full environ (this is exactly the real target shape --
  // the ccserver server and every agent session are node).
  const MARKER = `CCSERVER_SECRET_${Math.random().toString(36).slice(2)}`;
  const sleeper = spawnFn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    env: { ...process.env, [MARKER]: 'do-not-leak' }, stdio: 'ignore', detached: true,
  });
  try {
    const target = String(sleeper.pid);
    const outside = spawnSync(probeBin, [target], { encoding: 'utf-8', timeout: 10000 });
    if (!String(outside.stdout).startsWith('READABLE')) {
      t.skip(`KERN_PROCARGS2 not readable even outside a sandbox here (${fmtResult(outside)}) -- test would be vacuous`);
      return;
    }
    assert.ok(String(outside.stdout).includes(MARKER), 'sanity: the marker IS readable outside the sandbox');

    const opts = baseOpts();
    const sb = buildSeatbeltLaunch(opts);
    trackDir(sb.dir);
    sb.cwd = opts.cwd;
    const inside = runInSeatbelt(sb, [probeBin, target], { cwd: opts.cwd });
    const deniedInside = String(inside.stdout).includes('DENIED') || (inside.status ?? 0) !== 0;
    if (!deniedInside) {
      // KNOWN LIMITATION (verified on macOS 14.8.5 arm64, and the macos-latest
      // CI runner): the numeric-MIB {CTL_KERN, KERN_PROCARGS2, pid} read is
      // NOT a Seatbelt-mediated operation -- (deny default) for sysctl-read
      // and every (deny sysctl-read|sysctl*|system-info|process-info*) rule
      // tried have zero effect on it. A sandboxed agent can read a same-UID
      // process's argv+env. bwrap's --unshare-pid closes this; Seatbelt
      // cannot. See sandbox-seatbelt.js's sysctl block and docs-site
      // sandbox/overview.md "Known limitations". This test stays so that a
      // future macOS that DOES mediate the path flips it straight back to an
      // assertion.
      const leaked = String(inside.stdout).includes(MARKER);
      t.skip(`KERN_PROCARGS2 numeric-MIB read is unmediated by Seatbelt on this macOS -- known limitation (peer env marker ${leaked ? 'LEAKED' : 'not seen'} in the read)`);
      return;
    }
    try {
      assert.ok(!String(inside.stdout).startsWith('READABLE'), 'sandbox must not read another process argv/env');
      assert.ok(!String(inside.stdout).includes(MARKER), 'the peer process env marker must not leak into the sandbox');
    } catch (err) {
      preserveProfile(sb, 'kern_procargs2_denied');
      throw err;
    }
  } finally {
    try { process.kill(sleeper.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('H1 (PR #178 review): network-broker admin token is absent from the broker\'s own env, even under the KERN_PROCARGS2 limitation', SKIP_OPTS, async (t) => {
  if (!checkRunnable(t)) return;
  // Same probe as the sibling test above, but pointed at a REAL network
  // broker child (network-broker.js --serve) instead of a synthetic sleeper.
  // The H1 fix (see network-broker.js's runServer/startNetworkBroker
  // comments) never puts CCSANDBOX_NETWORK_BROKER_ADMIN_TOKEN in this
  // process's own env at all -- it arrives over a private pipe at startup
  // instead -- so this must hold even where the sibling test finds the
  // general same-UID KERN_PROCARGS2 path unmediated (the deny/skip branch
  // there does not excuse a leak of this specific secret).
  const probeSrc = join(tmpRoot, 'procargs2-probe-nb.c');
  const probeBin = join(tmpRoot, 'procargs2-probe-nb');
  writeFileSync(probeSrc, [
    '#include <sys/sysctl.h>',
    '#include <stdio.h>',
    '#include <stdlib.h>',
    '#include <unistd.h>',
    'int main(int argc, char **argv){',
    '  int pid = argc > 1 ? atoi(argv[1]) : 1;',
    '  int mib[3] = { CTL_KERN, KERN_PROCARGS2, pid };',
    '  size_t sz = 0;',
    '  if (sysctl(mib, 3, NULL, &sz, NULL, 0) != 0) { printf("DENIED\\n"); return 3; }',
    '  char *buf = calloc(1, sz + 1);',
    '  if (sysctl(mib, 3, buf, &sz, NULL, 0) != 0) { printf("DENIED\\n"); return 3; }',
    '  printf("READABLE %zu\\n", sz);',
    '  fwrite(buf, 1, sz, stdout);',
    '  return 0;',
    '}',
  ].join('\n'));
  try {
    execFileSync('cc', ['-O0', '-o', probeBin, probeSrc], { stdio: 'ignore', timeout: 30000 });
  } catch {
    t.skip('no working cc to build the KERN_PROCARGS2 probe');
    return;
  }

  let broker;
  try {
    broker = await startNetworkBroker({ allowedHosts: [] });
  } catch (e) {
    t.skip(`could not start a real network broker to probe (${e.message})`);
    return;
  }
  try {
    const target = String(broker.proc.pid);
    const outside = spawnSync(probeBin, [target], { encoding: 'utf-8', timeout: 10000 });
    if (!String(outside.stdout).startsWith('READABLE')) {
      t.skip(`KERN_PROCARGS2 not readable even outside a sandbox here (${fmtResult(outside)}) -- test would be vacuous`);
      return;
    }
    // Sanity: the proxy token IS deliberately in the broker's env (it has to
    // be -- buildIsolatedProxyEnv reads it back out for the sandbox's own
    // HTTP_PROXY), so it must show up outside the sandbox. This confirms the
    // probe/target are wired correctly before trusting the admin-token
    // assertions below.
    assert.ok(String(outside.stdout).includes(broker.token), 'sanity: proxy token readable outside the sandbox (expected -- it IS in env)');
    assert.ok(!String(outside.stdout).includes(broker.adminToken), 'admin token must not be in the broker env even outside the sandbox');

    const opts = baseOpts();
    const sb = buildSeatbeltLaunch(opts);
    trackDir(sb.dir);
    sb.cwd = opts.cwd;
    const inside = runInSeatbelt(sb, [probeBin, target], { cwd: opts.cwd });
    // Whether or not this macOS mediates KERN_PROCARGS2 (see the sibling
    // test's documented limitation), the admin token specifically must never
    // appear here: it was never written to the broker's env to begin with.
    assert.ok(!String(inside.stdout).includes(broker.adminToken), `admin token must not leak via KERN_PROCARGS2 even under the known same-UID limitation: ${fmtResult(inside)}`);
  } finally {
    try { broker.proc.kill('SIGKILL'); } catch { /* already dead */ }
    try { rmSync(broker.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('toolchain sysctls stay readable inside the sandbox (allow-list not too tight)', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  // The sysctl-read allow-list replaced the broad `(allow sysctl-read)`; make
  // sure the nodes node/libuv/V8/git actually read still resolve in-sandbox.
  const src = join(tmpRoot, 'sysctl-needs-probe.c');
  const bin = join(tmpRoot, 'sysctl-needs-probe');
  writeFileSync(src, [
    '#include <sys/sysctl.h>',
    '#include <stdio.h>',
    'int main(void){',
    '  const char *need[] = { "hw.ncpu", "hw.logicalcpu", "hw.memsize", "hw.pagesize",',
    '    "hw.machine", "hw.cachelinesize", "machdep.cpu.brand_string", "kern.osrelease",',
    '    "kern.osversion", "kern.version", "kern.hostname", "kern.boottime",',
    '    "kern.maxfilesperproc", "kern.argmax", "vm.loadavg" };',
    // hw.ephemeral_storage / kern.osvariant_status DO fall under the broad
    // hw. / kern.os prefixes but are re-denied by name -- they must NOT read.
    '  const char *blocked[] = { "hw.ephemeral_storage", "kern.osvariant_status" };',
    '  int bad = 0;',
    '  for (unsigned i = 0; i < sizeof(need)/sizeof(*need); i++) {',
    '    size_t sz = 0;',
    '    if (sysctlbyname(need[i], NULL, &sz, NULL, 0) != 0) { printf("FAIL %s\\n", need[i]); bad = 1; }',
    '  }',
    '  for (unsigned i = 0; i < sizeof(blocked)/sizeof(*blocked); i++) {',
    '    size_t sz = 0;',
    '    if (sysctlbyname(blocked[i], NULL, &sz, NULL, 0) == 0) { printf("LEAK %s\\n", blocked[i]); bad = 1; }',
    '  }',
    '  if (!bad) printf("ALL_OK\\n");',
    '  return bad;',
    '}',
  ].join('\n'));
  try {
    execFileSync('cc', ['-O0', '-o', bin, src], { stdio: 'ignore', timeout: 30000 });
  } catch {
    t.skip('no working cc to build the sysctl-needs probe');
    return;
  }
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const res = runInSeatbelt(sb, [bin], { cwd: opts.cwd });
  try {
    assertAllowed(res, sb, 'toolchain sysctls');
    assert.ok(String(res.stdout).includes('ALL_OK'), `a toolchain sysctl was denied or a sensitive one leaked: ${fmtResult(res)}`);
  } catch (err) {
    preserveProfile(sb, 'toolchain_sysctls');
    throw err;
  }
});

test('CFFIXED_USER_HOME redirects the macOS-API cache dir into the sandbox HOME', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  // CoreFoundation resolves ~/Library from getpwuid (not $HOME), so Xcode /
  // SwiftPM / `defaults` etc. would hit the REAL ~/Library/Caches. Compile a
  // tiny Foundation probe, run it inside the profile, and assert the cache dir
  // now resolves under the sandbox HOME -- and that the host cache is denied.
  const probeSrc = join(tmpRoot, 'cffixed-probe.m');
  const probeBin = join(tmpRoot, 'cffixed-probe');
  writeFileSync(probeSrc, [
    '#import <Foundation/Foundation.h>',
    'int main(void){ @autoreleasepool {',
    '  NSArray *c = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES);',
    '  printf("HOME=%s\\n", NSHomeDirectory().UTF8String);',
    '  printf("CACHES=%s\\n", [c.firstObject UTF8String]);',
    '  return 0;',
    '} }',
  ].join('\n'));
  try {
    execFileSync('cc', ['-x', 'objective-c', '-O0', '-framework', 'Foundation', '-o', probeBin, probeSrc],
      { stdio: 'ignore', timeout: 30000 });
  } catch {
    t.skip('no working cc / Foundation to build the CFFIXED_USER_HOME probe');
    return;
  }
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;

  const res = runInSeatbelt(sb, [probeBin], { cwd: opts.cwd });
  assertAllowed(res, sb, 'CFFIXED probe');
  const out = String(res.stdout);
  assert.ok(out.includes(`HOME=${sb.homeDir}`), `NSHomeDirectory should be the sandbox HOME, got ${fmtResult(res)}`);
  assert.ok(out.includes(`CACHES=${join(sb.homeDir, 'Library', 'Caches')}`),
    `caches dir should resolve under the sandbox HOME, got ${fmtResult(res)}`);
  assert.ok(!out.includes(`HOME=${HOME}\n`), 'must not resolve the real host HOME');

  // The host cache stays unreachable (no allow-list entry).
  const hostCacheProbe = join(HOME, 'Library', 'Caches', 'ccserver-sbexec-should-not-exist');
  const wres = runInSeatbelt(sb, ['/bin/sh', '-c', 'echo x > "$1"', 'sh', hostCacheProbe], { cwd: opts.cwd });
  assertDenied(wres, sb, `write ${hostCacheProbe}`);
});

test('sibling launch dirs denied, own runtime dir allowed', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  // Sibling under the same base dir: covered by the broad tmp allows, so only
  // the sibling deny pin keeps it closed (POSIX ERE has no lookahead: deny all
  // launch dirs, re-allow our own afterwards).
  const base = process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  const sibling = trackDir(mkdtempSync(join(base, 'ccserver-sb-sibling-')));
  const siblingFile = join(sibling, 'secret.txt');
  writeFileSync(siblingFile, 'sibling-secret\n');
  const denied = runInSeatbelt(sb, ['/bin/cat', siblingFile], { cwd: opts.cwd });
  assertDenied(denied, sb, 'sibling read');
  // Contrast: our own runtime file stays readable/writable.
  const ownFile = join(sb.dir, 'runtime', 'own.txt');
  writeFileSync(ownFile, 'own\n');
  const allowed = runInSeatbelt(sb, ['/bin/cat', ownFile], { cwd: opts.cwd });
  assertAllowed(allowed, sb, 'own runtime read');
});

test('bin/hooks/profile are immutable despite TMPDIR write rules', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const before = readFileSync(sb.profilePath, 'utf-8');
  for (const target of [join(sb.binDir, 'gh'), sb.profilePath]) {
    const res = runInSeatbelt(sb, ['/bin/sh', '-c', 'echo pwned > "$1"', 'sh', target], { cwd: opts.cwd });
    assertDenied(res, sb, `write ${target}`);
  }
  const hookTargets = (() => {
    try {
      return readdirSync(sb.hooksDir).map((n) => join(sb.hooksDir, n));
    } catch {
      return [];
    }
  })();
  for (const target of hookTargets) {
    const res = runInSeatbelt(sb, ['/bin/sh', '-c', 'echo pwned > "$1"', 'sh', target], { cwd: opts.cwd });
    assertDenied(res, sb, `write ${target}`);
  }
  assert.equal(readFileSync(sb.profilePath, 'utf-8'), before, 'profile must be unchanged');
});

test('sandbox HOME gitconfig pinned while the broker is on', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const homeDir = trackDir(mkdtempSync(join(tmpdir(), 'ccserver-sbexec-home-')));
  const brokerDir = trackDir(mkdtempSync(join(tmpdir(), 'ccserver-sbexec-broker-')));
  writeFileSync(join(brokerDir, 'allow.json'), '{}');
  const gitBroker = { sockPath: join(brokerDir, 'broker.sock'), allowlistPath: join(brokerDir, 'allow.json'), dir: brokerDir };
  const sb = buildSeatbeltLaunch(baseOpts({ homeDir, gitBroker }));
  trackDir(sb.dir);
  sb.cwd = sb.cwd || homeDir;
  const target = join(homeDir, '.gitconfig');
  const res = runInSeatbelt(sb, ['/bin/sh', '-c', 'echo pwned > "$1"', 'sh', target], { cwd: homeDir });
  assertDenied(res, sb, 'write HOME .gitconfig with broker');
});

test('sandbox HOME gitconfig writable without a broker (git config --global keeps working)', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const homeDir = trackDir(mkdtempSync(join(tmpdir(), 'ccserver-sbexec-home-')));
  const opts = baseOpts({ homeDir, gitBroker: null });
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const target = join(homeDir, '.gitconfig');
  const res = runInSeatbelt(sb, ['/bin/sh', '-c', 'echo ok > "$1"', 'sh', target], { cwd: opts.cwd });
  assertAllowed(res, sb, 'write HOME .gitconfig without broker');
  assert.ok(existsSync(target), '.gitconfig was not created');
});

test('macOS GUI/IPC exec pins are denied', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const candidates = [
    ['/usr/bin/osascript', ['-e', 'return 1']],
    ['/usr/bin/pbcopy', []],
    ['/usr/bin/pbpaste', []],
    ['/usr/bin/open', ['-h']],
    ['/usr/sbin/screencapture', ['-h']],
  ].filter(([bin]) => existsSync(bin));
  assert.ok(candidates.length > 0, 'expected at least one GUI/IPC binary on macOS');
  for (const [bin, args] of candidates) {
    const res = runInSeatbelt(sb, [bin, ...args], { cwd: opts.cwd });
    assertDenied(res, sb, `exec ${bin}`);
  }
});

test('env arrives via /usr/bin/env (HOME/PATH/CCSANDBOX_DOCKER)', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const res = runInSeatbelt(sb, ['/usr/bin/env'], { cwd: opts.cwd });
  assertAllowed(res, sb, 'env');
  const lines = new Set(res.stdout.split('\n'));
  assert.ok(lines.has(`HOME=${sb.homeDir}`), `HOME missing: ${fmtResult(res)}`);
  assert.ok(lines.has('CCSANDBOX_DOCKER=0'), `CCSANDBOX_DOCKER missing: ${fmtResult(res)}`);
  const pathLine = res.stdout.split('\n').find((l) => l.startsWith('PATH='));
  assert.ok(pathLine && pathLine.slice('PATH='.length).split(':')[0] === sb.binDir, `shim dir not first on PATH: ${fmtResult(res)}`);
});

// Security audit F3: the GPG vault relay listens at FIXED paths under the
// host runtime dir. A launch WITHOUT gpgVault must not be able to connect()
// to them (connect() is network-outbound under Seatbelt, so only the explicit
// unix-socket deny pin stops it); a gpgVault launch must still connect. A
// real listener is bound at the relay's agent path and a node one-liner
// inside the sandbox attempts the connect. connect() completes at the kernel
// level via the listen backlog, so the parent's blocked event loop
// (spawnSync) does not matter.
test('F3: relay sockets are unreachable without gpgVault and reachable with it', SKIP_OPTS, async (t) => {
  if (!checkRunnable(t)) return;
  const prevXdg = process.env.XDG_RUNTIME_DIR;
  // Short base: sockaddr_un.sun_path is 104 bytes on macOS.
  const runtimeDir = trackDir(mkdtempSync('/tmp/ccsbrl-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  const server = createServer((c) => c.destroy());
  try {
    const relayDir = gpgVaultRelay.getRelayDir();
    mkdirSync(relayDir, { recursive: true, mode: 0o700 });
    const agentSock = gpgVaultRelay.getRelaySocketPaths().agent;
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(agentSock, resolveListen);
    });
    const probe = [
      realpathSync(process.execPath), '-e',
      `require('net').connect(${JSON.stringify(agentSock)})`
      + `.on('connect',()=>{console.log('CONNECTED');process.exit(0)})`
      + `.on('error',(e)=>{console.log('ERR '+e.code);process.exit(3)})`,
    ];

    const noVault = buildSeatbeltLaunch(baseOpts());
    trackDir(noVault.dir);
    const denied = runInSeatbelt(noVault, probe);
    assertDenied(denied, noVault, 'non-gpgVault connect to the vault relay');
    assert.doesNotMatch(denied.stdout || '', /CONNECTED/);

    const withVault = buildSeatbeltLaunch(baseOpts({
      gpgVault: { homeDir: relayDir, sockets: {}, fingerprint: 'FAKEFPR', nameReal: 'ccserver test', nameEmail: 't@example.invalid' },
    }));
    trackDir(withVault.dir);
    const allowed = runInSeatbelt(withVault, probe);
    assertAllowed(allowed, withVault, 'gpgVault connect to the vault relay');
    assert.match(allowed.stdout, /CONNECTED/);
  } finally {
    server.close();
    if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = prevXdg;
  }
});

test('cwd=/ is refused fail-closed (no sandbox-exec spawn)', async () => {
  // Platform-independent: buildSandboxSpawn rejects the filesystem root
  // before any backend branch (subtrees('/') would grant everything).
  await assert.rejects(
    () => buildSandboxSpawn({ cwd: '/', targetCommand: ['/bin/echo', 'hi'] }),
    /filesystem root/,
  );
});
