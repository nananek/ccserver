import { test, expect } from '@playwright/test';

// Settings > 一般: テーマ・終了確認・ウィジェット重ね表示の各設定が
// 即時反映＋永続化されることを検証する。
test.describe('Settings general section', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    // localStorage を初期化してデフォルト状態から始める。
    // popup前提: セッション表示の既定はサイドバーのため、従来popup挙動に
    // 依存する本ファイルの検証では明示する (アサーション自体は不変)。
    await page.evaluate(() => {
      localStorage.removeItem('ccserver-theme');
      localStorage.removeItem('ccserver-skip-close-confirm');
      localStorage.removeItem('ccserver-sidebar-overlay');
      localStorage.setItem('ccserver-session-mode', 'popup');
      localStorage.removeItem('ccserver-session-sidebar-open');
      localStorage.removeItem('ccserver-session-sidebar-overlay');
      localStorage.removeItem('ccserver-default-sandbox-gpg');
      localStorage.removeItem('ccserver-default-sandbox-ssh-agent');
      localStorage.removeItem('ccserver-default-sandbox-rtk');
      localStorage.removeItem('ccserver-default-sandbox-code-review-graph');
      localStorage.removeItem('ccserver-nav-guard');
    });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('.settings-view')).toBeVisible();
  });

  test('theme select changes and persists', async ({ page }) => {
    const panel = page.locator('[role="tabpanel"]');
    const select = panel.getByLabel('テーマ');
    await expect(select).toBeVisible();
    await select.selectOption('dracula');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('ccserver-theme')))
      .toBe('dracula');
    // テーマCSSが即時適用される (Dracula の --bg-primary)。
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()
        )
      )
      .toBe('#282a36');
  });

  test('no theme picker in terminal header', async ({ page }) => {
    // shellタブを開いても、CLI上部のテーマ切り替えは存在しない
    // (一般設定に移植済み)。セッションタブはハンバーガーメニュー内に
    // 縦表示されるため、件数バッジで開 tab 数を検証する。
    await page.locator('.tab-list .tab-item', { hasText: 'Files' }).click();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page.locator('.session-menu-count')).toHaveText('1');
    await page.getByRole('button', { name: 'セッション一覧メニュー' }).click();
    await expect(page.locator('.session-menu [data-section="opened"] .session-menu-item')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.terminal-header')).toBeVisible();
    await expect(page.locator('.terminal-header .theme-picker')).toHaveCount(0);
  });

  test('close confirm checkbox toggles skip flag', async ({ page }) => {
    const panel = page.locator('[role="tabpanel"]');
    const check = panel.getByLabel('タブを閉じる前に確認する');
    await expect(check).toBeChecked();
    await check.uncheck();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('ccserver-skip-close-confirm')))
      .toBe('1');
    await check.check();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('ccserver-skip-close-confirm')))
      .toBeNull();
  });

  test('sidebar overlay checkbox toggles overlay mode', async ({ page }) => {
    const panel = page.locator('[role="tabpanel"]');
    const check = panel.getByLabel('ウィジェットをCLIの上に重ねて表示する');
    await expect(check).not.toBeChecked();
    await check.check();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('ccserver-sidebar-overlay')))
      .toBe('1');
    await expect(page.locator('.main-row')).toHaveClass(/sidebar-overlay/);
    // 重ね表示中もタブバーのトグルボタンはサイドバーに覆われず、
    // クリックで閉じられる (サイドバー自体に閉じるボタンはないため)。
    const toggle = page.getByRole('button', { name: 'サイドバーを閉じる' });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.locator('.right-sidebar')).toBeHidden();
    await page.getByRole('button', { name: 'サイドバーを開く' }).click();
    await expect(page.locator('.right-sidebar')).toBeVisible();
    await check.uncheck();
    await expect(page.locator('.main-row')).not.toHaveClass(/sidebar-overlay/);
  });

  test('sandbox defaults default to off/off/off/off and persist', async ({ page }) => {
    const panel = page.locator('[role="tabpanel"]');
    const gpg = panel.getByLabel('GPG署名を使う');
    const ssh = panel.getByLabel('ssh-agentを転送する');
    const rtk = panel.getByLabel('rtk を導入する');
    const crg = panel.getByLabel('code-review-graph MCP を導入する');
    await expect(gpg).not.toBeChecked();
    await expect(ssh).not.toBeChecked();
    await expect(rtk).not.toBeChecked();
    await expect(crg).not.toBeChecked();
    // 変更が localStorage に永続化される。
    await gpg.check();
    await ssh.check();
    await rtk.check();
    await crg.check();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('ccserver-default-sandbox-gpg')))
      .toBe('1');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('ccserver-default-sandbox-ssh-agent')))
      .toBe('1');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('ccserver-default-sandbox-rtk')))
      .toBe('1');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('ccserver-default-sandbox-code-review-graph')))
      .toBe('1');
    // リロード後も復元される。
    await page.reload();
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    const panel2 = page.locator('[role="tabpanel"]');
    await expect(panel2.getByLabel('GPG署名を使う')).toBeChecked();
    await expect(panel2.getByLabel('ssh-agentを転送する')).toBeChecked();
    await expect(panel2.getByLabel('rtk を導入する')).toBeChecked();
    await expect(panel2.getByLabel('code-review-graph MCP を導入する')).toBeChecked();
  });

  test('nav guard select defaults to confirm and persists', async ({ page }) => {
    const panel = page.locator('[role="tabpanel"]');
    const select = panel.getByLabel('ブラウザの戻る・進む操作');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('confirm');
    await select.selectOption('suppress');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('ccserver-nav-guard')))
      .toBe('suppress');
    // リロード後も復元される。
    await page.reload();
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('[role="tabpanel"]').getByLabel('ブラウザの戻る・進む操作')).toHaveValue('suppress');
  });

  test('nav guard select falls back to confirm on invalid stored value', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('ccserver-nav-guard', 'bogus'));
    await page.reload();
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('[role="tabpanel"]').getByLabel('ブラウザの戻る・進む操作')).toHaveValue('confirm');
  });
});
