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
// (${XDG_RUNTIME_DIR}/ccserver-notify.sock, see getNotifySockPath). Each
// session's sandbox binds that one socket in; the MCP config tells the agent
// to reach it through the same bridge wrapper as the group brokers (see
// mcpConfig.js / sandbox-mcp-wrapper.cjs).
//
// This module imports mcpBroker.js lazily (dynamic import) so the static
// import graph stays acyclic: sessionManager -> notify -> sandbox, and the
// broker/server/tools modules pull in sessionManager (via mcpTools) -- the
// broker wiring is only touched at runtime, never at module evaluation.

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSandboxConfig } from './sandbox.js';
import { vikunjaEnabled, createOrUpdateTask } from './vikunjaClient.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Persisted subscription registry (same pattern as .saved-groups.json /
// .saved-sessions.json). Read at each use (like loadSandboxConfig's env
// override) so tests can point it at a temp file without touching the real
// repo-root state file.
function notifyPath() {
  return process.env.CCSERVER_NOTIFY_PATH || join(__dirname, '..', '..', '.saved-notifications.json');
}

const NOTIFY_SOCKET_NAME = 'ccserver-notify.sock';
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

function isValidWebhookUrl(url) {
  return typeof url === 'string' && url.startsWith('https://');
}

export function getNotifySockPath() {
  const base = process.env.XDG_RUNTIME_DIR
    || (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : '/tmp');
  return join(base, NOTIFY_SOCKET_NAME);
}

// Whether the notify feature is on at all: a Discord webhook configured, a
// non-empty subscription registry (seed + runtime), or Vikunja configured
// (baseUrl + apiToken -- see vikunjaClient.js). This lets a Vikunja-only setup
// (no Discord webhook, no subscriptions) still get the MCP server injected --
// confirmed with the user rather than left as the plan's open question.
// When false, no MCP server is injected into sessions (see shouldInjectNotify).
export function notifyEnabled() {
  const cfg = loadNotifyConfig();
  return !!(cfg.discordWebhook || subscriptions.length > 0 || vikunjaEnabled());
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
    const raw = JSON.parse(readFileSync(notifyPath(), 'utf-8'));
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

function buildContent({ title, body, level }) {
  const t = typeof title === 'string' ? title : '';
  const b = typeof body === 'string' ? body : '';
  if (!t && !b) return '';
  const prefix = level && LEVEL_EMOJI[level] ? `${LEVEL_EMOJI[level]} ` : '';
  return `${prefix}${t}${b ? `\n${b}` : ''}`.trim();
}

// First 8 chars of a connection-scoped id (sessionId / groupId) for the
// footer -- enough for tracing, short enough to not drown the payload.
function shortId(id) {
  return String(id).slice(0, 8);
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

// Pure footer builder: "_from: <host> · <project> · group <groupShort> ·
// session <sessionShort>". host is always present; project appears when a
// meaningful name exists; group appears only for combo sessions (groupId set);
// session appears when a sessionId is known. identity is the per-connection
// attribution (see mcpBroker.js); null/undefined yields host-only.
export function buildAttribution(identity, host) {
  const parts = [String(host)];
  const project = projectLabel(identity);
  if (project) parts.push(project);
  if (identity?.groupId) parts.push(`group ${shortId(identity.groupId)}`);
  if (identity?.sessionId) parts.push(`session ${shortId(identity.sessionId)}`);
  return `\n\n_from: ${parts.join(' · ')}`;
}

async function deliver(url, content) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, username: 'ccserver' }),
      signal: controller.signal,
    });
    return res.ok;
  } catch (err) {
    console.warn(`[notify] delivery to ${url} failed: ${err.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Dispatch to every configured channel (Discord webhook + each subscribed
// webhook + Vikunja), all non-blocking. Returns the delivery tally for the MCP
// tool's result payload; never throws. `identity` is the optional
// per-connection attribution ({ sessionId, groupId, groupRole, cwd,
// projectName, app }, see mcpBroker.js): when present -- and notify.attribution
// is not disabled -- the payload's content gets an "_from: host · project ·
// group · session" footer appended. Without identity the payload is delivered
// as before (host-only footer). The notify tool's own args are unchanged.
export async function sendNotification({ title, body, level } = {}, identity) {
  const cfg = loadNotifyConfig();
  let content = buildContent({ title, body, level });
  if (content && cfg.attribution) {
    content += buildAttribution(identity, cfg.hostname);
  }
  if (!content) {
    return { ok: true, delivered: { discord: false, webhooks: 0, failed: 0 } };
  }
  const targets = [];
  if (cfg.discordWebhook) targets.push(cfg.discordWebhook);
  for (const s of subscriptions) targets.push(s.url);
  // Vikunja tracks one task per notification key (groupId, falling back to
  // sessionId) rather than per-URL like the webhook targets above, so it is
  // dispatched alongside the Promise.all instead of folded into `targets`.
  const vikunjaKey = identity?.groupId ?? identity?.sessionId ?? null;
  const wantVikunja = vikunjaEnabled() && vikunjaKey != null;
  const [results, vikunjaResult] = await Promise.all([
    Promise.all(targets.map((url) => deliver(url, content))),
    wantVikunja ? createOrUpdateTask({ key: vikunjaKey, title, body, level, identity }) : Promise.resolve(null),
  ]);
  const discord = cfg.discordWebhook ? results[0] : false;
  const webhookResults = cfg.discordWebhook ? results.slice(1) : results;
  const delivered = {
    discord,
    webhooks: webhookResults.filter(Boolean).length,
    failed: webhookResults.filter((r) => !r).length,
  };
  if (vikunjaResult) {
    delivered.vikunja = { ok: vikunjaResult.ok, action: vikunjaResult.action, taskId: vikunjaResult.taskId ?? null };
  }
  return { ok: true, delivered };
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
