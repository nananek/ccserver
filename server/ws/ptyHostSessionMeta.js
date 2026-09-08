// Persists the "launch input" metadata pty-host itself deliberately does not
// keep (see server/pty-host/ptyStore.js's header comment): cwd/app/model/
// permissionMode/groupId/groupRole/customLabel/isMetaAgent/sandbox details/
// reuseSandboxHome/the resume id a session was started with. pty-host's own
// list() only ever returns id/cwd/cols/rows/pid/exited/exitCode/exitSignal/
// createdAt/viewers/sandbox{active,docker} -- everything else here is what
// sessionManager.js's restorePtyHostSessions() needs to rebuild a `session`
// record for an already-running pty-host session after a server本体 restart
// (plan5 Step3).
//
// Also carries `shardIndex` (plan5 Step5): which pty-host instance this
// session's pty lives on, decided once at creation and never recomputed (see
// ptyHostClient.js's shardIndexForKey() header comment) -- restorePtyHostSessions()
// needs it to know which shard's client to attach()/subscribe() through. An
// entry written before Step5 existed has no such field; that always meant
// the sole pre-Step5 instance, i.e. shard 0 (restorePtyHostSessions()
// defaults a missing value to 0 itself, not this file).
//
// Deliberately NOT the same file as .saved-sessions.json (SAVED_SESSIONS_PATH
// in sessionManager.js): that one is written once at graceful shutdown and
// means "the pty is dead, here's how to resume a fresh one". This file means
// the opposite -- "the pty is still alive, here's how to reattach to it" --
// and so must stay current for every live pty-host session, not just at
// shutdown.
//
// Stateless by design (plan5 Step3: "every call reads the whole file, mutates
// its in-memory shape, writes it back"): session create/destroy is not a hot
// path, so there is no need for an in-memory cache that could drift from disk
// -- every mutation is immediately durable, and a reader always sees the
// latest state even across module reloads (e.g. in tests).

import { readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function metaPath() {
  return process.env.CCSERVER_PTY_HOST_SESSION_META_PATH
    || join(__dirname, '..', '..', '.pty-host-session-meta.json');
}

function readAll() {
  try {
    const raw = JSON.parse(readFileSync(metaPath(), 'utf-8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch {
    return {}; // no file / unreadable / corrupt -- start from empty
  }
}

function writeAll(all) {
  try {
    if (Object.keys(all).length > 0) {
      const path = metaPath();
      // Issue #119 Step6-1 added a per-session `env` field carrying nearly
      // this whole process's environment (buildSessionEnv() only strips a
      // small server-only denylist -- see sessionEnv.js), so this file can
      // now hold real secrets (API keys, tokens) that a launching shell's
      // env happened to carry. `mode` only takes effect when writeFileSync
      // itself creates the file; chmodSync also re-tightens a file that
      // already existed (e.g. upgraded from a pre-Step6 install, or created
      // under a looser umask) on every write, not just the first.
      writeFileSync(path, JSON.stringify(all), { mode: 0o600 });
      try { chmodSync(path, 0o600); } catch { /* best effort */ }
    } else {
      try { unlinkSync(metaPath()); } catch { /* nothing to remove */ }
    }
  } catch {
    // best effort -- persistence must never crash the session manager
  }
}

// Records (or overwrites) one session's restore metadata, keyed by pty-host
// session id. Called right after a successful pty-host spawn().
export function setPtyHostSessionMeta(id, meta) {
  const all = readAll();
  all[id] = meta;
  writeAll(all);
}

// Merges `partial` into an already-recorded entry (Issue #119 Step6:
// sessionManager.js's debounced claudeSessionId write-back updates only
// `latestClaudeSessionId`, not the whole launch-input record setPtyHostSessionMeta
// wrote at spawn time). Unlike setPtyHostSessionMeta, a missing entry is a
// silent no-op rather than creating a partial one from scratch -- the session
// may have been destroyed (and its entry deleted) between the debounce timer
// being armed and firing, and there is nothing meaningful to patch onto in
// that case.
export function patchPtyHostSessionMeta(id, partial) {
  const all = readAll();
  if (!(id in all)) return;
  all[id] = { ...all[id], ...partial };
  writeAll(all);
}

// Drops one session's entry. Called from destroySession()'s usePtyHost branch
// and from the `destroyed` push-event handler (a session pty-host tears down
// on its own, e.g. its idle/exited timeout, also stops needing a restore
// entry).
export function deletePtyHostSessionMeta(id) {
  const all = readAll();
  if (!(id in all)) return;
  delete all[id];
  writeAll(all);
}

// Reads the full store at once -- used by restorePtyHostSessions() at boot to
// match against pty-host's own list().
export function loadPtyHostSessionMeta() {
  return readAll();
}
