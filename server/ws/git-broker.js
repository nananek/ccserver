// Host-side git credential broker for sandboxed sessions.
//
// Runs OUTSIDE the sandbox (spawned by sandbox.js/sessionManager.js as a
// plain child process of ccserver), so it — and only it — ever sees the
// host's gh/git credentials. The sandbox only gets a Unix socket bound in
// (see sandbox-git-credential-helper.cjs) and can ask "may I have a
// credential for host+path", never a token file or agent it could reuse
// for an unrelated repo.
//
// This file is dual-purpose: imported for `startGitBroker()` (called from
// sandbox.js to launch a fresh instance per session), and, when executed
// directly with `--serve`, it IS that instance (the broker server loop).
// Keeping both in one file avoids a "the thing that starts the broker" /
// "the broker" split for no real benefit.
//
// Protocol (see sandbox-git-credential-helper.cjs for the client side): one
// connection per request, client writes a single JSON line
//   {"op":"credential","protocol":"https","host":"github.com","path":"owner/repo.git"}
// server responds with a single JSON line and closes:
//   {"ok":true,"username":"x-access-token","password":"<token>"}
//   {"ok":false,"reason":"not-allowlisted"|"no-token"|"bad-request"}
//
// SSH allow/deny does NOT go through this socket — the allow-list isn't
// secret, so it's ro-bound into the sandbox as a plain file and checked
// directly by sandbox-ssh-wrapper.cjs. That means a crashed/killed broker
// only breaks HTTPS credential vending (fails closed — the helper prints
// nothing), not SSH access to already-allowed repos.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeGitAllowlist, normalizeGitUrl } from './gitAllowlist.js';

const __filename = fileURLToPath(import.meta.url);

const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const RUNTIME_BASE = process.env.XDG_RUNTIME_DIR || `/run/user/${UID}`;

function fetchToken() {
  // Runs on the host, where the real gh config lives (never bound into the
  // sandbox). Fails closed: any error/empty output means no credential.
  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}

function handleRequest(line, conn, allowSet) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    conn.end(`${JSON.stringify({ ok: false, reason: 'bad-request' })}\n`);
    return;
  }
  if (!req || req.op !== 'credential') {
    conn.end(`${JSON.stringify({ ok: false, reason: 'bad-request' })}\n`);
    return;
  }

  const probe = `${req.protocol || 'https'}://${req.host || ''}/${req.path || ''}`;
  const norm = normalizeGitUrl(probe);
  const allowed = Boolean(norm && allowSet.has(norm));

  // Log the decision, never the token.
  process.stdout.write(`[git-broker] credential ${req.host || '?'}/${req.path || ''} -> ${allowed ? 'allow' : 'deny'}\n`);

  if (!allowed) {
    conn.end(`${JSON.stringify({ ok: false, reason: 'not-allowlisted' })}\n`);
    return;
  }
  const token = fetchToken();
  if (!token) {
    conn.end(`${JSON.stringify({ ok: false, reason: 'no-token' })}\n`);
    return;
  }
  conn.end(`${JSON.stringify({ ok: true, username: 'x-access-token', password: token })}\n`);
}

function runServer({ sock, allowlist }) {
  let allowSet;
  try {
    allowSet = new Set(JSON.parse(readFileSync(allowlist, 'utf-8')));
  } catch {
    allowSet = new Set(); // fail closed if the allow-list can't be read
  }

  try { unlinkSync(sock); } catch { /* fresh dir, usually not present */ }

  const server = createServer((conn) => {
    let buf = '';
    let handled = false;
    conn.setEncoding('utf-8');
    conn.on('data', (chunk) => {
      if (handled) return;
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      handled = true;
      handleRequest(buf.slice(0, nl), conn, allowSet);
    });
    conn.on('error', () => {});
  });

  server.on('error', (err) => {
    process.stderr.write(`[git-broker] listen failed: ${err.message}\n`);
    process.exit(1);
  });

  server.listen(sock, () => {
    process.stdout.write(`[git-broker] listening on ${sock} (${allowSet.size} repo(s) allow-listed)\n`);
  });

  const shutdown = () => { try { server.close(); } catch { /* ignore */ } process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Compute the allow-list once and launch a fresh broker instance for a
// sandbox session. Returns null (no broker) if the allow-list ends up
// empty for a non-git cwd — callers should treat that the same as
// "gitBroker disabled" for that launch.
export function startGitBroker({ cwd }) {
  const allowlist = computeGitAllowlist(cwd);

  const dir = join(RUNTIME_BASE, `ccserver-git-broker-${randomUUID()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const allowlistPath = join(dir, 'allowlist.json');
  const sockPath = join(dir, 'broker.sock');
  writeFileSync(allowlistPath, JSON.stringify(allowlist));

  const proc = spawn(process.execPath, [
    __filename, '--serve', '--sock', sockPath, '--allowlist', allowlistPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  proc.stdout.on('data', (d) => process.stdout.write(`[git-broker] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[git-broker] ${d}`));

  // buildSandboxSpawn (sandbox.js) is synchronous and bwrap's --bind-try only
  // sees the socket if it already exists at mount-namespace setup time — a
  // moment after this function returns. Without waiting here, the broker
  // starting up asynchronously would silently lose the race: bwrap would
  // launch before the socket file exists, and the sandbox would never see
  // it (bind is a one-time snapshot, not a live mount). Block briefly
  // (busy-wait via Atomics.wait, not a callback) until the broker is
  // actually listening, or give up after 2s (the sandbox launch then
  // proceeds without a working HTTPS credential helper — same fail-closed
  // behavior as a broker that crashes later).
  const deadline = Date.now() + 2000;
  while (!existsSync(sockPath) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }

  return { proc, dir, sockPath, allowlistPath, allowlist };
}

// Entry point when this file is spawned directly by startGitBroker().
function parseServeArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sock') out.sock = argv[++i];
    else if (argv[i] === '--allowlist') out.allowlist = argv[++i];
  }
  return out;
}

if (process.argv[2] === '--serve') {
  runServer(parseServeArgs(process.argv.slice(3)));
}
