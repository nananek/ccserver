import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { groupDocsRoute } from './groupDocs.js';

let runtimeDir;
let app;
let groupManager;
let groupId;

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-gd-route-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  process.env.CCSERVER_GROUP_DOCS_PATH = join(runtimeDir, 'saved-group-docs.json');
  process.env.CCSERVER_GROUP_FILES_PATH = join(runtimeDir, 'saved-group-files.json');
  process.env.CCSERVER_GROUP_FILES_ROOT = join(runtimeDir, 'group-files');
  process.env.CCSERVER_SAVED_SESSIONS_PATH = join(runtimeDir, 'saved-sessions.json');
  process.env.CCSERVER_ORCHESTRATOR_GENERATED_ROOT = join(runtimeDir, 'orchestrator-generated');
  process.env.CCSERVER_WORKTREE_ROOT = join(runtimeDir, 'worktrees');
  const templateCopyPath = join(runtimeDir, 'orchestrator-template.md');
  cpSync(join(new URL('../ws/orchestrator-template.md', import.meta.url).pathname), templateCopyPath);
  process.env.CCSERVER_ORCHESTRATOR_TEMPLATE_PATH = templateCopyPath;
  groupManager = await import('../ws/groupManager.js');
  groupId = randomUUID();
  await groupManager.createGroup({ groupId, cwd: '/srv/proj', orchestratorDir: join(runtimeDir, groupId) });
  app = Fastify();
  await app.register(groupDocsRoute, { prefix: '/api' });
});

after(async () => {
  try { groupManager.destroyGroup(groupId); } catch {}
  try { await app.close(); } catch {}
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
  delete process.env.CCSERVER_GROUP_DOCS_PATH;
});

test('GET /api/groups/:id/docs returns metadata only (404 for unknown group)', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/docs` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Array.isArray(body.docs));
  assert.equal(body.docs.length, 0);

  const notFound = await app.inject({ method: 'GET', url: '/api/groups/nope/docs' });
  assert.equal(notFound.statusCode, 404);
});

test('list/content round-trip reflects publish_doc without leaking content in the list', async () => {
  groupManager.publishGroupDoc(groupId, 'workerA', 'plan', '# Plan\n\nsome content');

  const list = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/docs` });
  assert.equal(list.statusCode, 200);
  const entry = list.json().docs.find((d) => d.key === 'plan');
  assert.ok(entry, 'published doc should appear in the list');
  assert.equal(entry.publishedBy, 'workerA');
  assert.equal(typeof entry.publishedAt, 'number');
  assert.equal(typeof entry.size, 'number');
  assert.equal(entry.content, undefined, 'list must not include content');

  const content = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/docs/content?key=plan` });
  assert.equal(content.statusCode, 200);
  const body = content.json();
  assert.equal(body.key, 'plan');
  assert.equal(body.content, '# Plan\n\nsome content');
  assert.equal(body.publishedBy, 'workerA');
  assert.equal(typeof body.publishedAt, 'number');
});

test('content 404s for unknown key and unknown group, 400 without key', async () => {
  const missingKey = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/docs/content?key=nope` });
  assert.equal(missingKey.statusCode, 404);

  const missingGroup = await app.inject({ method: 'GET', url: `/api/groups/nope/docs/content?key=plan` });
  assert.equal(missingGroup.statusCode, 404);

  const noKey = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/docs/content` });
  assert.equal(noKey.statusCode, 400);
});

test('docs route is read-only: no write methods registered', async () => {
  const post = await app.inject({ method: 'POST', url: `/api/groups/${groupId}/docs`, payload: { key: 'x', content: 'y' } });
  assert.equal(post.statusCode, 404);
  const del = await app.inject({ method: 'DELETE', url: `/api/groups/${groupId}/docs/content?key=plan` });
  assert.equal(del.statusCode, 404);
});
