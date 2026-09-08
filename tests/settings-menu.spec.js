import { test, expect } from '@playwright/test';

// Settings 左メニュー: 4項目の表示と切り替えを検証する。
// サンドボックス/ペアリング/パスキーの実データには依存しない (見出しと
// 空表示のいずれかが現れればよい) ため、bwrap 等の環境条件は不要。
test.describe('Settings left menu', () => {
  test('menus switch sections', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();

    // Settings タブに切り替える (常設タブ、アイコンのみ表示)。
    await page.locator('.tab-list').getByTitle('Settings').click();
    const settings = page.locator('.settings-view');
    await expect(settings).toBeVisible();

    // 左メニューの4項目がタブとして表示される (一般が先頭)。
    const sidebar = settings.locator('.settings-sidebar');
    const tabs = sidebar.getByRole('tab');
    await expect(tabs).toHaveText(['一般', '作成済みサンドボックス', 'ペアリング済みインスタンス', 'パスキー']);
    const panel = settings.locator('[role="tabpanel"]');
    await expect(panel).toBeVisible();

    // 初期選択は一般。
    await expect(sidebar.getByRole('tab', { name: '一般' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toContainText('テーマ');

    // サンドボックスに切り替え。
    await sidebar.getByRole('tab', { name: '作成済みサンドボックス' }).click();
    await expect(sidebar.getByRole('tab', { name: '作成済みサンドボックス' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toContainText('作成済みサンドボックス');

    // ペアリングに切り替え。
    await sidebar.getByRole('tab', { name: 'ペアリング済みインスタンス' }).click();
    await expect(sidebar.getByRole('tab', { name: 'ペアリング済みインスタンス' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toContainText('ペアリング済みインスタンス');

    // パスキーに切り替え (Issue #141 Step4)。
    await sidebar.getByRole('tab', { name: 'パスキー' }).click();
    await expect(sidebar.getByRole('tab', { name: 'パスキー' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toContainText('パスキー');

    // 一般に戻れる。
    await sidebar.getByRole('tab', { name: '一般' }).click();
    await expect(panel).toContainText('テーマ');
  });
});
