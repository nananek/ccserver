import { listSessions, getSession, destroySession } from '../ws/sessionManager.js';

export async function sessionsRoute(fastify, opts) {
  fastify.get('/sessions', async (request, reply) => {
    const activeSessions = listSessions();
    return { sessions: activeSessions };
  });

  fastify.delete('/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    const session = getSession(id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    // Explicit teardown: also cancel any scheduled prompt for this session.
    destroySession(id, { keepSchedule: false });
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
}
