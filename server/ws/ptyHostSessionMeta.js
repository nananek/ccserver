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

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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
      writeFileSync(metaPath(), JSON.stringify(all));
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
