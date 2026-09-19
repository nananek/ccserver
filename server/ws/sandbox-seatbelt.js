// macOS Seatbelt backend for `sandbox-exec` (see sandbox.js's darwin branch).
//
// Unlike bwrap (Linux), sandbox-exec has no bind mounts, mount namespaces or
// chroot: the sandboxed process sees the whole host filesystem and access is
// mediated by a deny-by-default Seatbelt policy instead ("visible but
// untouchable"). This is strictly weaker isolation than bwrap -- a regex gap
// is a live escape -- and docker (rootless dind) is unsupported, so every
// seatbelt launch runs with docker: false.
//
// sandbox-exec also has no `--setenv`: sandbox.js prepends `/usr/bin/env
// K=V ...` to the spawn argv from the `env` object returned here.
//
// The git/ssh/gh/commit-guard wrappers use a `#!/ccserver-sandbox-node`
// shebang that only resolves inside bwrap. On macOS the host node binary is
// directly visible, so this module mints per-launch `#!/bin/sh` shims that
// exec the real host node with the real wrapper script (the shim bodies and
// GIT_SSH_COMMAND are quoted for /bin/sh; credential.helper is
// backslash-escaped as a bare word: git classifies a leading `"` as a
// helper NAME (never executed), and the assembled command line -- the
// value plus the operation -- is still run via `sh -c` (git's
// run_credential_helper uses use_shell=1), so $TMPDIR spaces need
// bare-word escaping),
// plus a `hooks/` directory for core.hooksPath.

import { copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildIsolatedProxyEnv } from './network-broker.js';

// Base dir for per-launch seatbelt runtime dirs. os.tmpdir() honors $TMPDIR,
// which on macOS is the per-user /var/folders/... path. Overridable via
// CCSERVER_SANDBOX_SEATBELT_TMP for tests.
export function seatbeltBaseDir() {
  return process.env.CCSERVER_SANDBOX_SEATBELT_TMP || tmpdir();
}

// Carry the host's Claude Code login into the sandbox on darwin.
//
// macOS Claude Code stores its OAuth credentials in the login Keychain, which
// is unreachable under the Seatbelt profile (~/Library/Keychains is not
// allow-listed; `security` reports errSecNoDefaultKeychain / "authorization
// denied"). Claude then falls back to a plaintext <configDir>/.credentials.json
// -- which we point at the host ~/.claude (readable+writable in the profile) --
// but on a host that logged in via the Keychain that file does not exist yet,
// so the first sandbox launch would demand a fresh login.
//
// This runs on the HOST (unsandboxed, before the launch) and, only when the
// fallback file is absent, copies the Keychain item into it. `security` may
// pop a one-time GUI "ccserver wants to use the Keychain" prompt (ccserver did
// not create the item); a non-interactive failure is non-fatal -- the user
// just logs in once inside the sandbox and the file then persists.
//
// Idempotent: never overwrites an existing .credentials.json (Claude manages
// token refresh in that file itself once it exists).
//
// The `security` shell-out is SYNCHRONOUS (execFileSync) on the launch path --
// the pty-host shard for full sessions, the main server process for /usage
// captures -- so a `security` that blocks on a GUI prompt would freeze that
// event loop. Two guards: a 2s timeout (matches Claude Code's own keychain
// timeout) and a once-per-process probe (`defaultKeychainProbed`) so a launch
// storm can't re-stall. Tests inject `deps.runSecurity` to bypass both.

// Claude Code's own keychain account (its HT()): $USER, sanitized to
// "claude-code-user" if it has characters outside [A-Za-z0-9._-]. Exported for
// tests only.
export function keychainAccount() {
  let n;
  try { n = process.env.USER || userInfo().username; } catch { n = process.env.USER || ''; }
  if (!n) return '';
  return /^[a-zA-Z0-9._-]+$/.test(n) ? n : 'claude-code-user';
}

function probeHostKeychain() {
  const account = keychainAccount();
  const args = ['find-generic-password', '-w', '-s', 'Claude Code-credentials'];
  if (account) args.push('-a', account);
  return execFileSync('security', args, {
    encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

let defaultKeychainProbed = false;
// Tests only: clear the once-per-process probe latch.
export function _resetKeychainProbeForTest() { defaultKeychainProbed = false; }

export function seedClaudeCredentialsFromHostKeychain(hostHome, { runSecurity = null, probe = probeHostKeychain } = {}) {
  // Non-darwin: never shell out to `security`. An injected `runSecurity` or a
  // non-default `probe` is a test seam (production always calls this with
  // neither), so let those through -- otherwise the latch / probe-path tests
  // can only run on macOS.
  if (process.platform !== 'darwin' && !runSecurity && probe === probeHostKeychain) return false;
  // These env overrides make Claude ignore the stored credential entirely.
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) return false;
  const claudeDir = join(hostHome, '.claude');
  const credsPath = join(claudeDir, '.credentials.json');
  if (existsSync(credsPath)) return false;
  let raw;
  try {
    if (runSecurity) {
      // Full bypass of the once-per-process latch (each injected test drives
      // its own case).
      raw = String(runSecurity() ?? '').trim();
    } else {
      // One real `security` probe per process: a miss here (no item, ACL
      // denied, non-interactive, `security` missing, or the 2s timeout) just
      // means an in-sandbox login, and re-probing every launch would re-stall.
      if (defaultKeychainProbed) return false;
      defaultKeychainProbed = true;
      raw = String(probe() ?? '').trim();
    }
  } catch {
    return false;
  }
  if (!raw) return false;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return false; }
  if (!parsed || typeof parsed !== 'object' || !parsed.claudeAiOauth?.accessToken) return false;
  try {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(credsPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn(`[sandbox] could not seed ${credsPath} from the host Keychain: ${err?.message || err}`);
    return false;
  }
  console.warn(`[sandbox] seeded ${credsPath} from the host Keychain (Claude Code login carried into the sandbox)`);
  return true;
}

// Quote a host path for embedding in a Seatbelt `regex #"..."` literal.
// Seatbelt regexes are a POSIX-ERE-family dialect (AppleMatch), not ICU:
// escape only regex metacharacters (+ the SBPL string quotes). Escaping
// ordinary characters (spaces, '-', non-ASCII) is undefined behavior there.
export function escapeSeatbeltRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\"]/g, (c) => `\\${c}`);
}

// `^<dir>(/.*)?$` matches the dir itself plus everything underneath it.
export function subtreeRegex(dir) {
  return `^${escapeSeatbeltRegex(dir)}(/.*)?$`;
}

// Seatbelt mediates the symlink-resolved path: register both the raw and the
// realpath spelling so symlinked dirs still match their rules -- and so
// denies can't be walked around via the other spelling. Best-effort: absent
// paths keep just the raw spelling.
// `cache` (a per-launch Map, see buildSeatbeltLaunch) memoizes the
// realpathSync probe: the same anchor paths (projectDir, HOME, nodeBin, ...)
// are pinned repeatedly while one profile is assembled, and each uncached
// call is a blocking syscall.
export function pathVariants(p, cache = null) {
  if (cache?.has(p)) return cache.get(p);
  let out;
  try {
    const r = realpathSync(p);
    out = r === p ? [p] : [p, r];
  } catch {
    out = [p];
  }
  cache?.set(p, out);
  return out;
}

export function subtrees(p, cache = null) {
  return pathVariants(p, cache).map(subtreeRegex);
}

// Like pathVariants(), but resolves the symlink spelling even when `p` (or an
// intermediate component) does not exist yet: walk up to the nearest existing
// ancestor, realpath THAT, and re-append the missing trailing components.
// Seatbelt mediates the symlink-RESOLVED path, so a pin built from a
// not-yet-created path (a control socket before its broker has booted, the
// per-UID runtime dir on a fresh host) would otherwise keep only the raw
// spelling and silently miss every access via the resolved one (e.g. macOS
// resolves /tmp -> /private/tmp). Always includes the raw spelling too.
export function pathVariantsDeep(p, cache = null) {
  const abs = resolve(p);
  const missing = [];
  let cur = abs;
  const exists = (q) => {
    const k = `exists:${q}`;
    if (cache?.has(k)) return cache.get(k);
    const v = existsSync(q);
    cache?.set(k, v);
    return v;
  };
  while (cur && cur !== dirname(cur) && !exists(cur)) {
    missing.unshift(basename(cur));
    cur = dirname(cur);
  }
  const out = new Set([abs]);
  const bases = exists(cur) ? pathVariants(cur, cache) : [cur];
  for (const b of bases) out.add(missing.length ? join(b, ...missing) : b);
  return [...out];
}

// Exact-match reads on every ancestor directory up to (excluding) "/".
// Userspace realpath/lstat walks each ancestor component, and Seatbelt
// mediates every one of them: subtree rules (^/a/b/...) do NOT cover the
// ancestors themselves, so without these, node/vite/npm/git die with EPERM
// the moment they resolve anything under an allowed tree (verified on macOS
// hardware: EPERM lstat '/Volumes', '/Users', '/private' from project- and
// HOME-relative realpath). Exact match only, never subtree: siblings'
// contents stay closed. Both raw and realpath spellings (Seatbelt mediates
// the resolved path). "/" itself is allowed as a literal elsewhere, so it
// is excluded here.
export function ancestorExactRegexes(paths, cache = null) {
  const out = [];
  const seen = new Set();
  for (const p of paths.filter(Boolean)) {
    for (const v of pathVariants(p, cache)) {
      let d = dirname(v);
      while (d && d !== '/' && d !== '.') {
        if (!seen.has(d)) {
          seen.add(d);
          out.push(`^${escapeSeatbeltRegex(d)}$`);
        }
        d = dirname(d);
      }
    }
  }
  return out;
}

// Escape a host path for embedding in an SBPL `(literal "...")` string.
// Unlike escapeSeatbeltRegex (for `regex #"..."`), only the string-syntax
// metacharacters need escaping here.
export function escapeSeatbeltLiteral(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Credential trees an operator-configured extra bind must never re-expose to
// the sandbox, unconditionally (even with gitBroker off): raw ~/.ssh keys and
// the ~/.config/gh token are exactly the any-repo exposures the git broker
// replaces, and a stale sandbox.config.json predating that change must not
// silently reintroduce them. Shared by both backends' extra-bind filters
// (buildBwrapArgs and buildSeatbeltLaunch) so a new path is added in one place.
// `resolvedSrc` MUST already be resolve()'d so `~/.config/../.ssh/id_rsa`
// collapses onto ~/.ssh before the prefix test (Seatbelt/bwrap then mediate
// the resolved path and would grant it otherwise).
export function isBlockedCredentialBind(resolvedSrc, home) {
  return [join(home, '.ssh'), join(home, '.config', 'gh')]
    .some((p) => resolvedSrc === p || resolvedSrc.startsWith(`${p}/`));
}

// Agent CLI config/state dirs exposed writable on both backends so login and
// session state survive sandbox launches (bwrap's appBinds, seatbelt's
// appConfigDirs). Single source of truth (#7): both backends resolve the same
// relative list against their host home -- add a new CLI here, not in two
// places.
export const AGENT_CONFIG_REL_PATHS = [
  ['.claude'],
  ['.claude.json'],
  ['.local', 'share', 'claude'],
  ['.config', 'opencode'],
  ['.local', 'share', 'opencode'],
  ['.local', 'state', 'opencode'],
  ['.config', 'github-copilot'],
  ['.copilot'],
  ['.codex'],
  ['.commandcode'],
];
export function agentConfigDirs(home) {
  return AGENT_CONFIG_REL_PATHS.map((segs) => join(home, ...segs));
}

// Single teardown helper for the seatbelt orchestrator overlay (#9): the
// "only unlink files no other live session still references" guard was
// copy-pasted across sessionManager.js (spawn-failure + destroySession) and
// ptyStore.js (spawn-failure + destroy). `ownedFiles` is this session's
// overlay list, `peerFileLists` the other live sessions' lists -- files still
// referenced by a peer are kept. Best-effort: unlink failures are ignored.
export function releaseSeatbeltOverlay(ownedFiles, peerFileLists) {
  if (!Array.isArray(ownedFiles)) return;
  const stillReferenced = new Set();
  for (const list of peerFileLists || []) {
    if (!Array.isArray(list)) continue;
    for (const f of list) stillReferenced.add(f);
  }
  for (const f of ownedFiles) {
    if (stillReferenced.has(f)) continue;
    try { unlinkSync(f); } catch { /* best effort */ }
  }
}

// Network isolation for the seatbelt backend (see network-broker.js). Unlike
// bwrap (a real netns + kernel firewall), sandbox-exec has no network
// namespace: this is a Seatbelt policy flip from broad `(allow network*)` to
// deny-by-default-except-the-broker's-loopback-port. Defense in depth, not a
// hard boundary -- a same-UID process can still recover the broker's token
// via KERN_PROCARGS2 (see the sysctl-read comment block below), so this
// keeps a well-behaved process off the network without stopping a
// deliberately hostile one from finding the token and dialing the broker
// itself (which is still allow-list-scoped, unlike a raw network escape).
//
// SBPL SYNTAX (verified live on macOS 14.8.5 arm64 -- these filters are
// sparsely documented, do not "simplify" without re-verifying):
//   - the tcp/udp remote filter takes a bare "host:port" STRING:
//     `(remote tcp "localhost:54321")`. A nested `(remote ip ...)` /
//     `(remote address ...)` form does NOT compile (`remote expects string
//     argument` / `unbound variable: address`).
//   - the host part must be `*` or the literal name `localhost` (a numeric
//     `127.0.0.1` is rejected at compile time with `host must be * or
//     localhost in network address`). Verified live that this `localhost`
//     rule matches actual 127.0.0.1 connections (nc to 127.0.0.1:port
//     succeeds) while any other port is refused.
//   - the broker is always dialed at the numeric 127.0.0.1 (see
//     SEATBELT_ISOLATED_BROKER_HOST), never via the `localhost` name, so no
//     DNS resolution is needed inside the sandbox at all.
// Emission ORDER is load-bearing (last-match-wins): broad denies first, the
// broker re-allow after them, and the caller keeps denyNetOutboundLiterals
// last so the control-plane unix pins still beat the unix-socket allow below.
export const SEATBELT_ISOLATED_BROKER_HOST = '127.0.0.1';

export function seatbeltIsolatedNetworkRules(brokerPort) {
  const port = Number(brokerPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('seatbeltIsolatedNetworkRules: brokerPort must be a valid TCP port');
  }
  return [
    ';; network isolation: IP egress only toward the per-session broker.',
    ';; Direct connections fail closed; the broker resolves+connects',
    ';; host-side, and the proxy host is an IP literal so the sandbox',
    ';; needs no DNS of its own.',
    '(allow network-outbound (remote unix-socket))',
    '(deny network-outbound (remote tcp))',
    '(deny network-outbound (remote udp))',
    `(allow network-outbound (remote tcp "localhost:${Number(brokerPort)}"))`,
  ];
}

// Assemble the profile text. Each list holds ready-made `regex #"..."` bodies
// (see subtreeRegex) or exact-path literals. Seatbelt is last-match-wins:
// the deny lines beat the allow lines ONLY because they are emitted AFTER
// them -- keep the ordering (allows, sibling denies, re-allows, pin denies)
// when extending this profile.
//   readRegexes/writeRegexes    - allow file-read*/file-write* by pattern
//   readLiterals/writeLiterals  - allow by exact path (sockets, single files)
//   siblingDenyWriteRegexes / siblingDenyReadRegexes - deny sibling launch
//                    dirs (broad patterns covering own dir too)
//   reAllowWriteRegexes / reAllowReadRegexes - re-allow our own dir AFTER
//                    the sibling deny (last-match-wins)
//   denyWriteRegexes            - pin denies, emitted last so they beat the
//                    re-allows above
//   denyExecLiterals            - exact paths denied for process-exec
//                    (emitted after the broad process-exec allow)
//   denyNetOutboundLiterals     - unix-socket paths denied for connect()
//                    (emitted after the broad network allow; connect() is
//                    mediated as network-outbound, so file-write* pins
//                    cannot stop it)
//   networkIsolate              - null (default, historical open egress) or
//                    { brokerPort } for a strict broker-only profile (see
//                    seatbeltIsolatedNetworkRules above)
export function buildSeatbeltProfileText({
  readRegexes = [],
  readMetadataRegexes = [],
  writeRegexes = [],
  readLiterals = [],
  writeLiterals = [],
  siblingDenyWriteRegexes = [],
  siblingDenyReadRegexes = [],
  reAllowWriteRegexes = [],
  reAllowReadRegexes = [],
  denyWriteRegexes = [],
  denyExecLiterals = [],
  denyNetOutboundLiterals = [],
  runtimeDirDenyWriteRegexes = [],
  runtimeSocketAllowLiterals = [],
  networkIsolate = null,
} = {}) {
  const line = (op, sel) => `  (${op} ${sel})`;
  const regexes = (list) => list.map((r) => `(regex #"${r}")`).join(' ');
  const literals = (list) => list.map((p) => `(literal "${escapeSeatbeltLiteral(p)}")`).join(' ');
  const out = [
    '(version 1)',
    '',
    ';; deny-by-default: everything not explicitly allowed below is refused.',
    '(deny default)',
    '',
    ';; process + network. Egress stays open (agent APIs, git, tool',
    ';; provisioning) -- file scope is what this sandbox restricts.',
    '(allow process-exec process-fork)',
    ';; macOS GUI / IPC channels the sandboxed agent has no use for:',
    ';; clipboard exfil/injection, AppleScript automation, document/app',
    ';; opening, screen capture.',
    '(deny process-exec (literal "/usr/bin/osascript"))',
    '(deny process-exec (literal "/usr/bin/pbcopy"))',
    '(deny process-exec (literal "/usr/bin/pbpaste"))',
    '(deny process-exec (literal "/usr/bin/open"))',
    // These pins target Apple's fixed binary paths (no symlinks there) --
    // unlike ghPaths/controlSockDenies, no pathVariants needed. Note
    // screencapture(1) lives in /usr/sbin, not /usr/bin.
    '(deny process-exec (literal "/usr/sbin/screencapture"))',
    // Real gh binaries are denied so gh is reachable only via the PATH shim
    // (the wrapper relays to the git broker; nothing execs gh in-sandbox).
    // Seatbelt is last-match-wins (see the contract above), so these pins
    // work because they are emitted AFTER the broad process-exec allow --
    // keep every pin after the allows it must beat when extending the
    // profile.
    ...(denyExecLiterals.length > 0
      ? [`(deny process-exec ${denyExecLiterals.map((p) => `(literal "${escapeSeatbeltLiteral(p)}")`).join(' ')})`]
      : []),
    // Signals: self covers the agent process itself. Every descendant
    // inherits this same profile, so same-sandbox covers the timeout /
    // job-control kills (SIGTERM/SIGKILL to git, npm, shells...) that CLIs
    // issue in-sandbox, without opening signals to host processes outside
    // the tree. (Verify on macOS hardware: a missing allow here turns
    // child-process management into EPERM.)
    '(allow signal (target self))',
    '(allow signal (target same-sandbox))',
    // sysctl-read is NOT broadly allowed: deny-by-default, then allow-list only
    // the non-sensitive nodes the toolchain reads (list adapted from macOS's
    // own container.sb). This narrowing DOES stop the same-UID info leaks
    // Seatbelt actually mediates -- kern.bootargs is not under any allowed
    // prefix, so `(deny default)` refuses it (verified on macOS 14.8.5 arm64).
    // Two nodes DO fall under the broad prefixes -- `(sysctl-name-prefix "hw.")`
    // matches hw.ephemeral_storage and `(sysctl-name-prefix "kern.os")` matches
    // kern.osvariant_status (sysctl-name-prefix is a plain string prefix, not
    // component-wise) -- so they are re-denied by name AFTER the allow-list
    // (last-match-wins; verified they flip to EPERM on hardware). sysctl.name2oid
    // / sysctl.oidfmt are load-bearing (sysctlbyname(3) issues them first, so
    // denying them breaks every named lookup). Listing a name absent on a given
    // arch/OS is harmless. Verify on macOS hardware if this block is touched --
    // a compile error here fails closed for every launch.
    //
    // KNOWN LIMITATION (KERN_PROCARGS2): a same-UID process's full argv AND
    // environment is still readable from inside the sandbox via the numeric MIB
    // {CTL_KERN, KERN_PROCARGS2, pid}. Verified on macOS 14.8.5 arm64: NEITHER
    // (deny default) for sysctl-read NOR any (deny sysctl-read (sysctl-name
    // ...)) / (deny sysctl*) / (deny system-info) / (deny process-info*) rule
    // has any effect on that path -- the numeric-MIB procargs read is simply
    // not a Seatbelt-mediated operation on current macOS. Cross-UID is still
    // blocked (by the kernel, not the sandbox). This means a sandboxed agent
    // CAN read the ccserver server's env (CCSERVER_TOKEN / ANTHROPIC_API_KEY /
    // cloud creds), a peer session's env (its CCSANDBOX_GIT_BROKER_TOKEN,
    // messaging + meta identity tokens), and the git broker's env. bwrap's
    // --unshare-pid genuinely closes this; Seatbelt cannot. Mitigations that
    // do NOT depend on this being blocked: the git broker's allow-list is
    // repo-scoped regardless of token theft's blast radius, and secrets that
    // must be session-private should move off env entirely (see
    // docs-site sandbox/overview.md "Known limitations" and issue tracker).
    // The `kern.procargs*`-name deny below is kept only for the sysctlbyname(3)
    // spelling and as documentation -- it does nothing for the numeric MIB.
    // kern.proc* is also NOT allowed, so `ps` (which walks KERN_PROC via
    // sysctl) is refused -- but that is NOT process-list isolation:
    // `pgrep` / anything using proc_listpids() / libproc reaches every
    // same-UID pid (verified on macOS 14.8.5: `pgrep -l .` lists the full
    // process table in-sandbox). Combined with the KERN_PROCARGS2 read above,
    // a sandboxed agent enumerates every session and reads its env directly
    // -- no pid guessing needed. So the per-session broker token
    // (env-delivered) provides no isolation on macOS; the repo-scoped
    // allow-list is the only real boundary. Same posture applies to the
    // meta/messaging tokens. (Whether a targeted (deny process-info*
    // (target others)) would at least close the pgrep enumeration path
    // without breaking the toolchain is untested -- see the issue tracker.)
    `(allow sysctl-read ${[
      '(sysctl-name "sysctl.name2oid" "sysctl.proc_native")',
      '(sysctl-name-prefix "sysctl.oidfmt")',
      '(sysctl-name-prefix "hw.")',
      '(sysctl-name-prefix "machdep.")',
      '(sysctl-name-prefix "vm.")',
      '(sysctl-name-prefix "kern.os")',
      '(sysctl-name-prefix "kern.monotonicclock")',
      `(sysctl-name ${[
        'kern.argmax', 'kern.boottime', 'kern.clockrate', 'kern.hostid', 'kern.hostname',
        'kern.hv_support', 'kern.hv_vmm_present', 'kern.maxfiles', 'kern.maxfilesperproc',
        'kern.maxproc', 'kern.maxprocperuid', 'kern.maxvnodes', 'kern.memorystatus_level',
        'kern.ngroups', 'kern.ncpu', 'kern.safeboot', 'kern.saved_ids', 'kern.secure_kernel',
        'kern.smp_active', 'kern.tcsm_available', 'kern.tcsm_enable', 'kern.usrstack',
        'kern.usrstack64', 'kern.version', 'kern.waketime',
      ].map((n) => `"${n}"`).join(' ')})`,
    ].join(' ')})`,
    // Re-deny (after the allow-list, last-match-wins) the sensitive nodes that
    // the broad hw. / kern.os prefixes above would otherwise let through:
    //   - hw.ephemeral_storage / kern.osvariant_status: fingerprinting
    //     (VM/ephemeral detection, internal-build bitfield).
    //   - kern.procargs / kern.procargs2: the sysctlbyname(3) spelling only;
    //     the numeric-MIB path (see the KNOWN LIMITATION above) is unaffected.
    '(deny sysctl-read (sysctl-name "hw.ephemeral_storage") (sysctl-name "kern.osvariant_status") (sysctl-name "kern.procargs") (sysctl-name "kern.procargs2"))',
    '(allow mach-lookup)',
    // Open egress (default) or strict broker-only egress (isolated launches).
    // The isolated rules are emitted INSTEAD of the broad allow -- never in
    // addition (an extra `(allow network*)` anywhere would silently win back
    // open egress for the overlapping operation). denyNetOutboundLiterals
    // stays last in both modes so the control-plane unix pins keep beating
    // the unix-socket allow. An invalid brokerPort with networkIsolate set
    // must fail closed (seatbeltIsolatedNetworkRules throws), not silently
    // fall back to the broad allow below -- that fallback is for
    // networkIsolate genuinely being unset (isolation off).
    ...(networkIsolate
      ? seatbeltIsolatedNetworkRules(networkIsolate.brokerPort)
      : ['(allow network*)']),
    // Host control-plane unix sockets (pty-host RPC, meta broker) live under
    // hostRuntimeDir() -- inside the broad tmp write rules on darwin.
    // connect() is mediated as network-outbound (a file-write* pin cannot
    // stop it), and neither socket may be reachable from a sandboxed
    // process: the pty-host RPC accepts `spawn` with sandbox:false
    // (unsandboxed host exec) and the meta socket is the privileged meta
    // toolset's channel. NOTE: the path filter MUST be path-literal (not
    // regex/literal/subpath) -- per Apple's Sandbox Guide, unix-socket
    // network filters accept only path-literal. Emitted AFTER (allow
    // network*) per last-match-wins (verify on macOS hardware if touched:
    // a compile error here is fail-closed for every seatbelt launch).
    ...(denyNetOutboundLiterals.length > 0
      ? [`(deny network-outbound ${denyNetOutboundLiterals.map((p) => `(remote unix-socket (path-literal "${escapeSeatbeltLiteral(p)}"))`).join(' ')})`]
      : []),
    '',
    ';; devices: the pty and /dev/null etc. must stay usable.',
    '(allow file-read* file-write* (regex #"^/dev(/.*)?$"))',
    ';; the inherited controlling pty needs ioctls (isatty/tcgetattr), and',
    ';; agent tool shells / script(1) / expect allocate nested ptys.',
    '(allow pseudo-tty)',
    '(allow file-ioctl (regex #"^/dev(/.*)?$"))',
    '',
    ';; macOS requires reading the root directory itself during process',
    ';; startup (path resolution touches "/" as a directory); without this,',
    ';; every child dies at startup and sandbox-exec surfaces it as an abort',
    ';; (see docs/seatbelt-root-read-abort-diagnosis.md). This grants only the',
    ';; root directory entry, not any tree underneath it.',
    '(allow file-read* (literal "/"))',
    '',
  ];
  if (readMetadataRegexes.length > 0) {
    // Ancestor directories of the allowed trees: userspace realpath/lstat walks
    // every path component, and Seatbelt mediates each. These need only
    // file-read-metadata (stat/lstat/access) -- NOT file-read-data, which on a
    // directory is readdir(). Emitting them here (before the file-read* allow)
    // means an ancestor that is ALSO a genuine read tree still gets the wider
    // grant, while a bare ancestor (e.g. the real $HOME above the agent config
    // dirs) stays un-listable.
    out.push(';; ancestor directories: metadata only (path resolution, not readdir).', line('allow file-read-metadata', regexes(readMetadataRegexes)), '');
  }
  if (readRegexes.length > 0 || readLiterals.length > 0) {
    const sels = [regexes(readRegexes), literals(readLiterals)].filter(Boolean).join(' ');
    out.push(';; readable trees and files (system, project, tooling, scripts).', line('allow file-read*', sels), '');
  }
  if (writeRegexes.length > 0 || writeLiterals.length > 0) {
    const sels = [regexes(writeRegexes), literals(writeLiterals)].filter(Boolean).join(' ');
    out.push(';; writable trees and files (project, sandbox HOME, sockets).', line('allow file-write*', sels), '');
  }
  // POSIX ERE (AppleMatch) has no lookahead: express sibling exclusion as
  // "deny all launch dirs -> re-allow our own (last-match-wins) -> pins".
  if (siblingDenyWriteRegexes.length > 0) out.push(line('deny file-write*', regexes(siblingDenyWriteRegexes)), '');
  if (siblingDenyReadRegexes.length > 0) out.push(line('deny file-read*', regexes(siblingDenyReadRegexes)), '');
  if (reAllowWriteRegexes.length > 0) out.push(line('allow file-write*', regexes(reAllowWriteRegexes)), '');
  if (reAllowReadRegexes.length > 0) out.push(line('allow file-read*', regexes(reAllowReadRegexes)), '');
  if (denyWriteRegexes.length > 0) {
    out.push(
      ';; pin denies (emitted last so they beat the re-allows above):',
      ';; raw keys / gh tokens stay behind the git broker.',
      line('deny file-write*', regexes(denyWriteRegexes)),
      '',
    );
  }
  // Host runtime dir (hostRuntimeDir(): the /tmp base on darwin that holds
  // every session's control-plane sockets). The broad `^/tmp(/.*)?$` write
  // allow above would otherwise leave the dir itself writable: a sandboxed
  // process runs as the server's uid and owns it, and macOS sticky-bit does
  // not stop an owner renaming/rmdir'ing its own entry -- so the agent could
  // `rename()` the whole dir away and make EVERY other session's pty-host /
  // meta / notify / usage / reviewer socket resolve to nothing (server-wide
  // DoS from one sandbox). Deny-write the whole tree, then re-allow only the
  // exact sockets this session legitimately connect()s to (connect() is
  // mediated as file-write* on the socket path). pty-host / meta stay denied
  // -- they are never in the re-allow list.
  if (runtimeDirDenyWriteRegexes.length > 0) {
    out.push(
      ';; host runtime dir: deny-write the tree (rename/rmdir DoS), keep only',
      ';; the sockets this session connect()s to reachable.',
      line('deny file-write*', regexes(runtimeDirDenyWriteRegexes)),
      '',
    );
    if (runtimeSocketAllowLiterals.length > 0) {
      out.push(line('allow file-write*', literals(runtimeSocketAllowLiterals)), '');
    }
  }
  return out.join('\n');
}

function expandAgainstHome(p, hostHome) {
  if (p === '~') return hostHome;
  if (p.startsWith('~/')) return join(hostHome, p.slice(2));
  return p;
}

// Full darwin launch assembly (mirrors buildBwrapArgs' recipe, translated
// from binds to allow-rules). All host paths are directly visible inside the
// sandbox, so "binds" become Seatbelt allow entries and fixed in-sandbox
// paths become host paths (sockets, shims, hooks dir).
//
//   cwd            - project dir (resolved here)
//   hostHome       - the real host $HOME (config/agent dirs live under it)
//   homeDir        - effective sandbox HOME, or null for a throwaway dir
//                    created inside the runtime dir (single teardown unit)
//   sandboxPathBase- SANDBOX_PATH value from sandbox.js
//   nodeBin        - host node binary (realpath of process.execPath)
//   scripts        - { ghWrapper, credHelper, sshWrapper, commitHook,
//                    entrypoint, mcpBridge }: every host file this launch
//                    executes/reads inside the sandbox, allow-listed as
//                    exact literals (parity with bwrap's per-file ro-binds)
//   ssh            - { realSsh|null, configFile, knownHostsDefault, userKnownHosts|null }
//   gitBroker      - { sockPath, allowlistPath, dir } | null
//   commitGuard    - { configPath } | null
//   sockets        - { mcp, notify, usage, meta, reviewer } host paths | null
//   extraBinds/extraEnv - raw operator config (binds become allow rules;
//                    ~/.ssh and ~/.config/gh stay blocked, like bwrap)
//   authSock       - forwarded ssh-agent socket | null
//   gnupg          - true to expose the host ~/.gnupg keyring (opt-in, like
//                    bwrap's gpg flag) with GNUPGHOME pointed at it ($HOME
//                    inside is the sandbox home, so gpg needs the override)
//   app            - agent id ('claude' | 'opencode' | 'copilot' | 'codex' |
//                    'commandcode') | null: opencode sessions get the host
//                    XDG dirs (see env below); other apps resolve their
//                    config from the sandbox HOME as before
//   claudeDir      - extra agent install dir | null
//   orchestratorClaudeMdSrc / gitCommonDir / groupFilesDir - like bwrap
//   tools          - resolved opt-in tool specs | null. Call-shape parity
//                    only: rtk/CRG provisioning is bwrap-only (mount-bound
//                    provisioner) and every caller strips the flags before
//                    passing this -- nothing reads it here.
//   ghPaths        - real gh binary candidates (from sandbox.js, same set
//                    buildBwrapArgs ro-binds the wrapper over): denied for
//                    process-exec while the git broker is on, so gh is
//                    reachable only via the PATH shim
//   controlSockDenies - host control-plane unix-socket paths (pty-host RPC,
//                    meta broker, from sandbox.js): denied for
//                    network-outbound connect() -- file-write* pins cannot
//                    stop connect(), and both sockets live inside the broad
//                    tmp write rules on darwin
//   hostRuntimeDir - git-broker.js's hostRuntimeDir() (the short /tmp base on
//                    darwin holding every session's control-plane sockets):
//                    the whole tree is deny-written so a sandboxed process
//                    cannot rename/rmdir it and break other sessions' control
//                    plane, with only this session's own sockets re-allowed
//   networkBroker  - { port, token } | null (see network-broker.js): when set
//                    the profile switches to broker-only IP egress (see
//                    seatbeltIsolatedNetworkRules) and HTTP(S)_PROXY points at
//                    the loopback broker. Null keeps historical open egress.
//                    Raw non-proxy TCP (direct curl without the proxy env,
//                    direct ssh) fails closed while set -- intended.
//
// Returns { dir, profilePath, binDir, hooksDir, homeDir, ruleCopies,
// overlayFiles, nodeBin, env }. `dir` is the single teardown unit (also
// covers the throwaway HOME when homeDir was null). ruleCopies lists
// orchestrator rule files THIS launch created, overlayFiles every overlay
// path it uses (incl. pre-existing siblings' files -- the teardown guard's
// input) -- both NOT under `dir`, so the caller must remove them separately
// on teardown (null when no overlay was requested).
export function buildSeatbeltLaunch({
  cwd,
  hostHome,
  homeDir = null,
  sandboxPathBase,
  nodeBin,
  scripts,
  ssh = {},
  gitBroker = null,
  commitGuard = null,
  sockets = {},
  mcpToken = null,
  extraBinds = [],
  extraEnv = {},
  authSock = null,
  gnupg = false,
  app = null,
  claudeDir = null,
  orchestratorClaudeMdSrc = null,
  gitCommonDir = null,
  groupFilesDir = null,
  tools = null,
  ghPaths = [],
  controlSockDenies = [],
  hostRuntimeDir = null,
  networkBroker = null,
}) {
  // Defense in depth behind buildSandboxSpawn / sessionManager's cwd='/'
  // refusal: a projectDir of "/" makes subtrees('/') compile to "^/(/.*)?$",
  // silently granting file-read*/file-write* over the whole filesystem (a
  // fail-open sandbox). buildMinimalSeatbeltSpawn's /usage + /codex-usage
  // callers pin a fixed non-root cwd, but guard the shared primitive so a new
  // caller can't reintroduce the hole. See docs/seatbelt-root-read-abort-diagnosis.md.
  if (resolve(cwd) === '/') {
    throw new Error('Cannot build a seatbelt sandbox for the filesystem root (/) -- the project rule would grant the whole filesystem.');
  }
  const launchId = randomUUID();
  // The launch dir holds the in-sandbox XDG_RUNTIME_DIR (`<dir>/runtime`, see
  // env below). Tools bind unix sockets directly under $XDG_RUNTIME_DIR
  // (gpg-agent, tmux, `ssh -o ControlPath=%d/...`), and sockaddr_un.sun_path
  // caps the whole path at ~104 bytes on darwin. The per-user $TMPDIR base
  // (/var/folders/<...>/T, ~49 chars) plus a full-UUID leaf already pushes
  // `<dir>/runtime` past that -- every such bind then fails ENAMETOOLONG
  // (git-broker.js's hostRuntimeDir() picks a short /tmp base for exactly
  // this reason). Keep the launch dir a single teardown unit but give it a
  // short leaf so the runtime dir underneath stays inside the limit.
  const shortId = launchId.replace(/-/g, '').slice(0, 12);
  const dir = join(seatbeltBaseDir(), `ccserver-sb-${shortId}`);
  const binDir = join(dir, 'bin');
  const hooksDir = join(dir, 'hooks');
  const profilePath = join(dir, 'sandbox.sb');
  // The caller only learns `dir` on a successful return, so any throw
  // between here and the return at the bottom would leak the minted dir
  // under $TMPDIR. Remove it (and any rule copies made so far) before
  // rethrowing -- still fail-closed.
  const ruleCopies = [];
  const overlayFiles = [];
  // Every overlay path this launch uses (including pre-existing ones owned by
  // a live sibling). Returned as `overlayFiles` for the stillReferenced
  // teardown guard: a successor that sees the overlay as pre-existing must
  // still register it, or the owner's later teardown unlinks the live
  // successor's rules mid-session (#9). `ruleCopies` stays ownership-only
  // (this launch created them) for the build-failure catch below, which must
  // not delete a live sibling's overlay.
  // Per-launch memo for the blocking fs probes below (#8): the same anchor
  // paths are pinned a dozen times while one profile is assembled
  // (read + write + ancestor lists). Scoped to this launch -- never shared
  // across launches -- so a path that appears mid-run (broker sockets,
  // runtime dirs) is always probed fresh on the next launch.
  const pathCache = new Map();
  const memoVariants = (p) => pathVariants(p, pathCache);
  const memoSubtrees = (p) => subtrees(p, pathCache);
  const memoDeep = (p) => pathVariantsDeep(p, pathCache);
  const memoAncestors = (paths) => ancestorExactRegexes(paths, pathCache);
  try {
    // 0o700 like git-broker's dir: shims/hook/profile must be private to
    // this launch -- sandbox.sb reveals host paths, and a same-UID session
    // sharing the base dir must not reach them. Inside the try so a failure
    // here is cleaned up like every later throw (see the catch below).
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(binDir, { recursive: true, mode: 0o700 });
    mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
    // resolve() normalizes spelling but not symlinks (same reason tmpDirs
    // carries the realpath of tmpdir()): rules below register both spellings
    // via subtrees() so a symlinked cwd still matches -- and denies hold.
    // The XDG_RUNTIME_DIR override (see env below) must exist before the
    // entrypoint's mkdir -p runs -- and before any tool reads it.
    mkdirSync(join(dir, 'runtime'), { recursive: true, mode: 0o700 });

    const projectDir = resolve(cwd);
    // Throwaway HOME (minimal/usage sandboxes, or persistentHome off): lives
    // inside the runtime dir so teardown stays a single rm -rf.
    const effectiveHome = homeDir || join(dir, 'home');
    if (!homeDir) mkdirSync(effectiveHome, { recursive: true });

    // --- shims ---------------------------------------------------------------
    // Quote for /bin/sh double quotes: paths here derive from server-side
    // constants and runtime dirs, but never interpolate them raw -- a `"`/`$`
    // in $TMPDIR today would otherwise break out of the exec line.
    const shQuote = (s) => `"${String(s).replace(/(["$`\\])/g, '\\$1')}"`;
    // credential.helper is not a free-form shell command string the way
    // GIT_SSH_COMMAND is: git (credential_do) classifies the value as a
    // `!`-shell command, an absolute path, or a helper NAME (`git
    // credential-"<value>"`, which never executes). A leading `"` would
    // fall into the NAME class. The value IS still shell-parsed at
    // execution time (run_credential_helper spawns `sh -c "<value> <op>"`,
    // use_shell=1) -- which is exactly why bare-word backslash escaping
    // (`/a\ b/c`, leading `/` keeps the path class) works and a raw
    // unescaped path with spaces would not.
    //
    // A newline is the one char this cannot escape: `sh` treats backslash +
    // newline as a line continuation and splices it out, silently corrupting
    // the value. The only value passed here is an internal launch-dir path
    // (join(binDir, ...)), which can't contain one -- throw if that ever
    // changes rather than emit a broken helper line.
    const shEscapeWord = (s) => {
      const str = String(s);
      if (/[\n\r]/.test(str)) throw new Error('shEscapeWord: value contains a newline (would become a line continuation under sh -c)');
      return str.replace(/[^A-Za-z0-9_@%+=:,./-]/g, '\\$&');
    };
    const shim = (name, target) => {
      const p = join(binDir, name);
      writeFileSync(p, `#!/bin/sh\nexec ${shQuote(nodeBin)} ${shQuote(target)} "$@"\n`, { mode: 0o755 });
      return p;
    };
    let sshShim = null;
    let credHelperShim = null;
    if (gitBroker) {
      // The `gh` shim is reached via the PATH prepend (binDir is first), so no
      // reference is needed here -- unlike the ssh/credential-helper shims,
      // which are pointed at by absolute-path env (GIT_SSH_COMMAND / helper).
      shim('gh', scripts.ghWrapper);
      credHelperShim = shim('ccserver-git-credential-helper', scripts.credHelper);
      if (ssh.realSsh) sshShim = shim('ccserver-git-ssh', scripts.sshWrapper);
      // bwrap binds the ssh wrapper OVER the real ssh binary's path, so a
      // plain `ssh` resolution passes the allowlist gate (the real binary
      // stays reachable there too via $CCSANDBOX_REAL_SSH -- same bypass
      // class). Seatbelt has no mounts: the PATH-prepended binDir is the
      // closest equivalent, so cover plain `ssh` resolution too. An
      // absolute-path launch of the real ssh still bypasses the gate
      // (documented in docs-site).
      if (ssh.realSsh) shim('ssh', scripts.sshWrapper);
    }
    // The shared sandbox-ssh-config pins UserKnownHostsFile at bwrap's fixed
    // in-sandbox paths, which no mount provides here -- every host would
    // fail StrictHostKeyChecking. Emit a seatbelt variant pointing at the
    // host known_hosts paths (registered as read literals below). Only a
    // brokered launch consumes it (CCSANDBOX_SSH_CONFIG / GIT_SSH_COMMAND /
    // the ssh shims are wired under gitBroker), so minimal launches
    // (usage capture, gitBroker: null) must not mint it.
    let sshConfigPath = ssh.configFile;
    let knownHostsCopy = null;
    if (gitBroker && ssh.realSsh) {
      // UserKnownHostsFile is a whitespace-separated list with no quoting:
      // the server-tree default known_hosts (the install dir may contain
      // spaces) must live at a space-free path. Copy it into the launch dir
      // (under tmpdir, never spaced on macOS). ~/.ssh/known_hosts needs no
      // copy: macOS HOME paths never contain spaces.
      if (ssh.knownHostsDefault) {
        try {
          copyFileSync(ssh.knownHostsDefault, join(dir, 'known-hosts'));
          knownHostsCopy = join(dir, 'known-hosts');
        } catch { /* no known_hosts -> /dev/null (fail-closed) */ }
      }
      sshConfigPath = join(dir, 'ssh-config');
      writeFileSync(sshConfigPath, [
        '# Seatbelt variant of sandbox-ssh-config: same skip-system-config',
        '# posture, but UserKnownHostsFile uses host paths (there are no',
        "# mounts to provide bwrap's fixed in-sandbox paths).",
        'Host *',
        `\tUserKnownHostsFile ${[ssh.userKnownHosts, knownHostsCopy].filter(Boolean).join(' ') || '/dev/null'}`,
        '\tStrictHostKeyChecking yes',
        '',
      ].join('\n'), { mode: 0o600 });
    }
    if (commitGuard) {
      const p = join(hooksDir, 'commit-msg');
      writeFileSync(p, `#!/bin/sh\nexec ${shQuote(nodeBin)} ${shQuote(scripts.commitHook)} "$@"\n`, { mode: 0o755 });
    }

    // --- env (via /usr/bin/env, since sandbox-exec has no --setenv) ----------
    const hostLocalBin = join(hostHome, '.local', 'bin');
    const env = {
      HOME: effectiveHome,
      // CoreFoundation resolves the home dir (NSHomeDirectory, and hence
      // NSCachesDirectory / Application Support / Preferences / ~/Library) from
      // getpwuid, NOT $HOME -- so Objective-C/Swift tools (Xcode toolchain,
      // xcrun, CocoaPods, SwiftPM, `defaults`) would otherwise read+write the
      // REAL ~/Library/Caches, forcing it onto the allow-list and sharing it
      // with the host. CFFIXED_USER_HOME overrides that resolution (the same
      // hook the iOS simulator / sandboxed-app containers use), so those tools
      // land under the sandbox HOME like everything $HOME-based already does.
      // Completes the HOME remap; no host ~/Library/* stays reachable for it.
      CFFIXED_USER_HOME: effectiveHome,
      // bwrap sets XDG_RUNTIME_DIR via --setenv (hostRuntimeDir()). Without an
      // override the shared entrypoint defaults it to /run/user/<uid>, which
      // does not exist on macOS and is not writable under this profile. A
      // per-launch dir inside `dir` is always writable and torn down with the
      // rest (the entrypoint's mkdir -p succeeds there).
      XDG_RUNTIME_DIR: join(dir, 'runtime'),
      PATH: [binDir, join(effectiveHome, '.local', 'bin'), hostLocalBin, sandboxPathBase,
        '/opt/homebrew/bin', '/opt/homebrew/sbin'].join(':'),
      CCSANDBOX_DOCKER: '0',
    };
    if (sockets.mcp) env.CCSANDBOX_MCP_SOCK = sockets.mcp;
    // Connection token for the group control / handoff socket: the shared /tmp
    // runtime dir is reachable by every concurrent sandboxed session here, so
    // without this the bridge could not authenticate to its own broker (and a
    // peer session could reach it). See mcpBroker.js's requireToken.
    if (sockets.mcp && mcpToken) env.CCSANDBOX_MCP_TOKEN = mcpToken;
    // Seatbelt has no mounts: there is no /ccserver-group-files. Expose the
    // host blob dir the established way (env, like the socket paths) so tool
    // responses can one day report a path that actually resolves. NOTE: the
    // group_files tools still return the fixed /ccserver-group-files path, so
    // receiving shared files does NOT work on macOS seatbelt yet (see docs).
    if (groupFilesDir) env.CCSANDBOX_GROUP_FILES_DIR = groupFilesDir;
    if (authSock) env.SSH_AUTH_SOCK = authSock;
    if (gnupg) env.GNUPGHOME = join(hostHome, '.gnupg');
    // HOME is remapped to the sandbox home, so $HOME-relative config resolution
    // would miss the real auth/state (bwrap instead overlays the real dirs at
    // the real $HOME path). Point the CLIs that support it at the real dirs.
    // opencode resolves config/data/state via $HOME-relative XDG dirs and
    // copilot/commandcode resolve via $HOME (no env override exists) -- under
    // seatbelt they see the sandbox home, so their login / model / --continue
    // state does NOT carry over from the host (unlike bwrap, where $HOME IS the
    // host home path with the persistent home mounted there). See docs-site.
    //
    // NOT gated on existsSync: gating meant a host that had never run `claude` /
    // `codex` outside ccserver got no CLAUDE_CONFIG_DIR / CODEX_HOME, so their
    // config + credentials resolved against the throwaway sandbox HOME and every
    // launch demanded a fresh login -- and the host dir was never created, so it
    // never self-healed. The dirs are mkdir'd on the host by buildSandboxSpawn /
    // buildMinimalSandboxSpawn before the launch (this function never writes
    // outside its own runtime dir); pointing the env at a not-yet-created dir is
    // harmless (it is allow-listed read+write in the profile via appConfigDirs).
    const hostClaudeDir = join(hostHome, '.claude');
    env.CLAUDE_CONFIG_DIR = hostClaudeDir;
    // The macOS login Keychain (Claude's primary credential store on darwin) is
    // unreachable under this profile -- ~/Library/Keychains is not allow-listed
    // and `security` reports errSecNoDefaultKeychain / "authorization denied".
    // Claude falls back to a plaintext <configDir>/.credentials.json, and its
    // store resolves that path from CLAUDE_SECURESTORAGE_CONFIG_DIR *first*
    // (before CLAUDE_CONFIG_DIR); set it explicitly so the credential file
    // unambiguously lands in the host ~/.claude and persists across launches.
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = hostClaudeDir;
    env.CODEX_HOME = join(hostHome, '.codex');
    // opencode resolves config/data/state via $HOME-relative XDG dirs (no
    // dedicated override like CLAUDE_CONFIG_DIR exists), so point the XDG
    // base dirs at the host ones: login (auth.json under share), model/state
    // memory and --continue history then carry over from the host, like the
    // bwrap appBinds. Gated on existence so a host that never ran opencode
    // keeps a sandbox-local (throwaway/persistent-HOME) setup instead of
    // materializing host dirs from inside the sandbox. The profile already
    // allows these three host trees read+write (see appConfigDirs); other
    // tools resolving XDG dirs stay fail-closed because only the opencode
    // subtrees are allow-listed -- notably host ~/.config/git stays denied,
    // so sandboxed git keeps the sandbox gitconfig + broker pins.
    if (app === 'opencode') {
      const xdg = [
        ['XDG_CONFIG_HOME', join(hostHome, '.config')],
        ['XDG_DATA_HOME', join(hostHome, '.local', 'share')],
        ['XDG_STATE_HOME', join(hostHome, '.local', 'state')],
      ];
      const opencodeDir = {
        XDG_CONFIG_HOME: join(hostHome, '.config', 'opencode'),
        XDG_DATA_HOME: join(hostHome, '.local', 'share', 'opencode'),
        XDG_STATE_HOME: join(hostHome, '.local', 'state', 'opencode'),
      };
      for (const [key, base] of xdg) {
        if (existsSync(opencodeDir[key])) env[key] = base;
      }
    }

    // GIT_CONFIG_COUNT merges credential.helper (gitBroker) and core.hooksPath
    // (commitGuard) into one env mechanism -- same rule as buildBwrapArgs'
    // comment: a future feature reusing it must extend the count here.
    const gitConfigKeys = [];
    if (gitBroker) {
      env.CCSANDBOX_GIT_BROKER_SOCK = gitBroker.sockPath;
      env.CCSANDBOX_GIT_ALLOWLIST = gitBroker.allowlistPath;
      // Per-session token for the broker connection (git-broker.js): the socket
      // shares a /tmp dir with every concurrent session's broker here.
      if (gitBroker.token) env.CCSANDBOX_GIT_BROKER_TOKEN = gitBroker.token;
      env.GIT_CONFIG_NOSYSTEM = '1';
      if (ssh.realSsh) {
        env.CCSANDBOX_REAL_SSH = ssh.realSsh;
        env.CCSANDBOX_SSH_CONFIG = sshConfigPath;
        // git runs this through sh -c: quote the shim path so spaces in
        // $TMPDIR / CCSERVER_SANDBOX_SEATBELT_TMP cannot split it.
        env.GIT_SSH_COMMAND = shQuote(sshShim);
      }
      // Reset the helper list FIRST. bwrap ro-binds GENERATED_GITCONFIG over
      // ~/.gitconfig and so fully replaces a user-defined helper; there is no
      // mount here, so credential.helper only rides GIT_CONFIG_KEY_* -- and
      // git's multi-valued semantics make that an APPEND, not a replace. A
      // persistent HOME that once ran `git config --global credential.helper
      // store` during a gitBroker:false session (no .gitconfig write-pin
      // then) would otherwise end up with an effective list of
      // [store, broker-shim]: after a successful fetch git calls `approve` on
      // every helper, `store` writes the broker's (repo-unscoped) token to
      // ~/.git-credentials, and the agent -- which can read it -- then has an
      // any-repo github.com credential. An empty-string credential.helper
      // clears every helper read from .gitconfig / .config/git/config / repo
      // .git/config that came before; the two entries below then re-establish
      // only the broker shim.
      gitConfigKeys.push(['credential.helper', '']);
      // useHttpPath is supplied by the ro-bound GENERATED_GITCONFIG on the
      // bwrap path; there is no mount here, so it rides GIT_CONFIG too.
      // Without it git drops the path from the credential description and
      // the broker's host+path allowlist match always denies.
      gitConfigKeys.push(['credential.useHttpPath', 'true']);
      // NOT shell-quoted: git treats a leading `"` as a helper name and never
      // executes the helper. Backslash-escape as a bare word instead.
      gitConfigKeys.push(['credential.helper', shEscapeWord(credHelperShim)]);
    }
    if (commitGuard) {
      env.CCSANDBOX_COMMIT_GUARD_CONFIG = commitGuard.configPath;
      gitConfigKeys.push(['core.hooksPath', hooksDir]);
    }
    if (gitConfigKeys.length > 0) {
      env.GIT_CONFIG_COUNT = String(gitConfigKeys.length);
      gitConfigKeys.forEach(([k, v], i) => {
        env[`GIT_CONFIG_KEY_${i}`] = k;
        env[`GIT_CONFIG_VALUE_${i}`] = v;
      });
    }

    // NOTE: `tools` (rtk / code-review-graph provisioning) is accepted for
    // call-shape parity with buildBwrapArgs but is bwrap-only there: rtk is
    // stripped by buildSandboxSpawn's darwin branch and CRG by its
    // "no mounts -> no /ccserver-sandbox-provision.sh" warning, while
    // buildMinimalSandboxSpawn passes null. Nothing provision-related is
    // read or emitted here.

    // Network isolation (see network-broker.js + seatbeltIsolatedNetworkRules
    // above): the broker lives on host loopback, directly reachable since
    // seatbelt is unsandboxed at the network layer. Same shared proxy-env
    // builder as the bwrap backend; operator extraEnv below still wins on
    // conflict (deliberate operator override, like bwrap).
    if (networkBroker && Number.isInteger(networkBroker.port) && networkBroker.token) {
      Object.assign(env, buildIsolatedProxyEnv({
        host: SEATBELT_ISOLATED_BROKER_HOST,
        port: networkBroker.port,
        token: networkBroker.token,
      }));
    }

    // Operator env last, so it overrides the defaults above (like bwrap).
    for (const [k, v] of Object.entries(extraEnv || {})) {
      if (typeof k === 'string' && k) env[k] = expandAgainstHome(String(v), hostHome);
    }

    // --- profile allow/deny lists (binds translated to rules) ----------------
    const readRegexes = [
      '^/usr(/.*)?$', '^/bin(/.*)?$', '^/sbin(/.*)?$', '^/etc(/.*)?$',
      '^/System(/.*)?$', '^/Library(/.*)?$', '^/opt(/.*)?$',
      '^/private/etc(/.*)?$', '^/private/var(/.*)?$', '^/var(/.*)?$',
      '^/tmp(/.*)?$', '^/private/tmp(/.*)?$',
    ...memoSubtrees(projectDir),
    ...memoSubtrees(effectiveHome),
    ...memoSubtrees(dir),
    // Only the individual host files this launch executes/reads -- parity
    // with bwrap's per-file ro-binds. A serverDir subtree would expose the
    // whole server implementation to the sandboxed agent (open egress +
    // prompt injection make that reconnaissance material).
    ...[scripts.entrypoint, scripts.mcpBridge, scripts.ghWrapper,
      scripts.credHelper, scripts.sshWrapper, scripts.commitHook]
      .filter(Boolean).flatMap((f) => memoVariants(f).map((p) => `^${escapeSeatbeltRegex(p)}$`)),
    ...memoSubtrees(hostLocalBin),
  ];
    const tmpDirs = new Set([tmpdir()]);
    try { tmpDirs.add(realpathSync(tmpdir())); } catch { /* best effort */ }
    for (const t of tmpDirs) {
      const r = subtreeRegex(t);
      if (!readRegexes.includes(r)) readRegexes.push(r);
    }
    // Agent config dirs keep working when a CLI resolves the real home via
    // macOS APIs instead of $HOME (mirrors buildBwrapArgs' appBinds). Regexes
    // for absent paths are harmless, so no existsSync gating is needed.
    // NOTE: these need read as well as write (bwrap binds them rw) -- Seatbelt
    // file-write* does not imply file-read*, so a write-only entry would leave
    // CLIs unable to read back the auth/state they just wrote.
    const appConfigDirs = agentConfigDirs(hostHome);
    // Ancestor metadata (lstat) for userspace realpath: node/vite/npm/git and
    // the agent CLIs resolve paths component-by-component, and subtree rules
    // don't cover the ancestors themselves. Exact-match only -- siblings stay
    // closed. Bases mirror every tree a tool resolves within: project, sandbox
    // HOME, launch dir, tmp, node binary, AND the host home + agent config
    // dirs (CLAUDE_CONFIG_DIR / CODEX_HOME / the opencode XDG dirs all live
    // under hostHome -- without hostHome's ancestors a throwaway-HOME launch on
    // a host whose node lives outside $HOME EPERMs on lstat '/Users/<user>'
    // the moment Claude reads ~/.claude/.credentials.json).
    //
    // The node-based shims (gh / credential-helper / ssh / commit-hook / MCP
    // bridge) are `#!/bin/sh exec <node> <serverdir>/server/ws/*.cjs`: node's
    // module loader realpathSync's that script path, lstat-walking
    // <serverdir> and its parents. Those are NOT the exact `.cjs` pins above
    // (which cover open(), not the ancestor lstat), so without their
    // ancestors here every shim dies with `EPERM lstat '<serverdir>'` unless
    // the server happens to sit under a broadly-read tree (/opt, /usr/local).
    // Exact-match only, like every other ancestor -- the server tree's
    // contents stay closed. file-read-METADATA, not file-read*: resolution
    // needs lstat on each component, never readdir. Without the split a bare
    // ancestor like the real $HOME (above ~/.claude etc.) is listable, so a
    // throwaway-HOME /usage capture could `ls ~` and enumerate the host home.
    const readMetadataRegexes = memoAncestors([
      projectDir, effectiveHome, dir, ...tmpDirs, nodeBin, hostHome, ...appConfigDirs,
      ...[scripts.entrypoint, scripts.mcpBridge, scripts.ghWrapper,
        scripts.credHelper, scripts.sshWrapper, scripts.commitHook].filter(Boolean),
    ]);
    // NOTE: host ~/Library/Caches is deliberately NOT allow-listed -- CFFIXED_USER_HOME
    // (see env) redirects the macOS-API cache/Library resolution into the sandbox
    // HOME, so nothing needs the host copy. (Xcode/SwiftPM-heavy workflows that
    // want the host DerivedData/package cache can add a targeted operator bind.)
    readRegexes.push(...appConfigDirs.flatMap(memoSubtrees));
    // gpg opt-in (bwrap binds ~/.gnupg): with no mounts, allow the real
    // keyring and point gpg at it ($HOME here is the sandbox home).
    const gnupgHome = gnupg ? join(hostHome, '.gnupg') : null;
    if (gnupgHome) readRegexes.push(...memoSubtrees(gnupgHome));
    const writeRegexes = [
      ...memoSubtrees(projectDir),
      ...memoSubtrees(effectiveHome),
      // Only the mutable part of the runtime dir is writable. bin/ (gh/ssh/
      // credential-helper shims), hooks/ (the core.hooksPath target) and
      // sandbox.sb must stay read-only -- bwrap ro-binds their equivalents at
      // fixed paths, and a writable shim is attacker-chosen code on the next
      // git/gh/commit invocation.
      ...memoSubtrees(join(dir, 'runtime')),
      '^/tmp(/.*)?$', '^/private/tmp(/.*)?$',
      // host ~/Library/Caches intentionally absent: CFFIXED_USER_HOME points the
      // macOS-API cache dir at <sandbox HOME>/Library/Caches, already writable
      // via subtrees(effectiveHome).
      ...appConfigDirs.flatMap(memoSubtrees),
    ];
    for (const t of tmpDirs) {
      const r = subtreeRegex(t);
      if (!writeRegexes.includes(r)) writeRegexes.push(r);
    }
    if (gnupgHome) writeRegexes.push(...memoSubtrees(gnupgHome));
    if (claudeDir && existsSync(claudeDir)) readRegexes.push(...memoSubtrees(claudeDir));
    // The shims, the commit-msg hook and the MCP bridge all exec through the
    // host node binary: guarantee the binary FILE stays readable (dyld reads it
    // to exec) even when it lives outside the default trees (nvm/Volta/fnm under
    // $HOME). bwrap ro-binds just the file (SANDBOX_NODE_PATH), not its dir --
    // match that: `subtrees(dirname(nodeBin))` would expose every unrelated tool
    // in a shared bin dir (/usr/local/bin, ~/.local/bin). Ancestors are already
    // covered (metadata) by ancestorExactRegexes above; both spellings here.
    if (nodeBin) readRegexes.push(...memoVariants(nodeBin).map((p) => `^${escapeSeatbeltRegex(p)}$`));
    if (gitCommonDir) {
      readRegexes.push(...memoSubtrees(gitCommonDir));
      writeRegexes.push(...memoSubtrees(gitCommonDir));
    }
    if (groupFilesDir) readRegexes.push(...memoSubtrees(groupFilesDir));

    const readLiterals = [];
    const writeLiterals = [];
    const sockPaths = [sockets.mcp, sockets.notify, sockets.usage, sockets.meta, sockets.reviewer]
      .filter(Boolean);
    if (gitBroker) sockPaths.push(gitBroker.sockPath);
    // A forwarded ssh-agent socket needs an explicit rule: connect() is a
    // write, and custom locations (e.g. 1Password's ~/Library socket) fall
    // outside every allow tree above. Both spellings (see pathVariants).
    if (authSock) sockPaths.push(...memoVariants(authSock));
    for (const s of new Set(sockPaths)) {
      readLiterals.push(s);
      writeLiterals.push(s); // connect() needs write
    }
    if (gitBroker) readLiterals.push(gitBroker.allowlistPath);
    if (commitGuard) readLiterals.push(commitGuard.configPath);
    // Both spellings (see pathVariants): a server tree or HOME under a
    // symlink would otherwise read-deny these via the other spelling.
    // (The server-tree knownHostsDefault needs no literal: it is copied into
    // the launch dir when the brokered ssh config is minted, and that dir
    // is readable via subtrees(dir) above.)
    if (ssh.userKnownHosts) readLiterals.push(...memoVariants(ssh.userKnownHosts));
    // The per-launch seatbelt ssh config above (or the shared file when no
    // real ssh exists, kept for completeness though nothing reads it then).
    // Only brokered launches mint (and read) the per-launch copy.
    if (gitBroker && sshConfigPath) readLiterals.push(...memoVariants(sshConfigPath));
    if (orchestratorClaudeMdSrc) readLiterals.push(...memoVariants(orchestratorClaudeMdSrc));

    // Every deny pin must cover both spellings Seatbelt may see: under the
    // per-user TMPDIR, macOS resolves /var/... to /private/var/..., and a
    // pin built from a not-yet-existing file (profile, .gitconfig) would
    // silently keep only the raw spelling via pathVariants(). Derive both
    // spellings from the existing parent dir instead.
    const exactPins = (name, existingParent) =>
      memoVariants(existingParent).map((p) => `^${escapeSeatbeltRegex(join(p, name))}$`);
    // Sibling launch-dir denies need both spellings of the base dir as
    // well. POSIX ERE has no lookahead: deny ALL launch dirs (own
    // included), then re-allow our own subtree afterwards
    // (last-match-wins). Future sibling dirs stay covered by the deny.
    const siblingDeny = memoVariants(seatbeltBaseDir()).map((base) =>
      `^${escapeSeatbeltRegex(base)}/ccserver-sb-`);
    const ownReAllow = memoSubtrees(dir);
    // Raw keys / gh tokens are never reachable (mirrors bwrap's
    // BLOCKED_BIND_PATHS, unconditionally even with gitBroker off).
    const denyWriteRegexes = [
      ...memoSubtrees(join(hostHome, '.ssh')),
      ...memoSubtrees(join(hostHome, '.config', 'gh')),
      // With the git broker on, the sandbox HOME's gitconfig stays
      // unwritable (bwrap ro-binds GENERATED_GITCONFIG over it for the same
      // reason): an agent-written credential.helper there would otherwise
      // receive broker-issued tokens via `credential store`, exfiltrating
      // them past the allowlist. git also reads ~/.config/git/config
      // (checked BEFORE ~/.gitconfig): without this deny the .gitconfig pin
      // is trivially bypassed. With gitBroker off there are no
      // broker-issued tokens to steal and bwrap leaves both files
      // agent-writable -- match it, so `git config --global` keeps working
      // in a persistent HOME. (Repo-local .git/config and GIT_CONFIG_*
      // overrides stay agent-reachable by design -- same as bwrap.)
      ...(gitBroker ? [
        ...exactPins('.gitconfig', effectiveHome),
        ...exactPins(join('.config', 'git', 'config'), effectiveHome),
        // Defense-in-depth for the credential.helper reset above: even if a
        // `store` helper somehow still ran, it must not be able to persist a
        // broker-issued token where the agent can read it back.
        ...exactPins('.git-credentials', effectiveHome),
        ...exactPins(join('.config', 'git', 'credentials'), effectiveHome),
      ] : []),
      // Pin the read-only invariant explicitly: the runtime dir lives under
      // TMPDIR, which the broad tmp write rules above also match -- these
      // last-match-wins pins keep shims/hooks/profile immutable even so.
      ...memoSubtrees(binDir),
      ...memoSubtrees(hooksDir),
      ...exactPins(basename(profilePath), dir),
      // The commit-msg guard config lives under hostRuntimeDir() (short /tmp
      // base on darwin, inside the broad tmp write rules) and the in-sandbox
      // hook re-reads it on every commit -- bwrap ro-binds it, so deny-write
      // it here too or the agent can empty blockedPatterns mid-session. Same
      // for the broker allowlist (read once at broker boot, but pinning it
      // matches bwrap's ro-bind parity). NOTE: these pins cover THIS launch's
      // files only -- sibling sessions' runtime-dir files (broker sockets,
      // allowlists, commit-guard configs) stay reachable, exactly as
      // documented in docs-site (sandbox/overview.md).
      ...(commitGuard
        ? exactPins(basename(commitGuard.configPath), dirname(commitGuard.configPath))
        : []),
      ...(gitBroker
        ? exactPins(basename(gitBroker.allowlistPath), dirname(gitBroker.allowlistPath))
        : []),
      // The per-launch ssh-config (CCSANDBOX_SSH_CONFIG, minted for brokered
      // launches when ssh.realSsh) must stay immutable like bwrap's
      // --ro-bind'ed sandbox-ssh-config: an agent-writable copy could weaken
      // StrictHostKeyChecking / UserKnownHostsFile for brokered git ssh.
      ...(gitBroker && ssh.realSsh ? exactPins(basename(sshConfigPath), dir) : []),
      // The known_hosts copy is as security-sensitive as the ssh-config
      // itself: an agent-writable known_hosts weakens host key verification.
      ...(knownHostsCopy ? exactPins(basename(knownHostsCopy), dir) : []),
      // NOTE: sibling launch dirs are intentionally NOT repeated here.
      // They are already denied by siblingDenyWriteRegexes BEFORE the
      // own-dir re-allow (and future siblings never match that re-allow),
      // so repeating the sibling prefix in this final deny would match our
      // own dir too and -- under last-match-wins -- override its re-allow,
      // making dir/runtime and the throwaway HOME write-denied.
    ];
    // Orchestrator rule overlay: bwrap shadows CLAUDE.md/AGENTS.md read-only by
    // ro-binding the generated file over cwd's copies. Seatbelt has no mounts,
    // so materialize the generated rules into the orchestrator's managed cwd
    // instead -- that dir never persists CLAUDE.md/AGENTS.md (see
    // routes/groups.js), so the copies are launch-scoped by construction -- and
    // deny writes below so they stay immutable for the session. A copy failure
    // throws (fail-closed like a failed bwrap bind: never boot an orchestrator
    // with no rules). Teardown removes the copies (see ruleCopies below).
    if (orchestratorClaudeMdSrc) {
      for (const name of ['CLAUDE.md', 'AGENTS.md']) {
        const dest = join(projectDir, name);
        // A concurrent launch from the same deterministic orchestratorDir may
        // have already materialized these paths for a LIVE session -- the
        // same scenario the stillReferenced teardown guards protect. Copy
        // through a temp file + rename so a failed build never truncates a
        // live overlay, and track ownership so teardown only unlinks files
        // THIS launch created (a failed build must not delete a live
        // session's overlay out from under it).
        const preExisting = existsSync(dest);
        const tmpDest = `${dest}.ccserver-overlay-tmp-${launchId}`;
        try {
          copyFileSync(orchestratorClaudeMdSrc, tmpDest);
          renameSync(tmpDest, dest);
        } catch (err) {
          try { unlinkSync(tmpDest); } catch { /* best effort */ }
          throw new Error(`seatbelt orchestrator overlay: cannot copy rules to ${dest}: ${err.message}`);
        }
        if (!preExisting) ruleCopies.push(dest);
        overlayFiles.push(dest);
        for (const base of memoVariants(projectDir)) {
          denyWriteRegexes.push(`^${escapeSeatbeltRegex(join(base, name))}$`);
        }
      }
    }

    // Operator extra binds become allow rules (no remount, so src is used
    // as-is; dest is ignored). Blocked credential trees (~/.ssh, ~/.config/gh)
    // are skipped with a warning -- see isBlockedCredentialBind. resolve()
    // collapses `..` first so `~/.config/../.ssh/id_rsa` can't slip past it.
    for (const b of extraBinds || []) {
      if (!b || !b.src) continue;
      const src = resolve(expandAgainstHome(String(b.src), hostHome));
      if (isBlockedCredentialBind(src, hostHome)) {
        console.warn(`[sandbox] ignoring configured bind of ${src}: raw ssh keys / gh config are no longer exposed to the sandbox (see the git broker)`);
        continue;
      }
      readRegexes.push(...memoSubtrees(src));
      if (b.mode === 'rw') writeRegexes.push(...memoSubtrees(src));
    }

    // Control-plane sockets may not exist yet (pty-host/meta boot lazily),
    // and NEITHER may any of their parent dirs: the pty-host socket sits one
    // level below the runtime dir, the meta socket two levels below it, and
    // on a fresh host the runtime dir itself is absent until the first broker
    // starts. pathVariantsDeep() walks up to the first existing ancestor
    // (ultimately /tmp) and synthesizes both the raw and the symlink-resolved
    // (/private/tmp) spelling regardless of how many components are missing --
    // a raw-only pin would let connect() walk around the deny via the
    // resolved path Seatbelt actually mediates.
    const netDenyLiterals = [...new Set(
      (controlSockDenies || []).filter(Boolean).flatMap((s) => memoDeep(s)),
    )];
    // The pinned sockets' files themselves must also stay unwritable:
    // file-write* covers unlink/rename, so without these pins the agent can
    // delete or replace a pinned socket at its fixed path (DoS the server's
    // control plane, or impersonate pty-host/meta for future host-side
    // connects). Same list as the network-outbound pins -- the meta
    // session's own socket is excluded there, so it stays fully usable here.
    denyWriteRegexes.push(...netDenyLiterals.map((s) => `^${escapeSeatbeltRegex(s)}$`));
    // Deny-write the whole host runtime dir tree (see the C fix): the broad
    // `^/tmp(/.*)?$` write allow otherwise leaves the dir the server's
    // control-plane sockets live in renamable/removable by a same-uid
    // sandboxed process -> server-wide control-plane DoS. Both spellings, and
    // resolvable even before the dir exists (pathVariantsDeep). Re-allow only
    // the sockets THIS session connect()s to (writeLiterals that fall under
    // the tree) -- pty-host / meta are never in that list, so they stay
    // denied both here and via the netDenyLiterals pins above.
    let runtimeDirDenyWriteRegexes = [];
    let runtimeSocketAllowLiterals = [];
    if (hostRuntimeDir) {
      const rtVariants = memoDeep(hostRuntimeDir);
      runtimeDirDenyWriteRegexes = rtVariants.map(subtreeRegex);
      const underRuntime = (p) => rtVariants.some((base) => p === base || p.startsWith(`${base}/`));
      // Both spellings of every re-allowed socket: Seatbelt evaluates the
      // symlink-RESOLVED path, so the deny subtrees above catch a connect via
      // /private/tmp/... and a raw-only re-allow would leave it net-denied.
      runtimeSocketAllowLiterals = [...new Set(
        writeLiterals.filter(underRuntime).flatMap((p) => memoDeep(p)),
      )];
    }
    const profileText = buildSeatbeltProfileText({
      readRegexes, readMetadataRegexes, writeRegexes, readLiterals, writeLiterals,
      siblingDenyWriteRegexes: siblingDeny, siblingDenyReadRegexes: siblingDeny,
      reAllowWriteRegexes: ownReAllow, reAllowReadRegexes: ownReAllow,
      denyWriteRegexes,
      runtimeDirDenyWriteRegexes,
      runtimeSocketAllowLiterals,
      // Mirror bwrap (gh wrapper bound over the real binaries only while the
      // broker is on): with gitBroker off the agent may use its own gh, so the
      // pins must not apply. The binDir shim itself is never in ghPaths, but
      // filter it defensively so the PATH shim cannot be denied by mistake.
      denyExecLiterals: gitBroker
        ? [...new Set(ghPaths)].filter((p) => p && p !== join(binDir, 'gh'))
        : [],
      denyNetOutboundLiterals: netDenyLiterals,
      // Network isolation (see seatbeltIsolatedNetworkRules above): null
      // keeps historical open egress; set only when this launch requested it.
      networkIsolate: networkBroker && Number.isInteger(networkBroker.port)
        ? { brokerPort: networkBroker.port }
        : undefined,
    });
    writeFileSync(profilePath, profileText, { mode: 0o600 });
    return { dir, profilePath, binDir, hooksDir, homeDir: effectiveHome, ruleCopies: ruleCopies.length > 0 ? ruleCopies : null, overlayFiles: overlayFiles.length > 0 ? [...overlayFiles] : null, nodeBin, env };
  } catch (err) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    for (const f of ruleCopies) { try { unlinkSync(f); } catch { /* best effort */ } }
    throw err;
  }
}

// Serialize the seatbelt env object for `sandbox-exec -f profile
// /usr/bin/env K=V ... <cmd>` (sandbox-exec has no --setenv). Array-form
// spawn passes each `K=V` literally, so values with spaces are safe.
export function seatbeltEnvArgs(env) {
  return Object.entries(env || {}).map(([k, v]) => `${k}=${v}`);
}
