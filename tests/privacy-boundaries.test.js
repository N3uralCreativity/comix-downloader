'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const makeRoute = require('../core/cdl-route.js');
const settings = require('../core/settings.js');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const background = read('background.js');
let passed = 0;

async function test(name, fn) {
  await fn();
  passed++;
  console.log('PASS ' + name);
}

function extractFunction(name) {
  const marker = background.indexOf('function ' + name + '(');
  assert.ok(marker >= 0, name);
  const start = background.slice(marker - 6, marker) === 'async ' ? marker - 6 : marker;
  const end = background.indexOf('\n}\n', marker);
  return background.slice(start, end + 2);
}

function pageWindow(url = 'https://comix.to/title/fixture') {
  const win = new EventTarget();
  win.location = new URL(url);
  win.document = new EventTarget();
  win.document.getElementById = () => null;
  win.document.readyState = 'complete';
  win.history = {
    state: { existing: true },
    pushState(state, title, url) { win.history.state = state; win.location = new URL(url, win.location); },
    replaceState(state, title, url) { win.history.state = state; win.location = new URL(url, win.location); }
  };
  win.open = () => 'opened';
  win.HTMLAnchorElement = class { click() { return 'clicked'; } };
  win.top = win;
  return win;
}

function runScript(file, win, extra = {}) {
  const context = vm.createContext({
    window: win, document: win.document, history: win.history, location: win.location,
    Event, CustomEvent, URL, setTimeout, clearTimeout, console, ...extra
  });
  vm.runInContext(read(file), context, { filename: file });
  return context;
}

function communityContext(enabled = false, dataPermissions = []) {
  const calls = [];
  const changes = [];
  const state = { enabled, granted: true, fetchImpl: null };
  const stored = {};
  const context = vm.createContext({
    Date, TextEncoder, Uint8Array, crypto: webcrypto, AbortController,
    CDLSettings: { communityDataPermissions: () => dataPermissions },
    loadCfg: async () => ({ 'privacy.communitySharing': state.enabled }),
    chrome: {
      runtime: {},
      permissions: { contains: (request, callback) => callback(state.granted) },
      storage: {
        onChanged: { addListener: fn => changes.push(fn) },
        local: { get: async key => ({ [key]: stored[key] }), set: async value => Object.assign(stored, value) }
      }
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (state.fetchImpl) return state.fetchImpl(url, options);
      return { ok: true, json: async () => ({ first: '2026-10-22', counts: { total: 1 } }) };
    }
  });
  const start = background.indexOf('const CDL_BADGE_API =');
  const end = background.indexOf('// Chrome also exposes `browser`', start);
  vm.runInContext(background.slice(start, end) + '\nglobalThis.api = { badgeRegister, badgeLookup, flagSubmit, flagLookup, communityFetch };', context);
  return { api: context.api, calls, state, changes };
}

(async () => {
  await test('SPA subscriptions use authenticated extension messages, not public DOM events', () => {
    const win = pageWindow();
    let listener;
    win.chrome = { runtime: { id: 'our-extension', onMessage: { addListener: fn => { listener = fn; } } } };
    const route = makeRoute(win);
    let count = 0;
    const callback = () => { count++; };
    const unsubscribe = route.subscribe(callback);
    route.subscribe(() => { throw new Error('one failed subscriber must not stop the rest'); });
    win.location = new URL('/title/another', win.location);
    listener({ action: 'cdlRouteChanged' }, { id: 'another-extension' });
    win.dispatchEvent(new Event('cdl:locationchange'));
    assert.equal(count, 0);
    listener({ action: 'cdlRouteChanged' }, { id: 'our-extension' });
    listener({ action: 'cdlRouteChanged' }, { id: 'our-extension' });
    assert.equal(count, 1, 'same URL notifications are deduplicated');
    win.history.pushState({}, '', '/user?tab=settings');
    assert.equal(count, 2, 'extension-initiated navigation is immediate');
    unsubscribe();
    win.history.replaceState({}, '', '/agenda');
    assert.equal(count, 2);
  });

  await test('background route forwarding stays on supported origins and sends no URL payload', () => {
    const sent = [];
    const context = vm.createContext({
      supportedComixOrigin: value => /^https:\/\/comix\.(to|ws)\//.test(value || ''),
      notifyTab: (tabId, message) => sent.push({ tabId, message })
    });
    vm.runInContext(extractFunction('handleComixRouteUpdated') + '\nglobalThis.handler = handleComixRouteUpdated;', context);
    context.handler(7, { url: 'https://comix.to/title/a' }, {});
    context.handler(8, { status: 'complete' }, { url: 'https://comix.ws/agenda' });
    context.handler(9, { url: 'https://elsewhere.test/private' }, {});
    context.handler(10, { title: 'unchanged URL' }, { url: 'https://comix.to/' });
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
      { tabId: 7, message: { action: 'cdlRouteChanged' } },
      { tabId: 8, message: { action: 'cdlRouteChanged' } }
    ]);
  });

  await test('named page elements cannot suppress the isolated route helper', () => {
    const win = pageWindow();
    const proto = Object.create(Object.getPrototypeOf(win));
    proto.CDLRoute = { nodeType: 1 };
    Object.setPrototypeOf(win, proto);
    runScript('core/cdl-route.js', win);
    assert.equal(typeof win.CDLRoute.subscribe, 'function');
    assert.equal(Object.hasOwn(win, 'CDLRoute'), true);
  });

  await test('adblocking exposes neither its API nor unguarded native function references', () => {
    const win = pageWindow();
    runScript('content/adblock-main.js', win);
    assert.equal(win.CDLAdblock, undefined);
    assert.equal(win.__cdlAdblockInstalled, undefined);
    assert.deepEqual(Object.keys(win.open), []);
    assert.deepEqual(Object.keys(win.HTMLAnchorElement.prototype.click), []);
    assert.equal(win.open('https://ads.test'), null);
    win.dispatchEvent(new CustomEvent('cdl:adblock-state', { detail: false }));
    assert.equal(win.open('https://ads.test'), 'opened', 'stored off switch still works');
    win.dispatchEvent(new CustomEvent('cdl:adblock-state', { detail: 'off' }));
    win.dispatchEvent(new CustomEvent('cdl:adblock-state', { detail: true }));
    assert.equal(win.open('https://ads.test'), null);
    const adblock = require('../content/adblock-main.js');
    const other = pageWindow();
    adblock.install(other);
    const guard = other.open;
    adblock.install(other);
    assert.equal(other.open, guard, 'install remains idempotent');
  });

  await test('adblock settings relay does not leave a DOM attribute behind', () => {
    const win = pageWindow();
    const events = [];
    win.addEventListener('cdl:adblock-state', event => events.push(event.detail));
    win.document.documentElement = { setAttribute() { throw new Error('must not write DOM state'); } };
    runScript('content/adblock-control.js', win, {
      chrome: {
        runtime: {}, storage: {
          local: { get: (key, callback) => callback({ cdlSettings: { 'features.blockAds': false } }) },
          onChanged: { addListener() {} }
        }
      }
    });
    assert.deepEqual(events, [true, false]);
  });

  await test('ordinary pages receive no decoder or history hook from the extraction bridge', () => {
    const win = pageWindow();
    win.TextDecoder = class { decode(value) { return value; } };
    win.atob = value => value;
    const decode = win.TextDecoder.prototype.decode;
    const atob = win.atob;
    const push = win.history.pushState;
    const replace = win.history.replaceState;
    runScript('content/extract-bridge.js', win);
    assert.equal(win.TextDecoder.prototype.decode, decode);
    assert.equal(win.atob, atob);
    assert.equal(win.history.pushState, push);
    assert.equal(win.history.replaceState, replace);
    assert.equal(win.__cdlPages, undefined);
  });

  await test('extraction retains pages privately, cleans its marker and restores decoders', async () => {
    const win = pageWindow('https://comix.to/title/fixture/1?source=all#cdlx');
    win.TextDecoder = class { decode(value) { return value; } };
    win.atob = value => value;
    const decode = win.TextDecoder.prototype.decode;
    const atob = win.atob;
    runScript('content/extract-bridge.js', win);
    assert.equal(win.location.hash, '');
    assert.equal(win.location.search, '?source=all');
    assert.deepEqual(win.history.state, { existing: true });
    const json = JSON.stringify({ result: { padding: 'x'.repeat(200), pages: {
      baseUrl: 'https://images.test/', items: [{ url: 'one.webp' }, { url: 'two.webp' }]
    } } });
    assert.equal(new win.TextDecoder().decode(json), json);
    assert.equal(win.__cdlPages, undefined);
    assert.equal(win.TextDecoder.prototype.decode, decode);
    assert.equal(win.atob, atob);
    const first = { pages: null };
    win.dispatchEvent(new CustomEvent('cdl:extract-pages', { detail: first }));
    assert.equal(first.pages.length, 2);
    first.pages[0].src = 'https://changed.test/';
    const request = { pages: null };
    win.dispatchEvent(new CustomEvent('cdl:extract-pages', { detail: request }));
    assert.equal(request.pages[0].src, 'https://images.test/one.webp');
    const context = vm.createContext({ window: win, CustomEvent, setTimeout, Date });
    vm.runInContext(extractFunction('extractChapterImagesFromPage') + '\nglobalThis.extract = extractChapterImagesFromPage;', context);
    const pages = await context.extract({});
    assert.deepEqual(JSON.parse(JSON.stringify(pages)), [
      { src: 'https://images.test/one.webp', index: 1 }, { src: 'https://images.test/two.webp', index: 2 }
    ]);
  });

  await test('community sharing defaults off, including imported older settings', () => {
    assert.equal(settings.DEFAULTS['privacy.communitySharing'], false);
    assert.equal(settings.validate({})['privacy.communitySharing'], false);
    assert.ok(settings.SCHEMA['privacy.communitySharing']);
    assert.ok(settings.TABS.some(tab => tab.keys && tab.keys.includes('privacy.communitySharing')));
  });

  await test('all community operations fail closed before any network request', async () => {
    const ctx = communityContext(false);
    for (const result of [
      await ctx.api.badgeRegister('public-user'), await ctx.api.badgeLookup('public-user'),
      await ctx.api.flagSubmit('chapter', 'public-user', 'broken'), await ctx.api.flagLookup(['chapter'])
    ]) assert.equal(result.disabled, true);
    assert.equal(ctx.calls.length, 0);
  });

  await test('opted-in community traffic uses only hashes, without cookies or referrers', async () => {
    const ctx = communityContext(true);
    assert.equal((await ctx.api.badgeRegister('public-user')).ok, true);
    await ctx.api.badgeLookup('another-user');
    await ctx.api.flagSubmit('chapter-one', 'public-user', 'broken');
    await ctx.api.flagLookup(['chapter-two']);
    assert.equal(ctx.calls.length, 4);
    for (const { url, options } of ctx.calls) {
      assert.equal(options.credentials, 'omit');
      assert.equal(options.referrerPolicy, 'no-referrer');
      assert.doesNotMatch(url + (options.body || ''), /public-user|another-user|chapter-one|chapter-two/);
    }
    ctx.state.enabled = false;
    assert.equal((await ctx.api.badgeRegister('public-user')).disabled, true, 'consent also gates previously cached registrations');
    assert.equal(ctx.calls.length, 4);
  });

  await test('Firefox browser data consent is enforced independently of the setting', async () => {
    const ctx = communityContext(true, ['personallyIdentifyingInfo', 'browsingActivity', 'technicalAndInteraction']);
    ctx.state.granted = false;
    assert.equal((await ctx.api.badgeRegister('user')).ok, false);
    assert.equal(ctx.calls.length, 0);
    ctx.state.granted = true;
    assert.equal((await ctx.api.badgeRegister('user')).ok, true);
    assert.equal(ctx.calls.length, 1);
  });

  await test('revoking community sharing aborts pending requests', async () => {
    const ctx = communityContext(true);
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    ctx.state.fetchImpl = (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      started();
    });
    const pending = ctx.api.badgeRegister('user');
    await ready;
    ctx.state.enabled = false;
    ctx.changes.forEach(listener => listener({ cdlCommunitySharing: { newValue: false } }, 'local'));
    assert.equal((await pending).ok, false);
  });

  await test('disabled profile sharing never fetches the signed-in Comix account', async () => {
    const win = pageWindow('https://comix.to/');
    let fetched = 0;
    runScript('content/content_profile.js', win, {
      CDLBadgeCore: require('../core/cdl-badge-core.js'),
      CDLSettings: { getSettings: async () => ({}), onChange() {} },
      fetch: () => { fetched++; throw new Error('unexpected account fetch'); }
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(fetched, 0);
  });

  await test('a stale initial settings read cannot undo revoked sharing consent', async () => {
    const win = pageWindow('https://comix.to/');
    let resolveInitial, changed, fetched = 0;
    runScript('content/content_profile.js', win, {
      CDLBadgeCore: require('../core/cdl-badge-core.js'),
      CDLSettings: {
        getSettings: () => new Promise(resolve => { resolveInitial = resolve; }),
        onChange: callback => { changed = callback; }
      },
      fetch: () => { fetched++; throw new Error('unexpected account fetch'); }
    });
    changed({ 'privacy.communitySharing': false });
    resolveInitial({ 'privacy.communitySharing': true });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(fetched, 0);
  });

  await test('Firefox settings request browser consent in the click gesture and reject denial', async () => {
    for (const granted of [false, true]) {
      const stored = {};
      const requests = [];
      const context = vm.createContext({
        module: { exports: {} }, console,
        chrome: {
          runtime: { getManifest: () => ({ browser_specific_settings: { gecko: { data_collection_permissions: {
            optional: ['personallyIdentifyingInfo', 'authenticationInfo', 'browsingActivity', 'websiteContent', 'technicalAndInteraction']
          } } } }) },
          permissions: { request: (request, callback) => { requests.push(request); callback(granted); } },
          storage: { local: {
            get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, stored[key]])),
            set: async value => Object.assign(stored, value)
          } }
        }
      });
      vm.runInContext(read('core/settings.js'), context);
      const saving = context.module.exports.patchSettings({ 'privacy.communitySharing': true });
      assert.equal(requests.length, 1, 'request happens synchronously, before storage awaits');
      assert.deepEqual(Array.from(requests[0].data_collection), ['personallyIdentifyingInfo', 'browsingActivity', 'technicalAndInteraction']);
      if (granted) {
        await saving;
        assert.equal(stored.cdlSettings['privacy.communitySharing'], true);
        assert.equal(stored.cdlCommunitySharing, true);
      } else {
        await assert.rejects(saving, /permission was not granted/);
        assert.equal(stored.cdlSettings, undefined, 'denied consent never becomes enabled storage state');
        assert.equal(stored.cdlCommunitySharing, undefined);
      }
    }
  });

  await test('cloud sync never exports or overwrites this device\'s community consent', async () => {
    const Plus = require('../core/plus-core.js');
    const stored = { cdlSettings: { 'privacy.communitySharing': true, 'output.format': 'zip' } };
    const chrome = { runtime: {}, storage: { local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, stored[key]])),
      set: async value => Object.assign(stored, value)
    } } };
    const now = '2026-10-22T12:00:00.000Z';
    const captured = await Plus.captureLocal(chrome, ['settings'], 'local-device', now);
    assert.equal(captured.payload.categories.settings.stores.cdlSettings.records['privacy.communitySharing'], undefined);
    const remote = { categories: { settings: { stores: { cdlSettings: { records: {
      'privacy.communitySharing': { value: true, updatedAt: now, deviceId: 'other-device', deleted: false },
      'output.format': { value: 'cbz', updatedAt: now, deviceId: 'other-device', deleted: false }
    } } } } } };
    stored.cdlSettings['privacy.communitySharing'] = false;
    await Plus.applyPayload(chrome, remote, ['settings'], captured.meta);
    assert.equal(stored.cdlSettings['privacy.communitySharing'], false);
    assert.equal(stored.cdlSettings['output.format'], 'cbz', 'ordinary settings still synchronize');
    stored.cdlSettings['privacy.communitySharing'] = true;
    remote.categories.settings.stores.cdlSettings.records['privacy.communitySharing'].value = false;
    await Plus.applyPayload(chrome, remote, ['settings'], captured.meta);
    assert.equal(stored.cdlSettings['privacy.communitySharing'], true);
  });

  await test('stale settings, imports and restore writes cannot change authoritative local consent', async () => {
    const stored = { cdlSettings: { 'privacy.communitySharing': true } };
    const context = vm.createContext({ module: { exports: {} }, chrome: {
      runtime: { getManifest: () => ({}) },
      storage: { local: {
        get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, stored[key]])),
        set: async value => Object.assign(stored, value)
      } }
    } });
    vm.runInContext(read('core/settings.js'), context);
    const S = context.module.exports;
    assert.equal((await S.getSettings())['privacy.communitySharing'], false, 'a copied settings flag does not establish consent');
    await S.patchSettings({ 'privacy.communitySharing': true });
    assert.equal(stored.cdlCommunitySharing, true);
    assert.equal(Object.hasOwn(JSON.parse(await S.exportJSON()).settings, 'privacy.communitySharing'), false);
    await S.importJSON(JSON.stringify({ settings: { 'privacy.communitySharing': false, 'output.format': 'cbz' } }));
    assert.equal((await S.getSettings())['privacy.communitySharing'], true, 'import preserves the current device choice');
    await S.patchSettings({ 'privacy.communitySharing': false });
    stored.cdlSettings = { 'privacy.communitySharing': true, 'output.format': 'zip' };
    assert.equal((await S.getSettings())['privacy.communitySharing'], false, 'a delayed restore cannot undo opt-out');
    await S.importJSON(JSON.stringify({ settings: { 'privacy.communitySharing': true } }));
    assert.equal((await S.getSettings())['privacy.communitySharing'], false, 'an imported flag cannot enable sharing');
  });

  await test('only required media is web-accessible, using session URLs on Chromium', () => {
    const manifest = JSON.parse(read('manifest.json'));
    assert.equal(manifest.externally_connectable, undefined);
    assert.equal(manifest.permissions.includes('webNavigation'), false);
    for (const resource of manifest.web_accessible_resources) {
      assert.equal(resource.use_dynamic_url, true);
      assert.ok(resource.matches.every(pattern => /^\*:\/\/comix\.(to|ws)\/\*$/.test(pattern)));
      assert.ok(resource.resources.every(file => /^assets\/.+\.(gif|mp3|jpg)$/.test(file)));
    }
    assert.match(read('scripts/build-release.ps1'), /Properties\.Remove\('use_dynamic_url'\)/);
    for (const file of ['content/content_title.js', 'content/content_features.js', 'content/content_home.js', 'content/content_profile.js', 'content/content_agenda.js', 'content/cdl-embed-settings.js']) {
      assert.match(read(file), /CDLRoute\.subscribe/, file);
      assert.doesNotMatch(read(file), /(?:addEventListener|dispatchEvent).*cdl:locationchange/, file);
    }
  });

  console.log('\n' + passed + ' privacy boundary tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
