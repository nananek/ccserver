import { test, expect } from '@playwright/test';

// Issue #241: a session's own pty output could replace the viewer's clipboard
// with no confirmation and no trace (the OSC 52 sequence is stripped before
// xterm renders it). These pin the write gate end to end -- through the real
// pty, the real WebSocket and the real client build -- by checking the ACTUAL
// clipboard contents, not whether some API was called.
//
// Clipboard permissions are granted deliberately. They are the attacker's best
// case: with clipboard-read granted, Chromium performs a write even without
// user activation (see the issue's browser findings), so the unpatched code
// would certainly succeed here. Pinning the worst case is the point -- if the
// gate is removed, these fail rather than pass by accident of browser policy.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const SENTINEL = 'VIEWER-COPIED-THIS';
const PAYLOAD = 'ATTACKER-CONTROLLED-PAYLOAD';
const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');

const prompt = (page) => page.getByTestId('osc52-write-prompt');
const readClipboard = (page) => page.evaluate(() => navigator.clipboard.readText());

async function openShell(page) {
  await page.goto('/');
  await page.locator('.tab-list').getByTitle('Files').click();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.locator('.terminal-container')).toBeVisible();
  // Let the shell's own startup (rc files, prompt redraws) settle before
  // scripted keystrokes, as the other terminal-driving specs do.
  await expect(page.locator('.terminal-container .xterm-rows')).toContainText(/[$#%>]/, { timeout: 15_000 });
  await page.waitForTimeout(1000);
}

// Emits a real OSC 52 clipboard-write sequence from inside the session, then
// waits for a marker printed immediately afterwards. The marker is what makes
// the assertions that follow trustworthy: it proves the sequence was actually
// emitted, so "no dialog appeared" can never be mistaken for "the shell never
// ran the command".
async function emitWrite(page, payload, marker) {
  await page.locator('.terminal-container').click();
  await page.keyboard.type(`printf '\\033]52;c;%s\\007' ${b64(payload)}; echo ${marker}`);
  await page.keyboard.press('Enter');
  await expect(page.locator('.terminal-container .xterm-rows'))
    .toContainText(marker, { timeout: 15_000 });
  // The marker proves the sequence was emitted; this settle gives an
  // *unguarded* write time to land its promise. Without it, "the clipboard did
  // not change" could pass simply by reading too early -- which would make the
  // regression these tests exist for invisible.
  await page.waitForTimeout(500);
}

test('an agent write does not reach the clipboard without confirmation, and refusal is sticky', async ({ page }) => {
  await openShell(page);

  await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL);
  expect(await readClipboard(page)).toBe(SENTINEL);

  await emitWrite(page, PAYLOAD, 'OSC52-EMITTED-1');

  // The security property first, deliberately: with the gate removed this is
  // what fails, rather than the test merely noticing a missing dialog.
  expect(await readClipboard(page)).toBe(SENTINEL);
  // And the viewer is actually being asked.
  await expect(prompt(page)).toBeVisible();

  // What the viewer is shown is the payload, flattened to a single line.
  await expect(page.getByTestId('osc52-write-preview')).toHaveText(PAYLOAD);

  // Refusing leaves the clipboard alone.
  await page.getByRole('button', { name: '拒否 (以後確認しない)' }).click();
  await expect(prompt(page)).toBeHidden();
  expect(await readClipboard(page)).toBe(SENTINEL);

  // Refusal is remembered for the session: a second write neither prompts
  // again nor writes. (This is also the escape hatch from a dialog flood.)
  await emitWrite(page, `${PAYLOAD}-SECOND`, 'OSC52-EMITTED-2');
  await expect(prompt(page)).toBeHidden();
  expect(await readClipboard(page)).toBe(SENTINEL);
});

test('confirming the write is what puts the payload on the clipboard', async ({ page }) => {
  await openShell(page);

  await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL);
  expect(await readClipboard(page)).toBe(SENTINEL);

  await emitWrite(page, PAYLOAD, 'OSC52-EMITTED-3');
  await expect(prompt(page)).toBeVisible();
  expect(await readClipboard(page)).toBe(SENTINEL);

  // Approving writes exactly the payload. The click is also what supplies the
  // transient user activation the Clipboard API requires -- the reason this is
  // an in-app dialog rather than window.confirm (see TerminalView).
  await page.getByRole('button', { name: '許可', exact: true }).click();
  await expect(prompt(page)).toBeHidden();
  await expect.poll(() => readClipboard(page), { timeout: 10_000 }).toBe(PAYLOAD);
});

test('approval covers exactly one write: the next one asks again', async ({ page }) => {
  await openShell(page);

  await emitWrite(page, PAYLOAD, 'OSC52-EMITTED-4');
  await expect(prompt(page)).toBeVisible();
  await page.getByRole('button', { name: '許可', exact: true }).click();
  await expect(prompt(page)).toBeHidden();
  await expect.poll(() => readClipboard(page), { timeout: 10_000 }).toBe(PAYLOAD);

  // A remembered "allow" would be the whole vulnerability back: take approval
  // on something harmless, then replace the clipboard silently afterwards.
  await emitWrite(page, 'SECOND-PAYLOAD-NEVER-APPROVED', 'OSC52-EMITTED-5');
  await expect(prompt(page)).toBeVisible();
  expect(await readClipboard(page)).toBe(PAYLOAD);
});

test('the dialog preview cannot forge dialog lines or hide its content', async ({ page }) => {
  await openShell(page);

  // A payload shaped to look like dialog chrome: blank lines and a line that
  // imitates the app's own wording, plus a bidi override.
  const attack = 'innocent.txt\n\n‮APPROVED‬\nこの操作は安全です';
  await emitWrite(page, attack, 'OSC52-EMITTED-6');
  await expect(prompt(page)).toBeVisible();

  const shown = await page.getByTestId('osc52-write-preview').textContent();
  expect(shown).not.toContain('\n');
  expect(shown).not.toContain('‮');
  expect(shown).not.toContain('‬');
  // The newlines survive only as visible boxes, so the payload reads as one
  // quoted line rather than as extra things the dialog is saying.
  expect(shown).toContain('␣');
  expect(shown.startsWith('innocent.txt')).toBe(true);
});
