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
// Everything in this file is pure with respect to the server: it accumulates
// its own carry buffer, never touches a session, and hands finished events to
// the callback the caller supplied. Wiring lives in sessionManager (Step 3);
// policy (enable/rate-limit/dedupe/level) lives in notifyBridge (Step 3).
// Deliberately NOT a stream transform: the pty bytes are broadcast to the
// browser untouched (xterm.js registers OSC handlers for 0/1/2/4/8/10/11/12/
// 104/110/111/112 only, so 9/99/777 are discarded by it anyway, and
// TerminalView never subscribes to onBell -- so passing them through costs
// nothing and keeps session.outputBuffer byte-exact for replay).

// A sequence longer than this is not a notification anyone meant to send --
// bound the carry buffer so a peer that opens an OSC and never terminates it
// cannot grow memory without limit (same posture as mcpServer.js's
// MAX_TRANSPORT_BUFFER_CHARS).
export const MAX_OSC_LEN = 8 * 1024;

// Web Push and Discord both truncate long text anyway; cutting here keeps the
// downstream payloads bounded regardless of what a CLI decides to emit.
export const TITLE_MAX = 200;
export const BODY_MAX = 2000;

// kitty's OSC 99 splits one notification across several sequences keyed by
// i=<id>. A chunk set that never completes (CLI killed mid-notification) must
// not pin memory forever.
export const KITTY_PENDING_TTL_MS = 10_000;
export const KITTY_PENDING_MAX = 16;

const ESC = '\x1b';
const BEL = '\x07';

// C0 + DEL + C1. claude already maps these to spaces before emitting, but
// nothing guarantees the other CLIs do, and these strings end up in a Discord
// payload / a Notification title.
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;

function sanitize(text) {
  return String(text).replace(CONTROL_RE, ' ').replace(/ {2,}/g, ' ').trim();
}

function clamp(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
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
  return {
    source: 'osc777',
    title: cleanTitle(parts[1] ?? ''),
    body: cleanBody(parts.slice(2).join(';')),
  };
}

// OSC 9 (iTerm2-style): `9;<text>`, but sharing its opcode with the
// ConEmu/Windows-Terminal progress extension and with a badge form. Claude's
// own enum is { NOTIFY: 0, BADGE: 2, PROGRESS: 4 }:
//   9;4;1;50  progress 50%      -> dropped (streams continuously)
//   9;2;...   badge             -> dropped
//   9;0;text  explicit NOTIFY   -> the leading "0;" is stripped
//   9;text    plain notify      -> used as-is
// A message that genuinely begins with "2;" or "4;" is indistinguishable from
// the progress form and is dropped; no real emitter does that, and the cost of
// guessing wrong the other way is a notification storm.
function parseOsc9(rest) {
  const sub = /^(\d+)(?:;|$)/.exec(rest);
  if (sub) {
    const code = Number(sub[1]);
    if (code === 2 || code === 4) return null;
    if (code === 0) rest = rest.slice(sub[0].length);
  }
  const body = cleanBody(rest);
  if (!body) return null;
  // No title is carried in this form (the iterm2 channel folds it into the
  // text as "<title>: <message>", which cannot be split back apart safely).
  // The bridge supplies a title from the session instead.
  return { source: 'osc9', title: null, body };
}

// kitty's OSC 99: `99;<key=value:...>;<payload>`, several sequences per
// notification, keyed by i=<id>. claude emits
//   99;i=<id>:d=0:p=title;<title>
//   99;i=<id>:p=body;<message>
//   99;i=<id>:d=1:a=focus;
// `d` is "done": 0 means more chunks follow, and per the kitty protocol its
// default (absent) is "done". So a chunk with d absent or d=1 completes the
// set -- which lands the emit on the body chunk above, exactly where the
// content is complete. The trailing d=1:a=focus chunk then finds the entry
// already flushed and carries no payload, so the "nothing accumulated" guard
// drops it instead of firing an empty second notification.
function parseKittyMeta(meta) {
  const out = {};
  for (const pair of meta.split(':')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

export function createNotifyDetector({ onNotification, allowBell = false, now = Date.now } = {}) {
  let buf = '';
  // id -> { title, body, at }
  const kitty = new Map();

  function emit(event) {
    try {
      onNotification?.(event);
    } catch {
      // A detector must never break the pty data path (same rule as
      // sessionManager's exit/create listeners).
    }
  }

  function expireKitty() {
    const cutoff = now() - KITTY_PENDING_TTL_MS;
    for (const [id, entry] of kitty) {
      if (entry.at < cutoff) kitty.delete(id);
    }
    // A stream that opens a new id per sequence would otherwise grow the map
    // between expiries; drop oldest-first (Map preserves insertion order).
    while (kitty.size > KITTY_PENDING_MAX) {
      kitty.delete(kitty.keys().next().value);
    }
  }

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
    const entry = kitty.get(id) ?? { title: '', body: '', at: now() };
    if (meta.p === 'body') entry.body += payload;
    else entry.title += payload; // kitty's default payload type is "title"
    entry.at = now();
    kitty.set(id, entry);

    const done = meta.d === undefined || meta.d === '1';
    if (!done) return null;
    kitty.delete(id);
    const title = cleanTitle(entry.title);
    const body = cleanBody(entry.body);
    if (!title && !body) return null; // action-only chunk (a=focus/report)
    return { source: 'osc99', title, body };
  }

  // `body` is everything between "ESC ]" and the terminator.
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

  // Plain (non-escape) bytes. The only thing of interest here is a bare BEL,
  // and only when the caller opted in: a terminal bell is emitted by shell
  // completion, by `printf '\a'`, and by claude's own iterm2_with_bell
  // channel, so on its own it is a very weak signal.
  function handleText(text) {
    if (!allowBell) return;
    for (let i = text.indexOf(BEL); i !== -1; i = text.indexOf(BEL, i + 1)) {
      emit({ kind: 'bell', source: 'bell', title: null, body: '' });
    }
  }

  // A DCS terminator search that respects tmux/screen's ESC-doubling: inside
  // the passthrough payload every ESC was written twice, so the first literal
  // "ESC \" found by a naive indexOf can be the second half of a doubled ESC
  // followed by a backslash. Walk it instead. Returns the index of the ESC
  // that opens the terminator, or -1 when the payload is still incomplete.
  function findDcsEnd(s, from) {
    let i = from;
    while (i < s.length) {
      const e = s.indexOf(ESC, i);
      if (e === -1 || e + 1 >= s.length) return -1;
      if (s[e + 1] === ESC) { i = e + 2; continue; } // doubled ESC: payload data
      if (s[e + 1] === '\\') return e;
      i = e + 1;
    }
    return -1;
  }

  function feed(chunk) {
    if (!chunk) return;
    buf += chunk;

    for (;;) {
      const esc = buf.indexOf(ESC);
      if (esc === -1) {
        handleText(buf);
        buf = '';
        return;
      }
      if (esc > 0) handleText(buf.slice(0, esc));
      const rest = buf.slice(esc);
      if (rest.length < 2) { buf = rest; return; } // need the type byte

      const type = rest[1];

      if (type === ']') {
        // OSC: terminated by BEL or ST (ESC \). 8-bit ST (0x9c) is not
        // produced by any emitter here and is not accepted, matching the
        // ANSI_RE grammar the rest of the server already uses.
        const bel = rest.indexOf(BEL, 2);
        const st = rest.indexOf(`${ESC}\\`, 2);
        let end = -1;
        let after = -1;
        if (bel !== -1 && (st === -1 || bel < st)) { end = bel; after = bel + 1; }
        else if (st !== -1) { end = st; after = st + 2; }
        if (end === -1) {
          if (rest.length > MAX_OSC_LEN) {
            // Runaway/unterminated: drop a window of it without scanning it
            // for bells (it is sequence payload, not screen text) and resync
            // on the next ESC.
            buf = rest.slice(MAX_OSC_LEN);
            continue;
          }
          buf = rest;
          return;
        }
        handleOsc(rest.slice(2, end));
        buf = rest.slice(after);
        continue;
      }

      if (type === 'P') {
        // DCS. Only tmux/screen passthrough is unwrapped -- other DCS payloads
        // (sixel, DECRQSS replies) are consumed opaquely. A passthrough
        // payload is either "tmux;<doubled>" or, for screen, starts with the
        // doubled ESC of the wrapped sequence itself.
        const end = findDcsEnd(rest, 2);
        if (end === -1) {
          if (rest.length > MAX_OSC_LEN) { buf = rest.slice(MAX_OSC_LEN); continue; }
          buf = rest;
          return;
        }
        let payload = rest.slice(2, end);
        const tail = rest.slice(end + 2);
        if (payload.startsWith('tmux;')) payload = payload.slice(5);
        else if (payload[0] !== ESC) payload = ''; // not a passthrough wrapper
        // Un-double and re-scan: the unwrapped text is strictly shorter than
        // what it replaced, so this cannot loop forever on nested wrappers.
        buf = payload.replaceAll(`${ESC}${ESC}`, ESC) + tail;
        continue;
      }

      // Any other escape (CSI, charset selection, ...). Skipping just the ESC
      // byte is enough: the remainder is scanned as text, and no CSI/charset
      // sequence can contain a BEL or an "ESC ]".
      buf = rest.slice(1);
    }
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
  };
}
