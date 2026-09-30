'use strict';
/**
 * comix's chapter API as the extension uses it (run: `node tests/comix-api.test.js`): the
 * signed request token, the encrypted answer, and when the extension falls back to reading
 * a chapter in a background tab.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name); }
}

function extractFunction(name) {
  const marker = source.indexOf(`function ${name}(`);
  if (marker === -1) throw new Error(`Missing function ${name}`);
  const start = source.slice(Math.max(0, marker - 6), marker) === 'async ' ? marker - 6 : marker;
  const tail = source.slice(start);
  const end = tail.indexOf('\n}\n');
  if (end === -1) throw new Error(`Unterminated function ${name}`);
  return tail.slice(0, end + 2);
}

function extractStatement(prefix) {
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`Missing ${prefix}`);
  const end = source.indexOf(';\n', start);
  return source.slice(start, end + 1);
}

const CHAPTER = 'https://comix.to/title/grrd7-the-archmages-restaurant/11411479-chapter-152';
const comixTab = { id: 7, url: 'https://comix.to/title/grrd7-the-archmages-restaurant', status: 'complete', discarded: false };

function makeContext({ tabs = [comixTab], answer } = {}) {
  const calls = { injected: [], logs: [], slowed: 0 };
  const context = {
    console, URL, Response, TextEncoder, TextDecoder, Uint8Array, DOMException, atob, btoa, Date, JSON,
    downloadAllSession: null,
    cdlLog: (level, message) => calls.logs.push({ level, message }),
    slowComixPagesAfterWarning: () => { calls.slowed++; },
    chrome: {
      tabs: {
        get: async (id) => { const tab = tabs.find((t) => t.id === id); if (!tab) throw new Error('No tab'); return tab; },
        query: async () => tabs.slice(),
      },
      scripting: {
        executeScript: async (injection) => { calls.injected.push(injection); return [{ result: await answer(injection) }]; },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext([
    extractStatement('const COMIX_TAB_PATTERNS ='),
    extractStatement('const COMIX_API_CIPHER ='),
    extractStatement('const COMIX_API_RETRY_AFTER_MS ='),
    'let comixApiLayers = null;',
    'let comixApiUnusableUntil = 0;',
    'let comixImageTabId = null;',
    ...['isComixTabUrl', 'comixTabForImages', 'comixApiCipherLayers', 'comixApiEncode', 'comixApiDecode',
      'comixChapterIdFromUrl', 'comixPageFetchApi', 'chapterImagesFromApi', 'checkCloudflareResponse',
      'detectCloudflareChallengeDocument', 'makeCloudflareAccessError', 'isCloudflareAccessError',
      'parseRetryAfterMs'].map(extractFunction),
    'globalThis.api = { comixApiEncode, comixApiDecode, comixChapterIdFromUrl, chapterImagesFromApi, comixPageFetchApi, isCloudflareAccessError, unusableUntil: () => comixApiUnusableUntil };',
  ].join('\n'), context);
  return { api: context.api, calls };
}

async function run() {
  const { api } = makeContext({ answer: () => null });

  // The request token, checked against tokens comix's own reader sent on 2026-09-29/30
  check('the token for a chapter matches the reader\'s', api.comixApiEncode('/chapters/11411479') === 'IQ6wvJBq2kpghZShPvotMPVu');
  check('the token for another chapter matches the reader\'s', api.comixApiEncode('/chapters/5741936') === 'IQ6wvJBq2kpghX9rPXV1E-E');
  check('the token for a series matches the reader\'s', api.comixApiEncode('/manga/grrd7') === 'IZ-P1pUtAgJt3KP7');
  const text = JSON.stringify({ result: { pages: { baseUrl: 'https://x.example/fcf', items: [{ url: 'a' }] } }, note: 'é漢字' });
  check('an answer decodes back to the same text, accents and all', api.comixApiDecode(api.comixApiEncode(text)) === text);

  // Chapter addresses
  check('the chapter id comes from the chapter address', api.comixChapterIdFromUrl(CHAPTER) === '11411479');
  check('comix.ws chapters work too', api.comixChapterIdFromUrl('https://comix.ws/title/abc/42-chapter-1') === '42');
  check('a title page is not a chapter', api.comixChapterIdFromUrl('https://comix.to/title/abc') === '');
  check('a look-alike site is not comix', api.comixChapterIdFromUrl('https://comix.to.example/title/abc/42-chapter-1') === '');

  const pagesJson = { status: 200, result: { pages: { baseUrl: 'https://ek10.web-service-staging-156.site/fcf/', items: [
    { width: 690, height: 1000, url: 'bEqPbYfoPT0Gm-page-1' },
    { width: 690, height: 1000, url: 'https://other.example/page-2.webp' },
  ] } } };

  // Encrypted answer, as comix sends it
  {
    const { api, calls } = makeContext({ answer: () => ({ status: 200, headers: { 'content-type': 'application/json', 'x-enc': '1' },
      text: JSON.stringify({ e: makeContext({ answer: () => null }).api.comixApiEncode(JSON.stringify(pagesJson)) }) }) });
    const images = await api.chapterImagesFromApi(CHAPTER, 7);
    check('an encrypted answer gives the page list in order', Array.isArray(images) && images.length === 2 &&
      images[0].index === 1 && images[0].src === 'https://ek10.web-service-staging-156.site/fcf/bEqPbYfoPT0Gm-page-1' &&
      images[1].index === 2 && images[1].src === 'https://other.example/page-2.webp');
    const injection = calls.injected[0];
    check('it is one request from the comix tab, in the page itself', calls.injected.length === 1 && injection.world === 'MAIN' && injection.target.tabId === 7);
    check('the request carries the signed token the reader would send',
      injection.args[0] === '/chapters/11411479?_=IQ6wvJBq2kpghZShPvotMPVu');
  }

  // Plain answer (older API shape) and a bare list of pages
  {
    const { api } = makeContext({ answer: () => ({ status: 200, headers: { 'content-type': 'application/json' }, text: JSON.stringify(pagesJson) }) });
    const images = await api.chapterImagesFromApi(CHAPTER, 7);
    check('an unencrypted answer works too', images && images.length === 2);
  }

  // comix changed its keys: fall back to the background tab, and stop asking for a while
  {
    const { api, calls } = makeContext({ answer: () => ({ status: 403, headers: { 'content-type': 'application/json' }, text: '{"message":"Missing token"}' }) });
    check('a refused token falls back to reading the chapter in a tab', (await api.chapterImagesFromApi(CHAPTER, 7)) === null);
    check('the fallback is logged', calls.logs.some((l) => /HTTP 403/.test(l.message)));
    check('the API is not asked again for a while', (await api.chapterImagesFromApi(CHAPTER, 7)) === null && calls.injected.length === 1);
  }
  {
    const { api } = makeContext({ answer: () => ({ status: 200, headers: { 'content-type': 'application/json' }, text: '{"e":"not-a-real-answer"}' }) });
    check('an answer that cannot be read falls back to the tab', (await api.chapterImagesFromApi(CHAPTER, 7)) === null);
  }

  // Blocks, server errors and network failures are not fallbacks
  {
    const { api, calls } = makeContext({ answer: () => ({ status: 403, headers: { 'content-type': 'text/html', server: 'cloudflare' },
      text: '<title>Attention Required! | Cloudflare</title><h1>Sorry, you have been blocked</h1>' }) });
    const error = await api.chapterImagesFromApi(CHAPTER, 7).catch((e) => e);
    check('a Cloudflare block pauses the download instead of opening tabs', api.isCloudflareAccessError(error));
    check('a Cloudflare block also slows the page pace', calls.slowed === 1);
  }
  {
    const { api } = makeContext({ answer: () => ({ status: 503, headers: { 'content-type': 'text/html', 'retry-after': '3' }, text: 'busy' }) });
    const error = await api.chapterImagesFromApi(CHAPTER, 7).catch((e) => e);
    check('a server error is retried with its status and Retry-After', error.status === 503 && error.retryAfterMs === 3000);
  }
  {
    const { api } = makeContext({ answer: () => ({ status: 0, message: 'Failed to fetch' }) });
    const error = await api.chapterImagesFromApi(CHAPTER, 7).catch((e) => e);
    check('a network failure is retried', error.name === 'TypeError');
  }

  // When the API route is not available at all
  {
    const { api, calls } = makeContext({ answer: () => { throw new Error('should not be called'); } });
    check('a non-comix address never asks the API', (await api.chapterImagesFromApi('https://example.com/title/a/1-chapter-1', 7)) === null && calls.injected.length === 0);
  }
  {
    const { api, calls } = makeContext({ tabs: [], answer: () => { throw new Error('should not be called'); } });
    check('without a comix tab the chapter is read in a tab as before', (await api.chapterImagesFromApi(CHAPTER, 7)) === null && calls.injected.length === 0);
  }

  // The page-side request itself
  {
    const seen = [];
    const pageContext = {
      AbortController, setTimeout, clearTimeout, String,
      location: { origin: 'https://comix.to' },
      fetch: async (url, init) => { seen.push({ url, init }); return new Response('{"e":"x"}', { status: 200, headers: { 'content-type': 'application/json', 'x-enc': '1' } }); },
    };
    vm.createContext(pageContext);
    vm.runInContext(extractFunction('comixPageFetchApi') + '\nglobalThis.pageApi = comixPageFetchApi;', pageContext);
    const result = await pageContext.pageApi('/chapters/11411479?_=IQ6wvJBq2kpghZShPvotMPVu', 30000);
    check('the page asks its own origin with its cookies, like the reader', seen[0].url === 'https://comix.to/api/v1/chapters/11411479?_=IQ6wvJBq2kpghZShPvotMPVu' &&
      seen[0].init.credentials === 'include' && seen[0].init.headers.Accept === 'application/json, text/plain, */*');
    check('the page returns the status, the encryption flag and the text', result.status === 200 && result.headers['x-enc'] === '1' && result.text === '{"e":"x"}');
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => { console.error(error); process.exit(1); });
