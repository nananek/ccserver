// The text views of a session's output: stripAnsi() and sessionOutputText().
//
// Both are pure (mcpTools.js touches no env and no disk at import), so this
// file imports them directly. The consumers are read_output (an MCP tool), the
// browser's copy-the-terminal modal (GET /api/sessions/:id/text, #253), the
// session-limit detector and the reviewer's summary.
//
// The modal is the reason the bar is high: what it shows is what an operator
// copies out with the OS's own selection menu, and it is fed by whatever the
// terminal's program printed. Anything that survives here is on the clipboard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, sessionOutputText, readOutput } from './mcpTools.js';

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;

// Built from code points, not written out: U+202E in this source would make
// the file itself display differently from what it says.
const RLO = String.fromCodePoint(0x202e);
const PDF = String.fromCodePoint(0x202c);

// What must never reach a text view: every control character except newline
// and tab (C0, DEL, C1 -- ESC is one of them), and the bidi controls.
const FORBIDDEN = /[\x00-\x08\x0b-\x1f\x7f-\x9f]|\p{Bidi_Control}/u;

function assertClean(text, label) {
  const m = FORBIDDEN.exec(text);
  assert.equal(m, null, `${label}: control character U+${m ? m[0].codePointAt(0).toString(16).padStart(4, '0') : ''} survived in ${JSON.stringify(text)}`);
}

// --- F1: the shapes the old regex missed ---------------------------------------
//
// The old stripAnsi only knew `ESC [ [0-9;?]* [a-zA-Z]`, OSC, two charset
// forms and three single bytes. Each row here is one shape it let through,
// taken from what a real pty printed in the attack review of #265.
const CASES = [
  ['SGR with colon-separated parameters', `COLON${ESC}[38:2::255:0:0m-SGR${ESC}[0m\n`, 'COLON-SGR\n'],
  ['CSI with a space intermediate byte', `CURSOR${ESC}[1 qSTYLE\n`, 'CURSORSTYLE\n'],
  ['CSI with private-marker parameters', `a${ESC}[?2004hb${ESC}[>4;2mc${ESC}[=1;2cd`, 'abcd'],
  ['tmux DCS passthrough wrapping an OSC 52', `DCS:${ESC}Ptmux;${ESC}${ESC}]52;c;SU5ORVI=${BEL}${ST}AFTER-DCS\n`, 'DCS:AFTER-DCS\n'],
  ['plain DCS', `PLAIN-DCS:${ESC}P1;2|payload${ST}END\n`, 'PLAIN-DCS:END\n'],
  ['APC (kitty graphics)', `a${ESC}_Gf=100,a=T;AAAA${ST}b`, 'ab'],
  ['PM', `a${ESC}^private message${ST}b`, 'ab'],
  ['SOS', `a${ESC}Xstring${ST}b`, 'ab'],
  ['OSC 52 terminated by BEL', `OSC52:${ESC}]52;c;QUJDREVGRw==${BEL}END`, 'OSC52:END'],
  ['OSC 8 hyperlink terminated by ST', `${ESC}]8;;http://x${ST}link${ESC}]8;;${ST}`, 'link'],
  ['C0: CR, BS, BEL, SOH, VT, FF, NUL', 'C0:A\rB\bC\x07D\x01E\x0bF\x0cG\x00H\n', 'C0:ABCDEFGH\n'],
  ['DEL', 'a\x7fb', 'ab'],
  ['CRLF line endings become LF', 'one\r\ntwo\r\n', 'one\ntwo\n'],
  ['newline and tab are text, and stay', 'a\tb\nc', 'a\tb\nc'],
  ['bidi override / embedding / isolate / marks', `safe${RLO}spoiled${PDF}${String.fromCodePoint(0x2066)}x${String.fromCodePoint(0x2069)}${String.fromCodePoint(0x200f)}${String.fromCodePoint(0x061c)}`, 'safespoiledx'],
  ['8-bit C1 CSI', '\x9b31mred\x9b0m', 'red'],
  ['8-bit C1 OSC / DCS / APC closed by 8-bit ST', 'a\x9d0;title\x9cb\x90q\x9cc\x9fx\x9cd', 'abcd'],
  ['a stray C1 that starts nothing', 'a\x85b\x80c', 'abc'],
  ['charset designators and DEC line attributes', `${ESC}(B${ESC})0${ESC}#8a${ESC} Fb`, 'ab'],
  ['single-final escapes: DECSC / DECRC / RI / RIS / DECKPAM / ST', `${ESC}7a${ESC}8b${ESC}Mc${ESC}cd${ESC}=e${ESC}>f${ST}g`, 'abcdefg'],
  ['a lone ESC before a control character', `a${ESC}\nb`, 'a\nb'],
  ['a doubled ESC: the first is alone, the second starts the sequence', `a${ESC}${ESC}[31mb`, 'ab'],
  ['ESC plus any final byte is a two-byte sequence, and takes the byte with it', `a${ESC}zb`, 'ab'],
  ['a lone ESC at the very end', `a${ESC}`, 'a'],
  ['an unterminated OSC ends at the next ESC (the terminal starts the new sequence there)', `a${ESC}]0;title${ESC}[31mb`, 'ab'],
  ['a CSI cut short by a control character leaves the character to be dropped as one', `a${ESC}[31\nb`, 'a\nb'],
  ['literal brackets and semicolons are text', 'x[31m;1;2 y', 'x[31m;1;2 y'],
  ['non-ASCII text is untouched', 'こんにちは 😀 é', 'こんにちは 😀 é'],
];

for (const [name, input, expected] of CASES) {
  test(`stripAnsi: ${name}`, () => {
    const out = stripAnsi(input);
    assert.equal(out, expected);
    assertClean(out, name);
  });
}

// The rows above are examples; this is the property they are examples of. Over
// a large deterministic sample of streams built from every kind of token
// (sequences, half-sequences, controls, bidi, text), nothing forbidden may
// come out, stripping again must change nothing, and it must never grow.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOSTILE_TOKENS = [
  ESC, `${ESC}[`, `${ESC}]`, `${ESC}P`, `${ESC}_`, `${ESC}^`, `${ESC}X`, `${ESC}(`, `${ESC}#`, `${ESC} `, `${ESC}\\`,
  `${ESC}[38:2::1:2:3m`, `${ESC}[1 q`, `${ESC}[?25l`, `${ESC}[31`, `${ESC}]0;t${BEL}`, `${ESC}]52;c;QQ==${ST}`,
  `${ESC}Ptmux;${ESC}${ESC}]52;c;QQ==${BEL}${ST}`, `${ESC}P1$r`, `${ESC}7`, `${ESC}c`, `${ESC}(B`,
  BEL, '\r', '\b', '\x00', '\x01', '\x0b', '\x0c', '\x18', '\x1a', '\x7f', '\x80', '\x85', '\x9b', '\x9c', '\x9d', '\x90', '\x9f',
  RLO, PDF, String.fromCodePoint(0x2066), String.fromCodePoint(0x200e), String.fromCodePoint(0x061c),
  '[', ']', ';', ':', '?', '\\', '31m', '0;', 'hello', ' ', '\n', '\t', 'こんにちは', '😀',
];

function hostileStream(rand, tokens) {
  let s = '';
  for (let i = 0; i < tokens; i++) s += HOSTILE_TOKENS[Math.floor(rand() * HOSTILE_TOKENS.length)];
  return s;
}

test('stripAnsi: nothing forbidden survives any stream of sequences, fragments, controls and bidi marks', () => {
  const rand = mulberry32(0x253);
  for (let n = 0; n < 3000; n++) {
    const input = hostileStream(rand, 1 + Math.floor(rand() * 24));
    const out = stripAnsi(input);
    assertClean(out, `input ${JSON.stringify(input)}`);
    assert.equal(stripAnsi(out), out, `idempotent for ${JSON.stringify(input)}`);
    assert.ok(out.length <= input.length, 'stripping never adds characters');
  }
});

// --- F1 end to end: the text views built from a session's buffer --------------

// A stream of whole tokens whose visible payload is known, so the result of the
// cap can be checked against an independent answer instead of against
// stripAnsi itself. The escape bodies deliberately contain no `a`, `b` or
// newline: any of those showing up in the text is residue of a sequence that
// was cut or parsed wrongly, not visible output.
const SEQUENCES = [
  `${ESC}[31m`, `${ESC}[0m`, `${ESC}[38:2::255:0:0m`, `${ESC}[1 q`, `${ESC}[?2004h`, `${ESC}[2K`,
  `${ESC}]0;title${BEL}`, `${ESC}]8;;http://x${ST}`, `${ESC}]52;c;QQ==${BEL}`,
  `${ESC}Ptmux;${ESC}${ESC}]52;c;QQ==${BEL}${ST}`, `${ESC}P1;2|xyz${ST}`, `${ESC}_Gf=100;QQ==${ST}`,
  `${ESC}(B`, `${ESC}#8`, `${ESC}7`, `${ESC}=`, BEL, '\r', '\b', RLO, PDF, '\x9b31m',
];
const VISIBLE = ['a', 'b', 'ab', 'bb', '\n', 'aaaa'];

test('sessionOutputText: the text view holds only what was visible, whatever the cap cuts through', () => {
  const rand = mulberry32(0xf1);
  for (let n = 0; n < 60; n++) {
    let stream = '';
    let visible = '';
    // Long enough that the 16 KiB cap bites in most runs.
    while (stream.length < 40 * 1024) {
      if (rand() < 0.5) {
        const seq = SEQUENCES[Math.floor(rand() * SEQUENCES.length)];
        stream += seq;
      } else {
        const v = VISIBLE[Math.floor(rand() * VISIBLE.length)];
        stream += v;
        visible += v;
      }
    }
    // The pty hands the stream over in arbitrary chunks, and the buffer's tail
    // can end in the middle of a sequence.
    const chunks = [];
    for (let at = 0; at < stream.length;) {
      const len = 1 + Math.floor(rand() * 900);
      chunks.push(stream.slice(at, at + len));
      at += len;
    }
    const partial = SEQUENCES[Math.floor(rand() * SEQUENCES.length)];
    let dangling = rand() < 0.5 ? partial.slice(0, 1 + Math.floor(rand() * (partial.length - 1))) : '';
    // ...or a sequence left open for longer than the whole cap.
    if (!dangling && rand() < 0.3) dangling = `${ESC}]0;` + 'x'.repeat(1 + Math.floor(rand() * 30000));
    if (dangling) chunks.push(dangling);

    const out = sessionOutputText({ outputBuffer: chunks });
    assertClean(out.text, `run ${n}`);
    assert.match(out.text, /^[ab\n]*$/, `run ${n}: residue of an escape sequence in the text`);
    assert.ok(out.text.length <= 16 * 1024, `run ${n}: capped`);
    assert.ok(visible.endsWith(out.text), `run ${n}: the text is the newest part of what was visible, unaltered`);
    assert.ok(out.text.length > 0, `run ${n}: an open sequence at the end did not blank the text`);
    assert.equal(out.truncated, true, `run ${n}: a 40 KiB stream is over the cap`);
  }
});

test('sessionOutputText: the F1 shapes never reach the modal, in a buffer of pty-sized chunks', () => {
  const buf = [
    `COLON${ESC}[38:2::255:0:0m-SGR${ESC}[0m\r\n`,
    `CURSOR${ESC}[1 qSTYLE\r\n`,
    `DCS:${ESC}Ptmux;${ESC}${ESC}]52;c;SU5ORVI=${BEL}${ST}AFTER-DCS\r\n`,
    `PLAIN-DCS:${ESC}P1;2|payload${ST}END\r\n`,
    'C0:A\rB\bC\x07D\x01E\x0bF\r\n',
    `safe${RLO}spoiled${PDF}\r\n`,
  ];
  const { text, truncated } = sessionOutputText({ outputBuffer: buf });
  assert.equal(truncated, false);
  assert.equal(text, 'COLON-SGR\nCURSORSTYLE\nDCS:AFTER-DCS\nPLAIN-DCS:END\nC0:ABCDEF\nsafespoiled\n');
  assertClean(text, 'modal text');
});

// --- F3: what is kept is decided by size, not by how the writer chunked it ------
//
// sessionOutputText used to keep the last 200 buffer CHUNKS and only then apply
// the 16 KiB cap. A program that writes in small pieces makes 200 chunks a few
// hundred bytes, so nearly the whole screen was left out -- and `truncated` said
// false, because the cap never bit. The modal offers no way to ask for more.
const CAP = 16 * 1024;

// n one-character writes, cycling through the digits so that the text says
// where in the stream each character came from.
function digitWrites(n) {
  return Array.from({ length: n }, (_, i) => String(i % 10));
}

test('sessionOutputText: 3000 one-byte writes are all there, and truncated stays false', () => {
  const chunks = digitWrites(3000);
  const out = sessionOutputText({ outputBuffer: chunks });
  assert.equal(out.text, chunks.join(''), 'nothing of a 3000-byte screen may be left out');
  assert.equal(out.text.length, 3000);
  assert.equal(out.truncated, false);
});

test('sessionOutputText: small writes past the cap keep the NEWEST 16 KiB and say truncated', () => {
  // 20000 two-byte writes = 40000 chars. 200 chunks would have been 400 chars.
  const chunks = Array.from({ length: 20000 }, (_, i) => String(i % 100).padStart(2, '0'));
  const all = chunks.join('');
  const out = sessionOutputText({ outputBuffer: chunks });
  assert.equal(out.truncated, true, 'older output was left out, so it must be reported');
  assert.equal(out.text, all.slice(-CAP), 'and what is kept is the newest 16 KiB exactly');
  assert.equal(out.raw, all.slice(-CAP));
});

test('sessionOutputText: whatever is left out is reported, for any way of chunking the same stream', () => {
  const stream = 'the quick brown fox\n'.repeat(1500); // 30000 chars
  for (const size of [1, 2, 7, 199, 200, 201, 1000, 30000]) {
    const chunks = [];
    for (let at = 0; at < stream.length; at += size) chunks.push(stream.slice(at, at + size));
    const out = sessionOutputText({ outputBuffer: chunks });
    // Chunking must make no difference to the answer.
    assert.equal(out.text, stream.slice(-CAP), `chunk size ${size}`);
    assert.equal(out.truncated, true, `chunk size ${size}`);
  }
  // ...and a stream that fits is never reported as cut, however finely it was written.
  const short = 'short output\n'.repeat(100);
  for (const size of [1, 3, 50]) {
    const chunks = [];
    for (let at = 0; at < short.length; at += size) chunks.push(short.slice(at, at + size));
    const out = sessionOutputText({ outputBuffer: chunks });
    assert.equal(out.text, short, `chunk size ${size}`);
    assert.equal(out.truncated, false, `chunk size ${size}`);
  }
});

// read_output is the other caller of the same helper, and its default read
// follows: the newest 16 KiB of the buffer, not the newest 200 chunks of it.
function readOutputOf(session, args = {}) {
  return readOutput({
    groupId: 'g',
    groupManager: { isSessionInGroup: () => true },
    sessionManager: { getSession: () => session },
  }, { sessionId: 's', ...args });
}

test('readOutput: by default it returns the newest 16 KiB whatever size the writes were', () => {
  const session = { cwd: '/x', app: 'claude', exited: false, outputBuffer: digitWrites(3000) };
  const out = readOutputOf(session);
  assert.equal(out.text, session.outputBuffer.join(''));
  assert.equal(out.raw, out.text);
  assert.equal(out.truncated, false);
});

test('readOutput: an explicit tail is still the caller\'s own count of chunks', () => {
  // The caller asked for the last 200 chunks, and gets exactly those: the
  // parameter keeps its documented meaning. (It is the DEFAULT that no longer
  // counts chunks.)
  const session = { cwd: '/x', app: 'claude', exited: false, outputBuffer: digitWrites(3000) };
  const out = readOutputOf(session, { tail: 200 });
  assert.equal(out.text, session.outputBuffer.slice(-200).join(''));
  assert.equal(out.truncated, false, 'a narrowing the caller asked for is not the server dropping output');

  // Larger than the buffer, or absurd: clamped, never an error, and still bounded by the cap.
  assert.equal(readOutputOf(session, { tail: 1e9 }).text.length, 3000);
  assert.equal(readOutputOf(session, { tail: 0 }).text, session.outputBuffer.at(-1));
  assert.equal(readOutputOf(session, { tail: Number.NaN }).text.length, 3000, 'not a number: treated as absent');
});

// --- G1: a sequence left open past the cap must not blank the text ---------------
//
// The cap is counted back from where the stream's own text ends. An escape
// sequence still open at the end of the input (a program can hold one open for
// as long as it likes) is dropped from the end, and the cap must not be spent on
// it: when it was, the window fell inside the dangling sequence, the cut moved
// past it, and the text view came out empty (#265 attack review, G1).
test('sessionOutputText: an unterminated sequence longer than the cap does not take the text before it along', () => {
  // Each with a body that cannot end it: a string runs to its terminator, and a
  // CSI / ESC-intermediate run ends at a final byte, which `x` would be.
  const open = [
    ['OSC', `${ESC}]0;`, 'x'.repeat(20000)],
    ['DCS', `${ESC}P1;2|`, 'x'.repeat(20000)],
    ['APC', `${ESC}_G`, 'x'.repeat(20000)],
    ['CSI parameters', `${ESC}[`, '1;'.repeat(10000)],
    ['ESC ( intermediates', `${ESC}(`, '!'.repeat(20000)],
    ['8-bit C1 OSC', '\x9d0;', 'x'.repeat(20000)],
  ];
  for (const [name, head, filler] of open) {
    const out = sessionOutputText({ outputBuffer: ['IMPORTANT-OUTPUT\n', head + filler] });
    assert.equal(out.text, 'IMPORTANT-OUTPUT\n', `${name}: what was printed before the open sequence is the text`);
    assert.equal(out.truncated, true, `${name}: the raw stream is over the cap`);
    // ...whichever chunk the sequence opens in, and however the tail of the stream is chunked.
    const half = filler.length / 2;
    const split = sessionOutputText({ outputBuffer: ['IMPORTANT-OUTPUT\n' + head, filler.slice(0, half), filler.slice(half)] });
    assert.equal(split.text, 'IMPORTANT-OUTPUT\n', `${name}: split across chunks`);
  }
});

test('sessionOutputText: the cap is counted back from an open sequence, and still never splits a whole one', () => {
  // Newest 16 KiB of what precedes the open sequence, exactly.
  const plain = sessionOutputText({ outputBuffer: ['a'.repeat(17000) + ESC + ']0;' + 'x'.repeat(100)] });
  assert.equal(plain.text, 'a'.repeat(CAP));
  // The window's edge falls inside a complete sequence before the open one: it starts after it.
  const edge = `${'a'.repeat(9000)}${ESC}[38:2::255:0:0m${'b'.repeat(CAP - 4)}`;
  const cut = sessionOutputText({ outputBuffer: [edge + ESC + ']0;' + 'x'.repeat(30000)] });
  assert.equal(cut.text, 'b'.repeat(CAP - 4), 'no residue of the sequence the cap cut through');
  assert.ok(cut.text.length <= CAP);
});

test('sessionOutputText: a long sequence that IS terminated still costs the text before it (unchanged)', () => {
  // Not part of G1: a 20000-char OSC that ends properly is 20000 chars of the
  // stream, so the newest 16 KiB lies inside it and holds no visible text. It
  // has always been so; pinned so a change to it is a decision, not an accident.
  const out = sessionOutputText({ outputBuffer: ['IMPORTANT-OUTPUT\n', `${ESC}]0;` + 'x'.repeat(20000) + BEL] });
  assert.equal(out.text, '');
  assert.equal(out.truncated, true);
});

// --- G2: what `truncated` reports next to an explicit tail ------------------------
test('readOutput: truncated is about the chunks that were read -- a tail narrows them, and is not itself reported', () => {
  const chunks = Array.from({ length: 2000 }, () => 'x'.repeat(20)); // 40000 chars in 2000 chunks
  const session = { cwd: '/x', app: 'claude', exited: false, outputBuffer: chunks };
  // The last 5 chunks are 100 chars: nothing of THEM is left out.
  assert.equal(readOutputOf(session, { tail: 5 }).truncated, false);
  // Everything (tail beyond the buffer): 40000 chars, the cap leaves older ones out.
  assert.equal(readOutputOf(session, { tail: 1e9 }).truncated, true);
  // A tail whose chunks are themselves over the cap: reported, like any read.
  assert.equal(readOutputOf(session, { tail: 1000 }).truncated, true);
  assert.equal(readOutputOf(session, { tail: 1000 }).text.length, CAP);
});
