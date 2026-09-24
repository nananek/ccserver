// ccserver-notify: the server-global notification MCP server. Replaces the old
// idle-based "input_needed" heuristic (see the notify-mcp plan / README) with
// an explicit tool the agent can call when it actually needs attention.
//
// Process-wide concepts (NOT group-scoped like the control/handoff brokers):
//   - the subscription registry (webhook URLs registered at runtime via the
//     MCP `subscribe` tool, seeded at boot from sandbox.config.json's
//     `notify.subscriptions`),
//   - the Discord webhook (sandbox.config.json `notify.discordWebhook`, https
//     only, overridable via CCSERVER_DISCORD_WEBHOOK),
//   - delivery to all of the above over global fetch (10s timeout,
//     non-blocking: a failing webhook is logged, never thrown).
//
// One Unix socket hosts it for the whole server process
// (${XDG_RUNTIME_DIR}/ccserver-notify.d/sock, see getNotifySockPath). Each
// session's sandbox binds that socket's directory in (Issue #143 problem 1);
// the MCP config tells the agent to reach it through the same bridge wrapper
// as the group brokers (see mcpConfig.js / sandbox-mcp-wrapper.cjs).
//
// This module imports mcpBroker.js lazily (dynamic import) so the static
// import graph stays acyclic: sessionManager -> notify -> sandbox, and the
// broker/server/tools modules pull in sessionManager (via mcpTools) -- the
// broker wiring is only touched at runtime, never at module evaluation.

import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import { loadSandboxConfig } from './sandbox.js';
import { hostRuntimeDir } from './git-broker.js';
import { resolvePath, PATH_IDS } from '../paths.js';
import { readJsonFileIfRegular } from './regularFile.js';

// Persisted subscription registry (same pattern as .saved-groups.json /
// .saved-sessions.json). Read at each use (like loadSandboxConfig's env
// override) so tests can point it at a temp file without touching the real
// repo-root state file.
export function notifyPath() {
  return resolvePath(PATH_IDS.savedNotifications);
}

// Issue #143 problem 1: a dedicated directory holding only `sock`, bound into
// sandboxes as a directory rather than the socket file itself -- see
// mcpBroker.js's header comment for why (inode pinning across a server本体
// restart) and getNotifySockPath() below.
const NOTIFY_SOCKET_DIR_NAME = 'ccserver-notify.d';
const DELIVERY_TIMEOUT_MS = 10_000;

const LEVEL_EMOJI = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '🚨' };

// The in-memory registry: { id, url, name, createdAt }.
let subscriptions = [];
let notifyBroker = null; // { server, sockPath, dir, connections } | null

// Hostname for attribution and the browser tab title: CCSERVER_HOSTNAME wins
// over the config's notify.hostname, which in turn wins over the OS hostname
// (same priority pattern as CCSERVER_DISCORD_WEBHOOK, see sandbox.js). Exported
// so non-notify consumers (dirs.js /dirs/home -> client tab title) resolve the
// same name the notify footer shows (_from: <host>).
export function resolvedHostname() {
  const notify = loadSandboxConfig().notify || {};
  return process.env.CCSERVER_HOSTNAME || notify.hostname || hostname();
}

function loadNotifyConfig() {
  const notify = loadSandboxConfig().notify || { discordWebhook: null, subscriptions: [], hostname: null, attribution: true };
  return {
    ...notify,
    hostname: resolvedHostname(),
    attribution: notify.attribution !== false,
  };
}

// H4 SSRF guard (vuln_scan report): notify's `subscribe` tool used to accept
// any https:// URL and the host process would later POST to it (potentially
// following redirects) with no restriction at all -- a sandboxed agent could
// register an internal address and have the HOST (not the sandbox) reach it.
// Two layers close this:
//   1. Here: reject a literal loopback/private/link-local/reserved IP host
//      at subscribe time (cheap, no DNS, catches the obvious case -- e.g.
//      vuln_scan's PoC p4 registers `https://127.0.0.1:.../redirect`
//      directly).
//   2. deliverDispatcher() below: a custom Agent whose `connect.lookup`
//      validates every resolved address at actual connect time, which is
//      what actually closes the DNS-rebinding gap a subscribe-time-only
//      check would leave open for `notify.discordWebhook`/seeded
//      subscriptions using an ordinary hostname.
// IPv4 ranges: 0.0.0.0/8, 10/8 (private), 100.64/10 (CGNAT), 127/8
// (loopback), 169.254/16 (link-local, incl. cloud metadata endpoints),
// 172.16/12 + 192.168/16 (private), 192.0.0.0/24 (IETF protocol assignments),
// 224/4 (multicast), 240/4 (reserved).
function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
}

function isPrivateIPv4Int(n) {
  if (n === null) return false;
  const inRange = (base, bits) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  };
  return ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
    '172.16.0.0/12', '192.168.0.0/16', '192.0.0.0/24', '224.0.0.0/4', '240.0.0.0/4']
    .some((cidr) => { const [base, bits] = cidr.split('/'); return inRange(base, Number(bits)); });
}

function isPrivateIPv4(ip) {
  // not even a valid IPv4 literal -- let the hostname path handle it
  return isPrivateIPv4Int(ipv4ToInt(ip));
}

// Parse a textual IPv6 address into its 8 hextets, or null when it is not one.
//
// This replaces a regex that only looked at the first hextet and at the dotted
// `::ffff:a.b.c.d` spelling, which an attacker review broke trivially: the
// WHATWG URL parser normalizes EVERY IPv4-mapped spelling to the hex form
// (`::ffff:127.0.0.1` becomes `::ffff:7f00:1`), so by the time a URL's hostname
// was classified, the one form the old code could recognize no longer existed.
// `https://[::ffff:169.254.169.254]/` -- the cloud metadata service -- was
// accepted as a public address.
//
// Parsing properly instead of pattern-matching is the only way this stays
// correct: there are too many spellings of the same address to enumerate.
function parseIPv6(text) {
  let s = String(text).toLowerCase();
  const zone = s.indexOf('%'); // fe80::1%eth0
  if (zone !== -1) s = s.slice(0, zone);

  // A trailing dotted quad (`::ffff:1.2.3.4`, `::1.2.3.4`) is rewritten into
  // the two hextets it stands for, so the rest of the parser sees one form.
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1 && s.slice(lastColon + 1).includes('.')) {
    const n = ipv4ToInt(s.slice(lastColon + 1));
    if (n === null) return null;
    s = `${s.slice(0, lastColon + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;

  let groups;
  if (tail === null) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null; // "::" must stand for at least one zero group
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  }
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

// IPv6 classification over the parsed hextets. Every range that can carry a
// packet somewhere an unauthenticated POST should not go:
//   ::, ::1                 unspecified / loopback
//   ::ffff:0:0/96           IPv4-mapped   -> classify the embedded IPv4
//   ::/96                   IPv4-compatible (deprecated) -> same
//   64:ff9b::/96            NAT64 well-known prefix      -> same
//   2002::/16               6to4, embeds the IPv4 in hextets 1-2 -> same
//   fe80::/10               link-local
//   fc00::/7                unique local
//   ff00::/8                multicast
//   100::/64                discard-only
// The embedded-IPv4 cases are the ones the previous regex missed, and they are
// exactly the ones an attacker reaches for: ::ffff:169.254.169.254 is the
// cloud metadata service wearing an IPv6 hat.
function isPrivateIPv6(ip) {
  const h = parseIPv6(ip);
  if (!h) return false;
  const leadingZeros = (n) => h.slice(0, n).every((x) => x === 0);
  const embedded = (hi, lo) => isPrivateIPv4Int((((hi << 16) | lo) >>> 0));

  if (leadingZeros(7) && (h[7] === 0 || h[7] === 1)) return true; // :: and ::1
  if (leadingZeros(5) && (h[5] === 0xffff || h[5] === 0)) return embedded(h[6], h[7]);
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return embedded(h[6], h[7]);
  }
  if (h[0] === 0x2002) return embedded(h[1], h[2]);
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true; // 100::/64
  return false;
}

// Whether a URL hostname is an IP literal at all (bracketed IPv6, or a dotted
// quad). Used where only a real hostname makes sense -- see
// pushSubscriptions.validateEndpoint for why that is worth enforcing.
export function isIpLiteralHost(host) {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare !== host) return true; // brackets only ever wrap an IPv6 literal
  return ipv4ToInt(bare) !== null || parseIPv6(bare) !== null;
}

export function isPrivateOrReservedAddress(address, family) {
  if (family === 6 || address.includes(':')) return isPrivateIPv6(address);
  return isPrivateIPv4(address);
}

function isValidWebhookUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return false;
  let hostnamePart;
  try {
    hostnamePart = new URL(url).hostname;
  } catch {
    return false;
  }
  // URL#hostname keeps an IPv6 literal bracketed ("[::1]") -- strip that
  // before classifying it, or every IPv6 literal would silently skip the
  // private/reserved check below.
  const bare = hostnamePart.startsWith('[') && hostnamePart.endsWith(']')
    ? hostnamePart.slice(1, -1)
    : hostnamePart;
  // Only rejects a literal IP host here -- an ordinary hostname (however it
  // eventually resolves) is validated at actual connect time instead, by
  // deliverDispatcher()'s lookup hook below.
  return !isPrivateOrReservedAddress(bare, bare.includes(':') ? 6 : 4);
}

// Custom dns.lookup-shaped resolver for the delivery Agent: resolves like
// dns.lookup normally would, but refuses (calls back with an error instead
// of an address) when ANY candidate address is private/loopback/link-local/
// reserved -- this is what actually closes the SSRF, at the point a real
// socket is about to be opened, immune to a hostname that validates fine at
// subscribe time and is later re-pointed at an internal address (DNS
// rebinding).
function ssrfSafeLookup(hostname_, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'function' ? {} : (options || {});
  dnsLookup(hostname_, { ...opts, all: true }, (err, addresses) => {
    if (err) { cb(err); return; }
    const list = Array.isArray(addresses) ? addresses : [addresses];
    const blocked = list.find((a) => isPrivateOrReservedAddress(a.address, a.family));
    if (blocked) {
      cb(new Error(`notify: refusing to connect to private/reserved address ${blocked.address} (SSRF guard)`));
      return;
    }
    if (opts.all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  });
}

// Lazily created and cached -- most process lifetimes only ever need one.
let ssrfSafeDispatcher = null;
function deliverDispatcher() {
  if (!ssrfSafeDispatcher) ssrfSafeDispatcher = new Agent({ connect: { lookup: ssrfSafeLookup } });
  return ssrfSafeDispatcher;
}

// Shared with webPush.js, which POSTs to an endpoint string that likewise
// arrives from outside the server. Exported rather than duplicated so there is
// one lookup guard to audit, and so a fix to it covers both callers.
export function getSsrfSafeDispatcher() {
  return deliverDispatcher();
}

export function getNotifySockPath() {
  return join(hostRuntimeDir(), NOTIFY_SOCKET_DIR_NAME, 'sock');
}

// Whether the webpush channel can reach anyone right now.
//
// Resolved lazily so this module does not depend on the push store -- and so
// on the database -- existing yet: notify.js is imported far earlier than that
// (sessionManager -> notify -> sandbox), and reading `push_subscriptions` from
// here would break both the boot order and every test that exercises notify
// without a DB. Returns false until server/index.js wires it.
//
// notifyBridge re-exports this rather than keeping its own copy: the whole of
// #234 was the two paths answering "can Web Push reach anyone" differently, so
// there is exactly one binding and index.js's single call answers for both.
//
// The DIRECTION is forced, not a preference: notifyBridge already imports
// notify.js (sendNotification et al), so parking the binding over there and
// having notify.js reach for it would close that edge into a cycle. Whoever
// moves it back will find out the hard way -- it has to live here.
let webpushReachableFn = () => false;
export function setWebpushReachable(fn) {
  webpushReachableFn = typeof fn === 'function' ? fn : (() => false);
}
export function webpushReachable() {
  try {
    return !!webpushReachableFn();
  } catch {
    return false;
  }
}

// Which delivery channels can actually reach a human right now. `channels` is
// sendNotification's argument of the same name: null/undefined means every
// channel, a list restricts to the ones named.
//
// The single answer to "can this notification reach anyone" -- notifyEnabled,
// sendNotification and notifyBridge all ask through here. #234 was two
// implementations of this question disagreeing: the bridge counted Web Push
// and notifyEnabled did not, so a host subscribed only through the browser was
// told the feature was off and never got the `notify` tool at all.
export function reachableChannels(channels) {
  const wanted = (ch) => channels == null || channels.includes(ch);
  const out = [];
  if (wanted('discord') && (!!resolvedDiscordWebhook() || subscriptions.length > 0)) out.push('discord');
  if (wanted('webpush') && webpushReachable()) out.push('webpush');
  return out;
}

// Whether the notify feature is on at all: any channel that can reach someone
// -- a Discord webhook, a non-empty subscription registry (seed + runtime), or
// at least one subscribed browser.
// When false, no MCP server is injected into sessions (see shouldInjectNotify).
export function notifyEnabled() {
  return reachableChannels(null).length > 0;
}

// Pure injection decision for createSession:
//   - shells (app null) never get it,
//   - workers (groupRole !== 'orchestrator') never get it -- only the
//     orchestrator of a combo and standalone agent sessions do,
//   - copilot/commandcode never get it (no CLI-arg/env MCP injection; the
//     notify server would be unreachable), even as a standalone agent,
//   - nothing is injected when the feature is disabled.
export function shouldInjectNotify({ shell, app, groupId, groupRole, notifyEnabled }) {
  return !shell && app != null && app !== 'copilot' && app !== 'commandcode' && !!notifyEnabled
    && (groupId == null || groupRole === 'orchestrator');
}

// The effective Discord webhook, with the same env-over-config precedence
// loadNotifyConfig applies. Exported so notifyBridge can answer "can the
// discord channel actually reach anyone" without re-implementing that rule.
export function resolvedDiscordWebhook() {
  return loadNotifyConfig().discordWebhook || null;
}

export function listSubscriptions() {
  return subscriptions.map((s) => ({ id: s.id, url: s.url, name: s.name, createdAt: s.createdAt }));
}

function persistNotify() {
  try {
    writeFileSync(notifyPath(), JSON.stringify({ subscriptions: listSubscriptions() }));
  } catch {
    // best effort -- persistence must never break subscribe/unsubscribe
  }
}

export function subscribe({ url, name }) {
  if (!isValidWebhookUrl(url)) {
    return { error: 'invalid-url', message: 'webhook url must be an https:// URL' };
  }
  const sub = {
    id: randomUUID(),
    url,
    name: typeof name === 'string' && name.length > 0 ? name : null,
    createdAt: Date.now(),
  };
  subscriptions.push(sub);
  persistNotify();
  return { ok: true, subscription: { id: sub.id, url: sub.url, name: sub.name, createdAt: sub.createdAt } };
}

export function unsubscribe(subscriptionId) {
  const idx = subscriptions.findIndex((s) => s.id === subscriptionId);
  if (idx === -1) return { error: 'not-found' };
  subscriptions.splice(idx, 1);
  persistNotify();
  return { ok: true };
}

// Boot-time restore: seed the registry from sandbox.config.json's
// `notify.subscriptions` (a subscription-less install has no MCP to call
// `subscribe` with, so this is the only way to start from subscriptions
// alone), then overlay the persisted registry (which also holds runtime-only
// additions). Identical URLs are deduped so a seed never double-delivers.
export function restoreNotify() {
  const cfg = loadNotifyConfig();
  const seen = new Set();
  subscriptions = [];
  // The registry is being rebuilt from scratch, so "have we already said
  // nothing can receive this" is stale too -- the next outage after a restore
  // is a new one and has to be reported. Without this the flag is the only
  // notify state that survives a restore, which also makes the warn-once test
  // depend on whichever earlier case happened to leave it false.
  warnedUnreachable = false;
  const add = (url, name, id, createdAt) => {
    if (!isValidWebhookUrl(url) || seen.has(url)) return;
    seen.add(url);
    subscriptions.push({
      id: typeof id === 'string' && id ? id : randomUUID(),
      url,
      name: typeof name === 'string' && name.length > 0 ? name : null,
      createdAt: typeof createdAt === 'number' ? createdAt : Date.now(),
    });
  };
  for (const s of cfg.subscriptions) {
    if (s && typeof s === 'object') add(s.url, s.name);
  }
  try {
    const raw = readJsonFileIfRegular(notifyPath());
    if (raw && Array.isArray(raw.subscriptions)) {
      for (const s of raw.subscriptions) {
        if (s && typeof s === 'object') add(s.url, s.name, s.id, s.createdAt);
      }
    }
  } catch {
    // no persisted registry yet -- the seed alone is fine
  }
  return { subscriptions: listSubscriptions() };
}

// The one string that means something structural downstream: every payload
// ends with "\n\n_from: <host> · <project> · session <id>", which notify.js
// itself appends. Text that arrived from an agent -- the `notify` MCP tool's
// arguments, or bytes it wrote to its pty -- must not be able to forge that.
// Dropping the leading underscore costs nothing legible and makes the real
// marker unforgeable.
//
// Applied to EVERY notification, on every channel, rather than only on the pty
// bridge path: a final attacker review found the MCP path reaching the Web
// Push payload untouched, which is the same "one side fixed, the other left
// open" shape as several earlier findings.
// Matching `_from:` literally was not enough: an attacker review inserted
// characters that render as nothing between the letters -- `_fr<ZWSP>om:`,
// `_from<CGJ>:`, `_from<VS16>:`, `_from<U+E0000>:` -- and every one of them
// read as "_from:" on screen while sliding past the pattern. So the pattern
// tolerates any run of invisibles between the letters and consumes them along
// with the marker.
//
// HONEST LIMIT: this covers characters that are invisible or render blank --
// the default-ignorable set, format and combining marks, plus U+2800 (braille
// blank), U+FFFC and the private-use areas, which a review found rendering as
// nothing in some fonts. It does NOT cover characters that merely LOOK like
// the ones in "_from": full-width `＿from：` and the Cyrillic `_frом:` are
// still possible, and enumerating homoglyphs is not a winnable game. The
// point is that a reader cannot be shown something byte-identical in
// appearance to ccserver's own footer; a near-miss in a different script is a
// weaker trick and is left alone deliberately.
//
// PERFORMANCE IS PART OF THE CONTRACT HERE. The first attempt at this wrote
// the tail as `m <IGN>* \s* <IGN>*:` -- three adjacent quantifiers over
// OVERLAPPING sets (JS's \s contains U+FEFF, which is also Cf). On input like
// `_from` + CGJ x n with no colon, the engine enumerates every way to split
// that run between them: 32k characters took 6.7 SECONDS, 100k took 67.8, and
// a 1MiB MCP argument extrapolated to about two hours of a frozen event loop.
// A defence against an invisible-character bypass had become a far bigger
// hole than the bypass.
//
// The rule that keeps it linear: ONE quantifier per position, over ONE class
// that already contains everything allowed there. Do not reintroduce a second
// star next to this one -- notify.test.js has a timing test that fails if you
// do, but understanding why is cheaper than reading the failure.
const IGN_CHARS = '\\p{Default_Ignorable_Code_Point}\\p{Cf}\\p{Mn}\\u2800\\uFFFC\\p{Co}';
const IGN = `[${IGN_CHARS}]*`;
// The tail additionally allows real whitespace (`_from :`), folded into the
// same single class rather than chained after it.
const IGN_OR_SPACE = `[\\s${IGN_CHARS}]*`;
const FOOTER_MARKER_RE = new RegExp(
  `_${IGN}f${IGN}r${IGN}o${IGN}m${IGN_OR_SPACE}:`,
  'giu',
);

export function defangFooterMarker(text) {
  return typeof text === 'string' ? text.replace(FOOTER_MARKER_RE, 'from:') : text;
}

function buildContent({ title, body, level }) {
  const t = defangFooterMarker(typeof title === 'string' ? title : '');
  const b = defangFooterMarker(typeof body === 'string' ? body : '');
  if (!t && !b) return '';
  const prefix = level && LEVEL_EMOJI[level] ? `${LEVEL_EMOJI[level]} ` : '';
  return `${prefix}${t}${b ? `\n${b}` : ''}`.trim();
}

// First 8 characters of a connection-scoped id (sessionId / groupId) for the
// footer -- enough for tracing, short enough to not drown the payload.
//
// Code points, not UTF-16 units (attacker review L2r). ccserver's own ids are
// UUIDs, but this value arrives in the notify broker's UNAUTHENTICATED identity
// frame, so it is whatever the connecting process said it was -- an id of emoji
// came out of here ending in half a surrogate pair.
function shortId(id) {
  return Array.from(String(id)).slice(0, 8).join('');
}

// The project label for the footer: the session's projectName (basename of
// its cwd, computed in sessionManager) if present, else derived from cwd. The
// filesystem root has no meaningful name, so it is omitted.
function projectLabel(identity) {
  if (identity?.projectName) return String(identity.projectName);
  const cwd = identity?.cwd;
  if (!cwd || cwd === '/') return null;
  return basename(cwd);
}

// One field of the footer. The VALUES here are not ccserver's own: they come
// from the identity frame the process that connected to the notify broker sent
// (see mcpBroker.js), and that socket has no token gate today -- so treat them
// as untrusted strings, not as facts.
//
// An attacker review connected to the broker directly and set
// projectName to "victim-project\n\n_from: sneaky\nfake", which put a whole
// extra forged footer LINE inside the real one. Flattening control characters
// and capping the length is what keeps the footer to one line regardless of
// what the frame said. It does NOT make the values true -- see the note above
// buildAttribution.
const ATTRIBUTION_FIELD_MAX = 64;

function attributionField(value) {
  const flat = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  const defanged = defangFooterMarker(flat);
  // Code points, not UTF-16 units. This is the same defect F3 fixed in
  // pushDelivery's byte-trim, left behind here -- a project name of emoji
  // ended with half a surrogate pair.
  const cps = Array.from(defanged);
  return cps.length > ATTRIBUTION_FIELD_MAX
    ? `${cps.slice(0, ATTRIBUTION_FIELD_MAX - 1).join('')}\u2026`
    : defanged;
}

// Pure footer builder: "_from: <host> · <project> · group <groupShort> ·
// session <sessionShort>". host is always present; project appears when a
// meaningful name exists; group appears only for combo sessions (groupId set);
// session appears when a sessionId is known. identity is the per-connection
// attribution (see mcpBroker.js); null/undefined yields host-only.
//
// WHAT THIS FOOTER IS AND IS NOT. It is ASSEMBLED by ccserver, on one line,
// from fields no caller can split or extend (attributionField above). It is
// NOT an authenticated statement of origin: the notify broker accepts an
// identity frame from whoever connects to its socket, which every sandboxed
// session can reach, and unlike the group control/handoff brokers it does not
// require a token. A process that wanted to could therefore claim another
// session's project name. Closing that is tracked separately -- it is about
// the broker, not about notifications -- see the issue linked from
// docs-site guides/notify.md.
export function buildAttribution(identity, host) {
  const parts = [attributionField(host)];
  const project = projectLabel(identity);
  if (project) parts.push(attributionField(project));
  if (identity?.groupId) parts.push(`group ${attributionField(shortId(identity.groupId))}`);
  if (identity?.sessionId) parts.push(`session ${attributionField(shortId(identity.sessionId))}`);
  return `\n\n_from: ${parts.join(' · ')}`;
}

// The fetch paired with our Agent. NOT globalThis.fetch: Node's built-in fetch
// is backed by Node's OWN bundled undici, which refuses an Agent constructed by
// the `undici` package we depend on ("UND_ERR_INVALID_ARG: invalid onError
// method" on Node >= 24). An attacker review found that this made EVERY webhook
// delivery fail with a bare "fetch failed" on modern Node, and -- worse --
// turned the connect-time SSRF guard into dead code, since the request never
// reached the dispatcher at all. Using undici's own fetch keeps the two halves
// on the same implementation.
//
// Tests that stub delivery replace this via _setDeliverFetchForTests rather
// than globalThis.fetch, precisely so they exercise the same seam production
// uses instead of one that quietly diverged from it.
let deliverFetch = undiciFetch;

export function _setDeliverFetchForTests(fn) {
  deliverFetch = fn || undiciFetch;
}

export function _getDeliverFetch() {
  return deliverFetch;
}

// undici reports every connect-time failure as a bare "fetch failed" and puts
// the actual reason in `err.cause` -- including our OWN SSRF guard's refusal.
// Logging only the outer message makes "the guard refused this" look exactly
// like "the plumbing is broken", which is how a dead dispatcher went unnoticed
// through two Node majors (attacker review F2). Both delivery paths -- webhook
// here and Web Push in webPush.js -- report the cause as well.
export function describeFetchError(err) {
  const message = err?.message || String(err);
  const cause = err?.cause?.message;
  if (!cause || cause === message) return message;
  return `${message}: ${cause}`;
}

async function deliver(url, content) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await deliverFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // allowed_mentions: attacker review N4. `content` is agent-authored text
      // (the notify MCP tool's arguments, and from Step 3 whatever an agent
      // wrote to its pty), and a Discord webhook treats "@everyone"/"@here"/
      // "<@&role>" in the body as real pings by default. An empty `parse` list
      // turns every mention in the payload into inert text without altering
      // what the human reads. Non-Discord webhooks just see one extra JSON key
      // they ignore. Markdown itself is deliberately NOT escaped: agents use it
      // on purpose, and it cannot ping anyone.
      body: JSON.stringify({ content, username: 'ccserver', allowed_mentions: { parse: [] } }),
      signal: controller.signal,
      // H4: never silently follow a redirect -- a webhook host an agent
      // fully controls could otherwise 30x this POST at an internal
      // endpoint that never appeared in the subscribed URL at all.
      redirect: 'error',
      // H4: validates the resolved address at actual connect time (see
      // ssrfSafeLookup above) -- catches a hostname that re-resolves to a
      // private/internal address after passing subscribe-time validation.
      dispatcher: deliverDispatcher(),
    });
    return res.ok;
  } catch (err) {
    console.warn(`[notify] delivery to ${url} failed: ${describeFetchError(err)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Warned once per transition into "nothing can receive this" rather than on
// every call: an agent in a loop would otherwise bury the log in the same
// line. Reset as soon as a channel comes back, so the next outage is reported
// again.
let warnedUnreachable = false;
function warnUnreachable(channels) {
  if (warnedUnreachable) return;
  warnedUnreachable = true;
  const which = channels == null ? 'every channel is' : `channels [${channels.join(', ')}] are`;
  console.warn(`[notify] ${which} selected but nothing is configured to reach anyone; `
    + 'set notify.discordWebhook / notify.subscriptions, or subscribe a browser to Web Push');
}

// Dispatch to every configured channel (Discord webhook + each subscribed
// webhook), all non-blocking. Returns the delivery tally for the MCP tool's
// result payload; never throws. `identity` is the optional per-connection
// attribution ({ sessionId, groupId, groupRole, cwd, projectName, app }, see
// mcpBroker.js): when present -- and notify.attribution is not disabled -- the
// payload's content gets an "_from: host · project · group · session" footer
// appended. Without identity the payload is delivered as before (host-only
// footer).
//
// `channels` (Issue #152) lets a caller restrict delivery to a subset of the
// configured channels; omitting it (null/undefined) keeps the original
// behavior of delivering to everything that is configured. 'discord' covers
// the Discord webhook AND every subscribed webhook together -- they are not
// split further, since nothing has ever needed to control them independently.
// `delivered`'s shape is unchanged either way -- an excluded channel looks
// exactly like that channel being unconfigured (discord:false/webhooks:0).
//
// The Vikunja channel that used to live here was removed: task tracking is a
// different concern from "ping a human" and is being re-cut as its own MCP
// server (see the follow-up issue linked from docs-site guides/notify.md).
export async function sendNotification({
  title, body, level, channels,
} = {}, identity) {
  const cfg = loadNotifyConfig();
  let content = buildContent({ title, body, level });
  if (content && cfg.attribution) {
    content += buildAttribution(identity, cfg.hostname);
  }
  if (!content) {
    return { ok: true, delivered: { discord: false, webhooks: 0, failed: 0 } };
  }
  // #234: the same "can this reach anyone" check the bridge has done since its
  // F5 finding, now on the MCP-tool path too. Without it a call with nothing
  // configured -- or naming only a channel nothing backs -- fans out to zero
  // targets and still reports ok:true, so neither the agent that called it nor
  // the operator learns the notification died.
  //
  // Deliberately minimal: `delivered` keeps the shape every caller already
  // reads, and the zero-target case is reported through ok/reason alone. The
  // redesign of `delivered` (unset vs failed, Discord missing from `failed`)
  // is #235 and is not touched here.
  const reachable = reachableChannels(channels);
  if (reachable.length === 0) {
    warnUnreachable(channels);
    return { ok: false, reason: 'no-reachable-channel', delivered: { discord: false, webhooks: 0, failed: 0 } };
  }
  warnedUnreachable = false;
  const wantDiscordChannel = channels == null || channels.includes('discord');
  const targets = [];
  if (wantDiscordChannel) {
    if (cfg.discordWebhook) targets.push(cfg.discordWebhook);
    for (const s of subscriptions) targets.push(s.url);
  }
  // Web Push (plan-notify-bridge Step 4). Dispatched alongside the webhook
  // fan-out rather than after it, and reached through a lazy dynamic import so
  // the static graph stays acyclic (pushDelivery pulls in modules that import
  // this one -- same reasoning as mcpBroker.js above).
  const wantWebpush = channels == null || channels.includes('webpush');
  const [results, push] = await Promise.all([
    Promise.all(targets.map((url) => deliver(url, content))),
    wantWebpush ? deliverWebpush({ title, body, level, identity, cfg }) : Promise.resolve(null),
  ]);

  const discord = wantDiscordChannel && cfg.discordWebhook ? results[0] : false;
  const webhookResults = wantDiscordChannel && cfg.discordWebhook ? results.slice(1) : results;
  const delivered = {
    discord,
    webhooks: webhookResults.filter(Boolean).length,
    failed: webhookResults.filter((r) => !r).length,
  };
  // Omitted entirely when the channel was excluded or nothing is subscribed,
  // mirroring how an unconfigured Discord webhook simply reports discord:false.
  if (push) delivered.webpush = push;
  return { ok: true, delivered };
}

// Best effort: a push failure must never change what the webhook channels
// report, and must never throw into the caller (an agent's MCP tool call, or a
// pty data handler by way of notifyBridge).
async function deliverWebpush({ title, body, level, identity, cfg }) {
  try {
    const mod = await import('./pushDelivery.js');
    if (!mod.webpushConfigured()) return null;
    const res = await mod.deliverToSubscribers({
      title,
      body,
      level,
      // The browser gets the attribution as its own field rather than as text
      // appended to the body, so the Service Worker can render it separately.
      attribution: cfg.attribution ? buildAttribution(identity, cfg.hostname).replace(/^\n\n_from: /, '') : null,
      // One notification per session replaces the previous one for that
      // session instead of stacking, which is what makes a phone usable.
      tag: identity?.sessionId ? `ccserver-${shortId(identity.sessionId)}` : 'ccserver',
    });
    return res;
  } catch (err) {
    console.warn(`[notify] web push delivery failed: ${err?.message || err}`);
    return { sent: 0, failed: 0, pruned: 0 };
  }
}

// The notifyApi facade handed to buildNotifyMcpServer (see mcpServer.js).
// Deliberately a closed object rather than the module namespace, mirroring
// groupManager's facade pattern.
export const notifyApi = {
  sendNotification,
  subscribe,
  unsubscribe,
  listSubscriptions,
};

// Start (once) the global Unix-socket broker hosting ccserver-notify. Callers
// must await it before launching sessions: bwrap's --bind-try snapshots the
// socket file at mount time, so the file must exist first. Safe to call
// repeatedly -- the second call is a no-op returning the existing socket path.
export async function ensureNotifyBroker() {
  if (notifyBroker) return notifyBroker.sockPath;
  const broker = await import('./mcpBroker.js');
  stopBrokerFn = broker.stopBroker;
  notifyBroker = await broker.startNotifyBroker({
    notifyApi,
    sockPath: getNotifySockPath(),
  });
  return notifyBroker.sockPath;
}

// Whether the global broker is actually listening right now. Injecting the
// notify MCP into a session whose socket was never started (broker startup
// failure, or a config edit that enables notify without a restart) would give
// the agent a bridge to a socket nobody is listening on -- the wrapper would
// exhaust its retries and the MCP server would just fail. createSession gates
// its injection on this in addition to shouldInjectNotify.
export function notifyBrokerRunning() {
  return !!notifyBroker;
}

// Teardown for graceful shutdown. Synchronous (the stopBroker reference is
// cached on the first ensureNotifyBroker call). Best effort; a stale socket
// file is removed by the next boot's listenMcp anyway.
let stopBrokerFn = null;
export function stopNotifyBroker() {
  if (!notifyBroker) return;
  try {
    if (stopBrokerFn) stopBrokerFn(notifyBroker);
  } catch {
    // best effort
  }
  notifyBroker = null;
}
