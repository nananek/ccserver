// Orphaned network-broker cleanup (mirrors gitBrokerRegistry.js's mitigation
// for the same class of risk -- see its own header comment for the full
// rationale, kept as a separate registry/file on purpose so a bug in one
// can't cross-contaminate the other).
//
// sandbox.js's startNetworkBroker() spawns a plain child_process (not
// attached to any pty's controlling terminal). If pty-host itself
// crashes/OOM-kills while a sandboxed session's network broker is running,
// that broker survives as an orphan: nothing sends it a signal, and nothing
// ever removes its runtime dir (allow-list/deny-list + port file).
//
// This module is pty-host's mitigation: every network broker it spawns is
// recorded here (by the pty-host session id that owns it) and forgotten again
// on that session's normal teardown. On startup, before any session of the
// new generation is recorded, whatever is still listed here can only be
// left over from a previous generation that never got to clean up -- kill it
// and remove its dir.

import { readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export function defaultRegistryPath() {
  return process.env.CCSERVER_PTY_HOST_NETWORKBROKER_REGISTRY
    || join(homedir(), '.local', 'share', 'ccserver-sandbox', 'pty-host-network-brokers.json');
}

function load(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isAlive(pid) {
  try {
    // Signal 0: existence check only, sends nothing (see `man 2 kill`).
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class NetworkBrokerRegistry {
  constructor(path = defaultRegistryPath()) {
    this._path = path;
    this._entries = load(path);
  }

  _save() {
    try {
      if (Object.keys(this._entries).length === 0) {
        try { unlinkSync(this._path); } catch { /* nothing to remove */ }
        return;
      }
      mkdirSync(dirname(this._path), { recursive: true });
      writeFileSync(this._path, JSON.stringify(this._entries));
    } catch (err) {
      // Best effort, same policy as .saved-sessions.json elsewhere in this
      // codebase: a lost registry write only costs one extra generation
      // before an orphan is reaped, never a crash of the live path.
      console.warn(`[pty-host] network-broker registry write failed (continuing): ${err.message}`);
    }
  }

  record(sessionId, { pid, dir }) {
    this._entries[sessionId] = { pid, dir };
    this._save();
  }

  forget(sessionId) {
    if (!(sessionId in this._entries)) return;
    delete this._entries[sessionId];
    this._save();
  }

  // Startup-time cleanup. Must be called before this generation records its
  // own first entry. Returns a small summary for the boot log.
  reapOrphans() {
    const ids = Object.keys(this._entries);
    let killed = 0;
    for (const id of ids) {
      const { pid, dir } = this._entries[id];
      if (typeof pid === 'number' && isAlive(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
          killed++;
        } catch {
          // exited between the liveness check and here -- fine
        }
      }
      if (dir) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
    this._entries = {};
    this._save();
    return { found: ids.length, killed };
  }
}
