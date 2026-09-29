'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8').replace(/\r\n/g, '\n');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

function extract(name) {
  const marker = source.indexOf(`function ${name}(`);
  assert.ok(marker >= 0, name);
  const start = source.slice(marker - 6, marker) === 'async ' ? marker - 6 : marker;
  const tail = source.slice(start);
  const end = tail.indexOf('\n}\n');
  assert.ok(end >= 0, name);
  return tail.slice(0, end + 2);
}

async function run() {
  for (const file of ['core/plus-ui.js', 'content/content_agenda.js']) {
    const entry = manifest.content_scripts.find(item => item.js.includes(file));
    assert.deepEqual(entry.matches, ['*://comix.to/*', '*://comix.ws/*']);
  }
  // Public releases (three-part versions) request the production service instead.
  assert.ok(manifest.optional_host_permissions.includes(/^\d+\.\d+\.\d+$/.test(manifest.version)
    ? 'https://plus.n3uralcreativity.top/*'
    : 'https://plus.n3uralcreativity.top/*'));
  assert.ok(!manifest.host_permissions.includes('https://*.workers.dev/*'), 'Plus must still require opt-in permission');

  const stored = {};
  const snapshots = [];
  const baselineChecks = [];
  const snapshotRequests = [];
  const coverRequests = [];
  const context = {
    URL, Date, AbortController, setTimeout, clearTimeout,
    chrome: { storage: { local: {
      get: async () => structuredClone(stored),
      set: async patch => Object.assign(stored, structuredClone(patch)),
    } } },
    loadCfg: async () => ({ 'subscribe.enabled': true }),
    setupSubscribeAlarm() {},
    checkOneSubscription: async slug => baselineChecks.push(slug),
    recordAgendaTitleSnapshot: async (...args) => snapshots.push(args),
    fetchSeriesChapterSnapshotViaTab: async (slug, options) => {
      snapshotRequests.push({ slug, options });
      return { paths: ['/title/example/1-chapter-1'] };
    },
    fetch: async url => {
      coverRequests.push(url);
      return { ok: true, text: async () => '<meta property="og:image" content="https://cdn.example/cover.webp">' };
    },
    extractAgendaCoverFromHtml: () => 'https://cdn.example/cover.webp',
  };
  vm.createContext(context);
  const names = ['supportedComixOrigin', 'preferredComixOrigin', 'normalizeAgendaCoverUrl',
    'subscribeSeries', 'fetchSeriesChapterPathsViaTab', 'fetchSeriesCoverDirect', 'detectCloudflareChallengeDocument'];
  vm.runInContext(`
    const CDL_COMIX_ORIGINS = ['https://comix.to', 'https://comix.ws'];
    const CDL_DEFAULT_COMIX_ORIGIN = CDL_COMIX_ORIGINS[0];
    ${names.map(extract).join('\n')}
    globalThis.api = { ${names.join(',')} };
  `, context);

  const api = context.api;
  const snapshot = { rows: [{ chapterLabel: 'Chapter 1', createdAtFormatted: '3d ago' }] };
  await api.subscribeSeries('example', 'Example', 'https://comix.ws/title/example', 'https://cdn.example/cover.webp', snapshot);
  assert.equal(stored.cdlSubscriptions.example.sourceOrigin, 'https://comix.ws');
  assert.equal(stored.cdlSubscriptions.example.coverUrl, 'https://cdn.example/cover.webp');
  assert.equal(snapshots[0][2], snapshot, 'Subscribing must retain the initial Agenda history');
  assert.deepEqual(baselineChecks, ['example']);

  stored.cdlSubscriptions.example.lastSeen = ['1'];
  await api.subscribeSeries('example', 'Renamed', 'https://untrusted.example/', 'javascript:alert(1)', snapshot);
  assert.equal(stored.cdlSubscriptions.example.sourceOrigin, 'https://comix.ws');
  assert.equal(stored.cdlSubscriptions.example.coverUrl, 'https://cdn.example/cover.webp');
  assert.deepEqual(stored.cdlSubscriptions.example.lastSeen, ['1']);
  assert.deepEqual(baselineChecks, ['example'], 'Existing subscriptions must not reset their baseline');
  await api.subscribeSeries('primary', 'Primary', '', '', null);
  assert.equal(stored.cdlSubscriptions.primary.sourceOrigin, 'https://comix.to');

  assert.deepEqual(Array.from(await api.fetchSeriesChapterPathsViaTab('example', 'https://comix.ws')), ['/title/example/1-chapter-1']);
  assert.equal(snapshotRequests[0].options.sourceOrigin, 'https://comix.ws');
  assert.equal(snapshotRequests[0].options.maxPages, 1, 'The fast subscription scan must not request deep Agenda pagination');
  await api.fetchSeriesCoverDirect('example', 'https://comix.ws');
  await api.fetchSeriesCoverDirect('primary');
  assert.deepEqual(coverRequests, ['https://comix.ws/title/example', 'https://comix.to/title/primary']);

  // HTTP detection runs in the worker with no document; Agenda detection runs in a title tab.
  assert.equal(api.detectCloudflareChallengeDocument({ text: 'Cloudflare Error 1006: Access denied' }).blockKind, 'ip_ban');
  context.document = {
    title: 'Example', body: { innerText: 'Chapter 1' },
    querySelector: selector => selector.includes('.mchap-list') ? {} : null,
  };
  context.window = { _cf_chl_opt: {} };
  const title = api.detectCloudflareChallengeDocument();
  assert.equal(title.titleReady, true);
  assert.equal(title.challenged, false, 'A loaded Agenda title must not be mistaken for a stale challenge');
  assert.equal(api.detectCloudflareChallengeDocument({ challengeHeader: true }).challenged, true,
    'A DOM from a previous check must not suppress HTTP challenge detection');

  console.log('private-sync-regression.test.js: all tests passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
