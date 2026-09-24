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

// DECKPAM/DECKPNM are TWO bytes, unlike the charset designators (`ESC ( B`)
// and the DEC line attributes (`ESC # 8`) they sit next to in the parser.
// Consuming a third byte eats whatever follows -- usually the ESC that opens
// the next sequence, whose remainder then lands on screen as text. Full-screen
// TUIs emit these around application keypad mode, so `vim` or `less` in a
// shell session reaches this path.
test('ESC = / ESC > are two bytes and do not eat the sequence after them', () => {
  // A CUP moves the cursor down, so the rows it lands past exist but are
  // blank; the oracle is that nothing was PAINTED, same as the fuzz below.
  const painted = (stream) => {
    const s = createScreenModel();
    s.feed(stream);
    return s.screenRows().join('');
  };

  for (const keypad of ['\x1b=', '\x1b>']) {
    const label = JSON.stringify(keypad);
    assert.equal(painted(`${keypad}\x1b[3;7H`), '', `${label} swallowed the ESC of the following CUP`);
    assert.equal(painted(`${keypad}HELLO`), 'HELLO', `${label} ate the first text byte`);
  }

  // The three-byte neighbours must keep consuming three bytes.
  assert.equal(painted('\x1b(B\x1b[3;7H'), '', 'ESC ( B must still consume its third byte');
  assert.equal(painted('\x1b#8HELLO'), 'HELLO', 'ESC # 8 must still consume its third byte');
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

// --- self-consistency fuzz -----------------------------------------------
//
// Both parser regressions this file guards against were chunk-boundary bugs:
// state kept between feed() calls (a pending ESC, a half-consumed sequence)
// that the split-up path handled differently from the contiguous one. Hand
// written cases keep finding yesterday's boundary, so these two catch the
// shape of the bug instead of its address:
//
//   - splitting a byte string must never change what it draws, on all four
//     observables the rest of the server reads -- screenRows() (read_output
//     and the marker search), version() (screenIdleMs), takeDirtyRowCount()
//     (the busy/idle rate) and altScreenActive();
//   - a stream of complete escapes must draw nothing at all.
//
// WHAT THEY CANNOT CATCH. Both compare the parser against ITSELF, so a parser
// that is consistently wrong passes both. This is not theoretical: when these
// properties were added, a one-line mutant that ignores CUU (`ESC[nA`) passed
// all of them AND every hand written case the file had at that point, while
// drawing the wrong screen -- `AAAA\r\nBBBB` then `ESC[1A\rX` gave
// ["AAAA","XBBB"] where it should give ["XAAA","BBBB"] (measured in review).
// That mutant dies now, but only because the block below was written for it;
// nothing in the fuzz noticed then and nothing would notice the next one.
// A comparison against a reference implementation would have caught it;
// self-consistency cannot, and neither can it catch a wrong wrap position, a
// wrong erase extent, or a sequence nobody put in the corpus.
//
// So the semantics are carried by explicit expected-screen tests -- the ones
// above for CUP / EL / ED / wrapping / scrolling, and the block right below
// for the cursor moves and the alternate-screen switches. That block is only
// as strong as the cases actually written in it: each supported sequence
// needs its exact distance, its default parameter, its clamps and its effect
// on version()/takeDirtyRowCount() pinned separately, because a mutant that
// breaks any one of those in isolation passes everything else. The fuzz will
// not cover for a missing case.

// --- semantics: what each sequence is supposed to draw --------------------

test('CUU / CUD move the write target by whole rows', () => {
  const s = createScreenModel();
  s.feed('AAAA\r\nBBBB\r\nCCCC');
  s.feed('\x1b[2A\rX'); // two rows up, to the start of the line
  assert.deepEqual(s.screenRows(), ['XAAA', 'BBBB', 'CCCC']);
  s.feed('\x1b[1B\rY'); // one row back down
  assert.deepEqual(s.screenRows(), ['XAAA', 'YBBB', 'CCCC']);
});

test('CUU moves exactly n rows when the top is not in the way', () => {
  // Every other CUU case in this file starts close enough to the top that the
  // clamp decides the answer, which pins "ends up at the top" rather than
  // "moves n rows" -- a mutant that goes one row too far passes them all.
  const s = createScreenModel();
  s.feed('AAAA\r\nBBBB\r\nCCCC'); // cursor on the third row
  s.feed('\x1b[1A\rX'); // exactly one row up: the middle row, not the top
  assert.deepEqual(s.screenRows(), ['AAAA', 'XBBB', 'CCCC']);
});

test('CUD / CUF / CUB default to one step when the parameter is omitted', () => {
  // `ESC[B` means `ESC[1B`. Only CUU exercised the bare form, so a mutant
  // reading the omitted parameter as 0 -- i.e. not moving at all -- passed.
  const rows = createScreenModel();
  rows.feed('x\r\ny');
  rows.feed('\r\x1b[Bz'); // bare CUD: onto a new third row
  assert.deepEqual(rows.screenRows(), ['x', 'y', 'z']);

  const cols = createScreenModel();
  cols.feed('ABCDEF');
  cols.feed('\r\x1b[CX'); // bare CUF: one column in from the left
  assert.deepEqual(cols.screenRows(), ['AXCDEF']);
  cols.feed('\x1b[DY'); // bare CUB: back one from just after the X
  assert.deepEqual(cols.screenRows(), ['AYCDEF']);
});

test('CUU / CUD default to one row and stop at the top', () => {
  const s = createScreenModel();
  s.feed('AAAA\r\nBBBB');
  s.feed('\x1b[A\rX'); // no parameter means 1
  assert.deepEqual(s.screenRows(), ['XAAA', 'BBBB']);
  s.feed('\x1b[9A\rY'); // past the top: clamps to the first row
  assert.deepEqual(s.screenRows(), ['YAAA', 'BBBB']);
});

test('CUF / CUB move the write target by columns', () => {
  const s = createScreenModel();
  s.feed('ABCDEF');
  s.feed('\r\x1b[2CX'); // back to column 0, then forward two
  assert.deepEqual(s.screenRows(), ['ABXDEF']);
  s.feed('\x1b[2DY'); // two back from just after the X
  assert.deepEqual(s.screenRows(), ['AYXDEF']);
});

test('CUB stops at the left margin, CUF at the right', () => {
  const s = createScreenModel({ cols: 6 });
  s.feed('ABCDEF');
  s.feed('\r\x1b[9DX'); // already at column 0: cannot go further left
  assert.deepEqual(s.screenRows(), ['XBCDEF']);
  s.feed('\r\x1b[99CY'); // past the right edge: clamps to the last column
  assert.deepEqual(s.screenRows(), ['XBCDEY']);
});

test('CUD counts as a visible change exactly when it adds rows', () => {
  // Moving below the last row scrolls new ones onto the screen, so it has to
  // register on both counters the server reads: version() feeds screenIdleMs
  // and takeDirtyRowCount() feeds the activity rate. A mutant that skips the
  // bump leaves a screen that visibly grew while both counters say nothing
  // happened.
  const s = createScreenModel();
  s.feed('a\r\nb');
  s.takeDirtyRowCount();
  const before = s.version();
  s.feed('\x1b[5B'); // five rows down, past the bottom
  assert.ok(s.screenRows().length > 2, 'the screen grew');
  assert.ok(s.version() > before, 'a new row on screen is a visible change');
  assert.equal(s.takeDirtyRowCount(), 1, 'the row that appeared is the dirty one');

  // The contrast: moving inside the existing screen draws nothing, so neither
  // counter may move.
  const quiet = createScreenModel();
  quiet.feed('a\r\nb\r\nc');
  quiet.takeDirtyRowCount();
  const quietBefore = quiet.version();
  quiet.feed('\x1b[2A\x1b[1B\x1b[3C\x1b[2D');
  assert.equal(quiet.version(), quietBefore, 'cursor motion alone is not a change');
  assert.equal(quiet.takeDirtyRowCount(), 0);
});

test('CHA clamps to the last column and defaults to the first', () => {
  const s = createScreenModel({ cols: 6 });
  s.feed('ABCDEF');
  s.feed('\r\x1b[99GX'); // past the right edge: lands on the last column
  assert.deepEqual(s.screenRows(), ['ABCDEX']);
  s.feed('\x1b[GY'); // no parameter means column 1
  assert.deepEqual(s.screenRows(), ['YBCDEX']);
});

test('alternate screen: ?47 h/l toggles the flag like ?1049 does', () => {
  // mcpTools reads altScreenActive() for read_output's screenAlt, and the
  // module claims to support both spellings -- but only ?1049 had a test, so
  // a mutant that dropped ?47 passed everything.
  const s = createScreenModel();
  assert.equal(s.altScreenActive(), false);
  s.feed('\x1b[?47h');
  assert.equal(s.altScreenActive(), true, '?47h enters the alternate screen');
  s.feed('\x1b[?47l');
  assert.equal(s.altScreenActive(), false, '?47l leaves it');
});

test('alternate screen: switching buffers counts as a visible change', () => {
  const s = createScreenModel();
  s.feed('main screen');
  s.takeDirtyRowCount();
  const before = s.version();
  s.feed('\x1b[?47h');
  assert.ok(s.version() > before, 'the switch bumps the change counter');
  assert.equal(s.takeDirtyRowCount(), 1, 'every row that was visible is dirty');
});

test('other private modes do not touch the alternate-screen flag', () => {
  const s = createScreenModel();
  s.feed('\x1b[?25l\x1b[?25h\x1b[?2004h\x1b[?1000h');
  assert.equal(s.altScreenActive(), false);
});

// xorshift32 -- seeded so a failure is reproducible from the printed seed.
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x1_0000_0000;
  };
}

// Pieces chosen to hit the paths that carry state across a feed(): the skip
// modes, the pending prefix, and the parameter cap on both sides.
const FUZZ_PIECES = [
  'hello', 'a', ' ', '0123456789', '分析中…', ' ',
  '\r', '\n', '\r\n', '\t', '\x08', '\x07',
  '\x1b[2K', '\x1b[K', '\x1b[J', '\x1b[2J', '\x1b[1J', '\x1b[0J',
  '\x1b[H', '\x1b[3;7H', '\x1b[5A', '\x1b[4B', '\x1b[2C', '\x1b[6D', '\x1b[9G',
  '\x1b[?1049h', '\x1b[?1049l', '\x1b[?47h', '\x1b[?47l', '\x1b[?25l', '\x1b[?25h',
  '\x1b[0m', '\x1b[38;2;255;128;0;48;2;0;0;0;1;3;4m',
  '\x1b]0;a title\x07', '\x1b]8;;https://example.com\x1b\\', '\x1b]0;unterminated',
  '\x1b(B', '\x1b=', '\x1b>', '\x1b', '\x1b[',
  // The MAX_CSI_PARAM_CHARS frontier, from just inside to just outside.
  `\x1b[${'1;'.repeat(63)}m`, `\x1b[${'1;'.repeat(64)}m`, `\x1b[${'1;'.repeat(65)}m`,
  `\x1b[${'9'.repeat(127)}B`, `\x1b[${'9'.repeat(128)}B`, `\x1b[${'9'.repeat(129)}B`,
  '\x1b[999999999999B', `\x1b[${'9'.repeat(400)}B`,
];

// The subset that draws nothing: COMPLETE escapes, plus controls that only
// move the cursor. Whatever the parser does with these, none of their own
// bytes may end up on the screen -- which is exactly what the over-long-CSI
// regression did with its leftover parameters.
//
// Two pieces are excluded. `ESC` and `ESC[` are truncated: an incomplete
// sequence's meaning is whatever follows it, so `ESC` next to `ESC[`
// legitimately ends up printing the `[` (the parser consumes ESC ESC as one
// unknown escape and the rest is text). Not something this property is about.
//
// `ESC =` and `ESC >` used to be excluded too, because this fuzz found a real
// defect: escapeSequence treated them as three-byte sequences like `ESC ( B`,
// so they ate the byte after them. That is fixed, and they are back in the
// corpus -- their presence here IS the regression test (#213).
const NON_PRINTING_PIECES = FUZZ_PIECES.filter(
  (p) => (p.startsWith('\x1b') || /^[\x00-\x1f]+$/.test(p))
    && !['\x1b', '\x1b['].includes(p),
);

function randomStream(rand, pieces = 14, corpus = FUZZ_PIECES) {
  let out = '';
  for (let i = 0; i < pieces; i++) out += corpus[Math.floor(rand() * corpus.length)];
  return out;
}

// Split at random points, sprinkling in empty chunks -- the shape of the
// regression where feed('') consumed a pending ESC.
function randomSplit(rand, s) {
  const parts = [];
  let at = 0;
  while (at < s.length) {
    if (rand() < 0.15) parts.push('');
    const take = 1 + Math.floor(rand() * 6);
    parts.push(s.slice(at, at + take));
    at += take;
  }
  if (rand() < 0.5) parts.push('');
  return parts;
}

function observe(feeds) {
  const s = createScreenModel({ cols: 40, rows: 12 });
  for (const f of feeds) s.feed(f);
  return {
    rows: s.screenRows(),
    version: s.version(),
    alt: s.altScreenActive(),
    dirty: s.takeDirtyRowCount(),
  };
}

test('fuzz: how a stream is split never changes what it draws', () => {
  const rand = rng(0x5eed1234);
  const RUNS = 3000;
  for (let run = 0; run < RUNS; run++) {
    const stream = randomStream(rand);
    const split = randomSplit(rand, stream);
    const whole = observe([stream]);
    const piecewise = observe(split);
    assert.deepEqual(
      piecewise,
      whole,
      `run ${run}: splitting changed the result\n  stream: ${JSON.stringify(stream)}\n  split:  ${JSON.stringify(split)}`,
    );
  }
});

test('fuzz: random streams stay inside the model\'s bounds', () => {
  // Nothing a pty can write may push the model past its caps, make it throw,
  // or run away with time -- the last one being what a hostile sequence used
  // to do.
  const rand = rng(0xb0c1d5e7);
  const cols = 40;
  const rows = 12;
  const started = Date.now();
  for (let run = 0; run < 3000; run++) {
    const s = createScreenModel({ cols, rows });
    let previousVersion = 0;
    for (const chunk of randomSplit(rand, randomStream(rand))) {
      s.feed(chunk);
      const v = s.version();
      assert.ok(v >= previousVersion, 'version() is monotonic');
      previousVersion = v;
    }
    const screen = s.screenRows();
    assert.ok(screen.length <= rows, `screen grew past its cap: ${screen.length}`);
    for (const row of screen) assert.ok(row.length <= cols, `row longer than the width: ${JSON.stringify(row)}`);
    assert.ok(s.takeDirtyRowCount() <= rows, 'more rows reported dirty than exist');
    assert.equal(typeof s.altScreenActive(), 'boolean');
  }
  assert.ok(Date.now() - started < 20_000, 'the whole sweep must stay quick enough for CI');
});

test('fuzz: a skip mode always gives the screen back', () => {
  // Once inside the OSC or the over-long-CSI discard, a terminator has to end
  // it -- otherwise a single malformed sequence would blind the tab forever.
  const rand = rng(0x5c19a3f1);
  const pick = (chars, n) => {
    let out = '';
    for (let i = 0; i < n; i++) out += chars[Math.floor(rand() * chars.length)];
    return out;
  };
  for (let run = 0; run < 600; run++) {
    const osc = rand() < 0.5;
    // The body has to stay inside the sequence's own alphabet, or it ends it
    // early and legitimately: any byte in @-~ is a CSI final byte, and BEL or
    // ESC-backslash closes an OSC.
    const opener = osc ? '\x1b]0;junk' : `\x1b[${'9'.repeat(200)}`;
    const noise = osc
      ? pick('abcdefgh 0123456789/:.-', 20)
      : pick('0123456789;', 20);
    const terminator = osc ? '\x07' : 'm';
    const feeds = randomSplit(rand, `${opener}${noise}${terminator}RECOVERED`);
    const s = createScreenModel({ cols: 40, rows: 12 });
    for (const f of feeds) s.feed(f);
    assert.deepEqual(s.screenRows(), ['RECOVERED'], `run ${run}: ${JSON.stringify(feeds)}`);
  }
});

test('fuzz: an escape sequence never leaves its own bytes on the screen', () => {
  // The second regression's class: the parser gave up in the middle of a
  // sequence and the rest of it (`1;1;1;...m`) was drawn as text. Splitting
  // cannot detect that -- whole and split both draw the same wrong thing --
  // so the oracle here is that a stream of pure escapes and cursor motions
  // must paint nothing at all, however the parser chooses to handle it.
  const rand = rng(0x00e5ca9e);
  for (let run = 0; run < 2000; run++) {
    const feeds = randomSplit(rand, randomStream(rand, 12, NON_PRINTING_PIECES));
    const s = createScreenModel({ cols: 40, rows: 12 });
    for (const f of feeds) s.feed(f);
    const printed = s.screenRows().join('');
    assert.equal(printed, '', `run ${run}: escapes reached the screen as text: ${JSON.stringify(feeds)}`);
  }
});
