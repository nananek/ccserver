import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

const SPECIAL_KEYS = [
  { label: 'BS', data: '\x7f' },
  { label: 'Enter', data: '\r' },
  { label: 'Tab', data: '\t' },
  { label: 'C-c', data: '\x03' },
  { label: 'Ctrl', modifier: 'ctrl' },
  { label: '\u2191', data: '\x1b[A' },
  { label: '\u2193', data: '\x1b[B' },
  { label: 'C-d', data: '\x04' },
  { label: '\u2190', data: '\x1b[D' },
  { label: '\u2192', data: '\x1b[C' },
  { label: 'C-z', data: '\x1a' },
  { label: 'Shift', modifier: 'shift' },
  { label: 'Alt', modifier: 'alt' },
  { label: 'Esc', data: '\x1b' },
];

const MAX_RECONNECT_ATTEMPTS = 20;
const PING_INTERVAL_MS = 30000;

export default function TerminalView({ cwd, onClose, claudeSessionId, notify, notifyEnabled, notifyPermission, onToggleNotify, visible }) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const wsRef = useRef(null);
  const fitAddonRef = useRef(null);
  const sessionIdRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const claudeResumeIdRef = useRef(claudeSessionId);
  const notifyRef = useRef(notify);
  useEffect(() => { notifyRef.current = notify; }, [notify]);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        selectionBackground: '#585b70',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#f5c2e7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#f5c2e7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8',
      },
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
    const existingSessionId = sessionStorage.getItem(storageKey);
    if (existingSessionId) {
      sessionIdRef.current = existingSessionId;
    }

    const inputDisposable = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws/terminal`;
      const ws = new WebSocket(wsUrl);
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
          };
          if (claudeResumeIdRef.current) {
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
            if (msg.isReconnect) {
              term.clear();
            }
            term.focus();
            break;
          case 'output':
            term.write(msg.data);
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
              };
              const savedClaudeId = claudeResumeIdRef.current
                || localStorage.getItem(`ccserver-claude-resume:${cwd}`);
              if (savedClaudeId) {
                initMsg.claudeSessionId = savedClaudeId;
                claudeResumeIdRef.current = null;
              }
              ws.send(JSON.stringify(initMsg));
            }
            break;
          }
          case 'input_needed':
            if (notifyRef.current) {
              notifyRef.current('Claude Code', {
                body: `Input needed in ${cwd}`,
                icon: '/icon-192.png',
                tag: `input-needed-${cwd}`,
              });
            }
            break;
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
      inputDisposable.dispose();
      wsRef.current?.close();
      term.dispose();
    };
  }, [cwd]);

  // Re-fit terminal when tab becomes visible
  useEffect(() => {
    if (visible && fitAddonRef.current && xtermRef.current) {
      // Small delay to let layout settle after display:none → flex
      const timer = setTimeout(() => {
        fitAddonRef.current.fit();
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

  const sendInput = useCallback((data) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  }, []);

  const handleInputSend = useCallback(() => {
    if (composingRef.current) return;
    if (!inputText) return;
    sendInput(inputText + '\r');
    setInputText('');
    setModifiers({ ctrl: false, shift: false, alt: false });
  }, [inputText, sendInput]);

  const handleInputKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter' && !composingRef.current) {
        e.preventDefault();
        handleInputSend();
      }
    },
    [handleInputSend]
  );

  const handleSpecialKey = useCallback((key) => {
    if (key.modifier) {
      setModifiers((prev) => ({ ...prev, [key.modifier]: !prev[key.modifier] }));
      return;
    }
    sendInput(key.data);
  }, [sendInput]);

  return (
    <div className="terminal-view">
      <div className="terminal-header">
        <span className="terminal-title">Claude Code &mdash; {cwd}</span>
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
          {notifyEnabled ? '\uD83D\uDD14' : '\uD83D\uDD15'}
        </button>
      </div>
      <div className="terminal-container" ref={terminalRef} />
      <div className="terminal-special-keys">
        {SPECIAL_KEYS.map((key) => (
          <button
            key={key.label}
            className={
              'special-key-btn' +
              (key.modifier && modifiers[key.modifier] ? ' active' : '')
            }
            onClick={() => handleSpecialKey(key)}
          >
            {key.label}
          </button>
        ))}
      </div>
      <div className="terminal-input-bar">
        <input
          type="text"
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
          placeholder="Input text here..."
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <button className="btn btn-primary terminal-send-btn" onClick={handleInputSend}>
          Send
        </button>
      </div>
    </div>
  );
}
