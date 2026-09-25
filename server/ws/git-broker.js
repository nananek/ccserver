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
//     <- {"ok":false,"reason":"subcommand-not-allowed"|"ambiguous-flags"|"repo-unresolved"|"repo-must-be-explicit"|"not-allowlisted"|"blocked-message"|"file-arg-requires-stdin"|"unrecognized-flag"|"release-assets-not-allowed"|"release-download-dir-not-allowed"|"release-download-output-not-stdout"|"workflow-field-file-not-allowed"|"attach-not-allowed"|"checkout-worktree-not-allowed"|"bad-request"|"exec-failed"|"timeout"}
//
// SSH allow/deny does NOT go through this socket — the allow-list isn't
// secret, so it's ro-bound into the sandbox as a plain file and checked
// directly by sandbox-ssh-wrapper.cjs. That means a crashed/killed broker
// only breaks HTTPS credential vending and gh (fail closed — nothing is
// printed / gh appears unavailable), not SSH access to already-allowed repos.
//
// gh-exec also runs a second check once the allow/deny decision above says
// yes: plan8's PR-body guard (findBlockedGhText below). A `pr create`/`edit`/
// `comment`/`review` invocation's title/body text is checked against the
// same Claude-Session:/session-URL patterns commitGuard.js already blocks
// for local git commits (see sandbox-commit-msg-hook.cjs) -- gh's own
// free-form PR text never goes through a git hook at all, so without this a
// naive `gh pr create --body "...Claude-Session: ..."` would sail straight
// through the allow-list check above untouched. Only active when the caller
// (sandbox.js) passes startGitBroker() a non-null blockedPatterns (i.e.
// commitMessageGuard.enabled); omitted entirely, this is a no-op, same as
// before plan8.

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, createConnection } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeGitAllowlist, normalizeGitUrl, resolveOriginUrl } from './gitAllowlist.js';
import { classifyGhInvocation, extractGhTextFields, findBlockedGhFileArg } from './ghAllowlist.js';
import { buildGuardConfig, compilePatterns, findBlockedMatch } from './commitGuard.js';
import { classifyGhUsage, recordGhUsage } from '../ghUsageRecording.js';

const GH_EXEC_TIMEOUT_MS = 30_000;
const GH_EXEC_MAX_BYTES = 10 * 1024 * 1024;

const __filename = fileURLToPath(import.meta.url);

const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
// Host runtime dir for broker sockets and other per-launch state.
// XDG_RUNTIME_DIR wins when set; otherwise Linux uses /run/user/<uid> while
// macOS -- which has no /run -- falls back to a short /tmp base. NOT the
// per-user tmpdir (/var/folders/... is ~50 chars on its own): broker socket
// names (ccserver-git-broker-<uuid>/broker.sock,
// ccserver-mcp-<id>-<tag>) appended to it would exceed darwin's 104-byte
// sockaddr_un.sun_path limit and every bind would fail. /tmp is sticky
// (1777); every caller mkdirs the per-UID dir 0o700.
export function hostRuntimeDir() {
  if (process.env.XDG_RUNTIME_DIR) return process.env.XDG_RUNTIME_DIR;
  if (process.platform === 'darwin') return `/tmp/ccserver-runtime-${UID}`;
  return `/run/user/${UID}`;
}

// Create (and verify) the per-UID runtime dir. mkdirSync's mode option never
// fixes a pre-existing dir: on darwin the fallback base lives under the
// sticky, world-writable /tmp, where another local user can pre-create it
// (e.g. 0777) before our first bind -- the window reopens after every reboot
// and macOS's periodic /tmp cleanup. Binding sockets into a hostile dir lets
// its owner unlink/replace them (broker impersonation, credential theft), so
// fail closed unless THIS uid owns a private 0700 dir. Linux's
// /run/user/<uid> is root-owned via logind and needs no check (and an
// XDG_RUNTIME_DIR override is the operator's explicit responsibility).
export function ensureHostRuntimeDir() {
  const base = hostRuntimeDir();
  if (process.platform !== 'darwin' || process.env.XDG_RUNTIME_DIR) return base;
  mkdirSync(base, { recursive: true, mode: 0o700 });
  let st = statSync(base);
  // mkdirSync's mode option never fixes a PRE-existing dir. When THIS uid
  // already owns it, a too-loose mode (a past run's 0755, an earlier tool,
  // a lax host umask) is ours to correct -- self-heal to 0700 rather than
  // throwing on every sandbox / MCP-broker launch on the host until the dir
  // is deleted by hand (mcpBroker.js deliberately propagates this throw, so
  // a non-heal here bricks that feature). A dir owned by ANOTHER uid is
  // still refused: binding sockets
  // into a dir its owner can unlink/replace is the exact threat this guard
  // exists for, and chmod cannot take ownership.
  if (st.uid === UID && (st.mode & 0o777) !== 0o700) {
    try { chmodSync(base, 0o700); } catch { /* fall through to the throw */ }
    st = statSync(base);
  }
  if (st.uid !== UID || (st.mode & 0o777) !== 0o700) {
    throw new Error(
      `host runtime dir is not a private 0700 dir owned by uid ${UID}: ${base} `
      + `(owner uid ${st.uid}, mode ${(st.mode & 0o777).toString(8)}); `
      + 'remove it or fix its ownership/permissions, then relaunch',
    );
  }
  return base;
}
function runtimeBase() {
  return hostRuntimeDir();
}

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

    // A pipe's failures are emitted on the PIPE, not on the ChildProcess, so
    // the handler above does not cover them -- and they are asynchronous, so
    // a try/catch around the write cannot either. Unhandled, they take this
    // whole broker process down, and with it every git and gh call for the
    // session it serves. network-broker.js guards its own child's stdin for
    // exactly this reason; gh relay was added later and did not get the same
    // treatment.
    //
    // `gh` closing stdin early is NORMAL, not a fault: a subcommand that does
    // not read stdin exits as soon as it is done, and whatever is still in
    // flight then fails with EPIPE. So a stdin failure is deliberately NOT
    // resolved on. The authoritative outcome of the request is the child's
    // exit code and the output already captured, and both still arrive on
    // 'close'; resolving here instead would throw gh's real answer away and
    // leave the child unreaped. Retrying is not an option either -- these
    // commands are not idempotent (a second `pr create` posts twice).
    //
    // It is recorded and logged rather than ignored, because a zero exit
    // after a partial write means gh acted on truncated input, and that is
    // worth being able to see in the broker log.
    let stdinError = null;
    const noteStdinError = (e) => { stdinError ??= e; };
    child.stdin.on('error', noteStdinError);
    // Same class, same consequence, on the read side.
    child.stdout.on('error', noteStdinError);
    child.stderr.on('error', noteStdinError);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (stdinError) {
        process.stdout.write(`[git-broker] gh-exec stdin did not finish writing (${stdinError.code || stdinError.message}); gh exited ${code}\n`);
      }
      finish({
        ok: true,
        exitCode: typeof code === 'number' ? code : 1,
        stdout: Buffer.concat(out).toString('base64'),
        stderr: Buffer.concat(err).toString('base64'),
      });
    });

    // write()/end() can also fail synchronously (ERR_STREAM_DESTROYED) once
    // the child is gone; funnel that into the same place as the async form.
    try {
      if (stdinBuf && stdinBuf.length) child.stdin.write(stdinBuf);
      child.stdin.end();
    } catch (e) {
      noteStdinError(e);
    }
  });
}

// Checks a gh invocation's title/body fields (see ghAllowlist.js's
// extractGhTextFields): every 'file' field's value must be exactly "-"
// (stdin) -- ANY other value is refused outright, always, regardless of
// commitMessageGuard config (a filesystem boundary, not a content policy) --
// and -- only when commitMessageGuard patterns are configured -- every
// field's actual text (literal or stdin) is checked against
// ctx.guardPatterns (compiled once in runServer from the same config used
// for local commits, see commitGuard.js). Returns {field, match, reason}
// for the first blocked value found, or null.
//
// H2 follow-up (review on PR #179, P1 items 2+3): the original fix let a
// --body-file/-F value name any HOST path inside the session tree (checked
// via a lexical-normalize + realpath containment pass), which turned out to
// have two independent holes -- a symlink + trailing ".." combination where
// the checked path and the path gh actually opens diverge, and a
// check-then-reopen race where the session tree (fully agent-writable) can
// swap the checked file for a symlink out of tree between the check and the
// real `gh` invocation. Rather than harden that check further, the file-path
// case is removed entirely: gh's own body/notes-file flags accept "-" for
// stdin, so the sandboxed caller reads the file itself (inside the sandbox,
// where the filesystem boundary is the kernel's, not a userspace check) and
// pipes it in -- e.g. `cat body.md | gh pr comment 123 --body-file -`. No
// host path is ever opened by gh on this field's behalf again.
function findBlockedGhText(req, ctx) {
  const fields = extractGhTextFields(req.argv);
  if (!fields.length) return null;
  const hasGuardPatterns = !!(ctx.guardPatterns && ctx.guardPatterns.length);

  let stdinText;
  const decodeStdin = () => {
    if (stdinText !== undefined) return stdinText;
    try {
      stdinText = req.stdin ? Buffer.from(req.stdin, 'base64').toString('utf-8') : '';
    } catch {
      stdinText = '';
    }
    return stdinText;
  };

  for (const f of fields) {
    let text;
    if (f.kind === 'literal') {
      if (!hasGuardPatterns) continue;
      text = f.value;
    } else if (f.kind === 'file') {
      if (f.value !== '-') {
        return { field: f.field, match: { source: 'host file paths are not accepted; use stdin' }, reason: 'file-arg-requires-stdin' };
      }
      if (!hasGuardPatterns) continue;
      text = decodeStdin();
    }
    const match = findBlockedMatch(text, ctx.guardPatterns);
    if (match) return { field: f.field, match };
  }
  return null;
}

async function handleGhExec(req, conn, ctx) {
  const record = (result, denial = null) => recordGhUsage({ client: ctx.app, ...classifyGhUsage(req.argv), result, denial });
  if (!Array.isArray(req.argv) || !req.argv.every((a) => typeof a === 'string')) {
    record('cli-error', 'bad-request');
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
    record('cli-error', subReason);
    process.stdout.write(`[git-broker] gh-exec ${req.argv.join(' ')} -> deny (${subReason})\n`);
    conn.end(`${JSON.stringify({ ok: false, reason: subReason })}\n`);
    return;
  }

  // Host file-argument boundary (H2 follow-up, review on #179): flags/
  // positionals outside TEXT_FIELDS that also name a host path (release
  // create's asset positionals, release download's --dir/--output, workflow
  // run's -F key=@file, --attach, pr checkout --worktree). Independent of
  // the repo allow-list check below -- it's a filesystem boundary, not a
  // repo-scoping decision -- so it runs regardless of which repo(s) this
  // invocation targets.
  const fileArgBlocked = findBlockedGhFileArg(req.argv);
  if (fileArgBlocked) {
    record('cli-error', fileArgBlocked.reason);
    process.stdout.write(`[git-broker] gh-exec ${req.argv.join(' ')} -> deny (${fileArgBlocked.reason})\n`);
    conn.end(`${JSON.stringify({ ok: false, reason: fileArgBlocked.reason, field: fileArgBlocked.field })}\n`);
    return;
  }

  // ALL repo references found in argv (usually one; can be more -- see
  // ghAllowlist.js) must be allow-listed, not just the first/primary one.
  const denied = repos.find((r) => !ctx.allowSet.has(r));
  if (denied) {
    record('cli-error', 'not-allowlisted');
    process.stdout.write(`[git-broker] gh-exec ${req.argv.join(' ')} -> deny (repo ${denied} not-allowlisted)\n`);
    conn.end(`${JSON.stringify({ ok: false, reason: 'not-allowlisted' })}\n`);
    return;
  }

  const blocked = findBlockedGhText(req, ctx);
  if (blocked) {
    const reason = blocked.reason || 'blocked-message';
    record('cli-error', reason);
    process.stdout.write(`[git-broker] gh-exec ${req.argv.join(' ')} -> deny (${reason} in --${blocked.field}: ${blocked.match.source})\n`);
    conn.end(`${JSON.stringify({ ok: false, reason, field: blocked.field })}\n`);
    return;
  }

  process.stdout.write(`[git-broker] gh-exec ${req.argv.join(' ')} -> allow (repo(s) ${repos.join(', ')})\n`);
  const stdinBuf = req.stdin ? Buffer.from(req.stdin, 'base64') : null;
  const result = await execGh(req.argv, ctx.cwd, stdinBuf);
  // execGh failures are broker-side results, not policy denials: `timeout`
  // keeps its own result category, and a spawn failure (gh missing or not
  // runnable on the host) is broker-unavailable. cli-error is reserved for a
  // gh process that actually ran and exited non-zero. Passing these reasons
  // as `denial` would file them under broker-denied:*, which is only for the
  // fixed allow-list/guard refusals above.
  const outcome = result.ok
    ? (result.exitCode === 0 ? 'success' : 'cli-error')
    : (result.reason === 'timeout' ? 'timeout' : 'broker-unavailable');
  record(outcome);
  conn.end(`${JSON.stringify(result)}\n`);
}

// Constant-time compare that never throws and rejects length mismatches
// (timingSafeEqual requires equal-length buffers).
function tokenEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}

function handleRequest(line, conn, ctx) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    conn.end(`${JSON.stringify({ ok: false, reason: 'bad-request' })}\n`);
    return;
  }
  // Connection auth: on macOS Seatbelt this socket sits in a shared /tmp dir
  // reachable by every concurrent sandboxed session (bwrap binds it per-session
  // so this is belt-and-suspenders there). The per-session token (delivered to
  // the sandbox via CCSANDBOX_GIT_BROKER_TOKEN) keeps an unauthorized connect()
  // from borrowing another session's repo-scoped credentials -- but on macOS it
  // is an audit / accident-prevention layer, NOT a hard boundary: a same-UID
  // peer session can still recover this token by reading the target's env via
  // the numeric-MIB KERN_PROCARGS2 (unblockable under Seatbelt -- see
  // sandbox-seatbelt.js's KNOWN LIMITATION). The real boundary there is the
  // repo-scoped allow-list below. Fail closed: no configured token rejects
  // everything.
  if (!tokenEq(req && req.token, ctx.token)) {
    conn.end(`${JSON.stringify({ ok: false, reason: 'unauthorized' })}\n`);
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

function runServer({ sock, allowlist, cwd, commitGuard, app }) {
  let allowSet;
  try {
    allowSet = new Set(JSON.parse(readFileSync(allowlist, 'utf-8')));
  } catch {
    allowSet = new Set(); // fail closed if the allow-list can't be read
  }
  // PR-body guard patterns (see findBlockedGhText above): unlike the
  // allow-list, this fails OPEN -- a missing/unreadable/corrupt commitGuard
  // file means no PR-body check at all, not "block every gh-exec". This
  // guard exists to catch accidental leaks, not to gate access; an
  // availability failure here must never take gh down entirely.
  let guardPatterns = [];
  if (commitGuard) {
    try {
      const { patterns } = JSON.parse(readFileSync(commitGuard, 'utf-8'));
      guardPatterns = compilePatterns(Array.isArray(patterns) ? patterns : []);
    } catch {
      guardPatterns = [];
    }
  }
  // Per-session connection token (see handleRequest). Delivered via env, not
  // argv: the broker process is unsandboxed, but keeping it out of the command
  // line avoids incidental exposure via crash reports / process listings.
  const ctx = { allowSet, cwd, guardPatterns, app, token: process.env.CCSANDBOX_BROKER_TOKEN || '' };

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

// Readiness probe: connect to the socket and confirm the broker actually
// speaks the protocol (and accepts our token), rather than trusting that the
// socket file appearing means it is serving.
//
// This used to run the same handshake inside a FRESH NODE PROCESS via
// execFileSync, on a fixed 500ms budget. That was the single most expensive
// thing about starting a broker, and almost none of the 500ms was the probe:
// under 8x CPU oversubscription `node -e 'process.exit(0)'` alone takes
// 374-717ms to boot, so the budget could expire before the probe script had
// even started running. Measured on this host, that is what actually failed
// under load -- 6/20 launches on master and 4/20 on the first cut of this
// branch died here with "readiness probe failed", NOT on the socket wait
// this PR had already fixed (#248).
//
// The child process was only ever there because startGitBroker was
// synchronous and could not await a socket. It is async now (see the wait
// above), so the parent can just speak the protocol itself -- which is what
// network-broker.js's probeBroker already does. Removing the child removes
// the cost that was blowing the budget, instead of raising the budget to
// cover it.
function probeBrokerReady(sockPath, timeoutMs, token = '') {
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    // A complete line means the broker answered. The probe always sends the
    // real token, so a well-formed non-'unauthorized' reply = ready + authed.
    const verdict = () => buf.includes('\n') && !buf.includes('"unauthorized"');
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.destroy(); } catch { /* already gone */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const conn = createConnection(sockPath);
    conn.on('connect', () => {
      try { conn.write(`${JSON.stringify({ op: 'probe', token })}\n`); } catch { finish(false); }
    });
    conn.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) finish(verdict());
    });
    conn.on('error', () => finish(false));
    conn.on('close', () => finish(verdict()));
  });
}

// Compute the allow-list once and launch a fresh broker instance for a
// sandbox session. Returns null (no broker) if the allow-list ends up
// empty for a non-git cwd — callers should treat that the same as
// "gitBroker disabled" for that launch. For a git repo, startup is a
// required dependency: socket existence, child liveness and a readiness
// probe are all verified. On failure the child is terminated, the runtime
// dir removed and a descriptive error is thrown so buildSandboxSpawn can
// propagate it to createSession (launch fails clearly instead of leaving a
// sandboxed session with an unmounted broker socket showing
// "gh broker unreachable").
//
// blockedPatterns (plan8): the operator's own commitMessageGuard.
// blockedPatterns from sandbox.config.json, or null when commitMessageGuard
// is disabled. Passing null (the default) skips the PR-body guard file
// entirely -- gh-exec behaves exactly as before plan8. When given (even an
// empty array, meaning "just the commitGuard.js built-ins"), it's merged via
// buildGuardConfig() and written next to allowlist.json so the spawned
// --serve instance can load it; a write failure here only disables the
// PR-body guard for this launch (logged, not thrown) -- unlike the
// allow-list above, this is a best-effort accident-prevention layer, not a
// credential-scoping boundary the launch must refuse to proceed without.
// How long a freshly spawned host-side broker gets to publish the artifact
// that proves it is up: git's unix socket, network's port file (#248).
//
// Both were a fixed 2s. That is not a budget for the broker's own work -- it
// is a bet on how much CPU the host has spare, and on a busy machine the bet
// loses: #248 collected 31 "socket not ready within 2s" and 9 "port file not
// ready within 2s" failures inside single full-suite runs.
//
// Measured here (8 cores, timing startGitBroker to its socket appearing):
//
//     idle                    p50  155ms   max   163ms   0/12 over 2s
//     3x oversubscribed CPU   p50  781ms   max  1086ms   0/12 over 2s
//     8x oversubscribed CPU   p50 1803ms   max  2398ms   2/10 over 2s
//
// So the work itself is ~150ms and 2s was never the cost of doing it -- it
// was roughly the point where ordinary parallel load crosses over, which is
// why the suite reddened rather than the feature breaking. 10s sits ~4x above
// the measured tail at the load that actually reproduces the failure, ~64x
// above the idle median, and matches the smallest of the startup tests' own
// budgets, so the repo has one answer to "a spawned node should be up by now".
//
// It only bounds the FAILURE path -- a healthy broker resolves as soon as its
// artifact appears, so raising this costs a working host nothing. What it
// buys is that a loaded host creates the session instead of refusing it. The
// cost of being wrong is bounded too, and only now: both waits are async, so
// 10s of waiting delays this one session rather than the whole server.
const BROKER_STARTUP_BUDGET_MS = 10_000;

// Read per call rather than captured at module load, so a test can pin a
// short budget around a deliberately-hung child instead of paying the
// production value (see network-broker.test.js).
export function brokerStartupBudgetMs() {
  const raw = Number(process.env.CCSERVER_BROKER_STARTUP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : BROKER_STARTUP_BUDGET_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls `probe` until it returns something truthy, the child dies, or the
// budget runs out; resolves `{ value, waitedMs }` either way and never throws.
// Shared by both brokers so "how long do we wait, and when do we stop early"
// has one answer (#248).
export async function awaitBrokerReady({ probe, isDead, budgetMs, pollMs = 20 }) {
  const started = Date.now();
  let value = probe();
  while (!value && Date.now() - started < budgetMs) {
    if (isDead()) break;
    await sleep(pollMs);
    value = probe();
  }
  return { value, waitedMs: Date.now() - started };
}

// One shape for both brokers' launch failures. The cases have to stay
// distinguishable: an operator reading this line needs to know whether the
// child crashed (exit code), was killed (signal), or was simply still
// starting when time ran out -- only the last one is the load problem #248 is
// about, and only that one is fixed by giving it longer. The old text ("socket
// not ready within 2s") could not tell them apart, so every cause read as the
// same dead end.
export function brokerStartFailureReason({ spawnError, proc, waitedMs, budgetMs, waitingFor }) {
  if (spawnError) return spawnError.message;
  if (proc.exitCode !== null) {
    return `exited code=${proc.exitCode} after ${waitedMs}ms, while ccserver was waiting for ${waitingFor}`;
  }
  if (proc.signalCode) {
    return `terminated signal=${proc.signalCode} after ${waitedMs}ms, while ccserver was waiting for ${waitingFor}`;
  }
  // Kept short on purpose: #222 pins a bound on this whole string so an
  // unusable port file cannot turn a log line into a payload, and the fixed
  // wording here spends part of that budget.
  return `timed out after ${waitedMs}ms waiting for ${waitingFor} (budget ${budgetMs}ms); `
    + `the broker (pid ${proc.pid}) was still alive, so it was too slow rather than broken `
    + '-- raise CCSERVER_BROKER_STARTUP_TIMEOUT_MS on a loaded host';
}

// `spawnProcess` is injectable for the same reason network-broker.js makes it
// injectable: the launch FAILURE paths (a child that dies at once, a child
// that never publishes its socket) cannot be produced with the real broker,
// and they are the paths #248 is about.
export async function startGitBroker(
  { cwd, app = 'shell', blockedPatterns = null, ghUsageRecording = null },
  { spawnProcess = spawn } = {},
) {
  const allowlist = computeGitAllowlist(cwd);
  if (!allowlist || allowlist.length === 0) return null;

  const dir = join(runtimeBase(), `ccserver-git-broker-${randomUUID()}`);
  try {
    ensureHostRuntimeDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new Error(`git broker failed to start for ${cwd}: ${e.message}`);
  }
  const allowlistPath = join(dir, 'allowlist.json');
  const sockPath = join(dir, 'broker.sock');
  try {
    writeFileSync(allowlistPath, JSON.stringify(allowlist));
  } catch (e) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    throw new Error(`git broker failed to start for ${cwd}: ${e.message}`);
  }

  let commitGuardPath = null;
  if (blockedPatterns !== null) {
    try {
      commitGuardPath = join(dir, 'commit-guard.json');
      writeFileSync(commitGuardPath, JSON.stringify(buildGuardConfig(blockedPatterns)));
    } catch (e) {
      console.warn(`[git-broker] failed to write PR-body guard config for ${cwd}: ${e.message} (gh PR bodies will not be checked this session)`);
      commitGuardPath = null;
    }
  }

  // Per-session connection token: the sandbox gets it via
  // CCSANDBOX_GIT_BROKER_TOKEN, the --serve child via CCSANDBOX_BROKER_TOKEN.
  // A concurrent session with no/wrong token is rejected with
  // reason:"unauthorized" (see handleRequest -- on macOS this is an audit
  // layer, not a hard boundary, since KERN_PROCARGS2 leaks the token to a
  // same-UID peer).
  const token = randomBytes(24).toString('base64url');
  const serveArgs = [__filename, '--serve', '--sock', sockPath, '--allowlist', allowlistPath, '--cwd', cwd, '--app', app];
  if (commitGuardPath) serveArgs.push('--commit-guard', commitGuardPath);
  const proc = spawnProcess(process.execPath, serveArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CCSANDBOX_BROKER_TOKEN: token,
      CCSERVER_GH_USAGE_RECORDING: ghUsageRecording?.enabled === true ? '1' : '0',
      CCSERVER_GH_USAGE_RECORDING_FILE: ghUsageRecording?.enabled === true ? ghUsageRecording.file : '',
    },
  });

  proc.stdout.on('data', (d) => process.stdout.write(`[git-broker] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[git-broker] ${d}`));

  let spawnError = null;
  proc.on('error', (err) => { spawnError = err; });
  // Lifecycle observability: log unexpected exit after readiness
  proc.on('exit', (code, signal) => {
    // Only log unexpected exits; normal teardown kills with SIGTERM
    if (code !== 0 && code !== null) {
      process.stderr.write(`[git-broker] broker for ${cwd} (pid ${proc.pid}) exited code=${code} signal=${signal}\n`);
    } else if (signal) {
      process.stderr.write(`[git-broker] broker for ${cwd} (pid ${proc.pid}) terminated signal=${signal}\n`);
    }
  });

  // bwrap's --bind-try only sees the socket if it already exists at
  // mount-namespace setup time -- a moment after this function returns.
  // Without waiting here the broker would silently lose the race: bwrap would
  // launch before the socket file exists, and the sandbox would never see it
  // (bind is a one-time snapshot, not a live mount). So the socket must be
  // there before we return.
  //
  // That is an ORDERING requirement, and `await` satisfies it exactly as well
  // as blocking did. This used to be a synchronous Atomics.wait busy-wait,
  // justified by a comment saying buildSandboxSpawn was synchronous; it is
  // not, and has not been since network-broker's H1 review made it async --
  // sandbox.js already awaits startNetworkBroker a few lines away. Holding
  // the main thread here was therefore buying nothing, and #248 raised the
  // budget from 2s to 10s, which would have turned the worst case into a 10s
  // event-loop freeze with the SIGTERM handler wedged behind it -- the same
  // sync-blocking shape #212/#252 are closing elsewhere. Async instead: the
  // ordering still holds, and two sessions starting at once no longer
  // serialise behind each other's broker spawn.
  const budgetMs = brokerStartupBudgetMs();
  const startedAt = Date.now();
  const { value: ready, waitedMs } = await awaitBrokerReady({
    probe: () => existsSync(sockPath),
    isDead: () => spawnError !== null || proc.exitCode !== null || proc.signalCode !== null,
    budgetMs,
  });

  if (spawnError || proc.exitCode !== null || proc.signalCode !== null || !ready) {
    const reason = brokerStartFailureReason({
      spawnError, proc, waitedMs, budgetMs, waitingFor: `the broker socket ${sockPath}`,
    });
    try { proc.kill('SIGKILL'); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    throw new Error(`git broker failed to start for ${cwd}: ${reason}`);
  }

  // The probe shares ONE deadline with the socket wait above, rather than
  // adding a second budget after it: "the broker is up and answering" is a
  // single question, and two stacked budgets would make the real worst case
  // twice what CCSERVER_BROKER_STARTUP_TIMEOUT_MS says. The floor is not a
  // tuned budget -- it just means a socket that appeared in the last
  // milliseconds of the budget still gets a real attempt instead of a 0ms one.
  const probeBudgetMs = Math.max(budgetMs - (Date.now() - startedAt), 250);
  const probeStartedAt = Date.now();
  const probed = await probeBrokerReady(sockPath, probeBudgetMs, token);
  if (!probed) {
    try { proc.kill('SIGKILL'); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    const alive = proc.exitCode === null && proc.signalCode === null;
    throw new Error(
      `git broker readiness probe failed for ${cwd}: the socket ${sockPath} exists but the broker `
      + `did not answer within ${Date.now() - probeStartedAt}ms `
      + (alive
        ? '(the process was still alive, so it was too slow rather than broken -- '
          + 'raise CCSERVER_BROKER_STARTUP_TIMEOUT_MS on a loaded host)'
        : `(the process is gone: exitCode=${proc.exitCode} signal=${proc.signalCode})`),
    );
  }

  return { proc, dir, sockPath, allowlistPath, allowlist, commitGuardPath, token };
}

// Entry point when this file is spawned directly by startGitBroker().
function parseServeArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sock') out.sock = argv[++i];
    else if (argv[i] === '--allowlist') out.allowlist = argv[++i];
    else if (argv[i] === '--cwd') out.cwd = argv[++i];
    else if (argv[i] === '--app') out.app = argv[++i];
    else if (argv[i] === '--commit-guard') out.commitGuard = argv[++i];
  }
  return out;
}

// process.argv[1] === __filename matters because network-broker.js imports
// helpers from this module and also uses '--serve' as its own argv[2]: without
// this check, every network-broker child process would inadvertently run this
// module's runServer() too (see network-broker.js's matching guard).
if (process.argv[2] === '--serve' && process.argv[1] === __filename) {
  runServer(parseServeArgs(process.argv.slice(3)));
}
