// Vikunja task tracking for ccserver-notify (see notify.js). A `notify` call
// also creates/updates a Vikunja task per tracking key (identity.groupId ??
// identity.sessionId), so a human who misses the Discord ping still finds an
// actionable item in Vikunja. See tmp/notify-vikunja-integration-plan.md
// sections 2-3 for the full design rationale.
//
// The REST calls below were verified against the official Vikunja OpenAPI
// spec (<instance>/api/v1/docs.json, a Swagger 2.0 doc; checked against
// https://try.vikunja.io on 2026-08-21) -- the vikunja-agent-tools README this
// plan was scoped from does not document exact paths:
//   PUT    /projects/{id}/tasks        create task    { title, description }
//   PUT    /tasks/{id}/comments        add a comment  { comment }
//   GET    /labels?s=<title>           find a label by title (labels are
//                                      global per Vikunja account, not
//                                      per-project)
//   PUT    /labels                     create a label { title, hex_color }
//   PUT    /tasks/{id}/labels          attach a label { label_id }
//   DELETE /tasks/{id}/labels/{label}  detach a label
//
// The bucket (Kanban column) calls below were NOT verified against a live
// instance's docs.json (no notify.vikunja.baseUrl/apiToken was configured in
// this environment) -- they're assembled from community.vikunja.io threads
// and the go-vikunja security advisories for the move-task endpoint
// (GHSA-5pg6-m483-7vrg, GHSA-569v-q83c-3j3g). Re-verify against the live
// instance's /api/v1/docs.json before relying on this in production, per the
// plan this was implemented from (~/.claude/plans/indexed-wondering-owl.md):
//   GET  /projects/{id}/views                         list views, find
//                                                      view_kind: 'kanban'
//   GET  /projects/{id}/views/{view}/buckets           list buckets
//   PUT  /projects/{id}/views/{view}/buckets           create a bucket
//                                                      { title }
//   POST /projects/{id}/views/{view}/buckets/{bucket}/tasks
//                                                      move a task into the
//                                                      bucket { task_id }
//
// Deliberately not implemented (see plan 2.3 / section 5): deleting a task,
// or re-checking its live labels/bucket before updating it -- tracking state
// lives purely in .saved-vikunja-tasks.json, so a task a human completed by
// hand in Vikunja can still get a stray comment on the next notify (an
// accepted tradeoff, not a bug).
//
// Marking a task `done: true` on level 'success' was implemented and then
// *removed* (see tmp/vikunja-mark-done-plan.md for the original rationale,
// and ~/.claude/plans/indexed-wondering-owl.md for why it was reverted): a
// human reported that Vikunja's own "moving a task into the done bucket sets
// done, and vice versa" behavior made a Claude-reported success vanish from
// the board's open-task view at exactly the moment a human needed to see it
// and hand over the next prompt. `done` is now left entirely to the human;
// the Doing/To-Do bucket below stands in for "whose turn is it".
//
// The .saved-vikunja-tasks.json tracking entry for a key is never dropped on
// `success` either (it used to be, back when success also meant "done" --
// see above): one Vikunja card is reused for the whole lifetime of a
// tracking key (a combo's groupId, or a standalone sessionId), its bucket
// swinging Doing/To-Do with every notify, rather than a fresh card being
// created each time the key reports success. A new key (new combo/session)
// still starts a fresh card.

import { readFileSync, writeFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from 'undici';
import { loadSandboxConfig } from './sandbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function tasksPath() {
  return process.env.CCSERVER_VIKUNJA_TASKS_PATH || join(__dirname, '..', '..', '.saved-vikunja-tasks.json');
}

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 50;
const LEVEL_EMOJI = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '🚨' };

// notify level -> Vikunja status label suffix + label color (plan 2.3).
// `success` is the only terminal level -- error/warning stay tracked so a
// human working the Vikunja backlog keeps seeing updates until they resolve
// it out-of-band (Discord is easy to miss; Vikunja is meant to be the TODO
// list that isn't).
const LEVEL_STATUS = {
  info: { suffix: 'running', color: '3498db' },
  success: { suffix: 'completed', color: '2ecc71' },
  warning: { suffix: 'blocked', color: 'f39c12' },
  error: { suffix: 'needs-input', color: 'e74c3c' },
};
// notify level -> which Kanban bucket "turn" the task belongs in. `info` is
// the only level where Claude is actively working (Doing); every other
// level means Claude has stopped and it's the human's turn (To-Do) --
// including `success`, since finishing is exactly when a human needs to
// check in and hand over the next prompt, not when the card should look
// finished. warning/error don't get a bucket of their own: the distinction
// between "done", "blocked" and "needs input" is left to the status label
// above -- the bucket only answers "whose turn is it".
const LEVEL_BUCKET_KIND = { info: 'doing', success: 'todo', warning: 'todo', error: 'todo' };

// baseUrl/apiToken/projectId/etc are already resolved (env > config file >
// default) by loadSandboxConfig -- see sandbox.js's rawVikunja parsing.
export function vikunjaConfig() {
  return loadSandboxConfig().notify?.vikunja || {};
}

export function vikunjaEnabled() {
  const cfg = vikunjaConfig();
  return !!(cfg.baseUrl && cfg.apiToken);
}

function readTasks() {
  try {
    const raw = JSON.parse(readFileSync(tasksPath(), 'utf-8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch {
    return {};
  }
}

function writeTasks(map) {
  try {
    writeFileSync(tasksPath(), JSON.stringify(map));
  } catch {
    // best effort -- mirrors notify.js's persistNotify
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Duplicated (not imported) from notify.js's resolvedHostname/buildAttribution:
// notify.js imports this module, so importing back would create a cycle.
// Kept deliberately small.
function resolvedHost() {
  const notify = loadSandboxConfig().notify || {};
  return process.env.CCSERVER_HOSTNAME || notify.hostname || osHostname();
}

function shortId(id) {
  return String(id).slice(0, 8);
}

function projectLabel(identity) {
  if (identity?.projectName) return String(identity.projectName);
  const cwd = identity?.cwd;
  if (!cwd || cwd === '/') return null;
  return basename(cwd);
}

function footer(identity) {
  const parts = [resolvedHost()];
  const project = projectLabel(identity);
  if (project) parts.push(project);
  if (identity?.groupId) parts.push(`group ${shortId(identity.groupId)}`);
  if (identity?.sessionId) parts.push(`session ${shortId(identity.sessionId)}`);
  return `\n\n_from: ${parts.join(' · ')}`;
}

// A dispatcher that skips TLS verification, for notify.vikunja.verifyTls:
// false (self-signed instances). Built with the `undici` package pinned to
// the major version Node's own built-in fetch bundles internally -- a
// mismatched version makes fetch reject the dispatcher outright (see the
// npm undici@8 vs Node 22's bundled v6 incompatibility found while
// implementing this). Lazily created and cached: most setups never need it.
let insecureDispatcher = null;
function dispatcherFor(config) {
  if (config.verifyTls !== false) return undefined;
  if (!insecureDispatcher) insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  return insecureDispatcher;
}

const BODY_LOG_MAX_CHARS = 500;

// Best-effort: read the response body for a failure log line only. Never
// throws -- a read failure just means the log line omits the body, it must
// not affect the { ok: false, ... } result the caller already gets. Safe to
// log (unlike the URL/token, see below): it's Vikunja's response, not the
// request's secrets.
async function readBodyForLog(res) {
  try {
    const text = await res.text();
    if (!text) return null;
    return text.length > BODY_LOG_MAX_CHARS ? `${text.slice(0, BODY_LOG_MAX_CHARS)}…` : text;
  } catch {
    return null;
  }
}

// Low-level request: 4xx fails immediately (no retry), 5xx and network/
// timeout errors retry up to MAX_ATTEMPTS with exponential backoff (plan 3).
// `label` is a short static tag for logging -- never the URL or headers,
// since the base URL plus the bearer token must never reach the log (plan
// 2.5).
async function vikunjaFetch(config, method, path, body, label) {
  const url = `${config.baseUrl}/api/v1${path}`;
  const headers = { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (config.timeoutSeconds || 15) * 1000);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        dispatcher: dispatcherFor(config),
      });
      clearTimeout(timer);
      if (res.ok) {
        // The HTTP request itself already succeeded -- never fall through to
        // the retry path below over a body we failed to read/parse, since
        // that would resend a non-idempotent PUT/DELETE (e.g. a duplicate
        // task or comment) for a request Vikunja already applied.
        let responseBody = null;
        try {
          const text = await res.text();
          responseBody = text ? JSON.parse(text) : null;
        } catch { /* treat as no body -- still a success */ }
        return { ok: true, status: res.status, body: responseBody };
      }
      if (res.status < 500) {
        const bodyText = await readBodyForLog(res);
        console.warn(`[vikunja] ${label} failed: HTTP ${res.status}${bodyText ? ` -- ${bodyText}` : ''}`);
        return { ok: false, status: res.status, body: null };
      }
      if (attempt === MAX_ATTEMPTS) {
        const bodyText = await readBodyForLog(res);
        console.warn(`[vikunja] ${label} failed after ${MAX_ATTEMPTS} attempts: HTTP ${res.status}${bodyText ? ` -- ${bodyText}` : ''}`);
        return { ok: false, status: res.status, body: null };
      }
    } catch (err) {
      clearTimeout(timer);
      if (attempt === MAX_ATTEMPTS) {
        console.warn(`[vikunja] ${label} failed after ${MAX_ATTEMPTS} attempts: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
        return { ok: false, status: null, body: null };
      }
    }
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
  }
  return { ok: false, status: null, body: null };
}

async function findLabelId(config, title) {
  const res = await vikunjaFetch(config, 'GET', `/labels?s=${encodeURIComponent(title)}`, undefined, 'find-label');
  if (!res.ok || !Array.isArray(res.body)) return null;
  const exact = res.body.find((l) => l && l.title === title);
  return exact ? exact.id : null;
}

async function findOrCreateLabelId(config, title, color) {
  const existing = await findLabelId(config, title);
  if (existing != null) return existing;
  const created = await vikunjaFetch(config, 'PUT', '/labels', { title, hex_color: color }, 'create-label');
  return created.ok && created.body ? created.body.id : null;
}

// Detach the previous status label (if resolvable -- best effort, never
// blocks the swap) and attach the next one, auto-creating it if this is the
// project's first task at that status (plan 5.4).
async function swapStatusLabel(config, taskId, prevLevel, nextLevel) {
  const prefix = config.statusLabelPrefix || 'status-';
  const next = LEVEL_STATUS[nextLevel] || LEVEL_STATUS.info;
  if (prevLevel) {
    const prev = LEVEL_STATUS[prevLevel] || LEVEL_STATUS.info;
    if (prev.suffix !== next.suffix) {
      const prevId = await findLabelId(config, `${prefix}${prev.suffix}`);
      if (prevId != null) {
        await vikunjaFetch(config, 'DELETE', `/tasks/${taskId}/labels/${prevId}`, undefined, 'detach-label');
      }
    }
  }
  const nextId = await findOrCreateLabelId(config, `${prefix}${next.suffix}`, next.color);
  if (nextId != null) {
    await vikunjaFetch(config, 'PUT', `/tasks/${taskId}/labels`, { label_id: nextId }, 'attach-label');
  }
}

// The project's Kanban view id, memoized per baseUrl+projectId (a project's
// views rarely change). Only a successful lookup is cached -- a request
// failure (network blip, instance down) must not wedge every later notify
// into skipping the bucket move for the rest of the process lifetime.
const kanbanViewIdCache = new Map();

async function findKanbanViewId(config) {
  const cacheKey = `${config.baseUrl}::${config.projectId}`;
  if (kanbanViewIdCache.has(cacheKey)) return kanbanViewIdCache.get(cacheKey);
  const res = await vikunjaFetch(config, 'GET', `/projects/${config.projectId}/views`, undefined, 'list-views');
  if (!res.ok || !Array.isArray(res.body)) return null;
  const kanban = res.body.find((v) => v && v.view_kind === 'kanban');
  const viewId = kanban ? kanban.id : null;
  kanbanViewIdCache.set(cacheKey, viewId);
  return viewId;
}

async function findBucketId(config, viewId, title) {
  const res = await vikunjaFetch(config, 'GET', `/projects/${config.projectId}/views/${viewId}/buckets`, undefined, 'list-buckets');
  if (!res.ok || !Array.isArray(res.body)) return null;
  const exact = res.body.find((b) => b && b.title === title);
  return exact ? exact.id : null;
}

async function findOrCreateBucketId(config, viewId, title) {
  const existing = await findBucketId(config, viewId, title);
  if (existing != null) return existing;
  const created = await vikunjaFetch(config, 'PUT', `/projects/${config.projectId}/views/${viewId}/buckets`, { title }, 'create-bucket');
  return created.ok && created.body ? created.body.id : null;
}

// Move the task into the bucket, best-effort like swapStatusLabel -- a
// failure here must not affect the overall createOrUpdateTask result (the
// status label already reflects the level either way).
async function moveTaskToBucket(config, viewId, bucketId, taskId) {
  await vikunjaFetch(config, 'POST', `/projects/${config.projectId}/views/${viewId}/buckets/${bucketId}/tasks`, { task_id: taskId }, 'move-bucket');
}

// Move the task into the Doing/To-Do bucket matching nextLevel's "turn" (see
// LEVEL_BUCKET_KIND), skipping the move entirely when prev/next resolve to
// the same bucket kind -- unlike labels, a bucket move is exclusive (a task
// only ever sits in one bucket), so there's no separate detach step.
// Resolving the view/bucket ids costs a few extra requests; any failure
// along the way (no Kanban view configured, a transient error) just skips
// the move rather than blocking the notify.
async function swapStatusBucket(config, taskId, prevLevel, nextLevel) {
  const nextKind = LEVEL_BUCKET_KIND[nextLevel] || LEVEL_BUCKET_KIND.info;
  if (prevLevel) {
    const prevKind = LEVEL_BUCKET_KIND[prevLevel] || LEVEL_BUCKET_KIND.info;
    if (prevKind === nextKind) return;
  }
  const viewId = await findKanbanViewId(config);
  if (viewId == null) return;
  const buckets = config.buckets || {};
  const title = nextKind === 'doing' ? (buckets.doing || 'Doing') : (buckets.todo || 'To-Do');
  const bucketId = await findOrCreateBucketId(config, viewId, title);
  if (bucketId == null) return;
  await moveTaskToBucket(config, viewId, bucketId, taskId);
}

function commentText(title, body, level) {
  const emoji = level && LEVEL_EMOJI[level] ? `${LEVEL_EMOJI[level]} ` : '';
  const t = typeof title === 'string' ? title : '';
  const b = typeof body === 'string' ? body : '';
  return `${emoji}${t}${b ? `\n${b}` : ''}`.trim();
}

// Create or update the Vikunja task tracked for `key` (plan 2.1/2.2). Never
// throws; a failure at any step is logged and returned as { ok: false } so
// sendNotification's non-blocking contract (notify.js) holds.
export async function createOrUpdateTask({ key, title, body, level, identity }) {
  if (key == null) return { ok: false, action: 'skipped', taskId: null };
  const config = vikunjaConfig();
  if (!(config.baseUrl && config.apiToken)) return { ok: false, action: 'skipped', taskId: null };
  const lvl = LEVEL_STATUS[level] ? level : 'info';

  const tasks = readTasks();
  const existing = tasks[key];

  if (!existing) {
    if (!config.projectId) {
      console.warn('[vikunja] create-task skipped: no projectId configured');
      return { ok: false, action: 'error', taskId: null };
    }
    const description = `${typeof body === 'string' ? body : ''}${footer(identity)}`;
    const created = await vikunjaFetch(
      config, 'PUT', `/projects/${config.projectId}/tasks`,
      { title: typeof title === 'string' ? title : '', description },
      'create-task',
    );
    if (!created.ok || !created.body?.id) return { ok: false, action: 'error', taskId: null };
    const taskId = created.body.id;
    await swapStatusLabel(config, taskId, null, lvl);
    await swapStatusBucket(config, taskId, null, lvl);
    // The card is kept tracked regardless of level (including 'success') --
    // it's reused for the whole lifetime of this key, see the header comment.
    tasks[key] = { taskId, lastLevel: lvl, createdAt: Date.now() };
    writeTasks(tasks);
    return { ok: true, action: 'created', taskId };
  }

  const taskId = existing.taskId;
  const comment = await vikunjaFetch(
    config, 'PUT', `/tasks/${taskId}/comments`,
    { comment: commentText(title, body, level) },
    'add-comment',
  );
  await swapStatusLabel(config, taskId, existing.lastLevel, lvl);
  await swapStatusBucket(config, taskId, existing.lastLevel, lvl);
  tasks[key] = { ...existing, lastLevel: lvl };
  writeTasks(tasks);
  return { ok: comment.ok, action: 'updated', taskId };
}
