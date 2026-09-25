// R2 (#265) attack tests: stripAnsi / sessionOutputText and the copy modal's
// data path. Acceptance artifact: RED tests assert the SAFE behavior and fail
// on c311e229d8b2f52c8c7bd5e8c4e7f895ae50924d; GREEN tests pin behavior that
// must not regress.
//
// Run (from server/):
//   node --import ./testEnvDefaults.js --test --test-timeout=60000 security/terminal-text.attack.test.js
//
// Pure functions only: no network, no pty, no writes outside os.tmpdir().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripAnsi, sessionOutputText, readOutput } from '../ws/mcpTools.js';
import { findSessionLimitReset } from '../ws/sessionLimitDetect.js';

const ESC = '\x1b';
const BEL = '\x07';
const ST = ESC + '\\';
const RLO = String.fromCodePoint(0x202e);
const PDF = String.fromCodePoint(0x202c);
const FORBIDDEN = /[\x00-\x08\x0b-\x1f\x7f-\x9f]|\p{Bidi_Control}/u;

function assertClean(text, label) {
  const m = FORBIDDEN.exec(text);
  assert.equal(m, null, `${label}: control U+${m ? m[0].codePointAt(0).toString(16) : ''} survived: ${JSON.stringify(text)}`);
}

// ---------------------------------------------------------------------------
// GREEN: F1 shapes (the old regex let these through; each must resolve to its
// visible payload and leave no control byte).
// ---------------------------------------------------------------------------

const F1_SHAPES = [
  ['colon-separated SGR', `A${ESC}[38:2::255:0:0mB${ESC}[0m`, 'AB'],
  ['CSI with a space intermediate', `A${ESC}[1 qB`, 'AB'],
  ['CSI with private markers', `A${ESC}[?2004hB${ESC}[>4;2mC${ESC}[=1;2cD`, 'ABCD'],
  ['tmux DCS passthrough around an OSC 52', `A${ESC}Ptmux;${ESC}${ESC}]52;c;QQ==${BEL}${ST}B`, 'AB'],
  ['DCS / PM / APC / SOS', `A${ESC}P1;2|xyz${ST}B${ESC}^pm${ST}C${ESC}_apc${ST}D${ESC}Xsos${ST}E`, 'ABCDE'],
  ['unterminated OSC ends at the next ESC', `A${ESC}]0;title${ESC}[31mB`, 'AB'],
  ['8-bit C1 CSI / OSC / ST', `A\x9b31mB\x9d0;t\x9cC`, 'ABC'],
  ['lone ESC, doubled ESC, ESC plus one final byte', `A${ESC}\nB${ESC}${ESC}[31mC${ESC}zD`, 'A\nBCD'],
  ['charset / DEC line attribute / single finals', `A${ESC}(B${ESC}#8${ESC}7${ESC}=${ESC}>B`, 'AB'],
  ['bidi controls are removed', `A${RLO}spoiled${PDF}${String.fromCodePoint(0x2066)}x${String.fromCodePoint(0x061c)}`, 'Aspoiledx'],
  ['CRLF becomes LF; CR and BEL go', 'A\r\nB\rC\x07D', 'A\nBCD'],
  ['literal brackets stay text', 'x[31m;1;2 y', 'x[31m;1;2 y'],
];

for (const [name, input, expected] of F1_SHAPES) {
  test(`GREEN: stripAnsi removes the whole sequence (${name})`, () => {
    const out = stripAnsi(input);
    assert.equal(out, expected);
    assertClean(out, name);
  });
}

// A deterministic property check over streams built from sequence fragments,
// controls and bidi marks: nothing forbidden comes out, stripping is
// idempotent, and it never grows. (Independent seed and token table from the
// PR's own test file.)
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
const TOKENS = [
  ESC, `${ESC}[`, `${ESC}]`, `${ESC}P`, `${ESC}_`, `${ESC}^`, `${ESC}X`, `${ESC}(`, `${ESC}#`, `${ESC} `, `${ESC}\\`,
  `${ESC}[38:2::1:2:3m`, `${ESC}[1 q`, `${ESC}[?25l`, `${ESC}[0;1;31m`, `${ESC}]0;t${BEL}`, `${ESC}]52;c;QQ==${ST}`,
  `${ESC}Ptmux;${ESC}${ESC}]52;c;QQ==${BEL}${ST}`, `${ESC}P1$r`, `${ESC}7`, `${ESC}c`, `${ESC}(B`,
  BEL, '\r', '\b', '\x00', '\x01', '\x0b', '\x18', '\x1a', '\x7f', '\x80', '\x85', '\x9b', '\x9c', '\x9d', '\x90', '\x9f',
  RLO, PDF, String.fromCodePoint(0x2066), String.fromCodePoint(0x200e), String.fromCodePoint(0x061c),
  '[', ']', ';', ':', '?', '\\', '31m', '0;', 'visible', ' ', '\n', '\t', 'こんにちは', '😀',
];

test('GREEN: no forbidden character survives any stream of sequences, fragments, controls and bidi marks', () => {
  const rand = mulberry32(0x265);
  for (let n = 0; n < 2000; n++) {
    let input = '';
    const count = 1 + Math.floor(rand() * 24);
    for (let i = 0; i < count; i++) input += TOKENS[Math.floor(rand() * TOKENS.length)];
    const out = stripAnsi(input);
    assertClean(out, `stream ${n}`);
    assert.equal(stripAnsi(out), out, `idempotent for ${JSON.stringify(input)}`);
    assert.ok(out.length <= input.length, 'stripping never adds characters');
  }
});

test('GREEN: pathological inputs stay linear (1 MB of introducers under a generous bound)', () => {
  const cases = [
    (`${ESC}[`).repeat(200000),
    (`${ESC}[1;`).repeat(160000),
    (`${ESC}(`).repeat(200000),
    (`${ESC}]0;x`).repeat(120000),
    (`${ESC}P`).repeat(200000),
    '\x9b'.repeat(400000),
  ];
  const start = Date.now();
  for (const input of cases) {
    const out = stripAnsi(input);
    assertClean(out, 'pathological');
  }
  const ms = Date.now() - start;
  assert.ok(ms < 5000, `pathological stripping took ${ms}ms`);
});

// ---------------------------------------------------------------------------
// GREEN: F3 -- what is kept is decided by size, not by how the pty chunked it.
// ---------------------------------------------------------------------------

const CAP = 16 * 1024;

test('GREEN: 3000 one-byte writes are all kept, and truncated stays false', () => {
  const chunks = Array.from({ length: 3000 }, (_, i) => String(i % 10));
  const out = sessionOutputText({ outputBuffer: chunks });
  assert.equal(out.text, chunks.join(''));
  assert.equal(out.truncated, false);
});

test('GREEN: over the cap, the newest 16 KiB is kept whatever the chunk size, and truncated is true', () => {
  const stream = 'the quick brown fox\n'.repeat(1500); // 30000 chars
  for (const size of [1, 7, 200, 16384, 30000]) {
    const chunks = [];
    for (let at = 0; at < stream.length; at += size) chunks.push(stream.slice(at, at + size));
    const out = sessionOutputText({ outputBuffer: chunks });
    assert.equal(out.text, stream.slice(-CAP), `chunk size ${size}`);
    assert.equal(out.truncated, true, `chunk size ${size}`);
  }
});

test('GREEN: an explicit tail is still the caller\'s own chunk count', () => {
  const session = { cwd: '/x', app: 'claude', exited: false, outputBuffer: Array.from({ length: 3000 }, (_, i) => String(i % 10)) };
  const deps = { groupId: 'g', groupManager: { isSessionInGroup: () => true }, sessionManager: { getSession: () => session } };
  const tailed = readOutput(deps, { sessionId: 's', tail: 200 });
  assert.equal(tailed.text, session.outputBuffer.slice(-200).join(''));
  assert.equal(readOutput(deps, { sessionId: 's', tail: Number.NaN }).text.length, 3000);
  assert.equal(readOutput(deps, { sessionId: 's', tail: 1e9 }).text.length, 3000);
  assert.equal(readOutput(deps, { sessionId: 's', tail: 0 }).text, '9');
});

// ---------------------------------------------------------------------------
// GREEN: the session-limit detector still sees its message through the new
// stripping (the consumer that changed character sets underneath).
// ---------------------------------------------------------------------------

test('GREEN: the session-limit detector still matches through SGR and cursor-position noise', () => {
  const noisy = `\x1b[2K\r\x1b[31mYou've hit your session limit · resets 3:00 pm (Asia/Tokyo)\x1b[0m\r\n`;
  assert.ok(findSessionLimitReset(stripAnsi(noisy)), 'plain SGR-wrapped message');
  const positioned = `\x1b[10GYou've\x1b[10Ghit\x1b[10Gyoursessionlimit·resets 2:10 am (Asia/Tokyo)`;
  assert.ok(findSessionLimitReset(stripAnsi(positioned)), 'cursor-positioned message');
});

// ---------------------------------------------------------------------------
// GREEN: F2 regression pin -- the copy modal must fetch through authFetch.
// In token mode a bare fetch() has no Authorization header, which is exactly
// how the modal came back empty before this revision.
// ---------------------------------------------------------------------------

test('GREEN: the copy modal fetches /api/sessions/:id/text through authFetch', () => {
  const src = readFileSync(new URL('../../client/src/components/TerminalView.jsx', import.meta.url), 'utf8');
  assert.match(src, /authFetch\([^\n]*\/api\/sessions\/[^\n]*\/text/, 'the text route must go through authFetch');
  const bare = /(^|[^h])\bfetch\(\s*`\/api\/sessions\/\$\{[^}]+\}\/text`/m;
  assert.ok(!bare.test(src), 'the text route must not be fetched with a bare fetch()');
});

// ---------------------------------------------------------------------------
// RED: a dangling escape sequence longer than the cap blanks the WHOLE text
// view. cleanTextCut advances the cut start past the cap for a sequence that
// straddles it, and then a sequence that dangles to EOF sets the end before
// that start: slice(start, end) is empty. The visible text that preceded the
// dangling sequence is discarded, where the pre-#265 implementation kept it.
//
// Reproduced: outputBuffer = ['IMPORTANT-OUTPUT\n', ESC + ']0;' + 'x'*20000]
// gives text === '' today. A terminal program (the agent) can hold a sequence
// open indefinitely, so this blanks the copy modal and read_output.text on
// demand. Safe behavior: the visible text before the dangling sequence is
// still returned (bounded by the same cap).
// ---------------------------------------------------------------------------

test('RED: an unterminated sequence longer than the cap must not discard the visible text before it', () => {
  const chunks = ['IMPORTANT-OUTPUT\n', ESC + ']0;' + 'x'.repeat(20000)];
  const out = sessionOutputText({ outputBuffer: chunks });
  assert.ok(out.text.length <= CAP, 'the cap still holds');
  assert.match(out.text, /IMPORTANT-OUTPUT/, 'visible text printed before a dangling sequence must survive');
  assertClean(out.text, 'dangling sequence');

  // The same stream read through the MCP tool's helper: one implementation.
  const session = { cwd: '/x', app: 'claude', exited: false, outputBuffer: chunks };
  const deps = { groupId: 'g', groupManager: { isSessionInGroup: () => true }, sessionManager: { getSession: () => session } };
  assert.match(readOutput(deps, { sessionId: 's' }).text, /IMPORTANT-OUTPUT/);

  // Control: when the dangling sequence starts after the cap boundary, the
  // kept tail is the visible text before it (this already works).
  const tailKept = sessionOutputText({ outputBuffer: ['a'.repeat(17000) + ESC + ']0;' + 'x'.repeat(100)] });
  assert.equal(tailKept.text, 'a'.repeat(17000).slice(-CAP));
});
