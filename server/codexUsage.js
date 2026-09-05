// Background "Codex usage" reader. Unlike Claude (which has no non-interactive
// usage API and must be screen-scraped via `--ax-screen-reader`, see
// server/usage.js), the Codex CLI exposes rate-limit data through its
// `codex app-server` JSON-RPC protocol: spawn it, `initialize`, then call
// `account/rateLimits/read` to get the same primary/secondary usage windows
// the Codex TUI's own status line shows. No pty, no TUI navigation, no trust
// dialog. The result is cached so the client's top-bar Usage button can show
// it instantly; a forced refresh re-captures on demand.
//
// The capture runs in a *minimal* filesystem sandbox when bwrap is available
// (only Codex's own config is exposed — no project, no docker), falling back
// to launching codex directly otherwise -- unless sandbox.config.json sets
// "forceSandbox": true, in which case the capture fails rather than run
// unsandboxed. Reading rate limits makes no billable API call, so this does
// not itself consume plan usage.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildMinimalSandboxSpawn, resolveApp, sandboxAvailable, loadSandboxConfig, isAppHidden } from './ws/sandbox.js';
import { buildSessionEnv } from './ws/sessionEnv.js';

const CACHE_TTL_MS = 60 * 1000;       // serve cache without re-capturing
const CAPTURE_TIMEOUT_MS = 10 * 1000; // hard cap on a single capture (real round trip is ~100ms)

// A throwaway working directory for the sandboxed capture (kept empty; only
// exists so bwrap has a cwd to bind/chdir into without exposing a real
// project). Codex's app-server doesn't require a git repo cwd just to answer
// account/rateLimits/read (no thread is ever started).
const CODEX_USAGE_CWD = join(homedir(), '.local', 'share', 'ccserver-sandbox', 'codex-usage-cwd');

let cache = null;      // { usage, updatedAt }
let inflight = null;   // Promise<captureResult> while a capture is running

// Codex reports each window's used%/reset/duration but no human label (unlike
// Claude's "Current session" / "Current week (all models)" strings) -- so we
// synthesize one from windowDurationMins.
function windowLabel(mins) {
  if (mins == null) return '使用量';
  if (mins % (24 * 60) === 0) {
    const days = mins / (24 * 60);
    return days === 7 ? '週次' : `${days}日`;
  }
  if (mins % 60 === 0) return `${mins / 60}時間`;
  return `${mins}分`;
}

function formatResets(resetAtMs) {
  if (resetAtMs == null) return null;
  const d = new Date(resetAtMs);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function mapWindow(win, mins) {
  if (!win) return null;
  const resetAt = win.resetsAt != null ? win.resetsAt * 1000 : null;
  const windowMs = mins != null ? mins * 60 * 1000 : null;
  return {
    label: windowLabel(mins),
    pct: win.usedPercent,
    resets: formatResets(resetAt),
    resetAt,
    windowMs,
  };
}

// Turn a GetAccountRateLimitsResponse's `rateLimits` (RateLimitSnapshot) into
// the same shape server/usage.js's parseUsage() produces, so UsageButton.jsx
// needs no app-specific rendering logic. rateLimitsByLimitId, credits and
// rateLimitResetCredits are intentionally not surfaced (v1 scope).
export function mapRateLimits(rateLimits) {
  if (!rateLimits) return { limits: [], cost: null, plan: null };
  const limits = [];
  const primary = mapWindow(rateLimits.primary, rateLimits.primary?.windowDurationMins);
  const secondary = mapWindow(rateLimits.secondary, rateLimits.secondary?.windowDurationMins);
  if (primary) limits.push(primary);
  if (secondary) limits.push(secondary);
  return { limits, cost: null, plan: rateLimits.planType ?? null };
}

// Spawn `codex app-server`, speak newline-delimited JSON-RPC 2.0 over
// stdin/stdout (no Content-Length framing, no pty), and resolve once the
// account/rateLimits/read response (matched by id) arrives.
function capture() {
  return new Promise((resolve) => {
    // Self-review (issue #105): sandbox.config.json's hiddenApps hides codex
    // from every launch picker, but GET /api/usage?app=codex has no launch
    // picker to guard -- a direct call (any authenticated client, or
    // warmCodexUsage() at boot) would otherwise still spawn a real `codex`
    // process even when the operator listed it in hiddenApps specifically
    // because they haven't contracted for it. Refuse the same way the
    // not-installed check below does, mirroring server/usage.js's twin guard.
    // Checked BEFORE resolveApp() below: once codex is hidden, whether it
    // happens to be installed is irrelevant -- and unlike claude, codex has no
    // CCSERVER_*_BIN override to deterministically fake an install with in
    // tests, so this ordering is what makes the guard testable at all.
    if (isAppHidden('codex')) {
      resolve({ error: 'codex is hidden on this server (sandbox.config.json\'s "hiddenApps")' });
      return;
    }
    // codex not installed on this host (or resolveApp pointing at a missing
    // path): a spawn would just fail with execvp/ENOENT. Report the real
    // cause up front -- this also backs the client's automatic Usage-button
    // hiding (availableApps.codex === false via /dirs/home).
    const resolvedCodex = resolveApp('codex');
    if (resolvedCodex.found === false) {
      resolve({ error: 'codex is not installed on this server' });
      return;
    }
    let command = resolvedCodex.command;
    let args = ['app-server'];
    let spawnCwd = homedir();
    let sandboxed = false;

    if (process.platform !== 'win32' && sandboxAvailable()) {
      try {
        mkdirSync(CODEX_USAGE_CWD, { recursive: true });
        const spawnSpec = buildMinimalSandboxSpawn({
          cwd: CODEX_USAGE_CWD,
          targetCommand: ['codex', 'app-server'],
          app: 'codex',
        });
        command = spawnSpec.command;
        args = spawnSpec.args;
        spawnCwd = CODEX_USAGE_CWD;
        sandboxed = true;
      } catch {
        // bwrap launch failed; fall through to the forceSandbox / direct path.
      }
    }

    // forceSandbox (sandbox.config.json) forbids launching the agent outside
    // the sandbox, so the direct-launch fallback below is not allowed -- fail
    // the capture with a clear error instead of running codex unsandboxed.
    if (!sandboxed && loadSandboxConfig().forceSandbox) {
      resolve({ error: 'Cannot read usage: "forceSandbox": true but the sandbox is unavailable (bwrap missing / Windows)' });
      return;
    }

    // Drop server-only env (NODE_ENV, PORT, CCSERVER_*, forwarded ssh-agent);
    // see ws/sessionEnv.js.
    const cleanEnv = buildSessionEnv();

    let proc;
    try {
      proc = spawn(command, args, {
        cwd: spawnCwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...cleanEnv },
      });
    } catch (err) {
      resolve({ error: `Failed to launch codex: ${err.message}`, sandboxed });
      return;
    }

    let buf = '';
    let done = false;
    let hardTimer = null;

    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      try { proc.kill(); } catch { /* already gone */ }
      resolve({ ...res, sandboxed });
    };

    proc.on('error', (err) => finish({ error: `Failed to launch codex: ${err.message}` }));

    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 2) continue; // ignore the initialize response (id 1) and any stray notifications
        if (msg.error) {
          finish({ error: msg.error.message || 'codex reported an error reading rate limits' });
        } else {
          finish({ usage: mapRateLimits(msg.result?.rateLimits) });
        }
      }
    });

    sendRequests(proc);

    hardTimer = setTimeout(() => finish({ error: 'Timed out reading codex rate limits' }), CAPTURE_TIMEOUT_MS);
  });
}

// Pipeline both JSON-RPC requests to stdin right away -- codex processes them
// in order, so there's no need to wait for the initialize response before
// sending the next one.
function sendRequests(proc) {
  try {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'ccserver', version: '0.0.1' } } })}\n`);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' })}\n`);
  } catch {
    // dead pipe; the process's own 'error'/'exit' handling covers this
  }
}

// Return the latest codex usage, capturing if the cache is missing/stale (or
// forced). Concurrent callers share a single in-flight capture.
export async function getCodexUsage({ force = false } = {}) {
  const fresh = cache && Date.now() - cache.updatedAt < CACHE_TTL_MS;
  if (!force && fresh) {
    return { usage: cache.usage, updatedAt: cache.updatedAt, cached: true };
  }

  if (!inflight) {
    inflight = capture()
      .then((res) => {
        inflight = null;
        if (res.usage && res.usage.limits && res.usage.limits.length) {
          cache = { usage: res.usage, updatedAt: Date.now() };
        }
        return res;
      })
      .catch((err) => {
        inflight = null;
        return { error: String(err?.message || err) };
      });
  }

  const res = await inflight;

  if (res.usage && res.usage.limits && res.usage.limits.length) {
    return {
      usage: res.usage,
      updatedAt: cache ? cache.updatedAt : Date.now(),
      sandboxed: res.sandboxed,
      cached: false,
    };
  }

  // Capture failed; fall back to a stale cache if we have one.
  if (cache) {
    return { usage: cache.usage, updatedAt: cache.updatedAt, cached: true, error: res.error };
  }
  return { usage: null, error: res.error || 'Could not read codex usage', sandboxed: res.sandboxed };
}

// Best-effort cache warm at server startup so the first click is instant.
export function warmCodexUsage() {
  getCodexUsage({ force: true }).catch(() => { /* best effort */ });
}
