import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

const SPECIAL_KEYS = [
  { label: 'Tab', data: '\t' },
  { label: 'Esc', data: '\x1b' },
  { label: 'Ctrl', modifier: 'ctrl' },
  { label: 'Shift', modifier: 'shift' },
  { label: 'Alt', modifier: 'alt' },
  { label: '\u2190', data: '\x1b[D' },
  { label: '\u2191', data: '\x1b[A' },
  { label: '\u2193', data: '\x1b[B' },
  { label: '\u2192', data: '\x1b[C' },
  { label: 'C-c', data: '\x03' },
  { label: 'C-d', data: '\x04' },
  { label: 'C-z', data: '\x1a' },
];

export default function TerminalView({ cwd, onBack }) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const wsRef = useRef(null);
  const fitAddonRef = useRef(null);

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

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/terminal`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      const dims = fitAddon.proposeDimensions();
      ws.send(
        JSON.stringify({
          type: 'init',
          cwd,
          cols: dims?.cols || 80,
          rows: dims?.rows || 24,
        })
      );
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'ready':
          term.focus();
          break;
        case 'output':
          term.write(msg.data);
          break;
        case 'exit':
          term.writeln('');
          term.writeln(`\r\n[Process exited with code ${msg.exitCode}]`);
          break;
      }
    };

    ws.onclose = () => {
      term.writeln('\r\n[Connection closed]');
    };

    ws.onerror = () => {
      term.writeln('\r\n[Connection error]');
    };

    const inputDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    const handleResize = () => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims && ws.readyState === WebSocket.OPEN) {
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
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      inputDisposable.dispose();
      ws.close();
      term.dispose();
    };
  }, [cwd]);

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
    sendInput(inputText + '\n');
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
        <button className="btn btn-secondary" onClick={onBack}>
          Back
        </button>
        <span className="terminal-title">Claude Code &mdash; {cwd}</span>
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
