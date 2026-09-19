// Shared factory behind gitBrokerRegistry.js and networkBrokerRegistry.js --
// both mitigate the exact same class of risk (a broker child_process is not
// attached to any pty's controlling terminal, so it survives as an orphan if
// pty-host itself crashes/OOM-kills while the child is running) with
// identical load/record/forget/reapOrphans logic, differing only in what
// they're called and which env var / on-disk filename they use. Kept as one
// factory instantiated twice (not a single shared registry) so a bug
// affecting one broker kind can't cross-contaminate the other -- see each
// call site's own header comment for its broker-specific rationale.

import { readFileSync, writeFileSync, unlinkSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

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

// `label` is used only in the write-failure warning (e.g. "git-broker",
// "network-broker"); `envVar` + `fileName` define defaultRegistryPath().
export function createBrokerRegistry({ label, envVar, fileName }) {
  function defaultRegistryPath() {
    return process.env[envVar] || join(homedir(), '.local', 'share', 'ccserver-sandbox', fileName);
  }

  class BrokerRegistry {
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
        console.warn(`[pty-host] ${label} registry write failed (continuing): ${err.message}`);
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

  return { BrokerRegistry, defaultRegistryPath };
}
