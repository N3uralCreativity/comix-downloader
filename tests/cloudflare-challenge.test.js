'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function extractFunction(name) {
  const marker = source.indexOf(`function ${name}(`);
  if (marker < 0) throw new Error(`Missing function ${name}`);
  const start = source.slice(Math.max(0, marker - 6), marker) === 'async ' ? marker - 6 : marker;
  const bodyStart = source.indexOf('{', source.indexOf(')', marker));
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unterminated function ${name}`);
}

function inspect({ title = '', text = '', selectors = [], runtimeMarker = false, url = '' }) {
  const context = {
    document: {
      title,
      body: { innerText: text },
      querySelector(selectorList) {
        return selectors.some((selector) => selectorList.includes(selector)) ? {} : null;
      },
    },
    window: runtimeMarker ? { _cf_chl_opt: {} } : {},
    location: { href: url },
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunction('detectCloudflareChallengeDocument')}\nresult = detectCloudflareChallengeDocument();`, context);
  return context.result;
}

let pass = 0;
let fail = 0;
function check(name, condition) {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', name); }
}

async function run() {
  const chapterUrl = 'https://comix.to/title/series/1-chapter-1';
  const normal = inspect({
    title: 'Chapter 1', selectors: ['img.rpage-page__img'], url: chapterUrl,
  });
  check('a normal chapter reader is not treated as a challenge', normal.challenged === false);
  check('challenge inspection reports reader readiness and the current URL',
    normal.readerReady === true && normal.url === chapterUrl);
  check('a Cloudflare title is detected',
    inspect({ title: 'Just a moment...' }).challenged === true);
  check('the standard Cloudflare challenge form is detected',
    inspect({ selectors: ['form#challenge-form'] }).challenged === true);
  check('the Cloudflare runtime marker is detected',
    inspect({ runtimeMarker: true }).challenged === true);
  check('verification copy is detected when no reader is present',
    inspect({ text: 'Verify you are human before proceeding. Ray ID: 123' }).challenged === true);
  check('reader content prevents an unrelated embedded widget from pausing downloads',
    inspect({ selectors: ['img.rpage-page__img', '.cf-turnstile'] }).challenged === false);

  let inspected = 0;
  let currentUrl = chapterUrl;
  let reloads = 0;
  const waitContext = {
    Date, URL, Promise,
    CLOUDFLARE_CHALLENGE_POLL_MS: 0,
    setTimeout,
    chrome: {
      tabs: {
        get: async () => ({ status: 'complete', url: currentUrl }),
        update: async (_tabId, update) => {
          reloads++;
          currentUrl = update.url;
          return { status: 'loading', url: currentUrl };
        },
        reload: async () => { reloads++; },
      },
    },
    withExtractMarker: (value) => value,
    inspectCloudflareChallengeTab: async () => {
      inspected++;
      return { challenged: false, readerReady: inspected >= 2, url: currentUrl };
    },
    makeDownloadAllStoppedError: () => Object.assign(new Error('cancelled'), {
      name: 'DownloadAllStoppedError', code: 'DOWNLOAD_ALL_STOPPED',
    }),
  };
  vm.createContext(waitContext);
  const waitSource = `
    ${extractFunction('cloudflareChapterLocationMatches')}
    ${extractFunction('raceCloudflareCancellation')}
    ${extractFunction('reloadCloudflareChapterTab')}
    ${extractFunction('waitForCloudflareChallengeClear')}
    globalThis.waitForClear = waitForCloudflareChallengeClear;
  `;
  vm.runInContext(waitSource, waitContext);

  await waitContext.waitForClear(9, Date.now() + 1000, { expectedChapterUrl: chapterUrl });
  check('verification waits for an actual ready chapter reader', inspected === 2);

  inspected = 0;
  reloads = 0;
  currentUrl = 'https://comix.to/';
  waitContext.inspectCloudflareChallengeTab = async () => {
    inspected++;
    return { challenged: false, readerReady: true, url: currentUrl };
  };
  await waitContext.waitForClear(9, Date.now() + 1000, { expectedChapterUrl: chapterUrl });
  check('verification restores the exact affected chapter before resuming',
    reloads === 1 && currentUrl === chapterUrl && inspected >= 2);

  inspected = 0;
  currentUrl = chapterUrl;
  waitContext.inspectCloudflareChallengeTab = async () => ({
    challenged: false, readerReady: false, url: currentUrl,
  });
  let cancellation = null;
  try {
    await waitContext.waitForClear(9, Date.now() + 1000, {
      expectedChapterUrl: chapterUrl,
      cancelPromise: Promise.resolve(),
    });
  } catch (error) { cancellation = error; }
  check('CAPTCHA waits stop immediately when Download All is cancelled',
    cancellation && cancellation.code === 'DOWNLOAD_ALL_STOPPED');
  check('automatic CAPTCHA waiting does not swallow cancellation',
    /isDownloadAllStoppedError\(error\)/.test(source));

  let clearSharedGate = null;
  const sharedGate = new Promise((resolve) => { clearSharedGate = resolve; });
  const reloadedTabs = [];
  const challengeStates = { leader: [], follower: [] };
  const concurrentContext = {
    Promise,
    setTimeout,
    inspectCloudflareChallengeTab: async () => ({ challenged: true }),
    waitForCloudflareChallengeClear: async () => sharedGate,
    restoreChallengeOrigin: async () => true,
    showCloudflareChallengeNotification() {},
    isDownloadAllStoppedError: (error) => error && error.code === 'DOWNLOAD_ALL_STOPPED',
    makeDownloadAllStoppedError: () => Object.assign(new Error('cancelled'), {
      name: 'DownloadAllStoppedError', code: 'DOWNLOAD_ALL_STOPPED',
    }),
    withExtractMarker: (value) => value,
    chrome: {
      tabs: {
        update: async (tabId, update) => {
          if (update.url) reloadedTabs.push({ tabId, url: update.url });
          return { id: tabId, ...update };
        },
        reload: async (tabId) => { reloadedTabs.push({ tabId, url: 'reload' }); },
      },
    },
  };
  vm.createContext(concurrentContext);
  vm.runInContext(`
    const CLOUDFLARE_AUTO_WAIT_MS = 4000;
    const CLOUDFLARE_CHALLENGE_TIMEOUT_MS = 300000;
    const CLOUDFLARE_FOLLOWER_RELEASE_MS = 0;
    let _cloudflareChallengeGate = null;
    let _cloudflareFollowerReleaseChain = Promise.resolve();
    ${extractFunction('reportCloudflareChallenge')}
    ${extractFunction('raceCloudflareCancellation')}
    ${extractFunction('reloadCloudflareChapterTab')}
    ${extractFunction('coordinateCloudflareChallenge')}
    globalThis.coordinate = coordinateCloudflareChallenge;
  `, concurrentContext);

  const leaderUrl = 'https://comix.to/title/series/1-chapter-1';
  const followerUrl = 'https://comix.to/title/series/2-chapter-2';
  const leader = concurrentContext.coordinate(1, {
    expectedChapterUrl: leaderUrl,
    onChallenge: ({ state }) => challengeStates.leader.push(state),
  });
  await Promise.resolve();
  await Promise.resolve();
  const follower = concurrentContext.coordinate(2, {
    expectedChapterUrl: followerUrl,
    onChallenge: ({ state }) => challengeStates.follower.push(state),
  });
  await Promise.resolve();
  clearSharedGate();
  const coordinated = await Promise.all([leader, follower]);
  check('one shared CAPTCHA gate reloads every affected concurrent chapter',
    coordinated.every((result) => result.challenged && result.reloaded) &&
    reloadedTabs.some((entry) => entry.tabId === 1 && entry.url === leaderUrl) &&
    reloadedTabs.some((entry) => entry.tabId === 2 && entry.url === followerUrl));
  check('chapters queued behind CAPTCHA report waiting and automatic retry states',
    challengeStates.follower.includes('waiting') &&
    challengeStates.follower.includes('retrying') &&
    challengeStates.leader.includes('retrying'));
  check('a zero-image extraction after CAPTCHA gets an internal reload before chapter retries',
    source.includes('opened.navigation.challengeExtractionRetried') &&
    source.includes("error.code = 'CHALLENGE_RECOVERY_EMPTY'") &&
    source.includes('pending.challengeExtractionRetried'));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
