// Inbound half of cross-instance federation (plan Phase 1, migration v5): a
// dedicated mTLS TCP listener on CCSERVER_FEDERATION_PORT speaking the
// newline-delimited-JSON protocol from federationProtocol.js. This is a
// SEPARATE net/tls listener from the main Fastify HTTP server -- mixing
// plaintext browser HTTP and mTLS peer traffic on one port is awkward with
// Node's `tls` API, and separate ports let a firewall/reverse proxy treat
// "browser access" and "peer access" as independent exposure surfaces (plan
// section 5.1).
//
// Trust gate (every single connection, no exceptions): CA validation is
// disabled (`rejectUnauthorized: false`); the peer's certificate is still
// exchanged during the handshake (mutual TLS -- `requestCert: true`), and
// authorizeRequest() below decides what it may do purely from an exact
// fingerprint match against paired_instances, never from the certificate's
// CA chain, subject, or any self-reported field. Because every connection in
// this design is short-lived and single-purpose (see federationProtocol.js's
// header comment), there is no separate "is this still allowed" recheck --
// a revoked peer is refused on its very next connection attempt.
//
// Dynamic imports of routes/sessions.js, routes/groups.js and routes/dirs.js
// mirror metaAgent.js's ensureMetaAgentBroker(): server/ws/ modules never
// statically import server/routes/ modules in this codebase (the dependency
// runs the other way for every other feature) -- see metaAgent.js's header
// comment for the acyclic-import-graph rationale this follows.

import { createServer as createTlsServer } from 'node:tls';
import { hostname as osHostname } from 'node:os';
import { ensureIdentity, peerCertInfo } from './federationIdentity.js';
import * as pairing from './federationPairing.js';
import { LineFramer } from './federationProtocol.js';
import { federationConfig } from './federationConfig.js';
import { resolvedHostname } from './notify.js';
import { attachTerminalHandler } from './terminal.js';

const FEDERATION_KEEPALIVE_MS = 30_000;

let tlsServer = null;
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

export function federationPort() {
  const raw = process.env.CCSERVER_FEDERATION_PORT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function federationEnabled() {
  return federationPort() != null;
}

function myHostnameLabel() {
  return resolvedHostname() || osHostname();
}

// ---- RPC method handlers ------------------------------------------------
// Each returns a plain result object (never throws for expected failures --
// only a genuine bug should reject); the connection handler wraps it into
// the {v:1,kind:'rpc-response',...} envelope and writes it back.

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
  // `params` comes straight from a remote (if paired/active) peer, same
  // trust level as an HTTP body. It is spread into createSessionViaApi's
  // BODY argument only -- isReviewJob is that function's separate, trusted
  // 2nd parameter (never read from body), so a peer setting params.isReviewJob
  // cannot force reviewer MCP injection here even though this line does not
  // filter params itself. See createSessionViaApi's header comment.
  // permissionMode is intentionally NOT capped here either -- federation
  // peers are already fully trusted for equally/more dangerous fields
  // (isMetaAgent, sandboxOpts, app) pre-existing this path; singling out
  // permissionMode for capping would not meaningfully raise the trust
  // boundary. See PR#108 review.
  const res = await sessionsMod.createSessionViaApi({ ...(params || {}), requestedBy });
  if (!res.ok) return { ok: false, error: res.message };
  return { ok: true, session: res.body };
}

async function rpcSessionsDestroy(params) {
  const { smMod } = await loadRouteDeps();
  const id = params?.id;
  const session = id ? smMod.getSession(id) : null;
  if (!session) return { ok: false, error: 'session not found' };
  smMod.destroySession(id, { keepSchedule: false });
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
// -> handler.
const RPC_METHODS = {
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

function closeChanFor(socket) {
  return {
    send(str) {
      if (socket.destroyed || socket.writableEnded) return;
      try { socket.write(`${str}\n`); } catch { /* socket may already be gone */ }
    },
    close() {
      try { socket.end(); } catch { /* already closing */ }
    },
    get readyState() {
      return (socket.destroyed || socket.writableEnded) ? 3 : 1;
    },
  };
}

function handleConnection(socket, { log, selfIdentity }) {
  try { socket.setKeepAlive(true, FEDERATION_KEEPALIVE_MS); } catch { /* ignore: keepalive not critical */ }
  const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
  const info = peerCertInfo(socket);
  if (!info) {
    // No client certificate presented at all: cannot possibly correspond to
    // any pinned peer. Refuse before reading a single application byte.
    try { socket.end(); } catch { /* ignore */ }
    return;
  }
  const selfPairing = info.fingerprint === selfIdentity.fingerprint;
  const existingRow = selfPairing ? null : pairing.getRawByFingerprint(info.fingerprint);

  let mode = null; // 'rpc' | 'terminal'
  let terminalHandler = null;
  let revokeCheckTimer = null;

  const framer = new LineFramer(socket, {
    onError: (err) => {
      log?.warn?.({ err }, '[federation] frame error, closing connection');
      try { socket.destroy(); } catch { /* ignore */ }
    },
    onLine: async (frame) => {
      if (mode === 'terminal') {
        if (terminalHandler) {
          try { await terminalHandler.handleMessage(frame); } catch (err) { log?.error?.({ err }, '[federation] terminal relay error'); }
        }
        return;
      }
      if (mode === 'rpc') return; // one-shot: ignore anything after the first line
      mode = frame.kind === 'terminal-open' ? 'terminal' : 'rpc';

      if (mode === 'rpc') {
        const method = frame.method;
        const handler = RPC_METHODS[method];
        const authz = authorizeRequest({ kind: 'rpc', method }, existingRow, selfPairing);
        if (!authz.ok || !handler) {
          framer.write({ v: 1, kind: 'rpc-response', id: frame.id, ok: false, error: authz.ok ? 'unknown method' : authz.error });
          try { socket.end(); } catch { /* ignore */ }
          return;
        }
        let result;
        try {
          result = await handler(frame.params, { existingRow, selfPairing, selfIdentity, peerFingerprint: info.fingerprint, peerPem: info.pem, remoteAddr });
        } catch (err) {
          result = { ok: false, error: err.message };
        }
        framer.write({ v: 1, kind: 'rpc-response', id: frame.id, ...result });
        try { socket.end(); } catch { /* ignore */ }
        return;
      }

      // mode === 'terminal'
      const authz = authorizeRequest({ kind: 'terminal' }, existingRow, selfPairing);
      if (!authz.ok) {
        framer.write({ type: 'error', message: `federation: ${authz.error}`, code: 'FEDERATION_UNAUTHORIZED' });
        try { socket.end(); } catch { /* ignore */ }
        return;
      }
      pairing.touchLastSeen(existingRow.id);
      const chan = closeChanFor(socket);
      terminalHandler = attachTerminalHandler(chan);
      // The 'terminal-open' envelope itself carries no terminal message --
      // the very next line is the actual init/attach (see remoteTerminal.js).

      // Long-lived terminal relays can outlive the decision that revoked
      // them; one-shot RPC connections are already closed by the time a
      // revoke could race them, so this periodic re-check only runs here.
      revokeCheckTimer = setInterval(() => {
        const fresh = pairing.getInstance(existingRow.id);
        if (!fresh || fresh.status !== 'active') {
          try {
            framer.write({ type: 'error', message: 'federation: pairing is no longer active', code: 'FEDERATION_UNAUTHORIZED' });
          } catch { /* ignore */ }
          try { socket.destroy(); } catch { /* ignore */ }
        }
      }, 30_000);
    },
  });

  socket.on('close', () => {
    clearInterval(revokeCheckTimer);
    if (terminalHandler) terminalHandler.handleClose();
  });
  socket.on('error', () => {
    clearInterval(revokeCheckTimer);
    if (terminalHandler) terminalHandler.handleClose();
  });
}

// Starts (once) the federation TLS listener. No-op if already running or if
// CCSERVER_FEDERATION_PORT is unset/invalid. Throws only for genuine startup
// failures (identity generation, listen()) -- callers (index.js) log and
// continue without federation rather than refusing to boot, matching how the
// notify/usage/meta brokers are treated.
export async function ensureFederationServer({ log, port: portOverride } = {}) {
  if (tlsServer) return tlsServer;
  const port = portOverride ?? federationPort();
  if (port == null) return null;
  const id = await ensureIdentity();
  tlsServer = createTlsServer(
    { key: id.key, cert: id.cert, requestCert: true, rejectUnauthorized: false },
    (socket) => handleConnection(socket, { log, selfIdentity: id }),
  );
  await new Promise((resolve, reject) => {
    tlsServer.once('error', reject);
    tlsServer.listen(port, '0.0.0.0', () => {
      tlsServer.off('error', reject);
      resolve();
    });
  });
  return tlsServer;
}

export function federationServerRunning() {
  return !!tlsServer;
}

export function stopFederationServer() {
  if (!tlsServer) return;
  try { tlsServer.close(); } catch { /* best effort */ }
  tlsServer = null;
}

// Test seam: force the next ensureFederationServer() to rebuild routeDeps
// (a test may need a different set of mocked route modules).
export function _resetFederationServerForTests() {
  stopFederationServer();
  routeDeps = null;
}
