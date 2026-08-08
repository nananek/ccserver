import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

// The sandbox needs bwrap on the host; without it the server silently falls
// back to unsandboxed launches and the badge/re-init assertions below can't
// be meaningful.
const sandboxAvailable = existsSync('/usr/bin/bwrap');

// A unique working directory per test so sessions never collide in the
// server's session list (each test leaves its shell running behind).
const newCwd = () => mkdtempSync(join(tmpdir(), 'ccserver-e2e-'));

// Open a raw ws to the terminal endpoint from inside the page, issue an
// `init` for a sandboxed shell, and return the created sessionId.
async function openSandboxedShell(page, cwd) {
  return page.evaluate(async (cwd) => {
    const ws = new WebSocket(`ws://${location.host}/ws/terminal`);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const sessionId = await new Promise((res, rej) => {
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'session') res(m.sessionId);
        if (m.type === 'error') rej(new Error(m.message));
      };
      ws.send(JSON.stringify({
        type: 'init', cwd, cols: 80, rows: 24, shell: true, sandbox: true, app: null,
      }));
    });
    ws.close();
    return sessionId;
  }, cwd);
}

async function exitShell(page, sessionId) {
  await page.evaluate(async (sid) => {
    const ws = new WebSocket(`ws://${location.host}/ws/terminal`);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'session') {
        ws.send(JSON.stringify({ type: 'input', data: 'exit\r' }));
      }
    };
    ws.send(JSON.stringify({ type: 'attach', sessionId: sid }));
    await new Promise((res) => setTimeout(res, 1500));
    ws.close();
  }, sessionId);
}

// Collect every `init` frame the page's websockets send, newest last.
function initFrames(page) {
  const frames = [];
  page.on('websocket', (ws) => {
    ws.on('framesent', (e) => {
      try {
        const m = JSON.parse(e.payload);
        if (m.type === 'init') frames.push(m);
      } catch { /* not JSON — input bytes etc. */ }
    });
  });
  return frames;
}

test.describe('Active Sessions sandbox preservation (issue #1)', () => {
  test.skip(!sandboxAvailable, 'bwrap not available — sandbox cannot run');

  test('ended sandboxed session relaunches from the list with the sandbox kept', async ({ page }) => {
    test.setTimeout(120_000);
    const cwd = newCwd();

    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();

    // 1) Create a sandboxed shell session via a direct ws connection (the UI's
    // Terminal button opens unsandboxed shells, and claude/opencode may not be
    // installed in CI — the ws path exercises the exact server path the UI
    // uses for a sandboxed launch).
    const sessionId = await openSandboxedShell(page, cwd);
    expect(sessionId).toBeTruthy();

    // 2) Reload so DirectoryBrowser re-fetches the session list; the running
    // sandboxed session must show the sandbox badge.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    const item = page.locator('.session-item', { hasText: cwd });
    await expect(item).toBeVisible();
    await expect(item.locator('.session-badge.sandbox')).toBeVisible();

    // 3) End the session: exit the shell so the server marks it exited (and,
    // once the socket is detached, destroys it after the 30s cleanup timer).
    await exitShell(page, sessionId);

    // 4) Watch the init frames the UI tab sends after we click the stale entry.
    const inits = initFrames(page);

    // Wait out the server's exit-cleanup timer so the session is gone from the
    // map by the time we click (the SESSION_NOT_FOUND re-init path).
    await page.waitForTimeout(31_000);

    // 5) Click the (stale) Active Sessions entry. The server refuses the
    // attach of the dead session, and TerminalView must re-init the session
    // carrying the listing's sandbox flag — not silently drop it.
    await item.click();
    await expect.poll(() => inits.length).toBeGreaterThan(0);
    const init = inits[inits.length - 1];
    expect(init.sandbox).toBe(true);
    expect(init.shell).toBe(true);

    // 6) The relaunched sandboxed shell actually runs.
    const rows = page.locator('.terminal-container .xterm-rows');
    await expect(rows).toContainText(/[$#%>]/, { timeout: 15_000 });
  });

  test('running session entry still attaches (no relaunch)', async ({ page }) => {
    test.setTimeout(60_000);
    const cwd = newCwd();

    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();

    const sessionId = await openSandboxedShell(page, cwd);
    expect(sessionId).toBeTruthy();

    await page.reload();
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    const item = page.locator('.session-item', { hasText: cwd });
    await expect(item).toBeVisible();

    // Clicking a live session attaches to it; no fresh `init` should be sent.
    const inits = initFrames(page);
    await item.click();
    await page.waitForTimeout(2000);
    expect(inits.length).toBe(0);

    // The attached shell keeps running and accepts input.
    const rows = page.locator('.terminal-container .xterm-rows');
    await expect(rows).toContainText(/[$#%>]/, { timeout: 15_000 });
    await page.locator('.terminal-container').click();
    await page.keyboard.type('echo ATTACH_OK');
    await page.keyboard.press('Enter');
    await expect(rows).toContainText(/ATTACH_OK/, { timeout: 15_000 });

    // Clean up the still-running session so the server shuts down cleanly.
    await exitShell(page, sessionId);
  });
});
