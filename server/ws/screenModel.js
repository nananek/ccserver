// Lightweight virtual screen model for read_output (see mcpTools.js). The
// server previously only buffered raw pty bytes, which cannot show what a
// member's screen currently looks like: TUI spinners redraw in place via
// cursor moves, line erases and alternate-screen diffs, so the byte stream
// is "frame 1, frame 2, ..." with no way to tell which frame is on screen.
// This module interprets a practical subset of the xterm stream per session
// and exposes the current visible screen, a change counter, and a tally of
// how many distinct rows changed since it was last read (takeDirtyRowCount,
// the busy/quiet signal activity.js grades each session's tab colour from).
//
// Pure module (no app imports, Node builtins only), unit-testable directly
// with node --test. Bounded memory: at most `rows` (default 200) visible
// rows of `cols` (default 80) chars each -- roughly 16KB, the same order as
// the output buffer cap.
//
// Supported control subset (unhandled sequences are dropped harmlessly):
//   - printable text with wrapping, CR/LF/BS/TAB
//   - CSI: CUP/H, CUU/A, CUD/B, CUF/C, CUB/D, CHA/G, EL/K (0/1/2),
//     ED/J (0/2/3), SGR (attributes ignored), ?25 l/h (cursor hidden)
//   - alternate screen: CSI ?1049 h/l, ?47 h/l (content kept, flag exposed)
//   - OSC and other ESC sequences: discarded
//
// UTF-8: feed() accepts a string (the pty layer already delivers cleanly
// decoded text) or bytes, which are decoded through a per-model TextDecoder
// in stream mode so a multi-byte character split across chunks never
// mojibakes.

export const SCREEN_COLS = 80;
export const SCREEN_ROWS = 200;

// Bounds on the ESCAPE-SEQUENCE paths. The stream this parses comes from a
// pty that an agent (or anything running in its shell) can write to at will,
// and feed() runs synchronously inside sessionManager's onData for EVERY
// session -- so work that takes seconds here stops the whole server, not one
// tab. What these bounds remove is the case where a SHORT input costs
// unbounded time:
//   - a CSI parameter is clamped, and its digit run is cut off, so
//     `ESC[999999999999999999999B` can neither spin nor be rescanned forever
//     (a parameter that long is malformed by any real terminal's reckoning).
//     The cut-off sequence is then discarded up to its final byte rather
//     than abandoned mid-way, so its leftover parameters never land on the
//     screen as text;
//   - an unterminated escape keeps at most MAX_PENDING characters waiting for
//     the rest, instead of accumulating every byte that follows it.
//
// What they do NOT remove: the per-character cost of ordinary text. Plain
// output still blocks the event loop in proportion to its size -- measured
// at 3.3s for 12.5MiB, and 24-56s for the same volume broken into lines --
// so `cat`-ing a large file in a shell session stalls the server just as
// effectively as any of the sequences above. That is issue #210, and it is a
// denial-of-service of the same class, not merely a throughput concern. Do
// not read these bounds as "a pty writer can no longer stall the server";
// they only close the escape-sequence shortcuts to it.
const MAX_CSI_PARAM = 100_000;
// Comfortably past anything real: a truecolor SGR run is ~36 characters and
// a long chained one still under 64. Over-cap sequences are dropped whole
// (see csiSkip), so the cost of a false positive is a discarded escape --
// cheap for SGR, which this model ignores anyway -- but headroom is free.
const MAX_CSI_PARAM_CHARS = 128;
const MAX_PENDING = 256;

export function createScreenModel({ cols = SCREEN_COLS, rows = SCREEN_ROWS } = {}) {
  const capCols = Math.max(cols, 1);
  const capRows = Math.max(rows, 1);
  const decoder = new TextDecoder('utf-8', { fatal: false });

  const lines = []; // visible rows, oldest first, each at most capCols chars
  let cursorRow = 0;
  let cursorCol = 0;
  let alt = false;
  let version = 0;
  let pending = ''; // partial escape sequence awaiting the next chunk
  // An OSC (ESC ]) whose terminator has not arrived. Its body is discarded
  // anyway, so it is dropped as it streams rather than accumulated in
  // `pending`: an OSC body has no length limit, and re-scanning a growing
  // buffer once per chunk is quadratic (12.5MiB measured at ~8s of blocked
  // event loop before this). oscEsc remembers a trailing ESC that may turn
  // out to be the first half of an ST.
  let oscSkip = false;
  let oscEsc = false;
  // A CSI whose parameter run ran past MAX_CSI_PARAM_CHARS, waiting for the
  // final byte that ends it. Same reason as oscSkip: the rest is dropped as
  // it streams instead of being buffered or -- worse -- falling through to
  // the screen as printable text.
  let csiSkip = false;
  // Row indices touched since the last takeDirtyRowCount(). `version` counts
  // written CELLS, which scales with the terminal width and cannot tell a
  // one-line spinner redrawing 60 columns from real output; the number of
  // DISTINCT rows touched in a time slice can (see activity.js). Deduping in
  // a Set is what makes a spinner cheap: it rewrites the same row every
  // frame, so a whole slice of spinner frames counts as one row.
  // Approximation: a row index is a screen position, not an identity, so a
  // slice that also scrolls (ensureRow shifting the oldest row off) attributes
  // the touches to whichever rows sat at those positions. Scrolling is itself
  // heavy redraw activity, so this never makes a busy screen look quiet.
  let dirtyRows = new Set();

  // --- internal mutations ---------------------------------------------------

  // `row` is the screen row the mutation touched; omit it only for changes
  // that are not about one row (bumpAll covers the whole-screen ones).
  const bump = (row) => {
    version++;
    if (typeof row === 'number') dirtyRows.add(row);
  };

  // A whole-screen change (clear, alternate-screen switch): every row that
  // exists right now is dirty. Call it BEFORE the mutation drops the rows,
  // otherwise a clear would look like a one-row change.
  const bumpAll = () => {
    for (let r = 0; r < lines.length; r++) dirtyRows.add(r);
    version++;
  };

  // Grow rows until the cursor row exists, scrolling the oldest off the top
  // when the cap is reached (the cursor then stays at the same screen line).
  //
  // A cursor more than capRows below the bottom would scroll every existing
  // row away, and landing capRows+1 or a billion rows down gives the same
  // screen -- so that case is collapsed instead of stepped through one push/
  // shift at a time. Without this, `ESC[999999999B` walks a billion
  // iterations, and a parameter long enough to reach Infinity never
  // terminates at all (cursorRow-- does not move Infinity), hanging the
  // server's event loop for good.
  const ensureRow = () => {
    if (cursorRow - lines.length >= capRows) {
      lines.length = 0;
      for (let r = 0; r < capRows; r++) lines.push('');
      cursorRow = capRows - 1;
      return;
    }
    while (cursorRow >= lines.length) {
      lines.push('');
      if (lines.length > capRows) {
        lines.shift();
        cursorRow--;
      }
    }
  };

  const setChar = (ch) => {
    if (cursorCol >= capCols) {
      cursorRow++;
      cursorCol = 0;
    }
    ensureRow();
    let line = lines[cursorRow];
    if (line.length < cursorCol) line = line.padEnd(cursorCol, ' ');
    lines[cursorRow] = (line.slice(0, cursorCol) + ch + line.slice(cursorCol + 1)).replace(/\s+$/, '');
    cursorCol++;
    bump(cursorRow);
  };

  // --- control sequences ----------------------------------------------------

  // Clamped: a parameter is only ever used as a row/column distance, and the
  // screen is capRows x capCols, so anything past MAX_CSI_PARAM is the same
  // instruction as MAX_CSI_PARAM. Non-finite values (a digit run long enough
  // that Number() overflows to Infinity) clamp too rather than propagating.
  const csiParam = (p) => {
    if (p === '') return 0;
    const n = Number(p);
    if (!Number.isFinite(n)) return MAX_CSI_PARAM;
    return n > MAX_CSI_PARAM ? MAX_CSI_PARAM : n;
  };
  const csiParams = (body) => body.split(';').map(csiParam);

  const eraseLine = (mode) => {
    ensureRow();
    const line = lines[cursorRow];
    if (mode === 0) {
      lines[cursorRow] = line.slice(0, cursorCol).replace(/\s+$/, '');
    } else if (mode === 1) {
      lines[cursorRow] = (' '.repeat(Math.min(cursorCol, line.length)) + line.slice(cursorCol)).replace(/\s+$/, '');
    } else {
      lines[cursorRow] = '';
    }
    bump(cursorRow);
  };

  const eraseDisplay = (mode) => {
    if (mode === 2 || mode === 3) {
      bumpAll(); // every row currently on screen is about to be dropped
      lines.length = 0;
      cursorRow = 0;
      cursorCol = 0;
      lines.push('');
      return;
    }
    if (mode === 1) {
      // BOL of screen through the cursor -- rare; clear the rows above and
      // the current row's head.
      for (let r = 0; r < cursorRow; r++) {
        lines[r] = '';
        bump(r);
      }
      eraseLine(1);
      return;
    }
    // mode 0: cursor through the end of the screen.
    eraseLine(0);
    for (let r = cursorRow + 1; r < lines.length; r++) bump(r);
    lines.length = cursorRow + 1;
  };

  const cursorPos = (r, c) => {
    const before = lines.length;
    cursorRow = Math.max(0, (Number.isFinite(r) && r >= 1 ? r : 1) - 1);
    ensureRow(); // positions below the current bottom scroll down like xterm
    if (lines.length !== before) bump(cursorRow); // a new row appeared on screen
    cursorCol = Math.max(0, Math.min(Number.isFinite(c) && c >= 1 ? c - 1 : 0, capCols - 1));
  };

  const csi = (paramsStr, final) => {
    const priv = paramsStr.startsWith('?');
    const parts = csiParams(priv ? paramsStr.slice(1) : paramsStr);
    const p0 = parts[0] || 0;
    switch (final) {
      case 'H':
      case 'f':
        cursorPos(parts[0] || 1, parts[1] || 1);
        return;
      case 'A': cursorRow = Math.max(0, cursorRow - (p0 || 1)); return;
      case 'B': {
        const before = lines.length;
        cursorRow += (p0 || 1);
        ensureRow();
        if (lines.length !== before) bump(cursorRow);
        return;
      }
      case 'C': cursorCol = Math.min(capCols - 1, cursorCol + (p0 || 1)); return;
      case 'D': cursorCol = Math.max(0, cursorCol - (p0 || 1)); return;
      case 'G': cursorCol = Math.max(0, Math.min((p0 || 1) - 1, capCols - 1)); return;
      case 'K': eraseLine(p0); return;
      case 'J': eraseDisplay(p0); return;
      case 'h':
      case 'l':
        // Alternate screen only; cursor visibility (25) and other modes are
        // ignored (they do not change visible content).
        if (priv && (parts[0] === 1049 || parts[0] === 47)) {
          alt = final === 'h';
          bumpAll(); // switching buffers replaces everything that was visible
        }
        return;
      default:
        return; // SGR (m) and the rest: attributes are discarded
    }
  };

  // --- character / sequence dispatch ----------------------------------------

  const text = (ch) => {
    const code = ch.charCodeAt(0);
    if (code === 0x0d) { cursorCol = 0; return; } // CR
    if (code === 0x0a || code === 0x0c || code === 0x0b) {
      const before = lines.length;
      cursorRow++;
      ensureRow();
      if (lines.length !== before) bump(cursorRow); // a new row appeared on screen
      return;
    } // LF/FF/VT
    if (code === 0x08) { cursorCol = Math.max(0, cursorCol - 1); return; } // BS
    if (code === 0x09) { cursorCol = Math.min(capCols - 1, ((cursorCol >> 3) + 1) << 3); return; } // TAB
    if (code < 0x20 || code === 0x7f) return; // other C0 controls / DEL
    setChar(ch);
  };

  // Scan for an OSC terminator (BEL, or ESC \\) from `from`. Returns the index
  // just past it, OSC_NOT_FOUND when the chunk ends first, or OSC_ESC_TAIL
  // when it ends on an ESC that the next chunk may complete into an ST.
  const OSC_NOT_FOUND = -1;
  const OSC_ESC_TAIL = -2;
  const oscEnd = (s, from) => {
    for (let j = from; j < s.length; j++) {
      if (s[j] === '\x07') return j + 1;
      if (s[j] === '\x1b') {
        if (j + 1 >= s.length) return OSC_ESC_TAIL;
        if (s[j + 1] === '\\') return j + 2;
        // ESC followed by anything else is not a terminator here (same rule
        // the original scan used) -- keep looking.
      }
    }
    return OSC_NOT_FOUND;
  };

  // Index just past the first CSI final byte (0x40-0x7E) at or after `from`,
  // or -1 when this chunk does not contain one. Parameter and intermediate
  // bytes are all below 0x40, so the first byte in that range ends the
  // sequence.
  const csiEnd = (s, from) => {
    for (let j = from; j < s.length; j++) {
      const c = s[j];
      if (c >= '@' && c <= '~') return j + 1;
    }
    return -1;
  };

  // Parse the escape sequence starting at input[start] (an ESC byte).
  // Returns { end } (exclusive) when complete, { needsMore: true } when it
  // runs off the end of the input (the caller keeps the tail pending).
  const escapeSequence = (input, start) => {
    const next = input[start + 1];
    if (next === '[') {
      let j = start + 2;
      const paramLimit = j + MAX_CSI_PARAM_CHARS;
      while (j < input.length && j < paramLimit && '0123456789;?'.includes(input[j])) j++;
      if (j === paramLimit) {
        // No real terminal emits this many characters of parameters. Treat
        // the sequence as malformed and swallow it up to its final byte --
        // stopping at the cap instead would print the leftover parameters
        // (`1;1;1;...m`) on screen as text. Holding it as a possible prefix
        // is not an option either: that re-scans a growing buffer on every
        // chunk.
        const skipTo = csiEnd(input, j);
        if (skipTo >= 0) return { end: skipTo };
        csiSkip = true;
        return { end: input.length };
      }
      if (j >= input.length) return { needsMore: true };
      const final = input[j];
      if (final >= '@' && final <= '~') {
        csi(input.slice(start + 2, j), final);
        return { end: j + 1 };
      }
      return { end: j + 1 }; // malformed CSI -- skip the final byte
    }
    if (next === ']') {
      const end = oscEnd(input, start + 2);
      if (end >= 0) return { end };
      // Terminator not in this chunk: switch to discard mode (see oscSkip)
      // and swallow the rest rather than buffering it.
      oscSkip = true;
      oscEsc = end === OSC_ESC_TAIL;
      return { end: input.length };
    }
    // DECKPAM / DECKPNM take no argument: two bytes, not three like the
    // charset designators and DEC line attributes below. Consuming a third
    // byte eats whatever follows -- usually the ESC opening the next
    // sequence, whose remainder then lands on screen as text (#213).
    if (next === '=' || next === '>') return { end: start + 2 };
    if (next === '(' || next === ')' || next === '#') {
      if (input.length < start + 3) return { needsMore: true };
      return { end: start + 3 };
    }
    if (next === undefined) return { needsMore: true };
    return { end: start + 2 };
  };

  return {
    feed(data) {
      const input = pending + (typeof data === 'string' ? data : decoder.decode(data, { stream: true }));
      pending = '';
      let i = 0;
      // Still inside an OSC whose terminator has not arrived: drop payload
      // until it does. Nothing here is ever kept, so the memory and the work
      // both stay proportional to this chunk.
      if (oscSkip) {
        let from = 0;
        if (oscEsc) {
          // An empty chunk decides nothing -- keep waiting rather than
          // forgetting that an ESC is still pending, which would strand the
          // parser inside the OSC and swallow everything after it.
          if (input.length === 0) return;
          oscEsc = false;
          // The ESC that ended the previous chunk completes an ST only if
          // this one opens with a backslash.
          if (input[0] === '\\') {
            oscSkip = false;
            from = 1;
          }
        }
        if (oscSkip) {
          const end = oscEnd(input, from);
          if (end === OSC_NOT_FOUND) return;
          if (end === OSC_ESC_TAIL) { oscEsc = true; return; }
          oscSkip = false;
          i = end;
        } else {
          i = from;
        }
      } else if (csiSkip) {
        // Still inside an over-long CSI: drop bytes until its final one.
        const end = csiEnd(input, 0);
        if (end < 0) return;
        csiSkip = false;
        i = end;
      }
      while (i < input.length) {
        const ch = input[i];
        if (ch === '\x1b') {
          const seq = escapeSequence(input, i);
          if (seq.needsMore) {
            const tail = input.slice(i);
            // Everything that can legitimately wait for the next chunk is a
            // few characters (a partial CSI, a two- or three-byte escape);
            // the unbounded case, an OSC body, never reaches here. Anything
            // longer is malformed, and keeping it would let a sender grow
            // this buffer without limit.
            pending = tail.length <= MAX_PENDING ? tail : '';
            return;
          }
          i = seq.end;
        } else {
          text(ch);
          i++;
        }
      }
    },
    screenRows() {
      return lines.slice();
    },
    altScreenActive() {
      return alt;
    },
    version() {
      return version;
    },
    // Number of DISTINCT rows touched since the previous call, resetting the
    // tally. The caller samples this on a fixed cadence and divides by the
    // elapsed time to get "rows changed per second" -- the busy/quiet signal
    // activity.js splits 'busy' from 'low' on. Unlike version(), it does not
    // grow with the terminal width: a spinner redrawing one row for a whole
    // slice counts as 1 no matter how many columns it paints.
    takeDirtyRowCount() {
      const n = dirtyRows.size;
      dirtyRows = new Set();
      return n;
    },
  };
}
