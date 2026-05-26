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

'use strict';

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

const BATCH_SIZE = 3;
const MAX_LOG_ENTRIES = 500;
const ZIP_PART_MAX_CHAPTERS = 5;
const ZIP_PART_MAX_BYTES = 300 * 1024 * 1024;
const DOWNLOAD_ALL_LOG_LIMIT = 150;
const DOWNLOAD_ALL_TERMINAL_SESSION_TTL_MS = 2 * 60 * 1000;

let downloadAllSession = null;

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
  try {
    // Ouvrir un onglet en arrière-plan
    const tab = await chrome.tabs.create({
      url: chapterUrl,
      active: false,
      pinned: false,
    });

    pendingDownloads.set(tab.id, { chapterUrl, zipName, originTabId });
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

  const { chapterUrl, zipName, originTabId } = pendingDownloads.get(tabId);
  pendingDownloads.delete(tabId);

  try {
    // Injecter le script d'extraction dans l'onglet chapitre
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractChapterImagesFromPage,
    });

    // Fermer l'onglet dès que possible
    chrome.tabs.remove(tabId).catch(() => {});

    const payload = results?.[0]?.result;
    const images = Array.isArray(payload) ? payload : (payload?.images || []);
    const dataUrls = (payload && !Array.isArray(payload)) ? (payload.dataUrls || {}) : {};
    if (!Array.isArray(images) || images.length === 0) {
      throw new Error('Aucune image trouvée dans ce chapitre');
    }

    const scrambledCount = Object.keys(dataUrls).length;
    cdlLog('info', `Extracted ${images.length} images for ${zipName}${scrambledCount ? ` (${scrambledCount} unscrambled via canvas)` : ''}`);
    // Lancer le téléchargement + ZIP directement dans le service worker
    scheduleDownload({ images, chapterUrl, zipName, originTabId, dataUrls });
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

async function extractChapterImagesFromPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── Descrambling (comix.to) ───────────────────────────────────────────────
  // Le site applique côté client un canvas-unscramble via une fonction Mr
  // obfusquée (export "t" de secure-tfl4t2-*.js). Plutôt que de réimplémenter
  // sa logique (qui change), on laisse la page produire le canvas et on lit
  // les pixels. Détection per-image : l'URL contient "/si/" (vs "/i/" pour
  // les images non scramblées) — confirmé dans le code source comix.to :
  //     url: (n ? t : e) + a.url   où t = baseUrl.replace(/\/i\/(?=[bh])/, "/si/")
  //
  // `finalize` à la fin du flux récupère les canvases rendus et renvoie un
  // objet { images, dataUrls } où dataUrls[index] = PNG base64 quand dispo.
  const isScrambledUrl = (u) => typeof u === 'string' && /\/si\//.test(u);

  // Captures one canvas as a base64 image. Returns null if not yet drawn or
  // tainted (the page's Mr loads images via fetch→blob→bitmap so the canvas
  // shouldn't be tainted, but we handle the edge case anyway).
  // WebP at q=0.95 ≈ visually lossless for manga but ~5× smaller than PNG,
  // which matters because we serialize 89+ images back through executeScript.
  const captureCanvasAsDataUrl = (canvas) => {
    if (!canvas || !canvas.width || !canvas.height) return null;
    try {
      const ctx = canvas.getContext('2d');
      // Sample the center pixel — if alpha is 0 the canvas hasn't been drawn yet.
      const mid = ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1);
      if (mid.data[3] === 0) return null;
      // Prefer webp; fall back to PNG if the browser refuses (very old Firefox).
      const webp = canvas.toDataURL('image/webp', 0.95);
      if (webp && webp.startsWith('data:image/webp')) return webp;
      return canvas.toDataURL('image/png');
    } catch (_) { return null; }
  };

  const collectScrambledCaptures = async () => {
    const rpages = [...document.querySelectorAll('.rpage-page')];
    if (rpages.length === 0) return {};

    // Filename → dataUrl (we key by the trailing "NN.webp" so we can match
    // back to whatever URL the SW ends up fetching, regardless of host).
    const captures = {};
    const PER_PAGE_TIMEOUT_MS = 8000;
    const SCROLL_SETTLE_MS = 150;
    // Bail out of the whole loop if total runtime exceeds this — prevents a
    // single broken chapter from locking the extension up indefinitely.
    const OVERALL_TIMEOUT_MS = 4 * 60 * 1000;
    const overallDeadline = Date.now() + OVERALL_TIMEOUT_MS;

    for (const el of rpages) {
      if (Date.now() > overallDeadline) break;
      const img = el.querySelector('img');
      const url = img?.currentSrc || img?.src || '';
      if (!isScrambledUrl(url)) continue;

      el.scrollIntoView({ block: 'center', behavior: 'auto' });
      await sleep(SCROLL_SETTLE_MS);

      const start = Date.now();
      let dataUrl = null;
      while (Date.now() - start < PER_PAGE_TIMEOUT_MS) {
        const canvas = el.querySelector('canvas');
        dataUrl = captureCanvasAsDataUrl(canvas);
        if (dataUrl) break;
        await sleep(200);
      }
      if (!dataUrl) continue;

      // Key the capture by the filename portion of the URL (e.g. "07.webp").
      // The SW reconstructs URLs by pattern so the *path* may differ slightly,
      // but the trailing filename is stable.
      const fname = url.split('/').pop() || '';
      captures[fname] = dataUrl;
      // Also key by full URL for exact-match lookups.
      captures[url] = dataUrl;
    }
    return captures;
  };

  // Wraps every outer return : after URL discovery, walk the rendered pages
  // and grab any scrambled canvases as PNG data URLs.
  const finalize = async (images) => {
    let dataUrls = {};
    // Only do the slow canvas-reading pass if at least one image URL is
    // scrambled — otherwise this is just a normal chapter and we skip it.
    const anyScrambled =
      images.some(img => isScrambledUrl(img && img.src)) ||
      [...document.querySelectorAll('.rpage-page img')]
        .some(im => isScrambledUrl(im.currentSrc || im.src));
    if (anyScrambled) {
      try { dataUrls = await collectScrambledCaptures(); } catch (_) {}
    }
    return { images, dataUrls };
  };

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
      if (completed) return finalize(completed);
      // Échec énumération → continuer vers stratégie 2 (DOM + scroll)
    } else {
      // textContent confirme ou ne dépasse pas → __NEXT_DATA__ est complet
      return finalize(fromNextDataRaw);
    }
  }

  // ── STRATÉGIE 2 : pattern d'URL + énumération séquentielle ──────────────────

  // 1. Attendre qu'au moins un img[alt^="Page"] soit dans le DOM
  let retries = 25;
  while (retries-- > 0) {
    if (document.querySelectorAll('img[alt^="Page"]').length > 0) break;
    await sleep(400);
  }
  await sleep(300);

  // 2. Scroll léger pour déclencher le chargement de la 1ère image visible
  window.scrollTo(0, 0);
  await sleep(200);
  window.scrollTo(0, 500);
  await sleep(800);
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
    if (fromNextDataFull && fromNextDataFull.length >= total) return finalize(fromNextDataFull);
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
    await sleep(800);
    window.scrollTo(0, 0);
    for (const img of [...document.querySelectorAll('img[alt^="Page"]')]) {
      baseSrc = findSrc(img);
      if (baseSrc) break;
    }
  }

  // Aucune image trouvable → retourner ce qu'on a dans le DOM
  if (!baseSrc) {
    return finalize(pageImgEls
      .map((img) => ({ src: findSrc(img), index: parseInt((img.alt || '').replace(/\D/g, ''), 10) || 0 }))
      .filter((x) => x.src)
      .sort((a, b) => a.index - b.index));
  }

  // 5. Parser le pattern URL : https://cdn/.../HASH/01.webp
  const urlMatch = baseSrc.match(/^(https?:\/\/.+\/)(\d+)(\.\w+)$/i);
  if (!urlMatch) {
    return finalize(pageImgEls
      .map((img) => ({ src: findSrc(img), index: parseInt((img.alt || '').replace(/\D/g, ''), 10) || 0 }))
      .filter((x) => x.src)
      .sort((a, b) => a.index - b.index));
  }

  const baseUrl   = urlMatch[1];          // "https://cdn/.../HASH/"
  const numDigits = urlMatch[2].length;   // 2 → "01", 3 → "001"
  const ext       = urlMatch[3];          // ".webp"

  if (total <= 0) total = 50; // garde-fou absolu

  // 6. Construire toutes les URLs séquentiellement
  return finalize(Array.from({ length: total }, (_, i) => ({
    src:   `${baseUrl}${String(i + 1).padStart(numDigits, '0')}${ext}`,
    index: i + 1,
  })));
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

async function downloadImagesAsZip({ images, chapterUrl, zipName, originTabId, dataUrls }) {
  const zip = new JSZip();
  const total = images.length;
  let done = 0;

  for (let i = 0; i < images.length; i += BATCH_SIZE) {
    const batch = images.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async ({ src, index }) => {
        const paddedIndex = String(index).padStart(3, '0');
        try {
          // Si la page a déjà rendu (et nous a renvoyé) un canvas unscramblé
          // pour cette image, on l'utilise directement — sinon on télécharge
          // les bytes bruts depuis le CDN.
          const captured = pickCapturedDataUrl(src, dataUrls);
          if (captured) {
            const { buf, ext } = decodeDataUrl(captured);
            zip.file(`${paddedIndex}.${ext}`, buf);
          } else {
            const controller = new AbortController();
            const timeoutId  = setTimeout(() => controller.abort(), 30000);
            const response   = await fetch(src, {
              signal:  controller.signal,
              headers: {
                Accept:  'image/webp,image/avif,image/*,*/*;q=0.8',
                Referer: 'https://comix.to/',
              },
            });
            clearTimeout(timeoutId);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const buf = await response.arrayBuffer();
            const ext = (src.match(/\.([a-z0-9]+)$/i) || [, 'webp'])[1];
            zip.file(`${paddedIndex}.${ext}`, buf);
          }
        } catch (err) {
          // Image introuvable (ex. numéro de page hors limites) → on l'ignore,
          // pas de fichier vide dans le ZIP.
          console.warn(`[ComixDL] Image ${index} ignorée:`, err.message);
        }
        done++;
        notifyTab(originTabId, { action: 'downloadProgress', chapterUrl, current: done, total });
      })
    );
  }

  const { url, revoke } = await _zipToDownloadUrl(zip);
  await chrome.downloads.download({ url, filename: sanitizeFilename(zipName), saveAs: false });
  setTimeout(revoke, 60_000);

  cdlLog('ok', `ZIP saved: ${sanitizeFilename(zipName)} (${images.length} images)`);
  notifyTab(originTabId, { action: 'downloadDone', chapterUrl });
}

// ── Utilitaires ───────────────────────────────────────────────────────────────

/**
 * Comix.to applique son descrambling côté client via une fonction obfusquée
 * (Mr dans secure-tfl4t2-*.js) — réimplémenter sa logique est impraticable et
 * fragile. À la place, l'injected script scrolle dans la page chapitre,
 * attend que chaque canvas <canvas class="rpage-page__img"> soit rendu, puis
 * lit ses pixels via toDataURL('image/png'). Ces dataUrls sont passés au SW
 * dans `dataUrls` keyed by filename and full URL.
 *
 * Les fonctions ci-dessous décodent ces captures pour le ZIP.
 */
function pickCapturedDataUrl(src, dataUrls) {
  if (!src || !dataUrls) return null;
  if (dataUrls[src]) return dataUrls[src];
  const fname = src.split('/').pop() || '';
  if (fname && dataUrls[fname]) return dataUrls[fname];
  return null;
}

function decodeDataUrl(dataUrl) {
  const m = dataUrl.match(/^data:([^;,]+)(?:;base64)?,(.*)$/);
  if (!m) throw new Error('Invalid data URL');
  const mime = m[1];
  const binary = atob(m[2]);
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  const ext = (mime.split('/')[1] || 'png').toLowerCase();
  return { buf, ext };
}

/**
 * Génère le ZIP et retourne une URL téléchargeable.
 * Priorité : blob: URL (sans limite de taille, Chrome 120+).
 * Fallback  : data: base64 (Chrome < 120, taille limitée ≈ 500 Mo).
 * Retourne { url, revoke } — appeler revoke() une fois le téléchargement lancé.
 */
async function _zipToDownloadUrl(zip) {
  // Blob URL — pas de limite de taille, libère la mémoire correctement
  try {
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const url  = URL.createObjectURL(blob);
    return { url, revoke: () => URL.revokeObjectURL(url) };
  } catch (_) {}
  // Fallback base64 pour navigateurs plus anciens
  const base64 = await zip.generateAsync({ type: 'base64', compression: 'STORE' });
  return { url: `data:application/zip;base64,${base64}`, revoke: () => {} };
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

// ── Notification vers un onglet ───────────────────────────────────────────────

function notifyTab(tabId, message) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// ── Extraction Promise-based (pour download-all) ──────────────────────────────
// Ouvre un onglet, attend le chargement complet, injecte le script d'extraction,
// retourne { images, scramble } ou lance une exception.
async function extractFromTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;

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
    }, 120_000);

    const onUpdated = async (updatedId, changeInfo) => {
      if (updatedId !== tabId || changeInfo.status !== 'complete') return;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func:   extractChapterImagesFromPage,
        });
        chrome.tabs.remove(tabId).catch(() => {});
        const payload = results?.[0]?.result;
        const images = Array.isArray(payload) ? payload : (payload?.images || []);
        const dataUrls = (payload && !Array.isArray(payload)) ? (payload.dataUrls || {}) : {};
        settle(resolve, { images, dataUrls });
      } catch (err) {
        chrome.tabs.remove(tabId).catch(() => {});
        settle(reject, err);
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

    // Protection contre la race condition : si l'onglet est déjà chargé
    chrome.tabs.get(tabId).then(t => {
      if (t?.status === 'complete') onUpdated(tabId, { status: 'complete' });
    }).catch(() => {});
  });
}

// ── Téléchargement de tous les chapitres ──────────────────────────────────────
async function handleDownloadAllRequest(chapters, mangaName, zipName, originTabId) {
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

  // Rate limiting dynamique entre chapitres
  let rateDelay = 1500;  // ms
  const MIN_DELAY = 800, MAX_DELAY = 8000;

  for (let i = 0; i < chapters.length; i++) {
    if (downloadAllAbortFlag) { notifyDownloadAllCancelled(originTabId); return; }

    const { chapterUrl, chapterLabel } = chapters[i];
    // Nom de dossier avec numéro paddé pour tri alphabétique correct
    const folderName = chapterLabel.replace(/^Ch([\d.]+)(.*)/i,
      (_, n, rest) => `Ch${n.padStart(4, '0')}${rest}`);

    notify({ phase: 'extracting', chapterIndex: i + 1, totalChapters: chapters.length,
             chapterLabel, imagesDone: 0, imagesTotal: 0 });

    try {
      const { images, dataUrls } = await extractFromTab(chapterUrl);
      if (!images || images.length === 0) {
        cdlLog('warn', `No images found, skipping ${chapterLabel}`);
        notify({ phase: 'skipped', chapterIndex: i + 1, totalChapters: chapters.length,
                 chapterLabel, imagesDone: 0, imagesTotal: 0 });
        continue;
      }
      const captured = Object.keys(dataUrls || {}).length;
      cdlLog('info', `${chapterLabel}: extracted ${images.length} images${captured ? ` (${captured} unscrambled via canvas)` : ''}`);

      const folder = zip.folder(folderName);
      let imgDone = 0;

      for (let j = 0; j < images.length; j += BATCH_SIZE) {
        if (downloadAllAbortFlag) break;
        const batch = images.slice(j, j + BATCH_SIZE);
        await Promise.allSettled(batch.map(async ({ src, index }) => {
          const paddedIndex = String(index).padStart(3, '0');
          try {
            const captured = pickCapturedDataUrl(src, dataUrls);
            if (captured) {
              const { buf, ext } = decodeDataUrl(captured);
              folder.file(`${paddedIndex}.${ext}`, buf);
              zipPartBytes += buf.byteLength;
            } else {
              const ctrl = new AbortController();
              const t    = setTimeout(() => ctrl.abort(), 30_000);
              const res  = await fetch(src, {
                signal:  ctrl.signal,
                headers: { Accept: 'image/webp,image/avif,image/*,*/*;q=0.8', Referer: 'https://comix.to/' },
              });
              clearTimeout(t);
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const buf = await res.arrayBuffer();
              const ext = (src.match(/\.([a-z0-9]+)$/i) || [, 'webp'])[1];
              folder.file(`${paddedIndex}.${ext}`, buf);
              zipPartBytes += buf.byteLength;
            }
          } catch (err) {
            console.warn(`[ComixDL-All] ${chapterLabel} img ${index} ignorée:`, err.message);
          }
          imgDone++;
          notify({ phase: 'downloading', chapterIndex: i + 1, totalChapters: chapters.length,
                   chapterLabel, imagesDone: imgDone, imagesTotal: images.length });
        }));
      }

      notify({ phase: 'done', chapterIndex: i + 1, totalChapters: chapters.length,
               chapterLabel, imagesDone: imgDone, imagesTotal: images.length });
      cdlLog('ok', `${chapterLabel}: done (${imgDone} images)`);
      zipPartChapters++;
      rateDelay = Math.max(MIN_DELAY, rateDelay - 100); // succès → légèrement plus rapide

    } catch (err) {
      console.warn(`[ComixDL-All] Chapitre ${chapterLabel} échoué:`, err.message);
      cdlLog('error', `${chapterLabel} failed: ${err.message}`);
      rateDelay = Math.min(MAX_DELAY, Math.round(rateDelay * 1.5)); // échec → ralentir
      notify({ phase: 'error', chapterIndex: i + 1, totalChapters: chapters.length,
               chapterLabel, imagesDone: 0, imagesTotal: 0 });
    }

    if (i < chapters.length - 1 &&
        (zipPartChapters >= ZIP_PART_MAX_CHAPTERS || zipPartBytes >= ZIP_PART_MAX_BYTES)) {
      const saved = await saveCurrentZipPart(false);
      if (!saved) return;
    }

    // Pause entre chapitres (rate limiting)
    if (i < chapters.length - 1 && !downloadAllAbortFlag) {
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
    const { url, revoke } = await _zipToDownloadUrl(zip);
    const filename = sanitizeFilename(zipName);
    await chrome.downloads.download({
      url,
      filename,
      saveAs:   false,
    });
    // Libérer le blob URL après que Chrome a eu le temps de lire le flux
    setTimeout(revoke, 60_000);
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
