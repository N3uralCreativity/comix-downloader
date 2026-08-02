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
  'downloadItemProgressPercent',
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
vm.runInContext(`${helperSource}\n globalThis.api = { downloadItemProgressPercent, startAndConfirmBrowserDownload };`, helperContext);

const zipGenerationContext = {
  _IS_FIREFOX: false,
  Blob,
  URL: {
    createObjectURL: () => 'blob:generated',
    revokeObjectURL() {},
  },
};
vm.createContext(zipGenerationContext);
vm.runInContext(`
  ${extractFunction('generateChromiumZipBlob')}
  ${extractFunction('_zipToDownloadUrl')}
  globalThis.zipToDownloadUrl = _zipToDownloadUrl;
`, zipGenerationContext);

let archiveDelivery = { confirmed: true, fallback: false, downloadId: 17 };
let archiveError = null;
let archiveErrors = [];
let archiveDownloadOptions = [];
let fallbackCalls = 0;
let revokeCalls = 0;
let archiveIsMobile = false;
const archiveContext = {
  _IS_FIREFOX: true,
  SAVE_DIALOG_AUTO_RETRY_DELAY_MS: 0,
  isMobileBrowserPlatform: async () => archiveIsMobile,
  startAndConfirmBrowserDownload: async (options, waitOptions) => {
    archiveDownloadOptions.push(options);
    const nextError = archiveErrors.length ? archiveErrors.shift() : archiveError;
    if (nextError) throw nextError;
    if (waitOptions && waitOptions.onProgress) {
      waitOptions.onProgress({ id: 17, state: 'in_progress', bytesReceived: 50, totalBytes: 100 });
      waitOptions.onProgress({ id: 17, state: 'complete', bytesReceived: 100, totalBytes: 100 });
    }
    return { id: 17, state: 'complete', bytesReceived: 100, totalBytes: 100 };
  },
  chrome: {
    tabs: {
      async sendMessage() { fallbackCalls++; return { ok: true, confirmed: false, handoff: true }; },
    },
  },
  console,
  setTimeout,
};
vm.createContext(archiveContext);
vm.runInContext(`
  ${extractFunction('downloadErrorText')}
  ${extractFunction('isDownloadCancelledError')}
  ${extractFunction('isRetryableSaveCancellation')}
  ${extractFunction('makeDownloadCancelledError')}
  ${extractFunction('isArchiveDeliveryAccepted')}
  ${extractFunction('saveGeneratedArchive')}
  globalThis.saveGeneratedArchive = saveGeneratedArchive;
`, archiveContext);

const zipEvents = { records: [], done: [], errors: [], cancelled: 0 };
let zipDelivery = archiveDelivery;
let zipDeliveryError = null;
let zipDeliverySequence = [];
let zipGenerationCalls = 0;
let zipSaveOptions = [];
let zipSaveCancellationDecision = false;
let zipKeepAliveCalls = 0;
const zipContext = {
  _pendingZip: {},
  _zipToDownloadUrl: async () => {
    zipGenerationCalls++;
    return { url: 'blob:test', revoke() {}, base64: null };
  },
  sanitizeFilename: (name) => name.endsWith('.zip') ? name : `${name}.zip`,
  saveGeneratedArchive: async (options) => {
    zipSaveOptions.push(options);
    const next = zipDeliverySequence.length ? zipDeliverySequence.shift() : zipDeliveryError;
    if (next) throw next;
    return zipDelivery;
  },
  withExtensionKeepAlive: async (task) => {
    zipKeepAliveCalls++;
    return task();
  },
  recordChapterDownloaded: (_slug, label) => zipEvents.records.push(label),
  cdlLog() {},
  notifyDownloadAllDone: (_tabId, filename, warning) => zipEvents.done.push({ filename, warning }),
  notifyDownloadAllError: (_tabId, error, options) => zipEvents.errors.push({ error, options }),
  notifyDownloadAllSaveCancelled: () => {
    zipEvents.saveCancelled++;
    setTimeout(() => zipContext.resolvePendingArchiveSaveDecision(zipSaveCancellationDecision), 0);
  },
  notifyDownloadAllCancelled: () => { zipEvents.cancelled++; },
  console,
  setTimeout,
};
vm.createContext(zipContext);
vm.runInContext(`
  ${extractFunction('downloadErrorText')}
  ${extractFunction('describeArchiveFailure')}
  ${extractFunction('isDownloadCancelledError')}
  ${extractFunction('isArchiveDeliveryAccepted')}
  ${extractFunction('releasePendingGeneratedArchive')}
  ${extractFunction('waitForPendingArchiveSaveDecision')}
  ${extractFunction('resolvePendingArchiveSaveDecision')}
  ${extractFunction('_doZipAndSave')}
  globalThis.resolvePendingArchiveSaveDecision = resolvePendingArchiveSaveDecision;
  globalThis.doZipAndSave = (pending) => {
    _pendingZip = pending;
    return _doZipAndSave(pending);
  };
  globalThis.hasPendingZip = () => !!_pendingZip;
`, zipContext);

function resetZipEvents() {
  zipEvents.records.length = 0;
  zipEvents.done.length = 0;
  zipEvents.errors.length = 0;
  zipEvents.cancelled = 0;
  zipEvents.saveCancelled = 0;
  zipDeliveryError = null;
  zipDeliverySequence = [];
  zipGenerationCalls = 0;
  zipSaveOptions = [];
  zipSaveCancellationDecision = false;
  zipKeepAliveCalls = 0;
}

async function run() {
  const zipUpdates = [];
  let zipOptions = null;
  const generatedUrl = await zipGenerationContext.zipToDownloadUrl({
    async generateAsync(options, onUpdate) {
      zipOptions = options;
      onUpdate({ percent: 12.5, currentFile: '001.webp' });
      onUpdate({ percent: 100, currentFile: '' });
      return {};
    },
  }, (metadata) => zipUpdates.push(metadata.percent));
  check('JSZip progress metadata is forwarded without changing STORE output',
    generatedUrl.url === 'blob:generated' && zipOptions.type === 'blob' &&
    zipOptions.compression === 'STORE' && zipUpdates.join(',') === '12.5,100');

  let streamOptions = null;
  const streamUpdates = [];
  const streamedUrl = await zipGenerationContext.zipToDownloadUrl({
    generateInternalStream(options) {
      streamOptions = options;
      const handlers = {};
      return {
        on(event, handler) { handlers[event] = handler; return this; },
        resume() {
          handlers.data(new Uint8Array([1, 2]), { percent: 50, currentFile: '001.webp' });
          handlers.data(new Uint8Array([3, 4]), { percent: 100, currentFile: '' });
          handlers.end();
        },
      };
    },
  }, (metadata) => streamUpdates.push(metadata.percent));
  check('Chromium ZIP generation streams chunks without changing STORE compression',
    streamedUrl.url === 'blob:generated' && streamOptions.type === 'uint8array' &&
    streamOptions.compression === 'STORE' && streamOptions.streamFiles === true &&
    streamUpdates.join(',') === '50,100');

  let hiddenFallbackCalls = 0;
  let streamFailure = null;
  try {
    await zipGenerationContext.zipToDownloadUrl({
      generateInternalStream() {
        const handlers = {};
        return {
          on(event, handler) { handlers[event] = handler; return this; },
          resume() { handlers.error(new Error('allocation failed')); },
        };
      },
      async generateAsync() { hiddenFallbackCalls++; return 'AA=='; },
    });
  } catch (error) { streamFailure = error; }
  check('Chromium surfaces ZIP generation failures without a hidden base64 rebuild',
    streamFailure && streamFailure.message === 'allocation failed' && hiddenFallbackCalls === 0);

  archiveError = null;
  archiveErrors = [];
  archiveDownloadOptions = [];
  const saveUpdates = [];
  const confirmedArchive = await archiveContext.saveGeneratedArchive({
    url: 'blob:test', revoke() {}, base64: null,
    zip: { generateAsync: async () => 'AA==' }, filename: 'chapter.zip', originTabId: 4,
    onSaveProgress: (item) => saveUpdates.push(item.state),
  });
  check('archive delivery reports browser start, transfer, and completion states',
    confirmedArchive.confirmed === true && saveUpdates.join(',') === 'starting,in_progress,complete' &&
    archiveDownloadOptions.length === 1 && archiveDownloadOptions[0].saveAs === false);

  archiveError = null;
  archiveErrors = [Object.assign(new Error('Download cancelled.'), { code: 'DOWNLOAD_CANCELLED' }), null];
  archiveDownloadOptions = [];
  revokeCalls = 0;
  const automaticRetryUpdates = [];
  const retriedArchive = await archiveContext.saveGeneratedArchive({
    url: 'blob:test', revoke: () => { revokeCalls++; }, base64: null,
    zip: { generateAsync: async () => 'AA==' }, filename: 'chapter.zip', originTabId: 4,
    cancelRetryDelayMs: 0,
    onSaveProgress: (item) => automaticRetryUpdates.push(item.state),
  });
  check('an accidentally closed Save dialog is opened one more time automatically',
    retriedArchive.confirmed === true && archiveDownloadOptions.length === 2 &&
    archiveDownloadOptions[0].saveAs === false && archiveDownloadOptions[1].saveAs === true &&
    automaticRetryUpdates.includes('retrying') && revokeCalls === 1);

  startError = null;
  searchResults = [
    [{ id: 17, state: 'in_progress', bytesReceived: 25, totalBytes: 100 }],
    [{ id: 17, state: 'complete', bytesReceived: 100, totalBytes: 100, exists: true }],
  ];
  const observedProgress = [];
  const completed = await helperContext.api.startAndConfirmBrowserDownload(
    { url: 'blob:test', filename: 'chapter.zip' },
    { pollMs: 0, timeoutMs: 1000, onProgress: (item) => observedProgress.push(item.state) }
  );
  check('manifest eligibility waits for the DownloadItem complete state', completed.state === 'complete');
  check('browser save polling reports in-progress and complete snapshots',
    observedProgress.join(',') === 'in_progress,complete');
  check('browser save percentage uses DownloadItem byte counts',
    helperContext.api.downloadItemProgressPercent({ state: 'in_progress', bytesReceived: 25, totalBytes: 100 }) === 25 &&
    helperContext.api.downloadItemProgressPercent({ state: 'complete', bytesReceived: 0, totalBytes: -1 }) === 100 &&
    helperContext.api.downloadItemProgressPercent({ state: 'in_progress', bytesReceived: 0, totalBytes: -1 }) === null);

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
  archiveErrors = [];
  archiveDownloadOptions = [];
  fallbackCalls = 0;
  revokeCalls = 0;
  let archiveCancellation = null;
  try {
    await archiveContext.saveGeneratedArchive({
      url: 'data:test', revoke: () => { revokeCalls++; }, base64: 'AA==',
      zip: { generateAsync: async () => 'AA==' }, filename: 'chapter.zip', originTabId: 4,
      cancelRetryDelayMs: 0,
    });
  } catch (error) { archiveCancellation = error; }
  check('two user cancellations never fall through to the Firefox page fallback',
    archiveCancellation && archiveCancellation.code === 'DOWNLOAD_CANCELLED' &&
    archiveDownloadOptions.length === 2 && fallbackCalls === 0 && revokeCalls === 1);

  archiveDownloadOptions = [];
  revokeCalls = 0;
  let preservedCancellation = null;
  try {
    await archiveContext.saveGeneratedArchive({
      url: 'data:test', revoke: () => { revokeCalls++; }, base64: 'AA==',
      zip: { generateAsync: async () => 'AA==' }, filename: 'chapter.zip', originTabId: 4,
      cancelRetryDelayMs: 0, preserveOnCancel: true,
    });
  } catch (error) { preservedCancellation = error; }
  check('Download All can retain the prepared archive after both Save dialogs are closed',
    preservedCancellation && preservedCancellation.code === 'DOWNLOAD_CANCELLED' &&
    archiveDownloadOptions.length === 2 && revokeCalls === 0);

  archiveError = Object.assign(new Error('Browser shutdown.'), {
    code: 'DOWNLOAD_CANCELLED', reason: 'USER_SHUTDOWN',
  });
  archiveDownloadOptions = [];
  try {
    await archiveContext.saveGeneratedArchive({
      url: 'data:test', revoke() {}, base64: 'AA==',
      zip: { generateAsync: async () => 'AA==' }, filename: 'chapter.zip', originTabId: 4,
      cancelRetryDelayMs: 0,
    });
  } catch (_) {}
  check('browser shutdown cancellation does not reopen a Save dialog', archiveDownloadOptions.length === 1);

  archiveError = Object.assign(new Error('downloads API unavailable'), { downloadPhase: 'start' });
  archiveDownloadOptions = [];
  archiveIsMobile = false;
  const fallback = await archiveContext.saveGeneratedArchive({
    url: 'data:test', revoke() {}, base64: 'AA==',
    zip: { generateAsync: async () => 'AA==' }, filename: 'chapter.zip', originTabId: 4,
  });
  check('desktop Firefox start failure remains an explicitly unconfirmed page fallback',
    fallback.confirmed === false && fallback.accepted === false &&
    fallback.fallback === true && fallbackCalls === 1);

  archiveIsMobile = true;
  const mobileFallbackUpdates = [];
  const mobileFallback = await archiveContext.saveGeneratedArchive({
    url: 'data:test', revoke() {}, base64: 'AA==',
    zip: { generateAsync: async () => 'AA==' }, filename: 'chapter.zip', originTabId: 4,
    onSaveProgress: (item) => mobileFallbackUpdates.push(item.state),
  });
  check('Firefox Android accepts a successful page-to-download-manager handoff',
    mobileFallback.confirmed === false && mobileFallback.accepted === true &&
    mobileFallback.mobileHandoff === true && mobileFallback.fallback === true &&
    mobileFallbackUpdates.join(',') === 'starting,mobile_handoff');
  archiveIsMobile = false;

  resetZipEvents();
  zipDelivery = { confirmed: true, fallback: false, downloadId: 17 };
  const doZipProgress = [];
  const confirmedZip = await zipContext.doZipAndSave({
    zip: {}, zipName: 'series.zip', originTabId: 4, notifyDone: false,
    chapterRecords: [{ chapterLabel: 'Ch1' }, { chapterLabel: 'Ch2' }],
    slug: 'series', mangaName: 'Series',
    onZipProgress: (metadata) => doZipProgress.push(metadata),
  });
  check('confirmed ZIP part records only the chapters inside that part',
    confirmedZip.confirmed === true && zipEvents.records.join(',') === 'Ch1,Ch2');
  check('each ZIP attempt resets visible archive progress to zero',
    doZipProgress.length >= 2 && doZipProgress[0].reset === true &&
    doZipProgress[0].percent === 0 && doZipProgress.at(-1).percent === 100);
  check('ZIP construction uses a scoped extension-worker keep-alive', zipKeepAliveCalls === 1);

  resetZipEvents();
  zipDelivery = { confirmed: false, fallback: true, downloadId: null };
  const unconfirmedZip = await zipContext.doZipAndSave({
    zip: {}, zipName: 'series.zip', originTabId: 4, notifyDone: false,
    chapterRecords: [{ chapterLabel: 'Ch3' }], slug: 'series', mangaName: 'Series',
  });
  check('unverified fallback does not record chapters as downloaded',
    unconfirmedZip.confirmed === false && zipEvents.records.length === 0);

  resetZipEvents();
  zipDelivery = { confirmed: false, accepted: true, mobileHandoff: true, fallback: true, downloadId: null };
  const mobileZip = await zipContext.doZipAndSave({
    zip: {}, zipName: 'series.zip', originTabId: 4,
    chapterRecords: [{ chapterLabel: 'Ch3.5' }], slug: 'series', mangaName: 'Series',
  });
  check('accepted Firefox Android handoff records chapters without an unverified warning',
    mobileZip.confirmed === false && mobileZip.accepted === true &&
    mobileZip.mobileHandoff === true && zipEvents.records.join(',') === 'Ch3.5' &&
    zipEvents.done.length === 1 && zipEvents.done[0].warning === '');

  resetZipEvents();
  zipDelivery = { confirmed: true, fallback: false, downloadId: 19 };
  zipDeliverySequence = [
    Object.assign(new Error('Download cancelled.'), { code: 'DOWNLOAD_CANCELLED' }),
    null,
  ];
  zipSaveCancellationDecision = true;
  const recoveredZip = await zipContext.doZipAndSave({
    zip: {}, zipName: 'series.zip', originTabId: 4, notifyDone: false,
    chapterRecords: [{ chapterLabel: 'Ch4' }], slug: 'series', mangaName: 'Series',
  });
  check('Save again reuses the prepared archive and records chapters only after success',
    recoveredZip.confirmed === true && zipEvents.saveCancelled === 1 &&
    zipGenerationCalls === 1 && zipSaveOptions.length === 2 &&
    zipSaveOptions[1].forceSaveAs === true && zipEvents.records.join(',') === 'Ch4');

  resetZipEvents();
  zipDeliveryError = Object.assign(new Error('Download cancelled.'), { code: 'DOWNLOAD_CANCELLED' });
  const cancelledZip = await zipContext.doZipAndSave({
    zip: {}, zipName: 'series.zip', originTabId: 4,
    chapterRecords: [{ chapterLabel: 'Ch5' }], slug: 'series', mangaName: 'Series',
  });
  check('closing the recovery state abandons the pending archive and records nothing',
    cancelledZip === null && zipEvents.saveCancelled === 1 && zipEvents.cancelled === 1 &&
    zipEvents.records.length === 0 && zipEvents.errors.length === 0);

  resetZipEvents();
  zipDeliveryError = Object.assign(new Error('Download interrupted: FILE_NO_SPACE'), {
    downloadPhase: 'transfer',
  });
  const failedSave = await zipContext.doZipAndSave({
    zip: {}, zipName: 'series.zip', originTabId: 4, notifyDone: false,
    chapterRecords: [{ chapterLabel: 'Ch6' }], slug: 'series', mangaName: 'Series',
  });
  check('a browser save failure is classified separately from a runtime interruption',
    failedSave === null && zipEvents.errors.length === 1 &&
    zipEvents.errors[0].options.errorKind === 'archive_save' &&
    zipEvents.errors[0].options.errorTitle === 'Browser could not save the ZIP.' &&
    zipEvents.errors[0].error.includes('enough free space'));
  check('a failed archive is released instead of leaving a broken retry object',
    !zipContext.hasPendingZip() && zipEvents.records.length === 0);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
