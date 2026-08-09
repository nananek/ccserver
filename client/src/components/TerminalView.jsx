import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { getThemeIds, getTheme } from '../themes.js';
import { authWsUrl } from '../auth.js';
import { createOsc52Handler } from '../osc52.js';
import { dewrapSelection } from '../dewrap.js';

const ALL_SPECIAL_KEYS = [
  { id: 'bs', label: 'BS', data: '\x7f' },
  { id: 'enter', label: 'Enter', data: '\r' },
  { id: 'tab', label: 'Tab', data: '\t' },
  { id: 'c-c', label: 'C-c', data: '\x03' },
  { id: 'ctrl', label: 'Ctrl', modifier: 'ctrl' },
  { id: 'up', label: '\u2191', data: '\x1b[A' },
  { id: 'down', label: '\u2193', data: '\x1b[B' },
  { id: 'c-d', label: 'C-d', data: '\x04' },
  { id: 'left', label: '\u2190', data: '\x1b[D' },
  { id: 'right', label: '\u2192', data: '\x1b[C' },
  { id: 'c-z', label: 'C-z', data: '\x1a' },
  { id: 'shift', label: 'Shift', modifier: 'shift' },
  { id: 'alt', label: 'Alt', modifier: 'alt' },
  { id: 'esc', label: 'Esc', data: '\x1b' },
  { id: 'c-a', label: 'C-a', data: '\x01' },
  { id: 'c-e', label: 'C-e', data: '\x05' },
  { id: 'c-l', label: 'C-l', data: '\x0c' },
  { id: 'c-r', label: 'C-r', data: '\x12' },
  { id: 'c-w', label: 'C-w', data: '\x17' },
  { id: 'c-u', label: 'C-u', data: '\x15' },
  { id: 'c-k', label: 'C-k', data: '\x0b' },
  { id: 'del', label: 'Del', data: '\x1b[3~' },
  { id: 'home', label: 'Home', data: '\x1b[H' },
  { id: 'end', label: 'End', data: '\x1b[F' },
];

const BUILTIN_KEY_MAP = Object.fromEntries(ALL_SPECIAL_KEYS.map((k) => [k.id, k]));

const DEFAULT_KEY_IDS = [
  'bs', 'enter', 'tab', 'c-c', 'ctrl',
  'up', 'down', 'c-d', 'left', 'right',
  'c-z', 'shift', 'alt', 'esc',
];

const STORAGE_KEY = 'ccserver-special-keys';
const CUSTOM_KEYS_STORAGE = 'ccserver-custom-keys';

function loadCustomKeys() {
  try {
    const saved = localStorage.getItem(CUSTOM_KEYS_STORAGE);
    if (saved) {
      const keys = JSON.parse(saved);
      if (Array.isArray(keys)) return keys;
    }
  } catch { /* ignore */ }
  return [];
}

function buildKeyMap(customKeys) {
  const map = { ...BUILTIN_KEY_MAP };
  for (const k of customKeys) {
    map[k.id] = k;
  }
  return map;
}

function parseEscapeSequence(str) {
  return str
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\e/g, '\x1b')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

// Inverse of parseEscapeSequence: raw bytes -> the \xNN/\e/\r notation, for
// showing users what a picked key actually sends without requiring them to
// read/write that notation themselves.
function formatEscapeSequence(str) {
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (ch === '\x1b') out += '\\e';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\\') out += '\\\\';
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out;
}

// Structured picker for building a custom key's byte sequence without typing
// escape notation by hand. Ctrl/Alt on cursor/function keys use the standard
// xterm CSI-modifier encoding (\x1b[1;<mod><final>, mod = 1 + alt*2 + ctrl*4);
// Ctrl on a letter computes the control byte, Alt prefixes ESC ("meta sends
// escape") -- both match what real terminals send.
const PICKER_LETTER_DEFS = Array.from({ length: 26 }, (_, i) => {
  const ch = String.fromCharCode(97 + i);
  return { id: `letter:${ch}`, label: ch.toUpperCase(), kind: 'letter', char: ch, ctrlAlt: true };
});

const PICKER_NAMED_DEFS = [
  { id: 'named:enter', label: 'Enter', kind: 'plain', data: '\r', ctrlAlt: false },
  { id: 'named:tab', label: 'Tab', kind: 'plain', data: '\t', ctrlAlt: false },
  { id: 'named:esc', label: 'Esc', kind: 'plain', data: '\x1b', ctrlAlt: false },
  { id: 'named:bs', label: 'Backspace', kind: 'plain', data: '\x7f', ctrlAlt: false },
  { id: 'named:space', label: 'Space', kind: 'plain', data: ' ', ctrlAlt: false },
  { id: 'named:up', label: '↑ Up', kind: 'csi-final', final: 'A', ctrlAlt: true },
  { id: 'named:down', label: '↓ Down', kind: 'csi-final', final: 'B', ctrlAlt: true },
  { id: 'named:right', label: '→ Right', kind: 'csi-final', final: 'C', ctrlAlt: true },
  { id: 'named:left', label: '← Left', kind: 'csi-final', final: 'D', ctrlAlt: true },
  { id: 'named:home', label: 'Home', kind: 'csi-final', final: 'H', ctrlAlt: true },
  { id: 'named:end', label: 'End', kind: 'csi-final', final: 'F', ctrlAlt: true },
  { id: 'named:ins', label: 'Insert', kind: 'csi-tilde', num: 2, ctrlAlt: true },
  { id: 'named:del', label: 'Delete', kind: 'csi-tilde', num: 3, ctrlAlt: true },
  { id: 'named:pgup', label: 'PageUp', kind: 'csi-tilde', num: 5, ctrlAlt: true },
  { id: 'named:pgdn', label: 'PageDown', kind: 'csi-tilde', num: 6, ctrlAlt: true },
  { id: 'named:f1', label: 'F1', kind: 'ss3', final: 'P', ctrlAlt: true },
  { id: 'named:f2', label: 'F2', kind: 'ss3', final: 'Q', ctrlAlt: true },
  { id: 'named:f3', label: 'F3', kind: 'ss3', final: 'R', ctrlAlt: true },
  { id: 'named:f4', label: 'F4', kind: 'ss3', final: 'S', ctrlAlt: true },
  { id: 'named:f5', label: 'F5', kind: 'csi-tilde', num: 15, ctrlAlt: true },
  { id: 'named:f6', label: 'F6', kind: 'csi-tilde', num: 17, ctrlAlt: true },
  { id: 'named:f7', label: 'F7', kind: 'csi-tilde', num: 18, ctrlAlt: true },
  { id: 'named:f8', label: 'F8', kind: 'csi-tilde', num: 19, ctrlAlt: true },
  { id: 'named:f9', label: 'F9', kind: 'csi-tilde', num: 20, ctrlAlt: true },
  { id: 'named:f10', label: 'F10', kind: 'csi-tilde', num: 21, ctrlAlt: true },
  { id: 'named:f11', label: 'F11', kind: 'csi-tilde', num: 23, ctrlAlt: true },
  { id: 'named:f12', label: 'F12', kind: 'csi-tilde', num: 24, ctrlAlt: true },
];

const PICKER_KEY_MAP = Object.fromEntries([...PICKER_LETTER_DEFS, ...PICKER_NAMED_DEFS].map((d) => [d.id, d]));

function buildPickerSequence(def, ctrl, alt) {
  if (!def) return '';
  const mod = 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  if (def.kind === 'csi-final') return mod > 1 ? `\x1b[1;${mod}${def.final}` : `\x1b[${def.final}`;
  if (def.kind === 'csi-tilde') return mod > 1 ? `\x1b[${def.num};${mod}~` : `\x1b[${def.num}~`;
  if (def.kind === 'ss3') return mod > 1 ? `\x1b[1;${mod}${def.final}` : `\x1bO${def.final}`;
  if (def.kind === 'letter') {
    const base = ctrl ? String.fromCharCode(def.char.toUpperCase().charCodeAt(0) - 64) : def.char;
    return alt ? `\x1b${base}` : base;
  }
  return alt ? `\x1b${def.data}` : def.data; // 'plain'
}

function buildPickerLabel(def, ctrl, alt) {
  if (!def) return '';
  const prefix = `${ctrl ? 'C-' : ''}${alt ? 'M-' : ''}`;
  return def.kind === 'letter' ? `${prefix}${def.char}` : `${prefix}${def.label}`;
}

function loadKeyConfig(keyMap) {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const ids = JSON.parse(saved);
      if (Array.isArray(ids) && ids.length > 0 && ids.every((id) => keyMap[id])) {
        return ids;
      }
    }
  } catch { /* ignore */ }
  return DEFAULT_KEY_IDS;
}

const MAX_RECONNECT_ATTEMPTS = 20;
const PING_INTERVAL_MS = 30000;

function appLabel(app) {
  return app === 'opencode' ? 'opencode' : 'Claude Code';
}

// OSC 52 clipboard writes (sent by apps like opencode): update the browser
// clipboard, falling back to a hidden-textarea copy when the async Clipboard
// API is unavailable (non-secure context, denied permission, ...).
function writeClipboardText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch { /* clipboard unavailable — nothing more we can do */ }
}

function readClipboardText() {
  if (navigator.clipboard?.readText && window.isSecureContext) {
    return navigator.clipboard.readText().catch(() => null);
  }
  return Promise.resolve(null);
}

// OSC 52 query response: the clipboard content base64-encoded for the app.
function osc52Response(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `\x1b]52;c;${btoa(bin)}\x07`;
}

const themeIds = getThemeIds();

export default function TerminalView({ cwd, onClose, claudeSessionId, shell, sandbox, sandboxOpts, app = 'claude', resume = false, notify, notifyEnabled, notifyPermission, onToggleNotify, visible, onSessionId, onExited, attachSessionId, xtermTheme, themeId, onThemeChange, tabId, onAttention, onFocusTab, groupId, groupRole }) {
  const isMobile = useMemo(() => 'ontouchstart' in window, []);
  const terminalRef = useRef(null);
  const terminalViewRef = useRef(null);
  const xtermRef = useRef(null);
  const wsRef = useRef(null);
  const fitAddonRef = useRef(null);
  const sessionIdRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const claudeResumeIdRef = useRef(claudeSessionId);
  const shellRef = useRef(shell);
  const sandboxRef = useRef(sandbox);
  const sandboxOptsRef = useRef(sandboxOpts);
  const appRef = useRef(app);
  const resumeRef = useRef(resume);
  const [autoYes, setAutoYes] = useState(false);
  const [autoYesLog, setAutoYesLog] = useState([]);
  const [showAutoYesLog, setShowAutoYesLog] = useState(false);
  const [schedule, setSchedule] = useState(null); // { at, text } | null
  const [showScheduler, setShowScheduler] = useState(false);
  const [scheduleTime, setScheduleTime] = useState('');
  const [schedulePromptText, setSchedulePromptText] = useState('');
  const [scheduleError, setScheduleError] = useState('');
  const [serverTz, setServerTz] = useState(null);
  const serverOffsetRef = useRef(0); // serverNow - clientNow (ms)
  const [nowTick, setNowTick] = useState(() => Date.now());
  const notifyRef = useRef(notify);
  useEffect(() => { notifyRef.current = notify; }, [notify]);
  const onAttentionRef = useRef(onAttention);
  useEffect(() => { onAttentionRef.current = onAttention; }, [onAttention]);
  const onFocusTabRef = useRef(onFocusTab);
  useEffect(() => { onFocusTabRef.current = onFocusTab; }, [onFocusTab]);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  // Explicit mobile "select text" mode: a long-press gesture alone gives no
  // feedback in a PWA (no OS haptics), so entering selection is a deliberate
  // toggle instead -- its on/off state IS the confirmation. While active,
  // any single-finger drag starts a selection immediately (no long-press
  // wait) and the terminal is blurred/kept unfocused so the on-screen
  // keyboard doesn't pop up and shift the layout underneath it.
  //
  // Blurring alone isn't enough: xterm.js focuses its input textarea on
  // every mousedown (including the synthetic ones we dispatch for
  // touch-selection), which would pop the IME right back up. So we set
  // disableStdin -- xterm turns the textarea readonly in response, and
  // iOS/Android never open an IME for a readonly input -- but only for the
  // instant of the synthetic mousedown dispatch (see `dispatchMouse`),
  // not for the whole selection session. disableStdin is "stop stdin
  // entirely", not "make the textarea readonly": leaving it on would also
  // silently kill paste (its handlers funnel into triggerDataEvent, which
  // early-returns while disableStdin is set).
  const [selectionMode, setSelectionMode] = useState(false);
  const selectionModeRef = useRef(false);
  useEffect(() => {
    selectionModeRef.current = selectionMode;
    const term = xtermRef.current;
    if (!term) return;
    if (selectionMode) {
      term.blur();
    } else {
      term.focus();
    }
  }, [selectionMode]);
  // Whether a touch-selection has text selected and the floating copy
  // button should show; positioned off the (reactively-updated) end
  // handle rather than its own tracked coordinates -- see `handles`.
  const [copyBtn, setCopyBtn] = useState(false);
  // { start: {x,y}, end: {x,y} } (viewport coords) for the two draggable
  // selection-adjustment handles; null when there's no active selection.
  const [handles, setHandles] = useState(null);
  // Mirrors `handles` synchronously for use inside touch event listeners,
  // which close over state from whenever the effect last ran and would
  // otherwise see a stale value across renders.
  const handlesRef = useRef(null);
  const onSessionIdRef = useRef(onSessionId);
  useEffect(() => { onSessionIdRef.current = onSessionId; }, [onSessionId]);
  const onExitedRef = useRef(onExited);
  useEffect(() => { onExitedRef.current = onExited; }, [onExited]);

  const xtermThemeRef = useRef(xtermTheme);
  useEffect(() => { xtermThemeRef.current = xtermTheme; }, [xtermTheme]);

  useEffect(() => {
    if (!themeMenuOpen) return;
    const handleClick = (e) => {
      if (themeMenuRef.current && !themeMenuRef.current.contains(e.target)) {
        setThemeMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [themeMenuOpen]);

  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = xtermTheme;
    }
  }, [xtermTheme]);

  // Detect iOS keyboard open/close via visualViewport
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const threshold = 100;
    const handleResize = () => {
      const isKb = window.innerHeight - vv.height > threshold;
      setKeyboardOpen(isKb);
    };
    vv.addEventListener('resize', handleResize);
    return () => vv.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    // Narrow screens: keep the terminal wide enough for the TUI's bottom
    // chrome (opencode's prompt meta row — agent · model · provider — wraps
    // to 2-3 lines below ~65 columns, eating most of the screen), shrinking
    // the font instead of letting the UI wrap.
    const MIN_TERMINAL_COLS = 68;
    const MIN_FONT_SIZE = 9;
    const MAX_FONT_SIZE = 14;
    const CHAR_RATIO = 0.602; // measured advance width for the mono stack
    const pickFontSize = (width) => {
      const natural = isMobile ? 12 : MAX_FONT_SIZE;
      if (!width) return natural;
      if (width / (natural * CHAR_RATIO) >= MIN_TERMINAL_COLS) return natural;
      const shrunk = Math.floor((width / (MIN_TERMINAL_COLS * CHAR_RATIO)) * 10) / 10;
      return Math.max(MIN_FONT_SIZE, Math.min(natural, shrunk));
    };

    const term = new Terminal({
      cursorBlink: true,
      fontSize: pickFontSize(terminalRef.current?.clientWidth),
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: xtermThemeRef.current,
      scrollSensitivity: isMobile ? 3 : 1,
      fastScrollSensitivity: isMobile ? 10 : 5,
      // FitAddon reserves 14px for the scrollbar unless scrollback is 0.
      // opencode's TUI owns its history (no xterm scrollback needed), so drop
      // it to let the terminal use the full width.
      scrollback: appRef.current === 'opencode' ? 0 : 1000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    // opencode draws in the alternate screen, so xterm.js's buffer never has
    // scrollable content — pin the viewport to the bottom after every write
    // so a transient scroll (resize, buffer switch on exit/reconnect) can't
    // leave the TUI shifted out of view. Its own scrollbar is hidden via the
    // .tui-scroll class on the container.
    const pinToBottom = () => {
      if (appRef.current === 'opencode') term.scrollToBottom();
    };

    // Re-fit after the font size is corrected so the pty gets the adjusted
    // column count.
    const correctFontSize = () => {
      const fs = pickFontSize(terminalRef.current?.clientWidth);
      if (fs !== term.options.fontSize) {
        term.options.fontSize = fs;
        fitAddon.fit();
      }
    };
    correctFontSize();
    pinToBottom();

    // OSC 52 (clipboard) extraction: apps like opencode write the clipboard
    // via OSC 52, which xterm.js ignores. Handle it here and strip the
    // sequences from the stream.
    const osc52 = createOsc52Handler({
      onWrite: (text) => writeClipboardText(text),
      onQuery: () => {
        readClipboardText().then((text) => {
          if (text == null) return;
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data: osc52Response(text) }));
          }
        });
      },
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const storageKey = `ccserver-session:${cwd}`;
    if (attachSessionId) {
      sessionIdRef.current = attachSessionId;
    }

    const inputDisposable = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    const binaryDisposable = term.onBinary((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Click on terminal container to restore focus, unless selection mode
    // is deliberately keeping the keyboard closed.
    const containerEl = terminalRef.current;
    const handleContainerClick = () => {
      if (!selectionModeRef.current) term.focus();
    };
    containerEl.addEventListener('click', handleContainerClick);

    // Mobile touch scroll - override xterm's broken iOS touch handling.
    // Vertical drags are translated into synthetic wheel events: when the app
    // has mouse tracking (opencode's TUI) xterm.js forwards them as wheel-
    // mouse sequences, which scroll the TUI's internal conversation history;
    // without tracking (shells, claude) it scrolls its own buffer instead.
    //
    // Text selection is a separate, explicit mode (see `selectionMode`)
    // rather than a long-press gesture -- a PWA gets no OS haptic feedback,
    // so there was no way to tell a long-press had actually landed. While
    // the mode is on, any single-finger drag starts a selection immediately:
    // xterm.js already has full mouse-driven selection (SelectionService,
    // bound to real mouse events) -- iOS just never gets a chance to
    // trigger it, because canvas-rendered glyphs aren't selectable DOM text
    // for the OS's native gestures, and touch-action: none on the container
    // (see app.css) suppresses them anyway so our own handling can own
    // touch-drag unambiguously. So a drag dispatches synthetic
    // mousedown/mousemove/mouseup at the touch coordinates instead of wheel
    // events, letting xterm's own selection logic do the rest exactly as it
    // would for a real mouse. A floating "コピー" button appears afterward
    // since iOS has no native copy menu for a canvas selection either.
    const HANDLE_HIT_RADIUS = 28;
    let touchStartX = 0;
    let touchStartY = 0;
    let touchScrolling = false;
    let selecting = false;
    const dispatchMouse = (type, x, y, buttons) => {
      // detail must be 1 (a real single click) -- xterm's SelectionService
      // branches on event.detail to pick single/double/triple-click
      // handling (handleMouseDown), and a MouseEvent's detail defaults to 0
      // when unset, which matches none of those branches and silently no-ops.
      //
      // A mousedown makes xterm focus its input textarea, which pops the
      // IME back up unless the textarea is readonly at that instant. Set
      // disableStdin just around the dispatch (dispatchEvent runs listeners
      // synchronously) so the readonly window covers exactly the focus
      // moment -- and nothing else, keeping paste and other stdin paths
      // working during the rest of selection mode.
      const isMousedown = type === 'mousedown';
      if (isMousedown) term.options.disableStdin = true;
      term.element.dispatchEvent(new MouseEvent(type, {
        clientX: x, clientY: y, button: 0, buttons, detail: 1, bubbles: true, cancelable: true,
      }));
      if (isMousedown) term.options.disableStdin = false;
    };
    // Converts a buffer cell position (x/y, as returned by
    // term.getSelectionPosition() -- 0-based in practice despite the
    // "(1-based)" wording in xterm's own type declarations, confirmed by
    // round-tripping term.select(0, row, n)) into pixel coords -- rows are
    // real DOM nodes under .xterm-rows, one per visible line, so their rect
    // gives us cell size.
    //
    // Returns both viewport-relative coords (x/y/anchorY -- for touch
    // hit-testing and synthetic mouse dispatch, which the DOM always
    // reports in viewport space) and terminal-view-relative coords
    // (relX/relY -- for CSS position:absolute rendering). The relative
    // pair is what actually survives an iOS keyboard open/close: a fixed,
    // viewport-space handle needs every scroll/resize event caught and
    // recomputed, but an absolutely-positioned one anchored to a normal-flow
    // ancestor moves together with the row it marks for free, since both
    // are offset from the same shifting reference point identically.
    //
    // y/anchorY: `y` hangs below the row (for drawing a handle that
    // doesn't cover the character it marks); `anchorY` sits at the row's
    // own vertical center (for precisely re-establishing a selection
    // anchor -- landing exactly on a row boundary is ambiguous for
    // xterm's own hit-testing).
    const cellPixel = (bufY, bufX) => {
      const viewportRow = bufY - term.buffer.active.viewportY;
      if (viewportRow < 0 || viewportRow >= term.rows) return null;
      const rowEl = containerEl.querySelectorAll('.xterm-rows > div')[viewportRow];
      if (!rowEl) return null;
      const rect = rowEl.getBoundingClientRect();
      const anchorRect = terminalViewRef.current.getBoundingClientRect();
      const cellWidth = rect.width / term.cols;
      const x = rect.x + bufX * cellWidth;
      const y = rect.y + rect.height;
      return {
        x, y, anchorY: rect.y + rect.height / 2,
        relX: x - anchorRect.x, relY: y - anchorRect.y,
      };
    };
    const updateHandles = () => {
      if (!term.hasSelection()) {
        handlesRef.current = null;
        setHandles(null);
        return;
      }
      const pos = term.getSelectionPosition();
      const start = pos ? cellPixel(pos.start.y, pos.start.x) : null;
      const end = pos ? cellPixel(pos.end.y, pos.end.x) : null;
      const next = start && end ? { start, end } : null;
      handlesRef.current = next;
      setHandles(next);
    };
    const nearHandle = (x, y) => {
      const h = handlesRef.current;
      if (!h) return null;
      if (Math.hypot(x - h.start.x, y - h.start.y) <= HANDLE_HIT_RADIUS) return 'start';
      if (Math.hypot(x - h.end.x, y - h.end.y) <= HANDLE_HIT_RADIUS) return 'end';
      return null;
    };
    const handleTouchStart = (e) => {
      if (e.touches.length !== 1) return;
      const { clientX, clientY } = e.touches[0];
      touchStartX = clientX;
      touchStartY = clientY;
      touchScrolling = false;

      // Grabbing an existing handle re-anchors the selection at the OTHER
      // end (using its precise row-center Y, not the handle's own
      // below-row drawing position) and immediately starts following the
      // touch, so dragging either handle adjusts that side independently
      // without disturbing the rest of the selection.
      const grabbed = nearHandle(clientX, clientY);
      if (grabbed) {
        selecting = true;
        const fixed = grabbed === 'start' ? handlesRef.current.end : handlesRef.current.start;
        dispatchMouse('mousedown', fixed.x, fixed.anchorY, 1);
        dispatchMouse('mousemove', clientX, clientY, 1);
        return;
      }

      if (selectionModeRef.current) {
        selecting = true;
        setCopyBtn(false);
        dispatchMouse('mousedown', clientX, clientY, 1);
        return;
      }

      selecting = false;
    };
    const handleTouchMove = (e) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      if (selecting) {
        dispatchMouse('mousemove', touch.clientX, touch.clientY, 1);
        return;
      }
      const dy = touchStartY - touch.clientY;
      if (Math.abs(dy) >= 20) {
        term.element.dispatchEvent(new WheelEvent('wheel', {
          deltaY: dy,
          clientX: touch.clientX,
          clientY: touch.clientY,
          bubbles: true,
          cancelable: true,
        }));
        touchStartY = touch.clientY;
        touchScrolling = true;
      }
    };
    const handleTouchEnd = (e) => {
      if (selecting) {
        selecting = false;
        const { clientX, clientY } = e.changedTouches[0] || {};
        dispatchMouse('mouseup', clientX, clientY, 0);
        updateHandles();
        setCopyBtn(term.hasSelection() && clientX != null);
        e.preventDefault();
        return;
      }
      if (touchScrolling) {
        e.preventDefault();
        return;
      }
      // A plain tap that wasn't a drag: if a selection is still showing
      // from an earlier one, treat the tap as "dismiss" rather than
      // leaving stale handles on screen.
      if (term.hasSelection()) {
        term.clearSelection();
      }
    };
    const selectionChangeDisposable = term.onSelectionChange(() => {
      updateHandles();
      if (!term.hasSelection()) setCopyBtn(false);
    });
    if (isMobile) {
      containerEl.addEventListener('touchstart', handleTouchStart, { passive: true });
      containerEl.addEventListener('touchmove', handleTouchMove, { passive: true });
      containerEl.addEventListener('touchend', handleTouchEnd);
    }

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws/terminal`;
      const ws = new WebSocket(authWsUrl(wsUrl));
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptsRef.current = 0;
        const dims = fitAddon.proposeDimensions();

        if (sessionIdRef.current) {
          ws.send(
            JSON.stringify({
              type: 'attach',
              sessionId: sessionIdRef.current,
              cols: dims?.cols || 80,
              rows: dims?.rows || 24,
            })
          );
        } else {
          const initMsg = {
            type: 'init',
            cwd,
            cols: dims?.cols || 80,
            rows: dims?.rows || 24,
            shell: !!shellRef.current,
            sandbox: !!sandboxRef.current,
            sandboxOpts: sandboxOptsRef.current || null,
            app: appRef.current,
            // Group membership is carried into a re-launch so the server can
            // re-create the member's MCP channel and register it to the role.
            groupId: groupId || null,
            groupRole: groupRole || null,
          };
          if (!shellRef.current && claudeResumeIdRef.current) {
            initMsg.claudeSessionId = claudeResumeIdRef.current;
            claudeResumeIdRef.current = null;
          } else if (!shellRef.current && appRef.current === 'opencode' && resumeRef.current) {
            initMsg.resume = true;
          }
          ws.send(JSON.stringify(initMsg));
        }
      };

      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        switch (msg.type) {
          case 'session':
            sessionIdRef.current = msg.sessionId;
            sessionStorage.setItem(storageKey, msg.sessionId);
            if (onSessionIdRef.current) onSessionIdRef.current(msg.sessionId);
            // 再接続などで同一タブに新しいセッションが始まるケースがあるため、
            // セッション確立のたびにexitedフラグを戻す。
            if (onExitedRef.current) onExitedRef.current(false);
            if (msg.isReconnect) {
              term.clear();
            }
            if (!selectionModeRef.current) term.focus();
            break;
          case 'output':
            term.write(osc52.process(msg.data));
            pinToBottom();
            break;
          case 'auto_yes':
            setAutoYesLog((prev) => [...prev, msg.entry]);
            break;
          case 'auto_yes_state':
            setAutoYes(msg.enabled);
            setAutoYesLog(msg.log || []);
            break;
          case 'schedule_state':
            setSchedule(msg.scheduled || null);
            setScheduleError(msg.error || '');
            if (msg.serverTz) setServerTz(msg.serverTz);
            if (typeof msg.serverNow === 'number') {
              serverOffsetRef.current = msg.serverNow - Date.now();
            }
            break;
          case 'schedule_fired': {
            setSchedule(null);
            if (notifyRef.current) {
              const n = notifyRef.current(appLabel(appRef.current), {
                body: `Scheduled prompt sent in ${cwd}`,
                icon: '/icon-192.png',
                tag: `schedule-fired-${cwd}`,
              });
              if (n) {
                n.onclick = () => {
                  window.focus();
                  if (onFocusTabRef.current) onFocusTabRef.current();
                  n.close();
                };
              }
            }
            break;
          }
          case 'replay':
            term.write(osc52.process(msg.data));
            pinToBottom();
            break;
          case 'exit': {
            term.writeln('');
            term.writeln(`\r\n[Process exited with code ${msg.exitCode}]`);
            pinToBottom();
            sessionStorage.removeItem(storageKey);
            sessionIdRef.current = null;
            if (onExitedRef.current) onExitedRef.current(true);
            const app = appRef.current;
            const resumeKey = `ccserver-resume:${app}:${cwd}`;
            if (msg.claudeSessionId) {
              localStorage.setItem(resumeKey, msg.claudeSessionId);
            } else {
              localStorage.removeItem(resumeKey);
              // Legacy key from before sessions were app-scoped
              if (app === 'claude') localStorage.removeItem(`ccserver-claude-resume:${cwd}`);
            }
            break;
          }
          case 'error': {
            if (msg.code === 'SESSION_NOT_FOUND') {
              sessionIdRef.current = null;
              sessionStorage.removeItem(storageKey);
              const dims = fitAddon.proposeDimensions();
              const initMsg = {
                type: 'init',
                cwd,
                cols: dims?.cols || 80,
                rows: dims?.rows || 24,
                shell: !!shellRef.current,
                sandbox: !!sandboxRef.current,
                sandboxOpts: sandboxOptsRef.current || null,
                app: appRef.current,
                groupId: groupId || null,
                groupRole: groupRole || null,
              };
              if (!shellRef.current) {
                const app = appRef.current;
                const savedClaudeId = claudeResumeIdRef.current
                  || localStorage.getItem(`ccserver-resume:${app}:${cwd}`)
                  || (app === 'claude'
                    ? localStorage.getItem(`ccserver-claude-resume:${cwd}`)
                    : null);
                if (savedClaudeId) {
                  initMsg.claudeSessionId = savedClaudeId;
                  claudeResumeIdRef.current = null;
                } else if (app === 'opencode' && resumeRef.current) {
                  // opencode has no conversation id in its byte stream, so a
                  // re-launch continues via `opencode -c` (last session of the
                  // project) like the saved-session flow does.
                  initMsg.resume = true;
                }
              }
              ws.send(JSON.stringify(initMsg));
            } else {
              // Any other error (e.g. SPAWN_FAILED — the target app isn't
              // installed, or resolveApp/sandbox setup failed) previously had
              // no handler here: the tab just sat open and blank forever,
              // with nothing telling the user what went wrong.
              term.writeln(`\r\n[Error: ${msg.message || 'unknown error'}${msg.code ? ` (${msg.code})` : ''}]`);
            }
            break;
          }
          case 'input_needed': {
            if (onAttentionRef.current) {
              onAttentionRef.current();
            }
            if (notifyRef.current) {
              const n = notifyRef.current(appLabel(appRef.current), {
                body: `Input needed in ${cwd}`,
                icon: '/icon-192.png',
                tag: `input-needed-${cwd}`,
              });
              if (n) {
                n.onclick = () => {
                  window.focus();
                  if (onFocusTabRef.current) onFocusTabRef.current();
                  n.close();
                };
              }
            }
            break;
          }
          case 'detached':
            term.writeln('\r\n[Session taken over by another client]');
            intentionalCloseRef.current = true;
            break;
        }
      };

      ws.onclose = () => {
        if (intentionalCloseRef.current) return;

        if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(
            1000 * Math.pow(2, reconnectAttemptsRef.current),
            10000
          );
          reconnectAttemptsRef.current++;
          term.writeln(
            `\r\n[Connection lost. Reconnecting in ${delay / 1000}s... (${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS})]`
          );
          reconnectTimerRef.current = setTimeout(() => connect(), delay);
        } else {
          term.writeln(
            '\r\n[Connection lost. Max reconnection attempts reached.]'
          );
        }
      };

      ws.onerror = () => {
        // onclose will fire after this
      };
    }

    connect();

    // Reconnect when page becomes visible (iPhone background recovery)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const ws = wsRef.current;
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          if (intentionalCloseRef.current) return;
          reconnectAttemptsRef.current = 0;
          clearTimeout(reconnectTimerRef.current);
          connect();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Periodic ping to keep WebSocket alive
    const pingInterval = setInterval(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, PING_INTERVAL_MS);

    const handleResize = () => {
      // Recompute the font first so the fit sees the corrected columns.
      const fs = pickFontSize(terminalRef.current?.clientWidth);
      if (fs !== term.options.fontSize) {
        term.options.fontSize = fs;
      }
      fitAddon.fit();
      pinToBottom();
      // Rows re-rendered at (possibly) new screen positions -- any visible
      // selection handles were computed against the old layout.
      updateHandles();
      const dims = fitAddon.proposeDimensions();
      const ws = wsRef.current;
      if (dims && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'resize',
            cols: dims.cols,
            rows: dims.rows,
          })
        );
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    resizeObserver.observe(terminalRef.current);

    window.addEventListener('resize', handleResize);

    // Scrolling the buffer moves every row's position within the
    // container without changing the selection itself -- handles need
    // recomputing. (A page-level shift from the iOS keyboard opening does
    // NOT need a separate visualViewport listener: handles are positioned
    // relative to .terminal-view via cellPixel's relX/relY, so they move
    // together with the rows they mark for free.)
    const scrollDisposable = term.onScroll(() => updateHandles());

    return () => {
      intentionalCloseRef.current = true;
      clearTimeout(reconnectTimerRef.current);
      clearInterval(pingInterval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      scrollDisposable.dispose();
      containerEl.removeEventListener('click', handleContainerClick);
      selectionChangeDisposable.dispose();
      if (isMobile) {
        containerEl.removeEventListener('touchstart', handleTouchStart);
        containerEl.removeEventListener('touchmove', handleTouchMove);
        containerEl.removeEventListener('touchend', handleTouchEnd);
      }
      inputDisposable.dispose();
      binaryDisposable.dispose();
      wsRef.current?.close();
      term.dispose();
    };
  }, [cwd]);

  // Re-fit terminal and restore focus when tab becomes visible
  useEffect(() => {
    if (visible && fitAddonRef.current && xtermRef.current) {
      // Small delay to let layout settle after display:none → flex
      const timer = setTimeout(() => {
        fitAddonRef.current.fit();
        if (!selectionModeRef.current) xtermRef.current.focus();
        const dims = fitAddonRef.current.proposeDimensions();
        const ws = wsRef.current;
        if (dims && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [visible]);

  const [inputText, setInputText] = useState('');
  const composingRef = useRef(false);
  const [modifiers, setModifiers] = useState({ ctrl: false, shift: false, alt: false });
  const [customKeys, setCustomKeys] = useState(loadCustomKeys);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [newKeyData, setNewKeyData] = useState('');
  const [customKeyTab, setCustomKeyTab] = useState('key'); // 'key' | 'text' | 'advanced'
  const [pickerKeyId, setPickerKeyId] = useState('');
  const [pickerCtrl, setPickerCtrl] = useState(false);
  const [pickerAlt, setPickerAlt] = useState(false);
  const [pickerText, setPickerText] = useState('');
  const [pickerAppendEnter, setPickerAppendEnter] = useState(false);

  const keyMap = buildKeyMap(customKeys);
  const [keyConfig, setKeyConfig] = useState(() => loadKeyConfig(keyMap));
  const [showKeyConfig, setShowKeyConfig] = useState(false);

  const activeKeys = keyConfig.map((id) => keyMap[id]).filter(Boolean);
  const allKeys = [...ALL_SPECIAL_KEYS, ...customKeys];

  const saveKeyConfig = useCallback((ids) => {
    setKeyConfig(ids);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  }, []);

  const toggleKeyInConfig = useCallback((id) => {
    setKeyConfig((prev) => {
      const next = prev.includes(id) ? prev.filter((k) => k !== id) : [...prev, id];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const moveKeyInConfig = useCallback((id, direction) => {
    setKeyConfig((prev) => {
      const idx = prev.indexOf(id);
      if (idx < 0) return prev;
      const swapIdx = idx + direction;
      if (swapIdx < 0 || swapIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const resetKeyConfig = useCallback(() => {
    setCustomKeys([]);
    localStorage.removeItem(CUSTOM_KEYS_STORAGE);
    saveKeyConfig([...DEFAULT_KEY_IDS]);
  }, [saveKeyConfig]);

  const commitCustomKey = useCallback((label, data) => {
    if (!label || !data) return;
    const id = `custom:${label.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
    const newKey = { id, label, data };
    const nextCustom = [...customKeys, newKey];
    setCustomKeys(nextCustom);
    localStorage.setItem(CUSTOM_KEYS_STORAGE, JSON.stringify(nextCustom));
    setKeyConfig((prev) => {
      const next = [...prev, id];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, [customKeys]);

  // Draft state for the "カスタムキーを追加" form, derived fresh each render
  // from whichever of the three input modes (key picker / literal text /
  // raw notation) is currently selected.
  const pickerKeyDef = PICKER_KEY_MAP[pickerKeyId];
  const pickerCtrlAltCapable = !!pickerKeyDef?.ctrlAlt;
  const effectivePickerCtrl = pickerCtrl && pickerCtrlAltCapable;
  const effectivePickerAlt = pickerAlt && pickerCtrlAltCapable;
  const customKeyDraft = (() => {
    if (customKeyTab === 'key') {
      const data = pickerKeyDef ? buildPickerSequence(pickerKeyDef, effectivePickerCtrl, effectivePickerAlt) : '';
      const autoLabel = pickerKeyDef ? buildPickerLabel(pickerKeyDef, effectivePickerCtrl, effectivePickerAlt) : '';
      return { data, autoLabel, valid: !!pickerKeyDef };
    }
    if (customKeyTab === 'text') {
      const data = pickerText + (pickerAppendEnter ? '\r' : '');
      const autoLabel = pickerText.trim() || (pickerAppendEnter ? 'Enter' : '');
      return { data, autoLabel, valid: !!(pickerText.trim() || pickerAppendEnter) };
    }
    const raw = newKeyData.trim();
    const data = raw ? parseEscapeSequence(raw) : '';
    return { data, autoLabel: data ? formatEscapeSequence(data) : '', valid: !!raw };
  })();

  const resetCustomKeyForm = useCallback(() => {
    setNewKeyLabel('');
    setNewKeyData('');
    setPickerKeyId('');
    setPickerCtrl(false);
    setPickerAlt(false);
    setPickerText('');
    setPickerAppendEnter(false);
  }, []);

  const addCustomKey = useCallback(() => {
    if (!customKeyDraft.valid) return;
    const label = newKeyLabel.trim() || customKeyDraft.autoLabel;
    commitCustomKey(label, customKeyDraft.data);
    resetCustomKeyForm();
  }, [customKeyDraft, newKeyLabel, commitCustomKey, resetCustomKeyForm]);

  const deleteCustomKey = useCallback((id) => {
    const nextCustom = customKeys.filter((k) => k.id !== id);
    setCustomKeys(nextCustom);
    localStorage.setItem(CUSTOM_KEYS_STORAGE, JSON.stringify(nextCustom));
    setKeyConfig((prev) => {
      const next = prev.filter((k) => k !== id);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, [customKeys]);

  const sendInput = useCallback((data) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  }, []);

  // opencode's message-scroll keybindings (see src/config/keybind.ts in the
  // opencode repo): pageup/pagedown scroll half a page, ctrl+g / ctrl+alt+g
  // jump to the first/last message.
  const OPENCODE_SCROLL_KEYS = {
    up: '\x1b[5~', // pageup
    down: '\x1b[6~', // pagedown
    top: '\x07', // ctrl+g
    btm: '\x1b\x07', // ctrl+alt+g
  };

  const handleScrollButton = useCallback((action) => {
    const term = xtermRef.current;
    if (!term) return;
    if (appRef.current === 'opencode') {
      sendInput(OPENCODE_SCROLL_KEYS[action]);
    } else if (action === 'top') {
      term.scrollToTop();
    } else if (action === 'btm') {
      term.scrollToBottom();
    } else {
      term.scrollLines(action === 'up' ? -10 : 10);
    }
  }, [sendInput]);

  const handleInputSend = useCallback(() => {
    if (composingRef.current) return;
    if (!inputText) return;
    sendInput(inputText);
    setInputText('');
    setModifiers({ ctrl: false, shift: false, alt: false });
  }, [inputText, sendInput]);

  const handleInputKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter' && !composingRef.current) {
        e.preventDefault();
        if (inputText.endsWith('\\')) {
          setInputText((prev) => prev.slice(0, -1) + '\n');
        } else {
          if (!inputText) return;
          sendInput(inputText + '\r');
          setInputText('');
          setModifiers({ ctrl: false, shift: false, alt: false });
        }
      }
    },
    [inputText, sendInput]
  );

  const handleSpecialKey = useCallback((key) => {
    if (key.modifier) {
      setModifiers((prev) => ({ ...prev, [key.modifier]: !prev[key.modifier] }));
      return;
    }
    sendInput(key.data);
  }, [sendInput]);

  // Format an absolute epoch in the SERVER's timezone (matching Claude Code's
  // rate-limit reset times), falling back to the browser locale if unknown.
  const fmtServer = useCallback((epoch, opts) => {
    try {
      return new Date(epoch).toLocaleString([], { timeZone: serverTz || undefined, ...opts });
    } catch {
      return new Date(epoch).toLocaleString([], opts);
    }
  }, [serverTz]);

  const submitSchedule = useCallback(() => {
    if (!/^(\d{1,2}):(\d{2})$/.test(scheduleTime.trim())) {
      setScheduleError('時刻を HH:MM 形式で入力してください');
      return;
    }
    if (!schedulePromptText.trim()) {
      setScheduleError('プロンプト文面を入力してください');
      return;
    }
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Send the HH:MM string; the server interprets it in its own timezone.
      ws.send(JSON.stringify({ type: 'schedule_prompt', time: scheduleTime, text: schedulePromptText }));
      setScheduleError('');
    }
  }, [scheduleTime, schedulePromptText]);

  const cancelSchedule = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cancel_schedule' }));
    }
  }, []);

  // Tick a live clock while the scheduler panel is open so the displayed
  // server time stays current.
  useEffect(() => {
    if (!showScheduler) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [showScheduler]);

  return (
    <div className={`terminal-view${keyboardOpen ? ' keyboard-open' : ''}${selectionMode ? ' selection-mode' : ''}`} ref={terminalViewRef}>
      <div className="terminal-header">
        <span className="terminal-title">{sandbox ? '🔒 ' : ''}{shell ? 'Terminal' : appLabel(app)} &mdash; {cwd}</span>
        <div className="header-actions">
          <div className="theme-picker" ref={themeMenuRef}>
            <button
              className="btn theme-btn"
              onClick={() => setThemeMenuOpen((v) => !v)}
              title="Theme"
            >
              <svg className="header-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="4.5" r="1" fill="currentColor" stroke="none"/><circle cx="5" cy="6.5" r="1" fill="currentColor" stroke="none"/><circle cx="11" cy="6.5" r="1" fill="currentColor" stroke="none"/><circle cx="6" cy="10" r="1" fill="currentColor" stroke="none"/></svg>
            </button>
            {themeMenuOpen && (
              <div className="theme-menu">
                {themeIds.map((id) => (
                  <div
                    key={id}
                    className={`theme-menu-item${id === themeId ? ' active' : ''}`}
                    onClick={() => {
                      onThemeChange(id);
                      setThemeMenuOpen(false);
                    }}
                  >
                    {getTheme(id).name}
                  </div>
                ))}
              </div>
            )}
          </div>
          {!shell && (
            <>
              <button
                className={`btn auto-yes-toggle${autoYes ? ' active' : ''}`}
                onClick={() => {
                  const ws = wsRef.current;
                  if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'set_auto_yes', enabled: !autoYes }));
                  }
                }}
                title={autoYes ? 'Auto-yes enabled (click to disable)' : 'Auto-yes disabled (click to enable)'}
              >
                Auto-Y
              </button>
              {autoYesLog.length > 0 && (
                <button
                  className={`btn auto-yes-toggle${showAutoYesLog ? ' active' : ''}`}
                  onClick={() => setShowAutoYesLog((v) => !v)}
                  title="Auto-yes log"
                >
                  {autoYesLog.length}
                </button>
              )}
            </>
          )}
          <button
            className={`btn schedule-toggle${schedule ? ' active' : ''}`}
            onClick={() => setShowScheduler((v) => !v)}
            title={schedule
              ? `Scheduled prompt at ${fmtServer(schedule.at)} (click to view)`
              : 'Schedule a prompt'}
          >
            <svg className="header-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>
            {schedule && <span className="schedule-badge" />}
          </button>
          <button
            className={`btn notify-toggle${notifyEnabled ? ' active' : ''}`}
            onClick={onToggleNotify}
            title={
              notifyPermission === 'denied'
                ? 'Notifications blocked in browser settings'
                : notifyPermission === 'unsupported'
                  ? 'Notifications not supported'
                  : notifyEnabled
                    ? 'Disable notifications'
                    : 'Enable notifications'
            }
            disabled={notifyPermission === 'denied' || notifyPermission === 'unsupported'}
          >
            <svg className="header-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 12.5a2 2 0 004 0"/><path d="M4.5 6.5a3.5 3.5 0 017 0c0 2 .5 3 1.5 4.5H3C4 9.5 4.5 8.5 4.5 6.5z"/>{!notifyEnabled && <line x1="2" y1="2" x2="14" y2="14" strokeWidth="2"/>}</svg>
          </button>
        </div>
      </div>
      {showAutoYesLog && autoYesLog.length > 0 && (
        <div className="auto-yes-log">
          <div className="auto-yes-log-header">
            <span>Auto-Yes Log ({autoYesLog.length})</span>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowAutoYesLog(false)}>&#10005;</button>
          </div>
          <div className="auto-yes-log-list">
            {[...autoYesLog].reverse().map((entry, i) => (
              <div key={autoYesLog.length - 1 - i} className="auto-yes-log-entry">
                <span className="auto-yes-log-time">{new Date(entry.time).toLocaleTimeString()}</span>
                <span className="auto-yes-log-prompt">{entry.prompt}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {showScheduler && (
        <div className="scheduler-panel">
          <div className="scheduler-header">
            <span>予約プロンプト</span>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowScheduler(false)}>&#10005;</button>
          </div>
          <div className="scheduler-servertime">
            サーバー現在時刻: {fmtServer(nowTick + serverOffsetRef.current)}
            {serverTz ? ` (${serverTz})` : ' (タイムゾーン取得中…)'}
          </div>
          {schedule ? (
            <div className="scheduler-active">
              <div className="scheduler-active-info">
                <span className="scheduler-active-time">
                  {fmtServer(schedule.at)} に送信予定
                </span>
                <span className="scheduler-active-text">{schedule.text}</span>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={cancelSchedule}>キャンセル</button>
            </div>
          ) : (
            <div className="scheduler-form">
              <div className="scheduler-form-row">
                <input
                  type="time"
                  className="key-config-input scheduler-time"
                  value={scheduleTime}
                  onChange={(e) => setScheduleTime(e.target.value)}
                />
                <span className="scheduler-hint">サーバー時刻で送信(過ぎていれば翌日)</span>
              </div>
              <textarea
                className="terminal-input scheduler-text"
                value={schedulePromptText}
                onChange={(e) => setSchedulePromptText(e.target.value)}
                placeholder="送信するプロンプト文面..."
                rows={2}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <div className="scheduler-form-actions">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={submitSchedule}
                  disabled={!scheduleTime || !schedulePromptText.trim()}
                >
                  予約する
                </button>
              </div>
            </div>
          )}
          {scheduleError && <div className="scheduler-error">{scheduleError}</div>}
        </div>
      )}
      {/* opencode's TUI owns the conversation: the container hides xterm.js's
          empty scrollbar (.tui-scroll) and pinToBottom keeps the viewport at
          the bottom. */}
      <div className={`terminal-container${app === 'opencode' ? ' tui-scroll' : ''}`} ref={terminalRef} />
      {handles && (
        <>
          <div className="selection-handle" style={{ left: handles.start.relX, top: handles.start.relY }} />
          <div className="selection-handle" style={{ left: handles.end.relX, top: handles.end.relY }} />
        </>
      )}
      {copyBtn && handles && (
        <button
          className="selection-copy-btn"
          // Anchored to the (reactively-updated) end handle rather than the
          // touch point that was live when the button first appeared, so a
          // keyboard show/hide or scroll afterward can't leave it stranded.
          style={{
            left: Math.min(handles.end.relX, (terminalViewRef.current?.clientWidth ?? window.innerWidth) - 90),
            top: Math.max(handles.end.relY - 40, 8),
          }}
          onClick={() => {
            const term = xtermRef.current;
            if (term) {
              writeClipboardText(dewrapSelection(term.getSelection(), term.cols));
              term.clearSelection();
            }
            setCopyBtn(false);
          }}
        >
          📋 コピー
        </button>
      )}
      {!keyboardOpen && (
        <div className="terminal-scroll-controls">
          {/* opencode's TUI owns the conversation (mouse tracking + internal
              scroll), so its scrollback is frozen and xterm.js's scrollLines
              do nothing — drive the TUI with its message-scroll keybindings
              instead (PageUp/PageDown = half page, ctrl+g / ctrl+alt+g =
              first/last message). Other apps keep the buffer scroll. */}
          <button
            className="scroll-btn"
            onClick={() => handleScrollButton('up')}
            title="Scroll up"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10l4-4 4 4"/></svg>
          </button>
          <button className="scroll-btn" onClick={() => handleScrollButton('top')} title="Top">Top</button>
          <button className="scroll-btn" onClick={() => handleScrollButton('btm')} title="Bottom">Btm</button>
          <button
            className="scroll-btn"
            onClick={() => handleScrollButton('down')}
            title="Scroll down"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4"/></svg>
          </button>
          {isMobile && (
            <button
              className={'scroll-btn selection-mode-btn' + (selectionMode ? ' active' : '')}
              onClick={() => setSelectionMode((v) => !v)}
              title={selectionMode ? 'テキスト選択モードを終了' : 'テキスト選択モード'}
            >
              選択
            </button>
          )}
        </div>
      )}
      <div className="terminal-special-keys">
        {activeKeys.map((key) => (
          <button
            key={key.id}
            className={
              'special-key-btn' +
              (key.modifier && modifiers[key.modifier] ? ' active' : '')
            }
            onClick={() => handleSpecialKey(key)}
          >
            {key.label}
          </button>
        ))}
        <button
          className={'special-key-btn key-config-btn' + (showKeyConfig ? ' active' : '')}
          onClick={() => setShowKeyConfig((v) => !v)}
          title="Customize keys"
        >
          &#9881;
        </button>
      </div>
      {showKeyConfig && (
        <div className="key-config-panel">
          <div className="key-config-header">
            <span>キーのカスタマイズ</span>
            <div className="key-config-actions">
              <button className="btn btn-secondary btn-sm" onClick={resetKeyConfig}>リセット</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowKeyConfig(false)}>&#10005;</button>
            </div>
          </div>
          <div className="key-config-list">
            {keyConfig.map((id, idx) => {
              const key = keyMap[id];
              if (!key) return null;
              const isCustom = id.startsWith('custom:');
              return (
                <div key={id} className="key-config-item">
                  <button className="btn btn-secondary btn-sm" onClick={() => moveKeyInConfig(id, -1)} disabled={idx === 0}>&#9650;</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => moveKeyInConfig(id, 1)} disabled={idx === keyConfig.length - 1}>&#9660;</button>
                  <span className="key-config-label">{key.label}{isCustom ? ' *' : ''}</span>
                  {isCustom ? (
                    <button className="btn btn-secondary btn-sm key-config-remove" onClick={() => deleteCustomKey(id)} title="削除">&#128465;</button>
                  ) : null}
                  <button className="btn btn-secondary btn-sm key-config-remove" onClick={() => toggleKeyInConfig(id)}>&#10005;</button>
                </div>
              );
            })}
          </div>
          {allKeys.filter((k) => !keyConfig.includes(k.id)).length > 0 && (
            <div className="key-config-available">
              <div className="key-config-subheader">追加可能なキー</div>
              <div className="key-config-add-list">
                {allKeys.filter((k) => !keyConfig.includes(k.id)).map((key) => (
                  <button
                    key={key.id}
                    className="special-key-btn"
                    onClick={() => toggleKeyInConfig(key.id)}
                  >
                    + {key.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="key-config-custom">
            <div className="key-config-subheader">カスタムキーを追加</div>
            <div className="key-config-tabs">
              <button
                type="button"
                className={'key-config-tab' + (customKeyTab === 'key' ? ' active' : '')}
                onClick={() => setCustomKeyTab('key')}
              >
                キー
              </button>
              <button
                type="button"
                className={'key-config-tab' + (customKeyTab === 'text' ? ' active' : '')}
                onClick={() => setCustomKeyTab('text')}
              >
                テキスト
              </button>
              <button
                type="button"
                className={'key-config-tab' + (customKeyTab === 'advanced' ? ' active' : '')}
                onClick={() => setCustomKeyTab('advanced')}
              >
                詳細
              </button>
            </div>

            {customKeyTab === 'key' && (
              <div className="key-config-picker-row">
                <select
                  className="key-config-select"
                  value={pickerKeyId}
                  onChange={(e) => setPickerKeyId(e.target.value)}
                >
                  <option value="" disabled>キーを選択...</option>
                  <optgroup label="文字">
                    {PICKER_LETTER_DEFS.map((d) => (
                      <option key={d.id} value={d.id}>{d.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="特殊キー">
                    {PICKER_NAMED_DEFS.map((d) => (
                      <option key={d.id} value={d.id}>{d.label}</option>
                    ))}
                  </optgroup>
                </select>
                <label className={'key-config-modifier' + (pickerCtrlAltCapable ? '' : ' disabled')}>
                  <input
                    type="checkbox"
                    checked={effectivePickerCtrl}
                    disabled={!pickerCtrlAltCapable}
                    onChange={(e) => setPickerCtrl(e.target.checked)}
                  />
                  Ctrl
                </label>
                <label className={'key-config-modifier' + (pickerCtrlAltCapable ? '' : ' disabled')}>
                  <input
                    type="checkbox"
                    checked={effectivePickerAlt}
                    disabled={!pickerCtrlAltCapable}
                    onChange={(e) => setPickerAlt(e.target.checked)}
                  />
                  Alt
                </label>
              </div>
            )}

            {customKeyTab === 'text' && (
              <div className="key-config-picker-row">
                <input
                  type="text"
                  className="key-config-input key-config-input-data"
                  placeholder="送信するテキスト (例: hello)"
                  value={pickerText}
                  onChange={(e) => setPickerText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && customKeyDraft.valid) addCustomKey(); }}
                />
                <label className="key-config-modifier">
                  <input
                    type="checkbox"
                    checked={pickerAppendEnter}
                    onChange={(e) => setPickerAppendEnter(e.target.checked)}
                  />
                  末尾にEnter
                </label>
              </div>
            )}

            {customKeyTab === 'advanced' && (
              <div className="key-config-picker-row">
                <input
                  type="text"
                  className="key-config-input key-config-input-data"
                  placeholder="データ (例: \x03, \e[A, hello\r)"
                  value={newKeyData}
                  onChange={(e) => setNewKeyData(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && customKeyDraft.valid) addCustomKey(); }}
                />
              </div>
            )}

            <div className="key-config-custom-form">
              <input
                type="text"
                className="key-config-input"
                placeholder="ラベル (空欄で自動)"
                value={newKeyLabel}
                onChange={(e) => setNewKeyLabel(e.target.value)}
                maxLength={20}
              />
              <button className="btn btn-primary btn-sm" onClick={addCustomKey} disabled={!customKeyDraft.valid}>追加</button>
            </div>
            {customKeyDraft.valid && (
              <div className="key-config-preview">
                ラベル: <code>{newKeyLabel.trim() || customKeyDraft.autoLabel}</code>
                {' '}・ データ: <code>{formatEscapeSequence(customKeyDraft.data)}</code>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="terminal-input-bar">
        <textarea
          className="terminal-input"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleInputKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          placeholder="Input text here... (\ + Enter for newline)"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          rows={inputText.includes('\n') ? Math.min(inputText.split('\n').length, 5) : 1}
        />
        <button className="btn btn-primary terminal-send-btn" onClick={handleInputSend}>
          Send
        </button>
      </div>
    </div>
  );
}
