import { test, expect } from '@playwright/test';

// browseRoots (issue #189) client recovery: an operator narrowing browseRoots
// after a browser has remembered (or a tab restored) a path outside the new
// roots must not leave the directory browser stuck on a 403 -- the listing
// falls back to the server's initialBrowsePath, and the Home button points
// there too (home() itself may sit outside the allowed roots).
//
// /api/dirs/home and /api/dirs are fully stubbed: the e2e webServer is
// shared across the whole run, so a per-test sandbox.config.json flip isn't
// possible there (same pattern as hidden-apps.spec.js).

const HOME_RESPONSE = {
  home: '/home/tester',
  defaultApp: 'claude',
  forceSandbox: false,
  hostname: 'e2e-browse-roots',
  showUsage: false,
  availableApps: { claude: true, opencode: false, copilot: false, codex: false },
  hiddenApps: [],
  sandboxAvailable: true,
  browseRoots: ['/srv/projects'],
  browseRootsInvalid: false,
  initialBrowsePath: '/srv/projects',
};

function listing(current, dirs) {
  return { current, parent: current === '/srv/projects' ? null : '/srv/projects', dirs, files: [] };
}

async function stubServer(page) {
  await page.route('**/api/dirs/home', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HOME_RESPONSE) });
  });
  await page.route('**/api/dirs?**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get('path');
    if (path === '/srv/projects') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(listing('/srv/projects', [{ name: 'app1', path: '/srv/projects/app1' }])),
      });
      return;
    }
    if (path === '/srv/projects/app1') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(listing('/srv/projects/app1', [{ name: 'sub', path: '/srv/projects/app1/sub' }])),
      });
      return;
    }
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Path is outside the allowed browseRoots' }),
    });
  });
}

test('a remembered path outside browseRoots recovers to initialBrowsePath, and Home returns there', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('ccserver-last-dir', '/etc');
  });
  await stubServer(page);

  await page.goto('/');
  // The stale /etc listing 403s; the browser must recover to the allowed
  // start instead of showing an empty error view.
  await expect(page.locator('.dir-item', { hasText: 'app1' })).toBeVisible();
  await expect(page.locator('.error')).toHaveCount(0);

  // Walk one level down, then use Home (not Up) to get back.
  await page.locator('.dir-item', { hasText: 'app1' }).click();
  await expect(page.locator('.dir-item', { hasText: 'sub' })).toBeVisible();
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.locator('.dir-item', { hasText: 'app1' })).toBeVisible();
});

test('an unset remembered path starts at initialBrowsePath (never home(), which may be outside the roots)', async ({ page }) => {
  await stubServer(page);
  await page.goto('/');
  await expect(page.locator('.dir-item', { hasText: 'app1' })).toBeVisible();
});
