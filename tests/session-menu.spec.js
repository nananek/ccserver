import { test, expect } from '@playwright/test';

const SKIP_KEY = 'ccserver-skip-close-confirm';
// popup前提: 既定はサイドバーのため、従来popup挙動の検証では明示する
// (アサーション自体は不変)。
const usePopupMode = (page) => page.addInitScript(() => {
  localStorage.setItem('ccserver-session-mode', 'popup');
});
const openTerminalBtn = (page) => page.getByRole('button', { name: 'Terminal', exact: true });
const hamburger = (page) => page.getByRole('button', { name: 'セッション一覧メニュー' });
const sessionMenu = (page) => page.locator('.session-menu');
const barTabs = (page) => page.locator('.tab-list .tab-item');

async function gotoApp(page) {
  await page.goto('/');
  await expect(openTerminalBtn(page)).toBeVisible();
}

// pty確立 (サーバー側セッション生成) を待つ。タブ行・バッジはクリック直後に
// 同期描画されるが、確立メッセージは非同期で遅れて届き、TerminalView が
// その際に term.focus() でフォーカスを奪う。メニュー操作の前に消化させる
// ことでフォーカス系アサーションのフレークを避ける
// (session-sidebar.spec.js の openShellTab と同一手法)。
async function waitForShellPrompt(page) {
  await expect(page.locator('.terminal-container .xterm-rows')).toContainText(/[$#%>]/, { timeout: 15_000 });
}

// Terminate every session in the lower ("unopened") section. The shared e2e
// server keeps sessions across tests in this file, so each test cleans up
// after itself to stay isolated.
async function terminateAllLower(page) {
  await hamburger(page).click();
  for (let i = 0; i < 15; i++) {
    const items = sessionMenu(page).locator('[data-section="unopened"] .session-menu-item');
    const before = await items.count();
    if (before === 0) break;
    page.once('dialog', (d) => d.accept());
    await items.first().locator('.session-menu-close').click();
    // Wait for the list to shrink before the next iteration.
    await expect.poll(async () => items.count(), { timeout: 10_000 }).toBeLessThan(before);
  }
  await page.keyboard.press('Escape');
}

async function closeAllUpper(page) {
  if ((await sessionMenu(page).count()) === 0) await hamburger(page).click();
  await expect(sessionMenu(page)).toBeVisible();
  for (let i = 0; i < 5; i++) {
    // Upper items only exist while tabs are open; stop when the badge is gone.
    if (await page.locator('.session-menu-count').count() === 0) break;
    const uppers = sessionMenu(page).locator('[data-section="opened"] .session-menu-item');
    await uppers.first().locator('.session-menu-close').click();
    await expect
      .poll(async () => page.locator('.session-menu-count').count(), { timeout: 10_000 })
      .toBe(0);
  }
  await page.keyboard.press('Escape').catch(() => {});
}

test('hamburger is always at the left end; shell tabs go to the vertical menu, not the tab bar', async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, '1'), SKIP_KEY);
  await usePopupMode(page);
  await gotoApp(page);

  // Hamburger is always visible at the left end of the tab bar.
  const btn = hamburger(page);
  await expect(btn).toBeVisible();
  const barBox = await page.locator('.tab-bar').boundingBox();
  const btnBox = await btn.boundingBox();
  expect(btnBox.x).toBeLessThan(barBox.x + 40);

  // Empty state (no tabs open yet and no leaked sessions).
  await btn.click();
  await expect(sessionMenu(page)).toBeVisible();
  await expect(sessionMenu(page).getByText('開いているセッション', { exact: true })).toBeVisible();
  await expect(sessionMenu(page).getByText('開いているセッションはありません')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sessionMenu(page)).toBeHidden();

  // Open a shell tab from Files.
  await page.locator('.tab-list .tab-item', { hasText: 'Files' }).click();
  const barCountBefore = await barTabs(page).count();
  await openTerminalBtn(page).click();
  // The horizontal bar must not gain a terminal tab; Files/Remote stay.
  await expect(barTabs(page)).toHaveCount(barCountBefore);
  await expect(page.locator('.session-menu-count')).toHaveText('1');
  await waitForShellPrompt(page);

  // Menu lists the opened session vertically with a running (green) state line.
  // 状態文字(connected/idle/exited)は左線の色で表現するため表示しない。下段右端はCLI名のみ。
  await btn.click();
  const items = sessionMenu(page).locator('[data-section="opened"] .session-menu-item.is-running');
  await expect(items).toHaveCount(1);
  await expect(items.first().locator('.session-menu-status .session-menu-state')).toHaveText('shell');
  await expect(items.first()).not.toContainText(/connected|idle|exited/);

  // Selecting the item activates the terminal and closes the menu.
  await items.first().locator('.session-menu-select').click();
  await expect(sessionMenu(page)).toBeHidden();
  await expect(page.locator('.terminal-container')).toBeVisible();

  // Cleanup: close the tab, then terminate the leftover server session.
  await closeAllUpper(page);
  await terminateAllLower(page);
});

test('menu supports keyboard operation: Enter selects, arrows move focus, Escape closes', async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, '1'), SKIP_KEY);
  await usePopupMode(page);
  await gotoApp(page);

  await page.locator('.tab-list .tab-item', { hasText: 'Files' }).click();
  await openTerminalBtn(page).click();
  await expect(page.locator('.session-menu-count')).toHaveText('1');
  await waitForShellPrompt(page);

  await hamburger(page).click();
  const select = sessionMenu(page).locator('[data-section="opened"] .session-menu-select').first();
  await select.focus();
  await expect(select).toBeFocused();

  // ArrowDown moves focus to the row's close button (next control in the menu).
  await page.keyboard.press('ArrowDown');
  const closeBtn = sessionMenu(page).locator('[data-section="opened"] .session-menu-close').first();
  await expect(closeBtn).toBeFocused();

  // ArrowUp moves focus back to the select button.
  await page.keyboard.press('ArrowUp');
  await expect(select).toBeFocused();

  // Enter on the select button activates the terminal and closes the menu.
  await page.keyboard.press('Enter');
  await expect(sessionMenu(page)).toBeHidden();
  await expect(page.locator('.terminal-container')).toBeVisible();

  // Cleanup: close the tab, then terminate the leftover server session.
  await closeAllUpper(page);
  await terminateAllLower(page);
});

test('menu X closes the tab; unopened running session appears below and X terminates it', async ({ page }) => {
  // Deterministic close: skip the close-confirm modal (must be set before
  // the app mounts, since App reads it into state on first render).
  await page.addInitScript((k) => localStorage.setItem(k, '1'), SKIP_KEY);
  await usePopupMode(page);
  await gotoApp(page);

  await page.locator('.tab-list .tab-item', { hasText: 'Files' }).click();
  await openTerminalBtn(page).click();
  await expect(page.locator('.session-menu-count')).toHaveText('1');
  await waitForShellPrompt(page);

  // X on the upper item closes the tab (session keeps running server-side).
  await hamburger(page).click();
  const upper = sessionMenu(page).locator('[data-section="opened"] .session-menu-item.is-running').first();
  await upper.locator('.session-menu-close').click();
  await expect(page.locator('.session-menu-count')).toHaveCount(0);

  // The still-running session now appears in the lower section.
  // The menu stays open after the X click and refreshes on tab changes,
  // so the lower section appears without reopening.
  await expect(sessionMenu(page).getByText('稼働中のセッション', { exact: true })).toBeVisible({ timeout: 10_000 });
  const before = await sessionMenu(page).locator('[data-section="unopened"] .session-menu-item').count();
  expect(before).toBeGreaterThanOrEqual(1);

  // X on a lower item terminates that server-side session (window.confirm).
  page.once('dialog', (d) => d.accept());
  await sessionMenu(page).locator('[data-section="unopened"] .session-menu-item').first().locator('.session-menu-close').click();
  await expect
    .poll(async () => sessionMenu(page).locator('[data-section="unopened"] .session-menu-item').count(), { timeout: 10_000 })
    .toBe(before - 1);

  await page.keyboard.press('Escape');
  // Cleanup any remaining leaked sessions (e.g. from retries).
  await terminateAllLower(page);
});
