/**
 * cdl-embed-settings.js — adds the extension's settings natively into comix.to's
 * own settings page (comix.to/user?tab=settings).
 *
 * It injects a "Comix Downloader" entry into comix's left settings menu and, when
 * selected, renders the extension's settings INTO comix's content area using
 * comix's own markup/classes (usettings__section / usettings__row / usettings__
 * switch) so booleans look 100% native, with comix-themed selects/inputs for the
 * richer settings comix itself doesn't have. Changes save instantly (like comix),
 * straight to chrome.storage via CDLSettings. The standalone options.html page
 * keeps working independently.
 *
 * comix is a client-rendered SPA, so we watch history + the DOM and (re)inject as
 * the user moves in and out of the settings tab.
 */
(function () {
  'use strict';
  if (window.top !== window) return;
  var S = (typeof CDLSettings !== 'undefined') ? CDLSettings : (typeof globalThis !== 'undefined' && globalThis.CDLSettings);
  if (!S) return;

  var NAV_ID = 'cdl-nav-item';
  var VIEW_ID = 'cdl-uview';
  var STYLE_ID = 'cdl-embed-style';
  var hiddenComixView = null;
  var pollTimer = null;
  var observer = null;

  // ── helpers ──────────────────────────────────────────────────────────────
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else if (k === 'html') n.innerHTML = props[k];
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
  function onSettingsPage() {
    if (document.querySelector('.usettings__section') || document.getElementById(VIEW_ID)) return true;
    return /\/user(?:\/|$)/.test(location.pathname) && /(?:^|[?&])tab=settings(?:&|$)/.test(location.search);
  }
  function navList() { return document.querySelector('.umenu__list'); }
  function contentBox() { return document.querySelector('.user-content'); }
  function comixView() { return document.querySelector('.user-content > .uview:not(#' + VIEW_ID + ')'); }

  // ── styles for the controls comix doesn't ship (selects / inputs / badges) ──
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = el('style', { id: STYLE_ID });
    s.textContent =
      '.cdl-umenu-sep{padding:14px 12px 6px;font:700 10px/1 var(--f-mono,monospace);letter-spacing:.08em;text-transform:uppercase;color:var(--text-3,#707070);}' +
      '#' + VIEW_ID + ' .cdl-row{cursor:default;}' +
      '#' + VIEW_ID + ' .cdl-ctl{flex:0 0 auto;display:flex;align-items:center;gap:8px;}' +
      '#' + VIEW_ID + ' .cdl-input,#' + VIEW_ID + ' .cdl-select{background:var(--surface-2,#282c30);color:var(--text,#d4d4d4);' +
        'border:1px solid rgba(255,255,255,.10);border-radius:var(--radius,6px);padding:7px 10px;font-size:13px;font-family:inherit;outline:none;}' +
      '#' + VIEW_ID + ' .cdl-input:focus,#' + VIEW_ID + ' .cdl-select:focus{border-color:var(--accent,#8765eb);box-shadow:0 0 0 3px rgb(var(--accent-rgb,135 101 235) / .18);}' +
      '#' + VIEW_ID + ' .cdl-select{min-width:200px;cursor:pointer;}' +
      '#' + VIEW_ID + ' .cdl-input.num{width:104px;}' +
      '#' + VIEW_ID + ' .cdl-input.txt{min-width:240px;}' +
      '#' + VIEW_ID + ' input[type=color].cdl-color{width:40px;height:30px;padding:2px;border:1px solid rgba(255,255,255,.12);border-radius:6px;background:var(--surface-2,#282c30);cursor:pointer;}' +
      '#' + VIEW_ID + ' .cdl-badge{display:inline-block;margin-left:8px;font:700 9px/1.6 var(--f-mono,monospace);letter-spacing:.04em;text-transform:uppercase;padding:1px 6px;border-radius:5px;vertical-align:middle;}' +
      '#' + VIEW_ID + ' .cdl-badge.risky{color:#ef9a9a;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.32);}' +
      '#' + VIEW_ID + ' .cdl-badge.glitchy{color:#e6c071;background:rgba(234,179,8,.12);border:1px solid rgba(234,179,8,.34);}' +
      '#' + VIEW_ID + ' .cdl-warn{display:block;margin-top:6px;font-size:11.5px;line-height:1.45;color:var(--text-3,#8a8a8a);}' +
      '#' + VIEW_ID + ' .cdl-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px;}' +
      '#' + VIEW_ID + ' .cdl-btn{display:inline-flex;align-items:center;gap:7px;padding:8px 14px;border-radius:var(--radius,6px);' +
        'font-size:13px;font-weight:600;cursor:pointer;border:1px solid rgba(255,255,255,.12);background:var(--surface-2,#282c30);color:var(--text,#d4d4d4);}' +
      '#' + VIEW_ID + ' .cdl-btn.primary{background:var(--accent,#8765eb);border-color:var(--accent,#8765eb);color:var(--accent-ink,#1a1133);}' +
      '#' + VIEW_ID + ' .cdl-btn.danger{color:#ef9a9a;border-color:rgba(239,68,68,.32);background:rgba(239,68,68,.08);}' +
      '#' + VIEW_ID + ' .cdl-foot{margin-top:8px;font-size:11.5px;color:var(--text-3,#8a8a8a);}';
    (document.head || document.documentElement).appendChild(s);
  }

  // ── one settings row, native comix markup ───────────────────────────────────
  function makeRow(key, cur, onChange) {
    var sc = S.SCHEMA[key] || {};
    var type = sc.type || (typeof S.DEFAULTS[key] === 'boolean' ? 'bool' : 'string');
    var val = (key in cur) ? cur[key] : S.DEFAULTS[key];

    var title = el('span', { class: 'usettings__row-title', text: sc.label || key });
    if (sc.risk === 'risky' || sc.risk === 'glitchy') {
      title.appendChild(el('span', { class: 'cdl-badge ' + sc.risk, text: sc.risk }));
    }
    var body = el('span', { class: 'usettings__row-body' }, [title]);
    if (sc.help) body.appendChild(el('span', { class: 'usettings__row-hint', text: sc.help }));
    if (sc.warn) body.appendChild(el('span', { class: 'cdl-warn', text: sc.warn }));

    var save = function (v) { try { onChange(key, S.validateValue ? S.validateValue(key, v) : v); } catch (_) {} };

    if (type === 'bool') {
      var cb = el('input', { type: 'checkbox' });
      cb.checked = !!val;
      var row = el('label', { class: 'usettings__row' + (val ? ' is-on' : '') }, [
        body,
        el('span', { class: 'usettings__switch', 'aria-hidden': 'true' }, [
          cb, el('span', { class: 'usettings__switch-track' }), el('span', { class: 'usettings__switch-thumb' }),
        ]),
      ]);
      cb.addEventListener('change', function () { row.classList.toggle('is-on', cb.checked); save(cb.checked); });
      return row;
    }

    var ctl;
    if (type === 'enum') {
      var sel = el('select', { class: 'cdl-select' });
      (sc.enum || []).forEach(function (opt) {
        var o = el('option', { value: opt, text: (sc.options && sc.options[opt]) || opt });
        if (String(val) === String(opt)) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () { save(sel.value); });
      ctl = sel;
    } else if (type === 'color') {
      var col = el('input', { type: 'color', class: 'cdl-color' });
      col.value = /^#/.test(val) ? val : '#60a5fa';
      col.addEventListener('change', function () { save(col.value); });
      ctl = col;
    } else if (type === 'int' || type === 'float') {
      var num = el('input', { type: 'number', class: 'cdl-input num' });
      if (sc.min != null) num.min = sc.min;
      if (sc.max != null) num.max = sc.max;
      num.step = (type === 'float') ? (sc.step || 0.05) : 1;
      num.value = val;
      num.addEventListener('change', function () { save(num.value); });
      ctl = num;
    } else { // string / template
      var inp = el('input', { type: 'text', class: 'cdl-input txt' });
      if (sc.maxLen) inp.maxLength = sc.maxLen;
      inp.value = val == null ? '' : val;
      inp.addEventListener('change', function () { save(inp.value); });
      ctl = inp;
    }
    return el('div', { class: 'usettings__row cdl-row' }, [body, el('span', { class: 'cdl-ctl' }, [ctl])]);
  }

  // ── About & Backup actions ──────────────────────────────────────────────────
  function makeBackupSection(rerender) {
    var exportBtn = el('button', { type: 'button', class: 'cdl-btn' }, [svg(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'], 15), el('span', { text: 'Export settings' })]);
    exportBtn.addEventListener('click', function () {
      try {
        var json = S.exportJSON ? S.exportJSON() : '';
        var go = function (txt) {
          var blob = new Blob([txt], { type: 'application/json' });
          var a = el('a', { href: URL.createObjectURL(blob), download: 'comix-downloader-settings.json' });
          document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); }, 0);
        };
        if (json && typeof json.then === 'function') json.then(go); else go(json);
      } catch (_) {}
    });

    var importBtn = el('button', { type: 'button', class: 'cdl-btn' }, [svg(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'], 15), el('span', { text: 'Import settings' })]);
    var file = el('input', { type: 'file', accept: 'application/json,.json' });
    file.style.display = 'none';
    importBtn.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try { var p = S.importJSON(String(r.result)); if (p && p.then) p.then(rerender); else rerender(); } catch (_) {}
      };
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

  // ── build the whole extension settings view ─────────────────────────────────
  function buildView(cur) {
    var onChange = function (key, value) {
      var patch = {}; patch[key] = value;
      try { var p = S.patchSettings(patch); if (p && p.then) p.catch(function () {}); } catch (_) {}
    };
    var head = el('div', { class: 'uview__head' }, [
      el('h2', { class: 'uview__title', text: 'Comix Downloader' }),
      el('p', { class: 'uview__sub', text: 'Settings for the browser extension — separate from comix.to, saved instantly on your device.' }),
    ]);
    var view = el('div', { class: 'uview', id: VIEW_ID }, [head]);

    (S.TABS || []).forEach(function (tab) {
      var keys = (tab.keys || []).filter(function (k) { return S.SCHEMA[k]; });
      if (!keys.length) return;
      var sec = el('section', { class: 'usettings__section' }, [
        el('h3', { class: 'usettings__section-title', text: tab.label }),
      ]);
      keys.forEach(function (k) { sec.appendChild(makeRow(k, cur, onChange)); });
      view.appendChild(sec);
    });
    view.appendChild(makeBackupSection(activate));
    return view;
  }

  // ── nav + view switching ────────────────────────────────────────────────────
  function ensureNavItem() {
    var list = navList();
    if (!list || document.getElementById(NAV_ID)) return;
    if (!document.querySelector('.cdl-umenu-sep')) {
      list.appendChild(el('li', { class: 'cdl-umenu-sep', text: 'Extension' }));
    }
    var btn = el('button', { type: 'button', class: 'umenu__item', id: NAV_ID }, [
      el('span', { class: 'umenu__icon' }, [svg(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'], 16)]),
      el('span', { class: 'umenu__text', text: 'Comix Downloader' }),
    ]);
    btn.addEventListener('click', activate);
    list.appendChild(el('li', {}, [btn]));
  }

  function activate() {
    injectStyle();
    var box = contentBox(); if (!box) return;
    // hide comix's current view
    var cv = comixView();
    if (cv) { hiddenComixView = cv; cv.style.display = 'none'; }
    var old = document.getElementById(VIEW_ID); if (old) old.remove();
    S.getSettings().then(function (cur) {
      // guard: user may have navigated away while loading
      if (!document.getElementById(NAV_ID)) return;
      var existing = document.getElementById(VIEW_ID); if (existing) existing.remove();
      contentBox().appendChild(buildView(cur || {}));
      setActiveNav(true);
      try { box.scrollTop = 0; window.scrollTo(0, box.getBoundingClientRect().top + window.scrollY - 80); } catch (_) {}
    });
  }

  function deactivate() {
    var v = document.getElementById(VIEW_ID); if (v) v.remove();
    if (hiddenComixView) { try { hiddenComixView.style.display = ''; } catch (_) {} hiddenComixView = null; }
    setActiveNav(false);
  }

  function setActiveNav(on) {
    var ours = document.getElementById(NAV_ID);
    document.querySelectorAll('.umenu__item.is-active').forEach(function (b) { if (b !== ours) b.classList.toggle('is-active', !on); });
    if (ours) ours.classList.toggle('is-active', on);
  }

  // Clicking any of comix's own menu items hands control back to comix.
  document.addEventListener('click', function (e) {
    var item = e.target && e.target.closest && e.target.closest('.umenu__item');
    if (item && item.id !== NAV_ID && document.getElementById(VIEW_ID)) deactivate();
  }, true);

  // ── lifecycle (SPA-aware) ───────────────────────────────────────────────────
  function sync() {
    if (onSettingsPage()) { startWatching(); ensureNavItem(); }
    else { stopWatching(); deactivate(); var n = document.getElementById(NAV_ID); if (n && n.parentElement) n.parentElement.remove(); var sep = document.querySelector('.cdl-umenu-sep'); if (sep) sep.remove(); }
  }
  function startWatching() {
    if (!pollTimer) {
      var tries = 0;
      pollTimer = setInterval(function () {
        ensureNavItem();
        // keep our view alive if comix re-rendered it away while ours is active
        if (document.getElementById(NAV_ID) && document.getElementById(NAV_ID).classList.contains('is-active') && !document.getElementById(VIEW_ID)) activate();
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
})();
