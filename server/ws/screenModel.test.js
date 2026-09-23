// Unit tests for the lightweight virtual screen model (screenModel.js).
// No MCP SDK / bwrap / agent CLIs needed -- pure module tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScreenModel } from './screenModel.js';

test('plain text lands on the screen line by line', () => {
  const s = createScreenModel();
  s.feed('hello\r\nworld');
  assert.deepEqual(s.screenRows(), ['hello', 'world']);
});

test('CR overwrites the current line (the spinner pattern)', () => {
  const s = createScreenModel();
  s.feed('⠋ analyzing…');
  const v1 = s.version();
  s.feed('\r⠙ analyzing…');
  assert.ok(s.version() > v1, 'a new frame is a visible change');
  s.feed('\r⠹ analyzing…');
  assert.ok(s.version() > v1);
  assert.deepEqual(s.screenRows(), ['⠹ analyzing…'], 'only the latest frame survives');
});

test('spinner drawn with line erase + fixed cursor leaves a single line', () => {
  const s = createScreenModel();
  s.feed('line 1\n');
  s.feed('\r\x1b[2K⠋ working\r\x1b[2K⠙ working\r\x1b[2K⠹ working');
  assert.deepEqual(s.screenRows(), ['line 1', '⠹ working']);
});

test('line erase modes: K 0 clears cursor-to-EOL, K 2 the whole line', () => {
  const s = createScreenModel();
  s.feed('0123456789\r\n');
  s.feed('\x1b[5G'); // CHA: cursor to column 5 (1-based)
  s.feed('ab');
  assert.deepEqual(s.screenRows(), ['0123456789', '    ab']);
  s.feed('\r\x1b[5G\x1b[K');
  assert.deepEqual(s.screenRows(), ['0123456789', ''], 'K0 erases from the cursor to EOL');
  s.feed('\r\x1b[2K');
  assert.deepEqual(s.screenRows(), ['0123456789', ''], 'K2 erases the whole line');
});

test('cursor positioning: CUP moves the write target, overwriting in place', () => {
  const s = createScreenModel();
  s.feed('row one\r\nrow two\r\nrow three');
  s.feed('\x1b[2;1Hreplaced');
  assert.deepEqual(s.screenRows(), ['row one', 'replaced', 'row three']);
});

test('display erase: ED 2 clears everything; ED 0 clears cursor to screen end', () => {
  const s = createScreenModel();
  s.feed('a\r\nb\r\nc');
  s.feed('\x1b[2J');
  assert.deepEqual(s.screenRows(), ['']);
  s.feed('x\r\ny\r\nz');
  s.feed('\x1b[2;2H\x1b[J'); // cursor at (2,2), erase to end
  assert.deepEqual(s.screenRows(), ['x', 'y']);
});

test('alternate screen: ?1049 h/l toggles the flag without clearing content', () => {
  const s = createScreenModel();
  s.feed('main screen');
  assert.equal(s.altScreenActive(), false);
  s.feed('\x1b[?1049h');
  assert.equal(s.altScreenActive(), true);
  assert.deepEqual(s.screenRows(), ['main screen'], 'content is kept across the switch');
  s.feed('\x1b[?1049l');
  assert.equal(s.altScreenActive(), false);
});

test('scrolling: rows beyond the cap drop the oldest (bounded memory)', () => {
  const s = createScreenModel({ rows: 5 });
  for (let i = 0; i < 20; i++) s.feed(`line ${i}\r\n`);
  assert.equal(s.screenRows().length, 5);
  assert.deepEqual(s.screenRows(), ['line 16', 'line 17', 'line 18', 'line 19', '']);
});

test('line wrap: text wider than the width wraps to the next row', () => {
  const s = createScreenModel({ cols: 8 });
  s.feed('1234567890');
  assert.deepEqual(s.screenRows(), ['12345678', '90']);
});

test('unknown / ignored CSI sequences are dropped harmlessly (SGR, cursor hide, OSC)', () => {
  const s = createScreenModel();
  s.feed('\x1b[31m\x1b[1mred text\x1b[0m');
  s.feed('\x1b[?25l');
  s.feed('\x1b]0;title\x07');
  s.feed(' visible');
  assert.deepEqual(s.screenRows(), ['red text visible']);
});

test('escape sequences split across chunk boundaries are joined correctly', () => {
  const s = createScreenModel();
  const full = 'first\r\x1b[2Kline\r\x1b[31mred\x1b[0m end';
  // Feed one byte at a time -- every sequence boundary is a chunk boundary.
  for (const ch of full) s.feed(ch);
  assert.deepEqual(s.screenRows(), ['red end']);
});

test('OSC split across chunks (BEL terminator in a later chunk)', () => {
  const s = createScreenModel();
  s.feed('before\x1b]0;long ');
  s.feed('title\x07after');
  assert.deepEqual(s.screenRows(), ['beforeafter']);
});

test('UTF-8 multibyte characters split across byte chunks never mojibake', () => {
  const s = createScreenModel();
  const bytes = new TextEncoder().encode('分析中… done');
  // Split at a byte boundary inside the second character ('析' = 3 bytes).
  s.feed(bytes.slice(0, 4));
  s.feed(bytes.slice(4, 8));
  s.feed(bytes.slice(8));
  assert.deepEqual(s.screenRows(), ['分析中… done']);
});

test('version() counts visible changes; cursor-only movement does not', () => {
  const s = createScreenModel();
  s.feed('abc');
  const v = s.version();
  s.feed('\r'); // CR alone: no visible change
  assert.equal(s.version(), v);
  s.feed('\x1b[2C'); // cursor right: no visible change
  assert.equal(s.version(), v);
  s.feed('d'); // a real change
  assert.equal(s.version(), v + 1);
});

// takeDirtyRowCount: the "how much of the screen is moving" signal behind
// activity.js's busy/low split. version() cannot serve that purpose because
// it counts cells, so a one-line spinner on a wide terminal looks as heavy as
// real output; counting DISTINCT rows per time slice does not.

test('takeDirtyRowCount: a spinner redrawing one row counts as one row', () => {
  const s = createScreenModel();
  s.feed('line 1\n');
  s.takeDirtyRowCount();
  // Twenty frames of a spinner on the same row, the way a TUI paints one.
  for (const g of '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏') s.feed(`\r\x1b[2K${g} working`);
  assert.equal(s.takeDirtyRowCount(), 1, 'the same row over and over is still one row');
});

test('takeDirtyRowCount: streaming output counts every row it paints', () => {
  const s = createScreenModel();
  s.takeDirtyRowCount();
  for (let i = 0; i < 12; i++) s.feed(`output line ${i}\r\n`);
  assert.equal(s.takeDirtyRowCount(), 13, '12 written rows plus the empty row the last newline opened');
});

test('takeDirtyRowCount: resets on read, so each sample covers one slice', () => {
  const s = createScreenModel();
  s.feed('abc');
  assert.equal(s.takeDirtyRowCount(), 1);
  assert.equal(s.takeDirtyRowCount(), 0, 'nothing has been drawn since the previous sample');
  s.feed('d');
  assert.equal(s.takeDirtyRowCount(), 1);
});

test('takeDirtyRowCount: cursor-only movement dirties nothing', () => {
  const s = createScreenModel();
  s.feed('abc');
  s.takeDirtyRowCount();
  s.feed('\r');
  s.feed('\x1b[2C');
  s.feed('\x1b[A');
  assert.equal(s.takeDirtyRowCount(), 0);
});

test('takeDirtyRowCount: a screen clear dirties every row that was visible', () => {
  const s = createScreenModel();
  s.feed('a\r\nb\r\nc\r\nd');
  s.takeDirtyRowCount();
  s.feed('\x1b[2J'); // ED 2: the whole screen goes
  assert.equal(s.takeDirtyRowCount(), 4, 'all four rows changed, not just the one the cursor sat on');
});

test('takeDirtyRowCount: switching to the alternate screen replaces everything', () => {
  const s = createScreenModel();
  s.feed('a\r\nb\r\nc');
  s.takeDirtyRowCount();
  s.feed('\x1b[?1049h');
  assert.equal(s.takeDirtyRowCount(), 3);
});

test('takeDirtyRowCount: ED 0 counts the rows it drops below the cursor', () => {
  const s = createScreenModel();
  s.feed('x\r\ny\r\nz\r\nw');
  s.takeDirtyRowCount();
  s.feed('\x1b[2;2H\x1b[J'); // cursor to row 2, erase to the end of the screen
  assert.deepEqual(s.screenRows(), ['x', 'y']);
  assert.equal(s.takeDirtyRowCount(), 3, 'the cursor row plus the two rows that went away');
});

test('takeDirtyRowCount: ED 1 counts the rows it clears above the cursor', () => {
  // ED 1 (erase from the start of the screen to the cursor) is the one branch
  // whose rows used to be cleared with no change recorded at all.
  const s = createScreenModel();
  s.feed('aaa\r\nbbb\r\nccc\r\nddd');
  s.takeDirtyRowCount();
  s.feed('\x1b[3;2H\x1b[1J'); // cursor to row 3, column 2, erase to that point
  assert.deepEqual(s.screenRows(), ['', '', ' cc', 'ddd'], 'rows above are cleared, the cursor row keeps its tail');
  assert.equal(s.takeDirtyRowCount(), 3, 'the two rows above plus the cursor row');
});

test('ED 1 still registers as a visible change for screenIdleMs', () => {
  // sessionManager stamps screenLastChangeAt on any version() movement, so
  // the branch must keep bumping it at least once.
  const s = createScreenModel();
  s.feed('aaa\r\nbbb\r\nccc');
  const v = s.version();
  s.feed('\x1b[2;2H\x1b[1J');
  assert.ok(s.version() > v);
});

// Hostile input. sessionManager feeds every pty chunk through this parser
// synchronously, for every session, so a sequence that never finishes here
// stops the whole server rather than one tab. These cases all used to hang or
// grow without bound; each one asserts that the parser finishes AND that the
// screen it leaves behind is still sane.

test('a huge cursor-down parameter cannot spin (ESC[1000000000000000B)', () => {
  const s = createScreenModel();
  const started = Date.now();
  s.feed('\x1b[1000000000000000B');
  s.feed('landed');
  assert.ok(Date.now() - started < 2000, 'must not walk a quadrillion rows one at a time');
  // Everything that was on screen scrolled away; the cursor sits on the last row.
  assert.equal(s.screenRows().length, 200);
  assert.equal(s.screenRows()[199], 'landed');
});

test('a cursor parameter long enough to overflow to Infinity terminates', () => {
  // Number('9'.repeat(400)) is Infinity, and `cursorRow--` never moves it --
  // the original loop could not end at all.
  const s = createScreenModel();
  const started = Date.now();
  s.feed(`\x1b[${'9'.repeat(400)}B`);
  assert.ok(Date.now() - started < 2000);
  assert.ok(s.screenRows().length <= 200);
});

test('a huge CUP row parameter cannot spin (ESC[999999999999;1H)', () => {
  const s = createScreenModel();
  const started = Date.now();
  s.feed('\x1b[999999999999;1Hx');
  assert.ok(Date.now() - started < 2000);
  assert.equal(s.screenRows().length, 200);
});

test('an unterminated OSC discards its body instead of buffering it', () => {
  // The body is thrown away anyway, so it is dropped as it streams. Holding
  // it in `pending` and re-scanning that buffer on every chunk was quadratic:
  // 12.5MiB took ~8 seconds of blocked event loop and 158MB of RSS.
  const s = createScreenModel();
  s.feed('\x1b]0;');
  const chunk = 'A'.repeat(64 * 1024);
  const started = Date.now();
  for (let i = 0; i < 100; i++) s.feed(chunk);
  assert.ok(Date.now() - started < 2000, 'must stay linear in the bytes fed');
  assert.deepEqual(s.screenRows(), [], 'an OSC body never reaches the screen');
  // And it still ends where it should.
  s.feed('\x07visible');
  assert.deepEqual(s.screenRows(), ['visible']);
});

test('an unterminated CSI parameter run does not accumulate', () => {
  const s = createScreenModel();
  s.feed('\x1b[');
  const started = Date.now();
  for (let i = 0; i < 20; i++) s.feed('9'.repeat(4096));
  assert.ok(Date.now() - started < 2000);
});

test('an OSC terminator split across chunks still ends the string', () => {
  // ESC and its backslash landing in different chunks is the case the
  // discard path has to get right.
  const s = createScreenModel();
  s.feed('a\x1b]0;ti');
  s.feed('tle\x1b');
  s.feed('\\after');
  assert.deepEqual(s.screenRows(), ['aafter']);
});

test('an ESC inside an OSC that is not a terminator keeps the string open', () => {
  const s = createScreenModel();
  s.feed('a\x1b]0;ti\x1b');
  s.feed('Xtle\x07b');
  assert.deepEqual(s.screenRows(), ['ab'], 'only BEL or ESC-backslash ends it');
});

test('an empty chunk inside an unterminated OSC does not strand the parser', () => {
  // feed('') decides nothing, so it must not consume the remembered ESC that
  // a following backslash would complete into a string terminator. Losing it
  // left the parser inside the OSC forever, swallowing every later chunk.
  const s = createScreenModel();
  s.feed('\x1b]0;t\x1b');
  s.feed('');
  s.feed('\\VISIBLE');
  assert.deepEqual(s.screenRows(), ['VISIBLE']);

  // Several empty chunks in a row are no different.
  const s2 = createScreenModel();
  s2.feed('\x1b]0;t\x1b');
  s2.feed('');
  s2.feed('');
  s2.feed('\\SEEN');
  assert.deepEqual(s2.screenRows(), ['SEEN']);
});

test('an over-long CSI is discarded whole, not cut off mid-sequence', () => {
  // Stopping at the parameter cap left the rest of the sequence to be parsed
  // as text, so `ESC[1;1;1;...m` printed its own leftover parameters.
  const s = createScreenModel();
  s.feed(`\x1b[${'1;'.repeat(40)}mTEXT`);
  assert.deepEqual(s.screenRows(), ['TEXT'], 'the parameters never reach the screen');
});

test('an over-long CSI split across chunks is still discarded whole', () => {
  const s = createScreenModel();
  s.feed(`\x1b[${'1;'.repeat(40)}`);
  s.feed('mTEXT');
  assert.deepEqual(s.screenRows(), ['TEXT']);

  // ...and the discard stays bounded when the final byte never arrives.
  const s2 = createScreenModel();
  s2.feed(`\x1b[${'9'.repeat(4096)}`);
  const started = Date.now();
  for (let i = 0; i < 20; i++) s2.feed('9'.repeat(4096));
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(s2.screenRows(), [], 'nothing of the malformed sequence is drawn');
  s2.feed('mAFTER');
  assert.deepEqual(s2.screenRows(), ['AFTER'], 'the final byte ends the discard');
});

test('a realistic SGR run is not mistaken for an over-long one', () => {
  // The cap has to sit above anything a real terminal emits: a truecolor SGR
  // is ~36 characters of parameters and a long chained one still under 64.
  const s = createScreenModel();
  s.feed('\x1b[0;1;3;4;7;9;38;2;255;255;255;48;2;16;16;16mLONG');
  assert.deepEqual(s.screenRows(), ['LONG']);
});
