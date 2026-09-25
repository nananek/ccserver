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
