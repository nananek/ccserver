// GPG vault sandbox integration (plan: gpg-agent-vault): verifies
// buildSandboxSpawn's bwrap argv assembly when `gpgVault` is requested --
// same "no real bwrap/pty involved" convention as sandbox-commit-guard.test.js
// (buildSandboxSpawn only assembles argv). Requires a real, unlocked GPG
// vault, so this drives the actual gpgVaultAgent.js lifecycle against real
// gpg/gpgconf binaries -- skipped cleanly when unavailable (same posture as
// gpgVaultAgent.test.js).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildSandboxSpawn } from './sandbox.js';
import { getDb, closeDb } from '../db.js';
import { createConnection } from 'node:net';
import {
  gpgVaultToolsAvailable,
  generateAndStoreVault,
  lockVault,
  unlockVault,
  isUnlocked,
  getUnlockedAgentInfo,
} from './gpgVaultAgent.js';
import { getRelaySocketPaths, stop as stopGpgVaultRelay } from './gpgVaultRelay.js';

const TOOLS_AVAILABLE = gpgVaultToolsAvailable();
const IS_LINUX_BWRAP = process.platform !== 'darwin';

let tmpRoot;
let cfgPath;
const savedDbPath = process.env.CCSERVER_DB_PATH;
const savedHomeRoot = process.env.CCSERVER_SANDBOX_HOME_ROOT;
const savedRuntimeDir = process.env.XDG_RUNTIME_DIR;
const savedSandboxConfig = process.env.CCSERVER_SANDBOX_CONFIG;
// This test's OWN scratch runtime dir -- see gpgVaultAgent.test.js's
// `testRuntimeDir` comment for why this must be a captured constant, never
// derived from process.env after a restore.
const testRuntimeDir = `/tmp/cgvsb${process.pid}`;

function spawnFor(json, { targetCommand = ['claude'], gpgVault = true } = {}) {
  writeFileSync(cfgPath, JSON.stringify(json));
  return buildSandboxSpawn({ cwd: tmpRoot, targetCommand, app: 'claude', sandboxOpts: { gpgVault } });
}

function findSetenv(args, name) {
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === '--setenv' && args[i + 1] === name) return args[i + 2];
  }
  return null;
}

function cleanupSpawn(spawn) {
  if (!spawn) return;
  if (spawn.gitBrokerProc) { try { spawn.gitBrokerProc.kill('SIGKILL'); } catch { /* already dead */ } }
  if (spawn.gitBrokerDir) { try { rmSync(spawn.gitBrokerDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  if (spawn.commitGuardDir) { try { rmSync(spawn.commitGuardDir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-sb-gpgvault-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
  process.env.XDG_RUNTIME_DIR = testRuntimeDir;
});

after(() => {
  lockVault();
  // Any gpgVault:true spawnFor() call above lazily started the relay's
  // net.Server listeners under this test's own XDG_RUNTIME_DIR -- without
  // this, they keep the event loop alive past the last test, hanging this
  // file's overall run until the test runner's own timeout.
  stopGpgVaultRelay();
  closeDb();
  try { rmSync(testRuntimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (savedSandboxConfig === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG; else process.env.CCSERVER_SANDBOX_CONFIG = savedSandboxConfig;
  if (savedDbPath === undefined) delete process.env.CCSERVER_DB_PATH; else process.env.CCSERVER_DB_PATH = savedDbPath;
  if (savedHomeRoot === undefined) delete process.env.CCSERVER_SANDBOX_HOME_ROOT; else process.env.CCSERVER_SANDBOX_HOME_ROOT = savedHomeRoot;
  if (savedRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = savedRuntimeDir;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  lockVault();
  closeDb();
  const db = getDb();
  db.exec('DELETE FROM gpg_vault_credentials');
  db.exec('DELETE FROM gpg_vault');
  db.exec('DELETE FROM webauthn_credentials');
});

function setUpUnlockedVault() {
  getDb().prepare('INSERT INTO webauthn_credentials (id, public_key, counter, label, created_at) VALUES (?,?,?,?,?)')
    .run('cred-sb-1', Buffer.from('pk'), 0, null, Date.now());
  return generateAndStoreVault({
    nameReal: 'ccserver sandbox test', nameEmail: 'ccserver-sandbox-test@example.invalid',
    credentialId: 'cred-sb-1', prfSecret: randomBytes(32), prfSalt: randomBytes(32),
  });
}

test('gpgVault:true while no vault has been set up throws before any broker starts', { skip: !TOOLS_AVAILABLE }, async () => {
  await assert.rejects(
    () => spawnFor({ docker: false, gitBroker: true, persistentHome: false }),
    /no GPG vault has been set up yet/,
  );
});

test('gpgVault:true while the vault is locked throws before any broker starts', { skip: !TOOLS_AVAILABLE }, async () => {
  setUpUnlockedVault();
  lockVault();
  await assert.rejects(
    () => spawnFor({ docker: false, gitBroker: true, persistentHome: false }),
    /currently locked/,
  );
});

test('gpgVault:true while unlocked: binds public files+sockets, sets GNUPGHOME/SSH_AUTH_SOCK, injects git identity, and never exposes secret material', { skip: !TOOLS_AVAILABLE || !IS_LINUX_BWRAP }, async () => {
  const vault = setUpUnlockedVault();
  const spawn = await spawnFor({ docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: false } });
  try {
    const argsStr = spawn.args.join(' ');

    // Own target dir, distinct from the legacy gpg:true flag's ~/.gnupg.
    assert.ok(argsStr.includes('gnupg-vault'), 'uses its own gnupg-vault target dir');

    // Public files bound read-only (--ro-bind-try), sockets bound live (--bind-try).
    assert.ok(argsStr.includes('pubring.kbx'));
    const dashDashDir = spawn.args.indexOf('--dir');
    assert.ok(dashDashDir >= 0, '--dir creates the empty target directory node');

    assert.equal(findSetenv(spawn.args, 'GNUPGHOME')?.endsWith('gnupg-vault'), true);
    const sshAuthSock = findSetenv(spawn.args, 'SSH_AUTH_SOCK');
    assert.ok(sshAuthSock && sshAuthSock.includes('gnupg-vault'), 'SSH_AUTH_SOCK points at the in-sandbox bind target, not the host path');

    // Git identity injected via GIT_CONFIG_COUNT/KEY/VALUE (no commitGuard here, so gpgVault owns indices 0-4).
    assert.equal(findSetenv(spawn.args, 'GIT_CONFIG_COUNT'), '5');
    const gitConfig = {};
    for (let i = 0; i < 5; i++) {
      gitConfig[findSetenv(spawn.args, `GIT_CONFIG_KEY_${i}`)] = findSetenv(spawn.args, `GIT_CONFIG_VALUE_${i}`);
    }
    assert.equal(gitConfig['user.signingkey'], vault.fingerprint);
    assert.equal(gitConfig['commit.gpgsign'], 'true');
    assert.equal(gitConfig['gpg.program'], 'gpg');
    assert.equal(gitConfig['user.name'], 'ccserver sandbox test');
    assert.equal(gitConfig['user.email'], 'ccserver-sandbox-test@example.invalid');

    // Security-critical: the secret key material must NEVER appear as a bind
    // source/target anywhere in the generated argv.
    assert.ok(!argsStr.includes('private-keys-v1.d'), 'private-keys-v1.d must never be bound into the sandbox');
    assert.ok(!argsStr.includes('openpgp-revocs.d'), 'revocation certs must never be bound into the sandbox');
    assert.ok(!argsStr.includes('sshcontrol'), 'sshcontrol (host-only ssh-agent config) must never be bound into the sandbox');
  } finally {
    cleanupSpawn(spawn);
  }
});

test('gpgVault + commitMessageGuard both active: GIT_CONFIG_COUNT accounts for both, indices do not collide', { skip: !TOOLS_AVAILABLE || !IS_LINUX_BWRAP }, async () => {
  setUpUnlockedVault();
  const spawn = await spawnFor({ docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: true } });
  try {
    assert.equal(findSetenv(spawn.args, 'GIT_CONFIG_COUNT'), '6', 'core.hooksPath (1) + gpgVault (5) = 6');
    const gitConfig = {};
    for (let i = 0; i < 6; i++) {
      gitConfig[findSetenv(spawn.args, `GIT_CONFIG_KEY_${i}`)] = findSetenv(spawn.args, `GIT_CONFIG_VALUE_${i}`);
    }
    assert.equal(gitConfig['core.hooksPath'], '/ccserver-sandbox-git-hooks');
    assert.equal(gitConfig['commit.gpgsign'], 'true');
    assert.ok(spawn.commitGuardDir, 'commit guard runtime dir still created alongside gpgVault');
  } finally {
    cleanupSpawn(spawn);
    if (spawn?.commitGuardDir) { try { rmSync(spawn.commitGuardDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
});

test('gpgVault:true alongside the legacy gpg host-forwarding flag does not throw (warns, gpgVault wins)', { skip: !TOOLS_AVAILABLE || !IS_LINUX_BWRAP }, async () => {
  setUpUnlockedVault();
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: false }, gpg: true }));
  const spawn = await buildSandboxSpawn({ cwd: tmpRoot, targetCommand: ['claude'], app: 'claude', sandboxOpts: { gpgVault: true } });
  try {
    const sshAuthSock = findSetenv(spawn.args, 'SSH_AUTH_SOCK');
    assert.ok(sshAuthSock && sshAuthSock.includes('gnupg-vault'), 'gpgVault wins the SSH_AUTH_SOCK setenv (last bind wins)');
  } finally {
    cleanupSpawn(spawn);
  }
});

test('isUnlocked() reflects lock/unlock across the test helpers (sanity)', { skip: !TOOLS_AVAILABLE }, () => {
  assert.equal(isUnlocked(), false);
  setUpUnlockedVault();
  assert.equal(isUnlocked(), true);
  lockVault();
  assert.equal(isUnlocked(), false);
});

// Connects to `sockPath` and resolves with either the first line of data
// received (proof of a live backend behind the relay -- gpg-agent's Assuan
// protocol greets every new connection with "OK ..." before any command) or
// 'closed'/'error' if the relay refused/dropped the connection immediately
// (the locked-vault case). Bounded by a short timeout so a hung connection
// fails the test instead of hanging the suite.
function connectAndReadLine(sockPath, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(sockPath);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('timed out waiting for relay response')); }, timeoutMs);
    sock.once('data', (chunk) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(chunk.toString('utf-8'));
    });
    sock.once('close', () => { clearTimeout(timer); resolve('closed'); });
    sock.once('error', () => { clearTimeout(timer); resolve('error'); });
  });
}

test('gpgVaultRelay: forwards live traffic to the CURRENT backend, refuses while locked, and self-heals across a lock+re-unlock without restarting the sandbox', { skip: !TOOLS_AVAILABLE || !IS_LINUX_BWRAP }, async () => {
  const credentialId = 'cred-sb-relay';
  const prfSecret = randomBytes(32);
  getDb().prepare('INSERT INTO webauthn_credentials (id, public_key, counter, label, created_at) VALUES (?,?,?,?,?)')
    .run(credentialId, Buffer.from('pk'), 0, null, Date.now());
  generateAndStoreVault({
    nameReal: 'ccserver relay test', nameEmail: 'ccserver-relay-test@example.invalid',
    credentialId, prfSecret, prfSalt: randomBytes(32),
  });

  // Triggers gpgVaultRelay.ensureStarted() (buildSandboxSpawn), same as a
  // real gpgVault:true launch would -- no bwrap/pty actually runs here (this
  // file only ever assembles argv), but the relay's real net.Server
  // listeners DO start for real, which is exactly what this test exercises.
  const spawn = await spawnFor({ docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: false } });
  cleanupSpawn(spawn);

  const relaySockets = getRelaySocketPaths();

  // 1. Unlocked (generation A): a fresh connection through the relay's FIXED
  //    path reaches a real, live gpg-agent.
  const greetingA = await connectAndReadLine(relaySockets.agent);
  assert.match(greetingA, /^OK/, 'relay forwards to a live gpg-agent while unlocked');

  // 2. Locked: gpgVaultAgent.getSocketPath() now returns null for every
  //    kind, so a NEW connection through the SAME fixed path is refused
  //    immediately -- no dangling reference to the now-dead generation-A
  //    backend (its process was killed and its homeDir wiped by lockVault()).
  lockVault();
  const duringLock = await connectAndReadLine(relaySockets.agent);
  assert.equal(duringLock, 'closed', 'relay refuses new connections while the vault is locked');

  // 3. Re-unlocked (generation B: a brand new homeDir/gpg-agent process/
  //    socket paths, per unlockVault()'s own design -- see gpgVaultAgent.js).
  //    THE POINT OF THIS FIX: no sandbox restart, no relay restart, nothing
  //    re-plumbed -- the exact same fixed relay socket path now reaches the
  //    NEW backend, because gpgVaultRelay resolves the target fresh on every
  //    new connection rather than caching generation A's path.
  unlockVault({ credentialId, prfSecret });
  const greetingB = await connectAndReadLine(relaySockets.agent);
  assert.match(greetingB, /^OK/, 'relay forwards to the NEW (generation B) gpg-agent after a re-unlock, with no restart of anything');
});

// ---------------------------------------------------------------------------
// Security audit F1 regression: the relay must never hand out the vault's
// secret key. The audit reproduced `gpg --export-secret-keys` from inside a
// gpgVault:true bwrap sandbox, imported the result on the host, and signed
// with it. Everything below replays that attack against the fixed relay.

// Async child process: the relay under test runs on THIS process's event
// loop, so a synchronous spawn would deadlock the very relay it talks to.
function run(cmd, args, { input = null, env = process.env, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env });
    const out = [];
    const err = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
    });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

// Sends one Assuan command over a fresh relay connection (after the agent's
// greeting) and resolves with the first response line.
function assuanRoundTrip(sockPath, command, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(sockPath);
    let buf = '';
    let greeted = false;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`timed out on ${command}`)); }, timeoutMs);
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!greeted) {
          greeted = true;
          sock.write(`${command}\n`);
          continue;
        }
        if (/^(OK|ERR)\b/.test(line)) {
          clearTimeout(timer);
          sock.destroy();
          resolve(line);
          return;
        }
      }
    });
    sock.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// A throwaway GNUPGHOME that talks to the vault ONLY through the relay's
// agent socket -- the same view a sandbox has (public keyring + relay
// socket, nothing else). no-autostart so gpg can never fall back to spawning
// a local agent of its own.
//
// gpg does NOT always look for S.gpg-agent inside $GNUPGHOME. When a real
// /run/user/<uid> exists (true on this host; false inside the bwrap sandbox
// this is meant to imitate, since sandbox.js mounts a fresh --tmpfs /run
// there), GnuPG's "socketdir" scheme puts every socket under
// /run/user/<uid>/gnupg/d.<hash-of-homedir>/ instead and never even stats
// $GNUPGHOME/S.gpg-agent -- confirmed with strace, not something worth
// guessing at from the docs. `gpgconf --list-dirs agent-socket` reports
// whichever path gpg will actually use, so ask it instead of assuming
// $home/S.gpg-agent.
function relayOnlyGnupgHome(vaultHomeDir, relayAgentSock) {
  const home = mkdtempSync('/tmp/cgvc');
  execFileSync('cp', [join(vaultHomeDir, 'pubring.kbx'), join(vaultHomeDir, 'trustdb.gpg'), home]);
  writeFileSync(join(home, 'gpg.conf'), 'no-autostart\n');
  const agentSocketPath = execFileSync(
    'gpgconf', ['--homedir', home, '--list-dirs', 'agent-socket'], { timeout: 5000, encoding: 'utf8' },
  ).trim();
  const socketDir = dirname(agentSocketPath);
  if (socketDir !== home) mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  symlinkSync(relayAgentSock, agentSocketPath);
  return { home, extraSocketDir: socketDir === home ? null : socketDir };
}

test('F1: every relay-exposed socket reaches ONLY the restricted agent, and export commands are Forbidden', { skip: !TOOLS_AVAILABLE || !IS_LINUX_BWRAP }, async () => {
  setUpUnlockedVault();
  cleanupSpawn(await spawnFor({ docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: false } }));
  const relaySockets = getRelaySocketPaths();
  assert.deepEqual(Object.keys(relaySockets).sort(), ['agent', 'agentSsh'], 'only the agent + ssh sockets are relayed');

  // GETINFO restricted answers OK only on a restricted (extra-socket)
  // connection: proof the relay targets the extra socket, not the main one.
  assert.match(await assuanRoundTrip(relaySockets.agent, 'GETINFO restricted'), /^OK/);

  for (const cmd of ['KEYWRAP_KEY --export', 'EXPORT_KEY 0000000000000000000000000000000000000000', 'IMPORT_KEY', 'PASSWD 00', 'GENKEY', 'PRESET_PASSPHRASE 00 -1 00']) {
    assert.match(await assuanRoundTrip(relaySockets.agent, cmd), /^ERR 67109115 /, `${cmd} is Forbidden through the relay`);
  }
});

test('F1: `gpg --export-secret-keys` through the relay yields nothing, while git-style signing still works', { skip: !TOOLS_AVAILABLE || !IS_LINUX_BWRAP }, async () => {
  const vault = setUpUnlockedVault();
  cleanupSpawn(await spawnFor({ docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: false } }));
  const info = getUnlockedAgentInfo();
  const { home, extraSocketDir } = relayOnlyGnupgHome(info.homeDir, getRelaySocketPaths().agent);
  try {
    const exported = await run('gpg', ['--homedir', home, '--batch', '--pinentry-mode', 'loopback', '--export-secret-keys', vault.fingerprint]);
    assert.equal(exported.stdout.length, 0, 'no secret key material is exported');
    const exportedNoLoopback = await run('gpg', ['--homedir', home, '--batch', '--export-secret-keys', vault.fingerprint]);
    assert.equal(exportedNoLoopback.stdout.length, 0, 'no secret key material is exported (default pinentry mode either)');
    const sshExport = await run('gpg', ['--homedir', home, '--batch', '--export-secret-subkeys', vault.fingerprint]);
    assert.equal(sshExport.stdout.length, 0, 'subkeys (the SSH auth key) cannot be exported either');

    // Exactly how git signs a commit (gpg.program=gpg): must keep working.
    const signed = await run('gpg', ['--homedir', home, '--status-fd=2', '-bsau', vault.fingerprint], { input: 'tree 0\n' });
    assert.equal(signed.status, 0, `signing through the relay works: ${signed.stderr}`);
    assert.match(signed.stderr, /SIG_CREATED/);
    assert.match(signed.stdout.toString(), /BEGIN PGP SIGNATURE/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (extraSocketDir) rmSync(extraSocketDir, { recursive: true, force: true });
  }
});

test('F1: the relayed ssh-agent lists and signs with the vault key but refuses to add/remove/lock keys', { skip: !TOOLS_AVAILABLE || !IS_LINUX_BWRAP }, async () => {
  const vault = setUpUnlockedVault();
  cleanupSpawn(await spawnFor({ docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: false } }));
  const env = { ...process.env, SSH_AUTH_SOCK: getRelaySocketPaths().agentSsh };
  const keyBlob = vault.sshPublicKey.split(' ')[1];
  const listed = await run('ssh-add', ['-L'], { env });
  assert.ok(listed.stdout.toString().includes(keyBlob), 'the vault SSH key is offered through the relay');

  const removeAll = await run('ssh-add', ['-D'], { env });
  assert.notEqual(removeAll.status, 0, 'REMOVE_ALL_IDENTITIES is refused');
  // Still intact afterwards.
  assert.ok((await run('ssh-add', ['-L'], { env })).stdout.toString().includes(keyBlob));
});

// Replays the audit's exact repro inside a REAL bwrap sandbox built by
// buildSandboxSpawn (not just argv inspection): the sandbox's own gpg, with
// the GNUPGHOME/SSH_AUTH_SOCK the launch sets up, tries to export the key.
test('F1 (real bwrap): inside a gpgVault:true sandbox, export-secret-keys yields nothing, signing and ssh still work', { skip: !TOOLS_AVAILABLE || !IS_LINUX_BWRAP || !bwrapUsable() }, async (t) => {
  const vault = setUpUnlockedVault();
  const script = [
    'set -u',
    'export LC_ALL=C',
    `n=$(gpg --batch --pinentry-mode loopback --export-secret-keys ${vault.fingerprint} 2>/dev/null | wc -c)`,
    'echo "EXPORT_BYTES=$n"',
    `m=$(gpg --batch --export-secret-subkeys ${vault.fingerprint} 2>/dev/null | wc -c)`,
    'echo "SUBKEY_EXPORT_BYTES=$m"',
    'echo "KEYWRAP=$(gpg-connect-agent --no-autostart "KEYWRAP_KEY --export" /bye 2>&1 | grep -m1 -E "^(OK|ERR|D)")"',
    `if echo tree | gpg --batch --status-fd=1 -bsau ${vault.fingerprint} 2>/dev/null | grep -q SIG_CREATED; then echo SIGN=ok; else echo SIGN=fail; fi`,
    'if ssh-add -L >/dev/null 2>&1; then echo SSH=ok; else echo SSH=fail; fi',
    'ls "$GNUPGHOME"',
  ].join('\n');
  const sb = await spawnFor(
    { docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: false } },
    { targetCommand: ['bash', '-c', script] },
  );
  try {
    const res = await run(sb.command, sb.args, { timeoutMs: 60000 });
    const out = `${res.stdout}\n${res.stderr}`;
    if (sandboxDidNotStart(res)) {
      t.skip(`bwrap could not assemble the sandbox on this host: ${res.stderr.trim().split('\n')[0]}`);
      return;
    }
    assert.match(out, /EXPORT_BYTES=0\b/, `secret key export must yield 0 bytes inside the sandbox:\n${out}`);
    assert.match(out, /SUBKEY_EXPORT_BYTES=0\b/, out);
    assert.match(out, /KEYWRAP=ERR 67109115 /, out);
    assert.match(out, /SIGN=ok/, `signing must still work inside the sandbox:\n${out}`);
    assert.match(out, /SSH=ok/, out);
    // What the sandbox can see of the vault homedir: public files and the two
    // relay sockets, nothing else.
    assert.doesNotMatch(out, /private-keys-v1\.d|sshcontrol|S\.gpg-agent\.extra|S\.keyboxd|S\.dirmngr/, out);
  } finally {
    cleanupSpawn(sb);
  }
});

// Negative control (audit): a sandbox launched WITHOUT gpgVault cannot see
// the relay at all on Linux/bwrap.
test('F3 negative control (real bwrap): a sandbox without gpgVault cannot reach the relay sockets', { skip: !TOOLS_AVAILABLE || !IS_LINUX_BWRAP || !bwrapUsable() }, async (t) => {
  setUpUnlockedVault();
  // Make sure the relay is actually listening on the host.
  cleanupSpawn(await spawnFor({ docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: false } }));
  const relay = getRelaySocketPaths();
  const script = Object.values(relay).map((p) => `if [ -e '${p}' ]; then echo "VISIBLE ${p}"; else echo "ABSENT ${p}"; fi`).join('\n');
  const sb = await spawnFor(
    { docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: false } },
    { targetCommand: ['bash', '-c', script], gpgVault: false },
  );
  try {
    const res = await run(sb.command, sb.args, { timeoutMs: 60000 });
    const out = `${res.stdout}\n${res.stderr}`;
    if (sandboxDidNotStart(res)) {
      t.skip(`bwrap could not assemble the sandbox on this host: ${res.stderr.trim().split('\n')[0]}`);
      return;
    }
    for (const p of Object.values(relay)) assert.match(out, new RegExp(`ABSENT ${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), out);
    assert.doesNotMatch(out, /VISIBLE/, out);
  } finally {
    cleanupSpawn(sb);
  }
});

// Real-bwrap tests need a host where a full sandbox launch works at all
// (bwrap present and unprivileged user namespaces allowed). Note: if they
// fail with "bwrap: Can't bind mount ~/.claude.json", the host's
// ~/.claude.json is a stale bind of an unlinked inode (seen when the test
// itself runs inside a ccserver sandbox) -- run with a clean HOME, e.g.
// `HOME=$(mktemp -d) node --test ws/sandbox-gpgvault.test.js`.
// bwrap failed while ASSEMBLING the sandbox (a bind source it cannot mount),
// i.e. our script never ran at all: nothing about the vault was tested, so
// the caller skips with the reason instead of reporting a false failure. A
// real regression cannot hide here -- it needs the script to run and print.
function sandboxDidNotStart(res) {
  return res.status !== 0 && res.stdout.length === 0 && /^bwrap: /m.test(res.stderr);
}

function bwrapUsable() {
  try {
    execFileSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true'], { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}
