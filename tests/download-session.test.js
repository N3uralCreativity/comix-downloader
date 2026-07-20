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

const context = { Date, JSON, Math, Number, String, Array, Set };
vm.createContext(context);
vm.runInContext(`
  const DOWNLOAD_ALL_RESUME_VERSION = 1;
  ${extractFunction('cloneDownloadAllOptions')}
  ${extractFunction('normalizeDownloadAllResumeChapters')}
  ${extractFunction('createDownloadAllResumeData')}
  ${extractFunction('isValidDownloadAllResumeData')}
  ${extractFunction('isCompletedDownloadAllResumeData')}
  ${extractFunction('downloadAllResumeSlug')}
  ${extractFunction('downloadAllSessionMatchesUrl')}
  ${extractFunction('_serializeSession')}
  ${extractFunction('prepareInterruptedDownloadAllSession')}
  globalThis.api = {
    createDownloadAllResumeData,
    isValidDownloadAllResumeData,
    isCompletedDownloadAllResumeData,
    downloadAllSessionMatchesUrl,
    serialize: _serializeSession,
    prepareInterruptedDownloadAllSession,
  };
`, context);

const chapters = [
  { chapterUrl: 'https://comix.to/title/series/1-chapter-1', chapterLabel: 'Ch1' },
  { chapterUrl: 'https://comix.to/title/series/2-chapter-2', chapterLabel: 'Ch2' },
  { chapterUrl: 'https://comix.to/title/series/3-chapter-3', chapterLabel: 'Ch3' },
];
const options = { slug: 'series', nested: { format: 'zip' } };
const resume = context.api.createDownloadAllResumeData({
  chapters: [...chapters, { chapterUrl: '', chapterLabel: 'bad' }],
  mangaName: 'Series',
  zipName: 'series.zip',
  options,
});
options.nested.format = 'cbz';

check('resume data normalizes invalid chapter rows', resume.chapters.length === 3);
check('resume data clones nested options', resume.options.nested.format === 'zip');
check('a fresh checkpoint is resumable', context.api.isValidDownloadAllResumeData(resume));
check('resume data derives title matching from its slug',
  context.api.downloadAllSessionMatchesUrl({ resumeData: resume }, 'https://comix.to/title/series'));
check('resume data rejects a different title URL',
  !context.api.downloadAllSessionMatchesUrl({ resumeData: resume }, 'https://comix.to/title/other'));

const session = {
  active: true,
  status: 'running',
  originTabId: 5,
  totalChapters: 3,
  resumeData: { ...resume, checkpointIndex: 2, nextZipPart: 2, savedZipNames: ['series-part1.zip'] },
  logItems: [{ id: 'Ch1', cls: 'done', text: 'Ch1 done' }],
};
context.api.prepareInterruptedDownloadAllSession(session, 9);
check('an active persisted run becomes an interrupted resumable session',
  session.status === 'interrupted' && !session.active && session.canResumeDownload);
check('interrupted sessions resume at the chapter after the checkpoint',
  session.completed === 2 && session.resumeFromChapter === 3 && session.resumeChapterLabel === 'Ch3');
check('interrupted sessions bind to the matching restored tab', session.originTabId === 9);

const serialized = context.api.serialize(session);
check('the live session snapshot omits the full chapter checkpoint payload',
  !Object.prototype.hasOwnProperty.call(serialized, 'resumeData'));
check('the live session snapshot preserves resume UI fields',
  serialized.canResumeDownload && serialized.resumeChapterLabel === 'Ch3');

const awaitingSave = {
  active: true,
  status: 'awaiting_save',
  resumeData: { ...resume, checkpointIndex: 0 },
};
context.api.prepareInterruptedDownloadAllSession(awaitingSave, 2);
check('a lost prepared archive resumes from the last confirmed boundary',
  awaitingSave.status === 'interrupted' && awaitingSave.error.includes('prepared ZIP was lost'));

const completed = {
  active: true,
  status: 'running',
  resumeData: {
    ...resume,
    checkpointIndex: 3,
    nextZipPart: 3,
    savedZipNames: ['series-part1.zip', 'series-part2.zip'],
  },
};
context.api.prepareInterruptedDownloadAllSession(completed, 4);
check('a fully confirmed final checkpoint restores as complete, not interrupted',
  completed.status === 'done' && completed.doneZipName === '2 ZIP parts');
check('completed checkpoint data is recognized separately from resumable data',
  context.api.isCompletedDownloadAllResumeData(completed.resumeData) &&
  !context.api.isValidDownloadAllResumeData(completed.resumeData));

async function runAsyncSessionChecks() {
  const storedResume = {
    ...resume,
    checkpointIndex: 1,
    nextZipPart: 2,
    savedZipNames: ['series-part1.zip'],
  };
  const storedSession = {
    active: true,
    status: 'running',
    originTabId: 5,
    mangaName: 'Series',
    totalChapters: 3,
    seriesSlug: 'series',
    updatedAt: Date.now(),
  };
  const asyncContext = {
    Date, JSON, Math, Number, String, Array, Set,
    chrome: {
      storage: {
        local: {
          async get() {
            return {
              cdlDownloadAllSession: { ...storedSession },
              cdlDownloadAllResume: { ...storedResume },
            };
          },
        },
      },
    },
  };
  vm.createContext(asyncContext);
  vm.runInContext(`
    const DOWNLOAD_ALL_RESUME_VERSION = 1;
    const DOWNLOAD_ALL_TERMINAL_SESSION_TTL_MS = 120000;
    const DL_SESSION_KEY = 'cdlDownloadAllSession';
    const DL_RESUME_KEY = 'cdlDownloadAllResume';
    let downloadAllSession = null;
    let persistCount = 0;
    function persistDownloadAllSession() { persistCount++; }
    function clearPersistedDownloadAllResume() {
      if (downloadAllSession) downloadAllSession.resumeData = null;
    }
    ${extractFunction('isValidDownloadAllResumeData')}
    ${extractFunction('isCompletedDownloadAllResumeData')}
    ${extractFunction('downloadAllResumeSlug')}
    ${extractFunction('downloadAllSessionMatchesUrl')}
    ${extractFunction('prepareInterruptedDownloadAllSession')}
    ${extractFunction('loadPersistedSession')}
    ${extractFunction('getDownloadAllSessionForTab')}
    ${extractFunction('getDownloadAllSessionForTabAsync')}
    globalThis.api = {
      getDownloadAllSessionForTabAsync,
      getState: () => downloadAllSession,
      getPersistCount: () => persistCount,
    };
  `, asyncContext);

  const wrongTitle = await asyncContext.api.getDownloadAllSessionForTabAsync(
    9, 'https://comix.to/title/other'
  );
  check('a different title cannot claim or display a persisted checkpoint',
    wrongTitle === null && asyncContext.api.getState().originTabId === 5);

  const matchingTitle = await asyncContext.api.getDownloadAllSessionForTabAsync(
    10, 'https://comix.to/title/series'
  );
  check('the matching title rebinds an interrupted checkpoint after browser restart',
    matchingTitle && matchingTitle.status === 'interrupted' &&
    matchingTitle.originTabId === 10 && matchingTitle.resumeChapterLabel === 'Ch2');
  check('restoring and rebinding the checkpoint persists the repaired session',
    asyncContext.api.getPersistCount() >= 2);
}

runAsyncSessionChecks().then(() => {
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
