/**
 * background.js — Service Worker (Manifest V3)
 * Orchestre le téléchargement d'un chapitre :
 *   1. Ouvre un onglet invisible sur la page du chapitre
 *   2. Injecte un script d'extraction d'images (lazy-loading)
 *   3. Ferme l'onglet chapitre
 *   4. Fetch les images directement (service worker a les host_permissions)
 *   5. Crée le ZIP via JSZip (importScripts) → chrome.downloads (data URL base64)
 */

// Chrome loads JSZip from the service worker. Firefox loads it first through
// manifest.background.scripts in the generated Firefox package.
if (typeof importScripts === 'function' && typeof JSZip === 'undefined') {
  importScripts('lib/jszip.min.js');
}

// Shared settings module (CDLSettings). Chrome loads it here; Firefox loads it
// via manifest.background.scripts (jszip, settings, features-core, comicinfo,
// background — in that order).
if (typeof importScripts === 'function' && typeof CDLSettings === 'undefined') {
  importScripts('settings.js');
}

// Chapter-identity helpers (CDLFeaturesCore) for the downloaded-manifest, and the
// ComicInfo.xml builder (CDLComicInfo) for CBZ output. Same dual-context pattern.
if (typeof importScripts === 'function' && typeof CDLFeaturesCore === 'undefined') {
  importScripts('cdl-features-core.js');
}
if (typeof importScripts === 'function' && typeof CDLComicInfo === 'undefined') {
  importScripts('cdl-comicinfo.js');
}

'use strict';

// Read the user's settings fresh for each download operation. The service worker
// can restart mid-session, so we never cache config across operations (the one
// exception is the log cap below, used by the very frequent fire-and-forget log).
async function loadCfg() {
  if (typeof CDLSettings !== 'undefined') {
    try { return await CDLSettings.getSettings(); }
    catch (_) { return CDLSettings.DEFAULTS; }
  }
  return {};
}

// ── Comix-Downloader "tenure badge" service (v3.0.0) ─────────────────────────
// Records when the badge service first saw a user, and looks up other users'
// first-seen dates, so content_profile.js can show "Comix-Downloader user · N months"
// on comix profiles. The badge (and the community chapter flags that share this
// Worker) is a built-in, always-on feature; only an OPAQUE salted hash of the comix
// user id + a coarse date / coarse flag counts ever leave the device.
//
// CDL_BADGE_API points at the deployed free Cloudflare Worker (see worker/). A
// `cdlBadgeApi` storage key overrides it (used by the E2E harness; could also let
// advanced users self-host).
const CDL_BADGE_API = 'https://comix-downloader-badge.comixdl.workers.dev';
const CDL_BADGE_SALT = 'cdl-badge-v1'; // not secret; keeps raw comix ids out of the KV store
const _BADGE_LOOKUP_TTL = 7 * 24 * 60 * 60 * 1000; // cache a found date ~7 days
const _BADGE_NEG_TTL = 30 * 60 * 1000;             // cache "no record" only ~30 min (they may register soon)
const _BADGE_REGISTER_EVERY = 20 * 60 * 60 * 1000;  // re-register at most ~once/day
let _badgeMem = Object.create(null); // hashId -> { first, at } in-memory lookup cache

async function badgeApiBase() {
  try {
    const r = await chrome.storage.local.get('cdlBadgeApi');
    if (r && typeof r.cdlBadgeApi === 'string' && r.cdlBadgeApi) return r.cdlBadgeApi.replace(/\/+$/, '');
  } catch (_) {}
  return CDL_BADGE_API ? CDL_BADGE_API.replace(/\/+$/, '') : '';
}
async function badgeHash(hashId) {
  const data = new TextEncoder().encode(String(hashId) + CDL_BADGE_SALT);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 32); // 128-bit hex id is plenty and keeps requests small
}

// Register the current user (server timestamps first-seen). Throttled ~once/day.
async function badgeRegister(hashId) {
  const base = await badgeApiBase();
  if (!base || !hashId) return { ok: false };
  try {
    const store = await chrome.storage.local.get('cdlBadgeReg');
    const reg = store && store.cdlBadgeReg;
    if (reg && reg.hashId === hashId && reg.at && (Date.now() - reg.at) < _BADGE_REGISTER_EVERY) {
      return { ok: true, first: reg.first, cached: true };
    }
    const id = await badgeHash(hashId);
    const resp = await fetch(base + '/v1/seen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
    if (!resp.ok) return { ok: false };
    const j = await resp.json();
    await chrome.storage.local.set({ cdlBadgeReg: { hashId, first: j.first, at: Date.now() } });
    return { ok: true, first: j.first };
  } catch (_) { return { ok: false }; }
}

// Look up another user's first-seen date (cached in memory + storage, ~7-day TTL).
async function badgeLookup(hashId) {
  const base = await badgeApiBase();
  if (!base || !hashId) return { ok: false };
  // A found date is cached long; a "no record" only briefly, so a freshly-registered user shows up soon.
  var ttl = function (e) { return e.first ? _BADGE_LOOKUP_TTL : _BADGE_NEG_TTL; };
  const mem = _badgeMem[hashId];
  if (mem && (Date.now() - mem.at) < ttl(mem)) return { ok: true, first: mem.first };
  try {
    const store = await chrome.storage.local.get('cdlBadgeCache');
    const cache = (store && store.cdlBadgeCache) || {};
    const hit = cache[hashId];
    if (hit && (Date.now() - hit.at) < ttl(hit)) { _badgeMem[hashId] = hit; return { ok: true, first: hit.first }; }
    const id = await badgeHash(hashId);
    const resp = await fetch(base + '/v1/seen?ids=' + encodeURIComponent(id));
    if (!resp.ok) return { ok: false };
    const j = await resp.json();
    const first = (j && j[id]) || null;
    const entry = { first, at: Date.now() };
    _badgeMem[hashId] = entry;
    cache[hashId] = entry;
    try { await chrome.storage.local.set({ cdlBadgeCache: cache }); } catch (_) {}
    return { ok: true, first };
  } catch (_) { return { ok: false }; }
}

// ── Crowd quality flags (same Worker + KV as the badge) ──────────────────────
const _FLAG_TTL = 10 * 60 * 1000; // cache a chapter's flag counts ~10 min
let _flagMem = Object.create(null); // chapterId -> { counts, at }
// Chapter id is hashed under a 'chap:' namespace so it can't collide with user hashes.
function flagChapterHash(chapterId) { return badgeHash('chap:' + chapterId); }

// Submit one flag for a chapter (server dedups per user+chapter). Refreshes the local cache.
async function flagSubmit(chapterId, userHashId, type) {
  const base = await badgeApiBase();
  if (!base || !chapterId || !userHashId || !type) return { ok: false };
  try {
    const chapter = await flagChapterHash(chapterId);
    const user = await badgeHash(userHashId);
    const resp = await fetch(base + '/v1/flag', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chapter, user, type }),
    });
    if (!resp.ok) return { ok: false };
    const j = await resp.json();
    _flagMem[chapterId] = { counts: j.counts || null, at: Date.now() };
    return { ok: true, counts: j.counts || null };
  } catch (_) { return { ok: false }; }
}

// Batch-look up flag counts for chapter ids; returns { chapterId: {broken,missing,wrong,total}|null }.
async function flagLookup(chapterIds) {
  const base = await badgeApiBase();
  const ids = (chapterIds || []).map(String).filter(Boolean);
  if (!base || !ids.length) return { ok: false, counts: {} };
  const now = Date.now(), out = {}, need = [];
  ids.forEach((id) => { const m = _flagMem[id]; if (m && (now - m.at) < _FLAG_TTL) out[id] = m.counts; else need.push(id); });
  try {
    for (let i = 0; i < need.length; i += 50) {
      const chunk = need.slice(i, i + 50);
      const hashOf = {};
      await Promise.all(chunk.map(async (id) => { hashOf[await flagChapterHash(id)] = id; }));
      const hashes = Object.keys(hashOf);
      const resp = await fetch(base + '/v1/flags?ids=' + encodeURIComponent(hashes.join(',')));
      const j = resp.ok ? await resp.json() : {};
      hashes.forEach((h) => { const id = hashOf[h]; const c = (j && j[h]) || null; _flagMem[id] = { counts: c, at: now }; out[id] = c; });
    }
  } catch (_) {}
  return { ok: true, counts: out };
}

// Firefox exposes `browser` in addition to `chrome`; Chrome does not.
// In Firefox Android, blob: URLs created in a service worker cannot be resolved
// by the downloads API, so we use base64 data: URLs there instead.
const _IS_FIREFOX = typeof browser !== 'undefined';

// ── État global ───────────────────────────────────────────────────────────────

/** Map { tabId (chapitre) → { chapterUrl, zipName, originTabId } } */
const pendingDownloads = new Map();

/** File d'attente pour éviter les ZIP simultanés */
let isDownloading = false;
const downloadQueue = [];

/** Flag d'annulation du téléchargement groupé */
let downloadAllAbortFlag = false;
// Resolvers woken the instant a cancel is requested, so the worker pool / packer
// can stop awaiting in-flight chapters immediately instead of hanging forever.
let _downloadAllAbortResolvers = [];
function _signalDownloadAllAbort() {
  downloadAllAbortFlag = true;
  const waiters = _downloadAllAbortResolvers;
  _downloadAllAbortResolvers = [];
  for (const fn of waiters) { try { fn(); } catch (_) {} }
}
function _resetDownloadAllAbort() {
  downloadAllAbortFlag = false;
  _downloadAllAbortResolvers = [];
}
// One reusable promise per Download-All run that resolves when cancellation is
// requested. Reused across all races so we never leak a resolver per chapter.
function _downloadAllAbortPromise() {
  if (downloadAllAbortFlag) return Promise.resolve();
  return new Promise((res) => _downloadAllAbortResolvers.push(res));
}

/** ZIP en attente de génération — conservé pour permettre un retry uniquement sur l'étape ZIP */
let _pendingZip = null;

// Fallback defaults (mirror CDLSettings.DEFAULTS). The active values for batch
// size and ZIP splitting are read from settings per operation; these remain as
// safety fallbacks. MAX_LOG_ENTRIES is cached and kept in sync via onChange.
const BATCH_SIZE = 3;
let MAX_LOG_ENTRIES = 500;
const ZIP_PART_MAX_CHAPTERS = 5;
const ZIP_PART_MAX_BYTES = 300 * 1024 * 1024;
const DOWNLOAD_ALL_LOG_LIMIT = 150;
const DOWNLOAD_ALL_TERMINAL_SESSION_TTL_MS = 2 * 60 * 1000;

// Keep the activity-log cap in sync with user settings (cheap, read often), and
// keep the subscribe alarm aligned with subscribe.enabled / interval changes.
if (typeof CDLSettings !== 'undefined') {
  CDLSettings.getSettings().then((cfg) => { MAX_LOG_ENTRIES = cfg['logs.maxEntries'] || 500; }).catch(() => {});
  CDLSettings.onChange((cfg) => { MAX_LOG_ENTRIES = cfg['logs.maxEntries'] || 500; try { setupSubscribeAlarm(); } catch (_) {} });
}

let downloadAllSession = null;

// ── One-time "what's new" notices ─────────────────────────────────────────────
// On install/update we flag headline additions and badge the toolbar icon so
// existing users notice them. The options page clears each flag (and the badge,
// once no notice remains) when the user opens the relevant tab.
//   • cdlFeaturesNotice    → the Additional Features tab (see options.js)
//   • cdlConcurrencyNotice → the "Chapters at once" option on the Download tab
const FEATURES_NOTICE_VERSION = '2.0.2';
const CONCURRENCY_NOTICE_VERSION = '2.1.0';

// Toolbar "NEW" icon badge removed per user preference — intentionally a no-op so existing
// callers stay harmless. The download-progress badge (setProgressBadge) is unaffected.
function _setNewToolbarBadge() {}
function _clearToolbarBadge() {
  try { if (chrome.action && chrome.action.setBadgeText) chrome.action.setBadgeText({ text: '' }); } catch (_) {}
}

// Live Download-All progress on the toolbar icon (overrides the NEW badge while
// running). Restored to NEW / cleared when the run ends.
function setProgressBadge(completed, total) {
  try {
    if (!(chrome.action && chrome.action.setBadgeText)) return;
    let text = '';
    if (total > 0) text = `${Math.min(99, Math.round((completed / total) * 100))}%`;
    chrome.action.setBadgeText({ text });
    if (text && chrome.action.setBadgeBackgroundColor) chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  } catch (_) {}
}
// When a download run ends, clear the toolbar badge (no more "NEW" restore).
function restoreIdleBadge() { _clearToolbarBadge(); }

// ── Right-click context menu ──────────────────────────────────────────────────
// setupContextMenus runs on both onInstalled and onStartup; if those race, the
// second create() hits a "duplicate id" — harmless, but we read runtime.lastError
// in each callback so it never surfaces as an "Unchecked runtime.lastError".
function setupContextMenus() {
  if (!chrome.contextMenus) return;
  const swallow = () => { void chrome.runtime.lastError; };
  try {
    chrome.contextMenus.removeAll(() => {
      swallow();
      try {
        chrome.contextMenus.create({
          id: 'cdl-dl-chapter', title: 'Download this chapter',
          contexts: ['link'], targetUrlPatterns: ['*://comix.to/title/*']
        }, swallow);
        chrome.contextMenus.create({
          id: 'cdl-dl-series', title: 'Download whole series (open options)',
          contexts: ['page'], documentUrlPatterns: ['*://comix.to/title/*']
        }, swallow);
      } catch (_) {}
    });
  } catch (_) {}
}

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'cdl-dl-chapter') {
      const url = info.linkUrl || '';
      if (!/\/\d+-chapter-/i.test(url)) return;
      // Best-effort name from the tab title + chapter number in the URL.
      const manga = (tab && tab.title ? tab.title.replace(/\s*[-|].*$/, '').trim() : '') || 'comix';
      let label = 'chapter';
      if (typeof CDLFeaturesCore !== 'undefined') {
        const p = CDLFeaturesCore.parseChapterNumber(url);
        if (p && p.kind === 'num' && isFinite(p.value)) label = 'Ch' + p.value;
      }
      handleDownloadRequest(url, `${manga}-${label}`, tab ? tab.id : null, {
        chapterLabel: label, mangaName: manga, seriesMeta: { title: manga, sourceUrl: url },
      });
    } else if (info.menuItemId === 'cdl-dl-series') {
      if (tab && tab.id != null) chrome.tabs.sendMessage(tab.id, { action: 'startDownloadAll' }).catch(() => {});
    }
  });
}

chrome.runtime.onInstalled.addListener(setupContextMenus);
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(setupContextMenus);
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(_clearToolbarBadge); // clear any persisted "NEW" badge

// First install → open the site's welcome page (thanks + what's new). Install only:
// updates must never steal a tab from the user.
const CDL_WELCOME_URL = 'https://n3uralcreativity.github.io/comix-downloader/welcome.html';
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'install') return;
  try { chrome.tabs.create({ url: CDL_WELCOME_URL }); } catch (_) {}
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'install' && details.reason !== 'update') return;
  _clearToolbarBadge(); // remove any lingering "NEW" badge from earlier versions
  chrome.storage.local.get(['cdlFeaturesNotice', 'cdlConcurrencyNotice']).then((res) => {
    const prevF = res && res.cdlFeaturesNotice;
    if (!(prevF && prevF.seenVersion === FEATURES_NOTICE_VERSION)) {
      chrome.storage.local.set({
        cdlFeaturesNotice: { active: true, seenVersion: (prevF && prevF.seenVersion) || null }
      });
      _setNewToolbarBadge();
    }
    const prevC = res && res.cdlConcurrencyNotice;
    if (!(prevC && prevC.seenVersion === CONCURRENCY_NOTICE_VERSION)) {
      chrome.storage.local.set({
        cdlConcurrencyNotice: { active: true, seenVersion: (prevC && prevC.seenVersion) || null }
      });
      _setNewToolbarBadge();
    }
  }).catch(() => {});
});

// ── Système de logs persistants ──────────────────────────────────────────────
// Stocke les entrées dans chrome.storage.local (clé 'cdlLogs').
// Fire-and-forget : aucun await requis côté appelant.
function cdlLog(level, msg) {
  chrome.storage.local.get('cdlLogs').then(({ cdlLogs = [] }) => {
    cdlLogs.push({ ts: Date.now(), level, msg });
    if (cdlLogs.length > MAX_LOG_ENTRIES) cdlLogs.splice(0, cdlLogs.length - MAX_LOG_ENTRIES);
    chrome.storage.local.set({ cdlLogs });
  }).catch(() => {});
}

function startDownloadAllSession({ originTabId, mangaName, zipName, totalChapters }) {
  const now = Date.now();
  downloadAllSession = {
    active: true,
    status: 'running',
    originTabId,
    mangaName,
    zipName,
    totalChapters,
    chapterIndex: 0,
    imagesDone: 0,
    imagesTotal: 0,
    phase: 'preparing',
    startedAt: now,
    updatedAt: now,
    logItems: [],
    lastProgress: {
      action: 'downloadAllProgress',
      phase: 'preparing',
      chapterIndex: 0,
      totalChapters,
      chapterLabel: '',
      imagesDone: 0,
      imagesTotal: 0,
    },
  };
}

function updateDownloadAllSessionLog(progress) {
  if (!downloadAllSession || !progress.chapterLabel) return;

  const { phase, chapterLabel, imagesDone, imagesTotal } = progress;
  let cls = 'active';
  let text = '';

  if (phase === 'extracting') {
    text = `${chapterLabel} - opening...`;
  } else if (phase === 'downloading') {
    text = `${chapterLabel} - ${imagesDone}/${imagesTotal} images`;
  } else if (phase === 'done') {
    cls = 'done';
    text = `${chapterLabel} (${imagesDone} images)`;
  } else if (phase === 'error') {
    cls = 'error';
    text = `${chapterLabel} - failed`;
  } else if (phase === 'skipped') {
    cls = 'skipped';
    text = `${chapterLabel} - skipped`;
  }

  if (!text) return;

  const logItems = Array.isArray(downloadAllSession.logItems)
    ? [...downloadAllSession.logItems]
    : [];
  const existing = logItems.find((item) => item.id === chapterLabel);
  if (existing) {
    existing.cls = cls;
    existing.text = text;
  } else {
    logItems.push({ id: chapterLabel, cls, text });
  }
  if (logItems.length > DOWNLOAD_ALL_LOG_LIMIT) {
    logItems.splice(0, logItems.length - DOWNLOAD_ALL_LOG_LIMIT);
  }
  downloadAllSession.logItems = logItems;
}

function recordDownloadAllProgress(progress) {
  if (!downloadAllSession) return;
  const normalized = { action: 'downloadAllProgress', ...progress };
  Object.assign(downloadAllSession, {
    active: true,
    status: downloadAllSession.status === 'cancelling' ? 'cancelling' : 'running',
    phase: progress.phase,
    chapterIndex: progress.chapterIndex ?? downloadAllSession.chapterIndex,
    totalChapters: progress.totalChapters ?? downloadAllSession.totalChapters,
    completed: progress.completed ?? downloadAllSession.completed,
    concurrency: progress.concurrency ?? downloadAllSession.concurrency,
    imagesDone: progress.imagesDone ?? downloadAllSession.imagesDone,
    imagesTotal: progress.imagesTotal ?? downloadAllSession.imagesTotal,
    zipPart: progress.zipPart ?? downloadAllSession.zipPart,
    lastProgress: normalized,
    updatedAt: Date.now(),
  });
  updateDownloadAllSessionLog(progress);
  persistDownloadAllSession();
}

function recordDownloadAllCancelling() {
  if (!downloadAllSession) return;
  const progress = {
    action: 'downloadAllProgress',
    phase: 'cancelling',
    chapterIndex: downloadAllSession.chapterIndex || 0,
    totalChapters: downloadAllSession.totalChapters || 0,
    chapterLabel: '',
    imagesDone: downloadAllSession.imagesDone || 0,
    imagesTotal: downloadAllSession.imagesTotal || 0,
  };
  Object.assign(downloadAllSession, {
    active: true,
    status: 'cancelling',
    phase: 'cancelling',
    lastProgress: progress,
    updatedAt: Date.now(),
  });
  persistDownloadAllSession(true);
}

function recordDownloadAllTerminal(status, patch = {}) {
  if (!downloadAllSession) {
    downloadAllSession = {
      active: false,
      status,
      originTabId: patch.originTabId ?? null,
      mangaName: '',
      zipName: '',
      totalChapters: 0,
      logItems: [],
      startedAt: Date.now(),
    };
  }
  Object.assign(downloadAllSession, {
    active: false,
    status,
    ...patch,
    updatedAt: Date.now(),
  });
  persistDownloadAllSession(true);
}

// ── Durable session (survives MV3 service-worker eviction/crash) ──────────────
// downloadAllSession lives in the worker's memory, which Chrome discards when the
// worker is evicted (idle) or crashes. Persisting a serializable snapshot lets a page
// refresh rebuild the progress popup even after the worker was torn down mid-download.
const DL_SESSION_KEY = 'cdlDownloadAllSession';
let _dlPersistTimer = null;
function _serializeSession(s) {
  if (!s) return null;
  const keys = ['active', 'status', 'originTabId', 'mangaName', 'zipName', 'totalChapters',
    'chapterIndex', 'completed', 'concurrency', 'imagesDone', 'imagesTotal', 'phase', 'zipPart',
    'startedAt', 'updatedAt', 'lastProgress', 'lastError', 'lastDone', 'lastCancelled',
    'doneZipName', 'error', 'canRetryZip'];
  const out = {};
  for (const k of keys) if (s[k] !== undefined) out[k] = s[k];
  out.logItems = Array.isArray(s.logItems) ? s.logItems.slice(-60) : []; // cap so storage stays small
  return out;
}
function persistDownloadAllSession(force = false) {
  const write = () => { _dlPersistTimer = null; try { chrome.storage.local.set({ [DL_SESSION_KEY]: _serializeSession(downloadAllSession) }); } catch (_) {} };
  if (force) { if (_dlPersistTimer) { clearTimeout(_dlPersistTimer); _dlPersistTimer = null; } write(); return; }
  if (_dlPersistTimer) return; // throttle live progress writes to ~1/sec
  _dlPersistTimer = setTimeout(write, 1000);
}
function clearPersistedSession() {
  if (_dlPersistTimer) { clearTimeout(_dlPersistTimer); _dlPersistTimer = null; }
  try { chrome.storage.local.remove(DL_SESSION_KEY); } catch (_) {}
}
async function loadPersistedSession() {
  try { const r = await chrome.storage.local.get(DL_SESSION_KEY); return (r && r[DL_SESSION_KEY]) || null; } catch (_) { return null; }
}

// Async session lookup used by the getDownloadAllSession message. When there is no in-memory
// session (fresh worker after eviction/crash), fall back to the persisted one — and if it was
// still marked "running", the worker that was running it is gone, so present it as interrupted
// (so the popup restores with a Retry instead of a forever-spinning bar).
async function getDownloadAllSessionForTabAsync(tabId) {
  if (!downloadAllSession) {
    const stored = await loadPersistedSession();
    if (stored) {
      if (stored.active || stored.status === 'running' || stored.status === 'cancelling') {
        stored.active = false;
        stored.status = 'error';
        stored.error = 'Download interrupted — the browser or extension restarted. Click “Download All” again to restart it.';
        stored.canRetryZip = false;
        stored.lastError = { action: 'downloadAllError', error: stored.error, canRetryZip: false };
      }
      downloadAllSession = stored;
      persistDownloadAllSession(true);
    }
  }
  return getDownloadAllSessionForTab(tabId);
}

function getDownloadAllSessionForTab(tabId) {
  if (!downloadAllSession) return null;
  if (
    downloadAllSession.originTabId != null &&
    tabId != null &&
    downloadAllSession.originTabId !== tabId
  ) {
    return null;
  }
  if (
    !downloadAllSession.active &&
    Date.now() - (downloadAllSession.updatedAt || 0) > DOWNLOAD_ALL_TERMINAL_SESSION_TTL_MS
  ) {
    return null;
  }
  return downloadAllSession;
}

function dismissDownloadAllSessionForTab(tabId) {
  if (!downloadAllSession) return;
  if (
    downloadAllSession.originTabId != null &&
    tabId != null &&
    downloadAllSession.originTabId !== tabId
  ) {
    return;
  }
  if (!downloadAllSession.active) { downloadAllSession = null; clearPersistedSession(); }
}

function notifyDownloadAllProgress(originTabId, progress) {
  recordDownloadAllProgress(progress);
  if (typeof progress.completed === 'number' && progress.totalChapters) {
    setProgressBadge(progress.completed, progress.totalChapters);
  }
  notifyTab(originTabId, { action: 'downloadAllProgress', ...progress });
}

function notifyDownloadAllDone(originTabId, zipName) {
  const message = { action: 'downloadAllDone', zipName };
  recordDownloadAllTerminal('done', {
    originTabId,
    doneZipName: zipName,
    lastDone: message,
  });
  restoreIdleBadge();
  notifyTab(originTabId, message);
}

function notifyDownloadAllError(originTabId, error, canRetryZip = false) {
  const message = { action: 'downloadAllError', error, canRetryZip };
  recordDownloadAllTerminal('error', {
    originTabId,
    error,
    canRetryZip,
    lastError: message,
  });
  restoreIdleBadge();
  notifyTab(originTabId, message);
}

function notifyDownloadAllCancelled(originTabId) {
  const message = { action: 'downloadAllCancelled' };
  recordDownloadAllTerminal('cancelled', {
    originTabId,
    lastCancelled: message,
  });
  restoreIdleBadge();
  notifyTab(originTabId, message);
}

// ── Réception des messages depuis content_title.js ───────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'downloadChapter') {
    const originTabId = sender.tab?.id ?? null;
    sendResponse({ ok: true }); // ack first so a fault in setup never reads as "connection failed"
    Promise.resolve()
      .then(() => handleDownloadRequest(message.chapterUrl, message.zipName, originTabId, message.options))
      .catch((e) => { try { cdlLog('error', 'Download failed: ' + (e?.message || e)); } catch (_) {}
        notifyDownloadAllError(originTabId, 'Download failed: ' + (e?.message || 'unexpected error')); });
    return true;
  }

  if (message.action === 'downloadAllChapters') {
    const originTabId = sender.tab?.id ?? null;
    sendResponse({ ok: true }); // ack synchronously so a slow/faulty start never surfaces as "connection failed"
    _resetDownloadAllAbort();
    // Fire-and-forget, but ALWAYS catch: an unhandled rejection here can take down the MV3
    // service worker (and make the next Retry fail with "connection failed").
    Promise.resolve()
      .then(() => handleDownloadAllRequest(message.chapters, message.mangaName, message.zipName, originTabId, message.options))
      .catch((e) => { try { cdlLog('error', 'Download All failed: ' + (e?.message || e)); } catch (_) {}
        notifyDownloadAllError(originTabId, 'Download failed: ' + (e?.message || 'unexpected error')); });
    return true;
  }

  if (message.action === 'cancelDownloadAll') {
    _signalDownloadAllAbort();
    recordDownloadAllCancelling();
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'retryZip') {
    const originTabId = sender.tab?.id ?? null;
    sendResponse({ ok: true });
    if (_pendingZip) {
      Promise.resolve().then(() => _doZipAndSave(_pendingZip))
        .catch((e) => notifyDownloadAllError(originTabId, 'ZIP retry failed: ' + (e?.message || 'unexpected error')));
    } else {
      notifyDownloadAllError(originTabId, 'Session expired - please restart Download All');
    }
    return true;
  }

  if (message.action === 'getDownloadAllSession') {
    const originTabId = sender.tab?.id ?? null;
    // Async: may need to read the persisted session when the worker was restarted.
    getDownloadAllSessionForTabAsync(originTabId)
      .then((session) => sendResponse({ ok: true, session }))
      .catch(() => sendResponse({ ok: true, session: null }));
    return true;
  }

  if (message.action === 'dismissDownloadAllSession') {
    const originTabId = sender.tab?.id ?? null;
    dismissDownloadAllSessionForTab(originTabId);
    sendResponse({ ok: true });
    return true;
  }

  // ── Phase 2: subscriptions + library ──
  if (message.action === 'subscribe') {
    subscribeSeries(message.slug, message.mangaName).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.action === 'unsubscribe') {
    unsubscribeSeries(message.slug).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.action === 'checkSubscriptionsNow') {
    // Manual trigger: always check (force), even when the master toggle is off,
    // and report a summary so the options page can show what happened.
    checkAllSubscriptions(true).then((summary) => sendResponse({ ok: true, summary })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.action === 'libraryTest') {
    testLibrary(message.config).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  // Request the optional host permission for a library server. Content scripts
  // can't call chrome.permissions, so the native settings embed routes it here.
  // (A user gesture may not carry across the message; the caller falls back to
  // opening the options page, where the grant always works.)
  if (message.action === 'libraryGrant') {
    try {
      chrome.permissions.request({ origins: [message.origin] }, (granted) => {
        const err = chrome.runtime.lastError;
        sendResponse({ ok: !err && !!granted, granted: !!granted, error: err && err.message });
      });
    } catch (e) { sendResponse({ ok: false, error: e.message }); }
    return true;
  }
  // Tenure-badge: register the current user (server-timestamped) and look up others'
  // first-seen dates. Network happens here (SW has host permission → no CORS issues).
  if (message.action === 'cdlBadgeRegister') {
    badgeRegister(message.hashId).then((r) => sendResponse(r)).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.action === 'cdlBadgeLookup') {
    badgeLookup(message.hashId).then((r) => sendResponse(r)).catch(() => sendResponse({ ok: false }));
    return true;
  }
  // Crowd quality flags: submit a flag / batch-look up chapter flag counts.
  if (message.action === 'cdlFlagSubmit') {
    flagSubmit(message.chapterId, message.userHashId, message.type).then((r) => sendResponse(r)).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.action === 'cdlFlagLookup') {
    flagLookup(message.chapterIds).then((r) => sendResponse(r)).catch(() => sendResponse({ ok: false, counts: {} }));
    return true;
  }
  if (message.action === 'openOptions') {
    try {
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else chrome.tabs.create({ url: chrome.runtime.getURL('legacy/options.html') });
    } catch (_) {}
    sendResponse({ ok: true });
    return true;
  }
  // Content script reports comix's active theme → recolour the toolbar icon.
  if (message.action === 'cdlIconTheme') {
    setThemedIcon({ name: message.name });
    sendResponse({ ok: true });
    return false;
  }
  // Popup's Settings button was clicked → dismiss the "what's new" notices and
  // the toolbar NEW badge (until the next update).
  if (message.action === 'dismissNew') {
    try {
      const ver = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || null;
      chrome.storage.local.set({
        cdlFeaturesNotice: { active: false, seenVersion: ver },
        cdlConcurrencyNotice: { active: false, seenVersion: ver },
      });
      if (chrome.action && chrome.action.getBadgeText) {
        chrome.action.getBadgeText({}, (txt) => { if (txt === 'NEW') chrome.action.setBadgeText({ text: '' }); });
      }
    } catch (_) {}
    sendResponse({ ok: true });
    return false;
  }

});

// ── Toolbar icon follows comix.to's theme ─────────────────────────────────────
// comix's accent is cyan on "Main" and purple on Dark/Light, so we swap between
// pre-rendered icon sets (no OffscreenCanvas → reliable in the worker). Driven by
// the cdlSiteTheme the content script captures (storage event + a direct message).
function setThemedIcon(theme) {
  try {
    if (!chrome.action || !chrome.action.setIcon) return;
    const name = theme && theme.name;
    // Main = cyan on dark, Light = purple on white, Dark/default = purple on dark.
    const base = name === 'main' ? 'icons/icon-cyan' : name === 'light' ? 'icons/icon-light' : 'icons/icon';
    chrome.action.setIcon({ path: { 16: base + '16.png', 48: base + '48.png', 128: base + '128.png' } });
  } catch (_) {}
}
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.cdlSiteTheme) setThemedIcon(changes.cdlSiteTheme.newValue);
  });
  chrome.storage.local.get('cdlSiteTheme', (r) => setThemedIcon(r && r.cdlSiteTheme));
} catch (_) {}

// ── Logique principale ────────────────────────────────────────────────────────

// Extraction tabs are opened in the background (active:false). comix.to's reader
// throttles its own loading while it thinks the tab is hidden, so a background
// extraction crawls and times out. We add a #cdlx marker to the tab URL; the
// document_start MAIN-world content script (scripts/visibility-shim.js) sees it and
// makes the page report itself visible, so loading runs at full speed without the
// user needing to focus the tab. The marker is a URL hash — it never reaches the
// server, and it only ever appears on these throwaway tabs, never on a page the user
// is reading. The original (marker-free) URL is kept everywhere else for naming/fetch.
function withExtractMarker(url) {
  try { const u = new URL(url); u.hash = 'cdlx'; return u.href; }
  catch (_) { return String(url).split('#')[0] + '#cdlx'; }
}

async function handleDownloadRequest(chapterUrl, zipName, originTabId, options) {
  cdlLog('info', `Download started: ${zipName}`);
  const cfg = await loadCfg();
  try {
    // Ouvrir un onglet en arrière-plan
    const tab = await chrome.tabs.create({
      url: withExtractMarker(chapterUrl),
      active: false,
      pinned: false,
    });

    pendingDownloads.set(tab.id, { chapterUrl, zipName, originTabId, cfg, options });
  } catch (err) {
    console.error('[ComixDL] Impossible d\'ouvrir l\'onglet:', err);
    cdlLog('error', `Cannot open tab: ${err.message}`);
    notifyTab(originTabId, {
      action: 'downloadError',
      chapterUrl,
      error: 'Impossible d\'ouvrir la page du chapitre',
    });
  }
}

// ── Listener sur l'état des onglets ──────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!pendingDownloads.has(tabId)) return;
  if (changeInfo.status !== 'complete') return;

  const { chapterUrl, zipName, originTabId, cfg, options } = pendingDownloads.get(tabId);
  pendingDownloads.delete(tabId);

  try {
    // Injecter le script d'extraction dans l'onglet chapitre
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',   // share the page's Resource Timing buffer (canvas-page URLs)
      func: extractChapterImagesFromPage,
      args: [{
        aggressive: !!(cfg && cfg['advanced.aggressiveRetrieval']),
        pollMs: cfg && cfg['perf.pagePollMs'],
        settleMs: cfg && cfg['perf.pageSettleMs'],
        scrollSettleMs: cfg && cfg['perf.scrollSettleMs'],
      }],
    });

    // Fermer l'onglet dès que possible
    chrome.tabs.remove(tabId).catch(() => {});

    let images = results?.[0]?.result;
    if (!Array.isArray(images) || images.length === 0) {
      throw new Error('Aucune image trouvée dans ce chapitre');
    }
    images = await verifyEnumeratedImages(images, zipName);

    cdlLog('info', `Extracted ${images.length} images for ${zipName}`);
    // Lancer le téléchargement + ZIP directement dans le service worker
    scheduleDownload({ images, chapterUrl, zipName, originTabId, cfg, options });
  } catch (err) {
    chrome.tabs.remove(tabId).catch(() => {});
    console.error('[ComixDL] Extraction échouée:', err);
    cdlLog('error', `Extraction failed (${zipName}): ${err.message}`);
    notifyTab(originTabId, {
      action: 'downloadError',
      chapterUrl,
      error: err.message || 'Extraction des images échouée',
    });
  }
});

// ── Nettoyage des onglets fermés avant extraction ─────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingDownloads.delete(tabId);
});

// ── Fonction d'extraction injectée dans la page chapitre ──────────────────────
// IMPORTANT : entièrement auto-contenue (pas de closures externes — elle est
// sérialisée puis ré-exécutée dans la page par chrome.scripting.executeScript).
//
// The 2026 comix.to reader renders pages as <img class="rpage-page__img"
// alt="Page N" src="<opaque url>"> in a *virtualized* list; the URLs are opaque
// and extension-less, so the old "derive 01.webp..NN.webp and enumerate" trick no
// longer works. Strategies, newest first:
//   0. The page list captured by scripts/extract-bridge.js from the reader's own
//      (decrypted) chapters API — instant and works in a BACKGROUND tab with no
//      scrolling/rendering. This is the primary path.
//   A. Re-fetch the raw server HTML and parse every rpage-page__img out of it.
//   B. Drive the live (virtualized) reader, harvesting page images while scrolling
//      (only works while the tab is focused — kept as a fallback).
//   C. Last resort: the legacy __NEXT_DATA__ + sequential-URL enumeration.
async function extractChapterImagesFromPage(opts) {
  opts = opts || {};
  const aggressive = !!opts.aggressive;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── STRATEGY 0: page list captured by scripts/extract-bridge.js ──────────────
  // The bridge (document_start, MAIN world) grabs the reader's decrypted chapters
  // API and exposes window.__cdlPages = [{src,index}]. It arrives within ~1s of load
  // regardless of tab focus, so it both fixes background extraction and skips the
  // slow scroll entirely. Poll briefly in case extraction is injected before it lands.
  {
    const deadline = Date.now() + (aggressive ? 6000 : 12000);
    while (Date.now() < deadline) {
      const pages = window.__cdlPages;
      if (Array.isArray(pages) && pages.length) {
        return pages
          .filter((p) => p && /^https?:/i.test(p.src))
          .map((p, i) => ({ src: p.src, index: p.index || (i + 1) }))
          .sort((a, b) => a.index - b.index);
      }
      await sleep(150);
    }
  }

  // Past this point we drive the live reader (strategies A/B), which the browser
  // throttles in a background tab — kept only as a fallback for when the bridge
  // (strategy 0) didn't capture the page list (e.g. the user is on the tab and the
  // API format changed). Scrambled pages render to <canvas> with no DOM src; their
  // image URL is only visible as a network fetch, recovered below from the Resource
  // Timing buffer — so make sure a long chapter's entries are not evicted (cap ~250).
  // visible as a network fetch, recovered below from the Resource Timing buffer —
  // so make sure a long chapter's entries are not evicted (default cap is ~250).
  try { performance.setResourceTimingBufferSize(5000); } catch (_) {}

  // User-tunable render/scroll waits (defaults == previous hardcoded literals).
  // Aggressive mode halves the poll/settle waits, exactly as before.
  const pollMs        = aggressive ? Math.round((opts.pollMs   || 400) / 2) : (opts.pollMs   || 400);
  const settleMs      = aggressive
    ? Math.round((opts.settleMs != null ? opts.settleMs : 300) / 2)
    : (opts.settleMs != null ? opts.settleMs : 300);
  const scrollSettleMs = opts.scrollSettleMs != null ? opts.scrollSettleMs : 800;

  // ── STRATEGIES A & B (new reader) ───────────────────────────────────────────
  // Wrapped in a block so locals (total, retries, …) don't clash with the legacy
  // strategy 1/2 declarations below. Early `return` still exits the function.
  {
    // Inline copy of CDLFeaturesCore.parseReaderImages — KEEP IN SYNC.
    const decodeEntities = (s) => String(s == null ? '' : s)
      .replace(/&#39;/g, "'").replace(/&#x27;/gi, "'").replace(/&quot;/g, '"')
      .replace(/&#x2F;/gi, '/').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const parseReaderImages = (html, baseUrl) => {
      if (!html) return [];
      const byIndex = new Map();
      const tags = String(html).match(/<img\b[^>]*>/gi) || [];
      for (const tag of tags) {
        if (!/\brpage-page__img\b/.test(tag)) continue;
        const srcM = tag.match(/\bsrc\s*=\s*"([^"]+)"/i) || tag.match(/\bsrc\s*=\s*'([^']+)'/i);
        if (!srcM) continue;
        let src = decodeEntities(srcM[1]).trim();
        if (!src || /^data:/i.test(src)) continue;
        try { src = new URL(src, baseUrl || location.href).href; } catch (_) {}
        const altM = tag.match(/\balt\s*=\s*"[^"]*?(\d+)[^"]*"/i) || tag.match(/\balt\s*=\s*'[^']*?(\d+)[^']*'/i);
        const index = altM ? parseInt(altM[1], 10) : (byIndex.size + 1);
        if (!byIndex.has(index)) byIndex.set(index, { src, index });
      }
      return [...byIndex.values()].sort((a, b) => a.index - b.index);
    };

    // Best-effort total from the reader's "N / M" text + the highest data-page in
    // the DOM. Used to know when we've collected every page.
    const detectTotal = () => {
      const text = document.body ? (document.body.textContent || '') : '';
      const freq = {};
      for (const m of text.matchAll(/\b\d+\s*\/\s*(\d+)\b/g)) {
        const d = parseInt(m[1], 10);
        if (d > 1 && d < 2000) freq[d] = (freq[d] || 0) + 1;
      }
      let best = 0, bestCnt = 0;
      for (const k in freq) { if (freq[k] > bestCnt) { bestCnt = freq[k]; best = parseInt(k, 10); } }
      let maxDataPage = 0;
      document.querySelectorAll('[data-page]').forEach((el) => {
        const n = parseInt(el.getAttribute('data-page'), 10);
        if (isFinite(n) && n > maxDataPage) maxDataPage = n;
      });
      return Math.max(best, maxDataPage);
    };

    // ── STRATEGY A: raw server HTML (carries all pages, pre-virtualization) ──────
    let ssr = null;
    try {
      const resp = await fetch(location.href, { headers: { Accept: 'text/html' }, credentials: 'include' });
      if (resp.ok) {
        const imgs = parseReaderImages(await resp.text(), location.href);
        if (imgs.length) {
          const total = detectTotal();
          if (total <= 0 || imgs.length >= total) return imgs;
          ssr = imgs; // partial SSR — let strategy B try to complete it
        }
      }
    } catch (_) {}

    // ── STRATEGY B: drive the virtualized long-strip reader ─────────────────────
    // Some pages render as <img src> (URL in the DOM); the SCRAMBLED ones render as
    // <canvas> with NO src — their image URL only ever appears as a network fetch.
    // So we (a) harvest <img> src by page number, and (b) read the page-image loads
    // from the Resource Timing API. The CDN fetches pages in strict page order
    // (verified: 0 inversions), so we pair the leftover (canvas) URLs to the missing
    // page numbers by fetch time. The service worker un-scrambles them on download
    // via the X-Scramble-* response headers. Runs in the MAIN world (world:'MAIN' at
    // the injection sites) so it shares the page's Resource Timing buffer.
    const isReaderPage = () => !!document.querySelector('.rpage-page__img, img[alt^="Page"], [data-page]');
    let waitB = aggressive ? 8 : 25;
    while (waitB-- > 0) {
      if (document.querySelector('.rpage-page__img, img[alt^="Page"]')) break;
      await sleep(pollMs);
    }
    if (ssr || isReaderPage()) {
      await sleep(settleMs);

      const imgMap = new Map(); // page index -> url (from <img src>); authoritative
      const harvestImgs = () => {
        document.querySelectorAll('img.rpage-page__img, img[alt^="Page"]').forEach((img) => {
          const url = img.currentSrc || img.src || '';
          if (!/^https?:/i.test(url) || /^data:/i.test(url)) return;
          let idx = parseInt((img.getAttribute('alt') || '').replace(/\D+/g, ''), 10);
          if (!isFinite(idx) || idx <= 0) { const w = img.closest && img.closest('[data-page]'); idx = w ? parseInt(w.getAttribute('data-page'), 10) : NaN; }
          if (isFinite(idx) && idx > 0 && !imgMap.has(idx)) imgMap.set(idx, url);
        });
      };
      // Page-image URL prefixes (origin + first path segment) learned from the <img>
      // pages, so canvas-page loads can be picked out of the resource list without
      // hard-coding a CDN host.
      const prefixesOf = () => { const p = new Set(); for (const u of imgMap.values()) { const m = String(u).match(/^(https?:\/\/[^/]+\/[^/]+\/)/i); if (m) p.add(m[1]); } return p; };
      const pageImgSeq = () => {
        const pre = prefixesOf(); if (!pre.size) return [];
        const seen = new Set(); const out = [];
        for (const e of performance.getEntriesByType('resource')) {
          const u = e.name; if (seen.has(u)) continue;
          for (const p of pre) { if (u.indexOf(p) === 0) { seen.add(u); out.push({ url: u, t: e.startTime }); break; } }
        }
        out.sort((a, b) => a.t - b.t);
        return out;
      };

      // Total pages: counter text + the [data-page] wrappers (all present up front).
      const dpMax = Math.max(0, ...[...document.querySelectorAll('[data-page]')].map((e) => parseInt(e.getAttribute('data-page'), 10) || 0));
      let pageCount = Math.max(detectTotal(), dpMax);

      // Find the real scroll container (first scrollable ancestor of a page cell).
      let sc = document.querySelector('.rpage-page__img, img[alt^="Page"], [data-page]');
      sc = sc && sc.parentElement;
      while (sc && sc !== document.documentElement) {
        const cs = getComputedStyle(sc);
        if (/(auto|scroll)/.test(cs.overflowY) && sc.scrollHeight > sc.clientHeight + 40) break;
        sc = sc.parentElement;
      }
      sc = sc || document.scrollingElement || document.documentElement;

      // Scroll top→bottom so every page mounts and fetches; stop once all pages have
      // been requested (or after a few passes). Harvest <img> srcs as we pass.
      // The reader uses CSS scroll-behavior:smooth, which makes absolute scrollTop
      // jumps lag and never reach the bottom; force instant scrolling.
      try { sc.style.scrollBehavior = 'auto'; } catch (_) {}
      const step = Math.max(300, Math.round((sc.clientHeight || window.innerHeight || 800) * 0.6));
      const scrollWait = aggressive ? 60 : 100;
      const maxSteps = 4000;
      // One progressive pass: scroll the virtual list down in RELATIVE steps (so a
      // clamping/virtualized scroller mounts content as we go), stopping once every
      // page has been requested. Retry briefly when a step doesn't advance (content
      // still mounting); give up once the position truly stops moving.
      const scrollPass = async () => {
        let stuck = 0;
        for (let i = 0; i < maxSteps; i++) {
          const before = sc.scrollTop;
          sc.scrollTop = before + step;
          await sleep(scrollWait);
          harvestImgs();
          if (sc.scrollTop <= before + 2) { if (++stuck >= 4) break; await sleep(settleMs); } else stuck = 0;
          if (imgMap.size) pageCount = Math.max(pageCount, Math.max(...imgMap.keys()));
          if (pageCount > 0 && pageImgSeq().length >= pageCount) break;
        }
        await sleep(aggressive ? 400 : 900); // let the last in-flight requests land
      };
      harvestImgs();
      await scrollPass();
      // If some pages still haven't fetched, sweep once more from the top.
      if (pageCount > 0 && pageImgSeq().length < pageCount) { sc.scrollTop = 0; await sleep(settleMs); await scrollPass(); }
      if (imgMap.size) pageCount = Math.max(pageCount, Math.max(...imgMap.keys()));

      const collected = new Map();
      if (ssr) for (const it of ssr) collected.set(it.index, it);
      for (const [idx, url] of imgMap) collected.set(idx, { src: url, index: idx });

      // Fill the remaining (canvas) page numbers from the page-image fetch sequence,
      // in order. Skip URLs already bound to an <img> page so anchors stay correct.
      const imgUrlSet = new Set(imgMap.values());
      const leftover = pageImgSeq().map((e) => e.url).filter((u) => !imgUrlSet.has(u));
      const missing = [];
      for (let n = 1; n <= pageCount; n++) if (!collected.has(n)) missing.push(n);
      for (let i = 0; i < missing.length && i < leftover.length; i++) collected.set(missing[i], { src: leftover[i], index: missing[i] });

      const domImgs = [...collected.values()].sort((a, b) => a.index - b.index);
      if (domImgs.length) return domImgs;
    }
  }

  // ── STRATÉGIE 1 : __NEXT_DATA__ de Next.js ──────────────────────────────────
  // comix.to est un site Next.js : les props de page (incl. URLs des images)
  // sont sérialisées dans <script id="__NEXT_DATA__">.
  // On cherche n'importe quelle URL avec un nom de fichier numérique (01.webp,
  // 001.jpg, etc.) sur n'importe quel domaine CDN, puis on groupe par chemin
  // de base pour trouver le jeu d'images qui constitue le chapitre.
  const tryNextData = (knownTotal = 0) => {
    try {
      const sources = [];
      if (typeof window.__NEXT_DATA__ !== 'undefined') {
        sources.push(JSON.stringify(window.__NEXT_DATA__));
      }
      const scriptEl = document.getElementById('__NEXT_DATA__');
      if (scriptEl) sources.push(scriptEl.textContent || '');

      for (const raw of sources) {
        if (!raw) continue;

        // Trouver toutes les URLs d'images à nom de fichier numérique, quel que
        // soit le domaine CDN ou le format (webp, jpg, jpeg, png, avif…)
        const allUrls = raw.match(/https?:\/\/[^\s"'<>\\]+\/\d+\.(webp|jpg|jpeg|png|avif)/gi) || [];

        // Nettoyer les éventuelles échappées JSON (\/ ou \u002F)
        const cleaned = [...new Set(
          allUrls.map(u => u.replace(/\\u002[Ff]/g, '/').replace(/\\\//g, ''))
        )];
        if (cleaned.length < 2) continue;

        // Grouper par URL de base (tout avant le nom de fichier numérique)
        const groups = {};
        for (const url of cleaned) {
          const m = url.match(/^(https?:\/\/.+\/)(\d+)(\.\w+)$/i);
          if (!m) continue;
          const base = m[1];
          if (!groups[base]) groups[base] = [];
          groups[base].push({ url, num: parseInt(m[2], 10), digits: m[2].length, ext: m[3] });
        }

        // Choisir le groupe avec le plus d'images (= pages du chapitre)
        let best = null, bestLen = 0;
        for (const items of Object.values(groups)) {
          if (items.length > bestLen) { best = items; bestLen = items.length; }
        }

        if (!best || best.length < 2) continue;

        best.sort((a, b) => a.num - b.num);

        // Chercher le total de pages dans les métadonnées JSON (champs courants
        // dans les APIs de lecteurs manga Next.js). Permet de détecter un
        // __NEXT_DATA__ partiel sans avoir besoin du DOM.
        let effectiveTotal = knownTotal;
        const metaRe = /"(?:pageCount|page_count|totalPages|total_pages|pagesCount|pages_count|imagesCount|images_count|nbPages|nb_pages|pages_total|img_count)"\s*:\s*(\d{1,4})\b/gi;
        for (const mm of raw.matchAll(metaRe)) {
          const n = parseInt(mm[1], 10);
          if (n > best.length && n < 500 && n > effectiveTotal) effectiveTotal = n;
        }

        // Si on connaît déjà le total réel et que le JSON ne l'a pas complet,
        // on retourne quand même les URLs trouvées + on complète par énumération.
        if (effectiveTotal > best.length) {
          const { url, digits, ext } = best[0];
          const baseUrl = url.match(/^(https?:\/\/.+\/)(\d+)(\.\w+)$/i)[1];
          return Array.from({ length: effectiveTotal }, (_, i) => ({
            src: `${baseUrl}${String(i + 1).padStart(digits, '0')}${ext}`,
            index: i + 1,
          }));
        }

        return best.map((item, i) => ({ src: item.url, index: i + 1 }));
      }
    } catch (_) {}
    return null;
  };

  // Premier essai sans total connu (utilise uniquement ce qui est dans le JSON)
  const fromNextDataRaw = tryNextData();
  if (fromNextDataRaw && fromNextDataRaw.length >= 2) {
    // Vérification rapide du vrai total via textContent (server-rendered, toujours
    // disponible même en onglet arrière-plan). __NEXT_DATA__ ne contient parfois
    // que les N premières images (ex. 10 / 25) ; le texte "N / M" révèle le vrai total.
    const quickTotal = (() => {
      const text = document.body.textContent || '';
      const freq = {};
      for (const m of text.matchAll(/\b\d+\s*\/\s*(\d+)\b/g)) {
        const d = parseInt(m[1], 10);
        if (d > 1 && d < 1000) freq[d] = (freq[d] || 0) + 1;
      }
      let best = 0, bestCnt = 0;
      for (const [d, cnt] of Object.entries(freq)) {
        const n = parseInt(d, 10);
        if (cnt > bestCnt) { best = n; bestCnt = cnt; }
      }
      return best;
    })();

    if (quickTotal > fromNextDataRaw.length) {
      // __NEXT_DATA__ partiel → réessayer avec le vrai total pour énumérer complètement
      const completed = tryNextData(quickTotal);
      if (completed) return completed;
      // Échec énumération → continuer vers stratégie 2 (DOM + scroll)
    } else {
      // textContent confirme ou ne dépasse pas → __NEXT_DATA__ est complet
      return fromNextDataRaw;
    }
  }

  // ── STRATÉGIE 2 : pattern d'URL + énumération séquentielle ──────────────────

  // 1. Attendre qu'au moins un img[alt^="Page"] soit dans le DOM
  // (aggressive mode shortens the waits — faster but may miss late-loading pages)
  let retries = aggressive ? 8 : 25;
  while (retries-- > 0) {
    if (document.querySelectorAll('img[alt^="Page"]').length > 0) break;
    await sleep(pollMs);
  }
  await sleep(settleMs);

  // 2. Scroll léger pour déclencher le chargement de la 1ère image visible
  window.scrollTo(0, 0);
  await sleep(200);
  window.scrollTo(0, 500);
  await sleep(scrollSettleMs);
  window.scrollTo(0, 0);
  await sleep(400);

  // 3. Déterminer le nombre total de pages
  const pageImgEls = [...document.querySelectorAll('img[alt^="Page"]')];
  let total = pageImgEls.length; // minimum = images déjà dans le DOM

  // Utiliser textContent (pas innerText qui est vide sur les onglets en arrière-plan)
  const bodyText = document.body.textContent || '';

  // Compter les occurrences de chaque dénominateur dans les patterns "N / M"
  // Le lecteur affiche "4 / 30", "5 / 30", ... "30 / 30" pour chaque page non chargée
  // → le vrai total est le dénominateur qui apparaît le plus souvent ET le plus grand
  const denomCount = {};
  for (const m of bodyText.matchAll(/\b\d+\s*\/\s*(\d+)\b/g)) {
    const d = parseInt(m[1], 10);
    if (d > 1 && d < 1000) denomCount[d] = (denomCount[d] || 0) + 1;
  }
  // Prendre le dénominateur le plus fréquent parmi ceux >= total DOM actuel
  let bestDenom = 0, bestCnt = 0;
  for (const [d, cnt] of Object.entries(denomCount)) {
    const dNum = parseInt(d, 10);
    if (dNum >= total && cnt > bestCnt) { bestDenom = dNum; bestCnt = cnt; }
  }
  if (bestDenom > total) total = bestDenom;

  // Vérification via les boutons de navigation de page ("1 2 3 ... N")
  // UNIQUEMENT si le comptage par fréquence n'a pas amélioré le total :
  // sinon navNums capture aussi les numéros de chapitres (ex. 84 chapitres)
  // et écrase un total de pages correct (ex. 30).
  if (total <= pageImgEls.length) {
    const navNums = [...document.querySelectorAll('button, a, span')]
      .map(el => { const t = el.textContent.trim(); return /^\d{1,3}$/.test(t) ? parseInt(t, 10) : 0; })
      .filter(n => n > 0);
    if (navNums.length > 1 && navNums.includes(1) && navNums.includes(2)) {
      const navMax = Math.max(...navNums);
      if (navMax > total && navMax < 1000) total = navMax;
    }
  }

  // Deuxième tentative __NEXT_DATA__ maintenant que le total réel est connu :
  // si le JSON contenait moins d'images que le total, on complète par enumération.
  if (total > 0) {
    const fromNextDataFull = tryNextData(total);
    if (fromNextDataFull && fromNextDataFull.length >= total) return fromNextDataFull;
  }

  // 4. Trouver l'URL de la 1ère image réellement chargée
  const ATTRS = ['src', 'data-src', 'data-lazy-src', 'data-original'];
  const findSrc = (img) => {
    for (const attr of ATTRS) {
      const v = attr === 'src' ? img.src : img.getAttribute(attr);
      if (v && /^https?:\/\/.+\.\w{3,4}$/.test(v) && !v.includes('placeholder') && !v.includes('loading')) {
        return v;
      }
    }
    return '';
  };

  let baseSrc = '';
  for (const img of pageImgEls) {
    baseSrc = findSrc(img);
    if (baseSrc) break;
  }

  // Si aucune image chargée : scroll supplémentaire
  if (!baseSrc) {
    for (let y = 0; y <= 1500; y += 200) { window.scrollTo(0, y); await sleep(250); }
    await sleep(scrollSettleMs);
    window.scrollTo(0, 0);
    for (const img of [...document.querySelectorAll('img[alt^="Page"]')]) {
      baseSrc = findSrc(img);
      if (baseSrc) break;
    }
  }

  // Aucune image trouvable → retourner ce qu'on a dans le DOM
  if (!baseSrc) {
    return pageImgEls
      .map((img) => ({ src: findSrc(img), index: parseInt((img.alt || '').replace(/\D/g, ''), 10) || 0 }))
      .filter((x) => x.src)
      .sort((a, b) => a.index - b.index);
  }

  // 5. Parser le pattern URL : https://cdn/.../HASH/01.webp
  const urlMatch = baseSrc.match(/^(https?:\/\/.+\/)(\d+)(\.\w+)$/i);
  if (!urlMatch) {
    return pageImgEls
      .map((img) => ({ src: findSrc(img), index: parseInt((img.alt || '').replace(/\D/g, ''), 10) || 0 }))
      .filter((x) => x.src)
      .sort((a, b) => a.index - b.index);
  }

  const baseUrl   = urlMatch[1];          // "https://cdn/.../HASH/"
  const numDigits = urlMatch[2].length;   // 2 → "01", 3 → "001"
  const ext       = urlMatch[3];          // ".webp"

  if (total <= 0) total = 50; // garde-fou absolu

  // 6. Construire toutes les URLs séquentiellement
  return Array.from({ length: total }, (_, i) => ({
    src:   `${baseUrl}${String(i + 1).padStart(numDigits, '0')}${ext}`,
    index: i + 1,
  }));
}

// ── Vérification du total de pages contre le CDN ─────────────────────────────
// L'extracteur devine le total de pages depuis des fragments "N / M" du texte de
// la page puis énumère des URLs séquentielles (01.webp, 02.webp, …). Un nombre
// parasite peut empoisonner ce total (ex. 825 au lieu de 125) : la barre de
// progression affiche un faux total et des centaines d'URLs fantômes sont
// fetchées (et re-tentées) pour rien. Avant de télécharger, on sonde le CDN avec
// des requêtes Range d'1 octet + recherche dichotomique pour trouver la vraie
// dernière page, puis on tronque — ou étend — la liste. En cas de doute
// (CDN injoignable, erreur réseau) on rend la liste inchangée (fail-open).

// Reconnaît la signature de l'énumérateur : toutes les URLs partagent la même
// base + extension et les index forment exactement la séquence 1..N.
function analyzeImageSequence(images) {
  if (!Array.isArray(images) || images.length < 2) return null;
  let base = null, ext = null, digits = 0;
  const nums = [];
  for (const img of images) {
    const m = String((img && img.src) || '').match(/^(https?:\/\/.+\/)(\d+)(\.\w+)$/i);
    if (!m) return null;
    if (base === null) { base = m[1]; ext = m[3]; digits = m[2].length; }
    else if (m[1] !== base || m[3].toLowerCase() !== ext.toLowerCase()) return null;
    nums.push(parseInt(m[2], 10));
  }
  for (let i = 0; i < nums.length; i++) if (nums[i] !== i + 1) return null;
  return { base, ext, digits, count: nums.length };
}

// true = la page existe, false = absente (HTTP non-2xx ou contenu non-image),
// null = indéterminé (erreur réseau / timeout) → l'appelant doit abandonner.
async function probeImageUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      credentials: 'include',
      headers: {
        Range: 'bytes=0-0',
        Accept: 'image/webp,image/avif,image/*,*/*;q=0.8',
        Referer: 'https://comix.to/',
      },
    });
    try { if (res.body) await res.body.cancel(); } catch (_) {}
    if (!res.ok) return false;
    // Un soft-404 (page HTML d'erreur en 200) ne doit pas compter comme une page.
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    return !ct || ct.includes('image') || ct.includes('octet-stream');
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const PROBE_PAGE_CAP = 2000; // garde-fou absolu sur le nombre de pages d'un chapitre

async function verifyEnumeratedImages(images, label) {
  const seq = analyzeImageSequence(images);
  if (!seq) return images;
  const urlAt = (n) => `${seq.base}${String(n).padStart(seq.digits, '0')}${seq.ext}`;

  // Bornes de la dichotomie : lo = dernière page confirmée, hi = première absente.
  let lo, hi;
  const lastOk = await probeImageUrl(urlAt(seq.count));
  if (lastOk === null) return images;
  if (lastOk) {
    // La dernière page énumérée existe — vérifier s'il y en a d'autres au-delà
    // (total sous-estimé, ex. __NEXT_DATA__ partiel) par croissance exponentielle.
    lo = seq.count; hi = 0;
    for (let step = 1; !hi; step *= 2) {
      const n = lo + step;
      if (n > PROBE_PAGE_CAP) { hi = PROBE_PAGE_CAP + 1; break; }
      const ok = await probeImageUrl(urlAt(n));
      if (ok === null) return images;
      if (ok) lo = n; else hi = n;
    }
  } else {
    // Total surestimé — la page 1 doit exister (le pattern vient d'une vraie image).
    const firstOk = await probeImageUrl(urlAt(1));
    if (!firstOk) return images; // sonde non fiable sur ce CDN → on n'y touche pas
    lo = 1; hi = seq.count;
  }

  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const ok = await probeImageUrl(urlAt(mid));
    if (ok === null) return images;
    if (ok) lo = mid; else hi = mid;
  }

  if (lo === seq.count) return images;
  cdlLog('info', `${label}: page count corrected ${seq.count} → ${lo} (CDN probe)`);
  return Array.from({ length: lo }, (_, i) => ({ src: urlAt(i + 1), index: i + 1 }));
}


// ── File de téléchargement ────────────────────────────────────────────────────

function scheduleDownload(payload) {
  downloadQueue.push(payload);
  if (!isDownloading) processDownloadQueue();
}

function processDownloadQueue() {
  if (downloadQueue.length === 0) { isDownloading = false; return; }
  isDownloading = true;
  const payload = downloadQueue.shift();
  downloadImagesAsZip(payload)
    .catch((err) => {
      console.error('[ComixDL] ZIP error:', err);
      cdlLog('error', `ZIP error (${payload.zipName}): ${err.message}`);
      notifyTab(payload.originTabId, {
        action: 'downloadError',
        chapterUrl: payload.chapterUrl,
        error: err.message || 'Erreur inconnue',
      });
    })
    .finally(() => processDownloadQueue());
}

// ── Téléchargement + création du ZIP ─────────────────────────────────────────

async function downloadImagesAsZip({ images, chapterUrl, zipName, originTabId, cfg, options }) {
  cfg = cfg || {};
  const opts = resolveOutputOptions(cfg, options);
  const batchSize = cfg['perf.batchSize'] || BATCH_SIZE;
  const padDigits = cfg['naming.imagePadDigits'] || 3;
  const imageRetries = cfg['retry.imageRetries'] || 0;
  const zip = new JSZip();
  // Re-sequence to clean 1..N page numbers (sorted by the extractor's index) so
  // names are unique + ordered; collect then add sorted so archive entry order
  // matches reading order regardless of fetch completion order.
  const ordered = images.slice().sort((a, b) => (a.index || 0) - (b.index || 0));
  const total = ordered.length;
  let done = 0;
  const files = [];

  for (let i = 0; i < ordered.length; i += batchSize) {
    const batch = ordered.slice(i, i + batchSize);
    await Promise.allSettled(
      batch.map(async (img, k) => {
        const page = i + k + 1;
        const paddedIndex = String(page).padStart(padDigits, '0');
        const file = await fetchImageToFile(paddedIndex, img.src, cfg, imageRetries);
        if (file) { file.page = page; files.push(file); }
        done++;
        notifyTab(originTabId, { action: 'downloadProgress', chapterUrl, current: done, total });
      })
    );
  }
  files.sort((a, b) => a.page - b.page);
  for (const f of files) zip.file(f.name, f.buffer);

  // CBZ: a single chapter is itself the .cbz (flat images + optional ComicInfo.xml).
  const isCbz = opts.format === 'cbz';
  if (isCbz && opts.includeComicInfo) {
    const chapterLabel = (options && options.chapterLabel) || '';
    const mangaName = (options && options.mangaName) || (opts.seriesMeta && opts.seriesMeta.title) || '';
    const xml = buildChapterComicInfoXml(opts, chapterLabel, chapterUrl, files.length, mangaName);
    if (xml) zip.file('ComicInfo.xml', xml);
  }
  const ext = isCbz ? 'cbz' : 'zip';
  const outName = sanitizeFilename(zipName, ext);

  const { url, revoke, base64: urlBase64 } = await _zipToDownloadUrl(zip);
  try {
    await chrome.downloads.download({ url, filename: outName, saveAs: false });
    setTimeout(revoke, 60_000);
  } catch (_dlErr) {
    revoke();
    // downloads API unavailable on this platform (Firefox Android) — send ZIP
    // to the content script which can trigger a download via <a> click instead.
    if (originTabId != null) {
      const b64 = urlBase64 || await zip.generateAsync({ type: 'base64', compression: 'STORE' });
      chrome.tabs.sendMessage(originTabId, {
        action: 'triggerDownload',
        base64: b64,
        filename: outName,
      }).catch(() => {});
    } else {
      throw _dlErr;
    }
  }

  cdlLog('ok', `${ext.toUpperCase()} saved: ${outName} (${images.length} images)`);
  notifyTab(originTabId, { action: 'downloadDone', chapterUrl });

  // Same bookkeeping as Download All gives each chapter: mark it downloaded in
  // the manifest (green dot + "Only new" scope) and push the .cbz to the library.
  if (files.length) {
    const slug = opts.slug || (opts.seriesMeta && opts.seriesMeta.slug) ||
      (String(chapterUrl).match(/\/title\/([^/]+)\//) || [])[1] || '';
    const chapterLabel = (options && options.chapterLabel) || chapterLabelFromUrl(chapterUrl);
    const mangaName = (options && options.mangaName) || (opts.seriesMeta && opts.seriesMeta.title) || '';
    recordChapterDownloaded(slug, chapterLabel, mangaName);
    if (isCbz) {
      const libCfg = await getLibraryConfig();
      if (libCfg && libCfg.enabled && /^https?:\/\//i.test(libCfg.endpoint || '')) {
        const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
        queueLibraryPush(libCfg, seriesFolderName(mangaName || 'Series'), outName, bytes);
      }
    }
  }
}

// Fetch one image (with optional retries) and add it to the given JSZip
// container (the zip root or a chapter folder). Returns bytes written, 0 on fail.
async function fetchImageIntoZip(container, paddedIndex, src, cfg, retries) {
  let lastErr = null;
  for (let attempt = 0; attempt <= (retries || 0); attempt++) {
    try {
      const image = await fetchImageForZip(src, cfg);
      container.file(`${paddedIndex}.${image.ext}`, image.buffer);
      return image.buffer.byteLength || 0;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) console.warn(`[ComixDL] image ${paddedIndex} skipped:`, lastErr.message);
  return 0;
}

// Like fetchImageIntoZip, but returns the image bytes instead of writing straight
// into a JSZip container. Used by the concurrent Download-All path: images are
// buffered in memory and added to the ZIP later, in chapter order, by a single
// packer — so two chapters downloading at once never race on the ZIP object.
// Returns { name, buffer, bytes } or null when the image could not be fetched.
async function fetchImageToFile(paddedIndex, src, cfg, retries) {
  let lastErr = null;
  for (let attempt = 0; attempt <= (retries || 0); attempt++) {
    try {
      const image = await fetchImageForZip(src, cfg);
      return { name: `${paddedIndex}.${image.ext}`, buffer: image.buffer, bytes: image.buffer.byteLength || 0 };
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) console.warn(`[ComixDL] image ${paddedIndex} skipped:`, lastErr.message);
  return null;
}

// Fetch an image and, when comix.to marks it as scrambled, redraw the CDN
// tile mosaic back into normal page order before it goes into the ZIP.
// Honors user settings: fetch timeout, disable-scramble, and image re-encoding.
async function fetchImageForZip(src, cfg) {
  cfg = cfg || {};
  const timeoutMs = cfg['perf.imageTimeoutMs'] || 30000;
  const disableScramble = !!cfg['advanced.disableScramble'];
  const fmt = cfg['advanced.imageFormat'] || 'preserve';
  const quality = cfg['advanced.jpgQuality'] || 0.85;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(src, {
      signal: controller.signal,
      credentials: 'include',   // new reader serves images from *.comix.to — may be cookie-gated
      headers: {
        Accept: 'image/webp,image/avif,image/*,*/*;q=0.8',
        Referer: 'https://comix.to/',
      },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') || '';
    const rawExt = getImageExtension(src, contentType);
    const scramble = disableScramble ? null : getScrambleInfo(response.headers);

    if (!scramble) {
      if (fmt === 'preserve') {
        return { buffer: await response.arrayBuffer(), ext: rawExt, scrambled: false };
      }
      // Re-encode every image to a single format (lossy/heavy — opt-in only).
      const re = await reencodeImageBlob(await response.blob(), fmt, quality);
      return { buffer: re.buffer, ext: re.ext, scrambled: false };
    }

    const blob = await response.blob();
    try {
      const fixed = await unscrambleImageBlob(blob, scramble);
      if (fmt === 'jpg') {
        const re = await reencodeImageBlob(new Blob([fixed.buffer], { type: 'image/png' }), fmt, quality);
        return { buffer: re.buffer, ext: re.ext, scrambled: true };
      }
      // preserve / png → the unscramble step already outputs PNG
      return { buffer: fixed.buffer, ext: fixed.ext, scrambled: true };
    } catch (err) {
      cdlLog('warn', `Scrambled page fallback used (${scramble.seed}/${scramble.cols}x${scramble.rows}): ${err.message}`);
      console.warn('[ComixDL] Scrambled image could not be redrawn, keeping raw bytes:', err);
      if (fmt === 'preserve') {
        return { buffer: await blob.arrayBuffer(), ext: rawExt, scrambled: false, scrambleFailed: true };
      }
      const re = await reencodeImageBlob(blob, fmt, quality);
      return { buffer: re.buffer, ext: re.ext, scrambled: false, scrambleFailed: true };
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

// Re-encode an image blob to PNG or JPG. Falls back to the original bytes when
// the platform can't decode here, so opting in never silently drops pages.
async function reencodeImageBlob(blob, fmt, quality) {
  if (typeof createImageBitmap !== 'function') {
    const ext = (blob.type && blob.type.split('/')[1]) || 'webp';
    return { buffer: await blob.arrayBuffer(), ext };
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = createZipCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context is unavailable');
    ctx.drawImage(bitmap, 0, 0);
    const type = fmt === 'jpg' ? 'image/jpeg' : 'image/png';
    const out = await canvasToBlob(canvas, type, fmt === 'jpg' ? quality : undefined);
    return { buffer: await out.arrayBuffer(), ext: fmt === 'jpg' ? 'jpg' : 'png' };
  } finally {
    bitmap.close?.();
  }
}

function getScrambleInfo(headers) {
  const seedHeader = headers.get('X-Scramble-Seed');
  if (!seedHeader) return null;

  const seed = parseInt(seedHeader, 10);
  if (!Number.isFinite(seed) || seed <= 0) return null;

  const gridHeader = headers.get('X-Scramble-Grid') || '5x5';
  const gridMatch = gridHeader.match(/^\s*(\d+)\s*x\s*(\d+)\s*$/i);
  const cols = gridMatch ? parseInt(gridMatch[1], 10) || 5 : 5;
  const rows = gridMatch ? parseInt(gridMatch[2], 10) || 5 : 5;

  return {
    seed: seed >>> 0,
    cols: Math.max(1, cols),
    rows: Math.max(1, rows),
    algo: (headers.get('X-Scramble-Algo') || '').trim(),
    hash: (headers.get('X-Scramble-Hash') || '').trim().toLowerCase(),
  };
}

function getImageExtension(src, contentType = '') {
  const urlExt = (src.split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1];
  if (urlExt) return urlExt.toLowerCase();

  if (/image\/png/i.test(contentType)) return 'png';
  if (/image\/jpe?g/i.test(contentType)) return 'jpg';
  if (/image\/avif/i.test(contentType)) return 'avif';
  if (/image\/webp/i.test(contentType)) return 'webp';
  return 'webp';
}

// comix.to ships more than one tile-scramble variant (the X-Scramble-Algo header
// changed in 2026). The observed algo-3 variants share the same
// xorshift+Durstenfeld generator and differ only in the PRNG's init constant.
// The X-Scramble-Hash header helps identify known variants, but the fallback still
// tries every known constant and keeps the result whose tile seams join smoothly.
const SCRAMBLE_INIT_CONSTS = [0xe42f, 0x1, 0x1cb1d];
const SCRAMBLE_HASH_INIT_CONSTS = {
  '03632': [0xe42f],
  '02900': [0x1cb1d],
  '09197': [0x1],
  bca9b: [0x1],
  e8a87: [0x1],
};

async function unscrambleImageBlob(blob, { seed, cols, rows, hash }) {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('createImageBitmap is unavailable');
  }

  const bitmap = await createImageBitmap(blob);
  try {
    const tileW = Math.floor(bitmap.width / cols);
    const tileH = Math.floor(bitmap.height / rows);
    if (tileW < 1 || tileH < 1) throw new Error('invalid scramble grid');
    const count = cols * rows;
    const candidates = getScrambleInitCandidates(hash);
    const multi = count > 1 && candidates.length > 1;

    let best = null;
    for (const initConst of candidates) {
      const canvas = createZipCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context is unavailable');

      // The reader draws the whole mosaic first, then overwrites the grid tiles.
      // This preserves bottom/right remainders when dimensions are not exactly
      // divisible by the scramble grid.
      ctx.drawImage(bitmap, 0, 0);

      const permutation = makeScramblePermutation(seed, count, initConst);
      for (let i = 0; i < count; i++) {
        const srcX = (i % cols) * tileW;
        const srcY = Math.floor(i / cols) * tileH;
        const dstIndex = permutation[i];
        ctx.drawImage(bitmap, srcX, srcY, tileW, tileH, (dstIndex % cols) * tileW, Math.floor(dstIndex / cols) * tileH, tileW, tileH);
      }

      const score = multi ? scrambleSeamScore(ctx, tileW * cols, tileH * rows, tileW, tileH, cols, rows) : 0;
      if (!best || score < best.score) best = { canvas, score };
      if (!multi) break;
    }

    const outBlob = await canvasToBlob(best.canvas, 'image/png');
    return {
      buffer: await outBlob.arrayBuffer(),
      ext: 'png',
    };
  } finally {
    bitmap.close?.();
  }
}

function getScrambleInitCandidates(hash) {
  const preferred = hash ? SCRAMBLE_HASH_INIT_CONSTS[hash] : null;
  const out = [];
  for (const initConst of [...(preferred || []), ...SCRAMBLE_INIT_CONSTS]) {
    if (!out.includes(initConst)) out.push(initConst);
  }
  return out;
}

// Total colour discontinuity along the internal tile seams. Low = tiles line up
// (correct descramble); high = visible seams (wrong permutation).
function scrambleSeamScore(ctx, W, H, tileW, tileH, cols, rows) {
  let data;
  try { data = ctx.getImageData(0, 0, W, H).data; } catch (_) { return Infinity; }
  const STEP = 3;
  let s = 0;
  for (let c = 1; c < cols; c++) {
    const x = c * tileW;
    for (let y = 0; y < H; y += STEP) {
      const a = (y * W + x - 1) * 4, b = (y * W + x) * 4;
      s += Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2]);
    }
  }
  for (let r = 1; r < rows; r++) {
    const y = r * tileH;
    for (let x = 0; x < W; x += STEP) {
      const a = ((y - 1) * W + x) * 4, b = (y * W + x) * 4;
      s += Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2]);
    }
  }
  return s;
}

function createZipCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error('canvas is unavailable');
}

function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob(quality != null ? { type, quality } : { type });
  }
  if (typeof canvas.toBlob === 'function') {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('canvas encoding failed'));
      }, type, quality);
    });
  }
  throw new Error('canvas blob export is unavailable');
}

// Reproduces comix.to's exact tile permutation for a scrambled page. The seed is
// the X-Scramble-Seed header value; `count` = cols*rows from X-Scramble-Grid.
// Reverse-engineered (v2.3.3) by observing the reader's own descramble blits across
// forced seeds/grids and recovering the generator via the CRT of large grids:
//   • PRNG state init: initConst XOR (seed with its low bit cleared)  [low bit ignored]
//   • PRNG step: xorshift32 with shifts (13, 17, 5)
//   • shuffle: Durstenfeld (Fisher-Yates), i = count-1 .. 1, j = state % (i+1)
// order[srcTile] = destPosition, exactly what unscrambleImageBlob redraws.
// comix's 2026 "algo 3" uses the same generator with multiple init constants
// (currently 0xe42f, 0x1, and 0x1cb1d) across pages; unscrambleImageBlob tries
// the known variants and keeps whichever produces continuous tile seams.
function makeScramblePermutation(seed, count, initConst = 0xe42f) {
  const order = Array.from({ length: count }, (_, i) => i);
  let state = (initConst ^ ((seed >>> 1) << 1)) >>> 0;

  for (let remaining = count; remaining >= 2; remaining--) {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    const swapWith = state % remaining;
    const last = remaining - 1;
    const tmp = order[last];
    order[last] = order[swapWith];
    order[swapWith] = tmp;
  }

  return order;
}

// ── Utilitaires ───────────────────────────────────────────────────────────────

/**
 * Génère le ZIP et retourne une URL téléchargeable.
 * Chrome : blob: URL (sans limite de taille).
 * Firefox : data: base64 — blob URLs created in a service worker cannot be
 *   resolved by the Firefox downloads API (they are scoped to the SW context).
 * Retourne { url, revoke, base64? } — appeler revoke() après téléchargement.
 */
async function _zipToDownloadUrl(zip) {
  if (!_IS_FIREFOX) {
    // Chrome: blob URL (no size limit, memory-efficient)
    try {
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      const url  = URL.createObjectURL(blob);
      return { url, revoke: () => URL.revokeObjectURL(url) };
    } catch (_) {}
  }
  // Firefox (or fallback): base64 data URL
  const base64 = await zip.generateAsync({ type: 'base64', compression: 'STORE' });
  return { url: `data:application/zip;base64,${base64}`, revoke: () => {}, base64 };
}

function sanitizeFilename(name, ext) {
  ext = (ext || 'zip').replace(/^\./, '');
  const base = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\.(zip|cbz)$/i, '')
    .replace(/\.+$/, '')
    .substring(0, 196);
  return `${base || 'download'}.${ext}`;
}

function getZipPartName(zipName, partNumber) {
  const base = zipName.replace(/\.zip$/i, '');
  return `${base}-part-${String(partNumber).padStart(2, '0')}.zip`;
}

// Build the per-chapter folder name inside the ZIP from the user's template.
// Default 'Ch{num4}{rest}' reproduces the legacy padded "Ch0012" behavior.
// Falls back to the raw (sanitized) label when there is no Ch<number> prefix.
function buildChapterFolderName(folderFmt, chapterLabel, mangaName) {
  const m = String(chapterLabel || '').match(/^Ch([\d.]+)(.*)/i);
  if (!m) {
    const safe = (typeof CDLSettings !== 'undefined')
      ? CDLSettings.sanitizeFilename(chapterLabel, 80)
      : String(chapterLabel || 'Chapter');
    return safe || 'Chapter';
  }
  if (typeof CDLSettings !== 'undefined') {
    return CDLSettings.renderName(folderFmt, { num: m[1], rest: m[2], chapter: chapterLabel, manga: mangaName }, 80);
  }
  // Legacy fallback if the settings module is somehow unavailable.
  return `Ch${m[1].padStart(4, '0')}${m[2]}`;
}

// ── Output options (CBZ / ComicInfo / metadata / folder layout) ───────────────
// Merge the on-page panel's per-download choices over the saved settings defaults.
function resolveOutputOptions(cfg, options) {
  cfg = cfg || {};
  options = options || {};
  const pick = (o, c, d) => (o != null ? o : (c != null ? c : d));
  return {
    format: options.format || cfg['output.format'] || 'zip',
    includeComicInfo: !!pick(options.includeComicInfo, cfg['output.includeComicInfo'], true),
    includeSeriesMeta: !!pick(options.includeSeriesMeta, cfg['output.includeSeriesMeta'], false),
    folderLayout: options.folderLayout || cfg['output.folderLayout'] || 'default',
    folderFmt: cfg['naming.chapterFolderFmt'] || 'Ch{num4}{rest}',
    seriesMeta: options.seriesMeta || null,   // scraped on the page: {title,authors,status,description,genres,coverUrl,language,...}
    slug: options.slug || null,
    totalCount: options.totalCount || null,   // total chapters in the series (ComicInfo <Count>)
  };
}

// Top-level series folder name (Kavita/Komga layout groups everything under it).
function seriesFolderName(mangaName) {
  if (typeof CDLSettings !== 'undefined') return CDLSettings.sanitizeFilename(mangaName, 100) || 'Series';
  return String(mangaName || 'Series').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 100) || 'Series';
}

// Inner entry base path for a chapter (NO extension), honoring the folder layout.
//   default → "Ch0012"            (existing template)
//   kavita  → "Series/Series - Chapter 0012"
function buildChapterEntryName(opts, chapterLabel, mangaName) {
  if (opts.folderLayout === 'kavita') {
    const m = String(chapterLabel || '').match(/^Ch([\d.]+)(.*)/i);
    const num = m ? m[1] : '';
    const rest = m ? m[2] : '';
    const folder = seriesFolderName(mangaName);
    let base;
    if (typeof CDLSettings !== 'undefined') {
      base = CDLSettings.renderName('{manga} - Chapter {num4}{rest}',
        { manga: mangaName, num: num, rest: rest, chapter: chapterLabel }, 120);
    } else {
      base = `${mangaName} - Chapter ${num}${rest}`;
    }
    return `${folder}/${base}`;
  }
  return buildChapterFolderName(opts.folderFmt, chapterLabel, mangaName);
}

// Build a ComicInfo.xml string for one chapter (best-effort fields from the scrape).
function buildChapterComicInfoXml(opts, chapterLabel, chapterUrl, pageCount, mangaName) {
  if (typeof CDLComicInfo === 'undefined') return null;
  const meta = (opts && opts.seriesMeta) || {};
  let number = '';
  if (typeof CDLFeaturesCore !== 'undefined') {
    const p = CDLFeaturesCore.parseChapterNumber(chapterLabel || chapterUrl || '');
    if (p && p.kind === 'num' && isFinite(p.value)) number = String(p.value);
  }
  if (!number) { const m = String(chapterLabel || '').match(/([\d.]+)/); number = m ? m[1] : ''; }
  const join = (v) => (Array.isArray(v) ? v.join(', ') : v) || undefined;
  return CDLComicInfo.buildComicInfoXml({
    series: meta.title || mangaName,
    number: number || undefined,
    count: opts.totalCount || undefined,
    // Library servers display this as-is — "Chapter 92" reads better than "Ch92".
    title: number ? `Chapter ${number}` : (chapterLabel || undefined),
    summary: meta.description || undefined,
    writer: join(meta.authors) || meta.author || meta.writer || undefined,
    penciller: join(meta.artists) || undefined,
    genres: (meta.genres && meta.genres.length ? meta.genres : meta.tags) || undefined,
    tags: join(meta.demographics) || undefined,
    web: chapterUrl || undefined,
    pageCount: pageCount || undefined,
    language: meta.language || 'en',
    manga: 'Yes',
  });
}

// Add one finished chapter to the outer ZIP, honoring format/ComicInfo/layout.
// Returns the byte size added (for multipart accounting).
async function addChapterToOuter(zip, r, opts, mangaName) {
  const entryBase = buildChapterEntryName(opts, r.chapterLabel, mangaName);
  const comicInfo = opts.includeComicInfo
    ? buildChapterComicInfoXml(opts, r.chapterLabel, r.chapterUrl, r.files.length, mangaName)
    : null;

  if (opts.format === 'cbz') {
    const inner = new JSZip();
    for (const f of r.files) inner.file(f.name, f.buffer);
    if (comicInfo) inner.file('ComicInfo.xml', comicInfo);
    const bytes = await inner.generateAsync({ type: 'uint8array', compression: 'STORE' });
    zip.file(`${entryBase}.cbz`, bytes);
    // Optionally push this .cbz straight to the user's library server (Phase 2).
    // Queued, not awaited — a slow server must never stall the packer (it gates
    // the whole worker pool through the backpressure window).
    if (opts.pushLib) {
      const fileBase = opts.folderLayout === 'kavita' ? entryBase.split('/').pop() : entryBase;
      queueLibraryPush(opts.pushLib, seriesFolderName(mangaName), `${fileBase}.cbz`, bytes);
    }
    return bytes.byteLength || 0;
  }
  const folder = zip.folder(entryBase);
  for (const f of r.files) folder.file(f.name, f.buffer);
  if (comicInfo) folder.file('ComicInfo.xml', comicInfo);
  return r.bytes || 0;
}

// Write the series cover + series.json into the outer ZIP (once, lands in part 1).
async function addSeriesMetaToOuter(zip, opts, mangaName) {
  if (!opts.includeSeriesMeta || !opts.seriesMeta) return;
  const meta = opts.seriesMeta;
  const prefix = opts.folderLayout === 'kavita' ? `${seriesFolderName(mangaName)}/` : '';
  try { zip.file(`${prefix}series.json`, JSON.stringify(meta, null, 2)); } catch (_) {}
  if (meta.coverUrl) {
    try {
      const resp = await fetch(meta.coverUrl, { credentials: 'include', headers: { Referer: 'https://comix.to/' } });
      if (resp.ok) {
        const ct = resp.headers.get('content-type') || '';
        const ext = /png/i.test(ct) ? 'png' : /webp/i.test(ct) ? 'webp' : 'jpg';
        zip.file(`${prefix}cover.${ext}`, await resp.arrayBuffer());
      }
    } catch (err) {
      cdlLog('warn', `Cover image could not be fetched: ${err.message}`);
    }
  }
}

// Record a successfully-downloaded chapter into the per-series manifest. Writes are
// serialized through a promise chain so concurrent workers can't clobber each other.
let _manifestLock = Promise.resolve();
function recordChapterDownloaded(slug, chapterLabel, mangaName) {
  if (!slug) return;
  _manifestLock = _manifestLock.then(async () => {
    let key = chapterLabel;
    if (typeof CDLFeaturesCore !== 'undefined') {
      key = CDLFeaturesCore.dedupeKey(CDLFeaturesCore.parseChapterNumber(chapterLabel));
    }
    const { cdlManifest = {} } = await chrome.storage.local.get('cdlManifest');
    const entry = cdlManifest[slug] || { mangaName: mangaName || '', chapters: {} };
    if (mangaName) entry.mangaName = mangaName;
    entry.chapters = entry.chapters || {};
    entry.chapters[key] = { label: chapterLabel, ts: Date.now() };
    cdlManifest[slug] = entry;
    await chrome.storage.local.set({ cdlManifest });
  }).catch(() => {});
  return _manifestLock;
}

// ── Notification vers un onglet ───────────────────────────────────────────────

function notifyTab(tabId, message) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// ── Extraction Promise-based (pour download-all) ──────────────────────────────
// Ouvre un onglet, attend le chargement complet, injecte le script d'extraction,
// retourne les images ou lance une exception.
async function extractFromTab(url, cfg) {
  cfg = cfg || {};
  const tabTimeout = cfg['perf.tabLoadTimeoutMs'] || 120000;
  const aggressive = !!cfg['advanced.aggressiveRetrieval'];
  const tab = await chrome.tabs.create({ url: withExtractMarker(url), active: false });
  const tabId = tab.id;

  // A freshly created background tab can briefly report status:"complete" while
  // still on its initial about:blank document, before the navigation to `url`
  // commits — this happens on Firefox in particular. Injecting at that point
  // throws "Missing host permission for the tab" (about:blank is not covered by
  // host_permissions), which previously failed every Download-All chapter.
  // Only inject once the tab is actually on a real http(s) page.
  const isRealPageComplete = (t, changeInfo) => {
    const status = (changeInfo && changeInfo.status) || (t && t.status);
    if (status !== 'complete') return false;
    return /^https?:/i.test((t && t.url) || '');
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      fn(val);
    };

    const timer = setTimeout(() => {
      chrome.tabs.remove(tabId).catch(() => {});
      settle(reject, new Error('Timeout chargement onglet'));
    }, tabTimeout);

    const onUpdated = async (updatedId, changeInfo, updatedTab) => {
      if (updatedId !== tabId) return;
      if (!isRealPageComplete(updatedTab, changeInfo)) return;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',   // share the page's Resource Timing buffer (canvas-page URLs)
          func:   extractChapterImagesFromPage,
          args:   [{
            aggressive,
            pollMs: cfg['perf.pagePollMs'],
            settleMs: cfg['perf.pageSettleMs'],
            scrollSettleMs: cfg['perf.scrollSettleMs'],
          }],
        });
        chrome.tabs.remove(tabId).catch(() => {});
        settle(resolve, results?.[0]?.result || []);
      } catch (err) {
        chrome.tabs.remove(tabId).catch(() => {});
        settle(reject, err);
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

    // Race guard: if the tab is already sitting on the real chapter page (e.g.
    // served from cache) the "complete" event may have fired before the listener
    // was attached. Re-check the current state — but only act on a real page,
    // never the initial about:blank, otherwise injection fails on Firefox.
    chrome.tabs.get(tabId).then(t => {
      if (isRealPageComplete(t, null)) onUpdated(tabId, { status: 'complete' }, t);
    }).catch(() => {});
  });
}

// ── Téléchargement de tous les chapitres ──────────────────────────────────────
// Up to `download.concurrentChapters` (1–10, default 2) chapters are downloaded at the same
// time by a small worker pool. Each worker fully downloads its chapter into memory
// and NEVER touches the shared ZIP; a single in-order "packer" adds finished
// chapters to the ZIP strictly by chapter order and cuts ZIP parts at the split
// points. This keeps multi-part output contiguous & ordered and removes any race
// on the ZIP object, while a window (= concurrency) bounds how many finished but
// not-yet-packed chapters are held in memory. concurrency === 1 reproduces the
// original strictly-sequential behavior.
async function handleDownloadAllRequest(chapters, mangaName, zipName, originTabId, options) {
  const cfg = await loadCfg();
  const opts = resolveOutputOptions(cfg, options);
  if (!opts.totalCount) opts.totalCount = chapters.length;
  // Push finished .cbz files to the library server, only when enabled + CBZ format.
  if (opts.format === 'cbz') {
    const libCfg = await getLibraryConfig();
    if (libCfg && libCfg.enabled && /^https?:\/\//i.test(libCfg.endpoint || '')) opts.pushLib = libCfg;
  }
  const concurrency = Math.max(1, Math.min(10, parseInt(cfg['download.concurrentChapters'], 10) || 2));
  const batchSize = cfg['perf.batchSize'] || BATCH_SIZE;
  const padDigits = cfg['naming.imagePadDigits'] || 3;
  const imageRetries = cfg['retry.imageRetries'] || 0;
  const chapterRetries = cfg['retry.chapterRetries'] || 0;
  const splitMode = cfg['download.splitMode'] || 'multipart';
  const maxChapters = splitMode === 'single' ? Infinity : (cfg['download.chaptersPerPart'] || ZIP_PART_MAX_CHAPTERS);
  const maxBytes = splitMode === 'single' ? Infinity : (cfg['download.mbPerPart'] || 300) * 1024 * 1024;

  startDownloadAllSession({ originTabId, mangaName, zipName, totalChapters: chapters.length });
  persistDownloadAllSession(true);
  cdlLog('info', `Download All started: "${mangaName}" — ${chapters.length} chapters${concurrency > 1 ? ` (${concurrency} at a time)` : ''}`);

  let zip = new JSZip();
  let zipPart = 1;
  let zipPartChapters = 0;
  let zipPartBytes = 0;
  const savedZipNames = [];

  // finishedCount (chapters reaching a terminal state: done/skipped/error) drives
  // the monotonic progress bar/counter. Injected into every progress message so
  // the popup never depends on which of the concurrent chapters reported last.
  let finishedCount = 0;
  const notify = (extra) => notifyDownloadAllProgress(originTabId, { completed: finishedCount, concurrency, ...extra });

  const saveCurrentZipPart = async (isFinal = false) => {
    if (zipPartChapters === 0) return true;
    const partName = zipPart === 1 && isFinal ? zipName : getZipPartName(zipName, zipPart);

    notify({ phase: isFinal ? 'zipping' : 'savingPart',
             chapterIndex: chapters.length,
             totalChapters: chapters.length,
             chapterLabel: '',
             imagesDone: 0,
             imagesTotal: 0,
             zipPart });

    _pendingZip = { zip, zipName: partName, originTabId };
    const savedName = await _doZipAndSave({ zip, zipName: partName, originTabId, notifyDone: false });
    if (!savedName) return false;

    savedZipNames.push(savedName);
    cdlLog('ok', `Download All ZIP part saved: ${savedName}`);
    zip = new JSZip();
    zipPart++;
    zipPartChapters = 0;
    zipPartBytes = 0;
    return true;
  };

  // Rate limiting between chapters (dynamic / fixed / off). Shared across workers,
  // so the effective request rate scales roughly with `concurrency`.
  const rateMode = cfg['perf.rateLimitMode'] || 'dynamic';
  let rateDelay = cfg['perf.rateBaseMs'] != null ? cfg['perf.rateBaseMs'] : 1500;  // ms
  const MIN_DELAY = cfg['perf.rateMinMs'] != null ? cfg['perf.rateMinMs'] : 800;
  const MAX_DELAY = cfg['perf.rateMaxMs'] || 8000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Download one chapter's images into memory. Emits extracting/downloading
  // progress; returns a result the packer can add to the ZIP. Never throws.
  const downloadChapter = async (i) => {
    const { chapterUrl, chapterLabel } = chapters[i];

    notify({ phase: 'extracting', chapterIndex: i + 1, totalChapters: chapters.length,
             chapterLabel, imagesDone: 0, imagesTotal: 0 });

    let images = null, extractErr = null;
    for (let attempt = 0; attempt <= chapterRetries; attempt++) {
      if (downloadAllAbortFlag) break;
      try { images = await extractFromTab(chapterUrl, cfg); extractErr = null; break; }
      catch (e) { extractErr = e; images = null; }
    }
    if (extractErr) {
      console.warn(`[ComixDL-All] Chapitre ${chapterLabel} échoué:`, extractErr.message);
      cdlLog('error', `${chapterLabel} failed: ${extractErr.message}`);
      return { index: i, chapterUrl, chapterLabel, files: [], bytes: 0, imagesTotal: 0, imgDone: 0, status: 'error' };
    }
    if (!images || images.length === 0) {
      cdlLog('warn', `No images found, skipping ${chapterLabel}`);
      return { index: i, chapterUrl, chapterLabel, files: [], bytes: 0, imagesTotal: 0, imgDone: 0, status: 'skipped' };
    }
    images = await verifyEnumeratedImages(images, chapterLabel);
    cdlLog('info', `${chapterLabel}: extracted ${images.length} images`);

    // Re-sequence to clean 1..N page numbers (sorted by the extractor's index) so
    // filenames are unique + correctly ordered even if the source indices are
    // sparse or duplicated. Then sort the fetched files by page (they complete out
    // of order under concurrency) so the archive's entry order matches reading order.
    const ordered = images.slice().sort((a, b) => (a.index || 0) - (b.index || 0));
    const files = [];
    let bytes = 0, imgDone = 0;
    for (let j = 0; j < ordered.length; j += batchSize) {
      if (downloadAllAbortFlag) break;
      const batch = ordered.slice(j, j + batchSize);
      await Promise.allSettled(batch.map(async (img, k) => {
        const page = j + k + 1;
        const paddedIndex = String(page).padStart(padDigits, '0');
        const file = await fetchImageToFile(paddedIndex, img.src, cfg, imageRetries);
        if (file) { file.page = page; files.push(file); bytes += file.bytes; }
        imgDone++;
        notify({ phase: 'downloading', chapterIndex: i + 1, totalChapters: chapters.length,
                 chapterLabel, imagesDone: imgDone, imagesTotal: ordered.length });
      }));
    }
    files.sort((a, b) => a.page - b.page);
    return { index: i, chapterUrl, chapterLabel, files, bytes, imagesTotal: ordered.length, imgDone, status: 'done' };
  };

  // ── Worker pool + in-order packer ───────────────────────────────────────────
  const results = new Array(chapters.length);
  const resolvers = new Array(chapters.length);
  const ready = chapters.map((_, i) => new Promise((res) => { resolvers[i] = res; }));
  const abortPromise = _downloadAllAbortPromise();   // one reusable per-run signal

  let cursor = 0;        // next chapter index to grab
  let packedCount = 0;   // chapters consumed by the packer (packed or skipped)
  let packFailed = false;
  let windowWaiters = [];
  const wakeWindow = () => { const w = windowWaiters; windowWaiters = []; w.forEach((fn) => fn()); };

  // Backpressure: never let more than `concurrency` chapters be checked out but
  // unpacked, so buffered image bytes stay bounded (~concurrency chapters).
  const waitForWindow = async () => {
    while (!downloadAllAbortFlag && (cursor - packedCount) >= concurrency) {
      await Promise.race([new Promise((res) => windowWaiters.push(res)), abortPromise]);
    }
  };

  const worker = async () => {
    while (true) {
      await waitForWindow();
      if (downloadAllAbortFlag) return;
      const i = cursor++;
      if (i >= chapters.length) return;

      const result = await downloadChapter(i);
      results[i] = result;
      finishedCount++;   // bump before the terminal message so the bar advances

      if (result.status === 'done') {
        notify({ phase: 'done', chapterIndex: i + 1, totalChapters: chapters.length,
                 chapterLabel: result.chapterLabel, imagesDone: result.imgDone, imagesTotal: result.imagesTotal });
        cdlLog('ok', `${result.chapterLabel}: done (${result.imgDone} images)`);
        recordChapterDownloaded(opts.slug, result.chapterLabel, mangaName); // mark as grabbed
        if (rateMode === 'dynamic') rateDelay = Math.max(MIN_DELAY, rateDelay - 100); // success → slightly faster
      } else if (result.status === 'skipped') {
        notify({ phase: 'skipped', chapterIndex: i + 1, totalChapters: chapters.length,
                 chapterLabel: result.chapterLabel, imagesDone: 0, imagesTotal: 0 });
      } else {
        notify({ phase: 'error', chapterIndex: i + 1, totalChapters: chapters.length,
                 chapterLabel: result.chapterLabel, imagesDone: 0, imagesTotal: 0 });
        if (rateMode === 'dynamic') rateDelay = Math.min(MAX_DELAY, Math.round(rateDelay * 1.5)); // failure → back off
      }
      resolvers[i]();   // hand this chapter to the in-order packer

      // Pace before grabbing the next chapter (skipped once no work remains).
      if (rateMode !== 'off' && !downloadAllAbortFlag && cursor < chapters.length) {
        await sleep(rateDelay);
      }
    }
  };

  const packer = async () => {
    for (let i = 0; i < chapters.length; i++) {
      await Promise.race([ready[i], abortPromise]);
      if (downloadAllAbortFlag) return;

      const r = results[i];
      results[i] = null;   // release buffers as soon as they're packed

      if (r && r.status === 'done' && r.files.length) {
        const added = await addChapterToOuter(zip, r, opts, mangaName);
        zipPartChapters++;
        zipPartBytes += added;
        if (i < chapters.length - 1 && (zipPartChapters >= maxChapters || zipPartBytes >= maxBytes)) {
          const ok = await saveCurrentZipPart(false);
          if (!ok) { packFailed = true; _signalDownloadAllAbort(); return; }
        }
      }

      // Free a window slot only after this chapter (incl. any part-save) is fully
      // handled, so workers don't pile new downloads up during a ZIP save.
      packedCount = i + 1;
      wakeWindow();
    }
  };

  // Series cover + series.json go in first (so they land in ZIP part 1).
  await addSeriesMetaToOuter(zip, opts, mangaName);

  const workers = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all([packer(), ...workers]);

  if (packFailed) return;   // the ZIP error was already reported by _doZipAndSave
  if (downloadAllAbortFlag) { notifyDownloadAllCancelled(originTabId); return; }

  // Final ZIP part.
  const saved = await saveCurrentZipPart(true);
  if (!saved) return;

  // Let queued library pushes drain before reporting done (also keeps the MV3
  // service worker alive until the last upload finishes).
  if (opts.pushLib) { try { await _libPushChain; } catch (_) {} }

  const doneName = savedZipNames.length === 1 ? savedZipNames[0] : `${savedZipNames.length} ZIP parts`;
  cdlLog('ok', `Download All complete: ${doneName}`);
  notifyDownloadAllDone(originTabId, doneName);
}

async function _doZipAndSave({ zip, zipName, originTabId, notifyDone = true }) {
  try {
    const { url, revoke, base64: urlBase64 } = await _zipToDownloadUrl(zip);
    const filename = sanitizeFilename(zipName);
    try {
      await chrome.downloads.download({ url, filename, saveAs: false });
      setTimeout(revoke, 60_000);
    } catch (_dlErr) {
      revoke();
      // downloads API unavailable on this platform (Firefox Android) — fall back
      // to sending ZIP data to the content script for a <a>-click download.
      if (originTabId == null) throw _dlErr;
      const b64 = urlBase64 || await zip.generateAsync({ type: 'base64', compression: 'STORE' });
      await chrome.tabs.sendMessage(originTabId, { action: 'triggerDownload', base64: b64, filename });
    }
    _pendingZip = null;
    if (notifyDone) {
      cdlLog('ok', `Download All complete: ${filename}`);
      notifyDownloadAllDone(originTabId, filename);
    }
    return filename;
  } catch (err) {
    cdlLog('error', `Download All ZIP error: ${err.message}`);
    notifyDownloadAllError(originTabId, err.message, true);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Phase 2 — Subscribe & watch + Push-to-library
// ══════════════════════════════════════════════════════════════════════════════

function chapterLabelFromUrl(url) {
  const m = String(url || '').match(/\/(\d+)-chapter-([0-9a-z.-]+)(?:\/|$)/i);
  if (m) return `Ch${m[2]}`;
  const parts = String(url || '').split('/').filter(Boolean);
  return parts[parts.length - 1] || 'chapter';
}
function chapterKeyFor(label) {
  if (typeof CDLFeaturesCore !== 'undefined') return CDLFeaturesCore.dedupeKey(CDLFeaturesCore.parseChapterNumber(label));
  return String(label || '');
}

async function getSeriesPrefsBg(slug) {
  try { const { cdlSeriesPrefs } = await chrome.storage.local.get('cdlSeriesPrefs'); return (cdlSeriesPrefs && cdlSeriesPrefs[slug]) || {}; }
  catch (_) { return {}; }
}

// Fetch the FULL current chapter list for a series. Two stages:
//   1. Direct credentialed fetch from the service worker (fast, no tab) — but
//      Cloudflare often serves its "Just a moment…" challenge to SW fetches
//      even when the user browses the site fine.
//   2. Fallback: a real background tab on the series page — the managed
//      challenge solves itself there (same mechanics as downloads) AND
//      refreshes cf_clearance, which usually re-unblocks the direct path for
//      the remaining series of the same run.
// Returns sorted [{chapterUrl, chapterLabel, key}] or null when blocked/empty.
async function fetchSeriesChapters(slug) {
  if (!slug) return null;
  const toUrl = (p) => { try { return new URL(p, 'https://comix.to').href; } catch (_) { return ''; } };

  let paths = await fetchSeriesChapterPathsDirect(slug);
  if (!paths || !paths.length) paths = await fetchSeriesChapterPathsViaTab(slug);
  if (!paths || !paths.length) return null;

  const urlSet = new Set();
  paths.forEach((p) => { const u = toUrl(p); if (u) urlSet.add(u); });

  const prefix = `/title/${slug}/`;
  const byKey = new Map();
  for (const url of urlSet) {
    try { if (!new URL(url).pathname.startsWith(prefix)) continue; } catch (_) { continue; }
    const label = chapterLabelFromUrl(url);
    const key = chapterKeyFor(label);
    if (!byKey.has(key)) byKey.set(key, { chapterUrl: url, chapterLabel: label, key });
  }
  return [...byKey.values()].sort((a, b) =>
    parseFloat(a.chapterLabel.replace(/[^0-9.]/g, '')) - parseFloat(b.chapterLabel.replace(/[^0-9.]/g, '')));
}

// Stage 1 — plain SW fetch (+ buildId pagination). Returns chapter paths or null.
async function fetchSeriesChapterPathsDirect(slug) {
  const extract = (text) => (typeof CDLFeaturesCore !== 'undefined')
    ? CDLFeaturesCore.extractChapterPaths(text)
    : (String(text).match(/\/title\/[a-z0-9-]+\/\d+-chapter-[\w.-]+/gi) || []);

  let html = '';
  try {
    const r = await fetch(`https://comix.to/title/${slug}`, { credentials: 'include', headers: { Accept: 'text/html' } });
    if (!r.ok) return null;
    html = await r.text();
  } catch (_) { return null; }

  const paths = new Set(extract(html));
  const bm = html.match(/"buildId"\s*:\s*"([^"]+)"/);
  const buildId = bm ? bm[1] : null;

  if (buildId) {
    for (let page = 1; page <= 100; page++) {
      let text = '';
      try {
        const rr = await fetch(`https://comix.to/_next/data/${buildId}/title/${slug}.json?page=${page}`,
          { credentials: 'include', headers: { Accept: 'application/json' } });
        if (!rr.ok) break;
        text = await rr.text();
      } catch (_) { break; }
      let fresh = 0;
      extract(text).forEach((p) => { if (!paths.has(p)) { paths.add(p); fresh++; } });
      if (!fresh && page > 1) break;
    }
  }
  return paths.size ? [...paths] : null;
}

// Stage 2 — background tab on the series page. The Cloudflare managed challenge
// runs and solves itself in a real tab; we poll the page until the chapter list
// is readable (or give up after the deadline and report "blocked" as before).
async function fetchSeriesChapterPathsViaTab(slug) {
  if (!chrome.scripting || !chrome.tabs) return null;
  let tab = null;
  try { tab = await chrome.tabs.create({ url: withExtractMarker(`https://comix.to/title/${slug}`), active: false }); }
  catch (_) { return null; }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const deadline = Date.now() + 45_000;
    await sleep(2500); // let navigation (and a possible challenge) start
    while (Date.now() < deadline) {
      let out = null;
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: grabSeriesChapterPathsFromPage,
          args: [slug],
        });
        out = res && res[0] && res[0].result;
      } catch (_) {
        // injection fails while the page navigates (challenge → real page); but
        // if the tab itself is gone (closed by the user), stop waiting.
        try { await chrome.tabs.get(tab.id); } catch (_) { return null; }
      }
      if (out && !out.challenge && out.paths && out.paths.length) {
        cdlLog('info', `${slug}: chapter list read via background tab (Cloudflare cleared)`);
        return out.paths;
      }
      await sleep(1500);
    }
    return null;
  } finally {
    if (tab) { try { chrome.tabs.remove(tab.id).catch(() => {}); } catch (_) {} }
  }
}

// Injected into the series page tab. Self-contained (no outer closures).
async function grabSeriesChapterPathsFromPage(slug) {
  const RE = /\/title\/[a-z0-9-]+\/\d+-chapter-[\w.-]+/gi;
  const html = document.documentElement ? document.documentElement.outerHTML : '';
  const set = new Set(html.match(RE) || []);
  document.querySelectorAll('a[href*="-chapter-"]').forEach((a) => {
    const m = (a.getAttribute('href') || '').match(RE);
    if (m) m.forEach((p) => set.add(p));
  });
  // No chapter data AND no Next.js payload → most likely the Cloudflare
  // interstitial (or a page still rendering): ask the caller to retry.
  if (!set.size && !document.getElementById('__NEXT_DATA__')) {
    return { challenge: true, paths: [] };
  }
  // Pagination from page context: same-origin fetch with the browser's own
  // headers/cookies — Cloudflare never challenges these.
  const bm = html.match(/"buildId"\s*:\s*"([^"]+)"/);
  if (bm) {
    for (let page = 1; page <= 100; page++) {
      let fresh = 0;
      try {
        const r = await fetch(`/_next/data/${bm[1]}/title/${slug}.json?page=${page}`, { headers: { Accept: 'application/json' } });
        if (!r.ok) break;
        const t = await r.text();
        (t.match(RE) || []).forEach((p) => { if (!set.has(p)) { set.add(p); fresh++; } });
      } catch (_) { break; }
      if (!fresh && page > 1) break;
    }
  }
  return { challenge: false, paths: [...set] };
}

// ── Subscriptions ─────────────────────────────────────────────────────────────
const SUBSCRIBE_ALARM = 'cdlSubscribeCheck';

async function setupSubscribeAlarm() {
  if (!chrome.alarms) return;
  let cfg = {};
  try { cfg = await loadCfg(); } catch (_) {}
  // Settings saves call this on every change — keep the running alarm when the
  // schedule didn't actually change, otherwise the countdown restarts each save
  // and a frequently-tweaked browser never reaches the next check.
  const existing = await new Promise((res) => {
    try { chrome.alarms.get(SUBSCRIBE_ALARM, (a) => res(a || null)); } catch (_) { res(null); }
  });
  if (!cfg['subscribe.enabled']) {
    if (existing) { try { await chrome.alarms.clear(SUBSCRIBE_ALARM); } catch (_) {} }
    return;
  }
  const mins = Math.max(30, Math.min(1440, cfg['subscribe.intervalMinutes'] || 360));
  if (existing && existing.periodInMinutes === mins) return;
  try { await chrome.alarms.clear(SUBSCRIBE_ALARM); } catch (_) {}
  try { chrome.alarms.create(SUBSCRIBE_ALARM, { periodInMinutes: mins, delayInMinutes: 1 }); } catch (_) {}
}

async function subscribeSeries(slug, mangaName) {
  if (!slug) return;
  const { cdlSubscriptions = {} } = await chrome.storage.local.get('cdlSubscriptions');
  const isNew = !cdlSubscriptions[slug];
  if (isNew) cdlSubscriptions[slug] = { mangaName: mangaName || slug, lastSeen: [], lastCheck: 0 };
  else if (mangaName) cdlSubscriptions[slug].mangaName = mangaName;
  await chrome.storage.local.set({ cdlSubscriptions });
  // Subscribing implies wanting background checks — enable the master toggle once.
  let cfg = {};
  try {
    cfg = await loadCfg();
    if (!cfg['subscribe.enabled'] && typeof CDLSettings !== 'undefined') {
      await CDLSettings.patchSettings({ 'subscribe.enabled': true });
      cfg['subscribe.enabled'] = true;
    }
  } catch (_) {}
  setupSubscribeAlarm();
  // Baseline right away (fire-and-forget so the button stays snappy): without it
  // the first periodic check only records the current list, so nothing could be
  // detected before the SECOND check — hours later, which feels broken.
  if (isNew) checkOneSubscription(slug, cdlSubscriptions[slug], cfg).catch(() => {});
}

async function unsubscribeSeries(slug) {
  const { cdlSubscriptions = {} } = await chrome.storage.local.get('cdlSubscriptions');
  if (cdlSubscriptions[slug]) { delete cdlSubscriptions[slug]; await chrome.storage.local.set({ cdlSubscriptions }); }
}

// Returns a summary so the manual "Check now" can show real feedback.
async function checkAllSubscriptions(force) {
  let cfg = {};
  try { cfg = await loadCfg(); } catch (_) {}
  const summary = { checked: 0, newChapters: 0, blocked: 0, skipped: false };
  if (!cfg['subscribe.enabled'] && !force) { summary.skipped = true; return summary; }
  const { cdlSubscriptions = {} } = await chrome.storage.local.get('cdlSubscriptions');
  for (const slug of Object.keys(cdlSubscriptions)) {
    try {
      const r = await checkOneSubscription(slug, cdlSubscriptions[slug], cfg);
      summary.checked++;
      if (r && r.blocked) summary.blocked++;
      if (r && r.newCount) summary.newChapters += r.newCount;
    } catch (_) {}
  }
  return summary;
}

async function checkOneSubscription(slug, sub, cfg) {
  const chapters = await fetchSeriesChapters(slug);
  if (!chapters || !chapters.length) {
    // Blocked (Cloudflare) or empty — record the failed attempt so the options
    // page can tell the user instead of silently looking idle.
    try {
      const { cdlSubscriptions = {} } = await chrome.storage.local.get('cdlSubscriptions');
      if (cdlSubscriptions[slug]) {
        cdlSubscriptions[slug].lastCheck = Date.now();
        cdlSubscriptions[slug].lastStatus = 'blocked';
        await chrome.storage.local.set({ cdlSubscriptions });
      }
    } catch (_) {}
    return { blocked: true, newCount: 0 };
  }
  const hadBaseline = Array.isArray(sub.lastSeen) && sub.lastSeen.length > 0;
  const seen = new Set(sub.lastSeen || []);
  const newOnes = chapters.filter((c) => !seen.has(c.key));

  // Persist the fresh baseline + timestamp.
  const { cdlSubscriptions = {} } = await chrome.storage.local.get('cdlSubscriptions');
  const entry = cdlSubscriptions[slug] || sub || {};
  entry.mangaName = entry.mangaName || sub.mangaName || slug;
  entry.lastSeen = chapters.map((c) => c.key);
  entry.lastCheck = Date.now();
  entry.lastStatus = 'ok';
  cdlSubscriptions[slug] = entry;
  await chrome.storage.local.set({ cdlSubscriptions });

  if (!hadBaseline || !newOnes.length) return { blocked: false, newCount: 0 }; // first successful check just baselines
  cdlLog('ok', `${entry.mangaName}: ${newOnes.length} new chapter(s) found`);
  if (cfg['subscribe.notify']) notifyNewChapters(slug, entry.mangaName, newOnes);
  if (cfg['subscribe.autoDownload']) queueAutoDownload(slug, entry.mangaName, newOnes, cfg, chapters.length);
  return { blocked: false, newCount: newOnes.length };
}

function notifyNewChapters(slug, mangaName, newOnes) {
  if (!chrome.notifications) return;
  const labels = newOnes.slice(0, 4).map((c) => c.chapterLabel).join(', ') + (newOnes.length > 4 ? '…' : '');
  try {
    chrome.notifications.create(`cdlsub:${slug}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `New chapters — ${mangaName}`,
      message: `${newOnes.length} new: ${labels}`,
      priority: 1,
    });
  } catch (_) {}
}

if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener((id) => {
    if (id && id.indexOf('cdlsub:') === 0) {
      const slug = id.slice('cdlsub:'.length);
      try { chrome.tabs.create({ url: `https://comix.to/title/${slug}` }); } catch (_) {}
      try { chrome.notifications.clear(id); } catch (_) {}
    }
  });
}

// Auto-downloads run through a serial queue: when two subscriptions both find
// new chapters in the same check cycle, the second run waits instead of being
// dropped (handleDownloadAllRequest refuses to run two sessions at once).
let _autoDlChain = Promise.resolve();
function queueAutoDownload(slug, mangaName, newOnes, cfg, seriesTotal) {
  _autoDlChain = _autoDlChain
    .then(() => autoDownloadNew(slug, mangaName, newOnes, cfg, seriesTotal))
    .catch((e) => { cdlLog('error', `Auto-download failed (${mangaName}): ${e && e.message}`); });
  return _autoDlChain;
}

async function autoDownloadNew(slug, mangaName, newOnes, cfg, seriesTotal) {
  if (downloadAllSession && downloadAllSession.active) {
    // A user-initiated run is in progress — postpone. Drop these keys from the
    // baseline so the next periodic check re-detects them and retries.
    cdlLog('warn', `Auto-download postponed (another download is running): ${mangaName}`);
    try {
      const { cdlSubscriptions = {} } = await chrome.storage.local.get('cdlSubscriptions');
      const entry = cdlSubscriptions[slug];
      if (entry && Array.isArray(entry.lastSeen)) {
        const drop = new Set(newOnes.map((c) => c.key));
        entry.lastSeen = entry.lastSeen.filter((k) => !drop.has(k));
        await chrome.storage.local.set({ cdlSubscriptions });
      }
    } catch (_) {}
    return;
  }
  _resetDownloadAllAbort();
  const prefs = await getSeriesPrefsBg(slug);
  const options = {
    format: prefs.format || cfg['output.format'] || 'zip',
    includeComicInfo: prefs.includeComicInfo != null ? prefs.includeComicInfo : (cfg['output.includeComicInfo'] !== false),
    includeSeriesMeta: false,
    folderLayout: prefs.folderLayout || cfg['output.folderLayout'] || 'default',
    slug,
    seriesMeta: { title: mangaName, slug },
    // Real series total (for ComicInfo <Count>) — NOT the count of new chapters.
    totalCount: seriesTotal || 0,
  };
  let zipName = `${mangaName}-new`;
  try { if (typeof CDLSettings !== 'undefined') zipName = `${CDLSettings.renderName(cfg['naming.allZipTpl'] || '{manga}', { manga: mangaName }, 180)}-new`; } catch (_) {}
  const chapters = newOnes.map((c) => ({ chapterUrl: c.chapterUrl, chapterLabel: c.chapterLabel }));
  cdlLog('info', `Auto-downloading ${chapters.length} new chapter(s) of "${mangaName}"`);
  await handleDownloadAllRequest(chapters, mangaName, zipName, null, options);
  // Replaces the "new chapters" notification for this series with the outcome.
  if (cfg['subscribe.notify'] && chrome.notifications) {
    try {
      chrome.notifications.create(`cdlsub:${slug}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: `Auto-download finished — ${mangaName}`,
        message: `${chapters.length} new chapter(s) saved to your downloads folder.`,
        priority: 0,
      });
    } catch (_) {}
  }
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((a) => { if (a && a.name === SUBSCRIBE_ALARM) checkAllSubscriptions(); });
}
chrome.runtime.onInstalled.addListener(setupSubscribeAlarm);
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(setupSubscribeAlarm);

// ── Push to library (WebDAV / HTTP PUT) ───────────────────────────────────────
async function getLibraryConfig() {
  try { const { cdlLibrary } = await chrome.storage.local.get('cdlLibrary'); return cdlLibrary || null; }
  catch (_) { return null; }
}
function libAuthHeader(c) {
  if (c && (c.username || c.password)) return 'Basic ' + btoa(`${c.username || ''}:${c.password || ''}`);
  return null;
}
function joinLibraryUrl(base, ...parts) {
  let u = String(base || '').replace(/\/+$/, '');
  for (const p of parts) u += '/' + encodeURIComponent(p).replace(/%2F/gi, '/');
  return u;
}
// Pushes go through a serial queue so a slow library server never stalls the
// download pipeline: the packer queues the bytes and moves on immediately.
let _libPushChain = Promise.resolve();
const _libMkcolDone = new Set();
function queueLibraryPush(libCfg, seriesFolder, fileName, bytes) {
  _libPushChain = _libPushChain.then(async () => {
    try {
      const ok = await pushFileToLibrary(libCfg, seriesFolder, fileName, bytes);
      cdlLog(ok ? 'ok' : 'error', `Library push ${ok ? 'ok' : 'failed'}: ${fileName}`);
    } catch (e) {
      cdlLog('error', `Library push failed: ${fileName} (${e.message})`);
    }
  });
  return _libPushChain;
}
async function pushFileToLibrary(libCfg, seriesFolder, fileName, bytes) {
  const method = libCfg.method === 'POST' ? 'POST' : 'PUT';
  const auth = libAuthHeader(libCfg);
  // Best-effort: create the series collection first (WebDAV), once per folder.
  const folderUrl = joinLibraryUrl(libCfg.endpoint, seriesFolder);
  if (method === 'PUT' && !_libMkcolDone.has(folderUrl)) {
    _libMkcolDone.add(folderUrl);
    try { await fetch(folderUrl, { method: 'MKCOL', headers: auth ? { Authorization: auth } : {} }); } catch (_) {}
  }
  const headers = { 'Content-Type': 'application/vnd.comicbook+zip' };
  if (auth) headers['Authorization'] = auth;
  const resp = await fetch(joinLibraryUrl(libCfg.endpoint, seriesFolder, fileName), { method, headers, body: bytes });
  return resp.ok;
}
async function testLibrary(cfg) {
  if (!cfg || !/^https?:\/\//i.test(cfg.endpoint || '')) return { ok: false, error: 'Invalid URL' };
  // Without the optional host permission every fetch fails with a vague network
  // error — check it first so the message tells the user exactly what to do.
  try {
    // Same portless pattern as the options page grant: patterns with an
    // explicit port are invalid on Firefox; portless matches every port.
    const u = new URL(cfg.endpoint);
    const pat = `${u.protocol}//${u.hostname}/*`;
    const has = await new Promise((res) => {
      try { chrome.permissions.contains({ origins: [pat] }, (r) => res(!!r)); } catch (_) { res(true); }
    });
    if (!has) return { ok: false, error: 'No access to that server yet — click "Save & grant access" first' };
  } catch (_) {}
  const auth = libAuthHeader(cfg);
  const headers = auth ? { Authorization: auth } : {};
  try {
    let resp = await fetch(cfg.endpoint, { method: 'OPTIONS', headers });
    // Some servers reject OPTIONS outright — retry with a plain GET before judging.
    if (resp.status === 404 || resp.status === 405 || resp.status === 501) {
      try { resp = await fetch(cfg.endpoint, { method: 'GET', headers }); } catch (_) {}
    }
    if (resp.status === 401 || resp.status === 407) return { ok: false, status: resp.status, error: 'Authentication refused — check username/password' };
    if (resp.status === 403) return { ok: false, status: resp.status, error: 'Access forbidden (HTTP 403) — check the endpoint path and server permissions' };
    if (resp.status === 404) return { ok: false, status: resp.status, error: 'Not found (HTTP 404) — check the endpoint URL' };
    return { ok: true, status: resp.status };
  } catch (e) {
    return { ok: false, error: e.message || 'network error' };
  }
}
