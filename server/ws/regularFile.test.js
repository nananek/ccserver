// regularFile.js -- the one reader used for every file a sandboxed session
// could have replaced (issues #212 and #229).
//
// Every case here has a timeout. That is not decoration: the failure this
// module exists to prevent is a BLOCK, not a throw, and a synchronous block
// cannot be interrupted by anything inside the process. Without a timeout the
// regression does not fail the suite, it hangs the runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  accessSync, constants as fsConstants, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRegularFileText, readJsonFileIfRegular, STATE_FILE_MAX_BYTES } from './regularFile.js';

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-regfile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Same shape as files.test.js:481 and pathMigration.test.js:405.
function mkfifo(t, path) {
  try {
    execFileSync('mkfifo', [path]);
    return true;
  } catch {
    t.skip('mkfifo unavailable');
    return false;
  }
}

test('reads an ordinary file', { timeout: 5000 }, (t) => {
  const f = join(tmp(t), 'plain.json');
  writeFileSync(f, '{"a":1}');
  assert.equal(readRegularFileText(f), '{"a":1}');
  assert.deepEqual(readJsonFileIfRegular(f), { a: 1 });
});

test('an empty file reads as the empty string, not an error', { timeout: 5000 }, (t) => {
  const f = join(tmp(t), 'empty.json');
  writeFileSync(f, '');
  assert.equal(readRegularFileText(f), '');
});

// ---------------------------------------------------------------------------
// #229: readSync's return value
// ---------------------------------------------------------------------------

test('#229: a short read returns only the bytes that were read, with no NUL padding',
  { timeout: 5000, skip: process.platform !== 'linux' && 'needs Linux sysfs' }, (t) => {
  // readSync is ONE read(2). It may return less than asked for, and the old
  // code ignored the count: it allocated st.size, read into it, and
  // stringified the whole buffer -- so the tail came back as NUL bytes.
  //
  // Finding a real short read is the hard part, because read(2) on an
  // ordinary file does fill the buffer. sysfs attributes are the exception
  // that is always on hand: the kernel reports st.size = one page while the
  // attribute holds a few bytes, and fstat says isFile(), so this module
  // accepts it and then reads far less than st.size promised. That is the
  // #229 shape exactly, with no mocking (fs's ESM named exports cannot be
  // redefined anyway) and no contrived fixture.
  const attr = '/sys/devices/system/cpu/possible';
  try {
    accessSync(attr, fsConstants.R_OK);
  } catch {
    t.skip(`${attr} unavailable`);
    return;
  }
  const text = readRegularFileText(attr);
  // Pre-fix this was 4096 characters, 4092 of them NUL.
  assert.ok(!text.includes('\0'), `no NUL may survive into the result (got ${text.length} chars)`);
  assert.ok(text.length < 4096, `must not be padded out to st.size (got ${text.length})`);
  // And the value is the point: \0 survives String.trim(), so the old result
  // stayed unusable even after the trim every caller does.
  assert.match(text.trim(), /^[0-9,\-]+$/, `expected a cpu list, got ${JSON.stringify(text)}`);
});

// ---------------------------------------------------------------------------
// #212: things that are not regular files
// ---------------------------------------------------------------------------

test('#212: a FIFO is refused instead of blocking forever', { timeout: 5000 }, (t) => {
  const f = join(tmp(t), 'state.json');
  if (!mkfifo(t, f)) return;
  // Pre-fix, readFileSync here did not throw -- it waited for a writer that
  // never comes, with the event loop stopped and SIGTERM unhandled. The
  // timeout on this test is the only thing that could have caught it.
  assert.throws(() => readRegularFileText(f), (err) => err.code === 'ENOTREGULAR');
});

test('#212: a directory is refused', { timeout: 5000 }, (t) => {
  const d = join(tmp(t), 'adir');
  mkdirSync(d);
  assert.throws(() => readRegularFileText(d), (err) => err.code === 'ENOTREGULAR' || err.code === 'EISDIR');
});

test('#212: a symlinked final component is refused, not followed', { timeout: 5000 }, (t) => {
  const dir = tmp(t);
  const real = join(dir, 'real.json');
  const link = join(dir, 'link.json');
  writeFileSync(real, '{"followed":true}');
  symlinkSync(real, link);
  // O_NOFOLLOW: the point is that the target being a perfectly good file
  // does not matter. A session that can create the symlink chooses what gets
  // read otherwise -- including a device.
  assert.throws(() => readRegularFileText(link), (err) => err.code === 'ELOOP');
});

test('a file over the cap is refused rather than allocated', { timeout: 10000 }, (t) => {
  const f = join(tmp(t), 'big.json');
  writeFileSync(f, 'x'.repeat(4096));
  assert.throws(() => readRegularFileText(f, { maxBytes: 1024 }), (err) => err.code === 'EFBIG');
  // ...and the default cap is generous enough that real state files pass.
  assert.ok(STATE_FILE_MAX_BYTES >= 16 * 1024 * 1024);
  assert.equal(readRegularFileText(f).length, 4096);
});

test('a missing file still reports ENOENT, so callers can tell absent from unreadable',
  { timeout: 5000 }, (t) => {
  assert.throws(() => readRegularFileText(join(tmp(t), 'nope.json')), (err) => err.code === 'ENOENT');
});
