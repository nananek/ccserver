// Unit tests for the per-session activity classifier (activity.js).
// Pure module tests -- no MCP SDK / bwrap / agent CLIs needed.
//
// The marker fixtures below are NOT invented. Each is the real bottom of a
// real TUI, captured on 2026-09-24 by running the CLI under a pty
// (script(1), 100 columns) and replaying the byte stream through this repo's
// own screenModel.js. That is the same "verify against a captured frame"
// posture appLaunch.js's detectPermissionPrompt takes; an app whose frames
// nobody captured gets no marker entry at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_BUSY_MARKERS,
  BUSY_ENTER_ROWS_PER_SEC,
  BUSY_EXIT_ROWS_PER_SEC,
  MARKER_ROWS,
  QUIET_MS,
  RATE_HOLD_WINDOW_MS,
  RATE_WINDOW_MS,
  appHasBusyMarker,
  changeRateFromSamples,
  classifyActivity,
  detectBusyMarker,
  screenTailText,
} from './activity.js';

// --- captured frames ---------------------------------------------------

// Claude Code v2.1.278, mid-turn. The footer hint row carries
// "· esc to interrupt" for exactly as long as the turn runs.
const CLAUDE_BUSY = [
  '● pong',
  '',
  '· Caramelizing… (running Stop hook · 1s · ↓ 3 tokens)',
  '',
  '────────────────────────────────────────────────────',
  '❯',
  '────────────────────────────────────────────────────',
  '  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_C…',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt                        ◉ xhigh · /effort',
  '',
];

// The same session once the turn finished: identical layout, the interrupt
// hint simply gone.
const CLAUDE_IDLE = [
  '● pong',
  '',
  '✻ Worked for 1s · done 4:52',
  '',
  '────────────────────────────────────────────────────',
  '❯',
  '────────────────────────────────────────────────────',
  '  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_C…',
  '  ⏵⏵ auto mode on (shift+tab to cycle)                                          ◉ xhigh · /effort',
  '',
];

// opencode 2.0.12, mid-turn: an animated block bar plus "esc interrupt"
// (note: no "to", unlike Claude Code).
const OPENCODE_BUSY = [
  '  ┃',
  '  ┃',
  '  ┃  Build · DeepSeek V4.1 Flash OpenCode Go · max',
  '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
  '   ■■■⬝⬝⬝⬝⬝ esc interrupt                                        shift+tab agents  ctrl+p commands',
  '',
];

// The same footer when idle: cwd, context size and cost instead.
const OPENCODE_IDLE = [
  '  ┃',
  '  ┃',
  '  ┃  Build · DeepSeek V4.1 Flash OpenCode Go · max',
  '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
  '  /…/9371c49c-a7ac-4058-947f-9ac65dd58f3c/scratchpad  8.6K (1%) · $0.00  ctrl+p commands',
  '',
];

// --- detectBusyMarker --------------------------------------------------

test('detectBusyMarker: Claude Code busy vs idle (captured v2.1.278 frames)', () => {
  const hit = detectBusyMarker('claude', CLAUDE_BUSY);
  assert.ok(hit, 'the interrupt hint in the footer means the turn is running');
  assert.equal(hit.marker, 'esc to interrupt');
  assert.equal(detectBusyMarker('claude', CLAUDE_IDLE), null, 'the hint is gone once the turn ends');
});

test('detectBusyMarker: opencode busy vs idle (captured 2.0.12 frames)', () => {
  const hit = detectBusyMarker('opencode', OPENCODE_BUSY);
  assert.ok(hit, 'opencode advertises "esc interrupt" while working');
  assert.equal(hit.marker, 'esc interrupt');
  assert.equal(detectBusyMarker('opencode', OPENCODE_IDLE), null);
});

test('detectBusyMarker: each app only matches its own spelling', () => {
  // opencode's footer says "esc interrupt"; claude's pattern wants "esc to
  // interrupt". Neither app's pattern may drift into matching the other's
  // frame by accident -- that is what would make a marker table pointless.
  assert.equal(detectBusyMarker('claude', OPENCODE_BUSY), null);
  // The reverse direction does match ("esc interrupt" is not a substring of
  // "esc to interrupt"), so assert the real relationship rather than a
  // symmetry that does not hold.
  assert.equal(detectBusyMarker('opencode', CLAUDE_BUSY), null);
});

test('detectBusyMarker: apps with no captured frames have no marker', () => {
  // Deliberately absent from the table (not installed on the host this was
  // verified against). They must return null rather than a guessed pattern.
  for (const app of ['codex', 'copilot', 'commandcode']) {
    assert.equal(appHasBusyMarker(app), false, `${app} must not carry an unverified marker`);
    assert.equal(detectBusyMarker(app, CLAUDE_BUSY), null);
  }
  assert.equal(appHasBusyMarker('claude'), true);
  assert.equal(appHasBusyMarker('opencode'), true);
  assert.equal(appHasBusyMarker(null), false, 'a shell session has no app');
});

test('detectBusyMarker: the phrase in the agent\'s own output is not a marker', () => {
  // The worst false positive available: an agent printing a document about
  // this very feature. The phrase is in the transcript, the footer says the
  // session is idle -- anchoring the search to the footer keeps it idle.
  const transcript = [
    '● Wrote the plan:',
    '',
    '  Claude Code shows "esc to interrupt" while a turn is running, so the',
    '  marker is the primary signal for the green/not-green decision.',
    '',
  ];
  const rows = [...transcript];
  // Push the phrase out of the footer window with ordinary transcript rows.
  for (let i = 0; i < MARKER_ROWS; i++) rows.push(`  line ${i} of follow-up output`);
  rows.push(...CLAUDE_IDLE);
  assert.equal(detectBusyMarker('claude', rows), null);

  // Same screen, still mid-turn: the footer decides, not the transcript.
  const running = [...transcript, ...CLAUDE_BUSY];
  assert.ok(detectBusyMarker('claude', running));
});

test('detectBusyMarker: empty / missing screens never match', () => {
  assert.equal(detectBusyMarker('claude', null), null);
  assert.equal(detectBusyMarker('claude', []), null);
  assert.equal(detectBusyMarker('claude', ['', '', '']), null);
});

// --- screenTailText ----------------------------------------------------

test('screenTailText: trailing blank rows do not push the footer out of range', () => {
  // A TUI that leaves the bottom of the screen empty would otherwise hide its
  // own footer from a naive slice(-N).
  const rows = [...CLAUDE_BUSY, '', '', '', '', '', '', '', '', '', '', '', ''];
  assert.match(screenTailText(rows), /esc to interrupt/);
});

test('screenTailText: column gaps collapse so a laid-out footer still reads as words', () => {
  // TUIs place footer fields with absolute column moves, so the rendered row
  // has wide runs of spaces between the words.
  const text = screenTailText(['esc      to        interrupt']);
  assert.equal(text, 'esc to interrupt');
});

test('screenTailText: only the last rowCount rows are considered', () => {
  const rows = ['needle', 'a', 'b', 'c'];
  assert.match(screenTailText(rows, 4), /needle/);
  assert.doesNotMatch(screenTailText(rows, 3), /needle/);
});

// --- changeRateFromSamples ---------------------------------------------

test('changeRateFromSamples: rows per second over the window', () => {
  const now = 10_000;
  // Four samples, 250ms apart, 5 rows each = 20 rows over 750ms of covered
  // span -> well above the busy threshold.
  const samples = [
    { at: now - 750, rows: 5 },
    { at: now - 500, rows: 5 },
    { at: now - 250, rows: 5 },
    { at: now, rows: 5 },
  ];
  const rate = changeRateFromSamples(samples, now);
  assert.ok(rate > BUSY_ENTER_ROWS_PER_SEC, `expected a busy rate, got ${rate}`);
});

test('changeRateFromSamples: samples older than the window are ignored', () => {
  const now = 100_000;
  const samples = [
    { at: now - 60_000, rows: 400 }, // a burst a minute ago
    { at: now - 250, rows: 1 },
  ];
  const rate = changeRateFromSamples(samples, now);
  assert.ok(rate < BUSY_EXIT_ROWS_PER_SEC, `a stale burst must not keep a session red (got ${rate})`);
});

test('changeRateFromSamples: no samples at all means nothing is being drawn', () => {
  assert.equal(changeRateFromSamples([], 1000), 0);
  assert.equal(changeRateFromSamples(null, 1000), 0);
  assert.equal(changeRateFromSamples(undefined, 1000), 0);
});

test('changeRateFromSamples: a single fresh sample cannot divide by ~zero', () => {
  const now = 5_000;
  const rate = changeRateFromSamples([{ at: now, rows: 2 }], now);
  assert.ok(Number.isFinite(rate) && rate > 0 && rate < 100, `expected a sane rate, got ${rate}`);
});

// --- classifyActivity: the truth table ---------------------------------

const busyRate = BUSY_ENTER_ROWS_PER_SEC + 10;
const lowRate = 2;
const quietMs = QUIET_MS + 500;
const movingMs = 100;

test('classifyActivity: marker x quiet x rate', () => {
  const cases = [
    // marker present -> never idle, whatever the screen timing says.
    { name: 'marker + moving + fast', rows: CLAUDE_BUSY, screenIdleMs: movingMs, changeRate: busyRate, level: 'busy', reason: 'marker' },
    { name: 'marker + moving + slow', rows: CLAUDE_BUSY, screenIdleMs: movingMs, changeRate: lowRate, level: 'low', reason: 'marker' },
    { name: 'marker + quiet + slow', rows: CLAUDE_BUSY, screenIdleMs: quietMs, changeRate: lowRate, level: 'low', reason: 'marker' },
    { name: 'marker + quiet + fast', rows: CLAUDE_BUSY, screenIdleMs: quietMs, changeRate: busyRate, level: 'busy', reason: 'marker' },
    // no marker: the screen decides.
    { name: 'no marker + moving + fast', rows: CLAUDE_IDLE, screenIdleMs: movingMs, changeRate: busyRate, level: 'busy', reason: 'movement' },
    { name: 'no marker + moving + slow', rows: CLAUDE_IDLE, screenIdleMs: movingMs, changeRate: lowRate, level: 'low', reason: 'movement' },
    { name: 'no marker + quiet + slow', rows: CLAUDE_IDLE, screenIdleMs: quietMs, changeRate: lowRate, level: 'idle', reason: 'quiet' },
    // Quiet wins over a stale rate: nothing has touched the screen for
    // QUIET_MS, so whatever the window still remembers is over.
    { name: 'no marker + quiet + fast', rows: CLAUDE_IDLE, screenIdleMs: quietMs, changeRate: busyRate, level: 'idle', reason: 'quiet' },
  ];
  for (const c of cases) {
    const r = classifyActivity({ app: 'claude', screenRows: c.rows, screenIdleMs: c.screenIdleMs, changeRate: c.changeRate });
    assert.equal(r.level, c.level, `${c.name}: level`);
    assert.equal(r.reason, c.reason, `${c.name}: reason`);
  }
});

test('classifyActivity: a thinking spinner is never green (the whole point)', () => {
  // The requirement this feature exists for: while the agent is thinking, the
  // tab must not claim the user's turn. Even with the screen frozen and no
  // rows changing at all -- the strictest case the timing signals can make --
  // the marker alone keeps it out of 'idle'.
  const r = classifyActivity({
    app: 'claude',
    screenRows: CLAUDE_BUSY,
    screenIdleMs: 10 * 60 * 1000,
    changeRate: 0,
  });
  assert.notEqual(r.level, 'idle');
  assert.equal(r.level, 'low', 'thinking with nothing being drawn is the yellow case');
  assert.equal(r.marker, 'esc to interrupt', 'the tooltip can say why');
});

test('classifyActivity: opencode reaches the same verdicts from its own footer', () => {
  const busy = classifyActivity({ app: 'opencode', screenRows: OPENCODE_BUSY, screenIdleMs: movingMs, changeRate: busyRate });
  assert.equal(busy.level, 'busy');
  assert.equal(busy.marker, 'esc interrupt');
  const idle = classifyActivity({ app: 'opencode', screenRows: OPENCODE_IDLE, screenIdleMs: quietMs, changeRate: 0 });
  assert.equal(idle.level, 'idle');
});

test('classifyActivity: apps without a marker table still classify from movement', () => {
  for (const app of ['codex', 'copilot', 'commandcode']) {
    const moving = classifyActivity({ app, screenRows: ['working on it'], screenIdleMs: movingMs, changeRate: busyRate });
    assert.equal(moving.level, 'busy', `${app}: a moving screen is not idle`);
    assert.equal(moving.reason, 'movement');
    assert.equal(moving.markerVerified, false, `${app}: the reading is movement-only, and says so`);

    const slow = classifyActivity({ app, screenRows: ['working on it'], screenIdleMs: movingMs, changeRate: lowRate });
    assert.equal(slow.level, 'low');

    const still = classifyActivity({ app, screenRows: ['waiting'], screenIdleMs: quietMs, changeRate: 0 });
    assert.equal(still.level, 'idle', `${app}: a still screen reads idle`);
  }
});

test('classifyActivity: markerVerified reports which apps are marker-backed', () => {
  assert.equal(classifyActivity({ app: 'claude', screenRows: CLAUDE_IDLE, screenIdleMs: quietMs }).markerVerified, true);
  assert.equal(classifyActivity({ app: 'codex', screenRows: ['x'], screenIdleMs: quietMs }).markerVerified, false);
});

test('classifyActivity: no level where the question does not apply', () => {
  const noSession = classifyActivity({ app: 'claude', live: false });
  assert.equal(noSession.level, null);
  assert.equal(noSession.reason, 'no-session');

  const exited = classifyActivity({ app: 'claude', exited: true, screenRows: CLAUDE_BUSY, screenIdleMs: movingMs });
  assert.equal(exited.level, null, 'an exited session is not "busy" just because its last frame had the marker');
  assert.equal(exited.reason, 'exited');

  const shell = classifyActivity({ app: null, shell: true, screenIdleMs: movingMs, changeRate: busyRate });
  assert.equal(shell.level, null, 'a plain shell has no agent to be busy');
  assert.equal(shell.reason, 'shell');
});

test('classifyActivity: a session that has never drawn anything is idle', () => {
  // screenIdleMs is null until the screen first changes (a freshly created
  // session, or a test double with no screen model).
  const r = classifyActivity({ app: 'claude', screenRows: null, screenIdleMs: null, changeRate: 0 });
  assert.equal(r.level, 'idle');
  assert.equal(r.reason, 'quiet');
});

test('classifyActivity: the raw figures come back for tuning and tooltips', () => {
  const r = classifyActivity({ app: 'claude', screenRows: CLAUDE_BUSY, screenIdleMs: 120, changeRate: 37.5 });
  assert.equal(r.screenIdleMs, 120);
  assert.equal(r.changeRate, 37.5);
});

test('classifyActivity: a non-finite rate degrades to the low end, not a crash', () => {
  const r = classifyActivity({ app: 'claude', screenRows: CLAUDE_BUSY, screenIdleMs: 100, changeRate: NaN });
  assert.equal(r.level, 'low');
});

// --- table hygiene -----------------------------------------------------

test('APP_BUSY_MARKERS: every entry records the version it was verified on', () => {
  for (const [app, entry] of Object.entries(APP_BUSY_MARKERS)) {
    assert.ok(entry.re instanceof RegExp, `${app}: needs a pattern`);
    assert.equal(typeof entry.marker, 'string', `${app}: needs a human-readable marker name`);
    assert.match(entry.verifiedOn, /\d{4}-\d{2}-\d{2}/, `${app}: needs the capture date of the frame it was verified against`);
  }
});

test('APP_BUSY_MARKERS: patterns are not sticky (a reused regex must not skip matches)', () => {
  // A /g or /y flag would make .test() stateful and drop every other call --
  // these regexes are module-level and reused for the life of the process.
  for (const [app, entry] of Object.entries(APP_BUSY_MARKERS)) {
    assert.equal(entry.re.global, false, `${app}: no /g`);
    assert.equal(entry.re.sticky, false, `${app}: no /y`);
  }
  const rows = CLAUDE_BUSY;
  assert.ok(detectBusyMarker('claude', rows));
  assert.ok(detectBusyMarker('claude', rows), 'a second call must give the same answer');
});

// --- hysteresis: the red/yellow split must not strobe -------------------

// The measured gap between "a spinner ticking" (<=9 rows/s) and "content
// being painted" (>=13 rows/s) is narrow, and the answer is a colour on a
// tab. Two guards keep it from blinking: two thresholds (ENTER to go red,
// EXIT to come back) and two windows (the short one promotes, the long one
// holds). Neither is allowed to touch the green decision.

test('hysteresis: a rate inside the gap holds whichever level it already had', () => {
  const mid = (BUSY_ENTER_ROWS_PER_SEC + BUSY_EXIT_ROWS_PER_SEC) / 2;
  const common = { app: 'claude', screenRows: CLAUDE_BUSY, screenIdleMs: movingMs, changeRate: mid, holdRate: mid };
  assert.equal(classifyActivity({ ...common, previousLevel: 'busy' }).level, 'busy', 'already red: stays red');
  assert.equal(classifyActivity({ ...common, previousLevel: 'low' }).level, 'low', 'already yellow: stays yellow');
  assert.equal(classifyActivity({ ...common, previousLevel: null }).level, 'low', 'no history: needs ENTER to claim red');
});

test('hysteresis: crossing ENTER promotes, and only dropping under EXIT demotes', () => {
  const rows = CLAUDE_BUSY;
  const at = (changeRate, holdRate, previousLevel) => classifyActivity({
    app: 'claude', screenRows: rows, screenIdleMs: movingMs, changeRate, holdRate, previousLevel,
  }).level;
  assert.equal(at(BUSY_ENTER_ROWS_PER_SEC, BUSY_ENTER_ROWS_PER_SEC, 'low'), 'busy', 'at ENTER exactly: red');
  assert.equal(at(BUSY_ENTER_ROWS_PER_SEC - 1, BUSY_ENTER_ROWS_PER_SEC - 1, 'low'), 'low', 'just under ENTER: still yellow');
  assert.equal(at(0, BUSY_EXIT_ROWS_PER_SEC, 'busy'), 'busy', 'at EXIT exactly: holds red');
  assert.equal(at(0, BUSY_EXIT_ROWS_PER_SEC - 1, 'busy'), 'low', 'under EXIT: finally yellow');
});

test('hysteresis: a spinner can never HOLD red once the burst is over', () => {
  // The thresholds are only useful if both sit above the measured spinner
  // band (5-9 rows/s). Otherwise a session that went red during output would
  // stay red for the rest of a long think.
  const spinnerCeiling = 9;
  assert.ok(BUSY_EXIT_ROWS_PER_SEC > spinnerCeiling, 'EXIT must be above the spinner band');
  assert.ok(BUSY_ENTER_ROWS_PER_SEC >= BUSY_EXIT_ROWS_PER_SEC, 'ENTER must not be below EXIT');
  const r = classifyActivity({
    app: 'claude', screenRows: CLAUDE_BUSY, screenIdleMs: movingMs,
    changeRate: spinnerCeiling, holdRate: spinnerCeiling, previousLevel: 'busy',
  });
  assert.equal(r.level, 'low');
});

test('hysteresis: a lull inside a turn does not demote, a finished turn does', () => {
  // Replays the shape the flicker would come from: a burst, then a second of
  // near-silence while the model thinks, then another burst. The long window
  // still remembers the burst during the lull, so the tab stays red.
  const now = 100_000;
  const burst = [];
  for (let i = 0; i < 4; i++) burst.push({ at: now - 3500 + i * 250, rows: 12 });
  const lull = [];
  for (let i = 0; i < 6; i++) lull.push({ at: now - 1250 + i * 250, rows: 1 });
  const samples = [...burst, ...lull];

  const fast = changeRateFromSamples(samples, now, RATE_WINDOW_MS);
  const slow = changeRateFromSamples(samples, now, RATE_HOLD_WINDOW_MS);
  assert.ok(fast < BUSY_EXIT_ROWS_PER_SEC, `the lull alone looks quiet (${fast} rows/s)`);
  assert.ok(slow >= BUSY_EXIT_ROWS_PER_SEC, `the long window still remembers the burst (${slow} rows/s)`);
  assert.equal(
    classifyActivity({ app: 'claude', screenRows: CLAUDE_BUSY, screenIdleMs: movingMs, changeRate: fast, holdRate: slow, previousLevel: 'busy' }).level,
    'busy',
    'a lull inside a turn keeps the tab red',
  );

  // Same session a few seconds later: the burst has aged out of both windows.
  const later = now + RATE_HOLD_WINDOW_MS;
  const slowLater = changeRateFromSamples(samples, later, RATE_HOLD_WINDOW_MS);
  assert.equal(
    classifyActivity({ app: 'claude', screenRows: CLAUDE_BUSY, screenIdleMs: movingMs, changeRate: 0, holdRate: slowLater, previousLevel: 'busy' }).level,
    'low',
    'once the burst ages out, the tab goes back to yellow',
  );
});

test('hysteresis: holdRate defaults to changeRate when the caller has only one figure', () => {
  const r = classifyActivity({ app: 'claude', screenRows: CLAUDE_BUSY, screenIdleMs: movingMs, changeRate: busyRate });
  assert.equal(r.level, 'busy');
});

test('hysteresis: previousLevel can never drag a session out of green', () => {
  // The invariant from the requirement: whatever history says, an absent
  // marker plus a still screen is the user's turn, and a present marker is
  // never the user's turn.
  for (const previousLevel of [null, 'idle', 'low', 'busy']) {
    const green = classifyActivity({
      app: 'claude', screenRows: CLAUDE_IDLE, screenIdleMs: quietMs, changeRate: busyRate, holdRate: busyRate, previousLevel,
    });
    assert.equal(green.level, 'idle', `previousLevel=${previousLevel}: quiet + no marker is idle`);

    const running = classifyActivity({
      app: 'claude', screenRows: CLAUDE_BUSY, screenIdleMs: quietMs, changeRate: 0, holdRate: 0, previousLevel,
    });
    assert.notEqual(running.level, 'idle', `previousLevel=${previousLevel}: the marker still wins`);
  }
});
