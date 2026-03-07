import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { getThemeIds, getTheme } from '../themes.js';
import { authWsUrl } from '../auth.js';

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

const themeIds = getThemeIds();

export default function TerminalView({ cwd, onClose, claudeSessionId, shell, notify, notifyEnabled, notifyPermission, onToggleNotify, visible, onSessionId, attachSessionId, xtermTheme, themeId, onThemeChange, tabId, onAttention, onFocusTab }) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const wsRef = useRef(null);
  const fitAddonRef = useRef(null);
  const sessionIdRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const claudeResumeIdRef = useRef(claudeSessionId);
  const shellRef = useRef(shell);
  const [autoYes, setAutoYes] = useState(false);
  const [autoYesLog, setAutoYesLog] = useState([]);
  const [showAutoYesLog, setShowAutoYesLog] = useState(false);
  const notifyRef = useRef(notify);
  useEffect(() => { notifyRef.current = notify; }, [notify]);
  const onAttentionRef = useRef(onAttention);
  useEffect(() => { onAttentionRef.current = onAttention; }, [onAttention]);
  const onFocusTabRef = useRef(onFocusTab);
  useEffect(() => { onFocusTabRef.current = onFocusTab; }, [onFocusTab]);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const onSessionIdRef = useRef(onSessionId);
  useEffect(() => { onSessionIdRef.current = onSessionId; }, [onSessionId]);

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
    const isMobile = 'ontouchstart' in window;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: isMobile ? 12 : 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: xtermThemeRef.current,
      scrollSensitivity: isMobile ? 3 : 1,
      fastScrollSensitivity: isMobile ? 10 : 5,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

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

    // Click on terminal container to restore focus
    const containerEl = terminalRef.current;
    const handleContainerClick = () => {
      term.focus();
    };
    containerEl.addEventListener('click', handleContainerClick);

    // Mobile touch scroll - override xterm's broken iOS touch handling
    let touchStartY = 0;
    let touchScrolling = false;
    const handleTouchStart = (e) => {
      if (e.touches.length === 1) {
        touchStartY = e.touches[0].clientY;
        touchScrolling = false;
      }
    };
    const handleTouchMove = (e) => {
      if (e.touches.length !== 1) return;
      const dy = touchStartY - e.touches[0].clientY;
      const lines = Math.trunc(dy / 20);
      if (lines !== 0) {
        term.scrollLines(lines);
        touchStartY = e.touches[0].clientY;
        touchScrolling = true;
      }
    };
    const handleTouchEnd = (e) => {
      if (touchScrolling) {
        e.preventDefault();
      }
    };
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
          };
          if (!shellRef.current && claudeResumeIdRef.current) {
            initMsg.claudeSessionId = claudeResumeIdRef.current;
            claudeResumeIdRef.current = null;
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
            if (msg.isReconnect) {
              term.clear();
            }
            term.focus();
            break;
          case 'output':
            term.write(msg.data);
            break;
          case 'auto_yes':
            setAutoYesLog((prev) => [...prev, msg.entry]);
            break;
          case 'auto_yes_state':
            setAutoYes(msg.enabled);
            setAutoYesLog(msg.log || []);
            break;
          case 'replay':
            term.write(msg.data);
            break;
          case 'exit': {
            term.writeln('');
            term.writeln(`\r\n[Process exited with code ${msg.exitCode}]`);
            sessionStorage.removeItem(storageKey);
            sessionIdRef.current = null;
            const claudeResumeKey = `ccserver-claude-resume:${cwd}`;
            if (msg.claudeSessionId) {
              localStorage.setItem(claudeResumeKey, msg.claudeSessionId);
            } else {
              localStorage.removeItem(claudeResumeKey);
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
              };
              if (!shellRef.current) {
                const savedClaudeId = claudeResumeIdRef.current
                  || localStorage.getItem(`ccserver-claude-resume:${cwd}`);
                if (savedClaudeId) {
                  initMsg.claudeSessionId = savedClaudeId;
                  claudeResumeIdRef.current = null;
                }
              }
              ws.send(JSON.stringify(initMsg));
            }
            break;
          }
          case 'input_needed': {
            if (onAttentionRef.current) {
              onAttentionRef.current();
            }
            if (notifyRef.current) {
              const n = notifyRef.current('Claude Code', {
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
      fitAddon.fit();
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

    return () => {
      intentionalCloseRef.current = true;
      clearTimeout(reconnectTimerRef.current);
      clearInterval(pingInterval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      containerEl.removeEventListener('click', handleContainerClick);
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
        xtermRef.current.focus();
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

  const addCustomKey = useCallback(() => {
    const label = newKeyLabel.trim();
    const rawData = newKeyData.trim();
    if (!label || !rawData) return;
    const id = `custom:${label.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
    const data = parseEscapeSequence(rawData);
    const newKey = { id, label, data };
    const nextCustom = [...customKeys, newKey];
    setCustomKeys(nextCustom);
    localStorage.setItem(CUSTOM_KEYS_STORAGE, JSON.stringify(nextCustom));
    setKeyConfig((prev) => {
      const next = [...prev, id];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    setNewKeyLabel('');
    setNewKeyData('');
  }, [newKeyLabel, newKeyData, customKeys]);

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

  return (
    <div className={`terminal-view${keyboardOpen ? ' keyboard-open' : ''}`}>
      <div className="terminal-header">
        <span className="terminal-title">{shell ? 'Terminal' : 'Claude Code'} &mdash; {cwd}</span>
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
            {autoYesLog.map((entry, i) => (
              <div key={i} className="auto-yes-log-entry">
                <span className="auto-yes-log-time">{new Date(entry.time).toLocaleTimeString()}</span>
                <span className="auto-yes-log-prompt">{entry.prompt}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="terminal-container" ref={terminalRef} />
      {!keyboardOpen && (
        <div className="terminal-scroll-controls">
          <button className="scroll-btn" onClick={() => xtermRef.current?.scrollLines(-10)} title="Scroll up">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10l4-4 4 4"/></svg>
          </button>
          <button className="scroll-btn" onClick={() => xtermRef.current?.scrollToTop()} title="Top">Top</button>
          <button className="scroll-btn" onClick={() => xtermRef.current?.scrollToBottom()} title="Bottom">Btm</button>
          <button className="scroll-btn" onClick={() => xtermRef.current?.scrollLines(10)} title="Scroll down">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4"/></svg>
          </button>
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
            <div className="key-config-custom-form">
              <input
                type="text"
                className="key-config-input"
                placeholder="ラベル"
                value={newKeyLabel}
                onChange={(e) => setNewKeyLabel(e.target.value)}
                maxLength={20}
              />
              <input
                type="text"
                className="key-config-input key-config-input-data"
                placeholder="データ (例: \x03, \e[A, hello\r)"
                value={newKeyData}
                onChange={(e) => setNewKeyData(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addCustomKey(); }}
              />
              <button className="btn btn-primary btn-sm" onClick={addCustomKey} disabled={!newKeyLabel.trim() || !newKeyData.trim()}>追加</button>
            </div>
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
