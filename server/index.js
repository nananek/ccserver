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
import { terminalWs } from './ws/terminal.js';
import { remoteTerminalWs } from './ws/remoteTerminal.js';
import { gracefulShutdown, restoreSchedules } from './ws/sessionManager.js';
import { restoreGroups, detectOrphanWorktrees } from './ws/groupManager.js';
import { restoreNotify, ensureNotifyBroker, stopNotifyBroker, notifyEnabled } from './ws/notify.js';
import { ensureUsageBroker, stopUsageBroker, usageEnabled } from './ws/usageMcp.js';
import { ensureMetaAgentBroker, stopMetaAgentBroker, metaAgentEnabled } from './ws/metaAgent.js';
import { ensureReviewerBroker, stopReviewerBroker, reviewerEnabled } from './ws/reviewer.js';
import { expireStalePendingApprovals } from './ws/approvals.js';
import { ensureFederationServer, stopFederationServer, federationEnabled } from './ws/federationServer.js';
import { sweepExpiredPending } from './ws/federationPairing.js';
import { warmUsage } from './usage.js';
import { warmCodexUsage } from './codexUsage.js';
import { initDb, dbPath } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fastify = Fastify({ logger: true });

// Optional token auth (Jupyter-style): set CCSERVER_TOKEN to enable
const AUTH_TOKEN = process.env.CCSERVER_TOKEN;
if (AUTH_TOKEN) {
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

// SQLite (worker presets today, more stores in later phases): open + migrate
// before the server accepts connections. A failed migration refuses boot with
// a clear log instead of a systemd Restart=on-failure loop -- fail fast by
// design (see db.js).
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

const PORT = process.env.PORT || 3001;

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
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to start ccserver federation listener');
}

await fastify.listen({ port: PORT, host: '0.0.0.0' });

// Re-arm scheduled prompts persisted before the last shutdown/restart. Missed
// ones (server was down at their time) fire shortly after startup; live ones
// wait for their time. Sessions are auto-resumed lazily at fire time.
// Combo groups are restored first (their member sessions died with the old
// process) so those auto-resumes can re-create MCP channels, and the UI can
// offer to re-open the groups.
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

// Warm the Claude/Codex usage caches so the first click on the top-bar Usage
// button is instant (best effort — a failed capture just leaves the cache
// empty).
warmUsage();
warmCodexUsage();
