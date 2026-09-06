import { test, expect } from '@playwright/test';

// A /api/usage capture keeps one HTTP connection open for up to 30s, and a
// tunnelled path (Tailscale, a phone roaming between WiFi and cellular) can
// drop it mid-flight -- the browser then rejects fetch() outright and the
// popover used to print the raw "NetworkError when attempting to fetch
// resource." at the user. UsageButton now retries once after a short backoff
// (the server's capture finishes regardless and lands in its 60s cache, so
// the retry usually hits warm data) and, if that fails too, explains the
// connection problem and offers a retry button instead of the raw string.
//
// No real CLI capture is involved: /api/usage is mocked, and a dropped tunnel
// is simulated with route.abort('failed') -- Chromium surfaces that to
// fetch() as a rejected promise, the same catch path the real failure takes.

const RETRY_DELAY_MS = 3000;   // keep in sync with useUsage.js (shared hook used by the popover and the sidebar widget)

function usageBody(app) {
  const pct = app === 'codex' ? 55 : 10;
  return JSON.stringify({
    usage: {
      plan: 'pro',
      limits: [
        { label: 'Current session', pct, resets: '5h', resetAt: Date.now() + 5 * 3600_000, windowMs: 5 * 3600_000 },
      ],
    },
    updatedAt: Date.now(),
    cached: true,
  });
}

// Returns the switchboard the test drives: flip `failing` (or list apps in
// `failApps`, or set `failNext` to a count) to make /api/usage look like a
// dropped connection, `failDelayMs` to make it die slowly the way a real
// dropped tunnel does, and read `calls` to count what each app actually sent.
function mockRoutes(page, { serverError = null } = {}) {
  const net = { failing: false, failApps: null, failNext: 0, failDelayMs: 0, calls: [] };
  page.route('**/api/dirs/home*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        home: '/home/test',
        defaultApp: 'claude',
        forceSandbox: false,
        hostname: 'test',
        showUsage: true,
        availableApps: { claude: true, codex: true },
      }),
    });
  });
  page.route('**/api/usage**', async (route) => {
    const app = new URL(route.request().url()).searchParams.get('app') || 'claude';
    net.calls.push(app);
    let fail = false;
    if (net.failApps) fail = net.failApps.includes(app);
    else if (net.failing) fail = true;
    else if (net.failNext > 0) { net.failNext -= 1; fail = true; }
    if (fail) {
      if (net.failDelayMs) await new Promise((r) => setTimeout(r, net.failDelayMs));
      await route.abort('failed');
      return;
    }
    if (serverError) {
      // Application-level failure: HTTP 200 carrying an `error` field, which
      // never reaches fetch()'s catch and so must never be retried.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ usage: null, error: serverError, updatedAt: Date.now() }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: usageBody(app) });
  });
  return net;
}

const callsFor = (net, app) => net.calls.filter((a) => a === app).length;
const pct = (page) => page.locator('.usage-btn .usage-btn-pct');
const retryBtn = (menu) => menu.locator('.usage-error button', { hasText: '再試行' });

test('a dropped connection recovers on its own, with exactly one retry', async ({ page }) => {
  const net = mockRoutes(page);
  net.failNext = 1;
  await page.goto('/');

  // No interaction at all: the badge fills in once the backoff elapses.
  await expect(pct(page)).toHaveText('10%');
  expect(callsFor(net, 'claude')).toBe(2);
});

test('two failures in a row explain the connection problem instead of showing the raw error', async ({ page }) => {
  const net = mockRoutes(page);
  net.failing = true;
  await page.goto('/');

  await page.locator('.usage-btn').click();
  const menu = page.locator('.usage-menu');
  await expect(menu).toBeVisible();

  await expect(menu.locator('.usage-error-title')).toHaveText('サーバーに接続できませんでした');
  await expect(retryBtn(menu)).toBeVisible();
  // The old raw-message wording is gone from the UI...
  await expect(menu.locator('.usage-empty')).not.toContainText('取得できませんでした');
  // ...but stays reachable behind a tap, which is how this bug got diagnosed.
  // Not behind a hover: the phone on the flaky tunnel has none.
  const raw = menu.locator('.usage-error-raw');
  await expect(raw).toBeHidden();
  await menu.locator('.usage-error-detail summary').click();
  await expect(raw).toContainText(/fetch/i);
});

test('the 再試行 button recovers once the connection is back', async ({ page }) => {
  const net = mockRoutes(page);
  net.failing = true;
  await page.goto('/');

  await page.locator('.usage-btn').click();
  const menu = page.locator('.usage-menu');
  await expect(retryBtn(menu)).toBeVisible();

  net.failing = false;
  await retryBtn(menu).click();

  await expect(menu.locator('.usage-limit')).toHaveCount(1);
  await expect(pct(page)).toHaveText('10%');
  await expect(menu.locator('.usage-error-title')).toHaveCount(0);
});

test('the 更新 button stays disabled through the backoff instead of flashing an error', async ({ page }) => {
  const net = mockRoutes(page);
  net.failing = true;
  await page.goto('/');

  await page.locator('.usage-btn').click();
  // Scope to the popover: the sidebar UsageWidget renders an identical
  // refresh button (shared UsagePanel), so a page-wide locator matches two.
  const refresh = page.locator('.usage-menu .usage-menu-header button');
  // Both the mount fetch and the popover-open fetch have failed by now.
  await expect.poll(() => callsFor(net, 'claude')).toBeGreaterThanOrEqual(2);

  // Mid-backoff: still "loading", so no error is shown and no second capture
  // can be kicked off by an impatient click.
  await page.waitForTimeout(1000);
  await expect(refresh).toHaveText('取得中…');
  await expect(refresh).toBeDisabled();
  await expect(page.locator('.usage-error-title')).toHaveCount(0);

  net.failing = false;
  await expect(refresh).toHaveText('更新');
  await expect(refresh).toBeEnabled();
  await expect(pct(page)).toHaveText('10%');
});

test('switching tabs during the backoff cancels the pending retry', async ({ page }) => {
  const net = mockRoutes(page);
  net.failApps = ['claude'];   // codex keeps working
  await page.goto('/');

  await page.locator('.usage-btn').click();
  const menu = page.locator('.usage-menu');
  await expect(menu).toBeVisible();
  await expect.poll(() => callsFor(net, 'claude')).toBeGreaterThanOrEqual(2);
  const before = callsFor(net, 'claude');

  await menu.locator('.usage-tab', { hasText: 'Codex' }).click();
  await expect(pct(page)).toHaveText('55%');

  // The abandoned claude backoff must not fire behind codex's back.
  await page.waitForTimeout(RETRY_DELAY_MS + 1000);
  expect(callsFor(net, 'claude')).toBe(before);
});

test('a server-reported error keeps its plain message and is not retried', async ({ page }) => {
  const net = mockRoutes(page, { serverError: 'Timed out reading /usage' });
  await page.goto('/');

  await page.locator('.usage-btn').click();
  const menu = page.locator('.usage-menu');
  await expect(menu.locator('.usage-empty')).toHaveText('取得できませんでした: Timed out reading /usage');
  await expect(retryBtn(menu)).toHaveCount(0);

  // Mount + popover open, and no retry on top: HTTP 200 is a real answer.
  await page.waitForTimeout(RETRY_DELAY_MS + 500);
  expect(callsFor(net, 'claude')).toBe(2);
});

test('a failure a newer load already replaced does not retry over it', async ({ page }) => {
  const net = mockRoutes(page);
  net.failNext = 1;
  net.failDelayMs = 2000;   // a dropped tunnel rejects late, not instantly
  await page.goto('/');

  // The popover is opened while the badge's mount fetch is still hanging, and
  // its own fetch succeeds -- so the hanging one is stale by the time it dies.
  await page.locator('.usage-btn').click();
  await expect(pct(page)).toHaveText('10%');
  expect(callsFor(net, 'claude')).toBe(2);

  // That stale failure lands at ~2s; a backoff scheduled from it would fire at
  // ~5s and drag the popover back into 取得中… over data already on screen.
  await page.waitForTimeout(RETRY_DELAY_MS + 2500);
  expect(callsFor(net, 'claude')).toBe(2);
  await expect(page.locator('.usage-menu .usage-menu-header button')).toHaveText('更新');
});
