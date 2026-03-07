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
import { terminalWs } from './ws/terminal.js';
import { gracefulShutdown } from './ws/sessionManager.js';

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
  gracefulShutdown().then(() => process.exit(0));
};
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

const PORT = process.env.PORT || 3001;
await fastify.listen({ port: PORT, host: '0.0.0.0' });
