// Agent desktop-notification detector (plan: plan-notify-bridge, Step 1).
//
// The agent CLIs cannot reach a desktop notification daemon from inside the
// sandbox: bwrap never binds the host's D-Bus session socket (so notify-send
// is structurally dead), and the macOS seatbelt profile grants no Apple
// Events (so osascript/terminal-notifier are dead too). What every one of
// them CAN do is write an escape sequence to its own stdout -- which is the
// session pty, i.e. bytes ccserver already reads in sessionManager's
// onData. That is the capture point this module parses.
//
// Verified emitters (read out of the shipped binaries, not from docs):
//   claude 2.1.278  preferredNotifChannel picks the form:
//                     ghostty       -> ESC ] 777 ; notify ; <title> ; <msg> BEL
//                     iterm2        -> ESC ] 9 ; <title>: <msg> BEL
//                     kitty         -> three ESC ] 99 ; ... ST chunks
//                     terminal_bell -> a bare BEL
//                   `auto` resolves off TERM_PROGRAM and yields
//                   "no_method_available" under ccserver's plain
//                   TERM=xterm-256color, so a channel has to be injected
//                   explicitly (see agentNotifyConfig.js).
//   opencode        ships the literals ESC ] 777 ; notify ; and ESC ] 9 ; 4 ; 0.
//
// THE trap this module exists to get right: OSC 9 is not only a notification
// opcode. claude's own table is { NOTIFY: 0, BADGE: 2, PROGRESS: 4 }, and the
// progress form (ESC ] 9 ; 4 ; <state> ; <pct>) streams continuously while a
// turn runs. Treating those as notifications would fire a push per animation
// frame, so 9;2 and 9;4 are dropped here (see parseOsc9).
//
// THREAT MODEL -- read before changing the scanner. Everything fed to feed()
// is chosen by an agent inside the sandbox: it controls the bytes, where they
// split, and how many arrive. This parser runs on the host, in ccserver's
// single-threaded event loop, and its output is relayed to external services.
// So the scanner is written against three attacks, all of which an attacker
// review (attack-review-notify-parser) demonstrated against the first draft:
//   N1 CPU: the draft re-scanned the whole remaining buffer for a terminator
//      per sequence and re-sliced the buffer per sequence, which is O(n^2) --
//      1MiB of `ESC]777;notify;;x BEL` took 19.2s of host CPU and would have
//      stalled every session on the server. Fixed by scanning with a cursor
//      (no per-sequence slicing) and bounding every terminator search to
//      MAX_OSC_LEN (see findOscEnd/findDcsEnd).
//   N2 memory: the draft accumulated kitty OSC 99 chunks per id with no byte
//      cap, and refreshed the idle timer on every append so the TTL never
//      fired -- 31.7MiB retained from 31.3MiB fed, at 167MiB/s. Fixed with a
//      per-entry byte cap and a total-lifetime deadline (see handleOsc99).
//   N4 content: the text ends up in a Discord payload / a Notification body,
//      so sanitize() also strips invisible and bidi-control characters, and
//      clamp() truncates by code point so a split surrogate pair can never
//      reach a JSON encoder.
// Rate limiting and attribution are deliberately NOT here -- they are the
// bridge's job (Step 3), because they need session identity.
//
// Everything in this file is pure with respect to the server: it accumulates
// its own carry buffer, never touches a session, and hands finished events to
// the callback the caller supplied. Wiring lives in sessionManager (Step 3);
// policy (enable/rate-limit/dedupe/level) lives in notifyBridge (Step 3).
// Deliberately NOT a stream transform: the pty bytes are broadcast to the
// browser untouched (xterm.js registers OSC handlers for 0/1/2/4/8/10/11/12/
// 104/110/111/112 only, so 9/99/777 are discarded by it anyway, and
// TerminalView never subscribes to onBell -- so passing them through costs
// nothing and keeps session.outputBuffer byte-exact for replay).

// A sequence longer than this is not a notification anyone meant to send. It
// bounds two different things at once: the carry buffer (a peer that opens a
// sequence and never terminates it) and the per-sequence terminator search
// (so a stream of short sequences stays linear rather than quadratic).
export const MAX_OSC_LEN = 8 * 1024;

// Web Push and Discord both truncate long text anyway; cutting here keeps the
// downstream payloads bounded regardless of what a CLI decides to emit.
// Counted in code points, not UTF-16 units (see clamp).
export const TITLE_MAX = 200;
export const BODY_MAX = 2000;

// kitty's OSC 99 splits one notification across several sequences keyed by
// i=<id>. Three separate bounds, because an attacker can grow any one of them:
// how many ids are open, how many bytes one id may accumulate, and how long an
// unfinished id may stay open at all.
export const KITTY_PENDING_TTL_MS = 10_000;
export const KITTY_PENDING_MAX = 16;
export const KITTY_ENTRY_MAX_CHARS = TITLE_MAX + BODY_MAX;

// A tmux/screen passthrough wrapper can nest. Each level is unwrapped by a
// recursive scan of a payload that is already bounded by MAX_OSC_LEN, so this
// only exists to bound stack depth.
const MAX_DCS_DEPTH = 8;

const ESC = '\x1b';
const BEL = '\x07';
const CC_BEL = 0x07;
const CC_ESC = 0x1b;
const CC_BACKSLASH = 0x5c;

// Returned by the terminator scanners when a sequence ran past MAX_OSC_LEN
// without terminating: distinct from "need more bytes" (null), because the
// caller resynchronizes instead of carrying.
const OVERFLOW = Symbol('overflow');

// Returned when a string was ABANDONED mid-sequence: a real terminal ends an
// OSC string at any C0 control, not just at its terminator, and so must this
// (review finding F2). Without it an unterminated OSC swallows up to
// MAX_OSC_LEN of ordinary screen output into the notification body -- and that
// needs no attacker at all: a CLI crashing mid-write, or a child process
// sharing the pty interleaving its own output, is enough. Observed before the
// fix: feeding "ESC]9;start", then "normal output line 1\r\nline2\r\n", then
// "and a bell BEL" produced ONE notification whose body was the whole screen
// fragment. The abort index is where scanning resumes, so those bytes go back
// to being ordinary text.
const ABORTED = Symbol('aborted');

// C0 + DEL + C1. claude already maps these to spaces before emitting, but
// nothing guarantees the other CLIs do.
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g');
// Characters that render as nothing or reorder what follows them: soft hyphen,
// Arabic letter mark, Mongolian vowel separator, zero-width space/joiners,
// the LTR/RTL marks and embedding/override/isolate controls, the line and
// paragraph separators (which some clients render as a line break -- handy for
// forging a second "_from:" footer), word joiner / invisible operators, and
// the BOM. Removed outright rather than spaced, since they carry no meaning
// in a notification title.
const INVISIBLE_RE = new RegExp('[\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff]', 'g');
// Non-breaking / exotic spaces normalized to an ordinary space so the
// run-collapsing below actually collapses them. U+3000 (ideographic space) is
// deliberately NOT in here: it is ordinary text in Japanese.
const ODD_SPACE_RE = new RegExp('[\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f]', 'g');

function sanitize(text) {
  return String(text)
    .replace(CONTROL_RE, ' ')
    .replace(INVISIBLE_RE, '')
    .replace(ODD_SPACE_RE, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// Truncate by code point, never by UTF-16 unit: slicing mid-pair would emit a
// lone surrogate, which downstream turns into a JSON encoding error or U+FFFD.
function clamp(text, max) {
  if (text.length <= max) return text; // fast path: UTF-16 length bounds code points
  const cps = Array.from(text);
  if (cps.length <= max) return text;
  return `${cps.slice(0, max - 1).join('')}…`;
}

function cleanTitle(text) {
  const t = clamp(sanitize(text), TITLE_MAX);
  return t.length > 0 ? t : null;
}

function cleanBody(text) {
  return clamp(sanitize(text), BODY_MAX);
}

// OSC 777 (ghostty / opencode): `777;notify;<title>;<message...>`. The message
// may itself contain ';' (nothing escapes it), so everything past the title is
// rejoined. Any other 777 subcommand (777;precmd etc.) is not a notification.
function parseOsc777(rest) {
  const parts = rest.split(';');
  if (parts[0] !== 'notify') return null;
  const title = cleanTitle(parts[1] ?? '');
  const body = cleanBody(parts.slice(2).join(';'));
  // Review finding F8: this was the one parser of the three that fired on an
  // entirely empty payload. It was harmless (the bridge dropped it as
  // 'empty'), but only after paying for the whole policy path -- and an
  // inconsistency between three parsers of the same thing is a bug waiting
  // for someone to rely on it.
  if (!title && !body) return null;
  return { source: 'osc777', title, body };
}

// OSC 9 (iTerm2-style): `9;<text>`, but sharing its opcode with a whole
// sub-namespace. claude's own enum is { NOTIFY: 0, BADGE: 2, PROGRESS: 4 },
// and ConEmu/Windows Terminal add more (9;9;<cwd> sets the working directory,
// 9;1;... and others exist).
//
// This is an ALLOW-list, not a deny-list (review finding F3): only a payload
// with no numeric subcode, or with the explicit NOTIFY subcode 0, is treated
// as a notification. The first cut dropped just 2 and 4, so ConEmu's
// `9;9;/home/u/proj` arrived as a notification reading "9;/home/u/proj".
//   9;text      plain notify (what iTerm2 emits)  -> used as-is
//   9;0;text    explicit NOTIFY                   -> the "0;" is stripped
//   9;<n>;...   anything else                     -> dropped
// The cost is that a message literally beginning with "<digits>;" is dropped.
// That is the same asymmetry the deny-list version reasoned about, applied
// consistently: a missed notification is a nuisance, a per-animation-frame
// notification storm is an outage.
function parseOsc9(rest) {
  const sub = /^(\d+)(?:;|$)/.exec(rest);
  let text = rest;
  if (sub) {
    if (Number(sub[1]) !== 0) return null;
    text = rest.slice(sub[0].length);
  }
  const body = cleanBody(text);
  if (!body) return null;
  // No title is carried in this form (the iterm2 channel folds it into the
  // text as "<title>: <message>", which cannot be split back apart safely).
  // The bridge supplies a title from the session instead.
  return { source: 'osc9', title: null, body };
}

function parseKittyMeta(meta) {
  const out = {};
  for (const pair of meta.split(':')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

// Bounded forward scan for an OSC terminator (BEL, or ST = ESC \) starting at
// `from`. Returns { end, after }, null when more bytes are needed, or OVERFLOW
// when MAX_OSC_LEN was scanned without finding one. Never looks past
// MAX_OSC_LEN, which is what keeps a stream of short sequences linear.
function findOscEnd(s, from) {
  const hard = from + MAX_OSC_LEN;
  const limit = Math.min(s.length, hard);
  for (let i = from; i < limit; i++) {
    const c = s.charCodeAt(i);
    if (c === CC_BEL) return { end: i, after: i + 1 };
    if (c === CC_ESC) {
      if (i + 1 >= s.length) return null; // the next byte decides; wait for it
      if (s.charCodeAt(i + 1) === CC_BACKSLASH) return { end: i, after: i + 2 };
      // An ESC that does not open ST starts something else entirely; the
      // string is over (xterm treats it the same way).
      return { aborted: ABORTED, at: i };
    }
    // Any other C0 control -- CR and LF above all, but also CAN/SUB, which
    // exist precisely to cancel a sequence. None of them can appear in a
    // notification payload: claude and opencode both sanitize before emitting,
    // and this parser would strip them anyway.
    if (c < 0x20) return { aborted: ABORTED, at: i };
  }
  return limit < hard ? null : OVERFLOW;
}

// Same, for DCS, respecting tmux/screen's ESC-doubling: inside a passthrough
// payload every ESC was written twice, so the first literal "ESC \" can be the
// second half of a doubled ESC followed by a backslash.
function findDcsEnd(s, from) {
  const hard = from + MAX_OSC_LEN;
  const limit = Math.min(s.length, hard);
  let i = from;
  while (i < limit) {
    // NOTE: deliberately no C0-abort here, unlike findOscEnd. A tmux/screen
    // passthrough payload carries the WRAPPED sequence verbatim, terminator
    // included -- so a BEL inside it is data, not the end of the DCS. Only ST
    // (or MAX_OSC_LEN) ends a DCS.
    if (s.charCodeAt(i) !== CC_ESC) { i++; continue; }
    if (i + 1 >= s.length) return null;
    const next = s.charCodeAt(i + 1);
    if (next === CC_ESC) { i += 2; continue; } // doubled ESC: payload data
    if (next === CC_BACKSLASH) return { end: i, after: i + 2 };
    i++;
  }
  return limit < hard ? null : OVERFLOW;
}

export function createNotifyDetector({ onNotification, allowBell = false, now = Date.now } = {}) {
  let buf = '';
  // id -> { title, body, chars, startedAt }
  const kitty = new Map();
  let evictedKitty = 0;
  let truncatedKitty = 0;
  let overflowed = 0;
  let aborted = 0;

  function emit(event) {
    try {
      onNotification?.(event);
    } catch {
      // A detector must never break the pty data path (same rule as
      // sessionManager's exit/create listeners).
    }
  }

  // Bells are counted in place, without slicing the buffer -- slicing per
  // sequence is exactly what made the first draft quadratic.
  function handleTextRange(s, start, end) {
    if (!allowBell) return;
    for (let i = start; i < end; i++) {
      if (s.charCodeAt(i) === CC_BEL) emit({ kind: 'bell', source: 'bell', title: null, body: '' });
    }
  }

  // Total-lifetime expiry, NOT idle expiry: the draft refreshed the deadline
  // on every append, so an attacker who kept appending was never expired at
  // all (attack review N2). `startedAt` is set once, when the id is opened.
  function expireKitty() {
    const cutoff = now() - KITTY_PENDING_TTL_MS;
    for (const [id, entry] of kitty) {
      if (entry.startedAt < cutoff) kitty.delete(id);
    }
    // A stream that opens a new id per sequence would otherwise grow the map
    // between expiries; drop oldest-first (Map preserves insertion order).
    while (kitty.size > KITTY_PENDING_MAX) {
      kitty.delete(kitty.keys().next().value);
      evictedKitty += 1;
    }
  }

  // kitty's OSC 99: `99;<key=value:...>;<payload>`, several sequences per
  // notification, keyed by i=<id>. claude emits
  //   99;i=<id>:d=0:p=title;<title>
  //   99;i=<id>:p=body;<message>
  //   99;i=<id>:d=1:a=focus;
  // `d` is "done"; only d=0 means "more chunks follow" (its default, when
  // absent, is done). So anything that is not an explicit d=0 completes the
  // set -- which lands the emit on the body chunk above, exactly where the
  // content is complete, and also treats kitty's d=2 as terminal instead of
  // leaving it pending forever (attack review N5). The trailing d=1:a=focus
  // chunk then finds the entry already flushed and carries no payload, so the
  // "nothing accumulated" guard drops it instead of firing a second, empty
  // notification.
  function handleOsc99(rest) {
    const semi = rest.indexOf(';');
    const meta = parseKittyMeta(semi === -1 ? rest : rest.slice(0, semi));
    let payload = semi === -1 ? '' : rest.slice(semi + 1);
    if (meta.e === '1') {
      try {
        payload = Buffer.from(payload, 'base64').toString('utf-8');
      } catch {
        payload = '';
      }
    }
    const id = meta.i ?? '';
    expireKitty();
    const entry = kitty.get(id) ?? { title: '', body: '', chars: 0, startedAt: now() };

    // Per-entry byte cap (attack review N2): everything past the point where
    // the final title+body could still matter is dropped on arrival rather
    // than accumulated and then thrown away at flush time.
    const room = KITTY_ENTRY_MAX_CHARS - entry.chars;
    if (payload.length > room) {
      payload = payload.slice(0, Math.max(0, room));
      truncatedKitty += 1;
    }
    entry.chars += payload.length;
    if (meta.p === 'body') entry.body += payload;
    else entry.title += payload; // kitty's default payload type is "title"
    kitty.set(id, entry);

    if (meta.d === '0') return null;
    kitty.delete(id);
    const title = cleanTitle(entry.title);
    const body = cleanBody(entry.body);
    if (!title && !body) return null; // action-only chunk (a=focus/report)
    return { source: 'osc99', title, body };
  }

  // `oscBody` is everything between "ESC ]" and the terminator.
  function handleOsc(oscBody) {
    const semi = oscBody.indexOf(';');
    const code = semi === -1 ? oscBody : oscBody.slice(0, semi);
    const rest = semi === -1 ? '' : oscBody.slice(semi + 1);
    let event = null;
    if (code === '777') event = parseOsc777(rest);
    else if (code === '9') event = parseOsc9(rest);
    else if (code === '99') event = handleOsc99(rest);
    // Everything else is someone else's opcode: 0/1/2 window title, 8
    // hyperlink, 52 clipboard (handled client-side, see client/src/osc52.js),
    // 133 semantic prompt, 1337 iTerm2 proprietary, ...
    if (event) emit({ kind: 'notification', ...event });
  }

  // The single scanner, used for both the streaming buffer and (recursively)
  // for an already-complete DCS passthrough payload. Walks with a cursor and
  // never slices per sequence -- only the one sequence body actually being
  // parsed is materialized.
  //
  // Returns the index up to which `s` has been consumed. In streaming mode an
  // incomplete trailing sequence stops the walk and its start index is
  // returned, so the caller can carry exactly that tail; in non-streaming mode
  // (a complete payload) an incomplete tail is simply discarded.
  function scan(s, streaming, depth) {
    let cursor = 0;
    let i = 0;
    for (;;) {
      const esc = s.indexOf(ESC, i);
      if (esc === -1) {
        handleTextRange(s, cursor, s.length);
        return s.length;
      }
      handleTextRange(s, cursor, esc);
      if (esc + 2 > s.length) return streaming ? esc : s.length; // need the type byte

      const type = s[esc + 1];

      if (type === ']') {
        const res = findOscEnd(s, esc + 2);
        if (res === null) return streaming ? esc : s.length;
        if (res?.aborted === ABORTED) {
          aborted += 1;
          i = res.at;      // resume AT the control byte: it is ordinary output
          cursor = res.at;
          continue;
        }
        if (res === OVERFLOW) {
          // Runaway sequence: skip the window we scanned without treating it
          // as screen text (it is sequence payload, not output), and
          // resynchronize on the next ESC after it.
          overflowed += 1;
          i = esc + 2 + MAX_OSC_LEN;
          cursor = i;
          continue;
        }
        handleOsc(s.slice(esc + 2, res.end));
        i = res.after;
        cursor = i;
        continue;
      }

      if (type === 'P') {
        // DCS. Only tmux/screen passthrough is unwrapped -- other DCS payloads
        // (sixel, DECRQSS replies) are consumed opaquely. A passthrough
        // payload is either "tmux;<doubled>" or, for screen, starts with the
        // doubled ESC of the wrapped sequence itself. The unwrapped payload is
        // re-scanned in place rather than spliced back into the carry buffer:
        // splicing would copy the whole remaining buffer per wrapper.
        const res = findDcsEnd(s, esc + 2);
        if (res === null) return streaming ? esc : s.length;
        if (res?.aborted === ABORTED) {
          aborted += 1;
          i = res.at;
          cursor = res.at;
          continue;
        }
        if (res === OVERFLOW) {
          overflowed += 1;
          i = esc + 2 + MAX_OSC_LEN;
          cursor = i;
          continue;
        }
        let payload = s.slice(esc + 2, res.end);
        if (payload.startsWith('tmux;')) payload = payload.slice(5);
        else if (payload.charCodeAt(0) !== CC_ESC) payload = ''; // not a passthrough wrapper
        if (payload && depth < MAX_DCS_DEPTH) {
          scan(payload.replaceAll(`${ESC}${ESC}`, ESC), false, depth + 1);
        }
        i = res.after;
        cursor = i;
        continue;
      }

      // Any other escape (CSI, charset selection, ...). Skipping just the ESC
      // byte is enough: the remainder is scanned as text, and no CSI/charset
      // sequence can contain a BEL or an "ESC ]".
      i = esc + 1;
      cursor = i;
    }
  }

  function feed(chunk) {
    if (!chunk) return;
    buf += chunk;
    const consumed = scan(buf, true, 0);
    buf = consumed >= buf.length ? '' : buf.slice(consumed);
    // A carried tail can only ever be an unterminated sequence, which is
    // bounded by MAX_OSC_LEN the next time it is scanned. Trim here too so a
    // single huge chunk cannot leave more than that pinned between feeds.
    if (buf.length > MAX_OSC_LEN) buf = '';
  }

  function reset() {
    buf = '';
    kitty.clear();
  }

  return {
    feed,
    reset,
    // Test/introspection seams only.
    pendingBytes: () => buf.length,
    pendingKitty: () => kitty.size,
    pendingKittyChars: () => {
      let total = 0;
      for (const e of kitty.values()) total += e.chars;
      return total;
    },
    stats: () => ({ evictedKitty, truncatedKitty, overflowed, aborted }),
  };
}
