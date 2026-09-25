import { test, expect } from '@playwright/test';
import { CLIPBOARD_ALLOW_DELAY_MS } from '../client/src/osc52.js';

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

// The dialog swaps its content in place when a newer write arrives (a burst
// collapses to the newest payload). A click is only meaningful for what was on
// screen when it BEGAN: press on A, have the session swap in B while the button
// is still held, release -- the click must not write B. It is refused, and the
// viewer is asked again about what is now shown.
//
// B is emitted by the shell 3s after A, so the swap lands deterministically
// while the button is held down; the poll on the preview text is what proves the
// swap really happened before the release.
test('a click acts only on the payload on screen when it began: a swap mid-click is refused and asked again', async ({ page }) => {
  await openShell(page);

  await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL);
  expect(await readClipboard(page)).toBe(SENTINEL);

  const A = 'A'.repeat(48);
  const B = 'B'.repeat(48);
  await page.locator('.terminal-container').click();
  await page.keyboard.type(
    `printf '\\033]52;c;%s\\007' ${b64(A)}; sleep 3; printf '\\033]52;c;%s\\007' ${b64(B)}; echo OSC52-EMITTED-7`,
  );
  await page.keyboard.press('Enter');

  const preview = page.getByTestId('osc52-write-preview');
  const allow = page.getByRole('button', { name: '許可', exact: true });
  await expect(preview).toHaveText(A);
  // 許可 is inert for a moment after the dialog appears (see the delay tests
  // below); a press has to begin once it is live for this to be about the swap.
  await expect(allow).toHaveAttribute('aria-disabled', 'false');

  // Press on 許可 while A is what the dialog shows...
  const box = await allow.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // ...the session replaces it with B while the button is still held...
  await expect(preview).toHaveText(B, { timeout: 10_000 });
  // ...and, after 許可 has gone live again on B, the release lands on a dialog
  // that now shows something else. (Released any sooner, the swap's own delay
  // would refuse the click; this holds long enough that only the "what was on
  // screen when the press began" check can.)
  await expect(allow).toHaveAttribute('aria-disabled', 'false');
  await page.mouse.up();
  await page.waitForTimeout(500);

  // Not written: the viewer never saw B when they pressed.
  expect(await readClipboard(page)).toBe(SENTINEL);
  // Asked again, about B, and told why nothing happened.
  await expect(prompt(page)).toBeVisible();
  await expect(preview).toHaveText(B);
  await expect(page.getByTestId('osc52-write-swapped')).toBeVisible();

  // A whole click on what is now on screen is a real decision, and writes B.
  await allow.click();
  await expect(prompt(page)).toBeHidden();
  await expect.poll(() => readClipboard(page), { timeout: 10_000 }).toBe(B);
});

// Invisible characters the sanitizer did not know about used to fill the preview
// budget: 130 U+180E in front of a tail left the dialog showing only "…" while
// "許可" wrote the hidden tail as well.
test('invisible characters cannot make the preview look empty while the payload carries a hidden tail', async ({ page }) => {
  await openShell(page);

  await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL);
  expect(await readClipboard(page)).toBe(SENTINEL);

  const masked = '\u180e'.repeat(130) + 'HIDDEN-TAIL';
  await emitWrite(page, masked, 'OSC52-EMITTED-8');
  await expect(prompt(page)).toBeVisible();
  expect(await readClipboard(page)).toBe(SENTINEL);

  // The invisible run is not shown and does not eat the budget: the real
  // content is what the viewer reads.
  expect(await page.getByTestId('osc52-write-preview').textContent()).toBe('HIDDEN-TAIL');

  await page.getByRole('button', { name: '許可', exact: true }).click();
  await expect.poll(() => readClipboard(page), { timeout: 10_000 }).toBe(masked);
});

test('a payload with nothing visible in it says so instead of showing a blank box', async ({ page }) => {
  await openShell(page);

  // Braille blank, Hangul filler, a tag character and blanks only: every one
  // of them renders as nothing or as blank space.
  const blank = '\u2800'.repeat(30) + '\u3164'.repeat(30) + '\u{E0041}\u{E007F}' + ' '.repeat(40);
  await emitWrite(page, blank, 'OSC52-EMITTED-9');
  await expect(prompt(page)).toBeVisible();

  const shown = (await page.getByTestId('osc52-write-preview').textContent()) ?? '';
  expect(shown).toContain('見える文字がありません');
  // It states how much is nevertheless about to be written.
  expect(shown).toContain(String(Array.from(blank).length));
});


// 許可 is inert for CLIPBOARD_ALLOW_DELAY_MS after the dialog appears and after
// its content is swapped (the agent picks the moment: a click aimed at whatever
// was under the pointer, or a press that began before a swap, must not land on a
// decision nobody had time to read). 拒否 is never inert.
//
// "Immediately" is measured from INSIDE the page. A MutationObserver reacts in
// the same task as the render that changed the dialog and acts on it right then,
// so none of this depends on how quickly Playwright's own round trips get there
// (its polling can lag the dialog by more than the delay). Every observation --
// the preview text, aria-disabled, the computed opacity, a timestamp -- is
// logged for the assertions.
async function watchDialog(page, onContent) {
  await page.evaluate((initial) => {
    const probe = { log: [], onContent: initial };
    window.__osc52Probe = probe;
    let lastText = null;
    let lastDisabled = null;
    new MutationObserver(() => {
      const dialog = document.querySelector('[data-testid="osc52-write-prompt"]');
      const allow = dialog?.querySelector('[data-testid="osc52-write-allow"]') ?? null;
      const deny = dialog?.querySelector('.btn-secondary') ?? null;
      const text = dialog?.querySelector('[data-testid="osc52-write-preview"]')?.textContent ?? null;
      const disabled = allow ? allow.getAttribute('aria-disabled') : null;
      if (text === lastText && disabled === lastDisabled) return;
      const contentChanged = text !== lastText;
      lastText = text;
      lastDisabled = disabled;
      if (text === null) return;
      probe.log.push({
        kind: contentChanged ? 'content' : 'state',
        text,
        disabled,
        opacity: getComputedStyle(allow).opacity,
        at: performance.now(),
      });
      if (!contentChanged) return;
      const action = probe.onContent;
      if (action === 'click-allow') allow.click();
      if (action === 'click-deny') deny.click();
      if (action === 'press-allow') {
        allow.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0 }));
      }
      if (action === 'key-allow') {
        allow.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-disabled'] });
  }, onContent);
}
const setOnContent = (page, action) => page.evaluate((a) => { window.__osc52Probe.onContent = a; }, action);
const probeLog = (page) => page.evaluate(() => window.__osc52Probe.log);
const allowButton = (page) => page.getByTestId('osc52-write-allow');

// Types into the shell WITHOUT clicking the terminal: while the dialog is up its
// backdrop covers it, and a click there would dismiss the dialog.
async function typeInShell(page, command) {
  await page.locator('.terminal-container textarea').first().focus();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}
const osc = (payload) => `printf '\\033]52;c;%s\\007' ${b64(payload)}`;
const shellDone = (page, marker) => expect(page.locator('.terminal-container .xterm-rows')).toContainText(marker, { timeout: 15_000 });

test('許可 is inert when the dialog appears, looks and reports it, and works once the delay is over', async ({ page }) => {
  await openShell(page);
  await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL);
  // A click made in the very task that renders the dialog.
  await watchDialog(page, 'click-allow');

  await typeInShell(page, `${osc(PAYLOAD)}; echo OSC52-EMITTED-10`);
  await expect(prompt(page)).toBeVisible();
  await shellDone(page, 'OSC52-EMITTED-10');
  await expect(allowButton(page)).toHaveAttribute('aria-disabled', 'false', { timeout: CLIPBOARD_ALLOW_DELAY_MS + 5_000 });

  // It came up inert, and looked it; then it went live, and looked it.
  const log = await probeLog(page);
  expect(log.map((e) => [e.kind, e.disabled, e.opacity])).toEqual([
    ['content', 'true', '0.5'],
    ['state', 'false', '1'],
  ]);
  // The delay is the constant, not "a moment": it went live no sooner.
  expect(log[1].at - log[0].at).toBeGreaterThanOrEqual(CLIPBOARD_ALLOW_DELAY_MS - 30);

  // The click made while inert did nothing: nothing written, dialog still asking.
  expect(await readClipboard(page)).toBe(SENTINEL);
  await expect(prompt(page)).toBeVisible();

  // After the delay a real click is a decision like any other.
  await allowButton(page).click();
  await expect(prompt(page)).toBeHidden();
  await expect.poll(() => readClipboard(page), { timeout: 10_000 }).toBe(PAYLOAD);
});

test('a swap starts the delay again: a click right after B replaces A does nothing, even though 許可 was live on A', async ({ page }) => {
  await openShell(page);
  await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL);
  await watchDialog(page, 'click-allow');

  const A = 'A'.repeat(48);
  const B = 'B'.repeat(48);
  // B arrives 1.5s after A: long after A went live, so B's swap is what is under test.
  await typeInShell(page, `${osc(A)}; sleep 1.5; ${osc(B)}; echo OSC52-EMITTED-11`);
  await expect(page.getByTestId('osc52-write-preview')).toHaveText(B, { timeout: 15_000 });
  await shellDone(page, 'OSC52-EMITTED-11');
  await expect(allowButton(page)).toHaveAttribute('aria-disabled', 'false', { timeout: CLIPBOARD_ALLOW_DELAY_MS + 5_000 });

  // A came up inert and went live; B replaced it inert, in the same render as
  // the new text (there is no moment with B shown and 許可 still live), and went
  // live in its turn. A click was made in the task of each content change.
  const log = await probeLog(page);
  expect(log.map((e) => `${e.kind}:${e.text[0]}:${e.disabled}`)).toEqual([
    'content:A:true', 'state:A:false', 'content:B:true', 'state:B:false',
  ]);

  expect(await readClipboard(page)).toBe(SENTINEL);
  await expect(prompt(page)).toBeVisible();
  await allowButton(page).click();
  await expect.poll(() => readClipboard(page), { timeout: 10_000 }).toBe(B);
});

test('swaps that keep coming keep 許可 inert for as long as they do', async ({ page }) => {
  await openShell(page);
  await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL);
  await watchDialog(page, 'click-allow');

  // Six writes 0.2s apart: each lands well inside the delay of the one before.
  const burst = [1, 2, 3, 4, 5, 6].map((i) => osc(`burst-${i}`)).join('; sleep 0.2; ');
  await typeInShell(page, `${burst}; echo OSC52-EMITTED-12`);
  await expect(page.getByTestId('osc52-write-preview')).toHaveText('burst-6', { timeout: 15_000 });
  await shellDone(page, 'OSC52-EMITTED-12');
  await expect(allowButton(page)).toHaveAttribute('aria-disabled', 'false', { timeout: CLIPBOARD_ALLOW_DELAY_MS + 5_000 });

  // 許可 was never live while the burst went on: it went live once, after the last one.
  const log = await probeLog(page);
  const contents = log.filter((e) => e.kind === 'content');
  const live = log.filter((e) => e.disabled === 'false');
  expect(contents.length).toBeGreaterThanOrEqual(2);
  expect(live).toHaveLength(1);
  expect(log.at(-1)).toMatchObject({ kind: 'state', text: 'burst-6', disabled: 'false' });
  expect(log.slice(0, -1).every((e) => e.disabled === 'true')).toBe(true);

  // A burst is still one dialog, on the newest payload, and nothing was written.
  expect(await readClipboard(page)).toBe(SENTINEL);
  await allowButton(page).click();
  await expect.poll(() => readClipboard(page), { timeout: 10_000 }).toBe('burst-6');
});

// Clicks 許可 in the very task that puts the dialog on screen (the moment its
// tab is shown), and records what aria-disabled said at that moment. Arm it
// while the dialog is hidden; read the result from window.__osc52Shown.
async function clickAllowWhenShown(page) {
  await page.evaluate(() => {
    const allow = document.querySelector('[data-testid="osc52-write-allow"]');
    const shown = (window.__osc52Shown = { disabled: null });
    new MutationObserver((_, observer) => {
      if (allow.getClientRects().length === 0) return; // still hidden
      shown.disabled = allow.getAttribute('aria-disabled');
      allow.click();
      observer.disconnect();
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  });
}

// An inactive tab stays mounted under display:none and still receives writes, so
// its dialog can come up where nobody can see it. The delay must be spent on
// screen: if it ran out unseen, 許可 would already be live in the very frame the
// viewer switches to that tab, and a click that was on its way there (a double
// click on the tab, a click made just as the tab is shown) would decide.
test('the delay is spent on screen: a dialog that came up while its tab was hidden is inert when the tab is shown', async ({ page }) => {
  await openShell(page);
  await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL);

  // Terminals are not in the tab bar; the open one is reached from the sidebar.
  const terminalItem = page.locator('.left-sidebar [data-section="opened"] .session-menu-item').first();
  // The write is 1s away, so it lands after the terminal has been left.
  await typeInShell(page, `sleep 1; ${osc(PAYLOAD)}`);
  await page.locator('.tab-list').getByTitle('Files').click();
  await expect(page.locator('.terminal-container')).toBeHidden();

  // The dialog exists but is not on screen...
  await expect(prompt(page)).toBeAttached();
  await expect(prompt(page)).toBeHidden();
  // ...and stays that way for longer than the delay (the time that must not count).
  await page.waitForTimeout(CLIPBOARD_ALLOW_DELAY_MS + 500);

  await clickAllowWhenShown(page);
  await terminalItem.click();
  await expect(prompt(page)).toBeVisible();

  expect(await page.evaluate(() => window.__osc52Shown.disabled)).toBe('true');
  expect(await readClipboard(page)).toBe(SENTINEL);
  await expect(prompt(page)).toBeVisible();

  // The delay runs from when it is shown, so it does become live, and works.
  await expect(allowButton(page)).toHaveAttribute('aria-disabled', 'false', { timeout: CLIPBOARD_ALLOW_DELAY_MS + 5_000 });
  await allowButton(page).click();
  await expect.poll(() => readClipboard(page), { timeout: 10_000 }).toBe(PAYLOAD);
});

// The count is not banked. 許可 having gone live once does not survive the
// tab being hidden: the same click-as-the-tab-is-shown lands on it otherwise.
test('the delay is spent again when the tab is shown again: a dialog that had gone live is inert on return', async ({ page }) => {
  await openShell(page);
  await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL);

  await emitWrite(page, PAYLOAD, 'OSC52-EMITTED-19');
  await expect(prompt(page)).toBeVisible();
  // It went live while it was on screen...
  await expect(allowButton(page)).toHaveAttribute('aria-disabled', 'false', { timeout: CLIPBOARD_ALLOW_DELAY_MS + 5_000 });

  // ...and the tab is left, then come back to. The dialog's backdrop covers the
  // tab bar, so the switch away is one that does not go through the pointer
  // (a notification click, a tab opened by the session's own group): dispatched
  // straight to the tab.
  const terminalItem = page.locator('.left-sidebar [data-section="opened"] .session-menu-item').first();
  await page.locator('.tab-list').getByTitle('Files').dispatchEvent('click');
  await expect(page.locator('.terminal-container')).toBeHidden();
  await expect(prompt(page)).toBeHidden();

  await clickAllowWhenShown(page);
  await terminalItem.click();
  // First what 許可 said when the dialog came back: a live one has already been
  // clicked (and has written and closed the dialog) by the time anything else
  // here could look.
  await expect.poll(() => page.evaluate(() => window.__osc52Shown.disabled)).toBe('true');
  expect(await readClipboard(page)).toBe(SENTINEL);
  await expect(prompt(page)).toBeVisible();

  await expect(allowButton(page)).toHaveAttribute('aria-disabled', 'false', { timeout: CLIPBOARD_ALLOW_DELAY_MS + 5_000 });
  await allowButton(page).click();
  await expect.poll(() => readClipboard(page), { timeout: 10_000 }).toBe(PAYLOAD);
});

test('拒否 is never inert: refusing during the delay closes the dialog and stays refused', async ({ page }) => {
  await openShell(page);
  await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL);
  await watchDialog(page, 'click-deny');

  await typeInShell(page, `${osc(PAYLOAD)}; echo OSC52-EMITTED-13`);
  await shellDone(page, 'OSC52-EMITTED-13');
  // shellDone can pass on the echoed command line, before the sequence has run:
  // wait for the dialog to have come up (and been refused in that same task),
  // or the check below could succeed only because it was never shown.
  await expect.poll(async () => (await probeLog(page)).length).toBe(1);
  await expect(prompt(page)).toBeHidden();
  // The refusal was made while 許可 was still inert.
  expect((await probeLog(page)).map((e) => [e.kind, e.disabled])).toEqual([['content', 'true']]);
  expect(await readClipboard(page)).toBe(SENTINEL);

  // And it is the sticky refusal: the next write neither asks nor writes.
  await setOnContent(page, null);
  await emitWrite(page, `${PAYLOAD}-SECOND`, 'OSC52-EMITTED-14');
  await expect(prompt(page)).toBeHidden();
  expect(await readClipboard(page)).toBe(SENTINEL);
});

test('a press that began while 許可 was inert does not count when it is released after the delay', async ({ page }) => {
  await openShell(page);
  await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL);

  // Pointer: pressed in the task that renders the dialog, released (as a click) once live.
  await watchDialog(page, 'press-allow');
  await typeInShell(page, `${osc(PAYLOAD)}; echo OSC52-EMITTED-15`);
  await shellDone(page, 'OSC52-EMITTED-15');
  await expect(allowButton(page)).toHaveAttribute('aria-disabled', 'false', { timeout: CLIPBOARD_ALLOW_DELAY_MS + 5_000 });
  await allowButton(page).dispatchEvent('click');
  await page.waitForTimeout(300);
  expect(await readClipboard(page)).toBe(SENTINEL);
  await expect(prompt(page)).toBeVisible();

  // Keyboard: the same, for a key that went down while inert (a newer write swaps the content in).
  await setOnContent(page, 'key-allow');
  await typeInShell(page, `${osc(`${PAYLOAD}-2`)}; echo OSC52-EMITTED-16`);
  await shellDone(page, 'OSC52-EMITTED-16');
  await expect(page.getByTestId('osc52-write-preview')).toHaveText(`${PAYLOAD}-2`);
  await expect(allowButton(page)).toHaveAttribute('aria-disabled', 'false', { timeout: CLIPBOARD_ALLOW_DELAY_MS + 5_000 });
  await allowButton(page).dispatchEvent('click');
  await page.waitForTimeout(300);
  expect(await readClipboard(page)).toBe(SENTINEL);
  await expect(prompt(page)).toBeVisible();

  // A fresh, whole click is still a decision.
  await allowButton(page).click();
  await expect.poll(() => readClipboard(page), { timeout: 10_000 }).toBe(`${PAYLOAD}-2`);
});

test('once the delay is over 許可 works from the keyboard: Enter and Space', async ({ page }) => {
  await openShell(page);

  for (const [key, payload, marker] of [['Enter', `${PAYLOAD}-ENTER`, 'OSC52-EMITTED-17'], [' ', `${PAYLOAD}-SPACE`, 'OSC52-EMITTED-18']]) {
    await typeInShell(page, `${osc(payload)}; echo ${marker}`);
    await shellDone(page, marker);
    await expect(allowButton(page)).toHaveAttribute('aria-disabled', 'false', { timeout: CLIPBOARD_ALLOW_DELAY_MS + 5_000 });
    await allowButton(page).focus();
    await page.keyboard.press(key);
    await expect(prompt(page)).toBeHidden();
    await expect.poll(() => readClipboard(page), { timeout: 10_000 }).toBe(payload);
  }
});
