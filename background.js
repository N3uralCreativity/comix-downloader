/**
 * background.js — Service Worker (Manifest V3)
 * Orchestre le téléchargement d'un chapitre :
 *   1. Ouvre un onglet invisible sur la page du chapitre
 *   2. Injecte un script d'extraction d'images (lazy-loading)
 *   3. Ferme l'onglet chapitre
 *   4. Fetch les images directement (service worker a les host_permissions)
 *   5. Crée le ZIP via JSZip (importScripts) → chrome.downloads (data URL base64)
 */

// JSZip chargé en synchrone ; expose self.JSZip dans le service worker (UMD)
importScripts('lib/jszip.min.js');

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
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'retryZip') {
    const originTabId = sender.tab?.id ?? null;
    if (_pendingZip) {
      _doZipAndSave(_pendingZip);
    } else {
      notifyTab(originTabId, { action: 'downloadAllError', error: 'Session expired — please restart Download All' });
    }
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
      world: 'MAIN',
    });

    // Fermer l'onglet dès que possible
    chrome.tabs.remove(tabId).catch(() => {});

    const images = results?.[0]?.result;
    if (!Array.isArray(images) || images.length === 0) {
      throw new Error('Aucune image trouvée dans ce chapitre');
    }

    cdlLog('info', `Extracted ${images.length} images for ${zipName}`);
    // Lancer le téléchargement + ZIP directement dans le service worker
    scheduleDownload({ images, chapterUrl, zipName, originTabId });
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
    await sleep(800);
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

async function downloadImagesAsZip({ images, chapterUrl, zipName, originTabId }) {
  const zip = new JSZip();
  const total = images.length;
  let done = 0;

  for (let i = 0; i < images.length; i += BATCH_SIZE) {
    const batch = images.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async ({ src, index }) => {
        const paddedIndex = String(index).padStart(3, '0');
        try {
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
          const arrayBuffer = await response.arrayBuffer();
          // Conserver l'extension d'origine (webp, jpg, png…)
          const ext = (src.match(/\.([a-z0-9]+)$/i) || [, 'webp'])[1];
          zip.file(`${paddedIndex}.${ext}`, arrayBuffer);
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
}──────────

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\.+$/, '')
    .substring(0, 196) + '.zip';
}

// ── Notification vers un onglet ───────────────────────────────────────────────

function notifyTab(tabId, message) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// ── Extraction Promise-based (pour download-all) ──────────────────────────────
// Ouvre un onglet, attend le chargement complet, injecte le script d'extraction,
// retourne les images ou lance une exception.
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
          world:  'MAIN',
        });
        chrome.tabs.remove(tabId).catch(() => {});
        settle(resolve, results?.[0]?.result || []);
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
  cdlLog('info', `Download All started: "${mangaName}" — ${chapters.length} chapters`);
  const zip = new JSZip();
  const notify = (extra) => notifyTab(originTabId, { action: 'downloadAllProgress', ...extra });

  // Rate limiting dynamique entre chapitres
  let rateDelay = 1500;  // ms
  const MIN_DELAY = 800, MAX_DELAY = 8000;

  for (let i = 0; i < chapters.length; i++) {
    if (downloadAllAbortFlag) { notifyTab(originTabId, { action: 'downloadAllCancelled' }); return; }

    const { chapterUrl, chapterLabel } = chapters[i];
    // Nom de dossier avec numéro paddé pour tri alphabétique correct
    const folderName = chapterLabel.replace(/^Ch([\d.]+)(.*)/i,
      (_, n, rest) => `Ch${n.padStart(4, '0')}${rest}`);

    notify({ phase: 'extracting', chapterIndex: i + 1, totalChapters: chapters.length,
             chapterLabel, imagesDone: 0, imagesTotal: 0 });

    try {
      const images = await extractFromTab(chapterUrl);
      if (!images || images.length === 0) {
        cdlLog('warn', `No images found, skipping ${chapterLabel}`);
        notify({ phase: 'skipped', chapterIndex: i + 1, totalChapters: chapters.length,
                 chapterLabel, imagesDone: 0, imagesTotal: 0 });
        continue;
      }
      cdlLog('info', `${chapterLabel}: extracted ${images.length} images`);

      const folder = zip.folder(folderName);
      let imgDone = 0;

      for (let j = 0; j < images.length; j += BATCH_SIZE) {
        if (downloadAllAbortFlag) break;
        const batch = images.slice(j, j + BATCH_SIZE);
        await Promise.allSettled(batch.map(async ({ src, index }) => {
          const paddedIndex = String(index).padStart(3, '0');
          try {
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
      rateDelay = Math.max(MIN_DELAY, rateDelay - 100); // succès → légèrement plus rapide

    } catch (err) {
      console.warn(`[ComixDL-All] Chapitre ${chapterLabel} échoué:`, err.message);
      cdlLog('error', `${chapterLabel} failed: ${err.message}`);
      rateDelay = Math.min(MAX_DELAY, Math.round(rateDelay * 1.5)); // échec → ralentir
      notify({ phase: 'error', chapterIndex: i + 1, totalChapters: chapters.length,
               chapterLabel, imagesDone: 0, imagesTotal: 0 });
    }

    // Pause entre chapitres (rate limiting)
    if (i < chapters.length - 1 && !downloadAllAbortFlag) {
      await new Promise(r => setTimeout(r, rateDelay));
    }
  }

  if (downloadAllAbortFlag) { notifyTab(originTabId, { action: 'downloadAllCancelled' }); return; }

  // Génération du ZIP final
  notify({ phase: 'zipping', chapterIndex: chapters.length, totalChapters: chapters.length,
           chapterLabel: '', imagesDone: 0, imagesTotal: 0 });
  _pendingZip = { zip, zipName, originTabId };
  await _doZipAndSave({ zip, zipName, originTabId });
}

async function _doZipAndSave({ zip, zipName, originTabId }) {
  try {
    const { url, revoke } = await _zipToDownloadUrl(zip);
    await chrome.downloads.download({
      url,
      filename: sanitizeFilename(zipName),
      saveAs:   false,
    });
    // Libérer le blob URL après que Chrome a eu le temps de lire le flux
    setTimeout(revoke, 60_000);
    _pendingZip = null;
    cdlLog('ok', `Download All complete: ${sanitizeFilename(zipName)}`);
    notifyTab(originTabId, { action: 'downloadAllDone', zipName });
  } catch (err) {
    cdlLog('error', `Download All ZIP error: ${err.message}`);
    notifyTab(originTabId, { action: 'downloadAllError', error: err.message });
  }
}
