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
  const ensureRow = () => {
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

  const csiParams = (body) => body.split(';').map((p) => (p === '' ? 0 : Number(p) || 0));

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

  // Parse the escape sequence starting at input[start] (an ESC byte).
  // Returns { end } (exclusive) when complete, { needsMore: true } when it
  // runs off the end of the input (the caller keeps the tail pending).
  const escapeSequence = (input, start) => {
    const next = input[start + 1];
    if (next === '[') {
      let j = start + 2;
      while (j < input.length && '0123456789;?'.includes(input[j])) j++;
      if (j >= input.length) return { needsMore: true };
      const final = input[j];
      if (final >= '@' && final <= '~') {
        csi(input.slice(start + 2, j), final);
        return { end: j + 1 };
      }
      return { end: j + 1 }; // malformed CSI -- skip the final byte
    }
    if (next === ']') {
      let j = start + 2;
      while (j < input.length && input[j] !== '\x07' && !(input[j] === '\x1b' && input[j + 1] === '\\')) j++;
      if (j >= input.length) return { needsMore: true };
      return { end: input[j] === '\x07' ? j + 1 : j + 2 };
    }
    if (next === '(' || next === ')' || next === '=' || next === '>' || next === '#') {
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
      while (i < input.length) {
        const ch = input[i];
        if (ch === '\x1b') {
          const seq = escapeSequence(input, i);
          if (seq.needsMore) {
            pending = input.slice(i);
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
