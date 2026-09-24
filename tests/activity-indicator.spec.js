import { test, expect } from '@playwright/test';

// タブのアクティビティ表示 (server/ws/activity.js の level を
// client/src/activityLevel.js が描く) の検証。
//
// サーバー側の判定そのものは server/ws/activity.test.js が実フレームで
// 押さえているので、ここで見るのは「レベルごとに見た目が違い、色以外でも
// 区別でき、状態語が読み上げに載ること」だけ。実エージェントは起動できない
// (このホストに CLI が無くても通る必要がある) ため、/api/sessions を差し替えて
// 3 レベルを並べる。

const sessionToggle = (page) => page.getByRole('button', { name: /セッションサイドバー/ });
const leftSidebar = (page) => page.locator('.left-sidebar');
const unopenedItems = (page) => leftSidebar(page).locator('[data-section="unopened"] .session-menu-item');

const SESSIONS = [
  {
    id: 'sess-idle', cwd: '/srv/idle', connected: false, viewers: 0, shell: false,
    sandbox: true, sandboxOpts: null, gpgVaultActive: false, app: 'claude', model: null,
    permissionMode: 'standard', groupId: null, groupRole: null, customLabel: 'idle-one',
    activity: { level: 'idle', reason: 'quiet', marker: null, markerVerified: true, screenIdleMs: 60000, changeRate: 0 },
  },
  {
    id: 'sess-low', cwd: '/srv/low', connected: false, viewers: 0, shell: false,
    sandbox: true, sandboxOpts: null, gpgVaultActive: false, app: 'claude', model: null,
    permissionMode: 'standard', groupId: null, groupRole: null, customLabel: 'low-one',
    activity: { level: 'low', reason: 'marker', marker: 'esc to interrupt', markerVerified: true, screenIdleMs: 120, changeRate: 4.5 },
  },
  {
    id: 'sess-busy', cwd: '/srv/busy', connected: false, viewers: 0, shell: false,
    sandbox: true, sandboxOpts: null, gpgVaultActive: false, app: 'codex', model: null,
    permissionMode: 'standard', groupId: null, groupRole: null, customLabel: 'busy-one',
    activity: { level: 'busy', reason: 'movement', marker: null, markerVerified: false, screenIdleMs: 30, changeRate: 31.5 },
  },
  {
    // A hostile / broken value, the shape a malicious federation peer could
    // return for one of its own sessions (the peer computes the level and we
    // render it). It must not resolve through Object.prototype.
    id: 'sess-hostile', cwd: '/srv/hostile', connected: false, viewers: 0, shell: false,
    sandbox: true, sandboxOpts: null, gpgVaultActive: false, app: 'claude', model: null,
    permissionMode: 'standard', groupId: null, groupRole: null, customLabel: 'hostile-one',
    activity: { level: '__proto__', reason: 'constructor', marker: null, markerVerified: true, screenIdleMs: 0, changeRate: 0 },
  },
  {
    id: 'sess-shell', cwd: '/srv/shell', connected: false, viewers: 0, shell: true,
    sandbox: false, sandboxOpts: null, gpgVaultActive: false, app: null, model: null,
    permissionMode: 'standard', groupId: null, groupRole: null, customLabel: 'shell-one',
    activity: { level: null, reason: 'shell', marker: null, markerVerified: false, screenIdleMs: null, changeRate: 0 },
  },
];

async function stubSessions(page) {
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: SESSIONS }) });
  });
}

async function openSidebar(page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
  // 閉じているときサイドバーは DOM ごと消える (SessionSidebar は open で
  // ゲートしている) ので、行数ではなくパネルの有無で判定する。行数で見ると
  // 「開いているが読み込み前」と区別がつかず、開いているサイドバーを閉じて
  // しまう。
  if (await leftSidebar(page).count() === 0) await sessionToggle(page).click();
  await expect(leftSidebar(page)).toBeVisible();
  await expect(unopenedItems(page)).toHaveCount(SESSIONS.length);
}

const rowFor = (page, label) => unopenedItems(page).filter({ hasText: label });

test('each activity level draws its own dot, and a shell draws none', async ({ page }) => {
  await stubSessions(page);
  await openSidebar(page);

  await expect(rowFor(page, 'idle-one').locator('.session-activity.is-idle')).toHaveCount(1);
  await expect(rowFor(page, 'low-one').locator('.session-activity.is-low')).toHaveCount(1);
  await expect(rowFor(page, 'busy-one').locator('.session-activity.is-busy')).toHaveCount(1);
  // A plain shell has no agent, so the server reports level null and the UI
  // shows nothing rather than guessing.
  await expect(rowFor(page, 'shell-one').locator('.session-activity')).toHaveCount(0);
});

test('the level is not carried by colour alone: shape differs and the word is in the accessible name', async ({ page }) => {
  await stubSessions(page);
  await openSidebar(page);

  // 形: 中空 (背景なし) / 半分塗り (グラデーション) / 塗りつぶし (単色)。
  const background = (sel) => page.locator(sel).evaluate((el) => getComputedStyle(el).backgroundImage + '|' + getComputedStyle(el).backgroundColor);
  const idleBg = await background('.session-activity.is-idle');
  const lowBg = await background('.session-activity.is-low');
  const busyBg = await background('.session-activity.is-busy');
  expect(idleBg).not.toBe(lowBg);
  expect(lowBg).not.toBe(busyBg);
  expect(idleBg).not.toBe(busyBg);
  expect(lowBg).toContain('gradient');

  // 状態語は行の読み上げ名に入る (点そのものは aria-hidden)。
  await expect(rowFor(page, 'idle-one').getByRole('menuitem')).toHaveAttribute('aria-label', /待機中/);
  await expect(rowFor(page, 'low-one').getByRole('menuitem')).toHaveAttribute('aria-label', /低活動/);
  await expect(rowFor(page, 'busy-one').getByRole('menuitem')).toHaveAttribute('aria-label', /稼働中/);
  await expect(page.locator('.session-activity.is-idle')).toHaveAttribute('aria-hidden', 'true');
});

test('an unverified CLI is marked as a weaker reading, without shouting about it', async ({ page }) => {
  await stubSessions(page);
  await openSidebar(page);

  // codex にはキャプチャ済みの稼働中フレームが無く、画面の動きだけで判定して
  // いる。差は彩度を落とすだけにとどめ、レベルの形も色相も変えない。
  const busyDot = rowFor(page, 'busy-one').locator('.session-activity');
  await expect(busyDot).toHaveClass(/is-unverified/);
  await expect(rowFor(page, 'low-one').locator('.session-activity')).not.toHaveClass(/is-unverified/);
  // 根拠は tooltip に書いてある。
  await expect(busyDot).toHaveAttribute('title', /未検証/);
  await expect(rowFor(page, 'low-one').locator('.session-activity')).toHaveAttribute('title', /稼働中の表示を検出/);
});

test('a level that is not one of ours is dropped, not resolved through the prototype', async ({ page }) => {
  // activity は federation ピアが計算した値をそのまま描く経路があるため、
  // 未知のレベルは既定値に落とす。plain object の索引だと
  // LEVELS['__proto__'] が Object.prototype を返して truthy になり、
  // class の付かない点と "undefined — undefined / [object Object]" という
  // title が出てしまう (攻撃者レビュー F4)。
  await stubSessions(page);
  await openSidebar(page);

  const row = rowFor(page, 'hostile-one');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.session-activity')).toHaveCount(0);
  const label = await row.getByRole('menuitem').getAttribute('aria-label');
  expect(label).not.toContain('undefined');
  expect(label).not.toContain('[object Object]');
});
