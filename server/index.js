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
import { groupFilesRoute } from './routes/groupFiles.js';
import { sandboxRoute } from './routes/sandbox.js';
import { sandboxesRoute } from './routes/sandboxes.js';
import { terminalWs } from './ws/terminal.js';
import { gracefulShutdown, restoreSchedules } from './ws/sessionManager.js';
import { restoreGroups, detectOrphanWorktrees } from './ws/groupManager.js';
import { restoreNotify, ensureNotifyBroker, stopNotifyBroker, notifyEnabled } from './ws/notify.js';
import { ensureUsageBroker, stopUsageBroker, usageEnabled } from './ws/usageMcp.js';
import { warmUsage } from './usage.js';
import { warmCodexUsage } from './codexUsage.js';

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
await fastify.register(groupFilesRoute, { prefix: '/api' });
await fastify.register(sandboxRoute, { prefix: '/api' });
await fastify.register(sandboxesRoute, { prefix: '/api' });
await fastify.register(terminalWs);

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
  gracefulShutdown().then(() => process.exit(0));
};
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

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
