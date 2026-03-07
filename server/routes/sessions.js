import { listSessions, loadSavedSessions, getSession, destroySession, removeSavedSession } from '../ws/sessionManager.js';

export async function sessionsRoute(fastify, opts) {
  fastify.get('/sessions', async (request, reply) => {
    const activeSessions = listSessions();
    const activeCwds = new Set(activeSessions.map((s) => s.cwd));
    const savedSessions = loadSavedSessions().filter((s) => !activeCwds.has(s.cwd));
    return { sessions: activeSessions, savedSessions };
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

  if (process.env.CCSERVER_DEBUG) {
    fastify.get('/sessions/:id/buffer', async (request, reply) => {
      const { id } = request.params;
      const session = getSession(id);
      if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
      const raw = session.outputBuffer.slice(-20).join('');
      return { raw: raw.slice(-5000), stripped: stripAnsi(raw).slice(-5000) };
    });
  }

  fastify.delete('/sessions/saved/:index', async (request, reply) => {
    const index = parseInt(request.params.index, 10);
    if (isNaN(index) || !removeSavedSession(index)) {
      return reply.code(404).send({ error: 'Saved session not found' });
    }
    return { success: true };
  });
}
