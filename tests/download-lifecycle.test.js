'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');
const JSZip = require('../lib/jszip.min.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'content', 'content_title.js'), 'utf8');

function extractFunction(name, text = source) {
  const marker = text.indexOf(`function ${name}(`);
  assert.ok(marker >= 0, `Missing ${name}`);
  const start = text.slice(Math.max(0, marker - 6), marker) === 'async ' ? marker - 6 : marker;
  const bodyStart = text.indexOf('{', text.indexOf(')', marker));
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let i = bodyStart; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
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
    if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`Unterminated ${name}`);
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(test) {
  for (let i = 0; i < 200; i++) { if (test()) return; await tick(); }
  assert.fail('Operation did not reach the expected state');
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const url = (slug = 'series') => `https://comix.to/title/${slug}`;
const chapters = [1, 2, 3].map((n) => ({ chapterUrl: `${url()}/${n}-chapter-${n}`, chapterLabel: `Ch${n}` }));

function harness(overrides = {}) {
  const data = {}, messages = [], saved = [], marks = [], notifications = [];
  const tabs = new Map([[1, { id: 1, url: url() }]]);
  const config = { 'perf.rateLimitMode': 'off', 'download.concurrentChapters': 2 };
  const context = {
    crypto: webcrypto, URL, AbortController, JSZip, console,
    setTimeout(fn, ms) { return setTimeout(fn, ms).unref(); }, clearTimeout,
    chrome: {
      storage: { local: {
        async get(keys) {
          if (overrides.beforeRead) await overrides.beforeRead();
          return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
            .filter((key) => key in data).map((key) => [key, clone(data[key])]));
        },
        async set(values) { if (overrides.beforeWrite) await overrides.beforeWrite(values); Object.assign(data, clone(values)); },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
      } },
      tabs: { async get(id) { if (!tabs.has(id)) throw new Error('Tab closed'); return tabs.get(id); } },
      runtime: { getURL(value) { return value; } },
      notifications: { create(id, options) { notifications.push({ id, ...options }); } },
    },
    cdlLog() {}, restoreIdleBadge() {}, setProgressBadge() {},
    notifyTab(tabId, message) { messages.push({ tabId, ...clone(message) }); },
    downloadErrorText(error) { return error && error.message || String(error); },
    createErrorDiagnostic() { return { code: 'TEST', reference: 'test' }; },
    async loadCfg() { return config; },
    async getSeriesPrefsBg() { return overrides.prefs ? overrides.prefs() : {}; },
    async getLibraryConfig() { return null; },
    downloadAllPartitionPolicy() { return { maxChapters: 2, maxBytes: Infinity }; },
    downloadAllPartSplitReason(count) { return count >= 2 ? 'count_limit' : ''; },
    downloadAllProjectedPartSplitReason() { return ''; },
    async withExtensionKeepAlive(task) { return task(); },
    async addSeriesMetaToOuter() { return 0; },
    async extractFromTab(chapterUrl, cfg, navigation) {
      if (overrides.extract) return overrides.extract(chapterUrl, navigation);
      return [{ index: 1, src: chapterUrl }];
    },
    async verifyEnumeratedImages(images) {
      if (overrides.verify) await overrides.verify(images);
      return images;
    },
    async fetchImageToFile(name) { return { file: { name: `${name}.jpg`, buffer: new Uint8Array([1, 2, 3]), bytes: 3 } }; },
    async addChapterToOuter(zip, chapter) {
      for (const file of chapter.files) zip.folder(chapter.chapterLabel).file(file.name, file.buffer);
      return chapter.bytes;
    },
    async _zipToDownloadUrl(zip, progress) {
      const bytes = await zip.generateAsync({ type: 'uint8array' }, progress);
      return { url: bytes, revoke() {} };
    },
    async _bytesToDownloadUrl(bytes) { return { url: bytes, revoke() {} }; },
    async saveGeneratedArchive(options) {
      if (overrides.save) await overrides.save(options);
      saved.push(options);
      return { filename: options.filename, confirmed: true };
    },
    sanitizeFilename(name) { return name; },
    downloadTargetFilename(name) { return name; },
    directCbzTargetFilename(name) { return `${name}.cbz`; },
    getZipPartName(name, part) { return `${name}-part${part}.zip`; },
    buildCbzEntryName(options, chapter) { return chapter.chapterLabel; },
    uniqueDirectCbzEntryName(used, name) { assert.ok(!used.has(name)); used.add(name); return name; },
    describeArchiveFailure(error) { return { message: error.message, errorKind: 'archive_build' }; },
    recordChapterDownloaded(slug, label) { marks.push(label); },
    async recordSuccessfulDownloadForReview() {},
  };
  vm.createContext(context);
  vm.runInContext(`
    ${source.slice(source.indexOf('let downloadAllAbortFlag'), source.indexOf('// Fallback defaults'))}
    const DOWNLOAD_ALL_LOG_LIMIT = 150;
    const DOWNLOAD_ALL_TERMINAL_SESSION_TTL_MS = 120000;
    const BATCH_SIZE = 3;
    ${source.slice(source.indexOf('let downloadAllSession = null'), source.indexOf('const FEATURES_NOTICE_VERSION'))}
    ${source.slice(source.indexOf('function startDownloadAllSession('), source.indexOf('// ── Réception des messages depuis content_title.js'))}
    ${extractFunction('cancelDownloadAllForTab')}
    ${['resolveOutputOptions', 'chapterConcurrencyLimit', 'isArchiveDeliveryAccepted', 'isDownloadCancelledError',
      'buildChapterComicInfoXml', 'buildChapterCbzBytes', 'handleDownloadAllRequest', '_doZipAndSave',
      'autoDownloadNew', 'postponeAutoDownload'].map((name) => extractFunction(name)).join('\n')}
    globalThis.api = {
      state: () => downloadAllSession,
      setState: (value) => { downloadAllSession = value; },
      busy: () => !!_downloadAllRun,
      get: getDownloadAllSessionForTabAsync,
      cancel: (...args) => withDownloadAllSessionLock(() => cancelDownloadAllForTab(...args)),
      dismiss: (...args) => withDownloadAllSessionLock(() => dismissDownloadAllSessionForTab(...args)),
      resume: (...args) => withDownloadAllSessionLock(() => resumeDownloadAllFromCheckpoint(...args)),
      run: runDownloadAllRequest,
      auto: autoDownloadNew,
      notifyDownloadAllProgress,
      notifyDownloadAllCancelled,
      notifyDownloadAllDone,
      flush: async () => { if (downloadAllSession) persistDownloadAllSession(true, true); await _dlStorageQueue; },
      storageIdle: async () => { await _dlStorageQueue; },
      createResume: createDownloadAllResumeData,
      saveDecision: resolvePendingArchiveSaveDecision,
    };
  `, context);
  return { api: context.api, data, messages, saved, marks, notifications, tabs, config };
}

function interrupted(h, id = 'old') {
  const resumeData = h.api.createResume({ chapters, mangaName: 'Series', zipName: 'Series.zip', options: { slug: 'series' } });
  return { sessionId: id, revision: 1, active: false, status: 'interrupted', canResumeDownload: true,
    seriesSlug: 'series', originTabId: 1, resumeData, updatedAt: Date.now() };
}

async function testSessions() {
  const h = harness();
  h.api.setState(interrupted(h));
  await h.api.flush();
  await h.api.cancel(1, url(), 'old');
  await h.api.storageIdle();
  assert.equal(h.api.state(), null, 'Cancel on a stopped checkpoint must not create a phantom runner');
  assert.equal(await h.api.get(1, url()), null, 'Discarded checkpoint must stay gone on refresh');

  h.api.setState(interrupted(h));
  await h.api.flush();
  const wrong = await h.api.cancel(1, url(), 'different-run');
  assert.equal(wrong.ok, false, 'Old Cancel buttons cannot affect a newer session');
  assert.equal(h.api.state().status, 'interrupted');
  h.tabs.set(2, { id: 2, url: url() });
  assert.equal(await h.api.get(2, url()), null, 'Another live tab cannot steal the checkpoint UI');
  h.tabs.delete(1);
  assert.equal((await h.api.get(2, url())).originTabId, 2, 'Closed owner permits explicit recovery in another tab');

  h.api.notifyDownloadAllCancelled(2);
  await h.api.flush();
  h.api.setState(null);
  assert.equal(await h.api.get(2, url()), null, 'Cancelled state never reopens a downloading frame after restart');
  assert.equal(h.data['cdlDownloadAllResume:series'], undefined);

  const saved = interrupted(h, 'stopping');
  saved.status = 'running';
  saved.active = true;
  saved.cancelRequested = true;
  h.data['cdlDownloadAllSession:series'] = clone(saved);
  h.data['cdlDownloadAllResume:series'] = saved.resumeData;
  assert.equal(await h.api.get(2, url()), null, 'A restart during cancellation must not offer Resume');

  const start = interrupted(h, 'recover');
  start.active = true;
  start.status = 'running';
  h.data['cdlDownloadAllSession:series'] = clone(start);
  h.data['cdlDownloadAllResume:series'] = start.resumeData;
  h.tabs.set(1, { id: 1, url: url() });
  assert.equal(await h.api.get(2, url()), null, 'A worker restart must not transfer ownership from an open tab');
  assert.equal((await h.api.get(1, url())).originTabId, 1);
  h.tabs.delete(1);
  const [first, second] = await Promise.all([h.api.get(2, url()), h.api.get(3, url())]);
  assert.equal(first.status, 'interrupted');
  assert.equal(second, null, 'Concurrent restores grant ownership to only one live tab');
}

async function testPersistence() {
  const write = deferred();
  let hold = true;
  const h = harness({ async beforeWrite() { if (hold) await write.promise; } });
  h.api.setState(interrupted(h));
  const flush = h.api.flush();
  await tick();
  await h.api.dismiss(1, url(), 'old');
  hold = false;
  write.resolve();
  await flush;
  await h.api.storageIdle();
  assert.equal(h.data['cdlDownloadAllSession:series'], undefined, 'Delayed writes cannot resurrect a dismissed session');
  assert.equal(h.data['cdlDownloadAllResume:series'], undefined);

  const unavailable = harness({ beforeRead() { throw new Error('Storage unavailable'); } });
  await assert.rejects(unavailable.api.get(1, url()), /could not be read/,
    'A storage error must not be reported as an absent checkpoint');
}

async function testPipeline(directCbz) {
  const waiting = deferred();
  let opened = 0;
  const h = harness({
    async extract(chapterUrl, navigation) {
      opened++;
      if (chapterUrl.endsWith('chapter-2')) {
        await Promise.race([waiting.promise, navigation.cancelPromise]);
        if (navigation.cancelled()) throw Object.assign(new Error('Stopped'), { code: 'DOWNLOAD_ALL_STOPPED' });
      }
      return [{ index: 1, src: chapterUrl }];
    },
  });
  const task = h.api.run(chapters, 'Series', 'Series.zip', 1, {
    slug: 'series', format: directCbz ? 'cbz' : 'zip', directCbz, includeComicInfo: false,
  }, null, 'run-one');
  await until(() => opened >= 2 && h.messages.some((m) => m.phase === 'done'));
  assert.throws(() => h.api.run(chapters, 'Series', 'Series.zip', 2, {}, null, 'duplicate'), /still stopping/);
  const beforeWrongCancel = h.api.state().status;
  await h.api.cancel(2, url(), 'run-one');
  assert.equal(h.api.state().status, beforeWrongCancel, 'Cancel in another tab cannot stop this run');
  await h.api.cancel(1, url(), 'run-one');
  await h.api.cancel(1, url(), 'run-one');
  await task;
  assert.equal(h.api.busy(), false);
  assert.equal(h.api.state().status, 'cancelled');
  assert.ok(h.saved.length >= 1, 'Cancellation preserves completed chapter files');
  const archive = await JSZip.loadAsync(h.saved[0].url);
  assert.ok(archive.file(directCbz ? '001.jpg' : 'Ch1/001.jpg'), 'Preserved output contains the complete first chapter');
  assert.ok(!h.marks.includes('Ch2'), 'Interrupted chapter must never be marked as downloaded');
  const sent = h.messages.length;
  h.api.notifyDownloadAllProgress(1, { phase: 'downloading', completed: 0 });
  assert.equal(h.messages.length, sent, 'Late progress cannot resurrect a terminal state');
  assert.equal(h.api.state().active, false);
  assert.equal(await h.api.get(1, url()), null);
  waiting.resolve();
  await h.api.run(chapters, 'Series', 'Series.zip', 1, { slug: 'series' }, null, 'run-two');
  assert.equal(h.api.state().status, 'done', 'A fresh download runs normally after cancellation');
  assert.equal(h.api.state().sessionId, 'run-two');
}

async function testSaveDecision() {
  let failSave = true;
  const h = harness({ async save() {
    if (failSave) throw Object.assign(new Error('Download cancelled.'), { code: 'DOWNLOAD_CANCELLED' });
  } });
  const task = h.api.run(chapters.slice(0, 1), 'Series', 'Series.zip', 1, { slug: 'series' }, null, 'save');
  await until(() => h.api.state()?.status === 'awaiting_save');
  h.tabs.set(2, { id: 2, url: url() });
  h.tabs.get(1).url = url('another-series');
  assert.equal((await h.api.get(2, url())).originTabId, 2);
  failSave = false;
  assert.equal(h.api.saveDecision(true), true);
  await task;
  assert.equal(h.saved.length, 1, 'Save again reuses the archive');
  assert.equal(h.saved[0].originTabId, 2, 'Save again uses the recovery tab after the owner navigates away');
  assert.equal(h.messages.at(-1).tabId, 2, 'Completion is delivered to the recovery tab');
  assert.equal(h.api.state().status, 'done');

  h.tabs.get(1).url = url();
  failSave = true;
  const cancelled = h.api.run(chapters.slice(0, 1), 'Series', 'Series.zip', 1, { slug: 'series' }, null, 'save-cancel');
  await until(() => h.api.state()?.status === 'awaiting_save');
  await h.api.cancel(1, url(), 'save-cancel');
  await cancelled;
  assert.equal(h.api.state().status, 'cancelled', 'Cancel must release a pending save-decision wait');
}

async function testWorkerFailure() {
  let opened = 0;
  const h = harness({
    async extract(chapterUrl, navigation) {
      opened++;
      if (chapterUrl.endsWith('chapter-2')) {
        await navigation.cancelPromise;
        throw Object.assign(new Error('Stopped'), { code: 'DOWNLOAD_ALL_STOPPED' });
      }
      return [{ index: 1, src: chapterUrl }];
    },
    async verify() { throw new Error('Unexpected image verifier failure'); },
  });
  await assert.rejects(h.api.run(chapters, 'Series', 'Series.zip', 1, { slug: 'series' }), /verifier failure/);
  assert.ok(opened >= 2, 'The failure happens with concurrent work in flight');
  assert.equal(h.api.busy(), false, 'Fatal errors drain peers and release the runner');
  assert.equal(h.api.state().status, 'error');
  assert.equal(h.api.state().canResumeDownload, true, 'Failed runs retain a usable checkpoint');
}

async function testResume(directCbz) {
  let attempts = 0;
  const h = harness({ async save() {
    if (++attempts === 2) throw new Error('Temporary save failure');
  } });
  await h.api.run(chapters, 'Series', 'Series.zip', 1, {
    slug: 'series', format: directCbz ? 'cbz' : 'zip', directCbz, includeComicInfo: false,
  }, null, 'recoverable');
  assert.equal(h.api.state().status, 'error');
  const checkpoint = h.api.state().resumeData.checkpointIndex;
  assert.equal(checkpoint, directCbz ? 1 : 2);
  const restored = clone(h.api.state());
  await h.api.flush();
  h.api.setState(null);
  const result = await h.api.resume(1, url(), 'recoverable');
  assert.equal(result.checkpointIndex, checkpoint);
  await until(() => !h.api.busy());
  assert.equal(h.api.state().status, 'done', 'Resume succeeds after a worker restart');
  assert.equal(h.api.state().sessionId, restored.sessionId);
  assert.deepEqual(h.marks, ['Ch1', 'Ch2', 'Ch3'], 'Resume does not repeat confirmed output');
  assert.equal(h.saved.length, directCbz ? 3 : 2);
}

async function testProbeCancellation() {
  const controller = new AbortController();
  let aborted = false;
  const context = {
    AbortController, setTimeout, clearTimeout,
    preferredComixOrigin() { return 'https://comix.to'; },
    fetch(_url, { signal }) { return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('Aborted')); }, { once: true });
    }); },
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunction('probeImageUrl')}; globalThis.probe = probeImageUrl;`, context);
  const result = context.probe('https://images.example/001.jpg', url(), controller.signal);
  controller.abort();
  assert.equal(await result, null);
  assert.equal(aborted, true, 'Cancel aborts image-count probes without waiting for the network timeout');
}

async function testAutoDownloadRace() {
  const prefs = deferred();
  const h = harness({
    prefs() { return prefs.promise; },
    async extract(_chapterUrl, navigation) {
      await navigation.cancelPromise;
      throw Object.assign(new Error('Stopped'), { code: 'DOWNLOAD_ALL_STOPPED' });
    },
  });
  const newOnes = [{ ...chapters[0], key: 'new' }];
  h.data.cdlSubscriptions = { series: { lastSeen: ['existing', 'new'] } };
  const automated = h.api.auto('series', 'Series', newOnes, {}, 3);
  const manual = h.api.run(chapters.slice(0, 1), 'Series', 'Series.zip', 1, { slug: 'series' }, null, 'manual');
  prefs.resolve({});
  await automated;
  assert.equal(h.api.state().sessionId, 'manual', 'Auto-download cannot replace a manual run started during preference loading');
  assert.deepEqual(h.data.cdlSubscriptions.series.lastSeen, ['existing'], 'Postponed chapters remain eligible for the next check');
  await h.api.cancel(1, url(), 'manual');
  await manual;

  const failed = harness({ async save() { throw new Error('Save failed'); } });
  await failed.api.auto('series', 'Series', newOnes, { 'subscribe.notify': true }, 3);
  assert.equal(failed.api.state().status, 'error');
  assert.match(failed.notifications.at(-1).title, /stopped/, 'Failed auto-downloads must not announce successful delivery');
}

function testClientRevisions() {
  let popup = { dataset: { sessionId: 'current', seriesSlug: 'series', sessionRevision: '5', sessionStatus: 'running' } };
  const context = {
    document: { getElementById() { return popup; } },
    isTitleOverviewPage() { return true; }, _cdlSlug() { return 'series'; },
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunction('acceptDownloadAllUpdate', client)}; globalThis.accept = acceptDownloadAllUpdate;`, context);
  const update = { action: 'downloadAllProgress', sessionId: 'current', seriesSlug: 'series', revision: 6 };
  assert.equal(context.accept({ ...update, sessionId: 'old' }), false);
  assert.equal(context.accept({ ...update, seriesSlug: 'another-title' }), false);
  assert.equal(context.accept({ ...update, revision: 4 }), false);
  assert.equal(context.accept(update), true);
  assert.equal(context.accept({ ...update, action: 'downloadAllCancelled', revision: 7 }), true);
  assert.equal(context.accept({ ...update, revision: 8 }), false, 'Progress cannot replace a cancelled UI');
  popup = null;
  assert.equal(context.accept(update), false, 'Progress cannot recreate a dismissed frame');
}

function testDelayedStartRetry() {
  const popup = { dataset: { sessionId: 'start', sessionAccepted: 'false', sessionStatus: 'running' } };
  let commands = 0, retry, syncs = 0;
  const context = {
    _lastDlAllParams: { chapters, mangaName: 'Series', zipName: 'Series.zip', options: {} },
    _dlAllViewGeneration: 1,
    document: { getElementById() { return popup; } },
    setTimeout(fn) { retry = fn; },
    chrome: { runtime: { lastError: { message: 'Message port closed' }, sendMessage(_message, callback) { commands++; callback(); } } },
    startDownloadAllSessionSync() { syncs++; },
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunction('_launchDownloadAll', client)}; globalThis.launch = _launchDownloadAll;`, context);
  context.launch();
  assert.equal(commands, 1);
  popup.dataset.sessionAccepted = 'true';
  retry();
  assert.equal(commands, 1, 'Progress received after a lost acknowledgement prevents a duplicate start retry');
  assert.equal(syncs, 0);
}

(async () => {
  await testSessions();
  await testPersistence();
  await testPipeline(false);
  await testPipeline(true);
  await testSaveDecision();
  await testWorkerFailure();
  await testResume(false);
  await testResume(true);
  await testProbeCancellation();
  await testAutoDownloadRace();
  testClientRevisions();
  testDelayedStartRetry();
  console.log('download-lifecycle.test.js: all tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
