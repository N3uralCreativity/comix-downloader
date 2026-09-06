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

function extractConst(name) {
  const marker = source.indexOf(`const ${name} =`);
  if (marker === -1) throw new Error(`Missing const ${name}`);
  const end = source.indexOf(';', marker);
  return source.slice(marker, end + 1);
}

// The Firefox "Missing host permission for the tab" failure: the tab reports the
// chapter URL while still holding its initial about:blank document.
function buildHarness(options = {}) {
  const {
    grantedOrigins = ['*://comix.to/*', '*://comix.ws/*'],
    tabUrl = 'https://comix.to/title/x/1-chapter-1',
  } = options;
  let documentUrls = options.documentUrls || ['about:blank', 'https://comix.to/title/x/1-chapter-1'];

  const calls = [];
  let injectAttempts = 0;
  let tabClosed = false;
  let documentIndex = 0;

  const matches = (pattern, url) => {
    const [scheme, rest] = pattern.split('://');
    const host = rest.replace(/\/\*$/, '');
    try {
      const parsed = new URL(url);
      const schemeOk = scheme === '*' || `${scheme}:` === parsed.protocol;
      const hostOk = host.startsWith('*.')
        ? parsed.hostname === host.slice(2) || parsed.hostname.endsWith(`.${host.slice(2)}`)
        : parsed.hostname === host;
      return schemeOk && hostOk;
    } catch (_) {
      return false;
    }
  };

  const context = {
    Promise, String, Number, Math, Date, Error, URL, setTimeout, clearTimeout,
    console,
    chrome: {
      runtime: { lastError: null },
      scripting: {
        async executeScript(injection) {
          injectAttempts++;
          calls.push({ action: 'executeScript', tabId: injection.target.tabId });
          if (tabClosed) throw new Error('No tab with id: 101.');
          const current = documentUrls[Math.min(documentIndex, documentUrls.length - 1)];
          documentIndex++;
          const allowed = grantedOrigins.some((pattern) => matches(pattern, current));
          if (!allowed) throw new Error('Missing host permission for the tab');
          return [{ result: { url: current, readyState: 'complete' } }];
        },
      },
      permissions: {
        contains(query, callback) {
          calls.push({ action: 'permissions.contains', origins: query.origins.slice() });
          const ok = query.origins.every((requested) =>
            grantedOrigins.some((granted) => {
              const [, grantedHost] = granted.split('://');
              const [, requestedHost] = requested.split('://');
              return grantedHost === requestedHost;
            }));
          callback(ok);
        },
      },
      tabs: {
        async get(tabId) {
          calls.push({ action: 'tabs.get', tabId });
          if (tabClosed) throw new Error('No tab with id: 101.');
          return { id: tabId, status: 'complete', url: tabUrl };
        },
        async update(tabId, properties) {
          calls.push({ action: 'tabs.update', tabId, properties: { ...properties } });
          return { id: tabId };
        },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(`
    function downloadErrorText(value) {
      if (!value) return '';
      if (typeof value === 'string') return value;
      return String(value.reason || value.error || value.message || value.code || value);
    }
    function makeDownloadAllStoppedError() {
      const error = new Error('Download All stopped.');
      error.code = 'DOWNLOAD_ALL_STOPPED';
      return error;
    }
    ${extractConst('HOST_PERMISSION_ERROR_RE')}
    ${extractConst('INJECTION_RETRY_BASE_MS')}
    ${extractConst('INJECTION_RETRY_MAX_MS')}
    ${extractConst('INJECTION_READY_TIMEOUT_MS')}
    ${extractConst('INJECTION_STALLED_NUDGE_MS')}
    ${extractFunction('isHostPermissionError')}
    ${extractFunction('injectionOriginPattern')}
    ${extractFunction('hasGrantedHostPermission')}
    ${extractFunction('makeInjectionNotReadyError')}
    ${extractFunction('makeMissingHostPermissionError')}
    ${extractFunction('injectionTargetUrl')}
    ${extractFunction('executeScriptWhenInjectable')}
    ${extractFunction('probeInjectableDocument')}
    ${extractFunction('waitForInjectableTab')}
    globalThis.api = {
      isHostPermissionError,
      injectionOriginPattern,
      hasGrantedHostPermission,
      executeScriptWhenInjectable,
      waitForInjectableTab,
      INJECTION_READY_TIMEOUT_MS,
      INJECTION_STALLED_NUDGE_MS,
    };
  `, context);

  return {
    api: context.api,
    calls,
    closeTab: () => { tabClosed = true; },
    // Simulates the tab finally committing a document (e.g. after a nudge).
    commitDocument: (url) => { documentUrls = [url]; documentIndex = 0; },
    getInjectAttempts: () => injectAttempts,
  };
}

function buildDiagnosticsHarness() {
  const context = { String, Number, Math, Date, Error, console };
  vm.createContext(context);
  vm.runInContext(`
    ${extractConst('HOST_PERMISSION_ERROR_RE')}
    function downloadErrorText(value) {
      if (!value) return '';
      if (typeof value === 'string') return value;
      return String(value.reason || value.error || value.message || value.code || value);
    }
    ${extractFunction('diagnosticHttpStatus')}
    ${extractFunction('diagnosticDefinition')}
    globalThis.api = { diagnosticDefinition };
  `, context);
  return context.api;
}

async function run() {
  // ── Source wiring ──────────────────────────────────────────────────────────
  check('Download All waits for an injectable document before probing Cloudflare',
    /await waitForInjectableTab\(tabId, \{[\s\S]*?\}\);\s*\n\s*const challenge = await coordinateCloudflareChallenge\(tabId, opened\.navigation\);/
      .test(source));
  check('Single-chapter extraction waits for an injectable document too',
    /await waitForInjectableTab\(tabId, \{[\s\S]*?\}\);\s*\n\s*const challenge = await coordinateCloudflareChallenge\(tabId, \{/
      .test(source));
  check('Both extraction injections go through the retrying helper',
    source.split('await executeScriptWhenInjectable({').length === 4 &&
    !/executeScript\(\{[^}]*\n\s*func:\s*extractChapterImagesFromPage/.test(source));
  check('A stalled background tab is nudged with a fresh navigation',
    source.includes('nudge: () => chrome.tabs.update(tabId, { url: withExtractMarker(url) })') &&
    source.includes('nudge: () => chrome.tabs.update(tabId, { url: withExtractMarker(chapterUrl) })'));

  // ── Error recognition ──────────────────────────────────────────────────────
  const { api } = buildHarness();
  check('Firefox wording is recognised as a host-permission failure',
    api.isHostPermissionError(new Error('Missing host permission for the tab')));
  check('Chromium wording is recognised as a host-permission failure',
    api.isHostPermissionError(new Error(
      'Cannot access contents of the page. Extension manifest must request permission to access the respective host.'
    )));
  check('Unrelated failures are not mistaken for host-permission failures',
    !api.isHostPermissionError(new Error('Timeout chargement onglet')) &&
    !api.isHostPermissionError(new Error('Aucune image trouvée dans ce chapitre')));

  check('Origin patterns drop the port and keep the scheme',
    api.injectionOriginPattern('https://comix.to/title/x/1-chapter-1?a=b#cdlx') === 'https://comix.to/*');
  check('A tab between documents yields no origin pattern',
    api.injectionOriginPattern('about:blank') === null &&
    api.injectionOriginPattern('') === null);

  check('A granted origin reports true, an unlisted one false, about:blank null',
    (await api.hasGrantedHostPermission('https://comix.to/x')) === true &&
    (await api.hasGrantedHostPermission('https://example.com/x')) === false &&
    (await api.hasGrantedHostPermission('about:blank')) === null);

  // ── Retry until the real document commits ──────────────────────────────────
  const committing = buildHarness({
    documentUrls: ['about:blank', 'about:blank', 'https://comix.to/title/x/1-chapter-1'],
  });
  const ready = await committing.api.waitForInjectableTab(101, { timeoutMs: 5000 });
  check('Injection is retried until the chapter document commits',
    ready && ready.url === 'https://comix.to/title/x/1-chapter-1' &&
    committing.getInjectAttempts() === 3);
  check('Waiting never mistakes an uncommitted tab for a permission denial',
    committing.calls.filter((c) => c.action === 'permissions.contains').length === 2);

  // ── Genuine denial ─────────────────────────────────────────────────────────
  const denied = buildHarness({
    grantedOrigins: [],
    documentUrls: ['https://comix.to/title/x/1-chapter-1'],
  });
  let deniedError = null;
  try { await denied.api.waitForInjectableTab(101, { timeoutMs: 5000 }); }
  catch (error) { deniedError = error; }
  check('An ungranted host permission fails fast with an actionable message',
    deniedError && deniedError.code === 'HOST_PERMISSION_MISSING' &&
    /comix\.to/.test(deniedError.message) &&
    /permissions/i.test(deniedError.message) &&
    denied.getInjectAttempts() === 1);
  check('A denial is reported as a chapter extraction failure',
    deniedError && deniedError.cdlKind === 'chapter_extraction');

  // ── Tab closed mid-wait ────────────────────────────────────────────────────
  const closed = buildHarness({ documentUrls: ['about:blank'] });
  closed.closeTab();
  let closedError = null;
  try { await closed.api.waitForInjectableTab(101, { timeoutMs: 5000 }); }
  catch (error) { closedError = error; }
  check('A closed tab stops the wait instead of retrying to the deadline',
    closedError && /No tab with id/.test(closedError.message) &&
    closed.getInjectAttempts() === 1);

  // ── Deadline ───────────────────────────────────────────────────────────────
  const stuck = buildHarness({ documentUrls: ['about:blank'] });
  let stuckError = null;
  try { await stuck.api.waitForInjectableTab(101, { timeoutMs: 400 }); }
  catch (error) { stuckError = error; }
  check('A tab that never commits reports a load failure, not a permission failure',
    stuckError && stuckError.code === 'INJECTION_NOT_READY' &&
    !api.isHostPermissionError(stuckError));

  // ── Stalled tab nudge ──────────────────────────────────────────────────────
  // Firefox for Android unloads background tabs: the tab reports the chapter URL
  // but holds no document, so waiting alone never succeeds.
  const stalled = buildHarness({ documentUrls: ['about:blank'] });
  let nudgeCount = 0;
  const woken = await stalled.api.waitForInjectableTab(101, {
    timeoutMs: 5000,
    nudgeAfterMs: 100,
    nudge: () => {
      nudgeCount++;
      stalled.commitDocument('https://comix.to/title/x/1-chapter-1');
    },
  });
  check('An unloaded background tab is re-navigated exactly once', nudgeCount === 1);
  check('The wait succeeds once the nudged tab commits its document',
    woken && woken.url === 'https://comix.to/title/x/1-chapter-1');

  const hopeless = buildHarness({ documentUrls: ['about:blank'] });
  let nudgeError = null;
  let hopelessNudges = 0;
  try {
    await hopeless.api.waitForInjectableTab(101, {
      timeoutMs: 600, nudgeAfterMs: 100, nudge: () => { hopelessNudges++; },
    });
  } catch (error) { nudgeError = error; }
  check('A nudge that does not help still surfaces the load failure',
    nudgeError && nudgeError.code === 'INJECTION_NOT_READY' && hopelessNudges === 1);

  // ── Cancellation ───────────────────────────────────────────────────────────
  const cancellable = buildHarness({ documentUrls: ['about:blank'] });
  let cancelError = null;
  try {
    await cancellable.api.waitForInjectableTab(101, {
      timeoutMs: 5000,
      cancelled: () => true,
    });
  } catch (error) { cancelError = error; }
  check('A stopped Download All aborts the wait immediately',
    cancelError && cancelError.code === 'DOWNLOAD_ALL_STOPPED' &&
    cancellable.getInjectAttempts() === 0);

  // ── Diagnostics ────────────────────────────────────────────────────────────
  const diagnostics = buildDiagnosticsHarness();
  const permissionDiagnostic = diagnostics.diagnosticDefinition(
    new Error('Missing host permission for the tab'), '', 'extracting'
  );
  check('A raw host-permission failure is classified as a chapter extraction failure',
    permissionDiagnostic.kind === 'chapter_extraction' &&
    permissionDiagnostic.code === 'CDL-EXTRACT-003');
  const emptyDiagnostic = diagnostics.diagnosticDefinition(
    new Error('Aucune image trouvée dans ce chapitre'), 'chapter_extraction', 'extracting'
  );
  check('Extraction failures without a permission cause keep their own codes',
    emptyDiagnostic.code === 'CDL-EXTRACT-002');
  check('The permission code carries an actionable public message',
    source.includes("diagnostic.code === 'CDL-EXTRACT-003'") &&
    /Allow Comix Downloader to access it in the browser add-on permissions/.test(source));

  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
