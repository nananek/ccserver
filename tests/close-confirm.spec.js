import { test, expect } from '@playwright/test';

const SKIP_KEY = 'ccserver-skip-close-confirm';

// popup前提: 既定はサイドバーのため、従来popup挙動の検証では明示する
// (アサーション自体は不変)。
const usePopupMode = (page) => page.addInitScript(() => {
  localStorage.setItem('ccserver-session-mode', 'popup');
});

// Locators / helpers ---------------------------------------------------------
// Session (terminal) tabs now live in the hamburger menu at the left end of
// the tab bar, not in .tab-list. Files/Remote/Settings tabs stay horizontal
// (permanent, icon-only -- selected by title/aria-label, not visible text).

const openTerminalBtn = (page) => page.getByRole('button', { name: 'Terminal', exact: true });
const hamburger = (page) => page.getByRole('button', { name: 'セッション一覧メニュー' });
const sessionMenu = (page) => page.locator('.session-menu');
const sessionBadge = (page) => page.locator('.session-menu-count');
const menuCloseButtons = (page) => sessionMenu(page).locator('[data-section="opened"] .session-menu-item .session-menu-close');
const modal = (page) => page.locator('.resume-overlay', { hasText: 'タブを閉じますか?' });

async function badgeCount(page) {
  return sessionBadge(page).count();
}

async function openShellTab(page) {
  // The "Terminal" button lives in the Files/DirectoryBrowser tab.
  await page.locator('.tab-list').getByTitle('Files').click();
  const before = await badgeCount(page);
  await openTerminalBtn(page).click();
  if (before === 0) {
    await expect(sessionBadge(page)).toHaveText('1');
  } else {
    await expect(sessionBadge(page)).toHaveText(String(before + 1));
  }
}

async function openMenu(page) {
  await hamburger(page).click();
  await expect(sessionMenu(page)).toBeVisible();
}

async function gotoApp(page) {
  await page.goto('/');
  await expect(openTerminalBtn(page)).toBeVisible();
}

// Tests ----------------------------------------------------------------------

test('running tab: modal shows, cancel keeps the tab, confirm terminates it', async ({ page }) => {
  await usePopupMode(page);
  await gotoApp(page);
  await openShellTab(page);

  // X on a running tab (in the hamburger menu) opens the custom modal.
  await openMenu(page);
  await menuCloseButtons(page).first().click();
  await expect(modal(page)).toBeVisible();

  // Cancel keeps the tab.
  await page.getByRole('button', { name: 'キャンセル' }).click();
  await expect(modal(page)).toBeHidden();
  await expect(sessionBadge(page)).toHaveText('1');

  // Confirm (without checking the box) terminates the session and closes
  // the tab, and does NOT persist skip. ("The session is actually gone
  // server-side" is verified in detail by 'terminate button ends the
  // session completely' below -- this test only covers cancel-vs-confirm.)
  await openMenu(page).catch(() => {});
  if (await sessionMenu(page).count() === 0) await openMenu(page);
  await menuCloseButtons(page).first().click();
  await expect(modal(page)).toBeVisible();
  await modal(page).getByRole('button', { name: 'セッションを終了', exact: true }).click();
  await expect(modal(page)).toBeHidden();
  await expect(sessionBadge(page)).toHaveCount(0);

  const skip = await page.evaluate((k) => localStorage.getItem(k), SKIP_KEY);
  expect(skip).toBeNull();
});

test('"don\'t ask again" persists to localStorage and skips future confirms (incl. after reload)', async ({ page }) => {
  await usePopupMode(page);
  await gotoApp(page);
  await openShellTab(page);

  // Close with the checkbox ticked.
  await openMenu(page);
  await menuCloseButtons(page).first().click();
  await expect(modal(page)).toBeVisible();
  await page.locator('.close-confirm-checkbox input[type="checkbox"]').check();
  await modal(page).getByRole('button', { name: 'セッションを終了', exact: true }).click();
  await expect(sessionBadge(page)).toHaveCount(0);

  // Preference persisted.
  const skip = await page.evaluate((k) => localStorage.getItem(k), SKIP_KEY);
  expect(skip).toBe('1');

  // A new running tab now closes WITHOUT the modal -- and, since skip now
  // means "terminate immediately" rather than "detach", the session is
  // actually gone server-side too: it must not linger in the lower
  // ("unopened") section.
  await openShellTab(page);
  await openMenu(page);
  await menuCloseButtons(page).first().click();
  await expect(sessionBadge(page)).toHaveCount(0);
  await expect(modal(page)).toBeHidden();
  await expect(sessionMenu(page).locator('[data-section="unopened"] .session-menu-item')).toHaveCount(0, { timeout: 10_000 });

  // Survives a reload.
  await page.reload();
  await expect(openTerminalBtn(page)).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), SKIP_KEY)).toBe('1');
  await openShellTab(page);
  await openMenu(page);
  await menuCloseButtons(page).first().click();
  await expect(sessionBadge(page)).toHaveCount(0);
  await expect(modal(page)).toBeHidden();
  await expect(sessionMenu(page).locator('[data-section="unopened"] .session-menu-item')).toHaveCount(0, { timeout: 10_000 });
});

test('exited tab closes without a confirm (skip not enabled)', async ({ page }) => {
  await usePopupMode(page);
  await gotoApp(page);
  await openShellTab(page);

  // Wait for the shell to be ready (a prompt has rendered), then exit it.
  const rows = page.locator('.terminal-container .xterm-rows');
  await expect(rows).toContainText(/[$#%>]/, { timeout: 15_000 });
  await page.locator('.terminal-container').click();
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');

  // Server sends `exit` → client prints this and marks the tab exited.
  await expect(rows).toContainText(/Process exited/, { timeout: 15_000 });

  // Closing an exited tab skips the modal — and this is the exited path,
  // not the "don't ask again" path.
  expect(await page.evaluate((k) => localStorage.getItem(k), SKIP_KEY)).toBeNull();
  await openMenu(page);
  await menuCloseButtons(page).first().click();
  await expect(sessionBadge(page)).toHaveCount(0);
  await expect(modal(page)).toBeHidden();
});

test('terminate button ends the session completely: tab closes and session is gone', async ({ page }) => {
  await usePopupMode(page);
  await gotoApp(page);

  // Earlier tests in this file leave lingered sessions in the shared e2e
  // server; drain them so the "nothing left behind" assertions are exact.
  await openMenu(page);
  for (let i = 0; i < 15; i++) {
    const lowers = sessionMenu(page).locator('[data-section="unopened"] .session-menu-item');
    const before = await lowers.count();
    if (before === 0) break;
    page.once('dialog', (d) => d.accept());
    await lowers.first().locator('.session-menu-close').click();
    await expect.poll(async () => sessionMenu(page).locator('[data-section="unopened"] .session-menu-item').count(), { timeout: 10_000 }).toBeLessThan(before);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await expect(sessionMenu(page)).toBeHidden();

  await openShellTab(page);

  // The dialog offers session termination at the left end.
  await openMenu(page);
  await menuCloseButtons(page).first().click();
  await expect(modal(page)).toBeVisible();
  const terminateBtn = modal(page).getByRole('button', { name: 'セッションを終了', exact: true });
  await expect(terminateBtn).toBeVisible();

  await terminateBtn.click();
  await expect(modal(page)).toBeHidden();
  await expect(sessionBadge(page)).toHaveCount(0);

  // The session is gone server-side: nothing lingers in the lower section.
  await openMenu(page);
  await expect(sessionMenu(page).locator('[data-section="unopened"] .session-menu-item')).toHaveCount(0);
  await page.keyboard.press('Escape').catch(() => {});
});

test('terminate button ignores double-click: single DELETE, no error alert', async ({ page }) => {
  await usePopupMode(page);
  await gotoApp(page);
  await openShellTab(page);

  await openMenu(page);
  await menuCloseButtons(page).first().click();
  await expect(modal(page)).toBeVisible();

  // A duplicate DELETE would 404 and surface a bogus failure alert, so count
  // the requests and fail if any dialog appears.
  let deleteCount = 0;
  await page.route('**/api/sessions/*', async (route) => {
    if (route.request().method() === 'DELETE') deleteCount += 1;
    await route.continue();
  });
  let alerted = false;
  page.on('dialog', (d) => { alerted = true; d.accept().catch(() => {}); });

  await modal(page).getByRole('button', { name: 'セッションを終了', exact: true }).dblclick();
  await expect(modal(page)).toBeHidden({ timeout: 15_000 });
  await expect(sessionBadge(page)).toHaveCount(0);
  await page.waitForTimeout(1000); // let a duplicate request surface if any
  expect(deleteCount).toBe(1);
  expect(alerted).toBe(false);
  await page.unroute('**/api/sessions/*');
});

test('remote tab keeps the detach-only "閉じる" button and never issues a local DELETE', async ({ page }) => {
  await usePopupMode(page);
  await gotoApp(page);

  // Fake a single active paired instance with one running session, entirely
  // client-side: opening a remote terminal tab (App.jsx's
  // openRemoteTerminalTab) never itself calls a local API -- it only adds a
  // `remote: {...}` tab to state -- so no real second ccserver instance is
  // needed to reach the close-confirm dialog for one. The tab's own
  // WS connection (to this server's /ws/remote-terminal) will fail since
  // 'fake-remote-1' isn't a real paired peer; that's handled server-side
  // (see server/ws/remoteTerminal.js) and is irrelevant to this dialog test.
  const instanceId = 'fake-remote-1';
  await page.route('**/api/federation/instances', (route) => route.fulfill({
    json: { instances: [{ id: instanceId, status: 'active', label: 'FakePeer', fingerprint: 'aa:bb:cc:dd:ee', addr: '127.0.0.1:9999' }] },
  }));
  await page.route(`**/api/federation/instances/${instanceId}/sessions`, (route) => route.fulfill({
    json: { sessions: [{ id: 'remote-sess-1', cwd: '/tmp/remote-project', app: 'claude', shell: false }] },
  }));
  await page.route(`**/api/federation/instances/${instanceId}/groups`, (route) => route.fulfill({ json: { groups: [] } }));

  await page.locator('.tab-list').getByTitle('Remote').click();
  await page.getByTestId('remote-instance-header').waitFor();
  await page.locator('.sandbox-body', { hasText: '/tmp/remote-project' }).click();

  // The remote terminal tab shows up in the hamburger menu's "opened"
  // section like any other running terminal tab.
  await expect(sessionBadge(page)).toHaveText('1');
  await openMenu(page);
  await menuCloseButtons(page).first().click();
  await expect(modal(page)).toBeVisible();

  // No "セッションを終了" for a remote tab: a local DELETE would either 404
  // or, worse, hit an unrelated local session that happens to share the id.
  await expect(modal(page).getByRole('button', { name: 'セッションを終了', exact: true })).toHaveCount(0);
  const closeBtn = modal(page).getByRole('button', { name: '閉じる', exact: true });
  await expect(closeBtn).toBeVisible();

  let deleteRequested = false;
  await page.route('**/api/sessions/*', async (route) => {
    if (route.request().method() === 'DELETE') deleteRequested = true;
    await route.continue();
  });

  await closeBtn.click();
  await expect(modal(page)).toBeHidden();
  await expect(sessionBadge(page)).toHaveCount(0);
  expect(deleteRequested).toBe(false);

  await page.unroute('**/api/sessions/*');
});

test('closing the last session tab falls back to the Files tab, not Settings', async ({ page }) => {
  // Regression guard: doCloseTab picks "the tab at the closed tab's old
  // index" as the next active tab. Settings became an always-on tab sitting
  // right after Files/Remote (PR #116), so once it's the only tab left at
  // that index, closing the last terminal tab used to land on Settings
  // instead of Files. See App.jsx's doCloseTab isDynamic guard.
  await usePopupMode(page);
  await gotoApp(page);
  await openShellTab(page);

  await openMenu(page);
  await menuCloseButtons(page).first().click();
  await expect(modal(page)).toBeVisible();
  await modal(page).getByRole('button', { name: 'セッションを終了', exact: true }).click();
  await expect(modal(page)).toBeHidden();
  await expect(sessionBadge(page)).toHaveCount(0);

  await expect(page.locator('.tab-list').getByTitle('Files')).toHaveClass(/active/);
  await expect(openTerminalBtn(page)).toBeVisible();
  await expect(page.locator('.settings-view')).toBeHidden();
});

test('closing one of several open session tabs still selects an adjacent session tab, not Files', async ({ page }) => {
  // Regression guard for the same doCloseTab fix above: with more than one
  // dynamic (terminal/group) tab left, the existing "pick the adjacent one"
  // behavior must be unaffected -- only spilling over into the static tabs
  // should fall back to Files.
  await usePopupMode(page);
  await gotoApp(page);

  await openShellTab(page); // tab 1
  await openShellTab(page); // tab 2, becomes active
  await expect(sessionBadge(page)).toHaveText('2');

  // Close the active (2nd, last-opened) tab via its own close button.
  await openMenu(page);
  await menuCloseButtons(page).last().click();
  await expect(modal(page)).toBeVisible();
  await modal(page).getByRole('button', { name: 'セッションを終了', exact: true }).click();
  await expect(modal(page)).toBeHidden();
  await expect(sessionBadge(page)).toHaveText('1');

  // The remaining terminal tab (tab 1) is now active, not Files.
  await expect(page.locator('.terminal-container')).toBeVisible();
  await expect(page.locator('.tab-list').getByTitle('Files')).not.toHaveClass(/active/);

  // Clean up so the session doesn't linger for later tests.
  await openMenu(page);
  await menuCloseButtons(page).first().click();
  await expect(modal(page)).toBeVisible();
  await modal(page).getByRole('button', { name: 'セッションを終了', exact: true }).click();
  await expect(sessionBadge(page)).toHaveCount(0);
});
