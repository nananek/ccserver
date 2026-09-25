import { test, expect } from '@playwright/test';

// forceSandbox as an EFFECTIVE flag (issue #251): the launch menu must not
// offer 通常起動 when the server is going to force the launch sandboxed.
//
// The bug was that this field used to mean "what the operator literally
// wrote", so on a host with browseRoots set (and forceSandbox absent) the
// menu offered a choice the server then overrode -- and the session ran
// sandboxed while the UI said it had not. browseRoots now implies
// forceSandbox, decided once server-side, so the menu just reads the answer.
//
// forceSandboxReason is wording only; the menu never branches policy on it.
//
// /api/dirs/home is fully stubbed: the e2e webServer is shared across the
// whole run, so a per-test sandbox.config.json flip isn't possible (same
// pattern as hidden-apps.spec.js / browse-roots.spec.js).

const BASE = {
  home: '/home/tester',
  defaultApp: 'claude',
  forceSandbox: false,
  forceSandboxReason: null,
  hostname: 'e2e-sandbox-mandatory',
  showUsage: false,
  availableApps: { claude: true, opencode: false, copilot: false, codex: false },
  hiddenApps: [],
  sandboxAvailable: true,
};

async function stubDirsHome(page, body) {
  await page.route('**/api/dirs/home', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

const unsandboxedItem = (page) => page.locator('.open-menu-item', { hasText: '通常起動' });
const sandboxedItem = (page) => page.locator('.open-menu-item', { hasText: 'サンドボックスで起動' });

test('browseRoots forces a sandbox: 通常起動 is disabled and the note names browseRoots', async ({ page }) => {
  await stubDirsHome(page, { ...BASE, forceSandbox: true, forceSandboxReason: 'browseRoots' });
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();

  await expect(unsandboxedItem(page)).toHaveClass(/open-menu-item-disabled/);
  await expect(page.locator('.open-menu-note')).toContainText('browseRoots');

  // Clicking it must not move the checkmark off the sandboxed choice.
  await unsandboxedItem(page).click();
  await expect(sandboxedItem(page).locator('.open-menu-check')).toHaveText('✓');
});

test('an explicit forceSandbox gets its own wording', async ({ page }) => {
  await stubDirsHome(page, { ...BASE, forceSandbox: true, forceSandboxReason: 'config' });
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();

  await expect(unsandboxedItem(page)).toHaveClass(/open-menu-item-disabled/);
  await expect(page.locator('.open-menu-note')).toContainText('forceSandbox');
});

test('an unrestricted host still offers 通常起動', async ({ page }) => {
  await stubDirsHome(page, BASE);
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();

  await expect(unsandboxedItem(page)).not.toHaveClass(/open-menu-item-disabled/);
  await unsandboxedItem(page).click();
  await expect(unsandboxedItem(page).locator('.open-menu-check')).toHaveText('✓');
});
