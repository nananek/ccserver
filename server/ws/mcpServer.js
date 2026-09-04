// MCP servers for combo groups, hosted in the main Node process (same process
// as the pty sessions, so tools can reach sessions/outputBuffers directly).
// Runs over a Unix socket via SocketTransport -- MCP's stdio framing is
// newline-delimited JSON, so no framing conversion is needed.
//
// Two distinct servers per group:
//   control (buildControlMcpServer)  -- reachable only by the orchestrator
//     socket. Tools can inspect/type into any member and wait for handoffs.
//   handoff (buildHandoffMcpServer)  -- one per worker socket, exposing only
//     handoffToOrchestrator. The worker cannot read other sessions.
//
// groupId / sessionId / role are bound in the per-connection closure; they are
// never taken from tool arguments (see mcpTools.js -- the authorization
// boundary depends on this).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as tools from './mcpTools.js';
import * as metaTools from './metaTools.js';

// Newline-delimited JSON frames: a well-behaved MCP client sends a newline
// per message, so a buffer beyond this means the peer is not speaking MCP
// (or is hostile). Bounds the memory a single connection can pin. Exported
// so the broker can size the pre-transport identity-frame read identically
// (see mcpBroker.js).
export const MAX_TRANSPORT_BUFFER_CHARS = 1024 * 1024;

export class SocketTransport {
  // `initialBuffer` seeds the parser with bytes already read before the
  // transport took over (the broker replays a non-identity first line here).
  constructor(socket, initialBuffer = '') {
    this.socket = socket;
    this._buf = initialBuffer;
    this._closed = false;
  }

  start() {
    this.socket.setEncoding('utf-8');
    this.socket.on('data', (chunk) => {
      if (this._closed) return;
      this._buf += chunk;
      this._drain();
    });
    this.socket.on('close', () => {
      this._closed = true;
      this.onclose?.();
    });
    this.socket.on('error', (e) => this.onerror?.(e));
    // The broker pauses the socket while it reads the identity frame; resume
    // it now that this transport owns the connection.
    this.socket.resume();
    // Drain bytes seeded before start (a replayed non-identity first line) --
    // onmessage is wired by the MCP SDK before start() is called.
    this._drain();
  }

  _drain() {
    // The socket path is reachable by anything running as the same user,
    // not just the group's sandbox: a peer that never sends a newline
    // must not be able to grow this buffer without bound. Over the cap,
    // drop the connection (the in-flight partial frame is unrecoverable).
    if (this._buf.length > MAX_TRANSPORT_BUFFER_CHARS) {
      try { this.socket.destroy(); } catch { /* already gone */ }
      this._closed = true;
      return;
    }
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      if (line.trim()) {
        try {
          this.onmessage?.(JSON.parse(line));
        } catch {
          // drop malformed frames
        }
      }
    }
  }

  send(message) {
    this.socket.write(`${JSON.stringify(message)}\n`);
    return Promise.resolve();
  }

  close() {
    this.socket.end();
  }
}

// deps: { groupId, groupManager, sessionManager }
export function buildControlMcpServer(deps) {
  const server = new McpServer({ name: 'ccserver-control', version: '1.0.0' });

  server.tool(
    'list_group_sessions',
    'List all sessions in this orchestration group (workers and orchestrator) with role, app, cwd, live status, autoYes (whether automatic permission-approval is enabled; null when the member has no live session, e.g. a restored one), idleForMs (ms since each session last produced output; null when no live session exists), and dockerAvailable/dockerReason (see get_tab_status -- whether THIS member can currently use docker). A member expected to be working but showing a large idleForMs may be stuck -- that is a concrete anomaly signal on its own: confirm with a single read_output and go back to waiting; absent such signals, keep waiting on wait_for_handoff instead of polling. Before handing a member a docker-dependent task, check its dockerAvailable here rather than finding out from a failure: a rootless dockerd can only serve ONE session per project at a time (the same project opened in two sandboxes only gives docker to whichever session\'s dockerd actually won the startup race, which is NOT necessarily workerA -- check, don\'t assume).',
    {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(tools.listGroupSessions(deps)) }] }),
  );

  server.tool(
    'read_output',
    'Read the recent terminal output of a group member session. Returns raw bytes and ANSI-stripped text plus a screen view: screen (the member\'s current visible screen -- its latest rows, capped at 40 lines of 80 chars; the raw byte stream cannot show this because TUI spinners redraw in place via cursor moves and line erases), screenAlt (whether an alternate screen is active), screenTruncated (when the screen view was cut to its cap) and screenIdleMs (ms since the screen last visibly changed -- a spinner keeps this small, a static prompt makes it grow; prefer screenIdleMs over idleForMs for busy/idle judgments, since bytes can keep flowing while the screen is unchanged). tail is a count of output chunks (default 200; the server buffers up to ~512KB of the most recent output, chunked), not characters. The returned text is capped at 16KB (the buffer tail) with truncated:true when the cap is hit. This is a fallback for inspecting a possibly-stuck member, NOT a progress-check tool -- for normal flow, prefer wait_for_handoff and let pending work come back to you. Justify every call with a concrete anomaly signal (repeated wait_for_handoff timeouts, a stuck-looking idleForMs/screenIdleMs reported by get_tab_status/list_group_sessions, or the worker reporting trouble) and read once; never poll this for reassurance.',
    { sessionId: z.string(), tail: z.number().optional() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(tools.readOutput(deps, args)) }] }),
  );

  server.tool(
    'send_input',
    'Type text into a group member session terminal, optionally submitting with Enter (submit defaults true). This sends keystrokes, not a shell command primitive. For a just-launched session the tool first waits for the TUI to settle (up to ~10s) so keystrokes are not dropped; the result includes settled:false when the input was sent without confirmed readiness.',
    { sessionId: z.string(), text: z.string(), submit: z.boolean().optional() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await tools.sendInput(deps, args)) }] }),
  );

  server.tool(
    'new_session',
    'Atomically replace a worker\'s current session with a fresh process of the same role: same git worktree and same persisted launch preferences (app/model/sandboxOpts), but a brand-new CLI conversation with clean context. This is THE way to give a worker a fresh start -- never type `/new` or similar reset commands via send_input (their meaning depends on each app\'s slash commands). It takes no instruction text and accepts only the target worker\'s current sessionId; the orchestrator session itself can never be replaced. The old session stays live until the replacement is up (a failure leaves it untouched), and the result reports previousSessionId plus the NEW sessionId, role, app, model, cwd and sandboxOpts. Send your first instruction to the RETURNED sessionId in a SEPARATE send_input call afterwards -- do not combine a reset and an instruction into one text.',
    { sessionId: z.string() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await tools.newSession(deps, args)) }] }),
  );

  server.tool(
    'send_key',
    'Send ONE whitelisted control key to a group member terminal. Currently the only key is "escape", which dismisses an agent TUI\'s confirmation modal -- e.g. Codex\'s "Create a plan? esc dismiss" prompt that can appear after a long multi-line/bulleted instruction and stalls the worker until dismissed. This is a narrowly-scoped recovery tool, NOT an input channel: no other key, raw byte, or ANSI sequence exists here, and normal text belongs to send_input. Confirm the modal with a single read_output first, then send escape exactly once; never spam it or poll with repeated keys.',
    { sessionId: z.string(), key: z.enum(['escape']) },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(tools.sendKey(deps, args)) }] }),
  );

  server.tool(
    'open_tab',
    'Open a new worker session inside this group (with its own handoff channel) and return its sessionId. role must be a worker role (workerA, workerB, ...) -- never orchestrator. cwd is no longer read: the server always assigns each role its own dedicated git worktree automatically (or the shared project directory when the project isn\'t a git repo) -- the returned cwd tells you what was actually assigned; the argument is still accepted on the wire but has no effect and any value works. app (claude, opencode, or codex) is optional: omitted values fall back to the role\'s persisted preferences, then to the group defaults. copilot is not supported in groups because its MCP configuration is file-based and cannot be injected per session. For a genuinely new member, sandboxOpts.gpg / sandboxOpts.sshAgent cannot exceed what the calling orchestrator session itself currently has enabled -- a request for a flag the orchestrator does not hold is silently downgraded to false; check the returned sandboxOpts to see what was actually granted. Restarting an already-registered role (role currently has a member) always keeps that member\'s existing sandboxOpts regardless of what this call requests.',
    {
      role: z.string().regex(/^worker[A-Za-z0-9_-]+$/),
      app: z.enum(['claude', 'opencode', 'codex']).optional(),
      model: z.string().nullable().optional(),
      cwd: z.string(),
      sandboxOpts: z.object({ gpg: z.boolean().optional(), sshAgent: z.boolean().optional() }).optional(),
    },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await tools.openTab(deps, args)) }] }),
  );

  server.tool(
    'fetch_doc',
    'Fetch a document previously published (by any member) under a key via publish_doc.',
    { key: z.string() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(tools.fetchDoc(deps, args)) }] }),
  );

  server.tool(
    'list_docs',
    'List documents published in this group (key, publishedBy role, publishedAt, size) without their content -- fetch_doc the ones you need.',
    {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(tools.listDocs(deps)) }] }),
  );

  server.tool(
    'list_files',
    'List files shared in this group (id, name, size, mimeType, direction, publishedBy, publishedAt) without their content -- fetch_file the ones you need. Files are isolated by group and removed when the group is destroyed.',
    {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(tools.listFiles(deps)) }] }),
  );

  server.tool(
    'fetch_file',
    'Fetch metadata for a file shared in this group and get its read-only sandbox path. Returns id, name, size, mimeType, direction, publishedBy, publishedAt, and sandboxPath (/ccserver-group-files/<generated>). The file is readable at that path inside your sandbox; no blob bytes are returned in the tool response.',
    { fileId: z.string() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(tools.fetchFile(deps, args)) }] }),
  );

  server.tool(
    'close_tab',
    'Terminate a group member session (worker or orchestrator) and clean up its channel.',
    { sessionId: z.string() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(tools.closeTab(deps, args)) }] }),
  );

  server.tool(
    'get_tab_status',
    'Return the live status of a group member session (exited, connected, cwd, app) plus autoYes (whether automatic permission-approval is currently enabled), lastOutputAt (epoch ms of its last output; null if none yet), idleForMs (ms since then -- byte-based) and screenIdleMs (ms since the screen last visibly changed; null when no live screen exists). screenIdleMs is the better stuck/busy signal: a spinner keeps redrawing the screen (small screenIdleMs) even while the model is stalled, while a static screen (large screenIdleMs) means the member is genuinely idle. A large idleForMs on a member that should be working may mean it is stuck -- that is a concrete anomaly signal on its own: confirm with at most a single read_output; neither tool is for routine progress checks. Also returns dockerAvailable (true/false/null) and dockerReason: check these BEFORE assigning a docker-dependent task. A rootless dockerd can serve only ONE session per project at a time (the second sandbox of the same project simply runs without docker); dockerAvailable:false with dockerReason:"data-root-locked-by-another-session" means this member specifically lost that race -- it is not a fixable error, route the task to whichever member has dockerAvailable:true instead. dockerReason:"starting" means the sandbox just launched and docker has not finished starting -- wait a few seconds and check again rather than concluding docker is unavailable.',
    { sessionId: z.string() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(tools.getTabStatus(deps, args)) }] }),
  );

  server.tool(
    'repo_info',
    'Return shallow facts about the group\'s repository: top-level layout (directory and file names only, capped at 100 entries), the README preview (first ~8KB), a package.json summary (name/version/description and the keys of scripts/dependencies/devDependencies -- never values, capped at 50 keys each) and git state (current branch, short HEAD, last 5 commit subjects, count of changed files). It takes no path arguments (the project directory is fixed), returns no source-file contents, and is capped in size so it cannot balloon your context. Deeper inspection and any changes belong to the workers: send the work to a worker via send_input instead of trying to read the repo yourself.',
    {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(await tools.repoInfo(deps)) }] }),
  );

  server.tool(
    'wait_for_handoff',
    'Block until a worker calls handoff_to_orchestrator, or the timeout elapses. Returns the structured handoff event (worker, summary, status) -- or {timedOut:true} on timeout, in which case simply call wait_for_handoff again. Handoffs are never lost: a handoff that arrives while no one is waiting stays queued, and even a connection that dies mid-wait does not consume it -- the next wait_for_handoff (after reconnect) receives it. Call this once per turn instead of polling read_output.',
    { timeoutMs: z.number().optional() },
    async (args) => {
      const result = await tools.waitForHandoff(deps, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  return server;
}

// deps: { groupId, role, getSessionId, groupManager, sessionManager }
export function buildHandoffMcpServer(deps) {
  const server = new McpServer({ name: 'ccserver-handoff', version: '1.0.0' });

  server.tool(
    'handoff_to_orchestrator',
    'Notify the orchestrator that your task is complete, blocked, needs input, or hit an error. Call this exactly once when you finish a task or when you need the orchestrator to make a decision. The orchestrator is waiting on wait_for_handoff and will see the summary you provide here.',
    { summary: z.string(), status: z.enum(['done', 'blocked', 'needs_input', 'error']).optional(), nextRole: z.string().optional() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(tools.handoffToOrchestrator(deps, args)) }] }),
  );

  server.tool(
    'publish_doc',
    'Publish a document under a key, visible to every member of this group (including the orchestrator and other workers) via fetch_doc/list_docs -- the direct way to hand off content (e.g. a plan) to another worker WITHOUT going through the orchestrator. Your own ./tmp/ is local to your own git worktree and is NOT visible to other workers; publish only what you want to hand off, not your whole working directory. Re-publishing the same key overwrites it.',
    { key: z.string(), content: z.string() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(tools.publishDoc(deps, args)) }] }),
  );

  server.tool(
    'fetch_doc',
    'Fetch a document previously published (by any member) under a key via publish_doc.',
    { key: z.string() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(tools.fetchDoc(deps, args)) }] }),
  );

  server.tool(
    'list_docs',
    'List documents published in this group (key, publishedBy role, publishedAt, size) without their content -- fetch_doc the ones you need.',
    {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(tools.listDocs(deps)) }] }),
  );

  server.tool(
    'list_files',
    'List files shared in this group (id, name, size, mimeType, direction, publishedBy, publishedAt) without their content -- fetch_file the ones you need. Files are isolated by group and removed when the group is destroyed.',
    {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(tools.listFiles(deps)) }] }),
  );

  server.tool(
    'fetch_file',
    'Fetch metadata for a file shared in this group and get its read-only sandbox path. Returns id, name, size, mimeType, direction, publishedBy, publishedAt, and sandboxPath (/ccserver-group-files/<generated>). The file is readable at that path inside your sandbox; no blob bytes are returned in the tool response.',
    { fileId: z.string() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(tools.fetchFile(deps, args)) }] }),
  );

  server.tool(
    'publish_file',
    'Publish a file from your own worktree to this group so the browser user can download it and other members can fetch it via fetch_file. The path must be relative to your current worktree (never absolute or traversing outside it) and must point to a regular file. The file is copied into group storage; your original is untouched. Returns the generated file id and metadata.',
    { path: z.string() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(tools.publishFile(deps, args)) }] }),
  );

  return server;
}

// Process-global notification server (ccserver-notify, see notify.js). Unlike
// the control/handoff servers it is not group-scoped: one socket hosts it for
// the whole server, and its tools reach the shared subscription registry /
// Discord webhook via the closed `notifyApi` facade. Identity is never taken
// from the wire -- it arrives per-connection via the broker's identity frame
// (see mcpBroker.js) and is only an attribution (source display for the
// "_from:" footer), never an authorization input.
//
// notifyApi: { sendNotification, subscribe, unsubscribe, listSubscriptions }
export function buildNotifyMcpServer({ notifyApi, identity }) {
  const server = new McpServer({ name: 'ccserver-notify', version: '1.0.0' });

  server.tool(
    'notify',
    'Deliver a notification to every configured channel (the Discord webhook set in sandbox.config.json, plus every webhook currently subscribed via subscribe). Use this when you need human attention that the terminal alone cannot provide. level is an optional severity (info/success/warning/error) reflected in the payload.',
    { title: z.string(), body: z.string(), level: z.enum(['info', 'success', 'warning', 'error']).optional() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await notifyApi.sendNotification(args, identity)) }] }),
  );

  server.tool(
    'subscribe',
    'Register a webhook URL (https only) to receive future notify deliveries. Subscriptions are persisted server-side and survive a restart. Returns the created subscription (with its id) for later unsubscribe.',
    { url: z.string(), name: z.string().optional() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(notifyApi.subscribe(args)) }] }),
  );

  server.tool(
    'unsubscribe',
    'Remove a webhook subscription by its id (see subscribe / list_subscriptions).',
    { subscriptionId: z.string() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(notifyApi.unsubscribe(args)) }] }),
  );

  server.tool(
    'list_subscriptions',
    'List all currently subscribed webhook URLs (id, url, name, createdAt).',
    {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify({ subscriptions: notifyApi.listSubscriptions() }) }] }),
  );

  return server;
}

// Process-global usage server (ccserver-usage, see usageMcp.js). Like
// ccserver-notify it is not group-scoped: one socket hosts it for the whole
// server. Unlike notify, get_usage carries no per-connection identity -- it
// always returns the same server-wide snapshot regardless of who asks -- so
// buildServer's identity argument is simply unused here.
//
// usageApi: { getUsage }
export function buildUsageMcpServer({ usageApi }) {
  const server = new McpServer({ name: 'ccserver-usage', version: '1.0.0' });

  server.tool(
    'get_usage',
    'Get the current Claude usage snapshot (session/weekly percentage used, reset times, plan). Cached ~1 minute server-side; pass force:true to bypass the cache and re-capture immediately (slower, up to ~15s).',
    { force: z.boolean().optional() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await usageApi.getUsage({ force: !!args?.force })) }] }),
  );

  return server;
}

// Process-global reviewer server (ccserver-reviewer, see reviewer.js): like
// ccserver-usage it is not group-scoped (one socket for the whole server) and
// carries no per-connection identity -- attribution, if wanted, travels as
// the run_review tool's own `requestedBy` argument instead.
//
// reviewerApi: { runReview, listReviews, getReview }
export function buildReviewerMcpServer({ reviewerApi }) {
  const server = new McpServer({ name: 'ccserver-reviewer', version: '1.0.0' });
  const text = (result) => ({ content: [{ type: 'text', text: JSON.stringify(result) }] });

  server.tool(
    'run_review',
    'Launch a disposable headless review session against a local git ref/branch/PR/uncommitted diff and run /code-review on it. Does NOT require a GitHub PR to exist -- unlike PR-only reviewers, this uses a real local git worktree, so it can review an unpushed local branch, a pushed-but-PR-less branch, or even uncommitted (dirty) changes. If number is given, the target is checked out via `gh pr checkout` and results are posted as a PR comment; otherwise results are only recorded in ccserver (see list_reviews/get_review) and delivered via notify when configured. Returns immediately with the job id and status "running" -- poll get_review (or list_reviews) for completion, this tool never blocks until the review finishes.',
    {
      cwd: z.string(),
      headRef: z.string().optional(),
      baseRef: z.string().optional(),
      number: z.number().int().positive().optional(),
      includeUncommitted: z.boolean().optional(),
      app: z.enum(['claude', 'opencode', 'codex']).optional(),
      model: z.string().nullable().optional(),
      requestedBy: z.string().optional(),
    },
    async (args) => text(await reviewerApi.runReview(args)),
  );

  server.tool(
    'list_reviews',
    'List past and in-progress review jobs for a project (id, mode, status, headRef/prNumber, createdAt, finishedAt) without full result text -- get_review for details.',
    { cwd: z.string().optional(), limit: z.number().int().positive().max(100).optional() },
    async (args) => text(reviewerApi.listReviews(args)),
  );

  server.tool(
    'get_review',
    'Fetch one review job by id, including its result_summary and whether it was posted to the PR.',
    { id: z.string() },
    async (args) => text(reviewerApi.getReview(args)),
  );

  return server;
}

// Process-global META server (ccserver-meta, see metaAgent.js): the single
// privileged socket through which the meta agent manages the whole server --
// every project, group, session and sandbox. This is the OPPOSITE trust
// model of buildControlMcpServer above:
//   - control/handoff: groupId/sessionId/role are closure-bound per
//     connection and NEVER taken from tool arguments (multi-tenant isolation).
//   - meta: one trusted agent legitimately addresses ANY target by wire
//     argument (groupId/sessionId/slug). That is why every tool body lives in
//     metaTools.js (never mcpTools.js) -- see plan section 4.2.
// The connection's identity frame ({ sessionId, groupId, ... } from
// CCSERVER_META_IDENTITY via the bridge) arrives as deps.identity and powers
// only the self-target guards / approval attribution -- attribution and
// self-reference, never an authorization input (the socket binding is).
// Shared worker-entry schema for create/update_launch_preset (apps REQUIRED
// there -- a saved preset must reproduce its apps exactly). launch_group's
// workers differ deliberately: app stays optional and resolves via the group
// default at launch time.
const launchPresetWorkersSchema = z.array(z.object({
  role: z.string().regex(/^worker[A-Za-z0-9_-]+$/),
  app: z.enum(['claude', 'opencode', 'codex']),
  model: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  sandboxOpts: z.object({ gpg: z.boolean().optional(), sshAgent: z.boolean().optional() }).optional(),
})).min(1).max(7);

export function buildMetaMcpServer(deps) {
  const server = new McpServer({ name: 'ccserver-meta', version: '1.0.0' });
  const text = (result) => ({ content: [{ type: 'text', text: JSON.stringify(result) }] });

  // --- R (read-only) ---------------------------------------------------------
  server.tool(
    'list_projects',
    'List every known project (one row per resolved cwd that ever launched a sandbox/session): id, cwd, pathHash, user label, git remote, createdAt, lastSeenAt.',
    {},
    async () => text(metaTools.listProjects(deps)),
  );
  server.tool(
    'list_sandboxes',
    'List every persistent sandbox HOME with its real project path + label + git remote, measured disk size, live in-use count, and deletion state. Read-only overview before any destructive action.',
    {},
    async () => text(await metaTools.listSandboxes(deps)),
  );
  server.tool(
    'browse_directory',
    'Browse a host directory (same shape as GET /api/dirs): subdirectories and files with sizes/mtimes. showHidden includes dotfiles.',
    { path: z.string(), showHidden: z.boolean().optional() },
    async (args) => text(await metaTools.browseDirectory(deps, args)),
  );
  server.tool(
    'list_groups',
    'List all orchestration groups (groupId, cwd, memberCount, liveCount).',
    {},
    async () => text(metaTools.listGroups(deps)),
  );
  server.tool(
    'get_group',
    'Inspect one orchestration group: its project cwd and every member (role, sessionId, app/model, cwd, exited/connected, docker availability) plus currentTurn/lastHandoffAt.',
    { groupId: z.string() },
    async (args) => text(metaTools.getGroup(deps, args)),
  );
  server.tool(
    'list_sessions',
    'List ALL live sessions server-wide (standalone ones included), each with id/cwd/app/shell/sandbox/sandboxOpts/group info and isMetaAgent.',
    {},
    async () => text(metaTools.listSessions(deps)),
  );
  server.tool(
    'list_worker_presets',
    'List the shared worker preset library (display name / technical role / CLI / model templates for combo launches).',
    {},
    async () => text(metaTools.listWorkerPresets(deps)),
  );
  server.tool(
    'list_launch_presets',
    'List the combo launch presets: named N-worker bundles (+ orchestrator app/model/instructions preferences) with their nested worker snapshots. Use launch_from_preset to start one.',
    {},
    async () => text(metaTools.listLaunchPresets(deps)),
  );

  // --- W-low (config CRUD, no confirmation needed) ---------------------------
  server.tool(
    'create_worker_preset',
    'Create a worker preset (single-worker launch template). name is required; role must start with "worker"; app must be claude/opencode/codex; model optional.',
    { name: z.string(), role: z.string().regex(/^worker[A-Za-z0-9_-]+$/), app: z.enum(['claude', 'opencode', 'codex']), model: z.string().nullable().optional() },
    async (args) => text(metaTools.createWorkerPreset(deps, args)),
  );
  server.tool(
    'update_worker_preset',
    'Fully replace a worker preset by presetId (same fields as create_worker_preset).',
    { presetId: z.string(), name: z.string(), role: z.string().regex(/^worker[A-Za-z0-9_-]+$/), app: z.enum(['claude', 'opencode', 'codex']), model: z.string().nullable().optional() },
    async (args) => text(metaTools.updateWorkerPreset(deps, args)),
  );
  server.tool(
    'delete_worker_preset',
    'Delete a worker preset by presetId. Low-risk config change: running sessions are unaffected, future launches lose the template.',
    { presetId: z.string() },
    async (args) => text(metaTools.deleteWorkerPreset(deps, args)),
  );
  server.tool(
    'create_launch_preset',
    'Create a combo launch preset: { name, workers: [1-7 x { role, app, model?, name?, sandboxOpts? }], orchestratorApp?, orchestratorModel?, instructions? }. Roles unique within the preset; apps required and copilot-free.',
    {
      name: z.string(),
      workers: launchPresetWorkersSchema,
      orchestratorApp: z.enum(['claude', 'opencode', 'codex']).optional(),
      orchestratorModel: z.string().nullable().optional(),
      instructions: z.string().nullable().optional(),
    },
    async (args) => text(metaTools.createLaunchPreset(deps, args)),
  );
  server.tool(
    'update_launch_preset',
    'Fully replace a launch preset by presetId (same fields as create_launch_preset; the whole worker snapshot is replaced).',
    {
      presetId: z.string(),
      name: z.string(),
      workers: launchPresetWorkersSchema,
      orchestratorApp: z.enum(['claude', 'opencode', 'codex']).optional(),
      orchestratorModel: z.string().nullable().optional(),
      instructions: z.string().nullable().optional(),
    },
    async (args) => text(metaTools.updateLaunchPreset(deps, args)),
  );
  server.tool(
    'delete_launch_preset',
    'Delete a launch preset by presetId. Low-risk config change.',
    { presetId: z.string() },
    async (args) => text(metaTools.deleteLaunchPreset(deps, args)),
  );
  server.tool(
    'update_project_label',
    'Set or clear the human-readable display label of a project row (label null clears it -- UIs fall back to basename(cwd)). Pure metadata.',
    { projectId: z.string(), label: z.string().nullable() },
    async (args) => text(metaTools.updateProjectLabel(deps, args)),
  );
  server.tool(
    'create_directory',
    'Create a directory (optionally `git init` inside it). Same validation as POST /api/dirs: parent must exist, name must be a bare folder name.',
    { parent: z.string(), name: z.string(), gitInit: z.boolean().optional() },
    async (args) => text(await metaTools.createDirectory(deps, args)),
  );

  // --- W-create (resource creation, no confirmation needed) ------------------
  server.tool(
    'launch_session',
    'Launch ONE standalone agent session (no orchestrator) at an absolute cwd and return its sessionId. app defaults to claude (opencode/codex allowed); sandboxOpts.gpg/sshAgent are capped against YOUR OWN current grants (a flag you do not hold is silently downgraded to false -- check the returned sandboxOpts). Resource-consuming but non-destructive.',
    {
      cwd: z.string(),
      app: z.enum(['claude', 'opencode', 'codex']).optional(),
      model: z.string().nullable().optional(),
      sandbox: z.boolean().optional(),
      sandboxOpts: z.object({ gpg: z.boolean().optional(), sshAgent: z.boolean().optional() }).optional(),
    },
    async (args) => text(await metaTools.launchSession(deps, args)),
  );
  server.tool(
    'launch_group',
    'Launch a combo group (N workers + an auto-created orchestrator) at an absolute cwd. Same canonical payload as POST /api/groups: workers 1-7 with unique roles starting "worker"; copilot is refused. orchestratorApp/orchestratorModel select the orchestrator\'s own app/model (omitted -> claude / group default, same as leaving orchestrator out of the REST payload). Returns groupId + members.',
    {
      cwd: z.string(),
      workers: z.array(z.object({
        role: z.string().regex(/^worker[A-Za-z0-9_-]+$/),
        app: z.enum(['claude', 'opencode', 'codex']).optional(),
        model: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
        sandboxOpts: z.object({ gpg: z.boolean().optional(), sshAgent: z.boolean().optional() }).optional(),
      })).min(1).max(7),
      instructions: z.string().nullable().optional(),
      orchestratorApp: z.enum(['claude', 'opencode', 'codex']).optional(),
      orchestratorModel: z.string().nullable().optional(),
      sandboxOpts: z.object({ gpg: z.boolean().optional(), sshAgent: z.boolean().optional() }).optional(),
    },
    async (args) => text(await metaTools.launchGroup(deps, args)),
  );
  server.tool(
    'launch_from_preset',
    'Expand a saved launch preset into a fresh combo group at an absolute cwd (the snapshot is taken NOW -- later preset edits do not affect this launch). Same result shape as launch_group.',
    { presetId: z.string(), cwd: z.string() },
    async (args) => text(await metaTools.launchFromPreset(deps, args)),
  );

  // --- W-destructive (ALWAYS through the approval flow) ----------------------
  server.tool(
    'close_session',
    'Force-close ANY session (kills its pty). REQUIRES human approval via a pending_approvals dialog: this call BLOCKS until the browser approves/rejects or the fixed 5-minute timeout rejects it. Refused outright (fail closed, no dialog) when sessionId is YOUR OWN meta-agent session -- you can never terminate yourself, whatever reason you give. reason is shown to the approver.',
    { sessionId: z.string(), reason: z.string().min(1) },
    async (args) => text(await metaTools.closeSession(deps, args)),
  );
  server.tool(
    'destroy_group',
    'Destroy an ENTIRE orchestration group (all members\' ptys, brokers and worktrees). REQUIRES human approval like close_session; refused outright when groupId is the group YOU belong to (you have none as a standalone session, so this guard mainly defends against identity confusion). reason is shown to the approver.',
    { groupId: z.string(), reason: z.string().min(1) },
    async (args) => text(await metaTools.destroyGroup(deps, args)),
  );
  server.tool(
    'delete_sandbox',
    'Delete a persistent sandbox HOME + its docker data-root by slug. REQUIRES human approval; the existing in-use/dockerd-lock guards still apply on top (if your own sandbox is mounted there, the delete refuses). reason is shown to the approver.',
    { slug: z.string().regex(/^[A-Za-z0-9_]+$/), reason: z.string().min(1) },
    async (args) => text(await metaTools.deleteSandbox(deps, args)),
  );

  return server;
}
