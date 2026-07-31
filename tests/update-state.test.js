'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const UpdateState = require('../core/update-state.js');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

assert.equal(UpdateState.compareVersions('4.2.17', '4.2.16'), 1);
assert.equal(UpdateState.compareVersions('4.3', '4.2.99'), 1);
assert.equal(UpdateState.compareVersions('4.2.16.0', '4.2.16'), 0);
assert.equal(UpdateState.compareVersions('4.2.15', '4.2.16'), -1);
assert.equal(UpdateState.compareVersions('not-a-version', '4.2.16'), 0);

assert.deepStrictEqual(
  UpdateState.normalizeAvailableUpdate({ version: '4.2.17', detectedAt: 1234 }, '4.2.16'),
  { version: '4.2.17', detectedAt: 1234 }
);
assert.equal(
  UpdateState.normalizeAvailableUpdate({ version: '4.2.16', detectedAt: 1234 }, '4.2.16'),
  null,
  'the marker must become stale as soon as the new package is running'
);
assert.equal(
  UpdateState.normalizeAvailableUpdate({ version: '4.2.15' }, '4.2.16'),
  null
);
assert.equal(
  UpdateState.normalizeAvailableUpdate({ version: 'invalid' }, '4.2.16'),
  null
);

assert.equal(UpdateState.hasActiveDownloadWork({}), false);
for (const activity of [
  { downloadAllActive: true },
  { activeChapterDownloads: 1 },
  { queuedChapterDownloads: 1 },
  { pendingExtractionTabs: 1 },
  { pendingArchive: true },
]) {
  assert.equal(UpdateState.hasActiveDownloadWork(activity), true,
    `active work was not detected: ${JSON.stringify(activity)}`);
}

const background = read('background.js');
assert.match(background, /chrome\.runtime\.onUpdateAvailable\.addListener/,
  'the browser-native update event must drive detection');
assert.ok(!background.includes('requestUpdateCheck'),
  'the shared update flow must not depend on Chromium-only update polling');
assert.match(background, /message\.action === 'getAvailableUpdate'/);
assert.match(background, /message\.action === 'installAvailableUpdate'/);
assert.match(background, /hasActiveDownloadWork\(\)/,
  'extension reloads must be guarded while downloads are active');
assert.match(background, /chrome\.runtime\.reload\(\)/,
  'the explicit update action must apply the pending signed package');
assert.match(background, /setBadgeText\(\{ text: 'UP' \}\)/,
  'the toolbar must expose an unambiguous update badge');
assert.match(background, /_downloadProgressBadgeActive/,
  'Download All progress must take priority over the update badge');
assert.ok(!background.includes('chrome.storage.local.clear('),
  'the update lifecycle must never clear all extension data');

const popupHtml = read('popup/popup.html');
const popupJs = read('popup/popup.js');
assert.match(popupHtml, /id="update-panel"/);
assert.match(popupHtml, /id="update-action"/);
assert.match(popupJs, /action: 'getAvailableUpdate'/);
assert.match(popupJs, /action: 'installAvailableUpdate'/);
assert.match(popupJs, /updateBusy/,
  'the popup must explain why an update is deferred during a download');

const buildScript = read('scripts/build-release.ps1');
assert.ok(buildScript.includes('"core/update-state.js"'),
  'all store packages must include the update-state module');

console.log('update-state.test.js: all tests passed');
