import { test, expect } from '@playwright/test';

// 左セッションサイドバー (既定・サイドバーモード) の検証。
// 既存 popup 挙動は session-menu.spec.js / close-confirm.spec.js で
// popup を明示した上で検証しているため、ここでは新規挙動のみ扱う。

const SKIP_KEY = 'ccserver-skip-close-confirm';
const openTerminalBtn = (page) => page.getByRole('button', { name: 'Terminal', exact: true });
const sessionToggle = (page) => page.getByRole('button', { name: /セッションサイドバー/ });
const leftSidebar = (page) => page.locator('.left-sidebar');
const tabToggleBadge = (page) => page.locator('.tab-bar .session-menu-count');
const sidebarBadge = (page) => page.locator('.left-sidebar .session-menu-count');
const openedItems = (page) => leftSidebar(page).locator('[data-section="opened"] .session-menu-item');
const unopenedItems = (page) => leftSidebar(page).locator('[data-section="unopened"] .session-menu-item');

async function gotoApp(page) {
  await page.goto('/');
  await expect(openTerminalBtn(page)).toBeVisible();
}

async function openShellTab(page) {
  await page.locator('.tab-list').getByTitle('Files').click();
  await openTerminalBtn(page).click();
  await expect(tabToggleBadge(page)).toHaveText('1');
  // pty確立 (サーバー側セッション生成) を待つ。直後にタブを閉じる手順では、
  // 確立前に閉じるとサーバーにセッションが残らず下段が空になる競合を避ける。
  await expect(page.locator('.terminal-container .xterm-rows')).toContainText(/[$#%>]/, { timeout: 15_000 });
}

async function closeAllUpperSidebar(page) {
  for (let i = 0; i < 5; i++) {
    if (await tabToggleBadge(page).count() === 0) break;
    await openedItems(page).first().locator('.session-menu-close').click();
    await expect.poll(async () => tabToggleBadge(page).count(), { timeout: 10_000 }).toBe(0);
  }
}

async function terminateAllLowerSidebar(page) {
  for (let i = 0; i < 15; i++) {
    const before = await unopenedItems(page).count();
    if (before === 0) break;
    page.once('dialog', (d) => d.accept());
    await unopenedItems(page).first().locator('.session-menu-close').click();
    await expect.poll(async () => unopenedItems(page).count(), { timeout: 10_000 }).toBeLessThan(before);
  }
}

test('default is sidebar: left panel visible, popup absent, toggle persists', async ({ page }) => {
  await gotoApp(page);

  // 既定 (キーなし) はサイドバー。popup の .session-menu は存在しない。
  await expect(leftSidebar(page)).toBeVisible();
  await expect(page.locator('.session-menu')).toHaveCount(0);
  await expect(sessionToggle(page)).toHaveAccessibleName('セッションサイドバーを閉じる');

  // トグルで閉じる → 永続化 → 開く → リロード後も復元。
  await sessionToggle(page).click();
  await expect(leftSidebar(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ccserver-session-sidebar-open'))).toBe('0');

  await page.getByRole('button', { name: 'セッションサイドバーを開く' }).click();
  await expect(leftSidebar(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ccserver-session-sidebar-open'))).toBe('1');

  await page.reload();
  await expect(openTerminalBtn(page)).toBeVisible();
  await expect(leftSidebar(page)).toBeVisible();
});

test('selecting a tab keeps the sidebar open', async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, '1'), SKIP_KEY);
  await gotoApp(page);

  await openShellTab(page);
  await expect(openedItems(page)).toHaveCount(1);
  await expect(sidebarBadge(page)).toHaveText('1');

  // 選択してもサイドバーは閉じない (popup は選択で閉じる)。
  await openedItems(page).first().locator('.session-menu-select').click();
  await expect(page.locator('.terminal-container')).toBeVisible();
  await expect(leftSidebar(page)).toBeVisible();

  // Cleanup: タブを閉じ、残った稼働セッションを終了する。
  await closeAllUpperSidebar(page);
  await terminateAllLowerSidebar(page);
});

test('settings select switches mode and persists', async ({ page }) => {
  await gotoApp(page);
  await expect(leftSidebar(page)).toBeVisible();

  await page.locator('.tab-list').getByTitle('Settings').click();
  await expect(page.locator('.settings-view')).toBeVisible();
  const panel = page.locator('[role="tabpanel"]');
  const select = panel.getByLabel('セッション表示');
  await expect(select).toHaveValue('sidebar');

  // popup に切替: 左パネルが消え、ハンバーガー + popup が出る。
  await select.selectOption('popup');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ccserver-session-mode'))).toBe('popup');
  await expect(leftSidebar(page)).toBeHidden();
  const hamburger = page.getByRole('button', { name: 'セッション一覧メニュー' });
  await expect(hamburger).toBeVisible();
  await hamburger.click();
  await expect(page.locator('.session-menu')).toBeVisible();
  await page.keyboard.press('Escape');

  // sidebar に戻す → リロード後も復元。
  await select.selectOption('sidebar');
  await expect(leftSidebar(page)).toBeVisible();
  await page.reload();
  await expect(openTerminalBtn(page)).toBeVisible();
  await expect(leftSidebar(page)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ccserver-session-mode'))).toBe('sidebar');
});

test('session overlay is independent from widget overlay', async ({ page }) => {
  await gotoApp(page);
  await page.evaluate(() => {
    localStorage.removeItem('ccserver-sidebar-overlay');
    localStorage.removeItem('ccserver-session-sidebar-overlay');
  });
  await page.reload();
  await expect(openTerminalBtn(page)).toBeVisible();
  // overlay ON時は左パネルが設定UIに重なるため (右overlayと同一設計:
  // 閉じるのはtab-barトグルのみ)、チェック操作時はパネルを閉じておく。
  // overlay設定自体は開閉と独立に永続化される。
  await sessionToggle(page).click();
  await expect(leftSidebar(page)).toBeHidden();
  await page.locator('.tab-list').getByTitle('Settings').click();
  const panel = page.locator('[role="tabpanel"]');
  const sessionCheck = panel.getByLabel('セッションをCLIの上に重ねて表示する');
  const widgetCheck = panel.getByLabel('ウィジェットをCLIの上に重ねて表示する');
  await expect(sessionCheck).not.toBeChecked();
  await expect(widgetCheck).not.toBeChecked();

  // 左のみ ON: session-overlay のみ付与、右キー・右クラスに影響なし。
  await sessionCheck.check();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ccserver-session-sidebar-overlay'))).toBe('1');
  await expect(page.locator('.main-row')).toHaveClass(/session-overlay/);
  await expect(page.locator('.main-row')).not.toHaveClass(/sidebar-overlay/);
  expect(await page.evaluate(() => localStorage.getItem('ccserver-sidebar-overlay'))).toBeNull();
  // 開き直しても表示され、前面に重なる (absolute配置)。
  await page.getByRole('button', { name: 'セッションサイドバーを開く' }).click();
  await expect(leftSidebar(page)).toBeVisible();
  await expect.poll(() => page.locator('.left-sidebar').evaluate((el) => getComputedStyle(el).position)).toBe('absolute');
  await page.getByRole('button', { name: 'セッションサイドバーを閉じる' }).click();
  await expect(leftSidebar(page)).toBeHidden();

  await sessionCheck.uncheck();
  await expect(page.locator('.main-row')).not.toHaveClass(/session-overlay/);

  // 右のみ ON: sidebar-overlay のみ付与、左キーに影響なし。
  // (左OFF後の値は '0' 保存。右 useWidgetPrefs と同一の永続化方針)
  await widgetCheck.check();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ccserver-sidebar-overlay'))).toBe('1');
  await expect(page.locator('.main-row')).toHaveClass(/sidebar-overlay/);
  await expect(page.locator('.main-row')).not.toHaveClass(/session-overlay/);
  expect(await page.evaluate(() => localStorage.getItem('ccserver-session-sidebar-overlay'))).toBe('0');
});

test('overlay時は選択で閉じる (上段・下段とも)', async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, '1'), SKIP_KEY);
  await page.addInitScript(() => localStorage.setItem('ccserver-session-sidebar-overlay', '1'));
  await gotoApp(page);
  await expect(page.locator('.main-row')).toHaveClass(/session-overlay/);
  // overlay中はパネルがCLI側を覆うため、タブ起動の間は閉じておく。
  await sessionToggle(page).click();
  await expect(leftSidebar(page)).toBeHidden();
  await openShellTab(page);
  await page.getByRole('button', { name: 'セッションサイドバーを開く' }).click();
  await expect(leftSidebar(page)).toBeVisible();

  // 上段選択で閉じる。
  await openedItems(page).first().locator('.session-menu-select').click();
  await expect(page.locator('.terminal-container')).toBeVisible();
  await expect(leftSidebar(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ccserver-session-sidebar-open'))).toBe('0');

  // 開き直してタブを閉じると下段に移る。下段選択でも閉じる。
  await page.getByRole('button', { name: 'セッションサイドバーを開く' }).click();
  await openedItems(page).first().locator('.session-menu-close').click();
  await expect(unopenedItems(page)).toHaveCount(1, { timeout: 10_000 });
  await unopenedItems(page).first().locator('.session-menu-select').click();
  await expect(page.locator('.terminal-container')).toBeVisible();
  await expect(leftSidebar(page)).toBeHidden();

  // Cleanup: 開き直してタブを閉じ、残った稼働セッションを終了する。
  await page.getByRole('button', { name: 'セッションサイドバーを開く' }).click();
  await closeAllUpperSidebar(page);
  await terminateAllLowerSidebar(page);
});

test('in-flowでは下段選択でも開いたまま', async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, '1'), SKIP_KEY);
  await gotoApp(page);
  await expect(page.locator('.main-row')).not.toHaveClass(/session-overlay/);
  await openShellTab(page);

  await openedItems(page).first().locator('.session-menu-close').click();
  await expect(unopenedItems(page)).toHaveCount(1, { timeout: 10_000 });
  await unopenedItems(page).first().locator('.session-menu-select').click();
  await expect(page.locator('.terminal-container')).toBeVisible();
  await expect(leftSidebar(page)).toBeVisible();

  await closeAllUpperSidebar(page);
  await terminateAllLowerSidebar(page);
});

test('狭幅では重ねOFFでも選択で閉じる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((k) => localStorage.setItem(k, '1'), SKIP_KEY);
  await gotoApp(page);
  // 狭幅の初回は閉じた状態で始まる。先にタブを開いてから (backdropに
  // 塞がれる前に) サイドバーを開け、選択で閉じることを確認する。
  await expect(leftSidebar(page)).toBeHidden();
  await openShellTab(page);
  await page.getByRole('button', { name: 'セッションサイドバーを開く' }).click();
  await expect(leftSidebar(page)).toBeVisible();
  await openedItems(page).first().locator('.session-menu-select').click();
  await expect(page.locator('.terminal-container')).toBeVisible();
  await expect(leftSidebar(page)).toBeHidden();

  await page.getByRole('button', { name: 'セッションサイドバーを開く' }).click();
  await closeAllUpperSidebar(page);
  await terminateAllLowerSidebar(page);
});

test('overlay時はグループ再オープンでも閉じる', async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, '1'), SKIP_KEY);
  await page.addInitScript(() => localStorage.setItem('ccserver-session-sidebar-overlay', '1'));
  // エージェント不要のスタブグループで再オープン経路を検証する。
  await page.route('**/api/groups', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        groups: [{ groupId: 'group-stub-1', cwd: '/tmp/stub-proj', createdAt: Date.now(), memberCount: 3, liveCount: 2 }],
      }),
    });
  });
  await page.route('**/api/groups/group-stub-1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ groupId: 'group-stub-1', cwd: '/tmp/stub-proj', members: [] }),
    });
  });
  await gotoApp(page);
  await expect(page.locator('.main-row')).toHaveClass(/session-overlay/);

  const groupItem = page.locator('.left-sidebar [data-section="unopened-groups"] .session-menu-item', { hasText: 'stub-proj' });
  await expect(groupItem).toBeVisible({ timeout: 15_000 });
  await groupItem.locator('.session-menu-select').click();
  // 自動クローズで閉じる。開き直すと、上段にグループ親行がある
  // (水平.tab-itemには出ない)。
  await expect(leftSidebar(page)).toBeHidden();
  await page.getByRole('button', { name: 'セッションサイドバーを開く' }).click();
  await expect(page.locator('.left-sidebar [data-section="opened"] .session-menu-item[data-tab-type="group"]', { hasText: 'stub-proj' })).toBeVisible({ timeout: 15_000 });
});
