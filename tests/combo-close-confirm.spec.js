import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { resolveApp, SANDBOX_PATH } from '../server/ws/sandbox.js';

// Combo launch is unconditionally sandboxed (the server rejects it without
// bwrap), so the whole suite only makes sense where bwrap exists. The agent
// CLIs are the second prerequisite (POST /api/groups spawns claude+opencode
// sessions and 400s when a binary can't be resolved) -- skip when either is
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

const newCwd = () => mkdtempSync(join(tmpdir(), 'ccserver-combo-e2e-'));

async function createGroup(page, cwd) {
  return page.evaluate(async (cwd) => {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd,
        workerA: { app: 'claude' },
        workerB: { app: 'opencode' },
        orchestrator: { app: 'claude' },
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  }, cwd);
}

async function destroyGroup(page, groupId) {
  await page.evaluate(async (gid) => {
    await fetch(`/api/groups/${gid}`, { method: 'DELETE' });
  }, groupId);
}

test.skip(!sandboxAvailable, 'bwrap not available — sandbox cannot run');
test.skip(!agentsAvailable, 'claude/opencode not installed — group sessions cannot spawn');

test('combo group tab lifecycle: create via API, attach, close-confirm mentions 3 sessions, DELETE tears down', async ({ page }) => {
  const cwd = newCwd();
  let groupId = null;
  try {
    // Navigate first so relative fetches resolve against the app origin.
    await page.goto('/');
    const group = await createGroup(page, cwd);
    groupId = group.groupId;
    expect(group.members).toHaveLength(3);
    const roles = group.members.map((m) => m.role).sort();
    expect(roles).toEqual(['orchestrator', 'workerA', 'workerB']);

    // A group tab appears as one entry with the directory name -- opened
    // from the browser's Groups list (API-created groups don't open a tab
    // by themselves).
    await page.goto('/');
    const dirName = cwd.split(/[/\\]/).filter(Boolean).pop();
    const groupItem = page.locator('.session-item', { hasText: cwd });
    await expect(groupItem).toBeVisible({ timeout: 15_000 });
    await groupItem.click();
    const groupTab = page.locator('.tab-item', { hasText: dirName });
    await expect(groupTab).toBeVisible({ timeout: 15_000 });

    // Its X opens the group-specific close dialog (mentions 3 sessions).
    await groupTab.locator('.tab-close').click();
    await expect(page.locator('.resume-overlay', { hasText: 'グループを閉じますか?' })).toBeVisible();
    await expect(page.locator('.resume-overlay', { hasText: '3つのセッション' })).toBeVisible();

    // Cancel keeps the tab.
    await page.getByRole('button', { name: 'キャンセル' }).click();
    await expect(groupTab).toBeVisible();

    // Confirm closes the tab and destroys the group server-side.
    await groupTab.locator('.tab-close').click();
    await page.getByRole('button', { name: '閉じる' }).click();
    await expect(groupTab).toBeHidden();

    const gone = await page.evaluate(async (gid) => {
      const res = await fetch(`/api/groups/${gid}`);
      return res.status;
    }, groupId);
    expect(gone).toBe(404);
  } finally {
    if (groupId) await destroyGroup(page, groupId);
  }
});

test('combo launch is single-slot per directory: relaunching the same cwd activates the existing tab, no second group', async ({ page }) => {
  const cwd = newCwd();
  const dirName = cwd.split(/[/\\]/).filter(Boolean).pop();
  // The single-slot guarantee means the relaunch must not even POST: count
  // the group-creation requests instead of relying on the group surviving
  // server-side (members can exit on their own, and an empty group then
  // self-destructs).
  const createdGroupIds = [];
  await page.route('**/api/groups', async (route) => {
    if (route.request().method() === 'POST') {
      const response = await route.fetch();
      const body = await response.json();
      createdGroupIds.push(body.groupId);
      await route.fulfill({ response });
    } else {
      await route.continue();
    }
  });

  try {
    // Navigate the browser to the temp project dir: / -> tmp -> <dirName>.
    await page.goto('/');
    await page.locator('.breadcrumb-item', { hasText: '/' }).first().click();
    await page.locator('.dir-item', { hasText: 'tmp' }).first().click();
    await page.locator('.dir-item', { hasText: dirName }).click();

    const openLaunchModal = async () => {
      await page.getByRole('button', { name: '起動方法を選択' }).click();
      await page.locator('.resume-dialog .launch-mode-btn', { hasText: 'コンボ起動' }).click();
      await page.locator('.resume-dialog .btn-primary', { hasText: 'コンボ起動' }).click();
    };

    // First combo launch creates one group tab.
    await openLaunchModal();
    const groupTab = page.locator('.tab-item', { hasText: dirName });
    await expect(groupTab).toBeVisible({ timeout: 15_000 });
    expect(createdGroupIds).toHaveLength(1);
    const groupId = createdGroupIds[0];

    // Relaunching the same cwd from the browser must activate the existing
    // tab instead of spawning a second group.
    await page.locator('.tab-item', { hasText: 'Files' }).click();
    await openLaunchModal();

    await expect(groupTab).toHaveClass(/active/);
    await expect(page.locator('.tab-item', { hasText: dirName })).toHaveCount(1);
    await page.waitForTimeout(2000); // the buggy behavior would have POSTed by now
    expect(createdGroupIds).toHaveLength(1);
  } finally {
    await page.unroute('**/api/groups');
    if (createdGroupIds[0]) await destroyGroup(page, createdGroupIds[0]);
  }
});
