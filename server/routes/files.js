import { createReadStream, constants } from 'node:fs';
import { stat, open, realpath } from 'node:fs/promises';
import { basename, join, resolve, extname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { loadSandboxConfig } from '../ws/sandbox.js';
import { resolveWithinRoots, isContained } from '../pathPolicy.js';

// browseRoots (issue #189): resolves the same way resolve('/', requestedPath
// || '/') always did (relative paths anchored at /, '..' collapsed -- see
// files.test.js's host-wide-policy pin) but also reports whether the result
// falls inside the configured browseRoots. [] (default) is unrestricted, so
// this is a no-op change until an operator opts in.
// `invalid` reports a present-but-unusable browseRoots (see
// loadSandboxConfig): every route must fail closed (503) rather than treat it
// as unrestricted.
function safePath(requestedPath) {
  const { browseRoots, browseRootsInvalid } = loadSandboxConfig();
  if (browseRootsInvalid) {
    return { ok: false, invalid: true, path: resolve('/', requestedPath || '/') };
  }
  return { ...resolveWithinRoots(requestedPath, browseRoots), invalid: false }; // { ok, path, invalid }
}

const BROWSE_ROOTS_INVALID_ERROR = 'sandbox.config.json "browseRoots" is invalid (must be an array of directory paths); file access is disabled until it is fixed';

// Opens an upload target in a way that cannot be redirected outside
// browseRoots by a directory-symlink swap racing the request (a slow
// multipart body gives the attacker a wide window between the destination
// check and the actual write). On Linux the destination directory is pinned
// with an fd FIRST, containment is verified through that fd (not the path),
// and the file is opened relative to the fd via /proc/self/fd -- the fd
// keeps pointing at the original inode even if the path is swapped
// afterwards, so the check and the write can never disagree. On other
// platforms there is no portable openat emulation: the destination is
// re-realpath'd immediately before the open (shrinking the window to the
// single open() call) and the final component is opened with O_NOFOLLOW.
// Returns { outside:true } when the destination is not really inside roots;
// otherwise { handle, dir } with the caller responsible for closing both.
// Exported for tests (files.test.js pins the directory-symlink case through
// the opened fd, which the HTTP-level tests cannot stage without a race).
export async function openUploadTarget(destination, name, roots) {
  if (process.platform === 'linux') {
    const dir = await open(destination, constants.O_RDONLY | constants.O_DIRECTORY);
    let handle = null;
    try {
      const realDir = await realpath(`/proc/self/fd/${dir.fd}`);
      if (!isContained(realDir, roots)) return { outside: true, dir, handle: null };
      handle = await open(
        `/proc/self/fd/${dir.fd}/${name}`,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      );
      return { outside: false, dir, handle };
    } catch (err) {
      if (handle) await handle.close().catch(() => {});
      await dir.close().catch(() => {});
      throw err;
    }
  }
  const realDir = await realpath(destination);
  if (!isContained(realDir, roots)) return { outside: true, dir: null, handle: null };
  const handle = await open(
    join(destination, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
  );
  return { outside: false, dir: null, handle };
}

// Inline preview cap. The file browser's viewer only needs the head of a huge
// file to be useful, and slurping a multi-GB log into memory just to show it
// would be a self-inflicted DoS. Anything past this is cut and reported via
// `truncated: true` so the client can point at the download button instead.
export const PREVIEW_MAX_BYTES = 1024 * 1024;

// Binary sniff window: a NUL byte inside the first 8 KiB is the classic
// "this is not text" signal (the same heuristic git's diff uses). Images,
// executables and archives all trip it; UTF-8 text never contains NUL.
export const SNIFF_BYTES = 8 * 1024;

// Only these extensions are served by the preview route. The client mirrors
// this list (client/src/previewExts.js) to decide which rows are clickable;
// files.test.js asserts the two lists agree.
export const PREVIEW_EXTS = { '.md': 'markdown', '.txt': 'text' };

/**
 * Classify a file name for the preview viewer.
 * @param {string} name File name or path.
 * @returns {'markdown' | 'text' | null} null when the file is not previewable.
 */
export function previewKind(name) {
  return PREVIEW_EXTS[extname(String(name || '')).toLowerCase()] || null;
}

/**
 * Read at most `limit` bytes from the start of a file plus one extra byte so
 * the caller can tell "exactly limit bytes" from "more than limit bytes"
 * without trusting the stat() size (the file may be growing).
 * @param {import('node:fs/promises').FileHandle} handle Open read handle.
 * @param {number} limit Maximum number of bytes to return.
 * @returns {Promise<{ data: Buffer, truncated: boolean }>}
 */
async function readHead(handle, limit) {
  const buf = Buffer.alloc(limit + 1);
  let offset = 0;
  while (offset < buf.length) {
    const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const truncated = offset > limit;
  return { data: buf.subarray(0, Math.min(offset, limit)), truncated };
}

export async function filesRoute(fastify, opts) {
  // Download
  fastify.get('/files', async (request, reply) => {
    const { ok, path: filePath, invalid } = safePath(request.query.path);
    if (invalid) {
      return reply.code(503).send({ error: BROWSE_ROOTS_INVALID_ERROR });
    }
    if (!ok) {
      return reply.code(403).send({ error: 'Path is outside the allowed browseRoots' });
    }

    try {
      const st = await stat(filePath);
      if (!st.isFile()) {
        return reply.code(400).send({ error: 'Not a file' });
      }

      const name = basename(filePath);
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
      reply.header('Content-Length', st.size);
      reply.type('application/octet-stream');
      return reply.send(createReadStream(filePath));
    } catch (err) {
      if (err.code === 'ENOENT') {
        return reply.code(404).send({ error: 'File not found' });
      }
      if (err.code === 'EACCES') {
        return reply.code(403).send({ error: 'Permission denied' });
      }
      throw err;
    }
  });

  // Inline preview for the file browser (text / markdown). Kept separate from
  // the download route above so its `Content-Disposition: attachment`
  // behaviour, which existing clients rely on, stays untouched.
  fastify.get('/files/content', async (request, reply) => {
    const requested = request.query.path;
    if (typeof requested !== 'string' || requested === '') {
      return reply.code(400).send({ error: 'path is required' });
    }
    const { ok, path: filePath, invalid } = safePath(requested);
    if (invalid) {
      return reply.code(503).send({ error: BROWSE_ROOTS_INVALID_ERROR });
    }
    if (!ok) {
      return reply.code(403).send({ error: 'Path is outside the allowed browseRoots' });
    }
    const kind = previewKind(filePath);
    if (!kind) {
      return reply.code(415).send({ error: 'Unsupported file type' });
    }
    let handle = null;

    try {
      // Open first, validate through the handle. A stat() on the path followed
      // by a separate open() re-resolves the name, so a rename or symlink swap
      // in between would make us serve a file we never checked (TOCTOU).
      // Everything below -- type check, size, sniff, read -- goes through this
      // one FileHandle. O_NONBLOCK keeps a FIFO (or another blocking special
      // file) from parking the request and a libuv thread forever; it has no
      // effect on regular files.
      handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
      const st = await handle.stat();
      if (!st.isFile()) {
        return reply.code(400).send({ error: 'Not a file' });
      }

      const { data, truncated } = await readHead(handle, PREVIEW_MAX_BYTES);

      if (data.subarray(0, SNIFF_BYTES).includes(0)) {
        return reply.code(415).send({ error: 'Binary file' });
      }

      // 切り詰めた場合、末尾にUTF-8のマルチバイト列の途中が残り得る。
      // StringDecoderはその不完全な末尾を保持するので、end()を呼ばずに捨てる。
      // 切り詰めていない場合はend()で残りを吐き出す(不正なUTF-8ならU+FFFDになる)。
      const decoder = new StringDecoder('utf8');
      let content = decoder.write(data);
      if (!truncated) content += decoder.end();
      // 先頭のBOM(U+FEFF)は表示上見えないが、Markdownでは`#`の前に居座って
      // 見出しとして解釈されなくなる(Windows製エディタのファイルで起きる)ので落とす。
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

      return {
        path: filePath,
        name: basename(filePath),
        size: st.size,
        mtime: st.mtimeMs,
        kind,
        content,
        truncated,
      };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return reply.code(404).send({ error: 'File not found' });
      }
      if (err.code === 'EACCES') {
        return reply.code(403).send({ error: 'Permission denied' });
      }
      // open() itself refuses some non-files before stat() gets a say:
      // directories on platforms that reject O_RDONLY on them, sockets (ENXIO).
      if (err.code === 'EISDIR' || err.code === 'ENXIO') {
        return reply.code(400).send({ error: 'Not a file' });
      }
      throw err;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  });

  // Upload (multipart)
  fastify.post('/files', async (request, reply) => {
    const parts = request.parts();
    const { browseRoots, browseRootsInvalid } = loadSandboxConfig();
    let destination = null;
    let destinationBlocked = false;
    const uploaded = [];

    for await (const part of parts) {
      if (part.type === 'field' && part.fieldname === 'destination') {
        if (browseRootsInvalid) continue;
        const { ok, path } = safePath(part.value);
        if (ok) {
          destination = path;
        } else {
          destinationBlocked = true;
        }
        continue;
      }

      if (part.type === 'file') {
        if (browseRootsInvalid) {
          // Consume and discard to avoid stream errors
          await part.toBuffer();
          return reply.code(503).send({ error: BROWSE_ROOTS_INVALID_ERROR });
        }
        if (destinationBlocked) {
          // Consume and discard to avoid stream errors
          await part.toBuffer();
          return reply.code(403).send({ error: 'Destination is outside the allowed browseRoots' });
        }
        if (!destination) {
          // Consume and discard to avoid stream errors
          await part.toBuffer();
          return reply.code(400).send({ error: 'destination field must come before files' });
        }

        const name = basename(part.filename);
        if (!name || name === '.' || name === '..') {
          await part.toBuffer();
          continue;
        }

        const targetPath = join(destination, name);
        try {
          const buf = await part.toBuffer();
          // The destination check above is only a fast path: the body has
          // been streaming since then, so openUploadTarget re-establishes
          // containment (through a pinned directory fd on Linux) at the
          // moment of the actual write, and O_NOFOLLOW refuses a symlink
          // planted at the target file name itself (e.g. a malicious repo's
          // `notes.txt -> ~/.ssh/authorized_keys`).
          const { outside, dir, handle } = await openUploadTarget(destination, name, browseRoots);
          if (outside) {
            if (dir) await dir.close().catch(() => {});
            if (handle) await handle.close().catch(() => {});
            return reply.code(403).send({ error: 'Destination is outside the allowed browseRoots' });
          }
          try {
            await handle.writeFile(buf);
          } finally {
            await handle.close().catch(() => {});
            if (dir) await dir.close().catch(() => {});
          }
          uploaded.push({ name, path: targetPath, size: buf.length });
        } catch (err) {
          if (err.code === 'ELOOP') {
            return reply.code(403).send({ error: `Refusing to write through a symlink: ${name}` });
          }
          if (err.code === 'EACCES') {
            return reply.code(403).send({ error: `Permission denied: ${name}` });
          }
          if (err.code === 'ENOENT') {
            return reply.code(404).send({ error: 'Destination directory not found' });
          }
          throw err;
        }
      }
    }

    // A body with no file part (destination only) must not report success
    // while the config is unusable.
    if (browseRootsInvalid) {
      return reply.code(503).send({ error: BROWSE_ROOTS_INVALID_ERROR });
    }
    return { uploaded };
  });
}
