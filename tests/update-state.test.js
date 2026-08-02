'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const UpdateState = require('../core/update-state.js');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

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

assert.deepStrictEqual(
  UpdateState.normalizeUpdateCheckResult('update_available', { version: '4.2.20' }),
  { status: 'update_available', version: '4.2.20' },
  'callback-style Chromium update results must be normalized'
);
assert.deepStrictEqual(
  UpdateState.normalizeUpdateCheckResult({ status: 'no_update' }),
  { status: 'no_update', version: '' },
  'Promise-style update results must be normalized'
);
assert.deepStrictEqual(
  UpdateState.normalizeUpdateCheckResult({ status: 'throttled' }),
  { status: 'throttled', version: '' }
);
assert.deepStrictEqual(
  UpdateState.normalizeUpdateCheckResult({ status: 'unexpected', version: '4.2.20' }),
  { status: 'unknown', version: '4.2.20' }
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
assert.match(background, /runtime\[methodName\]/,
  'manual checks must feature-detect the browser-native signed-store update API');
assert.ok(!background.includes('chrome.runtime.requestUpdateCheck'),
  'Firefox packages must not contain a direct reference to the unsupported API');
assert.match(background, /message\.action === 'checkForUpdate'/,
  'manual checks must only run in response to a user-facing runtime message');
assert.match(background, /status: 'unsupported'/,
  'browsers without manual checks must receive an explicit supported fallback');
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
assert.match(background, /const UPDATE_CHECK_PERIOD_MINUTES = 30/,
  'automatic checks must use the requested 30-minute schedule');
assert.match(background, /a\.name === UPDATE_CHECK_ALARM/,
  'the update alarm must trigger the shared update checker');
assert.match(background, /_scheduledUpdateCheckRunning \|\| hasActiveDownloadWork\(\)/,
  'automatic checks must not compete with active downloads or overlap');
assert.match(background, /UPDATE_CHECK_LAST_ATTEMPT_KEY/,
  'manual and automatic checks must share a deduplication timestamp');
assert.match(background, /if \(knownUpdate\)/,
  'automatic checks must stop polling once an update is already known');
assert.ok(!background.includes('chrome.storage.local.clear('),
  'the update lifecycle must never clear all extension data');

const popupHtml = read('popup/popup.html');
const popupJs = read('popup/popup.js');
assert.match(popupHtml, /id="update-panel"/);
assert.match(popupHtml, /id="update-action"/);
assert.match(popupHtml, /id="btn-check-update"/);
assert.match(popupJs, /action: 'getAvailableUpdate'/);
assert.match(popupJs, /action: 'checkForUpdate'/);
assert.match(popupJs, /action: 'installAvailableUpdate'/);
assert.match(popupJs, /updateBusy/,
  'the popup must explain why an update is deferred during a download');

const optionsHtml = read('legacy/options.html');
const optionsJs = read('legacy/options.js');
const embeddedSettings = read('content/cdl-embed-settings.js');
assert.match(optionsHtml, /id="btn-check-update"/,
  'the standalone settings page must expose a manual update check');
assert.match(optionsHtml, /id="settings-update-panel"/,
  'the standalone settings page must render the shared update-ready state');
assert.match(optionsJs, /action: 'checkForUpdate'/);
assert.match(optionsJs, /action: 'installAvailableUpdate'/);
assert.match(embeddedSettings, /class: 'cdl-btn cdl-update-check'/,
  'the integrated settings page must expose a manual update check');
assert.match(embeddedSettings, /action: 'checkForUpdate'/);
assert.match(embeddedSettings, /action: 'installAvailableUpdate'/);

const buildScript = read('scripts/build-release.ps1');
assert.ok(buildScript.includes('"core/update-state.js"'),
  'all store packages must include the update-state module');

async function testNativeUpdateCheckAdapters() {
  const source = [
    extractFunction(background, 'normalizeNativeUpdateCheckResult'),
    extractFunction(background, 'getNativeUpdateCheckRequest'),
    extractFunction(background, 'requestNativeUpdateCheck'),
    'globalThis.requestNativeUpdateCheck = requestNativeUpdateCheck;',
  ].join('\n');

  async function runWithRuntime(runtime) {
    const context = {
      chrome: { runtime },
      CDLUpdateState: UpdateState,
      Promise,
      Error,
      setTimeout,
      clearTimeout,
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    return context.requestNativeUpdateCheck();
  }

  const callbackResult = await runWithRuntime({
    lastError: null,
    requestUpdateCheck(callback) {
      callback('update_available', { version: '4.2.20' });
    },
  });
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(callbackResult)),
    { status: 'update_available', version: '4.2.20' }
  );

  const promiseResult = await runWithRuntime({
    lastError: null,
    requestUpdateCheck() {
      if (arguments.length) throw new TypeError('Callbacks are unsupported');
      return Promise.resolve({ status: 'no_update' });
    },
  });
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(promiseResult)),
    { status: 'no_update', version: '' }
  );

  const unsupportedResult = await runWithRuntime({ lastError: null });
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(unsupportedResult)),
    { status: 'unsupported', version: '' }
  );
}

testNativeUpdateCheckAdapters()
  .then(() => console.log('update-state.test.js: all tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
