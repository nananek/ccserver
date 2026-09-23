import { test, expect } from '@playwright/test';

// Settings > 通知: エージェント通知ブリッジ (sandbox.config.json の
// notify.bridge) の GUI。サーバーの sandbox.config.json を実際に書き換える
// ため、各テストは終了時に元の状態 (enabled:false) へ戻す。
//
// 検証対象は UI と API の契約まで:
//   - 既定 (機能オフ) の描画と、オフの間は編集項目が無効であること
//   - マスタースイッチが即時 PUT され、再読込後も残ること
//   - まとめ保存が PUT され、サーバーが返した値で画面が更新されること
//   - サーバーのバリデーションエラーが画面に出ること
// Web Push の実配送は headless Chromium では検証しない (権限と push service
// が要る) ため、ここでは扱わない。
test.describe('Settings notifications section', () => {
  async function openPanel(page) {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await page.locator('.tab-list').getByTitle('Settings').click();
    const settings = page.locator('.settings-view');
    await expect(settings).toBeVisible();
    await settings.locator('.settings-sidebar').getByRole('tab', { name: '通知' }).click();
    const panel = settings.locator('[role="tabpanel"]');
    await expect(panel).toContainText('エージェント通知の転送');
    return panel;
  }

  // 何が起きても機能はオフに戻す (このサーバーは他の spec と共有のため)。
  test.afterEach(async ({ request }) => {
    await request.put('/api/notify-settings', { data: { enabled: false } });
  });

  test.beforeEach(async ({ request }) => {
    await request.put('/api/notify-settings', {
      data: {
        enabled: false, apps: ['claude', 'opencode'], injectConfig: true,
        channels: ['discord', 'webpush'], captureBell: false,
        minIntervalMs: 3000, dedupeWindowMs: 10000, maxPerHour: 60, level: 'info',
      },
    });
  });

  test('renders the defaults and disables editing while the feature is off', async ({ page }) => {
    const panel = await openPanel(page);

    const master = panel.getByRole('checkbox', { name: /エージェントのデスクトップ通知を転送する/ });
    await expect(master).not.toBeChecked();

    // オフの間は個別項目に触れない (起動コマンドラインを現状と同一に保つ
    // ため、まず機能そのものを有効化させる導線)。
    await expect(panel.getByRole('checkbox', { name: /Claude Code/ })).toBeDisabled();
    await expect(panel.getByLabel('転送時の重要度 (level)')).toBeDisabled();
    await expect(panel.getByLabel('1 セッションあたりの上限 (件/時)')).toBeDisabled();
    await expect(panel.getByRole('button', { name: '保存' })).toBeDisabled();

    // 既定値そのもの。
    await expect(panel.getByLabel('転送時の重要度 (level)')).toHaveValue('info');
    await expect(panel.getByLabel('最小送信間隔 (ミリ秒)')).toHaveValue('3000');
    await expect(panel.getByLabel('1 セッションあたりの上限 (件/時)')).toHaveValue('60');
    await expect(panel.getByRole('checkbox', { name: /ベル \(BEL\) も通知として扱う/ })).not.toBeChecked();
    // codex は既定で対象外 (このホストで未検証のため)。
    await expect(panel.getByRole('checkbox', { name: /OpenAI Codex/ })).not.toBeChecked();
    await expect(panel.getByRole('checkbox', { name: /Claude Code/ })).toBeChecked();
  });

  test('the master switch saves immediately and survives a reload', async ({ page, request }) => {
    const panel = await openPanel(page);
    const master = panel.getByRole('checkbox', { name: /エージェントのデスクトップ通知を転送する/ });

    await master.check();
    // 保存が完了すると個別項目が触れるようになる。
    await expect(panel.getByRole('checkbox', { name: /Claude Code/ })).toBeEnabled();

    // サーバー側にも入っている。
    await expect
      .poll(async () => (await (await request.get('/api/notify-settings')).json()).settings.enabled)
      .toBe(true);

    // 再読込しても残る。
    const reopened = await openPanel(page);
    await expect(reopened.getByRole('checkbox', { name: /エージェントのデスクトップ通知を転送する/ })).toBeChecked();
  });

  test('the save button writes the batched edits', async ({ page, request }) => {
    const panel = await openPanel(page);
    await panel.getByRole('checkbox', { name: /エージェントのデスクトップ通知を転送する/ }).check();
    await expect(panel.getByRole('checkbox', { name: /Claude Code/ })).toBeEnabled();

    await panel.getByLabel('転送時の重要度 (level)').selectOption('warning');
    await panel.getByRole('checkbox', { name: /ベル \(BEL\) も通知として扱う/ }).check();
    await panel.getByRole('checkbox', { name: /OpenAI Codex/ }).check();
    await panel.getByLabel('1 セッションあたりの上限 (件/時)').fill('12');
    await panel.getByRole('button', { name: '保存' }).click();
    await expect(panel).toContainText('保存しました。');

    const saved = (await (await request.get('/api/notify-settings')).json()).settings;
    expect(saved.level).toBe('warning');
    expect(saved.captureBell).toBe(true);
    expect(saved.maxPerHour).toBe(12);
    expect(saved.apps).toContain('codex');
  });

  test('a value the server rejects is surfaced as an error', async ({ page }) => {
    const panel = await openPanel(page);
    await panel.getByRole('checkbox', { name: /エージェントのデスクトップ通知を転送する/ }).check();
    await expect(panel.getByRole('checkbox', { name: /Claude Code/ })).toBeEnabled();

    // 0 は下限 (1) 未満。ブラウザの min 属性は fill では強制されないので、
    // サーバー側のバリデーションがそのまま画面に出ることを確認する。
    await panel.getByLabel('1 セッションあたりの上限 (件/時)').fill('0');
    await panel.getByRole('button', { name: '保存' }).click();
    await expect(panel.locator('.error')).toContainText('maxPerHour must be between');
  });

  test('a channel with nothing configured behind it is flagged', async ({ page }) => {
    const panel = await openPanel(page);
    // このテストサーバーは notify.discordWebhook も購読も持たないので、
    // 選択済みの discord チャネルは「未設定」と表示される。
    await expect(panel.getByText('Discord webhook / 購読 webhook（未設定）')).toBeVisible();
    await expect(panel).toContainText('設定するまで配信されません');
  });
});

test.describe('Settings notifications: Web Push', () => {
  async function openPanel(page) {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await page.locator('.tab-list').getByTitle('Settings').click();
    const settings = page.locator('.settings-view');
    await settings.locator('.settings-sidebar').getByRole('tab', { name: '通知' }).click();
    const panel = settings.locator('[role="tabpanel"]');
    await expect(panel).toContainText('エージェント通知の転送');
    return panel;
  }

  test('the push section renders and explains the secure-context requirement', async ({ page }) => {
    const panel = await openPanel(page);
    await expect(panel).toContainText('PWA 通知 (Web Push)');
    // The e2e server is plain http on a non-localhost-named host only when
    // CI says so; either way one of the two states must be shown rather than
    // a blank section.
    const subscribeButton = panel.getByRole('button', { name: 'この端末で受け取る' });
    const unsupported = panel.getByText('このブラウザは Web Push に対応していない', { exact: false });
    await expect(subscribeButton.or(unsupported).first()).toBeVisible();
  });

  test('the server mints a VAPID public key for the browser to subscribe with', async ({ request }) => {
    const body = await (await request.get('/api/notify-settings')).json();
    expect(typeof body.vapidPublicKey).toBe('string');
    // Uncompressed P-256 point: 65 bytes, leading 0x04.
    const raw = Buffer.from(body.vapidPublicKey, 'base64url');
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(0x04);
  });

  test('the test-send button reports what each channel did', async ({ page }) => {
    const panel = await openPanel(page);
    await panel.getByRole('button', { name: 'テスト通知を送る' }).click();
    // Nothing is configured on the e2e server, so the honest answer is
    // "Discord unconfigured, no push subscriptions" -- not silence.
    await expect(panel).toContainText('PWA: 購読なし');
    await expect(panel).toContainText('Discord: 未設定');
  });

  test('the observability counters are shown', async ({ page }) => {
    const panel = await openPanel(page);
    await expect(panel).toContainText('監視中のセッション:');
  });
});
