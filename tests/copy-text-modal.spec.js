import { test, expect, devices } from '@playwright/test';

// The mobile copy UI (#253). This replaced an on-canvas selection overlay
// (two draggable handles + a floating copy button) that had to recompute
// handle positions on every scroll -- and xterm scrolls once per line of
// output, so watching an agent stream queued one React update per line and
// never freed them.
//
// The replacement is a plain readOnly <textarea> in a modal, filled once when
// it opens from the server's own text view, scrolled to the bottom. iOS's
// native selection and copy menu work on a textarea directly, so there is
// nothing for the client to track and nothing to keep in sync -- which is the
// whole reason the leak cannot come back in this shape.
test.use({ ...devices['iPhone 13'], defaultBrowserType: 'chromium' });

const MARKER = 'copy-modal-marker-4821';

test('the copy modal opens with the terminal text, scrolled to the bottom', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.locator('.terminal-container')).toBeVisible();

  // A plain shell session (no claude/opencode dependency). Give its prompt
  // (rc/plugin startup) a moment to settle before typing.
  await page.waitForTimeout(2000);

  // Enough lines that the textarea must actually scroll for the marker --
  // the last line -- to be at the bottom.
  await page.keyboard.type(`seq 1 200; printf '${MARKER}\\n'`);
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');

  // Some interactive shell configs (async prompt redraws, live status
  // segments) race with scripted keystrokes independently of this feature.
  const printed = await page.waitForFunction((m) => {
    const rows = document.querySelectorAll('.xterm-rows > div');
    return [...rows].some((r) => r.textContent.includes(m));
  }, MARKER, { timeout: 15_000 }).then(() => true).catch(() => false);
  test.skip(!printed, 'shell did not echo the test command back (unrelated to the modal under test)');

  // The old UI's entry point was a "選択" toggle that put the terminal into a
  // mode; this one just opens a dialog.
  await expect(page.locator('.selection-mode-btn')).toHaveCount(0);
  await page.locator('.copy-text-btn').click();

  const area = page.locator('.copy-text-area');
  await expect(area).toBeVisible();

  // Filled from the server snapshot, not empty and not a spinner.
  await expect.poll(async () => (await area.inputValue()).includes(MARKER), {
    timeout: 10_000,
  }).toBe(true);

  // readOnly: it is for copying out, not editing in. (Native selection still
  // works on a readOnly textarea -- that is the point.)
  await expect(area).toHaveAttribute('readonly', /.*/);

  // Opened at the newest output: scrolled to the bottom, not the top.
  const atBottom = await area.evaluate((el) => {
    // scrollTop can land a pixel or two short of the exact maximum.
    const max = el.scrollHeight - el.clientHeight;
    return { max, scrollTop: el.scrollTop };
  });
  expect(atBottom.max).toBeGreaterThan(0); // it really did overflow
  expect(atBottom.scrollTop).toBeGreaterThanOrEqual(atBottom.max - 4);

  // No stray selection overlay survives from the retracted UI.
  await expect(page.locator('.selection-handle')).toHaveCount(0);
  await expect(page.locator('.selection-copy-btn')).toHaveCount(0);

  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(area).toHaveCount(0);
});
