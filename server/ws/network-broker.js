// Host-side network-egress broker for sandboxed sessions.
//
// Runs OUTSIDE the sandbox (spawned by sandbox.js as a plain child process
// of ccserver, exactly like git-broker.js), and is the ONLY path a
// network-isolated session's traffic is allowed to leave through. Each
// backend forces this by construction, not by convention:
//   - bwrap:  the rootlesskit-created netns gets an in-netns firewall rule
//     that drops everything except this broker's port.
//   - seatbelt: the profile flips to deny-by-default network, with a single
//     explicit allow for this broker's loopback port.
// See sandbox.js's buildSandboxSpawn for how each backend wires this up.
//
// This file is dual-purpose like git-broker.js: `startNetworkBroker()` is
// called from sandbox.js to launch a fresh instance per session, and when
// executed directly with `--serve` it IS that instance.
//
// Protocol: a plain HTTP CONNECT proxy (Node's http server + 'connect'
// event) -- NOT a full forward/MITM proxy. TLS goes through end-to-end
// untouched, so the broker only ever sees `CONNECT host:port`, never
// plaintext or the TLS session itself. This is what makes hostname-based
// allow-listing work against CDN-fronted APIs with rotating IPs, which a
// plain IP/port firewall rule cannot do reliably.
//
// Proxy auth: the broker binds every interface (0.0.0.0), not just loopback
// -- bwrap sessions reach it through slirp4netns's host-loopback forwarding
// (the sandbox's netns sees the broker at its slirp4netns gateway address,
// not at its own loopback); seatbelt sessions are unsandboxed at the network
// layer so it's directly reachable either way. Net effect: ANY local
// process -- and, since this is 0.0.0.0, anything that can otherwise reach
// this host's network interfaces at all -- can dial the port, not just this
// session's sandbox. A per-session token is therefore required on every
// CONNECT via standard
// HTTP proxy credentials (`Proxy-Authorization: Basic base64(x:<token>)`,
// which curl/undici/most HTTP clients send automatically when the proxy URL
// itself carries a userinfo part -- see buildProxyUrl below) -- without it,
// one session could relay traffic through another session's allow-list.
// Same audit-layer caveat as git-broker's own token (see its handleRequest
// comment): on macOS a same-UID peer can still recover env vars via
// KERN_PROCARGS2, so this is defense in depth, not a hard boundary there.
//
// Two independent axes of "how permissive right now":
//   - `mode` (operator-only, from sandbox.config.json's network.mode):
//     'enforce' (default) actually blocks disallowed hosts; 'audit' logs
//     every CONNECT's allow/deny verdict but never blocks non-denied hosts
//     -- for an operator to empirically discover the real host set an agent
//     CLI needs before flipping a project to 'enforce'. The deny-list
//     (network.deniedHosts) always blocks, even in audit mode.
//   - live `state` ('enforce' | 'open'), mutated at runtime via the
//     `/__admin/mode` control endpoint (see setNetworkBrokerMode below):
//     this is what the running-session UI toggle flips. It starts at
//     whichever state the launcher enabled isolation for this session with (see
//     startNetworkBroker's `state` param) -- 'audit' mode overrides the live
//     state entirely (audit always behaves as if 'open' while still logging
//     verdicts, except for denied hosts which stay blocked). The network
//     *boundary* itself (bwrap firewall / seatbelt profile) never changes
//     after launch -- only this in-process policy flag does, which is why
//     the toggle is instant and needs no sandbox restart.

import { lookup as dnsLookup } from 'node:dns';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostRuntimeDir, ensureHostRuntimeDir } from './git-broker.js';

const __filename = fileURLToPath(import.meta.url);

// True when `host` matches an entry in `list`: either an exact
// hostname, or (for an entry starting with '.') that suffix domain or any of
// its subdomains. Pure, case-insensitive, no I/O -- the enforcement decision
// itself, testable without spinning up the real proxy server. Port is
// deliberately not part of matching: CONNECT for HTTPS is always :443 in
// practice, and over-scoping to specific ports adds surface for no benefit.
// Shared by the allow-list and the deny-list (deniedHosts): both use the
// exact-or-leading-dot syntax.
export function isHostMatched(host, list) {
  if (typeof host !== 'string' || !host) return false;
  const h = host.toLowerCase();
  for (const entry of list || []) {
    if (typeof entry !== 'string' || !entry) continue;
    const e = entry.toLowerCase();
    if (e.startsWith('.')) {
      const suffix = e.slice(1);
      if (h === suffix || h.endsWith(e)) return true;
    } else if (h === e) {
      return true;
    }
  }
  return false;
}

export function isHostAllowed(host, allowedHosts) {
  return isHostMatched(host, allowedHosts);
}

// Deny-list match: same syntax as the allow-list. A match here always wins
// over the allow-list, the live open state, and audit mode.
export function isHostDenied(host, deniedHosts) {
  return isHostMatched(host, deniedHosts);
}

// M2 fix (vuln_scan report / PoC p5): isHostMatched/isHostDenied above are a
// plain string comparison against the CONNECT target's host field as
// written on the wire -- but node:net's own connector (and DNS resolvers in
// general) accept a much looser IPv4 grammar than "four decimal octets"
// (classic BSD inet_aton rules: 1-4 dot-separated parts, each decimal, 0x-
// hex, or 0-octal, with the last part absorbing any missing bytes). So
// "2130706433" / "0x7f000001" / "0177.0.0.1" / "127.1" all end up
// connecting to 127.0.0.1 while sailing straight past a denylist of
// ["127.0.0.1"], which only ever matches the literal string "127.0.0.1".
// This canonicalizes any such non-canonical-but-still-a-real-IPv4 host
// string to strict dotted-decimal form, so the caller can match THAT
// instead. Returns null for anything that isn't this loose IPv4 grammar
// (an ordinary hostname, an IPv6 literal, garbage) -- those are left to
// isHostMatched exactly as before.
export function canonicalizeIPv4Literal(host) {
  if (typeof host !== 'string' || !host) return null;
  const parts = host.split('.');
  const n = parts.length;
  if (n < 1 || n > 4) return null;
  const vals = [];
  for (const p of parts) {
    let v;
    if (/^0x[0-9a-fA-F]+$/i.test(p)) v = parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) v = parseInt(p, 8);
    else if (/^(0|[1-9][0-9]*)$/.test(p)) v = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(v) || v < 0) return null;
    vals.push(v);
  }
  // Every part but the last must fit one byte; the last absorbs whatever
  // bytes remain (a lone part IS the whole 32-bit value, two parts are
  // byte.24bits, three are byte.byte.16bits, four are byte.byte.byte.byte).
  for (let i = 0; i < n - 1; i++) {
    if (vals[i] > 0xff) return null;
  }
  const lastWidth = 4 - (n - 1);
  const lastMax = 256 ** lastWidth - 1;
  if (vals[n - 1] > lastMax) return null;
  let total = 0;
  for (let i = 0; i < n - 1; i++) total = total * 256 + vals[i];
  total = total * (256 ** lastWidth) + vals[n - 1];
  if (total > 0xffffffff) return null;
  return [24, 16, 8, 0].map((shift) => Math.floor(total / 2 ** shift) % 256).join('.');
}

// Canonical allow-list entry validation/normalization, shared by the config
// store (server/ws/networkAllowlist.js) and the live child endpoint below so
// the file and a running broker can never disagree on what an entry means.
// Accepts what isHostAllowed can match: an exact hostname or a leading-dot
// suffix (`.example.com` covers the domain and its subdomains). Anything
// else (schemes, ports, wildcards, whitespace, IPv6 literals) is rejected:
// the broker matches CONNECT hostnames only, so such entries could never
// match and would be dead data. Returns { hosts, rejected }: `hosts` is
// trimmed, lowercased and deduplicated; `rejected` holds the raw inputs that
// failed, for 400 responses.
export function normalizeAllowedHosts(entries) {
  const hosts = [];
  const rejected = [];
  const seen = new Set();
  // One DNS label: alphanumerics + interior hyphens. Dots separate labels;
  // a single leading dot marks a suffix entry (its remainder must itself be
  // a valid hostname).
  const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
  const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
  for (const raw of Array.isArray(entries) ? entries : []) {
    if (typeof raw !== 'string') { rejected.push(raw); continue; }
    const e = raw.trim().toLowerCase();
    const body = e.startsWith('.') ? e.slice(1) : e;
    if (!e || e.length > 253 || !HOSTNAME_RE.test(body)) { rejected.push(raw); continue; }
    if (seen.has(e)) continue;
    seen.add(e);
    hosts.push(e);
  }
  return { hosts, rejected };
}

export const MAX_ALLOWED_HOSTS = 200;

// Canonical parse of the `network` key of sandbox.config.json into the
// shape both loadSandboxConfig() (sandbox.js, what a launch actually
// applies) and getNetworkSettings() (networkAllowlist.js, what the Settings
// GUI shows/saves) need: isolate is the master switch (false by default: no
// broker, open egress, no live toggle on either backend); initialState
// selects the broker's starting live state ('enforce' by default, 'open'
// when explicitly set); mode is operator-only ('audit' never blocks a
// non-denied host, but deniedHosts still blocks even in audit);
// allowedHosts/deniedHosts use the same exact-or-leading-dot syntax and are
// only filtered to strings here (full validation/normalization on write is
// normalizeAllowedHosts above -- this parse just mirrors what's already on
// disk). Both call sites used to hand-duplicate this parse, kept in sync
// only by a comment claiming they mirrored each other; extracted here so
// they structurally cannot drift again.
export function normalizeNetworkSettings(rawNetwork) {
  const net = (rawNetwork && typeof rawNetwork === 'object' && !Array.isArray(rawNetwork)) ? rawNetwork : {};
  return {
    isolate: net.isolate === true,
    initialState: net.initialState === 'open' ? 'open' : 'enforce',
    mode: net.mode === 'audit' ? 'audit' : 'enforce',
    allowedHosts: Array.isArray(net.allowedHosts)
      ? net.allowedHosts.filter((h) => typeof h === 'string' && h)
      : [],
    deniedHosts: Array.isArray(net.deniedHosts)
      ? net.deniedHosts.filter((h) => typeof h === 'string' && h)
      : [],
  };
}

// Splits a CONNECT target ("host:port") into its parts. IPv6 literals
// ("[::1]:443") are deliberately unsupported (returns null) -- allow-listing
// is hostname-based, and no supported agent CLI's model API is IPv6-literal.
// The host is stripped of a trailing root-label dot ("evil.example." ==
// "evil.example" in DNS) before matching, so a trailing-dot FQDN can't be
// used to slip past isHostAllowed/isHostDenied.
function parseConnectTarget(target) {
  if (typeof target !== 'string' || target.startsWith('[')) return null;
  const idx = target.lastIndexOf(':');
  if (idx <= 0) return null;
  let host = target.slice(0, idx);
  if (host.endsWith('.')) host = host.slice(0, -1);
  const port = Number(target.slice(idx + 1));
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

// Constant-time compare that never throws and rejects length mismatches
// (mirrors git-broker.js's tokenEq).
function tokenEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}

// Extracts the token from a `Proxy-Authorization: Basic base64(x:<token>)`
// header (the form curl/undici send when the proxy URL carries userinfo --
// see buildProxyUrl). Any other scheme, or a malformed header, yields null.
function tokenFromProxyAuth(header) {
  if (typeof header !== 'string') return null;
  const m = /^Basic\s+(\S+)$/i.exec(header.trim());
  if (!m) return null;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf-8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return null;
  return decoded.slice(sep + 1);
}

// Same, for the admin endpoint's `Authorization: Bearer <token>`.
function tokenFromBearerAuth(header) {
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

// The proxy URL a sandboxed session should set HTTP_PROXY/HTTPS_PROXY to:
// embeds the per-session token as Basic-auth userinfo so well-behaved HTTP
// clients (curl, undici, requests, ...) send it automatically on every
// CONNECT without any extra configuration inside the sandbox.
export function networkBrokerProxyUrl({ host = '127.0.0.1', port, token }) {
  return `http://networkbroker:${encodeURIComponent(token)}@${host}:${port}`;
}

// The proxy env block every isolated backend injects (bwrap and seatbelt
// share this so proxy-detection quirks can't drift between them: curl/Python
// check lowercase, Node/Go commonly check uppercase, and agent CLIs bundle
// whichever HTTP client their runtime ships -- setting only one casing risks
// the env var being silently ignored, which looks identical to "no network
// at all" behind a structural boundary). `noProxyExtra` covers same-network
// peers that must never be routed through the proxy; loopback is always
// exempt.
export function buildIsolatedProxyEnv({ host = '127.0.0.1', port, token, noProxyExtra = [] }) {
  const proxyUrl = networkBrokerProxyUrl({ host, port, token });
  const noProxy = ['localhost', '127.0.0.1', ...noProxyExtra].join(',');
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

function runServer({ allowlist, denylist, mode, portFile, state: initialState, adminToken }) {
  let allowedHosts;
  try {
    allowedHosts = JSON.parse(readFileSync(allowlist, 'utf-8'));
    if (!Array.isArray(allowedHosts)) allowedHosts = [];
  } catch {
    allowedHosts = []; // fail closed if the allow-list can't be read
  }
  // Deny-list: same syntax as the allow-list. Missing/unreadable means
  // "nothing denied" (allow-side fail-closed is unchanged).
  let deniedHosts = [];
  if (denylist) {
    try {
      const parsed = JSON.parse(readFileSync(denylist, 'utf-8'));
      if (Array.isArray(parsed)) deniedHosts = parsed;
    } catch {
      deniedHosts = [];
    }
  }
  const initialMode = mode === 'audit' ? 'audit' : 'enforce';
  // Live policy state, mutated only by the /__admin/mode endpoint. 'audit'
  // is not a valid live state (it's the operator-only startup mode above);
  // when initialMode is 'audit' every CONNECT is logged but always allowed,
  // regardless of `state`. Starts at whatever the launcher enabled isolation
  // for this session with (see startNetworkBroker's `state`, fed from
  // sandbox.config.json's network.initialState) -- 'enforce' unless the
  // operator set initialState to 'open'.
  let state = initialState === 'open' ? 'open' : 'enforce';
  // Two independent tokens (H1 fix): `token` authenticates CONNECT proxy
  // traffic and is the one embedded in HTTP_PROXY/HTTPS_PROXY -- so it is
  // readable from *inside* the sandbox by design (see buildIsolatedProxyEnv).
  // `adminToken` authenticates /__admin/* and is only ever handed to the
  // host-side ccserver process (see startNetworkBroker) -- it must never be
  // derivable from anything visible inside the sandbox, or a sandboxed agent
  // could read it off its own env and use it to disable its own egress
  // allow-list, exactly like a stolen proxy token used to be able to.
  //
  // adminToken arrives as a plain parameter (read from stdin by
  // readAdminTokenFromStdin, below the process.argv guard at the bottom of
  // this file), never via env/argv/a file: a same-UID sandboxed process can
  // read another process's OWN env on some backends (macOS: KERN_PROCARGS2
  // -- see sandbox-seatbelt.js's own probe/tests for the documented proof),
  // so putting the admin secret in *this broker's* env would have handed a
  // sandboxed agent on macOS the same self-unlock this H1 fix exists to
  // close, just one hop further removed (read the broker's env instead of
  // the sandbox's own).
  const token = process.env.CCSANDBOX_NETWORK_BROKER_TOKEN || '';

  const server = createServer((req, res) => {
    // Socket aborts (RST after 403/407/404 etc.) surface as 'error' on
    // req/res -- without these the broker dies with Unhandled 'error'
    // (ECONNRESET). Intentionally silent: only CONNECT verdicts are logged.
    req.on('error', () => {});
    res.on('error', () => {});
    // Only the admin control endpoints are served as plain HTTP; everything
    // else on this port is proxy traffic (CONNECT, handled below) or noise.
    if (req.method === 'POST' && (req.url === '/__admin/mode' || req.url === '/__admin/allowlist')) {
      const suppliedToken = tokenFromBearerAuth(req.headers.authorization);
      if (!tokenEq(suppliedToken, adminToken)) {
        res.writeHead(401).end('unauthorized');
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
      req.on('end', () => {
        if (req.url === '/__admin/mode') {
          let parsed;
          try { parsed = JSON.parse(body); } catch { parsed = null; }
          if (!parsed || (parsed.mode !== 'enforce' && parsed.mode !== 'open')) {
            res.writeHead(400).end('bad mode');
            return;
          }
          state = parsed.mode;
          process.stdout.write(`[network-broker] live state -> ${state}\n`);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, mode: state }));
          return;
        }
        // Live allow/deny-list replacement (GUI save with auto-apply): the
        // same validation as the config store, so a list the file accepts
        // is always one a running broker accepts too. `hosts` and
        // `deniedHosts` are each optional; only present keys are replaced
        // (back-compat: old clients sending only `hosts` keep working).
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = null; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
            error: 'bad allowlist',
            rejected: [],
          }));
          return;
        }
        const hasAllow = parsed.hosts !== undefined;
        const hasDeny = parsed.deniedHosts !== undefined;
        if (!hasAllow && !hasDeny) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
            error: 'bad allowlist',
            rejected: [],
          }));
          return;
        }
        let nextAllowed = allowedHosts;
        let nextDenied = deniedHosts;
        if (hasAllow) {
          if (!Array.isArray(parsed.hosts)) {
            res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad allowlist', rejected: [] }));
            return;
          }
          const { hosts, rejected } = normalizeAllowedHosts(parsed.hosts);
          if (rejected.length > 0 || hosts.length > MAX_ALLOWED_HOSTS) {
            res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
              error: 'bad allowlist',
              rejected,
            }));
            return;
          }
          nextAllowed = hosts;
        }
        if (hasDeny) {
          if (!Array.isArray(parsed.deniedHosts)) {
            res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad denylist', rejected: [] }));
            return;
          }
          const { hosts, rejected } = normalizeAllowedHosts(parsed.deniedHosts);
          if (rejected.length > 0 || hosts.length > MAX_ALLOWED_HOSTS) {
            res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
              error: 'bad denylist',
              rejected,
            }));
            return;
          }
          nextDenied = hosts;
        }
        allowedHosts = nextAllowed;
        deniedHosts = nextDenied;
        process.stdout.write(`[network-broker] live allowlist -> ${allowedHosts.length} host(s), denylist -> ${deniedHosts.length} host(s)\n`);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, count: allowedHosts.length, deniedCount: deniedHosts.length }));
      });
      return;
    }
    res.writeHead(404).end();
  });

  server.on('connect', (req, clientSocket, head) => {
    // Must be first: 407/400/403 paths end() the socket and return early,
    // but a client RST after that (normal for 403-deny) emits ECONNRESET.
    // Without this the process dies with Unhandled 'error' event. Silent by
    // design -- only the CONNECT allow/deny line above is logged.
    let upstream = null;
    clientSocket.on('error', () => { try { upstream?.destroy(); } catch { /* ignore */ } });
    // 'close' without a prior 'error' is the common case for a peer that
    // vanishes silently (flaky network, black hole, half-open) rather than
    // RST'ing -- without also cleaning up here, the other side's socket
    // (and its fd) leaks for the rest of this long-lived, per-session
    // broker process's life.
    clientSocket.on('close', () => { try { upstream?.destroy(); } catch { /* ignore */ } });
    req.on('error', () => {});
    const suppliedToken = tokenFromProxyAuth(req.headers['proxy-authorization']);
    if (!tokenEq(suppliedToken, token)) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="network-broker"\r\n\r\n');
      return;
    }
    const target = parseConnectTarget(req.url);
    if (!target) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    // M2 fix: match against the CANONICAL address when target.host is any
    // non-standard-but-still-real IPv4 literal encoding (see
    // canonicalizeIPv4Literal) -- otherwise a denylist of ["127.0.0.1"]
    // never matches "2130706433"/"0x7f000001"/"0177.0.0.1"/"127.1" even
    // though all four connect straight to 127.0.0.1. Returns null for an
    // ordinary hostname, which is matched exactly as before.
    const literalIPv4 = canonicalizeIPv4Literal(target.host);
    const matchHost = literalIPv4 || target.host;

    const verdictFor = (host) => {
      const denied = isHostDenied(host, deniedHosts);
      const allowed = isHostMatched(host, allowedHosts);
      // Deny-list wins over everything: allow-list, live open state, and
      // audit mode. Audit still logs the verdict but no longer passes a
      // denied host through.
      const effectiveAllow = !denied && (allowed || initialMode === 'audit' || state === 'open');
      process.stdout.write(
        `[network-broker] CONNECT ${target.host}:${target.port} -> ${effectiveAllow ? 'allow' : 'deny'}`
        + `${denied ? ' (denylist)' : initialMode === 'audit' && !allowed ? ' (audit: would deny)' : ''}\n`,
      );
      return effectiveAllow;
    };

    // Pre-200 only: once the 200 is sent and piping starts (below), an
    // upstream error must just tear the tunnel down -- writing more HTTP
    // bytes over an error at that point would corrupt whatever TLS/
    // application data is already flowing through the pipe.
    const respond502 = () => { try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* ignore */ } };
    const connectTo = (address) => {
      const upstreamConn = netConnect(target.port, address, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstreamConn.off('error', respond502);
        upstreamConn.on('error', () => { try { clientSocket.destroy(); } catch { /* ignore */ } });
        if (head && head.length) upstreamConn.write(head);
        upstreamConn.pipe(clientSocket);
        clientSocket.pipe(upstreamConn);
      });
      upstream = upstreamConn;
      upstreamConn.on('error', respond502);
      // See clientSocket's matching 'close' handler above for why this is
      // needed alongside 'error'.
      upstreamConn.on('close', () => { try { clientSocket.destroy(); } catch { /* ignore */ } });
    };

    if (literalIPv4) {
      // Already a concrete address (whatever encoding it arrived in) -- no
      // DNS involved, so there is nothing left to pin: match and connect to
      // it directly.
      if (!verdictFor(matchHost)) {
        clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      connectTo(literalIPv4);
      return;
    }
    // An ordinary hostname: resolve it HERE, once, so (a) the deny-list can
    // be re-checked against the address actually about to be reached -- an
    // allow-listed hostname that resolves to a denied/internal address is
    // still refused (M2's DNS-rebinding case) -- and (b) the eventual
    // connect below reuses this exact resolved address instead of letting
    // node:net re-resolve independently, which is what pins it: a second,
    // later resolution could legitimately return something different.
    if (!verdictFor(matchHost)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    // `all: true` -- a bare dns.lookup() returns only ONE candidate (the
    // resolver's own ordering preference, e.g. an AAAA before the A record),
    // which would leave every OTHER address this hostname could resolve to
    // completely unchecked. Every candidate must be denylist-clean before
    // any of them is used.
    dnsLookup(target.host, { all: true }, (err, addresses) => {
      if (err || !Array.isArray(addresses) || addresses.length === 0) { respond502(); return; }
      const blocked = addresses.find((a) => isHostDenied(a.address, deniedHosts));
      if (blocked) {
        process.stdout.write(`[network-broker] CONNECT ${target.host}:${target.port} -> deny (resolved to denylisted ${blocked.address})\n`);
        clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      // Prefer an IPv4 candidate when one exists: most target services (and
      // this broker's own test fixtures) are only actually reachable over
      // v4, and the resolver's own ordering (which the bare, non-`all`
      // dns.lookup() used to hand straight to net.connect()) isn't a
      // reachability signal -- it can just as easily put an AAAA first.
      const chosen = addresses.find((a) => a.family === 4) || addresses[0];
      connectTo(chosen.address);
    });
  });

  // Malformed HTTP on the port (not a valid CONNECT/admin request) -- destroy
  // silently so one bad client can't kill the broker. No log: deny log only.
  server.on('clientError', (err, sock) => { try { sock.destroy(); } catch { /* ignore */ } });

  server.on('error', (err) => {
    process.stderr.write(`[network-broker] listen failed: ${err.message}\n`);
    process.exit(1);
  });

  // Bound on every interface, not just loopback -- a bwrap session reaches
  // this via slirp4netns's host-loopback forwarding at its netns gateway
  // address, not at its own loopback. This does widen exposure beyond "local
  // processes only" -- see the file header's proxy-auth comment: the
  // per-session token is the actual access boundary here, same posture as
  // git-broker's own token, not the bind address.
  server.listen(0, '0.0.0.0', () => {
    const { port } = server.address();
    try {
      writeFileSync(portFile, String(port));
    } catch (e) {
      process.stderr.write(`[network-broker] failed to write port file: ${e.message}\n`);
      process.exit(1);
    }
    process.stdout.write(`[network-broker] listening on 127.0.0.1:${port} (${allowedHosts.length} host(s) allow-listed, ${deniedHosts.length} host(s) deny-listed, mode=${initialMode}, state=${state})\n`);
  });

  const shutdown = () => { try { server.close(); } catch { /* ignore */ } process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Launch a fresh network-broker instance for a sandbox session. Mirrors
// startGitBroker's shape closely: writes the allow-list, spawns `--serve`
// with a per-session token, busy-waits for the child to report its chosen
// port, and probes it before returning. Throws on any failure (fail-closed
// at the infra level, not just at the traffic level) -- callers must treat a
// thrown startNetworkBroker as a launch failure, same as a failed
// startGitBroker for a git repo.
//
//   mode  - operator-only (sandbox.config.json's network.mode): 'enforce'
//           (default) or 'audit' (never blocks, only logs verdicts).
//   state - the LIVE toggle's starting value: 'enforce' (default) or 'open'.
//           Only isolation-enabled launches call this (see buildSandboxSpawn -- a broker
//           exists only when network.isolate is on); `state` carries
//           sandbox.config.json's network.initialState. The running-session
//           toggle (terminal.js's set_network_isolation ->
//           setNetworkBrokerMode) flips this same value later; it works
//           identically regardless of the state this call started with.
//   deniedHosts - absolute deny-list (sandbox.config.json's
//           network.deniedHosts): same syntax as allowedHosts, but a match
//           here always wins -- even in live 'open' state and in audit mode.
export async function startNetworkBroker(
  { allowedHosts = [], deniedHosts = [], mode = 'enforce', state = 'enforce' },
  { spawnProcess = spawn } = {},
) {
  const dir = join(hostRuntimeDir(), `ccserver-network-broker-${randomUUID()}`);
  try {
    ensureHostRuntimeDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new Error(`network broker failed to start: ${e.message}`);
  }
  const allowlistPath = join(dir, 'allowlist.json');
  const denylistPath = join(dir, 'denylist.json');
  const portFile = join(dir, 'port');
  try {
    writeFileSync(allowlistPath, JSON.stringify(allowedHosts));
    writeFileSync(denylistPath, JSON.stringify(deniedHosts));
  } catch (e) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`network broker failed to start: ${e.message}`);
  }

  // Two independent, unguessable tokens -- see runServer's comment. `token`
  // goes to the child via env (it's ALSO destined for the sandbox's own env,
  // buildIsolatedProxyEnv, called by sandbox.js, so there's nothing gained
  // by keeping it out of the child's env too). `adminToken` must stay
  // host-side only, including out of the CHILD BROKER PROCESS's own env --
  // see runServer's comment on why -- so it travels over a private,
  // anonymous pipe (the child's otherwise-unused stdin) exactly once at
  // startup instead. The child never starts its HTTP server (and its
  // /__admin/* auth) until it has read and validated it -- see
  // readAdminTokenFromStdin below.
  const token = randomBytes(24).toString('base64url');
  const adminToken = randomBytes(24).toString('base64url');
  const serveArgs = [__filename, '--serve', '--allowlist', allowlistPath, '--denylist', denylistPath, '--mode', mode, '--state', state, '--port-file', portFile];
  const proc = spawnProcess(process.execPath, serveArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CCSANDBOX_NETWORK_BROKER_TOKEN: token },
  });

  proc.stdout.on('data', (d) => process.stdout.write(`[network-broker] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[network-broker] ${d}`));

  let spawnError = null;
  proc.on('error', (err) => { spawnError = err; });
  // Writable-stream failures are emitted on proc.stdin, not on the ChildProcess
  // itself, and are asynchronous (so try/catch around .end() cannot catch an
  // EPIPE). Treat them exactly like a spawn failure; otherwise an early child
  // exit can crash the entire ccserver with an unhandled 'error' event.
  proc.stdin.on('error', (err) => { spawnError ??= err; });
  proc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`[network-broker] broker (pid ${proc.pid}) exited code=${code} signal=${signal}\n`);
    } else if (signal) {
      process.stderr.write(`[network-broker] broker (pid ${proc.pid}) terminated signal=${signal}\n`);
    }
  });

  // A synchronous write failure and an asynchronous stdin 'error' both feed
  // spawnError, so the readiness wait below fails the launch and performs the
  // normal child/runtime-dir cleanup.
  try {
    proc.stdin.end(adminToken);
  } catch (err) { spawnError ??= err; }

  // Async wait for the child to report its chosen port (H1 review: a
  // synchronous Atomics.wait busy-wait here would starve the event loop the
  // stdin write above needs in order to actually flush, and every caller up
  // the chain -- buildSandboxSpawn -> createSession -- now awaits this
  // whole function).
  const deadline = Date.now() + 2000;
  while (!existsSync(portFile) && Date.now() < deadline) {
    if (spawnError) break;
    if (proc.exitCode !== null || proc.signalCode !== null) break;
    await sleep(20);
  }

  if (spawnError || proc.exitCode !== null || proc.signalCode !== null || !existsSync(portFile)) {
    const reason = spawnError ? spawnError.message : proc.exitCode !== null ? `exited code=${proc.exitCode}` : proc.signalCode ? `signal=${proc.signalCode}` : 'port file not ready within 2s';
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`network broker failed to start: ${reason}`);
  }

  let port;
  try {
    port = Number(readFileSync(portFile, 'utf-8').trim());
    if (!Number.isInteger(port) || port <= 0) throw new Error('malformed port file');
  } catch (e) {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`network broker failed to start: ${e.message}`);
  }

  const probed = await probeBroker(port);
  if (!probed) {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`network broker readiness probe failed on port ${port}`);
  }

  return { proc, dir, port, token, adminToken, allowedHosts, deniedHosts, mode, state };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Async readiness probe: connect and confirm the port actually accepts TCP
// connections -- a bare connect+close is enough to distinguish "listening"
// from "nothing there yet". Was a synchronous execFileSync-spawned-subprocess
// probe (probeBrokerSync); now that startNetworkBroker itself is async (H1
// review), a plain in-process connect works and needs no subprocess at all.
function probeBroker(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (settled) return; settled = true; resolve(ok); };
    const sock = netConnect(port, '127.0.0.1');
    const timer = setTimeout(() => { try { sock.destroy(); } catch { /* ignore */ } finish(false); }, timeoutMs);
    sock.on('connect', () => { clearTimeout(timer); sock.end(); finish(true); });
    sock.on('error', () => { clearTimeout(timer); finish(false); });
  });
}

// Flips a running broker's live enforce/open state (the running-session UI
// toggle -- see server/ws/terminal.js's `set_network_isolation` handler).
// Does NOT touch the sandbox's network boundary itself, only this broker's
// in-process policy flag -- instant, no sandbox restart. Resolves to true on
// success, false on any failure (network error, wrong token, broker gone).
export async function setNetworkBrokerMode({ port, token }, mode) {
  if (mode !== 'enforce' && mode !== 'open') return false;
  return new Promise((resolve) => {
    const body = JSON.stringify({ mode });
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/__admin/mode',
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 2000,
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

// Pushes replacement allow/deny-lists to a running broker (the GUI save
// path with auto-apply -- see sessionManager's pushAllowlistToArmedSessions).
// Same shape as setNetworkBrokerMode: true on HTTP 200, false on any
// failure. Both lists are optional; only present keys are replaced.
// setNetworkBrokerAllowlist stays as the allow-only back-compat wrapper.
export async function setNetworkBrokerLists({ port, token }, { allowedHosts, deniedHosts } = {}) {
  const bodyObj = {};
  if (allowedHosts !== undefined) {
    if (!Array.isArray(allowedHosts)) return false;
    bodyObj.hosts = allowedHosts;
  }
  if (deniedHosts !== undefined) {
    if (!Array.isArray(deniedHosts)) return false;
    bodyObj.deniedHosts = deniedHosts;
  }
  if (Object.keys(bodyObj).length === 0) return false;
  return new Promise((resolve) => {
    const body = JSON.stringify(bodyObj);
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/__admin/allowlist',
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 2000,
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

export async function setNetworkBrokerAllowlist({ port, token }, hosts) {
  if (!Array.isArray(hosts)) return false;
  return setNetworkBrokerLists({ port, token }, { allowedHosts: hosts });
}

// Entry point when this file is spawned directly by startNetworkBroker().
function parseServeArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--allowlist') out.allowlist = argv[++i];
    else if (argv[i] === '--denylist') out.denylist = argv[++i];
    else if (argv[i] === '--mode') out.mode = argv[++i];
    else if (argv[i] === '--state') out.state = argv[++i];
    else if (argv[i] === '--port-file') out.portFile = argv[++i];
  }
  return out;
}

// Format of the token startNetworkBroker generates: randomBytes(24) base64url
// -- always exactly 32 characters from this charset, never padded.
const ADMIN_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
// Generous but bounded: the real payload is exactly 32 bytes; this only
// exists to stop an unbounded buffer if something unexpected is piped in.
const MAX_ADMIN_TOKEN_STDIN_BYTES = 256;

// Reads the admin token from stdin -- a single write + EOF from the parent
// (see startNetworkBroker) over an otherwise-unused pipe, never env/argv/a
// file (see runServer's comment on why). Resolves to the validated token
// string; rejects if stdin closes without ever producing exactly one
// well-formed token, the input is oversized, or a read error occurs -- any
// of which must abort startup before the HTTP server (and its /__admin/*
// auth) ever comes up, never fall back to some empty/guessed value.
function readAdminTokenFromStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.removeAllListeners('error');
      fn(arg);
    };
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_ADMIN_TOKEN_STDIN_BYTES) {
        finish(reject, new Error('admin token stdin exceeded the expected size'));
      }
    });
    process.stdin.on('end', () => {
      if (ADMIN_TOKEN_RE.test(buf)) finish(resolve, buf);
      else finish(reject, new Error('admin token stdin closed without a well-formed token'));
    });
    process.stdin.on('error', (err) => finish(reject, err));
  });
}

// See git-broker.js's matching guard for why argv[1] === __filename matters
// here too, symmetrically (this file is itself importable).
if (process.argv[2] === '--serve' && process.argv[1] === __filename) {
  readAdminTokenFromStdin()
    .then((adminToken) => runServer({ ...parseServeArgs(process.argv.slice(3)), adminToken }))
    .catch((err) => {
      // Fail closed: never listen (and never accept /__admin/* auth
      // attempts against an uninitialized adminToken) without a validated
      // token from the parent.
      process.stderr.write(`[network-broker] refusing to start: ${err.message}\n`);
      process.exit(1);
    });
}
