// Reading a file that a sandboxed session could have replaced.
//
// `readFileSync` is the wrong tool for any path an untrusted session can
// write, for two reasons that both look like a hang rather than an error:
//
//   - a FIFO with no writer does NOT throw, it BLOCKS. open(2) waits for a
//     writer that never comes, and because the read is synchronous the whole
//     event loop stops with it. A process stuck there also ignores SIGTERM
//     (it never reaches a JS frame to run the handler), so it cannot be shut
//     down short of SIGKILL. Every caller below wraps its read in try/catch
//     and treats failure as "start empty" -- but a block never reaches the
//     catch, so the try/catch reads as safe while being no protection at all.
//   - a symlink is followed, so the final component can point at a device
//     (/dev/zero reads forever) or at a file outside the tree entirely.
//
// So: open with O_NONBLOCK so open(2) returns immediately on a FIFO, with
// O_NOFOLLOW so a symlinked final component is refused outright, and check
// the kind with fstat on the descriptor we already hold -- not lstat on the
// path, which can be swapped between the check and the open. Anything that is
// not a regular file, and anything over the cap, throws instead of blocking,
// which is the shape callers already handle.
//
// This is the single implementation of that pattern. worktree.js's
// readGitdirFile() is a thin wrapper over it (it was the original copy, and
// carried the short-read bug fixed here -- issue #229). groupManager.js's
// addGroupFile() deliberately does NOT use it: that one streams a
// caller-supplied file into a blob with a fixed-size read/write loop, so it
// has no text to return, no size to pre-allocate and a containment check
// (/proc/self/fd) that has no meaning here. Sharing code between the two
// would mean a function that copies OR returns text depending on its
// arguments, which is a worse seam than two honest readers.

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

// Generous on purpose: these are JSON files ccserver itself wrote, and a cap
// that a legitimate file could cross would turn "restore my groups" into
// "silently start empty". The cap exists to bound a planted file, not to
// police our own output.
export const STATE_FILE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Read a regular file as UTF-8 text, refusing anything else.
 *
 * Throws rather than returning a sentinel so that existing call sites, which
 * already catch around `readFileSync`, keep their current behaviour without
 * a second error path. ENOENT passes through from open(2) unchanged, so
 * callers that distinguish "absent" from "unreadable" still can.
 *
 * `followSymlinks` drops O_NOFOLLOW for ONE caller -- see loadSandboxConfig.
 * It does not weaken the protection this module exists for: measured, every
 * hostile shape is still refused in under a millisecond through a symlink
 * (link -> FIFO is REJECTED as FIFO, link -> /dev/zero as a chardev, link ->
 * directory as a dir, link -> socket with ENXIO). What stops the hang is
 * O_NONBLOCK, which makes open(2) return immediately, plus the fstat
 * isFile() test on the descriptor; O_NOFOLLOW only decides whether a symlink
 * to a REGULAR FILE is followed, which is the one row of that table that
 * changes.
 */
export function readRegularFileText(file, { maxBytes = STATE_FILE_MAX_BYTES, followSymlinks = false } = {}) {
  const noFollow = followSymlinks ? 0 : (constants.O_NOFOLLOW || 0);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw Object.assign(new Error(`${file} is not a regular file`), { code: 'ENOTREGULAR' });
    }
    if (st.size > maxBytes) {
      throw Object.assign(new Error(`${file} exceeds ${maxBytes} bytes (got ${st.size})`), { code: 'EFBIG' });
    }
    const buf = Buffer.alloc(st.size);
    // readSync is allowed to return short -- it is one read(2), not a promise
    // to fill the buffer. Ignoring the count (the #229 bug) left the tail of
    // the buffer as NUL bytes, which survive .trim() and quietly corrupt
    // whatever is parsed out of the result. Loop, and trust the count.
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, read);
      if (n === 0) break; // EOF: the file shrank after fstat
      read += n;
    }
    return buf.subarray(0, read).toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

/** `JSON.parse(readFileSync(file, 'utf-8'))` with the protections above. */
export function readJsonFileIfRegular(file, opts) {
  return JSON.parse(readRegularFileText(file, opts));
}
