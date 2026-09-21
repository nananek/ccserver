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
//  - listens on exactly 2 sockets NAMED as GnuPG itself names them
//    (S.gpg-agent, S.gpg-agent.ssh) and forwards each new connection to
//    whichever real socket gpgVaultAgent.js CURRENTLY has (resolved fresh
//    per connection, never cached).
//  - SECURITY (audit F1): S.gpg-agent forwards to the agent's RESTRICTED
//    extra socket, never its main socket. The main socket answers
//    KEYWRAP_KEY/EXPORT_KEY, and the vault key is %no-protection, so a dumb
//    pipe onto it let any gpgVault:true sandbox run
//    `gpg --export-secret-keys` and exfiltrate the whole vault secret key.
//    Restricted mode forbids every export/import/keygen/passphrase command
//    (verified against GnuPG 2.4.9) while still allowing signing.
//  - Independently of that, every client->agent byte goes through
//    gpgVaultRelayFilter.js's protocol allowlists (Assuan for S.gpg-agent,
//    ssh-agent for S.gpg-agent.ssh), so the invariant does not rest on one
//    GnuPG version's restricted-mode command list alone.
//  - keyboxd/dirmngr/extra are deliberately NOT relayed any more: signing
//    needs none of them, and dirmngr performs network fetches from the HOST,
//    outside any per-sandbox network isolation.
//  - holds a COPY of the public pubring.kbx/trustdb.gpg/gpg.conf files, so
//    this directory is a complete, generation-independent GNUPGHOME
//    substitute usable as-is by macOS Seatbelt (which has no bind mounts, so
//    GNUPGHOME must be one real directory containing everything). Refreshed
//    on every gpgVault:true launch (ensureStarted), not just the first: the
//    content is identical across unlock generations of ONE vault, but a
//    vault can now be deleted and recreated (audit F1 remediation: pre-fix
//    vaults must be replaced), which changes the key.
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
import { createAssuanFilter, createSshAgentFilter } from './gpgVaultRelayFilter.js';

// Relayed sockets: in-sandbox basename (what gpg/ssh look up under
// $GNUPGHOME / via SSH_AUTH_SOCK), the gpgVaultAgent.js `sockets` key it
// forwards to, and the protocol filter guarding it. `agent` -> `agentExtra`
// is the audit-F1 fix: see this file's header.
const RELAYS = {
  agent: { basename: 'S.gpg-agent', target: 'agentExtra', createFilter: createAssuanFilter },
  agentSsh: { basename: 'S.gpg-agent.ssh', target: 'agentSsh', createFilter: createSshAgentFilter },
};

// Every basename this relay dir has EVER exposed (including the ones dropped
// by the audit-F1 fix). sandbox-seatbelt.js deny-pins all of these for
// non-gpgVault launches, so a stale socket from an older server build (or a
// future re-addition) can never become silently reachable.
const ALL_KNOWN_BASENAMES = ['S.gpg-agent', 'S.gpg-agent.ssh', 'S.gpg-agent.extra', 'S.keyboxd', 'S.dirmngr'];

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
  return Object.fromEntries(Object.entries(RELAYS).map(([kind, r]) => [kind, join(dir, r.basename)]));
}

// Deny-list form for launches WITHOUT gpgVault (audit F3): every socket path
// this relay dir has ever used, current or retired.
export function getAllRelaySocketPathsForDeny() {
  const dir = relayDir();
  return ALL_KNOWN_BASENAMES.map((name) => join(dir, name));
}

// Idempotent (listeners start once; public files refresh on every call),
// synchronous: called from buildSandboxSpawn (server/ws/sandbox.js) right
// before it snapshots gpgVaultInfo, so the relay sockets and the public-file
// copies are guaranteed to exist before
// bwrap's --bind-try / seatbelt's profile-building runs later in the same
// call. Only ever called while the vault is unlocked (buildSandboxSpawn
// gates gpgVault:true launches on isUnlocked() first), so
// getUnlockedAgentInfo() below is safe. Unlike git-broker's startGitBroker()
// (which spawns a child process and busy-waits for it to come up), this only
// opens local net.Server listeners -- synchronous enough in practice that no
// readiness dance is needed.
export function ensureStarted() {
  ensureHostRuntimeDir();
  const dir = relayDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Public metadata files, refreshed on every call -- see header comment on
  // why (vault delete + recreate changes the key).
  const vault = gpgVaultAgent.getUnlockedAgentInfo();
  for (const file of PUBLIC_FILES) {
    const src = join(vault.homeDir, file);
    if (existsSync(src)) {
      try { copyFileSync(src, join(dir, file)); } catch { /* best effort; bwrap still binds the real per-launch file directly */ }
    }
  }
  if (servers) return;

  // Retired sockets from an older build (unclean shutdown) must not linger
  // in the relay dir looking live.
  for (const name of ALL_KNOWN_BASENAMES) {
    if (Object.values(RELAYS).some((r) => r.basename === name)) continue;
    try { unlinkSync(join(dir, name)); } catch { /* usually absent */ }
  }

  const paths = getRelaySocketPaths();
  const started = new Map();
  for (const [kind, relay] of Object.entries(RELAYS)) {
    const sockPath = paths[kind];
    // Stale socket file from a previous server run (unclean shutdown) --
    // listen() refuses to bind over an existing path.
    try { unlinkSync(sockPath); } catch { /* fresh, usually absent */ }
    const server = createServer({ allowHalfOpen: true }, (inbound) => {
      // Resolved fresh on EVERY new connection -- this is the whole point:
      // a lock/unlock in between two connections is transparently picked up.
      const target = gpgVaultAgent.getSocketPath(relay.target);
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
      const filter = relay.createFilter({
        forward: (buf) => { if (!outbound.destroyed) outbound.write(buf); },
        reply: (buf) => { if (!inbound.destroyed) inbound.write(buf); },
        abort: (reason) => {
          console.warn(`[gpg-vault-relay] ${kind}: dropping connection (${reason})`);
          cleanup();
        },
      });
      inbound.on('error', cleanup);
      outbound.on('error', cleanup);
      inbound.on('close', cleanup);
      outbound.on('close', cleanup);
      inbound.on('end', () => { if (!outbound.destroyed) outbound.end(); });
      outbound.on('end', () => { if (!inbound.destroyed) inbound.end(); });
      // Client -> agent goes through the allowlist filter; never piped raw.
      inbound.on('data', (chunk) => filter.fromClient(chunk));
      outbound.on('data', (chunk) => {
        filter.fromServer(chunk);
        if (!inbound.destroyed) inbound.write(chunk);
      });
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
