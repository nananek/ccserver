// Host-side CLIs touched by the security audit remediation (P0): runs each
// as a real child process against a throwaway DB, the way an operator would.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, closeDb } from '../db.js';
import { hashLoginToken } from '../loginTokens.js';
import { createVault, addCredentialWrap, vaultExists, countCredentialWraps } from '../gpgVaultDb.js';

const CLI_DIR = import.meta.dirname;
let tmpRoot;
let env;
const savedDbPath = process.env.CCSERVER_DB_PATH;
const savedHomeRoot = process.env.CCSERVER_SANDBOX_HOME_ROOT;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-cli-test-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
  env = { ...process.env, CCSERVER_AUTH_MODE: 'passkey', LC_ALL: 'C' };
});

after(() => {
  closeDb();
  if (savedDbPath === undefined) delete process.env.CCSERVER_DB_PATH; else process.env.CCSERVER_DB_PATH = savedDbPath;
  if (savedHomeRoot === undefined) delete process.env.CCSERVER_SANDBOX_HOME_ROOT; else process.env.CCSERVER_SANDBOX_HOME_ROOT = savedHomeRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function runCli(script, args = []) {
  closeDb(); // let the child own the DB file while it runs
  return spawnSync(process.execPath, [join(CLI_DIR, script), ...args], { env, encoding: 'utf8', timeout: 30000 });
}

function tokenFlag(stdout) {
  const token = stdout.split('\n').map((l) => l.trim()).find((l) => /^[A-Za-z0-9_-]{40,}$/.test(l));
  assert.ok(token, `a token is printed: ${stdout}`);
  return getDb().prepare('SELECT allow_passkey_registration FROM login_tokens WHERE token_hash = ?')
    .get(hashLoginToken(token)).allow_passkey_registration;
}

test('issue-login-token: without the flag the token only logs in (security audit F2)', () => {
  const res = runCli('issue-login-token.js');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(tokenFlag(res.stdout), 0);
});

test('issue-login-token --allow-passkey-registration: the token carries the single-use registration grant', () => {
  const res = runCli('issue-login-token.js', ['--allow-passkey-registration']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(tokenFlag(res.stdout), 1);
  assert.match(res.stdout, /--allow-passkey-registration/);
});

test('issue-login-token rejects unknown arguments (a typo must not silently issue a login-only token)', () => {
  const res = runCli('issue-login-token.js', ['--allow-passkey-registraton']);
  assert.equal(res.status, 2);
});

test('gpg-vault-reset: dry run by default, deletes with --yes, flags a legacy vault (security audit F1.4)', () => {
  const db = getDb();
  db.prepare('INSERT INTO webauthn_credentials (id, public_key, counter, label, created_at) VALUES (?,?,?,?,?)')
    .run('cred-cli', Buffer.from('pk'), 0, null, Date.now());
  createVault({
    fingerprint: 'CLIFPR0000000000000000000000000000000000', keyId: 'CLIKEYID',
    nameReal: 'ccserver cli', nameEmail: 'cli@example.invalid',
    publicKeyArmored: '-----BEGIN-----', sshPublicKey: 'ssh-ed25519 AAAACLI',
    encryptedSecretKey: Buffer.from('ct'), encryptionNonce: Buffer.from('n'), encryptionTag: Buffer.from('t'),
  });
  addCredentialWrap({ credentialId: 'cred-cli', wrappedKey: Buffer.from('w'), wrapNonce: Buffer.from('n'), wrapTag: Buffer.from('t'), prfSalt: Buffer.alloc(32, 1) });
  db.prepare('UPDATE gpg_vault SET format_version = 1').run(); // pre-fix vault

  const dry = runCli('gpg-vault-reset.js');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /CLIFPR0000000000000000000000000000000000/);
  assert.match(dry.stdout, /ssh-ed25519 AAAACLI/);
  assert.match(dry.stdout, /無効化/);
  assert.match(dry.stdout, /--yes/);
  assert.equal(vaultExists(), true, 'dry run deletes nothing');

  const real = runCli('gpg-vault-reset.js', ['--yes']);
  assert.equal(real.status, 0, real.stderr);
  assert.equal(vaultExists(), false);
  assert.equal(countCredentialWraps(), 0);

  const again = runCli('gpg-vault-reset.js', ['--yes']);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /存在しません/);
});
