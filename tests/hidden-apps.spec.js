import { test, expect } from '@playwright/test';

// hiddenApps (sandbox.config.json, issue #105): agent CLI ids the operator
// hasn't contracted for. Unlike an app the server just can't find (still
// shown greyed out with a "サーバーに未インストール" tooltip), a hidden app
// must be removed ENTIRELY -- no partial/greyed hide mode -- from all 5
// launch surfaces: the single-launch modal, the combo role pickers (workerA/
// workerB/orchestrator), the worker preset management dialog, the
// meta-agent launch dialog, and the Usage button's app tabs.
//
// /api/dirs/home is fully stubbed (metaAgentEnabled included) so this suite
// is independent of what's actually installed/configured on the machine
// running it -- same pattern as meta-agent-launch.spec.js, whose comment
// explains why: the e2e webServer is shared across the whole run, so a
// per-test sandbox.config.json flip isn't possible there.

const META_AGENT_DIR_STUB = '/home/tester/.local/share/ccserver-sandbox/meta-agent';

const HOME_RESPONSE = {
  home: '/home/tester',
  defaultApp: 'claude',
  forceSandbox: false,
  hostname: 'e2e-hidden-apps',
  showUsage: true,
  availableApps: { claude: true, opencode: true, copilot: true, codex: true },
  hiddenApps: ['copilot', 'codex'],
  metaAgentEnabled: true,
  metaAgentDir: META_AGENT_DIR_STUB,
};

async function stubDirsHome(page, body = HOME_RESPONSE) {
  await page.route('**/api/dirs/home', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test('single-launch modal removes copilot and codex entirely, keeps claude/opencode', async ({ page }) => {
  await stubDirsHome(page);
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  await expect(page.locator('.open-menu-item', { hasText: 'Claude Code' })).toHaveCount(1);
  await expect(page.locator('.open-menu-item', { hasText: 'opencode' })).toHaveCount(1);
  await expect(page.locator('.open-menu-item', { hasText: 'GitHub Copilot' })).toHaveCount(0);
  await expect(page.locator('.open-menu-item', { hasText: 'OpenAI Codex' })).toHaveCount(0);
});

test('combo role pickers (workerA/workerB/orchestrator) drop codex, keep claude/opencode', async ({ page }) => {
  await stubDirsHome(page);
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  await page.locator('.resume-dialog .launch-mode-btn', { hasText: 'コンボ起動' }).click();
  // 3 roles x (claude, opencode) = 6 buttons total; codex must not appear at all.
  await expect(page.locator('.open-menu-app-btn', { hasText: 'Claude Code' })).toHaveCount(3);
  await expect(page.locator('.open-menu-app-btn', { hasText: 'opencode' })).toHaveCount(3);
  await expect(page.locator('.open-menu-app-btn', { hasText: 'OpenAI Codex' })).toHaveCount(0);
});

test('worker preset management dialog drops codex from the app picker', async ({ page }) => {
  await stubDirsHome(page);
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  await page.locator('.resume-dialog .launch-mode-btn', { hasText: 'コンボ起動' }).click();
  // Opening combo mode triggers the one-time preset fetch against the real
  // (live, e2e) worker-presets API -- no stub needed, only the "ready" state
  // (and therefore the 管理 button) has to show up.
  await expect(page.locator('.open-menu-label', { hasText: 'Worker プリセット' })).toBeVisible();
  await page.getByRole('button', { name: 'プリセット管理' }).click();
  const dialog = page.locator('.preset-manage-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.open-menu-app-btn', { hasText: 'Claude Code' })).toHaveCount(1);
  await expect(dialog.locator('.open-menu-app-btn', { hasText: 'opencode' })).toHaveCount(1);
  await expect(dialog.locator('.open-menu-app-btn', { hasText: 'OpenAI Codex' })).toHaveCount(0);
});

test('meta-agent launch dialog drops codex from the app picker', async ({ page }) => {
  await stubDirsHome(page);
  await page.goto('/');
  const metaBtn = page.locator('.meta-launch-btn');
  await expect(metaBtn).toBeEnabled();
  await metaBtn.click();
  const dialog = page.locator('.resume-dialog', { hasText: 'メタエージェントを起動' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.open-menu-item', { hasText: 'Claude Code' })).toHaveCount(1);
  await expect(dialog.locator('.open-menu-item', { hasText: 'opencode' })).toHaveCount(1);
  await expect(dialog.locator('.open-menu-item', { hasText: 'OpenAI Codex' })).toHaveCount(0);
});

test('Usage button drops the codex tab entirely when codex is hidden', async ({ page }) => {
  await stubDirsHome(page);
  await page.route('**/api/usage**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ usage: { plan: 'pro', limits: [] }, updatedAt: Date.now() }),
    });
  });
  await page.goto('/');
  const btn = page.locator('.usage-btn');
  await expect(btn).toBeVisible();
  await expect(btn.locator('.usage-btn-app')).toHaveText('(claude)');
  await btn.click();
  await expect(page.locator('.usage-menu')).toBeVisible();
  // The tab switcher only renders when BOTH claude and codex are selectable
  // (see UsageButton's claudeAvailable && codexAvailable) -- with codex
  // hidden, only one app is left, so it must be entirely absent.
  await expect(page.locator('.usage-tabs')).toHaveCount(0);
  await expect(page.locator('.usage-tab', { hasText: 'Codex' })).toHaveCount(0);
});
