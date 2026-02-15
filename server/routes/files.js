import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { resolve, basename, join } from 'node:path';

function safePath(requestedPath) {
  return resolve('/', requestedPath || '/');
}

export async function filesRoute(fastify, opts) {
  // Download
  fastify.get('/files', async (request, reply) => {
    const filePath = safePath(request.query.path);

    try {
      const st = await stat(filePath);
      if (!st.isFile()) {
        return reply.code(400).send({ error: 'Not a file' });
      }

      const name = basename(filePath);
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
      reply.header('Content-Length', st.size);
      reply.type('application/octet-stream');
      return reply.send(createReadStream(filePath));
    } catch (err) {
      if (err.code === 'ENOENT') {
        return reply.code(404).send({ error: 'File not found' });
      }
      if (err.code === 'EACCES') {
        return reply.code(403).send({ error: 'Permission denied' });
      }
      throw err;
    }
  });

  // Upload (multipart)
  fastify.post('/files', async (request, reply) => {
    const parts = request.parts();
    let destination = null;
    const uploaded = [];

    for await (const part of parts) {
      if (part.type === 'field' && part.fieldname === 'destination') {
        destination = safePath(part.value);
        continue;
      }

      if (part.type === 'file') {
        if (!destination) {
          // Consume and discard to avoid stream errors
          await part.toBuffer();
          return reply.code(400).send({ error: 'destination field must come before files' });
        }

        const name = basename(part.filename);
        if (!name || name === '.' || name === '..') {
          await part.toBuffer();
          continue;
        }

        const targetPath = join(destination, name);
        try {
          const buf = await part.toBuffer();
          await writeFile(targetPath, buf);
          uploaded.push({ name, path: targetPath, size: buf.length });
        } catch (err) {
          if (err.code === 'EACCES') {
            return reply.code(403).send({ error: `Permission denied: ${name}` });
          }
          if (err.code === 'ENOENT') {
            return reply.code(404).send({ error: 'Destination directory not found' });
          }
          throw err;
        }
      }
    }

    return { uploaded };
  });
}
