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
//      many.

export const ACTIVITY_LEVELS = ['idle', 'low', 'busy'];

// How long the screen must sit still before "no marker" is allowed to mean
// idle. Covers the gap between a TUI's frames plus a slow chunk arriving, so
// a running agent never slips into green between two redraws.
export const QUIET_MS = 1500;

// The same wait for an app with no verified marker (see APP_BUSY_MARKERS).
// There, stillness is the ONLY evidence there is, so it has to carry more
// weight before it may mean green: an app whose spinner ticks slower than
// QUIET_MS, or which stops redrawing entirely during a tool call, would
// otherwise read as "your turn" mid-think -- the exact failure this feature
// exists to prevent. The cost is that those apps take longer to turn green
// after a turn really ends.
export const QUIET_UNVERIFIED_MS = 5000;

// Rows-per-second thresholds for the 'busy' (red) / 'low' (yellow) split.
// Measured on this host (2026-09-24, 100-column pty, see activity.test.js's
// fixtures): both CLIs sit at 0 rows/s while idle; a spinner or a footer
// animation ticking on its own measured 5-9 rows/s; painting real content
// measured 13, 20, 29 and 43 rows/s.
//
// The gap between those two bands is only 9..13 wide, and this figure is
// painted on a tab: a rate hovering near a single threshold would blink the
// tab between yellow and red on every poll. So the threshold is split in two
// and the level only moves when the rate leaves the gap entirely -- ENTER to
// go red, EXIT to come back. Both sit inside the measured gap, so a spinner
// (<=9) can never HOLD red and real painting (>=13) always reaches it.
export const BUSY_ENTER_ROWS_PER_SEC = 12;
export const BUSY_EXIT_ROWS_PER_SEC = 10;

// How many rows at the bottom of the screen the busy marker may appear in.
//
// This is deliberately tiny. In BOTH captured frames the marker sits on the
// very last non-blank row of the screen, because it lives in the TUI's
// footer and the footer is pinned to the bottom. Anything above the footer is
// the TRANSCRIPT -- the agent's own words -- and an agent that merely writes
// about "esc to interrupt" (a plan discussing this feature, a terminal-UX
// answer, this very file) must never read as running. Claude Code's whole
// idle footer is only ~7 non-blank rows, so a window of 10 reached three rows
// into the transcript and pinned the tab yellow for as long as that text
// stayed on screen -- precisely when the user wants to know it is their turn.
// Three rows covers both captures with slack for a footer that grows a row,
// and still cannot reach past either app's footer.
export const MARKER_ROWS = 3;

// Sampling cadence for the rows-per-second figure. One sample per 250ms is
// fine-grained enough that a spinner's repeated row lands in several samples
// (deduped inside each one).
export const SAMPLE_MS = 250;

// The two windows the rate is averaged over -- the second half of the
// anti-flicker story. Going red is judged on the short window so a burst
// shows up promptly; coming back to yellow is judged on the long one, which
// still remembers the burst for a few seconds. An agent that alternates
// thinking and printing therefore stays red through the lulls instead of
// strobing, while a turn that really ended falls back within ~4s.
// (Green is not affected by either: it is decided by the marker and the
// quiet thresholds, never by these rates.)
export const RATE_WINDOW_MS = 2000;
export const RATE_HOLD_WINDOW_MS = 4000;

// Enough samples to cover the longer window at SAMPLE_MS, plus a little slack.
export const MAX_SAMPLES = Math.ceil(RATE_HOLD_WINDOW_MS / SAMPLE_MS) + 2;

// Ceiling on what a single sample may contribute. screenModel reports a
// whole-screen change (a clear, an alternate-screen switch) as every row it
// currently holds -- up to SCREEN_ROWS (200), which is its scrollback cap,
// not a screen. Unclamped, one ED 2 from a resize would bank 200 rows into a
// 250ms slice (800 rows/s, ~66x the threshold) and hold the tab red for the
// whole window. A full repaint IS activity, so it is not discarded, just
// capped at one conventional screenful.
export const MAX_ROWS_PER_SAMPLE = 24;

// Width the thresholds above were measured at, and the reference for
// normalizeRowsForWidth.
export const REFERENCE_COLS = 100;

// The "this agent is running" marker each CLI paints in its footer, keyed by
// the app ids in appLaunch.js's APPS.
//
// Only apps whose REAL frames were captured are listed. This mirrors the
// posture appLaunch.js's detectPermissionPrompt already takes: an unverified
// frame is never guessed at. codex, copilot and commandcode are absent on
// purpose -- they are not installed on the host this was built against, so
// they fall back to the screen-movement rule below (still correct, just
// without the marker's certainty, which is why QUIET_UNVERIFIED_MS makes them
// slower to claim green). Adding one is a single row here plus a
// captured-frame fixture in activity.test.js.
//
// Each pattern is matched against ONE row at a time (see detectBusyMarker),
// never a joined block, so a phrase assembled across two wrapped rows can
// never add up to a match. `[^\S\n]` rather than `\s` for the same reason.
export const APP_BUSY_MARKERS = {
  // Claude Code v2.1.278: the footer hint row gains " · esc to interrupt"
  // for exactly as long as the turn runs, on the last non-blank row. The
  // leading "·" is part of the footer's field separator and is required
  // here: prose says "press esc to interrupt", a footer says "· esc to
  // interrupt". Losing the marker to a future layout change is the safe
  // direction -- the session falls back to the movement rule, which a
  // redrawing spinner still keeps out of green.
  claude: {
    re: /·[^\S\n]*esc[^\S\n]+to[^\S\n]+interrupt/i,
    marker: 'esc to interrupt',
    verifiedOn: 'Claude Code v2.1.278 (2026-09-24)',
  },
  // opencode 2.0.12: the footer shows an animated block bar plus
  // "esc interrupt" (no "to") on the last non-blank row, and the
  // cwd/token/cost line when idle. The bar's glyphs change every frame, so
  // there is no stable separator to anchor on -- the three-row window is
  // what keeps the transcript out.
  opencode: {
    re: /esc[^\S\n]+interrupt/i,
    marker: 'esc interrupt',
    verifiedOn: 'opencode 2.0.12 (2026-09-24)',
  },
};

// Whether this app has a verified busy marker at all. Exposed so callers can
// say "this reading is marker-backed" vs "this reading is movement-only"
// instead of presenting both with the same confidence.
export function appHasBusyMarker(app) {
  return Object.prototype.hasOwnProperty.call(APP_BUSY_MARKERS, app);
}

// The marker table entry for an app, or null. Goes through hasOwnProperty so
// an app id that collides with an Object.prototype member ('constructor',
// 'toString', ...) reads as "no entry" instead of returning a function and
// blowing up on entry.re. Group members can carry an app string straight out
// of .saved-groups.json / .saved-sessions.json, which is a file on disk.
export function busyMarkerFor(app) {
  return appHasBusyMarker(app) ? APP_BUSY_MARKERS[app] : null;
}

// The bottom `rowCount` non-blank rows of the screen, each whitespace-
// normalized. Trailing blank rows are dropped first: a TUI that leaves the
// rest of the screen empty below its footer would otherwise push the footer
// out of the window.
export function screenTailRows(screenRows, rowCount = MARKER_ROWS) {
  if (!Array.isArray(screenRows) || screenRows.length === 0) return [];
  let end = screenRows.length;
  while (end > 0 && String(screenRows[end - 1]).trim() === '') end--;
  if (end === 0) return [];
  const start = Math.max(0, end - Math.max(1, rowCount));
  return screenRows.slice(start, end).map((r) => String(r).replace(/[ \t ]+/g, ' '));
}

// Look for the app's busy marker in the screen's footer region, row by row.
// Returns the matched entry (with its marker text) or null -- null both for
// "not running" and for "this app has no verified marker", which
// classifyActivity tells apart via appHasBusyMarker.
export function detectBusyMarker(app, screenRows, rowCount = MARKER_ROWS) {
  const entry = busyMarkerFor(app);
  if (!entry) return null;
  for (const row of screenTailRows(screenRows, rowCount)) {
    if (entry.re.test(row)) return entry;
  }
  return null;
}

// Rescale a dirty-row count measured at `cols` columns to the width the
// thresholds were calibrated at.
//
// Rows are already width-independent for a spinner (it rewrites one row
// whatever the width), but NOT for streaming output: the same text wraps into
// more rows on a narrow terminal than a wide one. Measured with 400
// characters of output: 10 rows at 40 columns, 4 at 100, 2 at 200 -- a 5x
// spread. The two mechanisms scale oppositely, so no factor fixes both: a
// linear cols/REFERENCE_COLS flattens streaming to ~1.2x but stretches a
// spinner by 5x (doubling it at 200 columns, enough to read red while merely
// thinking). The square root splits the difference, leaving both at ~2.25x
// instead of 5x for one of them -- the smallest worst case available here.
export function normalizeRowsForWidth(rows, cols) {
  const n = Number(rows) || 0;
  const width = Number(cols);
  if (!Number.isFinite(width) || width <= 0) return n;
  return n * Math.sqrt(width / REFERENCE_COLS);
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
  // Each sample is stamped when its slice CLOSED, so the oldest one already
  // covers the SAMPLE_MS before its own timestamp. Dividing by `now - oldest`
  // alone drops that slice's duration from the denominator and reports every
  // rate about a sample-width too high (8 rows/s measured as 9.1), eating a
  // fifth of the gap the busy threshold sits in.
  const elapsedMs = Math.max(now - oldest + SAMPLE_MS, SAMPLE_MS);
  return (rows * 1000) / elapsedMs;
}

// Classify one session. All inputs are plain values so this stays pure:
//
//   app           the session's app id (null for shells)
//   live          is there a live pty behind this member at all
//   exited        has that pty exited
//   shell         is this a plain shell session (no agent to be busy)
//   screenRows    screenModel.screenRows() -- may be null when there is no
//                 screen model (restored members, test doubles)
//   screenIdleMs  ms since the screen last visibly changed (null = never)
//   changeRate    rows per second over RATE_WINDOW_MS (drives going red)
//   holdRate      rows per second over RATE_HOLD_WINDOW_MS (drives coming
//                 back to yellow); defaults to changeRate, which collapses
//                 the hysteresis to a single window
//   previousLevel the level last reported for this session, so red/yellow
//                 can hold their ground instead of chattering around one
//                 threshold. Passing null just means "no history yet".
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
  holdRate = null,
  previousLevel = null,
} = {}) {
  const markerVerified = appHasBusyMarker(app);
  const base = { marker: null, markerVerified, screenIdleMs, changeRate };
  if (!live) return { ...base, level: null, reason: 'no-session' };
  if (exited) return { ...base, level: null, reason: 'exited' };
  if (shell) return { ...base, level: null, reason: 'shell' };

  const hit = detectBusyMarker(app, screenRows);
  // A screen that has never changed (null) has never drawn anything, so it
  // counts as quiet rather than as "moved just now".
  const quietAfter = markerVerified ? QUIET_MS : QUIET_UNVERIFIED_MS;
  const quiet = screenIdleMs == null || screenIdleMs >= quietAfter;

  // The green rule, and the one invariant worth stating out loud: 'idle'
  // needs the marker absent AND the screen still. A spinner keeps the marker
  // up (and the screen moving), so a thinking agent can never read as idle.
  if (!hit && quiet) return { ...base, level: 'idle', reason: 'quiet' };

  const fast = Number.isFinite(changeRate) ? changeRate : 0;
  const slow = Number.isFinite(holdRate) ? holdRate : fast;
  // Already red: keep it until even the long window drops below EXIT.
  // Otherwise: only go red once the short window clears ENTER.
  const busy = previousLevel === 'busy'
    ? slow >= BUSY_EXIT_ROWS_PER_SEC
    : fast >= BUSY_ENTER_ROWS_PER_SEC;
  return {
    ...base,
    marker: hit ? hit.marker : null,
    level: busy ? 'busy' : 'low',
    // What made this "running": the app's own marker, or (no marker, or no
    // marker table for this app) the screen simply still moving.
    reason: hit ? 'marker' : 'movement',
  };
}

// The reading for something that has no live pty at all: a restored group
// member, a session that is gone. Exported so callers never hand-roll the
// shape (and never have to call into a session facade just to say "nothing
// here"). Frozen because it is shared by every such caller.
export const NO_ACTIVITY = Object.freeze(classifyActivity({ live: false }));
