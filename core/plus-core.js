/**
 * Comix Downloader Plus client core.
 * Plain-script module shared by Chromium's service worker, Firefox background
 * scripts, unit tests, and both settings surfaces.
 */
(function (global, factory) {
  'use strict';
  var api = factory(global);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CDLPlus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (global) {
  'use strict';

  // Public releases carry three-part versions (4.3.0) and use the production service;
  // private test builds carry four parts (4.2.36.1) and use the testing service.
  var API_ORIGINS = {
    production: 'https://plus.n3uralcreativity.top',
    testing: 'https://plus.n3uralcreativity.top',
  };
  function releaseChannel(version) {
    return /^\d+\.\d+\.\d+$/.test(String(version || '')) ? 'production' : 'testing';
  }
  function manifestVersion() {
    try {
      var runtime = global.chrome && global.chrome.runtime;
      return runtime && typeof runtime.getManifest === 'function' ? runtime.getManifest().version : '';
    } catch (_) { return ''; }
  }
  var CHANNEL = releaseChannel(manifestVersion());
  var API_ORIGIN = API_ORIGINS[CHANNEL];
  var API_PERMISSION = API_ORIGIN + '/*';
  var SNAPSHOT_SCHEMA = 1;
  var STATE_KEY = 'cdlPlusState';
  var SECRET_KEY = 'cdlPlusSecrets';
  var DEVICE_KEY = 'cdlPlusDeviceIdentities';
  var META_KEY = 'cdlPlusSyncMeta';
  var SYNC_ALARM = 'cdl-plus-sync-15m';
  var FALLBACK_ALARM = 'cdl-plus-sync-pending';
  var DATA_PERMISSIONS = ['personallyIdentifyingInfo', 'authenticationInfo', 'browsingActivity', 'websiteContent', 'technicalAndInteraction'];
  var encoder = new TextEncoder();
  var decoder = new TextDecoder();

  var CATEGORIES = [
    { id: 'settings', label: 'Settings and presets', description: 'Extension settings and per-series presets.' },
    { id: 'subscriptions', label: 'Watched series', description: 'Series watched for new chapters.' },
    { id: 'progress', label: 'Reading progress', description: 'Resume chapters and reader positions.' },
    { id: 'downloads', label: 'Downloaded chapters', description: 'Downloaded-chapter markers only, never files.' },
    { id: 'stats', label: 'Reading statistics', description: 'Per-device reading totals combined locally.' },
  ];
  var CATEGORY_IDS = CATEGORIES.map(function (item) { return item.id; });
  var STORE_SPECS = {
    settings: ['cdlSettings', 'cdlSeriesPrefs'],
    subscriptions: ['cdlSubscriptions'],
    progress: ['cdlLastRead', 'cdlReaderScroll'],
    downloads: ['cdlManifest'],
  };
  var STORE_CATEGORY = {};
  Object.keys(STORE_SPECS).forEach(function (category) {
    STORE_SPECS[category].forEach(function (key) { STORE_CATEGORY[key] = category; });
  });
  var IGNORED_STORAGE_KEYS = new Set([
    STATE_KEY, SECRET_KEY, DEVICE_KEY, META_KEY, 'cdlLogs', 'cdlLibrary', 'cdlDownloadAllSession',
    'cdlNotices', 'cdlReviewPrompt', 'cdlOpenExtSettings', 'cdlOpenExtSettingsView', 'cdlSettingsNavigationAttempt',
  ]);

  function defaultState() {
    return {
      version: 1,
      setupStarted: false,
      account: null,
      device: null,
      selectedCategories: [],
      autoSync: true,
      lastRevision: 0,
      lastPayloadHash: null,
      lastSyncAt: null,
      pendingSyncAt: null,
      lastError: null,
    };
  }
  function cleanState(value) {
    var state = Object.assign(defaultState(), value && typeof value === 'object' ? value : {});
    state.selectedCategories = Array.from(new Set((Array.isArray(state.selectedCategories) ? state.selectedCategories : [])
      .filter(function (id) { return CATEGORY_IDS.indexOf(id) !== -1; })));
    state.autoSync = state.autoSync !== false;
    return state;
  }
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function nowIso(now) { return new Date(now == null ? Date.now() : now).toISOString(); }
  function randomBytes(size) { var out = new Uint8Array(size); global.crypto.getRandomValues(out); return out; }
  function randomDeviceId() {
    var bytes = randomBytes(18);
    return 'dev_' + toBase64Url(bytes);
  }
  function toBase64(bytes) {
    var raw = '';
    var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (var i = 0; i < view.length; i += 1) raw += String.fromCharCode(view[i]);
    return btoa(raw);
  }
  function fromBase64(value) {
    var raw = atob(String(value || ''));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }
  function toBase64Url(bytes) { return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + stableStringify(value[key]);
    }).join(',') + '}';
  }
  async function sha256Hex(value) {
    var input = typeof value === 'string' ? encoder.encode(value) : value;
    var digest = await global.crypto.subtle.digest('SHA-256', input);
    return Array.from(new Uint8Array(digest), function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
  }

  var RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function encodeRecoveryCode(bytes) {
    var bits = 0, value = 0, output = '';
    for (var i = 0; i < bytes.length; i += 1) {
      value = (value << 8) | bytes[i]; bits += 8;
      while (bits >= 5) { output += RECOVERY_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) output += RECOVERY_ALPHABET[(value << (5 - bits)) & 31];
    return output.match(/.{1,4}/g).join('-');
  }
  function decodeRecoveryCode(code) {
    var clean = String(code || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
    if (clean.length < 40) throw new Error('Recovery code is incomplete.');
    var bits = 0, value = 0, output = [];
    for (var i = 0; i < clean.length; i += 1) {
      var index = RECOVERY_ALPHABET.indexOf(clean[i]);
      if (index < 0) throw new Error('Recovery code contains an invalid character.');
      value = (value << 5) | index; bits += 5;
      if (bits >= 8) { output.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return new Uint8Array(output.slice(0, 32));
  }
  async function importAesKey(bytes, usages) {
    return global.crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, usages);
  }
  async function deriveRecoveryMaterial(code, salt, iterations) {
    var rawCode = typeof code === 'string' ? decodeRecoveryCode(code) : code;
    var material = await global.crypto.subtle.importKey('raw', rawCode, 'PBKDF2', false, ['deriveBits']);
    var bits = await global.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iterations }, material, 512);
    var bytes = new Uint8Array(bits);
    return { wrapKey: bytes.slice(0, 32), recoveryAuth: toBase64Url(bytes.slice(32, 64)) };
  }
  async function createRecoveryEnvelope(dek, recoveryCode) {
    var salt = randomBytes(16), iv = randomBytes(12), iterations = 250000;
    var derived = await deriveRecoveryMaterial(recoveryCode, salt, iterations);
    var key = await importAesKey(derived.wrapKey, ['encrypt']);
    var encrypted = await global.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: encoder.encode('cdl-plus-recovery-v1') }, key, dek);
    return {
      envelope: { v: 1, kdf: 'PBKDF2-SHA256', iterations: iterations, salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(encrypted)) },
      recoveryAuth: derived.recoveryAuth,
    };
  }
  async function openRecoveryEnvelope(envelope, recoveryCode) {
    if (!envelope || envelope.v !== 1 || envelope.kdf !== 'PBKDF2-SHA256') throw new Error('Unsupported recovery-key format.');
    var derived = await deriveRecoveryMaterial(recoveryCode, fromBase64(envelope.salt), Number(envelope.iterations));
    var key = await importAesKey(derived.wrapKey, ['decrypt']);
    var plain = await global.crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: encoder.encode('cdl-plus-recovery-v1') }, key, fromBase64(envelope.ciphertext));
    return { dek: new Uint8Array(plain), recoveryAuth: derived.recoveryAuth };
  }
  async function encryptSnapshot(payload, dek) {
    var iv = randomBytes(12);
    var key = await importAesKey(dek, ['encrypt']);
    var plain = encoder.encode(JSON.stringify(payload));
    var encrypted = await global.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: encoder.encode('cdl-plus-snapshot-v1') }, key, plain);
    return encoder.encode(JSON.stringify({ v: 1, alg: 'AES-256-GCM', iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(encrypted)) }));
  }
  async function decryptSnapshot(bytes, dek) {
    var envelope;
    try { envelope = JSON.parse(decoder.decode(bytes)); }
    catch (_) { throw new Error('Encrypted backup envelope is invalid.'); }
    if (!envelope || envelope.v !== 1 || envelope.alg !== 'AES-256-GCM') throw new Error('Encrypted backup format is not supported.');
    var key = await importAesKey(dek, ['decrypt']);
    var plain;
    try {
      plain = await global.crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: encoder.encode('cdl-plus-snapshot-v1') }, key, fromBase64(envelope.ciphertext));
    } catch (_) { throw new Error('Encrypted backup authentication failed. Local data was not changed.'); }
    var payload = JSON.parse(decoder.decode(plain));
    if (!payload || payload.schemaVersion !== SNAPSHOT_SCHEMA) throw new Error('This backup requires a newer extension version.');
    return payload;
  }

  // A readable name for the account's device list, such as "Chrome on Windows".
  function describeBrowser(nav) {
    nav = nav || global.navigator || {};
    var ua = String(nav.userAgent || '');
    var brand = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Vivaldi/.test(ua) ? 'Vivaldi'
      : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    var os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
      : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? brand + ' on ' + os : brand;
  }

  async function generateDeviceIdentity() {
    var pair = await global.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    return {
      id: randomDeviceId(),
      publicKeyJwk: await global.crypto.subtle.exportKey('jwk', pair.publicKey),
      privateKeyJwk: await global.crypto.subtle.exportKey('jwk', pair.privateKey),
      createdAt: nowIso(),
    };
  }
  async function ecdhWrapKey(dek, senderPrivateJwk, recipientPublicJwk) {
    var privateKey = await global.crypto.subtle.importKey('jwk', senderPrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    var publicKey = await global.crypto.subtle.importKey('jwk', recipientPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    var shared = await global.crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
    var digest = await global.crypto.subtle.digest('SHA-256', new Uint8Array(shared));
    var key = await importAesKey(new Uint8Array(digest), ['encrypt']);
    var iv = randomBytes(12);
    var ciphertext = await global.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: encoder.encode('cdl-plus-device-v1') }, key, dek);
    var senderPublic = clone(senderPrivateJwk);
    delete senderPublic.d;
    senderPublic.key_ops = [];
    return { v: 1, fromPublicKeyJwk: senderPublic, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
  }
  async function ecdhUnwrapKey(envelope, recipientPrivateJwk) {
    if (!envelope || envelope.v !== 1) throw new Error('Unsupported device-key format.');
    var privateKey = await global.crypto.subtle.importKey('jwk', recipientPrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    var publicKey = await global.crypto.subtle.importKey('jwk', envelope.fromPublicKeyJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    var shared = await global.crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
    var digest = await global.crypto.subtle.digest('SHA-256', new Uint8Array(shared));
    var key = await importAesKey(new Uint8Array(digest), ['decrypt']);
    var plain = await global.crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: encoder.encode('cdl-plus-device-v1') }, key, fromBase64(envelope.ciphertext));
    return new Uint8Array(plain);
  }

  function recordWins(left, right) {
    if (!left) return right;
    if (!right) return left;
    var leftTs = String(left.updatedAt || '');
    var rightTs = String(right.updatedAt || '');
    if (rightTs > leftTs) return right;
    if (leftTs > rightTs) return left;
    return String(right.deviceId || '') > String(left.deviceId || '') ? right : left;
  }
  function mergeRecordMaps(left, right) {
    var out = {};
    var keys = new Set(Object.keys(left || {}).concat(Object.keys(right || {})));
    keys.forEach(function (key) { out[key] = clone(recordWins(left && left[key], right && right[key])); });
    return out;
  }
  function mergePayloads(left, right) {
    var output = {
      schemaVersion: SNAPSHOT_SCHEMA,
      generatedAt: [left && left.generatedAt, right && right.generatedAt].filter(Boolean).sort().pop() || nowIso(),
      deviceId: right && right.deviceId || left && left.deviceId || '',
      categories: {},
    };
    var categories = new Set(Object.keys(left && left.categories || {}).concat(Object.keys(right && right.categories || {})));
    categories.forEach(function (category) {
      if (category === 'stats') {
        var leftDevices = left && left.categories && left.categories.stats && left.categories.stats.devices || {};
        var rightDevices = right && right.categories && right.categories.stats && right.categories.stats.devices || {};
        output.categories.stats = { devices: mergeRecordMaps(leftDevices, rightDevices) };
        return;
      }
      var stores = {};
      var leftStores = left && left.categories && left.categories[category] && left.categories[category].stores || {};
      var rightStores = right && right.categories && right.categories[category] && right.categories[category].stores || {};
      new Set(Object.keys(leftStores).concat(Object.keys(rightStores))).forEach(function (storeKey) {
        stores[storeKey] = { records: mergeRecordMaps(leftStores[storeKey] && leftStores[storeKey].records, rightStores[storeKey] && rightStores[storeKey].records) };
      });
      output.categories[category] = { stores: stores };
    });
    return output;
  }

  function numeric(value) { var n = Number(value); return Number.isFinite(n) ? n : 0; }
  function statsToContribution(stats) {
    var source = stats && typeof stats === 'object' ? stats : {};
    var out = { days: {}, series: {}, pace: { sum: 0, n: 0 } };
    Object.keys(source.days || {}).forEach(function (key) {
      out.days[key] = { c: numeric(source.days[key].c), s: numeric(source.days[key].s) };
    });
    Object.keys(source.series || {}).forEach(function (key) {
      var item = source.series[key] || {};
      out.series[key] = { c: numeric(item.c), s: numeric(item.s), ts: numeric(item.ts), name: String(item.name || key) };
    });
    var count = numeric(source.pace && source.pace.n);
    out.pace = { sum: numeric(source.pace && source.pace.avg) * count, n: count };
    return out;
  }
  function diffStats(current, baseline) {
    var cur = statsToContribution(current), base = statsToContribution(baseline), out = { days: {}, series: {}, pace: { sum: 0, n: 0 } };
    new Set(Object.keys(cur.days).concat(Object.keys(base.days))).forEach(function (key) {
      var c = cur.days[key] || {}, b = base.days[key] || {};
      var chapters = Math.max(0, numeric(c.c) - numeric(b.c)), seconds = Math.max(0, numeric(c.s) - numeric(b.s));
      if (chapters || seconds) out.days[key] = { c: chapters, s: seconds };
    });
    new Set(Object.keys(cur.series).concat(Object.keys(base.series))).forEach(function (key) {
      var c = cur.series[key] || {}, b = base.series[key] || {};
      var chapters = Math.max(0, numeric(c.c) - numeric(b.c)), seconds = Math.max(0, numeric(c.s) - numeric(b.s));
      if (chapters || seconds) out.series[key] = { c: chapters, s: seconds, ts: numeric(c.ts), name: c.name || b.name || key };
    });
    out.pace.n = Math.max(0, cur.pace.n - base.pace.n);
    out.pace.sum = Math.max(0, cur.pace.sum - base.pace.sum);
    return out;
  }
  function addContributions(left, right) {
    var out = { days: {}, series: {}, pace: { sum: 0, n: 0 } };
    [left || {}, right || {}].forEach(function (source) {
      Object.keys(source.days || {}).forEach(function (key) {
        var target = out.days[key] || (out.days[key] = { c: 0, s: 0 });
        target.c += numeric(source.days[key].c); target.s += numeric(source.days[key].s);
      });
      Object.keys(source.series || {}).forEach(function (key) {
        var item = source.series[key] || {};
        var target = out.series[key] || (out.series[key] = { c: 0, s: 0, ts: 0, name: item.name || key });
        target.c += numeric(item.c); target.s += numeric(item.s);
        if (numeric(item.ts) >= target.ts) { target.ts = numeric(item.ts); target.name = item.name || target.name; }
      });
      out.pace.sum += numeric(source.pace && source.pace.sum);
      out.pace.n += numeric(source.pace && source.pace.n);
    });
    return out;
  }
  function materializeContributions(devices) {
    var combined = { days: {}, series: {}, pace: { sum: 0, n: 0 } };
    Object.keys(devices || {}).forEach(function (deviceId) {
      var record = devices[deviceId];
      if (record && !record.deleted) combined = addContributions(combined, record.value);
    });
    return {
      days: combined.days,
      series: combined.series,
      pace: { avg: combined.pace.n ? combined.pace.sum / combined.pace.n : 0, n: combined.pace.n },
    };
  }

  function storageArea(chromeApi) { return chromeApi && chromeApi.storage && chromeApi.storage.local; }
  function storageGet(chromeApi, keys) {
    var area = storageArea(chromeApi); if (!area) return Promise.resolve({});
    try { var result = area.get(keys); if (result && typeof result.then === 'function') return result; } catch (_) {}
    return new Promise(function (resolve, reject) {
      try { area.get(keys, function (value) { var error = chromeApi.runtime && chromeApi.runtime.lastError; if (error) reject(error); else resolve(value || {}); }); }
      catch (error) { reject(error); }
    });
  }
  function storageSet(chromeApi, value) {
    var area = storageArea(chromeApi); if (!area) return Promise.resolve();
    try { var result = area.set(value); if (result && typeof result.then === 'function') return result; } catch (_) {}
    return new Promise(function (resolve, reject) {
      try { area.set(value, function () { var error = chromeApi.runtime && chromeApi.runtime.lastError; if (error) reject(error); else resolve(); }); }
      catch (error) { reject(error); }
    });
  }
  function storageRemove(chromeApi, keys) {
    var area = storageArea(chromeApi); if (!area) return Promise.resolve();
    try { var result = area.remove(keys); if (result && typeof result.then === 'function') return result; } catch (_) {}
    return new Promise(function (resolve, reject) {
      try { area.remove(keys, function () { var error = chromeApi.runtime && chromeApi.runtime.lastError; if (error) reject(error); else resolve(); }); }
      catch (error) { reject(error); }
    });
  }

  function nestedRecordKey(parts) { return JSON.stringify(parts); }
  function parseNestedRecordKey(value) {
    try {
      var parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch (_) { return null; }
  }
  function flattenStore(storeKey, value) {
    var source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    if (storeKey === 'cdlSeriesPrefs') {
      var presetRecords = {};
      Object.keys(source).forEach(function (slug) {
        var preset = source[slug] && typeof source[slug] === 'object' && !Array.isArray(source[slug]) ? source[slug] : {};
        Object.keys(preset).forEach(function (field) { presetRecords[nestedRecordKey(['preset', slug, field])] = clone(preset[field]); });
      });
      return presetRecords;
    }
    if (storeKey === 'cdlManifest') {
      var manifestRecords = {};
      Object.keys(source).forEach(function (slug) {
        var entry = source[slug] && typeof source[slug] === 'object' && !Array.isArray(source[slug]) ? source[slug] : {};
        var metadata = {};
        Object.keys(entry).forEach(function (field) { if (field !== 'chapters') metadata[field] = clone(entry[field]); });
        manifestRecords[nestedRecordKey(['manifest', slug, 'metadata'])] = metadata;
        var chapters = entry.chapters && typeof entry.chapters === 'object' && !Array.isArray(entry.chapters) ? entry.chapters : {};
        Object.keys(chapters).forEach(function (chapterKey) {
          manifestRecords[nestedRecordKey(['manifest', slug, 'chapter', chapterKey])] = clone(chapters[chapterKey]);
        });
      });
      return manifestRecords;
    }
    return clone(source);
  }
  function inflateStore(storeKey, records) {
    if (storeKey !== 'cdlSeriesPrefs' && storeKey !== 'cdlManifest') return clone(records || {});
    var output = {};
    Object.keys(records || {}).forEach(function (recordKey) {
      var parts = parseNestedRecordKey(recordKey);
      if (!parts || parts.length < 3) return;
      if (storeKey === 'cdlSeriesPrefs' && parts[0] === 'preset' && parts.length === 3) {
        var presetSlug = String(parts[1]);
        var field = String(parts[2]);
        if (!output[presetSlug]) output[presetSlug] = {};
        output[presetSlug][field] = clone(records[recordKey]);
        return;
      }
      if (storeKey !== 'cdlManifest' || parts[0] !== 'manifest') return;
      var slug = String(parts[1]);
      if (!output[slug]) output[slug] = { chapters: {} };
      if (parts[2] === 'metadata' && parts.length === 3) {
        var metadata = records[recordKey] && typeof records[recordKey] === 'object' && !Array.isArray(records[recordKey]) ? records[recordKey] : {};
        Object.keys(metadata).forEach(function (key) { if (key !== 'chapters') output[slug][key] = clone(metadata[key]); });
      } else if (parts[2] === 'chapter' && parts.length === 4) {
        output[slug].chapters[String(parts[3])] = clone(records[recordKey]);
      }
    });
    return output;
  }

  async function captureLocal(chromeApi, selected, deviceId, now) {
    var keys = [META_KEY, 'cdlReadStats'];
    selected.forEach(function (category) { (STORE_SPECS[category] || []).forEach(function (key) { keys.push(key); }); });
    var stored = await storageGet(chromeApi, keys);
    var meta = stored[META_KEY] && typeof stored[META_KEY] === 'object' ? clone(stored[META_KEY]) : { version: 1, stores: {}, stats: {} };
    meta.stores = meta.stores || {}; meta.stats = meta.stats || {};
    var payload = { schemaVersion: SNAPSHOT_SCHEMA, generatedAt: now, deviceId: deviceId, categories: {} };

    selected.forEach(function (category) {
      if (category === 'stats') return;
      var categoryPayload = { stores: {} };
      (STORE_SPECS[category] || []).forEach(function (storeKey) {
        var current = flattenStore(storeKey, stored[storeKey]);
        var storeMeta = meta.stores[storeKey] || { shadow: {}, clocks: {} };
        storeMeta.shadow = storeMeta.shadow || {}; storeMeta.clocks = storeMeta.clocks || {};
        var records = {};
        new Set(Object.keys(current).concat(Object.keys(storeMeta.shadow), Object.keys(storeMeta.clocks))).forEach(function (recordKey) {
          var exists = Object.prototype.hasOwnProperty.call(current, recordKey);
          var existed = Object.prototype.hasOwnProperty.call(storeMeta.shadow, recordKey);
          var changed = exists !== existed || (exists && stableStringify(current[recordKey]) !== stableStringify(storeMeta.shadow[recordKey]));
          var clock = storeMeta.clocks[recordKey];
          if (changed || !clock) clock = { updatedAt: now, deviceId: deviceId, deleted: !exists };
          else if (!exists) clock.deleted = true;
          storeMeta.clocks[recordKey] = clock;
          records[recordKey] = { updatedAt: clock.updatedAt, deviceId: clock.deviceId, deleted: !!clock.deleted };
          if (exists) { records[recordKey].value = clone(current[recordKey]); records[recordKey].deleted = false; }
        });
        storeMeta.shadow = current;
        meta.stores[storeKey] = storeMeta;
        categoryPayload.stores[storeKey] = { records: records };
      });
      payload.categories[category] = categoryPayload;
    });

    if (selected.indexOf('stats') !== -1) {
      var currentStats = stored.cdlReadStats && typeof stored.cdlReadStats === 'object' ? clone(stored.cdlReadStats) : { days: {}, series: {}, pace: { avg: 0, n: 0 } };
      var localContribution = meta.stats.localContribution;
      if (!localContribution) localContribution = statsToContribution(currentStats);
      else localContribution = addContributions(localContribution, diffStats(currentStats, meta.stats.lastMaterialized || {}));
      meta.stats.localContribution = localContribution;
      meta.stats.lastMaterialized = currentStats;
      meta.stats.devices = meta.stats.devices || {};
      var previousContribution = meta.stats.devices[deviceId];
      if (!previousContribution || previousContribution.deleted
        || stableStringify(previousContribution.value) !== stableStringify(localContribution)) {
        meta.stats.devices[deviceId] = { value: localContribution, updatedAt: now, deviceId: deviceId, deleted: false };
      }
      payload.categories.stats = { devices: clone(meta.stats.devices) };
    }
    var update = {}; update[META_KEY] = meta; await storageSet(chromeApi, update);
    return { payload: payload, meta: meta };
  }

  async function applyPayload(chromeApi, payload, selected, meta) {
    var nextMeta = meta && typeof meta === 'object' ? clone(meta) : { version: 1, stores: {}, stats: {} };
    nextMeta.stores = nextMeta.stores || {}; nextMeta.stats = nextMeta.stats || {};
    var patch = {};
    selected.forEach(function (category) {
      if (category === 'stats') return;
      var categoryPayload = payload.categories && payload.categories[category];
      if (!categoryPayload) return;
      Object.keys(categoryPayload.stores || {}).forEach(function (storeKey) {
        if ((STORE_SPECS[category] || []).indexOf(storeKey) === -1) return;
        var records = categoryPayload.stores[storeKey].records || {};
        var flatValue = {}, clocks = {};
        Object.keys(records).forEach(function (recordKey) {
          var record = records[recordKey];
          clocks[recordKey] = { updatedAt: record.updatedAt, deviceId: record.deviceId, deleted: !!record.deleted };
          if (!record.deleted) flatValue[recordKey] = clone(record.value);
        });
        patch[storeKey] = inflateStore(storeKey, flatValue);
        nextMeta.stores[storeKey] = { shadow: clone(flatValue), clocks: clocks };
      });
    });
    if (selected.indexOf('stats') !== -1 && payload.categories && payload.categories.stats) {
      var devices = payload.categories.stats.devices || {};
      var materialized = materializeContributions(devices);
      patch.cdlReadStats = materialized;
      nextMeta.stats.devices = clone(devices);
      nextMeta.stats.lastMaterialized = clone(materialized);
    }
    patch[META_KEY] = nextMeta;
    await storageSet(chromeApi, patch);
    return nextMeta;
  }

  function retimestampCategories(payload, categories, deviceId, timestamp) {
    var copy = clone(payload);
    categories.forEach(function (category) {
      var data = copy.categories && copy.categories[category]; if (!data) return;
      if (category === 'stats') {
        Object.keys(data.devices || {}).forEach(function (key) { data.devices[key].updatedAt = timestamp; data.devices[key].deviceId = deviceId; });
        return;
      }
      Object.keys(data.stores || {}).forEach(function (storeKey) {
        Object.keys(data.stores[storeKey].records || {}).forEach(function (recordKey) {
          data.stores[storeKey].records[recordKey].updatedAt = timestamp;
          data.stores[storeKey].records[recordKey].deviceId = deviceId;
        });
      });
    });
    copy.generatedAt = timestamp; copy.deviceId = deviceId;
    return copy;
  }

  function prepareRestorePayload(currentPayload, backupPayload, categories, deviceId, timestamp) {
    var restored = clone(currentPayload || { schemaVersion: SNAPSHOT_SCHEMA, categories: {} });
    restored.schemaVersion = SNAPSHOT_SCHEMA;
    restored.categories = restored.categories || {};
    (categories || []).forEach(function (category) {
      var current = currentPayload && currentPayload.categories && currentPayload.categories[category] || {};
      var backup = backupPayload && backupPayload.categories && backupPayload.categories[category] || {};
      if (category === 'stats') {
        var currentDevices = current.devices || {};
        var backupDevices = backup.devices || {};
        var devices = {};
        new Set(Object.keys(currentDevices).concat(Object.keys(backupDevices))).forEach(function (key) {
          if (Object.prototype.hasOwnProperty.call(backupDevices, key)) {
            devices[key] = clone(backupDevices[key]);
            devices[key].updatedAt = timestamp;
            devices[key].deviceId = deviceId;
          } else {
            devices[key] = { updatedAt: timestamp, deviceId: deviceId, deleted: true };
          }
        });
        restored.categories.stats = { devices: devices };
        return;
      }
      var stores = {};
      (STORE_SPECS[category] || []).forEach(function (storeKey) {
        var currentRecords = current.stores && current.stores[storeKey] && current.stores[storeKey].records || {};
        var backupRecords = backup.stores && backup.stores[storeKey] && backup.stores[storeKey].records || {};
        var records = {};
        new Set(Object.keys(currentRecords).concat(Object.keys(backupRecords))).forEach(function (recordKey) {
          if (Object.prototype.hasOwnProperty.call(backupRecords, recordKey)) {
            records[recordKey] = clone(backupRecords[recordKey]);
            records[recordKey].updatedAt = timestamp;
            records[recordKey].deviceId = deviceId;
          } else {
            records[recordKey] = { updatedAt: timestamp, deviceId: deviceId, deleted: true };
          }
        });
        stores[storeKey] = { records: records };
      });
      restored.categories[category] = { stores: stores };
    });
    restored.generatedAt = timestamp;
    restored.deviceId = deviceId;
    return restored;
  }

  function PlusApiError(code, message, requestId, status, details) {
    this.name = 'PlusApiError'; this.code = code || 'PLUS_REQUEST_FAILED'; this.message = message || 'The Plus request failed.';
    this.requestId = requestId || null; this.status = status || 0; this.details = details;
    if (Error.captureStackTrace) Error.captureStackTrace(this, PlusApiError);
  }
  PlusApiError.prototype = Object.create(Error.prototype);
  PlusApiError.prototype.constructor = PlusApiError;

  function createService(options) {
    options = options || {};
    var chromeApi = options.chrome || global.chrome;
    var fetchImpl = options.fetch || global.fetch.bind(global);
    var apiOrigin = String(options.apiOrigin || API_ORIGIN).replace(/\/$/, '');
    var initialized = false, syncPromise = null, debounceTimer = null, applyingRemote = false, refreshingTokens = null;

    async function getState() { var stored = await storageGet(chromeApi, STATE_KEY); return cleanState(stored[STATE_KEY]); }
    async function setState(patch) {
      var state = Object.assign(await getState(), patch || {}); state = cleanState(state);
      var update = {}; update[STATE_KEY] = state; await storageSet(chromeApi, update); return state;
    }
    async function getSecrets() { var stored = await storageGet(chromeApi, SECRET_KEY); return stored[SECRET_KEY] && typeof stored[SECRET_KEY] === 'object' ? stored[SECRET_KEY] : {}; }
    async function setSecrets(value) { var update = {}; update[SECRET_KEY] = value; await storageSet(chromeApi, update); return value; }
    async function getIdentity(email) {
      var hash = await sha256Hex(String(email || '').trim().toLowerCase());
      var stored = await storageGet(chromeApi, DEVICE_KEY), identities = stored[DEVICE_KEY] || {};
      if (!identities[hash]) { identities[hash] = await generateDeviceIdentity(); var update = {}; update[DEVICE_KEY] = identities; await storageSet(chromeApi, update); }
      return identities[hash];
    }
    async function publicView() {
      var state = await getState(), secrets = await getSecrets();
      return {
        state: state,
        encryptionReady: !!secrets.dek,
        signedIn: !!(state.account && secrets.tokens && secrets.tokens.refreshToken),
        categories: clone(CATEGORIES),
        recommendedCategories: CATEGORY_IDS.slice(),
      };
    }

    function permissionContains(payload) {
      if (!chromeApi || !chromeApi.permissions || !chromeApi.permissions.contains) return Promise.resolve(false);
      return new Promise(function (resolve) {
        try {
          var result = chromeApi.permissions.contains(payload, function (granted) {
            var error = chromeApi.runtime && chromeApi.runtime.lastError; resolve(!error && !!granted);
          });
          if (result && typeof result.then === 'function') result.then(function (granted) { resolve(!!granted); }).catch(function () { resolve(false); });
        } catch (_) { resolve(false); }
      });
    }
    function consentPermissionPayload() {
      var request = { origins: [apiOrigin + '/*'] };
      var manifest = {};
      try { manifest = chromeApi.runtime.getManifest(); } catch (_) {}
      var gecko = manifest && manifest.browser_specific_settings && manifest.browser_specific_settings.gecko;
      var declared = gecko && gecko.data_collection_permissions && gecko.data_collection_permissions.optional;
      if (Array.isArray(declared)) {
        var requested = DATA_PERMISSIONS.filter(function (category) { return declared.indexOf(category) !== -1; });
        if (requested.length) request.data_collection = requested;
      }
      return request;
    }
    async function requestConsent() {
      var granted = await permissionContains(consentPermissionPayload());
      if (!granted) throw new PlusApiError('PLUS_PERMISSION_REQUIRED', 'Open the standalone extension settings to approve access to the Plus API. No data was sent.');
      return setState({ setupStarted: true });
    }

    async function parseJsonResponse(response) {
      var body = await response.json().catch(function () { return null; });
      if (!response.ok || !body || body.ok === false) {
        var error = body && body.error || {};
        throw new PlusApiError(error.code || 'PLUS_REQUEST_FAILED', error.message || 'The Plus service request failed.', error.requestId, response.status, error.details);
      }
      return body;
    }
    async function rawRequest(path, init) {
      var response;
      try { response = await fetchImpl(apiOrigin + path, Object.assign({ cache: 'no-store', referrerPolicy: 'no-referrer' }, init || {})); }
      catch (_) { throw new PlusApiError('PLUS_NETWORK_ERROR', 'Could not reach the Plus service. Local extension data was not changed.'); }
      return response;
    }
    async function refreshTokens(secrets) {
      if (!secrets.tokens || !secrets.tokens.refreshToken) throw new PlusApiError('AUTH_REQUIRED', 'Sign in to Comix Downloader Plus.');
      var response = await rawRequest('/v1/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: secrets.tokens.refreshToken }) });
      var result = await parseJsonResponse(response);
      secrets.tokens = result.tokens; await setSecrets(secrets); return secrets;
    }
    async function authorizedRequest(path, init, binary) {
      var secrets = await getSecrets();
      if (!secrets.tokens || !secrets.tokens.accessToken) throw new PlusApiError('AUTH_REQUIRED', 'Sign in to Comix Downloader Plus.');
      var request = Object.assign({}, init || {}); request.headers = Object.assign({}, request.headers || {}, { Authorization: 'Bearer ' + secrets.tokens.accessToken });
      var response = await rawRequest(path, request);
      if (response.status === 401) {
        if (!refreshingTokens) {
          var staleToken = secrets.tokens.accessToken;
          var refreshLatest = async function () {
            var current = await getSecrets();
            if (current.tokens && current.tokens.accessToken !== staleToken) return current;
            return refreshTokens(current);
          };
          // The background worker and open library tabs share rotating credentials.
          refreshingTokens = (global.navigator && global.navigator.locks
            ? global.navigator.locks.request('cdl-plus-auth-refresh', refreshLatest)
            : refreshLatest()).finally(function () { refreshingTokens = null; });
        }
        secrets = await refreshingTokens;
        request.headers.Authorization = 'Bearer ' + secrets.tokens.accessToken;
        response = await rawRequest(path, request);
      }
      if (binary) {
        if (!response.ok) await parseJsonResponse(response);
        return { bytes: new Uint8Array(await response.arrayBuffer()), headers: response.headers };
      }
      return parseJsonResponse(response);
    }
    async function requestCode(email) {
      await requestConsent();
      var response = await rawRequest('/v1/auth/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email }) });
      return parseJsonResponse(response);
    }
    async function verifyCode(email, code, deviceName, intent, testerKey) {
      var identity = await getIdentity(email);
      var payload = { email: email, code: code, deviceId: identity.id, deviceName: deviceName || describeBrowser(), publicKeyJwk: identity.publicKeyJwk, intent: intent === 'login' ? 'login' : 'create' };
      if (testerKey) payload.testerKey = testerKey;
      var response = await rawRequest('/v1/auth/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var result = await parseJsonResponse(response);
      var secrets = await getSecrets(); secrets.tokens = result.tokens; await setSecrets(secrets);
      await setState({ account: result.account, device: { id: identity.id, name: result.account.device.name }, lastRevision: 0, lastPayloadHash: null, lastError: null });
      await ensureKey();
      await ensureAlarm(); return publicView();
    }
    // Private testing builds only: plus-tester.local.json sits next to manifest.json on the
    // developer's machine (never committed or packaged) and holds the shared tester
    // account's email and key for the testing service, which treats everyone as Plus.
    async function readTesterFile() {
      if (CHANNEL !== 'testing' || !chromeApi || !chromeApi.runtime || typeof chromeApi.runtime.getURL !== 'function') return null;
      try {
        var response = await global.fetch(chromeApi.runtime.getURL('plus-tester.local.json'), { cache: 'no-store' });
        if (!response.ok) return null;
        var data = await response.json();
        return data && typeof data.email === 'string' && typeof data.key === 'string' && data.key ? data : null;
      } catch (_) { return null; }
    }
    async function signInAsTester() {
      var tester = await readTesterFile();
      if (!tester) throw new PlusApiError('TESTER_UNAVAILABLE', 'The tester account needs plus-tester.local.json next to manifest.json (testing builds only).');
      var current = await getState();
      if (current.account) await signOut();
      return verifyCode(tester.email, '', 'Tester on ' + describeBrowser(), 'login', tester.key);
    }
    // Sign-in handover within one browser: a signed-in place creates a single-use
    // code, and another place (the website, the extension or the web library)
    // redeems it to become signed in as the same account.
    async function createHandoffCode() {
      return authorizedRequest('/v1/auth/handoff-code', { method: 'POST' });
    }
    async function redeemHandoff(code, email, deviceName) {
      await requestConsent();
      var current = await getState();
      if (current.account) await signOut();
      var identity = await getIdentity(email || 'handoff');
      var response = await rawRequest('/v1/auth/handoff', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code, deviceId: identity.id, deviceName: deviceName || describeBrowser(), publicKeyJwk: identity.publicKeyJwk }),
      });
      var result = await parseJsonResponse(response);
      var secrets = await getSecrets(); secrets.tokens = result.tokens; await setSecrets(secrets);
      await setState({ account: result.account, device: { id: identity.id, name: result.account.device.name }, lastRevision: 0, lastPayloadHash: null, lastError: null });
      await ensureKey();
      await ensureAlarm(); return publicView();
    }
    async function fetchAccount() {
      var result = await authorizedRequest('/v1/account', { method: 'GET' });
      await setState({ account: result.account, device: result.account.device, lastSyncAt: result.account.lastSyncAt || null, lastError: null });
      return result.account;
    }
    async function refreshAccount() {
      await fetchAccount();
      await ensureKey();
      return publicView();
    }
    function openTab(url) {
      if (!url || !chromeApi || !chromeApi.tabs || !chromeApi.tabs.create) return Promise.resolve(false);
      try {
        var result = chromeApi.tabs.create({ url: url });
        if (result && typeof result.then === 'function') return result.then(function () { return true; });
      } catch (_) { return Promise.resolve(false); }
      return Promise.resolve(true);
    }
    async function checkout(open) {
      var result = await authorizedRequest('/v1/billing/checkout', { method: 'POST' });
      if (open) result.opened = await openTab(result.url);
      return result;
    }
    async function billingPortal(open) {
      var result = await authorizedRequest('/v1/billing/portal', { method: 'GET' });
      if (open) result.opened = await openTab(result.url);
      return result;
    }

    async function bootstrapEncryption() {
      var state = await getState(); if (!state.account || !state.account.device || !state.account.device.approved) throw new PlusApiError('DEVICE_APPROVAL_REQUIRED', 'Sign in again on this device with a code sent to your email.');
      var secrets = await getSecrets();
      if (secrets.dek) throw new PlusApiError('SYNC_KEY_EXISTS', 'Cloud encryption is already initialized.');
      var dek = randomBytes(32);
      await authorizedRequest('/v1/keys/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyVersion: 1, dek: toBase64(dek) }) });
      secrets.dek = toBase64(dek); secrets.keyVersion = 1; await setSecrets(secrets);
      await updateSyncState({ lastRevision: 0, lastPayloadHash: null });
      await fetchAccount();
      return { view: await publicView() };
    }
    // A verified email sign-in is enough: the service returns this account's data key.
    async function unlockWithSignIn() {
      var result = await authorizedRequest('/v1/keys/escrow', { method: 'GET' });
      var secrets = await getSecrets(); secrets.dek = result.dek; secrets.keyVersion = result.keyVersion; await setSecrets(secrets);
      return publicView();
    }
    // Keeps this device's data key in step with the account after each sign-in or
    // refresh: fetch it, create it for a new paid account, or give an account created
    // with a recovery code the service copy that email sign-in needs.
    async function ensureKey() {
      var state = await getState(), account = state.account, secrets = await getSecrets();
      if (!account || !account.device || !account.device.approved) return;
      if (secrets.pendingRecoveryCode) { delete secrets.pendingRecoveryCode; await setSecrets(secrets); }
      if (secrets.dek && account.keyVersion && secrets.keyVersion && Number(secrets.keyVersion) !== Number(account.keyVersion)) {
        // The account's key was reset from another device; this copy no longer applies.
        delete secrets.dek; delete secrets.keyVersion; await setSecrets(secrets);
      }
      try {
        if (!secrets.dek && account.encryptionInitialized) {
          if (account.keyEscrow) await unlockWithSignIn();
          return;
        }
        if (!secrets.dek && ['trial', 'active', 'grace', 'cancelled_active'].indexOf(account.state) !== -1) {
          try { await bootstrapEncryption(); }
          catch (error) {
            if (!error || error.code !== 'SYNC_KEY_EXISTS') throw error;
            // Another browser created the key at the same moment; use that one.
            if ((await fetchAccount()).keyEscrow) await unlockWithSignIn();
          }
          return;
        }
        if (secrets.dek && account.encryptionInitialized && !account.keyEscrow) {
          await authorizedRequest('/v1/keys/escrow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dek: secrets.dek, keyVersion: secrets.keyVersion || 1 }) });
          await setState({ account: Object.assign({}, account, { keyEscrow: true }) });
        }
      } catch (error) {
        await setState({ lastError: { code: error && error.code || 'PLUS_KEY_UNAVAILABLE', message: error && error.message || 'Your cloud data could not be unlocked on this browser.', requestId: error && error.requestId || null } });
      }
    }
    async function recoverWithCode(code) {
      var info = await authorizedRequest('/v1/keys', { method: 'GET' });
      var opened = await openRecoveryEnvelope(info.recoveryEnvelope, code);
      var recovered = await authorizedRequest('/v1/devices/recover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recoveryAuth: opened.recoveryAuth }) });
      var secrets = await getSecrets(); secrets.dek = toBase64(opened.dek); secrets.keyVersion = recovered.keyVersion; delete secrets.pendingRecoveryCode; await setSecrets(secrets);
      await refreshAccount(); return publicView();
    }
    async function deviceApproval() {
      var result = await authorizedRequest('/v1/devices/me/approval', { method: 'GET' });
      if (result.approved && result.wrappedKey) {
        var state = await getState();
        var identities = (await storageGet(chromeApi, DEVICE_KEY))[DEVICE_KEY] || {};
        var identity = Object.keys(identities).map(function (key) { return identities[key]; }).find(function (item) { return item.id === state.device.id; });
        if (!identity) throw new PlusApiError('DEVICE_KEY_MISSING', 'This browser lost its device key. Sign out, then sign in again with a code sent to your email.');
        var dek = await ecdhUnwrapKey(result.wrappedKey, identity.privateKeyJwk);
        var secrets = await getSecrets(); secrets.dek = toBase64(dek); secrets.keyVersion = result.keyVersion; await setSecrets(secrets);
        await refreshAccount();
      }
      return { approval: result, view: await publicView() };
    }
    async function listDevices() { return authorizedRequest('/v1/devices', { method: 'GET' }); }
    async function sendFeedback(message) {
      var manifest = {};
      try { manifest = chromeApi.runtime.getManifest(); } catch (_) {}
      return authorizedRequest('/v1/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: String(message.kind || ''),
          message: String(message.message || '').slice(0, 4000),
          allowReply: message.allowReply !== false,
          version: String(manifest.version || ''),
          browser: describeBrowser(),
        }),
      });
    }
    async function approveDevice(deviceId, publicKeyJwk) {
      var state = await getState(), secrets = await getSecrets();
      if (!secrets.dek) throw new PlusApiError('SYNC_KEY_MISSING', 'This device does not have the cloud encryption key.');
      var identities = (await storageGet(chromeApi, DEVICE_KEY))[DEVICE_KEY] || {};
      var identity = Object.keys(identities).map(function (key) { return identities[key]; }).find(function (item) { return item.id === state.device.id; });
      if (!identity) throw new PlusApiError('DEVICE_KEY_MISSING', 'This browser no longer has its private device key.');
      var wrapped = await ecdhWrapKey(fromBase64(secrets.dek), identity.privateKeyJwk, publicKeyJwk);
      return authorizedRequest('/v1/devices/' + encodeURIComponent(deviceId) + '/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wrappedKey: wrapped, keyVersion: secrets.keyVersion || 1 }) });
    }
    async function revokeDevice(deviceId) { return authorizedRequest('/v1/devices/' + encodeURIComponent(deviceId), { method: 'DELETE' }); }

    async function setCategories(categories) {
      var selected = Array.from(new Set((categories || []).filter(function (id) { return CATEGORY_IDS.indexOf(id) !== -1; })));
      var state = await setState({ selectedCategories: selected, lastPayloadHash: null });
      if (selected.length) scheduleSync(10000);
      return { state: state };
    }
    async function updateSyncState(patch) { return setState(patch); }
    async function fetchCloudPayload(secrets, path) {
      var result = await authorizedRequest(path, { method: 'GET' }, true);
      return { payload: await decryptSnapshot(result.bytes, fromBase64(secrets.dek)), headers: result.headers };
    }
    async function uploadPayload(payload, secrets, baseRevision) {
      var encrypted = await encryptSnapshot(payload, fromBase64(secrets.dek));
      return authorizedRequest('/v1/sync/head', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'X-CDL-Base-Revision': String(baseRevision), 'X-CDL-Schema-Version': String(SNAPSHOT_SCHEMA) },
        body: encrypted,
      });
    }
    async function categoryPayloadHash(payload) {
      return sha256Hex(stableStringify(payload && payload.categories || {}));
    }
    async function performSync() {
      var state = await getState(), secrets = await getSecrets();
      if (!state.account || !state.selectedCategories.length || !secrets.dek) return { skipped: true, reason: 'not_configured' };
      if (!state.account.device || !state.account.device.approved) return { skipped: true, reason: 'device_unapproved' };
      var accountState = state.account.state;
      if (['trial', 'active', 'grace', 'cancelled_active'].indexOf(accountState) === -1) return { skipped: true, reason: 'read_only' };
      var started = nowIso(), captured = await captureLocal(chromeApi, state.selectedCategories, state.device.id, started);
      var capturedHash = await categoryPayloadHash(captured.payload);
      var headResult = await authorizedRequest('/v1/sync/head', { method: 'GET' });
      var head = headResult.head;
      if (head.schemaVersion > SNAPSHOT_SCHEMA) throw new PlusApiError('SYNC_SCHEMA_NEWER', 'Cloud data was created by a newer extension version. Update before syncing.');
      if (head.revision === state.lastRevision && state.lastPayloadHash && capturedHash === state.lastPayloadHash) {
        var checkedAt = nowIso();
        await updateSyncState({ lastSyncAt: checkedAt, pendingSyncAt: null, lastError: null });
        return { synced: true, unchanged: true, revision: head.revision, sizeBytes: head.sizeBytes, updatedAt: checkedAt };
      }
      var merged = captured.payload;
      var cloudHash = null;
      if (head.revision > 0) {
        var cloud = await fetchCloudPayload(secrets, '/v1/sync/head/data');
        cloudHash = await categoryPayloadHash(cloud.payload);
        merged = mergePayloads(cloud.payload, captured.payload);
        applyingRemote = true;
        try { captured.meta = await applyPayload(chromeApi, merged, state.selectedCategories, captured.meta); }
        finally { applyingRemote = false; }
      }
      var mergedHash = await categoryPayloadHash(merged);
      if (head.revision > 0 && cloudHash === mergedHash) {
        var mergedAt = nowIso();
        await updateSyncState({ lastRevision: head.revision, lastPayloadHash: mergedHash, lastSyncAt: mergedAt, pendingSyncAt: null, lastError: null });
        return { synced: true, unchanged: true, revision: head.revision, sizeBytes: head.sizeBytes, updatedAt: mergedAt };
      }
      var uploaded = null;
      for (var attempt = 0; attempt < 3 && !uploaded; attempt += 1) {
        try { uploaded = await uploadPayload(merged, secrets, head.revision); }
        catch (error) {
          if (error.code !== 'SYNC_CONFLICT' || attempt === 2) throw error;
          var latestHeadResult = await authorizedRequest('/v1/sync/head', { method: 'GET' });
          head = latestHeadResult.head;
          if (head.schemaVersion > SNAPSHOT_SCHEMA) throw new PlusApiError('SYNC_SCHEMA_NEWER', 'Cloud data was created by a newer extension version. Update before syncing.');
          if (head.revision > 0) {
            var latestCloud = await fetchCloudPayload(secrets, '/v1/sync/head/data');
            cloudHash = await categoryPayloadHash(latestCloud.payload);
            merged = mergePayloads(latestCloud.payload, merged);
            applyingRemote = true;
            try { captured.meta = await applyPayload(chromeApi, merged, state.selectedCategories, captured.meta); }
            finally { applyingRemote = false; }
            mergedHash = await categoryPayloadHash(merged);
            if (cloudHash === mergedHash) {
              var conflictMergedAt = nowIso();
              await updateSyncState({ lastRevision: head.revision, lastPayloadHash: mergedHash, lastSyncAt: conflictMergedAt, pendingSyncAt: null, lastError: null });
              return { synced: true, unchanged: true, revision: head.revision, sizeBytes: head.sizeBytes, updatedAt: conflictMergedAt };
            }
          }
        }
      }
      await updateSyncState({ lastRevision: uploaded.revision, lastPayloadHash: mergedHash, lastSyncAt: uploaded.updatedAt, pendingSyncAt: null, lastError: null });
      return { synced: true, revision: uploaded.revision, sizeBytes: uploaded.sizeBytes, updatedAt: uploaded.updatedAt };
    }
    function serializeError(error) { return { code: error.code || 'SYNC_FAILED', message: error.message || 'Sync failed.', requestId: error.requestId || null, at: nowIso() }; }
    async function syncNow() {
      if (syncPromise) return syncPromise;
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      if (chromeApi && chromeApi.alarms) {
        try { chromeApi.alarms.clear(FALLBACK_ALARM); } catch (_) {}
      }
      syncPromise = performSync().catch(async function (error) { await updateSyncState({ lastError: serializeError(error), pendingSyncAt: null }); throw error; })
        .finally(function () { syncPromise = null; });
      return syncPromise;
    }
    async function listSnapshots() { return authorizedRequest('/v1/sync/snapshots', { method: 'GET' }); }
    async function restoreSnapshot(snapshotId, categories) {
      var state = await getState(), secrets = await getSecrets();
      var selected = (categories || []).filter(function (id) { return state.selectedCategories.indexOf(id) !== -1; });
      if (!selected.length) throw new PlusApiError('RESTORE_CATEGORIES_EMPTY', 'Select at least one category to restore.');
      var readOnly = state.account && state.account.state === 'expired';
      if (!readOnly) await authorizedRequest('/v1/sync/restore-point', { method: 'POST' });
      var backup = await fetchCloudPayload(secrets, '/v1/sync/snapshots/' + encodeURIComponent(snapshotId) + '/data');
      var captured = await captureLocal(chromeApi, state.selectedCategories, state.device.id, nowIso());
      var restored = prepareRestorePayload(captured.payload, backup.payload, selected, state.device.id, nowIso());
      applyingRemote = true;
      try { await applyPayload(chromeApi, restored, state.selectedCategories, captured.meta); }
      finally { applyingRemote = false; }
      if (readOnly) {
        var restoredAt = nowIso();
        await updateSyncState({ lastPayloadHash: null, lastSyncAt: restoredAt, pendingSyncAt: null, lastError: null });
        return { restored: true, readOnly: true, updatedAt: restoredAt };
      }
      await updateSyncState({ lastRevision: 0, lastPayloadHash: null });
      return syncNow();
    }
    async function deleteCloudData() { var result = await authorizedRequest('/v1/sync', { method: 'DELETE' }); await updateSyncState({ lastRevision: 0, lastPayloadHash: null, lastSyncAt: null }); return result; }
    async function exportCloudData() {
      var secrets = await getSecrets();
      if (!secrets.dek) throw new PlusApiError('SYNC_KEY_MISSING', 'This device does not have the cloud encryption key.');
      var cloud = await fetchCloudPayload(secrets, '/v1/sync/head/data');
      var bytes = encoder.encode(JSON.stringify(cloud.payload, null, 2));
      if (!chromeApi || !chromeApi.downloads || !chromeApi.downloads.download) throw new PlusApiError('EXPORT_UNAVAILABLE', 'This browser cannot export the cloud backup.');
      var filename = 'comix-downloader-plus-export-' + nowIso().slice(0, 10) + '.json';
      var url = 'data:application/json;base64,' + toBase64(bytes);
      var downloadId = await new Promise(function (resolve, reject) {
        try {
          var result = chromeApi.downloads.download({ url: url, filename: filename, saveAs: true }, function (id) {
            var error = chromeApi.runtime && chromeApi.runtime.lastError;
            if (error) reject(new PlusApiError('EXPORT_FAILED', error.message)); else resolve(id);
          });
          if (result && typeof result.then === 'function') result.then(resolve).catch(function (error) { reject(new PlusApiError('EXPORT_FAILED', error.message)); });
        } catch (error) { reject(new PlusApiError('EXPORT_FAILED', error.message)); }
      });
      return { downloadId: downloadId, filename: filename };
    }
    async function resetCloudSync(confirmation) {
      var result = await authorizedRequest('/v1/sync/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation: confirmation }) });
      var secrets = await getSecrets(); delete secrets.dek; delete secrets.keyVersion; delete secrets.pendingRecoveryCode; await setSecrets(secrets);
      await storageRemove(chromeApi, META_KEY); await updateSyncState({ lastRevision: 0, lastPayloadHash: null, lastSyncAt: null });
      await refreshAccount();
      return { reset: result.reset, view: await publicView() };
    }
    async function signOut() {
      try { await authorizedRequest('/v1/auth/logout', { method: 'POST' }); } catch (_) {}
      var secrets = await getSecrets(); delete secrets.tokens; delete secrets.dek; delete secrets.keyVersion; delete secrets.pendingRecoveryCode; await setSecrets(secrets);
      await storageRemove(chromeApi, META_KEY); await setState(defaultState()); await clearAlarms();
      // The Plus website in this browser compares this with its own sign-in time.
      await storageSet(chromeApi, { cdlPlusSignedOutAt: Date.now() });
      return publicView();
    }
    async function deleteAccount() {
      var result = await authorizedRequest('/v1/account', { method: 'DELETE' });
      await storageRemove(chromeApi, [STATE_KEY, SECRET_KEY, META_KEY, DEVICE_KEY]); await clearAlarms(); return result;
    }

    async function ensureAlarm() {
      var state = await getState(); if (!state.account || !chromeApi || !chromeApi.alarms) return;
      try {
        var result = chromeApi.alarms.create(SYNC_ALARM, { periodInMinutes: 15 });
        if (result && typeof result.then === 'function') await result;
      } catch (_) {}
    }
    async function clearAlarms() {
      if (!chromeApi || !chromeApi.alarms) return;
      try { chromeApi.alarms.clear(SYNC_ALARM); chromeApi.alarms.clear(FALLBACK_ALARM); } catch (_) {}
    }
    function scheduleSync(delay) {
      if (debounceTimer) clearTimeout(debounceTimer);
      var when = Date.now() + (delay || 10000);
      setState({ pendingSyncAt: nowIso(when) }).catch(function () {});
      debounceTimer = setTimeout(function () { debounceTimer = null; syncNow().catch(function () {}); }, Math.max(0, when - Date.now()));
      if (chromeApi && chromeApi.alarms) {
        try { chromeApi.alarms.create(FALLBACK_ALARM, { when: Math.max(when, Date.now() + 30000) }); } catch (_) {}
      }
    }
    function onStorageChanged(changes, area) {
      if (area && area !== 'local' || applyingRemote) return;
      var changed = Object.keys(changes || {}).filter(function (key) { return !IGNORED_STORAGE_KEYS.has(key); });
      if (!changed.length) return;
      getState().then(function (state) {
        if (!state.account || !state.autoSync || !state.selectedCategories.length) return;
        var eligible = changed.some(function (key) { return key === 'cdlReadStats' ? state.selectedCategories.indexOf('stats') !== -1 : state.selectedCategories.indexOf(STORE_CATEGORY[key]) !== -1; });
        if (eligible) scheduleSync(10000);
      }).catch(function () {});
    }
    async function init() {
      if (initialized) return; initialized = true;
      if (chromeApi && chromeApi.storage && chromeApi.storage.onChanged) chromeApi.storage.onChanged.addListener(onStorageChanged);
      var state = await getState();
      if (!state.account) {
        // Private testing builds start signed in to the shared tester account, until someone signs out.
        var signedOut = await storageGet(chromeApi, 'cdlPlusSignedOutAt');
        if (!signedOut.cdlPlusSignedOutAt && await readTesterFile()) {
          try { await signInAsTester(); } catch (_) {}
          state = await getState();
        }
      }
      if (!state.account) return;
      await ensureAlarm();
      var delay = state.pendingSyncAt ? Math.max(250, Date.parse(state.pendingSyncAt) - Date.now()) : 1500;
      if (state.autoSync && state.selectedCategories.length) scheduleSync(delay);
    }
    async function handleAlarm(name) {
      if (name !== SYNC_ALARM && name !== FALLBACK_ALARM) return false;
      var state = await getState(); if (!state.account || !state.autoSync) return true;
      await syncNow().catch(function () {}); return true;
    }
    async function handleMessage(message) {
      var action = message && message.action;
      if (action === 'plusGetState') return publicView();
      if (action === 'plusOpenLibrary') return { opened: await openTab(chromeApi.runtime.getURL('cloud-library/index.html')) };
      if (action === 'plusLibraryFolders') {
        await refreshAccount();
        if (!library) throw new PlusApiError('LIBRARY_UNAVAILABLE', 'Cloud Library is unavailable.');
        var cloud = await library.list();
        return { folders: cloud.nodes.filter(function (n) { return n.kind === 'folder' && !n.deleted_at && n.state === 'ready'; }).map(function (n) { return { id: n.id, name: n.details.name }; }) };
      }
      if (action === 'plusRequestConsent') return { state: await requestConsent() };
      if (action === 'plusRequestCode') return requestCode(message.email);
      if (action === 'plusVerifyCode') return verifyCode(message.email, message.code, message.deviceName, message.intent);
      if (action === 'plusSignInAsTester') return signInAsTester();
      if (action === 'plusTesterAvailable') return { available: !!(await readTesterFile()) };
      if (action === 'plusCreateHandoff') return createHandoffCode();
      if (action === 'plusRedeemHandoff') return redeemHandoff(message.code, message.email, message.deviceName);
      if (action === 'plusRefreshAccount') return refreshAccount();
      if (action === 'plusCheckout') return checkout(!!message.open);
      if (action === 'plusBillingPortal') return billingPortal(!!message.open);
      if (action === 'plusBootstrapEncryption') return bootstrapEncryption();
      if (action === 'plusUnlock') { await refreshAccount(); return publicView(); }
      if (action === 'plusRecover') return recoverWithCode(message.recoveryCode);
      if (action === 'plusDeviceApproval') return deviceApproval();
      if (action === 'plusListDevices') return listDevices();
      if (action === 'plusSendFeedback') return sendFeedback(message);
      if (action === 'plusApproveDevice') return approveDevice(message.deviceId, message.publicKeyJwk);
      if (action === 'plusRevokeDevice') return revokeDevice(message.deviceId);
      if (action === 'plusSetCategories') return setCategories(message.categories);
      if (action === 'plusSyncNow') return syncNow();
      if (action === 'plusListSnapshots') return listSnapshots();
      if (action === 'plusRestoreSnapshot') return restoreSnapshot(message.snapshotId, message.categories);
      if (action === 'plusDeleteCloudData') return deleteCloudData();
      if (action === 'plusExportCloudData') return exportCloudData();
      if (action === 'plusResetCloudSync') return resetCloudSync(message.confirmation);
      if (action === 'plusSignOut') return signOut();
      if (action === 'plusDeleteAccount') return deleteAccount();
      return null;
    }
    var library = global.CDLCloudLibrary ? global.CDLCloudLibrary.create({
      request: authorizedRequest,
      context: async function () {
        var state = await getState();
        var secrets = await getSecrets();
        if (!state.account || !secrets.tokens || !secrets.tokens.refreshToken) {
          throw new PlusApiError('AUTH_REQUIRED', 'Sign in to Comix Downloader Plus.');
        }
        if (state.account && !state.account.id) { await refreshAccount(); state = await getState(); }
        if (!state.account || !state.account.id) {
          throw new PlusApiError('LIBRARY_SERVER_UPDATE_REQUIRED', 'You are signed in, but the Plus service is being updated. Try again in a few minutes.');
        }
        secrets = await getSecrets();
        if (!secrets.dek) { await ensureKey(); secrets = await getSecrets(); }
        if (!secrets.dek) throw new PlusApiError('LIBRARY_LOCKED', 'You are signed in, but your library could not be unlocked on this browser. Check your connection and try again.');
        return { user: state.account.id, dek: secrets.dek };
      },
    }) : null;
    return {
      init: init, handleAlarm: handleAlarm, handleMessage: handleMessage, syncNow: syncNow,
      getState: getState, publicView: publicView, scheduleSync: scheduleSync,
      library: library,
    };
  }

  return {
    API_ORIGIN: API_ORIGIN,
    API_ORIGINS: API_ORIGINS,
    API_PERMISSION: API_PERMISSION,
    CHANNEL: CHANNEL,
    releaseChannel: releaseChannel,
    DATA_PERMISSIONS: DATA_PERMISSIONS,
    describeBrowser: describeBrowser,
    SNAPSHOT_SCHEMA: SNAPSHOT_SCHEMA,
    STATE_KEY: STATE_KEY,
    SECRET_KEY: SECRET_KEY,
    DEVICE_KEY: DEVICE_KEY,
    META_KEY: META_KEY,
    SYNC_ALARM: SYNC_ALARM,
    FALLBACK_ALARM: FALLBACK_ALARM,
    CATEGORIES: CATEGORIES,
    RECOMMENDED_CATEGORIES: CATEGORY_IDS.slice(),
    defaultState: defaultState,
    cleanState: cleanState,
    encodeRecoveryCode: encodeRecoveryCode,
    decodeRecoveryCode: decodeRecoveryCode,
    createRecoveryEnvelope: createRecoveryEnvelope,
    openRecoveryEnvelope: openRecoveryEnvelope,
    encryptSnapshot: encryptSnapshot,
    decryptSnapshot: decryptSnapshot,
    generateDeviceIdentity: generateDeviceIdentity,
    ecdhWrapKey: ecdhWrapKey,
    ecdhUnwrapKey: ecdhUnwrapKey,
    mergePayloads: mergePayloads,
    diffStats: diffStats,
    addContributions: addContributions,
    materializeContributions: materializeContributions,
    captureLocal: captureLocal,
    applyPayload: applyPayload,
    retimestampCategories: retimestampCategories,
    prepareRestorePayload: prepareRestorePayload,
    createService: createService,
    PlusApiError: PlusApiError,
    __test: { stableStringify: stableStringify, recordWins: recordWins, flattenStore: flattenStore, inflateStore: inflateStore, toBase64: toBase64, fromBase64: fromBase64, sha256Hex: sha256Hex },
  };
});
