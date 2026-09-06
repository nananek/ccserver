import { test, expect } from '@playwright/test';

// セッション行の右クリック改名: コンテキストメニュー → 改名ダイアログ →
// 一覧・ターミナルヘッダー反映 → クリア → リロード後の下段表示まで検証する。
// 既定のサイドバーモードで検証する (popup とは SessionList を共用のため)。

const SKIP_KEY = 'ccserver-skip-close-confirm';
const openTerminalBtn = (page) => page.getByRole('button', { name: 'Terminal', exact: true });
const leftSidebar = (page) => page.locator('.left-sidebar');
const openedItems = (page) => leftSidebar(page).locator('[data-section="opened"] .session-menu-item');
const unopenedItems = (page) => leftSidebar(page).locator('[data-section="unopened"] .session-menu-item');
const contextMenu = (page) => page.locator('.session-context-menu');
const renameDialog = (page) => page.locator('.resume-dialog', { hasText: 'セッション名を設定' });

async function gotoApp(page) {
  await page.goto('/');
  await expect(openTerminalBtn(page)).toBeVisible();
}

async function openShellTab(page) {
  await page.locator('.tab-list').getByTitle('Files').click();
  await openTerminalBtn(page).click();
  await expect(page.locator('.terminal-container')).toBeVisible();
  await expect(openedItems(page)).toHaveCount(1);
}

// sessionId 確立 (WS往復) を待ってから行を右クリックする。未確立の間は
// メニューが開かないため、開くまで再試行する。
async function rightClickFirstOpened(page) {
  for (let i = 0; i < 10; i++) {
    await openedItems(page).first().click({ button: 'right' });
    try {
      await expect(contextMenu(page)).toBeVisible({ timeout: 1000 });
      return;
    } catch {
      await page.waitForTimeout(1000);
    }
  }
  throw new Error('context menu did not open');
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

test('右クリックで名前を設定すると一覧とヘッダーに反映され、クリアで戻る', async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, '1'), SKIP_KEY);
  await gotoApp(page);
  await openShellTab(page);

  // 右クリック → メニュー → 名前を設定。
  await rightClickFirstOpened(page);
  await expect(contextMenu(page).getByRole('menuitem', { name: '名前を設定' })).toBeVisible();
  await expect(contextMenu(page).getByRole('menuitem', { name: '名前をクリア' })).toHaveCount(0);
  await contextMenu(page).getByRole('menuitem', { name: '名前を設定' }).click();
  await expect(renameDialog(page)).toBeVisible();
  await renameDialog(page).getByLabel('セッション名').fill('マイ作業');
  await renameDialog(page).getByRole('button', { name: '保存' }).click();

  // 上段の行名とターミナルヘッダーに反映される。
  await expect(openedItems(page).first().locator('.session-menu-label')).toHaveText('マイ作業');
  await expect(page.locator('.terminal-title')).toContainText('マイ作業');

  // 再度右クリックすると「名前をクリア」が出る。クリアで元に戻る。
  await rightClickFirstOpened(page);
  await contextMenu(page).getByRole('menuitem', { name: '名前をクリア' }).click();
  await expect(openedItems(page).first().locator('.session-menu-label')).not.toHaveText('マイ作業');
  await expect(page.locator('.terminal-title')).not.toContainText('マイ作業');

  // Cleanup: タブを閉じ、残った稼働セッションを終了する。
  await openedItems(page).first().locator('.session-menu-close').click();
  await expect.poll(async () => openedItems(page).count(), { timeout: 10_000 }).toBe(0);
  await terminateAllLowerSidebar(page);
});

test('設定した名前はリロード後も下段に残る (サーバー保存)', async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, '1'), SKIP_KEY);
  await gotoApp(page);
  await openShellTab(page);

  await rightClickFirstOpened(page);
  await contextMenu(page).getByRole('menuitem', { name: '名前を設定' }).click();
  await renameDialog(page).getByLabel('セッション名').fill('リロード試験');
  await renameDialog(page).getByRole('button', { name: '保存' }).click();
  await expect(openedItems(page).first().locator('.session-menu-label')).toHaveText('リロード試験');

  // リロードでタブは消えるが、サーバー側セッションは生き残り下段に名前付きで出る。
  await page.reload();
  await expect(openTerminalBtn(page)).toBeVisible();
  await expect(leftSidebar(page)).toBeVisible();
  const lower = unopenedItems(page).filter({ hasText: 'リロード試験' });
  await expect(lower).toHaveCount(1, { timeout: 10_000 });

  await terminateAllLowerSidebar(page);
});
