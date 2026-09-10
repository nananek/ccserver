// Background "Claude usage" reader. Launches `claude --ax-screen-reader` (which
// renders the TUI as flat, screen-reader-friendly text), types `/usage`, scrapes
// the rendered dashboard, and parses out the plan limits (session / weekly
// percentages + reset times) plus session cost. The result is cached so the
// client's top-bar Usage button can show it instantly; a forced refresh
// re-captures on demand.
//
// The capture runs in a *minimal* filesystem sandbox when one is available
// (bwrap on Linux, sandbox-exec on macOS; only Claude's own config is exposed
// — no project, no docker), falling back to launching claude directly
// otherwise -- unless sandbox.config.json sets "forceSandbox": true, in which
// case the capture fails rather than run unsandboxed. Viewing /usage makes no
// API call, so this does not itself consume plan usage.
import * as pty from 'node-pty';
import { homedir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildMinimalSandboxSpawn, resolveClaude, sandboxAvailable, loadSandboxConfig, isAppHidden, forceSandboxUnavailableReason } from './ws/sandbox.js';
import { recordSessionLimitReset } from './sessionLimitState.js';
import { buildSessionEnv } from './ws/sessionEnv.js';

const CACHE_TTL_MS = 60 * 1000;       // serve cache without re-capturing
// The first capture can include Claude startup, the project trust prompt, and
// a network-backed usage refresh. Fifteen seconds is too short for that path.
const CAPTURE_TIMEOUT_MS = 30 * 1000; // hard cap on a single capture
const BOOT_DELAY_MS = 3000;           // wait for claude's TUI to come up before typing
const SETTLE_MS = 900;                // quiet period after the dashboard looks ready
const TRUST_SETTLE_MS = 1500;         // let the UI replace the trust dialog before typing

// A cwd claude hasn't seen before shows a "trust this folder" gate that would
// otherwise swallow the /usage command. Detected in the rendered text.
// The sandboxed capture uses a throwaway USAGE_CWD (below), so it hits this
// gate while an unsandboxed capture in an already-trusted $HOME does not --
// a missed variant here surfaces as a sandbox-only "Timed out reading /usage"
// with the process still alive. Keep the alternation conservative (dashboard
// text must never match it and cause a stray 'y' + Enter into a live prompt).
const TRUST_RE = /trust this (?:folder|directory|project)|do you trust|enter y\/n/i;

// Exported for unit tests (pure): does the rendered screen show the trust gate?
export function isTrustPrompt(text) {
  return TRUST_RE.test(stripRender(text));
}

// Pure decision for the /usage send/resend loop (tested directly; the pty
// closure below applies the counter mutation the caller owns). `force` (the
// post-trust send) always sends and never hits this. Returns { send, reason }.
export function usageSendGate({
  resend = false, sentUsage = false, resends = 0, maxResends = 2,
  trustShowing = false, dashboardPresent = false,
} = {}) {
  if (!resend) {
    // Initial send: exactly once.
    return sentUsage ? { send: false, reason: 'already-sent' } : { send: true, reason: 'initial' };
  }
  if (resends >= maxResends) return { send: false, reason: 'capped' };
  if (trustShowing) return { send: false, reason: 'trust-gate' }; // its own y/n flow drives the send
  if (dashboardPresent) return { send: false, reason: 'dashboard-ready' };
  return { send: true, reason: 'resend' };
}

// Screen tail attached to the timeout result so the next "Timed out" report
// carries what claude was actually showing (trust gate? login? blank?).
// Pure: tested directly, no spawn involved.
export const TIMEOUT_SCREEN_TAIL_LEN = 800;
export function buildTimeoutError(buf, { sandboxed = false, sentUsage = false, trustHandled = false, resends = 0 } = {}) {
  const screenTail = stripRender(buf).slice(-TIMEOUT_SCREEN_TAIL_LEN);
  return { error: 'Timed out reading /usage', screenTail, sandboxed, sentUsage, trustHandled, resends };
}

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

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Turn a reset string into an absolute epoch (ms) so the client can plot how far
// through the current window we are. Handles the two shapes claude emits:
//   "5:40pm (Asia/Tokyo)"       -> time only (session): next occurrence
//   "Jul 10, 2am (Asia/Tokyo)"  -> date + time (week)
// The timezone label is dropped; times are read as the server's local time,
// which matches the user's zone in practice. Returns null if unparseable.
function parseResetTime(resets, now) {
  if (!resets) return null;
  const s = resets.replace(/\s*\([^)]*\)\s*$/, '').trim(); // strip "(Asia/Tokyo)"

  let month = null;
  let day = null;
  let rest = s;
  const md = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(.*)$/);
  if (md && MONTHS[md[1].slice(0, 3).toLowerCase()] !== undefined) {
    month = MONTHS[md[1].slice(0, 3).toLowerCase()];
    day = parseInt(md[2], 10);
    rest = md[3];
  }

  const tm = rest.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!tm) return null;
  let hour = parseInt(tm[1], 10);
  const min = tm[2] ? parseInt(tm[2], 10) : 0;
  const ap = tm[3].toLowerCase();
  if (ap === 'pm' && hour !== 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;

  const base = new Date(now);
  const d = new Date(
    base.getFullYear(),
    month != null ? month : base.getMonth(),
    day != null ? day : base.getDate(),
    hour, min, 0, 0,
  );
  if (month != null) {
    // Dated reset: bump a year on wrap (e.g. a Jan reset seen in December).
    if (d.getTime() < now - 24 * 3600 * 1000) d.setFullYear(d.getFullYear() + 1);
  } else if (d.getTime() <= now) {
    // Time-only reset already past today -> it's tomorrow.
    d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

// Length of each usage window, so the client can place an "on-pace" marker.
// Claude's session limit is a rolling 5h window; weekly limits reset every 7d.
function windowFor(label) {
  if (/week/i.test(label)) return 7 * 24 * 3600 * 1000;
  if (/session/i.test(label)) return 5 * 3600 * 1000;
  return null;
}

// Parse the flat screen-reader dashboard. The limit blocks look like:
//   Current session
//   87% 87% used
//   Resets 5:40pm (Asia/Tokyo)
//   Current week (all models)
//   46% 46% used
//   Resets Jul 10, 2am (Asia/Tokyo)
// Recognized block-header shapes (see the comment above the label-detection
// loop below for why the label is extracted via this pattern, not taken verbatim).
const LABEL_RE = /Current (?:session|week(?:\s*\([^)]*\))?)/i;

export function parseUsage(raw) {
  const clean = stripRender(raw);
  const lines = clean.split('\n').map((l) => l.trim());

  const limits = [];
  for (let i = 0; i < lines.length; i++) {
    // A redraw race can glue two whole blocks onto the same physical line
    // with no newline between them (e.g. "87% 87% used46% 46% used"). Since
    // the percent match below is no longer anchored at line-start, matching
    // it anyway would silently bind the LAST block's percentage to the
    // FIRST block's label -- bail out on the whole line instead.
    if ((lines[i].match(/\d+%\s+(?:\d+%\s+)?used/g) || []).length > 1) continue;
    const m = lines[i].match(/(\d+)%\s+\d+%\s+used$/) || lines[i].match(/(\d+)%\s+used$/);
    if (!m) continue;
    const pct = Number(m[1]);
    // A leftover UI prefix ending in a digit (e.g. a stray "42" glued onto
    // "87% 87% used") merges into the digit run above. Usage percentages
    // are bounded by definition, so an out-of-range value is corruption --
    // drop the block rather than show an impossible number.
    if (pct > 100) continue;

    // Label: nearest preceding real line that isn't a percentage / reset
    // line, extracted via the known header patterns rather than taken
    // verbatim. The /usage screen's async re-render (e.g. "Scanning local
    // sessions…" -> "Refreshing…") can glue a leftover status string onto
    // the header line the same way issue #109 found it glued onto
    // percent/Resets lines -- pulling only the recognized "Current session"
    // / "Current week (...)" substring keeps that leftover text out of the
    // label shown to the user. If the nearest candidate line has no
    // recognizable header at all (header not yet rendered), the whole block
    // is dropped rather than showing whatever transient text sits there.
    let label = null;
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      const t = lines[j];
      if (!t || /used$/.test(t) || /Resets(\s|$)/.test(t)) continue;
      const lm = t.match(LABEL_RE);
      label = lm ? lm[0] : null;
      break;
    }
    if (!label) continue;

    // Reset time: the next "Resets ..." line before the next limit block.
    let resets = null;
    for (let k = i + 1; k < Math.min(lines.length, i + 4); k++) {
      const rm = lines[k].match(/Resets\s*(.+)$/);
      if (rm) { resets = rm[1].trim(); break; }
      if (/Resets(\s|$)/.test(lines[k]) || /used$/.test(lines[k])) break;
    }

    limits.push({ label, pct, resets, resetAt: parseResetTime(resets, Date.now()), windowMs: windowFor(label) });
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
    // Self-review (issue #105): sandbox.config.json's hiddenApps hides claude
    // from every launch picker, but GET /api/usage has no launch picker to
    // guard -- a direct call (any authenticated client, or warmUsage() at
    // boot) would otherwise still spawn a real `claude` process even when the
    // operator listed it in hiddenApps specifically because they haven't
    // contracted for it. Refuse the same way the not-installed check below
    // does, mirroring createSession's hiddenApps guard (sessionManager.js).
    // Checked BEFORE resolveClaude() below: once claude is hidden, whether it
    // happens to be installed is irrelevant.
    if (isAppHidden('claude')) {
      resolve({ error: 'claude is hidden on this server (sandbox.config.json\'s "hiddenApps")' });
      return;
    }
    // claude not installed on this host (or claudeBin pointing at a missing
    // path): a pty.spawn would just fail with execvp/ENOENT. Report the real
    // cause up front -- this also backs the client's automatic Usage-button
    // hiding (availableApps.claude === false via /dirs/home).
    const resolvedClaude = resolveClaude();
    if (resolvedClaude.found === false) {
      resolve({ error: 'claude is not installed on this server' });
      return;
    }
    // Direct (non-sandboxed) fallback below execs on the host: use the
    // absolute host path, not the bare name (which is resolved against the
    // sandbox PATH and may not resolve on the server's own PATH -- see
    // resolveApp's hostCommand). The sandboxed branch below re-resolves
    // internally, so this only affects the direct fallback.
    let command = resolvedClaude.hostCommand || resolvedClaude.command;
    let args = ['--ax-screen-reader'];
    let spawnCwd = homedir();
    let sandboxed = false;
    let seatbeltDir = null;

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
        // macOS seatbelt launches mint a runtime dir (profile + throwaway
        // HOME); removed in finish() below. Null on every other backend.
        seatbeltDir = spawn.seatbeltDir || null;
      } catch {
        // bwrap launch failed; fall through to the forceSandbox / direct path.
      }
    }

    // forceSandbox (sandbox.config.json) forbids launching the agent outside
    // the sandbox, so the direct-launch fallback below is not allowed -- fail
    // the capture with a clear error instead of running claude unsandboxed.
    if (!sandboxed && loadSandboxConfig().forceSandbox) {
      const { reason } = forceSandboxUnavailableReason();
      resolve({ error: `Cannot read usage: "forceSandbox": true but the sandbox is unavailable (${reason})` });
      return;
    }

    // Drop server-only env (NODE_ENV, PORT, CCSERVER_*, forwarded ssh-agent);
    // irrelevant here and can confuse tools. See ws/sessionEnv.js.
    const cleanEnv = buildSessionEnv();

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
      if (seatbeltDir) {
        try { rmSync(seatbeltDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      resolve({ error: `Failed to launch claude: ${err.message}`, sandboxed });
      return;
    }

    let buf = '';
    let done = false;
    let sentUsage = false;
    let trustHandled = false;
    let bootTimer = null;
    let settleTimer = null;
    let hardTimer = null;

    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(bootTimer);
      clearTimeout(settleTimer);
      clearTimeout(hardTimer);
      clearTimeout(resendTimer);
      try { ptyProc.kill(); } catch { /* already gone */ }
      if (seatbeltDir) {
        try { rmSync(seatbeltDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      resolve({ ...res, sandboxed });
    };

    // Type `/usage`, retrying while the dashboard hasn't appeared. A single
    // send is enough on a warm start, but a cold sandboxed start (seatbelt
    // profile compile, throwaway-HOME cache miss) can still be booting when
    // BOOT_DELAY_MS fires, so the first command text lands nowhere. Resends
    // are spaced 10s apart and capped: typing into an idle prompt is harmless
    // (it just re-opens the dashboard), and the leading Ctrl-U clears a stale
    // "/usage" left by a lost Enter so we never submit "/usage/usage".
    // Never resends while the trust gate is showing -- that dialog expects
    // y/n and must keep going through answerTrustThenUsage instead.
    const RESEND_DELAY_MS = 10 * 1000;
    const MAX_RESENDS = 2;
    let resends = 0;
    let resendTimer = null;
    const sendUsage = ({ resend = false, force = false } = {}) => {
      if (done) return;
      if (!force) {
        const gate = usageSendGate({
          resend, sentUsage, resends, maxResends: MAX_RESENDS,
          trustShowing: isTrustPrompt(buf),
          dashboardPresent: parseUsage(buf).limits.length > 0,
        });
        if (!gate.send) return;
        if (resend) resends += 1;
        else sentUsage = true;
      } else if (!resend) {
        // Post-trust forced send (answerTrustThenUsage): the throwaway-cwd
        // sandboxed capture always passes through the trust gate first, so no
        // non-force send ever runs and sentUsage would stay false forever --
        // leaving fast-complete (onData's looksReady) and the retry schedule
        // below disarmed, i.e. every trust-first capture waits out the full
        // hard timeout. Count the forced send as the initial send (gate and
        // Ctrl-U still skipped), so retries + fast-complete work the same way.
        sentUsage = true;
      }
      try {
        if (resend && !force) ptyProc.write('\x15'); // Ctrl-U: clear a possibly stale input line
        ptyProc.write('/usage');
        setTimeout(() => { try { ptyProc.write('\r'); } catch { /* dead */ } }, 500);
      } catch {
        if (!resend) finish({ error: 'claude exited before /usage could be sent' });
      }
      if (!resend) {
        const schedule = () => {
          if (done) return;
          clearTimeout(resendTimer);
          resendTimer = setTimeout(() => {
            sendUsage({ resend: true });
            schedule();
          }, RESEND_DELAY_MS);
        };
        schedule();
      }
    };

    // Clear the trust gate, then ask for usage once the dialog is gone. The
    // sandbox exposes only an empty throwaway cwd, so trusting it is harmless.
    // Runs even if a /usage was already sent (a late-appearing gate would have
    // eaten it): the post-trust send is forced, bypassing the once-only guard.
    const answerTrustThenUsage = () => {
      if (trustHandled || done) return;
      trustHandled = true;
      try {
        ptyProc.write('y');
        setTimeout(() => { try { ptyProc.write('\r'); } catch { /* dead */ } }, 200);
      } catch { /* dead */ }
      setTimeout(() => sendUsage({ force: true }), TRUST_SETTLE_MS);
    };

    bootTimer = setTimeout(() => {
      if (isTrustPrompt(buf)) answerTrustThenUsage();
      else sendUsage();
    }, BOOT_DELAY_MS);

    ptyProc.onData((d) => {
      buf += d;
      if (buf.length > 512 * 1024) buf = buf.slice(-256 * 1024);
      // The trust gate can appear before the boot delay -- or after an
      // already-sent /usage (slow render); clear it whenever it shows so it
      // never eats the command for good. The forced post-trust send recovers
      // the eaten command in the late case.
      if (!trustHandled && isTrustPrompt(buf)) {
        answerTrustThenUsage();
        return;
      }
      if (!sentUsage) return;
      if (looksReady(parseUsage(buf))) {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => finish({ usage: parseUsage(buf) }), SETTLE_MS);
      }
    });

    ptyProc.onExit(() => finish({ usage: parseUsage(buf) }));

    hardTimer = setTimeout(() => {
      const parsed = parseUsage(buf);
      if (parsed.limits.length) {
        finish({ usage: parsed });
        return;
      }
      const diag = buildTimeoutError(buf, { sandboxed, sentUsage, trustHandled, resends });
      console.warn(
        `[usage] capture timed out (sandboxed=${sandboxed} sentUsage=${sentUsage} trustHandled=${trustHandled} resends=${resends} bufLen=${buf.length}) screenTail=${JSON.stringify(diag.screenTail.slice(-400))}`,
      );
      finish(diag);
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
          // parseResetTime() already resolved this as the server's local
          // time (see its comment), so no timeZone is recorded here --
          // callers of getLatestSessionLimitReset() treat a null timeZone
          // as "server time".
          const sessionLimit = res.usage.limits.find((l) => /session/i.test(l.label));
          if (sessionLimit?.resetAt) {
            recordSessionLimitReset({ resetAtMs: sessionLimit.resetAt, source: 'usage' });
          }
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
  const out = { usage: null, error: res.error || 'Could not read usage', sandboxed: res.sandboxed };
  // Timeout diagnostics (screenTail/sentUsage/trustHandled from
  // buildTimeoutError): the client ignores unknown fields, but they let the
  // next report pin trust-gate vs login vs blank without a live repro.
  if (res.screenTail !== undefined) out.screenTail = res.screenTail;
  if (res.sentUsage !== undefined) out.sentUsage = res.sentUsage;
  if (res.trustHandled !== undefined) out.trustHandled = res.trustHandled;
  if (res.resends !== undefined) out.resends = res.resends;
  return out;
}

// Best-effort cache warm at server startup so the first click is instant.
export function warmUsage() {
  getUsage({ force: true }).catch(() => { /* best effort */ });
}
