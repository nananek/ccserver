// Background "Claude usage" reader. Launches `claude --ax-screen-reader` (which
// renders the TUI as flat, screen-reader-friendly text), types `/usage`, scrapes
// the rendered dashboard, and parses out the plan limits (session / weekly
// percentages + reset times) plus session cost. The result is cached so the
// client's top-bar Usage button can show it instantly; a forced refresh
// re-captures on demand.
//
// The capture runs in a *minimal* filesystem sandbox when bwrap is available
// (only Claude's own config is exposed — no project, no docker), falling back to
// launching claude directly otherwise. Viewing /usage makes no API call, so this
// does not itself consume plan usage.
import * as pty from 'node-pty';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildMinimalSandboxSpawn, sandboxAvailable } from './ws/sandbox.js';

const CACHE_TTL_MS = 60 * 1000;       // serve cache without re-capturing
const CAPTURE_TIMEOUT_MS = 15 * 1000; // hard cap on a single capture
const BOOT_DELAY_MS = 3000;           // wait for claude's TUI to come up before typing
const SETTLE_MS = 900;                // quiet period after the dashboard looks ready

// A throwaway working directory for the sandboxed capture (kept empty; only
// exists so bwrap has a cwd to bind/chdir into without exposing a real project).
const USAGE_CWD = join(homedir(), '.local', 'share', 'ccserver-sandbox', 'usage-cwd');

let cache = null;      // { usage, updatedAt }
let inflight = null;   // Promise<captureResult> while a capture is running

function stripRender(raw) {
  return String(raw)
    // OSC (window title etc.): ESC ] ... BEL / ST
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    // CSI sequences
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    // charset / misc single-char escapes
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\x1b[>=<]/g, '')
    .replace(/\r/g, '\n');
}

// Parse the flat screen-reader dashboard. The limit blocks look like:
//   Current session
//   87% 87% used
//   Resets 5:40pm (Asia/Tokyo)
//   Current week (all models)
//   46% 46% used
//   Resets Jul 10, 2am (Asia/Tokyo)
export function parseUsage(raw) {
  const clean = stripRender(raw);
  const lines = clean.split('\n').map((l) => l.trim());

  const limits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\d+)%\s+\d+%\s+used$/) || lines[i].match(/^(\d+)%\s+used$/);
    if (!m) continue;
    const pct = Number(m[1]);

    // Label: nearest preceding real line that isn't a percentage / reset line.
    let label = null;
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      const t = lines[j];
      if (!t || /used$/.test(t) || /^Resets/.test(t)) continue;
      label = t;
      break;
    }
    if (!label) continue;

    // Reset time: the next "Resets ..." line before the next limit block.
    let resets = null;
    for (let k = i + 1; k < Math.min(lines.length, i + 4); k++) {
      if (/^Resets/.test(lines[k])) { resets = lines[k].replace(/^Resets\s*/, '').trim(); break; }
      if (/used$/.test(lines[k])) break;
    }

    limits.push({ label, pct, resets });
  }

  // The screen re-renders as data streams in; keep the last block per label.
  const byLabel = new Map();
  for (const l of limits) byLabel.set(l.label, l);

  const cost = (clean.match(/Total cost:\s*(\$\S+)/) || [])[1] || null;
  const plan = (clean.match(/·\s*(Claude (?:Max|Pro|Team|Enterprise|Free)[^\n·]*)/) || [])[1]?.trim() || null;

  return { limits: [...byLabel.values()], cost, plan };
}

// A capture is "ready" once at least the session + one weekly limit have
// rendered with a reset time — enough to stop waiting for the slow tail
// ("Scanning local sessions…" etc.).
function looksReady(parsed) {
  return parsed.limits.length >= 2 && parsed.limits.some((l) => l.resets);
}

function capture() {
  return new Promise((resolve) => {
    let command = process.platform === 'win32' ? 'claude.exe' : 'claude';
    let args = ['--ax-screen-reader'];
    let spawnCwd = homedir();
    let sandboxed = false;

    if (process.platform !== 'win32' && sandboxAvailable()) {
      try {
        mkdirSync(USAGE_CWD, { recursive: true });
        const spawn = buildMinimalSandboxSpawn({
          cwd: USAGE_CWD,
          targetCommand: ['claude', '--ax-screen-reader'],
        });
        command = spawn.command;
        args = spawn.args;
        spawnCwd = USAGE_CWD;
        sandboxed = true;
      } catch {
        // fall back to launching claude directly
      }
    }

    // Drop any forwarded ssh-agent env; irrelevant here and can confuse tools.
    const { SSH_AUTH_SOCK, SSH_AGENT_PID, ...cleanEnv } = process.env;

    let ptyProc;
    try {
      ptyProc = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols: 100,
        rows: 40,
        cwd: spawnCwd,
        env: { ...cleanEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
    } catch (err) {
      resolve({ error: `Failed to launch claude: ${err.message}`, sandboxed });
      return;
    }

    let buf = '';
    let done = false;
    let sentUsage = false;
    let bootTimer = null;
    let settleTimer = null;
    let hardTimer = null;

    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(bootTimer);
      clearTimeout(settleTimer);
      clearTimeout(hardTimer);
      try { ptyProc.kill(); } catch { /* already gone */ }
      resolve({ ...res, sandboxed });
    };

    bootTimer = setTimeout(() => {
      try {
        ptyProc.write('/usage');
        setTimeout(() => { try { ptyProc.write('\r'); } catch { /* dead */ } }, 500);
        sentUsage = true;
      } catch {
        finish({ error: 'claude exited before /usage could be sent' });
      }
    }, BOOT_DELAY_MS);

    ptyProc.onData((d) => {
      buf += d;
      if (buf.length > 512 * 1024) buf = buf.slice(-256 * 1024);
      if (!sentUsage) return;
      if (looksReady(parseUsage(buf))) {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => finish({ usage: parseUsage(buf) }), SETTLE_MS);
      }
    });

    ptyProc.onExit(() => finish({ usage: parseUsage(buf) }));

    hardTimer = setTimeout(() => {
      const parsed = parseUsage(buf);
      finish(parsed.limits.length ? { usage: parsed } : { error: 'Timed out reading /usage' });
    }, CAPTURE_TIMEOUT_MS);
  });
}

// Return the latest usage, capturing if the cache is missing/stale (or forced).
// Concurrent callers share a single in-flight capture.
export async function getUsage({ force = false } = {}) {
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
  return { usage: null, error: res.error || 'Could not read usage', sandboxed: res.sandboxed };
}

// Best-effort cache warm at server startup so the first click is instant.
export function warmUsage() {
  getUsage({ force: true }).catch(() => { /* best effort */ });
}
