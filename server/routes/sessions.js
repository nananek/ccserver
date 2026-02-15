import { listSessions, loadSavedSessions, getSession, destroySession, removeSavedSession } from '../ws/sessionManager.js';

export async function sessionsRoute(fastify, opts) {
  fastify.get('/sessions', async (request, reply) => {
    return {
      sessions: listSessions(),
      savedSessions: loadSavedSessions(),
    };
  });

  fastify.delete('/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    const session = getSession(id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    destroySession(id);
    return { success: true, id };
  });

  fastify.delete('/sessions/saved/:index', async (request, reply) => {
    const index = parseInt(request.params.index, 10);
    if (isNaN(index) || !removeSavedSession(index)) {
      return reply.code(404).send({ error: 'Saved session not found' });
    }
    return { success: true };
  });
}
