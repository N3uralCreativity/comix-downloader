'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { MessageChannel } = require('node:worker_threads');
const JSZip = require('../lib/jszip.min.js');
const root = path.join(__dirname, '..');
const helper = fs.readFileSync(path.join(root, 'core/cdl-download-url.js'), 'utf8');
const documentSource = fs.readFileSync(path.join(root, 'offscreen/downloads.js'), 'utf8');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const functions = background.slice(background.indexOf('async function _zipToDownloadUrl('), background.indexOf('const DOWNLOAD_CONFIRM_POLL_MS'));
const firefoxDetection = background.match(/^const _IS_FIREFOX = .+;$/m)[0];
const origin = 'chrome-extension://test-extension/';

function harness() {
  let active = false, created = 0, closed = 0, receiver, listener, failCreate = false, failPost = false;
  let searches = 0, failSearch = false, downloadItems = [];
  let postMode = '', fastTimeout = false;
  const blobs = new Map();
  const counters = { next: 1 };
  const runtime = { id: 'test-extension', getURL: (file) => origin + file };
  const document = {
    Blob,
    URL: {
      createObjectURL(blob) { const url = `blob:${origin}${counters.next++}`; blobs.set(url, blob); return url; },
      revokeObjectURL(url) { blobs.delete(url); },
    },
    chrome: { runtime },
    navigator: { serviceWorker: { addEventListener(_type, fn) { receiver = fn; } } },
    setTimeout() { return 1; },
  };
  vm.createContext(document);
  vm.runInContext(documentSource, document);
  const client = {
    url: origin + 'offscreen/downloads.html',
    postMessage(data, ports) {
      if (failPost) throw new Error('Client disappeared');
      if (postMode === 'silent') return;
      if (postMode === 'invalid') {
        ports[0].postMessage({ ok: true, url: 'https://invalid.example/archive.zip' });
        return;
      }
      const message = structuredClone({ data, ports }, { transfer: ports });
      receiver({ ...message, source: { scriptURL: origin + 'background.js' } });
    },
  };
  const environment = {
    Blob, Uint8Array, btoa, URL: {}, crypto: webcrypto, MessageChannel, clearTimeout,
    setTimeout: (callback, ms) => setTimeout(callback, fastTimeout ? 10 : ms),
    clients: { async matchAll() { return active ? [client] : []; } },
    chrome: {
      runtime: { ...runtime, onMessage: { addListener(fn) { listener = fn; } } },
      offscreen: {
        async createDocument(options) {
          assert.equal(options.url, 'offscreen/downloads.html');
          assert.deepEqual([...options.reasons], ['BLOBS']);
          if (failCreate) throw new Error('Offscreen creation rejected');
          assert.equal(active, false, 'Only one document may be created');
          created++;
          active = true;
        },
        async closeDocument() { active = false; closed++; },
      },
      downloads: { async search() {
        searches++;
        if (failSearch) throw new Error('Download state unavailable');
        return downloadItems;
      } },
    },
  };
  let worker;
  function restart() {
    worker = vm.createContext({ ...environment, _IS_FIREFOX: false });
    vm.runInContext(helper + '\n' + functions, worker);
  }
  restart();
  const maintain = () => new Promise((resolve) => {
    listener({ action: 'cdlDownloadUrlMaintenance' }, { id: runtime.id, url: client.url }, resolve);
  });
  return {
    get api() { return worker.CDLDownloadUrl; }, get worker() { return worker; },
    blobs, maintain, restart,
    counts() { return { active, created, closed, searches }; },
    failCreate(value) { failCreate = value; }, failPost(value) { failPost = value; },
    postMode(value) { postMode = value; fastTimeout = value === 'silent'; },
    failSearch(value) { failSearch = value; }, downloads(value) { downloadItems = value; },
    unsupported() { worker.chrome = { runtime: environment.chrome.runtime }; },
    message(data, sender) { return listener(data, sender, () => assert.fail('Untrusted message accepted')); },
    documentMessage(data, ports, source) { receiver({ data, ports, source }); },
  };
}

async function testBinaryOutput() {
  const h = harness();
  assert.equal(h.counts().created, 0, 'Loading the helper must not create an offscreen document');
  assert.equal(h.worker.URL.createObjectURL, undefined, 'Exercise the real MV3 API limitation');
  const chapter = new JSZip();
  chapter.file('001.jpg', new Uint8Array([1, 2, 3]));
  const cbz = await chapter.generateAsync({ type: 'uint8array' });
  const outer = new JSZip();
  outer.file('chapter.cbz', cbz);
  const progress = [];
  const pdf = new TextEncoder().encode('%PDF-1.4\nfixture\n%%EOF');
  const urls = await Promise.all([
    h.worker._zipToDownloadUrl(outer, (metadata) => progress.push(metadata.percent)),
    h.worker._bytesToDownloadUrl(cbz, 'application/vnd.comicbook+zip'),
    h.worker._bytesToDownloadUrl(pdf, 'application/pdf'),
  ]);
  assert.equal(h.counts().created, 1, 'Concurrent formats share one offscreen document');
  assert.equal(h.blobs.size, 3);
  assert.ok(progress.includes(100), 'ZIP progress is retained');
  const restored = await JSZip.loadAsync(await h.blobs.get(urls[0].url).arrayBuffer());
  assert.deepEqual(await restored.file('chapter.cbz').async('uint8array'), cbz);
  assert.deepEqual(new Uint8Array(await h.blobs.get(urls[1].url).arrayBuffer()), cbz);
  assert.deepEqual(new Uint8Array(await h.blobs.get(urls[2].url).arrayBuffer()), pdf);
  assert.equal(h.blobs.get(urls[2].url).type, 'application/pdf');
  assert.equal((await h.maintain()).ok, true);
  assert.equal(h.blobs.size, 3, 'Pending saves and Save again must retain their URLs');
  assert.equal(h.counts().searches, 0, 'Normal cleanup must not scan browser downloads');
  await urls[0].revoke();
  await urls[0].revoke();
  assert.equal(h.blobs.size, 2, 'Release is idempotent and cannot release another download');
  await urls[1].revoke();
  await urls[2].revoke();
  await h.maintain();
  assert.equal(h.blobs.size, 0);
  assert.equal(h.counts().closed, 1, 'Idle documents are closed after all saves release their URLs');
}

async function testRecovery() {
  const h = harness();
  const pending = await h.api.fromBlob(new Blob(['pending save']));
  const orphan = await h.api.fromBlob(new Blob(['abandoned']));
  h.restart();
  h.downloads([{ url: pending.url, state: 'in_progress' }]);
  await h.maintain();
  assert.equal(h.blobs.has(pending.url), true, 'An in-progress save survives a worker restart');
  assert.equal(h.blobs.has(orphan.url), false, 'A worker restart cannot leak abandoned archive bytes');
  h.failSearch(true);
  assert.equal((await h.maintain()).ok, false);
  assert.equal(h.blobs.has(pending.url), true, 'An unavailable download manager must not cause premature cleanup');
  h.failSearch(false);
  h.downloads([]);
  await h.maintain();
  assert.equal(h.blobs.size, 0);
  assert.equal(h.counts().closed, 1);
}

async function testFailuresAndFallback() {
  const h = harness();
  h.failCreate(true);
  await assert.rejects(h.api.fromBlob(new Blob(['test'])), /Offscreen creation rejected/);
  h.failCreate(false);
  h.failPost(true);
  await assert.rejects(h.api.fromBlob(new Blob(['test'])), /Client disappeared/);
  h.failPost(false);
  h.postMode('silent');
  await assert.rejects(h.api.fromBlob(new Blob(['timeout'])), (error) =>
    error.cdlKind === 'archive_url' && /did not respond/.test(error.message));
  h.postMode('invalid');
  await assert.rejects(h.api.fromBlob(new Blob(['invalid response'])), /invalid URL/);
  h.postMode('');
  const retry = await h.api.fromBlob(new Blob(['retry']));
  assert.equal(h.blobs.size, 1, 'Failures release the operation lock and allow retry');
  await retry.revoke();
  await h.maintain();
  assert.equal(h.message({ action: 'cdlDownloadUrlMaintenance' }, { id: 'other', url: origin + 'offscreen/downloads.html' }), undefined);
  assert.equal(h.message({ action: 'cdlDownloadUrlMaintenance' }, { id: 'test-extension', url: 'https://comix.to/' }), undefined);
  const channel = new MessageChannel();
  try {
    h.documentMessage({ target: 'cdl-download-url', command: 'create', id: 'untrusted', blob: new Blob(['bad']) },
      [channel.port2], { scriptURL: origin + 'untrusted.js' });
    assert.equal(h.blobs.size, 0, 'Only the background worker may create offscreen URLs');
  } finally {
    channel.port1.close();
    channel.port2.close();
  }

  const zip = new JSZip();
  zip.file('fixture.txt', 'fallback');
  h.unsupported();
  assert.equal(h.api.supported(), false);
  assert.match((await h.worker._zipToDownloadUrl(zip)).url, /^data:application\/zip;base64,/);
  const bytes = new Uint8Array([0, 255, 3]);
  assert.equal((await h.worker._bytesToDownloadUrl(bytes, 'application/pdf')).url, 'data:application/pdf;base64,AP8D');
  h.worker._IS_FIREFOX = true;
  assert.match((await h.worker._zipToDownloadUrl(zip)).url, /^data:application\/zip;base64,/);
  assert.equal(h.counts().created, 1, 'Unsupported browsers and Firefox do not open offscreen documents');
}

function testBrowserDetection() {
  for (const [url, browser, expected] of [
    ['chrome-extension://test/', undefined, false],
    ['chrome-extension://test/', {}, false],
    ['moz-extension://test/', {}, true],
  ]) {
    const context = vm.createContext({ browser, chrome: { runtime: { getURL: () => url } } });
    assert.equal(vm.runInContext(firefoxDetection + '\n_IS_FIREFOX', context), expected,
      'A browser namespace alias in Chromium must not enable Firefox download fallbacks');
  }
}

(async () => {
  testBrowserDetection();
  await testBinaryOutput();
  await testRecovery();
  await testFailuresAndFallback();
  console.log('download-url.test.js: all tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
