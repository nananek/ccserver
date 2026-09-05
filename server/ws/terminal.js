import { homedir } from 'node:os';
import { basename } from 'node:path';
import { getGroup, resolveMemberLaunchCwd } from './groupManager.js';
import {
  createSession,
  getSession,
  attachSocket,
  detachSocket,
  writeToSession,
  setScheduledPrompt,
  cancelScheduledPrompt,
  scheduledPromptPublic,
  computeNextLocalTime,
  resolveMcpSocketForSession,
  buildScheduleStateMsg as scheduleStateMsg,
} from './sessionManager.js';

// The /ws/terminal message dispatcher, factored out of the route registration
// so it can be driven by something other than a real `ws` socket -- namely
// server/ws/federationServer.js's terminal relay, which hands it a `chan`
// adapter object backed by a federation TLS connection instead of a browser
// WebSocket (see federationServer.js's header comment for why). `chan` only
// needs to satisfy the same minimal interface sessionManager.js already
// expects of `session.socket` everywhere: `.send(jsonString)`, `.close(code,
// reason)`, and a numeric `.readyState` (1 === open, matching the WebSocket
// convention `session.socket.readyState === 1` checks already rely on).
//
// Behavior is unchanged from before this refactor -- every case body below is
// the same logic that used to close over the route handler's local `socket`
// variable, just parameterized as `chan`.
export function attachTerminalHandler(chan) {
  let currentSessionId = null;

  async function handleMessage(msg) {
    switch (msg.type) {
      case 'init': {
        if (currentSessionId) {
          detachSocket(currentSessionId, chan);
        }

        // A restored group member (see GroupTabView) re-launches via init
        // with its groupId/groupRole: the group's MCP resolver recreates
        // the member's handoff channel / the orchestrator's control broker
        // so the resumed session can reach the group again. Without a
        // socket the member would be invisible to the UI and unable to
        // hand off -- refuse to spawn it, exactly like fireSchedule drops
        // the prompt in the same situation.
        const groupId = typeof msg.groupId === 'string' ? msg.groupId : null;
        const groupRole = typeof msg.groupRole === 'string' ? msg.groupRole : null;
        let mcpSocketPath = null;
        let resolvedCwd = null;
        let gitCommonDir = null;
        if (groupId && groupRole) {
          mcpSocketPath = await resolveMcpSocketForSession(groupId, groupRole);
          if (!mcpSocketPath) {
            chan.send(JSON.stringify({
              type: 'error',
              message: `Cannot re-launch group member ${groupRole}: the group's MCP channel could not be re-created (group may have been destroyed)`,
              code: 'SPAWN_FAILED',
            }));
            break;
          }
          // Never trust the client-echoed msg.cwd for a group member: it's
          // just a replay of what listGroupMembers told the browser last
          // time (see GroupTabView), and a worker's worktree may have
          // disappeared from disk since then. Resolving fresh here -- the
          // same single resolver every other (re)spawn site uses -- lets a
          // lost worktree be recreated (and the human notified on genuine
          // data loss) instead of launching into a dead directory; see
          // groupManager.resolveMemberLaunchCwd.
          const cwdRes = resolveMemberLaunchCwd(groupId, groupRole);
          if (!cwdRes) {
            chan.send(JSON.stringify({
              type: 'error',
              message: `Cannot re-launch group member ${groupRole}: the group's working directory could not be resolved`,
              code: 'SPAWN_FAILED',
            }));
            break;
          }
          resolvedCwd = cwdRes.cwd;
          gitCommonDir = cwdRes.gitCommonDir;
        }
        // An orchestrator re-launched through the browser's re-init path
        // still reaches the group via the re-created control broker above.
        // Its init cwd is the hashed orchestrator dir, so attribute the
        // session to the group's real project path (workers' cwd IS the
        // project dir, so the same override is harmless for them).
        const group = groupId ? getGroup(groupId) : null;
        const projectName = group?.cwd ? basename(group.cwd) : undefined;

        const result = createSession({
          cwd: resolvedCwd || msg.cwd || homedir(),
          cols: msg.cols || 80,
          rows: msg.rows || 24,
          claudeSessionId: msg.claudeSessionId || null,
          shell: !!msg.shell,
          sandbox: !!msg.sandbox,
          sandboxOpts: msg.sandboxOpts || null,
          app: msg.app || null,
          model: typeof msg.model === 'string' ? msg.model : null,
          // Permission mode for commandcode launches ('standard' when
          // absent/invalid -- createSession normalizes it; other apps and
          // shells never emit a flag from it).
          permissionMode: typeof msg.permissionMode === 'string' ? msg.permissionMode : 'standard',
          // Meta-agent launch from the browser UI (same flag REST
          // POST /api/sessions already accepts). The server still gates the
          // actual MCP injection on metaAgentMcp + broker state, so a stale
          // client can never conjure privileges by sending this.
          isMetaAgent: !!msg.isMetaAgent,
          resumeLast: !!msg.resume,
          groupId,
          groupRole,
          projectName,
          mcpSocketPath,
          gitCommonDir,
          // Default reuse (keep the previous persistent HOME); only an
          // explicit false (client's "新規作成" dialog) wipes it.
          reuseSandboxHome: msg.reuseSandboxHome !== false,
        });
        if (result.error) {
          chan.send(JSON.stringify({
            type: 'error',
            message: result.error,
            code: 'SPAWN_FAILED',
          }));
          break;
        }

        const { sessionId, session } = result;
        currentSessionId = sessionId;
        attachSocket(sessionId, chan);

        chan.send(
          JSON.stringify({
            type: 'session',
            sessionId,
            cwd: session.cwd,
            cols: session.cols,
            rows: session.rows,
            isReconnect: false,
            // Echo whether the meta MCP was really injected so the client
            // can surface a silent downgrade (flag requested but the broker
            // is off) instead of leaving it invisible.
            isMetaAgent: !!session.isMetaAgent,
          })
        );
        chan.send(scheduleStateMsg(scheduledPromptPublic(session)));
        break;
      }

      case 'attach': {
        if (!msg.sessionId) {
          chan.send(
            JSON.stringify({
              type: 'error',
              message: 'sessionId required',
              code: 'INVALID_REQUEST',
            })
          );
          break;
        }

        const session = getSession(msg.sessionId);
        // Refuse attaching to an exited session: the pty is gone, so the
        // client-side re-init path (which carries the tab's launch
        // settings, e.g. sandbox) is the correct continuation. Attaching
        // here would otherwise leave the user staring at a stale "Process
        // exited" screen and, worse, cancel the exit-cleanup timer
        // (attachSocket clears timeoutTimer), turning the session into a
        // zombie that lingers until the server restarts.
        if (!session || session.exited) {
          chan.send(
            JSON.stringify({
              type: 'error',
              message: 'Session not found',
              code: 'SESSION_NOT_FOUND',
            })
          );
          break;
        }

        if (currentSessionId && currentSessionId !== msg.sessionId) {
          detachSocket(currentSessionId, chan);
        }

        currentSessionId = msg.sessionId;
        attachSocket(msg.sessionId, chan);

        chan.send(
          JSON.stringify({
            type: 'session',
            sessionId: msg.sessionId,
            cwd: session.cwd,
            cols: session.cols,
            rows: session.rows,
            isReconnect: true,
            isMetaAgent: !!session.isMetaAgent,
          })
        );

        for (const chunk of session.outputBuffer) {
          if (chan.readyState === 1) {
            chan.send(JSON.stringify({ type: 'replay', data: chunk }));
          }
        }

        if (session.exited) {
          chan.send(
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
          chan.send(JSON.stringify({
            type: 'auto_yes_state',
            enabled: session.autoYes,
            log: session.autoYesLog,
          }));
        }

        // Send scheduled-prompt state on attach (available for all sessions)
        chan.send(scheduleStateMsg(scheduledPromptPublic(session)));
        break;
      }

      case 'input': {
        if (currentSessionId) {
          writeToSession(currentSessionId, msg.data);
        }
        break;
      }

      case 'ping': {
        chan.send(JSON.stringify({ type: 'pong' }));
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
            chan.send(JSON.stringify({
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
            chan.send(JSON.stringify({
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
          chan.send(scheduleStateMsg(
            scheduled,
            scheduled ? undefined : 'Invalid schedule (time must be HH:MM in the future within 48h, with non-empty text)'
          ));
        }
        break;
      }

      case 'cancel_schedule': {
        if (currentSessionId) {
          cancelScheduledPrompt(currentSessionId);
          chan.send(scheduleStateMsg(null));
        }
        break;
      }

      case 'get_schedule': {
        if (currentSessionId) {
          const session = getSession(currentSessionId);
          if (session) {
            chan.send(scheduleStateMsg(scheduledPromptPublic(session)));
          }
        }
        break;
      }
    }
  }

  // Only the real WS route (below) ever calls this: a message that failed
  // JSON.parse is treated as raw pty input for whatever session is currently
  // attached. The federation terminal relay (federationServer.js) never
  // produces non-JSON lines -- every frame it forwards was itself JSON on the
  // wire -- so this path is unreachable from there.
  function handleRaw(rawString) {
    if (currentSessionId) {
      const session = getSession(currentSessionId);
      if (session?.ptyProcess && !session.exited) {
        session.ptyProcess.write(rawString);
      }
    }
  }

  function handleClose() {
    if (currentSessionId) {
      detachSocket(currentSessionId, chan);
      currentSessionId = null;
    }
  }

  return { handleMessage, handleRaw, handleClose, getCurrentSessionId: () => currentSessionId };
}

export async function terminalWs(fastify, opts) {
  fastify.get('/ws/terminal', { websocket: true }, (socket, req) => {
    const handler = attachTerminalHandler(socket);

    socket.on('message', async (rawMessage) => {
      let msg;
      try {
        msg = JSON.parse(rawMessage.toString());
      } catch {
        handler.handleRaw(rawMessage.toString());
        return;
      }

      try {
        await handler.handleMessage(msg);
      } catch (err) {
        fastify.log.error({ err }, 'terminal message handler error');
        try {
          socket.send(JSON.stringify({ type: 'error', message: String(err?.message || err), code: 'INTERNAL_ERROR' }));
        } catch { /* socket may be gone */ }
      }
    });

    socket.on('close', () => handler.handleClose());

    socket.on('error', (err) => {
      fastify.log.error('WebSocket error:', err);
      handler.handleClose();
    });
  });
}
