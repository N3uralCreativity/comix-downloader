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
  checkpoints: [], sessions: [], extracted: [],
};
let fetchMode = 'fail';
let chaptersPerPart = 30;
const allContext = {
  BATCH_SIZE: 4,
  ZIP_PART_MAX_CHAPTERS: 30,
  JSZip: ZipStub,
  loadCfg: async () => ({
    'perf.batchSize': 4,
    'perf.rateLimitMode': 'off',
    'download.concurrentChapters': 2,
    'download.chaptersPerPart': chaptersPerPart,
  }),
  resolveOutputOptions: (_cfg, options) => ({ format: 'zip', slug: 'series', ...(options || {}) }),
  getLibraryConfig: async () => null,
  chapterConcurrencyLimit: () => 2,
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
  notifyDownloadAllProgress(_tabId, message) { allEvents.progress.push(message); },
  getZipPartName: (name, part) => `${name}.part${part}`,
  _doZipAndSave: async ({
    zipName, chapterRecords = [], onZipProgress, onSaveProgress,
  }) => {
    allEvents.saves.push(zipName);
    if (onZipProgress) {
      onZipProgress({ percent: 0, currentFile: '', reset: true });
      // Let the next concurrent chapter emit progress while this ZIP owns the UI.
      await new Promise((resolve) => setTimeout(resolve, 0));
      onZipProgress({ percent: 37, currentFile: 'page-001.webp' });
      onZipProgress({ percent: 100, currentFile: '' });
    }
    if (onSaveProgress) {
      onSaveProgress({ state: 'starting', bytesReceived: 0, totalBytes: -1 });
      onSaveProgress({ state: 'in_progress', bytesReceived: 50, totalBytes: 100 });
      onSaveProgress({ state: 'complete', bytesReceived: 100, totalBytes: 100 });
    }
    chapterRecords.forEach((record) => allEvents.recorded.push(record.chapterLabel));
    return { filename: zipName, confirmed: true };
  },
  extractFromTab: async (url) => {
    allEvents.extracted.push(url);
    return [
      { index: 1, src: `${url}/image-1` },
      { index: 2, src: `${url}/image-2` },
    ];
  },
  verifyEnumeratedImages: async (images) => images,
  fetchImageToFile: async (index, src) => {
    if (fetchMode === 'pass' || (fetchMode === 'mixed' && src.includes('/good/'))) {
      return { file: { name: `${index}.webp`, buffer: new ArrayBuffer(2), bytes: 2 }, error: null };
    }
    return { file: null, error: new Error('HTTP 403') };
  },
  downloadAllAbortFlag: false,
  _downloadAllAbortPromise: () => new Promise(() => {}),
  downloadItemProgressPercent(item) {
    if (!item) return null;
    if (item.state === 'complete') return 100;
    return item.totalBytes > 0 ? item.bytesReceived / item.totalBytes * 100 : null;
  },
  recordChapterDownloaded: (_slug, label) => allEvents.recorded.push(label),
  addChapterToOuter: async (_zip, result) => result.bytes,
  _signalDownloadAllAbort() {},
  addSeriesMetaToOuter: async () => {},
  notifyDownloadAllCancelled() {},
  notifyDownloadAllError: (_tabId, error, canRetryZip) => allEvents.errors.push({ error, canRetryZip }),
  notifyDownloadAllDone: (_tabId, zipName, warning) => allEvents.done.push({ zipName, warning }),
  _libPushChain: Promise.resolve(),
  console,
  setTimeout,
};
vm.createContext(allContext);
vm.runInContext(`
  ${extractFunction('formatImageDownloadFailure')}
  ${extractFunction('handleDownloadAllRequest')}
  globalThis.handleDownloadAllRequest = handleDownloadAllRequest;
`, allContext);

function resetAllEvents() {
  Object.values(allEvents).forEach((items) => { items.length = 0; });
}

async function run() {
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
  check('failed chapter rows report zero saved images',
    allEvents.progress.filter((event) => event.phase === 'error').every((event) => event.imagesDone === 0 && event.imagesTotal === 2));

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
  check('each multipart archive reports ZIP and save stages', (() => {
    const zippedParts = new Set(allEvents.progress.filter((event) => event.phase === 'zipping').map((event) => event.zipPart));
    const savedParts = new Set(allEvents.progress.filter((event) => event.phase === 'saving').map((event) => event.zipPart));
    return zippedParts.size === 2 && savedParts.size === 2 && zippedParts.has(1) && zippedParts.has(2);
  })());
  check('concurrent chapter events cannot visually replace an active ZIP or Save stage', (() => {
    const firstZip = allEvents.progress.findIndex((event) => event.phase === 'zipping' && event.zipPart === 1);
    const firstSaveEnd = allEvents.progress.findIndex((event) =>
      event.phase === 'saving' && event.zipPart === 1 && event.saveState === 'complete');
    const chapterPhases = new Set(['extracting', 'downloading', 'done', 'error', 'skipped']);
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
  chaptersPerPart = 2;
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

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
