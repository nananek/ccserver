import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setPtyHostSessionMeta,
  patchPtyHostSessionMeta,
  deletePtyHostSessionMeta,
  loadPtyHostSessionMeta,
} from './ptyHostSessionMeta.js';

// metaPath() (in ptyHostSessionMeta.js) reads CCSERVER_PTY_HOST_SESSION_META_PATH
// fresh on every call rather than caching it at module load, so unlike the
// CCSERVER_PTY_HOST flag tests (which need their own process -- see
// sessionManager.pty-host.test.js's header comment) every test here can point
// at its own tmp file without any cross-test isolation risk.
function withTempMetaPath(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-pty-host-meta-test-'));
  const path = join(dir, '.pty-host-session-meta.json');
  const prev = process.env.CCSERVER_PTY_HOST_SESSION_META_PATH;
  process.env.CCSERVER_PTY_HOST_SESSION_META_PATH = path;
  try {
    return fn(path);
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_PTY_HOST_SESSION_META_PATH;
    else process.env.CCSERVER_PTY_HOST_SESSION_META_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadPtyHostSessionMeta returns {} when the file does not exist yet', () => {
  withTempMetaPath(() => {
    assert.deepEqual(loadPtyHostSessionMeta(), {});
  });
});

test('setPtyHostSessionMeta then loadPtyHostSessionMeta round-trips one entry', () => {
  withTempMetaPath(() => {
    setPtyHostSessionMeta('sess-1', { cwd: '/tmp/proj', shell: false, app: 'claude' });
    assert.deepEqual(loadPtyHostSessionMeta(), {
      'sess-1': { cwd: '/tmp/proj', shell: false, app: 'claude' },
    });
  });
});

test('setPtyHostSessionMeta accumulates multiple entries independently', () => {
  withTempMetaPath(() => {
    setPtyHostSessionMeta('sess-1', { cwd: '/a' });
    setPtyHostSessionMeta('sess-2', { cwd: '/b' });
    const all = loadPtyHostSessionMeta();
    assert.equal(Object.keys(all).length, 2);
    assert.equal(all['sess-1'].cwd, '/a');
    assert.equal(all['sess-2'].cwd, '/b');
  });
});

test('setPtyHostSessionMeta overwrites an existing entry for the same id', () => {
  withTempMetaPath(() => {
    setPtyHostSessionMeta('sess-1', { cwd: '/a' });
    setPtyHostSessionMeta('sess-1', { cwd: '/a-updated' });
    const all = loadPtyHostSessionMeta();
    assert.equal(Object.keys(all).length, 1);
    assert.equal(all['sess-1'].cwd, '/a-updated');
  });
});

test('deletePtyHostSessionMeta removes just the one entry', () => {
  withTempMetaPath(() => {
    setPtyHostSessionMeta('sess-1', { cwd: '/a' });
    setPtyHostSessionMeta('sess-2', { cwd: '/b' });
    deletePtyHostSessionMeta('sess-1');
    assert.deepEqual(loadPtyHostSessionMeta(), { 'sess-2': { cwd: '/b' } });
  });
});

test('deletePtyHostSessionMeta on an unknown id is a harmless no-op', () => {
  withTempMetaPath(() => {
    setPtyHostSessionMeta('sess-1', { cwd: '/a' });
    deletePtyHostSessionMeta('does-not-exist');
    assert.deepEqual(loadPtyHostSessionMeta(), { 'sess-1': { cwd: '/a' } });
  });
});

test('deleting the last entry removes the file from disk', () => {
  withTempMetaPath((path) => {
    setPtyHostSessionMeta('sess-1', { cwd: '/a' });
    assert.ok(existsSync(path), 'file exists once written');
    deletePtyHostSessionMeta('sess-1');
    assert.ok(!existsSync(path), 'file is removed once empty, like .saved-sessions.json');
  });
});

test('loadPtyHostSessionMeta recovers from a corrupt (non-JSON) file instead of throwing', () => {
  withTempMetaPath((path) => {
    writeFileSync(path, '{not valid json');
    assert.deepEqual(loadPtyHostSessionMeta(), {});
  });
});

test('loadPtyHostSessionMeta recovers from a file holding the wrong JSON shape (array, not object)', () => {
  withTempMetaPath((path) => {
    writeFileSync(path, '[1,2,3]');
    assert.deepEqual(loadPtyHostSessionMeta(), {});
  });
});

test('loadPtyHostSessionMeta recovers from an empty file', () => {
  withTempMetaPath((path) => {
    writeFileSync(path, '');
    assert.deepEqual(loadPtyHostSessionMeta(), {});
  });
});

test('setPtyHostSessionMeta after a corrupt file starts fresh instead of throwing', () => {
  withTempMetaPath((path) => {
    writeFileSync(path, '{not valid json');
    setPtyHostSessionMeta('sess-1', { cwd: '/a' });
    assert.deepEqual(loadPtyHostSessionMeta(), { 'sess-1': { cwd: '/a' } });
  });
});

// Issue #119 Step6-0: patchPtyHostSessionMeta merges into an existing entry
// (unlike setPtyHostSessionMeta, which replaces it wholesale) -- the debounced
// claudeSessionId write-back must update just latestClaudeSessionId without
// clobbering everything else setPtyHostSessionMeta wrote at spawn time.
test('patchPtyHostSessionMeta merges into an existing entry without touching its other fields', () => {
  withTempMetaPath(() => {
    setPtyHostSessionMeta('sess-1', { cwd: '/a', app: 'claude', latestClaudeSessionId: null });
    patchPtyHostSessionMeta('sess-1', { latestClaudeSessionId: 'resume-id-1' });
    assert.deepEqual(loadPtyHostSessionMeta(), {
      'sess-1': { cwd: '/a', app: 'claude', latestClaudeSessionId: 'resume-id-1' },
    });
  });
});

test('patchPtyHostSessionMeta on an id with no existing entry is a silent no-op, never creating a partial one', () => {
  withTempMetaPath(() => {
    patchPtyHostSessionMeta('does-not-exist', { latestClaudeSessionId: 'resume-id-1' });
    assert.deepEqual(loadPtyHostSessionMeta(), {}, 'nothing was created from a partial patch');
  });
});

// Issue #119 Step6-1's `env` field can carry near-enough this whole process's
// environment (buildSessionEnv() only strips a small server-only denylist),
// so a real secret (API key, token) picked up from a launching shell's env
// can land in this file -- unlike every other field this store has ever
// held. Skipped on non-POSIX platforms (Windows file permissions don't map
// onto a POSIX mode bitmask the same way).
const isPosix = process.platform !== 'win32';
test('setPtyHostSessionMeta writes the file with 0600 permissions, not the umask default', { skip: !isPosix }, () => {
  withTempMetaPath((path) => {
    setPtyHostSessionMeta('sess-1', { cwd: '/a', env: { SOME_SECRET: 'sh-1-abc' } });
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test('writing again re-tightens permissions even if the file already existed looser (e.g. pre-Step6 install)', { skip: !isPosix }, () => {
  withTempMetaPath((path) => {
    setPtyHostSessionMeta('sess-1', { cwd: '/a' });
    chmodSync(path, 0o644);
    setPtyHostSessionMeta('sess-1', { cwd: '/a-updated' });
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test('patchPtyHostSessionMeta only touches the named entry, leaving siblings untouched', () => {
  withTempMetaPath(() => {
    setPtyHostSessionMeta('sess-1', { cwd: '/a', latestClaudeSessionId: null });
    setPtyHostSessionMeta('sess-2', { cwd: '/b', latestClaudeSessionId: null });
    patchPtyHostSessionMeta('sess-1', { latestClaudeSessionId: 'resume-id-1' });
    const all = loadPtyHostSessionMeta();
    assert.equal(all['sess-1'].latestClaudeSessionId, 'resume-id-1');
    assert.equal(all['sess-2'].latestClaudeSessionId, null, 'sess-2 was never touched');
  });
});
