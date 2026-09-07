// Server本体 -> pty-host adapter (plan5 section 5.2): a UDS RPC/event client
// whose RemotePty proxy has the exact same shape as node-pty's IPty
// (onData/onExit/write/resize/kill/destroy), so sessionManager.js's
// createSession()/destroySession()/writeToSession() etc. work unmodified
// against either a real pty or one hosted by server/pty-host.
//
// Deliberately lazy: getPtyHostClient() below never opens the UDS socket
// until first called. When CCSERVER_PTY_HOST is unset, nothing in this file
// ever runs -- sessionManager.js's usePtyHost branches simply never call it.
//
// Talks the actual wire shape server/pty-host/rpcServer.js implements, which
// differs from plan5 5.2.1's original sketch in three ways (see plan5's
// "Step2 revision" note for the reconciliation): sessions are addressed by
// `id`, not `sessionId`; push events arrive as `{ type: 'event', event:
// 'data'|'exit'|'destroyed', id, ... }` rather than a bare top-level type;
// and `destroyed` carries no `reason` field.
//
// Plan5 Step5 (partitioning): this file also owns routing sessions across
// multiple pty-host instances ("shards"), so pty-host itself stays
// completely unaware of partitioning (see getPtyHostSockPath() in
// server/pty-host/index.js). See shardKeyForSession()/shardIndexForKey()/
// getPtyHostClient(shardIndex)/getAllPtyHostClients() below.

import { createConnection } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { encodeFrame, FrameDecoder } from '../pty-host/protocol.js';
import { getPtyHostSockPath } from '../pty-host/index.js';
import { projectHashForCwd } from './projectHash.js';

const RPC_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 5000;
const RECONNECT_BASE_MS = 100;
const RECONNECT_MAX_MS = 5000;
// Cap on buffered fire-and-forget frames (write/resize/kill/destroy) while
// disconnected -- a human types slowly, so a multi-second reconnect gap never
// comes close to this; it only guards against an unbounded leak if pty-host
// stays unreachable indefinitely (plan5 5.2.4).
const WRITE_QUEUE_MAX_FRAMES = 1000;

// Proxy for one pty-host-hosted session, matching node-pty's IPty surface
// (see plan5 5.2.2). All mutation methods are fire-and-forget: pty-host is
// the authoritative state owner, so nothing here needs to wait for an ack
// any more than the direct node-pty calls it replaces did.
export class RemotePty {
  constructor(client, sessionId, { cols, rows, pid, sandbox } = {}) {
    this._client = client;
    this.sessionId = sessionId;
    this.cols = cols;
    this.rows = rows;
    this.pid = pid;
    // { active, docker, stateDir } from pty-host's spawn response -- lets
    // sessionManager.js populate session.docker/session.sandboxStateDir the
    // same way the direct-spawn path does (dockerAvailability() etc. stay
    // unmodified either way).
    this.sandboxInfo = sandbox || null;
    this._dataListeners = new Set();
    this._exitListeners = new Set();
    this._lastSeq = 0;
    this._subscribed = false;
  }

  onData(cb) {
    this._dataListeners.add(cb);
    return { dispose: () => this._dataListeners.delete(cb) };
  }

  onExit(cb) {
    this._exitListeners.add(cb);
    return { dispose: () => this._exitListeners.delete(cb) };
  }

  write(data) {
    this._client._sendFireAndForget({ type: 'write', id: this.sessionId, data });
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this._client._sendFireAndForget({ type: 'resize', id: this.sessionId, cols, rows });
  }

  kill(signal) {
    this._client._sendFireAndForget({ type: 'kill', id: this.sessionId, signal });
  }

  // Matches node-pty's non-typings-but-actually-used destroy() (see
  // sessionManager.js's destroySession): force-closes the pty master fd.
  // pty-host's `destroy` RPC handler does the kill()-if-still-running +
  // destroy() + sandbox teardown in one step (server/pty-host/ptyStore.js),
  // so this single call is enough even though destroySession() also calls
  // kill() first -- pty-host's handler is idempotent about that.
  destroy() {
    this._client._sendFireAndForget({ type: 'destroy', id: this.sessionId });
    this._client._forgetSession(this.sessionId);
  }

  // Deliver one data chunk -- a live `data` push event, or one entry from a
  // subscribe() replay backlog -- to every registered onData listener,
  // tracking the highest seq seen so a reconnect can resume with sinceSeq
  // instead of re-fetching the whole buffer.
  _deliverData(seq, data) {
    if (typeof seq === 'number') this._lastSeq = seq;
    for (const cb of this._dataListeners) cb(data);
  }

  _deliverExit(exitCode, exitSignal) {
    for (const cb of this._exitListeners) cb({ exitCode, signal: exitSignal });
  }
}

export class PtyHostClient {
  constructor(sockPath = getPtyHostSockPath()) {
    this._sockPath = sockPath;
    this._socket = null;
    this._pending = new Map(); // reqId -> { resolve, reject, timer }
    this._remotePtys = new Map(); // sessionId -> RemotePty
    this._writeQueue = []; // fire-and-forget frames buffered while disconnected
    this._connectPromise = null;
    this._reconnectDelay = RECONNECT_BASE_MS;
    this._reconnectTimer = null;
    this._destroyedListeners = new Set();
    this._disconnectedListeners = new Set();
    this._closed = false;
  }

  // Subscribes to pty-host's `destroyed` push events (session id, reason).
  // See sessionManager.js's initPtyHostDestroyedHandler -- the only path that
  // cleans up server本体's local sessions Map when pty-host tears a session
  // down on its own (idle/exited timeout, or as a crash-recovery backstop).
  onDestroyed(cb) {
    this._destroyedListeners.add(cb);
    return () => this._destroyedListeners.delete(cb);
  }

  // Issue #143 problem 2: fired when this client's UDS connection dies
  // because pty-host's own PROCESS died (never for this client's own
  // close(), see the 'close' handler below -- that is a controlled shutdown,
  // not a loss). Called once per disconnect with the array of every
  // sessionId this client still held a RemotePty for at that moment -- UDS
  // has no notion of a transient network blip, so a `close` here can only
  // mean the remote process (and every pty it owned, per Step0's PoC
  // finding) is actually gone. See sessionManager.js's
  // initPtyHostDisconnectedHandler, the pair to initPtyHostDestroyedHandler
  // above but for "the whole shard vanished" rather than "one session was
  // torn down".
  onDisconnected(cb) {
    this._disconnectedListeners.add(cb);
    return () => this._disconnectedListeners.delete(cb);
  }

  _forgetSession(sessionId) {
    this._remotePtys.delete(sessionId);
  }

  _connect() {
    if (this._closed) return Promise.reject(new Error('PtyHostClient has been closed'));
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = new Promise((resolve, reject) => {
      const socket = createConnection(this._sockPath);
      const decoder = new FrameDecoder();
      let settled = false;

      socket.once('connect', () => {
        settled = true;
        this._socket = socket;
        this._reconnectDelay = RECONNECT_BASE_MS;
        this._flushQueue();
        this._resubscribeAll();
        resolve();
      });
      socket.once('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        // A post-connect error is always followed by 'close', handled below.
      });
      socket.on('data', (chunk) => {
        let frames;
        try {
          frames = decoder.push(chunk);
        } catch (err) {
          console.error(`[ptyHostClient] framing error: ${err.message}`);
          socket.destroy();
          return;
        }
        for (const frame of frames) this._onMessage(frame);
      });
      socket.on('close', () => {
        this._socket = null;
        this._connectPromise = null;
        this._rejectAllPending(new Error('pty-host connection closed'));
        // this._closed means close() was called deliberately (gracefulShutdown,
        // test teardown) -- every session survives that (pty-host itself is
        // still alive), so onDisconnected must stay silent and _remotePtys
        // must stay intact for the same reason resetPtyHostClientForTests'
        // reconnect is skipped below. Only an UNREQUESTED close (pty-host's
        // process actually died) means the sessions are really gone.
        if (!this._closed) {
          const sessionIds = [...this._remotePtys.keys()];
          this._remotePtys.clear();
          for (const cb of this._disconnectedListeners) {
            try {
              cb(sessionIds);
            } catch {
              // a listener must never break dispatch to the others
            }
          }
          this._scheduleReconnect();
        }
      });
    });

    return this._connectPromise;
  }

  _rejectAllPending(err) {
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this._pending.clear();
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || this._closed) return;
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect().catch(() => {
        // _connect's own 'close'/'error' handling re-schedules the next try.
      });
    }, delay);
    this._reconnectTimer.unref?.();
  }

  async _ensureConnected(timeoutMs = CONNECT_TIMEOUT_MS) {
    if (this._socket) return;
    let timer;
    try {
      await Promise.race([
        this._connect(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`pty-host unreachable (no connection within ${timeoutMs}ms)`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Timers here are unref'd: a pending RPC (or a live reconnect backoff)
  // must never be the reason a process can't exit -- callers that actually
  // care about the outcome are already awaiting the returned promise.
  _request(type, params = {}, { timeoutMs = RPC_TIMEOUT_MS } = {}) {
    const reqId = randomUUID();
    return new Promise((resolve, reject) => {
      if (!this._socket) {
        reject(new Error(`pty-host RPC "${type}": not connected`));
        return;
      }
      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        reject(new Error(`pty-host RPC "${type}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this._pending.set(reqId, { resolve, reject, timer });
      this._writeFrame({ reqId, type, ...params });
    });
  }

  _writeFrame(frame) {
    try {
      this._socket.write(encodeFrame(frame));
    } catch (err) {
      console.warn(`[ptyHostClient] write failed: ${err.message}`);
    }
  }

  // Fire-and-forget send for write/resize/kill/destroy: no reqId, no response
  // wait. Queues locally while disconnected and kicks off a background
  // (re)connect attempt -- never an implicit fallback to a different spawn
  // mode (plan5 5.2.4), just a best-effort delivery once the link is back.
  _sendFireAndForget(frame) {
    if (this._socket) {
      this._writeFrame(frame);
    } else {
      this._enqueue(frame);
      this._connect().catch(() => {});
    }
  }

  _enqueue(frame) {
    this._writeQueue.push(frame);
    if (this._writeQueue.length > WRITE_QUEUE_MAX_FRAMES) this._writeQueue.shift();
  }

  _flushQueue() {
    const queued = this._writeQueue;
    this._writeQueue = [];
    for (const frame of queued) this._writeFrame(frame);
  }

  // On every (re)connect, re-subscribe every session still held here,
  // resuming from the last seq actually seen so a reconnect never re-fetches
  // (or loses) output (plan5 5.2.4).
  _resubscribeAll() {
    for (const rpty of this._remotePtys.values()) {
      if (!rpty._subscribed) continue;
      this._request('subscribe', { id: rpty.sessionId, sinceSeq: rpty._lastSeq })
        .then((res) => this._applySubscribeResult(rpty, res))
        .catch((err) => {
          console.warn(`[ptyHostClient] resubscribe failed for session ${rpty.sessionId}: ${err.message}`);
        });
    }
  }

  _applySubscribeResult(rpty, res) {
    for (const chunk of res.backlog || []) {
      rpty._deliverData(chunk.seq, chunk.data);
    }
    if (typeof res.lastSeq === 'number') rpty._lastSeq = res.lastSeq;
  }

  _onMessage(frame) {
    if (frame.reqId) {
      const pending = this._pending.get(frame.reqId);
      if (!pending) return; // response to a request we've already timed out / given up on
      this._pending.delete(frame.reqId);
      clearTimeout(pending.timer);
      if (frame.ok) pending.resolve(frame);
      else pending.reject(new Error(frame.error || 'pty-host RPC failed'));
      return;
    }
    if (frame.type !== 'event') return;
    const rpty = this._remotePtys.get(frame.id);
    if (frame.event === 'data') {
      if (rpty) rpty._deliverData(frame.seq, frame.data);
    } else if (frame.event === 'exit') {
      if (rpty) rpty._deliverExit(frame.exitCode, frame.exitSignal);
    } else if (frame.event === 'destroyed') {
      this._remotePtys.delete(frame.id);
      for (const cb of this._destroyedListeners) {
        try {
          cb(frame.id, frame.reason ?? null);
        } catch {
          // a listener must never break dispatch to the others
        }
      }
    }
  }

  // Spawns a new pty-hosted session. Rejects with a message that stays
  // compatible with sessionManager.js's INFRA_ERROR_PREFIXES ("Failed to
  // build sandbox" / "Failed to spawn") -- pty-host's own spawn()/
  // buildSandboxSpawn() failures already carry those prefixes verbatim (see
  // server/pty-host/ptyStore.js), so only the unreachable case mints a new
  // message here (plan5 5.2.4).
  async spawn(params) {
    try {
      await this._ensureConnected();
    } catch (err) {
      throw new Error(`Failed to spawn "${params.command}": pty-host unreachable (${err.message})`);
    }
    const res = await this._request('spawn', params);
    const rpty = new RemotePty(this, res.id, { cols: res.cols, rows: res.rows, pid: res.pid, sandbox: res.sandbox });
    this._remotePtys.set(res.id, rpty);
    return rpty;
  }

  async list() {
    await this._ensureConnected();
    const res = await this._request('list');
    return res.sessions;
  }

  // Reattaches to a session pty-host already has (plan5 Step3): unlike
  // spawn(), issues no RPC of its own -- the session already exists on
  // pty-host's side (found via a prior list()), so this only needs to build
  // the local RemotePty proxy and register it for push-event dispatch. The
  // caller is expected to follow up with subscribe() to receive the buffered
  // backlog (and any live output going forward) exactly as the post-spawn()
  // path does.
  async attach(sessionId, { cols, rows, pid, sandbox } = {}) {
    await this._ensureConnected();
    const rpty = new RemotePty(this, sessionId, { cols, rows, pid, sandbox });
    this._remotePtys.set(sessionId, rpty);
    return rpty;
  }

  // Subscribes (or re-subscribes) to a session's output, applying any replay
  // backlog immediately. Server本体 calls this once right after spawn() and
  // never unsubscribes for the session's whole lifetime -- see
  // sessionManager.js's createSession(): AutoYes / session-limit detection /
  // outputBuffer accumulation must keep running even with zero browser
  // viewers attached, so pty-host's per-connection subscriber count can't be
  // tied to session.sockets.size the way plan5 5.2.3 originally sketched.
  async subscribe(rpty, sinceSeq = null) {
    await this._ensureConnected();
    rpty._subscribed = true;
    const res = await this._request('subscribe', { id: rpty.sessionId, sinceSeq });
    this._applySubscribeResult(rpty, res);
    return res;
  }

  // Graceful by design: a caller that just fire-and-forgot a `destroy` (e.g.
  // destroySession() tearing down its RemotePty) may call close() on the
  // very next line, before that write has actually reached the OS socket
  // buffer. socket.destroy() would drop it there, leaving a session
  // orphaned on pty-host's side; socket.end() flushes pending writes before
  // closing, so the last fire-and-forget frame this client sent is never
  // lost to its own shutdown.
  close() {
    this._closed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._rejectAllPending(new Error('PtyHostClient closed'));
    if (this._socket) {
      try { this._socket.end(); } catch { /* already gone */ }
      this._socket = null;
    }
  }
}

// shardIndex -> PtyHostClient. A plain Map (not a single `singleton`)
// since plan5 Step5: with CCSERVER_PTY_HOST_SHARDS unset (the default), only
// index 0 is ever populated, so this is a strict superset of the old
// single-client behavior -- every pre-Step5 call site that never thought
// about shards keeps hitting the exact same client it always did.
const clients = new Map();

// Reads CCSERVER_PTY_HOST_SHARDS once per call (cheap, and lets tests flip it
// between runs without a module reload). Unset/non-positive/non-integer all
// mean "no partitioning" -- 1 shard, matching every deployment that predates
// Step5.
export function shardCount() {
  const raw = process.env.CCSERVER_PTY_HOST_SHARDS;
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

// Picks the key a session's shard is derived from (plan5 Step5): groupId
// wins when present, so every member of a group -- one collaborative unit --
// lands in the same shard and shares a single instance's fate. A
// groupId-less standalone session falls back to its project identity via the
// shared projectHashForCwd() (server/ws/projectHash.js) instead of hashing
// the raw resolved path again here -- reusing it keeps "which project is
// this" answered exactly one way across the codebase (see that file's header
// comment), not forked into a second hash domain just for sharding.
export function shardKeyForSession({ groupId, cwd }) {
  return groupId ? `group:${groupId}` : `cwd:${projectHashForCwd(cwd)}`;
}

// Deterministic key -> shard index. Plain mod-hash, NOT consistent hashing:
// changing shard count reshuffles every key's assignment. That's fine only
// because callers decide a session's shardIndex exactly once, at creation
// (sessionManager.js's createSession()), and persist it (session record +
// ptyHostSessionMeta.json) rather than ever recomputing it on restore -- see
// this file's header and restorePtyHostSessions() in sessionManager.js.
export function shardIndexForKey(key, count = shardCount()) {
  if (count <= 1) return 0;
  const digest = createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % count;
}

// Lazily creates the shard's client -- never opens the UDS socket until
// first called. When CCSERVER_PTY_HOST is unset, sessionManager.js's
// usePtyHost branches never call this, so this module has zero runtime
// effect (plan5 5.2.5). Defaulting shardIndex to 0 keeps every pre-Step5
// call site (which never passes an argument) pointed at the same single
// client it always got.
export function getPtyHostClient(shardIndex = 0) {
  let client = clients.get(shardIndex);
  if (!client) {
    client = new PtyHostClient(getPtyHostSockPath(shardIndex));
    clients.set(shardIndex, client);
  }
  return client;
}

// Every currently-configured shard's client, indexed 0..shardCount()-1 (also
// lazily creating any not yet touched by getPtyHostClient()). For the
// handful of call sites that must reach every instance regardless of
// per-session routing: initPtyHostDestroyedHandler(), restorePtyHostSessions(),
// gracefulShutdown() (all in sessionManager.js).
export function getAllPtyHostClients() {
  const count = shardCount();
  const result = [];
  for (let i = 0; i < count; i++) result.push(getPtyHostClient(i));
  return result;
}

export function isPtyHostEnabled() {
  return process.env.CCSERVER_PTY_HOST === '1';
}

// Test seam: drop every shard's client so the next getPtyHostClient() call
// builds a fresh one (e.g. against a different sockPath, or after a previous
// test's in-process pty-host was torn down).
export function resetPtyHostClientForTests() {
  for (const client of clients.values()) client.close();
  clients.clear();
}
