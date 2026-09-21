// GPG vault agent lifecycle (plan: gpg-agent-vault). Owns the ONE managed
// gpg-agent process this server ever runs for the vault: generates the key,
// decrypts it into a tmpfs-only ephemeral GNUPGHOME on unlock, launches
// gpg-agent there with SSH support enabled, and tears it all down on lock.
//
// Lives under server/ws/ (not top-level server/) because it reuses
// hostRuntimeDir()/ensureHostRuntimeDir() from ./git-broker.js -- the exact
// same tmpfs-backed runtime directory (/run/user/<uid> on Linux, a short
// /tmp base on macOS) that broker already established for the identical
// reason: socket paths bound under it must stay well under the
// sockaddr_un.sun_path limit (108 bytes on Linux, 104 on macOS), which a
// naive long tmp path blows through immediately (verified against this
// host's GnuPG 2.4.9 while building this feature: gpg-agent refuses to even
// start when its own socket path is too long).
//
// Security-critical invariant, load-bearing for every caller of
// getUnlockedAgentInfo(): only the live agent SOCKETS plus the *public*
// pubring.kbx/trustdb.gpg/gpg.conf are ever handed to sandbox.js for
// bind-mounting. private-keys-v1.d/, openpgp-revocs.d/, and sshcontrol are
// never exposed via any accessor here -- callers must keep enumerating
// individual files (never the whole homeDir) when wiring this into a
// sandbox, exactly like sandbox.js already does for the unrelated
// host-forwarding `gpg:true` flag.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hostRuntimeDir, ensureHostRuntimeDir } from './git-broker.js';
import { deriveWrappingKey, aesGcmEncrypt, aesGcmDecrypt, generateVaultKey } from '../gpgVaultCrypto.js';
import * as gpgVaultDb from '../gpgVaultDb.js';
import { getDb } from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GEN_TIMEOUT_MS = 30_000;
const EXPORT_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 5_000;
const READY_POLL_MS = 100;
// 5 minutes: how often the auto-lock sweep checks whether every auth_sessions
// row has expired (see lockPolicy note below and the plan's "UX" section).
const AUTO_LOCK_SWEEP_MS = 5 * 60 * 1000;

// In-memory only, by design -- this is the entire "must be logged in to
// decrypt" guarantee. Never serialized, never written to disk except as the
// tmpfs-backed ephemeral GNUPGHOME below (which itself never survives a
// lock/restart). null when locked.
let state = null; // { vk: Buffer, homeDir: string, sockets: {...}, fingerprint, unlockedAt } | null
let autoLockTimer = null;

export function isUnlocked() {
  return state !== null;
}

export function vaultExists() {
  return gpgVaultDb.vaultExists();
}

// gpgVaultRelay.js's only window into this module's private `state`: the
// CURRENT real socket path for one of state.sockets' keys, or null while
// locked. Resolved fresh on every call (never cached by the caller) so a
// lock/unlock in between two calls is picked up automatically -- that's the
// entire mechanism that keeps an already-running gpgVault sandbox working
// across a relock/re-unlock without needing to be restarted.
export function getSocketPath(kind) {
  return state ? (state.sockets[kind] ?? null) : null;
}

// Host tool availability check (gpg/gpgconf), same existsSync-based spirit as
// sandbox.js's dockerSandboxAvailable() -- a clean, actionable error at setup
// time instead of a cryptic ENOENT deep inside key generation.
export function gpgVaultToolsAvailable() {
  try {
    execFileSync('gpg', ['--version'], { timeout: 2000, stdio: 'ignore' });
    execFileSync('gpgconf', ['--version'], { timeout: 2000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Independent read of sandbox.config.json's `gpgVaultLockPolicy.
// idleTimeoutMinutes`, deliberately NOT going through sandbox.js's
// loadSandboxConfig() -- same import-cycle-avoidance reasoning as
// networkAllowlist.js reading this file on its own (see
// server/ws/networkAllowlist.js's header comment): this is a lifecycle
// setting read here, at lock-policy-decision time, not a per-launch sandbox
// option. Defaults to 0 (disabled -- see plan's "UX" section for why the
// default lock policy is session-expiry-bound, not a short idle timer).
//
// A DISTINCT top-level key from the per-launch `gpgVault` boolean
// (loadSandboxConfig() in sandbox.js) on purpose: that key's shape there is
// `raw.gpgVault === true`, a plain boolean, so nesting an object under the
// same key would make one of the two readers see the wrong shape.
function resolveSandboxConfigPath() {
  return process.env.CCSERVER_SANDBOX_CONFIG || join(__dirname, '..', 'sandbox.config.json');
}

function idleTimeoutMinutes() {
  try {
    const raw = JSON.parse(readFileSync(resolveSandboxConfigPath(), 'utf-8'));
    const minutes = raw?.gpgVaultLockPolicy?.idleTimeoutMinutes;
    return typeof minutes === 'number' && minutes > 0 ? minutes : 0;
  } catch {
    return 0;
  }
}

function newTmpHomeDir(prefix) {
  ensureHostRuntimeDir();
  // Short prefix + a full UUID stays well under the sockaddr_un limit given
  // hostRuntimeDir()'s own short base (worst case under 90 bytes total for
  // the longest socket name, S.gpg-agent.browser) -- verified empirically
  // while building this feature: gpg-agent refuses to even start once its
  // own socket path is too long, and it fails with a generic, easy-to-miss
  // "can't connect to the gpg-agent" rather than a clear "path too long".
  const dir = join(hostRuntimeDir(), `${prefix}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function killAgentAt(homeDir) {
  try {
    execFileSync('gpgconf', ['--homedir', homeDir, '--kill', 'all'], { timeout: 5000, stdio: 'ignore' });
  } catch { /* best-effort -- the homedir is about to be wiped regardless */ }
}

function wipeHomeDir(homeDir) {
  try {
    rmSync(homeDir, { recursive: true, force: true });
  } catch { /* best-effort; tmpfs, so a leaked dir here is not a secret leak */ }
}

// Parses `gpg --with-colons --list-secret-keys` output for the primary key's
// fingerprint (the first `fpr:` record's field 9 -- verified against a real
// GnuPG 2.4.9 output while building this feature).
function resolveFingerprint(homeDir) {
  const out = execFileSync('gpg', ['--homedir', homeDir, '--batch', '--with-colons', '--list-secret-keys'], {
    timeout: EXPORT_TIMEOUT_MS, encoding: 'utf8',
  });
  for (const line of out.split('\n')) {
    if (line.startsWith('fpr:')) return line.split(':')[9];
  }
  throw new Error('failed to resolve GPG fingerprint after key generation/import');
}

// Parses `--with-colons --with-keygrip --list-secret-keys` for the
// Authenticate-capable subkey's keygrip: an `ssb` record whose field 11
// (key capabilities) contains lowercase 'a', followed by its `grp` record's
// field 9. Both field positions verified against real GnuPG 2.4.9 output
// while building this feature -- see server/gpgVaultDb.js's header comment
// for why the key is generated with a dedicated auth subkey in the first
// place (GnuPG's SSH support only ever presents keys listed in sshcontrol,
// and only an Authenticate-capable key belongs there).
function resolveAuthKeygrip(homeDir, fingerprint) {
  const out = execFileSync(
    'gpg',
    ['--homedir', homeDir, '--batch', '--with-colons', '--with-keygrip', '--list-secret-keys', fingerprint],
    { timeout: EXPORT_TIMEOUT_MS, encoding: 'utf8' },
  );
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(':');
    if (parts[0] !== 'ssb') continue;
    const capabilities = (parts[11] || '').toLowerCase();
    if (!capabilities.includes('a')) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const grpParts = lines[j].split(':');
      if (grpParts[0] === 'grp') return grpParts[9];
      if (grpParts[0] === 'ssb' || grpParts[0] === 'sec') break;
    }
  }
  throw new Error('no authentication-capable subkey found in the GPG vault key');
}

// Parses `gpgconf --list-dirs` colon-delimited `name:value` lines into the
// socket paths sandbox.js needs. Resolved fresh per homedir (not hardcoded)
// since GnuPG itself decides the exact socket placement rules.
function resolveDirs(homeDir) {
  const out = execFileSync('gpgconf', ['--homedir', homeDir, '--list-dirs'], {
    timeout: 5000, encoding: 'utf8',
  });
  const dirs = {};
  for (const line of out.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    dirs[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return dirs;
}

function waitForAgentReady(homeDir) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      execFileSync('gpg-connect-agent', ['--homedir', homeDir, 'GETINFO version', '/bye'], {
        timeout: 2000, stdio: 'ignore',
      });
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error('gpg-agent did not become ready in time');
      try { execFileSync('sleep', [String(READY_POLL_MS / 1000)], { timeout: 1000 }); } catch { /* ignore */ }
    }
  }
}

function stopAutoLockSweep() {
  if (autoLockTimer) {
    clearInterval(autoLockTimer);
    autoLockTimer = null;
  }
}

// Default lock policy (see plan's "UX: アンロックの頻度とロックポリシー"):
// bound to auth_sessions validity, not a short idle timer -- this server runs
// long, unattended, autonomous agent sessions, and a short default timeout
// would break in-flight signing/pushing with no human present to re-auth. An
// operator can opt into a stricter, off-by-default wall-clock TTL via
// sandbox.config.json's gpgVaultLockPolicy.idleTimeoutMinutes.
function startAutoLockSweep() {
  stopAutoLockSweep();
  const unlockedAt = Date.now();
  autoLockTimer = setInterval(() => {
    if (!state) return stopAutoLockSweep();
    const minutes = idleTimeoutMinutes();
    if (minutes > 0 && Date.now() - unlockedAt >= minutes * 60_000) {
      lockVault();
      return;
    }
    const activeSessions = getDb().prepare(
      'SELECT COUNT(*) AS c FROM auth_sessions WHERE expires_at > ?'
    ).get(Date.now()).c;
    if (activeSessions === 0) lockVault();
  }, AUTO_LOCK_SWEEP_MS);
  autoLockTimer.unref?.();
}

// Generates a fresh, dedicated GPG identity (Ed25519 sign+cert primary,
// Ed25519 auth-only subkey -- the standard shape for "sign commits AND
// SSH-authenticate with the same GPG key" via gpg-agent's SSH support),
// encrypts its exported secret key material under a freshly generated Vault
// Key (VK), wraps VK for the credential that completed the setup PRF
// ceremony, and leaves the vault unlocked (calls unlockVault() with the same
// values, exercising the exact same import/launch path a normal unlock
// uses rather than a separate, divergent code path).
//
// nameReal/nameEmail become both the GPG UID (Name-Real/Name-Email below)
// AND, via sandbox.js's git-identity injection, git's user.name/user.email
// for gpgVault-enabled sessions -- see db.js v8's migration comment for why
// reusing the same values here matters (a signed commit's author identity
// should match the signing key's own UID, and an unset user.name/user.email
// would break `git commit` outright in an ephemeral sandbox HOME).
export function generateAndStoreVault({ nameReal, nameEmail, credentialId, prfSecret }) {
  if (gpgVaultDb.vaultExists()) {
    throw new Error('a GPG vault already exists');
  }
  const tmp = newTmpHomeDir('ccv-gpg-setup');
  try {
    const paramBlock = [
      '%no-protection',
      'Key-Type: eddsa',
      'Key-Curve: ed25519',
      'Key-Usage: sign,cert',
      'Subkey-Type: eddsa',
      'Subkey-Curve: ed25519',
      'Subkey-Usage: auth',
      `Name-Real: ${nameReal}`,
      `Name-Email: ${nameEmail}`,
      'Expire-Date: 0',
      '%commit',
      '',
    ].join('\n');
    execFileSync('gpg', ['--homedir', tmp, '--batch', '--pinentry-mode', 'loopback', '--generate-key'], {
      input: paramBlock, timeout: GEN_TIMEOUT_MS, stdio: ['pipe', 'ignore', 'pipe'],
    });

    const fingerprint = resolveFingerprint(tmp);
    const keyId = fingerprint.slice(-16);
    const publicKeyArmored = execFileSync('gpg', ['--homedir', tmp, '--armor', '--export', fingerprint], {
      timeout: EXPORT_TIMEOUT_MS, encoding: 'utf8',
    });
    const sshPublicKey = execFileSync('gpg', ['--homedir', tmp, '--export-ssh-key', fingerprint], {
      timeout: EXPORT_TIMEOUT_MS, encoding: 'utf8',
    }).trim();
    let secretKeyBuf = execFileSync(
      'gpg',
      ['--homedir', tmp, '--batch', '--pinentry-mode', 'loopback', '--export-secret-keys', fingerprint],
      { timeout: EXPORT_TIMEOUT_MS },
    );

    const vk = generateVaultKey();
    const enc = aesGcmEncrypt(vk, secretKeyBuf, fingerprint);
    secretKeyBuf.fill(0);
    secretKeyBuf = null;

    const wrappingKey = deriveWrappingKey(prfSecret, credentialId);
    const wrap = aesGcmEncrypt(wrappingKey, vk, credentialId);
    vk.fill(0); // createVault/addCredentialWrap below only need the encrypted forms

    gpgVaultDb.createVault({
      fingerprint, keyId, nameReal, nameEmail,
      publicKeyArmored, sshPublicKey,
      encryptedSecretKey: enc.ciphertext, encryptionNonce: enc.iv, encryptionTag: enc.tag,
    });
    gpgVaultDb.addCredentialWrap({
      credentialId, wrappedKey: wrap.ciphertext, wrapNonce: wrap.iv, wrapTag: wrap.tag,
    });
  } finally {
    killAgentAt(tmp);
    wipeHomeDir(tmp);
  }

  // Re-derive through the normal unlock path (same PRF secret, now reading
  // back what was just stored) rather than hand-rolling a shortcut -- this
  // guarantees setup leaves the vault in exactly the state a later unlock
  // would also produce, with no divergent code path to keep in sync.
  return unlockVault({ credentialId, prfSecret });
}

// Adds another PRF-capable credential's wrap of the SAME vault key. Requires
// the vault to already be unlocked (the running process needs VK in memory
// to wrap it again) -- routes/gpgVault.js's add-credential endpoints check
// isUnlocked() before even starting the ceremony.
export function addCredentialToVault({ credentialId, prfSecret }) {
  if (!state) {
    throw new Error('the GPG vault must be unlocked before a new passkey can be added to it');
  }
  const wrappingKey = deriveWrappingKey(prfSecret, credentialId);
  const wrap = aesGcmEncrypt(wrappingKey, state.vk, credentialId);
  gpgVaultDb.addCredentialWrap({
    credentialId, wrappedKey: wrap.ciphertext, wrapNonce: wrap.iv, wrapTag: wrap.tag,
  });
}

// Decrypts the stored GPG secret key via a live PRF ceremony against an
// already-enrolled credential, imports it into a fresh tmpfs-only
// GNUPGHOME, launches gpg-agent there with SSH support, and leaves the
// vault unlocked. Idempotent: if already unlocked, returns the current
// public info without doing anything (callers that need to distinguish
// "was already unlocked" from "just unlocked" check isUnlocked() first).
export function unlockVault({ credentialId, prfSecret }) {
  if (!gpgVaultDb.vaultExists()) {
    const err = new Error('no GPG vault has been set up yet');
    err.code = 'GPG_VAULT_NOT_SET_UP';
    throw err;
  }
  if (state) return gpgVaultDb.getVaultPublicInfo();

  const wrapRow = gpgVaultDb.getCredentialWrap(credentialId);
  if (!wrapRow) {
    const err = new Error('this passkey cannot unlock the GPG vault');
    err.code = 'GPG_VAULT_CREDENTIAL_NOT_ENROLLED';
    throw err;
  }

  const wrappingKey = deriveWrappingKey(prfSecret, credentialId);
  let vk;
  try {
    vk = aesGcmDecrypt(
      wrappingKey,
      Buffer.from(wrapRow.wrapped_key), Buffer.from(wrapRow.wrap_nonce), Buffer.from(wrapRow.wrap_tag),
      credentialId,
    );
  } catch {
    throw new Error('failed to unlock the GPG vault (wrong PRF output or corrupted data)');
  }

  const vaultRow = gpgVaultDb.getVaultRow();
  let secretKeyBuf;
  try {
    secretKeyBuf = aesGcmDecrypt(
      vk,
      Buffer.from(vaultRow.encrypted_secret_key), Buffer.from(vaultRow.encryption_nonce), Buffer.from(vaultRow.encryption_tag),
      vaultRow.fingerprint,
    );
  } catch (err) {
    vk.fill(0);
    throw new Error(`failed to decrypt the stored GPG key: ${err.message}`);
  }

  const homeDir = newTmpHomeDir('ccv-gpg-agent');
  try {
    writeFileSync(join(homeDir, 'gpg-agent.conf'), [
      'enable-ssh-support',
      // Never prompt interactively -- the key has no passphrase (%no-protection
      // at generation time; see generateAndStoreVault's header comment for
      // why), so any prompt at all means something unexpected is happening.
      // Failing it closed (rather than hanging or silently succeeding) is the
      // point.
      'pinentry-program /bin/false',
      'disable-scdaemon',
      '',
    ].join('\n'));

    execFileSync('gpg', ['--homedir', homeDir, '--batch', '--pinentry-mode', 'loopback', '--import'], {
      input: secretKeyBuf, timeout: EXPORT_TIMEOUT_MS, stdio: ['pipe', 'ignore', 'pipe'],
    });
    secretKeyBuf.fill(0);
    secretKeyBuf = null;

    const importedFingerprint = resolveFingerprint(homeDir);
    if (importedFingerprint !== vaultRow.fingerprint) {
      throw new Error('imported key fingerprint does not match the stored vault fingerprint');
    }

    // Required: GnuPG's SSH support only ever presents keys listed in
    // sshcontrol (verified against this host's `man gpg-agent` / GnuPG 2.4.9
    // behavior while building this feature) -- an Authenticate-capable
    // subkey alone is not sufficient. Written before the agent's first
    // launch below to avoid a reload race.
    const authKeygrip = resolveAuthKeygrip(homeDir, importedFingerprint);
    writeFileSync(join(homeDir, 'sshcontrol'), `${authKeygrip}\n`);

    execFileSync('gpgconf', ['--homedir', homeDir, '--launch', 'gpg-agent'], { timeout: 10_000 });
    waitForAgentReady(homeDir);

    const dirs = resolveDirs(homeDir);
    const sockets = {
      agent: dirs['agent-socket'] || null,
      agentSsh: dirs['agent-ssh-socket'] || null,
      agentExtra: dirs['agent-extra-socket'] || null,
      keyboxd: dirs['keyboxd-socket'] || null,
      dirmngr: dirs['dirmngr-socket'] || null,
    };

    state = { vk, homeDir, sockets, fingerprint: importedFingerprint, unlockedAt: Date.now() };
    startAutoLockSweep();
    return gpgVaultDb.getVaultPublicInfo();
  } catch (err) {
    killAgentAt(homeDir);
    wipeHomeDir(homeDir);
    vk.fill(0);
    if (secretKeyBuf) secretKeyBuf.fill(0);
    throw err;
  }
}

// Tears the managed agent down: kills the process, wipes the tmpfs homedir,
// zeroes the in-memory VK, stops the auto-lock sweep. Idempotent (a no-op
// when already locked) -- callers (the explicit lock route, the auto-lock
// sweep, server shutdown) never need to check isUnlocked() first.
export function lockVault() {
  stopAutoLockSweep();
  if (!state) return;
  const { homeDir, vk } = state;
  state = null;
  killAgentAt(homeDir);
  wipeHomeDir(homeDir);
  vk.fill(0);
}

// Query surface for sandbox.js. Throws if locked -- callers must check
// isUnlocked() first (sandbox.js's buildSandboxSpawn fails loudly before any
// other per-launch side effect if gpgVault is requested while locked; see
// plan section 4). nameReal/nameEmail are included so sandbox.js's
// git-identity injection (user.name/user.email alongside user.signingkey)
// can source them from here without a separate gpgVaultDb import -- both are
// public columns (see db.js v8's migration comment), safe to read even
// though the rest of this function's callers otherwise treat "unlocked" as
// gating secret material.
export function getUnlockedAgentInfo() {
  if (!state) throw new Error('the GPG vault is locked');
  const { nameReal, nameEmail } = gpgVaultDb.getVaultPublicInfo();
  return { homeDir: state.homeDir, sockets: state.sockets, fingerprint: state.fingerprint, nameReal, nameEmail };
}

// Existence-check helper for a bind path -- sandbox.js only ever binds
// individual files it has confirmed exist (never the whole homeDir; see this
// file's header comment).
export function socketOrFileExists(path) {
  return !!path && existsSync(path);
}
