// agentNotifyDetect.js -- the OSC/BEL notification parser that reads agent
// desktop notifications out of the pty byte stream (plan: plan-notify-bridge,
// Step 1). Pure module: no server, no session, no I/O, so every case here is a
// plain feed()/collect assertion.
//
// The two behaviors worth guarding hardest:
//   - OSC 9;4 (progress) and 9;2 (badge) must NOT be mistaken for a
//     notification. claude and opencode both stream the progress form
//     continuously while a turn runs, so getting this wrong is a push per
//     animation frame rather than a cosmetic bug.
//   - Chunk boundaries. node-pty hands over whatever the kernel had; a
//     sequence is routinely split. Several cases below re-feed the same input
//     one character at a time and assert the result is identical.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNotifyDetector,
  MAX_OSC_LEN,
  TITLE_MAX,
  BODY_MAX,
  KITTY_PENDING_TTL_MS,
  KITTY_ENTRY_MAX_CHARS,
  KITTY_PENDING_MAX,
} from './agentNotifyDetect.js';

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;
const osc = (body, term = BEL) => `${ESC}]${body}${term}`;

// Feed `input` as one chunk and collect what came out.
function collect(input, opts = {}) {
  const events = [];
  const d = createNotifyDetector({ onNotification: (e) => events.push(e), ...opts });
  d.feed(input);
  return events;
}

// Feed `input` one character at a time -- the worst case node-pty can produce.
function collectByChar(input, opts = {}) {
  const events = [];
  const d = createNotifyDetector({ onNotification: (e) => events.push(e), ...opts });
  for (const ch of input) d.feed(ch);
  return events;
}

// Feed `input` split at every possible position, asserting all splits agree
// with the single-chunk result. This is the real regression net for the carry
// buffer: an off-by-one in the terminator search shows up here and nowhere else.
function assertSplitInvariant(input, opts = {}) {
  const whole = collect(input, opts);
  assert.deepEqual(collectByChar(input, opts), whole, 'per-character feed differs');
  for (let i = 1; i < input.length; i++) {
    const events = [];
    const d = createNotifyDetector({ onNotification: (e) => events.push(e), ...opts });
    d.feed(input.slice(0, i));
    d.feed(input.slice(i));
    assert.deepEqual(events, whole, `split at ${i} differs`);
  }
  return whole;
}

// --- OSC 777 (ghostty channel / opencode) ------------------------------------

test('OSC 777 notify yields title and body', () => {
  const events = assertSplitInvariant(osc('777;notify;Claude Code;Waiting for your input'));
  assert.deepEqual(events, [{
    kind: 'notification', source: 'osc777',
    title: 'Claude Code', body: 'Waiting for your input',
  }]);
});

test('OSC 777 message keeps its own semicolons', () => {
  // Nothing escapes ';' in the payload, so everything past the title is the
  // message -- a body of "a;b;c" must survive intact.
  const events = collect(osc('777;notify;T;a;b;c'));
  assert.deepEqual(events, [{ kind: 'notification', source: 'osc777', title: 'T', body: 'a;b;c' }]);
});

test('OSC 777 with an empty title reports title null', () => {
  const events = collect(osc('777;notify;;body only'));
  assert.deepEqual(events, [{ kind: 'notification', source: 'osc777', title: null, body: 'body only' }]);
});

test('OSC 777 with no message yields an empty body', () => {
  const events = collect(osc('777;notify;Title only'));
  assert.deepEqual(events, [{ kind: 'notification', source: 'osc777', title: 'Title only', body: '' }]);
});

test('OSC 777 non-notify subcommands are ignored', () => {
  assert.deepEqual(collect(osc('777;precmd;something')), []);
  assert.deepEqual(collect(osc('777;notify-send;x;y')), []);
});

test('OSC 777 terminated by ST works the same as BEL', () => {
  assert.deepEqual(
    collect(osc('777;notify;T;B', ST)),
    collect(osc('777;notify;T;B', BEL)),
  );
});

// --- OSC 9: the progress/badge trap ------------------------------------------

test('OSC 9;4 progress is never a notification', () => {
  // claude: osc(ITERM2=9, PROGRESS=4, state, pct). These stream continuously.
  for (const body of ['9;4;0', '9;4;1;50', '9;4;2;100', '9;4;3', '9;4;1;0']) {
    assert.deepEqual(collect(osc(body)), [], `${body} must be dropped (BEL)`);
    assert.deepEqual(collect(osc(body, ST)), [], `${body} must be dropped (ST)`);
  }
});

test('OSC 9;2 badge is never a notification', () => {
  assert.deepEqual(collect(osc('9;2;42')), []);
});

test('a burst of progress frames produces no events at all', () => {
  let s = '';
  for (let i = 0; i <= 100; i++) s += osc(`9;4;1;${i}`);
  s += osc('9;4;0');
  assert.deepEqual(collect(s), []);
});

test('OSC 9 plain text is a notification with no title', () => {
  const events = assertSplitInvariant(osc('9;Claude Code: needs your permission'));
  assert.deepEqual(events, [{
    kind: 'notification', source: 'osc9',
    title: null, body: 'Claude Code: needs your permission',
  }]);
});

test('OSC 9;0 strips the explicit NOTIFY subcode', () => {
  const events = collect(osc('9;0;hello'));
  assert.deepEqual(events, [{ kind: 'notification', source: 'osc9', title: null, body: 'hello' }]);
});

test('an empty OSC 9 emits nothing', () => {
  assert.deepEqual(collect(osc('9;')), []);
  assert.deepEqual(collect(osc('9')), []);
});

// --- OSC 99 (kitty channel) --------------------------------------------------

// The exact three-sequence shape claude emits for preferredNotifChannel=kitty.
const kittyTriple = (id, title, body) =>
  osc(`99;i=${id}:d=0:p=title;${title}`, ST)
  + osc(`99;i=${id}:p=body;${body}`, ST)
  + osc(`99;i=${id}:d=1:a=focus;`, ST);

test('kitty OSC 99 assembles three chunks into exactly one notification', () => {
  const events = assertSplitInvariant(kittyTriple(4242, 'Claude Code', 'Turn finished'));
  assert.deepEqual(events, [{
    kind: 'notification', source: 'osc99',
    title: 'Claude Code', body: 'Turn finished',
  }]);
});

test('kitty action-only chunks never fire an empty notification', () => {
  assert.deepEqual(collect(osc('99;i=1:d=1:a=focus;', ST)), []);
  assert.deepEqual(collect(osc('99;i=1:d=1:a=report;', ST)), []);
});

test('kitty single-chunk form (d absent = done) fires immediately', () => {
  const events = collect(osc('99;i=7;Hello', ST));
  assert.deepEqual(events, [{ kind: 'notification', source: 'osc99', title: 'Hello', body: '' }]);
});

test('kitty d=0 alone never fires', () => {
  const events = collect(osc('99;i=7:d=0:p=title;Hello', ST));
  assert.deepEqual(events, []);
});

test('kitty e=1 payloads are base64-decoded', () => {
  const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');
  const events = collect(
    osc(`99;i=9:d=0:p=title:e=1;${b64('日本語タイトル')}`, ST)
    + osc(`99;i=9:p=body:e=1;${b64('本文')}`, ST),
  );
  assert.deepEqual(events, [{
    kind: 'notification', source: 'osc99', title: '日本語タイトル', body: '本文',
  }]);
});

test('kitty chunk sets for different ids do not bleed into each other', () => {
  const events = collect(
    osc('99;i=1:d=0:p=title;One', ST)
    + osc('99;i=2:d=0:p=title;Two', ST)
    + osc('99;i=2:p=body;second', ST)
    + osc('99;i=1:p=body;first', ST),
  );
  assert.deepEqual(events, [
    { kind: 'notification', source: 'osc99', title: 'Two', body: 'second' },
    { kind: 'notification', source: 'osc99', title: 'One', body: 'first' },
  ]);
});

test('an abandoned kitty chunk set is expired rather than pinned forever', () => {
  let clock = 1_000_000;
  const events = [];
  const d = createNotifyDetector({ onNotification: (e) => events.push(e), now: () => clock });
  d.feed(osc('99;i=1:d=0:p=title;orphan', ST));
  assert.equal(d.pendingKitty(), 1);
  clock += KITTY_PENDING_TTL_MS + 1;
  // Any later OSC 99 runs the expiry sweep.
  d.feed(osc('99;i=2;later', ST));
  assert.deepEqual(events, [{ kind: 'notification', source: 'osc99', title: 'later', body: '' }]);
  assert.equal(d.pendingKitty(), 0);
});

test('a stream of never-completed kitty ids stays bounded', () => {
  const d = createNotifyDetector({ onNotification: () => {} });
  for (let i = 0; i < 500; i++) d.feed(osc(`99;i=${i}:d=0:p=title;x`, ST));
  assert.ok(d.pendingKitty() <= 17, `pending kitty entries: ${d.pendingKitty()}`);
});

// --- other OSC opcodes must not be mistaken for notifications ----------------

test('OSC 52 (clipboard), titles and hyperlinks are ignored', () => {
  const b64 = Buffer.from('clipboard text', 'utf-8').toString('base64');
  const input = osc(`52;c;${b64}`)
    + osc('0;window title')
    + osc('2;icon title')
    + osc('8;;https://example.com')
    + osc('133;A')
    + osc('1337;SetBadgeFormat=eA==');
  assert.deepEqual(collect(input), []);
});

// --- tmux / screen passthrough ----------------------------------------------

const tmuxWrap = (inner) => `${ESC}Ptmux;${inner.replaceAll(ESC, ESC + ESC)}${ST}`;
const screenWrap = (inner) => `${ESC}P${inner.replaceAll(ESC, ESC + ESC)}${ST}`;

test('a tmux-wrapped notification is unwrapped', () => {
  const events = assertSplitInvariant(tmuxWrap(osc('777;notify;T;B')));
  assert.deepEqual(events, [{ kind: 'notification', source: 'osc777', title: 'T', body: 'B' }]);
});

test('a screen-wrapped notification is unwrapped', () => {
  const events = collect(screenWrap(osc('777;notify;T;B')));
  assert.deepEqual(events, [{ kind: 'notification', source: 'osc777', title: 'T', body: 'B' }]);
});

test('a tmux-wrapped progress frame is still dropped', () => {
  assert.deepEqual(collect(tmuxWrap(osc('9;4;1;10'))), []);
});

test('non-passthrough DCS payloads are consumed, not parsed', () => {
  // A sixel-ish DCS whose data happens to contain the ']777;notify;' bytes
  // must not become a notification just because it was re-scanned.
  const input = `${ESC}Pq]777;notify;X;Y${ST}after`;
  assert.deepEqual(collect(input), []);
});

test('text after a DCS wrapper is still scanned', () => {
  const events = collect(`${tmuxWrap(osc('777;notify;A;B'))}${osc('777;notify;C;D')}`);
  assert.deepEqual(events.map((e) => e.title), ['A', 'C']);
});

// --- CSI / realistic TUI traffic --------------------------------------------

test('ordinary TUI redraw traffic produces no notifications', () => {
  const frame = `${ESC}[2J${ESC}[H${ESC}[?25l${ESC}[1;32mok${ESC}[0m`
    + `${ESC}[38;2;255;0;0mcolored${ESC}[m${ESC}(B${ESC}[?1049h`
    + `esc-in-text: ${ESC}[K done${ESC}[?25h`;
  assert.deepEqual(collect(frame), []);
  assert.deepEqual(collect(frame, { allowBell: true }), []);
});

test('a notification embedded in a redraw is still found', () => {
  const input = `${ESC}[2J${ESC}[H`
    + osc('9;4;1;30')
    + `${ESC}[1mrendering${ESC}[0m`
    + osc('777;notify;Claude Code;Permission needed')
    + `${ESC}[?25h`;
  const events = assertSplitInvariant(input);
  assert.deepEqual(events, [{
    kind: 'notification', source: 'osc777',
    title: 'Claude Code', body: 'Permission needed',
  }]);
});

// --- BEL ---------------------------------------------------------------------

test('a bare BEL is ignored by default', () => {
  assert.deepEqual(collect(`ding${BEL}dong`), []);
});

test('a bare BEL is reported when allowBell is on', () => {
  assert.deepEqual(collect(`ding${BEL}dong${BEL}`, { allowBell: true }), [
    { kind: 'bell', source: 'bell', title: null, body: '' },
    { kind: 'bell', source: 'bell', title: null, body: '' },
  ]);
});

test('an OSC terminator BEL is not also counted as a bell', () => {
  const events = collect(osc('777;notify;T;B'), { allowBell: true });
  assert.deepEqual(events, [{ kind: 'notification', source: 'osc777', title: 'T', body: 'B' }]);
});

// --- sanitizing and bounds ---------------------------------------------------

test('C1 controls are flattened and runs of spaces collapsed', () => {
  // C0 controls can no longer appear raw inside an OSC -- they abort it (see
  // the F2 cases below). C1 (0x80-0x9f) still can, and still gets flattened.
  const events = collect(osc('777;notify;a\u0085b;c\u009b\u009bd   e'));
  assert.deepEqual(events, [{ kind: 'notification', source: 'osc777', title: 'a b', body: 'c d e' }]);
});

test('control characters arriving via base64 are still sanitized', () => {
  // kitty's e=1 payloads are decoded AFTER the scanner, so this is the one
  // path by which a C0 byte can still reach the sanitizer.
  const b64 = (x) => Buffer.from(x, 'utf-8').toString('base64');
  const events = collect(osc(`99;i=1:e=1;${b64('a\tb\nc')}`, ST));
  assert.deepEqual(events, [{ kind: 'notification', source: 'osc99', title: 'a b c', body: '' }]);
});

test('title and body are truncated with an ellipsis', () => {
  const events = collect(osc(`777;notify;${'T'.repeat(TITLE_MAX * 2)};${'B'.repeat(BODY_MAX * 2)}`));
  assert.equal(events.length, 1);
  assert.equal(events[0].title.length, TITLE_MAX);
  assert.equal(events[0].body.length, BODY_MAX);
  assert.ok(events[0].title.endsWith('…'));
  assert.ok(events[0].body.endsWith('…'));
});

test('a whitespace-only title reports null rather than an empty string', () => {
  const events = collect(osc('777;notify;   ;body'));
  assert.equal(events[0].title, null);
});

test('an unterminated OSC does not grow the carry buffer without bound', () => {
  const d = createNotifyDetector({ onNotification: () => {} });
  for (let i = 0; i < 40; i++) d.feed(`${i === 0 ? `${ESC}]777;notify;` : ''}${'x'.repeat(4096)}`);
  assert.ok(d.pendingBytes() <= MAX_OSC_LEN, `carry buffer grew to ${d.pendingBytes()}`);
});

test('the parser resynchronizes after a runaway sequence', () => {
  const events = [];
  const d = createNotifyDetector({ onNotification: (e) => events.push(e) });
  d.feed(`${ESC}]777;notify;${'x'.repeat(MAX_OSC_LEN * 2)}`);
  d.feed(osc('777;notify;T;B'));
  assert.deepEqual(events, [{ kind: 'notification', source: 'osc777', title: 'T', body: 'B' }]);
});

test('plain output does not accumulate in the carry buffer', () => {
  const d = createNotifyDetector({ onNotification: () => {} });
  for (let i = 0; i < 100; i++) d.feed('a'.repeat(10_000));
  assert.equal(d.pendingBytes(), 0);
});

test('a lone trailing ESC is carried, not dropped', () => {
  const events = [];
  const d = createNotifyDetector({ onNotification: (e) => events.push(e) });
  d.feed(`text${ESC}`);
  d.feed(`]777;notify;T;B${BEL}`);
  assert.deepEqual(events, [{ kind: 'notification', source: 'osc777', title: 'T', body: 'B' }]);
});

// --- robustness --------------------------------------------------------------

test('a throwing callback never breaks the data path', () => {
  const seen = [];
  let first = true;
  const d = createNotifyDetector({
    onNotification: (e) => {
      if (first) { first = false; throw new Error('boom'); }
      seen.push(e);
    },
  });
  assert.doesNotThrow(() => {
    d.feed(osc('777;notify;A;1'));
    d.feed(osc('777;notify;B;2'));
  });
  assert.deepEqual(seen.map((e) => e.title), ['B']);
});

test('empty and undefined chunks are no-ops', () => {
  const d = createNotifyDetector({ onNotification: () => { throw new Error('should not fire'); } });
  assert.doesNotThrow(() => { d.feed(''); d.feed(undefined); d.feed(null); });
});

test('reset clears both the carry buffer and pending kitty chunks', () => {
  const d = createNotifyDetector({ onNotification: () => {} });
  // Order matters: an unterminated OSC legitimately swallows whatever follows
  // it until a terminator shows up (that is what a real terminal does too), so
  // the kitty chunk has to land first for both states to be pending at once.
  d.feed(osc('99;i=1:d=0:p=title;x', ST));
  d.feed(`${ESC}]777;notify;partial`);
  assert.ok(d.pendingBytes() > 0);
  assert.equal(d.pendingKitty(), 1);
  d.reset();
  assert.equal(d.pendingBytes(), 0);
  assert.equal(d.pendingKitty(), 0);
});

test('no callback at all is tolerated', () => {
  const d = createNotifyDetector({});
  assert.doesNotThrow(() => d.feed(osc('777;notify;T;B')));
});

// --- attacker-review regressions (attack-review-notify-parser) ---------------
//
// Every case below reproduces a finding an attacker review demonstrated
// against the first draft of this parser, using its own input shapes. They
// exist because the parser is fed bytes an agent inside the sandbox chooses,
// on the host's single event loop, with the output relayed to external
// services -- so "it parses correctly" is not the whole bar.

test('N1: a flood of BEL-terminated sequences stays linear, not quadratic', () => {
  // The draft searched for the ST terminator across the entire remaining
  // buffer per sequence, and re-sliced the buffer per sequence. With input
  // that contains no ST at all, every one of those searches was a full miss:
  // 1MiB took 19.2 SECONDS of host CPU, enough to stall every session on the
  // server once this is wired into onData. The threshold here is deliberately
  // loose (a fixed parser does ~100ms) -- it is a shape check for O(n^2), not
  // a benchmark, so it will not flake on a slow CI box.
  const one = `${ESC}]777;notify;;x${BEL}`;
  const oneMiB = one.repeat(Math.floor((1024 * 1024) / one.length));
  let events = 0;
  const d = createNotifyDetector({ onNotification: () => { events += 1; } });
  const started = process.hrtime.bigint();
  d.feed(oneMiB);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(events > 60_000, `the sequences must still be parsed (got ${events})`);
  assert.ok(ms < 3000, `1MiB of BEL-terminated OSC took ${ms.toFixed(0)}ms (quadratic regression?)`);
});

test('N1: 64KiB chunks -- the pty-realistic worst case -- stay linear', () => {
  const one = `${ESC}]777;notify;;x${BEL}`;
  const chunk = one.repeat(Math.floor((64 * 1024) / one.length));
  const d = createNotifyDetector({ onNotification: () => {} });
  const started = process.hrtime.bigint();
  for (let i = 0; i < 16; i++) d.feed(chunk);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 3000, `~1MiB in 64KiB chunks took ${ms.toFixed(0)}ms (quadratic regression?)`);
});

test('N2: one kitty id cannot accumulate unbounded bytes', () => {
  // The draft had no byte cap at all: 31.3MiB fed in left 31.7MiB retained.
  // Each chunk here is under MAX_OSC_LEN so it exercises the per-entry cap
  // rather than the runaway-sequence path.
  const d = createNotifyDetector({ onNotification: () => {} });
  for (let i = 0; i < 2000; i++) {
    d.feed(osc(`99;i=v:d=0:p=body;${'A'.repeat(4000)}`, ST));
  }
  assert.ok(
    d.pendingKittyChars() <= KITTY_ENTRY_MAX_CHARS,
    `retained ${d.pendingKittyChars()} chars for one id (cap ${KITTY_ENTRY_MAX_CHARS})`,
  );
  assert.ok(d.stats().truncatedKitty > 0, 'the cap must be reported, not silently applied');
});

test('N2: total pending bytes are bounded across every open id', () => {
  const d = createNotifyDetector({ onNotification: () => {} });
  for (let id = 0; id < 200; id++) {
    for (let i = 0; i < 4; i++) d.feed(osc(`99;i=${id}:d=0:p=body;${'B'.repeat(4000)}`, ST));
  }
  assert.ok(d.pendingKitty() <= KITTY_PENDING_MAX + 1, `open ids: ${d.pendingKitty()}`);
  assert.ok(
    d.pendingKittyChars() <= (KITTY_PENDING_MAX + 1) * KITTY_ENTRY_MAX_CHARS,
    `total retained ${d.pendingKittyChars()} chars`,
  );
});

test('N2: the TTL measures total lifetime, so appending cannot keep an entry alive', () => {
  // The draft refreshed the deadline on every append, so an attacker who kept
  // appending was never expired -- 10 simulated hours still held the entry.
  let clock = 1_000_000;
  const d = createNotifyDetector({ onNotification: () => {}, now: () => clock });
  d.feed(osc('99;i=v:d=0:p=title;IMPORTANT', ST));
  for (let i = 0; i < 10; i++) {
    clock += KITTY_PENDING_TTL_MS - 1000; // always shorter than the TTL
    d.feed(osc('99;i=v:d=0:p=body;x', ST));
  }
  // Whatever is pending now must be young: the original entry is long gone
  // rather than kept alive by the drip of appends.
  const events = [];
  const d2 = createNotifyDetector({ onNotification: (e) => events.push(e), now: () => clock });
  d2.feed(osc('99;i=v:d=0:p=title;IMPORTANT', ST));
  clock += KITTY_PENDING_TTL_MS + 1;
  d2.feed(osc('99;i=v:p=body;later', ST));
  assert.equal(events.length, 1);
  assert.equal(events[0].title, null, 'the expired title must not resurface');
  assert.equal(events[0].body, 'later');
});

test('N5: kitty d=2 completes the set instead of pending forever', () => {
  const events = collect(osc('99;i=1:d=2:p=title;done-action', ST));
  assert.deepEqual(events, [{
    kind: 'notification', source: 'osc99', title: 'done-action', body: '',
  }]);
});

test('N5: evicting an over-capacity kitty id is counted, not silent', () => {
  const d = createNotifyDetector({ onNotification: () => {} });
  for (let i = 0; i < 40; i++) d.feed(osc(`99;i=${i}:d=0:p=title;x`, ST));
  assert.ok(d.stats().evictedKitty > 0, 'a dropped in-progress notification must be observable');
});

test('N4: invisible, bidi and line-separator characters are stripped', () => {
  // U+2028 renders as a line break in some clients, which is how a forged
  // second "_from:" footer would be made to look like a separate line; the
  // bidi overrides reorder what follows them.
  const nasty = 'A B C‮D​E⁦F﻿G­H';
  const events = collect(osc(`777;notify;T;${nasty}`));
  assert.equal(events.length, 1);
  assert.equal(events[0].body, 'ABCDEFGH');
});

test('N4: non-breaking spaces collapse, ideographic space is preserved', () => {
  const events = collect(osc('777;notify;a  b;　日本語　'));
  assert.equal(events[0].title, 'a b', 'NBSP runs collapse like ordinary spaces');
  assert.equal(events[0].body, '　日本語　'.trim(), 'U+3000 is ordinary Japanese text, not a control');
});

test('N4: truncation never splits a surrogate pair', () => {
  // '👍' is one code point but two UTF-16 units; a naive slice at TITLE_MAX
  // units lands mid-pair and emits a lone surrogate, which downstream turns
  // into a JSON error or U+FFFD.
  const events = collect(osc(`777;notify;${'👍'.repeat(TITLE_MAX)};${'👍'.repeat(BODY_MAX)}`));
  assert.equal(events.length, 1);
  for (const field of ['title', 'body']) {
    const text = events[0][field];
    assert.equal(
      JSON.parse(JSON.stringify(text)), text,
      `${field} must survive a JSON round-trip (no lone surrogate)`,
    );
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        assert.ok(next >= 0xdc00 && next <= 0xdfff, `${field}: lone high surrogate at ${i}`);
        i += 1;
      } else {
        assert.ok(!(c >= 0xdc00 && c <= 0xdfff), `${field}: lone low surrogate at ${i}`);
      }
    }
  }
});

test('N4: code-point truncation still bounds the payload', () => {
  const events = collect(osc(`777;notify;${'👍'.repeat(TITLE_MAX * 2)};x`));
  assert.ok([...events[0].title].length <= TITLE_MAX, 'title is bounded in code points');
});

test('a runaway sequence is counted and resynchronized', () => {
  const events = [];
  const d = createNotifyDetector({ onNotification: (e) => events.push(e) });
  d.feed(`${ESC}]777;notify;${'x'.repeat(MAX_OSC_LEN * 2)}`);
  d.feed(osc('777;notify;T;B'));
  assert.deepEqual(events, [{ kind: 'notification', source: 'osc777', title: 'T', body: 'B' }]);
  assert.ok(d.stats().overflowed > 0, 'the skipped window must be observable');
});

// --- code-review regressions (review-notify-bridge) --------------------------

test('F2: a CR or LF ends an unterminated OSC instead of swallowing the screen', () => {
  // No attacker needed: a CLI that crashes mid-write, or a child process
  // sharing the pty, leaves an OSC open. Before the fix the next 8KiB of
  // ordinary output became the notification body.
  const events = [];
  const d = createNotifyDetector({ onNotification: (e) => events.push(e) });
  d.feed(`${ESC}]9;start`);
  d.feed('normal output line 1\r\nline2\r\n');
  d.feed(`and a bell${BEL}`);
  assert.deepEqual(events, [], 'screen output must not be relayed as a notification');
  assert.ok(d.stats().aborted > 0, 'the abandoned sequence is counted');
});

test('F2: scanning resumes at the control byte, so later sequences still work', () => {
  const events = collect(`${ESC}]777;notify;T\nplain text${osc('777;notify;Real;Body')}`);
  assert.deepEqual(events, [{ kind: 'notification', source: 'osc777', title: 'Real', body: 'Body' }]);
});

test('F2: an ESC that does not open ST also ends the string', () => {
  const events = collect(`${ESC}]9;abc${ESC}[0m${osc('777;notify;Real;Body')}`);
  assert.deepEqual(events.map((e) => e.title), ['Real']);
});

test('F2: a legitimate notification is unaffected', () => {
  assertSplitInvariant(osc('777;notify;Claude Code;Waiting for your input'));
});

test('F2: tmux passthrough still works (its payload carries a real BEL)', () => {
  // The DCS scanner deliberately does NOT abort on C0: the wrapped sequence's
  // own terminator lives inside the payload.
  const events = collect(tmuxWrap(osc('777;notify;T;B')));
  assert.deepEqual(events, [{ kind: 'notification', source: 'osc777', title: 'T', body: 'B' }]);
});

test('F3: OSC 9 subcodes are an allow-list, so ConEmu sequences are not notifications', () => {
  assert.deepEqual(collect(osc('9;9;/home/u/proj')), [], 'ConEmu set-working-directory');
  assert.deepEqual(collect(osc('9;1;hello')), [], 'an unknown subcode must not leak into the body');
  assert.deepEqual(collect(osc('9;2;42')), [], 'badge');
  assert.deepEqual(collect(osc('9;4;1;50')), [], 'progress');
  // The two accepted forms still work.
  assert.deepEqual(collect(osc('9;plain message')).map((e) => e.body), ['plain message']);
  assert.deepEqual(collect(osc('9;0;explicit notify')).map((e) => e.body), ['explicit notify']);
});

test('F8: an empty OSC 777 fires nothing, like the other two parsers', () => {
  assert.deepEqual(collect(osc('777;notify;;')), []);
  assert.deepEqual(collect(osc('777;notify;')), []);
  assert.deepEqual(collect(osc('777;notify')), []);
  // ...and a payload with only a title still does fire.
  assert.equal(collect(osc('777;notify;T')).length, 1);
});
