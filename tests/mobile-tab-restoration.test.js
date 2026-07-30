'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) passed++;
  else {
    failed++;
    console.error('FAIL:', name);
  }
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

function buildHarness({ os, createdActive, refreshedActive = createdActive, originUrl }) {
  const calls = [];
  let platformCalls = 0;
  let nextTabId = 101;
  let activeTabId = 7;
  const context = {
    Promise,
    String,
    Number,
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    chrome: {
      runtime: {
        async getPlatformInfo() {
          platformCalls++;
          return { os };
        },
      },
      tabs: {
        async create(properties) {
          calls.push({ action: 'create', properties: { ...properties } });
          const id = nextTabId++;
          if (createdActive) activeTabId = id;
          return { id, active: createdActive, url: properties.url };
        },
        async get(tabId) {
          calls.push({ action: 'get', tabId });
          if (tabId === 7) return { id: 7, active: activeTabId === 7, url: originUrl };
          if (tabId >= 101 && tabId < nextTabId) {
            return { id: tabId, active: refreshedActive && activeTabId === tabId };
          }
          throw new Error('Unknown tab');
        },
        async update(tabId, properties) {
          calls.push({ action: 'update', tabId, properties: { ...properties } });
          if (properties.active) activeTabId = tabId;
          return { id: tabId, ...properties };
        },
        async remove(tabId) {
          calls.push({ action: 'remove', tabId });
          if (activeTabId === tabId) activeTabId = 0;
        },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(`
    let _mobileBrowserPlatformPromise = null;
    function withExtractMarker(url) { return String(url).split('#')[0] + '#cdlx'; }
    ${extractFunction('downloadAllTabSlug')}
    ${extractFunction('isMobileBrowserPlatform')}
    ${extractFunction('restoreMobileDownloadAllOrigin')}
    ${extractFunction('createDownloadAllExtractionTab')}
    ${extractFunction('closeDownloadAllExtractionTab')}
    globalThis.api = {
      isMobileBrowserPlatform,
      createDownloadAllExtractionTab,
      closeDownloadAllExtractionTab,
    };
  `, context);
  return {
    api: context.api,
    calls,
    getPlatformCalls: () => platformCalls,
    getActiveTabId: () => activeTabId,
  };
}

async function run() {
  check('Download All extraction is wired through the managed mobile tab lifecycle',
    source.includes('const opened = await createDownloadAllExtractionTab(') &&
    source.includes('await closeDownloadAllExtractionTab(tabId, opened.navigation)') &&
    source.includes('originTabId,') &&
    source.includes('expectedSeriesSlug,'));

  const brokenMobile = buildHarness({
    os: 'android',
    createdActive: true,
    originUrl: 'https://comix.to/title/series?tab=chapters',
  });
  const opened = await brokenMobile.api.createDownloadAllExtractionTab(
    'https://comix.to/title/series/1-chapter-1',
    7,
    'series'
  );

  check('temporary tabs still request background creation',
    brokenMobile.calls[0].action === 'create' &&
    brokenMobile.calls[0].properties.active === false);
  check('a mobile browser that foregrounds active:false is detected',
    opened.navigation.mobile && opened.navigation.foregrounded);
  check('the exact originating title tab is reactivated after creation',
    brokenMobile.calls.some((call) =>
      call.action === 'update' && call.tabId === 7 && call.properties.active === true));
  check('restoring focus never rewrites or reloads the title URL',
    !brokenMobile.calls.some((call) =>
      call.action === 'update' && Object.prototype.hasOwnProperty.call(call.properties, 'url')));

  const closeStart = brokenMobile.calls.length;
  await brokenMobile.api.closeDownloadAllExtractionTab(101, opened.navigation);
  const closeCalls = brokenMobile.calls.slice(closeStart);
  check('the title is selected before the foreground temporary tab is removed',
    closeCalls[0].action === 'get' &&
    closeCalls[1].action === 'update' &&
    closeCalls[2].action === 'remove');
  check('the title is selected again after mobile tab removal settles',
    closeCalls[closeCalls.length - 2].action === 'get' &&
    closeCalls[closeCalls.length - 1].action === 'update');
  check('mobile platform detection is cached for the full download run',
    await brokenMobile.api.isMobileBrowserPlatform() &&
    brokenMobile.getPlatformCalls() === 1);

  const concurrentMobile = buildHarness({
    os: 'android',
    createdActive: true,
    originUrl: 'https://comix.to/title/series',
  });
  const concurrentTabs = await Promise.all([
    concurrentMobile.api.createDownloadAllExtractionTab(
      'https://comix.to/title/series/1-chapter-1',
      7,
      'series'
    ),
    concurrentMobile.api.createDownloadAllExtractionTab(
      'https://comix.to/title/series/2-chapter-2',
      7,
      'series'
    ),
  ]);
  await Promise.all(concurrentTabs.map((entry) =>
    concurrentMobile.api.closeDownloadAllExtractionTab(entry.tab.id, entry.navigation)));
  check('two foregrounded mobile extraction tabs return to the title, not a closed sibling',
    concurrentMobile.getActiveTabId() === 7 &&
    concurrentMobile.calls.filter((call) => call.action === 'remove').length === 2);

  const workingMobile = buildHarness({
    os: 'android',
    createdActive: false,
    refreshedActive: false,
    originUrl: 'https://comix.to/title/series',
  });
  const backgroundOpened = await workingMobile.api.createDownloadAllExtractionTab(
    'https://comix.to/title/series/2-chapter-2',
    7,
    'series'
  );
  await workingMobile.api.closeDownloadAllExtractionTab(101, backgroundOpened.navigation);
  check('well-behaved mobile browsers keep background tabs and user focus unchanged',
    !backgroundOpened.navigation.foregrounded &&
    !workingMobile.calls.some((call) => call.action === 'update') &&
    workingMobile.calls.some((call) => call.action === 'remove'));

  const desktop = buildHarness({
    os: 'win',
    createdActive: false,
    originUrl: 'https://comix.to/title/series',
  });
  const desktopOpened = await desktop.api.createDownloadAllExtractionTab(
    'https://comix.to/title/series/3-chapter-3',
    7,
    'series'
  );
  await desktop.api.closeDownloadAllExtractionTab(101, desktopOpened.navigation);
  check('desktop extraction behavior is unchanged',
    !desktopOpened.navigation.mobile &&
    !desktop.calls.some((call) => call.action === 'update'));

  const wrongTitle = buildHarness({
    os: 'android',
    createdActive: true,
    originUrl: 'https://comix.to/title/other',
  });
  const wrongOpened = await wrongTitle.api.createDownloadAllExtractionTab(
    'https://comix.to/title/series/4-chapter-4',
    7,
    'series'
  );
  await wrongTitle.api.closeDownloadAllExtractionTab(101, wrongOpened.navigation);
  check('a stale or different title tab is never activated',
    !wrongTitle.calls.some((call) => call.action === 'update') &&
    wrongTitle.calls.some((call) => call.action === 'remove'));

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
