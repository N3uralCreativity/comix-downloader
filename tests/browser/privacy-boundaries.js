'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const chapter = '/title/privacy-fixture/1-chapter-1';
const pages = [1, 2].map(index => ({ url: `https://images-fixture.invalid/page-${index}.webp` }));
const readerJson = JSON.stringify({ result: { padding: 'x'.repeat(200), pages: { items: pages } } });
const html = `<!doctype html><html data-theme="dark"><head><title>Privacy fixture</title>
<style>:root{--accent:#8b5cf6;--surface-2:#272b2e;--text-2:#9a9ca6}body{background:#17191a;color:#ddd;font:14px Arial;padding:24px}.mpage__actions{display:flex;gap:8px}.btn{padding:10px;border:0}</style>
<script>if(location.pathname === ${JSON.stringify(chapter)}) new TextDecoder().decode(new TextEncoder().encode(${JSON.stringify(readerJson)}));</script>
</head><body><main class="mpage"><h1>Privacy fixture</h1><div class="mpage__actions"><button class="btn mpage__read">Read chapter 1</button></div></main></body></html>`;

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cdl-privacy-'));
  const extension = path.join(root, 'dist/package-work/chrome');
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
      channel: 'chromium', headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    const accountRequests = [];
    await context.route(/^https?:/, route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'comix.to' || url.hostname === 'comix.ws') {
        if (url.pathname === '/api/v1/user') {
          accountRequests.push(url.href);
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { hashId: 'privacy-user' } }) });
        }
        if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"result":null}' });
        return route.fulfill({ contentType: 'text/html', body: html });
      }
      return route.abort();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => {
      self.privacyRequests = [];
      // Fixture the extension's network too: this test never contacts a real backend.
      self.fetch = async (url, options = {}) => {
        self.privacyRequests.push({ url: String(url), options: { credentials: options.credentials, referrerPolicy: options.referrerPolicy } });
        return new Response(JSON.stringify({ first: '2026-10-22', counts: { total: 0 } }), { headers: { 'Content-Type': 'application/json' } });
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://comix.to/title/privacy-fixture');
    await page.locator('.cdl-dl-all-btn').first().waitFor();
    const boundaries = await page.evaluate(() => ({
      globals: ['CDLRoute', 'CDLAdblock', '__cdlAdblockInstalled', '__cdlPages'].filter(name => typeof window[name] !== 'undefined'),
      publicHistory: /\[native code\]/.test(String(history.pushState)) && /\[native code\]/.test(String(history.replaceState)),
      publicDecoder: /\[native code\]/.test(String(TextDecoder.prototype.decode)),
      attributes: ['data-cdl-adblock', 'data-cdl-profile'].filter(name => document.documentElement.hasAttribute(name)),
      nativeReference: window.open.__cdlNative
    }));
    assert.deepEqual(boundaries.globals, []);
    assert.deepEqual(boundaries.attributes, []);
    assert.equal(boundaries.publicHistory, true);
    assert.equal(boundaries.publicDecoder, true);
    assert.equal(boundaries.nativeReference, undefined);
    assert.equal(accountRequests.length, 0);
    assert.equal(await worker.evaluate(() => self.privacyRequests.filter(r => /\/v1\/(seen|flags?)(?:\?|$)/.test(r.url)).length), 0);
    console.log('PASS real content-world isolation, native page history and no default community registration');

    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url === 'https://comix.to/title/privacy-fixture').id);
    await worker.evaluate(async tabId => {
      await chrome.scripting.executeScript({ target: { tabId }, func: () => {
        window.privacyRouteChanges = [];
        CDLRoute.subscribe(() => window.privacyRouteChanges.push(location.pathname));
      } });
    }, tabId);
    for (const [method, route] of [['pushState', '/title/privacy-second'], ['replaceState', '/user?tab=settings']]) {
      await page.evaluate(({ method, route }) => history[method]({}, '', route), { method, route });
      for (let attempt = 0; attempt < 60; attempt++) {
        const seen = await worker.evaluate(async ({ tabId, pathname }) => {
          const result = await chrome.scripting.executeScript({ target: { tabId }, func: pathname => window.privacyRouteChanges.includes(pathname), args: [pathname] });
          return result[0].result;
        }, { tabId, pathname: route.split('?')[0] });
        if (seen) break;
        if (attempt === 59) throw new Error('Missed actual browser SPA navigation: ' + route);
        await page.waitForTimeout(50);
      }
    }
    await page.evaluate(() => window.dispatchEvent(new Event('cdl:locationchange')));
    const changes = await worker.evaluate(async tabId => (await chrome.scripting.executeScript({ target: { tabId }, func: () => window.privacyRouteChanges }))[0].result, tabId);
    assert.deepEqual(changes, ['/title/privacy-second', '/user']);
    console.log('PASS actual Chrome tabs.onUpdated observes page pushState and replaceState without page hooks');

    const asset = await worker.evaluate(async tabId => (await chrome.scripting.executeScript({ target: { tabId }, func: () => ({
      id: chrome.runtime.id,
      url: chrome.runtime.getURL('assets/plus-announce/cloud-library.jpg')
    }) }))[0].result, tabId);
    assert.notEqual(new URL(asset.url).hostname, asset.id, 'asset URLs must not contain the fixed extension ID');
    const imageLoads = async url => page.evaluate(url => new Promise(resolve => {
      const image = new Image(); image.onload = () => resolve(image.naturalWidth > 0); image.onerror = () => resolve(false); image.src = url;
    }), url);
    assert.equal(await imageLoads(asset.url), true, 'existing announcement media remains usable');
    assert.equal(await imageLoads(`chrome-extension://${asset.id}/assets/plus-announce/cloud-library.jpg`), false, 'fixed-ID probing is denied');
    console.log('PASS dynamic Chromium media URLs work while fixed-ID resource probes fail');

    await worker.evaluate(async () => {
      await CDLSettings.patchSettings({ 'privacy.communitySharing': true });
    });
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await worker.evaluate(() => self.privacyRequests.some(r => r.url.endsWith('/v1/seen')))) break;
      if (attempt === 59) throw new Error('Opted-in profile registration did not work');
      await page.waitForTimeout(50);
    }
    assert.equal(accountRequests.length, 1);
    await worker.evaluate(async () => {
      await CDLSettings.patchSettings({ 'privacy.communitySharing': false });
    });
    const requestCount = await worker.evaluate(() => self.privacyRequests.length);
    await page.reload();
    assert.equal(accountRequests.length, 1, 'disabled profile sharing does not fetch the account on reload');
    assert.equal(await worker.evaluate(() => self.privacyRequests.length), requestCount);
    console.log('PASS opt-in enables the existing badge service and opting out stops future traffic');

    await page.goto('https://comix.to' + chapter + '?source=all#cdlx');
    const chapterTab = await worker.evaluate(async chapter => (await chrome.tabs.query({})).find(tab => tab.url && new URL(tab.url).pathname === chapter).id, chapter);
    const extracted = await worker.evaluate(async tabId => (await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: extractChapterImagesFromPage, args: [{}]
    }))[0].result, chapterTab);
    assert.deepEqual(extracted, pages.map((item, i) => ({ src: item.url, index: i + 1 })));
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await page.evaluate(() => window.__cdlPages), undefined);
    assert.equal(await page.evaluate(() => /\[native code\]/.test(String(TextDecoder.prototype.decode))), true);
    assert.deepEqual(errors, []);
    console.log('PASS real MAIN-world chapter capture, private handoff and decoder restoration');
    const screenshots = path.join(root, 'output/playwright');
    await fs.mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, 'privacy-boundaries.png') });
    const settingsPage = await context.newPage();
    await settingsPage.goto(`chrome-extension://${asset.id}/legacy/options.html`);
    await settingsPage.locator('.nav-item[data-tab="features"]').click();
    const sharingRow = settingsPage.locator('[data-key="privacy.communitySharing"]');
    await sharingRow.waitFor({ state: 'visible' });
    assert.equal(await sharingRow.locator('input[type="checkbox"]').isChecked(), false);
    for (const width of [1280, 390, 320]) {
      await settingsPage.setViewportSize({ width, height: 1000 });
      await sharingRow.scrollIntoViewIfNeeded();
      const fits = await sharingRow.evaluate(row => {
        const bounds = row.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= innerWidth && row.scrollWidth <= row.clientWidth;
      });
      assert.equal(fits, true, 'community preference fits at ' + width + 'px');
      await settingsPage.screenshot({ path: path.join(screenshots, `privacy-settings-${width}.png`) });
    }
    console.log('PASS the new preference is off by default and fits desktop/mobile settings');
    await settingsPage.close();
  } finally {
    if (context) await context.close();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('cdl-privacy-'));
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
