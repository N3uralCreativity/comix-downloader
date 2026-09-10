'use strict';

// Run after building the Chromium package. Unlike the VM tests, this exercises
// the packaged MV3 worker, real offscreen document, and browser downloads API.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const extension = path.resolve(__dirname, '../../dist/package-work/chrome');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cdl-archive-smoke-'));
  const downloadDir = path.join(temp, 'downloads');
  await fs.mkdir(downloadDir);
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
      channel: 'chromium', headless: true, acceptDownloads: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    await context.route(/^https?:/, (route) => route.abort());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    const results = await worker.evaluate(async () => {
      if (typeof URL.createObjectURL !== 'undefined') throw new Error('Expected an MV3 worker without createObjectURL');
      if (!CDLDownloadUrl.supported() || _IS_FIREFOX) {
        throw new Error(`Unexpected download runtime: ${JSON.stringify({
          workerUrl: self.location.href, firefox: _IS_FIREFOX,
          offscreen: typeof chrome.offscreen?.createDocument,
          clients: typeof self.clients?.matchAll, messageChannel: typeof MessageChannel,
        })}`);
      }
      const before = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (before.length) throw new Error('The extension opened an offscreen document before any archive was requested');

      const bytes = new Uint8Array(8 * 1024 * 1024);
      for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
      const chapter = new JSZip();
      chapter.file('001.jpg', bytes);
      const cbz = await chapter.generateAsync({ type: 'uint8array', compression: 'STORE' });
      const outer = new JSZip();
      outer.file('Chapter-01.cbz', cbz);
      const pdf = await PDFLib.PDFDocument.create();
      pdf.addPage().drawText('Comix Downloader archive smoke test');
      const pdfBytes = await pdf.save();

      const outputs = await Promise.all([
        _zipToDownloadUrl(outer),
        _zipToDownloadUrl(chapter),
        _bytesToDownloadUrl(cbz, 'application/vnd.comicbook+zip'),
        _bytesToDownloadUrl(pdfBytes, 'application/pdf'),
      ]);
      const documents = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (documents.length !== 1) throw new Error(`Expected one shared offscreen document, got ${documents.length}`);
      const names = ['bundled-cbz-part-01.zip', 'images.zip', 'chapter.cbz', 'chapter.pdf'];
      const results = [];
      const hash = async (buffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))]
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
      for (let i = 0; i < outputs.length; i++) {
        const output = outputs[i];
        if (!output.url.startsWith('blob:chrome-extension://')) throw new Error('Chromium must use binary Blob URLs');
        const buffer = await (await fetch(output.url)).arrayBuffer();
        if (i === 0) {
          const bundled = await JSZip.loadAsync(buffer);
          const inner = await bundled.file('Chapter-01.cbz').async('uint8array');
          if (await hash(inner) !== await hash(cbz)) throw new Error('Bundled CBZ bytes were changed');
        }
        const saved = await saveGeneratedArchive({ ...output, filename: names[i], originTabId: null });
        if (!saved.confirmed) throw new Error('The browser did not confirm the save');
        await output.revoke();
        const item = (await chrome.downloads.search({ id: saved.downloadId }))[0];
        if (item.state !== 'complete' || !item.exists) throw new Error('The file was not saved to disk');
        results.push({ format: names[i], filename: item.filename, size: buffer.byteLength, sha256: await hash(buffer) });
        let accessible = false;
        try { accessible = (await fetch(output.url)).ok; } catch (_) {}
        if (accessible) throw new Error('The saved archive URL was not revoked');
      }
      return results;
    });
    for (const result of results) {
      const relative = path.relative(downloadDir, result.filename);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Test output escaped the temporary download directory');
      const data = await fs.readFile(result.filename);
      assert.equal(data.length, result.size);
      assert.equal(createHash('sha256').update(data).digest('hex'), result.sha256, result.format);
      console.log(`PASS real Chromium save: ${result.format} (${data.length} bytes, SHA-256 verified)`);
    }
    // The offscreen document should close once its periodic cleanup finds no URLs.
    const cleanupDeadline = Date.now() + 40000;
    let openDocuments;
    do {
      openDocuments = await worker.evaluate(async () =>
        (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length);
      if (!openDocuments) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < cleanupDeadline);
    assert.equal(openDocuments, 0, 'The idle offscreen document was not closed');
    console.log('PASS idle offscreen document cleanup');
    console.log('archive-downloads.js: all real MV3 download checks passed');
  } finally {
    if (context) await context.close();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('cdl-archive-smoke-'), 'Refusing to remove an unexpected temporary directory');
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
