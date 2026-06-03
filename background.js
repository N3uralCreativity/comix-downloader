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
// via manifest.background.scripts (jszip, settings, background — in that order).
if (typeof importScripts === 'function' && typeof CDLSettings === 'undefined') {
  importScripts('settings.js');
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

// Keep the activity-log cap in sync with user settings (cheap, read often).
if (typeof CDLSettings !== 'undefined') {
  CDLSettings.getSettings().then((cfg) => { MAX_LOG_ENTRIES = cfg['logs.maxEntries'] || 500; }).catch(() => {});
  CDLSettings.onChange((cfg) => { MAX_LOG_ENTRIES = cfg['logs.maxEntries'] || 500; });
}

let downloadAllSession = null;

// ── "New Additional Features page" notice ─────────────────────────────────────
// On install/update, flag the new Additional Features settings page and badge the
// toolbar icon so existing users notice it. The options page clears both the flag and
// the badge once the user opens that tab (see options.js clearFeaturesNotice).
const FEATURES_NOTICE_VERSION = '2.0.2';

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'install' && details.reason !== 'update') return;
  chrome.storage.local.get('cdlFeaturesNotice').then((res) => {
    const prev = res && res.cdlFeaturesNotice;
    if (prev && prev.seenVersion === FEATURES_NOTICE_VERSION) return; // already acknowledged
    chrome.storage.local.set({
      cdlFeaturesNotice: { active: true, seenVersion: (prev && prev.seenVersion) || null }
    });
    try {
      if (chrome.action && chrome.action.setBadgeText) {
        chrome.action.setBadgeText({ text: 'NEW' });
        if (chrome.action.setBadgeBackgroundColor) chrome.action.setBadgeBackgroundColor({ color: '#60a5fa' });
      }
    } catch (_) {}
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
  notifyTab(originTabId, { action: 'downloadAllProgress', ...progress });
}

function notifyDownloadAllDone(originTabId, zipName) {
  const message = { action: 'downloadAllDone', zipName };
  recordDownloadAllTerminal('done', {
    originTabId,
    doneZipName: zipName,
    lastDone: message,
  });
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
  notifyTab(originTabId, message);
}

function notifyDownloadAllCancelled(originTabId) {
  const message = { action: 'downloadAllCancelled' };
  recordDownloadAllTerminal('cancelled', {
    originTabId,
    lastCancelled: message,
  });
  notifyTab(originTabId, message);
}

// ── Réception des messages depuis content_title.js ───────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'downloadChapter') {
    const originTabId = sender.tab?.id ?? null;
    handleDownloadRequest(message.chapterUrl, message.zipName, originTabId);
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'downloadAllChapters') {
    const originTabId = sender.tab?.id ?? null;
    downloadAllAbortFlag = false;
    handleDownloadAllRequest(message.chapters, message.mangaName, message.zipName, originTabId);
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'cancelDownloadAll') {
    downloadAllAbortFlag = true;
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

});

// ── Logique principale ────────────────────────────────────────────────────────

async function handleDownloadRequest(chapterUrl, zipName, originTabId) {
  cdlLog('info', `Download started: ${zipName}`);
  const cfg = await loadCfg();
  try {
    // Ouvrir un onglet en arrière-plan
    const tab = await chrome.tabs.create({
      url: chapterUrl,
      active: false,
      pinned: false,
    });

    pendingDownloads.set(tab.id, { chapterUrl, zipName, originTabId, cfg });
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

  const { chapterUrl, zipName, originTabId, cfg } = pendingDownloads.get(tabId);
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
    scheduleDownload({ images, chapterUrl, zipName, originTabId, cfg });
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

async function downloadImagesAsZip({ images, chapterUrl, zipName, originTabId, cfg }) {
  cfg = cfg || {};
  const batchSize = cfg['perf.batchSize'] || BATCH_SIZE;
  const padDigits = cfg['naming.imagePadDigits'] || 3;
  const imageRetries = cfg['retry.imageRetries'] || 0;
  const zip = new JSZip();
  const total = images.length;
  let done = 0;

  for (let i = 0; i < images.length; i += batchSize) {
    const batch = images.slice(i, i + batchSize);
    await Promise.allSettled(
      batch.map(async ({ src, index }) => {
        const paddedIndex = String(index).padStart(padDigits, '0');
        // Image introuvable (ex. numéro de page hors limites) → on l'ignore,
        // pas de fichier vide dans le ZIP.
        await fetchImageIntoZip(zip, paddedIndex, src, cfg, imageRetries);
        done++;
        notifyTab(originTabId, { action: 'downloadProgress', chapterUrl, current: done, total });
      })
    );
  }

  const { url, revoke, base64: urlBase64 } = await _zipToDownloadUrl(zip);
  try {
    await chrome.downloads.download({ url, filename: sanitizeFilename(zipName), saveAs: false });
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
        filename: sanitizeFilename(zipName),
      }).catch(() => {});
    } else {
      throw _dlErr;
    }
  }

  cdlLog('ok', `ZIP saved: ${sanitizeFilename(zipName)} (${images.length} images)`);
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

function sanitizeFilename(name) {
  const base = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\.zip$/i, '')
    .replace(/\.+$/, '')
    .substring(0, 196);
  return `${base || 'download'}.zip`;
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
async function handleDownloadAllRequest(chapters, mangaName, zipName, originTabId) {
  const cfg = await loadCfg();
  const batchSize = cfg['perf.batchSize'] || BATCH_SIZE;
  const padDigits = cfg['naming.imagePadDigits'] || 3;
  const imageRetries = cfg['retry.imageRetries'] || 0;
  const chapterRetries = cfg['retry.chapterRetries'] || 0;
  const splitMode = cfg['download.splitMode'] || 'multipart';
  const maxChapters = splitMode === 'single' ? Infinity : (cfg['download.chaptersPerPart'] || ZIP_PART_MAX_CHAPTERS);
  const maxBytes = splitMode === 'single' ? Infinity : (cfg['download.mbPerPart'] || 300) * 1024 * 1024;
  const folderFmt = cfg['naming.chapterFolderFmt'] || 'Ch{num4}{rest}';

  startDownloadAllSession({ originTabId, mangaName, zipName, totalChapters: chapters.length });
  cdlLog('info', `Download All started: "${mangaName}" — ${chapters.length} chapters`);
  let zip = new JSZip();
  let zipPart = 1;
  let zipPartChapters = 0;
  let zipPartBytes = 0;
  const savedZipNames = [];
  const notify = (extra) => notifyDownloadAllProgress(originTabId, extra);

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

  // Rate limiting entre chapitres (dynamic / fixed / off)
  const rateMode = cfg['perf.rateLimitMode'] || 'dynamic';
  let rateDelay = cfg['perf.rateBaseMs'] != null ? cfg['perf.rateBaseMs'] : 1500;  // ms
  const MIN_DELAY = cfg['perf.rateMinMs'] != null ? cfg['perf.rateMinMs'] : 800;
  const MAX_DELAY = cfg['perf.rateMaxMs'] || 8000;

  for (let i = 0; i < chapters.length; i++) {
    if (downloadAllAbortFlag) { notifyDownloadAllCancelled(originTabId); return; }

    const { chapterUrl, chapterLabel } = chapters[i];
    // Nom de dossier (template) avec numéro paddé pour tri alphabétique correct
    const folderName = buildChapterFolderName(folderFmt, chapterLabel, mangaName);

    notify({ phase: 'extracting', chapterIndex: i + 1, totalChapters: chapters.length,
             chapterLabel, imagesDone: 0, imagesTotal: 0 });

    try {
      let images = null, extractErr = null;
      for (let attempt = 0; attempt <= chapterRetries; attempt++) {
        try { images = await extractFromTab(chapterUrl, cfg); extractErr = null; break; }
        catch (e) { extractErr = e; images = null; }
      }
      if (extractErr) throw extractErr;
      if (!images || images.length === 0) {
        cdlLog('warn', `No images found, skipping ${chapterLabel}`);
        notify({ phase: 'skipped', chapterIndex: i + 1, totalChapters: chapters.length,
                 chapterLabel, imagesDone: 0, imagesTotal: 0 });
        continue;
      }
      cdlLog('info', `${chapterLabel}: extracted ${images.length} images`);

      const folder = zip.folder(folderName);
      let imgDone = 0;

      for (let j = 0; j < images.length; j += batchSize) {
        if (downloadAllAbortFlag) break;
        const batch = images.slice(j, j + batchSize);
        await Promise.allSettled(batch.map(async ({ src, index }) => {
          const paddedIndex = String(index).padStart(padDigits, '0');
          const bytes = await fetchImageIntoZip(folder, paddedIndex, src, cfg, imageRetries);
          zipPartBytes += bytes;
          imgDone++;
          notify({ phase: 'downloading', chapterIndex: i + 1, totalChapters: chapters.length,
                   chapterLabel, imagesDone: imgDone, imagesTotal: images.length });
        }));
      }

      notify({ phase: 'done', chapterIndex: i + 1, totalChapters: chapters.length,
               chapterLabel, imagesDone: imgDone, imagesTotal: images.length });
      cdlLog('ok', `${chapterLabel}: done (${imgDone} images)`);
      zipPartChapters++;
      if (rateMode === 'dynamic') rateDelay = Math.max(MIN_DELAY, rateDelay - 100); // succès → légèrement plus rapide

    } catch (err) {
      console.warn(`[ComixDL-All] Chapitre ${chapterLabel} échoué:`, err.message);
      cdlLog('error', `${chapterLabel} failed: ${err.message}`);
      if (rateMode === 'dynamic') rateDelay = Math.min(MAX_DELAY, Math.round(rateDelay * 1.5)); // échec → ralentir
      notify({ phase: 'error', chapterIndex: i + 1, totalChapters: chapters.length,
               chapterLabel, imagesDone: 0, imagesTotal: 0 });
    }

    if (i < chapters.length - 1 &&
        (zipPartChapters >= maxChapters || zipPartBytes >= maxBytes)) {
      const saved = await saveCurrentZipPart(false);
      if (!saved) return;
    }

    // Pause entre chapitres (rate limiting)
    if (rateMode !== 'off' && i < chapters.length - 1 && !downloadAllAbortFlag) {
      await new Promise(r => setTimeout(r, rateDelay));
    }
  }

  if (downloadAllAbortFlag) { notifyDownloadAllCancelled(originTabId); return; }

  // Génération du ZIP final
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
