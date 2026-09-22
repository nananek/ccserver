// Route-level tests for GET /api/files/content, the file browser's inline
// preview: text vs markdown classification, the NUL-byte binary guard, the
// 1 MiB cap with UTF-8-safe truncation, and the usual 404 / 400 error shapes.
// Also pins the existing GET /api/files download route to `attachment` so
// adding the preview route can never change download behaviour.

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, chmodSync, readdirSync, existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { filesRoute, openUploadTarget, previewKind, PREVIEW_EXTS, PREVIEW_MAX_BYTES, SNIFF_BYTES } from './files.js';
import { PREVIEW_EXTS as CLIENT_PREVIEW_EXTS, isPreviewable } from '../../client/src/previewExts.js';

// Characters that must not appear literally in this source file.
const BOM = String.fromCharCode(0xfeff);
const REPLACEMENT = String.fromCharCode(0xfffd);
const NUL = String.fromCharCode(0);

let dir;
let app;

function contentUrl(path) {
  return `/api/files/content?path=${encodeURIComponent(path)}`;
}

// browseRoots (issue #189): points loadSandboxConfig() at a temp config for
// the duration of `fn`, same pattern as sandbox-config.test.js's withConfig.
function withConfig(json, fn) {
  const cfgDir = mkdtempSync(join(tmpdir(), 'ccserver-files-cfg-'));
  const path = join(cfgDir, 'sandbox.config.json');
  return (async () => {
    try {
      writeFileSync(path, JSON.stringify(json));
      const prev = process.env.CCSERVER_SANDBOX_CONFIG;
      process.env.CCSERVER_SANDBOX_CONFIG = path;
      try {
        return await fn();
      } finally {
        if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
        else process.env.CCSERVER_SANDBOX_CONFIG = prev;
      }
    } finally {
      rmSync(cfgDir, { recursive: true, force: true });
    }
  })();
}

function buildMultipart(boundary, parts) {
  const bufs = [];
  for (const p of parts) {
    bufs.push(Buffer.from(`--${boundary}\r\n`));
    if (p.filename) {
      bufs.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`));
      bufs.push(Buffer.from(`Content-Type: ${p.contentType || 'application/octet-stream'}\r\n\r\n`));
      bufs.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data));
      bufs.push(Buffer.from('\r\n'));
    } else {
      bufs.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`));
      bufs.push(Buffer.from(String(p.data)));
      bufs.push(Buffer.from('\r\n'));
    }
  }
  bufs.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(bufs);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ccserver-files-route-'));
  app = Fastify();
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await app.register(filesRoute, { prefix: '/api' });
});

after(async () => {
  try { await app.close(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

test('previewKind allows only .md (markdown) and .txt (text), case-insensitively', () => {
  for (const name of ['README.md', 'notes.MD', '/x/y/z.Md']) {
    assert.equal(previewKind(name), 'markdown', name);
  }
  for (const name of ['notes.txt', 'NOTES.TXT', '/a/b/c.Txt']) {
    assert.equal(previewKind(name), 'text', name);
  }
  for (const name of ['data.json', 'script.js', 'Makefile', 'md', 'txt', 'file.md.bak', 'a.markdown', '']) {
    assert.equal(previewKind(name), null, name || '(empty)');
  }
});

test('GET /files/content rejects non-.md/.txt files with 415 before touching the disk', async () => {
  const p = join(dir, 'config.json');
  writeFileSync(p, '{"plain": "json"}\n');
  const res = await app.inject({ method: 'GET', url: contentUrl(p) });
  assert.equal(res.statusCode, 415);
  assert.equal(res.json().error, 'Unsupported file type');

  // Extension check comes first, so even a missing .png is reported as unsupported.
  const missing = await app.inject({ method: 'GET', url: contentUrl(join(dir, 'nope.png')) });
  assert.equal(missing.statusCode, 415);
});

test('GET /files/content returns a plain text file as kind=text with metadata', async () => {
  const p = join(dir, 'notes.txt');
  const body = 'line one\nline two\n日本語も含む\n';
  writeFileSync(p, body);

  const res = await app.inject({ method: 'GET', url: contentUrl(p) });
  assert.equal(res.statusCode, 200);
  const json = res.json();
  assert.equal(json.path, p);
  assert.equal(json.name, 'notes.txt');
  assert.equal(json.kind, 'text');
  assert.equal(json.content, body);
  assert.equal(json.truncated, false);
  assert.equal(json.size, Buffer.byteLength(body));
  assert.equal(typeof json.mtime, 'number');
});

test('GET /files/content flags .md files as kind=markdown and returns the raw source', async () => {
  const p = join(dir, 'README.md');
  const body = '# Title\n\nSome **bold** text.\n';
  writeFileSync(p, body);

  const res = await app.inject({ method: 'GET', url: contentUrl(p) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().kind, 'markdown');
  // The server never renders; the client sanitizes and renders.
  assert.equal(res.json().content, body);
});

test('GET /files/content returns an empty file as empty content, not an error', async () => {
  const p = join(dir, 'empty.txt');
  writeFileSync(p, '');

  const res = await app.inject({ method: 'GET', url: contentUrl(p) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().content, '');
  assert.equal(res.json().truncated, false);
  assert.equal(res.json().size, 0);
});

test('GET /files/content rejects binary content (NUL byte in the head) with 415', async () => {
  // A .txt in name only: PNG bytes with a NUL inside the sniff window.
  const p = join(dir, 'image.txt');
  writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));

  const res = await app.inject({ method: 'GET', url: contentUrl(p) });
  assert.equal(res.statusCode, 415);
  assert.equal(res.json().error, 'Binary file');
});

test('GET /files/content caps the body at PREVIEW_MAX_BYTES without splitting a UTF-8 sequence', async () => {
  const p = join(dir, 'big.txt');
  // Fill so that a 3-byte character ("あ", E3 81 82) straddles the cap:
  // (cap - 1) ASCII bytes, then "あ", then more ASCII. Byte `cap` is then the
  // middle of the multibyte sequence.
  const head = 'x'.repeat(PREVIEW_MAX_BYTES - 1);
  const tail = 'y'.repeat(64);
  writeFileSync(p, head + 'あ' + tail);

  const res = await app.inject({ method: 'GET', url: contentUrl(p) });
  assert.equal(res.statusCode, 200);
  const json = res.json();
  assert.equal(json.truncated, true);
  // The partial "あ" must be dropped, not replaced with U+FFFD.
  assert.equal(json.content, head);
  assert.ok(!json.content.includes('�'), 'no replacement character at the cut');
  assert.ok(Buffer.byteLength(json.content) <= PREVIEW_MAX_BYTES);
  // `size` still reports the real on-disk size so the UI can say how much is missing.
  assert.equal(json.size, Buffer.byteLength(head + 'あ' + tail));
});

test('GET /files/content returns exactly PREVIEW_MAX_BYTES when the cut lands on ASCII', async () => {
  const p = join(dir, 'ascii-big.txt');
  writeFileSync(p, 'a'.repeat(PREVIEW_MAX_BYTES + 64));

  const res = await app.inject({ method: 'GET', url: contentUrl(p) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().truncated, true);
  // Not one byte more than the cap, even though the read-ahead byte was valid text.
  assert.equal(res.json().content.length, PREVIEW_MAX_BYTES);
});

test('GET /files/content reports truncated=false for a file of exactly PREVIEW_MAX_BYTES', async () => {
  const p = join(dir, 'exact.txt');
  writeFileSync(p, 'z'.repeat(PREVIEW_MAX_BYTES));

  const res = await app.inject({ method: 'GET', url: contentUrl(p) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().truncated, false);
  assert.equal(res.json().content.length, PREVIEW_MAX_BYTES);
});

test('GET /files/content returns 404 for a missing file and 400 for a directory', async () => {
  const missing = await app.inject({ method: 'GET', url: contentUrl(join(dir, 'nope.txt')) });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, 'File not found');

  // A directory whose name passes the extension allow-list still gets 400.
  const sub = join(dir, 'subdir.txt');
  mkdirSync(sub);
  const asDir = await app.inject({ method: 'GET', url: contentUrl(sub) });
  assert.equal(asDir.statusCode, 400);
  assert.equal(asDir.json().error, 'Not a file');
});

test('GET /files (download) still serves attachments after the preview route was added', async () => {
  const p = join(dir, 'dl.md');
  writeFileSync(p, '# download me\n');

  const res = await app.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent(p)}` });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-disposition'], /^attachment; filename="dl\.md"/);
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.equal(res.body, '# download me\n');
});

// ---------------------------------------------------------------------------
// Client/server agreement: the Files tab decides which rows are clickable
// from client/src/previewExts.js, the route from PREVIEW_EXTS here. If they
// drift, users either get dead clicks or 415s. Pin them together.

test('client PREVIEW_EXTS matches the server allow-list, and isPreviewable agrees with previewKind', () => {
  assert.deepEqual([...CLIENT_PREVIEW_EXTS].sort(), Object.keys(PREVIEW_EXTS).sort());
  const names = ['README.md', 'a.MD', 'notes.txt', 'X.TXT', 'data.json', 'Makefile', 'md', 'txt', '.md', '.txt', 'file.md.bak', 'a.markdown', '', 'dir/deep/x.txt'];
  for (const name of names) {
    assert.equal(isPreviewable(name), previewKind(name) !== null, `disagree on ${JSON.stringify(name)}`);
  }
});

// ---------------------------------------------------------------------------
// Input validation and path policy.

test('GET /files/content requires a non-empty path query parameter', async () => {
  for (const url of ['/api/files/content', '/api/files/content?path=']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 400, url);
    assert.equal(res.json().error, 'path is required');
  }
});

test('GET /files/content resolves relative paths from / and collapses .. (same host-wide policy as GET /files)', async () => {
  const p = join(dir, 'rel.txt');
  writeFileSync(p, 'relative ok\n');

  // No leading slash -> anchored at the filesystem root, so it still lands on the file.
  const res1 = await app.inject({ method: 'GET', url: contentUrl(p.replace(/^\/+/, '')) });
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.json().path, p);
  assert.equal(res1.json().content, 'relative ok\n');

  // ".." is normalised by resolve(), never rejected: this route deliberately
  // serves whatever the download route serves.
  const res2 = await app.inject({ method: 'GET', url: contentUrl(join(dir, 'missing-dir', '..', 'rel.txt')) });
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.json().path, p);
});

test('GET /files/content follows a symlink and echoes the requested (link) path', async () => {
  const target = join(dir, 'link-target.txt');
  writeFileSync(target, 'via symlink\n');
  const link = join(dir, 'link.txt');
  symlinkSync(target, link);

  const res = await app.inject({ method: 'GET', url: contentUrl(link) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().content, 'via symlink\n');
  assert.equal(res.json().path, link);
});

test('GET /files/content maps EACCES to 403', { skip: process.getuid?.() === 0 ? 'root bypasses file modes' : false }, async () => {
  const p = join(dir, 'secret.txt');
  writeFileSync(p, 'hidden');
  chmodSync(p, 0o000);
  try {
    const res = await app.inject({ method: 'GET', url: contentUrl(p) });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'Permission denied');
  } finally {
    chmodSync(p, 0o600);
  }
});

// ---------------------------------------------------------------------------
// Content edge cases.

test('GET /files/content strips a leading UTF-8 BOM so a markdown heading still renders', async () => {
  const p = join(dir, 'bom.md');
  const body = '# Title\n';
  writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]));

  const res = await app.inject({ method: 'GET', url: contentUrl(p) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().content, body);
  // `size` is still the on-disk size (BOM included).
  assert.equal(res.json().size, Buffer.byteLength(body) + 3);
});

test('GET /files/content preserves CRLF line endings and a U+FEFF that is not at the start', async () => {
  const p = join(dir, 'crlf.txt');
  const body = 'a\r\nb' + BOM + 'c\r\n';
  writeFileSync(p, body);

  const res = await app.inject({ method: 'GET', url: contentUrl(p) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().content, body);
});

test('GET /files/content does not crash on invalid UTF-8; bad bytes become U+FFFD', async () => {
  const p = join(dir, 'latin1.txt');
  // "cafe" with an acute e as Latin-1: 0xE9 is not valid UTF-8 here.
  writeFileSync(p, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));

  const res = await app.inject({ method: 'GET', url: contentUrl(p) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().content, 'caf' + REPLACEMENT + '\n');
  assert.equal(res.json().truncated, false);
});

test('GET /files/content sniffs exactly the first SNIFF_BYTES for NUL', async () => {
  const inside = join(dir, 'nul-inside.txt');
  writeFileSync(inside, Buffer.concat([Buffer.alloc(SNIFF_BYTES - 1, 0x61), Buffer.from([0x00]), Buffer.from('tail')]));
  const res1 = await app.inject({ method: 'GET', url: contentUrl(inside) });
  assert.equal(res1.statusCode, 415, 'NUL at the last sniffed byte is caught');

  // One byte further is past the window: documented heuristic boundary, the
  // file is served as text and the NUL survives into the JSON string.
  const outside = join(dir, 'nul-outside.txt');
  writeFileSync(outside, Buffer.concat([Buffer.alloc(SNIFF_BYTES, 0x61), Buffer.from([0x00]), Buffer.from('tail')]));
  const res2 = await app.inject({ method: 'GET', url: contentUrl(outside) });
  assert.equal(res2.statusCode, 200);
  assert.ok(res2.json().content.includes(NUL));
});

test('GET /files/content truncates a file that is exactly PREVIEW_MAX_BYTES + 1', async () => {
  const p = join(dir, 'plus-one.txt');
  writeFileSync(p, 'q'.repeat(PREVIEW_MAX_BYTES + 1));

  const res = await app.inject({ method: 'GET', url: contentUrl(p) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().truncated, true);
  assert.equal(res.json().content.length, PREVIEW_MAX_BYTES);
  assert.equal(res.json().size, PREVIEW_MAX_BYTES + 1);
});

test('GET /files/content mtime matches the file and moves after a rewrite', async () => {
  const p = join(dir, 'mtime.txt');
  writeFileSync(p, 'v1');
  const first = (await app.inject({ method: 'GET', url: contentUrl(p) })).json();
  assert.equal(first.content, 'v1');

  // Rewrite a little later (avoid same-tick mtime on coarse filesystems).
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(p, 'v2-longer');
  const second = (await app.inject({ method: 'GET', url: contentUrl(p) })).json();
  assert.equal(second.content, 'v2-longer');
  assert.equal(second.size, 9);
  assert.ok(second.mtime >= first.mtime, 'mtime moved forward');
});

// ---------------------------------------------------------------------------
// Resource hygiene: every code path (text, binary 415, truncated, directory
// 400, missing 404) must close its file handle. Linux exposes the open
// descriptor table under /proc/self/fd, so count it around a burst of requests.

test('GET /files/content does not leak file descriptors on any path', { skip: process.platform !== 'linux' ? 'needs /proc/self/fd' : false }, async () => {
  const fds = () => readdirSync('/proc/self/fd').length;
  const text = join(dir, 'leak.txt');
  writeFileSync(text, 'ok');
  const bin = join(dir, 'leak-bin.txt');
  writeFileSync(bin, Buffer.from([0x00, 0x01, 0x02]));
  const big = join(dir, 'leak-big.txt');
  writeFileSync(big, 'b'.repeat(PREVIEW_MAX_BYTES + 1));
  const asDir = join(dir, 'leak-dir.txt');
  mkdirSync(asDir);
  const paths = [text, bin, big, asDir, join(dir, 'leak-missing.txt')];

  // Warm up so anything opened lazily on first use is already counted.
  for (const p of paths) await app.inject({ method: 'GET', url: contentUrl(p) });
  const before = fds();
  for (let i = 0; i < 20; i++) {
    for (const p of paths) await app.inject({ method: 'GET', url: contentUrl(p) });
  }
  const after = fds();
  assert.ok(after - before <= 1, `descriptors grew from ${before} to ${after}`);
});

// ---------------------------------------------------------------------------
// TOCTOU guard: the route must open the file first and make every decision
// (type check, size, sniff, read) through that one FileHandle. A path-based
// stat() followed by open() would re-resolve the name and could validate one
// file but serve another. FileHandle is not exported, so spy on its prototype
// obtained from a real handle.

async function fileHandleProto() {
  const p = join(dir, 'proto-probe.txt');
  writeFileSync(p, 'probe');
  const h = await open(p, 'r');
  const proto = Object.getPrototypeOf(h);
  await h.close();
  return proto;
}

test('GET /files/content validates and reads through the same opened FileHandle', async () => {
  const p = join(dir, 'handle-check.txt');
  writeFileSync(p, 'real file');
  const proto = await fileHandleProto();
  const realStat = proto.stat;
  const realRead = proto.read;
  const seen = { statCalls: 0, statThis: null, readThis: null };
  const statMock = mock.method(proto, 'stat', async function (...args) {
    seen.statCalls++;
    seen.statThis = this;
    return realStat.apply(this, args);
  });
  const readMock = mock.method(proto, 'read', async function (...args) {
    seen.readThis = this;
    return realRead.apply(this, args);
  });
  try {
    const res = await app.inject({ method: 'GET', url: contentUrl(p) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().content, 'real file');
    assert.equal(seen.statCalls, 1, 'exactly one stat, on the handle');
    assert.ok(seen.statThis && typeof seen.statThis.fd === 'number', 'stat ran on an open FileHandle');
    assert.equal(seen.readThis, seen.statThis, 'the read used the handle that was validated');
  } finally {
    statMock.mock.restore();
    readMock.mock.restore();
  }
});

test('GET /files/content trusts the handle stat for the type check (not-a-file from the handle -> 400)', async () => {
  const p = join(dir, 'handle-type.txt');
  writeFileSync(p, 'looks like a regular file on disk');
  const proto = await fileHandleProto();
  const statMock = mock.method(proto, 'stat', async function () {
    return { isFile: () => false, size: 0, mtimeMs: 0 };
  });
  try {
    const res = await app.inject({ method: 'GET', url: contentUrl(p) });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'Not a file');
  } finally {
    statMock.mock.restore();
  }
});

test('GET /files/content maps errors raised by the handle stat like path errors (EACCES -> 403)', async () => {
  const p = join(dir, 'handle-err.txt');
  writeFileSync(p, 'x');
  const proto = await fileHandleProto();
  const statMock = mock.method(proto, 'stat', async function () {
    const err = new Error('mocked');
    err.code = 'EACCES';
    throw err;
  });
  try {
    const res = await app.inject({ method: 'GET', url: contentUrl(p) });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'Permission denied');
  } finally {
    statMock.mock.restore();
  }
});

// Opening first must not turn special files into a hang: a FIFO with no
// writer blocks a plain open() forever (and pins a libuv thread), which is
// why the route opens with O_NONBLOCK and then rejects it via stat().
test('GET /files/content answers 400 for a FIFO instead of blocking in open()', { timeout: 5000, skip: process.platform === 'win32' }, async (t) => {
  const p = join(dir, 'pipe.txt');
  try {
    execFileSync('mkfifo', [p]);
  } catch {
    t.skip('mkfifo unavailable');
    return;
  }
  const res = await app.inject({ method: 'GET', url: contentUrl(p) });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'Not a file');
});

test('GET /files/content answers 400 for a unix domain socket', { skip: process.platform === 'win32' }, async () => {
  const p = join(dir, 'sock.txt');
  const srv = createServer();
  await new Promise((resolve, reject) => srv.once('error', reject).listen(p, resolve));
  try {
    const res = await app.inject({ method: 'GET', url: contentUrl(p) });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'Not a file');
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// browseRoots (issue #189). browseRoots unset (the default) is exercised by
// every test above -- this section is additive, covering the restricted
// case, and must never change what those tests assert.

test('GET /files: a path outside browseRoots is refused with 403, inside is served', async () => {
  const allowed = mkdtempSync(join(dir, 'allowed-'));
  const outside = mkdtempSync(join(dir, 'outside-'));
  const okFile = join(allowed, 'ok.txt');
  const blockedFile = join(outside, 'blocked.txt');
  writeFileSync(okFile, 'inside\n');
  writeFileSync(blockedFile, 'outside\n');

  await withConfig({ browseRoots: [allowed] }, async () => {
    const ok = await app.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent(okFile)}` });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body, 'inside\n');

    const blocked = await app.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent(blockedFile)}` });
    assert.equal(blocked.statusCode, 403);
    assert.match(blocked.json().error, /browseRoots/);
  });
});

test('GET /files/content: a path outside browseRoots is refused with 403, inside is served', async () => {
  const allowed = mkdtempSync(join(dir, 'allowed-'));
  const outside = mkdtempSync(join(dir, 'outside-'));
  const okFile = join(allowed, 'ok.md');
  const blockedFile = join(outside, 'blocked.md');
  writeFileSync(okFile, '# inside\n');
  writeFileSync(blockedFile, '# outside\n');

  await withConfig({ browseRoots: [allowed] }, async () => {
    const ok = await app.inject({ method: 'GET', url: contentUrl(okFile) });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().content, '# inside\n');

    const blocked = await app.inject({ method: 'GET', url: contentUrl(blockedFile) });
    assert.equal(blocked.statusCode, 403);
    assert.match(blocked.json().error, /browseRoots/);
  });
});

test('POST /files: an upload destination outside browseRoots is refused with 403 and nothing is written', async () => {
  const allowed = mkdtempSync(join(dir, 'allowed-'));
  const outside = mkdtempSync(join(dir, 'outside-'));

  await withConfig({ browseRoots: [allowed] }, async () => {
    const boundary = '----Boundary' + randomUUID().replace(/-/g, '');
    const payload = buildMultipart(boundary, [
      { name: 'destination', data: outside },
      { name: 'files', filename: 'evil.txt', contentType: 'text/plain', data: Buffer.from('should not land') },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(res.statusCode, 403);
    assert.match(res.json().error, /browseRoots/);
    assert.equal(existsSync(join(outside, 'evil.txt')), false, 'file must not be written outside browseRoots');
  });
});

test('POST /files: an upload destination inside browseRoots still succeeds', async () => {
  const allowed = mkdtempSync(join(dir, 'allowed-'));

  await withConfig({ browseRoots: [allowed] }, async () => {
    const boundary = '----Boundary' + randomUUID().replace(/-/g, '');
    const payload = buildMultipart(boundary, [
      { name: 'destination', data: allowed },
      { name: 'files', filename: 'ok.txt', contentType: 'text/plain', data: Buffer.from('fine') },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(existsSync(join(allowed, 'ok.txt')), true);
  });
});

// Fail closed (issue #189 self-review): a present-but-invalid browseRoots
// must disable file access (503), never silently restore host-wide access.
test('GET/POST /files: a present-but-invalid browseRoots fails closed with 503', async () => {
  await withConfig({ browseRoots: '/srv/repos' }, async () => {
    const get = await app.inject({ method: 'GET', url: '/api/files?path=/etc/passwd' });
    assert.equal(get.statusCode, 503);
    assert.match(get.json().error, /browseRoots/);

    const preview = await app.inject({ method: 'GET', url: contentUrl('/etc/hostname') });
    assert.equal(preview.statusCode, 503);

    const boundary = '----Boundary' + randomUUID().replace(/-/g, '');
    const payload = buildMultipart(boundary, [
      { name: 'destination', data: '/tmp' },
      { name: 'files', filename: 'x.txt', contentType: 'text/plain', data: Buffer.from('x') },
    ]);
    const post = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(post.statusCode, 503);

    // Destination-only body (no file part) must not report success either.
    const boundary2 = '----Boundary' + randomUUID().replace(/-/g, '');
    const payload2 = buildMultipart(boundary2, [{ name: 'destination', data: '/tmp' }]);
    const post2 = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary2}` },
      payload: payload2,
    });
    assert.equal(post2.statusCode, 503);
  });
});

// Regression (issue #189 self-review): a symlink planted at the target file
// name used to be followed by writeFile(), so an upload of `notes.txt` into a
// directory containing `notes.txt -> <anywhere>` wrote THROUGH the link --
// a write-outside-browseRoots primitive requiring no race (the read side
// already rejects the same link via its realpath containment check).
test('POST /files: an upload target that is a symlink is refused and the link target is untouched', async () => {
  const allowed = mkdtempSync(join(dir, 'allowed-'));
  const outside = mkdtempSync(join(dir, 'outside-'));
  const victim = join(outside, 'victim.txt');
  writeFileSync(victim, 'ORIGINAL\n');
  symlinkSync(victim, join(allowed, 'link.txt'));

  await withConfig({ browseRoots: [allowed] }, async () => {
    const boundary = '----Boundary' + randomUUID().replace(/-/g, '');
    const payload = buildMultipart(boundary, [
      { name: 'destination', data: allowed },
      { name: 'files', filename: 'link.txt', contentType: 'text/plain', data: Buffer.from('PWNED\n') },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.match(res.json().error, /symlink/);
    assert.equal(readFileSync(victim, 'utf-8'), 'ORIGINAL\n',
      'the symlink target outside browseRoots must not be overwritten');
  });
});

// Regression (issue #189 self-review): the destination DIRECTORY itself can
// be swapped for an outside-pointing symlink while a slow multipart body is
// still being read. openUploadTarget pins the directory with an fd first and
// verifies containment through that fd, so the swap cannot move the write
// outside browseRoots (on Linux; the non-Linux fallback re-checks the path
// immediately before the open).
test('openUploadTarget: a destination directory symlink pointing outside is rejected through the opened fd', async () => {
  const allowed = mkdtempSync(join(dir, 'allowed-'));
  const outside = mkdtempSync(join(dir, 'outside-'));
  symlinkSync(outside, join(allowed, 'linkdir'));

  const res = await openUploadTarget(join(allowed, 'linkdir'), 'escaped.txt', [allowed]);
  try {
    assert.equal(res.outside, true, 'the real directory behind the link is outside browseRoots');
    assert.equal(existsSync(join(outside, 'escaped.txt')), false, 'nothing may be created outside browseRoots');
  } finally {
    if (res.handle) await res.handle.close().catch(() => {});
    if (res.dir) await res.dir.close().catch(() => {});
  }
});

test('openUploadTarget: a real directory inside browseRoots still accepts the write', async () => {
  const allowed = mkdtempSync(join(dir, 'allowed-'));

  const res = await openUploadTarget(allowed, 'ok.txt', [allowed]);
  try {
    assert.equal(res.outside, false);
    await res.handle.writeFile(Buffer.from('hi'));
  } finally {
    await res.handle.close().catch(() => {});
    if (res.dir) await res.dir.close().catch(() => {});
  }
  assert.equal(readFileSync(join(allowed, 'ok.txt'), 'utf-8'), 'hi');
});
