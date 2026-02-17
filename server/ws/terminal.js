import {
  createSession,
  getSession,
  attachSocket,
  detachSocket,
} from './sessionManager.js';

export async function terminalWs(fastify, opts) {
  fastify.get('/ws/terminal', { websocket: true }, (socket, req) => {
    let currentSessionId = null;

    socket.on('message', (rawMessage) => {
      let msg;
      try {
        msg = JSON.parse(rawMessage.toString());
      } catch {
        if (currentSessionId) {
          const session = getSession(currentSessionId);
          if (session?.ptyProcess && !session.exited) {
            session.ptyProcess.write(rawMessage.toString());
          }
        }
        return;
      }

      switch (msg.type) {
        case 'init': {
          if (currentSessionId) {
            detachSocket(currentSessionId, socket);
          }

          const { sessionId, session } = createSession({
            cwd: msg.cwd || '/home/kts_sz',
            cols: msg.cols || 80,
            rows: msg.rows || 24,
            claudeSessionId: msg.claudeSessionId || null,
            shell: !!msg.shell,
          });

          currentSessionId = sessionId;
          attachSocket(sessionId, socket);

          socket.send(
            JSON.stringify({
              type: 'session',
              sessionId,
              cwd: session.cwd,
              cols: session.cols,
              rows: session.rows,
              isReconnect: false,
            })
          );
          break;
        }

        case 'attach': {
          if (!msg.sessionId) {
            socket.send(
              JSON.stringify({
                type: 'error',
                message: 'sessionId required',
                code: 'INVALID_REQUEST',
              })
            );
            break;
          }

          const session = getSession(msg.sessionId);
          if (!session) {
            socket.send(
              JSON.stringify({
                type: 'error',
                message: 'Session not found',
                code: 'SESSION_NOT_FOUND',
              })
            );
            break;
          }

          if (currentSessionId && currentSessionId !== msg.sessionId) {
            detachSocket(currentSessionId, socket);
          }

          currentSessionId = msg.sessionId;
          attachSocket(msg.sessionId, socket);

          socket.send(
            JSON.stringify({
              type: 'session',
              sessionId: msg.sessionId,
              cwd: session.cwd,
              cols: session.cols,
              rows: session.rows,
              isReconnect: true,
            })
          );

          for (const chunk of session.outputBuffer) {
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: 'replay', data: chunk }));
            }
          }

          if (session.exited) {
            socket.send(
              JSON.stringify({
                type: 'exit',
                exitCode: session.exitCode,
                signal: session.exitSignal,
                claudeSessionId: session.claudeSessionId,
              })
            );
          }

          if (msg.cols && msg.rows && !session.exited) {
            session.ptyProcess.resize(msg.cols, msg.rows);
            session.cols = msg.cols;
            session.rows = msg.rows;
          }
          break;
        }

        case 'input': {
          if (currentSessionId) {
            const session = getSession(currentSessionId);
            if (session?.ptyProcess && !session.exited) {
              session.ptyProcess.write(msg.data);
              session.idleNotified = false;
              if (session.idleTimer) {
                clearTimeout(session.idleTimer);
                session.idleTimer = null;
              }
            }
          }
          break;
        }

        case 'ping': {
          socket.send(JSON.stringify({ type: 'pong' }));
          break;
        }

        case 'resize': {
          if (currentSessionId && msg.cols && msg.rows) {
            const session = getSession(currentSessionId);
            if (session?.ptyProcess && !session.exited) {
              session.ptyProcess.resize(msg.cols, msg.rows);
              session.cols = msg.cols;
              session.rows = msg.rows;
            }
          }
          break;
        }
      }
    });

    socket.on('close', () => {
      if (currentSessionId) {
        detachSocket(currentSessionId, socket);
        currentSessionId = null;
      }
    });

    socket.on('error', (err) => {
      fastify.log.error('WebSocket error:', err);
      if (currentSessionId) {
        detachSocket(currentSessionId, socket);
        currentSessionId = null;
      }
    });
  });
}
