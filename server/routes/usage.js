import { getUsage } from '../usage.js';

export async function usageRoute(fastify) {
  // GET /api/usage[?force=1] — latest parsed Claude /usage dashboard. Served
  // from a short-lived cache; `force=1` re-captures on demand.
  fastify.get('/usage', async (request) => {
    const force = request.query.force === '1' || request.query.force === 'true';
    return getUsage({ force });
  });
}
