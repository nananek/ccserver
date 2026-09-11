import { test, expect } from '@playwright/test';

function mockRoutes(page, hooks = {}) {
  page.route('**/api/dirs/home*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(hooks.dirs ?? {
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
    const pct = app === 'codex' ? 55 : 10;
    await route.fulfill({
      status: hooks.usageStatus ?? 200,
      contentType: 'application/json',
      body: JSON.stringify({
        usage: {
          plan: 'pro',
          limits: [
            { label: 'Current session', pct, resets: '5h', resetAt: Date.now() + 5 * 3600_000, windowMs: 5 * 3600_000 },
          ],
        },
        updatedAt: Date.now(),
        cached: true,
      }),
    });
  });
  page.route('**/api/system-stats*', async (route) => {
    hooks.onSystemStats?.();
    if (hooks.systemStatsDelay) await new Promise((r) => setTimeout(r, hooks.systemStatsDelay));
    await route.fulfill({
      status: hooks.systemStatsStatus ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(hooks.systemStats ?? {
        uptime: 3600,
        loadAvg: [0.5, 0.4, 0.3],
        cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
        memory: { total: 16000, used: 8000, available: 8000, bufferCache: 1000, swapTotal: 0, swapUsed: 0 },
        storage: [],
        temperatures: {},
        gpu: null,
        ipmi: null,
      }),
    });
  });
}

test('sidebar open state persists across a reload', async ({ page }) => {
  mockRoutes(page);
  await page.goto('/');

  const sidebar = page.locator('.right-sidebar');
  const toggle = page.locator('.sidebar-toggle-btn');
  await expect(sidebar).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  await toggle.click();
  await expect(sidebar).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await page.reload();
  await expect(page.locator('.right-sidebar')).toBeHidden();

  await page.locator('.sidebar-toggle-btn').click();
  await expect(page.locator('.right-sidebar')).toBeVisible();
});

test('hiding a widget persists across a reload', async ({ page }) => {
  mockRoutes(page);
  await page.goto('/');

  const cpuWidget = page.locator('.widget-card', { hasText: 'CPU' });
  await expect(cpuWidget).toBeVisible();
  await cpuWidget.locator('.widget-icon-btn[title="非表示"]').click();
  await expect(page.locator('.widget-card', { hasText: 'CPU' })).toBeHidden();

  await page.reload();
  await expect(page.locator('.widget-card', { hasText: 'CPU' })).toBeHidden();
  await page.locator('.sidebar-header .btn', { hasText: '＋' }).click();
  await page.locator('.sidebar-add-item', { hasText: 'CPU' }).click();
  await expect(page.locator('.widget-card', { hasText: 'CPU' })).toBeVisible();
});

test('closing the sidebar stops system-stats polling', async ({ page }) => {
  let systemStatsHits = 0;
  mockRoutes(page, { onSystemStats: () => { systemStatsHits += 1; } });
  await page.goto('/');

  await expect(page.locator('.widget-card', { hasText: 'CPU' })).toBeVisible();
  expect(systemStatsHits).toBeGreaterThanOrEqual(1);

  await page.locator('.sidebar-toggle-btn').click();
  await expect(page.locator('.right-sidebar')).toBeHidden();

  // 閉じる直前に発行済みのポーリングが到着する猶予を1回分おいてから基準値を取る
  await page.waitForTimeout(2500);
  const hitsAfterClose = systemStatsHits;
  // Default 2s interval: 4.5s of silence proves the poll stopped
  await page.waitForTimeout(4500);
  expect(systemStatsHits).toBe(hitsAfterClose);
});

test('sidebar header has interval menu left of add button and no close button', async ({ page }) => {
  mockRoutes(page);
  await page.goto('/');

  // 右ヘッダーに限定 (左セッションサイドバーも .sidebar-header を持つため)。
  const header = page.locator('.right-sidebar .sidebar-header');
  await expect(header).toBeVisible();
  // Widgetsヘッダー内の ▶（閉じるボタン）は廃止。開閉はタブバーのトグルで行う。
  await expect(header.locator('.btn', { hasText: '▶' })).toHaveCount(0);
  await expect(page.locator('.sidebar-toggle-btn')).toBeVisible();

  // 更新頻度ボタンは＋ボタンの左隣にあること
  // (ボタンの表記はメニューと同一のINTERVAL_OPTIONSラベルを使う)
  const intervalBtn = header.locator('.btn[title="更新頻度"]');
  const addBtn = header.locator('.btn', { hasText: '＋' });
  await expect(intervalBtn).toBeVisible();
  await expect(intervalBtn).toHaveText('2秒');
  const intervalBox = await intervalBtn.boundingBox();
  const addBox = await addBtn.boundingBox();
  expect(intervalBox.x).toBeLessThan(addBox.x);

  // メニューから更新頻度を変更できること
  await intervalBtn.click();
  await expect(page.locator('.sidebar-add-item', { hasText: '5秒' })).toBeVisible();
  await page.locator('.sidebar-add-item', { hasText: '1秒' }).click();
  await expect(intervalBtn).toHaveText('1秒');
  expect(await page.evaluate(() => localStorage.getItem('monitor-interval'))).toBe('1000');
});

test('sidebar interval menu persists across a reload', async ({ page }) => {
  mockRoutes(page);
  await page.goto('/');

  const intervalBtn = page.locator('.sidebar-header .btn[title="更新頻度"]');
  await expect(intervalBtn).toHaveText('2秒');
  await intervalBtn.click();
  await page.locator('.sidebar-add-item', { hasText: '5秒' }).click();
  await expect(intervalBtn).toHaveText('5秒');
  expect(await page.evaluate(() => localStorage.getItem('monitor-interval'))).toBe('5000');

  await page.reload();
  await expect(page.locator('.sidebar-header .btn[title="更新頻度"]')).toHaveText('5秒');
});

test('tapping outside the sidebar closes it on narrow screens', async ({ page }) => {
  mockRoutes(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  // 狭幅の初回 (保存済み設定なし) は閉じた状態で始まる。
  // 開いたままだと画面の約85%を覆い背後の操作を塞ぐため (useWidgetPrefs.loadOpen)。
  await expect(page.locator('.right-sidebar')).toBeHidden();
  await expect(page.locator('.sidebar-backdrop')).toBeHidden();

  // タブバーのトグルで開く
  await page.locator('.sidebar-toggle-btn').click();
  await expect(page.locator('.right-sidebar')).toBeVisible();
  await expect(page.locator('.sidebar-backdrop')).toBeVisible();

  // ウィジェットの外（画面左側）をタップすると閉じる
  // （backdrop中央はサイドバーの下になるため左側の座標を指定）
  await page.locator('.sidebar-backdrop').click({ position: { x: 20, y: 400 } });
  await expect(page.locator('.right-sidebar')).toBeHidden();

  // タブバーのトグルで開き直せる
  await page.locator('.sidebar-toggle-btn').click();
  await expect(page.locator('.right-sidebar')).toBeVisible();
});

test('narrow first visit keeps main actions reachable (no sidebar overlay)', async ({ page }) => {
  mockRoutes(page);
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/');

  // 保存済み設定なしの狭幅初回はサイドバーが閉じていること。
  // file-preview 375px / text-selection (iPhone) で right-sidebar が
  // 背後のボタンを塞いでタイムアウトした回帰を防ぐ。
  await expect(page.locator('.right-sidebar')).toBeHidden();

  const terminalBtn = page.getByRole('button', { name: 'Terminal', exact: true });
  await expect(terminalBtn).toBeVisible();
  const hitTarget = await terminalBtn.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return target?.closest?.('.right-sidebar, .sidebar-backdrop') ?? null;
  });
  expect(hitTarget).toBeNull();
});

test('backdrop is hidden on wide screens', async ({ page }) => {
  mockRoutes(page);
  await page.goto('/');

  await expect(page.locator('.right-sidebar')).toBeVisible();
  // 広幅画面では in-flow 表示のためスクリムは出ない
  await expect(page.locator('.sidebar-backdrop')).toBeHidden();
});

test('system widget shows uptime and load average', async ({ page }) => {
  mockRoutes(page);
  await page.goto('/');

  const systemWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'System' }),
  });
  await expect(systemWidget).toBeVisible();
  // 注: テキスト素片への toBeVisible はフォントの有無に依存するため、
  // ボックスを持つ行要素に対して可視性＋テキスト内容を検証する。
  const systemRows = systemWidget.locator('.monitor-ipmi-row');
  await expect(systemRows).toHaveCount(2);
  await expect(systemRows.nth(0)).toBeVisible();
  await expect(systemRows.nth(0)).toContainText('Uptime');
  await expect(systemRows.nth(0)).toContainText('1h 0m');
  await expect(systemRows.nth(1)).toContainText('Load Average');
  await expect(systemRows.nth(1)).toContainText('0.50 0.40 0.30');
});

test('hiding the system widget persists across a reload', async ({ page }) => {
  mockRoutes(page);
  await page.goto('/');

  const systemWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'System' }),
  });
  await expect(systemWidget).toBeVisible();
  await systemWidget.locator('.widget-icon-btn[title="非表示"]').click();
  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'System' }),
  })).toBeHidden();

  await page.reload();
  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'System' }),
  })).toBeHidden();
  await page.locator('.sidebar-header .btn', { hasText: '＋' }).click();
  await page.locator('.sidebar-add-item', { hasText: 'System' }).click();
  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'System' }),
  })).toBeVisible();
});

test('missing uptime/loadAvg keeps an empty system frame', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
      memory: { total: 16000, used: 8000, available: 8000, bufferCache: 1000, swapTotal: 0, swapUsed: 0 },
      storage: [],
      temperatures: {},
      gpu: null,
      ipmi: null,
    },
  });
  await page.goto('/');

  // サイドバー: データ欠測時もSystemの枠は残し、中身は空にする。CPUは表示される
  const systemWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'System' }),
  });
  await expect(systemWidget).toBeVisible();
  await expect(systemWidget.locator('.widget-card-body')).toBeEmpty();
  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'CPU' }),
  })).toBeVisible();
});

test('partial cpu payload neither crashes nor hides the cpu frame', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      uptime: 3600,
      loadAvg: [0.5, 0.4, 0.3],
      cpu: { model: 'Test CPU' },
      memory: { total: 16000, used: 8000, available: 8000, bufferCache: 1000, swapTotal: 0, swapUsed: 0 },
      storage: [],
      temperatures: {},
      gpu: null,
      ipmi: null,
    },
  });
  await page.goto('/');

  // usage.total/cores 欠落時: CPUの枠は残し、中身は空にする。
  // ガード前のコード (total.toFixed/cores.map) ならrender時に例外になる。
  const cpuWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'CPU' }),
  });
  await expect(cpuWidget).toBeVisible();
  await expect(cpuWidget.locator('.widget-card-body')).toBeEmpty();
  // ページ全体は生きており、Systemウィジェットは表示される
  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'System' }),
  })).toBeVisible();
});

test('widget reorder persists across a reload', async ({ page }) => {
  mockRoutes(page);
  await page.goto('/');

  const titles = page.locator('.widget-card .widget-card-title');
  await expect(titles.first()).toContainText('Usage');
  // 先頭(Usage)を1つ下へ移動 → Systemが先頭になる
  await page.locator('.widget-card').first().locator('.widget-icon-btn[title="下へ"]').click();
  await expect(titles.first()).toContainText('System');
  expect(await page.evaluate(() => localStorage.getItem('ccserver-widget-order'))).toMatch(/^\["system"/);

  await page.reload();
  await expect(page.locator('.widget-card .widget-card-title').first()).toContainText('System');
});

test('moving a widget across a hidden one changes the visible order', async ({ page }) => {
  mockRoutes(page);
  await page.goto('/');

  // Systemを非表示にし、先頭Usageを下へ。旧コードでは不可視Systemと
  // 交換するだけで可視順序が変わらず無反応に見えた。
  const systemWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'System' }),
  });
  await systemWidget.locator('.widget-icon-btn[title="非表示"]').click();
  await page.locator('.widget-card').first().locator('.widget-icon-btn[title="下へ"]').click();
  await expect(page.locator('.widget-card .widget-card-title').first()).toContainText('CPU');

  await page.reload();
  await expect(page.locator('.widget-card .widget-card-title').first()).toContainText('CPU');
});

test('moving across usage hidden by env skips it', async ({ page }) => {
  mockRoutes(page, {
    dirs: {
      home: '/home/test',
      defaultApp: 'claude',
      forceSandbox: false,
      hostname: 'test',
      showUsage: false,
      availableApps: { claude: true, codex: true },
    },
  });
  // usageが途中に残る保存順序 (環境でusageが除外される場合)
  await page.addInitScript(
    () => localStorage.setItem('ccserver-widget-order', JSON.stringify(['system', 'usage', 'cpu', 'memory', 'storage', 'gpu'])),
  );
  await page.goto('/');

  // 描画順は [System, CPU, ...]。先頭Systemを下へ押すと、不可視のusage
  // ではなくCPUと入れ替わる。旧コードではusageと交換して無反応に見えた。
  await expect(page.locator('.widget-card .widget-card-title').first()).toContainText('System');
  await page.locator('.widget-card').first().locator('.widget-icon-btn[title="下へ"]').click();
  await expect(page.locator('.widget-card .widget-card-title').first()).toContainText('CPU');
});

test('move buttons at the rendered boundaries are disabled', async ({ page }) => {
  mockRoutes(page);
  await page.goto('/');

  const cards = page.locator('.widget-card');
  // 先頭の「上へ」と末尾の「下へ」は押しても何も起きないため無効化される
  await expect(cards.first().locator('.widget-icon-btn[title="上へ"]')).toBeDisabled();
  await expect(cards.first().locator('.widget-icon-btn[title="下へ"]')).toBeEnabled();
  await expect(cards.last().locator('.widget-icon-btn[title="下へ"]')).toBeDisabled();
  await expect(cards.last().locator('.widget-icon-btn[title="上へ"]')).toBeEnabled();
});

test('moving across an empty visible widget swaps with it', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      // Systemは可視設定のままデータ欠落で空枠になる形状
      uptime: null,
      cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
      memory: { total: 16000, used: 8000, available: 8000, bufferCache: 1000, swapTotal: 0, swapUsed: 0 },
      storage: [],
      temperatures: {},
      gpu: null,
      ipmi: null,
    },
  });
  await page.goto('/');

  // 描画順は [Usage, System(空枠), CPU, ...]。先頭Usageを下へ押すと
  // 空枠のSystemと入れ替わる (空枠も隠す/移動の操作対象として残す仕様)。
  // 未描画 (ローディング中・未知ID) のみが移動時に飛ばされる対象。
  await expect(page.locator('.widget-card .widget-card-title').first()).toContainText('Usage');
  const systemWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'System' }),
  });
  await expect(systemWidget).toBeVisible();
  await expect(systemWidget.locator('.widget-card-body')).toBeEmpty();
  await page.locator('.widget-card').first().locator('.widget-icon-btn[title="下へ"]').click();
  await expect(page.locator('.widget-card .widget-card-title').first()).toContainText('System');
});

test('partial ipmi payload neither crashes nor makes empty ipmi cards', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      uptime: 3600,
      loadAvg: [0.5, 0.4, 0.3],
      cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
      memory: { total: 16000, used: 8000, available: 8000, bufferCache: 1000, swapTotal: 0, swapUsed: 0 },
      storage: [],
      temperatures: {},
      gpu: null,
      // voltage/fans/temps 配列が欠落した形状。ガード前のコード
      // (data.ipmi.voltage.length) ならrender時に例外になる。
      ipmi: { power: [{ label: 'PSU', value: 120 }] },
    },
  });
  await page.goto('/');

  // ページ全体は生きている
  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'CPU' }),
  })).toBeVisible();

  // ＋メニューからIPMIを追加 → 存在するpower行のみ表示される
  await page.locator('.sidebar-header .btn', { hasText: '＋' }).click();
  await page.locator('.sidebar-add-item', { hasText: 'IPMI' }).click();
  const ipmiWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'IPMI' }),
  });
  await expect(ipmiWidget).toBeVisible();
  await expect(ipmiWidget).toContainText('120');
});

test('non-numeric gpu fields never render as NaN', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      uptime: 3600,
      loadAvg: [0.5, 0.4, 0.3],
      cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
      memory: { total: 16000, used: 8000, available: 8000, bufferCache: 1000, swapTotal: 0, swapUsed: 0 },
      storage: [],
      temperatures: {},
      // ファンレスGPUなど、nvidia-smiが数値以外を返す項目の再現。
      // NaNはJSONで送れないため、wire上の姿であるnullで検証する
      // (serverはparseInt('N/A')=NaNを返し、JSON化でnullになる)。
      gpu: { name: 'Fanless GPU', temp: null, utilization: 55, memoryUsed: 1000, memoryTotal: 2000, fanSpeed: null, powerUsage: 70, powerCap: 100 },
      ipmi: null,
    },
  });
  await page.goto('/');

  const gpuWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'GPU' }),
  });
  await expect(gpuWidget).toBeVisible();
  await expect(gpuWidget).toContainText('55');
  // 旧コードは "null°C" / "Fan: null%" と表示していた
  await expect(gpuWidget).not.toContainText('null');
  await expect(gpuWidget).not.toContainText('NaN');
  await expect(gpuWidget.getByText('Temperature', { exact: true })).toHaveCount(0);
  await expect(gpuWidget).toContainText('Fan: —');
});

test('gpu payload without usable metrics keeps an empty gpu frame', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      uptime: 3600,
      loadAvg: [0.5, 0.4, 0.3],
      cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
      memory: { total: 16000, used: 8000, available: 8000, bufferCache: 1000, swapTotal: 0, swapUsed: 0 },
      storage: [],
      temperatures: {},
      gpu: { name: 'Unknown GPU' },
      ipmi: null,
    },
  });
  await page.goto('/');

  // 有効メトリクスがなくても枠は残し、中身は空にする
  const gpuWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'GPU' }),
  });
  await expect(gpuWidget).toBeVisible();
  await expect(gpuWidget.locator('.widget-card-body')).toBeEmpty();
  // ページ全体は生きている
  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'CPU' }),
  })).toBeVisible();
});

test('empty temperature arrays keep an empty temperatures frame', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      uptime: 3600,
      loadAvg: [0.5, 0.4, 0.3],
      cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
      memory: { total: 16000, used: 8000, available: 8000, bufferCache: 1000, swapTotal: 0, swapUsed: 0 },
      storage: [],
      // 空配列はtruthyのため、ガード前のコードでは空のカード/見出しが描画される
      temperatures: { cpu: [], pch: [], other: [] },
      gpu: null,
      ipmi: null,
    },
  });
  await page.goto('/');

  // ＋メニューからTemperaturesを追加すると、有効行がなくても空枠が作られる
  await page.locator('.sidebar-header .btn', { hasText: '＋' }).click();
  await page.locator('.sidebar-add-item', { hasText: 'Temperatures' }).click();
  const tempsWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'Temperatures' }),
  });
  await expect(tempsWidget).toBeVisible();
  await expect(tempsWidget.locator('.widget-card-body')).toBeEmpty();
  // ページ全体は生きている
  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'CPU' }),
  })).toBeVisible();
});

test('temperature groups with data render while empty groups stay hidden', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      uptime: 3600,
      loadAvg: [0.5, 0.4, 0.3],
      cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
      memory: { total: 16000, used: 8000, available: 8000, bufferCache: 1000, swapTotal: 0, swapUsed: 0 },
      storage: [],
      temperatures: { cpu: [{ label: 'Package', value: 45 }], pch: [], other: [] },
      gpu: null,
      ipmi: null,
    },
  });
  await page.goto('/');

  await page.locator('.sidebar-header .btn', { hasText: '＋' }).click();
  await page.locator('.sidebar-add-item', { hasText: 'Temperatures' }).click();
  const tempsWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'Temperatures' }),
  });
  await expect(tempsWidget).toBeVisible();
  await expect(tempsWidget).toContainText('Package');
  await expect(tempsWidget.getByText('Chipset (PCH)', { exact: true })).toHaveCount(0);
  await expect(tempsWidget.getByText('Other', { exact: true })).toHaveCount(0);
});

test('temperature rows with missing values are hidden', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      uptime: 3600,
      loadAvg: [0.5, 0.4, 0.3],
      cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
      memory: { total: 16000, used: 8000, available: 8000, bufferCache: 1000, swapTotal: 0, swapUsed: 0 },
      storage: [],
      // hwmonのparse失敗はwire上でvalue:nullになる。旧コードは"null°C"表示。
      temperatures: { cpu: [{ label: 'Broken', value: null }, { label: 'Package', value: 45 }], pch: [], other: [] },
      gpu: null,
      ipmi: null,
    },
  });
  await page.goto('/');

  await page.locator('.sidebar-header .btn', { hasText: '＋' }).click();
  await page.locator('.sidebar-add-item', { hasText: 'Temperatures' }).click();
  const tempsWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'Temperatures' }),
  });
  await expect(tempsWidget).toBeVisible();
  await expect(tempsWidget).toContainText('Package');
  await expect(tempsWidget).not.toContainText('null');
  await expect(tempsWidget.getByText('Broken', { exact: true })).toHaveCount(0);
});

test('temperatures with only missing values keep an empty frame', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      uptime: 3600,
      loadAvg: [0.5, 0.4, 0.3],
      cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
      memory: { total: 16000, used: 8000, available: 8000, bufferCache: 1000, swapTotal: 0, swapUsed: 0 },
      storage: [],
      temperatures: { cpu: [{ label: 'Broken', value: null }] },
      gpu: null,
      ipmi: null,
    },
  });
  await page.goto('/');

  await page.locator('.sidebar-header .btn', { hasText: '＋' }).click();
  await page.locator('.sidebar-add-item', { hasText: 'Temperatures' }).click();
  // 有効行がなくても枠は残し、隠す/移動/追加の操作対象を維持する
  const tempsWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'Temperatures' }),
  });
  await expect(tempsWidget).toBeVisible();
  await expect(tempsWidget.locator('.widget-card-body')).toBeEmpty();
  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'CPU' }),
  })).toBeVisible();
});

test('usage tab selection in the sidebar widget switches the displayed app', async ({ page }) => {
  mockRoutes(page);
  await page.goto('/');

  const widget = page.locator('.usage-widget');
  await expect(widget.locator('.usage-tab.active')).toHaveText('Claude');
  await expect(widget.locator('.usage-limit-pct').first()).toHaveText('10%');

  await widget.locator('.usage-tab', { hasText: 'Codex' }).click();
  await expect(widget.locator('.usage-tab.active')).toHaveText('Codex');
  await expect(widget.locator('.usage-limit-pct').first()).toHaveText('55%');
});

test('usage api error shows the error state instead of bogus data', async ({ page }) => {
  mockRoutes(page, { usageStatus: 500 });
  await page.goto('/');

  // res.okチェックによりHTTP 500は例外→エラー表示になる (成功データ扱いしない)
  // 注: テキスト素片の可視性はフォント依存のため、行ではなくウィジェットで検証
  await expect(page.locator('.usage-widget')).toContainText('取得できませんでした');
});

test('non-finite cpu values are hidden, not rendered as NaN', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      uptime: 3600,
      loadAvg: [0.5, 0.4, 0.3],
      cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, null, 30] } },
      memory: { total: 16000, used: 8000, available: 8000, bufferCache: 1000, swapTotal: 0, swapUsed: 0 },
      storage: [],
      temperatures: {},
      gpu: null,
      ipmi: null,
    },
  });
  await page.goto('/');

  const cpuWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'CPU' }),
  });
  await expect(cpuWidget).toBeVisible();
  // 欠測コアの行は出さない (旧コードはNumber(null)=0で"0%"誤表示)
  await expect(cpuWidget.getByText('Core 0', { exact: true })).toHaveCount(1);
  await expect(cpuWidget.getByText('Core 1', { exact: true })).toHaveCount(0);
  await expect(cpuWidget.getByText('Core 2', { exact: true })).toHaveCount(1);
  await expect(cpuWidget).not.toContainText('NaN');
});

test('memory without usable numbers keeps empty memory/storage frames', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      uptime: 3600,
      loadAvg: [0.5, 0.4, 0.3],
      cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
      memory: { total: 16000 },
      storage: [],
      temperatures: {},
      gpu: null,
      ipmi: null,
    },
  });
  await page.goto('/');

  // 欠測時も枠は残る（中身は空）。分離後は Memory と Storage が独立した枠になる
  const memWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'Memory' }),
  });
  await expect(memWidget).toBeVisible();
  await expect(memWidget.locator('.widget-card-body')).toBeEmpty();
  const storageWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'Storage' }),
  });
  await expect(storageWidget).toBeVisible();
  await expect(storageWidget.locator('.widget-card-body')).toBeEmpty();
  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'CPU' }),
  })).toBeVisible();
});

test('partial memory renders placeholders instead of undefined', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      uptime: 3600,
      loadAvg: [0.5, 0.4, 0.3],
      cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
      memory: { total: 16000, used: 8000 },
      storage: [],
      temperatures: {},
      gpu: null,
      ipmi: null,
    },
  });
  await page.goto('/');

  const memWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'Memory' }),
  });
  await expect(memWidget).toBeVisible();
  // 旧コードは"undefined MB"表示
  await expect(memWidget).not.toContainText('undefined');
  await expect(memWidget).toContainText('Available: —');
  // storage が空でも Storage の空枠は残る（分離の確認）
  const emptyStorageWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'Storage' }),
  });
  await expect(emptyStorageWidget).toBeVisible();
  await expect(emptyStorageWidget.locator('.widget-card-body')).toBeEmpty();
});

test('storage rows with missing numbers are hidden', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      uptime: 3600,
      loadAvg: [0.5, 0.4, 0.3],
      cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
      memory: null,
      storage: [
        { mount: '/bad', device: 'sda9', total: null, used: null, available: 0, usedPct: 0 },
        { mount: '/data', device: 'sdb1', total: 2000, used: 500, available: 1500, usedPct: 25 },
      ],
      temperatures: {},
      gpu: null,
      ipmi: null,
    },
  });
  await page.goto('/');

  const storageWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'Storage' }),
  });
  await expect(storageWidget).toBeVisible();
  // 欠測行は出さない (旧コードは'/bad'行を描画していた)
  await expect(storageWidget).toContainText('/data');
  await expect(storageWidget.getByText('/bad', { exact: true })).toHaveCount(0);
  // memory が null でも Memory の空枠は残る（分離の確認）
  const emptyMemWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'Memory' }),
  });
  await expect(emptyMemWidget).toBeVisible();
  await expect(emptyMemWidget.locator('.widget-card-body')).toBeEmpty();
});

test('system filters unusable load values instead of showing 0.00/NaN', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      uptime: null,
      loadAvg: [0.5, null, 'N/A'],
      cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
      memory: null,
      storage: [],
      temperatures: {},
      gpu: null,
      ipmi: null,
    },
  });
  await page.goto('/');

  const systemWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'System' }),
  });
  await expect(systemWidget).toBeVisible();
  // nullは黙って0.00にしない (旧コードはNumber(null)=0で"0.00"表示)
  await expect(systemWidget).toContainText('0.50');
  await expect(systemWidget).not.toContainText('0.00');
  await expect(systemWidget).not.toContainText('NaN');
  await expect(systemWidget.getByText('Uptime', { exact: true })).toHaveCount(0);
});

test('system with only unusable values keeps an empty frame', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      uptime: null,
      loadAvg: [null],
      cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
      memory: null,
      storage: [],
      temperatures: {},
      gpu: null,
      ipmi: null,
    },
  });
  await page.goto('/');

  // 有効値がなくても枠は残し、中身は空にする
  const systemWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'System' }),
  });
  await expect(systemWidget).toBeVisible();
  await expect(systemWidget.locator('.widget-card-body')).toBeEmpty();
  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'CPU' }),
  })).toBeVisible();
});

test('ipmi rows with missing values are hidden without crashing', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      uptime: 3600,
      loadAvg: [0.5, 0.4, 0.3],
      cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
      memory: null,
      storage: [],
      temperatures: {},
      gpu: null,
      // 旧コードは voltage の toFixed で例外→画面全体が壊れる
      ipmi: {
        power: [{ label: 'PSU', value: 120 }],
        voltage: [{ label: 'V12', value: null }],
        fans: [{ label: 'FAN1', value: null }],
        temps: [{ label: 'Inlet', value: null }],
      },
    },
  });
  await page.goto('/');

  await page.locator('.sidebar-header .btn', { hasText: '＋' }).click();
  await page.locator('.sidebar-add-item', { hasText: 'IPMI' }).click();
  // 注: サイドバー内のカードはhideTitleのため、内側の.monitor-card-titleは
  // 存在しない。行ラベルで特定する。
  const ipmiWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'IPMI' }),
  });
  await expect(ipmiWidget).toBeVisible();
  const powerCard = ipmiWidget.locator('.monitor-card', { hasText: 'PSU' });
  await expect(powerCard).toBeVisible();
  await expect(powerCard).toContainText('120');
  // 欠測だけの行は出さない
  for (const label of ['V12', 'FAN1', 'Inlet']) {
    await expect(ipmiWidget.getByText(label, { exact: true })).toHaveCount(0);
  }
});

test('ipmi with only missing values keeps an empty frame', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      uptime: 3600,
      loadAvg: [0.5, 0.4, 0.3],
      cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
      memory: null,
      storage: [],
      temperatures: {},
      gpu: null,
      ipmi: { power: [{ label: 'PSU', value: null }] },
    },
  });
  await page.goto('/');

  await page.locator('.sidebar-header .btn', { hasText: '＋' }).click();
  await page.locator('.sidebar-add-item', { hasText: 'IPMI' }).click();
  // 有効行がなくても枠は残し、隠す/移動/追加の操作対象を維持する
  const ipmiWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'IPMI' }),
  });
  await expect(ipmiWidget).toBeVisible();
  await expect(ipmiWidget.locator('.widget-card-body')).toBeEmpty();
  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'CPU' }),
  })).toBeVisible();
});

test('off-option interval from storage shows fallback in sidebar control', async ({ page }) => {
  mockRoutes(page);
  // 選択肢外の値 (旧値・手編集値) で起動。normalizeIntervalは通す。
  await page.addInitScript(() => localStorage.setItem('monitor-interval', '3000'));
  await page.goto('/');

  // サイドバー側はフォールバック表示
  await expect(page.locator('.sidebar-header .btn[title="更新頻度"]')).toHaveText('3s');
});

test('sidebar menus close on Escape and are mutually exclusive', async ({ page }) => {
  mockRoutes(page);
  await page.goto('/');

  const intervalBtn = page.locator('.sidebar-header .btn[title="更新頻度"]');
  const addBtn = page.locator('.sidebar-header .btn', { hasText: '＋' });
  await expect(intervalBtn).toHaveAttribute('aria-expanded', 'false');
  await expect(addBtn).toHaveAttribute('aria-expanded', 'false');

  await intervalBtn.click();
  await expect(intervalBtn).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.sidebar-add-menu')).toHaveCount(1);

  // 片方を開くと他方は閉じる
  await addBtn.click();
  await expect(intervalBtn).toHaveAttribute('aria-expanded', 'false');
  await expect(addBtn).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.sidebar-add-menu')).toHaveCount(1);

  // Escapeで閉じる
  await page.keyboard.press('Escape');
  await expect(addBtn).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.sidebar-add-menu')).toHaveCount(0);
});

test('system-stats 500 shows per-widget errors and keeps widgets editable', async ({ page }) => {
  mockRoutes(page, { systemStatsStatus: 500, systemStats: { error: 'internal' } });
  await page.goto('/');

  // 可視モニターウィジェットごとに枠が作られ、枠内にエラーが出る。
  // 旧コードはリスト上部の単一バナーのみで枠が0件だった。
  for (const title of ['System', 'CPU', 'Memory', 'Storage', 'GPU']) {
    const card = page.locator('.widget-card', {
      has: page.locator('.widget-card-title', { hasText: title }),
    });
    await expect(card).toBeVisible();
    await expect(card.locator('.error')).toContainText('Failed to load system stats: HTTP 500');
  }
  // 単一バナーへの集約はしない (サイドバー直下の .error が残らないこと)。
  await expect(page.locator('.sidebar-widgets > .error')).toHaveCount(0);
  // Usage は system-stats と独立に表示される。
  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'Usage' }),
  })).toBeVisible();

  // エラー枠でも非表示・移動の操作対象になること。
  const cpuWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'CPU' }),
  });
  await cpuWidget.locator('.widget-icon-btn[title="非表示"]').click();
  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'CPU' }),
  })).toBeHidden();
});

test('system-stats error keeps IPMI frame hidden when showIpmi is off', async ({ page }) => {
  // showIpmi=false (IPMI無効/未対応) の状態で /system-stats 自体が失敗しても、
  // データ取得成功パス (case 'ipmi') と同じく IPMI 枠は出ないこと。
  await page.addInitScript(() => {
    localStorage.setItem('monitor-show-ipmi', 'false');
    localStorage.setItem('ccserver-widget:ipmi:visible', '1');
  });
  mockRoutes(page, { systemStatsStatus: 500, systemStats: { error: 'internal' } });
  await page.goto('/');

  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'System' }),
  })).toBeVisible();
  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'IPMI' }),
  })).toHaveCount(0);
});

test('partial 200 with errors shows only the failed widget as an error', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      uptime: 3600,
      loadAvg: [0.5, 0.4, 0.3],
      cpu: null,
      memory: { total: 16000, used: 8000, available: 8000, bufferCache: 1000, swapTotal: 0, swapUsed: 0 },
      storage: [],
      temperatures: {},
      gpu: null,
      ipmi: null,
      errors: { cpu: 'ENOENT: no such file or directory' },
    },
  });
  await page.goto('/');

  // CPU枠だけ項目別エラーになり、他は正常表示のまま。
  const cpuCard = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'CPU' }),
  });
  await expect(cpuCard).toBeVisible();
  await expect(cpuCard.locator('.error')).toContainText('Failed to load cpu');
  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'System' }),
  })).toBeVisible();
  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'Memory' }),
  })).toBeVisible();
  // storage が空でも Storage の空枠は残る（分離の確認）
  const partialStorageWidget = page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'Storage' }),
  });
  await expect(partialStorageWidget).toBeVisible();
  await expect(partialStorageWidget.locator('.widget-card-body')).toBeEmpty();
});

test('monitor widgets render single frame without nested monitor-card', async ({ page }) => {
  mockRoutes(page, {
    systemStats: {
      uptime: 3600,
      loadAvg: [0.5, 0.4, 0.3],
      cpu: { model: 'Test CPU', usage: { total: 25, cores: [20, 30] } },
      memory: { total: 16000, used: 8000, available: 8000, bufferCache: 1000, swapTotal: 0, swapUsed: 0 },
      storage: [
        { mount: '/data', device: 'sdb1', total: 2000, used: 500, available: 1500, usedPct: 25 },
      ],
      temperatures: {},
      gpu: { name: 'Test GPU', temp: 50, utilization: 55, memoryUsed: 1000, memoryTotal: 2000, fanSpeed: 30, powerUsage: 70, powerCap: 100 },
      ipmi: null,
    },
  });
  await page.goto('/');

  // System/CPU/Memory/Storage/GPU は外側 WidgetShell のみで内側 .monitor-card を持たない。
  // IPMI は複数セクションのため内側カードを残す対象外。
  const cases = [
    { title: 'System', text: 'Uptime' },
    { title: 'CPU', text: 'Test CPU' },
    { title: 'Memory', text: 'RAM' },
    { title: 'Storage', text: '/data' },
    { title: 'GPU', text: 'Test GPU' },
  ];
  for (const { title, text } of cases) {
    const widget = page.locator('.widget-card', {
      has: page.locator('.widget-card-title', { hasText: title }),
    });
    await expect(widget).toBeVisible();
    await expect(widget.locator('.widget-card-body > .monitor-card')).toHaveCount(0);
    await expect(widget).toContainText(text);
  }
});

test('slow responses do not pile up overlapping system-stats polls', async ({ page }) => {
  let systemStatsHits = 0;
  // 応答2.5sに対し周期1s。旧コードは毎tick発行して並走する。
  mockRoutes(page, { systemStatsDelay: 2500, onSystemStats: () => { systemStatsHits += 1; } });
  await page.addInitScript(() => localStorage.setItem('monitor-interval', '1000'));
  await page.goto('/');

  await expect(page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'CPU' }),
  })).toBeVisible();
  // 実行中tickはスキップされるため、約8秒で3発程度に収まる (旧コードは9発)
  await page.waitForTimeout(5500);
  expect(systemStatsHits).toBeLessThanOrEqual(4);
});

// --- ウィジェット右クリックメニュー / CPU表示モード -------------------------

function cpuStats(cores) {
  return {
    uptime: 3600,
    loadAvg: [0.5, 0.4, 0.3],
    cpu: { model: 'Test CPU', usage: { total: 25, cores } },
    memory: { total: 16000, used: 8000, available: 8000, bufferCache: 1000, swapTotal: 0, swapUsed: 0 },
    storage: [],
    temperatures: {},
    gpu: null,
    ipmi: null,
  };
}

function cpuWidgetOf(page) {
  return page.locator('.widget-card', {
    has: page.locator('.widget-card-title', { hasText: 'CPU' }),
  });
}

async function pickCoreView(page, label) {
  await cpuWidgetOf(page).click({ button: 'right' });
  const menu = page.locator('.widget-context-menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitemradio', { name: label }).click();
  await expect(menu).toHaveCount(0);
}

test('cpu core view mode is switchable from the context menu and persists', async ({ page }) => {
  mockRoutes(page, { systemStats: cpuStats([20, 30]) });
  await page.goto('/');
  const cpu = cpuWidgetOf(page);
  await expect(cpu).toBeVisible();
  // 2コアなので auto は bars。
  await expect(cpu.locator('.monitor-core-grid')).toHaveCount(1);

  await pickCoreView(page, 'ヒートマップモード');
  await expect(cpu.locator('.monitor-core-heatmap .monitor-core-cell')).toHaveCount(2);

  await page.reload();
  await expect(cpuWidgetOf(page).locator('.monitor-core-heatmap')).toHaveCount(1);

  // 選択中の項目にチェックが付く。
  await cpuWidgetOf(page).click({ button: 'right' });
  await expect(
    page.locator('.widget-context-menu').getByRole('menuitemradio', { name: 'ヒートマップモード' })
  ).toHaveAttribute('aria-checked', 'true');
});

test('auto core view flips to the heatmap past the 8-core threshold', async ({ page }) => {
  mockRoutes(page, { systemStats: cpuStats(Array.from({ length: 8 }, (_, i) => i * 5)) });
  await page.goto('/');
  await expect(cpuWidgetOf(page).locator('.monitor-core-grid')).toHaveCount(1);
  await expect(cpuWidgetOf(page).locator('.monitor-core-heatmap')).toHaveCount(0);

  await page.context().clearCookies();
  await page.route('**/api/system-stats*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(cpuStats(Array.from({ length: 9 }, (_, i) => i * 5))),
    });
  });
  await page.reload();
  await expect(cpuWidgetOf(page).locator('.monitor-core-heatmap .monitor-core-cell')).toHaveCount(9);
});

test('compact core view actually draws a bar for every core', async ({ page }) => {
  mockRoutes(page, { systemStats: cpuStats([20, 70]) });
  await page.goto('/');
  await pickCoreView(page, 'コンパクトモード');

  const items = cpuWidgetOf(page).locator('.monitor-core-compact-item');
  await expect(items).toHaveCount(2);
  // 回帰: fill が inline <span> のままだと width/height が効かず幅0になる
  // (バーが全く描画されない)。実寸で見る。
  const widths = await items.locator('.monitor-bar-fill').evaluateAll(
    (els) => els.map((el) => el.getBoundingClientRect().width)
  );
  expect(widths).toHaveLength(2);
  for (const w of widths) expect(w).toBeGreaterThan(0);
  expect(widths[1]).toBeGreaterThan(widths[0]);
});

test('the context menu stays on screen when opened at the viewport edge', async ({ page }) => {
  mockRoutes(page, { systemStats: cpuStats([20, 30]) });
  await page.goto('/');
  const cpu = cpuWidgetOf(page);
  await expect(cpu).toBeVisible();

  const box = await cpu.boundingBox();
  const vp = page.viewportSize();
  // ウィジェットの右下隅 = 画面右端すれすれで開く。
  await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });

  const menu = page.locator('.widget-context-menu');
  await expect(menu).toBeVisible();
  const mb = await menu.boundingBox();
  expect(mb.x).toBeGreaterThanOrEqual(0);
  expect(mb.y).toBeGreaterThanOrEqual(0);
  expect(mb.x + mb.width).toBeLessThanOrEqual(vp.width);
  expect(mb.y + mb.height).toBeLessThanOrEqual(vp.height);
});
