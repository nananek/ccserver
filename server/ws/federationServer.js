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
// certificate's CA chain, subject, or any self-reported field.
//
// Issue #142 Step 2: an inbound connection from an already-known,
// not-revoked fingerprint is routed straight into that peer's
// FederationLink (persistent, multiplexed -- server/ws/federationLink.js)
// via acceptInbound(), instead of being dispatched here. The only
// connection this file still dispatches itself, one raw request/response
// pair at a time, is the TOFU pairing.propose bootstrap from a fingerprint
// with no row yet (or a self-pairing/revoked one, which must be refused) --
// there is no row to key a FederationLink on until that RPC actually
// creates one. On success, this file hands the still-open socket to a
// brand-new FederationLink for the row pairing.propose just created,
// exactly mirroring what federationClient.js's initiatePairing does with
// its own end of the same connection (see that file's header comment) -- so
// the very first pairing.propose round trip doubles as the initial link
// handshake, with no separate reconnect required afterward. A revoked
// peer's connection never reaches that promotion (authorizeRequest refuses
// pairing.propose from a revoked row), so it stays refused on every
// subsequent attempt exactly like before.
//
// Dynamic imports of routes/sessions.js, routes/groups.js and routes/dirs.js
// mirror metaAgent.js's ensureMetaAgentBroker(): server/ws/ modules never
// statically import server/routes/ modules in this codebase (the dependency
// runs the other way for every other feature) -- see metaAgent.js's header
// comment for the acyclic-import-graph rationale this follows. (That import
// now lives in federationLink.js, alongside the RPC_METHODS table itself.)

import { createServer as createTlsServer } from 'node:tls';
import { ensureIdentity, peerCertInfo } from './federationIdentity.js';
import * as pairing from './federationPairing.js';
import { LineFramer, FRAME_KINDS } from './federationProtocol.js';
import {
  RPC_METHODS, authorizeRequest, getOrCreateLink, _resetRouteDepsForTests, _resetLinksForTests,
} from './federationLink.js';

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

  if (!selfPairing && existingRow && existingRow.status !== 'revoked') {
    // Known, not-revoked peer (active or still pending): only a persistent
    // link speaks to us now -- their dial (or a redial after a drop) lands
    // here. getOrCreateLink needs the public row shape (fingerprint/addr),
    // not the raw DB columns existingRow carries.
    const publicRow = pairing.getInstanceByFingerprint(info.fingerprint);
    if (publicRow) {
      getOrCreateLink(publicRow, { selfIdentity, log }).acceptInbound(socket, info);
      return;
    }
  }

  // Bootstrap / refusal path: unknown fingerprint, self-pairing, or a
  // revoked peer retrying. Exactly one 'rpc' frame in, one 'rpc-response'
  // out -- the only method that can ever succeed here is 'pairing.propose'
  // (authorizeRequest gates everything else). On success, the still-open
  // socket is promoted into the new pair's initial FederationLink instead
  // of being closed (see this file's header comment).
  let handled = false;
  const framer = new LineFramer(socket, {
    onError: (err) => {
      log?.warn?.({ err }, '[federation] frame error, closing connection');
      try { socket.destroy(); } catch { /* ignore */ }
    },
    onLine: async (frame) => {
      if (handled) return; // one-shot: ignore anything after the first line
      handled = true;
      if (frame.kind !== FRAME_KINDS.RPC) {
        try { socket.end(); } catch { /* ignore */ }
        return;
      }
      const method = frame.method;
      const handler = RPC_METHODS[method];
      const authz = authorizeRequest({ kind: 'rpc', method }, existingRow, selfPairing);
      if (!authz.ok || !handler) {
        framer.write({
          v: 1, kind: FRAME_KINDS.RPC_RESPONSE, id: frame.id, ok: false, error: authz.ok ? 'unknown method' : authz.error,
        });
        try { socket.end(); } catch { /* ignore */ }
        return;
      }
      let result;
      try {
        result = await handler(frame.params, {
          existingRow, selfPairing, selfIdentity, peerFingerprint: info.fingerprint, peerPem: info.pem, remoteAddr,
        });
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      framer.write({ v: 1, kind: FRAME_KINDS.RPC_RESPONSE, id: frame.id, ...result });
      if (!result.ok || method !== 'pairing.propose') {
        try { socket.end(); } catch { /* ignore */ }
        return;
      }
      const row = pairing.getInstanceByFingerprint(info.fingerprint);
      if (!row) {
        try { socket.end(); } catch { /* ignore */ }
        return;
      }
      getOrCreateLink(row, { selfIdentity, log }).adoptBootstrapSocket(socket, framer, info.pem, { isDialer: false });
    },
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

// Test seam: stops the listener, force the next RPC dispatch to rebuild
// routeDeps (a test may need a different set of mocked route modules -- the
// cache itself lives in federationLink.js alongside the handlers that use
// it), and tears down every FederationLink this process created (inbound or
// outbound) so a test's timers (reconnect backoff, revoke-check) don't
// outlive the test and its DB.
export function _resetFederationServerForTests() {
  stopFederationServer();
  _resetRouteDepsForTests();
  _resetLinksForTests();
}
