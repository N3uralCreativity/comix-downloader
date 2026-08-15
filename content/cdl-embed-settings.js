/**
 * cdl-embed-settings.js — adds the extension's settings natively into comix.to's
 * own settings page (comix.to/user?tab=settings).
 *
 * It injects a "Comix Downloader" entry into comix's left settings menu and, when
 * selected, renders the extension's settings INTO comix's content area using
 * comix's own markup/classes (usettings__section / usettings__row / usettings__
 * switch) so booleans look 100% native, with comix-themed sliders / selects /
 * inputs for the richer settings comix itself doesn't have. Naming templates get
 * a live preview, and the Sync section includes Push-to-library + Subscriptions
 * (which live under their own storage keys, not the settings schema). Changes
 * save instantly (like comix), straight to chrome.storage. The standalone
 * options.html page keeps working independently.
 */
(function () {
  'use strict';
  if (window.top !== window) return;
  var S = (typeof CDLSettings !== 'undefined') ? CDLSettings : (typeof globalThis !== 'undefined' && globalThis.CDLSettings);
  if (!S) return;

  var NAV_ID = 'cdl-nav-item';
  var VIEW_ID = 'cdl-uview';
  var STYLE_ID = 'cdl-embed-style';
  var FALLBACK_ID = 'cdl-settings-fallback';
  var OUTRO_ID = 'cdl-settings-outro';
  var OUTRO_MEDIA = [
    { file: 'dance-tina.gif', className: 'cdl-dancer--tina' },
    { file: 'dance-stick.gif', className: 'cdl-dancer--stick' },
    { file: 'dance-cat.gif', className: 'cdl-dancer--cat' },
    { file: 'dance-yellow.gif', className: 'cdl-dancer--yellow' },
    { file: 'dance-man.gif', className: 'cdl-dancer--man' },
    { file: 'dance-shaggy.gif', className: 'cdl-dancer--shaggy' },
    { file: 'dance-flamingo.gif', className: 'cdl-dancer--flamingo' },
  ];
  var hiddenComixView = null;
  var pollTimer = null;
  var observer = null;
  var autoChecked = false;
  var savedToast = null, savedTimer = null;
  var outroController = null;
  var outroAudio = null;
  // Scroll persistence: keep the reader's scroll position while our panel is open, across
  // comix's React re-renders (which wipe + re-inject our panel) and across page refreshes.
  var OPEN_KEY = 'cdlExtSettingsOpen';   // sessionStorage flag: our panel is open
  var SCROLL_KEY = 'cdlExtSettingsScroll'; // sessionStorage: last window.scrollY while open
  var scrollSaveTimer = null, scrollTracking = false;
  var fallbackTracked = false;
  var fallbackDeadline = 0;
  var fallbackMonitorTimer = null;
  var embeddedUpdateRefresh = null;

  // Sample context for live naming-template previews (mirrors the options page).
  var PREVIEW_CTX = {
    'naming.chapterFolderFmt': { num: '12', rest: '', chapter: '12', manga: 'Solo Leveling' },
    'naming.cbzFileTpl': { entry: 'Ch0012', manga: 'Solo Leveling', chapter: '12', label: 'Ch12', num: '12', rest: '', scanlator: 'Flame Comics', groupId: '42', language: 'en' },
    'naming.singleZipTpl': { manga: 'Solo Leveling', chapter: '12', label: 'Ch12', num: '12', scanlator: 'Flame Comics', groupId: '42' },
    'naming.allZipTpl': { manga: 'Solo Leveling' },
  };

  // Conditional controls — greyed out when their condition isn't met (mirrors the
  // standalone options page so irrelevant settings don't mislead).
  var DEPENDS = {
    'download.chaptersPerPart': function (d) { return d['download.splitMode'] === 'multipart'; },
    'download.cbzChaptersPerPart': function (d) { return d['download.splitMode'] === 'multipart'; },
    'download.pdfChaptersPerPart': function (d) { return d['download.splitMode'] === 'multipart'; },
    'download.mbPerPart': function (d) { return d['download.splitMode'] === 'multipart'; },
    'perf.rateBaseMs': function (d) { return d['perf.rateLimitMode'] !== 'off'; },
    'perf.rateMinMs': function (d) { return d['perf.rateLimitMode'] === 'dynamic'; },
    'perf.rateMaxMs': function (d) { return d['perf.rateLimitMode'] === 'dynamic'; },
    'appearance.accentColor': function (d) { return d['appearance.accentMode'] === 'custom'; },
    'advanced.jpgQuality': function (d) { return d['advanced.imageFormat'] === 'jpg'; },
    'subscribe.intervalMinutes': function (d) { return !!d['subscribe.enabled']; },
    'subscribe.notify': function (d) { return !!d['subscribe.enabled']; },
    'subscribe.autoDownload': function (d) { return !!d['subscribe.enabled']; },
    // Home sub-settings only matter when the custom Home is on; hero source/skip only when a hero shows.
    'home.sections': function (d) { return !!d['home.customLayout']; },
    'home.hero': function (d) { return !!d['home.customLayout']; },
    'home.heroSource': function (d) { return !!d['home.customLayout'] && d['home.hero'] !== 'off'; },
    'home.heroSkipRead': function (d) { return !!d['home.customLayout'] && d['home.hero'] !== 'off'; },
    'home.cardStyle': function (d) { return !!d['home.customLayout']; },
    'home.rows': function (d) { return !!d['home.customLayout']; },
    'home.density': function (d) { return !!d['home.customLayout']; },
    'home.showProgress': function (d) { return !!d['home.customLayout']; },
    'home.itemsPerSection': function (d) { return !!d['home.customLayout']; },
    'home.openInNewTab': function (d) { return !!d['home.customLayout']; },
    'home.greeting': function (d) { return !!d['home.customLayout']; },
    'home.hoverPreview': function (d) { return !!d['home.customLayout']; },
  };

  // ── helpers ──────────────────────────────────────────────────────────────
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else n.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function svg(paths, size) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('width', size || 16); s.setAttribute('height', size || 16);
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    paths.forEach(function (d) { var p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); s.appendChild(p); });
    return s;
  }
  // The "Angle Tray" brand mark (icons/icon.svg), filled with currentColor.
  function markSvg(size) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('width', size || 16); s.setAttribute('height', size || 16);
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'currentColor');
    s.setAttribute('aria-hidden', 'true');
    var g = document.createElementNS(ns, 'polygon');
    g.setAttribute('points', '10,2.6 14,2.6 14,8.6 18.8,8.6 12,15.8 5.2,8.6 10,8.6');
    s.appendChild(g);
    var t = document.createElementNS(ns, 'path');
    t.setAttribute('d', 'M3 16.8 6.2 20h11.6l3.2-3.2v4.8H3z');
    s.appendChild(t);
    return s;
  }
  function getLocal(key) {
    return new Promise(function (res) { try { chrome.storage.local.get(key, function (r) { res((r && r[key]) || null); }); } catch (_) { res(null); } });
  }
  function setLocal(key, val) { var o = {}; o[key] = val; try { chrome.storage.local.set(o); } catch (_) {} }
  function send(msg) { return new Promise(function (res) { try { chrome.runtime.sendMessage(msg, function (r) { res(chrome.runtime.lastError ? null : r); }); } catch (_) { res(null); } }); }
  function i18n(name, fallback, substitutions) {
    try { return chrome.i18n.getMessage(name, substitutions) || fallback; }
    catch (_) { return fallback; }
  }
  function extensionAsset(name) {
    try { return chrome.runtime.getURL('assets/settings-outro/' + name); }
    catch (_) { return ''; }
  }

  function outroProximity(distance, startAt, fullAt) {
    var span = Math.max(1, startAt - fullAt);
    return Math.max(0, Math.min(1, (startAt - distance) / span));
  }

  // Settings save instantly (like comix's own toggles); flash a brief confirmation.
  function flashSaved(msg) {
    try {
      if (!savedToast || !savedToast.isConnected) { savedToast = el('div', { id: 'cdl-saved-toast' }); (document.body || document.documentElement).appendChild(savedToast); }
      savedToast.textContent = msg || '✓ Saved';
      savedToast.classList.remove('show'); void savedToast.offsetWidth; savedToast.classList.add('show');
      clearTimeout(savedTimer);
      savedTimer = setTimeout(function () { if (savedToast) savedToast.classList.remove('show'); }, 1400);
    } catch (_) {}
  }

  function onSettingsPage() {
    if (document.querySelector('.usettings__section') || document.getElementById(VIEW_ID)) return true;
    return /\/user(?:\/|$)/.test(location.pathname) && /(?:^|[?&])tab=settings(?:&|$)/.test(location.search);
  }

  function removeSettingsFallback() {
    var host = document.getElementById(FALLBACK_ID);
    if (host) host.remove();
  }

  function stopFallbackMonitor() {
    if (fallbackMonitorTimer) clearTimeout(fallbackMonitorTimer);
    fallbackMonitorTimer = null;
  }

  function finishSettingsNavigationAttempt() {
    fallbackTracked = false;
    stopFallbackMonitor();
    removeSettingsFallback();
    send({ action: 'cdlCompleteSettingsNavigation' });
  }

  function dismissSettingsFallback() {
    fallbackTracked = false;
    stopFallbackMonitor();
    removeSettingsFallback();
    send({ action: 'cdlDismissSettingsFallback' });
  }

  function showSettingsFallback(reason) {
    if (document.getElementById(FALLBACK_ID)) return;
    stopFallbackMonitor();

    var host = el('div', { id: FALLBACK_ID });
    var shadow = host.attachShadow({ mode: 'open' });
    var style = el('style', { text:
      ':host{all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;width:min(420px,calc(100vw - 24px));color-scheme:dark;}' +
      '*,*::before,*::after{box-sizing:border-box;letter-spacing:0;}' +
      '.card{overflow:hidden;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:#202428;color:#f5f7fa;' +
        'box-shadow:0 24px 64px rgba(0,0,0,.52);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}' +
      '.head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 14px;border-bottom:1px solid rgba(255,255,255,.1);background:#292e33;}' +
      '.brand{min-width:0;display:flex;align-items:center;gap:10px;}' +
      '.mark{display:grid;place-items:center;width:32px;height:32px;flex:0 0 32px;border:1px solid rgba(103,232,249,.32);border-radius:6px;background:rgba(103,232,249,.1);color:#67e8f9;}' +
      '.brand-name,.brand-source{display:block;}' +
      '.brand-name{overflow:hidden;color:#fff;font-size:13px;font-weight:700;line-height:1.2;text-overflow:ellipsis;white-space:nowrap;}' +
      '.brand-source{margin-top:3px;color:#a5f3fc;font-size:10px;font-weight:700;line-height:1.2;text-transform:uppercase;}' +
      'button{font:inherit;letter-spacing:0;}' +
      '.close{display:grid;place-items:center;width:30px;height:30px;flex:0 0 30px;padding:0;border:0;border-radius:6px;background:transparent;color:#aab2bc;cursor:pointer;}' +
      '.close:hover{background:rgba(255,255,255,.08);color:#fff;}' +
      '.body{padding:16px;}' +
      '.warning{display:flex;align-items:flex-start;gap:11px;}' +
      '.warning-icon{display:grid;place-items:center;width:30px;height:30px;flex:0 0 30px;border:1px solid rgba(250,204,21,.32);border-radius:50%;background:rgba(250,204,21,.1);color:#facc15;}' +
      '.copy{min-width:0;}' +
      'h2{margin:0;color:#fff;font-size:15px;font-weight:700;line-height:1.3;}' +
      'p{margin:6px 0 0;color:#b9c0c9;font-size:12.5px;line-height:1.55;}' +
      '.actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:15px;}' +
      '.action{min-height:36px;padding:8px 13px;border:1px solid rgba(255,255,255,.14);border-radius:6px;background:#292e33;color:#e8ebef;font-weight:650;cursor:pointer;}' +
      '.action:hover{border-color:rgba(255,255,255,.26);background:#30363c;}' +
      '.action.primary{display:inline-flex;align-items:center;justify-content:center;gap:7px;border-color:#67e8f9;background:#67e8f9;color:#102126;}' +
      '.action.primary:hover{border-color:#a5f3fc;background:#a5f3fc;}' +
      '.action:disabled{opacity:.65;cursor:wait;}' +
      '.status{min-height:17px;margin-top:9px;color:#fca5a5;font-size:11.5px;text-align:right;}' +
      '@media(max-width:480px){:host{right:12px;bottom:12px;width:calc(100vw - 24px);}.actions{align-items:stretch;flex-direction:column-reverse}.action{width:100%;}.status{text-align:left;}}'
    });

    var closeBtn = el('button', { type: 'button', class: 'close', title: 'Dismiss', 'aria-label': 'Dismiss' }, [
      svg(['M18 6 6 18', 'M6 6l12 12'], 16)
    ]);
    var brand = el('div', { class: 'brand' }, [
      el('span', { class: 'mark' }, [markSvg(21)]),
      el('span', {}, [
        el('span', { class: 'brand-name', text: 'Comix Downloader' }),
        el('span', { class: 'brand-source', text: 'Extension settings fallback' })
      ])
    ]);
    var heading = el('h2', { text: 'Settings page unavailable' });
    var detail = reason === 'redirected'
      ? 'comix.to redirected this tab before its settings page could open.'
      : 'comix.to did not finish loading the page needed for the integrated settings.';
    var message = el('p', { text: detail + ' Your Comix Downloader settings are still available in a separate extension tab.' });
    var status = el('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
    var dismissBtn = el('button', { type: 'button', class: 'action', text: 'Dismiss' });
    var openLabel = el('span', { text: 'Open extension settings' });
    var openBtn = el('button', { type: 'button', class: 'action primary' }, [
      openLabel,
      svg(['M5 12h14', 'M13 6l6 6-6 6'], 15)
    ]);

    closeBtn.addEventListener('click', dismissSettingsFallback);
    dismissBtn.addEventListener('click', dismissSettingsFallback);
    openBtn.addEventListener('click', function () {
      openBtn.disabled = true;
      openLabel.textContent = 'Opening…';
      status.textContent = '';
      send({ action: 'cdlOpenStandaloneSettings' }).then(function (response) {
        if (response && response.ok) {
          fallbackTracked = false;
          removeSettingsFallback();
          return;
        }
        openBtn.disabled = false;
        openLabel.textContent = 'Open extension settings';
        status.textContent = 'Could not open the tab. Use your browser extension menu and choose Options.';
      });
    });

    var card = el('section', { class: 'card', role: 'alert', 'aria-labelledby': 'cdl-settings-fallback-title' }, [
      el('div', { class: 'head' }, [brand, closeBtn]),
      el('div', { class: 'body' }, [
        el('div', { class: 'warning' }, [
          el('span', { class: 'warning-icon' }, [svg(['M10.3 2.9 1.8 17.2A2 2 0 0 0 3.5 20h17a2 2 0 0 0 1.7-2.8L13.7 2.9a2 2 0 0 0-3.4 0Z', 'M12 8v5', 'M12 17h.01'], 17)]),
          el('div', { class: 'copy' }, [heading, message])
        ]),
        el('div', { class: 'actions' }, [dismissBtn, openBtn]),
        status
      ])
    ]);
    heading.id = 'cdl-settings-fallback-title';
    shadow.appendChild(style);
    shadow.appendChild(card);
    shadow.addEventListener('click', function (event) { event.stopPropagation(); });
    shadow.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
    (document.body || document.documentElement).appendChild(host);
  }

  function monitorSettingsNavigation() {
    if (!fallbackTracked) return;
    if (document.getElementById(VIEW_ID)) {
      finishSettingsNavigationAttempt();
      return;
    }
    if (!onSettingsPage()) {
      showSettingsFallback('redirected');
      return;
    }
    if (Date.now() >= fallbackDeadline) {
      showSettingsFallback('timeout');
      return;
    }
    fallbackMonitorTimer = setTimeout(monitorSettingsNavigation, 300);
  }

  function beginSettingsNavigationProbe() {
    var attempts = 0;
    var probe = function () {
      send({ action: 'cdlProbeSettingsNavigation' }).then(function (response) {
        if (response && response.tracked) {
          fallbackTracked = true;
          fallbackDeadline = Date.now() + 10000;
          monitorSettingsNavigation();
          return;
        }
        attempts++;
        if (attempts < 4) setTimeout(probe, 300);
      });
    };
    setTimeout(probe, 250);
  }

  function navList() { return document.querySelector('.umenu__list'); }
  function contentBox() { return document.querySelector('.user-content'); }
  function comixView() { return document.querySelector('.user-content > .uview:not(#' + VIEW_ID + ')'); }

  // ── styles for the controls comix doesn't ship (sliders/selects/inputs/etc.) ─
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = el('style', { id: STYLE_ID });
    s.textContent =
      '.cdl-umenu-sep{padding:14px 12px 6px;font:700 10px/1 var(--f-mono,monospace);letter-spacing:.08em;text-transform:uppercase;color:var(--text-3,#707070);}' +
      '#' + VIEW_ID + ' .cdl-row{cursor:default;}' +
      '#' + VIEW_ID + ' .cdl-disabled{opacity:.4;pointer-events:none;}' +
      '#' + VIEW_ID + ' .cdl-ctl{flex:0 0 auto;display:flex;align-items:center;gap:8px;}' +
      '#' + VIEW_ID + ' .cdl-input,#' + VIEW_ID + ' .cdl-select{background:var(--surface-2,#282c30);color:var(--text,#d4d4d4);' +
        'border:1px solid rgba(255,255,255,.10);border-radius:var(--radius,6px);padding:7px 10px;font-size:13px;font-family:inherit;outline:none;}' +
      '#' + VIEW_ID + ' .cdl-input:focus,#' + VIEW_ID + ' .cdl-select:focus{border-color:var(--accent,#8765eb);box-shadow:0 0 0 3px rgb(var(--accent-rgb,135 101 235) / .18);}' +
      '#' + VIEW_ID + ' .cdl-select{min-width:200px;cursor:pointer;}' +
      '#' + VIEW_ID + ' .cdl-input.num{width:104px;}' +
      '#' + VIEW_ID + ' .cdl-input.txt{min-width:240px;}' +
      '#' + VIEW_ID + ' .cdl-input.hex{width:88px;text-transform:uppercase;}' +
      '#' + VIEW_ID + ' .cdl-range{width:200px;accent-color:var(--accent,#8765eb);cursor:pointer;}' +
      '#' + VIEW_ID + ' .cdl-rangeval{min-width:46px;text-align:right;font-weight:600;color:var(--accent,#8765eb);font-variant-numeric:tabular-nums;}' +
      '#' + VIEW_ID + ' input[type=color].cdl-color{width:40px;height:30px;padding:2px;border:1px solid rgba(255,255,255,.12);border-radius:6px;background:var(--surface-2,#282c30);cursor:pointer;}' +
      '#' + VIEW_ID + ' .cdl-preview{margin-top:6px;font-size:12px;color:var(--text-2,#a0a0a0);font-family:var(--f-mono,monospace);}' +
      '#' + VIEW_ID + ' .cdl-badge{display:inline-block;margin-left:8px;font:700 9px/1.6 var(--f-mono,monospace);letter-spacing:.04em;text-transform:uppercase;padding:1px 6px;border-radius:5px;vertical-align:middle;}' +
      '#' + VIEW_ID + ' .cdl-badge.risky{color:#ef9a9a;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.32);}' +
      '#' + VIEW_ID + ' .cdl-badge.glitchy{color:#e6c071;background:rgba(234,179,8,.12);border:1px solid rgba(234,179,8,.34);}' +
      '#' + VIEW_ID + ' .cdl-warn{display:block;margin-top:6px;font-size:11.5px;line-height:1.45;color:var(--text-3,#8a8a8a);}' +
      '#' + VIEW_ID + ' .cdl-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px;}' +
      '#' + VIEW_ID + ' .cdl-btn{display:inline-flex;align-items:center;gap:7px;padding:8px 14px;border-radius:var(--radius,6px);' +
        'font-size:13px;font-weight:600;cursor:pointer;border:1px solid rgba(255,255,255,.12);background:var(--surface-2,#282c30);color:var(--text,#d4d4d4);}' +
      '#' + VIEW_ID + ' .cdl-btn.primary{background:var(--accent,#8765eb);border-color:var(--accent,#8765eb);color:var(--accent-ink,#1a1133);}' +
      '#' + VIEW_ID + ' .cdl-btn.danger{color:#ef9a9a;border-color:rgba(239,68,68,.32);background:rgba(239,68,68,.08);}' +
      '#' + VIEW_ID + ' .cdl-status{margin-top:4px;font-size:12px;color:var(--text-2,#a0a0a0);min-height:16px;}' +
      '#' + VIEW_ID + ' .cdl-settings-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;}' +
      '#' + VIEW_ID + ' .cdl-settings-head-copy{min-width:0;}' +
      '#' + VIEW_ID + ' .cdl-update-head-actions{display:flex;align-items:center;gap:9px;flex:0 0 auto;}' +
      '#' + VIEW_ID + ' .cdl-update-check.is-checking svg{animation:cdl-update-spin .85s linear infinite;}' +
      '#' + VIEW_ID + ' .cdl-update-check:disabled{opacity:.68;cursor:wait;}' +
      '#' + VIEW_ID + ' .cdl-update-check-status{font-size:11.5px;color:var(--text-3,#8a8a8a);max-width:190px;}' +
      '#' + VIEW_ID + ' .cdl-update-panel{display:grid;grid-template-columns:34px minmax(0,1fr) auto;align-items:center;gap:8px 12px;' +
        'margin:0 0 18px;padding:12px 14px;border:1px solid rgba(234,179,8,.3);border-radius:var(--radius,6px);background:rgba(234,179,8,.08);}' +
      '#' + VIEW_ID + ' .cdl-update-panel[hidden]{display:none;}' +
      '#' + VIEW_ID + ' .cdl-update-icon{grid-row:1 / span 2;width:32px;height:32px;display:grid;place-items:center;color:#eab308;' +
        'border:1px solid rgba(234,179,8,.32);border-radius:var(--radius,6px);background:var(--surface,#202326);}' +
      '#' + VIEW_ID + ' .cdl-update-copy{min-width:0;display:flex;flex-direction:column;}' +
      '#' + VIEW_ID + ' .cdl-update-title{font-size:13px;font-weight:700;color:var(--text-emphasis,#f5f5f5);}' +
      '#' + VIEW_ID + ' .cdl-update-message{font-size:12px;color:var(--text-2,#a0a0a0);}' +
      '#' + VIEW_ID + ' .cdl-update-action{grid-column:3;grid-row:1 / span 2;}' +
      '#' + VIEW_ID + ' .cdl-update-action-status{grid-column:2;min-height:15px;font-size:11px;color:#eab308;}' +
      '@keyframes cdl-update-spin{to{transform:rotate(360deg);}}' +
      '@media(max-width:700px){#' + VIEW_ID + ' .cdl-settings-head{flex-direction:column;}' +
        '#' + VIEW_ID + ' .cdl-update-head-actions{width:100%;flex-wrap:wrap;}' +
        '#' + VIEW_ID + ' .cdl-update-panel{grid-template-columns:32px minmax(0,1fr);}' +
        '#' + VIEW_ID + ' .cdl-update-action{grid-column:2;grid-row:auto;width:fit-content;}' +
        '#' + VIEW_ID + ' .cdl-update-action-status{grid-column:2;}}' +
      '#' + VIEW_ID + ' .cdl-sub-item{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid rgba(255,255,255,.06);}' +
      '#' + VIEW_ID + ' .cdl-sub-name{font-weight:600;color:var(--text,#d4d4d4);}' +
      '#' + VIEW_ID + ' .cdl-sub-meta{font-size:11.5px;color:var(--text-3,#8a8a8a);margin-left:auto;}' +
      '#' + VIEW_ID + ' .cdl-sub-x{background:none;border:none;color:var(--text-3,#8a8a8a);cursor:pointer;font-size:16px;line-height:1;padding:2px 6px;border-radius:6px;}' +
      '#' + VIEW_ID + ' .cdl-sub-x:hover{color:#ef9a9a;background:rgba(239,68,68,.1);}' +
      '#' + VIEW_ID + ' .cdl-foot{margin-top:8px;font-size:11.5px;color:var(--text-3,#8a8a8a);}' +
      // section picker (home.sections) — full-width reorderable list
      '#' + VIEW_ID + ' .cdl-row--block{display:block;}' +
      '#' + VIEW_ID + ' .cdl-seclist{margin-top:10px;display:flex;flex-direction:column;gap:6px;}' +
      '#' + VIEW_ID + ' .cdl-sec-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:var(--radius,6px);' +
        'background:var(--surface-2,#282c30);border:1px solid rgba(255,255,255,.08);opacity:.62;transition:opacity .14s,border-color .14s;}' +
      '#' + VIEW_ID + ' .cdl-sec-row.is-on{opacity:1;border-color:rgba(255,255,255,.16);}' +
      '#' + VIEW_ID + ' .cdl-sec-ord{display:flex;flex-direction:column;gap:2px;}' +
      '#' + VIEW_ID + ' .cdl-sec-move{width:22px;height:16px;display:flex;align-items:center;justify-content:center;cursor:pointer;' +
        'border:1px solid rgba(255,255,255,.12);border-radius:4px;background:var(--surface,#1f2226);color:var(--text-2,#a0a0a0);font-size:10px;line-height:1;padding:0;}' +
      '#' + VIEW_ID + ' .cdl-sec-move:hover:not(:disabled){color:var(--text-emphasis,#f5f5f5);border-color:var(--accent,#8765eb);}' +
      '#' + VIEW_ID + ' .cdl-sec-move:disabled{opacity:.3;cursor:default;}' +
      '#' + VIEW_ID + ' .cdl-sec-main{display:flex;align-items:center;gap:9px;cursor:pointer;flex:1;min-width:0;}' +
      '#' + VIEW_ID + ' .cdl-sec-name{font-size:13px;font-weight:600;color:var(--text,#d4d4d4);}' +
      // Final thank-you band: all supplied animations stay on one responsive row.
      '#' + VIEW_ID + ' .cdl-outro{position:relative;margin-top:18px;padding:34px 0 10px;border-top:1px solid rgba(255,255,255,.08);' +
        'overflow:hidden;opacity:.2;transform:translateY(12px);will-change:opacity,transform;}' +
      '#' + VIEW_ID + ' .cdl-outro-head{display:flex;align-items:center;justify-content:center;gap:10px;min-height:32px;}' +
      '#' + VIEW_ID + ' .cdl-outro-brand{display:flex;align-items:center;gap:9px;color:var(--accent,#8765eb);}' +
      '#' + VIEW_ID + ' .cdl-outro-title{margin:0;font-size:15px;font-weight:700;color:var(--text-emphasis,#f5f5f5);text-align:center;}' +
      '#' + VIEW_ID + ' .cdl-outro-media{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));' +
        'align-items:end;gap:clamp(1px,.55vw,8px);margin-top:18px;overflow:visible;pointer-events:none;}' +
      '#' + VIEW_ID + ' .cdl-outro-dancer{display:block;width:100%;height:auto;min-width:0;aspect-ratio:5/4;' +
        'object-fit:contain;object-position:center bottom;}' +
      '#' + VIEW_ID + ' .cdl-outro-audio{display:none;}' +
      '@media (prefers-reduced-motion:reduce){#' + VIEW_ID + ' .cdl-outro{opacity:1!important;transform:none!important;will-change:auto;}' +
        '#' + VIEW_ID + ' .cdl-outro-media{display:none;}#' + VIEW_ID + ' .cdl-update-check.is-checking svg{animation:none;}}' +
      '#cdl-saved-toast{position:fixed;left:50%;bottom:22px;transform:translate(-50%,8px);z-index:2147483647;' +
        'background:var(--surface-2,#282c30);color:var(--text-emphasis,#f5f5f5);border:1px solid rgba(255,255,255,.12);' +
        'border-radius:8px;padding:8px 16px;font:600 13px/1 system-ui,sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.45);' +
        'opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease;}' +
      '#cdl-saved-toast.show{opacity:1;transform:translate(-50%,0);}';
    (document.head || document.documentElement).appendChild(s);
  }

  // ── one schema-driven settings row, native comix markup ─────────────────────
  function makeRow(key, cur, onChange) {
    var sc = S.SCHEMA[key] || {};
    var type = sc.type || (typeof S.DEFAULTS[key] === 'boolean' ? 'bool' : 'string');
    var val = (key in cur) ? cur[key] : S.DEFAULTS[key];

    var title = el('span', { class: 'usettings__row-title', text: sc.label || key });
    if (sc.risk === 'risky' || sc.risk === 'glitchy') title.appendChild(el('span', { class: 'cdl-badge ' + sc.risk, text: sc.risk }));
    var body = el('span', { class: 'usettings__row-body' }, [title]);
    if (sc.help) body.appendChild(el('span', { class: 'usettings__row-hint', text: sc.help }));
    if (sc.warn) body.appendChild(el('span', { class: 'cdl-warn', text: sc.warn }));

    // Risky changes confirm first; on cancel the control reverts to `prior`.
    // (Glitchy settings keep their inline warning but save instantly.)
    var prior = val;
    var needsConfirm = sc.risk === 'risky' && !!sc.warn;
    var commit = function (raw) {
      var v = S.validateValue ? S.validateValue(key, raw) : raw;
      if (needsConfirm && String(v) !== String(prior) && !window.confirm(sc.warn + '\n\nApply this change?')) return;
      prior = v;
      try { onChange(key, v); } catch (_) {}
    };

    if (type === 'bool') {
      var cb = el('input', { type: 'checkbox' });
      cb.checked = !!val;
      var row = el('label', { class: 'usettings__row' + (val ? ' is-on' : '') }, [
        body,
        el('span', { class: 'usettings__switch', 'aria-hidden': 'true' }, [
          cb, el('span', { class: 'usettings__switch-track' }), el('span', { class: 'usettings__switch-thumb' }),
        ]),
      ]);
      cb.addEventListener('change', function () { commit(cb.checked); cb.checked = !!prior; row.classList.toggle('is-on', !!prior); });
      return row;
    }

    // Ordered, reorderable section picker (home.sections). Full-width list of toggle rows with
    // up/down reordering; commits the [{id,on}] array (patchSettings normalizes it).
    if (type === 'sectionList') {
      var labels = {}; (sc.sections || []).forEach(function (s) { labels[s.id] = s.label; });
      var items = (S.validateValue ? S.validateValue(key, val) : (val || [])).map(function (x) { return { id: x.id, on: !!x.on }; });
      var list = el('div', { class: 'cdl-seclist' });
      var commitList = function () { try { onChange(key, items.map(function (x) { return { id: x.id, on: !!x.on }; })); } catch (_) {} };
      var move = function (i, j) { if (j < 0 || j >= items.length) return; var t = items[i]; items[i] = items[j]; items[j] = t; commitList(); renderList(); };
      function renderList() {
        list.textContent = '';
        items.forEach(function (it, idx) {
          var cb = el('input', { type: 'checkbox' }); cb.checked = !!it.on;
          cb.addEventListener('change', function () { items[idx].on = cb.checked; row.classList.toggle('is-on', cb.checked); commitList(); });
          var up = el('button', { type: 'button', class: 'cdl-sec-move', title: 'Move up', text: '↑' });
          var dn = el('button', { type: 'button', class: 'cdl-sec-move', title: 'Move down', text: '↓' });
          up.disabled = idx === 0; dn.disabled = idx === items.length - 1;
          up.addEventListener('click', function () { move(idx, idx - 1); });
          dn.addEventListener('click', function () { move(idx, idx + 1); });
          var row = el('div', { class: 'cdl-sec-row' + (it.on ? ' is-on' : '') }, [
            el('span', { class: 'cdl-sec-ord' }, [up, dn]),
            el('label', { class: 'cdl-sec-main' }, [cb, el('span', { class: 'cdl-sec-name', text: labels[it.id] || it.id })]),
          ]);
          list.appendChild(row);
        });
      }
      renderList();
      return el('div', { class: 'usettings__row cdl-row cdl-row--block' }, [body, list]);
    }

    var preview = null;
    var updatePreview = function (v) {
      if (!preview) return;
      try { preview.textContent = '→ ' + (S.renderName ? S.renderName(v, PREVIEW_CTX[key] || {}, sc.maxLen || 80) : v); } catch (_) {}
    };

    var nodes;
    if (type === 'enum') {
      var sel = el('select', { class: 'cdl-select' });
      (sc.enum || []).forEach(function (opt) {
        var o = el('option', { value: opt, text: (sc.options && sc.options[opt]) || opt });
        if (String(val) === String(opt)) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () { commit(sel.value); sel.value = prior; });
      nodes = [sel];
    } else if (type === 'color') {
      var col = el('input', { type: 'color', class: 'cdl-color' });
      col.value = /^#/.test(val) ? val : '#60a5fa';
      var hex = el('input', { type: 'text', class: 'cdl-input hex', maxlength: '7' });
      hex.value = String(col.value).toUpperCase();
      var syncColor = function () { if (/^#/.test(prior)) col.value = prior; hex.value = String(prior).toUpperCase(); };
      col.addEventListener('change', function () { commit(col.value); syncColor(); });
      hex.addEventListener('change', function () { commit(hex.value); syncColor(); });
      nodes = [col, hex];
    } else if (type === 'float' || (type === 'int' && (sc.max - sc.min) <= 64)) {
      var step = sc.step || (type === 'float' ? 0.05 : 1);
      var fmt = function (v) { return type === 'float' ? (key === 'appearance.btnScale' ? v.toFixed(2) + '×' : v.toFixed(2)) : String(Math.round(v)); };
      var rng = el('input', { type: 'range', class: 'cdl-range', min: String(sc.min), max: String(sc.max), step: String(step) });
      rng.value = val;
      var readout = el('span', { class: 'cdl-rangeval', text: fmt(parseFloat(val)) });
      rng.addEventListener('input', function () { readout.textContent = fmt(parseFloat(rng.value)); });
      rng.addEventListener('change', function () { commit(parseFloat(rng.value)); rng.value = prior; readout.textContent = fmt(parseFloat(prior)); });
      nodes = [rng, readout];
    } else if (type === 'int') {
      var step2 = sc.step || (sc.max > 5000 ? 500 : 1);
      var num = el('input', { type: 'number', class: 'cdl-input num', min: String(sc.min), max: String(sc.max), step: String(step2) });
      num.value = val;
      num.addEventListener('change', function () { commit(num.value); num.value = prior; });
      nodes = [num];
    } else { // string / template
      var inp = el('input', { type: 'text', class: 'cdl-input txt' });
      if (sc.maxLen) inp.maxLength = sc.maxLen;
      inp.value = val == null ? '' : val;
      if (type === 'template' && PREVIEW_CTX[key]) { preview = el('p', { class: 'cdl-preview' }); inp.addEventListener('input', function () { updatePreview(inp.value); }); }
      inp.addEventListener('change', function () { commit(inp.value); inp.value = prior == null ? '' : prior; updatePreview(prior); });
      nodes = [inp];
    }

    var row2 = el('div', { class: 'usettings__row cdl-row' }, [body, el('span', { class: 'cdl-ctl' }, nodes)]);
    if (preview) { updatePreview(val); body.appendChild(preview); }
    return row2;
  }

  // ── Push-to-library + Subscriptions (live under cdlLibrary / cdlSubscriptions) ─
  function libField(label, ctl) {
    return el('div', { class: 'usettings__row cdl-row' }, [
      el('span', { class: 'usettings__row-body' }, [el('span', { class: 'usettings__row-title', text: label })]),
      el('span', { class: 'cdl-ctl' }, [ctl]),
    ]);
  }
  function makeLibrarySection(lib, rerender) {
    var cfg = Object.assign({ enabled: false, endpoint: '', method: 'PUT', username: '', password: '' }, lib || {});
    var saveCfg = function () { setLocal('cdlLibrary', cfg); flashSaved(); };

    var enableCb = el('input', { type: 'checkbox' });
    enableCb.checked = !!cfg.enabled;
    var enableRow = el('label', { class: 'usettings__row' + (cfg.enabled ? ' is-on' : '') }, [
      el('span', { class: 'usettings__row-body' }, [
        el('span', { class: 'usettings__row-title', text: 'Enable push after download' }),
        el('span', { class: 'usettings__row-hint', text: 'After each chapter is built as CBZ, upload it to your server at <base>/<Series>/<file>.cbz.' }),
      ]),
      el('span', { class: 'usettings__switch', 'aria-hidden': 'true' }, [enableCb, el('span', { class: 'usettings__switch-track' }), el('span', { class: 'usettings__switch-thumb' })]),
    ]);
    enableCb.addEventListener('change', function () { enableRow.classList.toggle('is-on', enableCb.checked); cfg.enabled = enableCb.checked; saveCfg(); });

    var endpoint = el('input', { type: 'text', class: 'cdl-input txt', placeholder: 'https://server.example/webdav/comics' });
    endpoint.value = cfg.endpoint || '';
    endpoint.addEventListener('change', function () { cfg.endpoint = endpoint.value.trim(); saveCfg(); });

    var method = el('select', { class: 'cdl-select' });
    [['PUT', 'PUT (WebDAV / most servers)'], ['POST', 'POST']].forEach(function (m) {
      var o = el('option', { value: m[0], text: m[1] }); if (cfg.method === m[0]) o.selected = true; method.appendChild(o);
    });
    method.addEventListener('change', function () { cfg.method = method.value; saveCfg(); });

    var user = el('input', { type: 'text', class: 'cdl-input txt', placeholder: 'username (optional)' });
    user.value = cfg.username || '';
    user.addEventListener('change', function () { cfg.username = user.value; saveCfg(); });

    var pass = el('input', { type: 'password', class: 'cdl-input txt', placeholder: 'password / token (optional)' });
    pass.value = cfg.password || '';
    pass.addEventListener('change', function () { cfg.password = pass.value; saveCfg(); });

    var status = el('p', { class: 'cdl-status' });
    var originOf = function () { try { var u = new URL(cfg.endpoint); return u.protocol + '//' + u.hostname + '/*'; } catch (_) { return null; } };

    var grantBtn = el('button', { type: 'button', class: 'cdl-btn primary' }, [el('span', { text: 'Save & grant access' })]);
    grantBtn.addEventListener('click', function () {
      saveCfg();
      var pat = originOf();
      if (!pat) { status.textContent = 'Enter a valid http(s) endpoint URL first.'; return; }
      status.textContent = 'Requesting access…';
      send({ action: 'libraryGrant', origin: pat }).then(function (r) {
        if (r && r.granted) { status.textContent = '✓ Access granted. You can Test the connection now.'; return; }
        // Content-script gesture can't open the prompt — hand off to the options page.
        status.textContent = 'Opening the extension’s settings to authorize your server…';
        send({ action: 'openOptions' });
      });
    });

    var testBtn = el('button', { type: 'button', class: 'cdl-btn' }, [el('span', { text: 'Test connection' })]);
    testBtn.addEventListener('click', function () {
      status.textContent = 'Testing…';
      send({ action: 'libraryTest', config: cfg }).then(function (r) {
        if (!r) { status.textContent = 'Test failed: no response.'; return; }
        status.textContent = r.ok ? ('✓ Server reachable (HTTP ' + r.status + ').') : ('✗ ' + (r.error || ('HTTP ' + r.status)));
      });
    });

    return el('section', { class: 'usettings__section' }, [
      el('h3', { class: 'usettings__section-title', text: 'Push to library (CBZ → Komga / Kavita)' }),
      el('p', { class: 'usettings__section-sub', text: 'Upload finished CBZ files to a WebDAV / HTTP folder your media server watches. This is the only feature that sends data off your device.' }),
      enableRow,
      libField('Endpoint URL', endpoint),
      libField('Method', method),
      libField('Username', user),
      libField('Password', pass),
      el('div', { class: 'cdl-actions' }, [grantBtn, testBtn]),
      status,
    ]);
  }

  function timeAgo(ts) {
    if (!ts) return 'waiting for first check';
    var m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'checked just now';
    if (m < 60) return 'checked ' + m + ' min ago';
    var h = Math.round(m / 60); if (h < 48) return 'checked ' + h + ' h ago';
    return 'checked ' + Math.round(h / 24) + ' d ago';
  }
  function makeSubsSection(subs, rerender) {
    var slugs = Object.keys(subs || {}).sort(function (a, b) {
      return String((subs[a] || {}).mangaName || a).localeCompare(String((subs[b] || {}).mangaName || b));
    });
    var sec = el('section', { class: 'usettings__section' }, [
      el('h3', { class: 'usettings__section-title', text: 'Subscriptions' }),
      el('p', { class: 'usettings__section-sub', text: 'Series you watch for new chapters (subscribe from a title page).' }),
    ]);
    if (!slugs.length) {
      sec.appendChild(el('p', { class: 'cdl-foot', text: 'No subscriptions yet. Open a series and click “☆ Subscribe” next to Download All.' }));
    } else {
      slugs.forEach(function (slug) {
        var s = subs[slug] || {};
        var x = el('button', { type: 'button', class: 'cdl-sub-x', title: 'Unsubscribe', text: '×' });
        x.addEventListener('click', function () { send({ action: 'unsubscribe', slug: slug }).then(function () { setTimeout(rerender, 150); }); });
        sec.appendChild(el('div', { class: 'cdl-sub-item' }, [
          el('span', { class: 'cdl-sub-name', text: s.mangaName || slug }),
          el('span', { class: 'cdl-sub-meta', text: ((s.lastSeen && s.lastSeen.length) ? s.lastSeen.length + ' tracked · ' : '') + timeAgo(s.lastCheck) }),
          x,
        ]));
      });
    }
    var checkBtn = el('button', { type: 'button', class: 'cdl-btn' }, [el('span', { text: 'Check now' })]);
    var st = el('p', { class: 'cdl-status' });
    checkBtn.addEventListener('click', function () {
      st.textContent = 'Checking…';
      send({ action: 'checkSubscriptionsNow' }).then(function (r) {
        st.textContent = (r && r.ok) ? 'Done.' : 'Check failed (open comix.to once, then retry).';
        setTimeout(rerender, 300);
      });
    });
    sec.appendChild(el('div', { class: 'cdl-actions' }, [checkBtn]));
    sec.appendChild(st);
    return sec;
  }

  // ── About & Backup ──────────────────────────────────────────────────────────
  function makeBackupSection(rerender) {
    var exportBtn = el('button', { type: 'button', class: 'cdl-btn' }, [svg(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'], 15), el('span', { text: 'Export settings' })]);
    exportBtn.addEventListener('click', function () {
      try {
        var go = function (txt) { var b = new Blob([txt], { type: 'application/json' }); var a = el('a', { href: URL.createObjectURL(b), download: 'comix-downloader-settings.json' }); document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); }, 0); };
        var json = S.exportJSON ? S.exportJSON() : ''; if (json && json.then) json.then(go); else go(json);
      } catch (_) {}
    });
    var importBtn = el('button', { type: 'button', class: 'cdl-btn' }, [svg(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'], 15), el('span', { text: 'Import settings' })]);
    var file = el('input', { type: 'file', accept: 'application/json,.json' }); file.style.display = 'none';
    importBtn.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () { try { var p = S.importJSON(String(r.result)); if (p && p.then) p.then(rerender); else rerender(); } catch (_) {} };
      r.readAsText(f); file.value = '';
    });
    var resetBtn = el('button', { type: 'button', class: 'cdl-btn danger' }, [svg(['M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.7 3', 'M3 4v5h5'], 15), el('span', { text: 'Reset to defaults' })]);
    resetBtn.addEventListener('click', function () {
      if (!window.confirm('Reset all Comix Downloader settings to their defaults?')) return;
      try { var p = S.resetDefaults(); if (p && p.then) p.then(rerender); else rerender(); } catch (_) {}
    });
    return el('section', { class: 'usettings__section' }, [
      el('h3', { class: 'usettings__section-title', text: 'Backup & reset' }),
      el('p', { class: 'usettings__section-sub', text: 'Export or import your extension settings, or restore the defaults.' }),
      el('div', { class: 'cdl-actions' }, [exportBtn, importBtn, resetBtn, file]),
    ]);
  }

  function getOutroAudio() {
    if (outroAudio) return outroAudio;
    outroAudio = el('audio', {
      class: 'cdl-outro-audio',
      src: extensionAsset('outro.mp3'),
      preload: 'auto',
    });
    outroAudio.loop = true;
    outroAudio.muted = false;
    outroAudio.volume = 0;
    return outroAudio;
  }

  // Start the real audio element during the settings-menu click while the browser
  // still considers playback user-initiated. It stays silent until the footer.
  function primeOutroAudio() {
    var audio = getOutroAudio();
    if (!audio.paused || audio.__cdlUnlockPending) return;
    try {
      audio.muted = false;
      audio.volume = 0.0001;
      audio.__cdlBlocked = false;
      var result = audio.play();
      if (result && result.then) {
        audio.__cdlUnlockPending = true;
        result.then(function () {
          audio.__cdlUnlockPending = false;
          audio.__cdlUnlocked = true;
          audio.__cdlBlocked = false;
          audio.volume = 0;
          if (outroController && outroController.playbackStateChanged) outroController.playbackStateChanged();
        }).catch(function () {
          audio.__cdlUnlockPending = false;
          audio.__cdlUnlocked = false;
          audio.__cdlBlocked = true;
          if (outroController && outroController.playbackStateChanged) outroController.playbackStateChanged();
        });
      } else {
        audio.__cdlUnlocked = true;
      }
    } catch (_) {
      audio.__cdlUnlockPending = false;
      audio.__cdlUnlocked = false;
      audio.__cdlBlocked = true;
    }
  }

  function makeOutroSection() {
    var media = el('div', { class: 'cdl-outro-media', 'aria-hidden': 'true' });
    OUTRO_MEDIA.forEach(function (item) {
      var image = el('img', {
        class: 'cdl-outro-dancer ' + item.className,
        src: extensionAsset(item.file),
        alt: '',
        loading: 'eager',
        decoding: 'async',
      });
      image.draggable = false;
      media.appendChild(image);
    });

    var audio = getOutroAudio();

    return el('section', {
      class: 'cdl-outro',
      id: OUTRO_ID,
      'aria-labelledby': 'cdl-outro-title',
    }, [
      el('div', { class: 'cdl-outro-head' }, [
        el('div', { class: 'cdl-outro-brand' }, [
          markSvg(20),
          el('h3', {
            class: 'cdl-outro-title',
            id: 'cdl-outro-title',
            text: 'Thanks for using my extension.',
          }),
        ]),
      ]),
      media,
      audio,
    ]);
  }

  function stopOutro() {
    if (!outroController) return;
    try { outroController.destroy(); } catch (_) {}
    outroController = null;
  }

  function setupOutro(view) {
    stopOutro();
    var root = view && view.querySelector('#' + OUTRO_ID);
    if (!root) return;
    var audio = root.querySelector('.cdl-outro-audio');
    if (!audio) return;

    var reduced = false;
    try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}
    if (reduced) {
      root.style.opacity = '1';
      root.style.transform = 'none';
      try { audio.pause(); audio.currentTime = 0; audio.volume = 0; } catch (_) {}
      outroController = { destroy: function () {} };
      return;
    }

    var MAX_VOLUME = 0.32;
    var AUDIO_START_PX = 180;
    var AUDIO_FULL_PX = 18;
    var REVEAL_START_PX = 360;
    var REVEAL_FULL_PX = 50;
    var targetVolume = 0;
    var currentVolume = 0;
    var proximity = 0;
    var blocked = !!audio.__cdlBlocked;
    var playPending = !!audio.__cdlUnlockPending;
    var destroyed = false;
    var frame = 0;

    function canKeepSilentPlayback() {
      return !document.hidden &&
        (!!audio.__cdlUnlocked || !!audio.__cdlUnlockPending || !audio.paused);
    }

    function pauseAndReset(force) {
      if (!force && canKeepSilentPlayback()) {
        try {
          audio.volume = 0;
          audio.muted = false;
        } catch (_) {}
        currentVolume = 0;
        return;
      }
      try {
        audio.pause();
        audio.currentTime = 0;
        audio.volume = 0;
        audio.muted = false;
      } catch (_) {}
      currentVolume = 0;
    }

    function startPlayback(force, allowSilent) {
      if (destroyed || (!allowSilent && proximity <= 0) || document.hidden || playPending) return;
      if (blocked && !force) return;
      if (force) blocked = false;
      if (!audio.paused) {
        audio.__cdlUnlocked = true;
        audio.__cdlBlocked = false;
        audio.muted = false;
        return;
      }
      try {
        audio.muted = false;
        audio.volume = targetVolume > 0 ? Math.max(0.01, targetVolume) : (allowSilent ? 0.0001 : 0);
        var result = audio.play();
        if (result && result.then) {
          playPending = true;
          audio.__cdlUnlockPending = true;
          result.then(function () {
            playPending = false;
            audio.__cdlUnlockPending = false;
            audio.__cdlUnlocked = true;
            audio.__cdlBlocked = false;
            if (destroyed) return;
            blocked = false;
            if (proximity <= 0) audio.volume = 0;
            audio.muted = document.hidden;
            animateVolume();
          }).catch(function () {
            playPending = false;
            audio.__cdlUnlockPending = false;
            audio.__cdlUnlocked = false;
            audio.__cdlBlocked = true;
            blocked = true;
          });
        } else {
          audio.__cdlUnlocked = true;
          audio.__cdlBlocked = false;
          audio.muted = false;
        }
      } catch (_) {
        audio.__cdlUnlocked = false;
        audio.__cdlBlocked = true;
        blocked = true;
      }
    }

    function animateVolume() {
      if (destroyed || frame) return;
      frame = requestAnimationFrame(function step() {
        frame = 0;
        if (destroyed) return;
        var delta = targetVolume - currentVolume;
        currentVolume += delta * 0.16;
        if (Math.abs(delta) < 0.001) currentVolume = targetVolume;
        try { audio.volume = Math.max(0, Math.min(1, currentVolume)); } catch (_) {}

        if (currentVolume === 0 && targetVolume === 0) {
          pauseAndReset(false);
          return;
        }
        if (!document.hidden && !audio.paused) audio.muted = false;
        if (currentVolume !== targetVolume) frame = requestAnimationFrame(step);
      });
    }

    function pageDistanceFromBottom() {
      var doc = document.documentElement;
      var body = document.body;
      var height = Math.max(
        doc ? doc.scrollHeight : 0,
        body ? body.scrollHeight : 0
      );
      return Math.max(0, height - (window.scrollY + window.innerHeight));
    }

    function updateProximity() {
      if (destroyed || !root.isConnected) return;
      var distance = pageDistanceFromBottom();
      proximity = outroProximity(distance, AUDIO_START_PX, AUDIO_FULL_PX);
      var reveal = outroProximity(distance, REVEAL_START_PX, REVEAL_FULL_PX);
      root.style.opacity = String(0.2 + (0.8 * reveal));
      root.style.transform = 'translateY(' + (12 * (1 - reveal)).toFixed(2) + 'px)';
      targetVolume = !document.hidden ? proximity * MAX_VOLUME : 0;
      if (targetVolume > 0) startPlayback();
      animateVolume();
    }

    function retryFromGesture() {
      if (audio.paused) startPlayback(true, true);
    }

    function onVisibilityChange() {
      if (document.hidden) {
        targetVolume = 0;
        pauseAndReset(true);
      }
      updateProximity();
      if (!document.hidden && proximity > 0) startPlayback();
    }

    window.addEventListener('scroll', updateProximity, { passive: true });
    window.addEventListener('resize', updateProximity, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('pointerdown', retryFromGesture, true);
    document.addEventListener('keydown', retryFromGesture, true);

    updateProximity();
    outroController = {
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        window.removeEventListener('scroll', updateProximity);
        window.removeEventListener('resize', updateProximity);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        document.removeEventListener('pointerdown', retryFromGesture, true);
        document.removeEventListener('keydown', retryFromGesture, true);
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        pauseAndReset(true);
      },
      playbackStateChanged: function () {
        playPending = !!audio.__cdlUnlockPending;
        blocked = !!audio.__cdlBlocked;
      },
    };
  }

  // ── build the whole extension settings view ─────────────────────────────────
  function makeEmbeddedUpdateControls() {
    var checkLabel = i18n('updateCheckAction', 'Check for updates');
    var checkStatus = el('span', { class: 'cdl-update-check-status', role: 'status', 'aria-live': 'polite' });
    var checkBtn = el('button', { type: 'button', class: 'cdl-btn cdl-update-check', title: checkLabel, 'aria-label': checkLabel }, [
      svg(['M20 6v5h-5', 'M4 18v-5h5', 'M6.1 9a7 7 0 0 1 11.5-2.6L20 11', 'm4 13 2.4 4.6A7 7 0 0 0 17.9 15'], 15),
      el('span', { text: checkLabel }),
    ]);

    var updateTitle = el('strong', { class: 'cdl-update-title', text: i18n('updateAvailableTitle', 'Your extension is outdated') });
    updateTitle.id = 'cdl-settings-update-title';
    var updateMessage = el('span', { class: 'cdl-update-message' });
    var updateStatus = el('span', { class: 'cdl-update-action-status', role: 'status', 'aria-live': 'polite' });
    var updateAction = el('button', { type: 'button', class: 'cdl-btn primary cdl-update-action', text: i18n('updateAvailableAction', 'Update now') });
    var panel = el('section', { class: 'cdl-update-panel', 'aria-labelledby': updateTitle.id }, [
      el('span', { class: 'cdl-update-icon' }, [svg(['M12 3v12', 'm7 10 5 5 5-5', 'M5 21h14'], 17)]),
      el('div', { class: 'cdl-update-copy' }, [updateTitle, updateMessage]),
      updateAction,
      updateStatus,
    ]);
    panel.hidden = true;

    function show(update) {
      if (!update || !update.version) { panel.hidden = true; return false; }
      updateMessage.textContent = i18n(
        'updateAvailableMessage',
        'Version ' + update.version + ' is ready. Your settings and history will stay intact.',
        update.version
      );
      updateAction.textContent = i18n('updateAvailableAction', 'Update now');
      updateAction.disabled = false;
      updateStatus.textContent = '';
      panel.hidden = false;
      return true;
    }

    function refresh() {
      return send({ action: 'getAvailableUpdate' }).then(function (result) {
        return show(result && result.ok ? result.update : null);
      });
    }

    checkBtn.addEventListener('click', function () {
      if (checkBtn.disabled) return;
      checkBtn.disabled = true;
      checkBtn.classList.add('is-checking');
      checkBtn.setAttribute('aria-busy', 'true');
      checkStatus.textContent = i18n('updateChecking', 'Checking for updates...');
      send({ action: 'checkForUpdate' }).then(function (result) {
        if (result && result.update && result.update.version) {
          show(result.update);
          checkStatus.textContent = i18n('updateAvailableShort', 'Update ' + result.update.version + ' is ready', result.update.version);
        } else if (result && result.ok && result.status === 'no_update') {
          checkStatus.textContent = i18n('updateUpToDate', 'You are up to date');
        } else if (result && result.ok && result.status === 'throttled') {
          checkStatus.textContent = i18n('updateCheckThrottled', 'Checked recently - try again later');
        } else if (result && result.ok && result.status === 'unsupported') {
          checkStatus.textContent = i18n('updateCheckUnsupported', 'Manual checks are unavailable in this browser');
        } else {
          checkStatus.textContent = i18n('updateCheckFailed', 'Could not check for updates');
        }
      }).finally(function () {
        checkBtn.disabled = false;
        checkBtn.classList.remove('is-checking');
        checkBtn.removeAttribute('aria-busy');
      });
    });

    updateAction.addEventListener('click', function () {
      updateAction.disabled = true;
      updateAction.textContent = i18n('updateInstalling', 'Updating...');
      updateStatus.textContent = '';
      send({ action: 'installAvailableUpdate' }).then(function (result) {
        if (result && result.ok) {
          updateStatus.textContent = i18n('updateInstalling', 'Updating...');
          return;
        }
        updateAction.disabled = false;
        updateAction.textContent = i18n('updateAvailableAction', 'Update now');
        if (result && result.noUpdate) { panel.hidden = true; return; }
        updateStatus.textContent = result && result.busy
          ? i18n('updateBusy', 'Finish or discard the current download, then try again.')
          : i18n('updateFailed', 'Could not start the update. Reopen the settings page and try again.');
      });
    });

    return {
      head: el('div', { class: 'cdl-update-head-actions' }, [checkBtn, checkStatus]),
      panel: panel,
      refresh: refresh,
    };
  }

  function buildView(cur, lib, subs) {
    var draft = Object.assign({}, S.DEFAULTS, cur);
    var rowEls = {};
    var applyDeps = function () {
      Object.keys(DEPENDS).forEach(function (k) { var r = rowEls[k]; if (r) r.classList.toggle('cdl-disabled', !DEPENDS[k](draft)); });
    };
    var onChange = function (key, value) {
      draft[key] = value;
      var p = {}; p[key] = value;
      try {
        var r = S.patchSettings(p);
        if (r && r.then) {
          r.then(function () { flashSaved(); })
            .catch(function () { flashSaved('Could not save'); });
        } else {
          flashSaved();
        }
      } catch (_) { flashSaved('Could not save'); }
      applyDeps();
    };
    var updateControls = makeEmbeddedUpdateControls();
    var view = el('div', { class: 'uview', id: VIEW_ID }, [
      el('div', { class: 'uview__head cdl-settings-head' }, [
        el('div', { class: 'cdl-settings-head-copy' }, [
          el('h2', { class: 'uview__title', text: 'Comix Downloader' }),
          el('p', { class: 'uview__sub', text: 'Settings for the browser extension — separate from comix.to, saved instantly on your device.' }),
        ]),
        updateControls.head,
      ]),
      updateControls.panel,
    ]);
    embeddedUpdateRefresh = updateControls.refresh;
    updateControls.refresh();
    (S.TABS || []).forEach(function (tab) {
      var keys = (tab.keys || []).filter(function (k) { return S.SCHEMA[k]; });
      if (keys.length) {
        var sec = el('section', { class: 'usettings__section' }, [el('h3', { class: 'usettings__section-title', text: tab.label })]);
        keys.forEach(function (k) { var row = makeRow(k, cur, onChange); rowEls[k] = row; sec.appendChild(row); });
        view.appendChild(sec);
      }
      if (tab.id === 'sync') {
        view.appendChild(makeLibrarySection(lib, activate));
        view.appendChild(makeSubsSection(subs, activate));
      }
    });
    view.appendChild(makeBackupSection(activate));
    view.appendChild(makeOutroSection());
    applyDeps();
    return view;
  }

  // ── nav + view switching ────────────────────────────────────────────────────
  function ensureNavItem() {
    var list = navList();
    if (!list || document.getElementById(NAV_ID)) return;
    if (!document.querySelector('.cdl-umenu-sep')) list.appendChild(el('li', { class: 'cdl-umenu-sep', text: 'Extension' }));
    var btn = el('button', { type: 'button', class: 'umenu__item', id: NAV_ID }, [
      el('span', { class: 'umenu__icon' }, [markSvg(16)]),
      el('span', { class: 'umenu__text', text: 'Comix Downloader' }),
    ]);
    btn.addEventListener('click', function () { activate(true); });
    list.appendChild(el('li', {}, [btn]));
  }

  // ── scroll persistence ──────────────────────────────────────────────────────
  function readScroll() { try { var v = sessionStorage.getItem(SCROLL_KEY); return v == null ? null : parseInt(v, 10); } catch (_) { return null; } }
  function saveScroll() { if (!document.getElementById(VIEW_ID)) return; try { sessionStorage.setItem(SCROLL_KEY, String(window.scrollY)); } catch (_) {} }
  function onScrollSave() {
    if (scrollSaveTimer) return;
    scrollSaveTimer = setTimeout(function () { scrollSaveTimer = null; saveScroll(); }, 150);
  }
  function startScrollTracking() { if (scrollTracking) return; scrollTracking = true; window.addEventListener('scroll', onScrollSave, { passive: true }); }
  function stopScrollTracking() {
    if (!scrollTracking) return; scrollTracking = false;
    window.removeEventListener('scroll', onScrollSave);
    if (scrollSaveTimer) { clearTimeout(scrollSaveTimer); scrollSaveTimer = null; }
  }
  // Restore where the reader was: their saved position if any (covers React re-injects +
  // refresh); otherwise, only on a deliberate open, bring the panel into view.
  function restoreScroll(box, userInitiated) {
    var saved = readScroll();
    if (saved != null && isFinite(saved)) { try { window.scrollTo(0, saved); } catch (_) {} return; }
    if (userInitiated) { try { var y = box.getBoundingClientRect().top + window.scrollY - 80; window.scrollTo(0, y); saveScroll(); } catch (_) {} }
  }

  function activate(userInitiated) {
    injectStyle();
    var box = contentBox(); if (!box) return;
    var cv = comixView(); if (cv) { hiddenComixView = cv; cv.style.display = 'none'; }
    stopOutro();
    if (userInitiated === true) primeOutroAudio();
    var old = document.getElementById(VIEW_ID); if (old) old.remove();
    Promise.all([S.getSettings(), getLocal('cdlLibrary'), getLocal('cdlSubscriptions')]).then(function (r) {
      if (!document.getElementById(NAV_ID)) return;
      stopOutro();
      var existing = document.getElementById(VIEW_ID); if (existing) existing.remove();
      var nextView = buildView(r[0] || {}, r[1] || {}, r[2] || {});
      contentBox().appendChild(nextView);
      finishSettingsNavigationAttempt();
      setupOutro(nextView);
      setActiveNav(true);
      try { sessionStorage.setItem(OPEN_KEY, '1'); } catch (_) {}
      startScrollTracking();
      restoreScroll(box, userInitiated === true);
    });
  }

  function deactivate() {
    stopOutro();
    embeddedUpdateRefresh = null;
    var v = document.getElementById(VIEW_ID); if (v) v.remove();
    if (hiddenComixView) { try { hiddenComixView.style.display = ''; } catch (_) {} hiddenComixView = null; }
    setActiveNav(false);
    stopScrollTracking();
    // An explicit close forgets the saved spot, so the next open starts at the panel top.
    try { sessionStorage.removeItem(OPEN_KEY); sessionStorage.removeItem(SCROLL_KEY); } catch (_) {}
  }

  // If the popup's "Settings" button sent us here, open our view automatically
  // once (consumes a short-lived flag set by the popup).
  function maybeAutoActivate() {
    if (autoChecked || !document.getElementById(NAV_ID)) return;
    autoChecked = true;
    try {
      chrome.storage.local.get('cdlOpenExtSettings', function (r) {
        var ts = r && r.cdlOpenExtSettings;
        if (ts && (Date.now() - ts) < 60000) {
          try { chrome.storage.local.remove('cdlOpenExtSettings'); } catch (_) {}
          activate(true);
        }
      });
    } catch (_) {}
  }

  function setActiveNav(on) {
    var ours = document.getElementById(NAV_ID);
    document.querySelectorAll('.umenu__item.is-active').forEach(function (b) { if (b !== ours) b.classList.toggle('is-active', !on); });
    if (ours) ours.classList.toggle('is-active', on);
  }

  document.addEventListener('click', function (e) {
    var item = e.target && e.target.closest && e.target.closest('.umenu__item');
    if (item && item.id !== NAV_ID && document.getElementById(VIEW_ID)) deactivate();
  }, true);

  // ── comix's quick-settings popover (gear in the top bar) ─────────────────────
  // Add a clear row that jumps to the full extension settings with our section
  // already open. We clone comix's own "Content preferences" row so it looks
  // 100% native, then repoint it.
  function openExtSettings() {
    var navigated = false;
    var go = function () {
      if (navigated) return;
      navigated = true;
      location.href = 'https://comix.to/user?tab=settings';
    };
    setLocal('cdlOpenExtSettings', Date.now());
    send({ action: 'cdlTrackSettingsNavigation' }).then(go);
    setTimeout(go, 500);
  }
  function injectQuickLink(dialog) {
    try {
      if (!dialog || dialog.querySelector('#cdl-quick-link')) return;
      var orig = dialog.querySelector('.settings-advanced-row');
      if (!orig || !orig.parentNode) return;
      var clone = orig.cloneNode(true);
      clone.id = 'cdl-quick-link';
      var setLeaf = function (find, to) {
        var els = clone.querySelectorAll('*');
        for (var i = 0; i < els.length; i++) { if (!els[i].children.length && (els[i].textContent || '').trim() === find) { els[i].textContent = to; return; } }
      };
      setLeaf('Content preferences', 'Comix Downloader settings');
      setLeaf('Types, demographics & blocked genres', 'Downloads, library, push to Komga / Kavita & more');
      clone.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openExtSettings(); }, true);
      orig.parentNode.insertBefore(clone, orig.nextSibling);
    } catch (_) {}
  }
  function installQuickDialogWatcher() {
    var check = function () { var d = document.querySelector('.settings-dialog'); if (d) injectQuickLink(d); };
    try { new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
    check();
  }

  // ── Mirror comix's active theme into storage ────────────────────────────────
  // The toolbar popup is a separate extension page that can't read comix's CSS,
  // so we snapshot the live theme tokens here; the popup applies them on open.
  function buildSiteTheme() {
    try {
      var cs = getComputedStyle(document.documentElement);
      var g = function (n) { return (cs.getPropertyValue(n) || '').trim(); };
      var bg = g('--bg'); if (!bg) return null;
      var rgb = g('--accent-rgb') || '135 101 235';
      var lum = (function () {
        var m = bg.match(/#?([0-9a-fA-F]{6})/);
        if (m) { var h = m[1]; return (0.2126 * parseInt(h.slice(0, 2), 16) + 0.7152 * parseInt(h.slice(2, 4), 16) + 0.0722 * parseInt(h.slice(4, 6), 16)) / 255; }
        var r = bg.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
        return r ? (0.2126 * +r[1] + 0.7152 * +r[2] + 0.0722 * +r[3]) / 255 : 0.1;
      })();
      var light = lum > 0.5;
      return {
        name: document.documentElement.getAttribute('data-theme') || 'main',
        bg: bg, panel: g('--surface') || bg,
        line: light ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.07)',
        line2: light ? 'rgba(0,0,0,0.14)' : 'rgba(255,255,255,0.11)',
        fg: g('--text') || (light ? '#222' : '#ddd'), fgStrong: g('--text-emphasis') || (light ? '#000' : '#fff'),
        muted: g('--text-2') || '#8a8a8a', muted2: g('--text-3') || '#666',
        accent: g('--accent') || '#8765eb', accentInk: g('--accent-ink') || (light ? '#ffffff' : '#0b0b0b'),
        accentBg: 'rgb(' + rgb + ' / 0.16)', accentLine: 'rgb(' + rgb + ' / 0.32)', accentSoft: 'rgb(' + rgb + ' / 0.18)',
        ok: g('--success') || '#22c55e', warn: g('--warning') || '#eab308', err: g('--danger') || '#ef4444',
      };
    } catch (_) { return null; }
  }
  var _lastThemeSig = '';
  function captureSiteTheme() {
    var theme = buildSiteTheme(); if (!theme) return;
    var sig = theme.name + '|' + theme.accent + '|' + theme.bg;
    if (sig === _lastThemeSig) return;
    _lastThemeSig = sig;
    try { chrome.storage.local.set({ cdlSiteTheme: theme }); } catch (_) {}
    // Direct nudge so the background recolours the toolbar icon promptly.
    try { chrome.runtime.sendMessage({ action: 'cdlIconTheme', name: theme.name }); } catch (_) {}
  }
  function installThemeWatcher() {
    captureSiteTheme();
    try { new MutationObserver(captureSiteTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); } catch (_) {}
    // Answer the popup's live request (it can't read the site itself).
    try { chrome.runtime.onMessage.addListener(function (msg, s, send) { if (msg && msg.action === 'cdlGetSiteTheme') { send(buildSiteTheme()); } }); } catch (_) {}
    [400, 1500].forEach(function (t) { setTimeout(captureSiteTheme, t); });
  }

  // ── lifecycle (SPA-aware) ───────────────────────────────────────────────────
  function sync() {
    if (onSettingsPage()) { startWatching(); ensureNavItem(); }
    else {
      stopWatching(); deactivate();
      var n = document.getElementById(NAV_ID); if (n && n.parentElement) n.parentElement.remove();
      var sep = document.querySelector('.cdl-umenu-sep'); if (sep) sep.remove();
    }
  }
  function startWatching() {
    if (!pollTimer) {
      var tries = 0;
      pollTimer = setInterval(function () {
        ensureNavItem();
        maybeAutoActivate();
        var n = document.getElementById(NAV_ID);
        // Re-open after a refresh (our panel was open last time) or re-inject after comix's
        // React wiped our panel — both restore the saved scroll position (no jump to top).
        var wasOpen = false; try { wasOpen = sessionStorage.getItem(OPEN_KEY) === '1'; } catch (_) {}
        if (n && !document.getElementById(VIEW_ID) && (n.classList.contains('is-active') || wasOpen)) activate(false);
        if (++tries > 60) { clearInterval(pollTimer); pollTimer = null; }
      }, 300);
    }
    if (!observer && document.body) {
      observer = new MutationObserver(function () { if (onSettingsPage()) ensureNavItem(); });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }
  function stopWatching() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (observer) { observer.disconnect(); observer = null; }
  }

  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    history[m] = function () { var r = orig.apply(this, arguments); try { window.dispatchEvent(new Event('cdl:locationchange')); } catch (_) {} return r; };
  });
  window.addEventListener('popstate', sync);
  window.addEventListener('hashchange', sync);
  window.addEventListener('cdl:locationchange', sync);
  sync();
  installQuickDialogWatcher();
  installThemeWatcher();
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes.cdlUpdateAvailable && embeddedUpdateRefresh) embeddedUpdateRefresh();
    });
  } catch (_) {}
  beginSettingsNavigationProbe();
})();
