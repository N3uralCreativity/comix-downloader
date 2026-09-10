'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const downloadSelector = '.cdl-dl-all-btn:not(.cdl-sub-btn)';
// Comix has separate desktop/mobile rows. Follow and Collection each own a
// dropdown; the mobile auxiliary strip deliberately does not wrap.
const follow = '<div class="fdrop mpage__follow"><button class="btn btn--soft mpage__follow-btn">Reading</button></div>';
const collect = '<div class="fdrop mpage__collect"><button class="btn btn--soft">Add to Collection</button></div>';
const read = '<button class="btn mpage__read">Resume Ch. 41</button>';
const fixture = `<!doctype html><html><head><style>
  :root { --surface-2:#272b2e; --text-2:#9a9ca6; --accent:#8b5cf6; }
  [data-theme="light"] { --surface-2:#eef1f3; --text-2:#54616a; --accent:#0891b2; }
  [data-theme="main"] { --surface-2:#323a3e; --text-2:#97a5a9; --accent:#66e8fa; }
  * { box-sizing:border-box; }
  body { margin:16px; font:14px Arial,sans-serif; }
  main { max-width:780px; }
  .btn { display:inline-flex; align-items:center; height:40px; padding:0 18px; border:0; border-radius:6px; font:600 14px Arial,sans-serif; }
  .btn--soft { color:var(--text-2); background:var(--surface-2); }
  .btn:focus-visible { outline:2px solid var(--accent); }
  .mpage__actions { display:flex; align-items:center; flex-wrap:wrap; gap:10px; }
  .mpage__actions-aux { flex:1 0 100%; }
  .mpage__cta { display:none; flex-wrap:wrap; align-items:center; gap:8px; }
  .mpage__cta-aux { display:inline-flex; align-items:center; gap:6px; flex:1 0 100%; }
  .fdrop { position:relative; }
  .mpage__follow { flex:1 1 auto; }
  .mpage__actions > .mpage__follow { flex:0 0 auto; }
  @media(max-width:720px) {
    .mpage__actions { display:none; }
    .mpage__cta { display:flex; }
    .mpage__cta-aux .mpage__follow-btn { width:100%; justify-content:space-between; }
  }
</style></head><body><main class="mpage"><h1>Test manga</h1>
  <div class="mpage__cta">${read}<div class="mpage__cta-aux">${follow}${collect}</div></div>
  <div class="mpage__actions">${read}${follow}${collect}<div class="mpage__actions-aux">Edit history</div></div>
</main></body></html>`;

(async () => {
  const browser = await chromium.launch({
    headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    await page.goto('https://comix.to/title/test-manga');
    await page.evaluate(() => {
      window.actionMessages = [];
      window.chrome = {
        runtime: {
          id: 'test-extension', onMessage: { addListener() {} },
          sendMessage(message, callback) {
            window.actionMessages.push(message);
            callback?.({ ok: true, session: null });
          },
        },
        storage: {
          local: { get(key, callback) { callback({ cdlSubscriptions: { 'test-manga': {} } }); } },
          onChanged: { addListener() {} },
        },
      };
    });
    await page.addScriptTag({ content: await fs.readFile(path.join(__dirname, '../../content/content_title.js'), 'utf8') });
    await page.locator(downloadSelector).waitFor();
    await page.evaluate(() => {
      window.originalDownload = document.querySelector('.cdl-dl-all-btn:not(.cdl-sub-btn)');
      window.originalSubscription = document.querySelector('.cdl-sub-btn');
    });

    for (const theme of ['dark', 'light', 'main']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const width of [1280, 390, 720, 320, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        const expectedParent = width <= 720 ? 'mpage__cta' : 'mpage__actions';
        await page.waitForFunction(expected =>
          document.querySelector('.cdl-title-actions')?.parentElement.className === expected,
        expectedParent);
        const result = await page.evaluate(() => {
          const download = document.querySelector('.cdl-dl-all-btn:not(.cdl-sub-btn)');
          const subscription = document.querySelector('.cdl-sub-btn');
          const group = download.parentElement;
          const row = group.parentElement;
          const native = row.querySelector('.mpage__follow-btn');
          const buttons = [download, subscription];
          const bounds = row.getBoundingClientRect();
          const rects = buttons.map(button => button.getBoundingClientRect());
          return {
            count: document.querySelectorAll('.cdl-dl-all-btn').length,
            sameNodes: download === window.originalDownload && subscription === window.originalSubscription,
            sameParent: subscription.parentElement === group,
            adjacent: download.nextElementSibling === subscription,
            dropdownsUntouched: [...document.querySelectorAll('.mpage__follow')].every(el => el.children.length === 1),
            noFollowClass: buttons.every(button => !button.classList.contains('mpage__follow-btn')),
            fits: rects.every(rect => rect.width > 0 && rect.height > 0 && rect.left >= bounds.left && rect.right <= bounds.right + 1),
            aligned: Math.abs(rects[0].top - rects[1].top) < 1,
            themesMatch: buttons.every(button => {
              const style = getComputedStyle(button);
              const reference = getComputedStyle(native);
              return style.color === reference.color && style.backgroundColor === reference.backgroundColor && style.marginTop === '0px';
            }),
            nativeFirst: [...row.children].indexOf(group) > [...row.children].indexOf(native.closest('.fdrop') || native),
          };
        });
        assert.equal(result.count, 2);
        for (const [key, value] of Object.entries(result)) {
          if (key !== 'count') assert.equal(value, true, `${theme}, ${width}px: ${key}`);
        }
        console.log(`PASS ${theme} title actions at ${width}px`);
      }
    }

    const stable = await page.evaluate(() => {
      const mutations = new MutationObserver(() => {});
      mutations.observe(document.body, { childList: true, subtree: true });
      for (let i = 0; i < 20; i++) { injectDownloadAllButton(); injectSubscribeButton(); }
      const count = mutations.takeRecords().length;
      mutations.disconnect();
      return count;
    });
    assert.equal(stable, 0, 'Repeated scans must not move/recreate buttons or trigger observer loops');
    await page.locator('.cdl-sub-btn').click();
    assert.equal(await page.locator('.cdl-sub-btn').getAttribute('data-sub'), '0');
    assert.equal(await page.evaluate(() => actionMessages.at(-1).action), 'unsubscribe');
    await page.locator('.cdl-sub-btn').click();
    assert.equal(await page.evaluate(() => actionMessages.at(-1).action), 'subscribe');

    // Exercise the real click listener without fetching chapters or starting a download.
    await page.evaluate(() => {
      collectChapterRowsWithGroups = async () => [{ chapterUrl: '/title/test-manga/1', chapterLabel: 'Ch1' }];
      showDownloadAllOptionsPanel = () => { window.optionsOpened = true; };
    });
    await page.locator(downloadSelector).click();
    await page.waitForFunction(() => window.optionsOpened === true);
    console.log('PASS stable DOM and working Download All / Subscribe after relocation');

    await page.evaluate(() => {
      // Simulate a replacement desktop row while preserving the mobile row.
      const row = document.querySelector('.mpage__actions');
      const clone = row.cloneNode(true);
      clone.querySelectorAll('.cdl-title-actions').forEach(el => el.remove());
      row.replaceWith(clone);
    });
    await page.locator('.mpage__actions > .cdl-title-actions > .cdl-sub-btn').waitFor();
    assert.equal(await page.locator('.cdl-dl-all-btn').count(), 2);

    await page.evaluate(() => {
      document.querySelector('.mpage__cta').remove();
      const row = document.querySelector('.mpage__actions');
      row.className = 'legacy-actions';
      row.querySelectorAll('.cdl-title-actions').forEach(el => el.remove());
      injectDownloadAllButton();
      injectSubscribeButton();
    });
    assert.equal(await page.locator('.legacy-actions > .cdl-title-actions > .cdl-dl-all-btn').count(), 2,
      'Legacy Follow fallback must insert outside the dropdown');
    await page.evaluate(() => {
      document.querySelector('.legacy-actions').style.display = 'none';
      injectDownloadAllButton();
      injectSubscribeButton();
    });
    assert.equal(await page.locator('body > .cdl-floating').count(), 1);
    assert.equal(await page.locator('.cdl-sub-btn').count(), 0);
    await page.evaluate(() => {
      document.querySelector('.legacy-actions').style.display = '';
      injectDownloadAllButton();
      injectSubscribeButton();
    });
    assert.equal(await page.locator('.legacy-actions > .cdl-title-actions > .cdl-dl-all-btn').count(), 2);
    console.log('PASS React replacement, legacy dropdown, and floating fallback');
    assert.deepEqual(errors, [], 'Unexpected browser errors');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
