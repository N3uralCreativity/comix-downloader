'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error('FAIL:', name);
  }
}

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`Missing function ${name}`);

  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }

  throw new Error(`Unterminated function ${name}`);
}

const started = [];
const controls = new Map();
const messages = [];

const context = {
  console: { error() {} },
  cdlLog() {},
  notifyTab(tabId, message) { messages.push({ tabId, ...message }); },
  downloadImagesAsZip(payload) {
    started.push(payload.id);
    return new Promise((resolve, reject) => controls.set(payload.id, { resolve, reject }));
  },
};
vm.createContext(context);
vm.runInContext(`
  let activeChapterDownloads = 0;
  const downloadQueue = [];
  ${extractFunction('chapterConcurrencyLimit')}
  ${extractFunction('scheduleDownload')}
  ${extractFunction('processDownloadQueue')}
  globalThis.queueApi = {
    scheduleDownload,
    chapterConcurrencyLimit,
    stats: () => ({ active: activeChapterDownloads, queued: downloadQueue.length }),
  };
`, context);

const api = context.queueApi;
const payload = (id, limit) => ({
  id,
  chapterUrl: `https://comix.to/title/series/${id}-chapter-${id}`,
  zipName: `chapter-${id}`,
  originTabId: 42,
  images: [{}, {}, {}],
  cfg: limit == null ? {} : { 'download.concurrentChapters': limit },
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function run() {
  check('default concurrency is 2', api.chapterConcurrencyLimit({}) === 2);
  check('concurrency is clamped to 1', api.chapterConcurrencyLimit({ 'download.concurrentChapters': 0 }) === 1);
  check('concurrency is clamped to 10', api.chapterConcurrencyLimit({ 'download.concurrentChapters': 99 }) === 10);

  api.scheduleDownload(payload('a'));
  api.scheduleDownload(payload('b'));
  api.scheduleDownload(payload('c'));

  check('two individual chapters start immediately', started.join(',') === 'a,b');
  check('third individual chapter waits in FIFO queue', api.stats().active === 2 && api.stats().queued === 1);
  check('queued progress is reported for every chapter',
    messages.filter((message) => message.action === 'downloadProgress' && message.current === 0 && message.total === 3).length === 3);

  controls.get('a').resolve();
  await flush();
  check('finishing one chapter starts the next', started.join(',') === 'a,b,c');
  check('the pool remains at its configured limit', api.stats().active === 2 && api.stats().queued === 0);

  controls.get('b').resolve();
  controls.get('c').resolve();
  await flush();
  check('all slots are released after completion', api.stats().active === 0 && api.stats().queued === 0);

  api.scheduleDownload(payload('d', 1));
  api.scheduleDownload(payload('e', 1));
  check('limit 1 retains serial behavior', started.join(',') === 'a,b,c,d' && api.stats().queued === 1);

  controls.get('d').reject(new Error('expected test failure'));
  await flush();
  check('a failed chapter releases its slot', started.join(',') === 'a,b,c,d,e');
  check('a failed chapter reports its own URL', messages.some((message) =>
    message.action === 'downloadError' && message.chapterUrl.includes('/d-chapter-d')));

  controls.get('e').resolve();
  await flush();
  check('the serial pool drains after the replacement task', api.stats().active === 0 && api.stats().queued === 0);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
