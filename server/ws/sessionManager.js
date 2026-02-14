import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';

const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const SESSION_EXITED_TIMEOUT_MS = 30 * 1000;
const OUTPUT_BUFFER_MAX_BYTES = 512 * 1024;

const sessions = new Map();

export function createSession({ cwd, cols, rows }) {
  const id = randomUUID();

  const { SSH_AUTH_SOCK, SSH_AGENT_PID, ...cleanEnv } = process.env;

  const ptyProcess = pty.spawn('/usr/bin/claude', [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...cleanEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '1',
    },
  });

  const session = {
    id,
    cwd,
    ptyProcess,
    socket: null,
    outputBuffer: [],
    bufferSize: 0,
    cols,
    rows,
    exited: false,
    exitCode: null,
    exitSignal: null,
    timeoutTimer: null,
  };

  ptyProcess.onData((data) => {
    appendToBuffer(session, data);

    if (session.socket && session.socket.readyState === 1) {
      session.socket.send(JSON.stringify({ type: 'output', data }));
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    session.exited = true;
    session.exitCode = exitCode;
    session.exitSignal = signal;

    if (session.socket && session.socket.readyState === 1) {
      session.socket.send(JSON.stringify({ type: 'exit', exitCode, signal }));
    }

    if (!session.socket) {
      startTimeout(session, SESSION_EXITED_TIMEOUT_MS);
    }
  });

  sessions.set(id, session);
  return { sessionId: id, session };
}

export function getSession(id) {
  return sessions.get(id);
}

export function listSessions() {
  const result = [];
  for (const [id, session] of sessions) {
    result.push({
      id,
      cwd: session.cwd,
      exited: session.exited,
      exitCode: session.exitCode,
      connected: session.socket !== null,
    });
  }
  return result;
}

export function attachSocket(id, socket) {
  const session = sessions.get(id);
  if (!session) return false;

  if (session.timeoutTimer) {
    clearTimeout(session.timeoutTimer);
    session.timeoutTimer = null;
  }

  if (session.socket && session.socket !== socket) {
    try {
      session.socket.send(
        JSON.stringify({ type: 'detached', reason: 'replaced' })
      );
      session.socket.close(4001, 'Replaced by new client');
    } catch {
      // old socket may already be closed
    }
  }

  session.socket = socket;
  return true;
}

export function detachSocket(id, socketToDetach) {
  const session = sessions.get(id);
  if (!session) return;

  if (socketToDetach && session.socket !== socketToDetach) return;

  session.socket = null;

  const timeout = session.exited
    ? SESSION_EXITED_TIMEOUT_MS
    : SESSION_TIMEOUT_MS;
  startTimeout(session, timeout);
}

export function destroySession(id) {
  const session = sessions.get(id);
  if (!session) return;

  if (session.timeoutTimer) {
    clearTimeout(session.timeoutTimer);
    session.timeoutTimer = null;
  }

  if (!session.exited) {
    try {
      session.ptyProcess.kill();
    } catch {
      // already dead
    }
  }

  sessions.delete(id);
}

export function destroyAllSessions() {
  for (const [id] of sessions) {
    destroySession(id);
  }
}

function appendToBuffer(session, data) {
  session.outputBuffer.push(data);
  session.bufferSize += data.length;

  while (session.bufferSize > OUTPUT_BUFFER_MAX_BYTES && session.outputBuffer.length > 0) {
    const removed = session.outputBuffer.shift();
    session.bufferSize -= removed.length;
  }
}

function startTimeout(session, ms) {
  if (session.timeoutTimer) {
    clearTimeout(session.timeoutTimer);
  }

  session.timeoutTimer = setTimeout(() => {
    destroySession(session.id);
  }, ms);
}
