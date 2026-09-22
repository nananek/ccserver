import { test, expect } from '@playwright/test';

// No sandbox backend on the server host (/api/dirs/home's sandboxAvailable):
// the sandbox choice (and combo mode, which always requires it) must be
// unselectable instead of failing at launch time. Missing field = older
// server: everything stays enabled (same fallback as availableApps).
//
// /api/dirs/home is fully stubbed so this suite is independent of the
// machine running it -- same pattern as hidden-apps.spec.js.

const HOME_RESPONSE = {
  home: '/home/tester',
  defaultApp: 'claude',
  forceSandbox: false,
  hostname: 'e2e-no-sandbox',
  showUsage: true,
  availableApps: { claude: true, opencode: true, copilot: true, codex: true },
  hiddenApps: [],
  sandboxAvailable: false,
};

async function stubDirsHome(page, body = HOME_RESPONSE) {
  await page.route('**/api/dirs/home', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test('sandbox choice is disabled and a remembered sandbox default is corrected', async ({ page }) => {
  await stubDirsHome(page);
  // A stale 'prefer sandbox' memory from a host that had a backend must not
  // survive: the fetch reconciliation forces 通常起動.
  await page.addInitScript(() => localStorage.setItem('ccserver-sandbox-default', '1'));
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();

  const sandboxItem = page.locator('.open-menu-item', { hasText: 'サンドボックスで起動' });
  await expect(sandboxItem).toHaveClass(/open-menu-item-disabled/);
  await expect(sandboxItem).toHaveAttribute('title', /サンドボックス/);

  // Clicking the disabled choice must not check it -- 通常起動 stays checked.
  await sandboxItem.click();
  const normalItem = page.locator('.open-menu-item', { hasText: '通常起動' });
  await expect(normalItem.locator('.open-menu-check')).toHaveText('✓');
  await expect(sandboxItem.locator('.open-menu-check')).toHaveText('');

  // The explanatory note names the cause (scoped to the modal: the same
  // message also shows in the browser header box).
  await expect(page.locator('.resume-dialog .open-menu-note', { hasText: 'サンドボックス機能が利用できないため' })).toBeVisible();
});

test('toolbar quick-launch drops the lock icon when the sandbox is unavailable', async ({ page }) => {
  await stubDirsHome(page);
  await page.addInitScript(() => localStorage.setItem('ccserver-sandbox-default', '1'));
  await page.goto('/');
  const main = page.locator('.open-split-main');
  await expect(main).not.toContainText('🔒');
  await expect(main).toHaveAttribute('title', '通常起動');
});

test('combo mode is disabled when the sandbox is unavailable', async ({ page }) => {
  await stubDirsHome(page);
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  const comboBtn = page.locator('.resume-dialog .launch-mode-btn', { hasText: 'コンボ起動' });
  await expect(comboBtn).toBeDisabled();
  await comboBtn.click({ force: true });
  // Still in single mode: the combo-only launch button must not appear.
  await expect(page.locator('.resume-dialog .btn-primary', { hasText: 'コンボ起動' })).toHaveCount(0);
  await expect(page.locator('.launch-mode-btn.active')).toHaveText('通常起動');
});

test('forceSandbox without a backend shows a warning instead of a dead locked toggle', async ({ page }) => {
  await stubDirsHome(page, { ...HOME_RESPONSE, forceSandbox: true });
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  await expect(page.locator('.resume-dialog .open-menu-note', { hasText: 'サンドボックス機能を利用できません' })).toBeVisible();
  // The toggle stays locked on sandbox (no misleading check on 通常起動).
  const sandboxItem = page.locator('.open-menu-item', { hasText: 'サンドボックスで起動' });
  await expect(sandboxItem.locator('.open-menu-check')).toHaveText('✓');
});

test('browser header shows a warning box under the subtitle when the sandbox is unavailable', async ({ page }) => {
  await stubDirsHome(page);
  await page.goto('/');
  const banner = page.locator('.directory-warning-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('role', 'alert');
  await expect(banner).toContainText('サンドボックス起動・コンボ起動はできません');
  await expect(banner).not.toHaveClass(/is-error/);
});

test('browser header shows an error box when forceSandbox contradicts the missing backend', async ({ page }) => {
  await stubDirsHome(page, { ...HOME_RESPONSE, forceSandbox: true });
  await page.goto('/');
  const banner = page.locator('.directory-warning-banner.is-error');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('サンドボックス機能を利用できません');
});

test('no header box while the capability is unknown or present', async ({ page }) => {
  const { sandboxAvailable: _dropped, ...legacy } = HOME_RESPONSE;
  await stubDirsHome(page, legacy);
  await page.goto('/');
  await expect(page.locator('.directory-warning-banner')).toHaveCount(0);

  // Present (backend installed): no box and the sandbox choice works.
  await stubDirsHome(page, { ...HOME_RESPONSE, sandboxAvailable: true });
  await page.reload();
  await expect(page.locator('.directory-warning-banner')).toHaveCount(0);
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  const sandboxItem = page.locator('.open-menu-item', { hasText: 'サンドボックスで起動' });
  await expect(sandboxItem).not.toHaveClass(/open-menu-item-disabled/);
});

test('double-click launch is also blocked when no launch can succeed', async ({ page }) => {
  await stubDirsHome(page, { ...HOME_RESPONSE, forceSandbox: true });
  // The browser UI never uses POST /api/sessions for directory opens: it
  // creates a local tab (App.openTerminalTab) and the new TerminalView sends
  // a WS `init` to /ws/terminal. Intercepting POST would pass vacuously even
  // with the launchesBlocked guard removed, so assert on the real effects:
  // no terminal tab opens and no WS init is sent.
  const wsInits = [];
  page.on('websocket', (ws) => {
    ws.on('framesent', (frame) => {
      try {
        const msg = JSON.parse(frame.payload);
        if (msg?.type === 'init') wsInits.push(msg);
      } catch { /* non-JSON control frames */ }
    });
  });
  await page.goto('/');
  await expect(page.locator('.dir-item').first()).toBeVisible();
  // Double-clicking a directory must not attempt a doomed launch.
  await page.locator('.dir-item').first().dblclick();
  await page.waitForTimeout(500);
  await expect(page.locator('.terminal-container')).toHaveCount(0);
  expect(wsInits).toHaveLength(0);
});

test('forceSandbox without a backend disables the launch buttons', async ({ page }) => {
  await stubDirsHome(page, { ...HOME_RESPONSE, forceSandbox: true });
  await page.goto('/');
  // Toolbar quick-launch and Terminal buttons: nothing can succeed.
  await expect(page.locator('.open-split-main')).toBeDisabled();
  await expect(page.locator('.toolbar-launch-group .launch-btn', { hasText: 'Terminal' })).toBeDisabled();
  // In-modal single-launch button too.
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  await expect(page.locator('.resume-dialog .btn-primary', { hasText: '起動' })).toBeDisabled();
});

test('missing sandboxAvailable (older server) keeps the sandbox choice enabled', async ({ page }) => {
  const { sandboxAvailable: _dropped, ...legacy } = HOME_RESPONSE;
  await stubDirsHome(page, legacy);
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  const sandboxItem = page.locator('.open-menu-item', { hasText: 'サンドボックスで起動' });
  await expect(sandboxItem).not.toHaveClass(/open-menu-item-disabled/);
  await sandboxItem.click();
  await expect(sandboxItem.locator('.open-menu-check')).toHaveText('✓');
});
