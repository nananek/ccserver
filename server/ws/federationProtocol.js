// Wire framing for the federation TLS transport (server/ws/federationServer.js
// / server/ws/federationClient.js / server/ws/federationLink.js):
// newline-delimited JSON, one object per line, both directions.
//
// ---------------------------------------------------------------------
// Issue #142 supersedes the one-shot design below: a one-way-reachability
// network (e.g. Tailscale ACLs allowing A->B but not B->A) can never
// complete the bidirectional pairing handshake under one-shot connections,
// because the unreachable side's paired_instances row is stuck at
// pending_remote_approval forever -- it has no connection over which to ever
// learn the peer's decision. server/ws/federationLink.js replaces one-shot
// connections with ONE persistent, multiplexed mTLS link per pair (both
// sides periodically try to (re)dial; whichever direction is actually
// reachable wins and carries all traffic). The two concerns the original
// design below traded connection-reuse away for are addressed differently
// under multiplexing rather than dropped:
//   - Revocation latency: a persistent link cannot re-run the
//     fingerprint+status check on "the next connection attempt" the way a
//     one-shot connection could, since there may not be a next attempt for a
//     long time. federationLink.js instead reuses the exact revokeCheckTimer
//     pattern this file's terminal relay already had (30s periodic DB
//     status recheck, close on revoke) for the whole link, RPC traffic
//     included -- the same bound (max 30s) this codebase already accepted
//     for terminal relays, just widened to cover RPC too.
//   - Channel-multiplexing complexity: kept deliberately narrow. A link
//     tracks exactly two kinds of in-flight state: RPC correlation ids (an
//     id -> pending-promise map, symmetric in both directions -- see the
//     `rpc`/`rpc-response` kinds below) and terminal channel ids (a
//     channelId -> handler map). No other state machine exists on top of
//     that.
// ---------------------------------------------------------------------
//
// Frame `kind`s carried by a link (see federationLink.js):
//   - 'link-hello': the very first frame either side sends once the TLS
//     handshake completes, carrying the sender's own fingerprint256. Used to
//     confirm both ends speak this protocol and to trigger duplicate-link
//     resolution (see federationLink.js's winningDialerIsSelf) when both
//     directions happen to connect at once.
//   - 'rpc' / 'rpc-response': request/response correlated by `id`, exactly
//     like the original one-shot design's single request per connection --
//     but symmetric now: EITHER endpoint may send a 'rpc' frame at any time
//     over the link (the original design only let the dialing side send
//     'rpc' and the accepting side send 'rpc-response').
//   - 'terminal-open' / 'terminal-data' / 'terminal-close': one link
//     multiplexes any number of terminal relays, one per open browser tab,
//     distinguished by a `channelId` (a UUID minted by whichever side calls
//     federationLink's openTerminalChannel-equivalent). 'terminal-data'
//     wraps one original /ws/terminal protocol message verbatim under `msg`
//     (see server/ws/terminal.js's attachTerminalHandler, which this reuses
//     unchanged on the receiving end).

export const PROTOCOL_VERSION = 1;

// Frame `kind` string constants, shared by federationLink.js,
// federationServer.js and federationClient.js so the wire vocabulary lives
// in exactly one place.
export const FRAME_KINDS = Object.freeze({
  LINK_HELLO: 'link-hello',
  RPC: 'rpc',
  RPC_RESPONSE: 'rpc-response',
  TERMINAL_OPEN: 'terminal-open',
  TERMINAL_DATA: 'terminal-data',
  TERMINAL_CLOSE: 'terminal-close',
});

// Bounds a single buffered (newline-incomplete) frame. Generous for a
// terminal replay burst or a sessions/groups listing, still finite -- a peer
// that never sends '\n' cannot grow this without limit.
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

// Reassembles newline-delimited JSON off a Node socket (net.Socket /
// tls.TLSSocket) and emits one parsed object per complete line. Malformed
// JSON on a line is reported via onError and otherwise ignored (the line is
// dropped, framing continues) -- a single garbled line must not desync or
// kill an otherwise-healthy relay.
export class LineFramer {
  constructor(socket, { onLine, onError } = {}) {
    this.socket = socket;
    this.onLine = onLine || (() => {});
    this.onError = onError || (() => {});
    this._buf = '';
    socket.on('data', (chunk) => this._feed(chunk));
  }

  _feed(chunk) {
    this._buf += chunk.toString('utf-8');
    if (this._buf.length > MAX_LINE_BYTES) {
      this.onError(new Error('federation frame exceeded max line size'));
      try { this.socket.destroy(); } catch { /* already gone */ }
      return;
    }
    let idx;
    while ((idx = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (err) {
        this.onError(new Error(`invalid federation frame JSON: ${err.message}`));
        continue;
      }
      this.onLine(obj);
    }
  }

  write(obj) {
    if (this.socket.destroyed || this.socket.writableEnded) return false;
    try {
      this.socket.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch {
      return false;
    }
  }
}

export function writeFrame(socket, obj) {
  socket.write(`${JSON.stringify(obj)}\n`);
}
