import { test, expect } from '@playwright/test';

// Duplicate-launch guard (issue #132): opening a directory that already has a
// live (non-shell, non-meta-agent) session must warn before spawning a
// second one, since two agent processes racing over the same cwd is exactly
// the footgun this feature exists to catch.
//
// The check hits GET /api/sessions before anything is actually launched, so
// it's exercised here entirely by stubbing that endpoint -- no real
// claude/opencode CLI (nor bwrap) needs to be installed on the runner.
//
// The toolbar's app-picker "起動" button is disabled whenever the picked app
// isn't actually installed/visible on the server (plain CI runners have
// neither claude nor opencode -- see availableApps in
// DirectoryBrowser.jsx's effectiveAppHidden), which would otherwise make
// every test here hang. neutralizeAppAvailability() patches the one
// /api/dirs/home response field that drives that gate so the button stays
// enabled regardless of what's actually installed on the runner -- the
// duplicate check itself never depends on the launch actually succeeding.

const DUP_CWD = '/tmp/ccserver-e2e-dup-session';

async function neutralizeAppAvailability(page) {
  await page.route('**/api/dirs/home', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.availableApps = null;
    json.hiddenApps = [];
    await route.fulfill({ response, json });
  });
}

function stubDuplicateSession(page, cwd, overrides = {}) {
  return page.route('**/api/sessions', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessions: [{
          id: 'e2e-dup-session',
          cwd,
          connected: true,
          viewers: 1,
          shell: false,
          sandbox: false,
          sandboxOpts: null,
          app: 'claude',
          model: null,
          permissionMode: 'standard',
          groupId: null,
          groupRole: null,
          isMetaAgent: false,
          customLabel: null,
          ...overrides,
        }],
      }),
    });
  });
}

// Frame-capture helper (same shape as sandbox-resume.spec.js / launch-modal's
// initFrames): records every JSON frame any page websocket sends, newest
// last.
function sentFrames(page) {
  const frames = [];
  page.on('websocket', (ws) => {
    ws.on('framesent', (e) => {
      try {
        frames.push(JSON.parse(e.payload));
      } catch { /* not JSON */ }
    });
  });
  return frames;
}

async function gotoWithFixedDir(page, cwd) {
  await neutralizeAppAvailability(page);
  await page.addInitScript((dir) => {
    localStorage.setItem('ccserver-last-dir', dir);
  }, cwd);
  await page.goto('/');
  await expect(page.locator('.open-split-caret')).toBeVisible();
}

async function launchViaMenu(page, appLabel = 'Claude Code') {
  await page.locator('.open-split-caret').click();
  await page.locator('.open-menu-item', { hasText: appLabel }).click();
  const launchBtn = page.locator('.resume-dialog .btn-primary', { hasText: '起動' });
  await expect(launchBtn).toBeEnabled();
  await launchBtn.click();
}

test('opening a directory with a live session shows the duplicate-session prompt', async ({ page }) => {
  await stubDuplicateSession(page, DUP_CWD);
  const frames = sentFrames(page);
  await gotoWithFixedDir(page, DUP_CWD);

  await launchViaMenu(page);

  await expect(page.getByText('同じディレクトリで既にセッションが起動しています')).toBeVisible();
  await expect(page.locator('.resume-dialog .resume-session-id')).toHaveText(DUP_CWD);
  await expect(page.getByRole('button', { name: '既存セッションを開く' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'そのまま新規起動する' })).toBeVisible();

  // Nothing launched yet -- the prompt intercepts before any ws traffic.
  await page.waitForTimeout(500);
  expect(frames.length).toBe(0);
});

test('"既存セッションを開く" attaches to the existing session instead of launching a new one', async ({ page }) => {
  await stubDuplicateSession(page, DUP_CWD);
  const frames = sentFrames(page);
  await gotoWithFixedDir(page, DUP_CWD);

  await launchViaMenu(page);
  await page.getByRole('button', { name: '既存セッションを開く' }).click();

  await expect(page.locator('.resume-overlay')).toHaveCount(0);
  await expect.poll(() => frames.length).toBeGreaterThan(0);
  // The very first frame the new tab's websocket sends must be an attach to
  // the duplicate's session id -- never a fresh `init` (which would spawn a
  // second agent process in the same directory). The stubbed id isn't a real
  // server-side session, so a SESSION_NOT_FOUND re-init can legitimately
  // follow afterwards (TerminalView's existing dead-session fallback,
  // covered by sandbox-resume.spec.js) -- only the first frame is asserted.
  expect(frames[0]).toMatchObject({ type: 'attach', sessionId: 'e2e-dup-session' });
});

test('"そのまま新規起動する" proceeds with the normal launch', async ({ page }) => {
  await stubDuplicateSession(page, DUP_CWD);
  const frames = sentFrames(page);
  await gotoWithFixedDir(page, DUP_CWD);

  await launchViaMenu(page);
  await page.getByRole('button', { name: 'そのまま新規起動する' }).click();

  await expect(page.locator('.resume-overlay')).toHaveCount(0);
  await expect.poll(() => frames.some((f) => f.type === 'init')).toBe(true);
  const init = frames.find((f) => f.type === 'init');
  expect(init.cwd).toBe(DUP_CWD);
});

test('cancelling the duplicate-session prompt (button or overlay click) launches nothing', async ({ page }) => {
  await stubDuplicateSession(page, DUP_CWD);
  const frames = sentFrames(page);
  await gotoWithFixedDir(page, DUP_CWD);

  await launchViaMenu(page);
  await page.getByRole('button', { name: 'キャンセル' }).click();
  await expect(page.locator('.resume-overlay')).toHaveCount(0);

  await launchViaMenu(page);
  await page.locator('.resume-overlay').click({ position: { x: 10, y: 10 } });
  await expect(page.locator('.resume-overlay')).toHaveCount(0);

  await page.waitForTimeout(500);
  expect(frames.length).toBe(0);
});

test('a live combo-group member in the same directory does not trigger the prompt', async ({ page }) => {
  // Group members are only ever meant to be reached through the group's own
  // sub-tab UI (same rule fetchServerSessions applies) -- the duplicate
  // check must ignore them entirely, not offer to attach a bare terminal tab
  // directly onto a live group worker/orchestrator.
  await stubDuplicateSession(page, DUP_CWD, { groupId: 'e2e-group', groupRole: 'workerA' });
  const frames = sentFrames(page);
  await gotoWithFixedDir(page, DUP_CWD);

  await launchViaMenu(page);
  await expect(page.locator('.resume-overlay')).toHaveCount(0);
  await expect.poll(() => frames.some((f) => f.type === 'init')).toBe(true);
});

test('a directory with no live session skips the prompt entirely', async ({ page }) => {
  // No stub: the real (empty, fresh test server) /api/sessions applies.
  const frames = sentFrames(page);
  await gotoWithFixedDir(page, '/tmp/ccserver-e2e-no-dup');

  await launchViaMenu(page);
  await expect(page.locator('.resume-overlay')).toHaveCount(0);
  await expect.poll(() => frames.some((f) => f.type === 'init')).toBe(true);
});
