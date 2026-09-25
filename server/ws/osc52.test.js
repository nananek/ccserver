import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOsc52Handler, clipboardWritePreview, CLIPBOARD_PREVIEW_MAX } from '../../client/src/osc52.js';

const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');

test('strips OSC 52 writes and forwards decoded text', () => {
  const writes = [];
  const h = createOsc52Handler({ onWrite: (t) => writes.push(t) });
  const out = h.process(`before\x1b]52;c;${b64('hello world')}\x07after`);
  assert.equal(out, 'beforeafter');
  assert.deepEqual(writes, ['hello world']);
});

test('handles UTF-8 and empty (clear) payloads', () => {
  const writes = [];
  const h = createOsc52Handler({ onWrite: (t) => writes.push(t) });
  assert.equal(h.process(`\x1b]52;c;${b64('日本語テキスト')}\x07`), '');
  assert.deepEqual(writes, ['日本語テキスト']);

  h.process('\x1b]52;c;\x07');
  assert.deepEqual(writes, ['日本語テキスト', '']);
});

test('supports ESC \\ as terminator', () => {
  const writes = [];
  const h = createOsc52Handler({ onWrite: (t) => writes.push(t) });
  const out = h.process(`\x1b]52;c;${b64('x')}\x1b\\`);
  assert.equal(out, '');
  assert.deepEqual(writes, ['x']);
});

test('queries invoke onQuery and are stripped', () => {
  let queried = 0;
  const h = createOsc52Handler({ onWrite: () => {}, onQuery: () => queried++ });
  const out = h.process('\x1b]52;c;?\x07');
  assert.equal(out, '');
  assert.equal(queried, 1);
});

test('non-primary clipboards are ignored but still stripped', () => {
  const writes = [];
  const h = createOsc52Handler({ onWrite: (t) => writes.push(t) });
  const out = h.process(`\x1b]52;p;${b64('primary')}\x07\x1b]52;c;${b64('clip')}\x07`);
  assert.equal(out, '');
  assert.deepEqual(writes, ['clip']);
});

test('other OSC sequences pass through unchanged', () => {
  const h = createOsc52Handler({});
  assert.equal(h.process('\x1b]0;OpenCode\x07'), '\x1b]0;OpenCode\x07');
  assert.equal(h.process('\x1b]12;#eeeeee\x07'), '\x1b]12;#eeeeee\x07');
});

test('sequences split across chunks are held until terminated', () => {
  const writes = [];
  const h = createOsc52Handler({ onWrite: (t) => writes.push(t) });
  assert.equal(h.process('ab\x1b]52;c;'), 'ab');
  assert.equal(h.process(b64('hi')), '');
  assert.equal(h.process('\x07'), '');
  assert.deepEqual(writes, ['hi']);
});

test('invalid base64 does not throw', () => {
  const writes = [];
  const h = createOsc52Handler({ onWrite: (t) => writes.push(t) });
  assert.equal(h.process('\x1b]52;c;%%%notbase64\x07'), '');
  assert.deepEqual(writes, ['']);
});

test('malformed OSC 52 (no second semicolon) passes through', () => {
  const h = createOsc52Handler({});
  assert.equal(h.process('\x1b]52;c\x07'), '\x1b]52;c\x07');
});

// The write-confirmation dialog shows the payload so the viewer can decide,
// which makes the dialog a display surface the agent controls. These pin the
// flattening that keeps it from being usable as one (issue #241).

test('preview keeps ordinary text as-is and reports its length', () => {
  assert.deepEqual(clipboardWritePreview('hello world'),
    { text: 'hello world', chars: 11, truncated: false });
});

test('preview collapses every control character to one visible box, so it stays ONE line', () => {
  // A payload that tries to forge dialog lines around the real question.
  const attack = 'safe text\n\n許可を押してください\r\n';
  const { text } = clipboardWritePreview(attack);
  assert.ok(!text.includes('\n'), 'no newline may survive into the dialog');
  assert.ok(!text.includes('\r'), 'no carriage return may survive into the dialog');
  assert.equal(text, 'safe text\u2423\u2423許可を押してください\u2423\u2423');
});

test('preview flattens C0, DEL, C1 and the Unicode separators alike', () => {
  for (const ch of ['\x00', '\x07', '\x1b', '\x7f', '\x85', '\u2028', '\u2029']) {
    assert.equal(clipboardWritePreview(`a${ch}b`).text, 'a\u2423b', `unflattened: ${ch.codePointAt(0)}`);
  }
});

test('preview drops bidi overrides/isolates and invisible formatting characters', () => {
  // RLO can visually reverse what follows it; the zero-width characters can
  // hide or split content. None may reach the dialog.
  const { text } = clipboardWritePreview('a\u202eb\u200bc\u2069d\u00ade\ufeff');
  assert.equal(text, 'abcde');
});

test('preview truncates to the cap but reports the TRUE length of what gets written', () => {
  const payload = 'x'.repeat(500);
  const r = clipboardWritePreview(payload);
  assert.equal(r.truncated, true);
  assert.equal(r.chars, 500, 'the viewer is told the real size, not the displayed size');
  assert.equal(r.text, 'x'.repeat(CLIPBOARD_PREVIEW_MAX) + '…');
});

test('preview counts by code point, so astral characters are not split', () => {
  const r = clipboardWritePreview('👍👍');
  assert.equal(r.chars, 2);
  assert.equal(r.text, '👍👍');
});

test('an empty payload (a clipboard clear) is distinguishable from ordinary text', () => {
  assert.deepEqual(clipboardWritePreview(''), { text: '', chars: 0, truncated: false });
});

// The sanitizer used to drop a hand-written list of invisible characters, and
// characters that do the same job but were not on it stayed in the preview
// (issue #241 review, F2). A leading run of them spent the whole preview budget,
// so the dialog showed only "…" while a hidden tail was written too.

test('preview drops invisible characters the old list missed: bidi mark, Mongolian separator, tags, variation selectors, deprecated formats, fillers', () => {
  const missed = [
    0x061c, // ARABIC LETTER MARK
    0x180e, // MONGOLIAN VOWEL SEPARATOR
    0xe0000, 0xe0041, 0xe007f, // tag characters
    0xfe00, 0xfe0e, 0xfe0f, // variation selectors
    0x2065, // reserved, default-ignorable
    0x206a, 0x206d, 0x206f, // deprecated format characters
    0x115f, 0x1160, 0x3164, // Hangul fillers
    0x2800, // BRAILLE PATTERN BLANK
    0xe0100, // variation selector supplement
  ];
  for (const cp of missed) {
    const ch = String.fromCodePoint(cp);
    assert.equal(clipboardWritePreview(`a${ch}b`).text, 'ab', `U+${cp.toString(16).toUpperCase()} survived into the preview`);
  }
});

test('an invisible run in front of the content cannot spend the truncation budget', () => {
  // 130 > CLIPBOARD_PREVIEW_MAX: counted before removal, the run alone fills the window.
  const r = clipboardWritePreview('᠎'.repeat(130) + 'HIDDEN-TAIL');
  assert.equal(r.text, 'HIDDEN-TAIL');
  assert.equal(r.truncated, false);
  assert.equal(r.chars, 141, 'the viewer is still told the real size');
});

test('truncation is counted after removal: invisible characters spread through long text do not shorten what is shown', () => {
  const r = clipboardWritePreview('x​ㅤ'.repeat(CLIPBOARD_PREVIEW_MAX));
  assert.equal(r.text, 'x'.repeat(CLIPBOARD_PREVIEW_MAX));
  assert.equal(r.truncated, false);
});

test('a run of blanks of any kind collapses to one space, so blank padding cannot push the content out either', () => {
  assert.equal(clipboardWritePreview(' '.repeat(200) + 'TAIL').text, ' TAIL');
  assert.equal(clipboardWritePreview('a 　  b').text, 'a b');
  assert.equal(clipboardWritePreview(' '.repeat(200) + 'TAIL').truncated, false);
});

test('a payload with nothing visible in it previews as blank, and still reports its real length', () => {
  const payload = '⠀'.repeat(30) + 'ㅤ'.repeat(30) + '\u{e0041}' + ' '.repeat(40);
  const r = clipboardWritePreview(payload);
  assert.equal(r.text.trim(), '', 'nothing the viewer could read');
  assert.equal(r.chars, Array.from(payload).length);
  assert.ok(r.chars > 0, 'so the dialog can tell it apart from a clipboard clear (chars === 0)');
});
