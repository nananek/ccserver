import { test, expect } from '@playwright/test';

// 旧形式のディレクトリ別記憶 ({gpg, sshAgent} のみ・tools キー不在) では
// tools 項目が未選択扱いとなり、Settings > 一般のグローバル既定値に
// フォールバックすること (一律 true にならないこと) を検証する。
// 明示保存された true/false は引き続き記憶が優先される。

const openTerminalBtn = (page) => page.getByRole('button', { name: 'Terminal', exact: true });
const launchMenuBtn = (page) => page.getByRole('button', { name: '起動方法を選択' });
// Scoped to the launch dialog: Settings is now a permanent (always-mounted)
// tab, so its General section's identically-labeled checkboxes ("rtk を導入
// する" / "code-review-graph MCP を導入する") are also in the DOM and would
// otherwise make an unscoped getByLabel ambiguous.
const launchDialog = (page) => page.locator('.resume-dialog.open-dialog');
const rtkCheck = (page) => launchDialog(page).getByLabel('rtk を導入する (sandbox 内にインストール)');
const crgCheck = (page) => launchDialog(page).getByLabel('code-review-graph MCP を導入する');

// currentPath は初回 '/' (ccserver-last-dir 未設定時)。起動メニューは
// currentPath に対する sandboxOpts を表示するため、'/' への記憶で足りる。
async function seedOldFormatMemory(page) {
  await page.evaluate(() => {
    localStorage.setItem('ccserver-default-sandbox-rtk', '0');
    localStorage.setItem('ccserver-default-sandbox-code-review-graph', '0');
    localStorage.setItem('ccserver-sandbox-opts:/', JSON.stringify({ gpg: false, sshAgent: false }));
  });
  await page.reload();
  await expect(openTerminalBtn(page)).toBeVisible();
}

test('旧形式の記憶 + グローバルOFF では tools がオフで表示される', async ({ page }) => {
  await page.goto('/');
  await expect(openTerminalBtn(page)).toBeVisible();
  await seedOldFormatMemory(page);

  await launchMenuBtn(page).click();
  await expect(rtkCheck(page)).not.toBeChecked();
  await expect(crgCheck(page)).not.toBeChecked();
  await page.getByRole('button', { name: 'キャンセル' }).click();
});

test('明示保存された tools=true はグローバルOFFでも記憶が優先される', async ({ page }) => {
  await page.goto('/');
  await expect(openTerminalBtn(page)).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem('ccserver-default-sandbox-rtk', '0');
    localStorage.setItem('ccserver-default-sandbox-code-review-graph', '0');
    localStorage.setItem(
      'ccserver-sandbox-opts:/',
      JSON.stringify({ gpg: false, sshAgent: false, tools: { rtk: true, codeReviewGraph: true } })
    );
  });
  await page.reload();
  await expect(openTerminalBtn(page)).toBeVisible();

  await launchMenuBtn(page).click();
  await expect(rtkCheck(page)).toBeChecked();
  await expect(crgCheck(page)).toBeChecked();
  await page.getByRole('button', { name: 'キャンセル' }).click();
});
