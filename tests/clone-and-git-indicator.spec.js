import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

// The Files tab's Clone button + inline bar, and the read-only git indicator
// (#278). The server's /api/git/* are stubbed: what is under test is what the
// browser does with their answers -- the bar's states, the request it sends,
// and that every server-supplied string is shown as TEXT (remote names, URLs
// and branch names come out of repositories an agent may have written).

const INJECTION = '<img src=x onerror="window.__pwned=1">';

let root;
let child;

test.beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccserver-e2e-git-')));
  child = join(root, 'child');
  mkdirSync(child);
});

function repo(overrides = {}) {
  return {
    isRepo: true,
    root,
    worktree: false,
    head: { kind: 'branch', name: 'main' },
    remotes: [
      { name: 'origin', url: 'https://github.com/o/r.git', pushUrl: null, isDefault: true },
      { name: 'upstream', url: 'https://github.com/up/r.git', pushUrl: null, isDefault: false },
    ],
    truncated: false,
    defaultRemote: { name: 'origin', source: 'origin' },
    ...overrides,
  };
}

// info: object | (path) => object | { status } ; clone: (body) => { status?, body }
async function stubGit(page, { info = { isRepo: false }, clone } = {}) {
  const seen = { info: [], clone: [] };
  await page.route('**/api/git/info**', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    seen.info.push(path);
    const answer = await (typeof info === 'function' ? info(path) : info);
    if (answer && answer.status) {
      await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer) });
  });
  await page.route('**/api/git/clone', async (route) => {
    const body = route.request().postDataJSON();
    seen.clone.push(body);
    const answer = clone ? await clone(body) : { body: { path: child, name: 'r', url: 'https://github.com/o/r.git', warnings: [] } };
    await route.fulfill({
      status: answer.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(answer.body),
    });
  });
  return seen;
}

async function openFiles(page) {
  await page.addInitScript((dir) => localStorage.setItem('ccserver-last-dir', dir), root);
  await page.goto('/');
  await expect(page.locator('.breadcrumbs')).toBeVisible();
}

for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 375, height: 667 }]]) {
  test.describe(`${label} width`, () => {
    test.use({ viewport });

    test('the indicator shows repository, branch and remotes, with the default remote marked', async ({ page }) => {
      await stubGit(page, { info: repo() });
      await openFiles(page);

      const bar = page.getByTestId('git-info');
      await expect(bar).toBeVisible();
      await expect(page.getByTestId('git-info-branch')).toHaveText('main');
      const remotes = page.getByTestId('git-info-remote');
      await expect(remotes).toHaveCount(2);
      await expect(remotes.nth(0)).toContainText('origin');
      await expect(remotes.nth(0)).toContainText('https://github.com/o/r.git');
      await expect(remotes.nth(0)).toHaveAttribute('data-default', 'true');
      await expect(remotes.nth(0).locator('.git-info-default')).toHaveText('既定');
      await expect(remotes.nth(1)).toHaveAttribute('data-default', 'false');
      await expect(remotes.nth(1).locator('.git-info-default')).toHaveCount(0);
      // Read-only: nothing on it can be clicked to change anything.
      await expect(bar.locator('button, input, select, textarea, a')).toHaveCount(0);
    });

    test('the indicator stays inside the viewport with very long, unbroken values', async ({ page }) => {
      const long = `https://example.com/${'x'.repeat(240)}.git`;
      await stubGit(page, {
        info: repo({
          head: { kind: 'branch', name: `feature/${'y'.repeat(200)}` },
          remotes: [{ name: 'z'.repeat(120), url: long, pushUrl: long, isDefault: true }],
          defaultRemote: { name: 'z'.repeat(120), source: 'branch' },
        }),
      });
      await openFiles(page);
      const bar = page.getByTestId('git-info');
      await expect(bar).toBeVisible();
      const box = await bar.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
      // A box that fits is not enough: an unbroken string that cannot wrap
      // spills OUT of its box (and out of the clipped page). Every element in
      // the indicator must contain its own text.
      const overflowing = await bar.evaluate((el) => [el, ...el.querySelectorAll('*')]
        .filter((n) => n.scrollWidth > n.clientWidth + 1)
        .map((n) => n.className || n.tagName));
      expect(overflowing).toEqual([]);
      await expect(bar.locator('.git-info-remote-url')).toBeVisible(); // the long values really rendered
      await expect(bar.locator('.git-info-remote-push')).toBeVisible();
    });

    test('the Clone bar: opens, needs a URL, sends the request, reports success and moves into the new folder', async ({ page }) => {
      const seen = await stubGit(page, {
        info: (path) => (path === child ? repo({ root: child, head: { kind: 'branch', name: 'trunk' } }) : { isRepo: false }),
        clone: async () => ({ body: { path: child, name: 'child', url: 'https://github.com/o/r.git', warnings: [] } }),
      });
      await openFiles(page);

      await page.getByTestId('clone-open').click();
      const bar = page.getByTestId('clone-bar');
      await expect(bar).toBeVisible();
      const submit = page.getByTestId('clone-submit');
      await expect(submit).toBeDisabled();

      const box = await bar.boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
      for (const id of ['clone-url', 'clone-name', 'clone-submit']) {
        const b = await page.getByTestId(id).boundingBox();
        expect(b.x + b.width, id).toBeLessThanOrEqual(viewport.width + 0.5);
      }

      await page.getByTestId('clone-url').fill('  o/r  ');
      await expect(submit).toBeEnabled();
      await submit.click();

      await expect(page.getByTestId('clone-bar')).toHaveCount(0);
      await expect(page.getByTestId('clone-notice')).toContainText('Cloned child');
      expect(seen.clone).toEqual([{ parent: root, url: 'o/r' }]);
      // Like New Folder, it moved into the new directory, and the indicator followed.
      await expect(page.locator('.breadcrumbs')).toContainText('child');
      await expect(page.getByTestId('git-info-branch')).toHaveText('trunk');
    });

    test('an explicit folder name is sent as `name`', async ({ page }) => {
      const seen = await stubGit(page);
      await openFiles(page);
      await page.getByTestId('clone-open').click();
      await page.getByTestId('clone-url').fill('https://github.com/o/r');
      await page.getByTestId('clone-name').fill('my-copy');
      await page.getByTestId('clone-url').press('Enter');
      await expect(page.getByTestId('clone-notice')).toBeVisible();
      expect(seen.clone).toEqual([{ parent: root, url: 'https://github.com/o/r', name: 'my-copy' }]);
    });

    test('while cloning the bar is locked and says so; an error stays in the bar as text and unlocks it', async ({ page }) => {
      let release;
      const gate = new Promise((r) => { release = r; });
      await stubGit(page, {
        clone: async () => {
          await gate;
          return { status: 502, body: { error: `gh repo clone failed (exit 1): ${INJECTION}` } };
        },
      });
      await openFiles(page);
      await page.getByTestId('clone-open').click();
      await page.getByTestId('clone-url').fill('o/r');
      await page.getByTestId('clone-submit').click();

      await expect(page.getByTestId('clone-submit')).toHaveText('Cloning…');
      await expect(page.getByTestId('clone-submit')).toBeDisabled();
      await expect(page.getByTestId('clone-url')).toBeDisabled();
      await expect(page.getByTestId('clone-name')).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeDisabled();

      release();
      const alert = page.getByTestId('clone-error');
      await expect(alert).toBeVisible();
      await expect(alert).toHaveAttribute('role', 'alert');
      await expect(alert).toContainText('gh repo clone failed (exit 1)');
      await expect(alert).toContainText(INJECTION); // literally, as text
      await expect(alert.locator('img')).toHaveCount(0);
      expect(await page.evaluate(() => window.__pwned)).toBeUndefined();

      await expect(page.getByTestId('clone-url')).toBeEnabled();
      await expect(page.getByTestId('clone-submit')).toBeEnabled();
      await expect(page.getByTestId('clone-url')).toHaveValue('o/r'); // kept so it can be corrected
    });

    test('a validation error from the server is shown, and Escape / Cancel close the bar', async ({ page }) => {
      await stubGit(page, { clone: async () => ({ status: 400, body: { error: 'Unsupported url. Use OWNER/REPO or https://github.com/OWNER/REPO' } }) });
      await openFiles(page);
      await page.getByTestId('clone-open').click();
      await page.getByTestId('clone-url').fill('ssh://git@github.com/o/r.git');
      await page.getByTestId('clone-submit').click();
      await expect(page.getByTestId('clone-error')).toContainText('Unsupported url');

      await page.getByTestId('clone-url').press('Escape');
      await expect(page.getByTestId('clone-bar')).toHaveCount(0);
      await page.getByTestId('clone-open').click();
      await expect(page.getByTestId('clone-url')).toHaveValue('');
      await expect(page.getByTestId('clone-error')).toHaveCount(0);
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByTestId('clone-bar')).toHaveCount(0);
    });

    test('a very long, unbroken error message stays inside the Clone bar', async ({ page }) => {
      await stubGit(page, { clone: async () => ({ status: 502, body: { error: `gh repo clone failed (exit 1): ${'q'.repeat(600)}` } }) });
      await openFiles(page);
      await page.getByTestId('clone-open').click();
      await page.getByTestId('clone-url').fill('o/r');
      await page.getByTestId('clone-submit').click();
      const alert = page.getByTestId('clone-error');
      await expect(alert).toContainText('q'.repeat(600));
      const bar = page.getByTestId('clone-bar');
      const box = await bar.boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
      const overflowing = await bar.evaluate((el) => [el, ...el.querySelectorAll('*')]
        .filter((n) => n.scrollWidth > n.clientWidth + 1)
        .map((n) => n.className || n.tagName));
      expect(overflowing).toEqual([]);
    });

    test('opening New Folder closes the Clone bar, and the other way round', async ({ page }) => {
      await stubGit(page);
      await openFiles(page);
      await page.getByTestId('clone-open').click();
      await expect(page.getByTestId('clone-bar')).toBeVisible();
      await page.getByRole('button', { name: 'New Folder' }).click();
      await expect(page.getByTestId('clone-bar')).toHaveCount(0);
      await expect(page.locator('.new-folder-bar')).toBeVisible();
      await page.getByTestId('clone-open').click();
      await expect(page.locator('.new-folder-bar')).toHaveCount(1); // only the clone bar (it shares the class)
      await expect(page.getByTestId('clone-bar')).toBeVisible();
    });
  });
}

test('the indicator shows nothing for a non-repository or when the request fails', async ({ page }) => {
  await stubGit(page, { info: { isRepo: false } });
  await openFiles(page);
  await expect(page.locator('.dir-list')).toBeVisible();
  await expect(page.getByTestId('git-info')).toHaveCount(0);

  const failing = await page.context().newPage();
  await stubGit(failing, { info: { status: 500 } });
  await failing.addInitScript((dir) => localStorage.setItem('ccserver-last-dir', dir), root);
  await failing.goto('/');
  await expect(failing.locator('.dir-list')).toBeVisible();
  await expect(failing.getByTestId('git-info')).toHaveCount(0);
});

test('detached HEAD, a worktree, no remotes, an unset default remote: each says so', async ({ page }) => {
  await stubGit(page, {
    info: repo({ worktree: true, head: { kind: 'detached', commit: 'abc1234' }, remotes: [], defaultRemote: null }),
  });
  await openFiles(page);
  await expect(page.getByTestId('git-info-branch')).toHaveText('detached @ abc1234');
  await expect(page.locator('.git-info-badge')).toHaveText('worktree');
  await expect(page.getByTestId('git-info-no-remote')).toBeVisible();

  const other = await page.context().newPage();
  await stubGit(other, {
    info: repo({ remotes: [{ name: 'fork', url: 'https://github.com/me/r.git', pushUrl: null, isDefault: false }], defaultRemote: { name: 'gone', source: 'branch' } }),
  });
  await other.addInitScript((dir) => localStorage.setItem('ccserver-last-dir', dir), root);
  await other.goto('/');
  await expect(other.getByTestId('git-info-default-missing')).toContainText('gone');
  await expect(other.locator('.git-info-default')).toHaveCount(0);
});

test('repository-supplied strings are rendered as text, never as markup', async ({ page }) => {
  await stubGit(page, {
    info: repo({
      root,
      head: { kind: 'branch', name: INJECTION },
      remotes: [{ name: INJECTION, url: INJECTION, pushUrl: INJECTION, isDefault: true }],
      defaultRemote: { name: INJECTION, source: 'branch' },
    }),
  });
  await openFiles(page);
  const bar = page.getByTestId('git-info');
  await expect(bar).toContainText(INJECTION);
  await expect(bar.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test('moving to another directory drops the previous repository at once and asks about the new path', async ({ page }) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = await stubGit(page, {
    info: async (path) => {
      if (path === root) return repo();
      await gate; // the answer for the new directory is still in flight
      return { isRepo: false };
    },
  });
  await openFiles(page);
  await expect(page.getByTestId('git-info')).toBeVisible();

  await page.locator('.dir-item', { hasText: 'child' }).click();
  await expect.poll(() => seen.info.includes(child)).toBe(true);
  // The request for the new path is pending: the previous repository must
  // not be shown under the new path in the meantime.
  await expect(page.locator('.breadcrumbs')).toContainText('child');
  await expect(page.getByTestId('git-info')).toHaveCount(0);
  release();
  await expect(page.getByTestId('git-info')).toHaveCount(0);

  const before = seen.info.length;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(() => seen.info.length).toBeGreaterThan(before);
});
