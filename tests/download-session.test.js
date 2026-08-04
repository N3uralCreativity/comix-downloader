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
  const DL_SESSION_KEY = 'cdlDownloadAllSession';
  const DL_RESUME_KEY = 'cdlDownloadAllResume';
  const DL_SESSION_PREFIX = 'cdlDownloadAllSession:';
  const DL_RESUME_PREFIX = 'cdlDownloadAllResume:';
  ${extractFunction('cloneDownloadAllOptions')}
  ${extractFunction('normalizeDownloadAllResumeChapters')}
  ${extractFunction('createDownloadAllResumeData')}
  ${extractFunction('isValidDownloadAllResumeData')}
  ${extractFunction('isCompletedDownloadAllResumeData')}
  ${extractFunction('downloadAllResumeSlug')}
  ${extractFunction('downloadAllTabSlug')}
  ${extractFunction('downloadAllSessionSlug')}
  ${extractFunction('downloadAllStorageKeys')}
  ${extractFunction('downloadAllSessionMatchesUrl')}
  ${extractFunction('_serializeSession')}
  ${extractFunction('prepareInterruptedDownloadAllSession')}
  globalThis.api = {
    createDownloadAllResumeData,
    isValidDownloadAllResumeData,
    isCompletedDownloadAllResumeData,
    downloadAllSessionMatchesUrl,
    downloadAllStorageKeys,
    serialize: _serializeSession,
    prepareInterruptedDownloadAllSession,
  };
`, context);

const chapters = [
  { chapterUrl: 'https://comix.to/title/series/1-chapter-1', chapterLabel: 'Ch1', group: 'Flame Comics', groupId: '42' },
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
check('resume data preserves scanlator metadata and its group alias',
  resume.chapters[0].scanlator === 'Flame Comics' &&
  resume.chapters[0].group === 'Flame Comics' && resume.chapters[0].groupId === '42');
check('resume data clones nested options', resume.options.nested.format === 'zip');
check('a fresh checkpoint is resumable', context.api.isValidDownloadAllResumeData(resume));
check('resume data derives title matching from its slug',
  context.api.downloadAllSessionMatchesUrl({ resumeData: resume }, 'https://comix.to/title/series'));
check('resume data rejects a different title URL',
  !context.api.downloadAllSessionMatchesUrl({ resumeData: resume }, 'https://comix.to/title/other'));
check('persisted Download All slots are isolated by normalized title slug', (() => {
  const first = context.api.downloadAllStorageKeys('Series');
  const second = context.api.downloadAllStorageKeys('other');
  return first.session === 'cdlDownloadAllSession:series' &&
    first.resume === 'cdlDownloadAllResume:series' && first.session !== second.session;
})());

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

const zippingSession = {
  active: true,
  status: 'running',
  phase: 'zipping',
  resumeData: { ...resume, checkpointIndex: 0, nextZipPart: 1, savedZipNames: [] },
};
context.api.prepareInterruptedDownloadAllSession(zippingSession, 9);
check('a worker restart during ZIP creation is identified by its real stage',
  zippingSession.errorTitle === 'ZIP creation was interrupted.' &&
  zippingSession.failurePhase === 'zipping' &&
  zippingSession.errorKind === 'runtime_interruption');

const serialized = context.api.serialize(session);
check('the live session snapshot omits the full chapter checkpoint payload',
  !Object.prototype.hasOwnProperty.call(serialized, 'resumeData'));
check('the live session snapshot preserves resume UI fields',
  serialized.canResumeDownload && serialized.resumeChapterLabel === 'Ch3');

const cancelledSerialized = context.api.serialize({
  active: false,
  status: 'cancelled',
  savedChapters: 2,
  doneZipName: 'series-partial.zip',
  warning: '',
  lastCancelled: {
    action: 'downloadAllCancelled',
    savedChapters: 2,
    zipName: 'series-partial.zip',
    warning: '',
  },
});
check('cancelled sessions persist the number and name of preserved chapters',
  cancelledSerialized.savedChapters === 2 &&
  cancelledSerialized.lastCancelled.savedChapters === 2 &&
  cancelledSerialized.doneZipName === 'series-partial.zip');

const recoverableContext = {
  resumeData: { ...resume, checkpointIndex: 1, savedZipNames: ['series-part1.zip'] },
  terminal: null,
  sent: null,
  restoredBadge: false,
};
vm.createContext(recoverableContext);
vm.runInContext(`
  const DOWNLOAD_ALL_RESUME_VERSION = 1;
  let downloadAllSession = { phase: 'zipping', resumeData };
  function recordDownloadAllTerminal(status, patch) { terminal = { status, ...patch }; }
  function restoreIdleBadge() { restoredBadge = true; }
  function notifyTab(_tabId, message) { sent = message; }
  ${extractFunction('isValidDownloadAllResumeData')}
  ${extractFunction('notifyDownloadAllError')}
  globalThis.report = () => notifyDownloadAllError(7, 'allocation failed', {
    errorTitle: 'ZIP creation failed.',
    errorKind: 'archive_build',
    failurePhase: 'archive_build',
  });
`, recoverableContext);
recoverableContext.report();
check('recoverable archive failures remain errors rather than generic interruptions',
  recoverableContext.sent.action === 'downloadAllError' &&
  recoverableContext.sent.errorTitle === 'ZIP creation failed.' &&
  recoverableContext.terminal.status === 'error');
check('recoverable archive failures expose the last confirmed checkpoint immediately',
  recoverableContext.sent.canResumeDownload === true &&
  recoverableContext.sent.resumeChapterLabel === 'Ch2' &&
  recoverableContext.sent.completed === 1 && recoverableContext.restoredBadge);

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
  const storageData = {
    cdlDownloadAllSession: { ...storedSession },
    cdlDownloadAllResume: { ...storedResume },
  };
  const asyncContext = {
    Date, JSON, Math, Number, String, Array, Set,
    storageData,
    chrome: {
      storage: {
        local: {
          async get(names) {
            const out = {};
            for (const name of names) {
              if (Object.prototype.hasOwnProperty.call(storageData, name)) {
                out[name] = JSON.parse(JSON.stringify(storageData[name]));
              }
            }
            return out;
          },
          remove(names) {
            for (const name of Array.isArray(names) ? names : [names]) delete storageData[name];
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
    const DL_SESSION_PREFIX = 'cdlDownloadAllSession:';
    const DL_RESUME_PREFIX = 'cdlDownloadAllResume:';
    let downloadAllSession = null;
    let persistCount = 0;
    function persistDownloadAllSession(_force, includeResumeData) {
      persistCount++;
      const keys = downloadAllStorageKeys(downloadAllSession);
      const snapshot = JSON.parse(JSON.stringify(downloadAllSession));
      delete snapshot.resumeData;
      storageData[keys.session] = snapshot;
      if (includeResumeData && downloadAllSession.resumeData) {
        storageData[keys.resume] = JSON.parse(JSON.stringify(downloadAllSession.resumeData));
      }
    }
    function clearPersistedSession(session = downloadAllSession) {
      const keys = downloadAllStorageKeys(session);
      delete storageData[keys.session];
      delete storageData[keys.resume];
    }
    function clearPersistedDownloadAllResume(session = downloadAllSession) {
      const keys = downloadAllStorageKeys(session);
      if (session) session.resumeData = null;
      delete storageData[keys.resume];
    }
    ${extractFunction('isValidDownloadAllResumeData')}
    ${extractFunction('isCompletedDownloadAllResumeData')}
    ${extractFunction('downloadAllResumeSlug')}
    ${extractFunction('downloadAllTabSlug')}
    ${extractFunction('downloadAllSessionSlug')}
    ${extractFunction('downloadAllStorageKeys')}
    ${extractFunction('downloadAllSessionMatchesUrl')}
    ${extractFunction('prepareInterruptedDownloadAllSession')}
    ${extractFunction('clearLegacyPersistedDownloadAllSession')}
    ${extractFunction('loadPersistedSession')}
    ${extractFunction('getDownloadAllSessionForTab')}
    ${extractFunction('getDownloadAllSessionForTabAsync')}
    globalThis.api = {
      getDownloadAllSessionForTabAsync,
      getState: () => downloadAllSession,
      setState: (next) => { downloadAllSession = next; },
      getPersistCount: () => persistCount,
    };
  `, asyncContext);

  const wrongTitle = await asyncContext.api.getDownloadAllSessionForTabAsync(
    9, 'https://comix.to/title/other'
  );
  check('a legacy checkpoint cannot claim or display a different title',
    wrongTitle === null && asyncContext.api.getState() === null);

  const matchingTitle = await asyncContext.api.getDownloadAllSessionForTabAsync(
    10, 'https://comix.to/title/series'
  );
  check('the matching title rebinds an interrupted checkpoint after browser restart',
    matchingTitle && matchingTitle.status === 'interrupted' &&
    matchingTitle.originTabId === 10 && matchingTitle.resumeChapterLabel === 'Ch2');
  check('legacy checkpoints migrate into a title-scoped storage slot',
    !!storageData['cdlDownloadAllSession:series'] &&
    !!storageData['cdlDownloadAllResume:series'] && !storageData.cdlDownloadAllSession);

  const otherResume = {
    ...storedResume,
    chapters: storedResume.chapters.map((chapter) => ({
      ...chapter,
      chapterUrl: chapter.chapterUrl.replace('/series/', '/other/'),
    })),
    mangaName: 'Other',
    options: { ...storedResume.options, slug: 'other' },
    checkpointIndex: 0,
    nextZipPart: 1,
    savedZipNames: [],
  };
  storageData['cdlDownloadAllSession:other'] = {
    active: false,
    status: 'interrupted',
    originTabId: 4,
    mangaName: 'Other',
    totalChapters: 3,
    seriesSlug: 'other',
    canResumeDownload: true,
    updatedAt: Date.now(),
  };
  storageData['cdlDownloadAllResume:other'] = otherResume;

  const otherTitle = await asyncContext.api.getDownloadAllSessionForTabAsync(
    11, 'https://comix.to/title/other'
  );
  check('each title restores only its own interrupted Download All session',
    otherTitle && otherTitle.mangaName === 'Other' && otherTitle.seriesSlug === 'other' &&
    otherTitle.originTabId === 11);

  const firstTitleAgain = await asyncContext.api.getDownloadAllSessionForTabAsync(
    12, 'https://comix.to/title/series'
  );
  check('switching titles preserves the earlier title checkpoint independently',
    firstTitleAgain && firstTitleAgain.mangaName === 'Series' &&
    firstTitleAgain.seriesSlug === 'series' && firstTitleAgain.originTabId === 12);

  const cleanTitle = await asyncContext.api.getDownloadAllSessionForTabAsync(
    13, 'https://comix.to/title/clean-title'
  );
  check('a title without a checkpoint starts with clean Download All state',
    cleanTitle === null && asyncContext.api.getState() === null);
  check('restoring and rebinding scoped checkpoints persists repaired sessions',
    asyncContext.api.getPersistCount() >= 4);

  asyncContext.api.setState({
    active: true,
    status: 'running',
    originTabId: 20,
    mangaName: 'Series',
    seriesSlug: 'series',
    totalChapters: 3,
    updatedAt: Date.now(),
  });
  const duplicateTitleTab = await asyncContext.api.getDownloadAllSessionForTabAsync(
    21, 'https://comix.to/title/series'
  );
  check('a second same-title tab cannot steal an active Download All session',
    duplicateTitleTab === null && asyncContext.api.getState().originTabId === 20);
}

runAsyncSessionChecks().then(() => {
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
