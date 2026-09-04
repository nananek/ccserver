import * as groupManager from '../ws/groupManager.js';

// Read-only REST view onto the group document board (publish_doc/fetch_doc/
// list_docs -- see groupManager.js's "group-scoped document sharing"
// section). No POST/PUT/DELETE here on purpose: publishing/deleting a doc
// stays an MCP-only (agent) action, the browser can only look.
export async function groupDocsRoute(fastify, opts) {
  // List docs for a group. No content, mirroring listGroupDocs()/list_docs's
  // "list is cheap, fetch is deliberate" shape.
  fastify.get('/groups/:id/docs', async (request, reply) => {
    const groupId = request.params.id;
    const group = groupManager.getGroup(groupId);
    if (!group) return reply.code(404).send({ error: 'Group not found' });
    const docs = groupManager.listGroupDocs(groupId);
    return { docs };
  });

  // Fetch one doc's content. `key` is a query param rather than a path
  // segment: publish_doc's key has no character restrictions (may contain
  // '/', '?', ...), same reasoning as files.js's `/files/content?path=`.
  fastify.get('/groups/:id/docs/content', async (request, reply) => {
    const groupId = request.params.id;
    const key = request.query.key;
    if (typeof key !== 'string' || key === '') {
      return reply.code(400).send({ error: 'key is required' });
    }
    const group = groupManager.getGroup(groupId);
    if (!group) return reply.code(404).send({ error: 'Group not found' });
    const res = groupManager.fetchGroupDoc(groupId, key);
    if (res.error) {
      return reply.code(404).send({ error: res.error, message: res.message });
    }
    return { key: res.key, content: res.content, publishedBy: res.publishedBy, publishedAt: res.publishedAt };
  });
}
