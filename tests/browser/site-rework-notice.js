'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    const context = await browser.newContext();
    await context.route(/^https?:/, route => route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const output = path.join(root, 'output/playwright');
    await fs.mkdir(output, { recursive: true });
    for (const file of ['index.html', 'plus.html', 'Documentation.html']) {
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(pathToFileURL(path.join(root, 'docs', file)).href);
        const notice = page.locator('[data-service-notice]');
        await notice.waitFor();
        const box = await notice.boundingBox();
        assert.ok(box.y >= 0 && box.y < 120, `${file} ${width}: notice below the nav`);
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `${file} ${width}: notice fits`);
        const overflow = await notice.evaluate(node => [node, ...node.querySelectorAll('h2,p,summary')].some(element => element.scrollWidth > element.clientWidth + 1));
        assert.equal(overflow, false, `${file} ${width}: notice text fits`);
        assert.equal(await page.locator('a[href*="account?mode=create"]').count(), 0);
        assert.ok(await page.locator('a[href*="account?mode=login"]').count() > 0);
        assert.match(await notice.textContent(), /renewals have been stopped/);
        await page.screenshot({ path: path.join(output, `rework-${file.replace('.html', '')}-${width}.png`) });
        if (file === 'index.html') {
          await notice.locator('summary').click();
          assert.equal(await notice.locator('details').getAttribute('open'), '');
          assert.match(await notice.textContent(), /including Download All/);
          const detailOverflow = await notice.evaluate(node => [...node.querySelectorAll('p')].some(element => element.scrollWidth > element.clientWidth + 1));
          assert.equal(detailOverflow, false);
          await page.screenshot({ path: path.join(output, `rework-update-expanded-${width}.png`) });
        }
      }
    }
    const noScript = await browser.newContext({ javaScriptEnabled: false });
    await noScript.route(/^https?:/, route => route.abort());
    const staticPage = await noScript.newPage();
    await staticPage.goto(pathToFileURL(path.join(root, 'docs/index.html')).href);
    assert.match(await staticPage.locator('[data-service-notice]').textContent(), /Downloads may currently fail or be unusable/);
    assert.deepEqual(errors, []);
    console.log('PASS static warnings with/without JavaScript, expanded developer update, existing-account links and 1440/390/320 layouts');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
