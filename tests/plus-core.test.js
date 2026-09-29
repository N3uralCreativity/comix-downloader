'use strict';

const assert = require('assert');
const Plus = require('../core/plus-core.js');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeChrome(initial, options) {
  options = options || {};
  const store = clone(initial || {});
  const listeners = [];
  const alarms = [];
  function selection(keys) {
    if (keys == null) return clone(store);
    if (typeof keys === 'string') return Object.prototype.hasOwnProperty.call(store, keys) ? { [keys]: clone(store[keys]) } : {};
    if (Array.isArray(keys)) {
      const result = {};
      keys.forEach((key) => { if (Object.prototype.hasOwnProperty.call(store, key)) result[key] = clone(store[key]); });
      return result;
    }
    const result = {};
    Object.keys(keys || {}).forEach((key) => { result[key] = Object.prototype.hasOwnProperty.call(store, key) ? clone(store[key]) : clone(keys[key]); });
    return result;
  }
  const api = {
    runtime: { getManifest: () => clone(options.manifest || {}) },
    permissions: {
      contains: (payload, callback) => {
        const granted = options.permissionGranted === true;
        if (callback) callback(granted);
        return Promise.resolve(granted);
      },
      request: () => { throw new Error('The service worker must not request optional permissions.'); },
    },
    storage: {
      local: {
        get: async (keys) => selection(keys),
        set: async (patch) => {
          const changes = {};
          Object.keys(patch || {}).forEach((key) => {
            changes[key] = { oldValue: clone(store[key]), newValue: clone(patch[key]) };
            store[key] = clone(patch[key]);
          });
          listeners.forEach((listener) => listener(changes, 'local'));
        },
        remove: async (keys) => {
          (Array.isArray(keys) ? keys : [keys]).forEach((key) => { delete store[key]; });
        },
      },
      onChanged: { addListener: (listener) => listeners.push(listener) },
    },
    alarms: {
      create: (name, details) => { alarms.push({ name, details }); },
      clear: async (name) => {
        for (let index = alarms.length - 1; index >= 0; index -= 1) {
          if (alarms[index].name === name) alarms.splice(index, 1);
        }
        return true;
      },
    },
  };
  return { api, store, alarms };
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

(async () => {
  await test('Plus is opt-in and starts with no selected categories', async () => {
    const state = Plus.defaultState();
    assert.equal(state.setupStarted, false);
    assert.deepEqual(state.selectedCategories, []);
    assert.equal(state.account, null);
    assert.equal(state.lastPayloadHash, null);
  });

  await test('recovery codes preserve all 256 bits', async () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
    const code = Plus.encodeRecoveryCode(bytes);
    assert.match(code, /^(?:[A-Z2-9]{4}-)+[A-Z2-9]{1,4}$/);
    assert.deepEqual(Array.from(Plus.decodeRecoveryCode(code)), Array.from(bytes));
  });

  await test('recovery wrapping opens with the right code and rejects a different code', async () => {
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const code = Plus.encodeRecoveryCode(crypto.getRandomValues(new Uint8Array(32)));
    const wrong = Plus.encodeRecoveryCode(crypto.getRandomValues(new Uint8Array(32)));
    const wrapped = await Plus.createRecoveryEnvelope(dek, code);
    const opened = await Plus.openRecoveryEnvelope(wrapped.envelope, code);
    assert.deepEqual(Array.from(opened.dek), Array.from(dek));
    assert.equal(opened.recoveryAuth, wrapped.recoveryAuth);
    await assert.rejects(() => Plus.openRecoveryEnvelope(wrapped.envelope, wrong));
  });

  await test('snapshot encryption authenticates ciphertext before parsing or applying it', async () => {
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const payload = { schemaVersion: 1, generatedAt: '2026-08-17T10:00:00.000Z', deviceId: 'dev_a', categories: { settings: { stores: {} } } };
    const encrypted = await Plus.encryptSnapshot(payload, dek);
    assert.deepEqual(await Plus.decryptSnapshot(encrypted, dek), payload);

    const envelope = JSON.parse(new TextDecoder().decode(encrypted));
    const ciphertext = Plus.__test.fromBase64(envelope.ciphertext);
    ciphertext[0] ^= 1;
    envelope.ciphertext = Plus.__test.toBase64(ciphertext);
    const tampered = new TextEncoder().encode(JSON.stringify(envelope));
    await assert.rejects(() => Plus.decryptSnapshot(tampered, dek), /authentication failed/i);
  });

  await test('approved devices can transfer a key with ECDH without server key access', async () => {
    const sender = await Plus.generateDeviceIdentity();
    const recipient = await Plus.generateDeviceIdentity();
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await Plus.ecdhWrapKey(dek, sender.privateKeyJwk, recipient.publicKeyJwk);
    assert.equal(Object.prototype.hasOwnProperty.call(wrapped.fromPublicKeyJwk, 'd'), false);
    const opened = await Plus.ecdhUnwrapKey(wrapped, recipient.privateKeyJwk);
    assert.deepEqual(Array.from(opened), Array.from(dek));
    await assert.rejects(() => Plus.ecdhUnwrapKey(wrapped, sender.privateKeyJwk));
  });

  await test('merge keeps the newest record and preserves deletion tombstones', async () => {
    const left = {
      schemaVersion: 1, generatedAt: '2026-08-17T10:00:00.000Z', deviceId: 'dev_a',
      categories: { settings: { stores: { cdlSettings: { records: {
        theme: { value: 'light', updatedAt: '2026-08-17T10:00:00.000Z', deviceId: 'dev_a', deleted: false },
        removed: { value: true, updatedAt: '2026-08-17T10:00:00.000Z', deviceId: 'dev_a', deleted: false },
      } } } } },
    };
    const right = {
      schemaVersion: 1, generatedAt: '2026-08-17T11:00:00.000Z', deviceId: 'dev_b',
      categories: { settings: { stores: { cdlSettings: { records: {
        theme: { value: 'dark', updatedAt: '2026-08-17T11:00:00.000Z', deviceId: 'dev_b', deleted: false },
        removed: { updatedAt: '2026-08-17T11:00:00.000Z', deviceId: 'dev_b', deleted: true },
      } } } } },
    };
    const records = Plus.mergePayloads(left, right).categories.settings.stores.cdlSettings.records;
    assert.equal(records.theme.value, 'dark');
    assert.equal(records.removed.deleted, true);
    assert.equal(Object.prototype.hasOwnProperty.call(records.removed, 'value'), false);
  });

  await test('restoring an older category tombstones records created after that backup', async () => {
    const current = {
      schemaVersion: 1, generatedAt: '2026-08-17T12:00:00.000Z', deviceId: 'dev_current',
      categories: { settings: { stores: { cdlSettings: { records: {
        theme: { value: 'light', updatedAt: '2026-08-17T12:00:00.000Z', deviceId: 'dev_current', deleted: false },
        language: { value: 'fr', updatedAt: '2026-08-17T12:00:00.000Z', deviceId: 'dev_current', deleted: false },
      } } } } },
    };
    const backup = {
      schemaVersion: 1, generatedAt: '2026-08-17T10:00:00.000Z', deviceId: 'dev_backup',
      categories: { settings: { stores: { cdlSettings: { records: {
        theme: { value: 'dark', updatedAt: '2026-08-17T10:00:00.000Z', deviceId: 'dev_backup', deleted: false },
      } } } } },
    };
    const restored = Plus.prepareRestorePayload(current, backup, ['settings'], 'dev_restore', '2026-08-17T13:00:00.000Z');
    const records = restored.categories.settings.stores.cdlSettings.records;
    assert.equal(records.theme.value, 'dark');
    assert.equal(records.theme.updatedAt, '2026-08-17T13:00:00.000Z');
    assert.equal(records.language.deleted, true);
    assert.equal(Object.prototype.hasOwnProperty.call(records.language, 'value'), false);

    const merged = Plus.mergePayloads(current, restored);
    assert.equal(merged.categories.settings.stores.cdlSettings.records.language.deleted, true);
  });

  await test('download markers and series presets merge at chapter and field granularity', async () => {
    const initial = {
      cdlManifest: { series: { mangaName: 'Series', chapters: { '1': { label: 'Ch1', ts: 1 } } } },
      cdlSeriesPrefs: { series: { format: 'zip', includeComicInfo: true } },
    };
    const left = makeChrome(initial);
    const right = makeChrome(initial);
    await Plus.captureLocal(left.api, ['settings', 'downloads'], 'dev_a', '2026-08-17T10:00:00.000Z');
    await Plus.captureLocal(right.api, ['settings', 'downloads'], 'dev_b', '2026-08-17T10:00:00.000Z');
    left.store.cdlManifest.series.chapters['2'] = { label: 'Ch2', ts: 2 };
    left.store.cdlSeriesPrefs.series.format = 'cbz';
    right.store.cdlManifest.series.chapters['3'] = { label: 'Ch3', ts: 3 };
    right.store.cdlSeriesPrefs.series.includeComicInfo = false;
    const leftPayload = (await Plus.captureLocal(left.api, ['settings', 'downloads'], 'dev_a', '2026-08-17T11:00:00.000Z')).payload;
    const rightPayload = (await Plus.captureLocal(right.api, ['settings', 'downloads'], 'dev_b', '2026-08-17T12:00:00.000Z')).payload;
    const merged = Plus.mergePayloads(leftPayload, rightPayload);
    const target = makeChrome();
    await Plus.applyPayload(target.api, merged, ['settings', 'downloads'], null);
    assert.deepEqual(Object.keys(target.store.cdlManifest.series.chapters).sort(), ['1', '2', '3']);
    assert.equal(target.store.cdlSeriesPrefs.series.format, 'cbz');
    assert.equal(target.store.cdlSeriesPrefs.series.includeComicInfo, false);
  });

  await test('per-device statistics combine once without overwriting another device', async () => {
    const devices = {
      dev_a: { value: { days: { '2026-08-17': { c: 2, s: 600 } }, series: { a: { c: 2, s: 600, ts: 2, name: 'A' } }, pace: { sum: 500, n: 2 } }, updatedAt: '2026-08-17T10:00:00.000Z' },
      dev_b: { value: { days: { '2026-08-17': { c: 3, s: 900 } }, series: { a: { c: 3, s: 900, ts: 3, name: 'A' } }, pace: { sum: 900, n: 3 } }, updatedAt: '2026-08-17T11:00:00.000Z' },
    };
    const totals = Plus.materializeContributions(devices);
    assert.deepEqual(totals.days['2026-08-17'], { c: 5, s: 1500 });
    assert.equal(totals.series.a.c, 5);
    assert.equal(totals.pace.n, 5);
    assert.equal(totals.pace.avg, 280);
  });

  await test('capture includes only selected allowlisted stores', async () => {
    const chrome = makeChrome({
      cdlSettings: { 'appearance.accentColor': '#8b5cf6' },
      cdlSeriesPrefs: { series: { format: 'cbz' } },
      cdlLibrary: { endpoint: 'https://private.example', username: 'reader', password: 'secret' },
      cdlLogs: [{ message: 'private diagnostic' }],
      cdlManifest: { series: { chapters: { 1: true } } },
    });
    const captured = await Plus.captureLocal(chrome.api, ['settings'], 'dev_test', '2026-08-17T12:00:00.000Z');
    const serialized = JSON.stringify(captured.payload);
    assert.match(serialized, /accentColor/);
    assert.doesNotMatch(serialized, /private\.example|reader|secret|private diagnostic|cdlManifest/);
    assert.deepEqual(Object.keys(captured.payload.categories), ['settings']);
  });

  await test('unchanged local statistics retain their device clock', async () => {
    const chrome = makeChrome({ cdlReadStats: { days: { '2026-08-17': { c: 2, s: 600 } }, series: {}, pace: { avg: 300, n: 2 } } });
    const first = await Plus.captureLocal(chrome.api, ['stats'], 'dev_test', '2026-08-17T12:00:00.000Z');
    const second = await Plus.captureLocal(chrome.api, ['stats'], 'dev_test', '2026-08-17T13:00:00.000Z');
    assert.equal(first.payload.categories.stats.devices.dev_test.updatedAt, '2026-08-17T12:00:00.000Z');
    assert.equal(second.payload.categories.stats.devices.dev_test.updatedAt, '2026-08-17T12:00:00.000Z');
  });

  await test('apply rejects stores outside the category allowlist', async () => {
    const chrome = makeChrome({ cdlLibrary: { password: 'keep-me' } });
    const payload = {
      schemaVersion: 1, categories: { settings: { stores: {
        cdlSettings: { records: { known: { value: 1, updatedAt: '2026-08-17T12:00:00.000Z', deviceId: 'dev_a', deleted: false } } },
        cdlLibrary: { records: { password: { value: 'replace-me', updatedAt: '2026-08-17T12:00:00.000Z', deviceId: 'dev_a', deleted: false } } },
      } } },
    };
    await Plus.applyPayload(chrome.api, payload, ['settings'], null);
    assert.deepEqual(chrome.store.cdlSettings, { known: 1 });
    assert.deepEqual(chrome.store.cdlLibrary, { password: 'keep-me' });
  });

  await test('a free installation initializes without alarms or Plus network calls', async () => {
    const chrome = makeChrome();
    let networkCalls = 0;
    const service = Plus.createService({ chrome: chrome.api, fetch: async () => { networkCalls += 1; throw new Error('unexpected network'); } });
    await service.init();
    const view = await service.handleMessage({ action: 'plusGetState' });
    assert.equal(networkCalls, 0);
    assert.equal(chrome.alarms.length, 0);
    assert.equal(view.signedIn, false);
    assert.deepEqual(view.state.selectedCategories, []);
  });

  await test('manual synchronization clears the pending debounce alarm', async () => {
    const chrome = makeChrome({
      [Plus.STATE_KEY]: {
        ...Plus.defaultState(),
        account: { state: 'active', device: { id: 'dev_local', approved: true } },
        device: { id: 'dev_local', name: 'Browser' },
      },
    });
    const service = Plus.createService({ chrome: chrome.api, fetch: async () => { throw new Error('unexpected network'); } });
    await service.handleMessage({ action: 'plusSetCategories', categories: ['settings'] });
    assert.ok(chrome.alarms.some((alarm) => alarm.name === Plus.FALLBACK_ALARM));
    const result = await service.handleMessage({ action: 'plusSyncNow' });
    assert.equal(result.reason, 'not_configured');
    assert.equal(chrome.alarms.some((alarm) => alarm.name === Plus.FALLBACK_ALARM), false);
  });

  await test('Plus records consent only after the settings page granted its optional permissions', async () => {
    const chrome = makeChrome({}, { permissionGranted: true });
    const service = Plus.createService({ chrome: chrome.api, fetch: async () => { throw new Error('unexpected network'); } });
    const result = await service.handleMessage({ action: 'plusRequestConsent' });
    assert.equal(result.state.setupStarted, true);
    assert.equal(chrome.store[Plus.STATE_KEY].setupStarted, true);

    const denied = makeChrome({}, { permissionGranted: false });
    const deniedService = Plus.createService({ chrome: denied.api, fetch: async () => { throw new Error('unexpected network'); } });
    await assert.rejects(
      () => deniedService.handleMessage({ action: 'plusRequestConsent' }),
      (error) => error && error.code === 'PLUS_PERMISSION_REQUIRED'
    );
    assert.equal(Object.prototype.hasOwnProperty.call(denied.store, Plus.STATE_KEY), false);
  });

  await test('expired accounts restore locally without attempting a cloud write', async () => {
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const cloudPayload = {
      schemaVersion: 1,
      generatedAt: '2026-08-17T12:00:00.000Z',
      deviceId: 'dev_cloud',
      categories: { settings: { stores: { cdlSettings: { records: {
        theme: { value: 'cloud', updatedAt: '2026-08-17T12:00:00.000Z', deviceId: 'dev_cloud', deleted: false },
      } } } } },
    };
    const encrypted = await Plus.encryptSnapshot(cloudPayload, dek);
    const chrome = makeChrome({
      [Plus.STATE_KEY]: {
        ...Plus.defaultState(),
        setupStarted: true,
        account: { state: 'expired', device: { id: 'dev_local', approved: true }, dataDeleteAt: '2026-11-01T00:00:00.000Z' },
        device: { id: 'dev_local', name: 'Browser' },
        selectedCategories: ['settings'],
      },
      [Plus.SECRET_KEY]: { tokens: { accessToken: 'access', refreshToken: 'refresh' }, dek: Plus.__test.toBase64(dek), keyVersion: 1 },
      cdlSettings: { theme: 'local' },
    });
    const calls = [];
    const service = Plus.createService({
      chrome: chrome.api,
      fetch: async (url, init) => {
        calls.push({ url, method: (init && init.method) || 'GET' });
        if (/\/v1\/sync\/snapshots\/snapshot_old\/data$/.test(url)) return new Response(encrypted, { status: 200 });
        throw new Error('Unexpected request: ' + url);
      },
    });
    const result = await service.handleMessage({ action: 'plusRestoreSnapshot', snapshotId: 'snapshot_old', categories: ['settings'] });
    assert.equal(result.readOnly, true);
    assert.equal(chrome.store.cdlSettings.theme, 'cloud');
    assert.deepEqual(calls.map((call) => call.method), ['GET']);
    assert.equal(calls.some((call) => /restore-point/.test(call.url) || call.method === 'PUT'), false);
  });

  console.log(`\nRESULT: ${passed} passed, 0 failed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
