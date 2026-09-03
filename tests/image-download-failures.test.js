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
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
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

const helperContext = {};
vm.createContext(helperContext);
vm.runInContext(`${extractFunction('formatImageDownloadFailure')}; globalThis.formatFailure = formatImageDownloadFailure;`, helperContext);
check('zero-image chapters get an explicit error',
  helperContext.formatFailure(0, 0, null) === 'No images were found for this chapter.');
check('complete CDN rejection reports saved/total and HTTP status', (() => {
  const message = helperContext.formatFailure(79, 0, new Error('HTTP 403'));
  return message.includes('0/79') && message.includes('HTTP 403') && message.includes('Reload comix.to');
})());
check('partial image failure reports the incomplete count',
  helperContext.formatFailure(89, 88, new Error('HTTP 503')).includes('Only 88 of 89 images'));

const retryContext = {
  Date, Math, Number, String,
  fetchCalls: 0,
  cooldowns: [],
  fetchImageForZip: async () => ({ buffer: new ArrayBuffer(1), ext: 'webp' }),
  waitForImageHostCooldown: async () => {},
  deferImageHost: (_src, delay) => retryContext.cooldowns.push(delay),
  imageRetryDelayMs: () => 1,
};
vm.createContext(retryContext);
vm.runInContext(`
  const IMAGE_TRANSIENT_MIN_RETRIES = 3;
  ${extractFunction('imageRequestStatus')}
  ${extractFunction('isRetryableImageRequestError')}
  ${extractFunction('imageRetryLimit')}
  ${extractFunction('parseRetryAfterMs')}
  ${extractFunction('fetchImageWithRetry')}
  globalThis.retryApi = {
    isRetryableImageRequestError,
    imageRetryLimit,
    parseRetryAfterMs,
    fetchImageWithRetry,
  };
`, retryContext);

check('Cloudflare 520 and 521 image responses are transient',
  retryContext.retryApi.isRetryableImageRequestError(new Error('HTTP 520')) &&
  retryContext.retryApi.isRetryableImageRequestError(new Error('HTTP 521')));
check('rate limits, timeouts, and server errors are transient',
  retryContext.retryApi.isRetryableImageRequestError(Object.assign(new Error('HTTP 429'), { status: 429 })) &&
  retryContext.retryApi.isRetryableImageRequestError(Object.assign(new Error('timeout'), { name: 'AbortError' })) &&
  retryContext.retryApi.isRetryableImageRequestError(new Error('HTTP 503')));
check('permanent image errors do not gain automatic retries',
  !retryContext.retryApi.isRetryableImageRequestError(new Error('HTTP 403')) &&
  !retryContext.retryApi.isRetryableImageRequestError(new Error('HTTP 404')));
check('transient image failures receive at least three retries',
  retryContext.retryApi.imageRetryLimit(1, new Error('HTTP 521')) === 3);
check('a larger user retry setting is preserved',
  retryContext.retryApi.imageRetryLimit(5, new Error('HTTP 520')) === 5);
check('Retry-After seconds are converted to milliseconds',
  retryContext.retryApi.parseRetryAfterMs('2') === 2000);

class ZipStub {
  file() {}
}

const singleChapterFunction = extractFunction('downloadImagesAsZip');
const incompleteGuard = singleChapterFunction.indexOf('if (total === 0 || files.length !== total)');
const zipGeneration = singleChapterFunction.indexOf('await _zipToDownloadUrl(zip)');
check('single-chapter download rejects incomplete image sets before ZIP generation',
  incompleteGuard !== -1 && zipGeneration !== -1 && incompleteGuard < zipGeneration);

const allEvents = {
  progress: [], errors: [], done: [], saves: [], recorded: [], logs: [],
  checkpoints: [], sessions: [], extracted: [], reviews: [], pdfBuilds: [], packed: [],
  cancelled: [], directCbzBuilds: [], saveRequests: [],
};
let fetchMode = 'fail';
let extractMode = 'pass';
let chaptersPerPart = 30;
let cbzChaptersPerPart = 10;
let mbPerPart = 300;
let chapterRetriesSetting = 1;
let archiveDeliveryMode = 'confirmed';
let outputFormat = 'zip';
let concurrentChapters = 2;
let pipelineTestActive = false;
let activePdfBuilds = 0;
let maxActivePdfBuilds = 0;
let resolveFirstPdfStarted = null;
let firstPdfStarted = Promise.resolve();
let resolveSecondChapterFetched = null;
let secondChapterFetched = Promise.resolve();
let cancelAfterDoneCount = 0;
let cancelOnArchiveStage = '';
let downloadAllStopPromise = null;
let resolveDownloadAllStop = null;
const imageFetchCalls = new Map();
const extractCalls = new Map();

function resetDownloadAllStopSignal() {
  downloadAllStopPromise = new Promise((resolve) => { resolveDownloadAllStop = resolve; });
}

function requestDownloadAllStop() {
  allContext.downloadAllStopFlag = true;
  if (resolveDownloadAllStop) resolveDownloadAllStop();
}

resetDownloadAllStopSignal();
const allContext = {
  BATCH_SIZE: 4,
  ZIP_PART_MAX_CHAPTERS: 30,
  ZIP_PART_MAX_BYTES: 300 * 1024 * 1024,
  JSZip: ZipStub,
  loadCfg: async () => ({
    'perf.batchSize': 4,
    'perf.rateLimitMode': 'off',
    'download.concurrentChapters': concurrentChapters,
    'download.chaptersPerPart': chaptersPerPart,
    'download.cbzChaptersPerPart': cbzChaptersPerPart,
    'download.mbPerPart': mbPerPart,
    'download.splitMode': 'multipart',
    'retry.imageRetries': 1,
    'retry.chapterRetries': chapterRetriesSetting,
  }),
  resolveOutputOptions: (_cfg, options) => ({ format: outputFormat, slug: 'series', ...(options || {}) }),
  getLibraryConfig: async () => null,
  chapterConcurrencyLimit: () => concurrentChapters,
  createDownloadAllResumeData({ chapters, mangaName, zipName, options, resumeState }) {
    const source = resumeState || {};
    const allChapters = source.chapters || chapters;
    return {
      version: 1,
      chapters: allChapters,
      mangaName: source.mangaName || mangaName,
      zipName: source.zipName || zipName,
      options: source.options || options || {},
      totalChapters: allChapters.length,
      checkpointIndex: source.checkpointIndex || 0,
      nextZipPart: source.nextZipPart || 1,
      savedZipNames: (source.savedZipNames || []).slice(),
      terminalCounts: { done: 0, skipped: 0, error: 0, ...(source.terminalCounts || {}) },
      firstChapterError: source.firstChapterError || '',
      checkpointBlocked: false,
    };
  },
  updateDownloadAllResumeCheckpoint(checkpoint) { allEvents.checkpoints.push(checkpoint); },
  startDownloadAllSession(session) { allEvents.sessions.push(session); },
  persistDownloadAllSession() {},
  cdlLog(level, message) { allEvents.logs.push({ level, message }); },
  notifyDownloadAllProgress(_tabId, message) {
    allEvents.progress.push(message);
    if (cancelAfterDoneCount > 0 && message.phase === 'done') {
      const completed = allEvents.progress.filter((event) => event.phase === 'done').length;
      if (completed >= cancelAfterDoneCount) requestDownloadAllStop();
    }
  },
  getZipPartName: (name, part) => `${name}.part${part}`,
  _doZipAndSave: async ({
    zipName, targetFilename, outputExtension, chapterRecords = [], onZipProgress, onSaveProgress,
  }) => {
    allEvents.saves.push(zipName);
    allEvents.saveRequests.push({ zipName, targetFilename, outputExtension, chapterRecords });
    if (onZipProgress) {
      onZipProgress({ percent: 0, currentFile: '', reset: true });
      // Let the next concurrent chapter emit progress while this ZIP owns the UI.
      await new Promise((resolve) => setTimeout(resolve, 0));
      onZipProgress({ percent: 37, currentFile: 'page-001.webp' });
      if (cancelOnArchiveStage === 'zipping') {
        cancelOnArchiveStage = '';
        requestDownloadAllStop();
      }
      onZipProgress({ percent: 100, currentFile: '' });
    }
    if (onSaveProgress) {
      onSaveProgress({ state: 'starting', bytesReceived: 0, totalBytes: -1 });
      if (cancelOnArchiveStage === 'saving') {
        cancelOnArchiveStage = '';
        requestDownloadAllStop();
      }
      onSaveProgress({ state: 'in_progress', bytesReceived: 50, totalBytes: 100 });
      onSaveProgress({ state: 'complete', bytesReceived: 100, totalBytes: 100 });
    }
    const confirmed = archiveDeliveryMode === 'confirmed';
    const accepted = confirmed || archiveDeliveryMode === 'mobile';
    if (accepted) chapterRecords.forEach((record) => allEvents.recorded.push(record.chapterLabel));
    return {
      filename: targetFilename || zipName,
      confirmed,
      accepted,
      mobileHandoff: archiveDeliveryMode === 'mobile',
    };
  },
  extractFromTab: async (url) => {
    allEvents.extracted.push(url);
    const calls = (extractCalls.get(url) || 0) + 1;
    extractCalls.set(url, calls);
    if (extractMode === 'cancel-immediately') {
      requestDownloadAllStop();
      throw Object.assign(new Error('Download All was cancelled.'), {
        name: 'DownloadAllStoppedError', code: 'DOWNLOAD_ALL_STOPPED',
      });
    }
    if (extractMode === 'recover-once' && calls === 1) throw new Error('HTTP 520');
    return [
      { index: 1, src: `${url}/image-1` },
      { index: 2, src: `${url}/image-2` },
    ];
  },
  verifyEnumeratedImages: async (images) => images,
  fetchImageToFile: async (index, src) => {
    if (pipelineTestActive && src.includes('/good/2/')) {
      await firstPdfStarted;
      allEvents.pdfBuilds.push(`fetch-ch2:pdfs-${activePdfBuilds}`);
      if (resolveSecondChapterFetched) resolveSecondChapterFetched();
    }
    const calls = (imageFetchCalls.get(src) || 0) + 1;
    imageFetchCalls.set(src, calls);
    const recoversMissingPage = fetchMode === 'recover-missing' &&
      (src.endsWith('/image-1') || calls > 1);
    if (fetchMode === 'pass' || recoversMissingPage ||
        (fetchMode === 'mixed' && src.includes('/good/'))) {
      return { file: { name: `${index}.webp`, buffer: new ArrayBuffer(2), bytes: 2 }, error: null };
    }
    return { file: null, error: new Error(fetchMode === 'recover-missing' ? 'HTTP 521' : 'HTTP 403') };
  },
  chapterRecoveryDelayMs: () => 0,
  waitForChapterRecovery: async () => {},
  deferImageHost() {},
  downloadAllAbortFlag: false,
  downloadAllStopFlag: false,
  downloadAllShouldStop: () => allContext.downloadAllAbortFlag || allContext.downloadAllStopFlag,
  downloadAllNetworkSignal: () => null,
  isDownloadAllStoppedError: (error) => !!error && (
    error.code === 'DOWNLOAD_ALL_STOPPED' || error.name === 'DownloadAllStoppedError'
  ),
  _downloadAllAbortPromise: () => downloadAllStopPromise,
  downloadItemProgressPercent(item) {
    if (!item) return null;
    if (item.state === 'complete') return 100;
    return item.totalBytes > 0 ? item.bytesReceived / item.totalBytes * 100 : null;
  },
  recordChapterDownloaded: (_slug, label) => allEvents.recorded.push(label),
  buildChapterPdfOutput: async (files, _opts, chapterLabel, _chapterUrl, _mangaName, onProgress) => {
    activePdfBuilds++;
    maxActivePdfBuilds = Math.max(maxActivePdfBuilds, activePdfBuilds);
    allEvents.pdfBuilds.push(`start:${chapterLabel}`);
    if (onProgress) onProgress({ current: 1, total: files.length, finalizing: false });
    if (pipelineTestActive && chapterLabel === 'Ch1') {
      if (resolveFirstPdfStarted) resolveFirstPdfStarted();
      await secondChapterFetched;
    }
    if (onProgress) onProgress({ current: files.length, total: files.length, finalizing: true });
    allEvents.pdfBuilds.push(`end:${chapterLabel}`);
    activePdfBuilds--;
    return new Uint8Array([1, 2, 3]);
  },
  addChapterToOuter: async (_zip, result) => {
    allEvents.packed.push({ chapterLabel: result.chapterLabel, hasPdf: !!result.pdfBytes });
    return result.pdfBytes ? result.pdfBytes.byteLength : result.bytes;
  },
  buildChapterCbzBytes: async (result, _opts, _mangaName, onProgress) => {
    allEvents.directCbzBuilds.push(result.chapterLabel);
    if (onProgress) onProgress({ percent: 50 });
    return new Uint8Array([1, 2, 3]);
  },
  buildCbzEntryName: (_opts, result) => result.chapterLabel,
  uniqueDirectCbzEntryName: (used, entry) => {
    used.add(`${entry}.cbz`.toLowerCase());
    return entry;
  },
  directCbzTargetFilename: (entry, folder) => `${folder ? `${folder}/` : ''}${entry}.cbz`,
  _bytesToDownloadUrl: async () => ({ url: 'blob:direct-cbz', revoke() {} }),
  withExtensionKeepAlive: (task) => task(),
  tagDiagnosticError: (error, kind, phase) => Object.assign(error, { cdlKind: kind, cdlPhase: phase }),
  createErrorDiagnostic: (error, options = {}) => ({
    code: options.errorKind === 'chapter_extraction' ? 'CDL-EXTRACT-001' :
      error?.cdlKind === 'image_download' ? 'CDL-IMAGE-001' : 'CDL-PIPELINE-001',
    reference: `test-${allEvents.progress.length}`,
    technicalMessage: error?.message || String(error),
    kind: options.errorKind || error?.cdlKind || 'pipeline',
    phase: options.failurePhase || error?.cdlPhase || 'unknown',
  }),
  describeArchiveFailure: (error, failurePhase) => ({
    errorTitle: 'Archive failed.',
    errorKind: failurePhase,
    failurePhase,
    message: error.message,
  }),
  _signalDownloadAllAbort() {
    allContext.downloadAllAbortFlag = true;
    requestDownloadAllStop();
  },
  addSeriesMetaToOuter: async () => {},
  notifyDownloadAllCancelled: (_tabId, details) => allEvents.cancelled.push(details || {}),
  notifyDownloadAllError: (_tabId, error, canRetryZip) => allEvents.errors.push({ error, canRetryZip }),
  notifyDownloadAllDone: (_tabId, zipName, warning) => allEvents.done.push({ zipName, warning }),
  recordSuccessfulDownloadForReview: async () => { allEvents.reviews.push('recorded'); },
  _libPushChain: Promise.resolve(),
  console,
  setTimeout,
};
vm.createContext(allContext);
vm.runInContext(`
  ${extractFunction('formatImageDownloadFailure')}
  ${extractFunction('downloadAllResumeSlug')}
  ${extractFunction('isArchiveDeliveryAccepted')}
  ${extractFunction('chaptersPerPartForFormat')}
  ${extractFunction('downloadAllPartitionPolicy')}
  ${extractFunction('downloadAllPartSplitReason')}
  ${extractFunction('downloadAllProjectedPartSplitReason')}
  ${extractFunction('handleDownloadAllRequest')}
  globalThis.handleDownloadAllRequest = handleDownloadAllRequest;
  globalThis.partitionApi = {
    downloadAllPartitionPolicy,
    downloadAllPartSplitReason,
    downloadAllProjectedPartSplitReason,
  };
`, allContext);

function resetAllEvents() {
  Object.values(allEvents).forEach((items) => { items.length = 0; });
  imageFetchCalls.clear();
  extractCalls.clear();
  outputFormat = 'zip';
  mbPerPart = 300;
  pipelineTestActive = false;
  activePdfBuilds = 0;
  maxActivePdfBuilds = 0;
  concurrentChapters = 2;
  cancelAfterDoneCount = 0;
  cancelOnArchiveStage = '';
  allContext.downloadAllAbortFlag = false;
  allContext.downloadAllStopFlag = false;
  resetDownloadAllStopSignal();
}

async function run() {
  const cbzPolicy = allContext.partitionApi.downloadAllPartitionPolicy({
    'download.splitMode': 'multipart',
    'download.chaptersPerPart': 5,
    'download.cbzChaptersPerPart': 50,
    'download.mbPerPart': 300,
  }, 'cbz');
  check('CBZ partitioning uses its own configured file count instead of the ZIP folder count',
    cbzPolicy.maxChapters === 50 && cbzPolicy.maxMb === 300);
  check('the shared size threshold can intentionally split before the CBZ file count',
    allContext.partitionApi.downloadAllPartSplitReason(
      12, 301 * 1024 * 1024, cbzPolicy
    ) === 'size_limit');
  check('a part closes before adding a chapter that would substantially overshoot its size limit',
    allContext.partitionApi.downloadAllProjectedPartSplitReason(
      11, 290 * 1024 * 1024, 40 * 1024 * 1024, cbzPolicy
    ) === 'size_limit');

  retryContext.fetchCalls = 0;
  retryContext.cooldowns.length = 0;
  retryContext.fetchImageForZip = async () => {
    retryContext.fetchCalls++;
    if (retryContext.fetchCalls < 4) throw Object.assign(new Error('HTTP 521'), { status: 521 });
    return { buffer: new ArrayBuffer(1), ext: 'webp' };
  };
  await retryContext.retryApi.fetchImageWithRetry('https://wowpic.example/page.webp', {}, 1);
  check('a transient image succeeds after the automatic retry budget',
    retryContext.fetchCalls === 4 && retryContext.cooldowns.length === 3);

  retryContext.fetchCalls = 0;
  retryContext.cooldowns.length = 0;
  const visibleRetries = [];
  retryContext.fetchImageForZip = async () => {
    retryContext.fetchCalls++;
    if (retryContext.fetchCalls < 3) throw Object.assign(new Error('HTTP 520'), { status: 520 });
    return { buffer: new ArrayBuffer(1), ext: 'webp' };
  };
  await retryContext.retryApi.fetchImageWithRetry(
    'https://wowpic.example/visible.webp', {}, 1,
    (retry) => visibleRetries.push(`${retry.retryAttempt}/${retry.retryLimit}:${retry.status}`)
  );
  check('each image retry exposes its attempt, limit, and HTTP status',
    visibleRetries.join(',') === '1/3:520,2/3:520');

  retryContext.fetchCalls = 0;
  retryContext.cooldowns.length = 0;
  retryContext.fetchImageForZip = async () => {
    retryContext.fetchCalls++;
    throw Object.assign(new Error('HTTP 403'), { status: 403 });
  };
  try { await retryContext.retryApi.fetchImageWithRetry('https://wowpic.example/page.webp', {}, 1); } catch (_) {}
  check('a permanent image error keeps the configured retry budget',
    retryContext.fetchCalls === 2 && retryContext.cooldowns.length === 0);

  resetAllEvents();
  fetchMode = 'fail';
  await allContext.handleDownloadAllRequest([
    { chapterUrl: 'https://comix.to/title/series/bad-1', chapterLabel: 'Ch1' },
    { chapterUrl: 'https://comix.to/title/series/bad-2', chapterLabel: 'Ch2' },
  ], 'Series', 'series.zip', 7, {});
  check('Download All reports an error when no chapter images can be fetched',
    allEvents.errors.length === 1 && allEvents.errors[0].error.includes('No ZIP files were created') &&
    allEvents.errors[0].error.includes('HTTP 403'));
  check('zero-image Download All never invokes the ZIP downloader', allEvents.saves.length === 0);
  check('zero-image Download All never emits a done event', allEvents.done.length === 0);
  check('failed chapters are not marked as downloaded', allEvents.recorded.length === 0);
  check('failed Download All does not count toward the review request', allEvents.reviews.length === 0);
  check('failed chapter rows report zero saved images',
    allEvents.progress.filter((event) => event.phase === 'error').every((event) => event.imagesDone === 0 && event.imagesTotal === 2));

  resetAllEvents();
  fetchMode = 'recover-missing';
  chapterRetriesSetting = 1;
  const recoveredChapterUrl = 'https://comix.to/title/series/recover/1';
  await allContext.handleDownloadAllRequest([
    { chapterUrl: recoveredChapterUrl, chapterLabel: 'Ch1' },
  ], 'Series', 'series.zip', 7, {});
  check('chapter recovery retries only pages still missing after image retries',
    imageFetchCalls.get(`${recoveredChapterUrl}/image-1`) === 1 &&
    imageFetchCalls.get(`${recoveredChapterUrl}/image-2`) === 2);
  check('a recovered chapter is included instead of reported incomplete',
    allEvents.saves.length === 1 && allEvents.done.length === 1 &&
    allEvents.done[0].warning === '' && !allEvents.progress.some((event) => event.phase === 'error'));
  check('missing-page recovery is visible with its configured attempt number',
    allEvents.progress.some((event) => event.phase === 'retryingImages' &&
      event.retryAttempt === 1 && event.retryLimit === 1 && event.missingImages === 1));
  check('missing-page recovery is written to the extension log',
    allEvents.logs.some((entry) => entry.level === 'warn' &&
      entry.message.includes('retrying 1 missing image') && entry.message.includes('1/1')));

  resetAllEvents();
  fetchMode = 'pass';
  extractMode = 'recover-once';
  const recoveredExtractionUrl = 'https://comix.to/title/series/reopen/1';
  await allContext.handleDownloadAllRequest([
    { chapterUrl: recoveredExtractionUrl, chapterLabel: 'Ch1' },
  ], 'Series', 'series.zip', 7, {});
  check('chapter extraction retry reopens a failed chapter and then saves it',
    extractCalls.get(recoveredExtractionUrl) === 2 && allEvents.saves.length === 1 &&
    allEvents.done.length === 1 && allEvents.done[0].warning === '');
  check('chapter extraction retries are visible in progress and logs',
    allEvents.progress.some((event) => event.phase === 'retryingChapter' &&
      event.retryAttempt === 1 && event.retryLimit === 1) &&
    allEvents.logs.some((entry) => entry.level === 'warn' && entry.message.includes('reopening chapter')));
  extractMode = 'pass';

  resetAllEvents();
  fetchMode = 'mixed';
  await allContext.handleDownloadAllRequest([
    { chapterUrl: 'https://comix.to/title/series/good/1', chapterLabel: 'Ch1' },
    { chapterUrl: 'https://comix.to/title/series/bad/2', chapterLabel: 'Ch2' },
  ], 'Series', 'series.zip', 7, {});
  check('complete chapters are still saved when another chapter fails',
    allEvents.saves.length === 1 && allEvents.done.length === 1);
  check('mixed result finishes with an explicit incomplete-chapter warning',
    allEvents.done[0].warning.includes('1 of 2 chapters could not be included'));
  check('only the complete chapter is marked as downloaded',
    allEvents.recorded.length === 1 && allEvents.recorded[0] === 'Ch1');
  check('partial Download All does not count toward the review request', allEvents.reviews.length === 0);
  check('Download All exposes real ZIP generation percentages', (() => {
    const values = allEvents.progress.filter((event) => event.phase === 'zipping').map((event) => event.zipPercent);
    return values.includes(0) && values.includes(37) && values.includes(100);
  })());
  check('Download All exposes browser save progress after ZIP generation', (() => {
    const events = allEvents.progress.filter((event) => event.phase === 'saving');
    return events.some((event) => event.saveState === 'starting' && event.savePercent === null) &&
      events.some((event) => event.saveState === 'in_progress' && event.savePercent === 50) &&
      events.some((event) => event.saveState === 'complete' && event.savePercent === 100);
  })());

  resetAllEvents();
  fetchMode = 'pass';
  chaptersPerPart = 2;
  await allContext.handleDownloadAllRequest([
    { chapterUrl: 'https://comix.to/title/series/good/1', chapterLabel: 'Ch1' },
    { chapterUrl: 'https://comix.to/title/series/good/2', chapterLabel: 'Ch2' },
    { chapterUrl: 'https://comix.to/title/series/good/3', chapterLabel: 'Ch3' },
  ], 'Series', 'series.zip', 7, {});
  check('chapter split threshold saves the first ZIP part before the final part',
    JSON.stringify(allEvents.saves) === JSON.stringify(['series.zip.part1', 'series.zip.part2']));
  check('multi-part success reports the number of ZIP parts',
    allEvents.done.length === 1 && allEvents.done[0].zipName === '2 ZIP parts' && !allEvents.done[0].warning);
  check('a successful multi-part Download All counts as one review-eligible use',
    allEvents.reviews.length === 1);
  check('each multipart archive reports ZIP and save stages', (() => {
    const zippedParts = new Set(allEvents.progress.filter((event) => event.phase === 'zipping').map((event) => event.zipPart));
    const savedParts = new Set(allEvents.progress.filter((event) => event.phase === 'saving').map((event) => event.zipPart));
    return zippedParts.size === 2 && savedParts.size === 2 && zippedParts.has(1) && zippedParts.has(2);
  })());
  check('concurrent chapter events cannot visually replace an active ZIP or Save stage', (() => {
    const firstZip = allEvents.progress.findIndex((event) => event.phase === 'zipping' && event.zipPart === 1);
    const firstSaveEnd = allEvents.progress.findIndex((event) =>
      event.phase === 'saving' && event.zipPart === 1 && event.saveState === 'complete');
    const chapterPhases = new Set([
      'extracting', 'retryingChapter', 'downloading', 'retryingImage', 'retryingImages',
      'done', 'error', 'skipped',
    ]);
    return firstZip >= 0 && firstSaveEnd > firstZip &&
      !allEvents.progress.slice(firstZip, firstSaveEnd + 1).some((event) => chapterPhases.has(event.phase));
  })());
  check('the frame resumes with buffered chapter progress after a ZIP part is saved', (() => {
    const firstSaveEnd = allEvents.progress.findIndex((event) =>
      event.phase === 'saving' && event.zipPart === 1 && event.saveState === 'complete');
    const resumed = allEvents.progress.findIndex((event, index) => index > firstSaveEnd && event.phase === 'resuming');
    const chapterThree = allEvents.progress.findIndex((event, index) =>
      index > resumed && event.chapterLabel === 'Ch3' && event.phase === 'done');
    return firstSaveEnd >= 0 && resumed > firstSaveEnd && chapterThree > resumed &&
      allEvents.progress[resumed].completed === allEvents.progress[chapterThree].completed;
  })());
  check('the visible chapter count stays frozen throughout a ZIP part save', (() => {
    const firstZip = allEvents.progress.findIndex((event) => event.phase === 'zipping' && event.zipPart === 1);
    const firstSaveEnd = allEvents.progress.findIndex((event) =>
      event.phase === 'saving' && event.zipPart === 1 && event.saveState === 'complete');
    const counts = new Set(allEvents.progress.slice(firstZip, firstSaveEnd + 1).map((event) => event.completed));
    return firstZip >= 0 && firstSaveEnd > firstZip && counts.size === 1 && counts.has(2);
  })());

  resetAllEvents();
  fetchMode = 'pass';
  outputFormat = 'cbz';
  chaptersPerPart = 2;
  cbzChaptersPerPart = 3;
  await allContext.handleDownloadAllRequest([
    { chapterUrl: 'https://comix.to/title/series/good/1', chapterLabel: 'Ch1' },
    { chapterUrl: 'https://comix.to/title/series/good/2', chapterLabel: 'Ch2' },
    { chapterUrl: 'https://comix.to/title/series/good/3', chapterLabel: 'Ch3' },
    { chapterUrl: 'https://comix.to/title/series/good/4', chapterLabel: 'Ch4' },
  ], 'Series', 'series.zip', 7, {});
  const firstCbzPart = allEvents.progress.find((event) =>
    event.phase === 'zipping' && event.zipPart === 1 && event.splitReason === 'count_limit');
  check('the Download All pipeline respects the CBZ-specific files-per-part setting',
    firstCbzPart && firstCbzPart.partChapters === 3 && firstCbzPart.maxPartChapters === 3 &&
    firstCbzPart.outputFormat === 'cbz');

  resetAllEvents();
  fetchMode = 'pass';
  outputFormat = 'cbz';
  await allContext.handleDownloadAllRequest([
    { chapterUrl: 'https://comix.to/title/series/good/1', chapterLabel: 'Ch1' },
    { chapterUrl: 'https://comix.to/title/series/good/2', chapterLabel: 'Ch2' },
    { chapterUrl: 'https://comix.to/title/series/good/3', chapterLabel: 'Ch3' },
  ], 'Series', 'series.zip', 7, { directCbz: true });
  check('direct CBZ mode saves one browser file per completed chapter',
    JSON.stringify(allEvents.saves) === JSON.stringify(['Ch1.cbz', 'Ch2.cbz', 'Ch3.cbz']) &&
    allEvents.saveRequests.every((request) => request.outputExtension === 'cbz' &&
      request.targetFilename === request.zipName));
  check('direct CBZ mode never adds chapter files to an outer ZIP',
    allEvents.packed.length === 0 &&
    allEvents.directCbzBuilds.join(',') === 'Ch1,Ch2,Ch3');
  check('each confirmed direct CBZ advances the resume checkpoint and downloaded manifest',
    allEvents.checkpoints.map((checkpoint) => checkpoint.checkpointIndex).join(',') === '1,2,3' &&
    allEvents.recorded.join(',') === 'Ch1,Ch2,Ch3');
  check('direct CBZ completion reports separate files and remains review eligible',
    allEvents.done.length === 1 && allEvents.done[0].zipName === '3 CBZ files' &&
    allEvents.done[0].warning === '' && allEvents.reviews.length === 1);
  check('direct CBZ progress identifies both build and save stages without ZIP parts',
    allEvents.progress.some((event) => event.phase === 'zipping' && event.directCbz === true &&
      event.cbzFileIndex === 1 && event.cbzFileTotal === 3) &&
    allEvents.progress.some((event) => event.phase === 'saving' && event.directCbz === true &&
      event.chapterLabel === 'Ch1'));

  resetAllEvents();
  fetchMode = 'pass';
  outputFormat = 'zip';
  chaptersPerPart = 50;
  mbPerPart = 6 / (1024 * 1024); // synthetic six-byte boundary; each stub chapter is four bytes
  await allContext.handleDownloadAllRequest([
    { chapterUrl: 'https://comix.to/title/series/good/1', chapterLabel: 'Ch1' },
    { chapterUrl: 'https://comix.to/title/series/good/2', chapterLabel: 'Ch2' },
  ], 'Series', 'series.zip', 7, {});
  const projectedSizePart = allEvents.progress.find((event) =>
    event.phase === 'zipping' && event.zipPart === 1 && event.splitTrigger === 'projected');
  check('the pipeline closes a part before the next chapter would overshoot the size setting',
    projectedSizePart && projectedSizePart.splitReason === 'size_limit' &&
    projectedSizePart.partChapters === 1 && projectedSizePart.partBytes === 4);

  resetAllEvents();
  fetchMode = 'pass';
  chaptersPerPart = 2;
  archiveDeliveryMode = 'mobile';
  await allContext.handleDownloadAllRequest([
    { chapterUrl: 'https://comix.to/title/series/good/1', chapterLabel: 'Ch1' },
    { chapterUrl: 'https://comix.to/title/series/good/2', chapterLabel: 'Ch2' },
  ], 'Series', 'series.zip', 7, {});
  check('Firefox Android Download All handoff finishes without a verification warning',
    allEvents.done.length === 1 && allEvents.done[0].warning === '');
  check('Firefox Android Download All handoff marks included chapters as downloaded',
    allEvents.recorded.join(',') === 'Ch1,Ch2');
  check('Firefox Android Download All handoff advances the resume checkpoint',
    allEvents.checkpoints.some((checkpoint) => checkpoint.checkpointIndex === 2));
  check('an API-unverified mobile handoff does not trigger the review request',
    allEvents.reviews.length === 0);

  resetAllEvents();
  fetchMode = 'pass';
  chaptersPerPart = 2;
  archiveDeliveryMode = 'confirmed';
  const allChapters = [
    { chapterUrl: 'https://comix.to/title/series/good/1', chapterLabel: 'Ch1' },
    { chapterUrl: 'https://comix.to/title/series/good/2', chapterLabel: 'Ch2' },
    { chapterUrl: 'https://comix.to/title/series/good/3', chapterLabel: 'Ch3' },
    { chapterUrl: 'https://comix.to/title/series/good/4', chapterLabel: 'Ch4' },
  ];
  await allContext.handleDownloadAllRequest(
    allChapters.slice(2), 'Series', 'series.zip', 7, { slug: 'series' }, {
      version: 1,
      chapters: allChapters,
      mangaName: 'Series',
      zipName: 'series.zip',
      options: { slug: 'series' },
      checkpointIndex: 2,
      nextZipPart: 2,
      savedZipNames: ['series.zip.part1'],
      terminalCounts: { done: 2, skipped: 0, error: 0 },
      firstChapterError: '',
      logItems: [{ id: 'Ch1', cls: 'done', text: 'Ch1 done' }],
      startedAt: 100,
    }
  );
  check('checkpoint resume fetches only chapters after the confirmed ZIP part',
    allEvents.extracted.length === 2 &&
    allEvents.extracted.every((url) => /\/good\/[34]$/.test(url)));
  check('checkpoint resume continues ZIP part numbering',
    JSON.stringify(allEvents.saves) === JSON.stringify(['series.zip.part2']));
  check('checkpoint resume preserves global chapter indexes and totals', (() => {
    const chapterEvents = allEvents.progress.filter((event) => event.chapterLabel);
    return chapterEvents.length > 0 && chapterEvents.every((event) =>
      event.totalChapters === 4 && event.chapterIndex >= 3 && event.chapterIndex <= 4);
  })());
  check('checkpoint resume reports all previously and newly saved ZIP parts',
    allEvents.done.length === 1 && allEvents.done[0].zipName === '2 ZIP parts');
  check('checkpoint resume advances persistence through the final chapter',
    allEvents.checkpoints.some((checkpoint) =>
      checkpoint.checkpointIndex === 4 && checkpoint.nextZipPart === 3 &&
      checkpoint.terminalCounts.done === 4));

  resetAllEvents();
  fetchMode = 'pass';
  chaptersPerPart = 50;
  cancelAfterDoneCount = 2;
  await allContext.handleDownloadAllRequest([
    { chapterUrl: 'https://comix.to/title/series/good/1', chapterLabel: 'Ch1' },
    { chapterUrl: 'https://comix.to/title/series/good/2', chapterLabel: 'Ch2' },
    { chapterUrl: 'https://comix.to/title/series/good/3', chapterLabel: 'Ch3' },
    { chapterUrl: 'https://comix.to/title/series/good/4', chapterLabel: 'Ch4' },
  ], 'Series', 'series.zip', 7, {});
  check('Cancel packages chapters that completed before the stop was processed',
    allEvents.saves.length === 1 && allEvents.recorded.join(',') === 'Ch1,Ch2' &&
    allEvents.cancelled.length === 1 && allEvents.cancelled[0].savedChapters === 2);
  check('Cancel reports cancellation rather than normal completion',
    allEvents.done.length === 0 && allEvents.errors.length === 0);

  resetAllEvents();
  fetchMode = 'pass';
  chaptersPerPart = 2;
  concurrentChapters = 1;
  cancelAfterDoneCount = 3;
  await allContext.handleDownloadAllRequest([
    { chapterUrl: 'https://comix.to/title/series/good/1', chapterLabel: 'Ch1' },
    { chapterUrl: 'https://comix.to/title/series/good/2', chapterLabel: 'Ch2' },
    { chapterUrl: 'https://comix.to/title/series/good/3', chapterLabel: 'Ch3' },
    { chapterUrl: 'https://comix.to/title/series/good/4', chapterLabel: 'Ch4' },
    { chapterUrl: 'https://comix.to/title/series/good/5', chapterLabel: 'Ch5' },
  ], 'Series', 'series.zip', 7, {});
  check('Cancel preserves prior parts and saves a below-threshold final part',
    JSON.stringify(allEvents.saves) === JSON.stringify(['series.zip.part1', 'series.zip.part2']) &&
    allEvents.recorded.join(',') === 'Ch1,Ch2,Ch3' &&
    allEvents.cancelled.length === 1 && allEvents.cancelled[0].savedChapters === 3);

  resetAllEvents();
  extractMode = 'cancel-immediately';
  fetchMode = 'pass';
  chaptersPerPart = 50;
  await allContext.handleDownloadAllRequest([
    { chapterUrl: 'https://comix.to/title/series/good/1', chapterLabel: 'Ch1' },
    { chapterUrl: 'https://comix.to/title/series/good/2', chapterLabel: 'Ch2' },
  ], 'Series', 'series.zip', 7, {});
  check('Cancel creates no empty archive when no chapter completed',
    allEvents.saves.length === 0 && allEvents.recorded.length === 0 &&
    allEvents.cancelled.length === 1 && allEvents.cancelled[0].savedChapters === 0);
  extractMode = 'pass';

  for (const archiveStage of ['zipping', 'saving']) {
    resetAllEvents();
    fetchMode = 'pass';
    chaptersPerPart = 50;
    cancelOnArchiveStage = archiveStage;
    await allContext.handleDownloadAllRequest([
      { chapterUrl: 'https://comix.to/title/series/good/1', chapterLabel: 'Ch1' },
    ], 'Series', 'series.zip', 7, {});
    check(`Cancel during final ${archiveStage} preserves the accepted archive`,
      allEvents.saves.length === 1 && allEvents.recorded.join(',') === 'Ch1' &&
      allEvents.done.length === 0 && allEvents.cancelled.length === 1 &&
      allEvents.cancelled[0].savedChapters === 1);
  }

  const stressChapters = Array.from({ length: 101 }, (_, index) => ({
    chapterUrl: `https://comix.to/title/series/good/${index + 1}`,
    chapterLabel: `Ch${index + 1}`,
  }));
  let stableStressRuns = 0;
  for (const format of ['zip', 'cbz']) {
    for (let attempt = 0; attempt < 3; attempt++) {
      resetAllEvents();
      fetchMode = 'pass';
      outputFormat = format;
      concurrentChapters = 4;
      chaptersPerPart = 25;
      cbzChaptersPerPart = 25;
      await allContext.handleDownloadAllRequest(
        stressChapters, 'Series', `series-${format}-${attempt}.zip`, 7, {}
      );
      if (allEvents.errors.length === 0 && allEvents.done.length === 1 &&
          allEvents.recorded.length === 101 && allEvents.saves.length === 5) {
        stableStressRuns++;
      }
    }
  }
  check('ZIP and CBZ pipelines complete three synthetic 101-chapter stress runs each',
    stableStressRuns === 6);

  resetAllEvents();
  fetchMode = 'pass';
  chaptersPerPart = 2;
  outputFormat = 'pdf';
  pipelineTestActive = true;
  firstPdfStarted = new Promise((resolve) => { resolveFirstPdfStarted = resolve; });
  secondChapterFetched = new Promise((resolve) => { resolveSecondChapterFetched = resolve; });
  await allContext.handleDownloadAllRequest([
    { chapterUrl: 'https://comix.to/title/series/good/1', chapterLabel: 'Ch1' },
    { chapterUrl: 'https://comix.to/title/series/good/2', chapterLabel: 'Ch2' },
  ], 'Series', 'series.zip', 7, {});
  check('a second chapter keeps fetching while the first chapter PDF is being built',
    allEvents.pdfBuilds.includes('fetch-ch2:pdfs-1'));
  check('PDF builds remain serialized to bound CPU and memory usage',
    maxActivePdfBuilds === 1 &&
    allEvents.pdfBuilds.filter((event) => event.startsWith('start:')).length === 2);
  check('the packer receives completed PDF bytes instead of rebuilding image pages',
    allEvents.packed.length === 2 && allEvents.packed.every((entry) => entry.hasPdf));
  check('Download All exposes PDF page and finalization progress before succeeding',
    allEvents.progress.some((event) => event.phase === 'buildingPdf' && event.pdfFinalizing === false) &&
    allEvents.progress.some((event) => event.phase === 'buildingPdf' && event.pdfFinalizing === true) &&
    allEvents.done.length === 1 && allEvents.errors.length === 0);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
