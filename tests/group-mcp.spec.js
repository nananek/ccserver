import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { resolveApp, SANDBOX_PATH } from '../server/ws/sandbox.js';

// Server-side combo group API contract: POST /api/groups spawns 3 sandboxed
// member sessions (2 workers + 1 orchestrator in its isolated dir), GET
// resolves them, DELETE tears all of them down. The sandbox (bwrap) is a hard
// prerequisite of the whole feature, so skip where it's missing -- same
// guard as sandbox-resume.spec.js. The agent CLIs are a second hard
// prerequisite: POST /api/groups launches claude+opencode sessions and
// returns 400 when the app binary can't be resolved, so skip when either is
// absent (plain CI runners have neither).
const sandboxAvailable = existsSync('/usr/bin/bwrap');

function appResolves(app) {
  try {
    const r = resolveApp(app).command;
    if (r.startsWith('/')) return existsSync(r);
    return SANDBOX_PATH.split(':').some((dir) => dir && existsSync(join(dir, r)));
  } catch {
    return false;
  }
}
const agentsAvailable = appResolves('claude') && appResolves('opencode');

const newCwd = () => mkdtempSync(join(tmpdir(), 'ccserver-group-mcp-'));

test.skip(!sandboxAvailable, 'bwrap not available — sandbox cannot run');
test.skip(!agentsAvailable, 'claude/opencode not installed — group sessions cannot spawn');

test('POST /api/groups creates 3 members; GET lists them; DELETE destroys them', async ({ page }) => {
  const cwd = newCwd();
  let groupId = null;
  try {
    await page.goto('/');

    // Create.
    const group = await page.evaluate(async (cwd) => {
      const res = await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd,
          workerA: { app: 'claude' },
          workerB: { app: 'opencode' },
          orchestrator: { app: 'claude', instructions: 'custom instructions' },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      return res.json();
    }, cwd);
    groupId = group.groupId;
    expect(group.members).toHaveLength(3);
    const byRole = Object.fromEntries(group.members.map((m) => [m.role, m]));
    expect(byRole.workerA.app).toBe('claude');
    expect(byRole.workerB.app).toBe('opencode');
    expect(byRole.orchestrator.cwd).not.toBe(cwd); // isolated dir, not the project
    expect(byRole.workerA.cwd).toBe(cwd);

    // GET resolves members and the orchestrator instructions were written.
    const got = await page.evaluate(async (gid) => {
      const res = await fetch(`/api/groups/${gid}`);
      return res.json();
    }, groupId);
    expect(got.allowedCwds).toEqual([cwd]);
    expect(got.members).toHaveLength(3);
    const orchDir = got.orchestratorDir;
    expect(orchDir).toBeTruthy();

    // The three sessions show up in /api/sessions tagged with the group.
    const sessions = await page.evaluate(async (gid) => {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      return data.sessions.filter((s) => s.groupId === gid);
    }, groupId);
    expect(sessions).toHaveLength(3);
    expect(sessions.map((s) => s.groupRole).sort()).toEqual(['orchestrator', 'workerA', 'workerB']);

    // DELETE destroys all three.
    const delStatus = await page.evaluate(async (gid) => {
      const res = await fetch(`/api/groups/${gid}`, { method: 'DELETE' });
      return res.status;
    }, groupId);
    expect(delStatus).toBe(200);
    groupId = null;

    // destroyGroup is synchronous on the server; poll instead of a fixed
    // wait so the assertion is deterministic.
    await expect.poll(async () => page.evaluate(async (gid) => {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      return data.sessions.filter((s) => s.groupId === gid).length;
    }, group.groupId)).toBe(0);

    const gone = await page.evaluate(async (gid) => {
      const res = await fetch(`/api/groups/${gid}`);
      return res.status;
    }, group.groupId);
    expect(gone).toBe(404);
  } finally {
    if (groupId) {
      await page.evaluate(async (gid) => {
        await fetch(`/api/groups/${gid}`, { method: 'DELETE' });
      }, groupId);
    }
  }
});
