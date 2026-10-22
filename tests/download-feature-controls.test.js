'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const settings = require('../core/settings.js');
const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');
const extract = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};

assert.equal(settings.DEFAULTS['download.enableAll'], false);
assert.equal(settings.validate({})['download.enableAll'], false, 'Existing installations default to off');
assert.equal(settings.validate({ 'download.enableAll': true })['download.enableAll'], true);
assert.ok(settings.TABS.find(tab => tab.id === 'download').keys.includes('download.enableAll'));
assert.match(settings.SCHEMA['download.enableAll'].label, /deprecated/i);
assert.match(settings.SCHEMA['download.enableAll'].warn, /IP bans/);
assert.match(settings.SCHEMA['download.enableAll'].warn, /Comix blocking/);

const messages = [];
const tasks = new Map();
const queue = [];
const removedTabs = [];
const context = vm.createContext({
  _chapterAccessTasks: tasks,
  downloadQueue: queue,
  pendingDownloads: new Map(),
  AbortController,
  crypto: require('node:crypto').webcrypto,
  createCloudflarePauseControl: () => ({}),
  chrome: { tabs: {
    sendMessage(tabId, message) { messages.push({ tabId, message }); return Promise.resolve(); },
    remove(tabId) { removedTabs.push(tabId); return Promise.resolve(); },
  } },
});
vm.runInContext(extract('notifyTab') + '\n' + extract('createChapterAccessTask'), context);

const task = context.createChapterAccessTask('https://comix.to/title/test/1-chapter-1', 10);
context.notifyTab(10, { action: 'downloadProgress', chapterUrl: task.chapterUrl, taskId: task.id, current: 2, total: 5 });
context.notifyTab(10, { action: 'downloadPackaging', chapterUrl: task.chapterUrl, taskId: task.id, percent: 40 });
assert.equal(task.progress.imagesDone, 2, 'Archive snapshots retain downloaded image counts');
assert.equal(task.progress.imagesTotal, 5);
assert.equal(task.progress.revision, 2);
assert.equal(task.progress.percent, 40);
assert.equal(messages[1].tabId, 10, 'Updates remain scoped to the owning tab');

queue.push({ task });
task.cancel();
assert.equal(task.signal.aborted, true);
assert.equal(queue.length, 0, 'Queued cancellation does not fetch images');
assert.equal(tasks.has(task.id), false);
const newer = context.createChapterAccessTask(task.chapterUrl, 10);
context.notifyTab(10, { action: 'downloadPreparing', chapterUrl: newer.chapterUrl, taskId: newer.id });
context.notifyTab(10, { action: 'downloadCancelled', chapterUrl: task.chapterUrl, taskId: task.id });
assert.equal(newer.progress.action, 'downloadPreparing', 'Late cancellation cannot mutate a newer task');
assert.equal(messages.at(-1).message.taskId, task.id);

const extracting = context.createChapterAccessTask('https://comix.to/title/test/2-chapter-2', 10);
extracting.tabId = 20;
context.pendingDownloads.set(20, { handling: false });
extracting.cancel();
assert.deepEqual(removedTabs, [20]);
assert.equal(context.pendingDownloads.has(20), false);
assert.equal(tasks.has(extracting.id), false, 'Unstarted extraction does not retain an aborted task');

const titleSource = fs.readFileSync(require.resolve('../content/content_title.js'), 'utf8');
const updateStart = titleSource.indexOf('function updateChapterProgressPanel(');
const updateSource = titleSource.slice(updateStart, titleSource.indexOf('\n}', updateStart) + 2);
const progress = new Map();
const view = vm.createContext({
  _chapterProgressItems: progress,
  _cdlSlug: () => 'test',
  document: { getElementById: () => ({}) },
  renderChapterProgressPanel() {},
});
vm.runInContext(updateSource, view);
const chapterUrl = task.chapterUrl;
view.updateChapterProgressPanel({ action: 'downloadPreparing', chapterUrl, taskId: 'old', revision: 1 });
view.updateChapterProgressPanel({ action: 'downloadCancelled', chapterUrl, taskId: 'old', revision: 2 });
view.updateChapterProgressPanel({ action: 'downloadPreparing', chapterUrl });
view.updateChapterProgressPanel({ action: 'downloadPreparing', chapterUrl, taskId: 'retry', revision: 1 });
assert.equal(view.updateChapterProgressPanel({ action: 'downloadDone', chapterUrl, taskId: 'old', revision: 3 }), false);
view.updateChapterProgressPanel({ action: 'downloadProgress', chapterUrl, taskId: 'retry', revision: 3, current: 2, total: 5 });
assert.equal(view.updateChapterProgressPanel({ action: 'downloadProgress', chapterUrl, taskId: 'retry', revision: 2, current: 1, total: 5 }), false);
assert.equal(progress.get(chapterUrl).taskId, 'retry');
assert.equal(progress.get(chapterUrl).imagesDone, 2, 'Late restore responses do not roll progress backwards');
console.log('PASS Download All default, setting warning, single progress snapshots, queued cancellation, extraction cleanup and retry isolation');
