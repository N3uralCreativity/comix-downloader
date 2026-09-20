'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('../../lib/jszip.min.js');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const titleUrl = 'https://comix.to/title/cloudflare-smoke';
const fixture = `<!doctype html><html data-theme="dark"><head><title>Cloudflare pause test</title><style>
  :root { --surface:#202426; --surface-2:#272b2e; --text:#cdd5d6; --text-emphasis:#ecf4f5; --text-2:#9a9ca6; --accent:#8b5cf6; }
  * { box-sizing:border-box; } body { background:#17191a; color:var(--text); font:14px Arial,sans-serif; padding:24px; }
  .mpage__actions { display:flex; gap:10px; } .btn { padding:12px; background:var(--surface); color:var(--text); border:0; }
</style></head><body><main class="mpage"><h1>Cloudflare pause test</h1>
  <div class="mpage__actions"><button class="btn mpage__read">Read chapter 1</button></div>
</main></body></html>`;

(async () => {
  const extension = path.resolve(__dirname, '../../dist/package-work/chrome');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cdl-cloudflare-smoke-'));
  const screenshots = path.resolve(__dirname, '../../output/playwright');
  await fs.mkdir(screenshots, { recursive: true });
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
      channel: 'chromium', headless: true, acceptDownloads: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    await context.route(/^https?:/, route => route.request().url().startsWith(titleUrl)
      ? route.fulfill({ contentType: 'text/html', body: fixture }) : route.abort());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: temp });
    await page.goto(titleUrl);
    await page.locator('.cdl-dl-all-btn').first().waitFor();
    await worker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
      self.testTabId = tab.id;
      self.testBanned = true;
      self.testRequests = {};
      const actualFetch = self.fetch;
      self.fetch = async (input, options) => {
        const src = String(input);
        if (!src.startsWith('https://image-fixture.invalid/')) return actualFetch(input, options);
        self.testRequests[src] = (self.testRequests[src] || 0) + 1;
        if (self.testBanned && src.endsWith('/1/2')) {
          return new Response('<h1>Error 1006</h1><p>Cloudflare: your IP address has been banned.</p>', {
            status: 403, headers: { 'content-type': 'text/html' },
          });
        }
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
      };
      loadCfg = async () => ({ 'perf.batchSize': 1, 'perf.rateLimitMode': 'off', 'download.concurrentChapters': 2 });
      getLibraryConfig = async () => null;
      extractFromTab = async (chapterUrl) => [1, 2, 3].map(index => ({
        index, src: `https://image-fixture.invalid/${chapterUrl.includes('/1-chapter') ? 1 : 2}/${index}`,
      }));
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
        showDownloadAllPopup('Cloudflare pause test', 2, { sessionId: 'cloudflare-smoke' });
      } });
      self.testRun = runDownloadAllRequest([1, 2].map(n => ({ chapterUrl: `${url}/${n}-chapter-${n}`, chapterLabel: `Ch${n}` })),
        'Cloudflare pause test', 'cloudflare-smoke.zip', tab.id, { format: 'zip', slug: 'cloudflare-smoke' }, null, 'cloudflare-smoke');
    }, titleUrl);

    await page.locator('#cdl-ap-access-resume').waitFor();
    assert.match(await page.locator('#cdl-ap-img-status').textContent(), /IP address/);
    const firstRequests = await worker.evaluate(() => ({ ...self.testRequests }));
    await page.waitForTimeout(1200);
    assert.deepEqual(await worker.evaluate(() => self.testRequests), firstRequests, 'No automatic retries while blocked');
    await page.reload();
    await page.locator('#cdl-ap-access-resume').waitFor();
    assert.equal(await page.locator('#cdl-all-popup').getAttribute('data-session-status'), 'blocked');

    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.locator('#cdl-all-popup').evaluate(popup => {
        const rect = popup.getBoundingClientRect();
        const controls = [...popup.querySelectorAll('.cdl-ap-footer button, .cdl-ap-footer a')].map(el => {
          const box = el.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
        });
        return { left: rect.left, right: rect.right, bottom: rect.bottom, width: innerWidth, controls };
      });
      assert.ok(layout.left >= 0 && layout.right <= width + 1 && layout.bottom <= 901, JSON.stringify(layout));
      for (let i = 0; i < layout.controls.length; i++) {
        const a = layout.controls[i];
        assert.ok(a.left >= layout.left && a.right <= layout.right + 1);
        for (const b of layout.controls.slice(i + 1)) {
          assert.ok(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1,
            'Pause buttons must not overlap');
        }
      }
      await page.screenshot({ path: path.join(screenshots, `cloudflare-pause-${width}.png`) });
    }
    await page.locator('#cdl-ap-access-resume').click();
    await page.waitForFunction(() => !document.querySelector('#cdl-ap-access-resume')?.disabled &&
      document.querySelector('#cdl-all-popup')?.dataset.sessionStatus === 'blocked');
    assert.equal(await worker.evaluate(() => self.testRequests['https://image-fixture.invalid/1/2']), 2);
    await worker.evaluate(() => { self.testBanned = false; });
    await page.locator('#cdl-ap-access-resume').click();
    const result = await worker.evaluate(async () => {
      await self.testRun;
      return { status: downloadAllSession.status, requests: self.testRequests,
        downloads: await chrome.downloads.search({ state: 'complete' }) };
    });
    assert.equal(result.status, 'done');
    assert.equal(result.downloads.length, 1);
    for (const [url, count] of Object.entries(result.requests)) assert.equal(count, url.endsWith('/1/2') ? 3 : 1);
    const file = result.downloads[0].filename;
    assert.equal(path.dirname(path.resolve(file)), path.resolve(temp));
    const zip = await JSZip.loadAsync(await fs.readFile(file));
    const images = Object.values(zip.files).filter(entry => !entry.dir && entry.name.endsWith('.jpg'));
    assert.equal(images.length, 6, 'The resumed archive includes every page');
    for (const image of images) assert.deepEqual([...await image.async('uint8array')], [1, 2, 3]);

    await worker.evaluate(async () => {
      await chrome.scripting.executeScript({ target: { tabId: self.testTabId }, func: () => document.getElementById('cdl-all-popup')?.remove() });
      self.singleTask = createChapterAccessTask('https://comix.to/title/cloudflare-smoke/3-chapter-3', self.testTabId);
      self.singlePause = self.singleTask.access.pause(makeCloudflareAccessError({ blocked: true, blockKind: 'access_denied', cloudflareCode: '1020' }))
        .catch(error => error.code);
    });
    await page.locator('#cdl-single-error[data-task-id]').waitFor();
    await page.bringToFront();
    const singleBox = await page.locator('#cdl-single-error').boundingBox();
    assert.ok(singleBox.x >= 0 && singleBox.x + singleBox.width <= 321 && singleBox.height > 100);
    await page.screenshot({ path: path.join(screenshots, 'cloudflare-single-pause-320.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await worker.evaluate(() => self.singlePause), 'DOWNLOAD_ALL_STOPPED');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS real MV3 Cloudflare pause, reload, re-block, resume, archive bytes, single-chapter Cancel, desktop/mobile layout');
  } finally {
    if (context) await context.close();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('cdl-cloudflare-smoke-'));
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
