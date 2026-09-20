'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const JSZip = require('../lib/jszip.min.js');
const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8').replace(/\r\n/g, '\n');

function extract(name) {
  const marker = source.indexOf(`function ${name}(`);
  assert.ok(marker >= 0, name);
  const start = source.slice(marker - 6, marker) === 'async ' ? marker - 6 : marker;
  // All tested helpers are top-level declarations, so the next declaration is a safe boundary.
  const tail = source.slice(start);
  const end = tail.indexOf('\n}\n');
  assert.ok(end >= 0, name);
  return tail.slice(0, end + 2);
}

const context = {
  URL, Response, TextDecoder, AbortController, setTimeout, clearTimeout, console, crypto: webcrypto, JSZip,
  chrome: { tabs: { get: async () => ({ status: 'complete' }), update: async () => { throw new Error('Unexpected automatic navigation'); } } },
  withExtensionKeepAlive: (task) => task(),
  preferredComixOrigin: () => 'https://comix.to',
};
vm.createContext(context);
const names = ['detectCloudflareChallengeDocument', 'makeCloudflareAccessError', 'isCloudflareAccessError',
  'checkCloudflareResponse', 'createCloudflarePauseControl', 'makeDownloadAllStoppedError', 'isDownloadAllStoppedError',
  'probeImageUrl', 'fetchImageForZip', 'parseRetryAfterMs', 'getImageExtension',
  'createChapterAccessTask', 'downloadImagesAsZip', 'fetchImageToFile', 'fetchImageWithRetry',
  'raceCloudflareCancellation', 'reportCloudflareChallenge', 'coordinateCloudflareChallenge', 'waitForCloudflareChallengeClear'];
vm.runInContext(`
  const CLOUDFLARE_AUTO_WAIT_MS = 4000, CLOUDFLARE_CHALLENGE_TIMEOUT_MS = 300000;
  const CLOUDFLARE_CHALLENGE_POLL_MS = 0, CLOUDFLARE_FOLLOWER_RELEASE_MS = 0;
  let _cloudflareChallengeGate = null, _cloudflareFollowerReleaseChain = Promise.resolve();
  const _chapterAccessTasks = new Map();
  ${names.map(extract).join('\n')}
  globalThis.api = { ${names.join(',')} };
`, context);
const api = context.api;
const classify = (text, extra = {}) => api.detectCloudflareChallengeDocument({ text, ...extra });
const blockedError = () => api.makeCloudflareAccessError(classify('Cloudflare Error 1006: your IP address has been banned'));
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function testClassification() {
  for (const code of [1006, 1007, 1008, 1106]) {
    const result = classify(`Cloudflare Error ${code}: Access denied`);
    assert.equal(result.blockKind, 'ip_ban');
    assert.equal(result.challenged, false);
  }
  for (const code of [1005, 1010, 1020]) {
    assert.equal(classify(`Cloudflare Error ${code}: Access denied`).blockKind, 'access_denied');
  }
  assert.equal(classify('Cloudflare Error 1015: You are being rate limited').blockKind, 'rate_limit');
  assert.equal(classify('Sorry, you have been blocked. Cloudflare Ray ID: abc', { title: 'Attention Required! | Cloudflare' }).blocked, true);
  assert.equal(classify('Access denied').blocked, false, 'An ordinary 403 does not prove an IP ban');
  assert.equal(classify('Cloudflare Ray ID: 1006').blocked, false, 'A Ray ID is not an error code');
  assert.equal(classify('Cloudflare Ray ID: abc').challenged, false, 'A Ray ID alone is not a CAPTCHA');
  assert.equal(classify('Verify you are human', { title: 'Just a moment...' }).challenged, true);
  assert.equal(classify('', { challengeHeader: true }).challenged, true);
  context.document = { title: 'Chapter 1020', body: { innerText: 'Cloudflare Error 1020' }, querySelector: () => ({}) };
  assert.equal(api.detectCloudflareChallengeDocument().blocked, false, 'Reader content wins over unrelated text');
}

async function testResponses() {
  const response = (body, status = 403, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
  await assert.rejects(api.checkCloudflareResponse(response('<h1>Error <span>1006</span></h1> Cloudflare'), 'https://cdn.example/p.jpg?token=secret'),
    (error) => error.blockKind === 'ip_ban' && error.blockedUrl === 'https://cdn.example/p.jpg');
  await assert.rejects(api.checkCloudflareResponse(response('<h1>Sorry, you have been blocked</h1>Cloudflare', 200), ''),
    (error) => error.blockKind === 'access_denied');
  await assert.rejects(api.checkCloudflareResponse(response('challenge', 403, { 'cf-mitigated': 'challenge' }), ''),
    (error) => error.blockKind === 'challenge');
  await assert.rejects(api.checkCloudflareResponse(response('<title>Just a moment...</title>', 200), ''),
    (error) => error.blockKind === 'challenge');
  await assert.rejects(api.checkCloudflareResponse(response('<title>Not an image</title>', 200), ''), /HTML page/);
  await api.checkCloudflareResponse(response('Forbidden', 403, { server: 'cloudflare' }), '');
  await api.checkCloudflareResponse(response('Too many requests', 429), '');
  const image = new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
  await api.checkCloudflareResponse(image, '');
  assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [1, 2, 3], 'Normal images are not read or copied for detection');

  context.fetch = async () => response('Cloudflare Error 1015: You are being rate limited', 429);
  await assert.rejects(api.probeImageUrl('https://cdn.example/page001.jpg', 'https://comix.to'),
    (error) => error.blockKind === 'rate_limit', 'A blocked image-count probe cannot truncate a chapter');
  await assert.rejects(api.fetchImageForZip('https://cdn.example/p.jpg', { 'advanced.disableScramble': true }),
    (error) => error.blockKind === 'rate_limit');
  context.fetch = async () => response('Forbidden', 403);
  await assert.rejects(api.fetchImageForZip('https://cdn.example/p.jpg', {}), (error) => error.status === 403 && !error.blockKind);
  context.fetch = async () => response('<h1>Page not found</h1>', 200);
  assert.equal(await api.probeImageUrl('https://cdn.example/page999.jpg', 'https://comix.to'), false,
    'Ordinary soft-404 probes still report a missing page');
}

async function testChallengeTransitions() {
  context.inspectCloudflareChallengeTab = async () => ({ challenged: false, blocked: true, blockKind: 'ip_ban' });
  await assert.rejects(api.coordinateCloudflareChallenge(1), (error) => error.blockKind === 'ip_ban');
  const states = [];
  let checks = 0;
  context.inspectCloudflareChallengeTab = async () => ++checks === 1
    ? { challenged: true } : { blocked: true, blockKind: 'access_denied', cloudflareCode: '1020' };
  await assert.rejects(api.coordinateCloudflareChallenge(1, { onChallenge: ({ state }) => states.push(state) }),
    (error) => error.cloudflareCode === '1020');
  assert.deepEqual(states, ['automatic'], 'A ban appearing during CAPTCHA is not swallowed by the automatic-wait fallback');
}

async function testPauseGate() {
  let stopped = false, cancel;
  const cancelPromise = new Promise((resolve) => { cancel = resolve; });
  let notices = 0, resumes = 0, calls = 0, activeKeepAlives = 0;
  context.withExtensionKeepAlive = async (task) => {
    activeKeepAlives++;
    try { return await task(); } finally { activeKeepAlives--; }
  };
  const control = api.createCloudflarePauseControl({
    onPause() { notices++; }, onResume() { resumes++; }, cancelPromise, cancelled: () => stopped,
  });
  let first = true;
  const request = control.run(async () => { calls++; if (first) { first = false; throw blockedError(); } return 42; });
  await tick();
  assert.equal(control.paused, true);
  assert.equal(activeKeepAlives, 1);
  const follower = control.run(async () => { calls++; return 43; });
  await tick();
  assert.equal(calls, 1);
  control.resume();
  assert.deepEqual(await Promise.all([request, follower]), [42, 43]);
  assert.equal(notices, 1);
  assert.equal(resumes, 1);
  assert.equal(activeKeepAlives, 0);

  let rejectStale, staleCalls = 0;
  const stale = control.run(() => ++staleCalls === 1
    ? new Promise((_resolve, reject) => { rejectStale = reject; }) : Promise.resolve(44));
  await tick();
  const pause = control.pause(blockedError());
  await tick();
  control.resume();
  await pause;
  rejectStale(blockedError());
  assert.equal(await stale, 44, 'An old in-flight block response cannot re-pause a newer manual attempt');
  assert.equal(notices, 2);
  assert.equal(control.paused, false);

  let oldReject;
  const oldRequest = control.run(() => new Promise((_resolve, reject) => { oldReject = reject; }));
  await tick();
  const waiting = control.pause(blockedError());
  await tick();
  stopped = true;
  cancel();
  oldReject(blockedError());
  await assert.rejects(waiting, (error) => error.code === 'DOWNLOAD_ALL_STOPPED');
  await assert.rejects(oldRequest, (error) => error.code === 'DOWNLOAD_ALL_STOPPED');
  assert.equal(activeKeepAlives, 0, 'Cancelling cleans up the keepalive even with concurrent requests');
}

async function testSingleChapterResume() {
  const requests = [];
  let savedZip, blocked = true;
  Object.assign(context, {
    resolveOutputOptions: () => ({ format: 'zip' }),
    cdlLog() {}, notifyTab() {}, showCloudflareBlockedNotification() {},
    waitForImageHostCooldown: async () => {},
    sanitizeFilename: (name) => name, downloadTargetFilename: (name) => name,
    chapterLabelFromUrl: () => 'Ch1',
    _zipToDownloadUrl: async (zip) => { savedZip = zip; return { url: 'blob:test', revoke() {} }; },
    saveGeneratedArchive: async () => ({ confirmed: true, filename: 'chapter.zip' }),
    isArchiveDeliveryAccepted: () => true, recordSuccessfulDownloadForReview: async () => {},
    recordChapterDownloaded() {},
    fetch: async (url) => {
      requests.push(url);
      if (blocked && url.endsWith('/2')) return new Response('Cloudflare Error 1006: Access denied', { status: 403 });
      return new Response(new Uint8Array([Number(url.slice(-1))]), { headers: { 'content-type': 'image/jpeg' } });
    },
  });
  const task = api.createChapterAccessTask('https://comix.to/title/test/1-chapter-1', 7);
  const images = [1, 2, 3].map((index) => ({ index, src: `https://cdn.example/${index}` }));
  const download = api.downloadImagesAsZip({
    images, chapterUrl: task.chapterUrl, zipName: 'chapter.zip', originTabId: 7,
    cfg: { 'perf.batchSize': 1, 'advanced.disableScramble': true }, task,
  });
  for (let i = 0; i < 100 && !task.access.paused; i++) await tick();
  assert.equal(task.access.paused, true);
  assert.equal(requests.length, 2);
  blocked = false;
  task.access.resume();
  await download;
  assert.deepEqual(requests.map((url) => url.slice(-1)), ['1', '2', '2', '3']);
  assert.deepEqual(Object.keys(savedZip.files), ['001.jpg', '002.jpg', '003.jpg']);
  assert.equal((await savedZip.file('001.jpg').async('uint8array'))[0], 1);
}

const watchdog = setTimeout(() => { console.error('Cloudflare tests did not settle'); process.exit(1); }, 15000);
(async () => {
  await testClassification();
  await testResponses();
  await testChallengeTransitions();
  await testPauseGate();
  await testSingleChapterResume();
  console.log('cloudflare-access.test.js: all tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
