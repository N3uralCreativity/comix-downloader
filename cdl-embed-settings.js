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
  var hiddenComixView = null;
  var pollTimer = null;
  var observer = null;
  var autoChecked = false;
  var savedToast = null, savedTimer = null;

  // Sample context for live naming-template previews (mirrors the options page).
  var PREVIEW_CTX = {
    'naming.chapterFolderFmt': { num: '12', rest: '', chapter: '12', manga: 'Solo Leveling' },
    'naming.singleZipTpl': { manga: 'Solo Leveling', chapter: '12' },
    'naming.allZipTpl': { manga: 'Solo Leveling' },
  };

  // Conditional controls — greyed out when their condition isn't met (mirrors the
  // standalone options page so irrelevant settings don't mislead).
  var DEPENDS = {
    'download.chaptersPerPart': function (d) { return d['download.splitMode'] === 'multipart'; },
    'download.mbPerPart': function (d) { return d['download.splitMode'] === 'multipart'; },
    'perf.rateBaseMs': function (d) { return d['perf.rateLimitMode'] !== 'off'; },
    'perf.rateMinMs': function (d) { return d['perf.rateLimitMode'] === 'dynamic'; },
    'perf.rateMaxMs': function (d) { return d['perf.rateLimitMode'] === 'dynamic'; },
    'appearance.accentColor': function (d) { return d['appearance.accentMode'] === 'custom'; },
    'advanced.jpgQuality': function (d) { return d['advanced.imageFormat'] === 'jpg'; },
    'subscribe.intervalMinutes': function (d) { return !!d['subscribe.enabled']; },
    'subscribe.notify': function (d) { return !!d['subscribe.enabled']; },
    'subscribe.autoDownload': function (d) { return !!d['subscribe.enabled']; },
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
  function getLocal(key) {
    return new Promise(function (res) { try { chrome.storage.local.get(key, function (r) { res((r && r[key]) || null); }); } catch (_) { res(null); } });
  }
  function setLocal(key, val) { var o = {}; o[key] = val; try { chrome.storage.local.set(o); } catch (_) {} }
  function send(msg) { return new Promise(function (res) { try { chrome.runtime.sendMessage(msg, function (r) { res(chrome.runtime.lastError ? null : r); }); } catch (_) { res(null); } }); }

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
      '#' + VIEW_ID + ' .cdl-sub-item{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid rgba(255,255,255,.06);}' +
      '#' + VIEW_ID + ' .cdl-sub-name{font-weight:600;color:var(--text,#d4d4d4);}' +
      '#' + VIEW_ID + ' .cdl-sub-meta{font-size:11.5px;color:var(--text-3,#8a8a8a);margin-left:auto;}' +
      '#' + VIEW_ID + ' .cdl-sub-x{background:none;border:none;color:var(--text-3,#8a8a8a);cursor:pointer;font-size:16px;line-height:1;padding:2px 6px;border-radius:6px;}' +
      '#' + VIEW_ID + ' .cdl-sub-x:hover{color:#ef9a9a;background:rgba(239,68,68,.1);}' +
      '#' + VIEW_ID + ' .cdl-foot{margin-top:8px;font-size:11.5px;color:var(--text-3,#8a8a8a);}' +
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

  // ── build the whole extension settings view ─────────────────────────────────
  function buildView(cur, lib, subs) {
    var draft = Object.assign({}, S.DEFAULTS, cur);
    var rowEls = {};
    var applyDeps = function () {
      Object.keys(DEPENDS).forEach(function (k) { var r = rowEls[k]; if (r) r.classList.toggle('cdl-disabled', !DEPENDS[k](draft)); });
    };
    var onChange = function (key, value) {
      draft[key] = value;
      var p = {}; p[key] = value;
      try { var r = S.patchSettings(p); if (r && r.then) r.catch(function () {}); } catch (_) {}
      flashSaved(); applyDeps();
    };
    var view = el('div', { class: 'uview', id: VIEW_ID }, [
      el('div', { class: 'uview__head' }, [
        el('h2', { class: 'uview__title', text: 'Comix Downloader' }),
        el('p', { class: 'uview__sub', text: 'Settings for the browser extension — separate from comix.to, saved instantly on your device.' }),
      ]),
    ]);
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
    applyDeps();
    return view;
  }

  // ── nav + view switching ────────────────────────────────────────────────────
  function ensureNavItem() {
    var list = navList();
    if (!list || document.getElementById(NAV_ID)) return;
    if (!document.querySelector('.cdl-umenu-sep')) list.appendChild(el('li', { class: 'cdl-umenu-sep', text: 'Extension' }));
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
    var cv = comixView(); if (cv) { hiddenComixView = cv; cv.style.display = 'none'; }
    var old = document.getElementById(VIEW_ID); if (old) old.remove();
    Promise.all([S.getSettings(), getLocal('cdlLibrary'), getLocal('cdlSubscriptions')]).then(function (r) {
      if (!document.getElementById(NAV_ID)) return;
      var existing = document.getElementById(VIEW_ID); if (existing) existing.remove();
      contentBox().appendChild(buildView(r[0] || {}, r[1] || {}, r[2] || {}));
      setActiveNav(true);
      try { window.scrollTo(0, box.getBoundingClientRect().top + window.scrollY - 80); } catch (_) {}
    });
  }

  function deactivate() {
    var v = document.getElementById(VIEW_ID); if (v) v.remove();
    if (hiddenComixView) { try { hiddenComixView.style.display = ''; } catch (_) {} hiddenComixView = null; }
    setActiveNav(false);
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
          activate();
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
    var go = function () { location.href = 'https://comix.to/user?tab=settings'; };
    try { chrome.storage.local.set({ cdlOpenExtSettings: Date.now() }, go); } catch (_) { go(); }
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
        if (n && n.classList.contains('is-active') && !document.getElementById(VIEW_ID)) activate();
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
})();
