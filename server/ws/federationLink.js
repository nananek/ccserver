// Persistent, multiplexed mTLS "link" between this instance and one paired
// peer (Issue #142 Step 1) -- replaces the one-shot connections described in
// federationProtocol.js's (superseded) header comment. See that file for the
// wire-frame vocabulary this module speaks.
//
// One FederationLink instance == one pair (keyed by the peer's certificate
// fingerprint256, see the registry at the bottom). It owns:
//   - dialing out (with reconnect backoff) and/or accepting an inbound
//     socket for this peer, whichever direction turns out reachable;
//   - the link-hello handshake and the resulting duplicate-connection
//     resolution when both directions connect at once;
//   - RPC request/response correlation in BOTH directions (the protocol is
//     now symmetric -- either end may initiate an 'rpc' frame);
//   - terminal relay channel multiplexing (channelId -> handler);
//   - the periodic revocation recheck (same 30s-interval pattern
//     federationServer.js's terminal relay already used, now covering RPC
//     traffic too).
//
// Issue #142 Step 2: federationServer.js's inbound listener and
// federationClient.js's RPC/terminal calls now run through this module --
// oneShotRpc/callInstanceRpc(one-shot)/openTerminalChannel(one-shot) have
// been deleted per the plan's decision 4. The one surviving one-shot
// connection is the TOFU pairing.propose bootstrap dial (still in
// federationClient.js's initiatePairing / federationServer.js's own
// bootstrap handler for an unknown fingerprint) -- see adoptBootstrapSocket
// below for how that single connection is promoted straight into a
// FederationLink on both ends instead of being closed and re-dialed.
//
// Deliberately duplicates federationClient.js's tiny host:port parser and
// TLS-dial helper rather than importing them: federationClient.js will
// import FROM this module once Step 2 lands, and importing the other
// direction now would set up a cycle for no benefit before that happens.

import { connect as tlsConnect } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { ensureIdentity, peerCertInfo } from './federationIdentity.js';
import { LineFramer, FRAME_KINDS } from './federationProtocol.js';
import * as pairing from './federationPairing.js';
import { federationConfig } from './federationConfig.js';
import { resolvedHostname } from './notify.js';
import { attachTerminalHandler } from './terminal.js';
import { hostname as osHostname } from 'node:os';

const CONNECT_TIMEOUT_MS = 10_000;
const FEDERATION_KEEPALIVE_MS = 30_000;
const REVOKE_CHECK_INTERVAL_MS = 30_000;

// Reconnect backoff (plan decision 2): first retry after 2s, x1.5 each
// further attempt, capped at 10s. Resets to the initial value whenever a
// connection is actually established (see FederationLink._adopt) -- the
// backoff only grows across consecutive FAILED attempts, never while a link
// is healthy.
export const RECONNECT_INITIAL_MS = 2_000;
export const RECONNECT_FACTOR = 1.5;
export const RECONNECT_MAX_MS = 10_000;

export function nextReconnectDelayMs(previousDelayMs) {
  if (previousDelayMs == null) return RECONNECT_INITIAL_MS;
  return Math.min(RECONNECT_MAX_MS, previousDelayMs * RECONNECT_FACTOR);
}

// Duplicate-link resolution (plan decision 3): when both directions connect
// at once, the connection dialed by whichever instance has the
// lexicographically smaller fingerprint256 wins; the other is closed. Pure
// and symmetric -- either side reaches the same conclusion independently,
// no coordination round-trip needed. Returns whether the winning connection
// is the one where the CALLER (self) was the dialer.
export function winningDialerIsSelf(selfFingerprint, peerFingerprint) {
  return selfFingerprint < peerFingerprint;
}

function parseAddr(addr) {
  if (typeof addr !== 'string' || !addr.includes(':')) {
    throw new Error('address must be host:port');
  }
  const idx = addr.lastIndexOf(':');
  const host = addr.slice(0, idx);
  const port = Number(addr.slice(idx + 1));
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error('address must be host:port with a valid port number');
  }
  return { host, port };
}

function myHostnameLabel() {
  return resolvedHostname() || osHostname();
}

// ---- RPC method handlers (moved from federationServer.js) --------------
// Each returns a plain result object (never throws for expected failures --
// only a genuine bug should reject); dispatch (both the legacy one-shot
// path in federationServer.js and FederationLink's own inbound-rpc handling
// below) wraps it into the {v:1,kind:'rpc-response',...} envelope.

let routeDeps = null;

async function loadRouteDeps() {
  if (routeDeps) return routeDeps;
  const [sessionsMod, groupsMod, dirsMod, gmMod, smMod] = await Promise.all([
    import('../routes/sessions.js'),
    import('../routes/groups.js'),
    import('../routes/dirs.js'),
    import('./groupManager.js'),
    import('./sessionManager.js'),
  ]);
  routeDeps = { sessionsMod, groupsMod, dirsMod, gmMod, smMod };
  return routeDeps;
}

async function rpcPairingPropose(params, ctx) {
  if (ctx.selfPairing) return { ok: false, error: 'cannot pair with yourself' };
  const cfg = federationConfig();
  if (cfg.requireTokenForPairing && process.env.CCSERVER_TOKEN) {
    if (params?.federationToken !== process.env.CCSERVER_TOKEN) {
      return { ok: false, error: 'federation token required' };
    }
  }
  const hostnameClaimed = typeof params?.hostnameLabel === 'string' && params.hostnameLabel
    ? params.hostnameLabel.slice(0, 200) : null;
  const claimedAddr = typeof params?.claimedAddr === 'string' && params.claimedAddr
    ? params.claimedAddr.slice(0, 200) : ctx.remoteAddr;
  const row = pairing.recordInboundRequest({
    fingerprint: ctx.peerFingerprint,
    certPem: ctx.peerPem,
    hostnameClaimed,
    addr: claimedAddr,
  });
  if (!row) return { ok: false, error: 'this instance previously revoked the pairing' };
  return {
    ok: true,
    requestId: row.id,
    myFingerprint: ctx.selfIdentity.fingerprint,
    myHostnameLabel: myHostnameLabel(),
    myDecision: row.localDecision,
    myStatus: row.status,
  };
}

async function rpcPairingStatus(_params, ctx) {
  pairing.touchLastSeen(ctx.existingRow.id);
  const fresh = pairing.getInstance(ctx.existingRow.id);
  return {
    ok: true,
    myFingerprint: ctx.selfIdentity.fingerprint,
    myHostnameLabel: myHostnameLabel(),
    myDecision: fresh.localDecision,
    myStatus: fresh.status,
  };
}

async function rpcSessionsList(_params) {
  const { smMod } = await loadRouteDeps();
  return { ok: true, sessions: smMod.listSessions() };
}

async function rpcSessionsCreate(params, ctx) {
  const { sessionsMod } = await loadRouteDeps();
  const requestedBy = `federation:${ctx.existingRow.label || ctx.peerFingerprint.slice(0, 8)}`;
  // See federationServer.js's original header comment on this handler for
  // why `params` may be spread straight into createSessionViaApi's BODY
  // argument (isReviewJob stays a separate trusted parameter no caller here
  // ever forwards from untrusted input).
  const res = await sessionsMod.createSessionViaApi({ ...(params || {}), requestedBy });
  if (!res.ok) return { ok: false, error: res.message };
  return { ok: true, session: res.body };
}

async function rpcSessionsDestroy(params) {
  const { smMod } = await loadRouteDeps();
  const id = params?.id;
  const session = id ? smMod.getSession(id) : null;
  if (!session) return { ok: false, error: 'session not found' };
  smMod.destroySession(id, { keepSchedule: false, reason: 'federation' });
  return { ok: true };
}

async function rpcGroupsList() {
  const { gmMod } = await loadRouteDeps();
  return { ok: true, groups: gmMod.listGroups() };
}

async function rpcGroupMembers(params) {
  const { gmMod } = await loadRouteDeps();
  if (!params?.groupId || !gmMod.getGroup(params.groupId)) return { ok: false, error: 'group not found' };
  return { ok: true, members: gmMod.listGroupMembers(params.groupId) };
}

async function rpcGroupsCreate(params) {
  const { groupsMod } = await loadRouteDeps();
  const res = await groupsMod.launchGroupFromSpec(params || {});
  if (!res.ok) return { ok: false, error: res.message };
  return { ok: true, group: res.body };
}

async function rpcGroupsDestroy(params) {
  const { gmMod } = await loadRouteDeps();
  const id = params?.groupId;
  if (!id || !gmMod.getGroup(id)) return { ok: false, error: 'group not found' };
  gmMod.destroyGroup(id);
  return { ok: true };
}

async function rpcDirsList(params) {
  const { dirsMod } = await loadRouteDeps();
  const res = await dirsMod.browseDirectory(params?.path || '/', !!params?.showHidden);
  if (!res.ok) return { ok: false, error: res.message };
  return { ok: true, listing: res.data };
}

// Which methods are reachable before a pair reaches 'active' is decided by
// authorizeRequest() below (by literal method name -- only the two pairing
// plumbing methods are pre-active-reachable); this table is just method name
// -> handler. Shared by both ends of a link (plan section on RPC
// dispatch) -- federationServer.js's legacy one-shot handler imports this
// same table rather than keeping its own copy.
export const RPC_METHODS = {
  'pairing.propose': rpcPairingPropose,
  'pairing.status': rpcPairingStatus,
  'sessions.list': rpcSessionsList,
  'sessions.create': rpcSessionsCreate,
  'sessions.destroy': rpcSessionsDestroy,
  'groups.list': rpcGroupsList,
  'groups.members': rpcGroupMembers,
  'groups.create': rpcGroupsCreate,
  'groups.destroy': rpcGroupsDestroy,
  'dirs.list': rpcDirsList,
};

// Pure authorization decision, exported for unit testing without a real TLS
// connection. `existingRow` is the raw paired_instances row (or null/
// undefined for an unknown fingerprint) -- see federationPairing.getRawByFingerprint.
// Unchanged from federationServer.js's original (moved verbatim).
export function authorizeRequest({ kind, method }, existingRow, selfPairing) {
  if (selfPairing) return { ok: false, error: 'cannot federate with yourself' };
  if (kind === 'rpc' && method === 'pairing.propose') {
    if (existingRow && existingRow.status === 'revoked') return { ok: false, error: 'peer is revoked' };
    return { ok: true };
  }
  if (!existingRow || existingRow.status === 'revoked') {
    return { ok: false, error: existingRow ? 'peer is revoked' : 'unknown peer -- pair first' };
  }
  if (kind === 'rpc' && method === 'pairing.status') return { ok: true };
  if (existingRow.status !== 'active') {
    return { ok: false, error: `peer is not an active pair yet (status=${existingRow.status})` };
  }
  return { ok: true };
}

// Test seam: force the next inbound RPC dispatch (here or in
// federationServer.js's legacy path) to rebuild routeDeps.
export function _resetRouteDepsForTests() {
  routeDeps = null;
}

// Opens one mTLS connection as the dialer and resolves once the handshake
// completes and the peer's certificate has been read. Mirrors
// federationClient.js's connectTls (duplicated -- see this file's header
// comment on why).
async function dialTls({
  host, port, selfIdentity, connectTimeoutMs = CONNECT_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host, port, key: selfIdentity.key, cert: selfIdentity.cert, rejectUnauthorized: false, timeout: connectTimeoutMs,
    }, () => {
      // `timeout` above is meant to bound only the handshake itself. Node's
      // socket-level idle timer does not stop once connected, though -- it
      // fires again (and the 'timeout' handler below would destroy() the
      // socket) after any CONNECT_TIMEOUT_MS-long gap with zero bytes in
      // either direction. That is fatal for a persistent link: unlike the
      // one-shot RPCs this dial helper was duplicated from, a healthy link
      // is expected to sit idle between calls far longer than 10s. Disable
      // the idle timer now that the handshake succeeded; liveness past this
      // point is governed by TCP keepalive (see setKeepAlive below) and the
      // revoke-check timer, not socket inactivity.
      socket.setTimeout(0);
      const info = peerCertInfo(socket);
      if (!info) {
        try { socket.destroy(); } catch { /* ignore */ }
        reject(new Error('peer presented no TLS certificate'));
        return;
      }
      resolve({ socket, info });
    });
    try { socket.setKeepAlive(true, FEDERATION_KEEPALIVE_MS); } catch { /* ignore: keepalive not critical */ }
    socket.once('error', reject);
    socket.once('timeout', () => {
      try { socket.destroy(); } catch { /* ignore */ }
      reject(new Error(`connection to ${host}:${port} timed out`));
    });
  });
}

// One persistent, multiplexed link to a single paired peer. `row` is the
// public paired_instances shape (id, fingerprint, addr, ... -- see
// federationPairing.rowToPublic), same shape federationClient.js's existing
// functions already key off of (row.fingerprint, row.addr).
export class FederationLink {
  constructor(row, {
    selfIdentity, log, revokeCheckIntervalMs = REVOKE_CHECK_INTERVAL_MS, connectTimeoutMs = CONNECT_TIMEOUT_MS,
  } = {}) {
    this.row = row;
    this.selfIdentity = selfIdentity;
    this.log = log || null;
    this.revokeCheckIntervalMs = revokeCheckIntervalMs;
    this.connectTimeoutMs = connectTimeoutMs;
    // Fixed for this link's lifetime: which direction wins a simultaneous
    // double-connect is a pure function of the two fingerprints alone.
    this._preferSelfAsDialer = winningDialerIsSelf(selfIdentity.fingerprint, row.fingerprint);

    this.live = null; // { socket, framer, isDialer } once established
    this._peerPem = null; // live TLS peer cert PEM for the current `live` connection
    this.destroyed = false;
    this._wantsConnection = false;
    this._dialing = false;
    this._backoffDelay = null;
    this._reconnectTimer = null;
    this._revokeCheckTimer = null;
    this.pendingRpc = new Map(); // id -> { resolve, reject, timer }
    this.channels = new Map(); // channelId -> handler, for channels the PEER opened toward us
    this.outboundChannels = new Map(); // channelId -> { onMessage, onClose }, for channels WE opened

    this._onConnectCb = null;
    this._onDisconnectCb = null;
  }

  get connected() {
    return !!this.live;
  }

  onConnect(cb) { this._onConnectCb = cb; }

  onDisconnect(cb) { this._onDisconnectCb = cb; }

  // Commits this link to maintaining an outbound connection: dials now, and
  // keeps redialing (with backoff) forever after any drop, until close().
  // Idempotent -- safe to call again (e.g. from a future Step 3 periodic
  // "make sure every active pair has a link" sweep).
  connect() {
    if (this.destroyed) return;
    this._wantsConnection = true;
    this._dialOnce();
  }

  // Registers an already-accepted inbound TLS socket (from
  // federationServer.js's listener) as a connection candidate for this
  // peer. `peerInfo` is federationIdentity.peerCertInfo(socket)'s result --
  // the caller has already matched peerInfo.fingerprint to this link's
  // row.fingerprint before calling this.
  acceptInbound(socket, peerInfo) {
    if (this.destroyed) {
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    this._startCandidate(socket, peerInfo, { isDialer: false });
  }

  // Promotes a socket that has already completed one raw pairing.propose /
  // rpc-response round trip (the TOFU bootstrap exchange -- see
  // federationClient.js's initiatePairing and federationServer.js's
  // bootstrap handler) directly into this link's live connection, instead
  // of closing it and making both ends redial from scratch. `framer` must
  // already be attached to `socket` (the very same LineFramer that carried
  // the propose/response exchange) -- this reassigns its onLine/onError so
  // every line from here on flows through the normal link dispatch. No
  // separate link-hello round trip is needed: the propose exchange over
  // this exact socket already proves both ends are live and speak this
  // protocol version, so `helloReceived` is set true up front.
  adoptBootstrapSocket(socket, framer, peerPem, { isDialer }) {
    if (this.destroyed) {
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    const candidate = {
      socket, framer, isDialer, discarded: false, peerPem, helloReceived: true,
    };
    framer.onError = (err) => {
      this.log?.warn?.({ err }, '[federation-link] frame error, closing connection');
      try { socket.destroy(); } catch { /* ignore */ }
    };
    framer.onLine = (frame) => this._onCandidateLine(candidate, frame);
    socket.once('close', () => this._onSocketClose(candidate));
    this._resolveCandidate(candidate);
  }

  async _dialOnce() {
    if (this.destroyed || this.live || this._dialing) return;
    this._dialing = true;
    let host;
    let port;
    try {
      ({ host, port } = parseAddr(this.row.addr));
    } catch (err) {
      this._dialing = false;
      this.log?.warn?.({ err }, `[federation-link] cannot dial ${this.row.fingerprint.slice(0, 12)}`);
      return; // a malformed stored address will never parse -- no point retrying
    }
    try {
      const { socket, info } = await dialTls({
        host, port, selfIdentity: this.selfIdentity, connectTimeoutMs: this.connectTimeoutMs,
      });
      this._dialing = false;
      if (this.destroyed) {
        try { socket.destroy(); } catch { /* ignore */ }
        return;
      }
      if (info.fingerprint !== this.row.fingerprint) {
        // The peer at this address no longer presents the pinned
        // certificate -- refuse to trust it (same rule as the one-shot
        // path) and keep retrying; an operator fixing the address/cert
        // mismatch shouldn't require a restart.
        try { socket.destroy(); } catch { /* ignore */ }
        this._scheduleReconnect();
        return;
      }
      this._startCandidate(socket, info, { isDialer: true });
    } catch (err) {
      this._dialing = false;
      this.log?.warn?.({ err }, `[federation-link] dial to ${this.row.addr} failed`);
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.destroyed || this.live || this._reconnectTimer || !this._wantsConnection) return;
    const delay = nextReconnectDelayMs(this._backoffDelay);
    this._backoffDelay = delay;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._dialOnce();
    }, delay);
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  // Wraps a freshly connected/accepted socket (not yet trusted as "the"
  // live connection) and sends our link-hello. Resolution happens once the
  // peer's own link-hello arrives (_onCandidateLine).
  _startCandidate(socket, peerInfo, { isDialer }) {
    const candidate = {
      socket, framer: null, isDialer, discarded: false, peerPem: peerInfo.pem,
    };
    candidate.framer = new LineFramer(socket, {
      onError: (err) => {
        this.log?.warn?.({ err }, '[federation-link] frame error, closing connection');
        try { socket.destroy(); } catch { /* ignore */ }
      },
      onLine: (frame) => this._onCandidateLine(candidate, frame),
    });
    socket.once('close', () => this._onSocketClose(candidate));
    socket.once('error', () => { /* 'close' always follows 'error' on a Node socket */ });
    candidate.framer.write({ v: 1, kind: FRAME_KINDS.LINK_HELLO, fingerprint: this.selfIdentity.fingerprint });
  }

  _onCandidateLine(candidate, frame) {
    if (candidate === this.live) {
      this._onLiveLine(frame);
      return;
    }
    if (frame.kind !== FRAME_KINDS.LINK_HELLO || candidate.helloReceived) return;
    candidate.helloReceived = true;
    this._resolveCandidate(candidate);
  }

  _resolveCandidate(candidate) {
    if (!this.live) {
      this._adopt(candidate);
      return;
    }
    const candidateShouldWin = candidate.isDialer === this._preferSelfAsDialer;
    if (candidateShouldWin) {
      const old = this.live;
      old.discarded = true;
      this._adopt(candidate);
      try { old.socket.destroy(); } catch { /* ignore */ }
    } else {
      candidate.discarded = true;
      try { candidate.socket.destroy(); } catch { /* ignore */ }
    }
  }

  _adopt(candidate) {
    this.live = candidate;
    // The live TLS peer certificate, not the (possibly stale/absent) DB
    // cache -- matches the one-shot path's info.pem, used verbatim by
    // rpcPairingPropose's recordInboundRequest.
    this._peerPem = candidate.peerPem;
    this._backoffDelay = null;
    this._clearReconnectTimer();
    this._startRevokeCheckTimer();
    this._onConnectCb?.();
  }

  _onSocketClose(candidate) {
    if (candidate.discarded) return; // we destroyed it ourselves as a losing duplicate / superseded link
    if (candidate === this.live) {
      this.live = null;
      this._clearRevokeCheckTimer();
      for (const pending of this.pendingRpc.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('federation link closed'));
      }
      this.pendingRpc.clear();
      for (const handler of this.channels.values()) {
        try { handler.handleClose(); } catch { /* ignore */ }
      }
      this.channels.clear();
      for (const chan of this.outboundChannels.values()) {
        try { chan.onClose(); } catch { /* ignore */ }
      }
      this.outboundChannels.clear();
      this._onDisconnectCb?.();
    }
    if (!this.destroyed) this._scheduleReconnect();
  }

  _onLiveLine(frame) {
    switch (frame.kind) {
      case FRAME_KINDS.RPC:
        this._handleIncomingRpc(frame);
        break;
      case FRAME_KINDS.RPC_RESPONSE: {
        const pending = this.pendingRpc.get(frame.id);
        if (!pending) return;
        this.pendingRpc.delete(frame.id);
        clearTimeout(pending.timer);
        pending.resolve(frame);
        break;
      }
      case FRAME_KINDS.TERMINAL_OPEN:
        this._handleTerminalOpen(frame);
        break;
      case FRAME_KINDS.TERMINAL_DATA:
        this._handleTerminalData(frame);
        break;
      case FRAME_KINDS.TERMINAL_CLOSE:
        this._handleTerminalClose(frame);
        break;
      default:
        // Unknown frame kind on an established link: ignore rather than
        // tear down -- a future protocol version may add kinds this
        // instance doesn't understand yet.
        break;
    }
  }

  async _handleIncomingRpc(frame) {
    const existingRow = pairing.getRawByFingerprint(this.row.fingerprint);
    const authz = authorizeRequest({ kind: 'rpc', method: frame.method }, existingRow, false);
    const handler = RPC_METHODS[frame.method];
    let result;
    if (!authz.ok || !handler) {
      result = { ok: false, error: authz.ok ? 'unknown method' : authz.error };
    } else {
      try {
        result = await handler(frame.params, {
          existingRow,
          selfPairing: false,
          selfIdentity: this.selfIdentity,
          peerFingerprint: this.row.fingerprint,
          peerPem: this._peerPem,
          remoteAddr: this.row.addr,
        });
      } catch (err) {
        result = { ok: false, error: err.message };
      }
    }
    this.live?.framer.write({ v: 1, kind: FRAME_KINDS.RPC_RESPONSE, id: frame.id, ...result });
  }

  // Sends an RPC over the live socket and resolves with the peer's response
  // envelope ({ok, ...}). No fallback when the link isn't up (plan decision
  // 4) -- rejects immediately rather than opening a one-shot connection.
  rpc(method, params, { timeoutMs = 15_000 } = {}) {
    if (!this.live) return Promise.reject(new Error('federation link is not established'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`federation rpc ${method} timed out`));
      }, timeoutMs);
      this.pendingRpc.set(id, { resolve, reject, timer });
      const ok = this.live.framer.write({ v: 1, kind: FRAME_KINDS.RPC, id, method, params });
      if (!ok) {
        clearTimeout(timer);
        this.pendingRpc.delete(id);
        reject(new Error('failed to write to federation link'));
      }
    });
  }

  // Opens one multiplexed terminal channel over this link (our side
  // initiating -- mirrors federationClient.js's current openTerminalChannel
  // return shape so remoteTerminal.js needs no changes once Step 2 wires
  // this in). Throws synchronously if the link isn't up (no fallback).
  openTerminalChannel() {
    if (!this.live) throw new Error('federation link is not established');
    const channelId = randomUUID();
    let onMessageCb = null;
    let onCloseCb = null;
    this.outboundChannels.set(channelId, {
      onMessage: (msg) => onMessageCb?.(msg),
      onClose: () => onCloseCb?.(),
    });
    this.live.framer.write({ v: 1, kind: FRAME_KINDS.TERMINAL_OPEN, channelId });
    return {
      send: (obj) => { this.live?.framer.write({ v: 1, kind: FRAME_KINDS.TERMINAL_DATA, channelId, msg: obj }); },
      onMessage: (cb) => { onMessageCb = cb; },
      onClose: (cb) => { onCloseCb = cb; },
      close: () => {
        this.live?.framer.write({ v: 1, kind: FRAME_KINDS.TERMINAL_CLOSE, channelId });
        this.outboundChannels.delete(channelId);
      },
    };
  }

  // Peer opened a channel toward US -- same authorization + attachTerminalHandler
  // wiring federationServer.js's inbound relay branch used, now addressed by
  // channelId instead of owning the whole socket.
  _handleTerminalOpen(frame) {
    const existingRow = pairing.getRawByFingerprint(this.row.fingerprint);
    const authz = authorizeRequest({ kind: 'terminal' }, existingRow, false);
    if (!authz.ok) {
      this.live?.framer.write({
        v: 1, kind: FRAME_KINDS.TERMINAL_DATA, channelId: frame.channelId,
        msg: { type: 'error', message: `federation: ${authz.error}`, code: 'FEDERATION_UNAUTHORIZED' },
      });
      this.live?.framer.write({ v: 1, kind: FRAME_KINDS.TERMINAL_CLOSE, channelId: frame.channelId });
      return;
    }
    pairing.touchLastSeen(existingRow.id);
    const self = this;
    const channelId = frame.channelId;
    const chan = {
      send(str) {
        let msg;
        try { msg = JSON.parse(str); } catch { return; }
        self.live?.framer.write({ v: 1, kind: FRAME_KINDS.TERMINAL_DATA, channelId, msg });
      },
      close() {
        self.live?.framer.write({ v: 1, kind: FRAME_KINDS.TERMINAL_CLOSE, channelId });
        self.channels.delete(channelId);
      },
      get readyState() {
        return self.live ? 1 : 3;
      },
    };
    this.channels.set(channelId, attachTerminalHandler(chan));
  }

  _handleTerminalData(frame) {
    const inbound = this.channels.get(frame.channelId);
    if (inbound) {
      inbound.handleMessage(frame.msg).catch((err) => this.log?.error?.({ err }, '[federation-link] terminal relay error'));
      return;
    }
    const outbound = this.outboundChannels.get(frame.channelId);
    if (outbound) outbound.onMessage(frame.msg);
    // Unknown channelId (already closed on our end) -- drop silently.
  }

  _handleTerminalClose(frame) {
    const inbound = this.channels.get(frame.channelId);
    if (inbound) {
      try { inbound.handleClose(); } catch { /* ignore */ }
      this.channels.delete(frame.channelId);
    }
    const outbound = this.outboundChannels.get(frame.channelId);
    if (outbound) {
      try { outbound.onClose(); } catch { /* ignore */ }
      this.outboundChannels.delete(frame.channelId);
    }
  }

  _startRevokeCheckTimer() {
    this._clearRevokeCheckTimer();
    this._revokeCheckTimer = setInterval(() => {
      const fresh = pairing.getInstance(this.row.id);
      if (!fresh || fresh.status === 'revoked') {
        // Permanent: a revoked (or deleted) pair must never reconnect.
        this.close();
        return;
      }
      if (fresh.status !== 'active') {
        // Temporary: drop the live connection but let the normal backoff
        // keep retrying in case the pair becomes active later.
        try { this.live?.socket.destroy(); } catch { /* ignore */ }
      }
    }, this.revokeCheckIntervalMs);
  }

  _clearRevokeCheckTimer() {
    if (this._revokeCheckTimer) {
      clearInterval(this._revokeCheckTimer);
      this._revokeCheckTimer = null;
    }
  }

  // Permanent teardown: closes the live socket (if any), stops every timer,
  // and refuses all future reconnect attempts. Use this for "this pair is
  // gone" (revoked); for a link that should keep retrying later, just let
  // the socket drop naturally instead.
  close() {
    this.destroyed = true;
    this._wantsConnection = false;
    this._clearReconnectTimer();
    this._clearRevokeCheckTimer();
    if (this.live) {
      const live = this.live;
      live.discarded = true;
      try { live.socket.destroy(); } catch { /* ignore */ }
      this.live = null;
      for (const pending of this.pendingRpc.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('federation link closed'));
      }
      this.pendingRpc.clear();
      for (const handler of this.channels.values()) {
        try { handler.handleClose(); } catch { /* ignore */ }
      }
      this.channels.clear();
      for (const chan of this.outboundChannels.values()) {
        try { chan.onClose(); } catch { /* ignore */ }
      }
      this.outboundChannels.clear();
      this._onDisconnectCb?.();
    }
  }
}

// ---- Registry: one FederationLink per peer fingerprint ------------------
// Consulted by federationServer.js's inbound listener and every
// federationClient.js call site so all of them find-or-create the SAME link
// for a given pair instead of each managing its own Map (and, on the
// server side, so a fresh inbound connection from an already-linked peer
// resolves the duplicate-connection dance in _resolveCandidate rather than
// silently opening a second parallel link).

const links = new Map(); // fingerprint -> FederationLink

export function getOrCreateLink(row, opts) {
  let link = links.get(row.fingerprint);
  if (!link) {
    link = new FederationLink(row, opts);
    links.set(row.fingerprint, link);
  }
  return link;
}

export function getLink(fingerprint) {
  return links.get(fingerprint) || null;
}

export function removeLink(fingerprint) {
  const link = links.get(fingerprint);
  if (link) {
    link.close();
    links.delete(fingerprint);
  }
}

// Issue #142 Step 3: called once at server startup (server/index.js, right
// after ensureFederationServer() brings the inbound mTLS listener up) so
// every still-relevant pair gets a FederationLink dialing from boot, not
// just the ones some later RPC/terminal call or a fresh TOFU bootstrap
// happens to touch. Without this, a pair sitting in paired_instances with
// nobody having called callInstanceRpc/reconcilePending/openTerminalChannel
// against it since the last restart would never get a connect() at all --
// fatal in a one-directional-reachability environment where the OTHER side
// is the only one that could ever dial in.
//
// 'revoked'/'expired'/'rejected' are excluded: these mean the relationship
// is over (or never happened), and dialing a revoked peer in particular
// would be a hole in the "pin the key" model this feature otherwise
// enforces. 'pending_local_approval'/'pending_remote_approval' ARE
// included: reconcilePending can only learn the peer's decision by actually
// reaching it, which is exactly the reachability problem this whole issue
// exists to solve.
//
// connect() is idempotent and keeps retrying forever on its own backoff
// once called (see its own comment), so this is a one-shot sweep at boot,
// not a recurring timer -- there is no separate safety net here by design;
// if a link's own internal backoff ever stalls, that is a bug in
// FederationLink itself, not something this function should paper over by
// re-polling.
export async function establishAllLinks({ log } = {}) {
  const selfIdentity = await ensureIdentity();
  const rows = pairing.listInstances()
    .filter((row) => row.status !== 'revoked' && row.status !== 'expired' && row.status !== 'rejected');
  for (const row of rows) {
    getOrCreateLink(row, { selfIdentity, log }).connect();
  }
  log?.info?.(`[federation-link] establishAllLinks: kicked off connect() for ${rows.length} pair(s)`);
  return rows.length;
}

export function _resetLinksForTests() {
  for (const link of links.values()) link.close();
  links.clear();
}
