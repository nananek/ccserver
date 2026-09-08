// Outbound half of cross-instance federation: dialing a peer's federation
// port to run the TOFU pairing bootstrap, and otherwise driving REST-shaped
// calls / terminal I/O over a persistent, multiplexed FederationLink
// (server/ws/federationLink.js) rather than a fresh connection per call --
// see federationProtocol.js's header comment for why (Issue #142). The
// bootstrap dial in initiatePairing() is the one exception: there is no
// paired_instances row (and so no FederationLink) to speak over until that
// very call creates one, so it still runs as a single raw request/response
// round trip -- see that function for how its socket then gets promoted
// into the pair's initial link instead of being closed.
//
// Trust on first contact (TOFU) only ever applies to that ONE call:
// initiatePairing(). Every other function here requires an already-pinned
// fingerprint (from paired_instances, via federationPairing.getActiveInstance
// or the row passed to reconcilePending) -- FederationLink itself refuses to
// treat a connection as live if the peer certificate doesn't match the
// row's pinned fingerprint exactly (see federationLink.js's _dialOnce). This
// is what actually enforces "pin the key, not a CA" on the outbound side;
// federationServer.js enforces the same thing for inbound connections.

import { connect as tlsConnect } from 'node:tls';
import { hostname as osHostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ensureIdentity, peerCertInfo } from './federationIdentity.js';
import { LineFramer, FRAME_KINDS } from './federationProtocol.js';
import * as pairing from './federationPairing.js';
import { resolvedHostname } from './notify.js';
import { federationPort } from './federationServer.js';
import { getOrCreateLink } from './federationLink.js';

const CONNECT_TIMEOUT_MS = 10_000;
const RPC_TIMEOUT_MS = 15_000;
const FEDERATION_KEEPALIVE_MS = 30_000;
const LINK_READY_TIMEOUT_MS = 5_000;
const LINK_READY_POLL_MS = 50;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseRemoteAddr(remoteAddr) {
  if (typeof remoteAddr !== 'string' || !remoteAddr.includes(':')) {
    throw new Error('address must be host:port');
  }
  const idx = remoteAddr.lastIndexOf(':');
  const host = remoteAddr.slice(0, idx);
  const port = Number(remoteAddr.slice(idx + 1));
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error('address must be host:port with a valid port number');
  }
  return { host, port };
}

function myHostnameLabel() {
  return resolvedHostname() || osHostname();
}

// The address the peer should dial to reach US back -- needed for
// reconcilePending's pairing.status polling (and, once active, for the peer
// to be able to reach us at all if the pairing is later initiated from
// their side too). Best-effort self-report: `${resolvedHostname()}:${federationPort()}`,
// using the SAME hostname resolution notify.js already uses for its own
// "_from: <host>" attribution (CCSERVER_HOSTNAME env > sandbox.config.json's
// notify.hostname > OS hostname). There is no NAT/multi-homing-proof way to
// self-report a reachable address in general -- an operator on an
// asymmetric network needs CCSERVER_HOSTNAME set to whatever the peer can
// actually resolve (a Tailscale MagicDNS name, typically). Without this, the
// peer would fall back to the ephemeral TCP source port of this one
// bootstrap connection, which is useless for any later dial-back.
function myClaimedAddr() {
  const port = federationPort();
  return port != null ? `${myHostnameLabel()}:${port}` : null;
}

// Opens one mTLS connection and resolves once the handshake is done and the
// peer's certificate has been read -- CA validation stays off
// (rejectUnauthorized: false); the caller decides whether to trust the
// fingerprint (TOFU for the very first pairing propose, exact-pin match for
// everything else -- see the header comment).
async function connectTls({ host, port }) {
  const id = await ensureIdentity();
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host, port, key: id.key, cert: id.cert, rejectUnauthorized: false, timeout: CONNECT_TIMEOUT_MS,
    }, () => {
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

// The one place TOFU is allowed: dial a never-before-seen address, learn its
// certificate from the handshake itself, ask it to record us as a pending
// inbound request, and record OUR side of the pair (direction
// 'outbound_initiated', status starts pending_local_approval -- see
// federationPairing.js's header comment on the symmetric approval model).
// Returns the created/refreshed public row. Throws on any failure (network,
// refusal, or a previously-revoked peer) -- the REST route turns that into a
// 4xx/5xx for the browser.
//
// On success, this does NOT close the socket: the same connection that just
// carried the propose/response exchange is handed to federationLink.js as
// the new pair's initial live link (adoptBootstrapSocket), mirroring what
// federationServer.js's own bootstrap handler does with its end of this
// same TCP connection. No separate dial-and-reconnect is needed just to
// start the persistent link.
export async function initiatePairing({ remoteAddr, remoteToken, label }) {
  const { host, port } = parseRemoteAddr(remoteAddr);
  const { socket, info } = await connectTls({ host, port });
  const id = randomUUID();
  const { frame, framer } = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      reject(new Error('federation rpc pairing.propose timed out'));
    }, RPC_TIMEOUT_MS);
    const lineFramer = new LineFramer(socket, {
      onLine: (line) => {
        if (settled || line.kind !== FRAME_KINDS.RPC_RESPONSE || line.id !== id) return;
        settled = true;
        clearTimeout(timer);
        resolve({ frame: line, framer: lineFramer });
      },
      onError: (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.destroy(); } catch { /* ignore */ }
        reject(err);
      },
    });
    socket.once('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('connection closed before a response arrived'));
    });
    lineFramer.write({
      v: 1,
      kind: FRAME_KINDS.RPC,
      id,
      method: 'pairing.propose',
      params: {
        hostnameLabel: myHostnameLabel(),
        claimedAddr: myClaimedAddr() || undefined,
        federationToken: typeof remoteToken === 'string' && remoteToken ? remoteToken : undefined,
      },
    });
  });
  if (!frame.ok) {
    try { socket.destroy(); } catch { /* ignore */ }
    throw new Error(frame.error || 'pairing request was refused');
  }
  // connectTls armed `socket`'s idle timer (tls.connect's `timeout` option)
  // to bound how long a one-shot RPC may sit unanswered -- fine for the
  // propose/response wait above (already independently bounded by this
  // function's own RPC_TIMEOUT_MS timer), but fatal from here on: this
  // socket is about to become the pair's persistent link, and a healthy
  // link can legitimately sit idle between calls far longer than
  // CONNECT_TIMEOUT_MS. Disable it now, exactly like federationLink.js's
  // own dialTls does for every later reconnect -- without this, the very
  // first link a fresh pairing creates gets destroyed out from under it
  // ~10s after the last byte flowed, self-healing only because the normal
  // reconnect backoff then kicks in.
  socket.setTimeout(0);
  const row = pairing.recordOutboundRequest({
    fingerprint: info.fingerprint,
    certPem: info.pem,
    hostnameClaimed: typeof frame.myHostnameLabel === 'string' ? frame.myHostnameLabel : null,
    addr: remoteAddr,
    label: typeof label === 'string' && label ? label : null,
  });
  if (!row) {
    try { socket.destroy(); } catch { /* ignore */ }
    throw new Error('this instance previously revoked a pairing with that fingerprint');
  }
  const selfIdentity = await ensureIdentity();
  getOrCreateLink(row, { selfIdentity }).adoptBootstrapSocket(socket, framer, info.pem, { isDialer: true });
  return row;
}

// Find-or-create the FederationLink for `row`, make sure it is at least
// trying to connect (idempotent -- a no-op if it's already live or already
// dialing), and give it a bounded chance to actually finish connecting
// before giving up. This is NOT a fallback to a different connection
// mechanism (plan decision 4 forbids that) -- it's patience for the SAME
// link's own in-flight dial, typically well under a second on a real
// network (and often already resolved by the time this runs, since a
// pairing bootstrap's initiatePairing already adopted the pair's first live
// connection). Without this, a request arriving the moment a pair goes
// active -- or right after a process restart, before anything has
// re-dialed -- would spuriously fail even though the link was about to
// connect a moment later. Once a link is warm this returns immediately:
// the loop's very first `.connected` check short-circuits it. Callers still
// see a clear "not established" error if the link is still down once
// timeoutMs elapses (an actually-unreachable peer, or one that takes longer
// than that to answer) -- the REST layer's own polling (routes/federation.js's
// header comment) is what turns that into "now connected" on a later call.
async function getReadyLink(row, { timeoutMs = LINK_READY_TIMEOUT_MS } = {}) {
  const selfIdentity = await ensureIdentity();
  const link = getOrCreateLink(row, { selfIdentity });
  link.connect();
  const deadline = Date.now() + timeoutMs;
  while (!link.connected && !link.destroyed && Date.now() < deadline) {
    await sleep(LINK_READY_POLL_MS);
  }
  return link;
}

// Asks every not-yet-active pending row's peer what THEY decided, and folds
// the answer into remote_decision (federationPairing.recordRemoteDecision),
// which may flip the row to 'active' once both sides show 'approved' (see
// federationPairing.deriveStatus). Best-effort per row: an unreachable peer
// (or one whose link hasn't finished connecting yet) just leaves that row
// unchanged for the next poll. Called from the REST polling path
// (routes/federation.js) rather than a background timer -- see that file's
// header comment.
export async function reconcilePending() {
  const rows = pairing.listPending();
  const outcomes = [];
  for (const row of rows) {
    const link = await getReadyLink(row);
    if (!link.connected) {
      outcomes.push({ id: row.id, reachable: false });
      continue;
    }
    try {
      const resp = await link.rpc('pairing.status', {}, { timeoutMs: 5000 });
      if (resp.ok && (resp.myDecision === 'approved' || resp.myDecision === 'rejected')) {
        pairing.recordRemoteDecision(row.id, resp.myDecision);
      }
      outcomes.push({ id: row.id, reachable: true });
    } catch {
      outcomes.push({ id: row.id, reachable: false });
    }
  }
  return outcomes;
}

// REST-shaped call to an ALREADY-active peer (session/group list, launch,
// destroy, dir browse -- see federationLink.js's RPC_METHODS). Throws if the
// instance isn't active or its link isn't established (no fallback to a
// fresh one-shot connection -- plan decision 4).
export async function callInstanceRpc(instanceId, method, params, { timeoutMs } = {}) {
  const row = pairing.getActiveInstance(instanceId);
  if (!row) throw new Error('instance is not an active paired peer');
  const link = await getReadyLink(row);
  if (!link.connected) throw new Error(`federation link to ${row.addr} is not established`);
  const resp = await link.rpc(method, params, timeoutMs != null ? { timeoutMs } : {});
  if (!resp.ok) throw new Error(resp.error || `federation call ${method} failed`);
  pairing.touchLastSeen(row.id);
  return resp;
}

// Opens one multiplexed terminal channel over the peer's persistent link
// (see server/ws/remoteTerminal.js). The returned handle stays open for as
// long as the browser tab does; TerminalView.jsx's existing
// reconnect-on-close logic is what recovers if the underlying link itself
// drops (a fresh browser reconnect calls this again, by which point the
// link may have already reconnected via its own backoff). Throws if the
// instance isn't active or its link isn't established -- no fallback to a
// fresh one-shot connection (plan decision 4).
export async function openTerminalChannel(instanceId) {
  const row = pairing.getActiveInstance(instanceId);
  if (!row) throw new Error('instance is not an active paired peer');
  const link = await getReadyLink(row);
  if (!link.connected) throw new Error(`federation link to ${row.addr} is not established`);
  pairing.touchLastSeen(row.id);
  return link.openTerminalChannel();
}
