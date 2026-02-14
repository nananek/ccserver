import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function dirsRoute(fastify, opts) {
  fastify.get('/dirs', async (request, reply) => {
    const requestedPath = request.query.path || '/';
    const absPath = resolve('/', requestedPath);

    try {
      const entries = await readdir(absPath, { withFileTypes: true });

      const dirs = entries
        .filter((entry) => {
          if (!entry.isDirectory()) return false;
          if (!request.query.showHidden && entry.name.startsWith('.')) return false;
          return true;
        })
        .map((entry) => ({
          name: entry.name,
          path: join(absPath, entry.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return {
        current: absPath,
        parent: absPath === '/' ? null : resolve(absPath, '..'),
        dirs,
      };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return reply.code(404).send({ error: 'Directory not found' });
      }
      if (err.code === 'EACCES') {
        return reply.code(403).send({ error: 'Permission denied' });
      }
      throw err;
    }
  });
}
