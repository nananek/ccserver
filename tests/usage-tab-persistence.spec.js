import { test, expect } from '@playwright/test';

// The sidebar UsageWidget must remember the app the user last picked across
// page loads (localStorage `ccserver-usage-app`) instead of resetting to the
// active terminal tab's app every time an OpenCode (or any) terminal is
// opened/activated. Real CLI capture is not needed: both server endpoints are
// mocked with distinct fixture percentages (claude=10, codex=55, opencode=77)
// so the active tab label and pct prove which app's data is on screen.

function mockRoutes(page, { defaultApp = 'claude', availableApps = { claude: true, codex: true }, usageDelayApps = [] } = {}) {
  page.route('**/api/dirs/home*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        home: '/home/test',
        defaultApp,
        forceSandbox: false,
        hostname: 'test',
        showUsage: true,
        availableApps,
      }),
    });
  });
  page.route('**/api/usage**', async (route) => {
    const app = new URL(route.request().url()).searchParams.get('app') || 'claude';
    if (usageDelayApps.includes(app)) await new Promise((r) => setTimeout(r, 300));
    const pct = app === 'codex' ? 55 : app === 'opencode' ? 77 : 10;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        usage: {
          plan: 'pro',
          limits: [
            { label: 'Current session', pct, resets: '5h', resetAt: Date.now() + 5 * 3600_000, windowMs: 5 * 3600_000 },
            { label: 'Weekly limit', pct: Math.min(90, pct + 20), resets: '3d', resetAt: Date.now() + 3 * 86400_000, windowMs: 7 * 86400_000 },
          ],
        },
        updatedAt: Date.now(),
        cached: true,
      }),
    });
  });
}

const widget = () => page.locator('.usage-widget');
const activeTab = () => widget().locator('.usage-tab.active');
// The tab switcher (and so .usage-tab.active) only renders when more than
// one app is selectable; with just one, the header label is the only signal
// of which app is showing.
const headerLabel = () => widget().locator('.usage-menu-header span');
const pct = () => widget().locator('.usage-limit-pct').first();
let page;

test.beforeEach(async ({ page: p }) => {
  page = p;
});

test('a saved codex choice survives opening the app with a claude defaultApp', async () => {
  // Regression for the old behavior: defaultApp:'claude' (e.g. active OpenCode
  // tab) must not override the persisted codex selection.
  mockRoutes(page, { defaultApp: 'claude' });
  await page.addInitScript(() => {
    window.localStorage.setItem('ccserver-usage-app', 'codex');
  });
  await page.goto('/');

  await expect(activeTab()).toHaveText('Codex');
  await expect(pct()).toHaveText('55%');
});

test('the choice made in the widget persists across a reload', async () => {
  mockRoutes(page);
  await page.goto('/');

  await expect(activeTab()).toHaveText('Claude');
  await widget().locator('.usage-tab', { hasText: 'Codex' }).click();
  await expect(activeTab()).toHaveText('Codex');

  // Simulates closing/reopening or refocusing the browser on an OpenCode tab:
  // the same document reloads, but the saved pick must still win.
  await page.reload();

  await expect(activeTab()).toHaveText('Codex');
  await expect(pct()).toHaveText('55%');
});

test('a saved claude choice falls back to codex when claude is unavailable', async () => {
  mockRoutes(page, { availableApps: { claude: false, codex: true } });
  await page.addInitScript(() => {
    window.localStorage.setItem('ccserver-usage-app', 'claude');
  });
  await page.goto('/');

  // Only codex is selectable, so no tab switcher renders -- the header
  // label is the only way to tell which app is showing.
  await expect(headerLabel()).toHaveText('Codex 使用量');
  await expect(pct()).toHaveText('55%');
});

test('a saved codex choice falls back to claude when codex is unavailable', async () => {
  mockRoutes(page, { availableApps: { claude: true, codex: false } });
  await page.addInitScript(() => {
    window.localStorage.setItem('ccserver-usage-app', 'codex');
  });
  await page.goto('/');

  await expect(headerLabel()).toHaveText('Claude 使用量');
  await expect(pct()).toHaveText('10%');
});

test('a saved opencode choice falls back to the defaultApp seed without Go support', async () => {
  mockRoutes(page, { defaultApp: 'claude' });
  await page.addInitScript(() => {
    window.localStorage.setItem('ccserver-usage-app', 'opencode');
  });
  await page.goto('/');

  await expect(activeTab()).toHaveText('Claude');
});

test('a saved opencode choice survives a reload when Go is available', async () => {
  mockRoutes(page, { availableApps: { claude: true, codex: true, opencodeGo: true } });
  await page.addInitScript(() => {
    window.localStorage.setItem('ccserver-usage-app', 'opencode');
  });
  await page.goto('/');

  await expect(activeTab()).toHaveText('OpenCode');
});

test('a delayed response for a since-abandoned tab does not overwrite the current tab', async () => {
  // opencode's fetch resolves last, well after the user has already moved on
  // to codex -- reproduces the external-network-latency race #8 describes.
  mockRoutes(page, { availableApps: { claude: true, codex: true, opencodeGo: true }, usageDelayApps: ['opencode'] });
  await page.goto('/');

  // Switch to opencode (kicks off its slow fetch), then immediately away to
  // codex (whose own fetch resolves quickly) before opencode's response lands.
  await widget().locator('.usage-tab', { hasText: 'OpenCode' }).click();
  await widget().locator('.usage-tab', { hasText: 'Codex' }).click();
  await expect(activeTab()).toHaveText('Codex');
  await expect(pct()).toHaveText('55%');

  // Give opencode's delayed response time to arrive; it must be dropped, not
  // shown under the still-active codex tab.
  await page.waitForTimeout(400);
  await expect(activeTab()).toHaveText('Codex');
  await expect(pct()).toHaveText('55%');
});
