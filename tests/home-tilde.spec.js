import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { test, expect } from '@playwright/test';

// The display layer abbreviates $HOME as `~` (client/src/displayPath.js) in
// the terminal title, while title attributes keep the raw full path. The
// session list shows the basename with the raw path on hover. A session whose
// cwd sits under $HOME must show as ~/... in the terminal header;
// the /tmp-based specs (sandbox-resume etc.) stay on the raw path.

async function openShell(page, cwd) {
  return page.evaluate(async (cwd) => {
    const ws = new WebSocket(`ws://${location.host}/ws/terminal`);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const sessionId = await new Promise((res, rej) => {
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'session') res(m.sessionId);
        if (m.type === 'error') rej(new Error(m.message));
      };
      ws.send(JSON.stringify({
        type: 'init', cwd, cols: 80, rows: 24, shell: true, sandbox: false, app: null,
      }));
    });
    ws.close();
    return sessionId;
  }, cwd);
}

async function exitShell(page, sessionId) {
  await page.evaluate(async (sid) => {
    const ws = new WebSocket(`ws://${location.host}/ws/terminal`);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'session') ws.send(JSON.stringify({ type: 'input', data: 'exit\r' }));
    };
    ws.send(JSON.stringify({ type: 'attach', sessionId: sid }));
    await new Promise((res) => setTimeout(res, 1500));
    ws.close();
  }, sessionId);
}

test('$HOME paths keep the raw path on hover and show as ~ in the terminal title', async ({ page }) => {
  const base = mkdtempSync(join(homedir(), '.ccserver-home-tilde-'));
  const cwd = join(base, 'project');
  mkdirSync(cwd, { recursive: true });
  // The server runs as the same user, so the display layer abbreviates the
  // $HOME prefix (homedir()) as ~:  ~/.ccserver-home-tilde-XXXX/project.
  const label = '~' + cwd.slice(homedir().length);
  let sessionId = null;
  try {
    await page.goto('/');
    await page.waitForSelector('.dir-list');
    sessionId = await openShell(page, cwd);

    // Files画面の Active Sessions 一覧は撤去され、左セッション一覧の下段に
    // 移設された。下段の行は basename 表示 + title 属性にフルパスを持つため、
    // title 属性 (cwd完全一致) で一意に特定する。
    await page.reload();
    const item = page.locator(`.left-sidebar [data-section="unopened"] .session-menu-item[title="${cwd}"]`);
    await expect(item).toBeVisible();
    // The raw full path stays available on hover (title attribute), and the
    // visible row never shows the full path.
    await expect(item).toHaveAttribute('title', cwd);
    await expect(item.locator('.session-menu-label')).toHaveText('project');
    await expect(item.locator('.session-menu-label')).not.toHaveText(cwd);

    // Opening the session shows the abbreviated path in the terminal header.
    await item.locator('.session-menu-select').click();
    await expect(page.locator('.terminal-title', { hasText: label })).toBeVisible();
  } finally {
    if (sessionId) await exitShell(page, sessionId);
    rmSync(base, { recursive: true, force: true });
  }
});

test('breadcrumbs under $HOME render the root as ~ and navigate on click', async ({ page }) => {
  const base = mkdtempSync(join(homedir(), '.ccserver-home-tilde-'));
  const cwd = join(base, 'project');
  mkdirSync(cwd, { recursive: true });
  try {
    // Seed last-dir to the home-relative dir so the browser opens there.
    await page.goto('/');
    await page.evaluate((d) => localStorage.setItem('ccserver-last-dir', d), cwd);
    await page.goto('/');

    // Root crumb is "~" with the real home path as its title; the rest of
    // the crumbs stay plain segment names.
    const rootCrumb = page.locator('.breadcrumb-item', { hasText: '~' }).first();
    await expect(rootCrumb).toBeVisible();
    await expect(rootCrumb).toHaveAttribute('title', homedir());
    await expect(page.locator('.breadcrumb-item', { hasText: 'project' })).toBeVisible();

    // Clicking the ~ crumb navigates back to $HOME itself. Under $HOME the
    // breadcrumb renders the full path (root + home dir segments) instead of
    // a lone ~ crumb, so parents of $HOME stay reachable.
    await rootCrumb.click();
    await expect(page.locator('.breadcrumb-item', { hasText: '~' })).not.toBeVisible();
    await expect(page.locator('.breadcrumb-item', { hasText: 'project' })).not.toBeVisible();
    await expect(page.locator('.breadcrumb-item').first()).toHaveText('/');
    await expect(page.locator('.breadcrumb-item', { hasText: basename(homedir()) })).toBeVisible();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
