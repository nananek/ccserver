import { readdir, mkdir, stat } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';

export async function dirsRoute(fastify, opts) {
  fastify.get('/dirs', async (request, reply) => {
    const requestedPath = request.query.path || '/';
    const absPath = resolve('/', requestedPath);

    try {
      const entries = await readdir(absPath, { withFileTypes: true });
      const showHidden = !!request.query.showHidden;

      const dirs = entries
        .filter((entry) => {
          if (!entry.isDirectory()) return false;
          if (!showHidden && entry.name.startsWith('.')) return false;
          return true;
        })
        .map((entry) => ({
          name: entry.name,
          path: join(absPath, entry.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const fileEntries = entries.filter((entry) => {
        if (!entry.isFile()) return false;
        if (!showHidden && entry.name.startsWith('.')) return false;
        return true;
      });

      const files = await Promise.all(
        fileEntries.map(async (entry) => {
          const filePath = join(absPath, entry.name);
          try {
            const st = await stat(filePath);
            return { name: entry.name, path: filePath, size: st.size, mtime: st.mtimeMs };
          } catch {
            return { name: entry.name, path: filePath, size: 0, mtime: 0 };
          }
        })
      );
      files.sort((a, b) => a.name.localeCompare(b.name));

      return {
        current: absPath,
        parent: absPath === '/' ? null : resolve(absPath, '..'),
        dirs,
        files,
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

  fastify.post('/dirs', async (request, reply) => {
    const { parent, name } = request.body || {};

    if (!parent || !name) {
      return reply.code(400).send({ error: 'parent and name are required' });
    }

    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      return reply.code(400).send({ error: 'Invalid folder name' });
    }

    const absParent = resolve('/', parent);
    const newPath = join(absParent, name);

    try {
      await mkdir(newPath);
      return { path: newPath };
    } catch (err) {
      if (err.code === 'EEXIST') {
        return reply.code(409).send({ error: 'Directory already exists' });
      }
      if (err.code === 'EACCES') {
        return reply.code(403).send({ error: 'Permission denied' });
      }
      if (err.code === 'ENOENT') {
        return reply.code(404).send({ error: 'Parent directory not found' });
      }
      throw err;
    }
  });
}
