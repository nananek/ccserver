import { test, expect } from '@playwright/test';

const SKIP_KEY = 'ccserver-skip-close-confirm';

// Locators / helpers ---------------------------------------------------------

const openTerminalBtn = (page) => page.getByRole('button', { name: 'Terminal', exact: true });
const closeButtons = (page) => page.locator('.tab-item .tab-close');
const modal = (page) => page.locator('.resume-overlay', { hasText: 'タブを閉じますか?' });

async function openShellTab(page) {
  // The "Terminal" button lives in the Files/DirectoryBrowser tab. Closing a
  // terminal tab activates an adjacent tab (Monitor), so re-activate Files first.
  await page.locator('.tab-item', { hasText: 'Files' }).click();
  const before = await closeButtons(page).count();
  await openTerminalBtn(page).click();
  // A terminal tab has a close (×) button; Files/Monitor tabs do not.
  await expect(closeButtons(page)).toHaveCount(before + 1);
}

async function gotoApp(page) {
  await page.goto('/');
  await expect(openTerminalBtn(page)).toBeVisible();
}

// Tests ----------------------------------------------------------------------

test('running tab: modal shows, cancel keeps the tab, confirm closes it', async ({ page }) => {
  await gotoApp(page);
  await openShellTab(page);

  // X on a running tab opens the custom modal (not window.confirm).
  await closeButtons(page).first().click();
  await expect(modal(page)).toBeVisible();

  // Cancel keeps the tab.
  await page.getByRole('button', { name: 'キャンセル' }).click();
  await expect(modal(page)).toBeHidden();
  await expect(closeButtons(page)).toHaveCount(1);

  // Confirm (without checking the box) closes the tab and does NOT persist skip.
  await closeButtons(page).first().click();
  await expect(modal(page)).toBeVisible();
  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(modal(page)).toBeHidden();
  await expect(closeButtons(page)).toHaveCount(0);

  const skip = await page.evaluate((k) => localStorage.getItem(k), SKIP_KEY);
  expect(skip).toBeNull();
});

test('"don\'t ask again" persists to localStorage and skips future confirms (incl. after reload)', async ({ page }) => {
  await gotoApp(page);
  await openShellTab(page);

  // Close with the checkbox ticked.
  await closeButtons(page).first().click();
  await expect(modal(page)).toBeVisible();
  await page.locator('.close-confirm-checkbox input[type="checkbox"]').check();
  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(closeButtons(page)).toHaveCount(0);

  // Preference persisted.
  const skip = await page.evaluate((k) => localStorage.getItem(k), SKIP_KEY);
  expect(skip).toBe('1');

  // A new running tab now closes WITHOUT the modal.
  await openShellTab(page);
  await closeButtons(page).first().click();
  await expect(closeButtons(page)).toHaveCount(0);
  await expect(modal(page)).toBeHidden();

  // Survives a reload.
  await page.reload();
  await expect(openTerminalBtn(page)).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), SKIP_KEY)).toBe('1');
  await openShellTab(page);
  await closeButtons(page).first().click();
  await expect(closeButtons(page)).toHaveCount(0);
  await expect(modal(page)).toBeHidden();
});

test('exited tab closes without a confirm (skip not enabled)', async ({ page }) => {
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
  await closeButtons(page).first().click();
  await expect(closeButtons(page)).toHaveCount(0);
  await expect(modal(page)).toBeHidden();
});
