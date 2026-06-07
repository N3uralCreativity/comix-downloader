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

function _setNewToolbarBadge() {
  try {
    if (chrome.action && chrome.action.setBadgeText) {
      chrome.action.setBadgeText({ text: 'NEW' });
      if (chrome.action.setBadgeBackgroundColor) chrome.action.setBadgeBackgroundColor({ color: '#60a5fa' });
    }
  } catch (_) {}
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
function restoreIdleBadge() {
  try {
    if (!(chrome.action && chrome.action.setBadgeText)) return;
    chrome.storage.local.get(['cdlFeaturesNotice', 'cdlConcurrencyNotice']).then((res) => {
      const active = (res.cdlFeaturesNotice && res.cdlFeaturesNotice.active) ||
                     (res.cdlConcurrencyNotice && res.cdlConcurrencyNotice.active);
      if (active) _setNewToolbarBadge();
      else chrome.action.setBadgeText({ text: '' });
    }).catch(() => { try { chrome.action.setBadgeText({ text: '' }); } catch (_) {} });
  } catch (_) {}
}

// ── Right-click context menu ──────────────────────────────────────────────────
function setupContextMenus() {
  if (!chrome.contextMenus) return;
  try {
    chrome.contextMenus.removeAll(() => {
      try {
        chrome.contextMenus.create({
          id: 'cdl-dl-chapter', title: 'Download this chapter',
          contexts: ['link'], targetUrlPatterns: ['*://comix.to/title/*']
        });
        chrome.contextMenus.create({
          id: 'cdl-dl-series', title: 'Download whole series (open options)',
          contexts: ['page'], documentUrlPatterns: ['*://comix.to/title/*']
        });
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

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'install' && details.reason !== 'update') return;
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
  if (!downloadAllSession.active) downloadAllSession = null;
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
    handleDownloadRequest(message.chapterUrl, message.zipName, originTabId, message.options);
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'downloadAllChapters') {
    const originTabId = sender.tab?.id ?? null;
    _resetDownloadAllAbort();
    handleDownloadAllRequest(message.chapters, message.mangaName, message.zipName, originTabId, message.options);
    sendResponse({ ok: true });
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
    if (_pendingZip) {
      _doZipAndSave(_pendingZip);
    } else {
      notifyDownloadAllError(originTabId, 'Session expired - please restart Download All');
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'getDownloadAllSession') {
    const originTabId = sender.tab?.id ?? null;
    sendResponse({ ok: true, session: getDownloadAllSessionForTab(originTabId) });
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
    checkAllSubscriptions().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.action === 'libraryTest') {
    testLibrary(message.config).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

});

// ── Logique principale ────────────────────────────────────────────────────────

async function handleDownloadRequest(chapterUrl, zipName, originTabId, options) {
  cdlLog('info', `Download started: ${zipName}`);
  const cfg = await loadCfg();
  try {
    // Ouvrir un onglet en arrière-plan
    const tab = await chrome.tabs.create({
      url: chapterUrl,
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

    const images = results?.[0]?.result;
    if (!Array.isArray(images) || images.length === 0) {
      throw new Error('Aucune image trouvée dans ce chapitre');
    }

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
// IMPORTANT : entièrement auto-contenue (pas de closures externes)
// Stratégie : on ne s'appuie PAS sur le lazy-loading pour avoir tous les src.
// On récupère l'URL de la 1ère image chargée, on en déduit le pattern (base + numérotation),
// et on reconstruit séquentiellement toutes les URLs.

async function extractChapterImagesFromPage(opts) {
  opts = opts || {};
  const aggressive = !!opts.aggressive;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // User-tunable render/scroll waits (defaults == previous hardcoded literals).
  // Aggressive mode halves the poll/settle waits, exactly as before.
  const pollMs        = aggressive ? Math.round((opts.pollMs   || 400) / 2) : (opts.pollMs   || 400);
  const settleMs      = aggressive
    ? Math.round((opts.settleMs != null ? opts.settleMs : 300) / 2)
    : (opts.settleMs != null ? opts.settleMs : 300);
  const scrollSettleMs = opts.scrollSettleMs != null ? opts.scrollSettleMs : 800;

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

async function unscrambleImageBlob(blob, { seed, cols, rows }) {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('createImageBitmap is unavailable');
  }

  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = createZipCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context is unavailable');

    const tileW = Math.floor(bitmap.width / cols);
    const tileH = Math.floor(bitmap.height / rows);
    if (tileW < 1 || tileH < 1) throw new Error('invalid scramble grid');

    const permutation = makeScramblePermutation(seed, cols * rows);
    for (let i = 0; i < permutation.length; i++) {
      const srcX = (i % cols) * tileW;
      const srcY = Math.floor(i / cols) * tileH;
      const dstIndex = permutation[i];
      const dstX = (dstIndex % cols) * tileW;
      const dstY = Math.floor(dstIndex / cols) * tileH;
      ctx.drawImage(bitmap, srcX, srcY, tileW, tileH, dstX, dstY, tileW, tileH);
    }

    const outBlob = await canvasToBlob(canvas, 'image/png');
    return {
      buffer: await outBlob.arrayBuffer(),
      ext: 'png',
    };
  } finally {
    bitmap.close?.();
  }
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

function makeScramblePermutation(seed, count) {
  const order = Array.from({ length: count }, (_, i) => i);
  let state = seed >>> 0;

  for (let remaining = count; remaining >= 2; remaining--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
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
    title: chapterLabel || undefined,
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
    if (opts.pushLib) {
      const fileBase = opts.folderLayout === 'kavita' ? entryBase.split('/').pop() : entryBase;
      try {
        const ok = await pushFileToLibrary(opts.pushLib, seriesFolderName(mangaName), `${fileBase}.cbz`, bytes);
        cdlLog(ok ? 'ok' : 'error', `Library push ${ok ? 'ok' : 'failed'}: ${fileBase}.cbz`);
      } catch (e) {
        cdlLog('error', `Library push failed: ${fileBase}.cbz (${e.message})`);
      }
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
      const resp = await fetch(meta.coverUrl, { headers: { Referer: 'https://comix.to/' } });
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
  const tab = await chrome.tabs.create({ url, active: false });
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
// Up to `download.concurrentChapters` (1–4) chapters are downloaded at the same
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
  const concurrency = Math.max(1, Math.min(4, parseInt(cfg['download.concurrentChapters'], 10) || 1));
  const batchSize = cfg['perf.batchSize'] || BATCH_SIZE;
  const padDigits = cfg['naming.imagePadDigits'] || 3;
  const imageRetries = cfg['retry.imageRetries'] || 0;
  const chapterRetries = cfg['retry.chapterRetries'] || 0;
  const splitMode = cfg['download.splitMode'] || 'multipart';
  const maxChapters = splitMode === 'single' ? Infinity : (cfg['download.chaptersPerPart'] || ZIP_PART_MAX_CHAPTERS);
  const maxBytes = splitMode === 'single' ? Infinity : (cfg['download.mbPerPart'] || 300) * 1024 * 1024;

  startDownloadAllSession({ originTabId, mangaName, zipName, totalChapters: chapters.length });
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

// Fetch the FULL current chapter list for a series, credentialed (so the user's
// cf_clearance cookie is sent → usually clears Cloudflare). Returns sorted
// [{chapterUrl, chapterLabel, key}] or null when blocked/empty (degrade silently).
async function fetchSeriesChapters(slug) {
  if (!slug) return null;
  const extract = (text) => (typeof CDLFeaturesCore !== 'undefined')
    ? CDLFeaturesCore.extractChapterPaths(text)
    : (String(text).match(/\/title\/[a-z0-9-]+\/\d+-chapter-[\w.-]+/gi) || []);
  const toUrl = (p) => { try { return new URL(p, 'https://comix.to').href; } catch (_) { return ''; } };

  let html = '';
  try {
    const r = await fetch(`https://comix.to/title/${slug}`, { credentials: 'include', headers: { Accept: 'text/html' } });
    if (!r.ok) return null;
    html = await r.text();
  } catch (_) { return null; }

  const urlSet = new Set();
  extract(html).forEach((p) => { const u = toUrl(p); if (u) urlSet.add(u); });
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
      extract(text).forEach((p) => { const u = toUrl(p); if (u && !urlSet.has(u)) { urlSet.add(u); fresh++; } });
      if (!fresh && page > 1) break;
    }
  }
  if (!urlSet.size) return null;

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

// ── Subscriptions ─────────────────────────────────────────────────────────────
const SUBSCRIBE_ALARM = 'cdlSubscribeCheck';

async function setupSubscribeAlarm() {
  if (!chrome.alarms) return;
  let cfg = {};
  try { cfg = await loadCfg(); } catch (_) {}
  try { await chrome.alarms.clear(SUBSCRIBE_ALARM); } catch (_) {}
  if (cfg['subscribe.enabled']) {
    const mins = Math.max(30, Math.min(1440, cfg['subscribe.intervalMinutes'] || 360));
    try { chrome.alarms.create(SUBSCRIBE_ALARM, { periodInMinutes: mins, delayInMinutes: 1 }); } catch (_) {}
  }
}

async function subscribeSeries(slug, mangaName) {
  if (!slug) return;
  const { cdlSubscriptions = {} } = await chrome.storage.local.get('cdlSubscriptions');
  if (!cdlSubscriptions[slug]) cdlSubscriptions[slug] = { mangaName: mangaName || slug, lastSeen: [], lastCheck: 0 };
  else if (mangaName) cdlSubscriptions[slug].mangaName = mangaName;
  await chrome.storage.local.set({ cdlSubscriptions });
  // Subscribing implies wanting background checks — enable the master toggle once.
  try {
    const cfg = await loadCfg();
    if (!cfg['subscribe.enabled'] && typeof CDLSettings !== 'undefined') await CDLSettings.patchSettings({ 'subscribe.enabled': true });
  } catch (_) {}
  setupSubscribeAlarm();
}

async function unsubscribeSeries(slug) {
  const { cdlSubscriptions = {} } = await chrome.storage.local.get('cdlSubscriptions');
  if (cdlSubscriptions[slug]) { delete cdlSubscriptions[slug]; await chrome.storage.local.set({ cdlSubscriptions }); }
}

async function checkAllSubscriptions() {
  let cfg = {};
  try { cfg = await loadCfg(); } catch (_) {}
  if (!cfg['subscribe.enabled']) return;
  const { cdlSubscriptions = {} } = await chrome.storage.local.get('cdlSubscriptions');
  for (const slug of Object.keys(cdlSubscriptions)) {
    try { await checkOneSubscription(slug, cdlSubscriptions[slug], cfg); } catch (_) {}
  }
}

async function checkOneSubscription(slug, sub, cfg) {
  const chapters = await fetchSeriesChapters(slug);
  if (!chapters || !chapters.length) return; // blocked or nothing — try again next cycle
  const hadBaseline = Array.isArray(sub.lastSeen) && sub.lastSeen.length > 0;
  const seen = new Set(sub.lastSeen || []);
  const newOnes = chapters.filter((c) => !seen.has(c.key));

  // Persist the fresh baseline + timestamp.
  const { cdlSubscriptions = {} } = await chrome.storage.local.get('cdlSubscriptions');
  const entry = cdlSubscriptions[slug] || sub || {};
  entry.mangaName = entry.mangaName || sub.mangaName || slug;
  entry.lastSeen = chapters.map((c) => c.key);
  entry.lastCheck = Date.now();
  cdlSubscriptions[slug] = entry;
  await chrome.storage.local.set({ cdlSubscriptions });

  if (!hadBaseline || !newOnes.length) return; // first successful check just baselines
  cdlLog('ok', `${entry.mangaName}: ${newOnes.length} new chapter(s) found`);
  if (cfg['subscribe.notify']) notifyNewChapters(slug, entry.mangaName, newOnes);
  if (cfg['subscribe.autoDownload']) autoDownloadNew(slug, entry.mangaName, newOnes, cfg);
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

async function autoDownloadNew(slug, mangaName, newOnes, cfg) {
  if (downloadAllSession && downloadAllSession.active) return; // don't collide with a running session
  _resetDownloadAllAbort();
  const prefs = await getSeriesPrefsBg(slug);
  const options = {
    format: prefs.format || cfg['output.format'] || 'zip',
    includeComicInfo: prefs.includeComicInfo != null ? prefs.includeComicInfo : (cfg['output.includeComicInfo'] !== false),
    includeSeriesMeta: false,
    folderLayout: prefs.folderLayout || cfg['output.folderLayout'] || 'default',
    slug,
    seriesMeta: { title: mangaName, slug },
    totalCount: 0,
  };
  let zipName = `${mangaName}-new`;
  try { if (typeof CDLSettings !== 'undefined') zipName = `${CDLSettings.renderName(cfg['naming.allZipTpl'] || '{manga}', { manga: mangaName }, 180)}-new`; } catch (_) {}
  const chapters = newOnes.map((c) => ({ chapterUrl: c.chapterUrl, chapterLabel: c.chapterLabel }));
  cdlLog('info', `Auto-downloading ${chapters.length} new chapter(s) of "${mangaName}"`);
  handleDownloadAllRequest(chapters, mangaName, zipName, null, options);
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
async function pushFileToLibrary(libCfg, seriesFolder, fileName, bytes) {
  const method = libCfg.method === 'POST' ? 'POST' : 'PUT';
  const auth = libAuthHeader(libCfg);
  // Best-effort: create the series collection first (WebDAV). Ignored elsewhere.
  if (method === 'PUT') {
    try { await fetch(joinLibraryUrl(libCfg.endpoint, seriesFolder), { method: 'MKCOL', headers: auth ? { Authorization: auth } : {} }); } catch (_) {}
  }
  const headers = { 'Content-Type': 'application/vnd.comicbook+zip' };
  if (auth) headers['Authorization'] = auth;
  const resp = await fetch(joinLibraryUrl(libCfg.endpoint, seriesFolder, fileName), { method, headers, body: bytes });
  return resp.ok;
}
async function testLibrary(cfg) {
  if (!cfg || !/^https?:\/\//i.test(cfg.endpoint || '')) return { ok: false, error: 'Invalid URL' };
  const auth = libAuthHeader(cfg);
  try {
    const resp = await fetch(cfg.endpoint, { method: 'OPTIONS', headers: auth ? { Authorization: auth } : {} });
    return { ok: true, status: resp.status };
  } catch (e) {
    return { ok: false, error: e.message || 'network error' };
  }
}
