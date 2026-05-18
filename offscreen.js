/**
 * offscreen.js
 * Tourne dans un document offscreen Chrome MV3.
 * Reçoit la liste d'URLs d'images d'un chapitre, les fetch,
 * crée un ZIP via JSZip, déclenche le téléchargement et notifie la progression.
 */

'use strict';

const BATCH_SIZE = 3; // Nombre de fetch simultanés

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startZip') {
    handleStartZip(message).catch((err) => {
      chrome.runtime.sendMessage({
        action: 'offscreenError',
        chapterUrl: message.chapterUrl,
        originTabId: message.originTabId,
        error: err.message || 'Erreur lors de la création du ZIP',
      }).catch(() => {});
    });
  }
});

/**
 * Télécharge toutes les images en batches, crée un ZIP et déclenche le download.
 */
async function handleStartZip({ images, chapterUrl, zipName, originTabId }) {
  const zip = new JSZip();
  const total = images.length;
  let done = 0;

  // Téléchargement par batch pour ne pas saturer le réseau
  for (let i = 0; i < images.length; i += BATCH_SIZE) {
    const batch = images.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async ({ src, index }) => {
        const paddedIndex = String(index).padStart(3, '0');
        const filename = `${paddedIndex}.webp`;

        try {
          const arrayBuffer = await fetchImageAsArrayBuffer(src);
          zip.file(filename, arrayBuffer);
        } catch (err) {
          // Image manquante : noter l'erreur dans le ZIP sans bloquer
          zip.file(`${paddedIndex}_error.txt`, `Erreur pour ${src}: ${err.message}`);
          console.warn(`[ComixDL Offscreen] Impossible de télécharger ${src}:`, err);
        }

        done++;
        chrome.runtime.sendMessage({
          action: 'offscreenProgress',
          chapterUrl,
          originTabId,
          current: done,
          total,
        }).catch(() => {});
      })
    );
  }

  // Génération du ZIP
  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'STORE' },
    (meta) => {
      // Progression JSZip (optionnel, pas relayée ici)
    }
  );

  // Créer une URL objet et déclencher le téléchargement
  const blobUrl = URL.createObjectURL(blob);

  await chrome.downloads.download({
    url: blobUrl,
    filename: sanitizeFilename(zipName),
    saveAs: false,
  });

  // Libérer l'URL objet après un court délai (laisser Chrome démarrer le DL)
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);

  chrome.runtime.sendMessage({
    action: 'offscreenDone',
    chapterUrl,
    originTabId,
  }).catch(() => {});
}

/**
 * Fetch une image et retourne son ArrayBuffer.
 * Timeout de 30 secondes pour les connexions lentes.
 */
async function fetchImageAsArrayBuffer(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Simuler un vrai navigateur pour éviter les blocages CDN
        'Accept': 'image/webp,image/avif,image/*,*/*;q=0.8',
        'Referer': 'https://comix.to/',
        'Origin': 'https://comix.to',
      },
      mode: 'cors',
      credentials: 'omit',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.arrayBuffer();
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Sanitize le nom de fichier pour éviter les caractères interdits sur Windows/Mac/Linux.
 */
function sanitizeFilename(name) {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\.+$/, '');
  // Réserver 4 chars pour l'extension '.zip'
  const base = cleaned.substring(0, 196);
  return base + (name.toLowerCase().endsWith('.zip') ? '.zip' : '.zip');
}
