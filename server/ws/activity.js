// Per-session activity level: how hard the agent in a session is currently
// working, in three steps the UI paints on each tab.
//
//   'idle' (green)  the agent is NOT running -- it is waiting for the user
//   'low'  (yellow) running, but barely redrawing (a "Thinking…" spinner, a
//                   long tool call -- nothing is being painted)
//   'busy' (red)    running and actively painting (streaming a reply, tool
//                   output scrolling past)
//
// Pure module (no app imports, Node builtins only), unit-testable directly
// with node --test. Every input is passed in; nothing here reads a session.
//
// WHY NOT JUST idleForMs / screenIdleMs
//
// sessionManager already tracks two idle figures, and neither can carry this
// on its own:
//   - idleForMs is byte-based. A spinner writes bytes every frame, so it
//     stays small for the whole turn -- it cannot tell "thinking" from
//     "streaming", and a TUI that repaints a clock keeps it small while idle.
//   - screenIdleMs is screen-based, which is better, but it also shrinks when
//     the USER types (the echo is a screen change) -- "screen moved" is not
//     "the agent is running".
//
// So the judgment is split in two, and the green decision never rests on
// timing alone:
//
//   1. IS IT RUNNING?  Every supported TUI advertises an interrupt key while,
//      and only while, it is working ("esc to interrupt"). That marker is the
//      primary signal, confirmed against real captured frames (see
//      APP_BUSY_MARKERS). 'idle' requires the marker to be absent AND the
//      screen to have gone quiet -- an AND, so a spinner can never read as
//      idle, and an app with no marker entry of its own still falls back to
//      "the screen is moving, so it is not idle".
//   2. HOW HARD?  Among running sessions, the split is the number of DISTINCT
//      screen rows changing per second (screenModel's takeDirtyRowCount). A
//      spinner rewrites one or two rows over and over; real output paints
//      many. Rows, not cells, because a cell count scales with the terminal
//      width -- a wide terminal would make every spinner look busy.

export const ACTIVITY_LEVELS = ['idle', 'low', 'busy'];

// How long the screen must sit still before "no marker" is allowed to mean
// idle. Covers the gap between a TUI's frames plus a slow chunk arriving, so
// a running agent never slips into green between two redraws.
export const QUIET_MS = 1500;

// Rows-per-second at or above which a running session counts as 'busy'.
// Measured on this host (2026-09-24, 100-column pty, see activity.test.js's
// fixtures): both CLIs sit at 0 rows/s while idle; a spinner ticking on its
// own touches ~1-2 rows per 250ms sample (4-8 rows/s); painting real content
// measured 13, 20, 29 and 43 rows/s. 12 sits in that gap, closer to the
// spinner side so that "a whole answer is being drawn" reliably reads red.
export const BUSY_ROWS_PER_SEC = 12;

// How many rows at the bottom of the screen the busy marker may appear in.
// The marker lives in the TUI's footer, so the search is anchored there and
// never scans the transcript: an agent that PRINTS the phrase "esc to
// interrupt" (a plan discussing this very feature, say) must not read as
// running. Trailing blank rows are skipped before counting.
export const MARKER_ROWS = 10;

// Sampling cadence for the rows-per-second figure, and the window the rate is
// averaged over. One sample per 250ms is fine-grained enough that a spinner's
// repeated row lands in several samples (deduped inside each one), and the 2s
// window keeps a single quiet frame from dropping a busy session to yellow.
export const SAMPLE_MS = 250;
export const RATE_WINDOW_MS = 2000;

// Enough samples to cover RATE_WINDOW_MS at SAMPLE_MS, plus a little slack.
export const MAX_SAMPLES = Math.ceil(RATE_WINDOW_MS / SAMPLE_MS) + 2;

// The "this agent is running" marker each CLI paints in its footer, keyed by
// the app ids in appLaunch.js's APPS.
//
// Only apps whose REAL frames were captured are listed. This mirrors the
// posture appLaunch.js's detectPermissionPrompt already takes: an unverified
// frame is never guessed at. codex, copilot and commandcode are absent on
// purpose -- they are not installed on the host this was built against, so
// they fall back to the screen-movement rule below (still correct, just
// without the marker's certainty). Adding one is a single row here plus a
// captured-frame fixture in activity.test.js.
//
// The regexes run against a whitespace-normalized tail (see screenTailText),
// so the wide column gaps a TUI lays its footer out with collapse to single
// spaces first.
export const APP_BUSY_MARKERS = {
  // Claude Code v2.1.278: the footer hint row gains " · esc to interrupt"
  // for exactly as long as the turn runs. Older versions put the same phrase
  // on the spinner line instead ("✻ Thinking… (12s · esc to interrupt)") --
  // both are inside MARKER_ROWS, so one pattern covers them.
  claude: { re: /esc\s+to\s+interrupt/i, marker: 'esc to interrupt', verifiedOn: 'Claude Code v2.1.278 (2026-09-24)' },
  // opencode 2.0.12: the footer shows an animated block bar plus
  // "esc interrupt" (no "to") while working, and the cwd/token/cost line
  // when idle.
  opencode: { re: /esc\s+interrupt/i, marker: 'esc interrupt', verifiedOn: 'opencode 2.0.12 (2026-09-24)' },
};

// Whether this app has a verified busy marker at all. Exposed so callers can
// say "this reading is marker-backed" vs "this reading is movement-only"
// instead of presenting both with the same confidence.
export function appHasBusyMarker(app) {
  return Object.prototype.hasOwnProperty.call(APP_BUSY_MARKERS, app);
}

// The bottom `rowCount` rows of the screen, as one whitespace-normalized
// string. Trailing blank rows are dropped first: a TUI that leaves the rest
// of the screen empty below its footer would otherwise push the footer out of
// the window.
export function screenTailText(screenRows, rowCount = MARKER_ROWS) {
  if (!Array.isArray(screenRows) || screenRows.length === 0) return '';
  let end = screenRows.length;
  while (end > 0 && String(screenRows[end - 1]).trim() === '') end--;
  if (end === 0) return '';
  const start = Math.max(0, end - Math.max(1, rowCount));
  return screenRows.slice(start, end).join('\n').replace(/[ \t ]+/g, ' ');
}

// Look for the app's busy marker in the screen's footer region. Returns the
// matched entry (with its marker text) or null -- null both for "not running"
// and for "this app has no verified marker", which classifyActivity tells
// apart via appHasBusyMarker.
export function detectBusyMarker(app, screenRows, rowCount = MARKER_ROWS) {
  const entry = APP_BUSY_MARKERS[app];
  if (!entry) return null;
  const tail = screenTailText(screenRows, rowCount);
  if (!tail) return null;
  return entry.re.test(tail) ? entry : null;
}

// Rows-per-second over the last `windowMs`, from the sampler's ring of
// { at, rows } entries (see sessionManager's screenSamples). Samples older
// than the window are ignored; with nothing in the window the answer is 0
// ("nothing has been drawn lately"), not null -- a session that stopped
// producing samples stopped drawing.
export function changeRateFromSamples(samples, now, windowMs = RATE_WINDOW_MS) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  const cutoff = now - windowMs;
  let rows = 0;
  let oldest = null;
  for (const s of samples) {
    if (!s || typeof s.at !== 'number' || s.at < cutoff) continue;
    rows += Number(s.rows) || 0;
    if (oldest == null || s.at < oldest) oldest = s.at;
  }
  if (oldest == null) return 0;
  // Measure over the window actually covered by samples, floored at one
  // sample interval so a single fresh sample cannot divide by ~0 and report
  // an absurd rate.
  const elapsedMs = Math.max(now - oldest, SAMPLE_MS);
  return (rows * 1000) / elapsedMs;
}

// Classify one session. All inputs are plain values so this stays pure:
//
//   app          the session's app id (null for shells)
//   live         is there a live pty behind this member at all
//   exited       has that pty exited
//   shell        is this a plain shell session (no agent to be busy)
//   screenRows   screenModel.screenRows() -- may be null when there is no
//                screen model (restored members, test doubles)
//   screenIdleMs ms since the screen last visibly changed (null = never)
//   changeRate   rows per second, from changeRateFromSamples
//
// Returns { level, reason, marker, markerVerified, screenIdleMs, changeRate }.
// `level` is null when the question does not apply (no session, exited,
// shell) -- the UI shows nothing rather than guessing.
export function classifyActivity({
  app = null,
  live = true,
  exited = false,
  shell = false,
  screenRows = null,
  screenIdleMs = null,
  changeRate = 0,
} = {}) {
  const markerVerified = appHasBusyMarker(app);
  const base = { marker: null, markerVerified, screenIdleMs, changeRate };
  if (!live) return { ...base, level: null, reason: 'no-session' };
  if (exited) return { ...base, level: null, reason: 'exited' };
  if (shell) return { ...base, level: null, reason: 'shell' };

  const hit = detectBusyMarker(app, screenRows);
  // A screen that has never changed (null) has never drawn anything, so it
  // counts as quiet rather than as "moved just now".
  const quiet = screenIdleMs == null || screenIdleMs >= QUIET_MS;

  // The green rule, and the one invariant worth stating out loud: 'idle'
  // needs the marker absent AND the screen still. A spinner keeps the marker
  // up (and the screen moving), so a thinking agent can never read as idle.
  if (!hit && quiet) return { ...base, level: 'idle', reason: 'quiet' };

  const rate = Number.isFinite(changeRate) ? changeRate : 0;
  return {
    ...base,
    marker: hit ? hit.marker : null,
    level: rate >= BUSY_ROWS_PER_SEC ? 'busy' : 'low',
    // What made this "running": the app's own marker, or (no marker, or no
    // marker table for this app) the screen simply still moving.
    reason: hit ? 'marker' : 'movement',
  };
}
