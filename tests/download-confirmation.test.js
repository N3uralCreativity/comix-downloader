'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) passed++;
  else { failed++; console.error('FAIL:', name); }
}

function extractFunction(name) {
  const marker = source.indexOf(`function ${name}(`);
  if (marker === -1) throw new Error(`Missing function ${name}`);
  const start = source.slice(Math.max(0, marker - 6), marker) === 'async ' ? marker - 6 : marker;
  const bodyStart = source.indexOf('{', source.indexOf(')', marker));
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;

  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
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

const helperSource = [
  'downloadErrorText',
  'isDownloadCancelledError',
  'makeDownloadCancelledError',
  'tagDownloadError',
  'waitForBrowserDownload',
  'startAndConfirmBrowserDownload',
].map(extractFunction).join('\n');

let startError = null;
let startId = 17;
let searchResults = [];
const helperContext = {
  DOWNLOAD_CONFIRM_POLL_MS: 0,
  DOWNLOAD_CONFIRM_TIMEOUT_MS: 1000,
  chrome: {
    downloads: {
      async download() {
        if (startError) throw startError;
        return startId;
      },
      async search() {
        if (searchResults.length > 1) return searchResults.shift();
        return searchResults[0] || [];
      },
    },
  },
  console,
  setTimeout,
};
vm.createContext(helperContext);
vm.runInContext(`${helperSource}\n globalThis.api = { startAndConfirmBrowserDownload };`, helperContext);

let archiveDelivery = { confirmed: true, fallback: false, downloadId: 17 };
let archiveError = null;
let fallbackCalls = 0;
let revokeCalls = 0;
const archiveContext = {
  _IS_FIREFOX: true,
  startAndConfirmBrowserDownload: async () => {
    if (archiveError) throw archiveError;
    return { id: 17 };
  },
  chrome: {
    tabs: {
      async sendMessage() { fallbackCalls++; return { ok: true, confirmed: false }; },
    },
  },
  console,
};
vm.createContext(archiveContext);
vm.runInContext(`
  ${extractFunction('downloadErrorText')}
  ${extractFunction('isDownloadCancelledError')}
  ${extractFunction('makeDownloadCancelledError')}
  ${extractFunction('saveGeneratedArchive')}
  globalThis.saveGeneratedArchive = saveGeneratedArchive;
`, archiveContext);

const zipEvents = { records: [], done: [], errors: [], cancelled: 0 };
let zipDelivery = archiveDelivery;
let zipDeliveryError = null;
const zipContext = {
  _pendingZip: {},
  _zipToDownloadUrl: async () => ({ url: 'blob:test', revoke() {}, base64: null }),
  sanitizeFilename: (name) => name.endsWith('.zip') ? name : `${name}.zip`,
  saveGeneratedArchive: async () => {
    if (zipDeliveryError) throw zipDeliveryError;
    return zipDelivery;
  },
  recordChapterDownloaded: (_slug, label) => zipEvents.records.push(label),
  cdlLog() {},
  notifyDownloadAllDone: (_tabId, filename, warning) => zipEvents.done.push({ filename, warning }),
  notifyDownloadAllError: (_tabId, error) => zipEvents.errors.push(error),
  notifyDownloadAllCancelled: () => { zipEvents.cancelled++; },
  console,
};
vm.createContext(zipContext);
vm.runInContext(`
  ${extractFunction('downloadErrorText')}
  ${extractFunction('isDownloadCancelledError')}
  ${extractFunction('_doZipAndSave')}
  globalThis.doZipAndSave = _doZipAndSave;
`, zipContext);

function resetZipEvents() {
  zipEvents.records.length = 0;
  zipEvents.done.length = 0;
  zipEvents.errors.length = 0;
  zipEvents.cancelled = 0;
  zipDeliveryError = null;
}

async function run() {
  startError = null;
  searchResults = [
    [{ id: 17, state: 'in_progress' }],
    [{ id: 17, state: 'complete', exists: true }],
  ];
  const completed = await helperContext.api.startAndConfirmBrowserDownload(
    { url: 'blob:test', filename: 'chapter.zip' },
    { pollMs: 0, timeoutMs: 1000 }
  );
  check('manifest eligibility waits for the DownloadItem complete state', completed.state === 'complete');

  startError = new Error('Download canceled by the user');
  let startCancellation = null;
  try { await helperContext.api.startAndConfirmBrowserDownload({ url: 'blob:test' }); }
  catch (error) { startCancellation = error; }
  check('closing the Save dialog is normalized as cancellation',
    startCancellation && startCancellation.code === 'DOWNLOAD_CANCELLED');

  startError = null;
  searchResults = [[{ id: 17, state: 'interrupted', error: 'USER_CANCELED' }]];
  let interruptedCancellation = null;
  try {
    await helperContext.api.startAndConfirmBrowserDownload({ url: 'blob:test' }, { pollMs: 0, timeoutMs: 1000 });
  } catch (error) { interruptedCancellation = error; }
  check('USER_CANCELED terminal state is not treated as complete',
    interruptedCancellation && interruptedCancellation.code === 'DOWNLOAD_CANCELLED');

  searchResults = [[{ id: 17, state: 'interrupted', error: 'FILE_NO_SPACE' }]];
  let interruption = null;
  try {
    await helperContext.api.startAndConfirmBrowserDownload({ url: 'blob:test' }, { pollMs: 0, timeoutMs: 1000 });
  } catch (error) { interruption = error; }
  check('non-user interruptions remain errors and identify the transfer phase',
    interruption && interruption.code !== 'DOWNLOAD_CANCELLED' &&
    interruption.downloadPhase === 'transfer' && interruption.message.includes('FILE_NO_SPACE'));

  archiveError = Object.assign(new Error('Download cancelled.'), { code: 'DOWNLOAD_CANCELLED' });
  fallbackCalls = 0;
  revokeCalls = 0;
  let archiveCancellation = null;
  try {
    await archiveContext.saveGeneratedArchive({
      url: 'data:test', revoke: () => { revokeCalls++; }, base64: 'AA==',
      zip: { generateAsync: async () => 'AA==' }, filename: 'chapter.zip', originTabId: 4,
    });
  } catch (error) { archiveCancellation = error; }
  check('user cancellation never falls through to the Firefox page fallback',
    archiveCancellation && archiveCancellation.code === 'DOWNLOAD_CANCELLED' && fallbackCalls === 0 && revokeCalls === 1);

  archiveError = Object.assign(new Error('downloads API unavailable'), { downloadPhase: 'start' });
  const fallback = await archiveContext.saveGeneratedArchive({
    url: 'data:test', revoke() {}, base64: 'AA==',
    zip: { generateAsync: async () => 'AA==' }, filename: 'chapter.zip', originTabId: 4,
  });
  check('Firefox start failure can use an explicitly unconfirmed page fallback',
    fallback.confirmed === false && fallback.fallback === true && fallbackCalls === 1);

  resetZipEvents();
  zipDelivery = { confirmed: true, fallback: false, downloadId: 17 };
  const confirmedZip = await zipContext.doZipAndSave({
    zip: {}, zipName: 'series.zip', originTabId: 4, notifyDone: false,
    chapterRecords: [{ chapterLabel: 'Ch1' }, { chapterLabel: 'Ch2' }],
    slug: 'series', mangaName: 'Series',
  });
  check('confirmed ZIP part records only the chapters inside that part',
    confirmedZip.confirmed === true && zipEvents.records.join(',') === 'Ch1,Ch2');

  resetZipEvents();
  zipDelivery = { confirmed: false, fallback: true, downloadId: null };
  const unconfirmedZip = await zipContext.doZipAndSave({
    zip: {}, zipName: 'series.zip', originTabId: 4, notifyDone: false,
    chapterRecords: [{ chapterLabel: 'Ch3' }], slug: 'series', mangaName: 'Series',
  });
  check('unverified fallback does not record chapters as downloaded',
    unconfirmedZip.confirmed === false && zipEvents.records.length === 0);

  resetZipEvents();
  zipDeliveryError = Object.assign(new Error('Download cancelled.'), { code: 'DOWNLOAD_CANCELLED' });
  const cancelledZip = await zipContext.doZipAndSave({
    zip: {}, zipName: 'series.zip', originTabId: 4,
    chapterRecords: [{ chapterLabel: 'Ch4' }], slug: 'series', mangaName: 'Series',
  });
  check('cancelled multipart Save dialog reports cancellation and records nothing',
    cancelledZip === null && zipEvents.cancelled === 1 && zipEvents.records.length === 0 && zipEvents.errors.length === 0);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
