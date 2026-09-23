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

test('control characters are flattened and runs of spaces collapsed', () => {
  const events = collect(osc('777;notify;a\x01b;c\x02\x02d   e'));
  assert.deepEqual(events, [{ kind: 'notification', source: 'osc777', title: 'a b', body: 'c d e' }]);
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
