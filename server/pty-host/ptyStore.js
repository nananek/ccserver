// The pty-host session store (plan5 sections 0-2): holds exactly the state
// that must survive a server-本体 restart -- the OS pty process, its raw
// output backlog, its cols/rows, and its exited/exitCode/exitSignal -- plus
// (2.1) the sandbox construction that used to happen in
// server/ws/sessionManager.js's createSession(), and (2.2) the viewer-count
// driven idle/exited destroy timers that used to live there too.
//
// Everything else that createSession() does today -- AutoYes detection,
// screenModel, session-limit detection, scheduled-prompt injection, MCP
// config/env assembly, app/model/permission-mode resolution -- is
// deliberately NOT here. Those are derived/replayable from the raw byte
// stream and stay server-side (see plan5 section 0); this store only ever
// sees an already-fully-resolved command/args/env to spawn, and a
// caller-decided cols/rows to apply (the multi-viewer size *negotiation*
// algorithm also stays server-side -- this store just applies whatever single
// size it's told).
//
// No import from sessionManager.js, deliberately: this is the module meant to
// eventually replace it, not extend it.

import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { buildSandboxSpawn } from '../ws/sandbox.js';
import { resolveSessionTimeoutMs, resolveExitedTimeoutMs } from './timeouts.js';

const OUTPUT_BUFFER_MAX_BYTES = 512 * 1024;
const TERM_NAME = 'xterm-256color';

function clampSize(n, fallback) {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export class PtyStore {
  // onEvent(connId, frameObj): deliver one push event (a `data`/`exit`/
  // `destroyed` event object) to the connection identified by connId. The
  // store only knows connIds (opaque subscriber tokens); translating one to
  // an actual socket is rpcServer.js's job, keeping this class socket-free
  // and directly unit-testable.
  constructor({
    onEvent = () => {},
    gitBrokerRegistry = null,
    sessionTimeoutMs = resolveSessionTimeoutMs(),
    exitedTimeoutMs = resolveExitedTimeoutMs(),
    outputBufferMaxBytes = OUTPUT_BUFFER_MAX_BYTES,
  } = {}) {
    this._sessions = new Map();
    this._onEvent = onEvent;
    this._gitBrokerRegistry = gitBrokerRegistry;
    this._sessionTimeoutMs = sessionTimeoutMs;
    this._exitedTimeoutMs = exitedTimeoutMs;
    this._outputBufferMaxBytes = outputBufferMaxBytes;
  }

  size() {
    return this._sessions.size;
  }

  // rpcServer.js calls this once it can translate a connId to a live socket
  // (connIds are minted per-connection, so this can only be wired after the
  // server has started accepting). Overridable at any time; defaults to the
  // no-op passed to the constructor, which is enough for tests that only
  // care about PtyStore's own state transitions.
  setEventSink(fn) {
    this._onEvent = fn;
  }

  spawn({
    id = null,
    cwd,
    cols,
    rows,
    command,
    args = [],
    env = {},
    sandbox = false,
    sandboxOpts = null,
    app = null,
    mcpSocketPath = null,
    notifySocketPath = null,
    usageSocketPath = null,
    metaSocketPath = null,
    reviewerSocketPath = null,
    reuseSandboxHome = true,
    orchestratorClaudeMdSrc = null,
    gitCommonDir = null,
    groupFilesDir = null,
    sandboxHomeCreatedBy = null,
  }) {
    if (typeof cwd !== 'string' || !cwd) throw new Error('spawn: "cwd" must be a non-empty string');
    if (typeof command !== 'string' || !command) throw new Error('spawn: "command" must be a non-empty string');
    if (sandbox && !app) throw new Error('spawn: "app" is required when sandbox is true');

    let sessionId = id;
    if (sessionId != null) {
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('spawn: "id" must be a non-empty string');
      if (this._sessions.has(sessionId)) throw new Error(`spawn: session "${sessionId}" already exists`);
    } else {
      sessionId = randomUUID();
    }

    const wantCols = clampSize(cols, 80);
    const wantRows = clampSize(rows, 24);

    let finalCommand = command;
    let finalArgs = args;
    let docker = false;
    let stateDir = null;
    let gitBrokerProc = null;
    let gitBrokerDir = null;
    let commitGuardDir = null;
    if (sandbox) {
      let built;
      try {
        built = buildSandboxSpawn({
          cwd, targetCommand: [command, ...args], app, sandboxOpts,
          mcpSocketPath, notifySocketPath, usageSocketPath, metaSocketPath, reviewerSocketPath,
          reuseSandboxHome, orchestratorClaudeMdSrc, gitCommonDir, groupFilesDir, sandboxHomeCreatedBy,
        });
      } catch (err) {
        throw new Error(`Failed to build sandbox: ${err.message}`);
      }
      finalCommand = built.command;
      finalArgs = built.args;
      docker = !!built.docker;
      stateDir = built.stateDir || null;
      gitBrokerProc = built.gitBrokerProc || null;
      gitBrokerDir = built.gitBrokerDir || null;
      // Commit-message guard's runtime dir (sandbox.js's startCommitGuard,
      // plan8): just a JSON config file bind-mounted into the sandbox, no
      // process -- same "remove this dir on teardown" treatment as
      // gitBrokerDir, minus the kill.
      commitGuardDir = built.commitGuardDir || null;
    }

    let ptyProcess;
    try {
      ptyProcess = pty.spawn(finalCommand, finalArgs, {
        name: TERM_NAME,
        cols: wantCols,
        rows: wantRows,
        cwd,
        env,
      });
    } catch (err) {
      // The sandbox (if any) was already built by this point -- unlike
      // sessionManager.js's createSession() (which leaks stateDir/
      // gitBrokerProc/gitBrokerDir on this exact failure path today), clean
      // up what buildSandboxSpawn already created before reporting the error.
      if (stateDir) { try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ } }
      if (gitBrokerProc) { try { gitBrokerProc.kill('SIGTERM'); } catch { /* already dead */ } }
      if (gitBrokerDir) { try { rmSync(gitBrokerDir, { recursive: true, force: true }); } catch { /* best effort */ } }
      if (commitGuardDir) { try { rmSync(commitGuardDir, { recursive: true, force: true }); } catch { /* best effort */ } }
      throw new Error(`Failed to spawn "${finalCommand}": ${err.message}`);
    }

    const entry = {
      id: sessionId,
      cwd,
      cols: wantCols,
      rows: wantRows,
      pid: ptyProcess.pid,
      ptyProcess,
      exited: false,
      exitCode: null,
      exitSignal: null,
      outputBuffer: [], // [{seq, data}], oldest first
      bufferBytes: 0,
      nextSeq: 1,
      subscribers: new Set(), // opaque connIds (see class doc above)
      timeoutTimer: null,
      createdAt: Date.now(),
      sandbox: { active: sandbox, docker, stateDir, gitBrokerProc, gitBrokerDir, commitGuardDir },
    };

    ptyProcess.onData((data) => this._handleData(entry, data));
    ptyProcess.onExit(({ exitCode, signal }) => this._handleExit(entry, exitCode, signal ?? null));

    this._sessions.set(sessionId, entry);
    if (gitBrokerProc && this._gitBrokerRegistry) {
      this._gitBrokerRegistry.record(sessionId, { pid: gitBrokerProc.pid, dir: gitBrokerDir });
    }

    return {
      id: sessionId,
      pid: entry.pid,
      cols: entry.cols,
      rows: entry.rows,
      sandbox: { active: sandbox, docker, stateDir },
    };
  }

  _oldestSeq(entry) {
    return entry.outputBuffer.length ? entry.outputBuffer[0].seq : entry.nextSeq;
  }

  _handleData(entry, data) {
    const seq = entry.nextSeq++;
    entry.outputBuffer.push({ seq, data });
    // .length is UTF-16 code units, not bytes -- multi-byte output (CJK text,
    // emoji) would otherwise undercount against outputBufferMaxBytes.
    entry.bufferBytes += Buffer.byteLength(data, 'utf8');
    while (entry.bufferBytes > this._outputBufferMaxBytes && entry.outputBuffer.length > 0) {
      const removed = entry.outputBuffer.shift();
      entry.bufferBytes -= Buffer.byteLength(removed.data, 'utf8');
    }
    this._emit(entry, { type: 'event', event: 'data', id: entry.id, seq, data });
  }

  _handleExit(entry, exitCode, exitSignal) {
    entry.exited = true;
    entry.exitCode = exitCode;
    entry.exitSignal = exitSignal;
    this._emit(entry, { type: 'event', event: 'exit', id: entry.id, exitCode, exitSignal });
    // node-pty's onExit fires asynchronously -- kill()+destroy() (see
    // destroy() below) already return before the OS actually reports the
    // child's death, so a destroy() of a still-running session routinely
    // finishes (removing the entry from _sessions) before this callback
    // runs. Arming a fresh timer on that now-detached entry would leak a
    // live setTimeout the destroyed session's id can never reach again to
    // clear -- the identity check (not just an id lookup, which an id reused
    // by a brand new session would also pass) guards against exactly that.
    if (this._sessions.get(entry.id) === entry && entry.subscribers.size === 0) {
      this._armTimeout(entry);
    }
  }

  _emit(entry, frameObj) {
    for (const connId of entry.subscribers) this._onEvent(connId, frameObj);
  }

  _armTimeout(entry) {
    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = null;
    }
    const ms = entry.exited ? this._exitedTimeoutMs : this._sessionTimeoutMs;
    if (!(ms > 0)) return; // 0/negative: operator disabled this timeout tier
    entry.timeoutTimer = setTimeout(() => this.destroy(entry.id), ms);
  }

  write(id, data) {
    const entry = this._sessions.get(id);
    if (!entry || entry.exited) return false;
    try {
      entry.ptyProcess.write(data);
      return true;
    } catch {
      return false;
    }
  }

  // Applies ONE authoritative size (already negotiated by the caller across
  // its viewers, if it has more than one) -- see class doc.
  resize(id, cols, rows) {
    const entry = this._sessions.get(id);
    if (!entry) return null;
    const c = clampSize(cols, entry.cols);
    const r = clampSize(rows, entry.rows);
    if (!entry.exited) {
      try {
        entry.ptyProcess.resize(c, r);
      } catch {
        return { cols: entry.cols, rows: entry.rows };
      }
    }
    entry.cols = c;
    entry.rows = r;
    return { cols: c, rows: r };
  }

  // Signal the OS process only -- the session record (and its buffered
  // output/exit code) stays around until destroy() or the exited-timeout
  // reaps it. Distinct from destroy() so a caller can watch a session's final
  // output/exit code before tearing down its bookkeeping.
  kill(id, signal) {
    const entry = this._sessions.get(id);
    if (!entry || entry.exited) return false;
    try {
      entry.ptyProcess.kill(signal || undefined);
      return true;
    } catch {
      return false;
    }
  }

  // Full teardown: force-kill if still running, close the pty master fd,
  // remove sandbox artifacts, and drop the record. Mirrors
  // sessionManager.js's destroySession().
  destroy(id) {
    const entry = this._sessions.get(id);
    if (!entry) return false;

    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = null;
    }
    if (!entry.exited) {
      try { entry.ptyProcess.kill(); } catch { /* already dead */ }
    }
    // Force-close the pty master read stream: kill() alone only signals the
    // child, and a lingering grandchild holding the slave fd would otherwise
    // keep the master's read stream (and the event loop) alive forever.
    try { entry.ptyProcess.destroy(); } catch { /* already torn down */ }

    if (entry.sandbox.stateDir) {
      try { rmSync(entry.sandbox.stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    if (entry.sandbox.gitBrokerProc) {
      try { entry.sandbox.gitBrokerProc.kill('SIGTERM'); } catch { /* already dead */ }
    }
    if (entry.sandbox.gitBrokerDir) {
      try { rmSync(entry.sandbox.gitBrokerDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    if (entry.sandbox.commitGuardDir) {
      try { rmSync(entry.sandbox.commitGuardDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    this._gitBrokerRegistry?.forget(id);

    this._emit(entry, { type: 'event', event: 'destroyed', id });
    this._sessions.delete(id);
    return true;
  }

  list() {
    return [...this._sessions.values()].map((e) => ({
      id: e.id,
      cwd: e.cwd,
      cols: e.cols,
      rows: e.rows,
      pid: e.pid,
      exited: e.exited,
      exitCode: e.exitCode,
      exitSignal: e.exitSignal,
      createdAt: e.createdAt,
      viewers: e.subscribers.size,
      sandbox: { active: e.sandbox.active, docker: e.sandbox.docker },
    }));
  }

  // Registers connId as a viewer of `id` and replays buffered output newer
  // than sinceSeq (all of it, if sinceSeq is omitted). `truncated` is set
  // when sinceSeq points before the oldest chunk still retained -- the
  // 512KiB ring already dropped some bytes the caller hasn't seen yet.
  subscribe(id, connId, sinceSeq = null) {
    const entry = this._sessions.get(id);
    if (!entry) return null;
    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = null;
    }
    entry.subscribers.add(connId);

    const oldest = this._oldestSeq(entry);
    const truncated = typeof sinceSeq === 'number' && sinceSeq + 1 < oldest;
    const backlog = (typeof sinceSeq === 'number')
      ? entry.outputBuffer.filter((c) => c.seq > sinceSeq).map((c) => ({ seq: c.seq, data: c.data }))
      : entry.outputBuffer.map((c) => ({ seq: c.seq, data: c.data }));

    return {
      id,
      cols: entry.cols,
      rows: entry.rows,
      exited: entry.exited,
      exitCode: entry.exitCode,
      exitSignal: entry.exitSignal,
      backlog,
      lastSeq: entry.nextSeq - 1,
      truncated,
    };
  }

  unsubscribe(id, connId) {
    const entry = this._sessions.get(id);
    if (!entry || !entry.subscribers.delete(connId)) return false;
    if (entry.subscribers.size === 0) this._armTimeout(entry);
    return true;
  }

  // Called when a server本体 connection drops (crash, restart, network
  // blip) -- treated as an implicit unsubscribe from every session it held,
  // NEVER as a destroy: plan5's passive-teardown guarantee is that losing the
  // UDS connection alone must never discard a live pty.
  handleConnectionClose(connId) {
    for (const entry of this._sessions.values()) {
      if (entry.subscribers.delete(connId) && entry.subscribers.size === 0) {
        this._armTimeout(entry);
      }
    }
  }
}
