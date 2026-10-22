'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('../../lib/jszip.min.js');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const titleUrl = 'https://comix.to/title/chapter-progress';
const secureUrl = 'https://comix.to/assets/build/fixture/dist/secure-fixture-T1.js';
const secureModule = `let vmdd=globalThis,vmd7_fixture=vmdd.vmd7_fixture||(vmdd.vmd7_fixture={});
const i={};vmd7_fixture.i=i,globalThis.i=vmd7_fixture.i;
function $(client) {
  client.interceptors.request.use((config) => { config.params={...config.params,_:'fixture'}; return config; });
  client.interceptors.response.use((response) => {
    if(response.headers.get('x-enc')==='2') response.data=JSON.parse(atob(response.data.e));
    return response;
  });
}
vmd7_fixture.$=$,globalThis.$=vmd7_fixture.$;
export{i as i,$ as r};`;
const fixture = `<!doctype html><html data-theme="dark"><head><title>Chapter progress test</title>
<script type="module" src="${secureUrl}"></script><style>
:root{--surface:#202426;--surface-2:#272b2e;--text:#cdd5d6;--text-emphasis:#ecf4f5;--text-2:#9a9ca6;--accent:#8b5cf6}
[data-theme="light"]{--surface:#fff;--surface-2:#eef1f3;--text:#25323a;--text-emphasis:#15232b;--text-2:#54616a;--accent:#0891b2;--page-bg:#f6f7f8}
[data-theme="main"]{--surface:#202c30;--surface-2:#323a3e;--accent:#66e8fa}
*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--page-bg,#17191a);color:var(--text);font:14px Arial,sans-serif}
.mpage__actions{display:flex;gap:10px}.btn{padding:12px;background:var(--surface);color:var(--text);border:0}
.mchap-row{display:flex;align-items:center;gap:10px;padding:10px}.mchap-row a{color:var(--text)}
</style></head><body><main class="mpage"><h1 class="mpage__title">Chapter progress test</h1>
<div class="mpage__actions"><button class="btn mpage__read">Read chapter 1</button></div>
<div class="mchap-list">${[1, 2, 3, 4].map(n => `<div class="mchap-item"><div class="mchap-row"><a class="mchap-row__primary" href="${titleUrl}/${n}-chapter-${n}">Chapter ${n}</a><button class="mchap-bookmark">Bookmark</button></div></div>`).join('')}</div>
</main></body></html>`;

(async () => {
  const extension = path.resolve(__dirname, '../../dist/package-work/chrome');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cdl-chapter-progress-'));
  const screenshots = path.resolve(__dirname, '../../output/playwright');
  await fs.mkdir(screenshots, { recursive: true });
  let context;
  let releaseApi;
  try {
    context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
      channel: 'chromium', headless: true, acceptDownloads: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    let banned = true;
    const requests = {};
    const apiHold = new Promise(resolve => { releaseApi = resolve; });
    await context.route(/^https?:/, async route => {
      const url = route.request().url();
      const api = url.match(/^https:\/\/comix\.to\/api\/v1\/chapters\/(\d+)\?/);
      if (api) {
        if (api[1] === '4') await apiHold;
        const pages = { alt: [], node: null, items: [1, 2, 3].map(n => ({ width: 10, height: 10, url: `https://progress-images.invalid/${api[1]}/${n}` })) };
        return route.fulfill({ contentType: 'application/json', headers: { 'x-enc': '2' },
          body: JSON.stringify({ e: Buffer.from(JSON.stringify({ id: Number(api[1]), pages })).toString('base64') }) });
      }
      if (url === secureUrl) return route.fulfill({ contentType: 'text/javascript', body: secureModule });
      if (url.startsWith(titleUrl)) return route.fulfill({ contentType: 'text/html', body: fixture });
      if (url.startsWith('https://progress-images.invalid/')) {
        const image = new URL(url).pathname;
        if (route.request().resourceType() === 'image') requests[image] = (requests[image] || 0) + 1;
        if (image.endsWith('/2') && (banned || image.startsWith('/3/'))) {
          return route.fulfill({ status: 403, contentType: 'text/html', headers: { 'access-control-allow-origin': '*' },
            body: '<h1>Error 1006</h1><p>Cloudflare: your IP address has been banned.</p>' });
        }
        return route.fulfill({ contentType: 'image/jpeg', headers: { 'access-control-allow-origin': '*' }, body: Buffer.from([1, 2, 3]) });
      }
      return route.abort();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(async () => {
      await CDLSettings.patchSettings({ 'perf.batchSize': 1, 'perf.rateLimitMode': 'off', 'perf.pagePace': 'fast',
        'download.concurrentChapters': 1, 'output.format': 'cbz' });
      getLibraryConfig = async () => null;
      self.releaseBuild = null;
      self.releaseSave = null;
      const build = _zipToDownloadUrl;
      _zipToDownloadUrl = async (...args) => {
        await new Promise(resolve => { self.releaseBuild = resolve; });
        return build(...args);
      };
      const save = saveGeneratedArchive;
      saveGeneratedArchive = async (...args) => {
        self.requestedFilename = args[0].filename;
        await new Promise(resolve => { self.releaseSave = resolve; });
        return save(...args);
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: temp });
    await page.goto(titleUrl);
    await page.locator('.mchap-row .cdl-btn').first().waitFor();
    assert.equal(await page.locator('.cdl-dl-all-btn:not(.cdl-sub-btn)').count(), 0);
    assert.equal(await page.locator('.cdl-sub-btn').count(), 1);
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, titleUrl);
    const send = async (message, target = tabId) => worker.evaluate(async ({ message, target }) => {
      const result = await chrome.scripting.executeScript({ target: { tabId: target }, func: message => chrome.runtime.sendMessage(message), args: [message] });
      return result[0].result;
    }, { message, target });
    const rejectBulk = await send({ action: 'downloadAllChapters', chapters: [{ chapterUrl: titleUrl + '/1-chapter-1', chapterLabel: 'Ch1' }] });
    assert.equal(rejectBulk.ok, false);
    assert.match(rejectBulk.error, /deprecated and disabled/);
    await worker.evaluate(() => CDLSettings.patchSettings({ 'download.enableAll': true }));
    await page.locator('.cdl-dl-all-btn:not(.cdl-sub-btn)').waitFor();
    await worker.evaluate(async target => {
      await chrome.scripting.executeScript({ target: { tabId: target }, func: async () => {
        await showDownloadAllOptionsPanel('Chapter progress test', [{
          chapterUrl: location.href + '/1-chapter-1', chapterLabel: 'Ch1', group: '', groupId: '',
        }]);
      } });
    }, tabId);
    await page.locator('#cdl-opts-panel').waitFor();
    assert.match(await page.locator('.cdl-op-deprecated').textContent(), /IP bans and Comix blocking/);
    await worker.evaluate(() => CDLSettings.patchSettings({ 'download.enableAll': false }));
    await page.locator('.cdl-dl-all-btn:not(.cdl-sub-btn)').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#cdl-opts-backdrop').count(), 0, 'Disabling closes the options overlay as well as its panel');

    await page.locator('.mchap-row .cdl-btn').nth(0).click();
    const panel = page.locator('#cdl-chapter-popup');
    await panel.locator('button', { hasText: 'Resume download' }).waitFor();
    assert.match(await panel.textContent(), /IP address/);
    assert.equal(await panel.locator('#cdl-cp-counter').textContent(), '1 / 3 images');
    await page.locator('.mchap-row .cdl-btn').nth(1).click();
    await panel.locator('.cdl-cp-row').filter({ hasText: 'Ch2' }).getByText('Queued', { exact: true }).waitFor();
    await panel.locator('.cdl-cp-row').filter({ hasText: 'Ch2' }).getByRole('button', { name: 'Cancel', exact: true }).click();
    await panel.locator('.cdl-cp-row').filter({ hasText: 'Ch2' }).getByText('Download cancelled', { exact: true }).waitFor();
    assert.equal(Object.keys(requests).some(key => key.startsWith('/2/')), false);
    await page.reload();
    await panel.locator('button', { hasText: 'Resume download' }).waitFor();
    assert.equal(await panel.locator('#cdl-cp-counter').textContent(), '1 / 3 images');
    const snapshot = await send({ action: 'getChapterDownloads' });
    assert.equal(snapshot.downloads.length, 1, 'Reload does not restore cancelled queue entries');
    const other = await context.newPage();
    await other.goto(titleUrl);
    const otherId = await worker.evaluate(async id => (await chrome.tabs.query({})).find(tab => tab.url === 'https://comix.to/title/chapter-progress' && tab.id !== id).id, tabId);
    assert.equal((await send({ action: 'getChapterDownloads' }, otherId)).downloads.length, 0);
    assert.equal((await send({ action: 'cancelChapterDownload', taskId: snapshot.downloads[0].taskId }, otherId)).ok, false);
    await other.close();
    for (const theme of ['dark', 'light', 'main']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 800 });
        await page.waitForTimeout(30);
        const box = await panel.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 801, JSON.stringify(box));
        assert.equal(await panel.getAttribute('data-cdl-theme'), theme === 'light' ? 'light' : 'dark');
        await page.screenshot({ path: path.join(screenshots, `chapter-progress-${theme}-${width}.png`) });
      }
    }
    banned = false;
    await panel.getByRole('button', { name: 'Resume download', exact: true }).click();
    await panel.getByText('Building CBZ: 0%', { exact: true }).first().waitFor();
    assert.equal(await panel.getAttribute('data-stage'), 'zip');
    await worker.evaluate(() => self.releaseBuild());
    await panel.getByText('Saving file - confirm or cancel in the browser save dialog', { exact: true }).first().waitFor();
    assert.equal(await panel.getAttribute('data-stage'), 'save');
    assert.equal(await panel.getByRole('button', { name: 'Cancel', exact: true }).count(), 0);
    assert.equal((await send({ action: 'cancelChapterDownload', taskId: snapshot.downloads[0].taskId })).ok, false);
    await worker.evaluate(() => self.releaseSave());
    await panel.getByRole('button', { name: 'Close', exact: true }).waitFor();
    assert.match(await panel.textContent(), /Download saved/);
    const downloads = await worker.evaluate(() => chrome.downloads.search({ state: 'complete' }));
    assert.equal(downloads.length, 1);
    // CDP's automatic-save override names offscreen blobs by UUID, ignoring the requested name.
    assert.match(await worker.evaluate(() => self.requestedFilename), /\.cbz$/);
    const archive = await JSZip.loadAsync(await fs.readFile(downloads[0].filename));
    const images = Object.values(archive.files).filter(entry => /\.jpg$/.test(entry.name));
    assert.equal(images.length, 3);
    for (const image of images) assert.deepEqual([...await image.async('uint8array')], [1, 2, 3]);
    assert.equal(requests['/1/1'], 1, 'Resume does not fetch completed pages again');
    await panel.getByRole('button', { name: 'Close', exact: true }).click();

    await page.locator('.mchap-row .cdl-btn').nth(2).click();
    await panel.getByRole('button', { name: 'Resume download', exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await panel.getByText('Download cancelled', { exact: true }).first().waitFor();
    await page.reload();
    await page.locator('.mchap-row .cdl-btn').first().waitFor();
    assert.equal(await panel.count(), 0, 'Cancelled chapters do not resurrect progress on reload');
    await page.locator('.mchap-row .cdl-btn').nth(3).click();
    await panel.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    releaseApi();
    await panel.getByText('Download cancelled', { exact: true }).first().waitFor();
    await page.waitForTimeout(100);
    assert.equal(Object.keys(requests).some(key => key.startsWith('/4/')), false, 'Cancellation while reading the chapter list prevents image requests');
    assert.equal((await worker.evaluate(() => chrome.downloads.search({ state: 'complete' }))).length, 1);
    assert.deepEqual(errors, []);
    console.log('PASS packaged default-off/live toggle and backend gate; single CBZ progress, queue cancellation, reload, tab isolation, Cloudflare resume, archive/save stages, saved bytes, early cancellation, 3 themes at desktop/mobile widths');
  } finally {
    if (releaseApi) releaseApi();
    if (context) await context.close();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('cdl-chapter-progress-'));
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
