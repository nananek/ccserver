// macOS Seatbelt backend (sandbox-exec): profile generation, per-launch shim
// layout, and env assembly. All pure assembly -- no sandbox-exec/pty runs --
// and platform-independent, so this runs on Linux CI too (buildSeatbeltLaunch
// itself never checks process.platform; only buildSandboxSpawn branches on
// it). The one exception is the final Linux-only backend-text test, which
// carries an explicit skip guard (it would fail on macOS by design).
//
// Isolated via CCSERVER_SANDBOX_SEATBELT_TMP: every launch dir lands under a
// temp root removed in after().

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AGENT_CONFIG_REL_PATHS,
  agentConfigDirs,
  ancestorExactRegexes,
  buildSeatbeltLaunch,
  buildSeatbeltProfileText,
  escapeSeatbeltLiteral,
  escapeSeatbeltRegex,
  isBlockedCredentialBind,
  pathVariants,
  pathVariantsDeep,
  releaseSeatbeltOverlay,
  seatbeltEnvArgs,
  seatbeltIsolatedNetworkRules,
  SEATBELT_ISOLATED_BROKER_HOST,
  seedClaudeCredentialsFromHostKeychain,
  keychainAccount,
  _resetKeychainProbeForTest,
  subtreeRegex,
  subtrees,
} from './sandbox-seatbelt.js';
import { forceSandboxUnavailableReason, sandboxBackend, sandboxUnavailableReason, seatbeltControlSockPaths } from './sandbox.js';
import { META_SOCKET_DIR_NAME, hostRuntimeDir } from './git-broker.js';
import * as gpgVaultRelay from './gpgVaultRelay.js';
import { getMetaSockPath } from './metaAgent.js';

const HOME = homedir();

let tmpRoot;
let prevSeatbeltTmp;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-test-'));
  prevSeatbeltTmp = process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  process.env.CCSERVER_SANDBOX_SEATBELT_TMP = join(tmpRoot, 'seatbelt');
});

after(() => {
  if (prevSeatbeltTmp === undefined) delete process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  else process.env.CCSERVER_SANDBOX_SEATBELT_TMP = prevSeatbeltTmp;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

const DIRS = [];
function trackDir(d) {
  DIRS.push(d);
  return d;
}
after(() => {
  for (const d of DIRS) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function baseOpts(over = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-cwd-'));
  DIRS.push(cwd);
  return {
    cwd,
    hostHome: HOME,
    homeDir: null,
    sandboxPathBase: `${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    nodeBin: process.execPath,
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

test('escapeSeatbeltRegex quotes regex metacharacters but keeps slashes', () => {
  assert.equal(escapeSeatbeltRegex('/Users/oli/a+b (x)/y.md'), '/Users/oli/a\\+b \\(x\\)/y\\.md');
});

test('escapeSeatbeltLiteral escapes only SBPL string metacharacters', () => {
  assert.equal(escapeSeatbeltLiteral('/tmp/a"b\\c'), '/tmp/a\\"b\\\\c');
  assert.equal(escapeSeatbeltLiteral('/tmp/plain.sock'), '/tmp/plain.sock');
});

test('buildSeatbeltProfileText escapes literals pasted into the profile', () => {
  const text = buildSeatbeltProfileText({ readLiterals: ['/tmp/we"ird.sock'] });
  assert.ok(text.includes('(literal "/tmp/we\\"ird.sock")'));
});

test('subtreeRegex matches the dir itself and everything below', () => {
  assert.equal(subtreeRegex('/srv/proj'), '^/srv/proj(/.*)?$');
});

test('buildSeatbeltProfileText is deny-by-default with open egress', () => {
  const text = buildSeatbeltProfileText({
    readRegexes: ['^/usr(/.*)?$'],
    writeRegexes: ['^/srv/proj(/.*)?$'],
    denyWriteRegexes: ['^/home/u/.ssh(/.*)?$'],
  });
  assert.ok(text.includes('(version 1)'));
  assert.ok(text.includes('(deny default)'));
  assert.ok(text.includes('(allow network*)'));
  assert.ok(text.includes('(allow process-exec process-fork)'));
  assert.ok(text.includes('(allow file-read* (regex #"^/usr(/.*)?$")'));
  assert.ok(text.includes('(allow file-write* (regex #"^/srv/proj(/.*)?$")'));
  assert.ok(text.includes('(deny file-write* (regex #"^/home/u/.ssh(/.*)?$")'));
});

test('buildSeatbeltProfileText with networkIsolate replaces open egress with broker-only rules', () => {
  const text = buildSeatbeltProfileText({
    readRegexes: ['^/usr(/.*)?$'],
    writeRegexes: ['^/srv/proj(/.*)?$'],
    denyNetOutboundLiterals: ['/tmp/ccserver-runtime-501/ccserver-control.sock'],
    networkIsolate: { brokerPort: 54321 },
  });
  assert.ok(!text.includes('(allow network*)'), 'no broad allow: it would silently win back open egress');
  assert.ok(text.includes('(deny network-outbound (remote tcp))'), 'IP/TCP denied by default');
  assert.ok(text.includes('(deny network-outbound (remote udp))'), 'UDP (incl. DNS) denied by default');
  assert.ok(
    text.includes('(allow network-outbound (remote tcp "localhost:54321"))'),
    'the per-launch broker port is re-allowed (last-match-wins)',
  );
  assert.ok(text.includes('(allow network-outbound (remote unix-socket))'), 'unix IPC stays allowed');
  assert.ok(
    text.includes('(deny network-outbound (remote unix-socket (path-literal "/tmp/ccserver-runtime-501/ccserver-control.sock")))'),
    'control-plane unix pins survive',
  );
  // Ordering: broad denies -> broker re-allow -> unix pins last.
  const denyTcpAt = text.indexOf('(deny network-outbound (remote tcp))');
  const brokerAt = text.indexOf('(remote tcp "localhost:54321")');
  const pinAt = text.indexOf('path-literal "/tmp/ccserver-runtime-501/ccserver-control.sock"');
  assert.ok(denyTcpAt >= 0 && brokerAt > denyTcpAt, 'broker re-allow comes after the broad deny');
  assert.ok(pinAt > brokerAt, 'control-plane unix pins stay last');
  // Every emitted rule line must be paren-balanced (an unbalanced SBPL rule
  // fails the whole profile compile -- fail-closed for every launch).
  for (const l of text.split('\n')) {
    if (!l.trim() || l.trim().startsWith(';;')) continue;
    assert.equal((l.match(/\(/g) || []).length, (l.match(/\)/g) || []).length, `balanced rule line: ${l}`);
  }
});

test('seatbeltIsolatedNetworkRules pins the concrete broker port', () => {
  const rules = seatbeltIsolatedNetworkRules(1234);
  assert.ok(rules.some((r) => r.includes('localhost:1234')), 'concrete port embedded');
  assert.ok(!rules.some((r) => r.includes('(allow network*)')), 'never the broad allow');
});

test('buildSeatbeltLaunch with networkBroker injects proxy env (loopback broker)', () => {
  const sb = buildSeatbeltLaunch(baseOpts({ networkBroker: { port: 54321, token: 'tok123' } }));
  trackDir(sb.dir);
  const expected = `http://networkbroker:tok123@${SEATBELT_ISOLATED_BROKER_HOST}:54321`;
  assert.equal(sb.env.HTTP_PROXY, expected);
  assert.equal(sb.env.HTTPS_PROXY, expected);
  assert.equal(sb.env.http_proxy, expected);
  assert.equal(sb.env.https_proxy, expected);
  const profile = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(!profile.includes('(allow network*)'), 'isolated launch profile has no open egress');
  assert.ok(profile.includes('(remote tcp "localhost:54321")'), 'isolated launch profile pins the broker port');
});

test('buildSeatbeltLaunch without networkBroker keeps open egress and sets no proxy env', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  assert.equal(sb.env.HTTP_PROXY, undefined);
  const profile = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(profile.includes('(allow network*)'), 'historical open egress preserved');
});

test('profile allows reading the root directory itself (macOS startup requirement)', () => {
  // macOS path resolution reads "/" as a directory during process startup:
  // with only subtree regexes (^/usr/... etc.) allowed, every child dies at
  // startup and sandbox-exec surfaces it as an abort (exit 134) -- while the
  // UI reports code 0. See docs/seatbelt-root-read-abort-diagnosis.md. The
  // literal grants only the root directory entry, not any tree below it.
  const text = buildSeatbeltProfileText({ readRegexes: ['^/usr(/.*)?$'] });
  assert.ok(text.includes('(allow file-read* (literal "/"))'), 'the literal root read must survive profile assembly');
});

test('buildSeatbeltLaunch creates profile+bin+hooks and a throwaway HOME', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  assert.ok(existsSync(sb.profilePath), 'profile file exists');
  assert.ok(existsSync(sb.binDir), 'shim bin dir exists');
  assert.ok(existsSync(sb.hooksDir), 'hooks dir exists');
  assert.ok(sb.homeDir.startsWith(`${sb.dir}/`), 'throwaway HOME lives inside the teardown dir');
  assert.equal(sb.env.HOME, sb.homeDir);
  assert.equal(sb.env.CCSANDBOX_DOCKER, '0');
  assert.ok(sb.env.PATH.startsWith(`${sb.binDir}:`), 'shim dir is first on PATH');

  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(subtreeRegex(sb.homeDir)), 'HOME is writable');
  assert.ok(text.includes(subtreeRegex(join(HOME, '.ssh'))), 'raw ssh keys are denied');
  assert.ok(text.includes(subtreeRegex(join(HOME, '.config', 'gh'))), 'gh config is denied');
  // opencode state dirs stay writable so launches don't error (see plan notes).
  assert.ok(text.includes(subtreeRegex(join(HOME, '.local', 'share', 'opencode'))));
  assert.ok(text.includes(subtreeRegex(join(HOME, '.codex'))));
});

test('agent config dirs are readable as well as writable (file-write* does not imply file-read*)', () => {
  // Seatbelt file-write* does not imply file-read*: a write-only entry would
  // leave CLIs unable to read back the auth/state they just wrote.
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  const readLine = text.split('\n').find((l) => l.startsWith('  (allow file-read*'));
  assert.ok(readLine, 'profile has a file-read rule');
  for (const p of [
    join(HOME, '.claude'), join(HOME, '.config', 'opencode'),
    join(HOME, '.local', 'state', 'opencode'), join(HOME, '.codex'),
    join(HOME, '.commandcode'),
  ]) {
    assert.ok(readLine.includes(subtreeRegex(p)), `${p} is readable`);
  }
});

test('host ~/Library/Caches is NOT shared; CFFIXED_USER_HOME redirects the macOS-API cache dir', () => {
  // CoreFoundation resolves ~/Library from getpwuid, not $HOME, so without
  // CFFIXED_USER_HOME the host cache would have to be allow-listed and shared.
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  assert.equal(sb.env.CFFIXED_USER_HOME, sb.homeDir, 'CFFIXED_USER_HOME points at the sandbox HOME');
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(!text.includes(subtreeRegex(join(HOME, 'Library', 'Caches'))), 'host ~/Library/Caches must not be allow-listed');
  // the macOS-API cache dir now resolves under the (writable) sandbox HOME
  assert.ok(text.includes(subtreeRegex(sb.homeDir)), 'sandbox HOME is writable, so <HOME>/Library/Caches is too');
});

test('buildSeatbeltLaunch honors an explicit persistent homeDir', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-home-'));
  DIRS.push(homeDir);
  const sb = buildSeatbeltLaunch(baseOpts({ homeDir }));
  trackDir(sb.dir);
  assert.equal(sb.homeDir, homeDir);
  assert.equal(sb.env.HOME, homeDir);
  // CFFIXED_USER_HOME must track the persistent HOME too, not just the
  // throwaway one -- otherwise Foundation-API tools write into the real
  // ~/Library on a persistent-HOME session.
  assert.equal(sb.env.CFFIXED_USER_HOME, homeDir);
});

test('opencode sessions resolve host auth/state via XDG; other apps keep the sandbox HOME', () => {
  // opencode honors XDG base dirs, so point them at the host trees (whose
  // profile allows already exist unconditionally): login, model memory and
  // --continue then carry over from the host, like bwrap's appBinds.
  const fakeHome = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-hosthome-'));
  DIRS.push(fakeHome);
  for (const d of ['.config/opencode', '.local/share/opencode', '.local/state/opencode']) {
    mkdirSync(join(fakeHome, d), { recursive: true });
  }
  const sb = buildSeatbeltLaunch({ ...baseOpts(), hostHome: fakeHome, app: 'opencode' });
  trackDir(sb.dir);
  assert.equal(sb.env.XDG_CONFIG_HOME, join(fakeHome, '.config'));
  assert.equal(sb.env.XDG_DATA_HOME, join(fakeHome, '.local', 'share'));
  assert.equal(sb.env.XDG_STATE_HOME, join(fakeHome, '.local', 'state'));

  const claude = buildSeatbeltLaunch({ ...baseOpts(), hostHome: fakeHome, app: 'claude' });
  trackDir(claude.dir);
  assert.equal(claude.env.XDG_CONFIG_HOME, undefined, 'non-opencode sessions must not redirect XDG');
  assert.equal(claude.env.XDG_DATA_HOME, undefined);
  assert.equal(claude.env.XDG_STATE_HOME, undefined);
});

test('opencode XDG redirect is per-dir gated (absent host dirs stay sandbox-local)', () => {
  // A host that never ran opencode must not get host dirs materialized from
  // inside the sandbox: only existing opencode dirs are redirected.
  const fakeHome = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-hosthome-'));
  DIRS.push(fakeHome);
  mkdirSync(join(fakeHome, '.local', 'share', 'opencode'), { recursive: true });
  const sb = buildSeatbeltLaunch({ ...baseOpts(), hostHome: fakeHome, app: 'opencode' });
  trackDir(sb.dir);
  assert.equal(sb.env.XDG_DATA_HOME, join(fakeHome, '.local', 'share'));
  assert.equal(sb.env.XDG_CONFIG_HOME, undefined);
  assert.equal(sb.env.XDG_STATE_HOME, undefined);
});

test('ancestor dirs get exact-match (not subtree) read allows', () => {
  // Userspace realpath/lstat walks every ancestor component: subtree rules
  // don't cover the ancestors themselves, so node/vite/npm die with EPERM
  // without these (verified on macOS: EPERM lstat '/Volumes', '/Users',
  // '/private'). Exact match only -- siblings' contents stay closed.
  assert.deepEqual(
    ancestorExactRegexes(['/no/such/base/dir']),
    ['^/no/such/base$', '^/no/such$', '^/no$'],
  );
  const sb = buildSeatbeltLaunch(baseOpts({ cwd: '/no/such/proj' }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes('(regex #"^/no/such$")'), 'ancestor exact-match present');
  assert.ok(text.includes('(regex #"^/no$")'));
  assert.ok(!text.includes('^/no(/.*)?$'), 'ancestors must not be subtrees (siblings stay closed)');
});

test('hostHome ancestors get lstat allows even for a throwaway HOME with node outside $HOME', () => {
  // CLAUDE_CONFIG_DIR / CODEX_HOME / the opencode XDG dirs live under hostHome.
  // A throwaway-HOME launch (homeDir:null) whose node lives outside $HOME must
  // still be able to lstat the hostHome ancestors, or Claude EPERMs the moment
  // it reads ~/.claude/.credentials.json. hostHome deliberately points outside
  // every other allow tree (project/tmp/node) so only the new push covers it.
  const fakeHome = '/Users/ccserver-anchome-fixture'; // synthetic, need not exist
  const nodeBin = '/opt/homebrew/bin/node'; // deliberately not under fakeHome
  const sb = buildSeatbeltLaunch(baseOpts({ hostHome: fakeHome, homeDir: null, nodeBin }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  for (const anc of ancestorExactRegexes([fakeHome, join(fakeHome, '.claude'), join(fakeHome, '.config', 'opencode')])) {
    assert.ok(text.includes(`(regex #"${anc}")`), `missing ancestor lstat allow: ${anc}`);
  }
  // ...still exact-match only (never a subtree that would open siblings).
  assert.ok(!text.includes(subtreeRegex('/Users')), '/Users must not become a subtree');
});

test('host git XDG dir stays denied (XDG redirect cannot leak host gitconfig)', () => {  // XDG_CONFIG_HOME now points at the host tree for opencode sessions, so
  // lock in that sandboxed git can never read the host XDG gitconfig: the
  // profile must not allow-list host ~/.config/git, keeping the sandbox
  // gitconfig + broker pins authoritative.
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(!text.includes(subtreeRegex(join(HOME, '.config', 'git'))), 'host ~/.config/git must stay denied');
});

test('buildSeatbeltLaunch wires gitBroker shims and merges GIT_CONFIG_COUNT', () => {
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-broker-'));
  DIRS.push(brokerDir);
  const knownHostsDefault = join(brokerDir, 'known-hosts-default');
  writeFileSync(knownHostsDefault, 'example.com ssh-ed25519 AAAA\n');
  const sb = buildSeatbeltLaunch(baseOpts({
    gitBroker: { sockPath: join(brokerDir, 'broker.sock'), allowlistPath: join(brokerDir, 'allow.json'), dir: brokerDir },
    commitGuard: { configPath: join(brokerDir, 'guard.json') },
    ssh: { realSsh: '/usr/bin/ssh', configFile: '/nonexistent-ssh-config', knownHostsDefault, userKnownHosts: null },
    sockets: { notify: join(brokerDir, 'notify.sock') },
  }));
  trackDir(sb.dir);
  for (const name of ['gh', 'ssh', 'ccserver-git-ssh', 'ccserver-git-credential-helper']) {
    const p = join(sb.binDir, name);
    assert.ok(existsSync(p), `${name} shim exists`);
    assert.ok(statSync(p).mode & 0o111, `${name} shim is executable`);
    assert.ok(readFileSync(p, 'utf-8').includes(process.execPath), `${name} shim execs the host node`);
  }
  // The per-launch ssh config points UserKnownHostsFile at host paths (the
  // shared sandbox-ssh-config pins bwrap's fixed in-sandbox paths, which no
  // mount provides here), and CCSANDBOX_SSH_CONFIG follows it. The
  // server-tree known_hosts is copied into the launch dir because
  // UserKnownHostsFile has no quoting (a spaced install dir would split it).
  const sshConfig = join(sb.dir, 'ssh-config');
  assert.ok(existsSync(sshConfig), 'per-launch ssh config exists');
  const knownHostsCopy = join(sb.dir, 'known-hosts');
  assert.ok(existsSync(knownHostsCopy), 'known_hosts copied into the launch dir');
  assert.equal(readFileSync(knownHostsCopy, 'utf-8'), 'example.com ssh-ed25519 AAAA\n');
  const sshConfigText = readFileSync(sshConfig, 'utf-8');
  assert.ok(sshConfigText.includes(`UserKnownHostsFile ${knownHostsCopy}`), 'known_hosts uses the launch-dir copy');
  assert.ok(sshConfigText.includes('StrictHostKeyChecking yes'));
  assert.ok(!sshConfigText.includes('/ccserver-sandbox-known-hosts'), 'no bwrap fixed paths');
  assert.equal(sb.env.CCSANDBOX_SSH_CONFIG, sshConfig);
  const hook = join(sb.hooksDir, 'commit-msg');
  assert.ok(existsSync(hook), 'commit-msg hook shim exists');
  assert.equal(sb.env.GIT_CONFIG_COUNT, '4');
  // KEY_0 is an empty-string credential.helper: it clears any helper the
  // agent left in .gitconfig / .config/git/config / repo .git/config before
  // KEY_2 re-establishes the broker shim (git multi-valued keys APPEND via
  // GIT_CONFIG_KEY_*, so without this reset a persistent-HOME `store` helper
  // would still fire and exfiltrate the broker token).
  assert.equal(sb.env.GIT_CONFIG_KEY_0, 'credential.helper');
  assert.equal(sb.env.GIT_CONFIG_VALUE_0, '');
  assert.equal(sb.env.GIT_CONFIG_KEY_1, 'credential.useHttpPath');
  assert.equal(sb.env.GIT_CONFIG_VALUE_1, 'true');
  assert.equal(sb.env.GIT_CONFIG_KEY_2, 'credential.helper');
  // credential.helper is backslash-escaped as a bare word (a leading `"` is
  // parsed by git as a helper NAME, never executed). No metacharacters in
  // binDir here, so the value is the plain path. GIT_SSH_COMMAND above stays
  // sh-quoted: that one IS a shell command string.
  assert.equal(sb.env.GIT_CONFIG_VALUE_2, join(sb.binDir, 'ccserver-git-credential-helper'));
  assert.equal(sb.env.GIT_CONFIG_KEY_3, 'core.hooksPath');
  assert.equal(sb.env.GIT_CONFIG_VALUE_3, sb.hooksDir);
  assert.equal(sb.env.GIT_SSH_COMMAND, `"${join(sb.binDir, 'ccserver-git-ssh')}"`);
  assert.equal(sb.env.CCSANDBOX_MCP_SOCK, undefined);
  assert.ok(sb.env.PATH.includes(sb.binDir));

  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(`(literal "${join(brokerDir, 'broker.sock')}")`), 'broker socket is reachable');
  assert.ok(text.includes(`(literal "${join(brokerDir, 'notify.sock')}")`), 'notify socket is reachable');
  assert.ok(text.includes(`(literal "${sshConfig}")`), 'ssh config is readable');
});

test('buildSeatbeltLaunch sets CCSANDBOX_MCP_SOCK for group sessions', () => {
  const sb = buildSeatbeltLaunch(baseOpts({ sockets: { mcp: '/tmp/ccserver-mcp.sock' } }));
  trackDir(sb.dir);
  assert.equal(sb.env.CCSANDBOX_MCP_SOCK, '/tmp/ccserver-mcp.sock');
});

test('buildSeatbeltLaunch denies CLAUDE.md/AGENTS.md writes for orchestrators', () => {
  const opts = baseOpts();
  const src = join(tmpRoot, 'orchestrator.md');
  writeFileSync(src, '# rules\n');
  const sb = buildSeatbeltLaunch(baseOpts({
    cwd: opts.cwd,
    orchestratorClaudeMdSrc: src,
  }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(`^${escapeSeatbeltRegex(join(opts.cwd, 'CLAUDE.md'))}$`));
  assert.ok(text.includes(`^${escapeSeatbeltRegex(join(opts.cwd, 'AGENTS.md'))}$`));
});

test('buildSeatbeltLaunch allows gitCommonDir rw and groupFilesDir ro', () => {
  const sb = buildSeatbeltLaunch(baseOpts({
    gitCommonDir: '/srv/common-git',
    groupFilesDir: '/srv/group-files',
  }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(subtreeRegex('/srv/common-git')), 'git common dir is allowed');
  assert.ok(text.includes(subtreeRegex('/srv/group-files')), 'group files dir is readable');
  // group files stay read-only (bwrap ro-binds them): no write rule.
  const writeLine = text.split('\n').find((l) => l.startsWith('  (allow file-write*'));
  assert.ok(!writeLine.includes(subtreeRegex('/srv/group-files')), 'group files dir is not writable');
  // ...while the git common dir needs writes (index lock, refs).
  assert.ok(writeLine.includes(subtreeRegex('/srv/common-git')), 'git common dir is writable');
  // The host blob dir is exposed for future tooling via env.
  assert.equal(sb.env.CCSANDBOX_GROUP_FILES_DIR, '/srv/group-files');
});

test('buildSeatbeltLaunch materializes the orchestrator overlay and tracks it for teardown', () => {
  const srcDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-orchsrc-'));
  DIRS.push(srcDir);
  const src = join(srcDir, 'rules.md');
  writeFileSync(src, '# rules\n');
  const cwd = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-orchcwd-'));
  DIRS.push(cwd);
  const sb = buildSeatbeltLaunch(baseOpts({ cwd, orchestratorClaudeMdSrc: src }));
  trackDir(sb.dir);
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    assert.equal(readFileSync(join(cwd, name), 'utf-8'), '# rules\n', `${name} materialized`);
  }
  assert.deepEqual(sb.ruleCopies, [join(cwd, 'CLAUDE.md'), join(cwd, 'AGENTS.md')]);
  assert.deepEqual(sb.overlayFiles, sb.ruleCopies, 'owned files are registered too');
});

test('buildSeatbeltLaunch does not claim ownership of a live overlay', () => {
  // Same deterministic orchestratorDir, predecessor still live: its overlay
  // files pre-exist. The new launch refreshes them but must not list them
  // for teardown -- otherwise its own teardown (or a failed build) would
  // delete the live session's overlay out from under it.
  const srcDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-orchsrc-'));
  DIRS.push(srcDir);
  const src = join(srcDir, 'rules.md');
  writeFileSync(src, '# refreshed rules\n');
  const cwd = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-orchcwd-'));
  DIRS.push(cwd);
  writeFileSync(join(cwd, 'CLAUDE.md'), '# live rules\n');
  writeFileSync(join(cwd, 'AGENTS.md'), '# live rules\n');
  const sb = buildSeatbeltLaunch(baseOpts({ cwd, orchestratorClaudeMdSrc: src }));
  trackDir(sb.dir);
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    assert.equal(readFileSync(join(cwd, name), 'utf-8'), '# refreshed rules\n', `${name} refreshed`);
  }
  assert.equal(sb.ruleCopies, null, 'pre-existing files are not owned');
  assert.deepEqual(
    sb.overlayFiles,
    [join(cwd, 'CLAUDE.md'), join(cwd, 'AGENTS.md')],
    'pre-existing files are still registered so the teardown guard sees the successor',
  );
});

test('buildSeatbeltLaunch failure preserves a pre-existing overlay', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-orchcwd-'));
  DIRS.push(cwd);
  writeFileSync(join(cwd, 'CLAUDE.md'), '# live rules\n');
  assert.throws(
    () => buildSeatbeltLaunch(baseOpts({ cwd, orchestratorClaudeMdSrc: join(tmpRoot, 'absent.md') })),
    /cannot copy rules/,
  );
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf-8'), '# live rules\n', 'live overlay untouched');
  assert.ok(!existsSync(join(cwd, 'AGENTS.md')), 'no partial overlay left behind');
});

test('buildSeatbeltLaunch skips blocked extra binds like bwrap does', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-bindhome-'));
  DIRS.push(fakeHome);
  const sb = buildSeatbeltLaunch(baseOpts({
    hostHome: fakeHome,
    extraBinds: [
      { src: '~/.ssh', mode: 'ro' },
      // `..` traversal must not slip a raw-key path past the ~/.ssh check.
      { src: '~/.config/../.ssh/id_rsa', mode: 'ro' },
      { src: `${fakeHome}/.ssh/../.ssh`, mode: 'rw' },
      { src: '/srv/shared', mode: 'rw' },
    ],
  }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(subtreeRegex('/srv/shared')), 'legit extra bind is allowed');
  // ~/.ssh appears in the deny section by design; assert it is in NO allow line
  // and that the `..` path never produced a raw-key allow at all.
  const allowLines = text.split('\n').filter((l) => /^\s*\(allow file-(read|write)\*/.test(l)).join('\n');
  assert.ok(!allowLines.includes(subtreeRegex(join(fakeHome, '.ssh'))), '~/.ssh never allow-listed');
  assert.ok(!text.includes(escapeSeatbeltRegex(join(fakeHome, '.ssh', 'id_rsa'))), 'no raw key path via ..');
});

test('releaseSeatbeltOverlay: unlinks only files no peer still references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-overlay-'));
  DIRS.push(dir);
  const a = join(dir, 'CLAUDE.md');
  const b = join(dir, 'AGENTS.md');
  const c = join(dir, 'OTHER.md');
  for (const f of [a, b, c]) writeFileSync(f, 'x\n');
  // A peer still references `a`: only `b` goes.
  releaseSeatbeltOverlay([a, b], [[a], null, [join(dir, 'UNRELATED.md')]]);
  assert.ok(existsSync(a), 'peer-referenced file is kept');
  assert.ok(!existsSync(b), 'unreferenced file is unlinked');
  // Nothing references `a` anymore: it goes too. Non-arrays are ignored.
  releaseSeatbeltOverlay([a, c], [null, undefined, []]);
  assert.ok(!existsSync(a), 'last owner cleans up');
  assert.ok(!existsSync(c), 'unreferenced file is unlinked');
  // Non-array owned input is a no-op, never throws.
  releaseSeatbeltOverlay(null, [[a]]);
  releaseSeatbeltOverlay(undefined, null);
});

test('agentConfigDirs: single source of truth for both backends (#7)', () => {
  const dirs = agentConfigDirs('/home/u');
  assert.equal(dirs.length, 10, 'ten CLI config/state dirs');
  assert.ok(dirs.includes('/home/u/.claude'), 'claude config');
  assert.ok(dirs.includes(join('/home/u', '.local', 'state', 'opencode')), 'opencode state');
  assert.ok(dirs.includes(join('/home/u', '.config', 'github-copilot')), 'copilot config');
  assert.ok(dirs.includes(join('/home/u', '.commandcode')), 'commandcode auth');
  // Every entry resolves under the given home (join, never string concat).
  for (const d of dirs) assert.ok(d.startsWith('/home/u/') || d === '/home/u/.claude.json' || d.startsWith('/home/u/.claude'), `${d} is under the home`);
  assert.equal(new Set(dirs).size, dirs.length, 'no duplicates');
  assert.equal(AGENT_CONFIG_REL_PATHS.length, 10, 'relative list matches');
});

test('pathVariants/subtrees accept a per-launch memo cache (#8)', () => {
  const cache = new Map();
  const first = pathVariants('/tmp', cache);
  assert.ok(cache.size > 0, 'probe is cached');
  const second = pathVariants('/tmp', cache);
  assert.equal(second, first, 'same reference from cache');
  // Uncached calls keep the old behavior.
  assert.deepEqual(pathVariants('/definitely-absent-ccserver-test-path'), ['/definitely-absent-ccserver-test-path']);
  const st1 = subtrees('/tmp', cache);
  const st2 = subtrees('/tmp', cache);
  assert.equal(st2[0], st1[0], 'subtrees reuses the cached variants');
  const anc = ancestorExactRegexes(['/tmp/a', '/tmp/b'], cache);
  assert.ok(anc.includes('^/tmp$'), 'ancestors still emitted with a cache');
});

test('isBlockedCredentialBind: the shared filter matches ~/.ssh and ~/.config/gh trees only', () => {  const home = '/home/u';
  assert.equal(isBlockedCredentialBind('/home/u/.ssh', home), true, 'the dir itself');
  assert.equal(isBlockedCredentialBind('/home/u/.ssh/id_ed25519', home), true, 'a file under it');
  assert.equal(isBlockedCredentialBind('/home/u/.config/gh/hosts.yml', home), true, 'gh config');
  assert.equal(isBlockedCredentialBind('/home/u/.sshfoo', home), false, 'a sibling with a shared prefix is not blocked');
  assert.equal(isBlockedCredentialBind('/home/u/.config/github', home), false, 'a sibling of gh/ is not blocked');
  assert.equal(isBlockedCredentialBind('/srv/shared', home), false, 'an unrelated path');
  // The caller passes a resolve()'d src, so `..` is already collapsed by the
  // time this runs (join() collapses it here) -- a `~/.config/../.ssh` path
  // still lands on the blocked ~/.ssh tree.
  assert.equal(isBlockedCredentialBind(join(home, '.config', '..', '.ssh', 'id_rsa'), home), true);
});

test('buildSeatbeltLaunch refuses the filesystem root as cwd (shared-primitive fail-open guard)', () => {
  assert.throws(
    () => buildSeatbeltLaunch(baseOpts({ cwd: '/' })),
    /filesystem root/,
    'a projectDir of "/" would make subtrees("/") grant the whole filesystem',
  );
  // A spelling that resolves to the root is caught too.
  assert.throws(() => buildSeatbeltLaunch(baseOpts({ cwd: '/tmp/..' })), /filesystem root/);
});

test('profile allows pty ioctls and nested pty allocation', () => {
  // isatty()/tcgetattr() on the inherited pty are file-ioctl operations;
  // without these rules interactive CLIs cannot detect their TTY.
  const text = buildSeatbeltProfileText({});
  assert.ok(text.includes('(allow pseudo-tty)'));
  assert.ok(text.includes('(allow file-ioctl (regex #"^/dev(/.*)?$"))'));
});

test('sysctl-read is allow-listed (not broad); kern.proc* / procargs stay denied', () => {
  const text = buildSeatbeltProfileText({});
  // No broad `(allow sysctl-read)`: the narrow allow-list still refuses
  // sysctl-read leaks Seatbelt mediates (kern.bootargs etc.). It does NOT
  // block the numeric-MIB KERN_PROCARGS2 read -- that path is unmediated on
  // macOS 14+ (see the KNOWN LIMITATION in sandbox-seatbelt.js and the
  // exec test).
  assert.ok(!/\(allow sysctl-read\)/.test(text), 'no unfiltered (allow sysctl-read)');
  assert.ok(text.includes('(allow sysctl-read'), 'a filtered sysctl-read allow is present');
  // The toolchain essentials are allowed...
  for (const need of ['(sysctl-name-prefix "hw.")', '(sysctl-name-prefix "machdep.")',
    '(sysctl-name-prefix "kern.os")', '"sysctl.name2oid"', '"kern.version"']) {
    assert.ok(text.includes(need), `sysctl allow-list keeps ${need}`);
  }
  // ...but nothing opens kern.proc* (so `ps` is refused -- though `pgrep` /
  // proc_listpids() still enumerate, and KERN_PROCARGS2 still leaks: see the
  // KNOWN LIMITATION in sandbox-seatbelt.js).
  const allowLine = text.split('\n').find((l) => l.startsWith('(allow sysctl-read '));
  assert.ok(allowLine, 'the sysctl-read allow is a single line');
  assert.ok(!allowLine.includes('kern.proc'), 'kern.proc* / procargs are not in the sysctl allow list');
  assert.ok(!allowLine.includes('(sysctl-name-prefix "kern.")'), 'no bare kern. prefix (would re-open procargs)');
  // The broad hw. / kern.os prefixes are plain string-prefix matches, so they
  // pull in hw.ephemeral_storage and kern.osvariant_status (fingerprinting).
  // Those are re-denied by name AFTER the allow-list, together with the
  // procargs sysctlbyname spelling (last-match-wins).
  const denyLine = text.split('\n').find((l) => l.startsWith('(deny sysctl-read '));
  assert.ok(denyLine, 'a sysctl-read deny line exists after the allow-list');
  for (const name of ['hw.ephemeral_storage', 'kern.osvariant_status', 'kern.procargs', 'kern.procargs2']) {
    assert.ok(denyLine.includes(`(sysctl-name "${name}")`), `re-denies ${name} after the prefix allow`);
  }
  const allowIdx = text.indexOf('(allow sysctl-read');
  const denyIdx = text.indexOf(denyLine);
  assert.ok(denyIdx > allowIdx, 'the sysctl re-deny is emitted AFTER the allow (last-match-wins)');
  const readAllowIdx = text.indexOf('(allow file-read*');
  if (readAllowIdx !== -1) assert.ok(denyIdx < readAllowIdx, 'deny precedes the file allows');
});

test('pathVariants registers both raw and realpath spellings', () => {
  assert.deepEqual(pathVariants('/definitely-absent-path-xyz'), ['/definitely-absent-path-xyz']);
  assert.ok(subtrees(tmpRoot).length >= 1);
  assert.ok(subtrees(tmpRoot).every((r) => r.startsWith('^') && r.endsWith('(/.*)?$')));
});

test('gnupg opt-in exposes the keyring and sets GNUPGHOME', () => {
  const sb = buildSeatbeltLaunch(baseOpts({ gnupg: true }));
  trackDir(sb.dir);
  assert.equal(sb.env.GNUPGHOME, join(HOME, '.gnupg'));
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(subtreeRegex(join(HOME, '.gnupg'))));
});

test('gnupg off by default: no keyring rule, no GNUPGHOME', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  assert.equal(sb.env.GNUPGHOME, undefined);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(!text.includes(subtreeRegex(join(HOME, '.gnupg'))));
});

test('forwarded ssh-agent socket gets an explicit allow rule', () => {
  const sb = buildSeatbeltLaunch(baseOpts({ authSock: '/tmp/custom-agent.sock' }));
  trackDir(sb.dir);
  assert.equal(sb.env.SSH_AUTH_SOCK, '/tmp/custom-agent.sock');
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes('(literal "/tmp/custom-agent.sock")'));
});

test('gitBroker env carries credential.useHttpPath (bwrap parity)', () => {
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-httppath-'));
  DIRS.push(brokerDir);
  const sb = buildSeatbeltLaunch(baseOpts({
    gitBroker: { sockPath: join(brokerDir, 'b.sock'), allowlistPath: join(brokerDir, 'a.json'), dir: brokerDir },
  }));
  trackDir(sb.dir);
  const keys = Object.entries(sb.env)
    .filter(([k]) => k.startsWith('GIT_CONFIG_KEY_'))
    .map(([, v]) => v);
  const vals = Object.entries(sb.env)
    .filter(([k]) => k.startsWith('GIT_CONFIG_VALUE_'))
    .map(([, v]) => v);
  const pairs = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
  assert.equal(pairs['credential.useHttpPath'], 'true', 'broker matching needs the path');
  assert.ok(Object.values(pairs).some((v) => String(v).includes('credential-helper')));
});

test('sandbox HOME gitconfig is deny-pinned (no agent helper injection)', () => {
  // Pins apply while the broker is on (broker-issued tokens must not land in
  // an agent-written helper); without a broker both files stay writable.
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-broker-'));
  DIRS.push(brokerDir);
  const sb = buildSeatbeltLaunch(baseOpts({
    gitBroker: { sockPath: join(brokerDir, 'broker.sock'), allowlistPath: join(brokerDir, 'allow.json'), dir: brokerDir },
  }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(`^${escapeSeatbeltRegex(join(sb.homeDir, '.gitconfig'))}$`));
});

test('bin/hooks/profile are deny-pinned despite the TMPDIR write rules', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(subtreeRegex(join(sb.dir, 'bin'))), 'shim dir pinned');
  assert.ok(text.includes(subtreeRegex(join(sb.dir, 'hooks'))), 'hooks dir pinned');
});

test('agent CLIs resolve the real config via env (HOME is remapped)', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-realhome-'));
  DIRS.push(fakeHome);
  mkdirSync(join(fakeHome, '.claude'));
  mkdirSync(join(fakeHome, '.codex'));
  const sb = buildSeatbeltLaunch(baseOpts({ hostHome: fakeHome }));
  trackDir(sb.dir);
  assert.equal(sb.env.CLAUDE_CONFIG_DIR, join(fakeHome, '.claude'));
  assert.equal(sb.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, join(fakeHome, '.claude'));
  assert.equal(sb.env.CODEX_HOME, join(fakeHome, '.codex'));
});

test('CLAUDE_CONFIG_DIR / CODEX_HOME are set even when the host dirs are absent', () => {
  // The macOS Keychain is unreachable in the sandbox, so Claude relies on the
  // plaintext ~/.claude/.credentials.json fallback; gating these on existsSync
  // meant a host that never ran the CLI outside ccserver got no override, the
  // credentials landed in the throwaway sandbox HOME, and every launch demanded
  // a fresh login. buildSandboxSpawn mkdir's the host dirs; buildSeatbeltLaunch
  // must point the env at them regardless.
  const fakeHome = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-emptyhome-'));
  DIRS.push(fakeHome);
  const sb = buildSeatbeltLaunch(baseOpts({ hostHome: fakeHome }));
  trackDir(sb.dir);
  assert.equal(sb.env.CLAUDE_CONFIG_DIR, join(fakeHome, '.claude'));
  assert.equal(sb.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, join(fakeHome, '.claude'));
  assert.equal(sb.env.CODEX_HOME, join(fakeHome, '.codex'));
  // ...and buildSeatbeltLaunch must not have created them on the host itself
  // (it only ever writes under its own runtime dir).
  assert.ok(!existsSync(join(fakeHome, '.claude')), 'buildSeatbeltLaunch does not touch the host home');
  assert.ok(!existsSync(join(fakeHome, '.codex')), 'buildSeatbeltLaunch does not touch the host home');
  // The fallback trees stay allow-listed read+write even when absent.
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(subtreeRegex(join(fakeHome, '.claude'))));
  assert.ok(text.includes(subtreeRegex(join(fakeHome, '.codex'))));
});

test('seedClaudeCredentialsFromHostKeychain never overwrites an existing credentials file', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-seedhome-'));
  DIRS.push(fakeHome);
  mkdirSync(join(fakeHome, '.claude'));
  const credsPath = join(fakeHome, '.claude', '.credentials.json');
  writeFileSync(credsPath, '{"claudeAiOauth":{"accessToken":"keep-me"}}\n');
  const wrote = seedClaudeCredentialsFromHostKeychain(fakeHome);
  assert.equal(wrote, false, 'no-op when the file already exists');
  assert.equal(readFileSync(credsPath, 'utf-8'), '{"claudeAiOauth":{"accessToken":"keep-me"}}\n');
});

test('seedClaudeCredentialsFromHostKeychain is a no-op when auth env overrides are set', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-seedenv-'));
  DIRS.push(fakeHome);
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  try {
    assert.equal(seedClaudeCredentialsFromHostKeychain(fakeHome), false);
    assert.ok(!existsSync(join(fakeHome, '.claude', '.credentials.json')));
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
});

test('seedClaudeCredentialsFromHostKeychain swallows a failing Keychain probe', () => {
  // A host that never logged into Claude Code: `security` throws / finds
  // nothing. The helper must return false (-> in-sandbox login) and create no
  // file. runSecurity is injected so no real `security` runs (never touches
  // the runner's real Keychain, and works on Linux CI).
  const fakeHome = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-seednohit-'));
  DIRS.push(fakeHome);
  const wrote = seedClaudeCredentialsFromHostKeychain(fakeHome, {
    runSecurity: () => { throw new Error('errSecItemNotFound'); },
  });
  assert.equal(wrote, false);
  assert.ok(!existsSync(join(fakeHome, '.claude', '.credentials.json')));
});

test('seedClaudeCredentialsFromHostKeychain writes a 0600 file when the probe returns a credential', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-seedhit-'));
  DIRS.push(fakeHome);
  const payload = { claudeAiOauth: { accessToken: 'sk-ant-oat01-x', refreshToken: 'r', expiresAt: 1 } };
  const wrote = seedClaudeCredentialsFromHostKeychain(fakeHome, {
    runSecurity: () => `${JSON.stringify(payload)}\n`,
  });
  assert.equal(wrote, true);
  const credsPath = join(fakeHome, '.claude', '.credentials.json');
  assert.deepEqual(JSON.parse(readFileSync(credsPath, 'utf-8')), payload);
  assert.equal(statSync(credsPath).mode & 0o777, 0o600, 'credentials file is chmod 600');
});

test('seedClaudeCredentialsFromHostKeychain rejects a non-JSON / shapeless probe result', () => {
  for (const bad of ['not json', '{}', '{"claudeAiOauth":{}}', '']) {
    const fakeHome = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-seedbad-'));
    DIRS.push(fakeHome);
    const wrote = seedClaudeCredentialsFromHostKeychain(fakeHome, { runSecurity: () => bad });
    assert.equal(wrote, false, `rejected: ${JSON.stringify(bad)}`);
    assert.ok(!existsSync(join(fakeHome, '.claude', '.credentials.json')));
  }
});

test('seedClaudeCredentialsFromHostKeychain runs the real Keychain probe at most once per process', () => {
  _resetKeychainProbeForTest();
  let calls = 0;
  const probe = () => { calls += 1; return ''; }; // empty -> returns false, latch still set
  const h1 = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-once1-'));
  const h2 = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-once2-'));
  DIRS.push(h1, h2);
  assert.equal(seedClaudeCredentialsFromHostKeychain(h1, { probe }), false);
  assert.equal(seedClaudeCredentialsFromHostKeychain(h2, { probe }), false);
  assert.equal(calls, 1, 'a launch storm must not re-stall on `security` after the first miss');
  _resetKeychainProbeForTest(); // don't leak the latch to later tests
});

test('seedClaudeCredentialsFromHostKeychain swallows a throwing real probe (timeout / missing security)', () => {
  _resetKeychainProbeForTest();
  const h = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-throwprobe-'));
  DIRS.push(h);
  const wrote = seedClaudeCredentialsFromHostKeychain(h, {
    probe: () => { throw new Error('spawn security ENOENT'); },
  });
  assert.equal(wrote, false);
  assert.ok(!existsSync(join(h, '.claude', '.credentials.json')));
  _resetKeychainProbeForTest();
});

test('keychainAccount matches Claude Code HT(): $USER, sanitized to claude-code-user', () => {
  const prev = process.env.USER;
  try {
    process.env.USER = 'ast';
    assert.equal(keychainAccount(), 'ast');
    process.env.USER = 'first.last-2_x';
    assert.equal(keychainAccount(), 'first.last-2_x', 'dots/dashes/underscores are allowed');
    process.env.USER = 'weird name!';
    assert.equal(keychainAccount(), 'claude-code-user', 'anything outside [A-Za-z0-9._-] -> fallback');
    process.env.USER = 'アスト';
    assert.equal(keychainAccount(), 'claude-code-user', 'non-ASCII -> fallback');
  } finally {
    if (prev === undefined) delete process.env.USER;
    else process.env.USER = prev;
  }
});

test('host node binary is readable as a FILE, not its whole dir (nvm-style installs)', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  const readLine = text.split('\n').find((l) => l.startsWith('  (allow file-read*'));
  const nodeBin = realpathSync(process.execPath);
  // The exact binary path is pinned (dyld reads it to exec)...
  assert.ok(readLine.includes(`^${escapeSeatbeltRegex(nodeBin)}$`), 'node binary file pinned');
  // ...but NOT its directory as a subtree -- a shared bin dir (/usr/local/bin,
  // ~/.local/bin) would otherwise expose every unrelated tool in it.
  assert.ok(!readLine.includes(subtreeRegex(dirname(nodeBin))), 'node bin dir is not a subtree allow');
  // Its ancestors are still resolvable, but metadata-only (lstat, not readdir).
  const metaLine = text.split('\n').find((l) => l.startsWith('  (allow file-read-metadata'));
  assert.ok(metaLine.includes(`^${escapeSeatbeltRegex(dirname(nodeBin))}$`), 'node bin dir ancestor lstat allowed');
});

test('buildSeatbeltLaunch cleans up its runtime dir when the overlay copy fails', () => {
  const seatbeltTmp = join(tmpRoot, 'seatbelt');
  const before = new Set(existsSync(seatbeltTmp) ? readdirSync(seatbeltTmp) : []);
  assert.throws(
    () => buildSeatbeltLaunch(baseOpts({ orchestratorClaudeMdSrc: join(tmpRoot, 'absent.md') })),
    /cannot copy rules/,
  );
  const after = existsSync(seatbeltTmp) ? readdirSync(seatbeltTmp) : [];
  assert.deepEqual(after.filter((n) => !before.has(n)), [], 'no leaked runtime dir');
});

test('only executed host files are readable, never the server tree', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  const readLine = text.split('\n').find((l) => l.startsWith('  (allow file-read*'));
  // serverDir itself must not appear as an allowed subtree...
  assert.ok(!readLine.includes('server/ws(/.*)?$'), 'no server tree allow');
  // ...while every executed host file is pinned exactly.
  for (const f of ['sandbox-entrypoint.sh', 'sandbox-mcp-wrapper.cjs', 'sandbox-gh-wrapper.cjs',
    'sandbox-git-credential-helper.cjs', 'sandbox-ssh-wrapper.cjs', 'sandbox-commit-msg-hook.cjs']) {
    assert.ok(readLine.includes(`^${escapeSeatbeltRegex(join(import.meta.dirname, f))}$`), `${f} pinned`);
  }
});

test('the shim scripts get ancestor lstat allows (node module-loader realpath)', () => {
  // `#!/bin/sh exec <node> <serverdir>/server/ws/*.cjs`: node realpathSync's
  // the entry script, lstat-walking <serverdir> and its parents. The exact
  // `.cjs` pins cover open() but not the ancestor lstat -- without these the
  // gh / credential-helper / ssh / commit-hook / MCP shims all die with
  // `EPERM lstat '<serverdir>'` unless the server sits under a broadly-read
  // tree. Ancestors are file-read-METADATA only (lstat, never readdir), so the
  // server tree's contents stay closed -- and a bare ancestor like the real
  // $HOME cannot be listed.
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  const readLine = text.split('\n').find((l) => l.startsWith('  (allow file-read*'));
  const metaLine = text.split('\n').find((l) => l.startsWith('  (allow file-read-metadata'));
  const wsDir = import.meta.dirname;                 // <repo>/server/ws
  for (const anc of ancestorExactRegexes([join(wsDir, 'sandbox-gh-wrapper.cjs')])) {
    assert.ok(metaLine.includes(`(regex #"${anc}")`), `missing ancestor lstat allow: ${anc}`);
    assert.ok(!readLine.includes(`(regex #"${anc}")`), `ancestor must be metadata-only, not file-read*: ${anc}`);
  }
  // still exact-match: server/ws must not be a subtree (contents closed).
  assert.ok(!readLine.includes(subtreeRegex(wsDir)), 'server/ws is not a subtree allow');
  assert.ok(!metaLine.includes(subtreeRegex(wsDir)), 'server/ws is not a metadata subtree either');
});

test('the real host $HOME is not listable from a throwaway-HOME sandbox (#3)', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-realhome-'));
  DIRS.push(fakeHome);
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  const sb = buildSeatbeltLaunch(baseOpts({ hostHome: fakeHome, homeDir: null }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  const readLine = text.split('\n').find((l) => l.startsWith('  (allow file-read*')) || '';
  const metaLine = text.split('\n').find((l) => l.startsWith('  (allow file-read-metadata')) || '';
  // ~/.claude is a genuine read tree; the home dir ITSELF is only an ancestor.
  assert.ok(readLine.includes(subtreeRegex(join(fakeHome, '.claude'))), '~/.claude readable');
  assert.ok(metaLine.includes(`^${escapeSeatbeltRegex(fakeHome)}$`), 'host home ancestor lstat allowed');
  assert.ok(!readLine.includes(`^${escapeSeatbeltRegex(fakeHome)}$`), 'host home is NOT file-read* (no readdir)');
  assert.ok(!readLine.includes(subtreeRegex(fakeHome)), 'host home is not a subtree allow');
});

test('sibling launch dirs are deny-pinned for read and write', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  // POSIX ERE has no lookahead: all launch dirs are denied, then our own is
  // re-allowed after the deny (last-match-wins). Siblings stay unreachable
  // despite the broad tmpdir allow rules (0o700 is per-UID, not per-session).
  assert.ok(!text.includes('(?!'), 'no lookahead: not valid Seatbelt ERE');
  assert.ok(text.includes('ccserver-sb-'), 'sibling launch dirs pinned');
  const denyWrites = text.split('\n').filter((l) => l.includes('(deny file-write*')).join('\n');
  const denyReads = text.split('\n').filter((l) => l.includes('(deny file-read*')).join('\n');
  assert.ok(denyWrites.includes('ccserver-sb-'), 'write pin covers siblings');
  assert.ok(denyReads.includes('ccserver-sb-'), 'read pin covers siblings');
});

// Minimal last-match-wins emulator for file-write* rules: returns the op of
// the last rule whose regex OR literal selector matches the path ('deny' when
// nothing matches, mirroring `(deny default)`).
function finalWriteVerdict(text, path) {
  let verdict = 'deny';
  for (const m of text.matchAll(/^\s*\((allow|deny) file-write\*\s*(.*)\)$/gm)) {
    const bodies = [...m[2].matchAll(/\(regex #"(.*?)"\)/g)].map((x) => x[1]);
    const lits = [...m[2].matchAll(/\(literal "((?:[^"\\]|\\.)*)"\)/g)].map((x) => x[1].replace(/\\(.)/g, '$1'));
    if (bodies.some((r) => new RegExp(r).test(path)) || lits.includes(path)) verdict = m[1];
  }
  return verdict;
}

test('own launch dir stays writable: pin denies do not override the re-allow', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  // runtime/ (XDG_RUNTIME_DIR) and the throwaway HOME must end as allow --
  // the sibling prefix deny must not be repeated after the own-dir re-allow.
  assert.equal(finalWriteVerdict(text, join(sb.dir, 'runtime', 'tool.sock')), 'allow');
  assert.equal(finalWriteVerdict(text, join(sb.homeDir, 'some-project-file')), 'allow');
  // ...while the read-only invariants and siblings stay denied.
  assert.equal(finalWriteVerdict(text, join(sb.binDir, 'gh')), 'deny');
  assert.equal(finalWriteVerdict(text, join(sb.profilePath)), 'deny');
  assert.equal(
    finalWriteVerdict(text, join(dirname(sb.dir), 'ccserver-sb-sibling', 'sandbox.sb')),
    'deny',
  );
});

test('per-launch ssh-config is write-pinned when ssh.realSsh is set', () => {
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-broker-'));
  DIRS.push(brokerDir);
  const knownHostsDefault = join(brokerDir, 'known-hosts-default');
  writeFileSync(knownHostsDefault, 'example.com ssh-ed25519 AAAA\n');
  const sb = buildSeatbeltLaunch(baseOpts({
    gitBroker: { sockPath: join(brokerDir, 'broker.sock'), allowlistPath: join(brokerDir, 'allow.json'), dir: brokerDir },
    ssh: { realSsh: '/usr/bin/ssh', configFile: '/nonexistent-ssh-config', knownHostsDefault, userKnownHosts: null },
  }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.equal(finalWriteVerdict(text, join(sb.dir, 'ssh-config')), 'deny');
  assert.equal(finalWriteVerdict(text, join(sb.dir, 'known-hosts')), 'deny');
});

test('missing server known_hosts falls back to /dev/null (fail-closed)', () => {
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-broker-'));
  DIRS.push(brokerDir);
  const sb = buildSeatbeltLaunch(baseOpts({
    gitBroker: { sockPath: join(brokerDir, 'broker.sock'), allowlistPath: join(brokerDir, 'allow.json'), dir: brokerDir },
    ssh: { realSsh: '/usr/bin/ssh', configFile: '/nonexistent-ssh-config', knownHostsDefault: '/nonexistent-known-hosts', userKnownHosts: null },
  }));
  trackDir(sb.dir);
  assert.ok(!existsSync(join(sb.dir, 'known-hosts')), 'no copy without a source file');
  const sshConfigText = readFileSync(join(sb.dir, 'ssh-config'), 'utf-8');
  assert.ok(sshConfigText.includes('UserKnownHostsFile /dev/null'), 'empty known_hosts, strict checking kept');
});

test('spaced launch dirs: helper is bare-word-escaped, ssh command is quoted', () => {
  // $TMPDIR may contain spaces: credential.helper must stay a bare word
  // (backslash-escaped, leading `/` so git executes it directly -- a `"`
  // would be parsed as a helper NAME), while GIT_SSH_COMMAND is a shell
  // command string and stays double-quoted.
  const spacedBase = join(tmpRoot, 'with space');
  mkdirSync(spacedBase, { recursive: true });
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-broker-'));
  DIRS.push(brokerDir);
  const prev = process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  process.env.CCSERVER_SANDBOX_SEATBELT_TMP = spacedBase;
  try {
    const sb = buildSeatbeltLaunch(baseOpts({
      gitBroker: { sockPath: join(brokerDir, 'broker.sock'), allowlistPath: join(brokerDir, 'allow.json'), dir: brokerDir },
      ssh: { realSsh: '/usr/bin/ssh', configFile: '/nonexistent-ssh-config', knownHostsDefault: '/nonexistent-known-hosts', userKnownHosts: null },
    }));
    trackDir(sb.dir);
    assert.ok(sb.binDir.includes(' '), 'launch dir really contains a space');
    const helperShim = join(sb.binDir, 'ccserver-git-credential-helper');
    // KEY_2 is the real helper (KEY_0 is the empty-string reset, KEY_1 useHttpPath).
    assert.equal(sb.env.GIT_CONFIG_KEY_2, 'credential.helper');
    assert.equal(sb.env.GIT_CONFIG_VALUE_2, helperShim.replace(/ /g, '\\ '));
    assert.ok(sb.env.GIT_CONFIG_VALUE_2.startsWith('/'), 'helper keeps its leading slash');
    assert.equal(sb.env.GIT_SSH_COMMAND, `"${join(sb.binDir, 'ccserver-git-ssh')}"`);
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
    else process.env.CCSERVER_SANDBOX_SEATBELT_TMP = prev;
  }
});

test('no per-launch ssh-config is minted without ssh.realSsh', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  assert.ok(!existsSync(join(sb.dir, 'ssh-config')));
  assert.equal(sb.env.CCSANDBOX_SSH_CONFIG, undefined);
});

test('no per-launch ssh-config is minted without a git broker (minimal launches)', () => {
  // buildMinimalSandboxSpawn passes ssh: seatbeltSsh() (realSsh set on real
  // macOS hosts) with gitBroker: null -- nothing consumes the ssh machinery
  // there, so nothing may be minted (bwrap parity: broker-gated).
  const sb = buildSeatbeltLaunch(baseOpts({
    ssh: { realSsh: '/usr/bin/ssh', configFile: '/nonexistent-ssh-config', knownHostsDefault: '/nonexistent-known-hosts', userKnownHosts: null },
  }));
  trackDir(sb.dir);
  assert.ok(!existsSync(join(sb.dir, 'ssh-config')));
  assert.ok(!existsSync(join(sb.dir, 'known-hosts')));
  assert.equal(sb.env.CCSANDBOX_SSH_CONFIG, undefined);
  assert.equal(sb.env.GIT_SSH_COMMAND, undefined);
});

test('deny lines are emitted after the allow lines (last-match-wins)', () => {
  const text = buildSeatbeltProfileText({
    readRegexes: ['^/srv/proj(/.*)?$'],
    writeRegexes: ['^/srv/proj(/.*)?$'],
    denyWriteRegexes: ['^/home/u/.ssh(/.*)?$'],
  });
  const allowWriteIdx = text.indexOf('(allow file-write*');
  const denyWriteIdx = text.indexOf('(deny file-write*');
  assert.ok(allowWriteIdx !== -1 && denyWriteIdx !== -1 && allowWriteIdx < denyWriteIdx, 'pins must land after the allows');
});

test('sibling deny pins cover both raw and realpath spellings of the base', () => {
  // seatbeltBaseDir() under a symlink: deny pins must carry both spellings,
  // or the other spelling walks around the pin via the broad tmp allows.
  const realBase = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-realbase-'));
  DIRS.push(realBase);
  const linkBase = join(tmpRoot, 'base-link');
  symlinkSync(realBase, linkBase);
  // macOS resolves /var/... to /private/var/...: the registered realpath
  // spelling is the fully-resolved one (cf. the /tmp control-socket test).
  const realBaseResolved = realpathSync(realBase);
  const prev = process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  process.env.CCSERVER_SANDBOX_SEATBELT_TMP = linkBase;
  try {
    const sb = buildSeatbeltLaunch(baseOpts());
    trackDir(sb.dir);
    const text = readFileSync(sb.profilePath, 'utf-8');
    assert.ok(
      text.includes(`^${escapeSeatbeltRegex(linkBase)}/ccserver-sb-`),
      'raw base spelling pinned',
    );
    assert.ok(
      text.includes(`^${escapeSeatbeltRegex(realBaseResolved)}/ccserver-sb-`),
      'realpath base spelling pinned',
    );
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
    else process.env.CCSERVER_SANDBOX_SEATBELT_TMP = prev;
  }
});

test('gitconfig deny pins cover both spellings of a symlinked HOME', () => {
  const realHome = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-realhome-'));
  DIRS.push(realHome);
  const linkHome = join(tmpRoot, 'home-link');
  symlinkSync(realHome, linkHome);
  const homeDir = join(linkHome, 'home');
  mkdirSync(homeDir, { recursive: true });
  // Same /var -> /private/var note as above: compare against the
  // fully-resolved spelling.
  const realHomeResolved = realpathSync(realHome);
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-broker-'));
  DIRS.push(brokerDir);
  const sb = buildSeatbeltLaunch(baseOpts({
    homeDir,
    gitBroker: { sockPath: join(brokerDir, 'broker.sock'), allowlistPath: join(brokerDir, 'allow.json'), dir: brokerDir },
  }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(`^${escapeSeatbeltRegex(join(homeDir, '.gitconfig'))}$`), 'raw spelling pinned');
  assert.ok(
    text.includes(`^${escapeSeatbeltRegex(join(realHomeResolved, 'home', '.gitconfig'))}$`),
    'realpath spelling pinned',
  );
});

test('gitconfig deny pins apply only while the git broker is on', () => {
  // Without a broker there are no broker-issued tokens to steal, and bwrap
  // leaves both files agent-writable -- `git config --global` must keep
  // working in a persistent HOME.
  const homeDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-home-'));
  DIRS.push(homeDir);
  const sb = buildSeatbeltLaunch(baseOpts({ homeDir, gitBroker: null }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(!text.includes('/\\.gitconfig$")'), 'no .gitconfig pin without a broker');
  assert.ok(!text.includes('git/config'), 'no xdg git config pin without a broker');
});

test('buildSeatbeltProfileText denies real gh binaries for process-exec', () => {
  const text = buildSeatbeltProfileText({ denyExecLiterals: ['/opt/homebrew/bin/gh', '/tmp/we"ird/gh'] });
  assert.ok(text.includes('(deny process-exec (literal "/opt/homebrew/bin/gh") (literal "/tmp/we\\"ird/gh"))'));
});

test('buildSeatbeltProfileText denies control-plane sockets via path-literal', () => {
  // connect() is mediated as network-outbound: the pin must use
  // (remote unix-socket (path-literal ...)) -- Apple's Sandbox Guide allows
  // only path-literal there, not regex/literal/subpath -- and land AFTER
  // (allow network*) per last-match-wins.
  const text = buildSeatbeltProfileText({ denyNetOutboundLiterals: ['/tmp/ccserver-runtime-501/ccserver-control.sock'] });
  assert.ok(text.includes('(deny network-outbound (remote unix-socket (path-literal "/tmp/ccserver-runtime-501/ccserver-control.sock")))'));
  assert.ok(text.indexOf('(allow network*)') < text.indexOf('(deny network-outbound'));
  // Every emitted rule line must be paren-balanced (an unbalanced SBPL rule
  // fails the whole profile compile -- fail-closed for all seatbelt launches).
  for (const l of text.split('\n')) {
    if (!l.trimStart().startsWith('(')) continue;
    const opens = (l.match(/\(/g) || []).length;
    const closes = (l.match(/\)/g) || []).length;
    assert.equal(opens, closes, `balanced parens: ${l}`);
  }
});

function assertParenBalanced(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') { // skip string literals (may contain parens)
      i += 1;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i += 1; i += 1; }
      continue;
    }
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') { depth -= 1; assert.ok(depth >= 0, 'unbalanced ) in profile'); }
  }
  assert.equal(depth, 0, 'profile is not paren-balanced overall');
  // ...and no rule line individually spills its parens (single-line style).
  for (const l of text.split('\n')) {
    if (!l.trimStart().startsWith('(')) continue;
    const noStr = l.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    assert.equal((noStr.match(/\(/g) || []).length, (noStr.match(/\)/g) || []).length, `balanced rule line: ${l}`);
  }
}

test('buildSeatbeltProfileText compiles balanced with every optional clause populated', () => {
  // A syntax error in a clause only emitted under a rare combination (broker +
  // guard + gnupg + orchestrator overlay + control-sock denies + exec/net
  // deny literals) would otherwise surface only at a real launch. Feed all of
  // them at once and check the whole profile stays paren-balanced.
  const text = buildSeatbeltProfileText({
    readRegexes: [subtreeRegex('/opt/x'), subtreeRegex('/weird "quote" dir')],
    writeRegexes: [subtreeRegex('/opt/y')],
    readLiterals: ['/tmp/a.sock', '/tmp/we"ird.sock'],
    writeLiterals: ['/tmp/b.sock'],
    siblingDenyWriteRegexes: ['^/tmp/base/ccserver-seatbelt-'],
    siblingDenyReadRegexes: ['^/tmp/base/ccserver-seatbelt-'],
    reAllowWriteRegexes: ['^/tmp/base/ccserver-seatbelt-abc(/.*)?$'],
    reAllowReadRegexes: ['^/tmp/base/ccserver-seatbelt-abc(/.*)?$'],
    denyWriteRegexes: ['^/home/u/\\.ssh(/.*)?$', '^/home/u/\\.gitconfig$'],
    denyExecLiterals: ['/opt/homebrew/bin/gh', '/tmp/we"ird/gh'],
    denyNetOutboundLiterals: ['/tmp/rt/ccserver-control.sock', '/tmp/rt/meta/meta.sock'],
  });
  assertParenBalanced(text);
  // Spot-check the clauses actually co-exist (not silently dropped).
  assert.ok(text.includes('(deny process-exec (literal "/opt/homebrew/bin/gh") (literal "/tmp/we\\"ird/gh"))'));
  assert.ok(text.includes('(remote unix-socket (path-literal "/tmp/rt/meta/meta.sock"))'));
  assert.ok(text.includes('(allow sysctl-read (sysctl-name'));
});

test('buildSeatbeltLaunch: a fully-loaded launch produces a paren-balanced profile', () => {
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-full-broker-'));
  const sockDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-full-socks-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-full-home-'));
  const orch = join(sockDir, 'CLAUDE.md');
  writeFileSync(orch, '# orchestrator\n');
  DIRS.push(brokerDir, sockDir, homeDir);
  const sb = buildSeatbeltLaunch(baseOpts({
    homeDir,
    hostRuntimeDir: sockDir, // exercise the runtime-dir deny/re-allow clause too
    gitBroker: { sockPath: join(brokerDir, 'b.sock'), allowlistPath: join(brokerDir, 'a.json'), dir: brokerDir, token: 'tok' },
    commitGuard: { configPath: join(brokerDir, 'guard.json') },
    gnupg: true,
    authSock: join(sockDir, '1password-agent.sock'),
    orchestratorClaudeMdSrc: orch,
    ghPaths: ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'],
    controlSockDenies: [join(sockDir, 'ccserver-control.sock'), join(sockDir, 'meta', 'meta.sock')],
    sockets: { mcp: join(sockDir, 'mcp.sock'), notify: join(sockDir, 'notify.sock'), meta: join(sockDir, 'meta', 'meta.sock') },
    extraBinds: [{ src: '/srv/shared', mode: 'rw' }, { src: '~/.ssh', mode: 'ro' }],
  }));
  trackDir(sb.dir);
  for (const c of sb.ruleCopies || []) DIRS.push(c);
  assertParenBalanced(readFileSync(sb.profilePath, 'utf-8'));
});

test('buildSeatbeltLaunch: gpgVault (plan: gpg-agent-vault) sets env, pins public files read-only, sockets read+write, and never exposes secret material', () => {
  // gpgVaultRelay.js derives its FIXED paths from hostRuntimeDir()
  // (XDG_RUNTIME_DIR) directly, not from the gpgVault info object passed to
  // buildSeatbeltLaunch below -- see gpgVaultRelay.js's header for why (a
  // single server-wide relay, so an already-running sandbox survives a later
  // lock+re-unlock without a restart). Point XDG_RUNTIME_DIR at a throwaway
  // dir for this test, same pattern other tests in this file already use
  // (see the "no runtime-dir deny" test below).
  const prevXdg = process.env.XDG_RUNTIME_DIR;
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-xdgrt-'));
  DIRS.push(runtimeDir);
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  try {
    // Pure profile-text generation -- no real gpg-agent/relay listener needed
    // here (that's gpgVaultAgent.test.js's/sandbox-gpgvault.test.js's job);
    // just materialize the files buildSeatbeltLaunch expects to find at the
    // relay's fixed paths (empty files stand in for real socket/pubring
    // content -- only path wiring is under test here).
    const relayDir = gpgVaultRelay.getRelayDir();
    mkdirSync(relayDir, { recursive: true });
    for (const f of ['pubring.kbx', 'trustdb.gpg', 'gpg.conf']) writeFileSync(join(relayDir, f), '');
    const relaySockets = gpgVaultRelay.getRelaySocketPaths();
    for (const s of Object.values(relaySockets)) writeFileSync(s, '');

    // The launch-time vault info's OWN homeDir -- deliberately a DIFFERENT
    // dir from the relay dir above, holding secret material that must NEVER
    // be referenced, so the assertion below proves omission, not mere
    // non-existence. A plausible fake object matching getUnlockedAgentInfo()'s
    // shape (fingerprint/nameReal/nameEmail are the only fields
    // buildSeatbeltLaunch still reads from it -- homeDir/sockets are legacy
    // shape only, unused for path wiring now).
    const vaultHome = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-gpgvault-'));
    DIRS.push(vaultHome);
    writeFileSync(join(vaultHome, 'sshcontrol'), 'FAKEKEYGRIP\n');

    const sb = buildSeatbeltLaunch(baseOpts({
      gpgVault: { homeDir: vaultHome, sockets: {}, fingerprint: 'FAKEFPR1234567890', nameReal: 'ccserver test', nameEmail: 'ccserver-test@example.invalid' },
    }));
    trackDir(sb.dir);
    assertParenBalanced(readFileSync(sb.profilePath, 'utf-8'));

    assert.equal(sb.env.GNUPGHOME, relayDir);
    assert.equal(sb.env.SSH_AUTH_SOCK, relaySockets.agentSsh);
    assert.equal(sb.env.GIT_CONFIG_COUNT, '5');
    const gitConfig = {};
    for (let i = 0; i < 5; i++) gitConfig[sb.env[`GIT_CONFIG_KEY_${i}`]] = sb.env[`GIT_CONFIG_VALUE_${i}`];
    assert.equal(gitConfig['user.signingkey'], 'FAKEFPR1234567890');
    assert.equal(gitConfig['commit.gpgsign'], 'true');
    assert.equal(gitConfig['gpg.program'], 'gpg');
    assert.equal(gitConfig['user.name'], 'ccserver test');
    assert.equal(gitConfig['user.email'], 'ccserver-test@example.invalid');

    const text = readFileSync(sb.profilePath, 'utf-8');
    assert.ok(text.includes('pubring.kbx'), 'public keybox is referenced');
    assert.equal(finalWriteVerdict(text, join(relayDir, 'pubring.kbx')), 'deny', 'public files are read-only, never write-allowed');
    assert.equal(finalWriteVerdict(text, relaySockets.agentSsh), 'allow', 'sockets need write for connect()');
    assert.ok(!text.includes('sshcontrol'), 'sshcontrol (host-only ssh-agent config) must never be referenced in the profile');
    assert.ok(!text.includes('private-keys-v1.d'), 'private-keys-v1.d must never be referenced in the profile');
    assert.ok(!text.includes(vaultHome), "the launch's own vault homeDir must never be referenced -- only the relay's fixed paths");
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = prevXdg;
  }
});

test('buildSeatbeltLaunch: gpgVault null (default) sets no GNUPGHOME/GIT_CONFIG -- backward compatible', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  assert.equal(sb.env.GIT_CONFIG_COUNT, undefined);
  assert.equal(sb.env.GNUPGHOME, undefined);
});

// Security audit F3: a launch WITHOUT gpgVault must not be able to connect()
// to the vault relay's fixed sockets. connect() is network-outbound under
// Seatbelt (so the runtime-dir write pins cannot stop it); only a
// last-match-wins `(deny network-outbound (remote unix-socket ...))` does.
function relayNetDenyIndex(text, path) {
  const needle = `(remote unix-socket (path-literal "${path}"))`;
  const idx = text.indexOf(needle);
  if (idx === -1) return -1;
  const lineStart = text.lastIndexOf('\n', idx) + 1;
  return text.slice(lineStart, idx).includes('(deny network-outbound') ? idx : -1;
}

for (const isolate of [false, true]) {
  test(`F3: non-gpgVault launch deny-pins every vault relay socket after the network allow (isolation=${isolate})`, () => {
    const prevXdg = process.env.XDG_RUNTIME_DIR;
    const runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-xdgrt-'));
    DIRS.push(runtimeDir);
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    try {
      const sb = buildSeatbeltLaunch(baseOpts(isolate ? { networkBroker: { port: 41234, token: 'tok' } } : {}));
      trackDir(sb.dir);
      const text = readFileSync(sb.profilePath, 'utf-8');
      assertParenBalanced(text);
      const allowIdx = isolate
        ? text.indexOf('(allow network-outbound (remote unix-socket))')
        : text.indexOf('(allow network*)');
      assert.ok(allowIdx !== -1, 'the broad unix-socket allow under test is present');
      const all = gpgVaultRelay.getAllRelaySocketPathsForDeny();
      // Current AND retired basenames (S.gpg-agent.extra, S.keyboxd,
      // S.dirmngr) -- a stale socket from an older build must stay pinned.
      assert.equal(all.length, 5);
      for (const p of all) {
        const idx = relayNetDenyIndex(text, p);
        assert.ok(idx !== -1, `relay socket ${p} is network-outbound denied`);
        assert.ok(idx > allowIdx, `deny for ${p} comes after the allow (last match wins)`);
        const priv = p.replace(tmpdir(), realpathSync(tmpdir()));
        assert.ok(text.includes(`(path-literal "${priv}")`), `symlink-resolved spelling of ${p} pinned too`);
        assert.equal(finalWriteVerdict(text, p), 'deny', `relay socket file ${p} is not writable/replaceable`);
      }
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = prevXdg;
    }
  });
}

test('F3: gpgVault launch is NOT deny-pinned on its own relay sockets (and only 2 are exposed)', () => {
  const prevXdg = process.env.XDG_RUNTIME_DIR;
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-xdgrt-'));
  DIRS.push(runtimeDir);
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  try {
    const relayDir = gpgVaultRelay.getRelayDir();
    mkdirSync(relayDir, { recursive: true });
    const relaySockets = gpgVaultRelay.getRelaySocketPaths();
    assert.deepEqual(Object.keys(relaySockets).sort(), ['agent', 'agentSsh']);
    for (const s of Object.values(relaySockets)) writeFileSync(s, '');
    const sb = buildSeatbeltLaunch(baseOpts({
      gpgVault: { homeDir: relayDir, sockets: {}, fingerprint: 'FAKEFPR', nameReal: 'ccserver test', nameEmail: 't@example.invalid' },
    }));
    trackDir(sb.dir);
    const text = readFileSync(sb.profilePath, 'utf-8');
    for (const p of Object.values(relaySockets)) {
      assert.equal(relayNetDenyIndex(text, p), -1, `${p} must stay connectable for a gpgVault launch`);
    }
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = prevXdg;
  }
});

test('buildSeatbeltLaunch pins controlSockDenies for network-outbound', () => {
  const sockDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-socks-'));
  DIRS.push(sockDir);
  const controlSock = join(sockDir, 'ccserver-control.sock');
  writeFileSync(controlSock, '');
  const sb = buildSeatbeltLaunch(baseOpts({ controlSockDenies: [controlSock] }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(`(remote unix-socket (path-literal "${controlSock}"))`), 'control socket pinned');
  // The socket FILE itself must also be write-denied (file-write* covers
  // unlink/rename -- otherwise the agent could replace the pinned socket at
  // its fixed path and impersonate the control plane for host-side connects).
  assert.equal(finalWriteVerdict(text, controlSock), 'deny', 'pinned socket file unwritable');
});

test('control-socket pins cover both /tmp spellings even when the dir is absent', () => {
  // The runtime dir may not exist yet (nothing booted a broker); the anchor
  // must fall back to the always-existing parent so the /private/tmp
  // spelling (Seatbelt mediates the resolved path) is pinned too.
  const absentDir = join(tmpdir(), `ccserver-seatbelt-absent-${randomUUID()}`);
  const sock = join(absentDir, 'ccserver-control.sock');
  const prev = process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  // Keep the launch dir OUT of the absent dir (fresh boots put it there).
  process.env.CCSERVER_SANDBOX_SEATBELT_TMP = tmpRoot;
  try {
    const sb = buildSeatbeltLaunch(baseOpts({ controlSockDenies: [sock] }));
    trackDir(sb.dir);
    const text = readFileSync(sb.profilePath, 'utf-8');
    assert.ok(text.includes(`(path-literal "${sock}")`), 'raw spelling pinned');
    const priv = sock.replace(tmpdir(), realpathSync(tmpdir()));
    assert.ok(text.includes(`(path-literal "${priv}")`), 'symlink-resolved spelling pinned');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
    else process.env.CCSERVER_SANDBOX_SEATBELT_TMP = prev;
  }
});

test('control-plane pin paths track the producers (rename-safe)', () => {
  // The network-outbound deny is only as good as its path: if meta renames
  // its socket, the pin must follow. It builds from git-broker.js's shared
  // constants, and so does the pin list.
  const prevXdg = process.env.XDG_RUNTIME_DIR;
  delete process.env.XDG_RUNTIME_DIR;
  try {
    assert.equal(getMetaSockPath(), join(hostRuntimeDir(), META_SOCKET_DIR_NAME, 'sock'));
    const pins = seatbeltControlSockPaths(null);
    assert.ok(pins.includes(getMetaSockPath()), 'meta socket pinned');
    const metaPins = seatbeltControlSockPaths(getMetaSockPath());
    assert.ok(!metaPins.includes(getMetaSockPath()), 'meta session keeps its channel');
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = prevXdg;
  }
});

test('commit-guard config and broker allowlist are write-pinned', () => {
  // The in-sandbox commit-msg hook re-reads its config on every commit;
  // bwrap ro-binds it, so seatbelt must deny-write it (and the allowlist).
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-broker-'));
  DIRS.push(brokerDir);
  const allowlistPath = join(brokerDir, 'allow.json');
  writeFileSync(allowlistPath, '{}');
  const guardPath = join(brokerDir, 'guard.json');
  writeFileSync(guardPath, '{}');
  const sb = buildSeatbeltLaunch(baseOpts({
    gitBroker: { sockPath: join(brokerDir, 'broker.sock'), allowlistPath, dir: brokerDir },
    commitGuard: { configPath: guardPath },
  }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.equal(finalWriteVerdict(text, guardPath), 'deny', 'guard config immutable');
  assert.equal(finalWriteVerdict(text, allowlistPath), 'deny', 'allowlist immutable');
});

test('buildSeatbeltLaunch pins ghPaths only while the git broker is on', () => {
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-broker-'));
  DIRS.push(brokerDir);
  const gitBroker = { sockPath: join(brokerDir, 'broker.sock'), allowlistPath: join(brokerDir, 'allow.json'), dir: brokerDir };
  const sb = buildSeatbeltLaunch(baseOpts({ gitBroker, ghPaths: ['/opt/homebrew/bin/gh', '/usr/bin/gh'] }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes('(deny process-exec (literal "/opt/homebrew/bin/gh") (literal "/usr/bin/gh"))'), 'real gh denied');
  const denyExecs = text.split('\n').filter((l) => l.includes('deny process-exec')).join('\n');
  assert.ok(!denyExecs.includes(join(sb.binDir, 'gh')), 'PATH shim itself is never denied');
  const sbOff = buildSeatbeltLaunch(baseOpts({ gitBroker: null, ghPaths: ['/opt/homebrew/bin/gh'] }));
  trackDir(sbOff.dir);
  const textOff = readFileSync(sbOff.profilePath, 'utf-8');
  assert.ok(!textOff.includes('(literal "/opt/homebrew/bin/gh")'), 'no gh pin without a broker');
});

// --- security review 2026-09-10 fixes A-F -------------------------------------

test('B: pathVariantsDeep resolves the symlink spelling through missing components', () => {
  // Existing dir: both spellings, like pathVariants.
  const real = realpathSync(tmpRoot);
  assert.deepEqual(new Set(pathVariantsDeep(tmpRoot)), new Set([tmpRoot, real]));
  // Deep path whose trailing components don't exist yet: the spelling that
  // resolves the nearest existing ancestor (tmpRoot -> its realpath, which on
  // macOS is the /private/... form and on Linux is identical) must still
  // appear, no matter how many components are missing.
  const deep = join(tmpRoot, 'ccserver-runtime-999', 'ccserver-meta.d', 'sock');
  const got = pathVariantsDeep(deep);
  assert.ok(got.includes(deep), 'raw spelling kept');
  assert.ok(
    got.includes(join(real, 'ccserver-runtime-999', 'ccserver-meta.d', 'sock')),
    'ancestor-resolved spelling synthesized',
  );
});

test('B: the 2-level meta socket is net-pinned in BOTH spellings when the runtime dir is absent', () => {
  // The bug: pathVariants() on a non-existent 2-level path returned only the
  // raw spelling, so the meta broker stayed reachable via the symlink-resolved
  // spelling Seatbelt actually mediates (e.g. /tmp -> /private/tmp on macOS).
  const base = tmpdir();
  const absentBase = join(base, `ccserver-rt-absent-${randomUUID()}`);
  const metaSock = join(absentBase, 'ccserver-meta.d', 'sock');
  // The spelling pathVariantsDeep synthesizes: nearest existing ancestor
  // (tmpdir) resolved. Identical to metaSock on Linux, the /private form on macOS.
  const priv = metaSock.replace(base, realpathSync(base));
  const prev = process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  process.env.CCSERVER_SANDBOX_SEATBELT_TMP = tmpRoot; // keep the launch dir out of absentBase
  try {
    const sb = buildSeatbeltLaunch(baseOpts({ controlSockDenies: [metaSock] }));
    trackDir(sb.dir);
    const text = readFileSync(sb.profilePath, 'utf-8');
    assert.ok(text.includes(`(path-literal "${metaSock}")`), 'raw spelling net-pinned');
    assert.ok(text.includes(`(path-literal "${priv}")`), 'ancestor-resolved spelling net-pinned');
    // ...and the socket file itself stays write-denied in both spellings.
    assert.equal(finalWriteVerdict(text, metaSock), 'deny');
    assert.equal(finalWriteVerdict(text, priv), 'deny');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
    else process.env.CCSERVER_SANDBOX_SEATBELT_TMP = prev;
  }
});

test('C: the host runtime dir tree is deny-written, with only this session\'s sockets re-allowed', () => {
  const runtimeDir = join(tmpdir(), `ccserver-rt-${randomUUID()}`);
  mkdirSync(runtimeDir, { recursive: true });
  DIRS.push(runtimeDir);
  const brokerDir = join(runtimeDir, 'ccserver-git-broker-x');
  mkdirSync(brokerDir, { recursive: true });
  const brokerSock = join(brokerDir, 'broker.sock');
  const notifySock = join(runtimeDir, 'ccserver-notify.d', 'sock');
  const controlSock = join(runtimeDir, 'ccserver-control.sock');
  const sb = buildSeatbeltLaunch(baseOpts({
    hostRuntimeDir: runtimeDir,
    gitBroker: { sockPath: brokerSock, allowlistPath: join(brokerDir, 'allow.json'), dir: brokerDir },
    sockets: { notify: notifySock },
    controlSockDenies: [controlSock],
  }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  // The runtime dir itself and an arbitrary path in it (the rename/rmdir DoS
  // vector) are write-denied...
  assert.equal(finalWriteVerdict(text, runtimeDir), 'deny', 'runtime dir itself unwritable');
  assert.equal(finalWriteVerdict(text, join(runtimeDir, 'attacker-rename-target')), 'deny');
  // ...but the sockets this session legitimately connect()s to stay writable.
  assert.equal(finalWriteVerdict(text, brokerSock), 'allow', 'broker socket connectable');
  assert.equal(finalWriteVerdict(text, notifySock), 'allow', 'notify socket connectable');
  // ...while the control socket stays denied (never re-allowed).
  assert.equal(finalWriteVerdict(text, controlSock), 'deny', 'control socket stays unwritable');
});

test('C: no runtime-dir deny is emitted without a hostRuntimeDir (bwrap-path / unset)', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(!text.includes('host runtime dir: deny-write'), 'no runtime-dir clause when not requested');
});

test('D: credential.helper is reset to empty BEFORE the broker shim is re-added', () => {
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-dreset-'));
  DIRS.push(brokerDir);
  const sb = buildSeatbeltLaunch(baseOpts({
    gitBroker: { sockPath: join(brokerDir, 'b.sock'), allowlistPath: join(brokerDir, 'a.json'), dir: brokerDir },
  }));
  trackDir(sb.dir);
  const n = Number(sb.env.GIT_CONFIG_COUNT);
  const entries = [];
  for (let i = 0; i < n; i++) entries.push([sb.env[`GIT_CONFIG_KEY_${i}`], sb.env[`GIT_CONFIG_VALUE_${i}`]]);
  const helperIdxs = entries.map(([k], i) => (k === 'credential.helper' ? i : -1)).filter((i) => i >= 0);
  assert.equal(helperIdxs.length, 2, 'exactly a reset entry + the shim');
  assert.equal(entries[helperIdxs[0]][1], '', 'first credential.helper is the empty-string reset');
  assert.ok(entries[helperIdxs[1]][1].includes('ccserver-git-credential-helper'), 'second is the broker shim');
  assert.ok(helperIdxs[0] < helperIdxs[1], 'reset comes first');
});

test('D: ~/.git-credentials is deny-write-pinned while the broker is on', () => {
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-dcreds-'));
  DIRS.push(brokerDir);
  const homeDir = mkdtempSync(join(tmpdir(), 'ccserver-sbtest-dcreds-home-'));
  DIRS.push(homeDir);
  const sb = buildSeatbeltLaunch(baseOpts({
    homeDir,
    gitBroker: { sockPath: join(brokerDir, 'b.sock'), allowlistPath: join(brokerDir, 'a.json'), dir: brokerDir },
  }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.equal(finalWriteVerdict(text, join(homeDir, '.git-credentials')), 'deny');
  assert.equal(finalWriteVerdict(text, join(homeDir, '.config', 'git', 'credentials')), 'deny');
  // Off without a broker (bwrap parity: those files stay agent-writable).
  const sbOff = buildSeatbeltLaunch(baseOpts({ homeDir, gitBroker: null }));
  trackDir(sbOff.dir);
  const textOff = readFileSync(sbOff.profilePath, 'utf-8');
  assert.notEqual(finalWriteVerdict(textOff, join(homeDir, '.git-credentials')), 'deny');
});

test('F: the in-sandbox XDG_RUNTIME_DIR fits sockaddr_un with room for a socket name', () => {
  // A full-UUID launch-dir leaf (`ccserver-seatbelt-<uuid>`, 54 chars) pushed
  // <dir>/runtime past darwin's 104-byte sun_path limit, so gpg-agent / tmux
  // / ssh ControlPath binds under $XDG_RUNTIME_DIR failed ENAMETOOLONG. The
  // fix shortens the leaf. Base the check on a realistic-length root: darwin's
  // real per-user tmpdir is /var/folders/<...>/T (~48 chars); pad a short /tmp
  // dir up to that so the test is independent of the actual (possibly
  // pathological, possibly sandboxed) host tmpdir.
  const realBaseLen = 48;
  let padBase = trackDir(mkdtempSync('/tmp/ccs-f-')); // ~15 chars
  if (padBase.length < realBaseLen) {
    padBase = join(padBase, 'p'.repeat(realBaseLen - padBase.length - 1));
    mkdirSync(padBase, { recursive: true });
  }
  const prev = process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  process.env.CCSERVER_SANDBOX_SEATBELT_TMP = padBase;
  try {
    const sb = buildSeatbeltLaunch(baseOpts());
    trackDir(sb.dir);
    const rt = sb.env.XDG_RUNTIME_DIR;
    assert.ok(rt.startsWith(`${sb.dir}/`), 'runtime dir still inside the single teardown unit');
    // The launch-dir leaf is the part this fix controls: far shorter than the
    // old `ccserver-seatbelt-<uuid>` (54 chars).
    assert.ok(basename(sb.dir).length <= 26, `launch-dir leaf too long: ${basename(sb.dir)}`);
    // tmux binds $XDG_RUNTIME_DIR/tmux-<uid>/default (~17 bytes); keep it clear.
    assert.ok(
      Buffer.byteLength(`${rt}/tmux-501/default`) < 104,
      `${rt} (${Buffer.byteLength(rt)} bytes) leaves no room for a socket name`,
    );
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
    else process.env.CCSERVER_SANDBOX_SEATBELT_TMP = prev;
  }
});

test('seatbeltEnvArgs serializes K=V pairs for /usr/bin/env', () => {
  assert.deepEqual(
    seatbeltEnvArgs({ HOME: '/tmp/h', PATH: '/a:/b c' }),
    ['HOME=/tmp/h', 'PATH=/a:/b c'],
  );
});

test('sandboxBackend/sandboxUnavailableReason stay bwrap-flavored on Linux', { skip: process.platform !== 'linux' }, () => {
  // This host is Linux: backend is bwrap when installed, else none -- never
  // seatbelt -- and the refusal text keeps its historical wording (asserted
  // byte-identically by routes/groups.test.js).
  assert.ok(['bwrap', 'none'].includes(sandboxBackend()));
  const { reason, hint } = sandboxUnavailableReason();
  assert.equal(reason, 'bwrap is not available on this host');
  assert.equal(hint, 'Install bwrap (bubblewrap) or launch without the sandbox.');
  const forced = forceSandboxUnavailableReason();
  assert.equal(forced.reason, 'bwrap is not available on this host');
  assert.equal(forced.hint, 'Install bwrap (bubblewrap) or disable forceSandbox.');
});
