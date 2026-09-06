import { test, expect } from '@playwright/test';

// ブラウザの「戻る / 進む」履歴操作ガード (useNavGuard) の検証。
// /nav-guard-prior はサーバーの SPA フォールバックで index.html が返るため、
// 戻り先となる履歴エントリとして使える (API でも dist 実ファイルでもない)。

const GUARD_KEY = 'ccserver-nav-guard';

async function gotoWithPrior(page, mode) {
  if (mode !== undefined) {
    await page.addInitScript((m) => {
      localStorage.setItem('ccserver-nav-guard', m);
    }, mode);
  }
  await page.goto('/nav-guard-prior');
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
}

// ガードのダミー履歴エントリが先頭にあるか。滞在系アサーションは goBack
// 後の非同期な再 push を見逃さないよう poll で判定する (両ドキュメントで
// 同じアプリが描画されるため、ボタンの可視性だけでは離脱の裏付けにならない)。
const guardPresent = (page) =>
  page.evaluate(() => !!(window.history.state && window.history.state.__ccserverNavGuard));
const pathname = (page) => new URL(page.url()).pathname;

test.describe('nav guard', () => {
  test('suppress mode: goBack stays without any dialog', async ({ page }) => {
    await gotoWithPrior(page, 'suppress');
    let dialogSeen = false;
    page.once('dialog', async (dialog) => {
      dialogSeen = true;
      await dialog.dismiss();
    });
    await page.goBack();
    await expect.poll(() => pathname(page)).toBe('/');
    await expect.poll(() => guardPresent(page)).toBe(true);
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    expect(dialogSeen).toBe(false);
  });

  test('confirm mode (default): goBack shows a dialog; dismiss stays', async ({ page }) => {
    await gotoWithPrior(page);
    expect(await page.evaluate(() => localStorage.getItem('ccserver-nav-guard'))).toBeNull();
    let dialogSeen = false;
    page.once('dialog', async (dialog) => {
      dialogSeen = true;
      await dialog.dismiss();
    });
    await page.goBack();
    expect(dialogSeen).toBe(true);
    await expect.poll(() => pathname(page)).toBe('/');
    await expect.poll(() => guardPresent(page)).toBe(true);
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
  });

  test('confirm mode: accepting the dialog leaves the page', async ({ page }) => {
    await gotoWithPrior(page);
    page.once('dialog', async (dialog) => {
      await dialog.accept();
    });
    await page.goBack();
    await expect.poll(() => page.url()).toContain('/nav-guard-prior');
  });

  test('allow mode: goBack leaves without any dialog', async ({ page }) => {
    await gotoWithPrior(page, 'allow');
    let dialogSeen = false;
    page.once('dialog', async (dialog) => {
      dialogSeen = true;
      await dialog.dismiss();
    });
    await page.goBack();
    await expect.poll(() => page.url()).toContain('/nav-guard-prior');
    expect(dialogSeen).toBe(false);
  });

  test('keydown: Alt+ArrowLeft is swallowed over editable targets, passes through on body', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    // Settings を開いて select (editable) にフォーカスする。
    await page.locator('.tab-list').getByTitle('Settings').click();
    const select = page.locator('#general-theme-select');
    await expect(select).toBeVisible();
    await select.focus();
    const swallowedOnSelect = await page.evaluate(() => {
      const target = document.getElementById('general-theme-select');
      const e = new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(swallowedOnSelect).toBe(true);
    // 非入力フォーカス (body) の confirm モードは抑止せず popstate 側に任せる。
    await page.evaluate(() => { document.activeElement?.blur(); });
    const swallowedOnBody = await page.evaluate(() => {
      const e = new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(swallowedOnBody).toBe(false);
    // suppress モードでは body 上でも黙って抑止する。
    await page.evaluate(() => localStorage.setItem('ccserver-nav-guard', 'suppress'));
    await page.reload();
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    const swallowedOnBodySuppress = await page.evaluate(() => {
      const e = new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(swallowedOnBodySuppress).toBe(true);
    expect(await page.evaluate((k) => localStorage.getItem(k), GUARD_KEY)).toBe('suppress');
  });

  test('switching confirm -> allow peels the guard entry (two cycles)', async ({ page }) => {
    await gotoWithPrior(page);
    const select = page.locator('[role="tabpanel"]').getByLabel('ブラウザの戻る・進む操作');
    // 設定UIで allow に切り替えると、積まれていたガードが剥がれる。
    // confirm に戻して再び allow にしても剥がれる (peel フラグのリセット確認)。
    await page.locator('.tab-list').getByTitle('Settings').click();
    for (let i = 0; i < 2; i++) {
      await select.selectOption('allow');
      await expect.poll(() => guardPresent(page)).toBe(false);
      await select.selectOption('confirm');
      await expect.poll(() => guardPresent(page)).toBe(true);
    }
    await select.selectOption('allow');
    await expect.poll(() => guardPresent(page)).toBe(false);
    let dialogSeen = false;
    page.once('dialog', async (dialog) => {
      dialogSeen = true;
      await dialog.dismiss();
    });
    // 直後の「戻る」1回で離脱できる（ダミーに消費されない）。
    await page.goBack();
    await expect.poll(() => page.url()).toContain('/nav-guard-prior');
    expect(dialogSeen).toBe(false);
  });

  test('pageshow keeps the guard armed', async ({ page }) => {
    await gotoWithPrior(page);
    // bfcache 復元相当の pageshow を発火させてもガードは維持される。
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    let dialogSeen = false;
    page.once('dialog', async (dialog) => {
      dialogSeen = true;
      await dialog.dismiss();
    });
    await page.goBack();
    expect(dialogSeen).toBe(true);
    await expect.poll(() => pathname(page)).toBe('/');
    await expect.poll(() => guardPresent(page)).toBe(true);
  });

  test('leave and come back: guard is armed', async ({ page }) => {
    // confirm-OK で離脱した後に forward で戻ると、ガードが武装されている
    // (bfcache 復元時は onPageShow、フルリロード時はマウント時 push のため、
    // どちらの経路でもガードが存在しなければならない)。
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    page.once('dialog', async (dialog) => {
      await dialog.accept();
    });
    await page.goBack();
    await expect.poll(() => page.url()).toBe('about:blank');
    let dialogSeen = false;
    page.once('dialog', async (dialog) => {
      dialogSeen = true;
      await dialog.dismiss();
    });
    await page.goForward();
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await expect.poll(() => guardPresent(page)).toBe(true);
    expect(dialogSeen).toBe(false);
  });

  test('pageshow re-pushes a missing guard', async ({ page }) => {
    // replaceState でガードを剥がした状態で pageshow が来ると積み直す
    // (bfcache 復元相当。同一ドキュメントのためリスナーは維持される)。
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await expect.poll(() => guardPresent(page)).toBe(true);
    await page.evaluate(() => window.history.replaceState(null, '', '/#replaced'));
    await expect.poll(() => guardPresent(page)).toBe(false);
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await expect.poll(() => guardPresent(page)).toBe(true);
  });

  test('mode switch right after accept does not disarm the guard', async ({ page }) => {
    // confirm-OK 直後の back() を no-op 化 (直接オープン相当の行き止まりを
    // 再現。page.goBack() 自体は CDP 経由のためスタブの影響を受けない)。
    // この状態で allow → confirm と切り替えても、残留フラグで次回の
    // popstate が誤消費されず、確認が出続ける。
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await page.locator('.tab-list').getByTitle('Settings').click();
    const select = page.locator('[role="tabpanel"]').getByLabel('ブラウザの戻る・進む操作');
    await page.evaluate(() => {
      window.__origBack = window.history.back.bind(window.history);
      window.history.back = () => {};
    });
    let firstSeen = false;
    page.once('dialog', async (dialog) => {
      firstSeen = true;
      await dialog.accept();
    });
    await page.goBack();
    expect(firstSeen).toBe(true);
    await page.evaluate(() => { window.history.back = window.__origBack; });
    await select.selectOption('allow');
    await select.selectOption('confirm');
    let dialogSeen = false;
    page.once('dialog', async (dialog) => {
      dialogSeen = true;
      await dialog.dismiss();
    });
    await page.goBack();
    expect(dialogSeen).toBe(true);
    await expect.poll(() => guardPresent(page)).toBe(true);
  });

  test('rapid allow->confirm switch shows no spontaneous dialog', async ({ page }) => {
    // allow 切替の peel back() を遅延スタブ化し、allow→confirm 両 effect
    // 確定後に実行する。こうすると peel 完了 pop が confirm リスナーに届く
    // 順序が確定し、誤認があれば必ず自発ダイアログとして現れる。
    await gotoWithPrior(page);
    await page.locator('.tab-list').getByTitle('Settings').click();
    const select = page.locator('[role="tabpanel"]').getByLabel('ブラウザの戻る・進む操作');
    await page.evaluate(() => {
      window.__origBack = window.history.back.bind(window.history);
      window.__backCalls = 0;
      window.__pendingBack = null;
      window.history.back = () => {
        window.__backCalls++;
        window.__pendingBack = () => window.__origBack();
      };
      window.__releaseBack = () => {
        const f = window.__pendingBack;
        window.__pendingBack = null;
        if (f) f();
      };
    });
    let dialogs = 0;
    page.on('dialog', async (dialog) => {
      dialogs++;
      await dialog.dismiss();
    });
    await select.selectOption('allow');
    await select.selectOption('confirm');
    await page.waitForTimeout(500);
    // allow effect が peel を発行したことの裏付け (なければテスト自体が無効)。
    expect(await page.evaluate(() => window.__backCalls)).toBe(1);
    await page.evaluate(() => window.__releaseBack());
    await page.waitForTimeout(500);
    expect(dialogs).toBe(0);
    await expect.poll(() => guardPresent(page)).toBe(true);
    await page.evaluate(() => { window.history.back = window.__origBack; });
    await page.goBack();
    expect(dialogs).toBe(1);
  });

  test('no-op back after accept re-arms the guard via timer', async ({ page }) => {
    // confirm-OK 後の back() が no-op のまま 500ms 経つとガードが積み直され、
    // 次回の「戻る」でも再び確認が出る。
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await page.evaluate(() => {
      window.__origBack = window.history.back.bind(window.history);
      window.history.back = () => {};
    });
    page.once('dialog', async (dialog) => {
      await dialog.accept();
    });
    await page.goBack();
    await expect.poll(() => guardPresent(page)).toBe(true);
    await page.evaluate(() => { window.history.back = window.__origBack; });
    let dialogSeen = false;
    page.once('dialog', async (dialog) => {
      dialogSeen = true;
      await dialog.dismiss();
    });
    await page.goBack();
    expect(dialogSeen).toBe(true);
  });
});
