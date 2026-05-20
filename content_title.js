/**
 * content_title.js
 * Injecte les boutons de téléchargement de chapitres sur les pages titre de comix.to.
 * Tourne uniquement sur les pages *://comix.to/title/*
 */

'use strict';

// ── Constantes ────────────────────────────────────────────────────────────────

const DOWNLOAD_BTN_CLASS  = 'cdl-btn';
const PROGRESS_SPAN_CLASS = 'cdl-progress';
const EXTENSION_ID        = chrome.runtime.id;

// Dernier lancement Download All — permet de relancer après une erreur ZIP
let _lastDlAllParams = null;

// SVG icône téléchargement (flèche vers le bas + barre)
const ICON_DOWNLOAD = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="7 10 12 15 17 10"/>
  <line x1="12" y1="15" x2="12" y2="3"/>
</svg>`;

// SVG icône succès (checkmark)
const ICON_DONE = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="20 6 9 17 4 12"/>
</svg>`;

// SVG icône erreur (×)
const ICON_ERROR = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <line x1="18" y1="6" x2="6" y2="18"/>
  <line x1="6" y1="6" x2="18" y2="18"/>
</svg>`;

// ── Styles injectés ───────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('cdl-styles')) return;
  const style = document.createElement('style');
  style.id = 'cdl-styles';
  style.textContent = `
    .${DOWNLOAD_BTN_CLASS} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      position: relative;
      background: transparent;
      border: none;
      cursor: pointer;
      padding: 4px;
      margin-left: 4px;
      border-radius: 4px;
      color: var(--muted, #888);
      transition: color 0.15s ease, background 0.15s ease;
      vertical-align: middle;
      flex-shrink: 0;
      outline: none;
    }
    .${DOWNLOAD_BTN_CLASS}:hover {
      color: var(--fg, #e0e0e0);
      background: rgba(255,255,255,0.07);
    }
    .${DOWNLOAD_BTN_CLASS}[data-state="loading"] {
      color: #60a5fa;
      pointer-events: none;
    }
    .${DOWNLOAD_BTN_CLASS}[data-state="loading"] svg {
      animation: cdl-spin 1s linear infinite;
    }
    .${DOWNLOAD_BTN_CLASS}[data-state="done"] {
      color: #4ade80;
      pointer-events: none;
    }
    .${DOWNLOAD_BTN_CLASS}[data-state="error"] {
      color: #f87171;
    }
    .${DOWNLOAD_BTN_CLASS}[data-state="error"]:hover {
      color: #fca5a5;
    }
    @keyframes cdl-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    .${PROGRESS_SPAN_CLASS} {
      position: absolute;
      bottom: -8px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 9px;
      font-weight: 600;
      color: #60a5fa;
      white-space: nowrap;
      pointer-events: none;
      letter-spacing: -0.3px;
    }
    .${DOWNLOAD_BTN_CLASS}[data-state="loading"] .${PROGRESS_SPAN_CLASS} {
      display: block;
    }
    .${DOWNLOAD_BTN_CLASS}:not([data-state="loading"]) .${PROGRESS_SPAN_CLASS} {
      display: none;
    }
    /* ── Bouton Download All ──────────────────────────────────────────────── */
    .cdl-dl-all-btn {
      display: flex !important;
      align-items: center !important;
      gap: 7px !important;
      margin-top: 8px !important;
    }
    .cdl-dl-all-btn svg { flex-shrink: 0 !important; }
    /* ── Popup progression Download All ──────────────────────────────────── */
    #cdl-all-popup {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 380px;
      background: #13151f;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.04);
      z-index: 2147483647;
      font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
      font-size: 13px;
      color: #c8cde0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .cdl-ap-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 13px 16px 11px;
      background: rgba(255,255,255,0.03);
      border-bottom: 1px solid rgba(255,255,255,0.07);
      gap: 10px;
    }
    .cdl-ap-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 14px;
      color: #e8ecf0;
    }
    .cdl-ap-close {
      background: none;
      border: none;
      cursor: pointer;
      color: #555;
      font-size: 18px;
      line-height: 1;
      padding: 2px 7px;
      border-radius: 4px;
      transition: color .15s,background .15s;
      flex-shrink: 0;
    }
    .cdl-ap-close:hover { color: #e0e0e0; background: rgba(255,255,255,0.08); }
    .cdl-ap-body {
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 9px;
    }
    .cdl-ap-manga-name {
      font-weight: 600;
      font-size: 12px;
      color: #5a6280;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cdl-ap-status-chapter {
      font-size: 13px;
      font-weight: 500;
      color: #c0c8e0;
      min-height: 18px;
    }
    .cdl-ap-status-line {
      font-size: 12px;
      color: #7a82a0;
      min-height: 16px;
    }
    .cdl-ap-bar-wrap {
      height: 6px;
      background: rgba(255,255,255,0.08);
      border-radius: 3px;
      overflow: hidden;
    }
    .cdl-ap-bar {
      height: 100%;
      background: linear-gradient(90deg,#3b82f6,#60a5fa);
      border-radius: 3px;
      transition: width .5s ease;
    }
    .cdl-ap-counter {
      font-size: 11px;
      color: #4a5270;
      text-align: right;
    }
    .cdl-ap-log {
      overflow-y: auto;
      max-height: 150px;
      min-height: 56px;
      background: rgba(0,0,0,0.25);
      border-radius: 8px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      scrollbar-width: thin;
      scrollbar-color: #2c3050 transparent;
    }
    .cdl-ap-log-item { font-size: 11px; padding: 1px 0; color: #4a5270; }
    .cdl-ap-log-item.done    { color: #4ade80; }
    .cdl-ap-log-item.active  { color: #60a5fa; }
    .cdl-ap-log-item.error   { color: #f87171; }
    .cdl-ap-log-item.skipped { color: #3a4060; }
    .cdl-ap-footer {
      padding: 10px 16px 14px;
      border-top: 1px solid rgba(255,255,255,0.07);
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .cdl-ap-cancel-btn {
      background: rgba(239,68,68,0.12);
      border: 1px solid rgba(239,68,68,0.25);
      color: #f87171;
      border-radius: 8px;
      padding: 6px 18px;
      font-size: 12px;
      cursor: pointer;
      transition: background .15s;
    }
    .cdl-ap-cancel-btn:hover:not(:disabled) { background: rgba(239,68,68,0.22); }
    .cdl-ap-cancel-btn:disabled { opacity: .4; cursor: default; }
    .cdl-ap-done-btn {
      background: rgba(74,222,128,0.12);
      border: 1px solid rgba(74,222,128,0.25);
      color: #4ade80;
      border-radius: 8px;
      padding: 6px 18px;
      font-size: 12px;
      cursor: pointer;
      transition: background .15s;
    }
    .cdl-ap-done-btn:hover { background: rgba(74,222,128,0.22); }
    .cdl-ap-retry-btn {
      background: rgba(251,191,36,0.10);
      border: 1px solid rgba(251,191,36,0.28);
      color: #fbbf24;
      border-radius: 8px;
      padding: 6px 18px;
      font-size: 12px;
      cursor: pointer;
      transition: background .15s;
    }
    .cdl-ap-retry-btn:hover { background: rgba(251,191,36,0.22); }
  `;
  document.head.appendChild(style);
}

// ── Récupération du nom du manga ──────────────────────────────────────────────

function getMangaName() {
  // Sélecteurs possibles selon le DOM du site
  const candidates = [
    'h1.series-title',
    'h1[class*="title"]',
    '.series-name h1',
    '.title-name',
    'h1',
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) return el.textContent.trim();
  }
  // Fallback : titre de la page sans " - Comix"
  return document.title.replace(/\s*[-|]\s*comix.*$/i, '').trim() || 'manga';
}

// ── Slugification pour le nom de fichier ZIP ──────────────────────────────────

function slugify(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 60);
}

// ── Extraction du numéro de chapitre depuis une URL ───────────────────────────

function extractChapterLabel(url) {
  // ex: /9517864-chapter-92  →  "Ch92"
  const m = url.match(/\/(\d+)-chapter-([0-9a-z.-]+)(?:\/|$)/i);
  if (m) return `Ch${m[2]}`;
  // fallback : dernier segment
  const parts = url.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'chapter';
}

// ── Injection du bouton sur une ligne de chapitre ─────────────────────────────

function injectButtonForRow(bookmarkBtn) {
  // Éviter les doublons
  if (bookmarkBtn.nextElementSibling?.classList?.contains(DOWNLOAD_BTN_CLASS)) return;
  if (bookmarkBtn.parentElement?.querySelector(`.${DOWNLOAD_BTN_CLASS}`)) return;

  // Chercher l'URL du chapitre dans la ligne parente
  const row = bookmarkBtn.closest('a, [class*="chapter"], [class*="mchap"], li, tr, div')
    || bookmarkBtn.parentElement;

  // Remonter jusqu'à trouver un lien de chapitre
  let chapterLink = null;
  let el = bookmarkBtn;
  while (el && !chapterLink) {
    chapterLink = el.querySelector?.('a[href*="/title/"]') || null;
    if (!chapterLink && el.tagName === 'A' && el.href?.includes('/title/')) chapterLink = el;
    el = el.parentElement;
    if (el === document.body) break;
  }
  if (!chapterLink) return;

  const chapterUrl = chapterLink.href;
  // On s'assure que l'URL est bien un chapitre (contient un ID numérique + "chapter")
  if (!/\/\d+-chapter-/i.test(chapterUrl)) return;

  const mangaName = getMangaName();
  const chapterLabel = extractChapterLabel(chapterUrl);
  const zipName = `${slugify(mangaName)}-${chapterLabel}.zip`;

  // Créer le bouton
  const btn = document.createElement('button');
  btn.className = DOWNLOAD_BTN_CLASS;
  btn.title = `Télécharger ${chapterLabel}`;
  btn.setAttribute('data-state', 'idle');
  btn.setAttribute('data-chapter-url', chapterUrl);
  btn.innerHTML = ICON_DOWNLOAD + `<span class="${PROGRESS_SPAN_CLASS}"></span>`;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.getAttribute('data-state') === 'loading') return;
    startDownload(btn, chapterUrl, zipName);
  });

  bookmarkBtn.insertAdjacentElement('afterend', btn);
}

// ── Lancement du téléchargement ───────────────────────────────────────────────

function startDownload(btn, chapterUrl, zipName) {
  // Si le contexte de l'extension a été invalidé (ex. rechargement en cours de session),
  // chrome.runtime.id est undefined et sendMessage lèverait une exception.
  if (!chrome.runtime?.id) {
    setButtonState(btn, 'error', 'Extension rechargée — actualisez la page');
    return;
  }
  setButtonState(btn, 'loading', null);
  try {
    chrome.runtime.sendMessage(
      {
        action: 'downloadChapter',
        chapterUrl,
        zipName,
        originTabId: null, // sera résolu par le background via sender.tab.id
      },
      (response) => {
        if (chrome.runtime.lastError) {
          setButtonState(btn, 'error', 'Erreur de connexion à l\'extension');
        }
      }
    );
  } catch (e) {
    setButtonState(btn, 'error', 'Extension rechargée — actualisez la page');
  }
}

// ── Mise à jour visuelle du bouton ────────────────────────────────────────────

function setButtonState(btn, state, extra) {
  btn.setAttribute('data-state', state);
  const progressSpan = btn.querySelector(`.${PROGRESS_SPAN_CLASS}`);

  if (state === 'loading') {
    btn.innerHTML = getSpinnerSVG() + `<span class="${PROGRESS_SPAN_CLASS}">${extra || ''}</span>`;
  } else if (state === 'done') {
    btn.innerHTML = ICON_DONE;
    btn.title = 'Téléchargé !';
    // Revenir à l'icône download après 2.5s
    setTimeout(() => {
      if (btn.getAttribute('data-state') === 'done') {
        btn.innerHTML = ICON_DOWNLOAD + `<span class="${PROGRESS_SPAN_CLASS}"></span>`;
        btn.setAttribute('data-state', 'idle');
        btn.title = `Télécharger`;
        btn.style.pointerEvents = '';
      }
    }, 2500);
  } else if (state === 'error') {
    btn.innerHTML = ICON_ERROR;
    btn.title = extra || 'Erreur lors du téléchargement';
    btn.style.pointerEvents = '';
  } else {
    // idle
    btn.innerHTML = ICON_DOWNLOAD + `<span class="${PROGRESS_SPAN_CLASS}"></span>`;
  }
}

function getSpinnerSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
  </svg>`;
}

// ── Réception des messages du background (progression, fin, erreur) ───────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'downloadProgress') {
    const btn = findButtonByChapterUrl(message.chapterUrl);
    if (btn && btn.getAttribute('data-state') === 'loading') {
      const progressSpan = btn.querySelector(`.${PROGRESS_SPAN_CLASS}`);
      if (progressSpan) {
        progressSpan.textContent = `${message.current}/${message.total}`;
      }
    }
  } else if (message.action === 'downloadDone') {
    const btn = findButtonByChapterUrl(message.chapterUrl);
    if (btn) setButtonState(btn, 'done', null);
  } else if (message.action === 'downloadError') {
    const btn = findButtonByChapterUrl(message.chapterUrl);
    if (btn) setButtonState(btn, 'error', message.error || 'Erreur inconnue');

  // ── Download All ──────────────────────────────────────────────────────────
  } else if (message.action === 'downloadAllProgress') {
    updateDownloadAllPopup(message);

  } else if (message.action === 'downloadAllDone') {
    const popup = document.getElementById('cdl-all-popup');
    if (popup) {
      const bar = document.getElementById('cdl-ap-bar');
      if (bar) bar.style.width = '100%';
      const s = document.getElementById('cdl-ap-chapter-status');
      if (s) s.textContent = '✓ Download complete!';
      const i = document.getElementById('cdl-ap-img-status');
      if (i) i.textContent = `Saved as: ${message.zipName || 'manga.zip'}`;
      _dlAllSetFooterClose(popup);
    }

  } else if (message.action === 'downloadAllError') {
    updateDownloadAllPopupError(message.error || 'Unknown error');

  } else if (message.action === 'downloadAllCancelled') {
    const popup = document.getElementById('cdl-all-popup');
    if (popup) {
      const s = document.getElementById('cdl-ap-chapter-status');
      if (s) s.textContent = 'Download cancelled.';
      _dlAllSetFooterClose(popup);
    }
  }
});

function findButtonByChapterUrl(url) {
  // Comparaison directe sur l'attribut (plus fiable que l'escape CSS)
  return (
    [...document.querySelectorAll(`.${DOWNLOAD_BTN_CLASS}`)].find(
      (btn) => btn.getAttribute('data-chapter-url') === url
    ) || null
  );
}

// ── Download All ──────────────────────────────────────────────────────────────

/** Échappe les caractères HTML dangereux pour l'insertion dans innerHTML. */
function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/**
 * Collecte TOUTES les URLs de chapitres :
 *  1. Extraction regex depuis __NEXT_DATA__ (page courante)
 *  2. Si un total > URLs trouvées, récupère les pages suivantes via l'API Next.js
 *  3. Fallback DOM
 *  4. Déduplication par numéro de chapitre (une seule source par chapitre)
 *  5. Tri ascendant
 */
async function getAllChapters() {
  const slug    = window.location.pathname.match(/\/title\/([^/]+)/)?.[1];
  let allUrls   = [];

  const scriptEl = document.getElementById('__NEXT_DATA__');
  if (scriptEl) {
    const jsonStr = scriptEl.textContent;

    // ─ Extraction initiale depuis le JSON brut ─────────────────────────────
    const rawPaths = jsonStr.match(/\/title\/[a-z0-9-]+\/\d+-chapter-[\w.]+/g) || [];
    allUrls = rawPaths.map(p => `https://comix.to${p}`);

    // ─ Chercher le total de chapitres et le buildId pour les pages suivantes ───
    let nextData = null;
    try { nextData = JSON.parse(jsonStr); } catch (_) {}
    const buildId = nextData?.buildId;

    // Tenter plusieurs clés candidates pour le total
    const totalMatch = jsonStr.match(
      /"chapter_count"\s*:\s*(\d+)|"total_chapters"\s*:\s*(\d+)|"total"\s*:\s*(\d+)/
    );
    const total = totalMatch
      ? parseInt(totalMatch[1] || totalMatch[2] || totalMatch[3])
      : 0;

    if (buildId && slug && total > allUrls.length) {
      const perPage   = 20;
      const maxPages  = Math.min(Math.ceil(total / perPage), 100); // plafond sécurité
      const pageNums  = [];
      for (let p = 2; p <= maxPages; p++) pageNums.push(p);

      const results = await Promise.all(
        pageNums.map(p =>
          fetch(`/_next/data/${buildId}/title/${slug}.json?page=${p}`, {
            headers: { 'Accept': 'application/json' }
          })
          .then(r => r.ok ? r.text() : '')
          .catch(() => '')
        )
      );

      for (const text of results) {
        if (!text) continue;
        const paths = text.match(/\/title\/[a-z0-9-]+\/\d+-chapter-[\w.]+/g) || [];
        allUrls.push(...paths.map(p => `https://comix.to${p}`));
      }
    }
  }

  // ─ Fallback DOM ─────────────────────────────────────────────────────
  if (allUrls.length === 0) {
    allUrls = [...document.querySelectorAll('a[href*="/title/"]')]
      .map(a => a.href)
      .filter(u => /\/\d+-chapter-/i.test(u));
  }

  // ─ Déduplication par numéro de chapitre (une seule source par numéro) ──────
  // Deux entrées ont le même extractChapterLabel ⇒ même chapitre, sources différentes.
  // On garde la première occurrence trouvée.
  const byLabel = new Map();
  for (const url of allUrls) {
    const label = extractChapterLabel(url);
    if (!byLabel.has(label)) byLabel.set(label, { chapterUrl: url, chapterLabel: label });
  }

  return [...byLabel.values()].sort(
    (a, b) => parseFloat(a.chapterLabel.replace(/[^0-9.]/g, ''))
            - parseFloat(b.chapterLabel.replace(/[^0-9.]/g, ''))
  );
}

/** Lance (ou relance) la session Download All avec les params en cache. */
function _launchDownloadAll() {
  if (!_lastDlAllParams) return;
  const { chapters, mangaName, zipName } = _lastDlAllParams;
  try {
    chrome.runtime.sendMessage(
      { action: 'downloadAllChapters', chapters, mangaName, zipName },
      (res) => { if (chrome.runtime.lastError) updateDownloadAllPopupError('Erreur de connexion \u00e0 l\'extension'); }
    );
  } catch (_) {
    updateDownloadAllPopupError('Extension recharg\u00e9e \u2014 actualisez la page');
  }
}

/** Injecte le bouton "Download All" sous le bouton Follow/Start-reading. */
function injectDownloadAllButton() {
  if (document.querySelector('.cdl-dl-all-btn')) return;
  const followBtn = document.querySelector('.mpage__follow-btn');
  if (!followBtn) return;

  const btn = document.createElement('button');
  btn.className = 'btn btn--soft mpage__follow-btn cdl-dl-all-btn';
  btn.type = 'button';
  btn.title = 'Télécharger tous les chapitres en un ZIP';
  btn.innerHTML = `${ICON_DOWNLOAD} Download All`;

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!chrome?.runtime?.id) { alert('Extension rechargée — actualisez la page.'); return; }
    if (document.getElementById('cdl-all-popup')) return; // déjà en cours

    // Indicateur de chargement pendant la collecte des chapitres
    btn.disabled = true;
    btn.innerHTML = `${ICON_DOWNLOAD} Loading chapters…`;

    let chapters;
    try {
      chapters = await getAllChapters();
    } catch (_) {
      chapters = [];
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${ICON_DOWNLOAD} Download All`;
    }

    if (chapters.length === 0) { alert('Aucun chapitre trouvé sur cette page.'); return; }

    const mangaName = getMangaName();
    const zipName   = `${slugify(mangaName)}.zip`;
    _lastDlAllParams = { chapters, mangaName, zipName };
    showDownloadAllPopup(mangaName, chapters.length);
    _launchDownloadAll();
  });

  followBtn.insertAdjacentElement('afterend', btn);
}

// ── Popup Download All ────────────────────────────────────────────────────────

function showDownloadAllPopup(mangaName, totalChapters) {
  document.getElementById('cdl-all-popup')?.remove();

  const popup = document.createElement('div');
  popup.id = 'cdl-all-popup';
  popup.innerHTML = `
    <div class="cdl-ap-header">
      <div class="cdl-ap-title">${ICON_DOWNLOAD}&nbsp;Downloading All Chapters</div>
      <button class="cdl-ap-close" title="Réduire">−</button>
    </div>
    <div class="cdl-ap-body">
      <div class="cdl-ap-manga-name">${escapeHtml(mangaName)}</div>
      <div class="cdl-ap-status-chapter" id="cdl-ap-chapter-status">Preparing…</div>
      <div class="cdl-ap-status-line"    id="cdl-ap-img-status">Starting…</div>
      <div class="cdl-ap-bar-wrap"><div class="cdl-ap-bar" id="cdl-ap-bar" style="width:0%"></div></div>
      <div class="cdl-ap-counter" id="cdl-ap-counter">0 / ${totalChapters} chapters</div>
      <div class="cdl-ap-log" id="cdl-ap-log"></div>
    </div>
    <div class="cdl-ap-footer">
      <button class="cdl-ap-cancel-btn" id="cdl-ap-cancel-btn">Cancel</button>
    </div>`;
  document.body.appendChild(popup);

  // Bouton −  : réduire/agrandir le corps du popup
  popup.querySelector('.cdl-ap-close').addEventListener('click', () => {
    const body = popup.querySelector('.cdl-ap-body');
    body.style.display = body.style.display === 'none' ? '' : 'none';
  });

  document.getElementById('cdl-ap-cancel-btn').addEventListener('click', () => {
    if (!chrome?.runtime?.id) return;
    try {
      chrome.runtime.sendMessage({ action: 'cancelDownloadAll' });
      const s = document.getElementById('cdl-ap-chapter-status');
      if (s) s.textContent = 'Cancelling…';
      document.getElementById('cdl-ap-cancel-btn').disabled = true;
    } catch (_) {}
  });
  // Apr\u00e8s 20s : ajouter un bouton Retry dans le footer m\u00eame sans erreur
  popup._cdlRetryTimer = setTimeout(() => {
    const footer = popup.querySelector('.cdl-ap-footer');
    if (!footer || footer.querySelector('.cdl-ap-retry-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'cdl-ap-retry-btn';
    btn.textContent = '\u21ba Retry';
    btn.addEventListener('click', () => {
      clearTimeout(popup._cdlRetryTimer);
      popup.remove();
      const { mangaName, chapters } = _lastDlAllParams;
      showDownloadAllPopup(mangaName, chapters.length);
      _launchDownloadAll();
    });
    footer.insertBefore(btn, footer.firstChild);
  }, 20000);}

function _dlAllSetFooterClose(popup) {
  clearTimeout(popup._cdlRetryTimer);
  const footer = popup.querySelector('.cdl-ap-footer');
  if (!footer) return;
  footer.innerHTML = '<button class="cdl-ap-done-btn" id="cdl-ap-close-btn">Close</button>';
  document.getElementById('cdl-ap-close-btn')?.addEventListener('click', () => popup.remove());
}

function updateDownloadAllPopup(msg) {
  const popup = document.getElementById('cdl-all-popup');
  if (!popup) return;
  const { phase, chapterIndex, totalChapters, chapterLabel, imagesDone, imagesTotal } = msg;

  const el = (id) => document.getElementById(id);
  const pctDone    = totalChapters > 0 ? Math.round((chapterIndex - 1) / totalChapters * 100) : 0;
  const pctCurrent = totalChapters > 0 ? Math.round(chapterIndex / totalChapters * 100) : 0;

  if (phase === 'extracting') {
    el('cdl-ap-chapter-status').textContent = `Chapter ${chapterIndex} / ${totalChapters} — ${chapterLabel}`;
    el('cdl-ap-img-status').textContent     = 'Opening chapter…';
    el('cdl-ap-bar').style.width            = `${pctDone}%`;
    el('cdl-ap-counter').textContent        = `${chapterIndex - 1} / ${totalChapters} chapters`;
    _dlAllAddLog(chapterLabel, 'active', `⟳ ${chapterLabel} — opening…`);

  } else if (phase === 'downloading') {
    el('cdl-ap-chapter-status').textContent = `Chapter ${chapterIndex} / ${totalChapters} — ${chapterLabel}`;
    el('cdl-ap-img-status').textContent     = `Images : ${imagesDone} / ${imagesTotal}`;
    _dlAllUpdateLastLog(`⟳ ${chapterLabel} — ${imagesDone}/${imagesTotal} images`);

  } else if (phase === 'done') {
    el('cdl-ap-bar').style.width     = `${pctCurrent}%`;
    el('cdl-ap-counter').textContent = `${chapterIndex} / ${totalChapters} chapters`;
    _dlAllUpdateLastLog(`✓ ${chapterLabel} (${imagesDone} images)`, 'done');

  } else if (phase === 'error') {
    _dlAllUpdateLastLog(`✗ ${chapterLabel} — failed`, 'error');

  } else if (phase === 'skipped') {
    _dlAllUpdateLastLog(`— ${chapterLabel} — skipped`, 'skipped');

  } else if (phase === 'zipping') {
    el('cdl-ap-chapter-status').textContent = 'Building ZIP file…';
    el('cdl-ap-img-status').textContent     = 'Please wait — this may take a moment…';
    el('cdl-ap-bar').style.width            = '99%';
    // Afficher immédiatement le bouton Retry dans le footer dès la phase ZIP
    clearTimeout(popup._cdlRetryTimer);
    const footer = popup.querySelector('.cdl-ap-footer');
    if (footer && !footer.querySelector('.cdl-ap-retry-btn')) {
      const retryBtn = document.createElement('button');
      retryBtn.className   = 'cdl-ap-retry-btn';
      retryBtn.textContent = '↺ Retry';
      retryBtn.addEventListener('click', () => {
        // Relance uniquement le ZIP — ne touche pas au popup ni aux chapitres
        retryBtn.disabled    = true;
        retryBtn.textContent = '↺ Retrying…';
        el('cdl-ap-chapter-status').textContent = 'Building ZIP file…';
        el('cdl-ap-img-status').textContent     = 'Please wait — this may take a moment…';
        el('cdl-ap-bar').style.width            = '99%';
        try {
          chrome.runtime.sendMessage({ action: 'retryZip' }, (res) => {
            if (chrome.runtime.lastError) updateDownloadAllPopupError('Erreur de connexion à l\'extension');
            else { retryBtn.disabled = false; retryBtn.textContent = '↺ Retry'; }
          });
        } catch (_) { updateDownloadAllPopupError('Extension rechargée — actualisez la page'); }
      });
      footer.insertBefore(retryBtn, footer.firstChild);
    }
  }
}

function _dlAllAddLog(id, cls, text) {
  const log = document.getElementById('cdl-ap-log');
  if (!log) return;
  // Réutiliser l'entrée existante si même chapitre
  const existing = [...log.querySelectorAll('.cdl-ap-log-item')].find(el => el.dataset.chid === id);
  if (existing) { existing.textContent = text; existing.className = `cdl-ap-log-item ${cls}`; return; }
  const item = document.createElement('div');
  item.className     = `cdl-ap-log-item ${cls}`;
  item.dataset.chid  = id;
  item.textContent   = text;
  log.appendChild(item);
  log.scrollTop = log.scrollHeight;
}

function _dlAllUpdateLastLog(text, newCls) {
  const log = document.getElementById('cdl-ap-log');
  if (!log) return;
  const items = log.querySelectorAll('.cdl-ap-log-item');
  const last  = items[items.length - 1];
  if (!last) return;
  last.textContent = text;
  if (newCls) last.className = `cdl-ap-log-item ${newCls}`;
}

function updateDownloadAllPopupError(errMsg) {
  const popup = document.getElementById('cdl-all-popup');
  if (!popup) return;
  clearTimeout(popup._cdlRetryTimer);
  const s = document.getElementById('cdl-ap-chapter-status');
  if (s) { s.textContent = `Error: ${errMsg}`; s.style.color = '#f87171'; }

  const footer = popup.querySelector('.cdl-ap-footer');
  if (!footer) return;
  footer.innerHTML = '';

  if (_lastDlAllParams) {
    const retryBtn = document.createElement('button');
    retryBtn.className = 'cdl-ap-retry-btn';
    retryBtn.textContent = '↺ Retry';
    retryBtn.addEventListener('click', () => {
      popup.remove();
      const { mangaName, chapters } = _lastDlAllParams;
      showDownloadAllPopup(mangaName, chapters.length);
      _launchDownloadAll();
    });
    footer.appendChild(retryBtn);
  }

  const closeBtn = document.createElement('button');
  closeBtn.className = 'cdl-ap-done-btn';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => popup.remove());
  footer.appendChild(closeBtn);
}

// ── Scan initial et MutationObserver ─────────────────────────────────────────

function scanAndInject() {
  // Chercher tous les boutons bookmark existants
  const bookmarkBtns = document.querySelectorAll('.mchap-bookmark, [class*="mchap-bookmark"]');
  bookmarkBtns.forEach(injectButtonForRow);
  injectDownloadAllButton();
}

function observeDOM() {
  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Vérifier si un nouveau bookmark a été ajouté
          if (
            node.classList?.contains('mchap-bookmark') ||
            node.querySelector?.('.mchap-bookmark, [class*="mchap-bookmark"]')
          ) {
            shouldScan = true;
            break;
          }
        }
      }
      if (shouldScan) break;
    }
    if (shouldScan) scanAndInject();
    // Aussi surveiller l'apparition du bouton Follow (rendu React tardif)
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE &&
            (node.classList?.contains('mpage__follow-btn') ||
             node.querySelector?.('.mpage__follow-btn'))) {
          injectDownloadAllButton();
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ── Point d'entrée ────────────────────────────────────────────────────────────

(function init() {
  // Ne pas s'exécuter sur les pages de lecture de chapitre
  // URL format de chapitre : /title/{slug}/{chapterId}
  const pathParts = location.pathname.split('/').filter(Boolean);
  // pathParts[0] === 'title', pathParts[1] === slug, pathParts[2] === chapterId (si présent)
  if (pathParts.length >= 3 && /^\d+/.test(pathParts[2])) {
    // Nous sommes sur une page de lecture de chapitre, ne rien faire
    return;
  }

  injectStyles();
  scanAndInject();
  observeDOM();
})();
