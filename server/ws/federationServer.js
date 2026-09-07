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
// authorizeRequest() (federationLink.js) decides what it may do purely from
// an exact fingerprint match against paired_instances, never from the
// certificate's CA chain, subject, or any self-reported field. Because every
// connection in this design is short-lived and single-purpose (see
// federationProtocol.js's header comment), there is no separate "is this
// still allowed" recheck -- a revoked peer is refused on its very next
// connection attempt.
//
// Dynamic imports of routes/sessions.js, routes/groups.js and routes/dirs.js
// mirror metaAgent.js's ensureMetaAgentBroker(): server/ws/ modules never
// statically import server/routes/ modules in this codebase (the dependency
// runs the other way for every other feature) -- see metaAgent.js's header
// comment for the acyclic-import-graph rationale this follows.

import { createServer as createTlsServer } from 'node:tls';
import { ensureIdentity, peerCertInfo } from './federationIdentity.js';
import * as pairing from './federationPairing.js';
import { LineFramer } from './federationProtocol.js';
import { RPC_METHODS, authorizeRequest, _resetRouteDepsForTests } from './federationLink.js';
import { attachTerminalHandler } from './terminal.js';

// Re-exported for federationServer.test.js (and any other existing caller)
// -- authorizeRequest's home moved to federationLink.js in Issue #142 Step 1
// but this file's public surface stays the same.
export { authorizeRequest };

const FEDERATION_KEEPALIVE_MS = 30_000;

let tlsServer = null;

export function federationPort() {
  const raw = process.env.CCSERVER_FEDERATION_PORT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function federationEnabled() {
  return federationPort() != null;
}

// RPC_METHODS and authorizeRequest now live in federationLink.js (Issue
// #142 Step 1: the dispatch table is shared by both ends of a persistent
// link from the start, per the plan). Re-imported above -- this file's own
// one-shot handleConnection below is unchanged and still uses them exactly
// as before; Step 2 replaces this function's body with link-based dispatch.

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

// Test seam: force the next RPC dispatch to rebuild routeDeps (a test may
// need a different set of mocked route modules). The cache itself now lives
// in federationLink.js alongside the handlers that use it.
export function _resetFederationServerForTests() {
  stopFederationServer();
  _resetRouteDepsForTests();
}
