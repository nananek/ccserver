import { listSessions } from '../ws/sessionManager.js';

export async function sessionsRoute(fastify, opts) {
  fastify.get('/sessions', async (request, reply) => {
    return { sessions: listSessions() };
  });
}
