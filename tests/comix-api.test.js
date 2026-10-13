'use strict';
/**
 * comix's chapter API as the extension uses it (run: `node tests/comix-api.test.js`): the
 * request is signed and the answer decrypted by comix's own secure-*.js code, borrowed in
 * the comix tab; when the extension falls back to reading a chapter in a background tab;
 * and the addresses a failed page is retried on, compared with comix's reader.
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

// `chapterGapMs` replaces the time between two chapters (COMIX_CHAPTER_GAP_MS), which is 0
// here unless a check is about that time.
function makeContext({ tabs = [comixTab], answer, chapterGapMs = 0 } = {}) {
  const calls = { injected: [], logs: [], slowed: 0 };
  const context = {
    console, URL, Response, TextEncoder, TextDecoder, Uint8Array, DOMException, Date, JSON, Map, setTimeout, clearTimeout,
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
    extractStatement('const COMIX_API_RETRY_AFTER_MS ='),
    extractStatement('const COMIX_PAGE_HOSTS_KEPT ='),
    'const comixPageHosts = new Map();',
    'let comixApiUnusableUntil = 0;',
    'let comixImageTabId = null;',
    extractStatement('const IMAGE_RETRY_AFTER_MAX_MS ='),
    extractStatement('const comixPagePacer ='),
    extractStatement('const COMIX_PACER_STORAGE_KEY ='),
    'let comixPacerRestored = null;',
    `const COMIX_CHAPTER_GAP_MS = ${Number(chapterGapMs)};`,
    extractStatement('const comixChapterPacer ='),
    ...['isComixTabUrl', 'comixTabForImages', 'comixChapterIdFromUrl', 'comixPageReadChapter', 'chapterImagesFromApi',
      'checkCloudflareResponse', 'detectCloudflareChallengeDocument', 'makeCloudflareAccessError', 'isCloudflareAccessError',
      'parseRetryAfterMs', 'rememberComixPageHosts', 'waitForComixChapterTurn', 'restoreComixPacer', 'saveComixPacer',
      'holdComixRequests', 'waitForAbortableDelay', 'makeDownloadAllStoppedError'].map(extractFunction),
    'globalThis.api = { comixChapterIdFromUrl, chapterImagesFromApi, isCloudflareAccessError, comixPageHosts, pacer: comixPagePacer, unusableUntil: () => comixApiUnusableUntil };',
  ].join('\n'), context);
  return { api: context.api, calls };
}

// A stand-in for comix's secure-*.js as its obfuscator ships it: every top-level name is
// also kept on a namespace object on the page ("<namespace>.<name>=<name>"), and the module
// ends with its export list. Its installer adds a request signer and a response decrypter
// to an axios-style client; the other exports are not installers.
const SECURE = 'https://comix.to/assets/build/fixture/dist/secure-fixture-T1.js';
const secureText = [
  'let vmdd=globalThis,vmd7_fixture=vmdd.vmd7_fixture||(vmdd.vmd7_fixture={});',
  "const i={m:'not an installer'};vmd7_fixture.i=i,globalThis.i=vmd7_fixture.i;",
  'function a(){}vmd7_fixture.a=a,globalThis.a=vmd7_fixture.a;',
  'function $(d0){}vmd7_fixture.$=$,globalThis.$=vmd7_fixture.$;',
  'export{i as i,a as x,$ as r};',
].join('');
function installer(client) {
  client.interceptors.request.use((config) => {
    config.params = { ...(config.params || {}), _: 'sig.' + btoa(config.url) };
    config.headers.set('x-fixture', 'signed');
    return config;
  });
  client.interceptors.response.use((response) => {
    const enc = typeof response.headers.get === 'function' ? response.headers.get('x-enc') : response.headers['x-enc'];
    if (enc === '2' && response.data && typeof response.data.e === 'string') {
      response.data = JSON.parse(Buffer.from(response.data.e, 'base64').toString('utf8'));
    }
    return response;
  });
}
const pageNamespace = () => ({
  i: { m: 'not an installer' },
  a: () => { throw new Error('not an installer either'); },
  $: installer,
});
const encrypt = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

// `files` are comix's scripts as the browser cache holds them; `uncached` ones are missing
// from it, and a cache-only read of those fails like the browser's does.
function makePage({ resources = [], scripts = [], files = {}, uncached = [], namespace = pageNamespace(), api }) {
  const seen = [];
  const window = { vmd7_fixture: namespace };
  const pageContext = {
    AbortController, setTimeout, clearTimeout, URL, URLSearchParams, JSON, Object, String, Array, Promise, window,
    location: { origin: 'https://comix.to' },
    performance: { getEntriesByType: () => resources.map((name) => ({ name })) },
    document: { querySelectorAll: () => scripts.map((src) => ({ src })) },
    fetch: async (url, init) => {
      seen.push({ url: String(url), init });
      if (uncached.includes(url) && init && init.cache === 'only-if-cached') throw new TypeError('Failed to fetch');
      if (files[url] != null) return new Response(files[url], { status: 200 });
      return api(String(url), init);
    },
  };
  vm.createContext(pageContext);
  vm.runInContext(extractFunction('comixPageReadChapter') + '\nglobalThis.read = comixPageReadChapter;', pageContext);
  return { read: pageContext.read, seen, window };
}

// comix's reader (build "tmonyg", 10 Oct 2026) picks the address of a failed page's retry
// number e with this function, copied verbatim: (url, altDomains, altNode, page index, e).
const readerRetryUrl = function(a,b,c,d,e){if(!a||e<=0)return a;let f=a;const[g="",h="",i=""]=/^(https?:\/\/)([^/?#]+)/.exec(a)??[],[j="",...k]=i.split("."),l=(e-1)%3,m=2===l&&c?c:j,n=l>=1,o=b?.length?b[d%b.length]:void 0,p=n&&o?o:k.join(".");return m&&p&&(f=h+m+"."+p+a.slice(g.length)),f+(f.includes("?")?"&":"?")+"r="+e};

async function run() {
  // Chapter addresses
  {
    const { api } = makeContext({ answer: () => null });
    check('the chapter id comes from the chapter address', api.comixChapterIdFromUrl(CHAPTER) === '11411479');
    check('comix.ws chapters work too', api.comixChapterIdFromUrl('https://comix.ws/title/abc/42-chapter-1') === '42');
    check('a title page is not a chapter', api.comixChapterIdFromUrl('https://comix.to/title/abc') === '');
    check('a look-alike site is not comix', api.comixChapterIdFromUrl('https://comix.to.example/title/abc/42-chapter-1') === '');
  }

  // The page side: comix's own code signs the request and decrypts the answer
  const chapterAnswer = { id: 11411479, pages: { alt: ['pureheart42.site', 'deepblue90.site'], node: '1xx', items: [
    { width: 720, height: 1334, url: 'https://c150.kkplayer.wtf/hi/page-1' },
    { width: 720, height: 1334, url: 'https://c150.kkplayer.wtf/hi/page-2' },
  ] }, note: 'é漢字' };
  const encryptedAnswer = () => new Response(JSON.stringify({ e: encrypt(chapterAnswer) }),
    { status: 200, headers: { 'content-type': 'application/json', 'x-enc': '2', 'x-build-id': 'tmonyg' } });
  const signed = (id) => `https://comix.to/api/v1/chapters/${id}?_=${encodeURIComponent('sig.' + Buffer.from(`/chapters/${id}`).toString('base64'))}`;
  {
    const page = makePage({ resources: ['https://comix.to/assets/main.js', SECURE], files: { [SECURE]: secureText }, api: encryptedAnswer });
    const result = await page.read('11411479', 30000, '/title/grrd7-the-archmages-restaurant/11411479-chapter-152');
    check('comix\'s script is read from the page, then the request is signed by its own interceptor',
      page.seen.length === 2 && page.seen[0].url === SECURE && page.seen[1].url === signed('11411479'));
    check('headers the signer adds are sent, with the page\'s cookies, like the reader',
      page.seen[1].init.credentials === 'include' && page.seen[1].init.headers['x-fixture'] === 'signed');
    check('the request carries comix\'s own client headers (its firewall can tell requests apart)',
      page.seen[1].init.headers.Accept === 'application/json' && page.seen[1].init.headers['X-Requested-With'] === 'XMLHttpRequest');
    check('the request is sent from the chapter\'s own page, like the reader\'s',
      page.seen[1].init.referrer === 'https://comix.to/title/grrd7-the-archmages-restaurant/11411479-chapter-152');
    check('the answer is decrypted by comix\'s own interceptor, accents and all', result.status === 200 && result.encrypted === false &&
      JSON.stringify(result.data) === JSON.stringify(chapterAnswer));
    check('the encryption and build headers come back for the log', result.headers['x-enc'] === '2' && result.headers['x-build-id'] === 'tmonyg');
    check('comix\'s script is only read back from the browser cache, never fetched again',
      page.seen[0].init.cache === 'only-if-cached' && page.seen[0].init.mode === 'same-origin');
    const again = await page.read('11411480', 30000, 'not-a-title-path');
    check('the next chapter reuses the signer kept on the page: one request',
      again.status === 200 && page.seen.length === 3 && page.seen[2].url === signed('11411480'));
    check('an unexpected chapter address sends no made-up referrer', page.seen[2].init.referrer === undefined);
  }
  {
    // comix served another build: its script is read again.
    const page = makePage({ resources: [SECURE], files: { [SECURE]: secureText }, api: encryptedAnswer });
    await page.read('11411479', 30000);
    page.window[Symbol.for('comix-downloader.chapter-api')].secureUrl = 'https://comix.to/assets/build/old/dist/secure-old.js';
    await page.read('11411479', 30000);
    check('a signer kept from an older comix build is not reused', page.seen.filter((r) => r.url === SECURE).length === 2);
  }
  {
    const page = makePage({
      resources: [SECURE], files: { [SECURE]: secureText },
      api: async () => new Response(JSON.stringify({ e: 'still-secret' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    const result = await page.read('11411479', 30000);
    check('an answer comix\'s code does not decrypt is reported as encrypted', result.status === 200 && result.encrypted === true);
  }
  {
    const page = makePage({ resources: ['https://comix.to/assets/main.js'], api: async () => { throw new Error('should not be called'); } });
    const result = await page.read('11411479', 30000);
    check('a page without comix\'s signing script is reported, with no request', /no signing script/.test(result.unsupported || '') && page.seen.length === 0);
  }
  {
    const page = makePage({
      resources: [SECURE], files: { [SECURE]: secureText }, uncached: [SECURE],
      api: async () => { throw new Error('should not be called'); },
    });
    const result = await page.read('11411479', 30000);
    check('a signing script missing from the cache is reported, with no API request',
      /not in the browser cache/.test(result.unsupported || '') && page.seen.length === 1 && page.seen[0].init.cache === 'only-if-cached');
  }
  {
    const page = makePage({
      resources: [SECURE], files: { [SECURE]: 'let n={},t={};export{n as n,t as t};' },
      api: async () => { throw new Error('should not be called'); },
    });
    const result = await page.read('11411479', 30000);
    check('a signing script without an installer is reported, with no API request',
      /did not offer a request signer/.test(result.unsupported || '') && page.seen.every((r) => r.url === SECURE));
  }
  {
    const page = makePage({
      resources: [SECURE], files: { [SECURE]: secureText }, namespace: undefined,
      api: async () => { throw new Error('should not be called'); },
    });
    page.window.vmd7_fixture = undefined;
    const result = await page.read('11411479', 30000);
    check('a script whose names are not on the page is reported, with no API request', /did not offer a request signer/.test(result.unsupported || ''));
  }
  {
    // The resource list can be full: the script is then found through the page's entry module.
    const main = 'https://comix.to/assets/build/fixture/dist/main-fixture.js';
    const page = makePage({
      resources: [],
      scripts: [main],
      files: { [main]: 'import{r as a}from"./secure-fixture-T1.js";', [SECURE]: secureText },
      api: encryptedAnswer,
    });
    const result = await page.read('11411479', 30000);
    check('the signing script is found through the entry module when the resource list misses it', result.status === 200 && result.data && result.data.id === 11411479);
  }
  {
    const page = makePage({
      resources: [SECURE], files: { [SECURE]: secureText },
      api: async () => new Response('{"message":"Invalid token.","code":"invalid_token"}', { status: 403, headers: { 'content-type': 'application/json' } }),
    });
    const result = await page.read('11411479', 30000);
    check('a refused request returns its status and text', result.status === 403 && /invalid_token/.test(result.text));
  }
  {
    const page = makePage({
      resources: [SECURE], files: { [SECURE]: secureText },
      api: async () => { throw new TypeError('Failed to fetch'); },
    });
    const result = await page.read('11411479', 30000);
    check('a network failure returns no status and the reason', result.status === 0 && /Failed to fetch/.test(result.message));
  }

  // The extension side
  {
    const { api, calls } = makeContext({ answer: () => ({ status: 200, headers: { 'content-type': 'application/json', 'x-enc': '2' }, data: chapterAnswer, encrypted: false }) });
    const images = await api.chapterImagesFromApi(CHAPTER, 7);
    check('a decrypted answer gives the page list in order', Array.isArray(images) && images.length === 2 &&
      images[0].index === 1 && images[0].src === 'https://c150.kkplayer.wtf/hi/page-1' &&
      images[1].index === 2 && images[1].src === 'https://c150.kkplayer.wtf/hi/page-2');
    const injection = calls.injected[0];
    check('it is one request from the comix tab, in the page itself', calls.injected.length === 1 && injection.world === 'MAIN' &&
      injection.target.tabId === 7 && injection.func.name === 'comixPageReadChapter' && injection.args[0] === '11411479' &&
      injection.args[2] === '/title/grrd7-the-archmages-restaurant/11411479-chapter-152');
    const hosts = api.comixPageHosts.get('https://c150.kkplayer.wtf/hi/page-2');
    check('each page keeps the alternative hosts and its position for retries', hosts && hosts.idx === 1 && hosts.altNode === '1xx' &&
      hosts.altDomains.join() === 'pureheart42.site,deepblue90.site');
  }
  {
    const odd = { pages: { alt: ['ok.site', 'bad/path.site', '', 42, 'no-dot'], node: 'a b', items: [{ url: 'https://h.example/p1' }] } };
    const { api } = makeContext({ answer: () => ({ status: 200, headers: {}, data: odd, encrypted: false }) });
    await api.chapterImagesFromApi(CHAPTER, 7);
    const hosts = api.comixPageHosts.get('https://h.example/p1');
    check('only plain domain names are kept as alternative hosts', hosts && hosts.altDomains.join() === 'ok.site' && hosts.altNode === null);
  }
  {
    const older = { result: { pages: { baseUrl: 'https://ek10.web-service-staging-156.site/fcf/', items: [
      { url: 'bEqPbYfoPT0Gm-page-1' }, { url: 'https://other.example/page-2.webp' }] } } };
    const { api } = makeContext({ answer: () => ({ status: 200, headers: {}, data: older, encrypted: false }) });
    const images = await api.chapterImagesFromApi(CHAPTER, 7);
    check('the older answer shape (base address and relative pages) still works', images && images.length === 2 &&
      images[0].src === 'https://ek10.web-service-staging-156.site/fcf/bEqPbYfoPT0Gm-page-1' && api.comixPageHosts.size === 0);
  }

  // When comix's code or the API cannot be used: fall back to the background tab for a while
  {
    const { api, calls } = makeContext({ answer: () => ({ unsupported: 'no signing script was found on the page' }) });
    check('comix\'s code missing falls back to reading the chapter in a tab', (await api.chapterImagesFromApi(CHAPTER, 7)) === null);
    check('the reason is logged', calls.logs.some((l) => /could not be used \(no signing script/.test(l.message)));
    check('the API is not tried again for a while', (await api.chapterImagesFromApi(CHAPTER, 7)) === null && calls.injected.length === 1);
  }
  {
    const { api, calls } = makeContext({ answer: () => ({ status: 403, headers: { 'content-type': 'application/json' }, text: '{"message":"Invalid token.","code":"invalid_token"}' }) });
    check('a refused request falls back to reading the chapter in a tab', (await api.chapterImagesFromApi(CHAPTER, 7)) === null);
    check('the refusal is logged', calls.logs.some((l) => /HTTP 403/.test(l.message)));
    check('a refusal also stops API tries for a while', (await api.chapterImagesFromApi(CHAPTER, 7)) === null && calls.injected.length === 1);
  }
  {
    const { api } = makeContext({ answer: () => ({ status: 200, headers: { 'content-type': 'application/json' }, data: { e: 'x' }, encrypted: true }) });
    check('an answer that stayed encrypted falls back to the tab', (await api.chapterImagesFromApi(CHAPTER, 7)) === null);
  }
  {
    const { api } = makeContext({ answer: () => ({ status: 200, headers: { 'content-type': 'application/json' }, data: { pages: { items: [] } }, encrypted: false }) });
    check('an empty page list falls back to the tab', (await api.chapterImagesFromApi(CHAPTER, 7)) === null);
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
    const left = api.pacer.holdUntil - Date.now();
    check('and every chapter and page waits the time comix asked for', left > 2500 && left <= 3000);
  }

  // Chapters are opened one at a time across every download, with a gap between them
  {
    const answer = () => ({ status: 200, headers: { 'content-type': 'application/json' }, data: chapterAnswer, encrypted: false });
    const { api, calls } = makeContext({ answer, chapterGapMs: 300 });
    const t0 = Date.now();
    await Promise.all([1, 2, 3].map(() => api.chapterImagesFromApi(CHAPTER, 7)));
    const elapsed = Date.now() - t0;
    check('three chapters asked for at once are read one after another, 240-360 ms apart here',
      calls.injected.length === 3 && elapsed >= 480 && elapsed < 1500);
  }
  {
    const { api, calls } = makeContext({ answer: () => { throw new Error('should not be called'); } });
    api.pacer.holdUntil = Date.now() + 400;
    const t0 = Date.now();
    await api.chapterImagesFromApi('https://example.com/title/a/1-chapter-1', 7);
    check('an address that is not a comix chapter does not wait for a turn', Date.now() - t0 < 100 && calls.injected.length === 0);
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

  // Retry addresses match comix's reader
  {
    const retry = {};
    vm.createContext(retry);
    vm.runInContext([extractFunction('cacheBustedImageUrl'), extractFunction('comixReaderRetryUrl'), 'globalThis.retryUrl = comixReaderRetryUrl;'].join('\n'), retry);
    let compared = 0;
    let mismatch = null;
    for (const url of ['https://c150.kkplayer.wtf/hi/abc', 'https://c150.kkplayer.wtf/hi/abc?v3', 'https://x.example/p', 'http://a.b.example/p?x=1']) {
      for (const altDomains of [[], ['pureheart42.site'], ['pureheart42.site', 'deepblue90.site', 'strongforce67.site']]) {
        for (const altNode of [null, '1xx']) {
          for (const idx of [0, 1, 4, 7]) {
            for (let attempt = 0; attempt <= 7; attempt++) {
              const ours = retry.retryUrl(url, { altDomains, altNode, idx }, attempt);
              const theirs = readerRetryUrl(url, altDomains, altNode, idx, attempt);
              compared++;
              if (ours !== theirs && !mismatch) mismatch = { url, altDomains, altNode, idx, attempt, ours, theirs };
            }
          }
        }
      }
    }
    check(`retry addresses for web addresses are the reader's in all ${compared} cases`, !mismatch);
    if (mismatch) console.log(JSON.stringify(mismatch));
    // The reader glues a host onto anything that is not a web address; page addresses from the
    // API always are, and anything else only gets its retry number.
    check('something that is not a web address only gets the retry number',
      retry.retryUrl('not-a-url', { altDomains: ['pureheart42.site'], altNode: '1xx', idx: 0 }, 3) === 'not-a-url?r=3');
    const hosts = { altDomains: ['pureheart42.site', 'deepblue90.site'], altNode: '1xx', idx: 1 };
    check('retry 1 keeps the host, 2 moves domain, 3 also takes the node',
      retry.retryUrl('https://c150.kkplayer.wtf/hi/abc', hosts, 1) === 'https://c150.kkplayer.wtf/hi/abc?r=1' &&
      retry.retryUrl('https://c150.kkplayer.wtf/hi/abc', hosts, 2) === 'https://c150.deepblue90.site/hi/abc?r=2' &&
      retry.retryUrl('https://c150.kkplayer.wtf/hi/abc', hosts, 3) === 'https://1xx.deepblue90.site/hi/abc?r=3');
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => { console.error(error); process.exit(1); });
