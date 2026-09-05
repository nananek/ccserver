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

test('combo launch is disabled (not silently sent) when every combo-eligible app is hidden', async ({ page }) => {
  // Edge case found in self-review: an operator who only contracted GitHub
  // Copilot (which can't join combos) hides claude/opencode/codex entirely.
  // The role pickers correctly render zero buttons for each role, but
  // without a launch-time guard, comboApps state kept its stale default
  // (claude/opencode/claude) and コンボ起動 would silently launch those
  // hidden apps -- a picker-vs-launch-value mismatch that defeated the hide.
  await stubDirsHome(page, { ...HOME_RESPONSE, hiddenApps: ['claude', 'opencode', 'codex'] });
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  await page.locator('.resume-dialog .launch-mode-btn', { hasText: 'コンボ起動' }).click();
  await expect(page.locator('.open-menu-app-btn')).toHaveCount(0);
  const launchBtn = page.locator('.resume-actions button.btn-primary', { hasText: 'コンボ起動' });
  await expect(launchBtn).toBeDisabled();
});

test('toolbar quick-launch button is disabled (not silently sent) when the remembered default app is hidden with nothing to fall back to', async ({ page }) => {
  // Second self-review pass edge case: unlike the picker items (which block
  // their own click via chooseApp), the toolbar's quick-launch button and
  // the in-modal single-launch 起動 button fire onOpen directly with
  // whatever appDefault currently holds. The reconciliation effect corrects
  // a stale/hidden default to the first available app -- but only when one
  // exists; hiding every app at once leaves it stuck on the hidden value,
  // and without a launch-time guard this button would silently launch it.
  await page.addInitScript(() => {
    localStorage.setItem('ccserver-app-default', 'claude');
  });
  await stubDirsHome(page, { ...HOME_RESPONSE, hiddenApps: ['claude', 'opencode', 'copilot', 'codex', 'commandcode'] });
  await page.goto('/');
  await expect(page.locator('.open-split-main')).toBeDisabled();
});

test('preset-add select is disabled (not a silent no-op) when every combo-eligible app is hidden', async ({ page }) => {
  // Same edge case as the コンボ起動 button guard above, applied to the
  // preset picker itself: picking a preset when nothing is combo-eligible
  // used to just do nothing at all, with no error or tooltip.
  await stubDirsHome(page, { ...HOME_RESPONSE, hiddenApps: ['claude', 'opencode', 'codex'] });
  await page.goto('/');
  await page.getByRole('button', { name: '起動方法を選択' }).click();
  await page.locator('.resume-dialog .launch-mode-btn', { hasText: 'コンボ起動' }).click();
  const select = page.locator('.open-menu-preset-select');
  await expect(select).toBeVisible();
  await expect(select).toBeDisabled();
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

test('meta-agent launch is disabled (not silently sent) when the remembered app was hidden after the fact', async ({ page }) => {
  // Second self-review pass edge case: MetaLaunchDialog persists its app pick
  // under its own localStorage key (independent of the single-launch
  // ccserver-app-default key) and reloads it on every dialog open with no
  // hiddenApps awareness at all. If the operator hides an app the user had
  // previously chosen here, the picker correctly renders no checked button,
  // but without a launch-time guard 統括エージェントを起動 would still
  // silently launch that hidden app -- the same picker-vs-launch-value
  // mismatch class the コンボ起動 guard above protects against.
  await page.addInitScript(() => {
    localStorage.setItem('ccserver-meta-app', 'codex');
  });
  // HOME_RESPONSE already hides codex (hiddenApps: ['copilot', 'codex']).
  await stubDirsHome(page);
  await page.goto('/');
  const metaBtn = page.locator('.meta-launch-btn');
  await expect(metaBtn).toBeEnabled();
  await metaBtn.click();
  const dialog = page.locator('.resume-dialog', { hasText: 'メタエージェントを起動' });
  await expect(dialog).toBeVisible();
  // No picker button shows as selected -- the remembered 'codex' pick isn't
  // even offered any more.
  await expect(dialog.locator('.open-menu-check:has-text("✓")')).toHaveCount(0);
  const launchBtn = dialog.locator('.btn-primary', { hasText: 'メタエージェントを起動' });
  await expect(launchBtn).toBeDisabled();
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
