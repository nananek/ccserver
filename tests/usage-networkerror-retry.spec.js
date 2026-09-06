import { test, expect } from '@playwright/test';

// A /api/usage capture keeps one HTTP connection open for up to 30s, and a
// tunnelled path (Tailscale, a phone roaming between WiFi and cellular) can
// drop it mid-flight -- the browser then rejects fetch() outright and the
// sidebar UsageWidget used to print the raw "NetworkError when attempting to
// fetch resource." at the user. It now retries once after a short backoff
// (the server's capture finishes regardless and lands in its 60s cache, so
// the retry usually hits warm data) and, if that fails too, explains the
// connection problem and offers a retry button instead of the raw string.
//
// No real CLI capture is involved: /api/usage is mocked, and a dropped tunnel
// is simulated with route.abort('failed') -- Chromium surfaces that to
// fetch() as a rejected promise, the same catch path the real failure takes.

const RETRY_DELAY_MS = 3000;   // keep in sync with useUsage.js

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
const widget = (page) => page.locator('.usage-widget');
const pct = (page) => widget(page).locator('.usage-limit-pct');
const retryBtn = (scope) => scope.locator('.usage-error button', { hasText: '再試行' });

test('a dropped connection recovers on its own, with exactly one retry', async ({ page }) => {
  const net = mockRoutes(page);
  net.failNext = 1;
  await page.goto('/');

  // No interaction at all: the widget fills in once the backoff elapses.
  await expect(pct(page)).toHaveText('10%');
  expect(callsFor(net, 'claude')).toBe(2);
});

test('two failures in a row explain the connection problem instead of showing the raw error', async ({ page }) => {
  const net = mockRoutes(page);
  net.failing = true;
  await page.goto('/');
  const w = widget(page);

  await expect(w.locator('.usage-error-title')).toHaveText('サーバーに接続できませんでした', { timeout: RETRY_DELAY_MS * 2 + 5000 });
  await expect(retryBtn(w)).toBeVisible();
  // The old raw-message wording is gone from the UI...
  await expect(w.locator('.usage-empty')).not.toContainText('取得できませんでした');
  // ...but stays reachable behind a tap, which is how this bug got diagnosed.
  // Not behind a hover: the phone on the flaky tunnel has none.
  const raw = w.locator('.usage-error-raw');
  await expect(raw).toBeHidden();
  await w.locator('.usage-error-detail summary').click();
  await expect(raw).toContainText(/fetch/i);
});

test('the 再試行 button recovers once the connection is back', async ({ page }) => {
  const net = mockRoutes(page);
  net.failing = true;
  await page.goto('/');

  const w = widget(page);
  await expect(retryBtn(w)).toBeVisible({ timeout: RETRY_DELAY_MS * 2 + 5000 });

  net.failing = false;
  await retryBtn(w).click();

  await expect(w.locator('.usage-limit')).toHaveCount(1);
  await expect(pct(page)).toHaveText('10%');
  await expect(w.locator('.usage-error-title')).toHaveCount(0);
});

test('the 更新 button stays disabled through the backoff instead of flashing an error', async ({ page }) => {
  const net = mockRoutes(page);
  net.failing = true;
  await page.goto('/');

  const refresh = page.locator('.usage-widget .usage-menu-header button');
  await expect.poll(() => callsFor(net, 'claude')).toBeGreaterThanOrEqual(1);

  // Mid-backoff (well inside the 3s window from the mount fetch's failure):
  // still "loading", so no error is shown and no second capture can be
  // kicked off by an impatient click.
  await page.waitForTimeout(1000);
  await expect(refresh).toHaveText('取得中…');
  await expect(refresh).toBeDisabled();
  await expect(page.locator('.usage-error-title')).toHaveCount(0);

  net.failing = false;
  await expect(refresh).toHaveText('更新', { timeout: RETRY_DELAY_MS + 5000 });
  await expect(refresh).toBeEnabled();
  await expect(pct(page)).toHaveText('10%');
});

test('switching tabs during the backoff cancels the pending retry', async ({ page }) => {
  const net = mockRoutes(page);
  net.failApps = ['claude'];   // codex keeps working
  await page.goto('/');

  await expect.poll(() => callsFor(net, 'claude')).toBeGreaterThanOrEqual(1);
  const before = callsFor(net, 'claude');

  await widget(page).locator('.usage-tab', { hasText: 'Codex' }).click();
  await expect(pct(page)).toHaveText('55%');

  // The abandoned claude backoff must not fire behind codex's back.
  await page.waitForTimeout(RETRY_DELAY_MS + 1000);
  expect(callsFor(net, 'claude')).toBe(before);
});

test('a server-reported error keeps its plain message and is not retried', async ({ page }) => {
  const net = mockRoutes(page, { serverError: 'Timed out reading /usage' });
  await page.goto('/');

  const w = widget(page);
  await expect(w.locator('.usage-empty')).toHaveText('取得できませんでした: Timed out reading /usage');
  await expect(retryBtn(w)).toHaveCount(0);

  // Only the mount fetch, and no retry on top: HTTP 200 is a real answer.
  await page.waitForTimeout(RETRY_DELAY_MS + 500);
  expect(callsFor(net, 'claude')).toBe(1);
});
