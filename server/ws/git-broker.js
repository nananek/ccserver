// Host-side git/gh credential broker for sandboxed sessions.
//
// Runs OUTSIDE the sandbox (spawned by sandbox.js/sessionManager.js as a
// plain child process of ccserver), so it — and only it — ever sees the
// host's gh/git credentials. The sandbox only gets a Unix socket bound in
// (see sandbox-git-credential-helper.cjs / sandbox-gh-wrapper.cjs) and can
// ask "may I have a credential for host+path" or "run this gh command for
// me", never a token file or agent it could reuse for an unrelated repo.
//
// This file is dual-purpose: imported for `startGitBroker()` (called from
// sandbox.js to launch a fresh instance per session), and, when executed
// directly with `--serve`, it IS that instance (the broker server loop).
// Keeping both in one file avoids a "the thing that starts the broker" /
// "the broker" split for no real benefit.
//
// Protocol: one connection per request, client writes a single JSON line,
// server responds with a single JSON line and closes.
//
//   Git HTTPS credential (see sandbox-git-credential-helper.cjs):
//     -> {"op":"credential","protocol":"https","host":"github.com","path":"owner/repo.git"}
//     <- {"ok":true,"username":"x-access-token","password":"<token>"}
//     <- {"ok":false,"reason":"not-allowlisted"|"no-token"|"bad-request"}
//
//   gh passthrough (see sandbox-gh-wrapper.cjs and ghAllowlist.js): argv is
//   the gh command as the sandboxed caller invoked it (no leading "gh");
//   stdin, if any, is base64. Only a fixed safelist of subcommands is ever
//   executed, and only for repos already in the git allow-list.
//     -> {"op":"gh-exec","argv":["pr","view","123"],"stdin":"<base64>"}
//     <- {"ok":true,"exitCode":0,"stdout":"<base64>","stderr":"<base64>"}
//     <- {"ok":false,"reason":"subcommand-not-allowed"|"ambiguous-flags"|"repo-unresolved"|"not-allowlisted"|"bad-request"|"exec-failed"|"timeout"}
//
// SSH allow/deny does NOT go through this socket — the allow-list isn't
// secret, so it's ro-bound into the sandbox as a plain file and checked
// directly by sandbox-ssh-wrapper.cjs. That means a crashed/killed broker
// only breaks HTTPS credential vending and gh (fail closed — nothing is
// printed / gh appears unavailable), not SSH access to already-allowed repos.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeGitAllowlist, normalizeGitUrl, resolveOriginUrl } from './gitAllowlist.js';
import { classifyGhInvocation } from './ghAllowlist.js';

const GH_EXEC_TIMEOUT_MS = 30_000;
const GH_EXEC_MAX_BYTES = 10 * 1024 * 1024;

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

function handleCredential(req, conn, allowSet) {
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

// Runs the real `gh` binary on the host (PATH-resolved, same as fetchToken's
// `gh auth token` above) for an already-allow-listed gh invocation. No TTY:
// gh commands relayed through the broker must be non-interactive (all
// required input via flags/stdin) -- there's no editor/prompt to attach to
// on the other side of this socket.
function execGh(argv, cwd, stdinBuf) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('gh', argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, reason: 'exec-failed' });
      return;
    }

    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, reason: 'timeout' });
    }, GH_EXEC_TIMEOUT_MS);

    const out = [];
    const err = [];
    let outLen = 0;
    let errLen = 0;
    child.stdout.on('data', (d) => { outLen += d.length; if (outLen <= GH_EXEC_MAX_BYTES) out.push(d); });
    child.stderr.on('data', (d) => { errLen += d.length; if (errLen <= GH_EXEC_MAX_BYTES) err.push(d); });
    child.on('error', () => { clearTimeout(timer); finish({ ok: false, reason: 'exec-failed' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({
        ok: true,
        exitCode: typeof code === 'number' ? code : 1,
        stdout: Buffer.concat(out).toString('base64'),
        stderr: Buffer.concat(err).toString('base64'),
      });
    });

    if (stdinBuf && stdinBuf.length) child.stdin.write(stdinBuf);
    child.stdin.end();
  });
}

async function handleGhExec(req, conn, ctx) {
  if (!Array.isArray(req.argv) || !req.argv.every((a) => typeof a === 'string')) {
    conn.end(`${JSON.stringify({ ok: false, reason: 'bad-request' })}\n`);
    return;
  }

  // cwd is always the session's own cwd (fixed at broker startup), never
  // taken from the request -- the sandboxed caller doesn't get to point gh
  // at an arbitrary host path.
  const { allowed: subOk, repos, reason: subReason } = classifyGhInvocation(
    req.argv,
    () => resolveOriginUrl(ctx.cwd),
  );
  if (!subOk) {
    process.stdout.write(`[git-broker] gh-exec ${req.argv.join(' ')} -> deny (${subReason})\n`);
    conn.end(`${JSON.stringify({ ok: false, reason: subReason })}\n`);
    return;
  }
  // ALL repo references found in argv (usually one; can be more -- see
  // ghAllowlist.js) must be allow-listed, not just the first/primary one.
  const denied = repos.find((r) => !ctx.allowSet.has(r));
  if (denied) {
    process.stdout.write(`[git-broker] gh-exec ${req.argv.join(' ')} -> deny (repo ${denied} not-allowlisted)\n`);
    conn.end(`${JSON.stringify({ ok: false, reason: 'not-allowlisted' })}\n`);
    return;
  }

  process.stdout.write(`[git-broker] gh-exec ${req.argv.join(' ')} -> allow (repo(s) ${repos.join(', ')})\n`);
  const stdinBuf = req.stdin ? Buffer.from(req.stdin, 'base64') : null;
  const result = await execGh(req.argv, ctx.cwd, stdinBuf);
  conn.end(`${JSON.stringify(result)}\n`);
}

function handleRequest(line, conn, ctx) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    conn.end(`${JSON.stringify({ ok: false, reason: 'bad-request' })}\n`);
    return;
  }
  if (req && req.op === 'credential') {
    handleCredential(req, conn, ctx.allowSet);
    return;
  }
  if (req && req.op === 'gh-exec') {
    handleGhExec(req, conn, ctx).catch(() => { try { conn.destroy(); } catch { /* ignore */ } });
    return;
  }
  conn.end(`${JSON.stringify({ ok: false, reason: 'bad-request' })}\n`);
}

function runServer({ sock, allowlist, cwd }) {
  let allowSet;
  try {
    allowSet = new Set(JSON.parse(readFileSync(allowlist, 'utf-8')));
  } catch {
    allowSet = new Set(); // fail closed if the allow-list can't be read
  }
  const ctx = { allowSet, cwd };

  try { unlinkSync(sock); } catch { /* fresh dir, usually not present */ }

  // allowHalfOpen: gh-exec responses are written asynchronously (after
  // awaiting the real `gh` child process), well after the client has
  // finished writing its request and called .end() (half-closing its own
  // write side). Without this, net's default behavior auto-ends OUR write
  // side too as soon as it sees the client's FIN -- before the async
  // handler ever gets to conn.end(response) -- silently discarding the
  // response. The synchronous credential/deny paths never hit this race
  // (they call conn.end() in the same tick as the incoming 'end'), which is
  // why it only showed up for gh-exec.
  const server = createServer({ allowHalfOpen: true }, (conn) => {
    let buf = '';
    let handled = false;
    conn.setEncoding('utf-8');
    conn.on('data', (chunk) => {
      if (handled) return;
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      handled = true;
      handleRequest(buf.slice(0, nl), conn, ctx);
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
    __filename, '--serve', '--sock', sockPath, '--allowlist', allowlistPath, '--cwd', cwd,
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
    else if (argv[i] === '--cwd') out.cwd = argv[++i];
  }
  return out;
}

if (process.argv[2] === '--serve') {
  runServer(parseServeArgs(process.argv.slice(3)));
}
