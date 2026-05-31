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

// Retry timer for Download All button injection (React renders Follow btn late on mobile)
let _dlAllInjRetryTimer = null;

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

// ── User settings (loaded async; v1.1.2 defaults until then) ────────────────────
let CFG = (typeof CDLSettings !== 'undefined') ? Object.assign({}, CDLSettings.DEFAULTS) : {};

function getAccent() {
  const c = CFG['appearance.accentColor'];
  return (CFG['appearance.accentMode'] === 'custom' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c || '')) ? c : '#60a5fa';
}
function _clampScale(v) { v = parseFloat(v); return isFinite(v) ? Math.min(1.5, Math.max(0.8, v)) : 1; }
function _clampInt(v, min, max, d) { v = parseInt(v, 10); return isFinite(v) ? Math.min(max, Math.max(min, v)) : d; }
function getAllLabel() { const l = CFG['appearance.allLabel']; return (l && String(l).trim()) ? String(l).trim() : 'Download All'; }
function isIconText() { return CFG['appearance.btnStyle'] === 'icon+text'; }
function getIdleContent() {
  return ICON_DOWNLOAD + (isIconText() ? '<span class="cdl-btn-text">Download</span>' : '') + `<span class="${PROGRESS_SPAN_CLASS}"></span>`;
}
function applyBtnTextClass(btn) { btn.classList.toggle('cdl-has-text', isIconText()); }
function buildSingleZipName(mangaName, chapterLabel) {
  const num = String(chapterLabel || '').replace(/^ch/i, '');
  if (typeof CDLSettings !== 'undefined') {
    const slug = slugify(mangaName);
    const base = CDLSettings.renderName(CFG['naming.singleZipTpl'] || '{manga}-Ch{chapter}', { manga: slug, chapter: num, num: num }, 196);
    return (base || slug || 'comix') + '.zip';
  }
  return `${slugify(mangaName)}-${chapterLabel}.zip`;
}
function buildAllZipName(mangaName) {
  if (typeof CDLSettings !== 'undefined') {
    const slug = slugify(mangaName);
    const base = CDLSettings.renderName(CFG['naming.allZipTpl'] || '{manga}', { manga: slug }, 196);
    return (base || slug || 'comix') + '.zip';
  }
  return `${slugify(mangaName)}.zip`;
}

// Dynamic, settings-driven CSS layered on top of the static styles. Re-injected
// whenever settings change so accent color, button scale, the progress-frame
// position/width and animation toggles update live.
function applyDynamicStyles() {
  const prev = document.getElementById('cdl-dyn-styles');
  if (prev) prev.remove();
  const accent = getAccent();
  const scale = _clampScale(CFG['appearance.btnScale']);
  const noAnim = !!CFG['appearance.disableAnim'];
  const W = _clampInt(CFG['frame.width'], 300, 560, 380);
  const pos = CFG['frame.position'] || 'bottom-right';
  const vy = pos.indexOf('top') === 0 ? 'top:24px;bottom:auto;' : 'bottom:24px;top:auto;';
  const vx = /left$/.test(pos) ? 'left:24px;right:auto;' : 'right:24px;left:auto;';
  const btnW = Math.round(36 * scale), svgS = Math.round(16 * scale), loadW = Math.round(68 * scale);
  const fontS = Math.max(10, Math.round(12 * scale));
  const style = document.createElement('style');
  style.id = 'cdl-dyn-styles';
  style.textContent = `
    .${DOWNLOAD_BTN_CLASS} { width:${btnW}px; min-width:${btnW}px; }
    .${DOWNLOAD_BTN_CLASS} svg { width:${svgS}px; height:${svgS}px; }
    .${DOWNLOAD_BTN_CLASS}[data-state="loading"] { width:${loadW}px; min-width:${loadW}px; color:${accent}; }
    .${PROGRESS_SPAN_CLASS} { color:${accent}; }
    #cdl-all-popup { --cdl-accent:${accent}; }
    .${DOWNLOAD_BTN_CLASS}.cdl-has-text { width:auto; min-width:0; gap:6px; padding:0 9px; }
    .${DOWNLOAD_BTN_CLASS}.cdl-has-text[data-state="loading"] { width:auto; min-width:0; }
    .cdl-btn-text { font-size:${fontS}px; font-weight:600; }
    #cdl-all-popup { width:${W}px; ${vy} ${vx} }
    ${noAnim ? `.${DOWNLOAD_BTN_CLASS}[data-state="loading"] svg{animation:none!important;} #cdl-all-popup{animation:none!important;} .${DOWNLOAD_BTN_CLASS},.cdl-ap-bar,.cdl-ap-close{transition:none!important;}` : ''}
  `;
  document.head.appendChild(style);
}

// Re-apply everything that depends on settings (called on storage change).
function onSettingsChanged() {
  applyDynamicStyles();
  const all = document.querySelector('.cdl-dl-all-btn');
  if (all && !all.disabled) all.innerHTML = `${ICON_DOWNLOAD} ${escapeHtml(getAllLabel())}`;
  document.querySelectorAll(`.${DOWNLOAD_BTN_CLASS}`).forEach((b) => {
    const st = b.getAttribute('data-state');
    if (!st || st === 'idle') { b.innerHTML = getIdleContent(); applyBtnTextClass(b); }
  });
}

// Auto-hide the progress frame N seconds after it reaches a terminal state.
function maybeAutoHideFrame(popup) {
  const sec = _clampInt(CFG['frame.autoHideSec'], 0, 60, 0);
  if (sec > 0) setTimeout(() => { dismissDownloadAllSession(); popup.remove(); }, sec * 1000);
}

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
      padding: 0;
      margin-left: 0;
      border-radius: 4px;
      color: var(--muted, #888);
      transition: color 0.15s ease, background 0.15s ease;
      vertical-align: middle;
      flex-shrink: 0;
      outline: none;
      align-self: stretch;
      width: 36px;
      min-width: 36px;
      height: auto;
      overflow: hidden;
    }
    .${DOWNLOAD_BTN_CLASS}:hover {
      color: var(--fg, #e0e0e0);
      background: rgba(255,255,255,0.07);
    }
    .${DOWNLOAD_BTN_CLASS}[data-state="loading"] {
      color: #60a5fa;
      pointer-events: none;
      gap: 3px;
      width: 68px;
      min-width: 68px;
      justify-content: center;
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
      position: static;
      transform: none;
      font-size: 10px;
      line-height: 1;
      font-weight: 600;
      color: #60a5fa;
      white-space: nowrap;
      pointer-events: none;
      letter-spacing: 0;
    }
    .${DOWNLOAD_BTN_CLASS}[data-state="loading"] .${PROGRESS_SPAN_CLASS} { display: inline; }
    .${DOWNLOAD_BTN_CLASS}:not([data-state="loading"]) .${PROGRESS_SPAN_CLASS} { display: none; }
    /* ── Bouton Download All ──────────────────────────────────────────────── */
    .cdl-dl-all-btn {
      display: flex !important;
      align-items: center !important;
      gap: 7px !important;
      margin-top: 8px !important;
    }
    /* ── Bouton Download All (floating mobile fallback) ────────────────────── */
    .cdl-dl-all-btn.cdl-floating {
      position: fixed !important;
      bottom: 72px !important;
      right: 16px !important;
      z-index: 2147483646 !important;
      border-radius: 50px !important;
      padding: 10px 18px !important;
      background: rgba(19,21,31,0.97) !important;
      border: 1px solid rgba(255,255,255,0.18) !important;
      box-shadow: 0 4px 24px rgba(0,0,0,0.55) !important;
      margin-top: 0 !important;
    }
    /* ── Popup progression Download All ──────────────────────────────────── */
    #cdl-all-popup {
      /* Palette flips with the host site via [data-cdl-theme]; dark is default. */
      --cdl-bg: #13151f;
      --cdl-header-bg: rgba(255,255,255,0.025);
      --cdl-text: #d6dae8;
      --cdl-text-strong: #eef1f8;
      --cdl-muted: #8088a4;
      --cdl-faint: #5a6280;
      --cdl-border: rgba(255,255,255,0.10);
      --cdl-border-soft: rgba(255,255,255,0.06);
      --cdl-track: rgba(255,255,255,0.09);
      --cdl-log-bg: rgba(255,255,255,0.03);
      --cdl-hover: rgba(255,255,255,0.08);
      --cdl-shadow: 0 12px 34px rgba(0,0,0,0.42), 0 2px 8px rgba(0,0,0,0.30);
      --cdl-accent: #60a5fa;
      --cdl-ok: #4ade80;   --cdl-ok-bg: rgba(74,222,128,0.12);  --cdl-ok-bgh: rgba(74,222,128,0.20);  --cdl-ok-border: rgba(74,222,128,0.28);
      --cdl-warn: #fbbf24; --cdl-warn-bg: rgba(251,191,36,0.12); --cdl-warn-bgh: rgba(251,191,36,0.20); --cdl-warn-border: rgba(251,191,36,0.30);
      --cdl-err: #f87171;  --cdl-err-bg: rgba(239,68,68,0.12);   --cdl-err-bgh: rgba(239,68,68,0.20);   --cdl-err-border: rgba(239,68,68,0.28);
      --cdl-skip: #5a6280;

      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 380px;
      background: var(--cdl-bg);
      border: 1px solid var(--cdl-border);
      border-radius: 14px;
      box-shadow: var(--cdl-shadow);
      z-index: 2147483647;
      font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
      font-size: 13px;
      color: var(--cdl-text);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      animation: cdl-ap-in .22s cubic-bezier(.16,.84,.44,1) both;
    }
    #cdl-all-popup[data-cdl-theme="light"] {
      --cdl-bg: #ffffff;
      --cdl-header-bg: #f7f8fb;
      --cdl-text: #2b3146;
      --cdl-text-strong: #14171f;
      --cdl-muted: #6b7180;
      --cdl-faint: #98a0b2;
      --cdl-border: rgba(17,20,32,0.12);
      --cdl-border-soft: rgba(17,20,32,0.08);
      --cdl-track: rgba(17,20,32,0.09);
      --cdl-log-bg: #f5f6f9;
      --cdl-hover: rgba(17,20,32,0.05);
      --cdl-shadow: 0 14px 36px rgba(24,28,45,0.16), 0 2px 8px rgba(24,28,45,0.08);
      --cdl-ok: #16a34a;   --cdl-ok-bg: rgba(22,163,74,0.09);  --cdl-ok-bgh: rgba(22,163,74,0.16);  --cdl-ok-border: rgba(22,163,74,0.24);
      --cdl-warn: #b45309; --cdl-warn-bg: rgba(180,83,9,0.09); --cdl-warn-bgh: rgba(180,83,9,0.16); --cdl-warn-border: rgba(180,83,9,0.24);
      --cdl-err: #dc2626;  --cdl-err-bg: rgba(220,38,38,0.08); --cdl-err-bgh: rgba(220,38,38,0.15); --cdl-err-border: rgba(220,38,38,0.22);
      --cdl-skip: #98a0b2;
    }
    @keyframes cdl-ap-in {
      from { opacity: 0; transform: translateY(10px) scale(.98); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .cdl-ap-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 15px;
      background: var(--cdl-header-bg);
      border-bottom: 1px solid var(--cdl-border-soft);
      gap: 10px;
    }
    .cdl-ap-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 13.5px;
      color: var(--cdl-text-strong);
    }
    .cdl-ap-title svg { width: 16px; height: 16px; color: var(--cdl-accent); }
    .cdl-ap-close {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--cdl-faint);
      font-size: 18px;
      line-height: 1;
      padding: 2px 8px;
      border-radius: 6px;
      transition: color .15s,background .15s;
      flex-shrink: 0;
    }
    .cdl-ap-close:hover { color: var(--cdl-text-strong); background: var(--cdl-hover); }
    .cdl-ap-body {
      padding: 14px 15px;
      display: flex;
      flex-direction: column;
      gap: 9px;
    }
    .cdl-ap-manga-name {
      font-weight: 600;
      font-size: 12px;
      color: var(--cdl-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cdl-ap-status-chapter {
      font-size: 13px;
      font-weight: 500;
      color: var(--cdl-text);
      min-height: 18px;
    }
    .cdl-ap-status-chapter.error { color: var(--cdl-err); }
    .cdl-ap-status-line {
      font-size: 12px;
      color: var(--cdl-muted);
      min-height: 16px;
    }
    .cdl-ap-bar-wrap {
      height: 6px;
      background: var(--cdl-track);
      border-radius: 4px;
      overflow: hidden;
    }
    .cdl-ap-bar {
      height: 100%;
      width: 0;
      background: var(--cdl-accent);
      border-radius: 4px;
      transition: width .5s ease;
    }
    .cdl-ap-counter {
      font-size: 11px;
      color: var(--cdl-faint);
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .cdl-ap-log {
      overflow-y: auto;
      max-height: 150px;
      min-height: 56px;
      background: var(--cdl-log-bg);
      border: 1px solid var(--cdl-border-soft);
      border-radius: 9px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      scrollbar-width: thin;
      scrollbar-color: var(--cdl-faint) transparent;
    }
    .cdl-ap-log-item { font-size: 11px; padding: 1px 0; color: var(--cdl-muted); font-variant-numeric: tabular-nums; }
    .cdl-ap-log-item.done    { color: var(--cdl-ok); }
    .cdl-ap-log-item.active  { color: var(--cdl-accent); }
    .cdl-ap-log-item.error   { color: var(--cdl-err); }
    .cdl-ap-log-item.skipped { color: var(--cdl-skip); }
    .cdl-ap-footer {
      padding: 11px 15px 13px;
      border-top: 1px solid var(--cdl-border-soft);
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .cdl-ap-cancel-btn, .cdl-ap-done-btn, .cdl-ap-retry-btn {
      border-radius: 8px;
      padding: 6px 18px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background .15s, border-color .15s;
    }
    .cdl-ap-cancel-btn {
      background: var(--cdl-err-bg);
      border: 1px solid var(--cdl-err-border);
      color: var(--cdl-err);
    }
    .cdl-ap-cancel-btn:hover:not(:disabled) { background: var(--cdl-err-bgh); border-color: var(--cdl-err); }
    .cdl-ap-cancel-btn:disabled { opacity: .4; cursor: default; }
    .cdl-ap-done-btn {
      background: var(--cdl-ok-bg);
      border: 1px solid var(--cdl-ok-border);
      color: var(--cdl-ok);
    }
    .cdl-ap-done-btn:hover { background: var(--cdl-ok-bgh); border-color: var(--cdl-ok); }
    .cdl-ap-retry-btn {
      background: var(--cdl-warn-bg);
      border: 1px solid var(--cdl-warn-border);
      color: var(--cdl-warn);
    }
    .cdl-ap-retry-btn:hover { background: var(--cdl-warn-bgh); border-color: var(--cdl-warn); }
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

function slugify(str, maxLen) {
  const cap = maxLen || (CFG && CFG['naming.slugMaxLen']) || 60;
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, cap);
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

  const chapterLabel = extractChapterLabel(chapterUrl);

  // Créer le bouton
  const btn = document.createElement('button');
  btn.className = DOWNLOAD_BTN_CLASS;
  btn.title = `Download ${chapterLabel}`;
  btn.setAttribute('data-state', 'idle');
  btn.setAttribute('data-chapter-url', chapterUrl);
  btn.innerHTML = getIdleContent();
  applyBtnTextClass(btn);

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.getAttribute('data-state') === 'loading') return;
    startDownload(btn, chapterUrl, buildSingleZipName(getMangaName(), chapterLabel));
  });

  bookmarkBtn.insertAdjacentElement('afterend', btn);
}

// ── Lancement du téléchargement ───────────────────────────────────────────────

function startDownload(btn, chapterUrl, zipName) {
  // Si le contexte de l'extension a été invalidé (ex. rechargement en cours de session),
  // chrome.runtime.id est undefined et sendMessage lèverait une exception.
  if (!chrome.runtime?.id) {
    setButtonState(btn, 'error', 'Extension reloaded — refresh the page');
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
          setButtonState(btn, 'error', 'Connection to the extension failed');
        }
      }
    );
  } catch (e) {
    setButtonState(btn, 'error', 'Extension reloaded — refresh the page');
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
    btn.title = 'Downloaded!';
    // Revenir à l'icône download après 2.5s
    setTimeout(() => {
      if (btn.getAttribute('data-state') === 'done') {
        btn.innerHTML = getIdleContent();
        applyBtnTextClass(btn);
        btn.setAttribute('data-state', 'idle');
        btn.title = 'Download';
        btn.style.pointerEvents = '';
      }
    }, 2500);
  } else if (state === 'error') {
    btn.innerHTML = ICON_ERROR;
    btn.title = extra || 'Download error';
    btn.style.pointerEvents = '';
  } else {
    // idle
    btn.innerHTML = getIdleContent();
    applyBtnTextClass(btn);
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
    updateDownloadAllPopupDone(message.zipName || 'manga.zip');

  } else if (message.action === 'downloadAllError') {
    updateDownloadAllPopupError(message.error || 'Unknown error', { canRetryZip: !!message.canRetryZip });

  } else if (message.action === 'downloadAllCancelled') {
    updateDownloadAllPopupCancelled();

  } else if (message.action === 'triggerDownload') {
    // Fallback for Firefox Android where chrome.downloads.download doesn't work
    // with blob URLs created in the service worker. The service worker sends the
    // ZIP as base64 and we trigger the download from the page context instead.
    try {
      const bytes = atob(message.base64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      const blob = new Blob([arr], { type: 'application/zip' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = message.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (_) {}
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

const CHAPTER_PATH_RE = /\/title\/[a-z0-9-]+\/\d+-chapter-[\w.-]+/gi;
const CHAPTERS_PER_PAGE = 20;
const MAX_CHAPTER_LIST_PAGES = 100;
const CHAPTER_LIST_WAIT_MS = 7000;

function unique(items) {
  return [...new Set(items)];
}

function normalizeChapterUrl(path) {
  try {
    return new URL(path, window.location.origin).href;
  } catch (_) {
    return '';
  }
}

function extractChapterUrlsFromText(text) {
  if (!text) return [];
  const matches = text.match(CHAPTER_PATH_RE) || [];
  return unique(matches.map(normalizeChapterUrl).filter(Boolean));
}

function collectChapterUrlsFromValue(value, urls = []) {
  if (!value) return urls;
  if (typeof value === 'string') {
    urls.push(...extractChapterUrlsFromText(value));
  } else if (Array.isArray(value)) {
    for (const item of value) collectChapterUrlsFromValue(item, urls);
  } else if (typeof value === 'object') {
    for (const item of Object.values(value)) collectChapterUrlsFromValue(item, urls);
  }
  return urls;
}

function extractChapterUrlsFromPayload(text) {
  try {
    return unique(collectChapterUrlsFromValue(JSON.parse(text)));
  } catch (_) {
    return extractChapterUrlsFromText(text);
  }
}

function filterChapterUrlsForTitle(urls, titleSlug) {
  if (!titleSlug) return urls;
  const titlePrefix = `/title/${titleSlug}/`;
  return urls.filter(url => {
    try {
      return new URL(url, window.location.origin).pathname.startsWith(titlePrefix);
    } catch (_) {
      return false;
    }
  });
}

function getChapterListRange(root = document.body) {
  const text = root.innerText || root.textContent || document.body?.innerText || '';
  const showingMatch = text.match(
    /Showing\s+(\d+)\s+to\s+(\d+)\s+of\s+(\d+)\s+items/i
  );
  if (!showingMatch) return null;

  return {
    from: parseInt(showingMatch[1], 10),
    to: parseInt(showingMatch[2], 10),
    total: parseInt(showingMatch[3], 10),
  };
}

function getExactChapterTotal(jsonStr = '') {
  const range = getChapterListRange(document.body);
  if (range) return range.total;

  const totalMatch = jsonStr?.match(/"chapter_count"\s*:\s*(\d+)|"total_chapters"\s*:\s*(\d+)/);
  if (totalMatch) return parseInt(totalMatch[1] || totalMatch[2], 10);

  return 0;
}

async function fetchChapterListPage(buildId, slug, page) {
  try {
    const r = await fetch(`/_next/data/${buildId}/title/${slug}.json?page=${page}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!r.ok) return [];
    return extractChapterUrlsFromPayload(await r.text());
  } catch (_) {
    return [];
  }
}

function getChaptersSection() {
  const heading = [...document.querySelectorAll('h1, h2, h3')]
    .find(el => /^chapters$/i.test(el.textContent.trim()));
  return heading?.closest('section') || document;
}

function extractChapterUrlsFromDom(root = getChaptersSection()) {
  return unique(
    [...root.querySelectorAll('a[href*="/title/"]')]
      .map(a => normalizeChapterUrl(a.getAttribute('href') || a.href))
      .filter(u => /\/\d+-chapter-/i.test(u))
  );
}

function getChapterListSignature(root = getChaptersSection()) {
  const range = getChapterListRange(root);
  const rangeText = range ? `${range.from}-${range.to}-${range.total}` : '';
  return `${rangeText}|${extractChapterUrlsFromDom(root).join('|')}`;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForChapterListChange(previousSignature) {
  const started = Date.now();
  while (Date.now() - started < CHAPTER_LIST_WAIT_MS) {
    await wait(120);
    const signature = getChapterListSignature();
    if (signature && signature !== previousSignature && extractChapterUrlsFromDom().length > 0) {
      return true;
    }
  }
  return false;
}

function findChapterPagerButtonByLabel(label) {
  return [...getChaptersSection().querySelectorAll('button[aria-label]')]
    .find(btn => btn.getAttribute('aria-label') === label && !btn.disabled) || null;
}

function getCurrentRenderedChapterPage() {
  const current = getChaptersSection().querySelector('[aria-current="page"], .npager__num.is-active');
  const page = parseInt(current?.textContent?.trim() || '', 10);
  if (Number.isFinite(page) && page > 0) return page;

  const range = getChapterListRange(getChaptersSection());
  if (!range) return 1;
  return Math.max(1, Math.ceil(range.to / CHAPTERS_PER_PAGE));
}

async function clickChapterPagerButton(label) {
  const btn = findChapterPagerButtonByLabel(label);
  if (!btn) return false;

  const before = getChapterListSignature();
  btn.click();
  return waitForChapterListChange(before);
}

async function restoreRenderedChapterPage(page) {
  if (!page || page <= 0) return;

  const current = getCurrentRenderedChapterPage();
  if (current === page) return;

  if (current !== 1) {
    await clickChapterPagerButton('First page');
  }

  for (let p = 1; p < page; p++) {
    const moved = await clickChapterPagerButton('Next page');
    if (!moved) break;
  }
}

async function collectChaptersFromRenderedPagination() {
  let allUrls = extractChapterUrlsFromDom();
  const initialRange = getChapterListRange(getChaptersSection());
  if (!initialRange || initialRange.total <= allUrls.length) return allUrls;

  const originalPage = getCurrentRenderedChapterPage();
  const originalScrollY = window.scrollY;
  if (originalPage !== 1) {
    await clickChapterPagerButton('First page');
  }

  for (let i = 0; i < MAX_CHAPTER_LIST_PAGES; i++) {
    allUrls.push(...extractChapterUrlsFromDom());

    const range = getChapterListRange(getChaptersSection());
    if (!range || range.to >= range.total) break;

    const moved = await clickChapterPagerButton('Next page');
    if (!moved) break;
  }

  await restoreRenderedChapterPage(originalPage);
  window.scrollTo(0, originalScrollY);
  return unique(allUrls);
}

/**
 * Collecte TOUTES les URLs de chapitres :
 *  1. Read embedded page payloads when present.
 *  2. Si un total > URLs trouvées, récupère les pages suivantes via l'API Next.js
 *  3. Fall back to walking the rendered chapter pagination.
 *  4. Déduplication par numéro de chapitre (une seule source par chapitre)
 *  5. Sort ascending.
 */
async function getAllChapters() {
  const slug    = window.location.pathname.match(/\/title\/([^/]+)/)?.[1];
  let allUrls   = [];

  const scriptEl = document.getElementById('__NEXT_DATA__');
  if (scriptEl) {
    const jsonStr = scriptEl.textContent;

    // ─ Extraction initiale depuis le JSON brut ─────────────────────────────
    allUrls = extractChapterUrlsFromPayload(jsonStr);

    // ─ Chercher le total de chapitres et le buildId pour les pages suivantes ───
    let nextData = null;
    try { nextData = JSON.parse(jsonStr); } catch (_) {}
    const buildId = nextData?.buildId;

    const total = getExactChapterTotal(jsonStr);

    if (buildId && slug && total > 0) {
      // Exact total known: fetch every page from 1, independent of the current pagination page.
      const maxPages = Math.min(Math.ceil(total / CHAPTERS_PER_PAGE), MAX_CHAPTER_LIST_PAGES);
      const pageNums = [];
      for (let p = 1; p <= maxPages; p++) pageNums.push(p);

      const results = await Promise.all(
        pageNums.map(p => fetchChapterListPage(buildId, slug, p))
      );

      for (const urls of results) {
        allUrls.push(...urls);
      }
    } else if (buildId && slug && allUrls.length > 0) {
      // Unknown total: fetch pages until the endpoint returns no new chapter links.
      const seenUrls = new Set(allUrls);
      for (let p = 1; p <= MAX_CHAPTER_LIST_PAGES; p++) {
        const urls = await fetchChapterListPage(buildId, slug, p);
        if (!urls.length) break;

        const freshUrls = urls.filter(url => !seenUrls.has(url));
        for (const url of freshUrls) {
          seenUrls.add(url);
          allUrls.push(url);
        }

        if (!freshUrls.length && p > 1) break;
      }
    }
  }

  // ─ Fallback DOM ─────────────────────────────────────────────────────
  const visibleTotal = getExactChapterTotal();
  if (allUrls.length === 0 || (visibleTotal > 0 && unique(allUrls).length < visibleTotal)) {
    allUrls.push(...await collectChaptersFromRenderedPagination());
  }
  allUrls = filterChapterUrlsForTitle(allUrls, slug);

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
      (res) => { if (chrome.runtime.lastError) updateDownloadAllPopupError('Connection to the extension failed'); }
    );
  } catch (_) {
    updateDownloadAllPopupError('Extension reloaded \u2014 refresh the page');
  }
}

/**
 * Returns true if an element has non-zero dimensions (i.e. is not hidden by
 * CSS display:none / visibility:hidden on itself or an ancestor).
 */
function isElVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}

/**
 * Finds the anchor element for inserting the Download All button.
 * Each candidate is checked for actual visibility so we don't inject
 * into a container that is display:none on mobile.
 * Returns { anchor, mode } where mode is 'afterend' | 'append' | 'floating',
 * or null (anchor not in DOM yet — caller should retry).
 */
function findDownloadAllAnchor() {
  // 1. Desktop exact class — only if visible
  const desktop = document.querySelector('.mpage__follow-btn');
  if (desktop && isElVisible(desktop)) return { anchor: desktop, mode: 'afterend' };

  // 2. Any follow-like class within the manga header, only if visible
  const pageRoot = document.querySelector('[class*="mpage"], [class*="manga-header"], [class*="title-page"]') || document.body;
  const followLike = [...pageRoot.querySelectorAll(
    '[class*="follow-btn"], [class*="follow_btn"], [class*="followBtn"], [class*="follow-button"]'
  )].find(isElVisible);
  if (followLike) return { anchor: followLike, mode: 'afterend' };

  // 3. Button / link / role=button whose text starts with "Follow", visible
  const followByText = [...document.querySelectorAll('button, a, [role="button"]')]
    .find(el => isElVisible(el) && /^follow(ing)?\b/i.test((el.textContent || '').trim()));
  if (followByText) return { anchor: followByText, mode: 'afterend' };

  // 4. Visible action container
  const actionContainer = [...document.querySelectorAll(
    '[class*="mpage__actions"], [class*="mpage-actions"], [class*="page-actions"]'
  )].find(isElVisible);
  if (actionContainer) return { anchor: actionContainer, mode: 'append' };

  // 5. Desktop button is in DOM but hidden (mobile collapses that section).
  //    Use 'floating' mode: fixed-position button anchored to the viewport.
  if (desktop) return { anchor: document.body, mode: 'floating' };

  // 6. Nothing found yet — caller should retry
  return null;
}

/** Injecte le bouton "Download All" sous le bouton Follow/Start-reading. */
function injectDownloadAllButton() {
  if (document.querySelector('.cdl-dl-all-btn')) return;
  const found = findDownloadAllAnchor();
  if (!found) {
    // Follow button not yet in DOM (React renders it late on mobile) — retry
    if (!_dlAllInjRetryTimer) {
      let attempts = 0;
      const retry = () => {
        if (document.querySelector('.cdl-dl-all-btn')) { _dlAllInjRetryTimer = null; return; }
        injectDownloadAllButton();
        if (!document.querySelector('.cdl-dl-all-btn') && attempts++ < 20) {
          _dlAllInjRetryTimer = setTimeout(retry, 500);
        } else {
          _dlAllInjRetryTimer = null;
        }
      };
      _dlAllInjRetryTimer = setTimeout(retry, 500);
    }
    return;
  }
  // Cancel any pending retry — we found the anchor
  if (_dlAllInjRetryTimer) { clearTimeout(_dlAllInjRetryTimer); _dlAllInjRetryTimer = null; }
  const { anchor, mode } = found;
  if (mode === 'floating' && CFG['appearance.allowFloating'] === false) return;

  const btn = document.createElement('button');
  btn.className = 'btn btn--soft mpage__follow-btn cdl-dl-all-btn';
  if (mode === 'floating') btn.classList.add('cdl-floating');
  btn.type = 'button';
  btn.title = 'Download all chapters as a ZIP';
  btn.innerHTML = `${ICON_DOWNLOAD} ${escapeHtml(getAllLabel())}`;

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!chrome?.runtime?.id) { alert('Extension reloaded — please refresh the page.'); return; }
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
      btn.innerHTML = `${ICON_DOWNLOAD} ${escapeHtml(getAllLabel())}`;
    }

    if (chapters.length === 0) { alert('No chapters found on this page.'); return; }

    const mangaName = getMangaName();
    const zipName   = buildAllZipName(mangaName);
    _lastDlAllParams = { chapters, mangaName, zipName };
    showDownloadAllPopup(mangaName, chapters.length);
    _launchDownloadAll();
  });

  if (mode === 'floating') document.body.appendChild(btn);
  else if (mode === 'append') anchor.appendChild(btn);
  else anchor.insertAdjacentElement('afterend', btn);
}

// ── Popup Download All ────────────────────────────────────────────────────────

// ── Theme sync : keep the popup's palette aligned with the host site ──────────
// comix.to (like most sites) flips between light/dark by swapping the page
// background and/or a class on <html>. We sample that at runtime so the popup
// matches, and re-check whenever the site toggles its theme.
let _cdlThemeWatching = false;

function _cdlRelLuminance(r, g, b) {
  const a = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}

// Returns 'dark' | 'light'. The page's actual background is the source of truth
// (it's what the popup sits on); class/attribute hints and the OS preference are
// fallbacks for when the background is transparent.
function _cdlDetectSiteTheme() {
  for (const el of [document.body, document.documentElement]) {
    if (!el) continue;
    const m = (getComputedStyle(el).backgroundColor || '').match(/rgba?\(([^)]+)\)/i);
    if (!m) continue;
    const p = m[1].split(',').map((s) => parseFloat(s));
    if (p.length >= 4 && p[3] === 0) continue; // transparent → keep looking
    if (p.length >= 3) return _cdlRelLuminance(p[0], p[1], p[2]) < 0.5 ? 'dark' : 'light';
  }
  const de = document.documentElement;
  const hint = (
    (de.getAttribute('data-theme') || de.getAttribute('data-color-mode') ||
     de.getAttribute('data-bs-theme') || de.className || '') + ' ' +
    ((document.body && document.body.className) || '')
  ).toLowerCase();
  if (/\bdark\b/.test(hint)) return 'dark';
  if (/\blight\b/.test(hint)) return 'light';
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch (_) { return 'dark'; }
}

function _cdlApplyPopupTheme() {
  const popup = document.getElementById('cdl-all-popup');
  if (popup) popup.setAttribute('data-cdl-theme', _cdlDetectSiteTheme());
}

// Re-sync on site theme toggles (class/attr/style swaps on <html>/<body>) and on
// OS-level scheme changes. Installed once; it's a no-op while no popup exists.
function _cdlEnsureThemeWatcher() {
  if (_cdlThemeWatching) return;
  _cdlThemeWatching = true;
  try {
    const mo = new MutationObserver(() => _cdlApplyPopupTheme());
    const opts = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-bs-theme', 'data-mode'] };
    mo.observe(document.documentElement, opts);
    if (document.body) mo.observe(document.body, opts);
  } catch (_) {}
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => _cdlApplyPopupTheme();
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch (_) {}
}

function showDownloadAllPopup(mangaName, totalChapters, options = {}) {
  const allowFullRetry = options.allowFullRetry !== false;
  document.getElementById('cdl-all-popup')?.remove();

  const popup = document.createElement('div');
  popup.id = 'cdl-all-popup';
  popup.setAttribute('data-cdl-theme', _cdlDetectSiteTheme());
  popup.innerHTML = `
    <div class="cdl-ap-header">
      <div class="cdl-ap-title">${ICON_DOWNLOAD}&nbsp;Downloading All Chapters</div>
      <button class="cdl-ap-close" title="Minimize">−</button>
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
  _cdlEnsureThemeWatcher();
  requestAnimationFrame(_cdlApplyPopupTheme);

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
  popup._cdlRetryTimer = allowFullRetry ? setTimeout(() => {
    if (!_lastDlAllParams) return;
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
  }, 20000) : null;
}

function dismissDownloadAllSession() {
  if (!chrome?.runtime?.id) return;
  try {
    chrome.runtime.sendMessage({ action: 'dismissDownloadAllSession' });
  } catch (_) {}
}

function _dlAllSetFooterClose(popup) {
  clearTimeout(popup._cdlRetryTimer);
  const footer = popup.querySelector('.cdl-ap-footer');
  if (!footer) return;
  footer.innerHTML = '<button class="cdl-ap-done-btn" id="cdl-ap-close-btn">Close</button>';
  document.getElementById('cdl-ap-close-btn')?.addEventListener('click', () => {
    dismissDownloadAllSession();
    popup.remove();
  });
}

function updateDownloadAllPopupDone(zipName) {
  const popup = document.getElementById('cdl-all-popup');
  if (!popup) return;
  const bar = document.getElementById('cdl-ap-bar');
  if (bar) bar.style.width = '100%';
  const s = document.getElementById('cdl-ap-chapter-status');
  if (s) {
    s.textContent = 'Download complete!';
    s.classList.remove('error');
  }
  const i = document.getElementById('cdl-ap-img-status');
  if (i) i.textContent = `Saved as: ${zipName || 'manga.zip'}`;
  _dlAllSetFooterClose(popup);
  maybeAutoHideFrame(popup);
}

function updateDownloadAllPopupCancelled() {
  const popup = document.getElementById('cdl-all-popup');
  if (!popup) return;
  const s = document.getElementById('cdl-ap-chapter-status');
  if (s) {
    s.textContent = 'Download cancelled.';
    s.classList.remove('error');
  }
  _dlAllSetFooterClose(popup);
  maybeAutoHideFrame(popup);
}

function updateDownloadAllPopup(msg) {
  const popup = document.getElementById('cdl-all-popup');
  if (!popup) return;
  const { phase, chapterIndex, totalChapters, chapterLabel, imagesDone, imagesTotal } = msg;

  const el = (id) => document.getElementById(id);
  const pctDone    = totalChapters > 0 ? Math.round((chapterIndex - 1) / totalChapters * 100) : 0;
  const pctCurrent = totalChapters > 0 ? Math.round(chapterIndex / totalChapters * 100) : 0;

  if (phase === 'preparing') {
    el('cdl-ap-chapter-status').textContent = 'Preparing...';
    el('cdl-ap-img-status').textContent     = 'Starting...';
    el('cdl-ap-bar').style.width            = '0%';
    el('cdl-ap-counter').textContent        = `0 / ${totalChapters || 0} chapters`;

  } else if (phase === 'cancelling') {
    el('cdl-ap-chapter-status').textContent = 'Cancelling...';
    el('cdl-ap-img-status').textContent     = 'Stopping after the current step...';

  } else if (phase === 'extracting') {
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
            if (chrome.runtime.lastError) updateDownloadAllPopupError('Connection to the extension failed');
            else { retryBtn.disabled = false; retryBtn.textContent = '↺ Retry'; }
          });
        } catch (_) { updateDownloadAllPopupError('Extension reloaded — refresh the page'); }
      });
      footer.insertBefore(retryBtn, footer.firstChild);
    }
  } else if (phase === 'savingPart') {
    el('cdl-ap-chapter-status').textContent = `Saving ZIP part ${msg.zipPart || ''}...`;
    el('cdl-ap-img-status').textContent     = 'Continuing after this part is saved...';
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

function updateDownloadAllPopupError(errMsg, options = {}) {
  const popup = document.getElementById('cdl-all-popup');
  if (!popup) return;
  clearTimeout(popup._cdlRetryTimer);
  const s = document.getElementById('cdl-ap-chapter-status');
  if (s) { s.textContent = `Error: ${errMsg}`; s.classList.add('error'); }

  const footer = popup.querySelector('.cdl-ap-footer');
  if (!footer) return;
  footer.innerHTML = '';

  if (options.canRetryZip) {
    const retryBtn = document.createElement('button');
    retryBtn.className = 'cdl-ap-retry-btn';
    retryBtn.textContent = 'Retry ZIP';
    retryBtn.addEventListener('click', () => {
      retryBtn.disabled = true;
      retryBtn.textContent = 'Retrying...';
      const status = document.getElementById('cdl-ap-chapter-status');
      if (status) {
        status.textContent = 'Building ZIP file...';
        status.classList.remove('error');
      }
      try {
        chrome.runtime.sendMessage({ action: 'retryZip' }, () => {
          if (chrome.runtime.lastError) updateDownloadAllPopupError('Connection to the extension failed');
          else {
            retryBtn.disabled = false;
            retryBtn.textContent = 'Retry ZIP';
          }
        });
      } catch (_) {
        updateDownloadAllPopupError('Extension reloaded — refresh the page');
      }
    });
    footer.appendChild(retryBtn);
  } else if (_lastDlAllParams) {
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
  closeBtn.addEventListener('click', () => {
    dismissDownloadAllSession();
    popup.remove();
  });
  footer.appendChild(closeBtn);
}

function restoreDownloadAllLogItems(items) {
  const log = document.getElementById('cdl-ap-log');
  if (!log || !Array.isArray(items)) return;
  log.innerHTML = '';
  for (const entry of items) {
    if (!entry || !entry.text) continue;
    const cls = ['active', 'done', 'error', 'skipped'].includes(entry.cls) ? entry.cls : '';
    const item = document.createElement('div');
    item.className = `cdl-ap-log-item ${cls}`;
    item.dataset.chid = entry.id || entry.text;
    item.textContent = entry.text;
    log.appendChild(item);
  }
  log.scrollTop = log.scrollHeight;
}

function restoreDownloadAllPopupFromSession(session) {
  if (!session || document.getElementById('cdl-all-popup')) return;

  showDownloadAllPopup(
    session.mangaName || getMangaName(),
    session.totalChapters || 0,
    { allowFullRetry: false }
  );
  restoreDownloadAllLogItems(session.logItems);

  if (session.status === 'done') {
    updateDownloadAllPopupDone(session.doneZipName || session.zipName || 'manga.zip');
  } else if (session.status === 'error') {
    updateDownloadAllPopupError(session.error || 'Unknown error', { canRetryZip: !!session.canRetryZip });
  } else if (session.status === 'cancelled') {
    updateDownloadAllPopupCancelled();
  } else if (session.lastProgress) {
    updateDownloadAllPopup(session.lastProgress);
  }
}

function restoreDownloadAllPopupFromBackground() {
  if (!chrome?.runtime?.id) return;
  try {
    chrome.runtime.sendMessage({ action: 'getDownloadAllSession' }, (res) => {
      if (chrome.runtime.lastError || !res?.session) return;
      restoreDownloadAllPopupFromSession(res.session);
    });
  } catch (_) {}
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
    // Also watch for the Follow button appearing late (React deferred render on mobile).
    const FOLLOW_LIKE_RE = /(?:^|\s)(?:mpage__)?(?:follow(?:[-_]?btn)?)\b/i;
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const cls = typeof node.className === 'string' ? node.className : '';
        if (
          FOLLOW_LIKE_RE.test(cls) ||
          node.querySelector?.('[class*="follow-btn"], [class*="follow_btn"], [class*="followBtn"], .mpage__follow-btn') ||
          (node.querySelector?.('button, a, [role="button"]') &&
            [...(node.querySelectorAll?.('button, a, [role="button"]') || [])].some(
              el => /^follow(ing)?\b/i.test((el.textContent || '').trim())
            ))
        ) {
          injectDownloadAllButton();
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ── Point d'entrée ────────────────────────────────────────────────────────────

(async function init() {
  // Ne pas s'exécuter sur les pages de lecture de chapitre
  // URL format de chapitre : /title/{slug}/{chapterId}
  const pathParts = location.pathname.split('/').filter(Boolean);
  // pathParts[0] === 'title', pathParts[1] === slug, pathParts[2] === chapterId (si présent)
  if (pathParts.length >= 3 && /^\d+/.test(pathParts[2])) {
    // Nous sommes sur une page de lecture de chapitre, ne rien faire
    return;
  }

  if (typeof CDLSettings !== 'undefined') {
    try { CFG = await CDLSettings.getSettings(); } catch (_) {}
    CDLSettings.onChange((next) => { CFG = next; onSettingsChanged(); });
  }

  injectStyles();
  applyDynamicStyles();
  scanAndInject();
  observeDOM();
  restoreDownloadAllPopupFromBackground();
})();
