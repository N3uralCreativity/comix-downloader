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
// The "Angle Tray" brand mark (icons/icon.svg), filled with currentColor so the
// buttons' accent theming keeps working.
const ICON_DOWNLOAD = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
  <polygon points="10,2.6 14,2.6 14,8.6 18.8,8.6 12,15.8 5.2,8.6 10,8.6"/>
  <path d="M3 16.8 6.2 20h11.6l3.2-3.2v4.8H3z"/>
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

// Replace a node's children from a trusted HTML string without touching innerHTML.
// All callers pass internal icon constants + escapeHtml()'d text. Parsing with
// DOMParser('text/html') never executes scripts and isn't an innerHTML/outerHTML
// sink, so addons-linter / CWS review stay clean.
function _setHTML(node, html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  node.replaceChildren(...parsed.body.childNodes);
}

function getAccent() {
  const c = CFG['appearance.accentColor'];
  // Auto mode follows comix.to's own accent (cyan on "Main", purple on "Dark"),
  // read live from the page's --accent custom property; custom mode wins.
  return (CFG['appearance.accentMode'] === 'custom' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c || '')) ? c : 'var(--accent, #66e8fa)';
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
  // Only a custom accent recolors the idle buttons; auto mode keeps the neutral
  // look that blends with the host site (default behaviour unchanged).
  const isCustom = CFG['appearance.accentMode'] === 'custom';
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
    ${isCustom ? `
    .${DOWNLOAD_BTN_CLASS}[data-state="idle"] { color:${accent}; }
    .${DOWNLOAD_BTN_CLASS}[data-state="idle"]:hover { color:${accent}; filter:brightness(1.25); }
    .cdl-dl-all-btn, .cdl-dl-all-btn svg { color:${accent}!important; }
    ` : ''}
    ${noAnim ? `.${DOWNLOAD_BTN_CLASS}[data-state="loading"] svg{animation:none!important;} #cdl-all-popup{animation:none!important;} .${DOWNLOAD_BTN_CLASS},.cdl-ap-bar,.cdl-ap-close{transition:none!important;}` : ''}
  `;
  document.head.appendChild(style);
}

// Re-apply everything that depends on settings (called on storage change).
function onSettingsChanged() {
  // Only touch the DOM on title overview pages. The extension's `.cdl-btn` class is
  // also used by the embedded settings UI (Export/Import/Reset), so running this on
  // the settings page would restyle / overwrite those buttons.
  if (!isTitleOverviewPage()) return;
  applyDynamicStyles();
  const all = document.querySelector('.cdl-dl-all-btn:not(.cdl-sub-btn)');
  if (all && !all.disabled) _setHTML(all, `${ICON_DOWNLOAD} ${escapeHtml(getAllLabel())}`);
  document.querySelectorAll(`.${DOWNLOAD_BTN_CLASS}`).forEach((b) => {
    const st = b.getAttribute('data-state');
    if (!st || st === 'idle') { _setHTML(b, getIdleContent()); applyBtnTextClass(b); }
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
      color: var(--text-2, #888);
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
      color: var(--text, #e0e0e0);
      background: rgba(255,255,255,0.07);
    }
    .${DOWNLOAD_BTN_CLASS}[data-state="loading"] {
      color: var(--accent, #60a5fa);
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
      color: var(--success, #4ade80);
      pointer-events: none;
    }
    .${DOWNLOAD_BTN_CLASS}[data-state="error"] {
      color: var(--danger, #f87171);
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
      color: var(--accent, #60a5fa);
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
      background: var(--surface-2, rgba(19,21,31,0.97)) !important;
      border: 1px solid rgba(255,255,255,0.18) !important;
      box-shadow: 0 4px 24px rgba(0,0,0,0.55) !important;
      margin-top: 0 !important;
    }
    /* ── Popup progression Download All ──────────────────────────────────── */
    #cdl-all-popup {
      /* Inherits comix.to's own theme tokens so it matches whatever palette the
         user has active — "Main" (cyan) or "Dark" (purple). [data-cdl-theme="light"]
         below covers comix's light theme; fallbacks are comix's "Main" values. */
      --cdl-bg: var(--surface, #2a3134);
      --cdl-header-bg: var(--surface-2, #323a3e);
      --cdl-text: var(--text, #cdd5d6);
      --cdl-text-strong: var(--text-emphasis, #ecf4f5);
      --cdl-muted: var(--text-2, #9da4a5);
      --cdl-faint: var(--text-3, #6f7778);
      --cdl-border: rgba(255,255,255,0.10);
      --cdl-border-soft: rgba(255,255,255,0.06);
      --cdl-track: rgba(255,255,255,0.09);
      --cdl-log-bg: rgba(255,255,255,0.03);
      --cdl-hover: rgba(255,255,255,0.08);
      --cdl-shadow: 0 16px 40px -14px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.30);
      --cdl-accent: var(--accent, #66e8fa);
      --cdl-ok: var(--success, #4ade80);   --cdl-ok-bg: rgba(74,222,128,0.12);  --cdl-ok-bgh: rgba(74,222,128,0.20);  --cdl-ok-border: rgba(74,222,128,0.28);
      --cdl-warn: var(--warning, #fbbf24); --cdl-warn-bg: rgba(251,191,36,0.12); --cdl-warn-bgh: rgba(251,191,36,0.20); --cdl-warn-border: rgba(251,191,36,0.30);
      --cdl-err: var(--danger, #f87171);  --cdl-err-bg: rgba(239,68,68,0.12);   --cdl-err-bgh: rgba(239,68,68,0.20);   --cdl-err-border: rgba(239,68,68,0.28);
      --cdl-skip: var(--text-3, #5a6280);

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
  _setHTML(btn, getIdleContent());
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
        options: buildSingleChapterOptions(chapterUrl),
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

// Output options for a single-chapter download — inherits the saved settings
// defaults (format/ComicInfo). A single chapter is itself the .cbz, so series
// cover/series.json aren't bundled, but ComicInfo still uses the scraped fields.
function buildSingleChapterOptions(chapterUrl) {
  return {
    format: CFG['output.format'] || 'zip',
    includeComicInfo: CFG['output.includeComicInfo'] !== false,
    includeSeriesMeta: false,
    folderLayout: 'default',
    chapterLabel: extractChapterLabel(chapterUrl),
    mangaName: getMangaName(),
    slug: _cdlSlug(),   // so the background records it in the per-series manifest
    seriesMeta: scrapeSeriesMeta(),
  };
}

// ── Mise à jour visuelle du bouton ────────────────────────────────────────────

function setButtonState(btn, state, extra) {
  btn.setAttribute('data-state', state);
  const progressSpan = btn.querySelector(`.${PROGRESS_SPAN_CLASS}`);

  if (state === 'loading') {
    _setHTML(btn, getSpinnerSVG() + `<span class="${PROGRESS_SPAN_CLASS}">${escapeHtml(extra || '')}</span>`);
  } else if (state === 'done') {
    _setHTML(btn, ICON_DONE);
    btn.title = 'Downloaded!';
    // Revenir à l'icône download après 2.5s
    setTimeout(() => {
      if (btn.getAttribute('data-state') === 'done') {
        _setHTML(btn, getIdleContent());
        applyBtnTextClass(btn);
        btn.setAttribute('data-state', 'idle');
        btn.title = 'Download';
        btn.style.pointerEvents = '';
      }
    }, 2500);
  } else if (state === 'error') {
    _setHTML(btn, ICON_ERROR);
    btn.title = extra || 'Download error';
    btn.style.pointerEvents = '';
  } else {
    // idle
    _setHTML(btn, getIdleContent());
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
  } else if (message.action === 'startDownloadAll') {
    // From the right-click "Download whole series" context menu — reuse the button flow.
    const b = document.querySelector('.cdl-dl-all-btn:not(.cdl-sub-btn)');
    if (b) b.click();

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
  // The "Showing X to Y of Z items" range gives the page exactly (Y / per-page); prefer it.
  const range = getChapterListRange(getChaptersSection());
  if (range) return Math.max(1, Math.ceil(range.to / CHAPTERS_PER_PAGE));

  const current = getChaptersSection().querySelector('[aria-current="page"], .npager__num.is-active');
  const page = parseInt(current?.textContent?.trim() || '', 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

// Enabled, numbered page buttons currently rendered in the chapter pager.
function chapterPagerNumberButtons() {
  return [...getChaptersSection().querySelectorAll('button')]
    .filter(b => /^\d+$/.test((b.textContent || '').trim()) && !b.disabled)
    .map(b => ({ n: parseInt(b.textContent.trim(), 10), btn: b }));
}

// comix's chapter pager is WINDOWED and centered on the current page: on page 1 it shows
// [1..5] + "Next"/"Last"; but on e.g. page 5 of 7 it shows [First]/[Prev] + [3..7] with NO
// "Next page" button — the later pages are only reachable as numbered buttons. So paging
// forward with "Next page" alone stalls partway (dropping the OLDEST chapters, since the list
// is newest-first). Navigate by the numbered buttons (which always include current±2 around
// the current page), falling back to the chevrons/window edges. Converges on `target`.
async function goToChapterPage(target) {
  for (let guard = 0; guard < MAX_CHAPTER_LIST_PAGES; guard++) {
    const cur = getCurrentRenderedChapterPage();
    if (cur === target) return true;
    const before = getChapterListSignature();
    const nums = chapterPagerNumberButtons();
    let btn = (nums.find(x => x.n === target) || {}).btn;
    if (!btn) {
      if (target > cur) {
        const fwd = nums.filter(x => x.n > cur && x.n <= target).sort((a, b) => b.n - a.n)[0]
                 || nums.filter(x => x.n > cur).sort((a, b) => b.n - a.n)[0];
        btn = (fwd && fwd.btn) || findChapterPagerButtonByLabel('Next page') || findChapterPagerButtonByLabel('Last page');
      } else {
        const bwd = nums.filter(x => x.n < cur && x.n >= target).sort((a, b) => a.n - b.n)[0]
                 || nums.filter(x => x.n < cur).sort((a, b) => a.n - b.n)[0];
        btn = (bwd && bwd.btn) || findChapterPagerButtonByLabel('Previous page') || findChapterPagerButtonByLabel('First page');
      }
    }
    if (!btn) return false;
    btn.click();
    if (!await waitForChapterListChange(before)) return false;
  }
  return false;
}

async function restoreRenderedChapterPage(page) {
  if (!page || page <= 0) return;
  await goToChapterPage(page);
}

// Walk every chapter-list page (1 → last), invoking collect() on each rendered page. Robust to
// the windowed pager; restores the page + scroll the user was on afterward.
async function walkChapterListPages(collect) {
  const originalPage = getCurrentRenderedChapterPage();
  const originalScrollY = window.scrollY;
  await goToChapterPage(1);
  for (let i = 0; i < MAX_CHAPTER_LIST_PAGES; i++) {
    collect();
    const range = getChapterListRange(getChaptersSection());
    if (!range || range.to >= range.total) break;
    if (!await goToChapterPage(getCurrentRenderedChapterPage() + 1)) break;
  }
  await restoreRenderedChapterPage(originalPage);
  window.scrollTo(0, originalScrollY);
}

async function collectChaptersFromRenderedPagination() {
  const firstPageUrls = extractChapterUrlsFromDom();
  const initialRange = getChapterListRange(getChaptersSection());
  if (!initialRange || initialRange.total <= firstPageUrls.length) return firstPageUrls;

  const allUrls = [];
  await walkChapterListPages(() => allUrls.push(...extractChapterUrlsFromDom()));
  return unique(allUrls);
}

// Each chapter row on the new title page is `.mchap-row` and carries its
// scanlation group in `.mchap-row__group` (name in the trailing <span>, id in
// the /groups/<id> href). We read full rows — one per chapter PER group, since
// comix's "All groups" view lists every group's upload — so the download panel
// can offer a translator filter. Returns [] on the old/legacy layout.
function extractChapterRowsFromDom(root = getChaptersSection()) {
  const rows = [];
  root.querySelectorAll('.mchap-row').forEach((row) => {
    const a = row.querySelector('a.mchap-row__primary[href]') || row.querySelector('a[href*="-chapter-"]');
    if (!a) return;
    const url = normalizeChapterUrl(a.getAttribute('href') || a.href);
    if (!/\/\d+-chapter-/i.test(url)) return;
    const gEl = row.querySelector('.mchap-row__group');
    const group = gEl ? ((gEl.querySelector('span') || gEl).textContent || '').trim() : '';
    const groupId = gEl ? (((gEl.getAttribute('href') || '').match(/\/groups\/(\d+)/) || [])[1] || '') : '';
    rows.push({ chapterUrl: url, chapterLabel: extractChapterLabel(url), group, groupId });
  });
  return rows;
}

async function collectChapterRowsWithGroups() {
  const seen = new Set();
  const rows = [];
  const add = (rs) => { for (const r of rs) { if (!seen.has(r.chapterUrl)) { seen.add(r.chapterUrl); rows.push(r); } } };
  add(extractChapterRowsFromDom());
  if (!rows.length) return rows; // not the new chapter-list DOM → caller falls back

  const initialRange = getChapterListRange(getChaptersSection());
  if (initialRange && initialRange.to < initialRange.total) {
    await walkChapterListPages(() => add(extractChapterRowsFromDom()));
  }
  return rows;
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
function _launchDownloadAll(attempt) {
  attempt = attempt || 0;
  if (!_lastDlAllParams) return;
  const { chapters, mangaName, zipName, options } = _lastDlAllParams;
  // The MV3 service worker sleeps when idle; the first message after a crash/idle can come back
  // with a transient lastError ("message port closed" / "Receiving end does not exist") while it
  // spins back up. The background acks BEFORE doing any work, so a transient error means the
  // request wasn't started \u2014 safe to retry a few times before surfacing a failure to the user.
  const retry = () => { if (attempt < 3) { setTimeout(() => _launchDownloadAll(attempt + 1), 500); return true; } return false; };
  try {
    chrome.runtime.sendMessage(
      { action: 'downloadAllChapters', chapters, mangaName, zipName, options },
      () => {
        const err = chrome.runtime.lastError;
        if (!err) return; // acked \u2014 the download is starting
        if (/context invalidated/i.test(err.message || '')) {
          updateDownloadAllPopupError('Extension was updated \u2014 refresh the page and try again');
        } else if (!retry()) {
          updateDownloadAllPopupError('Connection to the extension failed');
        }
      }
    );
  } catch (e) {
    // Synchronous throw = the extension context is gone (updated/reloaded). Retrying can't help.
    if (/context invalidated/i.test(e && e.message || '') || !retry()) {
      updateDownloadAllPopupError('Extension reloaded \u2014 refresh the page');
    }
  }
}

// \u2500\u2500 Series metadata scrape + downloaded-manifest helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// comix.to keeps series data in specific DOM nodes (mpage__*), so we read those
// directly and fall back to __NEXT_DATA__ / <meta> for the full description.
function pickLargestImage(img) {
  // Prefer the largest srcset candidate; else strip a "@NNN" size suffix from src
  // (e.g. ...69767eed05c41@280.jpg \u2192 ...69767eed05c41.jpg = full resolution).
  try {
    const ss = img.getAttribute('srcset') || '';
    if (ss) {
      let best = '', bestW = -1;
      ss.split(',').forEach((part) => {
        const m = part.trim().match(/(\S+)\s+(\d+)w/);
        if (m && parseInt(m[2], 10) > bestW) { bestW = parseInt(m[2], 10); best = m[1]; }
      });
      if (best) return best;
    }
  } catch (_) {}
  const src = img.getAttribute('src') || img.src || '';
  return src.replace(/@\d+(?=\.\w+(?:$|\?))/, '');
}

function scrapeSeriesMeta() {
  const meta = {
    title: getMangaName(), authors: [], artists: [], status: '', description: '',
    genres: [], demographics: [], coverUrl: '', language: 'en',
  };

  // Cover \u2014 .mpage__poster img (full-res)
  const poster = document.querySelector('.mpage__poster img, [class*="mpage__poster"] img, img[class*="mpage__poster"]');
  if (poster) meta.coverUrl = pickLargestImage(poster);

  // Status badge \u2014 e.g. "RELEASING"
  const statusEl = document.querySelector('.mpage__badge--status, [class*="badge--status"]');
  if (statusEl) meta.status = (statusEl.textContent || '').trim();

  // Detail blocks: Authors / Artists / Genres / Demographics (skip tracker chips)
  document.querySelectorAll('.mpage__detail').forEach((block) => {
    const label = (block.querySelector('.mpage__detail-label')?.textContent || '').trim().toLowerCase();
    const chips = [...block.querySelectorAll('.mpage__chip')]
      .filter((a) => !a.classList.contains('mpage__chip--tracker'))
      .map((a) => (a.textContent || '').trim())
      .filter(Boolean);
    if (!chips.length) return;
    if (label === 'authors') meta.authors = chips;
    else if (label === 'artists') meta.artists = chips;
    else if (label === 'genres') meta.genres = chips;
    else if (label === 'demographics') meta.demographics = chips;
  });

  // Description \u2014 visible block first (may be truncated), then the full one from
  // __NEXT_DATA__ (the longest description/synopsis/summary string), then <meta>.
  const descEl = document.querySelector('.mpage__description, [class*="mpage__description"], [class*="mpage__summary"]');
  if (descEl) { const t = (descEl.textContent || '').trim(); if (t.length > meta.description.length) meta.description = t; }
  try {
    const el = document.getElementById('__NEXT_DATA__');
    const raw = el ? (el.textContent || '') : '';
    if (raw) {
      let best = meta.description || '';
      for (const m of raw.matchAll(/"(?:description|synopsis|summary)"\s*:\s*"((?:[^"\\]|\\.){20,}?)"/gi)) {
        try { const s = JSON.parse('"' + m[1] + '"'); if (s.length > best.length) best = s; } catch (_) {}
      }
      meta.description = best;
      if (!meta.language) { const lm = raw.match(/"lang(?:uage)?"\s*:\s*"([a-z]{2}(?:-[A-Za-z]{2})?)"/i); if (lm) meta.language = lm[1]; }
    }
  } catch (_) {}

  // <meta> fallbacks
  if (!meta.coverUrl) { const og = document.querySelector('meta[property="og:image"]'); if (og && og.content) meta.coverUrl = og.content; }
  if (!meta.description) { const md = document.querySelector('meta[name="description"], meta[property="og:description"]'); if (md && md.content) meta.description = md.content; }

  meta.slug = (location.pathname.match(/\/title\/([^/]+)/) || [])[1] || '';
  meta.sourceUrl = location.href;
  return meta;
}

// Stable per-chapter key (matches background's manifest key) via CDLFeaturesCore.
function chapterKeyOf(label) {
  if (typeof CDLFeaturesCore !== 'undefined') {
    return CDLFeaturesCore.dedupeKey(CDLFeaturesCore.parseChapterNumber(label));
  }
  return String(label || '');
}

// Resolve the set of already-downloaded chapter keys for this series.
function getDownloadedKeySet() {
  return new Promise((resolve) => {
    const slug = (location.pathname.match(/\/title\/([^/]+)/) || [])[1] || '';
    if (!slug || !chrome?.storage?.local) { resolve(new Set()); return; }
    try {
      chrome.storage.local.get('cdlManifest', (res) => {
        const entry = res && res.cdlManifest && res.cdlManifest[slug];
        resolve(new Set(entry && entry.chapters ? Object.keys(entry.chapters) : []));
      });
    } catch (_) { resolve(new Set()); }
  });
}

// Per-series saved output preferences (cdlSeriesPrefs[slug]); overlays settings defaults.
function getSeriesPrefs() {
  return new Promise((resolve) => {
    const slug = (location.pathname.match(/\/title\/([^/]+)/) || [])[1] || '';
    if (!slug || !chrome?.storage?.local) { resolve({}); return; }
    try {
      chrome.storage.local.get('cdlSeriesPrefs', (res) => {
        resolve((res && res.cdlSeriesPrefs && res.cdlSeriesPrefs[slug]) || {});
      });
    } catch (_) { resolve({}); }
  });
}
function saveSeriesPrefs(prefs) {
  const slug = (location.pathname.match(/\/title\/([^/]+)/) || [])[1] || '';
  if (!slug || !chrome?.storage?.local) return;
  try {
    chrome.storage.local.get('cdlSeriesPrefs', (res) => {
      const all = (res && res.cdlSeriesPrefs) || {};
      all[slug] = prefs;
      chrome.storage.local.set({ cdlSeriesPrefs: all });
    });
  } catch (_) {}
}

// Mark per-chapter buttons whose chapter is already in the downloaded manifest
// (subtle green dot + tooltip). Re-run on scan and whenever the manifest changes.
function markDownloadedButtons() {
  getDownloadedKeySet().then((set) => {
    if (!document.getElementById('cdl-done-style')) {
      const st = document.createElement('style');
      st.id = 'cdl-done-style';
      st.textContent = `.${DOWNLOAD_BTN_CLASS}.cdl-row-done::after{content:'';position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;background:#4ade80;box-shadow:0 0 0 1px rgba(0,0,0,0.25);}`;
      document.head.appendChild(st);
    }
    document.querySelectorAll(`.${DOWNLOAD_BTN_CLASS}[data-chapter-url]`).forEach((b) => {
      const label = extractChapterLabel(b.getAttribute('data-chapter-url') || '');
      const done = set.has(chapterKeyOf(label));
      b.classList.toggle('cdl-row-done', done);
      if (done && !/already downloaded/i.test(b.title)) b.title = `${b.title} (already downloaded)`;
    });
  }).catch(() => {});
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
  if (document.querySelector('.cdl-dl-all-btn:not(.cdl-sub-btn)')) return;
  const found = findDownloadAllAnchor();
  if (!found) {
    // Follow button not yet in DOM (React renders it late on mobile) — retry
    if (!_dlAllInjRetryTimer) {
      let attempts = 0;
      const retry = () => {
        if (document.querySelector('.cdl-dl-all-btn:not(.cdl-sub-btn)')) { _dlAllInjRetryTimer = null; return; }
        injectDownloadAllButton();
        if (!document.querySelector('.cdl-dl-all-btn:not(.cdl-sub-btn)') && attempts++ < 20) {
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
  _setHTML(btn, `${ICON_DOWNLOAD} ${escapeHtml(getAllLabel())}`);

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!chrome?.runtime?.id) { alert('Extension reloaded — please refresh the page.'); return; }
    if (document.getElementById('cdl-all-popup') || document.getElementById('cdl-opts-panel')) return; // already running / panel open

    // Indicateur de chargement pendant la collecte des chapitres
    btn.disabled = true;
    _setHTML(btn, `${ICON_DOWNLOAD} Loading chapters…`);

    let rows;
    try {
      rows = await collectChapterRowsWithGroups();
      if (!rows.length) {
        // Legacy layout (no .mchap-row): fall back to the URL-only scraper.
        const legacy = await getAllChapters();
        rows = legacy.map((c) => ({ chapterUrl: c.chapterUrl, chapterLabel: c.chapterLabel, group: '', groupId: '' }));
      }
    } catch (_) {
      rows = [];
    } finally {
      btn.disabled = false;
      _setHTML(btn, `${ICON_DOWNLOAD} ${escapeHtml(getAllLabel())}`);
    }

    if (rows.length === 0) { alert('No chapters found on this page.'); return; }

    // Open the options panel; it launches the download (or export) on Start.
    showDownloadAllOptionsPanel(getMangaName(), rows);
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

// ── Download options panel (shown before Download All) ────────────────────────
function injectOptsStyles() {
  if (document.getElementById('cdl-opts-styles')) return;
  const style = document.createElement('style');
  style.id = 'cdl-opts-styles';
  style.textContent = `
    #cdl-opts-backdrop { position:fixed; inset:0; z-index:2147483647; background:rgba(8,10,16,0.55);
      display:flex; align-items:center; justify-content:center; padding:20px;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; animation:cdl-ap-in .18s ease both; }
    #cdl-opts-panel {
      --cdl-bg:var(--surface,#2a3134); --cdl-header-bg:var(--surface-2,#323a3e); --cdl-text:var(--text,#cdd5d6); --cdl-text-strong:var(--text-emphasis,#ecf4f5);
      --cdl-muted:var(--text-2,#9da4a5); --cdl-faint:var(--text-3,#6f7778); --cdl-border:rgba(255,255,255,0.10); --cdl-border-soft:rgba(255,255,255,0.06);
      --cdl-hover:rgba(255,255,255,0.06); --cdl-accent:var(--accent,#66e8fa); --cdl-accent-bg:rgb(var(--accent-rgb,102 232 250) / 0.14);
      --cdl-ok:var(--success,#4ade80);
      width:440px; max-width:100%; max-height:88vh; overflow-y:auto; background:var(--cdl-bg);
      color:var(--cdl-text); border:1px solid var(--cdl-border); border-radius:14px;
      box-shadow:0 18px 44px rgba(0,0,0,0.5); font-size:13px; }
    #cdl-opts-panel[data-cdl-theme="light"] {
      --cdl-bg:#fff; --cdl-header-bg:#f7f8fb; --cdl-text:#2b3146; --cdl-text-strong:#14171f; --cdl-muted:#6b7180;
      --cdl-faint:#98a0b2; --cdl-border:rgba(17,20,32,0.12); --cdl-border-soft:rgba(17,20,32,0.08);
      --cdl-hover:rgba(17,20,32,0.05); --cdl-accent-bg:rgba(37,99,235,0.10); }
    .cdl-op-head { display:flex; align-items:center; justify-content:space-between; gap:10px;
      padding:13px 16px; background:var(--cdl-header-bg); border-bottom:1px solid var(--cdl-border-soft);
      border-radius:14px 14px 0 0; }
    .cdl-op-title { font-weight:600; font-size:14px; color:var(--cdl-text-strong); display:flex; align-items:center; gap:8px; }
    .cdl-op-title svg { width:16px; height:16px; color:var(--cdl-accent); }
    .cdl-op-close { background:none; border:none; color:var(--cdl-faint); font-size:20px; line-height:1; cursor:pointer; padding:2px 8px; border-radius:6px; }
    .cdl-op-close:hover { color:var(--cdl-text-strong); background:var(--cdl-hover); }
    .cdl-op-body { padding:14px 16px; display:flex; flex-direction:column; gap:14px; }
    .cdl-op-sec-label { font-size:11px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--cdl-muted); margin-bottom:7px; }
    .cdl-op-cards { display:flex; gap:9px; }
    .cdl-op-card { flex:1; border:1.5px solid var(--cdl-border); border-radius:10px; padding:10px 11px; cursor:pointer; transition:border-color .12s, background .12s; }
    .cdl-op-card:hover { background:var(--cdl-hover); }
    .cdl-op-card.sel { border-color:var(--cdl-accent); background:var(--cdl-accent-bg); }
    .cdl-op-card .t { font-weight:600; color:var(--cdl-text-strong); font-size:13px; }
    .cdl-op-card .d { color:var(--cdl-muted); font-size:11px; margin-top:3px; line-height:1.35; }
    .cdl-op-row { display:flex; align-items:center; gap:9px; }
    .cdl-op-check { display:flex; align-items:flex-start; gap:9px; cursor:pointer; }
    .cdl-op-check input { margin-top:2px; accent-color:var(--cdl-accent); width:15px; height:15px; flex-shrink:0; }
    .cdl-op-check .t { color:var(--cdl-text); font-size:12.5px; }
    .cdl-op-check .d { color:var(--cdl-faint); font-size:11px; }
    .cdl-op-field { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .cdl-op-field label { color:var(--cdl-text); font-size:12.5px; }
    #cdl-opts-panel select, #cdl-opts-panel input[type="number"] {
      background:var(--cdl-header-bg); color:var(--cdl-text); border:1px solid var(--cdl-border);
      border-radius:7px; padding:5px 8px; font-size:12.5px; }
    .cdl-op-scope { display:flex; flex-direction:column; gap:7px; }
    .cdl-op-scope label { display:flex; align-items:center; gap:8px; color:var(--cdl-text); font-size:12.5px; cursor:pointer; }
    .cdl-op-scope input[type="radio"] { accent-color:var(--cdl-accent); }
    .cdl-op-scope input[type="number"] { width:64px; }
    .cdl-op-range { display:flex; align-items:center; gap:6px; color:var(--cdl-muted); }
    .cdl-op-estimate { font-size:12px; color:var(--cdl-muted); background:var(--cdl-header-bg);
      border:1px solid var(--cdl-border-soft); border-radius:8px; padding:8px 10px; }
    .cdl-op-foot { display:flex; align-items:center; justify-content:space-between; gap:8px;
      padding:12px 16px; border-top:1px solid var(--cdl-border-soft); }
    .cdl-op-btn { border-radius:8px; padding:8px 16px; font-size:12.5px; font-weight:600; cursor:pointer; border:1px solid var(--cdl-border); background:transparent; color:var(--cdl-text); }
    .cdl-op-btn:hover { background:var(--cdl-hover); }
    .cdl-op-btn.primary { background:var(--cdl-accent); border-color:var(--cdl-accent); color:var(--accent-ink, #07101f); }
    .cdl-op-btn.primary:hover { filter:brightness(1.08); }
    .cdl-op-btn:disabled { opacity:.45; cursor:default; }
  `;
  document.head.appendChild(style);
}

async function showDownloadAllOptionsPanel(mangaName, rows) {
  injectOptsStyles();
  const meta = scrapeSeriesMeta();
  const [prefs, downloaded] = await Promise.all([getSeriesPrefs(), getDownloadedKeySet()]);

  // Defaults: settings, overlaid with this series' remembered choices.
  const def = {
    format: prefs.format || CFG['output.format'] || 'zip',
    includeComicInfo: prefs.includeComicInfo != null ? prefs.includeComicInfo : (CFG['output.includeComicInfo'] !== false),
    includeSeriesMeta: prefs.includeSeriesMeta != null ? prefs.includeSeriesMeta : !!CFG['output.includeSeriesMeta'],
    folderLayout: prefs.folderLayout || CFG['output.folderLayout'] || 'default',
  };

  // ── Translator / group filter ──────────────────────────────────────────────
  // `rows` holds one entry per chapter PER group; for a given group we collapse
  // to one chapter per number (newest upload first), ascending. "All groups"
  // collapses across every group — the original (single-source-per-chapter) set.
  const GROUP_ALL = '__all';
  const dedupeByLabel = (rs) => {
    const seen = new Set(); const out = [];
    for (const r of rs) { if (!seen.has(r.chapterLabel)) { seen.add(r.chapterLabel); out.push(r); } }
    return out.sort((a, b) => parseFloat(a.chapterLabel.replace(/[^0-9.]/g, '')) - parseFloat(b.chapterLabel.replace(/[^0-9.]/g, '')));
  };
  const groupTally = new Map();
  rows.forEach((r) => { const g = r.group || 'Unknown group'; if (!groupTally.has(g)) groupTally.set(g, new Set()); groupTally.get(g).add(r.chapterLabel); });
  const groupList = [...groupTally.entries()].map(([name, set]) => ({ name, count: set.size }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const hasGroups = groupList.length > 1;
  const baseFor = (g) => (g === GROUP_ALL) ? dedupeByLabel(rows) : dedupeByLabel(rows.filter((r) => (r.group || 'Unknown group') === g));

  let currentGroup = GROUP_ALL;
  let chapters = baseFor(currentGroup);
  const newCountOf = (set) => set.filter((c) => !downloaded.has(chapterKeyOf(c.chapterLabel))).length;
  let newCount = newCountOf(chapters);
  const hasManifest = downloaded.size > 0;
  const defaultScope = (CFG['download.skipDownloaded'] !== false && newCount > 0 && newCount < chapters.length) ? 'new' : 'all';

  const backdrop = document.createElement('div');
  backdrop.id = 'cdl-opts-backdrop';
  const panel = document.createElement('div');
  panel.id = 'cdl-opts-panel';
  panel.setAttribute('data-cdl-theme', _cdlDetectSiteTheme());

  _setHTML(panel, `
    <div class="cdl-op-head">
      <div class="cdl-op-title">${ICON_DOWNLOAD}&nbsp;Download options</div>
      <button class="cdl-op-close" id="cdl-op-close" title="Cancel">×</button>
    </div>
    <div class="cdl-op-body">
      <div class="cdl-ap-manga-name" style="color:var(--cdl-muted);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(mangaName)}</div>
      <div>
        <div class="cdl-op-sec-label">Format</div>
        <div class="cdl-op-cards">
          <div class="cdl-op-card" data-fmt="zip"><div class="t">ZIP</div><div class="d">Plain folders of images.</div></div>
          <div class="cdl-op-card" data-fmt="cbz"><div class="t">CBZ</div><div class="d">One comic file per chapter — opens in Komga, Kavita, Mihon, YACReader…</div></div>
        </div>
      </div>
      <label class="cdl-op-check"><input type="checkbox" id="cdl-op-comicinfo"><span><span class="t">Include ComicInfo.xml</span><br><span class="d">Series, number, tags — so library servers index each chapter.</span></span></label>
      <label class="cdl-op-check"><input type="checkbox" id="cdl-op-meta"><span><span class="t">Include series info</span><br><span class="d">Save the cover image and series details (cover.jpg + series.json).</span></span></label>
      <div class="cdl-op-field">
        <label for="cdl-op-layout">Folder layout</label>
        <select id="cdl-op-layout">
          <option value="default">Default (Ch0001)</option>
          <option value="kavita">Kavita / Komga (Series / Series - Chapter 0001)</option>
        </select>
      </div>
      ${hasGroups ? `
      <div class="cdl-op-field">
        <label for="cdl-op-group">Translator / group</label>
        <select id="cdl-op-group">
          <option value="${GROUP_ALL}">All groups (${dedupeByLabel(rows).length})</option>
          ${groupList.map((g) => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)} (${g.count})</option>`).join('')}
        </select>
      </div>` : ''}
      <div>
        <div class="cdl-op-sec-label">Which chapters</div>
        <div class="cdl-op-scope">
          <label><input type="radio" name="cdl-op-scope" value="all"> All chapters (<span id="cdl-op-all-n">${chapters.length}</span>)</label>
          <label><input type="radio" name="cdl-op-scope" value="new"${newCount === 0 ? ' disabled' : ''}> Only new — not yet downloaded (<span id="cdl-op-new-n">${newCount}</span>)</label>
          <label><input type="radio" name="cdl-op-scope" value="range"> <span class="cdl-op-range">Range&nbsp;<input type="number" id="cdl-op-from" min="1" max="${chapters.length}" value="1">to<input type="number" id="cdl-op-to" min="1" max="${chapters.length}" value="${chapters.length}"></span></label>
        </div>
      </div>
      <div class="cdl-op-estimate" id="cdl-op-estimate"></div>
      <label class="cdl-op-check"><input type="checkbox" id="cdl-op-remember"><span class="t">Remember these choices for this series</span></label>
    </div>
    <div class="cdl-op-foot">
      <button class="cdl-op-btn" id="cdl-op-export" title="Save the chapter list + series info as JSON, without downloading images">Export list</button>
      <div style="display:flex;gap:8px;">
        <button class="cdl-op-btn" id="cdl-op-cancel">Cancel</button>
        <button class="cdl-op-btn primary" id="cdl-op-start">Start download</button>
      </div>
    </div>`);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  // ── State + wiring ──
  let format = def.format;
  const q = (id) => panel.querySelector(id);
  const cards = [...panel.querySelectorAll('.cdl-op-card')];
  const selectFormat = (f) => { format = f; cards.forEach((c) => c.classList.toggle('sel', c.dataset.fmt === f)); };
  cards.forEach((c) => c.addEventListener('click', () => { selectFormat(c.dataset.fmt); updateEstimate(); }));
  selectFormat(format);
  q('#cdl-op-comicinfo').checked = def.includeComicInfo;
  q('#cdl-op-meta').checked = def.includeSeriesMeta;
  q('#cdl-op-layout').value = def.folderLayout;
  const scopeRadio = (v) => panel.querySelector(`input[name="cdl-op-scope"][value="${v}"]`);
  scopeRadio(defaultScope).checked = true;

  const currentScope = () => (panel.querySelector('input[name="cdl-op-scope"]:checked') || {}).value || 'all';
  const clampInt = (v, lo, hi, d) => { v = parseInt(v, 10); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const selectedChapters = () => {
    const scope = currentScope();
    if (scope === 'new') return chapters.filter((c) => !downloaded.has(chapterKeyOf(c.chapterLabel)));
    if (scope === 'range') {
      let a = clampInt(q('#cdl-op-from').value, 1, chapters.length, 1);
      let b = clampInt(q('#cdl-op-to').value, 1, chapters.length, chapters.length);
      if (a > b) { const t = a; a = b; b = t; }
      return chapters.slice(a - 1, b);
    }
    return chapters.slice();
  };
  // Tell the user up front when finished CBZ files will also go to their server.
  let libPushEnabled = false;
  try {
    chrome.storage.local.get('cdlLibrary', (res) => {
      const c = res && res.cdlLibrary;
      libPushEnabled = !!(c && c.enabled && /^https?:\/\//i.test(c.endpoint || ''));
      if (libPushEnabled) updateEstimate();
    });
  } catch (_) {}
  const updateEstimate = () => {
    const n = selectedChapters().length;
    const mb = Math.max(1, Math.round(n * 6)); // ~6 MB/chapter, very rough
    const lib = (format === 'cbz' && libPushEnabled) ? ' · each CBZ will also be pushed to your library server' : '';
    q('#cdl-op-estimate').textContent = `${n} chapter${n === 1 ? '' : 's'} selected · rough estimate ~${mb} MB (varies a lot by title)${lib}`;
    q('#cdl-op-start').disabled = n === 0;
  };
  panel.querySelectorAll('input[name="cdl-op-scope"], #cdl-op-from, #cdl-op-to')
    .forEach((el) => el.addEventListener('input', updateEstimate));
  updateEstimate();

  // Switching translator rebuilds the active chapter set and its counts.
  if (hasGroups) {
    const groupSel = q('#cdl-op-group');
    groupSel.value = GROUP_ALL;
    groupSel.addEventListener('change', () => {
      currentGroup = groupSel.value;
      chapters = baseFor(currentGroup);
      newCount = newCountOf(chapters);
      q('#cdl-op-all-n').textContent = String(chapters.length);
      q('#cdl-op-new-n').textContent = String(newCount);
      const newRadio = scopeRadio('new');
      if (newRadio) {
        newRadio.disabled = newCount === 0;
        if (newCount === 0 && currentScope() === 'new') scopeRadio('all').checked = true;
      }
      const fromI = q('#cdl-op-from'); const toI = q('#cdl-op-to');
      fromI.max = String(chapters.length); toI.max = String(chapters.length);
      toI.value = String(chapters.length);
      if (parseInt(fromI.value, 10) > chapters.length) fromI.value = '1';
      updateEstimate();
    });
  }

  const close = () => backdrop.remove();
  q('#cdl-op-close').addEventListener('click', close);
  q('#cdl-op-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  const buildOptions = () => ({
    format,
    includeComicInfo: q('#cdl-op-comicinfo').checked,
    includeSeriesMeta: q('#cdl-op-meta').checked,
    folderLayout: q('#cdl-op-layout').value,
    slug: meta.slug || '',
    seriesMeta: meta,
    totalCount: chapters.length,
  });

  q('#cdl-op-start').addEventListener('click', () => {
    const subset = selectedChapters();
    if (!subset.length) return;
    const options = buildOptions();
    if (q('#cdl-op-remember').checked) {
      saveSeriesPrefs({ format: options.format, includeComicInfo: options.includeComicInfo,
        includeSeriesMeta: options.includeSeriesMeta, folderLayout: options.folderLayout });
    }
    const zipName = buildAllZipName(mangaName);
    _lastDlAllParams = { chapters: subset, mangaName, zipName, options };
    close();
    showDownloadAllPopup(mangaName, subset.length);
    _launchDownloadAll();
  });

  q('#cdl-op-export').addEventListener('click', () => {
    exportChapterList(mangaName, selectedChapters(), meta);
    close();
  });
}

// Export-only: save the selected chapter list + scraped series metadata as JSON,
// without downloading any images. Triggered from the options panel.
function exportChapterList(mangaName, chapters, meta) {
  try {
    const payload = {
      __comix: 'export', version: 1, exportedAt: new Date().toISOString(),
      series: meta, chapters: chapters.map((c) => ({ label: c.chapterLabel, url: c.chapterUrl })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slugify(mangaName) || 'comix'}-chapters.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (_) {}
}

function showDownloadAllPopup(mangaName, totalChapters, options = {}) {
  const allowFullRetry = options.allowFullRetry !== false;
  document.getElementById('cdl-all-popup')?.remove();

  const popup = document.createElement('div');
  popup.id = 'cdl-all-popup';
  popup.setAttribute('data-cdl-theme', _cdlDetectSiteTheme());
  _setHTML(popup, `
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
    </div>`);
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
  // `completed` (chapters finished: done/skipped/error) drives a monotonic bar +
  // counter, so it never jumps backwards when several chapters run at once. Older
  // background builds didn't send it — fall back to the single-chapter formula.
  const completed = (typeof msg.completed === 'number')
    ? msg.completed
    : Math.max(0, (chapterIndex || 0) - 1);
  const concurrency = msg.concurrency || 1;
  const pct = totalChapters > 0 ? Math.round(completed / totalChapters * 100) : 0;
  const counterText = `${completed} / ${totalChapters || 0} chapters`;
  // With >1 chapter in flight the per-chapter log rows carry the live detail, so
  // the single headline/sub-line show a stable overall summary instead of flipping
  // between the concurrent chapters.
  const headline = concurrency > 1
    ? `Downloading ${totalChapters} chapters (${concurrency} at a time)…`
    : null;
  const overall = `${completed} / ${totalChapters} chapters done`;

  if (phase === 'preparing') {
    el('cdl-ap-chapter-status').textContent = 'Preparing...';
    el('cdl-ap-img-status').textContent     = 'Starting...';
    el('cdl-ap-bar').style.width            = '0%';
    el('cdl-ap-counter').textContent        = `0 / ${totalChapters || 0} chapters`;

  } else if (phase === 'cancelling') {
    el('cdl-ap-chapter-status').textContent = 'Cancelling...';
    el('cdl-ap-img-status').textContent     = 'Stopping after the current step...';

  } else if (phase === 'extracting') {
    el('cdl-ap-chapter-status').textContent = headline || `Chapter ${chapterIndex} / ${totalChapters} — ${chapterLabel}`;
    el('cdl-ap-img-status').textContent     = headline ? overall : 'Opening chapter…';
    el('cdl-ap-bar').style.width            = `${pct}%`;
    el('cdl-ap-counter').textContent        = counterText;
    _dlAllAddLog(chapterLabel, 'active', `⟳ ${chapterLabel} — opening…`);

  } else if (phase === 'downloading') {
    el('cdl-ap-chapter-status').textContent = headline || `Chapter ${chapterIndex} / ${totalChapters} — ${chapterLabel}`;
    el('cdl-ap-img-status').textContent     = headline ? overall : `Images : ${imagesDone} / ${imagesTotal}`;
    el('cdl-ap-bar').style.width            = `${pct}%`;
    el('cdl-ap-counter').textContent        = counterText;
    _dlAllAddLog(chapterLabel, 'active', `⟳ ${chapterLabel} — ${imagesDone}/${imagesTotal} images`);

  } else if (phase === 'done') {
    el('cdl-ap-bar').style.width     = `${pct}%`;
    el('cdl-ap-counter').textContent = counterText;
    if (headline) el('cdl-ap-img-status').textContent = overall;
    _dlAllAddLog(chapterLabel, 'done', `✓ ${chapterLabel} (${imagesDone} images)`);

  } else if (phase === 'error') {
    el('cdl-ap-bar').style.width     = `${pct}%`;
    el('cdl-ap-counter').textContent = counterText;
    _dlAllAddLog(chapterLabel, 'error', `✗ ${chapterLabel} — failed`);

  } else if (phase === 'skipped') {
    el('cdl-ap-bar').style.width     = `${pct}%`;
    el('cdl-ap-counter').textContent = counterText;
    _dlAllAddLog(chapterLabel, 'skipped', `— ${chapterLabel} — skipped`);

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

// ── Subscribe toggle (watch this series for new chapters) ─────────────────────
function _cdlSlug() { return (location.pathname.match(/\/title\/([^/]+)/) || [])[1] || ''; }

// Small transient toast at the bottom of the page (subscribe feedback, etc.).
let _cdlToastTimer = null;
function cdlToast(msg) {
  let t = document.getElementById('cdl-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'cdl-toast';
    t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;'
      + 'background:rgba(17,19,28,.95);color:#e6e9f2;padding:9px 16px;border-radius:10px;'
      + 'font:600 13px system-ui,-apple-system,sans-serif;border:1px solid rgba(255,255,255,.14);'
      + 'box-shadow:0 8px 28px rgba(0,0,0,.45);pointer-events:none;opacity:0;transition:opacity .2s;'
      + 'max-width:88vw;text-align:center;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  requestAnimationFrame(() => { t.style.opacity = '1'; });
  clearTimeout(_cdlToastTimer);
  _cdlToastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2600);
}

function injectSubscribeButton() {
  if (document.querySelector('.cdl-sub-btn')) return;
  const allBtn = document.querySelector('.cdl-dl-all-btn:not(.cdl-sub-btn)');
  if (!allBtn) return; // appears next to Download All; the observer re-runs the scan
  // The floating FAB (mobile fallback) sits alone at body level — a second
  // unpositioned button there would render broken. Skip it in that mode.
  if (allBtn.classList.contains('cdl-floating')) return;
  const slug = _cdlSlug();
  if (!slug) return;

  const btn = document.createElement('button');
  btn.className = 'btn btn--soft mpage__follow-btn cdl-dl-all-btn cdl-sub-btn';
  btn.type = 'button';
  const render = (subscribed) => {
    btn.dataset.sub = subscribed ? '1' : '0';
    btn.textContent = subscribed ? '★ Subscribed' : '☆ Subscribe';
    btn.title = subscribed
      ? 'Watching this series for new chapters — click to stop'
      : 'Watch this series for new chapters (background checks + notifications)';
  };
  render(false);
  try {
    chrome.storage.local.get('cdlSubscriptions', (res) => {
      render(!!(res && res.cdlSubscriptions && res.cdlSubscriptions[slug]));
    });
  } catch (_) {}

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!chrome?.runtime?.id) return;
    const subscribed = btn.dataset.sub === '1';
    render(!subscribed); // optimistic
    try {
      chrome.runtime.sendMessage(
        subscribed ? { action: 'unsubscribe', slug } : { action: 'subscribe', slug, mangaName: getMangaName() },
        () => {
          if (chrome.runtime.lastError) { render(subscribed); cdlToast('Could not update the subscription — try again'); return; }
          if (subscribed) { cdlToast('Unsubscribed — no more checks for this series'); return; }
          const mins = parseInt(CFG['subscribe.intervalMinutes'], 10) || 360;
          const every = mins >= 60 ? `${Math.round((mins / 60) * 10) / 10}h` : `${mins}min`;
          cdlToast(`Subscribed — checking every ${every} for new chapters`);
        }
      );
    } catch (_) { render(subscribed); }
  });

  allBtn.insertAdjacentElement('afterend', btn);
}

function scanAndInject() {
  // Chercher tous les boutons bookmark existants
  const bookmarkBtns = document.querySelectorAll('.mchap-bookmark, [class*="mchap-bookmark"]');
  bookmarkBtns.forEach(injectButtonForRow);
  injectDownloadAllButton();
  injectSubscribeButton();
  markDownloadedButtons();
}

let _cdlBodyObserver = null;
function observeDOM() {
  if (_cdlBodyObserver) return; // already watching — keep a single observer
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
  _cdlBodyObserver = observer;
}
function disconnectDOM() {
  if (_cdlBodyObserver) { _cdlBodyObserver.disconnect(); _cdlBodyObserver = null; }
}

// ── Point d'entrée ────────────────────────────────────────────────────────────

// Are we on a title *overview* page (chapter list), as opposed to a chapter
// reader (/title/{slug}/{numericId}) or any other comix page? The download
// buttons only belong on the overview. URL format chapitre : /title/{slug}/{id}.
function isTitleOverviewPage() {
  const p = location.pathname.split('/').filter(Boolean);
  if (p[0] !== 'title' || !p[1]) return false;       // not a /title/{slug} page
  if (p.length >= 3 && /^\d+/.test(p[2])) return false; // chapter reader
  return true;
}

// Inject (or tear down) the title-page UI for the current route. Idempotent:
// the inject* helpers no-op when their target already exists, and observeDOM()
// keeps a single observer, so this is safe to call repeatedly.
function cdlSyncRoute() {
  if (isTitleOverviewPage()) {
    injectStyles();
    applyDynamicStyles();
    scanAndInject();
    observeDOM();
    restoreDownloadAllPopupFromBackground();
  } else {
    // Left the overview (reader/home/settings/search/…). The injected nodes vanish
    // with the old DOM that Next.js replaces, so just stop observing — but DO remove
    // our injected <style>s: their `.cdl-btn` rules would otherwise restyle the
    // embedded settings page's Export/Import/Reset buttons (same class).
    disconnectDOM();
    ['cdl-styles', 'cdl-dyn-styles'].forEach((id) => document.getElementById(id)?.remove());
  }
}

(async function init() {
  if (typeof CDLSettings !== 'undefined') {
    try { CFG = await CDLSettings.getSettings(); } catch (_) {}
    CDLSettings.onChange((next) => { CFG = next; onSettingsChanged(); });
  }

  // Styles are injected per-route by cdlSyncRoute() (title pages only) so they never
  // leak onto other comix pages such as the embedded settings UI.

  // Refresh the "already-downloaded" dots when the manifest changes (e.g. after a run).
  try {
    if (chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.cdlManifest && isTitleOverviewPage()) markDownloadedButtons();
      });
    }
  } catch (_) {}

  // SPA-aware lifecycle. comix's MAIN-world bridge (scripts/extract-bridge.js) emits
  // `cdl:locationchange` on every pushState/replaceState — Next fires those often with
  // the SAME path (shallow updates), so only re-sync when the path actually changes.
  // (In-page DOM swaps that keep the path are still caught by the MutationObserver.)
  let _cdlLastPath = location.pathname;
  const onRouteChange = () => {
    if (location.pathname === _cdlLastPath) return;
    _cdlLastPath = location.pathname;
    cdlSyncRoute();
  };
  window.addEventListener('cdl:locationchange', onRouteChange);
  window.addEventListener('popstate', onRouteChange);
  window.addEventListener('hashchange', onRouteChange);
  window.addEventListener('pageshow', (e) => { if (e.persisted) cdlSyncRoute(); });

  cdlSyncRoute();
})();
