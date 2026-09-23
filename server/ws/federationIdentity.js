// This instance's own federation identity: a self-signed Ed25519 leaf
// certificate used as BOTH the TLS server cert (federationServer.js) and the
// TLS client cert (federationClient.js) for every peer connection -- mutual
// TLS, one keypair per instance, SSH-host-key style (plan section 3).
//
// Trust model recap (see federationServer.js for the enforcement side): CA
// validation is disabled entirely for the federation port. The only thing
// that makes a peer trusted is an exact match of its live certificate's
// fingerprint256 against a 'active' row in paired_instances -- pinned by a
// human, once, at pairing time. This module only produces/reads OUR OWN
// identity; the peer trust table lives in federationPairing.js.
//
// Key generation shells out to `openssl` (execFile, fixed argv, no shell) --
// node:crypto has no X.509 issuance API. Mirrors the existing execFileAsync
// call sites (dirs.js's `git init`, appLaunch.js's CLI probes): fixed argv,
// no shell, no user-controlled arguments.

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { resolvePath, PATH_IDS } from '../paths.js';

const execFileAsync = promisify(execFile);

const CERT_SUBJECT = '/CN=ccserver';
// 100 years: effectively permanent, like an SSH host key. There is no
// rotation UI in Phase 1 (plan section 10) -- replacing the file is the
// rotation mechanism, and it deliberately invalidates every existing pin.
const CERT_DAYS = '36500';

export function federationHomeDir() {
  return resolvePath(PATH_IDS.federationHome);
}

export function keyPath() {
  return join(federationHomeDir(), 'instance.key');
}

export function certPath() {
  return join(federationHomeDir(), 'instance.crt');
}

// Best-effort probe used by index.js to decide whether to attempt federation
// at all: an environment without openssl gets a clear startup log instead of
// a cryptic execFile ENOENT the first time a peer connects.
export function opensslAvailable() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let cached = null;

// Load the identity from disk into memory (throws if the files are missing --
// callers must ensureIdentity() first). Cached for the process lifetime: the
// files never change without a restart (see the header comment on rotation).
export function loadIdentity() {
  if (cached) return cached;
  const key = readFileSync(keyPath(), 'utf-8');
  const cert = readFileSync(certPath(), 'utf-8');
  const x509 = new X509Certificate(cert);
  cached = { key, cert, fingerprint: x509.fingerprint256 };
  return cached;
}

function hasIdentityFiles() {
  return existsSync(keyPath()) && existsSync(certPath());
}

// Idempotent: generates the keypair only if either file is missing. Always
// re-asserts the 0600 permission on the key (a fresh checkout / manual copy
// may have lost it) before returning the loaded identity. Throws if openssl
// is missing or the invocation fails -- callers (index.js) must treat that as
// "federation disabled this run", never a fatal boot error.
export async function ensureIdentity() {
  const dir = federationHomeDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!hasIdentityFiles()) {
    await execFileAsync('openssl', [
      'req', '-x509', '-newkey', 'ed25519', '-days', CERT_DAYS, '-nodes',
      '-keyout', keyPath(), '-out', certPath(), '-subj', CERT_SUBJECT,
    ], { timeout: 15_000 });
  }
  try {
    chmodSync(keyPath(), 0o600);
  } catch { /* best effort -- a read-only filesystem still lets us proceed */ }
  return loadIdentity();
}

// Whether the on-disk key currently has permissions looser than 0600 (owner
// read/write only). Surfaced by GET /api/federation/identity so a leaked
// checkout / careless `cp` shows up in the UI instead of silently weakening
// the one thing the whole trust model rests on.
export function keyPermissionsAreSafe() {
  try {
    const mode = statSync(keyPath()).mode & 0o777;
    return mode === 0o600;
  } catch {
    return null; // file missing / unreadable -- not this function's concern
  }
}

// Test seam: drop the cached identity so a test using a different
// CCSERVER_FEDERATION_HOME gets a fresh read instead of a stale one from an
// earlier test in the same process.
export function _resetIdentityCacheForTests() {
  cached = null;
}

// Extract { fingerprint, pem } for whatever certificate a live TLS socket's
// peer presented, from tls.TLSSocket#getPeerCertificate()'s result. Used
// identically by federationServer.js (inbound) and federationClient.js
// (outbound) -- both need the SAME two facts (the trust anchor, and the PEM
// to keep for display/audit in paired_instances.remote_cert_pem) from the
// handshake itself, before any application-layer byte is exchanged. Returns
// null when the peer presented no certificate at all (rejectUnauthorized is
// off, so an uncooperative/anonymous TLS client can still complete the
// handshake -- callers must treat null as "cannot possibly be a paired peer"
// and refuse).
export function peerCertInfo(tlsSocket) {
  const peer = tlsSocket.getPeerCertificate();
  if (!peer || !peer.raw) return null;
  const x509 = new X509Certificate(peer.raw);
  return { fingerprint: x509.fingerprint256, pem: x509.toString() };
}
