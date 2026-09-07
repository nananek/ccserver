// Wire framing for the pty-host UDS RPC/event channel (plan5 section 1.3):
// server本体 <-> pty-host talk length-prefixed NDJSON over one Unix socket.
//
// Each frame is:
//   [4-byte big-endian uint32 length][UTF-8 JSON payload of that many bytes]
//
// A length prefix (rather than scanning for a '\n', the mcpBroker.js pattern)
// is used here because pty-host frames can carry a whole buffered output
// backlog (subscribe's replay) in one message -- large enough that a
// byte-at-a-time newline scan on every incoming chunk would be wasteful, and
// because raw pty bytes end up as a JSON string field regardless, so "NDJSON"
// here means "one JSON object per message", not "split on raw newlines".

const LENGTH_BYTES = 4;
// Guards against a corrupted/malicious length header pinning the decoder on
// an unbounded wait for bytes that will never arrive. Comfortably above the
// largest plausible single frame (a subscribe() replay of the full 512KiB
// output buffer, JSON-escaped).
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export function encodeFrame(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf-8');
  const header = Buffer.alloc(LENGTH_BYTES);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

// Incremental decoder: feed it arbitrarily-chunked Buffers from a socket's
// 'data' event, get back the objects for every frame that has fully arrived
// so far (zero, one, or several per call). Partial frames are held until the
// rest arrives.
export class FrameDecoder {
  constructor() {
    this._buf = Buffer.alloc(0);
  }

  push(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    const frames = [];
    for (;;) {
      if (this._buf.length < LENGTH_BYTES) break;
      const len = this._buf.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) {
        throw new Error(`pty-host protocol: frame length ${len} exceeds ${MAX_FRAME_BYTES} bytes`);
      }
      if (this._buf.length < LENGTH_BYTES + len) break;
      const json = this._buf.subarray(LENGTH_BYTES, LENGTH_BYTES + len).toString('utf-8');
      this._buf = this._buf.subarray(LENGTH_BYTES + len);
      frames.push(JSON.parse(json));
    }
    return frames;
  }
}
