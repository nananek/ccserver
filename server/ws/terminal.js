import { homedir } from 'node:os';
import {
  createSession,
  getSession,
  attachSocket,
  detachSocket,
  setScheduledPrompt,
  cancelScheduledPrompt,
  scheduledPromptPublic,
  computeNextLocalTime,
  getServerTimeInfo,
} from './sessionManager.js';

// Build a schedule_state payload including server timezone info so the client
// can display/interpret times in the server's zone (matching Claude Code).
function scheduleStateMsg(scheduled, error) {
  const { tz, now } = getServerTimeInfo();
  return JSON.stringify({
    type: 'schedule_state',
    scheduled,
    serverTz: tz,
    serverNow: now,
    ...(error ? { error } : {}),
  });
}

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

          const result = createSession({
            cwd: msg.cwd || homedir(),
            cols: msg.cols || 80,
            rows: msg.rows || 24,
            claudeSessionId: msg.claudeSessionId || null,
            shell: !!msg.shell,
          });

          if (result.error) {
            socket.send(JSON.stringify({
              type: 'error',
              message: result.error,
              code: 'SPAWN_FAILED',
            }));
            break;
          }

          const { sessionId, session } = result;
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
          socket.send(scheduleStateMsg(scheduledPromptPublic(session)));
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

          // Send auto-yes state on attach
          if (!session.shell) {
            socket.send(JSON.stringify({
              type: 'auto_yes_state',
              enabled: session.autoYes,
              log: session.autoYesLog,
            }));
          }

          // Send scheduled-prompt state on attach (available for all sessions)
          socket.send(scheduleStateMsg(scheduledPromptPublic(session)));
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

        case 'set_auto_yes': {
          if (currentSessionId) {
            const session = getSession(currentSessionId);
            if (session && !session.shell) {
              session.autoYes = !!msg.enabled;
              socket.send(JSON.stringify({
                type: 'auto_yes_state',
                enabled: session.autoYes,
                log: session.autoYesLog,
              }));
            }
          }
          break;
        }

        case 'get_auto_yes': {
          if (currentSessionId) {
            const session = getSession(currentSessionId);
            if (session) {
              socket.send(JSON.stringify({
                type: 'auto_yes_state',
                enabled: session.autoYes,
                log: session.autoYesLog,
              }));
            }
          }
          break;
        }

        case 'schedule_prompt': {
          if (currentSessionId) {
            // Prefer an "HH:MM" wall-clock time interpreted in the server's
            // timezone; fall back to an explicit absolute epoch (`at`).
            const at = msg.time != null
              ? computeNextLocalTime(msg.time)
              : Number(msg.at);
            const text = typeof msg.text === 'string' ? msg.text : '';
            const scheduled = at != null ? setScheduledPrompt(currentSessionId, at, text) : null;
            socket.send(scheduleStateMsg(
              scheduled,
              scheduled ? undefined : 'Invalid schedule (time must be HH:MM in the future within 48h, with non-empty text)'
            ));
          }
          break;
        }

        case 'cancel_schedule': {
          if (currentSessionId) {
            cancelScheduledPrompt(currentSessionId);
            socket.send(scheduleStateMsg(null));
          }
          break;
        }

        case 'get_schedule': {
          if (currentSessionId) {
            const session = getSession(currentSessionId);
            if (session) {
              socket.send(scheduleStateMsg(scheduledPromptPublic(session)));
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
