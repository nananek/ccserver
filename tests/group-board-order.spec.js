import { test, expect } from '@playwright/test';

// The group tab's Docs (publish_doc board) and Files panels: newest first,
// creation/update times visible, nothing clipped at desktop or phone width.
//
// The group APIs are stubbed instead of creating a real group: a real one
// needs bwrap + the agent CLIs (POST /api/groups spawns claude+opencode), so
// a spec built on it is skipped on plain CI runners -- and this UI needs
// none of that, since it only renders what /api/groups/:id/{docs,files}
// return. A group with no members mounts GroupTabView without a terminal.
// What the server stores (createdAt surviving an overwrite, the publishedAt
// fallback for old data) is pinned by the node tests, not here.
//
// A fixed locale + zone makes the displayed time an exact literal, so the
// assertions read the rendered text rather than re-running the app's
// formatter.
test.use({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });

const GROUP_ID = 'e2e-board-group';
const CWD = '/tmp/e2e-board-project';
const at = (iso) => Date.parse(iso);

// Listed the way the server does: first-publish / first-upload order, i.e.
// NOT the order the panels are expected to show.
const HOSTILE_DOC_KEY = '<img src=x onerror="window.__xss=1">';
const LONG_DOC_KEY = 'notes/2026/a-very-long-document-key-that-cannot-fit-on-a-phone-screen-untruncated';
const docsFixture = () => [
  // Created first, touched last -> must come first.
  { key: 'design-notes', publishedBy: 'workerA', size: 1536, createdAt: at('2026-01-01T00:00:00Z'), publishedAt: at('2026-09-20T03:04:05Z') },
  { key: 'old-plan', publishedBy: 'workerB', size: 10, createdAt: at('2026-03-02T01:02:03Z'), publishedAt: at('2026-03-02T01:02:03Z') },
  { key: HOSTILE_DOC_KEY, publishedBy: 'workerA', size: 20, createdAt: at('2026-09-01T00:00:00Z'), publishedAt: at('2026-09-10T00:00:00Z') },
  // A server that predates createdAt: created falls back to published.
  { key: LONG_DOC_KEY, publishedBy: 'workerB', size: 30, publishedAt: at('2026-09-15T12:00:00Z') },
];
const EXPECTED_DOC_ORDER = ['design-notes', LONG_DOC_KEY, HOSTILE_DOC_KEY, 'old-plan'];

const filesFixture = () => [
  { id: 'f1', name: 'report.pdf', size: 2048, mimeType: 'application/pdf', direction: 'user', publishedBy: null, publishedAt: at('2026-09-01T00:00:00Z') },
  { id: 'f2', name: '<img src=x onerror=window.__xss=2>.png', size: 512, mimeType: 'image/png', direction: 'agent', publishedBy: 'workerA', publishedAt: at('2026-09-21T00:00:00Z') },
  { id: 'f3', name: 'sheet.xlsx', size: 4096, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', direction: 'agent', publishedBy: 'workerB', publishedAt: at('2026-09-10T00:00:00Z') },
];

const json = (route, body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });

// Serves the stubbed group and returns hit counters, so a test can prove its
// fixture was actually consumed before it trusts what it reads back.
async function stubGroup(page, { docs = [], files = [] } = {}) {
  const state = { docs, files, docsHits: 0, filesHits: 0, contentKeys: [] };
  await page.route((url) => url.pathname.startsWith('/api/groups'), async (route) => {
    const req = route.request();
    const { pathname, searchParams } = new URL(req.url());
    if (req.method() !== 'GET') return route.fallback();
    if (pathname === '/api/groups') {
      return json(route, { groups: [{ groupId: GROUP_ID, cwd: CWD, memberCount: 3, liveCount: 3 }] });
    }
    if (pathname === `/api/groups/${GROUP_ID}`) {
      return json(route, { groupId: GROUP_ID, cwd: CWD, members: [], currentTurn: null });
    }
    if (pathname === `/api/groups/${GROUP_ID}/docs`) {
      state.docsHits++;
      return json(route, { docs: state.docs });
    }
    if (pathname === `/api/groups/${GROUP_ID}/docs/content`) {
      const key = searchParams.get('key');
      state.contentKeys.push(key);
      const d = state.docs.find((x) => x.key === key);
      return json(route, { ...d, content: '# preview body' });
    }
    if (pathname === `/api/groups/${GROUP_ID}/files`) {
      state.filesHits++;
      return json(route, { files: state.files });
    }
    return route.fallback();
  });
  return state;
}

async function openGroupTab(page) {
  await page.goto('/');
  const item = page.locator('.left-sidebar [data-section="unopened-groups"] .session-menu-item', { hasText: 'e2e-board-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.locator('.session-menu-select').click();
  await expect(page.locator('.group-docs-trigger-btn')).toBeVisible();
}

// The "text got cut off" failure, in both shapes it can take: the element
// truncates its own text (overflow:hidden + ellipsis on the time itself, which
// is how the time was lost before), or it sits (partly) outside an ancestor
// that clips it. Horizontal only -- the list legitimately scrolls vertically.
async function expectNotClippedHorizontally(locator) {
  const clipped = await locator.evaluate((node) => {
    if (node.scrollWidth > node.clientWidth + 1) return 'truncates its own text';
    const r = node.getBoundingClientRect();
    for (let a = node.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === 'visible') continue;
      const ar = a.getBoundingClientRect();
      if (r.left < ar.left - 0.5 || r.right > ar.right + 0.5) return `clipped by ancestor <${a.tagName.toLowerCase()} class="${a.className}">`;
    }
    return null;
  });
  expect(clipped, 'time text is cut off').toBeNull();
}

// Every row's times are on screen, inside the dialog, clear of the row's
// buttons, and the page/dialog do not scroll sideways.
async function expectLayoutIntact(page, dialogSel, itemSel, timeSel, expectedRows) {
  const dialog = page.locator(dialogSel);
  const rows = dialog.locator(itemSel);
  await expect(rows).toHaveCount(expectedRows);
  const dialogBox = await dialog.boundingBox();
  for (let i = 0; i < expectedRows; i++) {
    const row = rows.nth(i);
    const btnBox = await row.locator('button').first().boundingBox();
    const times = row.locator(timeSel);
    const n = await times.count();
    expect(n).toBeGreaterThan(0);
    for (let j = 0; j < n; j++) {
      const t = times.nth(j);
      await expect(t).toBeVisible();
      await expectNotClippedHorizontally(t);
      const box = await t.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(dialogBox.x - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 0.5);
      expect(box.x + box.width, 'time overlaps the row buttons').toBeLessThanOrEqual(btnBox.x + 0.5);
    }
  }
  const overflow = await page.evaluate((sel) => {
    const d = document.querySelector(sel);
    const list = d.querySelector('[class$="-list"]');
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      dialog: d.scrollWidth - d.clientWidth,
      list: list.scrollWidth - list.clientWidth,
    };
  }, dialogSel);
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.dialog).toBeLessThanOrEqual(0);
  expect(overflow.list).toBeLessThanOrEqual(0);
}

const WIDTHS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 375, height: 667 },
];

test('Docs: newest update first, created/updated times shown, an overwrite moves the doc to the top, keys render as text', async ({ page }) => {
  const stub = await stubGroup(page, { docs: docsFixture() });
  await openGroupTab(page);
  await page.locator('.group-docs-trigger-btn').click();

  const dialog = page.locator('.group-docs-dialog');
  const rows = dialog.locator('.group-docs-item');
  await expect(rows).toHaveCount(4);
  expect(stub.docsHits, 'the stubbed /docs response was consumed').toBeGreaterThan(0);

  // Order: last update descending -- not the server's first-publish order.
  await expect(dialog.locator('.group-docs-name')).toHaveText(EXPECTED_DOC_ORDER);

  // Exact local-time text, created and updated kept apart.
  const first = rows.nth(0);
  await expect(first.locator('.group-docs-created')).toHaveText('作成 2026/1/1 9:00:00');
  await expect(first.locator('.group-docs-updated')).toHaveText('更新 2026/9/20 12:04:05');
  // No createdAt from the server -> falls back to the published time.
  await expect(rows.nth(1).locator('.group-docs-created')).toHaveText('作成 2026/9/15 21:00:00');
  await expect(rows.nth(1).locator('.group-docs-updated')).toHaveText('更新 2026/9/15 21:00:00');

  // Agent-chosen keys are text, never markup.
  await expect(rows.nth(2).locator('.group-docs-name')).toHaveText(HOSTILE_DOC_KEY);
  await expect(dialog.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  for (const vp of WIDTHS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await expectLayoutIntact(page, '.group-docs-dialog', '.group-docs-item', '.group-docs-time', 4);
  }
  await page.setViewportSize({ width: WIDTHS[0].width, height: WIDTHS[0].height });

  // Overwrite "old-plan": the server keeps createdAt, moves publishedAt.
  stub.docs = stub.docs.map((d) => (d.key === 'old-plan' ? { ...d, publishedAt: at('2026-09-25T00:00:00Z') } : d));
  await expect(dialog.locator('.group-docs-name').first()).toHaveText('old-plan', { timeout: 10_000 });
  const moved = dialog.locator('.group-docs-item').first();
  await expect(moved.locator('.group-docs-created')).toHaveText('作成 2026/3/2 10:02:03');
  await expect(moved.locator('.group-docs-updated')).toHaveText('更新 2026/9/25 9:00:00');
  await expect(dialog.locator('.group-docs-name')).toHaveText(['old-plan', 'design-notes', LONG_DOC_KEY, HOSTILE_DOC_KEY]);

  // The preview header carries the same two times.
  await dialog.locator('.group-docs-item', { hasText: 'design-notes' }).getByRole('button', { name: 'View' }).click();
  const meta = page.locator('.file-preview-meta');
  await expect(meta).toContainText('作成 2026/1/1 9:00:00');
  await expect(meta).toContainText('更新 2026/9/20 12:04:05');
  expect(stub.contentKeys).toEqual(['design-notes']);
});

test('Files: newest upload first, agent/browser time labelled, names render as text, nothing clipped', async ({ page }) => {
  const stub = await stubGroup(page, { files: filesFixture() });
  await openGroupTab(page);
  await page.locator('.group-files-trigger-btn').click();

  const dialog = page.locator('.group-files-dialog');
  const rows = dialog.locator('.group-files-item');
  await expect(rows).toHaveCount(3);
  expect(stub.filesHits, 'the stubbed /files response was consumed').toBeGreaterThan(0);

  // Server order is f1, f2, f3; the panel shows newest first.
  await expect(dialog.locator('.group-files-name')).toHaveText(['<img src=x onerror=window.__xss=2>.png', 'sheet.xlsx', 'report.pdf']);

  // Files are never overwritten, so there is one time; its label says how the file got here.
  await expect(rows.nth(0).locator('.group-files-time')).toHaveText('公開 2026/9/21 9:00:00');
  await expect(rows.nth(1).locator('.group-files-time')).toHaveText('公開 2026/9/10 9:00:00');
  await expect(rows.nth(2).locator('.group-files-time')).toHaveText('アップロード 2026/9/1 9:00:00');

  await expect(dialog.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  for (const vp of WIDTHS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await expectLayoutIntact(page, '.group-files-dialog', '.group-files-item', '.group-files-time', 3);
  }
});
