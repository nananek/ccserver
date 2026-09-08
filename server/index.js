import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dirsRoute } from './routes/dirs.js';
import { sessionsRoute } from './routes/sessions.js';
import { filesRoute } from './routes/files.js';
import { systemRoute } from './routes/system.js';
import { usageRoute } from './routes/usage.js';
import { groupsRoute } from './routes/groups.js';
import { workerPresetsRoute } from './routes/workerPresets.js';
import { launchPresetsRoute } from './routes/launchPresets.js';
import { projectsRoute } from './routes/projects.js';
import { approvalsRoute } from './routes/approvals.js';
import { groupFilesRoute } from './routes/groupFiles.js';
import { groupDocsRoute } from './routes/groupDocs.js';
import { sandboxRoute } from './routes/sandbox.js';
import { sandboxesRoute } from './routes/sandboxes.js';
import { federationRoute } from './routes/federation.js';
import { authRoute } from './routes/auth.js';
import { terminalWs } from './ws/terminal.js';
import { remoteTerminalWs } from './ws/remoteTerminal.js';
import { gracefulShutdown, restoreSchedules, initPtyHostDestroyedHandler, initPtyHostDisconnectedHandler, initPtyHostReconnectedHandler, restorePtyHostSessions } from './ws/sessionManager.js';
import { getPtyHostClient, isPtyHostEnabled, checkPtyHostReachable } from './ws/ptyHostClient.js';
import { restoreGroups, detectOrphanWorktrees } from './ws/groupManager.js';
import { restoreNotify, ensureNotifyBroker, stopNotifyBroker, notifyEnabled } from './ws/notify.js';
import { ensureUsageBroker, stopUsageBroker, usageEnabled } from './ws/usageMcp.js';
import { ensureMetaAgentBroker, stopMetaAgentBroker, metaAgentEnabled } from './ws/metaAgent.js';
import { ensureReviewerBroker, stopReviewerBroker, reviewerEnabled } from './ws/reviewer.js';
import { expireStalePendingApprovals } from './ws/approvals.js';
import { ensureFederationServer, stopFederationServer, federationEnabled } from './ws/federationServer.js';
import { sweepExpiredPending } from './ws/federationPairing.js';
import { establishAllLinks } from './ws/federationLink.js';
import { warmUsage } from './usage.js';
import { warmCodexUsage } from './codexUsage.js';
import { warmOpencodeUsage } from './opencodeUsage.js';
import { initDb, dbPath } from './db.js';
import { selectableAppIds, installedApps } from './ws/sandbox.js';
import { verifySessionCookie } from './authSessions.js';
import { resolveAuthMode } from './authMode.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// trustProxy scoped to loopback only (Issue #141 Step2): the documented HTTPS
// deployment path (Tailscale Serve, docs-site deployment/tailscale.md) always
// reverse-proxies from 127.0.0.1 to this process, and passkey mode's session
// cookie decides its Secure attribute from request.protocol
// (authSessions.js/routes/auth.js) -- without this, request.protocol sees the
// plaintext hop from the proxy and never reports 'https', so Secure would
// never be set even for a genuinely HTTPS-fronted deployment. Scoping to
// loopback (rather than trustProxy: true) means a direct, non-proxied
// connection -- this server also binds 0.0.0.0, so one is reachable -- can't
// spoof X-Forwarded-Proto to influence its own response.
const fastify = Fastify({ logger: true, trustProxy: ['127.0.0.1', '::1'] });

// SQLite (worker presets today, more stores in later phases): open + migrate
// before anything that might touch it -- notably the CCSERVER_AUTH_MODE=passkey
// hook below, which queries auth_sessions on every request (Issue #141 Step1
// moved this above the auth hook registration; it used to sit right before
// fastify.listen()). A failed migration refuses boot with a clear log instead
// of a systemd Restart=on-failure loop -- fail fast by design (see db.js).
try {
  initDb();
  fastify.log.info(`SQLite database ready at ${dbPath()}`);
  // Approvals whose waiter died with a previous process can never be decided:
  // expire them (fail-safe -- nothing runs just because the server restarted).
  const swept = expireStalePendingApprovals();
  if (swept > 0) fastify.log.warn(`Expired ${swept} stale pending approval(s) left by a previous run`);
  // Federation pairing requests older than the 7-day window (see
  // federationPairing.js) never had a waiter to lose, so unlike the sweep
  // above this isn't a crash-recovery step -- just the same boot-time
  // opportunity to catch up before the first browser poll does.
  const expiredPairings = sweepExpiredPending();
  if (expiredPairings > 0) fastify.log.info(`Expired ${expiredPairings} stale federation pairing request(s)`);
} catch (err) {
  fastify.log.error({ err }, `Failed to initialize SQLite database (${dbPath()}): ${err.message}`);
  process.exit(1);
}

// Auth mode (Issue #141): CCSERVER_AUTH_MODE exclusively picks one of
// none (default) / token (legacy CCSERVER_TOKEN, unchanged) / passkey (new
// session-cookie based auth). Never mixed -- passkey mode does not accept
// CCSERVER_TOKEN at all (plan decision 5).
//
// Defaulting when CCSERVER_AUTH_MODE is unset (matching the pre-#141 behavior
// where CCSERVER_TOKEN alone -- "Optional token auth (Jupyter-style): set
// CCSERVER_TOKEN to enable", per README -- turned auth on, so an existing
// deployment doesn't silently lose auth on upgrade) is resolveAuthMode()'s
// job, shared with server/cli/issue-login-token.js so both agree on the
// effective mode.
const AUTH_TOKEN = process.env.CCSERVER_TOKEN;
const AUTH_MODE = resolveAuthMode();

// Endpoints under /api/auth that must work with NO session yet -- the ones
// that exist to *create* one (login-token; WebAuthn authentication
// options/verify). This is an explicit allowlist, not a blanket '/api/auth'
// prefix exemption: Step3 also adds WebAuthn *registration*
// (register-options/register-verify, for adding a passkey while already
// logged in) under the same /api/auth/webauthn/* path, and that one must
// require an existing session like any other route -- a prefix exemption
// would silently bypass auth for it too. It's deliberately absent here so it
// falls through to the normal session check below.
const UNAUTHENTICATED_AUTH_ROUTES = new Set([
  '/api/auth/login-token',
  '/api/auth/webauthn/authenticate-options',
  '/api/auth/webauthn/authenticate-verify',
]);
const isAuthRoute = (url) => UNAUTHENTICATED_AUTH_ROUTES.has(url.split('?')[0]);

if (AUTH_MODE === 'token') {
  // Legacy Jupyter-style shared-secret auth, unmodified from before Issue #141.
  if (!AUTH_TOKEN) {
    fastify.log.error('CCSERVER_AUTH_MODE=token requires CCSERVER_TOKEN to be set');
    process.exit(1);
  }
  fastify.addHook('onRequest', async (request, reply) => {
    // Allow static assets through
    if (!request.url.startsWith('/api') && !request.url.startsWith('/ws')) return;
    const token =
      request.query.token ||
      request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (token !== AUTH_TOKEN) {
      reply.code(401).send({ error: 'Invalid or missing token' });
    }
  });
  fastify.log.info('Token authentication enabled');
} else if (AUTH_MODE === 'passkey') {
  if (AUTH_TOKEN) {
    fastify.log.warn('CCSERVER_TOKEN is set but ignored because CCSERVER_AUTH_MODE=passkey');
  }
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api') && !request.url.startsWith('/ws')) return;
    if (isAuthRoute(request.url)) return;
    if (!verifySessionCookie(request)) {
      reply.code(401).send({ error: 'Not authenticated' });
    }
  });
  fastify.log.info('Passkey authentication enabled');
} else if (AUTH_MODE === 'none') {
  if (AUTH_TOKEN) {
    fastify.log.warn("CCSERVER_TOKEN is set but ignored because CCSERVER_AUTH_MODE is 'none' (set CCSERVER_AUTH_MODE=token to enable it)");
  }
} else {
  fastify.log.error(`Unknown CCSERVER_AUTH_MODE: ${AUTH_MODE} (expected none, token, or passkey)`);
  process.exit(1);
}

await fastify.register(websocket);
await fastify.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });
await fastify.register(dirsRoute, { prefix: '/api' });
await fastify.register(sessionsRoute, { prefix: '/api' });
await fastify.register(filesRoute, { prefix: '/api' });
await fastify.register(systemRoute, { prefix: '/api' });
await fastify.register(usageRoute, { prefix: '/api' });
await fastify.register(groupsRoute, { prefix: '/api' });
await fastify.register(workerPresetsRoute, { prefix: '/api' });
await fastify.register(launchPresetsRoute, { prefix: '/api' });
await fastify.register(projectsRoute, { prefix: '/api' });
await fastify.register(approvalsRoute, { prefix: '/api' });
await fastify.register(groupFilesRoute, { prefix: '/api' });
await fastify.register(groupDocsRoute, { prefix: '/api' });
await fastify.register(sandboxRoute, { prefix: '/api' });
await fastify.register(sandboxesRoute, { prefix: '/api' });
await fastify.register(federationRoute, { prefix: '/api' });
await fastify.register(authRoute, { prefix: '/api' });
await fastify.register(terminalWs);
await fastify.register(remoteTerminalWs);

if (process.env.NODE_ENV === 'production') {
  await fastify.register(fastifyStatic, {
    root: join(__dirname, '..', 'client', 'dist'),
  });

  fastify.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      reply.code(404).send({ error: 'Not found' });
    } else {
      reply.sendFile('index.html');
    }
  });
}

const cleanup = () => {
  stopNotifyBroker();
  stopUsageBroker();
  stopMetaAgentBroker();
  stopReviewerBroker();
  stopFederationServer();
  gracefulShutdown().then(() => process.exit(0));
};
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Refuse to boot only if sandbox.config.json's hiddenApps (issue #105) has
// hidden every agent CLI actually installed on this host: every one of the 5
// launch screens would silently offer nothing to start. A host with nothing
// installed at all (shell-only use, CI) never had a boot-time check before
// this feature and must keep booting -- that's a separate, pre-existing
// situation hiddenApps did not create. Checked here -- after installedApps()
// filesystem detection, not at config-parse time -- because the emptiness
// only exists once "installed" and "not hidden" are intersected (see
// selectableAppIds()).
try {
  const anyInstalled = Object.values(installedApps()).some(Boolean);
  const selectable = selectableAppIds();
  if (anyInstalled && selectable.length === 0) {
    fastify.log.error(
      'Refusing to start: sandbox.config.json\'s "hiddenApps" hides every agent CLI installed on this host, '
      + 'leaving nothing launchable. Remove at least one entry from hiddenApps, or install one of the hidden CLIs.'
    );
    process.exit(1);
  }
  if (selectable.length > 0) {
    fastify.log.info(`Selectable agent CLIs: ${selectable.join(', ')}`);
  } else {
    fastify.log.warn('No agent CLI is installed on this host; only shell sessions will be launchable.');
  }
} catch (err) {
  fastify.log.error({ err }, 'Refusing to start: failed to determine selectable agent CLIs');
  process.exit(1);
}

const PORT = process.env.PORT || 3001;

// Issue #119 Step7-3: isPtyHostEnabled() now defaults to ON when
// CCSERVER_PTY_HOST is unset (ptyHostClient.js), so an existing deployment
// that has never started ccserver-pty-host.service would otherwise have
// every createSession() call below fail outright the moment it upgrades.
// Probe reachability once, up front, and fall back to direct spawn for this
// run if pty-host isn't actually there. Overriding process.env.CCSERVER_PTY_HOST
// (rather than some separate in-memory flag) is deliberate: isPtyHostEnabled()
// re-reads it fresh on every call, so this one write is automatically
// honored by every pty-host call site below -- this file's own
// initPtyHost*Handler calls just after, and every usePtyHost check inside
// sessionManager.js -- with no extra plumbing. A deployment that already has
// pty-host running is unaffected, and one that explicitly opted out via
// CCSERVER_PTY_HOST=0 never reaches this block at all (isPtyHostEnabled()
// is already false).
//
// Only probes shard 0 (getPtyHostClient()'s default): the scenario this
// guards against is "pty-host was never set up on this host at all", which
// is necessarily a shard-0-only deployment (CCSERVER_PTY_HOST_SHARDS is
// itself opt-in, see ptyHostClient.js's shardCount()) -- a partitioned
// deployment missing just one of several shards is already handled per-shard
// by restorePtyHostSessions()/createSession()'s own unreachable-shard
// handling further down, not by this all-or-nothing boot-time fallback.
if (isPtyHostEnabled()) {
  const ptyHostClient = getPtyHostClient();
  if (await checkPtyHostReachable(ptyHostClient)) {
    fastify.log.info('pty-host reachable at boot -- sessions will be created via pty-host');
  } else {
    fastify.log.warn(
      'pty-host unreachable at boot -- falling back to direct pty spawn for this run. Start '
      + 'ccserver-pty-host.service (see docs-site deployment/systemd.md) for terminal sessions '
      + 'to survive a ccserver restart, or set CCSERVER_PTY_HOST=0 to silence this check.'
    );
    process.env.CCSERVER_PTY_HOST = '0';
    // No other call site will ever touch this client again this run (every
    // pty-host-related check below now reads isPtyHostEnabled() as false) --
    // close it so it stops retrying in the background for no one, rather
    // than reconnecting forever via its own internal backoff.
    ptyHostClient.close();
  }
}

// pty-host adapter (plan5 Step2): registers the `destroyed` push-event
// handler that cleans up server本体's local sessions Map when pty-host tears
// a session down on its own. A no-op (never opens the UDS socket) unless
// pty-host is enabled AND reachable (isPtyHostEnabled() -- see the probe
// just above, which can itself force this to false for the rest of this
// run).
initPtyHostDestroyedHandler();

// Issue #143 problem 2: registers the disconnect handler that treats a
// shard's pty-host process dying as every session it held being lost (see
// sessionManager.js's initPtyHostDisconnectedHandler). Also a no-op unless
// isPtyHostEnabled().
initPtyHostDisconnectedHandler();

// Issue #119 Step6: registers the reconnect handler that, once a shard comes
// back after the disconnect above, reattaches whatever pty-host itself
// already auto-resumed on that shard (see sessionManager.js's
// initPtyHostReconnectedHandler) -- without this, Step6's auto-resume would
// keep those sessions alive on pty-host's side invisibly, with server本体
// never noticing. Also a no-op unless isPtyHostEnabled().
initPtyHostReconnectedHandler();

// ccserver-notify: restore the subscription registry, then host the
// process-global MCP socket if the feature is enabled (Discord webhook or
// subscriptions). Started before the server accepts connections: bwrap's
// --bind-try snapshots the socket file at mount time, so it must exist
// before a notify-enabled session is created.
try {
  restoreNotify();
  if (notifyEnabled()) {
    await ensureNotifyBroker();
    fastify.log.info('ccserver-notify MCP broker started');
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to start ccserver-notify broker');
}

// ccserver-usage: host the process-global get_usage MCP socket when the
// feature is enabled (claude installed AND usageMcp explicitly enabled). Same
// bind-before-listen ordering requirement as notify above.
try {
  if (usageEnabled()) {
    await ensureUsageBroker();
    fastify.log.info('ccserver-usage MCP broker started');
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to start ccserver-usage broker');
}

// ccserver-meta: host the privileged meta-agent MCP socket when explicitly
// enabled (metaAgentMcp in sandbox.config.json). Same bind-before-listen
// ordering requirement: the meta agent's sandbox snapshots this socket at
// launch, so it must exist before any isMetaAgent session can be created.
try {
  if (metaAgentEnabled()) {
    await ensureMetaAgentBroker();
    fastify.log.info('ccserver-meta MCP broker started');
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to start ccserver-meta broker');
}

// ccserver-reviewer: host the process-global run_review/list_reviews/
// get_review MCP socket when explicitly enabled (reviewerMcp in
// sandbox.config.json). Same bind-before-listen ordering requirement as
// notify/usage/meta above.
try {
  if (reviewerEnabled()) {
    await ensureReviewerBroker();
    fastify.log.info('ccserver-reviewer MCP broker started');
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to start ccserver-reviewer broker');
}

// Federation (plan Phase 1): a dedicated mTLS listener on
// CCSERVER_FEDERATION_PORT, separate from the Fastify port above -- see
// ws/federationServer.js's header comment. Opt-in via the env var; a failure
// here (missing openssl, port already in use) disables federation for this
// run rather than refusing to boot, matching the notify/usage/meta brokers.
try {
  if (federationEnabled()) {
    await ensureFederationServer({ log: fastify.log });
    fastify.log.info(`ccserver federation listener started on port ${process.env.CCSERVER_FEDERATION_PORT}`);
    // Issue #142 Step 3: kick every non-terminal pair's FederationLink into
    // dialing right away, in case this process never otherwise calls
    // connect() for it (no RPC/terminal call has happened yet, and this pair
    // never went through the TOFU bootstrap in this process's lifetime).
    // FederationLink.connect() is idempotent and keeps retrying forever on
    // its own backoff once called, so a single fire-and-forget sweep at
    // boot is enough -- not awaited, so an unreachable peer can never delay
    // fastify.listen() below.
    establishAllLinks({ log: fastify.log }).catch((err) => {
      fastify.log.error({ err }, 'Failed to kick off federation link establishment');
    });
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to start ccserver federation listener');
}

await fastify.listen({ port: PORT, host: '0.0.0.0' });

// Reattach to pty-host sessions that survived this restart (plan5 Step3) --
// pty-host is a separate process, so CCSERVER_PTY_HOST=1 sessions' ptys keep
// running across a server本体 crash/restart even though the `sessions` Map
// below started empty. A no-op when the flag is off. Must run before
// restoreGroups() just below: a group's member is only treated as "gone,
// offer a resume" when sessionApi.getSession() finds nothing, so a still-
// running member needs to already be back in `sessions` by then.
try {
  const restoreInfo = await restorePtyHostSessions();
  if (restoreInfo.restored) {
    fastify.log.info(`Reattached ${restoreInfo.restored} pty-host session(s) from before restart`);
  }
  if (restoreInfo.orphanedLive) {
    fastify.log.warn(`${restoreInfo.orphanedLive} pty-host session(s) had no restore metadata and were left running unmanaged`);
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to restore pty-host sessions');
}

// Re-arm scheduled prompts persisted before the last shutdown/restart. Missed
// ones (server was down at their time) fire shortly after startup; live ones
// wait for their time. Sessions are auto-resumed lazily at fire time.
// Combo groups are restored next: under a direct node-pty spawn (or a
// non-graceful pty-host restart), every member's pty died with the old
// process and only its .saved-sessions.json resume info is available; under
// CCSERVER_PTY_HOST=1 a member that restorePtyHostSessions() just reattached
// above is instead found live (see restoreGroups()/listGroupMembers() in
// groupManager.js, which check sessionApi.getSession() before falling back
// to the saved info). Either way this auto-resumes/re-creates MCP channels
// as needed, and the UI can offer to re-open groups that still need it.
try {
  const groupInfo = restoreGroups();
  if (groupInfo?.restored) {
    fastify.log.info(`Restored ${groupInfo.restored} combo group(s)`);
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to restore combo groups');
}

// Diagnostic-only scan (never deletes) for worktree directories left behind
// by a removal that failed, or a crash between creation and persistence --
// see groupManager.detectOrphanWorktrees / plan section 3.7-3.
try {
  const orphans = detectOrphanWorktrees();
  if (orphans.length) {
    fastify.log.warn(`Found ${orphans.length} orphaned worktree director${orphans.length === 1 ? 'y' : 'ies'} (see warnings above); not removed automatically`);
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to scan for orphaned worktrees');
}

try {
  const info = restoreSchedules();
  if (info?.restored) {
    fastify.log.info(
      `Restored ${info.restored} scheduled prompt(s)` +
      (info.missed ? ` (${info.missed} missed while down, firing now)` : '')
    );
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to restore scheduled prompts');
}

// Warm the Claude/Codex/OpenCode Go usage caches so the first click on the
// top-bar Usage button is instant (best effort — a failed capture just
// leaves the cache empty; Go skips warming entirely when disabled/keyless).
warmUsage();
warmCodexUsage();
warmOpencodeUsage();
