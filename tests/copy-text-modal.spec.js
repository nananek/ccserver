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

// What follows drives the modal through a real pty and the real /text route,
// so it covers what the unit tests around stripAnsi/sessionOutputText cannot:
// that the bytes a program actually printed are what the operator gets.

// A plain shell session on the Terminal tab, given a moment for its prompt
// (rc/plugin startup) to settle before anything is typed.
async function openShell(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.locator('.terminal-container')).toBeVisible();
  await page.waitForTimeout(2000);
}

// Whether the terminal's rendered rows show `text` -- the shell echoing the
// command is not enough, so callers pass text only the OUTPUT contains.
function screenShows(page, text) {
  return page.waitForFunction((m) => {
    const rows = document.querySelectorAll('.xterm-rows > div');
    return [...rows].some((r) => r.textContent.includes(m));
  }, text, { timeout: 15_000 }).then(() => true).catch(() => false);
}

// The modal's text is what gets copied out with the OS's own selection menu,
// and it is filled from whatever the terminal's program printed. Nothing in it
// may be an escape byte, a control byte or a bidi control (#265 attack review,
// F1). The old path took the text out of xterm's parsed buffer, which cannot
// contain them; the server's text view has to hold that line itself.
test('the copy modal holds no escape, control or bidi bytes, however the terminal was written to', async ({ page }) => {
  await openShell(page);

  // Octal escapes so the same line works in bash and zsh. Each row is one shape
  // the old stripAnsi let through: colon-separated SGR, a space-intermediate CSI,
  // tmux's DCS passthrough, CR / BS / BEL / SOH / VT, and a right-to-left
  // override (U+202E, bytes 342 200 256) closed by U+202C. The last line is
  // built by printf so that the typed command never contains it: it appears in
  // the terminal only once the OUTPUT has been printed.
  await page.keyboard.type(
    'printf \'COLON\\033[38:2::255:0:0m-SGR\\033[0m\\n'
    + 'CURSOR\\033[1 qSTYLE\\n'
    + 'DCS:\\033Ptmux;\\033\\033]0;x\\007\\033\\\\AFTER-DCS\\n'
    + 'C0:A\\015B\\010C\\007D\\001E\\013F\\n'
    + 'safe\\342\\200\\256spoiled\\342\\200\\254\\n'
    + 'END-%s\\n\' MARK',
  );
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  const printed = await screenShows(page, 'END-MARK');
  test.skip(!printed, 'shell did not run the test command (unrelated to the modal under test)');

  await page.locator('.copy-text-btn').click();
  const area = page.locator('.copy-text-area');
  await expect.poll(async () => (await area.inputValue()).includes('END-MARK'), {
    timeout: 10_000,
  }).toBe(true);

  const value = await area.inputValue();
  // The output, cleaned: every sequence gone whole (no `[38:2::...` left behind)
  // and CRLF read as a newline.
  expect(value).toContain('COLON-SGR\nCURSORSTYLE\nDCS:AFTER-DCS\nC0:ABCDEF\nsafespoiled\nEND-MARK');
  expect(value).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]|\p{Bidi_Control}/u);
});

// AUTH_MODE=token gates every /api request on `Authorization: Bearer <token>`,
// and the client attaches it in authFetch. The modal's fetch went around
// authFetch, so in token mode it was answered 401 and the modal opened empty
// with no hint why (#265 attack review, F2). This suite's server runs in `none`
// mode, where the header is ignored -- so the token gate is stood in for at the
// network layer: the route answers 401 unless the header is there, exactly as
// the real gate does, and the test asserts what the browser sent.
test('the copy modal authenticates its fetch: it sends the stored token and shows the 200 body', async ({ page }) => {
  const TOKEN = 'e2e-token-265';
  const BODY = 'token-mode-body-7741';
  await page.addInitScript((t) => localStorage.setItem('ccserver-token', t), TOKEN);

  const seen = [];
  await page.route('**/api/sessions/*/text', async (route) => {
    const auth = route.request().headers().authorization ?? null;
    seen.push(auth);
    if (auth !== `Bearer ${TOKEN}`) {
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Unauthorized' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: `${BODY}\n`, truncated: false }) });
  });

  await openShell(page);
  // Anything on screen means the session is attached (its id is known), which is
  // what the button needs; the modal's content here comes from the route above.
  const attached = await page.waitForFunction(() => {
    const rows = document.querySelectorAll('.xterm-rows > div');
    return [...rows].some((r) => r.textContent.trim() !== '');
  }, null, { timeout: 15_000 }).then(() => true).catch(() => false);
  test.skip(!attached, 'shell printed nothing, so the session never attached (unrelated to the modal under test)');

  await page.locator('.copy-text-btn').click();
  const area = page.locator('.copy-text-area');
  await expect(area).toBeVisible();
  await expect.poll(async () => (await area.inputValue()).includes(BODY), { timeout: 10_000 }).toBe(true);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen).toEqual(seen.map(() => `Bearer ${TOKEN}`));
});
