import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, FrameDecoder } from './protocol.js';

test('encodeFrame + FrameDecoder round-trips one object', () => {
  const decoder = new FrameDecoder();
  const frame = encodeFrame({ type: 'ping', reqId: '1' });
  const out = decoder.push(frame);
  assert.deepEqual(out, [{ type: 'ping', reqId: '1' }]);
});

test('a frame split across multiple chunks is held until complete', () => {
  const decoder = new FrameDecoder();
  const frame = encodeFrame({ hello: 'world', n: 42 });
  const mid = Math.floor(frame.length / 2);
  assert.deepEqual(decoder.push(frame.subarray(0, mid)), []);
  assert.deepEqual(decoder.push(frame.subarray(mid)), [{ hello: 'world', n: 42 }]);
});

test('multiple frames arriving in one chunk are all decoded, in order', () => {
  const decoder = new FrameDecoder();
  const a = encodeFrame({ i: 1 });
  const b = encodeFrame({ i: 2 });
  const c = encodeFrame({ i: 3 });
  const out = decoder.push(Buffer.concat([a, b, c]));
  assert.deepEqual(out, [{ i: 1 }, { i: 2 }, { i: 3 }]);
});

test('byte-at-a-time delivery still reassembles correctly', () => {
  const decoder = new FrameDecoder();
  const frame = encodeFrame({ data: 'x'.repeat(500) });
  const out = [];
  for (let i = 0; i < frame.length; i++) {
    out.push(...decoder.push(frame.subarray(i, i + 1)));
  }
  assert.deepEqual(out, [{ data: 'x'.repeat(500) }]);
});

test('a corrupt/oversized length header throws instead of hanging forever', () => {
  const decoder = new FrameDecoder();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(0xffffffff, 0); // ~4GiB, past MAX_FRAME_BYTES
  assert.throws(() => decoder.push(header), /exceeds/);
});

test('unicode payloads (multi-byte UTF-8) survive the length-prefix framing', () => {
  const decoder = new FrameDecoder();
  const payload = { data: '日本語のテスト出力 🎉\n', seq: 7 };
  const out = decoder.push(encodeFrame(payload));
  assert.deepEqual(out, [payload]);
});
