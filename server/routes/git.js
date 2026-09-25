// Files screen git endpoints (#278):
//
//   GET  /api/git/info?path=   read-only repository / branch / remotes of the
//                              directory the screen is showing
//   POST /api/git/clone        clone a GitHub repository into a new directory
//                              under `parent` ({ parent, url, name? })
//
// Both are bounded by browseRoots exactly like /api/dirs (a present-but-
// unusable browseRoots fails closed with 503). The work lives in gitInfo.js
// and ghClone.js; this file only maps their result objects to HTTP.
//
// `opts.gitInfo` / `opts.clone` are test seams: extra options forwarded to
// readGitInfo / cloneRepository (a fake gh, tighter timeouts, ...).

import { loadSandboxConfig } from '../ws/sandbox.js';
import { readGitInfo } from '../gitInfo.js';
import { cloneRepository } from '../ghClone.js';

const BROWSE_ROOTS_INVALID_ERROR = 'sandbox.config.json "browseRoots" is invalid (must be an array of directory paths); directory access is disabled until it is fixed';

const STATUS = {
  validation: 400,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  busy: 429,
  'clone-failed': 502,
  timeout: 504,
  'gh-unavailable': 500,
  internal: 500,
};

export async function gitRoute(fastify, opts = {}) {
  fastify.get('/git/info', async (request, reply) => {
    const { browseRoots, browseRootsInvalid } = loadSandboxConfig();
    if (browseRootsInvalid) return reply.code(503).send({ error: BROWSE_ROOTS_INVALID_ERROR });
    const res = await readGitInfo(request.query?.path, browseRoots, opts.gitInfo);
    if (!res.ok) return reply.code(STATUS[res.code] || 500).send({ error: res.message });
    return res.data;
  });

  fastify.post('/git/clone', async (request, reply) => {
    const { browseRoots, browseRootsInvalid } = loadSandboxConfig();
    if (browseRootsInvalid) return reply.code(503).send({ error: BROWSE_ROOTS_INVALID_ERROR });
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply.code(400).send({ error: 'A JSON object body is required' });
    }
    const res = await cloneRepository(body, browseRoots, opts.clone);
    if (!res.ok) return reply.code(STATUS[res.code] || 500).send({ error: res.message });
    return res.data;
  });
}
