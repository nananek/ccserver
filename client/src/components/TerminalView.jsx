import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

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

  return (
    <div className="terminal-view">
      <div className="terminal-header">
        <button className="btn btn-secondary" onClick={onBack}>
          Back
        </button>
        <span className="terminal-title">Claude Code &mdash; {cwd}</span>
      </div>
      <div className="terminal-container" ref={terminalRef} />
    </div>
  );
}
