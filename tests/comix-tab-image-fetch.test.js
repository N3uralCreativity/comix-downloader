'use strict';
/**
 * Pages on comix's rotating image hosts are fetched from inside an open comix tab
 * (run: `node tests/comix-tab-image-fetch.test.js`). Those hosts answer 403 unless the
 * request comes from comix.to, and the extension can only add comix's Referer on hosts
 * it has permission for.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));

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
  const bodyStart = source.indexOf('{', source.indexOf(')', marker));
  let depth = 0; let quote = ''; let escaped = false; let lineComment = false; let blockComment = false;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i]; const next = source[i + 1];
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

function extractConst(name) {
  const match = source.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (!match) throw new Error(`Missing const ${name}`);
  return match[0];
}

function makeContext({ tabs = [], inject }) {
  const calls = { injected: [] };
  const context = {
    console, URL, Uint8Array, atob, Response, DOMException, AbortController, setTimeout, clearTimeout,
    downloadAllSession: null,
    chrome: {
      tabs: {
        get: async (id) => { const tab = tabs.find((t) => t.id === id); if (!tab) throw new Error('No tab with id: ' + id); return tab; },
        query: async () => tabs.slice(),
      },
      scripting: {
        executeScript: async (injection) => { calls.injected.push(injection); return inject(injection); },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext([
    extractConst('DIRECT_IMAGE_HOST'),
    extractConst('COMIX_TAB_PATTERNS'),
    'let comixImageTabId = null;',
    ...['canFetchImageDirectly', 'isComixTabUrl', 'comixTabForImages', 'makeComixTabRequiredError', 'raceAbort',
      'base64ToBytes', 'comixPageFetchImage', 'fetchImageThroughComixTab', 'parseRetryAfterMs',
      'imageRequestStatus', 'isRetryableImageRequestError'].map(extractFunction),
    'globalThis.api = { canFetchImageDirectly, fetchImageThroughComixTab, isRetryableImageRequestError, comixTabForImages };',
  ].join('\n'), context);
  return { api: context.api, calls, context };
}

const PAGE = 'https://jloo.quantum-data-api.site/i5/bEqPbYfoPT0Gm2HlHkKfoAJUyr0BYu6i3R0VvqLI6y4E8EoNPDQ';
const comixTab = { id: 7, url: 'https://comix.to/title/grrd7-the-archmages-restaurant', status: 'complete', discarded: false };

async function run() {
  const { api } = makeContext({ inject: () => [] });

  // Which hosts the extension fetches itself
  check('comix.to pages are fetched directly', api.canFetchImageDirectly('https://comix.to/images/a.webp'));
  check('static.comix.to pages are fetched directly', api.canFetchImageDirectly('https://static.comix.to/186e/i/8/46/a@280.jpg'));
  check('comix.ws pages are fetched directly', api.canFetchImageDirectly('https://comix.ws/images/a.webp'));
  check('the wowpic hosts in the Referer rule are fetched directly', api.canFetchImageDirectly('https://k2.wowpic7.store/i/1.webp'));
  check('a rotating image host goes through the comix tab', !api.canFetchImageDirectly(PAGE));
  check('another rotating image host goes through the comix tab', !api.canFetchImageDirectly('https://ek10.spark-node-v2.site/i5/abc'));
  check('a look-alike host is not treated as comix', !api.canFetchImageDirectly('https://comix.to.evil.example/a.webp'));
  check('wowpic10 is not covered by the Referer rule', !api.canFetchImageDirectly('https://k2.wowpic10.store/a.webp'));

  // The direct hosts must stay exactly the ones the extension can reach with comix's Referer.
  const rule = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules', 'comix-image-headers.json'), 'utf8'))[0];
  check('the Referer rule still covers the wowpic hosts', new RegExp(rule.condition.regexFilter).test('https://k2.wowpic7.store/'));
  check('no new required host permission was added', !manifest.host_permissions.some((entry) => /quantum|spark|sync-core|\*:\/\/\*\/\*/.test(entry)));

  // A page fetched through the comix tab
  const bytes = Buffer.from('RIFF....WEBPVP8 test');
  {
    const { api, calls } = makeContext({
      tabs: [comixTab],
      inject: () => [{ result: { ok: true, status: 200, contentType: 'image/webp', data: bytes.toString('base64') } }],
    });
    const response = await api.fetchImageThroughComixTab(PAGE, 30000, null);
    const body = Buffer.from(await response.arrayBuffer());
    check('the page bytes come back unchanged', body.equals(bytes));
    check('the content type is kept', response.headers.get('content-type') === 'image/webp');
    check('the fetch runs in the page itself (MAIN world) of the comix tab',
      calls.injected[0].world === 'MAIN' && calls.injected[0].target.tabId === 7);
    check('the page function receives the image address and timeout', calls.injected[0].args[0] === PAGE && calls.injected[0].args[1] === 30000);
  }

  // The Download All tab is preferred over other comix tabs
  {
    const other = { id: 3, url: 'https://comix.to/home', status: 'complete', discarded: false };
    const { api, calls, context } = makeContext({
      tabs: [other, comixTab],
      inject: () => [{ result: { ok: true, status: 200, contentType: 'image/webp', data: bytes.toString('base64') } }],
    });
    context.downloadAllSession = { originTabId: 7 };
    await api.fetchImageThroughComixTab(PAGE, 30000, null);
    check('the tab that started Download All is used', calls.injected[0].target.tabId === 7);
  }

  // HTTP errors keep their status so the retry rules apply
  {
    const { api } = makeContext({ tabs: [comixTab], inject: () => [{ result: { ok: false, status: 503, retryAfter: '2' } }] });
    const error = await api.fetchImageThroughComixTab(PAGE, 30000, null).catch((e) => e);
    check('a server error keeps its HTTP status', error.status === 503 && /HTTP 503/.test(error.message));
    check('a server error keeps Retry-After', error.retryAfterMs === 2000);
    check('a server error is retried', api.isRetryableImageRequestError(error));
  }

  // No comix tab: a clear message, not endless retries
  {
    const { api } = makeContext({ tabs: [{ id: 9, url: 'https://example.com/', status: 'complete' }], inject: () => [] });
    const error = await api.fetchImageThroughComixTab(PAGE, 30000, null).catch((e) => e);
    check('without a comix tab the error says to keep one open', error.code === 'COMIX_TAB_REQUIRED' && /keep a comix\.to tab open/.test(error.message));
    check('without a comix tab it is not retried', !api.isRetryableImageRequestError(error));
  }

  // The tab closed or navigated away during the download
  {
    let first = true;
    const { api, calls } = makeContext({
      tabs: [comixTab],
      inject: () => {
        if (first) { first = false; throw new Error('Frame with ID 0 was removed.'); }
        return [{ result: { ok: true, status: 200, contentType: 'image/webp', data: bytes.toString('base64') } }];
      },
    });
    const error = await api.fetchImageThroughComixTab(PAGE, 30000, null).catch((e) => e);
    check('a tab that went away is a retryable network error', error.name === 'TypeError' && api.isRetryableImageRequestError(error));
    const response = await api.fetchImageThroughComixTab(PAGE, 30000, null);
    check('the next attempt finds a comix tab again', response.ok && calls.injected.length === 2);
  }

  // A page-side network failure (for example a refused CORS response) is retried
  {
    const { api } = makeContext({ tabs: [comixTab], inject: () => [{ result: { ok: false, status: 0, message: 'Failed to fetch' } }] });
    const error = await api.fetchImageThroughComixTab(PAGE, 30000, null).catch((e) => e);
    check('a page-side network failure is retryable', api.isRetryableImageRequestError(error));
  }

  // Stopping Download All abandons a request still running in the page
  {
    const controller = new AbortController();
    const { api } = makeContext({ tabs: [comixTab], inject: () => new Promise(() => {}) });
    const pending = api.fetchImageThroughComixTab(PAGE, 30000, controller.signal).catch((e) => e);
    controller.abort();
    const error = await pending;
    check('an abort ends the wait at once', error.name === 'AbortError');
  }

  // The page function itself, run against a stubbed page fetch
  {
    const pageContext = {
      AbortController, setTimeout, clearTimeout, String,
      fetch: async (url, init) => {
        pageContext.seen = { url, init };
        return new Response(bytes, { status: 200, headers: { 'content-type': 'image/webp' } });
      },
      FileReader: class {
        readAsDataURL(blob) {
          blob.arrayBuffer().then((buffer) => {
            this.result = 'data:image/webp;base64,' + Buffer.from(buffer).toString('base64');
            this.onload();
          });
        }
      },
    };
    vm.createContext(pageContext);
    vm.runInContext(extractFunction('comixPageFetchImage') + '\nglobalThis.pageFetch = comixPageFetchImage;', pageContext);
    const result = await pageContext.pageFetch(PAGE, 30000);
    check('the page fetch sends no cookies (the hosts allow any origin, not credentials)', pageContext.seen.init.credentials === 'omit');
    check('the page fetch sends comix as the referrer origin', pageContext.seen.init.referrerPolicy === 'strict-origin-when-cross-origin');
    check('the page fetch returns base64 bytes and the type', result.ok && Buffer.from(result.data, 'base64').equals(bytes) && result.contentType === 'image/webp');
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => { console.error(error); process.exit(1); });
