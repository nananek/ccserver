import * as pty from 'node-pty';

export async function terminalWs(fastify, opts) {
  fastify.get('/ws/terminal', { websocket: true }, (socket, req) => {
    let ptyProcess = null;

    socket.on('message', (rawMessage) => {
      let msg;
      try {
        msg = JSON.parse(rawMessage.toString());
      } catch {
        if (ptyProcess) ptyProcess.write(rawMessage.toString());
        return;
      }

      switch (msg.type) {
        case 'init': {
          const cwd = msg.cwd || '/home/kts_sz';
          const cols = msg.cols || 80;
          const rows = msg.rows || 24;

          if (ptyProcess) {
            ptyProcess.kill();
          }

          ptyProcess = pty.spawn('/usr/bin/claude', [], {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env: {
              ...process.env,
              TERM: 'xterm-256color',
              COLORTERM: 'truecolor',
              FORCE_COLOR: '1',
            },
          });

          ptyProcess.onData((data) => {
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: 'output', data }));
            }
          });

          ptyProcess.onExit(({ exitCode, signal }) => {
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: 'exit', exitCode, signal }));
            }
          });

          socket.send(JSON.stringify({ type: 'ready', cwd, cols, rows }));
          break;
        }

        case 'input': {
          if (ptyProcess) {
            ptyProcess.write(msg.data);
          }
          break;
        }

        case 'resize': {
          if (ptyProcess && msg.cols && msg.rows) {
            ptyProcess.resize(msg.cols, msg.rows);
          }
          break;
        }
      }
    });

    socket.on('close', () => {
      if (ptyProcess) {
        ptyProcess.kill();
        ptyProcess = null;
      }
    });

    socket.on('error', (err) => {
      fastify.log.error('WebSocket error:', err);
      if (ptyProcess) {
        ptyProcess.kill();
        ptyProcess = null;
      }
    });
  });
}
