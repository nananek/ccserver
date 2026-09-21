// GPG vault relay (plan: gpg-agent-vault, follow-up). A lock-then-unlock
// cycle (gpgVaultAgent.js's unlockVault/lockVault) always mints a brand new
// tmpfs homeDir + gpg-agent process with brand new socket paths -- but
// buildSandboxSpawn only ever snapshots those paths ONCE, at the moment a
// sandbox launches, and bind-mounts (bwrap) or allow-lists (seatbelt) them.
// Without this relay, an already-running gpgVault:true sandbox would keep
// pointing at sockets that no longer exist after any later lock/unlock, so
// its signing/SSH push would silently keep failing even though the UI
// reports "unlocked" again -- see docs-site sandbox/credentials.md and the
// PR that introduced this file for the full writeup.
//
// Fix: sandboxes never touch the vault's raw (per-unlock-generation) sockets
// directly. Instead they see this module's FIXED, generation-independent
// directory, which:
//  - listens on 5 sockets NAMED EXACTLY as GnuPG itself names them
//    (S.gpg-agent, S.gpg-agent.ssh, S.gpg-agent.extra, S.keyboxd, S.dirmngr
//    -- see gpgVaultAgent.js's resolveDirs()/gpgconf --list-dirs) and
//    forwards each new connection to whichever real socket gpgVaultAgent.js
//    CURRENTLY has (resolved fresh per connection, never cached) -- same
//    "host-side process mediates access to the live state" shape as
//    git-broker.js/network-broker.js, but dumb byte-level forwarding only
//    (no protocol parsing) since, unlike git-broker, there is nothing to
//    authorize here: the vault is a single, server-wide singleton, not
//    scoped per session/repo.
//  - holds a one-time COPY of the public pubring.kbx/trustdb.gpg/gpg.conf
//    files, so this directory is a complete, generation-independent
//    GNUPGHOME substitute usable as-is by macOS Seatbelt (which has no bind
//    mounts, so GNUPGHOME must be one real directory containing everything).
//    Safe to copy once and never refresh: unlockVault() always re-verifies
//    the freshly-imported key's fingerprint against the vault's permanently
//    stored one, and generateAndStoreVault() refuses to ever create a second
//    vault (gpgVaultDb's gpg_vault table is a fixed-id singleton row), so
//    this content is identical across every unlock generation for the
//    lifetime of this server's vault.
//
// Deliberately NOT a separate child process (unlike git-broker.js): it holds
// no secrets of its own (only forwards to whatever gpgVaultAgent.js already
// decided to expose) and does no privileged work, so the isolation a
// subprocess buys elsewhere isn't needed here, and skipping it avoids a
// second process to spawn/track/kill per server run.

import { createServer, createConnection } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { hostRuntimeDir, ensureHostRuntimeDir } from './git-broker.js';
import * as gpgVaultAgent from './gpgVaultAgent.js';

// Same keys as gpgVaultAgent.js's `sockets` object (getUnlockedAgentInfo()),
// mapped to the exact basename GnuPG itself uses for each (see this file's
// header) -- load-bearing: a sandbox's gpg/ssh client looks these up by
// these conventional names under $GNUPGHOME, not by any name of our choosing.
const SOCKET_BASENAMES = {
  agent: 'S.gpg-agent',
  agentSsh: 'S.gpg-agent.ssh',
  agentExtra: 'S.gpg-agent.extra',
  keyboxd: 'S.keyboxd',
  dirmngr: 'S.dirmngr',
};

const PUBLIC_FILES = ['pubring.kbx', 'trustdb.gpg', 'gpg.conf'];

// Map<kind, net.Server> once started, or null before the first gpgVault
// sandbox launch this server run (lazy -- most deployments never touch
// gpgVault at all).
let servers = null;

function relayDir() {
  // Short prefix, matching gpgVaultAgent.js's newTmpHomeDir()'s own reasoning
  // about staying well under sockaddr_un.sun_path (108 bytes Linux / 104
  // macOS) -- this dir is fixed (not per-UUID), so the margin is even wider
  // here, but keeping the naming short and consistent costs nothing.
  return join(hostRuntimeDir(), 'ccv-gpg-relay');
}

// The relay directory itself -- on macOS this doubles as a drop-in GNUPGHOME
// (see this file's header); on Linux/bwrap only the individual socket paths
// below are used (public files are bound per-launch from the real homeDir
// instead, since bwrap can assemble a target dir from multiple real
// sources).
export function getRelayDir() {
  return relayDir();
}

// Fixed, generation-independent socket paths sandbox.js/sandbox-seatbelt.js
// use instead of the vault's own (per-unlock) socket paths. Pure function of
// hostRuntimeDir() -- safe to call before ensureStarted() (e.g. while still
// deciding whether to launch), though the paths obviously won't have a
// listener behind them until ensureStarted() actually runs.
export function getRelaySocketPaths() {
  const dir = relayDir();
  return Object.fromEntries(Object.entries(SOCKET_BASENAMES).map(([kind, name]) => [kind, join(dir, name)]));
}

// Idempotent, synchronous: called from buildSandboxSpawn (server/ws/sandbox.js)
// right before it snapshots gpgVaultInfo, so the relay sockets (and, on
// first call, the public-file copies) are guaranteed to exist before
// bwrap's --bind-try / seatbelt's profile-building runs later in the same
// call. Only ever called while the vault is unlocked (buildSandboxSpawn
// gates gpgVault:true launches on isUnlocked() first), so
// getUnlockedAgentInfo() below is safe. Unlike git-broker's startGitBroker()
// (which spawns a child process and busy-waits for it to come up), this only
// opens local net.Server listeners -- synchronous enough in practice that no
// readiness dance is needed.
export function ensureStarted() {
  if (servers) return;
  ensureHostRuntimeDir();
  const dir = relayDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // One-time copy of the public metadata files -- see header comment on why
  // this is safe to never refresh.
  const vault = gpgVaultAgent.getUnlockedAgentInfo();
  for (const file of PUBLIC_FILES) {
    const src = join(vault.homeDir, file);
    if (existsSync(src)) {
      try { copyFileSync(src, join(dir, file)); } catch { /* best effort; bwrap still binds the real per-launch file directly */ }
    }
  }

  const paths = getRelaySocketPaths();
  const started = new Map();
  for (const kind of Object.keys(SOCKET_BASENAMES)) {
    const sockPath = paths[kind];
    // Stale socket file from a previous server run (unclean shutdown) --
    // listen() refuses to bind over an existing path.
    try { unlinkSync(sockPath); } catch { /* fresh, usually absent */ }
    const server = createServer({ allowHalfOpen: true }, (inbound) => {
      // Resolved fresh on EVERY new connection -- this is the whole point:
      // a lock/unlock in between two connections is transparently picked up.
      const target = gpgVaultAgent.getSocketPath(kind);
      if (!target) {
        // Locked right now: refuse immediately rather than hang, mirroring
        // how a real "no such agent" failure looks to the client (gpg/ssh
        // both treat a closed connection as "agent unavailable").
        inbound.destroy();
        return;
      }
      const outbound = createConnection(target);
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        inbound.destroy();
        outbound.destroy();
      };
      inbound.on('error', cleanup);
      outbound.on('error', cleanup);
      inbound.on('close', cleanup);
      outbound.on('close', cleanup);
      inbound.pipe(outbound);
      outbound.pipe(inbound);
    });
    server.on('error', (err) => {
      console.warn(`[gpg-vault-relay] ${kind} listen failed: ${err.message}`);
    });
    server.listen(sockPath);
    started.set(kind, server);
  }
  servers = started;
}

// Called from gracefulShutdown() (server/ws/sessionManager.js), alongside
// the other broker/relay teardowns.
export function stop() {
  if (!servers) return;
  for (const server of servers.values()) {
    try { server.close(); } catch { /* already closed / never bound */ }
  }
  servers = null;
}
