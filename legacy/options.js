/**
 * options.js — Comix Downloader settings page (V2.0.0)
 *
 * Builds the whole UI from CDLSettings.SCHEMA / TABS so the page never drifts
 * from the source of truth. Changes are staged in a draft and only persisted on
 * Save; risky/glitchy changes require an explicit confirmation first.
 */
'use strict';

(function () {
  var S = window.CDLSettings;
  var current = {};   // last-saved settings
  var draft = {};     // staged edits
  var controls = {};  // key -> { setValue, setEnabled, row }

  // Separate storage keys (NOT in cdlSettings — validate() would drop them). Track the
  // one-time "what's new" notices set by background.js on update.
  var NOTICE_KEY = 'cdlFeaturesNotice';              // Additional Features tab
  var NOTICE_KEY_CONCURRENCY = 'cdlConcurrencyNotice'; // "Chapters at once" on the Download tab
  var noticeActive = false;
  var concurrencyNoticeActive = false;

  // ── Tiny DOM helpers ──────────────────────────────────────────────────────
  // Swap a node's children from a trusted HTML string without using innerHTML.
  // Values here are internal icon SVGs + escapeHtml()'d text; DOMParser('text/html')
  // never runs scripts and isn't an innerHTML sink, so the AMO/CWS linters stay clean.
  function _setHTML(node, html) {
    var parsed = new DOMParser().parseFromString(html, 'text/html');
    node.replaceChildren.apply(node, parsed.body.childNodes);
  }
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'html') _setHTML(node, attrs[k]);
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }
  function clone(o) { var r = {}; for (var k in o) r[k] = o[k]; return r; }

  var ICONS = {
    box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/>',
    gauge: '<path d="M12 14l4-4"/><path d="M20.7 17a9 9 0 1 0-17.4 0"/>',
    repeat: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    tag: '<path d="M20.6 13.4L11 3.8A2 2 0 0 0 9.6 3H4a1 1 0 0 0-1 1v5.6a2 2 0 0 0 .6 1.4l9.6 9.6a2 2 0 0 0 2.8 0l4.6-4.6a2 2 0 0 0 0-2.6z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
    brush: '<path d="M3 21c3 0 5-2 5-5 0-1.5-1-2.5-2.5-2.5S3 14.5 3 16"/><path d="M14 3l7 7-9 9"/>',
    warn: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17"/>',
    info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12" y2="8"/>',
    sparkles: '<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M18.5 13.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>'
  };
  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || ICONS.info) + '</svg>';
  }

  // Tabs that need extra (non-schema) content appended.
  var TAB_INTRO = {
    download: 'How "Download All" packages a full series into ZIP files.',
    output: 'Output format and metadata — make downloads drop-in ready for Komga, Kavita, Mihon, YACReader. You can also pick these per-download from the on-page panel.',
    perf: 'Network pacing and timeouts. The defaults are tuned for comix.to — change them only if you have a reason to.',
    retry: 'What happens when an image or chapter fails to download.',
    naming: 'File and folder names inside the ZIPs.',
    appearance: 'Customize the on-page download buttons and the progress panel.',
    advanced: 'Powerful options that can break downloads or hurt quality. Read each warning.',
    features: 'Extra tweaks that make comix.to nicer to use — not about downloading. All off by default, so turn on what you like.',
    sync: 'Watch subscribed series for new chapters, and optionally push finished CBZ files to your own media server (Komga / Kavita via a watched folder).',
    about: 'Back up your configuration, and information about the extension.'
  };

  // Rows that are only meaningful when another setting has a certain value.
  var DEPENDS = {
    'download.chaptersPerPart': function () { return draft['download.splitMode'] === 'multipart'; },
    'download.mbPerPart':       function () { return draft['download.splitMode'] === 'multipart'; },
    'perf.rateBaseMs':          function () { return draft['perf.rateLimitMode'] !== 'off'; },
    'perf.rateMinMs':           function () { return draft['perf.rateLimitMode'] === 'dynamic'; },
    'perf.rateMaxMs':           function () { return draft['perf.rateLimitMode'] === 'dynamic'; },
    'appearance.accentColor':   function () { return draft['appearance.accentMode'] === 'custom'; },
    'advanced.jpgQuality':      function () { return draft['advanced.imageFormat'] === 'jpg'; },
    'subscribe.intervalMinutes': function () { return !!draft['subscribe.enabled']; },
    'subscribe.notify':          function () { return !!draft['subscribe.enabled']; },
    'subscribe.autoDownload':    function () { return !!draft['subscribe.enabled']; },
    'home.sections':       function () { return !!draft['home.customLayout']; },
    'home.hero':           function () { return !!draft['home.customLayout']; },
    'home.heroSource':     function () { return !!draft['home.customLayout'] && draft['home.hero'] !== 'off'; },
    'home.heroSkipRead':   function () { return !!draft['home.customLayout'] && draft['home.hero'] !== 'off'; },
    'home.cardStyle':      function () { return !!draft['home.customLayout']; },
    'home.rows':           function () { return !!draft['home.customLayout']; },
    'home.density':        function () { return !!draft['home.customLayout']; },
    'home.showProgress':   function () { return !!draft['home.customLayout']; },
    'home.itemsPerSection': function () { return !!draft['home.customLayout']; },
    'home.openInNewTab':   function () { return !!draft['home.customLayout']; },
    'home.greeting':       function () { return !!draft['home.customLayout']; },
    'home.hoverPreview':   function () { return !!draft['home.customLayout']; }
  };

  // Sample context for live template previews.
  var PREVIEW_CTX = {
    'naming.chapterFolderFmt': { num: '12', rest: '', chapter: '12', manga: 'Solo Leveling' },
    'naming.singleZipTpl':     { manga: 'Solo Leveling', chapter: '12' },
    'naming.allZipTpl':        { manga: 'Solo Leveling' }
  };

  // ── Build a single control for a setting key ──────────────────────────────
  function buildControl(key) {
    var s = S.SCHEMA[key];
    var id = 'c_' + key.replace(/\W/g, '_');
    var wrap = el('div', { class: 'row-control' });
    var api = { setValue: function () {}, setEnabled: function () {}, input: null };

    function commit(v) { setDraft(key, v); }

    if (s.type === 'sectionList') {
      var labels = {}; (s.sections || []).forEach(function (sec) { labels[sec.id] = sec.label; });
      var items = [];
      var list = el('div', { class: 'seclist' });
      function commitList() { commit(items.map(function (x) { return { id: x.id, on: !!x.on }; })); }
      function moveItem(i, j) { if (j < 0 || j >= items.length) return; var t = items[i]; items[i] = items[j]; items[j] = t; commitList(); renderList(); }
      function renderList() {
        list.textContent = '';
        items.forEach(function (it, idx) {
          var cb = el('input', { type: 'checkbox', onchange: function () { items[idx].on = cb.checked; row.className = 'sec-row' + (cb.checked ? ' is-on' : ''); commitList(); } });
          cb.checked = !!it.on;
          var up = el('button', { type: 'button', class: 'sec-move', title: 'Move up', text: '↑', onclick: function () { moveItem(idx, idx - 1); } });
          var dn = el('button', { type: 'button', class: 'sec-move', title: 'Move down', text: '↓', onclick: function () { moveItem(idx, idx + 1); } });
          if (idx === 0) up.disabled = true;
          if (idx === items.length - 1) dn.disabled = true;
          var row = el('div', { class: 'sec-row' + (it.on ? ' is-on' : '') }, [
            el('span', { class: 'sec-ord' }, [up, dn]),
            el('label', { class: 'sec-main' }, [cb, el('span', { class: 'sec-name', text: labels[it.id] || it.id })])
          ]);
          list.appendChild(row);
        });
      }
      wrap.appendChild(list);
      api.setValue = function (v) { items = (S.validateValue ? S.validateValue(key, v) : (v || [])).map(function (x) { return { id: x.id, on: !!x.on }; }); renderList(); };
      api.setEnabled = function (on) { wrap.querySelectorAll('input,button').forEach(function (n) { n.disabled = !on; }); if (on) renderList(); };

    } else if (s.type === 'bool') {
      var cb = el('input', { type: 'checkbox', id: id, onchange: function () { commit(cb.checked); api.label.textContent = cb.checked ? 'On' : 'Off'; } });
      var sw = el('label', { class: 'switch' }, [cb, el('span', { class: 'track' })]);
      api.label = el('span', { class: 'switch-label' });
      wrap.appendChild(sw); wrap.appendChild(api.label);
      api.setValue = function (v) { cb.checked = !!v; api.label.textContent = v ? 'On' : 'Off'; };
      api.setEnabled = function (on) { cb.disabled = !on; };

    } else if (s.type === 'enum') {
      var sel = el('select', { id: id, onchange: function () { commit(sel.value); } });
      s.enum.forEach(function (opt) {
        var lbl = (s.options && s.options[opt]) || opt;
        sel.appendChild(el('option', { value: opt, text: lbl }));
      });
      wrap.appendChild(sel);
      api.setValue = function (v) { sel.value = v; };
      api.setEnabled = function (on) { sel.disabled = !on; };

    } else if (s.type === 'color') {
      var col = el('input', { type: 'color', id: id, onchange: function () { commit(col.value); hex.value = col.value.toUpperCase(); } });
      var hex = el('input', { type: 'text', class: 'hex', maxlength: '7', onchange: function () {
        var v = S.validateValue(key, hex.value); commit(v); col.value = v; hex.value = v.toUpperCase();
      } });
      wrap.appendChild(col); wrap.appendChild(hex);
      api.setValue = function (v) { col.value = v; hex.value = String(v).toUpperCase(); };
      api.setEnabled = function (on) { col.disabled = !on; hex.disabled = !on; };

    } else if (s.type === 'string' || s.type === 'template') {
      var txt = el('input', { type: 'text', id: id, maxlength: String(s.maxLen || 80),
        oninput: function () { commit(txt.value); } });
      wrap.appendChild(txt);
      api.setValue = function (v) { txt.value = v == null ? '' : v; };
      api.setEnabled = function (on) { txt.disabled = !on; };

    } else if (s.type === 'float' || (s.type === 'int' && (s.max - s.min) <= 64)) {
      var step = s.step || (s.type === 'float' ? 0.05 : 1);
      var rng = el('input', { type: 'range', id: id, min: String(s.min), max: String(s.max), step: String(step),
        oninput: function () { var v = parseFloat(rng.value); readout.textContent = fmt(v); commit(v); } });
      var readout = el('span', { class: 'range-val' });
      function fmt(v) { return s.type === 'float' ? (key === 'appearance.btnScale' ? v.toFixed(2) + '×' : v.toFixed(2)) : String(Math.round(v)); }
      wrap.appendChild(rng); wrap.appendChild(readout);
      api.setValue = function (v) { rng.value = v; readout.textContent = fmt(parseFloat(v)); };
      api.setEnabled = function (on) { rng.disabled = !on; };

    } else { // large int → number field
      var step2 = s.step || (s.max > 5000 ? 500 : 1);
      var num = el('input', { type: 'number', id: id, min: String(s.min), max: String(s.max), step: String(step2),
        onchange: function () { var v = S.validateValue(key, num.value); commit(v); num.value = v; } });
      wrap.appendChild(num);
      api.setValue = function (v) { num.value = v; };
      api.setEnabled = function (on) { num.disabled = !on; };
    }

    api.el = wrap;
    api.id = id;
    return api;
  }

  // ── Build one setting row ─────────────────────────────────────────────────
  function buildRow(key) {
    var s = S.SCHEMA[key];
    var ctl = buildControl(key);
    var head = el('div', { class: 'row-head' }, [
      el('label', { class: 'row-label', for: ctl.id, text: s.label })
    ]);
    if (s.risk && s.risk !== 'none') head.appendChild(el('span', { class: 'badge ' + s.risk, text: s.risk }));

    var row = el('div', { class: 'row', 'data-key': key }, [
      head,
      el('p', { class: 'row-help', text: s.help || '' }),
      ctl.el
    ]);

    if (s.type === 'template') {
      var prev = el('p', { class: 'preview' });
      row.appendChild(prev);
      ctl.preview = prev;
    }
    if (s.warn) {
      row.appendChild(el('div', { class: 'warn-note ' + s.risk, html: icon('warn') + '<span>' + escapeHtml(s.warn) + '</span>' }));
    }

    controls[key] = {
      setValue: ctl.setValue,
      setEnabled: ctl.setEnabled,
      preview: ctl.preview,
      row: row
    };
    return row;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── Extra content for the About & Backup tab ──────────────────────────────
  function buildAboutExtras(panel) {
    var backup = el('div', { class: 'section' }, [
      el('h3', { text: 'Backup' }),
      el('p', { text: 'Export your settings to a file, or import a previously saved file. Importing replaces your current settings.' }),
      el('div', { class: 'btn-group' }, [
        el('button', { class: 'btn', id: 'btn-export', type: 'button', html: icon('box') + 'Export settings' }),
        el('button', { class: 'btn', id: 'btn-import', type: 'button', html: icon('repeat') + 'Import settings' })
      ])
    ]);

    var reset = el('div', { class: 'section' }, [
      el('h3', { text: 'Reset' }),
      el('p', { text: 'Restore every setting to its default value. This cannot be undone.' }),
      el('div', { class: 'btn-group' }, [
        el('button', { class: 'btn danger', id: 'btn-reset', type: 'button', html: icon('warn') + 'Reset to defaults' })
      ])
    ]);

    var m = chrome.runtime.getManifest();
    var about = el('div', { class: 'section' }, [
      el('h3', { text: 'About' }),
      el('p', { class: 'about-meta', html: '<strong>' + escapeHtml(m.name) + '</strong> · version ' + escapeHtml(m.version) + ' · MIT License' }),
      el('div', { class: 'links' }, [
        link('https://github.com/N3uralCreativity/comix-downloader', 'GitHub repository'),
        link('https://n3uralcreativity.github.io/comix-downloader/index.html', 'Project website'),
        link('https://addons.mozilla.org/en-US/firefox/addon/comix-chapter-downloader/', 'Firefox Add-on'),
        link('https://chromewebstore.google.com/detail/nojjjpmicodkodnnllbdolpglhlclpdp', 'Chrome Web Store')
      ])
    ]);

    panel.appendChild(backup);
    panel.appendChild(reset);
    panel.appendChild(about);

    panel.querySelector('#btn-export').addEventListener('click', onExport);
    panel.querySelector('#btn-import').addEventListener('click', function () { document.getElementById('import-file').click(); });
    panel.querySelector('#btn-reset').addEventListener('click', onReset);
  }
  function link(href, text) {
    return el('a', { href: href, target: '_blank', rel: 'noopener', html: icon('info') + escapeHtml(text) });
  }

  // ── Sync tab extras: Push-to-library config + Subscriptions list ───────────
  var LIBRARY_KEY = 'cdlLibrary';
  function originPattern(url) {
    // No port in the pattern: match patterns with an explicit port are invalid
    // on Firefox, and a portless pattern matches every port on both browsers.
    try { var u = new URL(url); return u.protocol + '//' + u.hostname + '/*'; } catch (e) { return null; }
  }
  function buildSyncExtras(panel) {
    // Push-to-library
    var enable = el('input', { type: 'checkbox', id: 'lib-enabled' });
    var endpoint = el('input', { type: 'text', id: 'lib-endpoint', placeholder: 'https://server.example/webdav/comics' });
    var method = el('select', { id: 'lib-method' }, [
      el('option', { value: 'PUT', text: 'PUT (WebDAV / most servers)' }),
      el('option', { value: 'POST', text: 'POST' })
    ]);
    var user = el('input', { type: 'text', id: 'lib-user', placeholder: 'username (optional)' });
    var pass = el('input', { type: 'password', id: 'lib-pass', placeholder: 'password / token (optional)' });
    var status = el('p', { class: 'row-help', id: 'lib-status', text: '' });

    var lib = el('div', { class: 'section' }, [
      el('h3', { text: 'Push to library (CBZ → Komga / Kavita)' }),
      el('p', { text: 'After each chapter is built as CBZ, upload it to your own server (a WebDAV or HTTP folder your library watches). Files go to <base>/<Series>/<file>.cbz. This is the only feature that sends data off your machine — see the privacy page.' }),
      el('label', { class: 'switch-row', html: '' }, [enable, el('span', { class: 'switch-label', text: 'Enable push after download' })]),
      el('div', { class: 'lib-grid' }, [
        el('label', { text: 'Endpoint URL' }), endpoint,
        el('label', { text: 'Method' }), method,
        el('label', { text: 'Username' }), user,
        el('label', { text: 'Password' }), pass
      ]),
      el('div', { class: 'btn-group' }, [
        el('button', { class: 'btn primary', id: 'lib-save', type: 'button', html: icon('box') + 'Save & grant access' }),
        el('button', { class: 'btn', id: 'lib-test', type: 'button', html: icon('repeat') + 'Test connection' })
      ]),
      status
    ]);
    panel.appendChild(lib);

    // Subscriptions
    var subStatus = el('p', { class: 'row-help', id: 'sub-status', text: '' });
    var subWrap = el('div', { class: 'section' }, [
      el('h3', { text: 'Subscriptions' }),
      el('p', { text: 'Series you subscribed to from their title page. Background checks look for new chapters (see settings above).' }),
      el('div', { id: 'sub-list' }, [el('p', { class: 'row-help', text: 'Loading…' })]),
      el('div', { class: 'btn-group' }, [
        el('button', { class: 'btn', id: 'sub-check', type: 'button', html: icon('repeat') + 'Check now' })
      ]),
      subStatus
    ]);
    panel.appendChild(subWrap);

    // Load saved library config
    try {
      chrome.storage.local.get(LIBRARY_KEY, function (res) {
        var c = (res && res[LIBRARY_KEY]) || {};
        enable.checked = !!c.enabled;
        endpoint.value = c.endpoint || '';
        method.value = c.method === 'POST' ? 'POST' : 'PUT';
        user.value = c.username || '';
        pass.value = c.password || '';
      });
    } catch (e) {}

    lib.querySelector('#lib-save').addEventListener('click', function () {
      var cfg = { enabled: enable.checked, endpoint: endpoint.value.trim(), method: method.value,
        username: user.value, password: pass.value };
      if (cfg.enabled && !/^https?:\/\//i.test(cfg.endpoint)) { status.textContent = 'Enter a valid http(s) endpoint URL first.'; return; }
      var save = function (note) {
        var payload = {}; payload[LIBRARY_KEY] = cfg;
        chrome.storage.local.set(payload, function () { status.textContent = note || 'Saved.'; });
      };
      // The button promises "grant access": request the host permission whenever
      // a valid endpoint is set, even if the push toggle is still off — so a
      // user can grant + Test first and only then enable.
      var pat = /^https?:\/\//i.test(cfg.endpoint) ? originPattern(cfg.endpoint) : null;
      if (pat) {
        try {
          chrome.permissions.request({ origins: [pat] }, function (granted) {
            if (!granted) { status.textContent = 'Permission to reach that server was declined — push will not work.'; return; }
            save(cfg.enabled ? 'Saved — access granted.' : 'Saved — access granted. Tick "Enable push after download" to activate it.');
          });
        } catch (e) { save(); }
      } else { save(); }
    });

    lib.querySelector('#lib-test').addEventListener('click', function () {
      status.textContent = 'Testing…';
      try {
        chrome.runtime.sendMessage({ action: 'libraryTest', config: {
          endpoint: endpoint.value.trim(), method: method.value, username: user.value, password: pass.value
        } }, function (res) {
          if (chrome.runtime.lastError || !res) { status.textContent = 'Test failed: no response.'; return; }
          status.textContent = res.ok ? ('✓ Server reachable (HTTP ' + res.status + ').') : ('✗ ' + (res.error || ('HTTP ' + res.status)));
        });
      } catch (e) { status.textContent = 'Test failed.'; }
    });

    var timeAgo = function (ts) {
      if (!ts) return 'waiting for first check';
      var mins = Math.round((Date.now() - ts) / 60000);
      if (mins < 1) return 'checked just now';
      if (mins < 60) return 'checked ' + mins + ' min ago';
      var h = Math.round(mins / 60);
      if (h < 48) return 'checked ' + h + ' h ago';
      return 'checked ' + Math.round(h / 24) + ' d ago';
    };
    var refreshSubs = function () {
      chrome.storage.local.get('cdlSubscriptions', function (res) {
        var subs = (res && res.cdlSubscriptions) || {};
        var listEl = document.getElementById('sub-list');
        if (!listEl) return;
        listEl.innerHTML = '';
        var slugs = Object.keys(subs).sort(function (a, b) {
          return String((subs[a] || {}).mangaName || a).localeCompare(String((subs[b] || {}).mangaName || b));
        });
        if (!slugs.length) {
          listEl.appendChild(el('p', { class: 'row-help', text: 'No subscriptions yet. Open a series on comix.to and click "☆ Subscribe" next to the Download All button.' }));
          return;
        }
        slugs.forEach(function (slug) {
          var s = subs[slug] || {};
          var bits = [];
          bits.push(s.lastSeen && s.lastSeen.length ? s.lastSeen.length + ' chapters tracked' : 'no chapters tracked yet');
          bits.push(timeAgo(s.lastCheck));
          if (s.lastStatus === 'blocked') bits.push('⚠ last check was blocked — open comix.to once, then retry');
          var row = el('div', { class: 'sub-row' }, [
            el('div', { class: 'sub-info' }, [
              el('a', { class: 'sub-name', href: 'https://comix.to/title/' + encodeURIComponent(slug), target: '_blank', rel: 'noopener', text: s.mangaName || slug }),
              el('span', { class: 'sub-meta', text: bits.join(' · ') })
            ]),
            el('button', { class: 'btn danger', type: 'button', text: 'Unsubscribe', onclick: function () {
              chrome.runtime.sendMessage({ action: 'unsubscribe', slug: slug }, refreshSubs);
            } })
          ]);
          listEl.appendChild(row);
        });
      });
    };
    subWrap.querySelector('#sub-check').addEventListener('click', function () {
      var b = document.getElementById('sub-check');
      b.disabled = true;
      subStatus.textContent = 'Checking…';
      chrome.runtime.sendMessage({ action: 'checkSubscriptionsNow' }, function (res) {
        b.disabled = false;
        refreshSubs();
        if (chrome.runtime.lastError || !res || !res.ok) { subStatus.textContent = 'Check failed — try again.'; return; }
        var s = res.summary || {};
        var parts = ['Checked ' + (s.checked || 0) + ' series'];
        parts.push((s.newChapters || 0) + ' new chapter' + (s.newChapters === 1 ? '' : 's'));
        if (s.blocked) parts.push(s.blocked + ' blocked by the site (open comix.to once, then retry)');
        subStatus.textContent = parts.join(' · ') + '.';
      });
    });
    refreshSubs();
    // Keep the list live: background checks update cdlSubscriptions while this page is open.
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && changes.cdlSubscriptions) refreshSubs();
      });
    } catch (e) {}
  }

  // ── Build the whole page ──────────────────────────────────────────────────
  function buildUI() {
    var sidebar = document.getElementById('sidebar');
    var content = document.getElementById('content');
    sidebar.innerHTML = '';
    content.innerHTML = '';

    S.TABS.forEach(function (tab, idx) {
      var navBtn = el('button', { class: 'nav-item' + (idx === 0 ? ' active' : ''), 'data-tab': tab.id, type: 'button',
        html: icon(tab.icon) + '<span>' + escapeHtml(tab.label) + '</span>',
        onclick: function () { selectTab(tab.id); } });
      sidebar.appendChild(navBtn);

      var panel = el('section', { class: 'panel' + (idx === 0 ? ' active' : ''), 'data-tab': tab.id }, [
        el('div', { class: 'panel-head' }, [
          el('h2', { text: tab.label }),
          el('p', { text: TAB_INTRO[tab.id] || '' })
        ])
      ]);
      tab.keys.forEach(function (key) { if (S.SCHEMA[key]) panel.appendChild(buildRow(key)); });
      if (tab.id === 'about') buildAboutExtras(panel);
      if (tab.id === 'sync') buildSyncExtras(panel);
      content.appendChild(panel);
    });
  }

  function selectTab(id) {
    document.querySelectorAll('.nav-item').forEach(function (n) { n.classList.toggle('active', n.getAttribute('data-tab') === id); });
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.toggle('active', p.getAttribute('data-tab') === id); });
    document.getElementById('content').scrollTo ? window.scrollTo(0, 0) : null;
    if (id === 'features') clearFeaturesNotice();
    if (id === 'download') clearConcurrencyNotice();
  }

  // ── Draft / sync ──────────────────────────────────────────────────────────
  function setDraft(key, value) {
    draft[key] = S.validateValue(key, value);
    refreshDependents();
    updatePreview(key);
    updateDirty();
  }

  function refreshDependents() {
    for (var key in DEPENDS) {
      if (controls[key]) controls[key].setEnabled(DEPENDS[key]());
      var row = controls[key] && controls[key].row;
      if (row) row.classList.toggle('disabled', !DEPENDS[key]());
    }
  }

  function updatePreview(key) {
    if (!controls[key] || !controls[key].preview) return;
    var maxLen = S.SCHEMA[key].maxLen || 80;
    var out = S.renderName(draft[key], PREVIEW_CTX[key] || {}, maxLen);
    var node = controls[key].preview;
    node.textContent = 'Preview: ';
    node.appendChild(el('code', { text: out }));
  }

  // Push every value from `draft` into the controls (after load / reset / import).
  function syncControls() {
    for (var key in controls) {
      if (Object.prototype.hasOwnProperty.call(draft, key)) controls[key].setValue(draft[key]);
    }
    refreshDependents();
    for (var k2 in PREVIEW_CTX) updatePreview(k2);
  }

  function changedKeys() {
    return Object.keys(draft).filter(function (k) { return draft[k] !== current[k]; });
  }

  function updateDirty() {
    var n = changedKeys().length;
    var bar = document.getElementById('savebar');
    bar.hidden = n === 0;
    document.getElementById('savebar-msg').textContent =
      n === 1 ? '1 unsaved change' : n + ' unsaved changes';
  }

  // ── Save / discard / reset / backup ───────────────────────────────────────
  function onSave() {
    var changed = changedKeys();
    if (!changed.length) return;
    var warned = changed.filter(function (k) { return S.SCHEMA[k] && S.SCHEMA[k].warn && S.SCHEMA[k].risk !== 'none'; });

    var proceed = function () {
      S.saveSettings(draft).then(function (saved) {
        current = clone(saved);
        draft = clone(saved);
        syncControls();
        updateDirty();
        toast('Settings saved', 'ok');
      }).catch(function () { toast('Could not save settings', 'error'); });
    };

    if (warned.length) {
      var list = el('div', { class: 'warn-list' });
      warned.forEach(function (k) {
        var sc = S.SCHEMA[k];
        list.appendChild(el('div', { class: 'warn-note ' + sc.risk,
          html: '<span><strong>' + escapeHtml(sc.label) + '</strong> — ' + escapeHtml(sc.warn) + '</span>' }));
      });
      openModal({
        title: 'Apply these changes?',
        bodyNodes: [el('p', { text: 'Some of the changes you are saving can affect reliability or quality:' }), list],
        confirmLabel: 'Apply changes',
        danger: true,
        onConfirm: proceed
      });
    } else {
      proceed();
    }
  }

  function onDiscard() {
    draft = clone(current);
    syncControls();
    updateDirty();
    toast('Changes discarded');
  }

  function onReset() {
    openModal({
      title: 'Reset all settings?',
      bodyNodes: [el('p', { text: 'Every setting will return to its default value. Any customizations you made will be lost. This cannot be undone.' })],
      confirmLabel: 'Reset to defaults',
      danger: true,
      onConfirm: function () {
        S.resetDefaults().then(function (def) {
          current = clone(def);
          draft = clone(def);
          syncControls();
          updateDirty();
          toast('Settings reset to defaults', 'ok');
        }).catch(function () { toast('Could not reset settings', 'error'); });
      }
    });
  }

  function onExport() {
    S.exportJSON().then(function (json) {
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = el('a', { href: url, download: 'comix-downloader-settings.json' });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast('Settings exported', 'ok');
    });
  }

  function onImportFile(ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    var reset = function () { ev.target.value = ''; };
    file.text().then(function (text) {
      openModal({
        title: 'Import settings?',
        bodyNodes: [el('p', { text: 'This replaces all your current settings with the contents of "' + file.name + '".' })],
        confirmLabel: 'Import',
        danger: true,
        onCancel: reset,
        onConfirm: function () {
          S.importJSON(text).then(function (saved) {
            current = clone(saved);
            draft = clone(saved);
            syncControls();
            updateDirty();
            toast('Settings imported', 'ok');
          }).catch(function (e) { toast(e.message || 'Import failed', 'error'); }).then(reset);
        }
      });
    }).catch(function () { toast('Could not read that file', 'error'); reset(); });
  }

  // ── Modal & toast ─────────────────────────────────────────────────────────
  var modalConfirmCb = null, modalCancelCb = null;
  function openModal(opts) {
    document.getElementById('modal-title').textContent = opts.title || '';
    var body = document.getElementById('modal-body');
    body.innerHTML = '';
    (opts.bodyNodes || []).forEach(function (n) { body.appendChild(n); });
    var confirm = document.getElementById('modal-confirm');
    confirm.textContent = opts.confirmLabel || 'Confirm';
    confirm.className = 'btn ' + (opts.danger ? 'danger' : 'primary');
    modalConfirmCb = opts.onConfirm || null;
    modalCancelCb = opts.onCancel || null;
    document.getElementById('modal').hidden = false;
    confirm.focus();
  }
  function closeModal(runCancel) {
    document.getElementById('modal').hidden = true;
    if (runCancel && modalCancelCb) modalCancelCb();
    modalConfirmCb = null; modalCancelCb = null;
  }

  function toast(msg, kind) {
    var wrap = document.getElementById('toast-wrap');
    var t = el('div', { class: 'toast' + (kind ? ' ' + kind : ''), text: msg });
    wrap.appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity .25s'; }, 2200);
    setTimeout(function () { t.remove(); }, 2600);
  }

  // ── "New Additional Features page" one-time notice ────────────────────────
  function readFeaturesNotice() {
    try {
      chrome.storage.local.get(NOTICE_KEY, function (res) {
        var n = res && res[NOTICE_KEY];
        if (n && n.active) { noticeActive = true; showFeaturesNotice(); }
      });
    } catch (e) {}
  }

  function showFeaturesNotice() {
    var nav = document.querySelector('.nav-item[data-tab="features"]');
    if (nav) nav.classList.add('has-badge');
    var panel = document.querySelector('.panel[data-tab="features"]');
    if (panel && !panel.querySelector('.features-banner')) {
      var banner = el('div', { class: 'features-banner', html: icon('sparkles') +
        '<span><strong>New page.</strong> These comix.to enhancements were just added — all off by default. Turn on what you like.</span>' });
      var head = panel.querySelector('.panel-head');
      if (head) head.insertAdjacentElement('afterend', banner);
      else panel.insertBefore(banner, panel.firstChild);
    }
  }

  function clearFeaturesNotice() {
    if (!noticeActive) return;
    noticeActive = false;
    var nav = document.querySelector('.nav-item[data-tab="features"]');
    if (nav) nav.classList.remove('has-badge');
    var banner = document.querySelector('.panel[data-tab="features"] .features-banner');
    if (banner) banner.remove();
    try {
      var payload = {};
      payload[NOTICE_KEY] = { active: false, seenVersion: chrome.runtime.getManifest().version };
      chrome.storage.local.set(payload);
    } catch (e) {}
    clearToolbarBadgeUnless(NOTICE_KEY_CONCURRENCY);
  }

  // ── "Chapters at once" one-time notice (Download tab) ─────────────────────
  function readConcurrencyNotice() {
    try {
      chrome.storage.local.get(NOTICE_KEY_CONCURRENCY, function (res) {
        var n = res && res[NOTICE_KEY_CONCURRENCY];
        if (!n || !n.active) return;
        concurrencyNoticeActive = true;
        showConcurrencyNotice();
        // The Download tab is shown by default, so the banner is on screen the
        // moment Settings opens. Persist "seen" now so it won't nag next time,
        // but leave it visible for this session (keepDom).
        clearConcurrencyNotice(true);
      });
    } catch (e) {}
  }

  function showConcurrencyNotice() {
    var nav = document.querySelector('.nav-item[data-tab="download"]');
    if (nav) nav.classList.add('has-badge');
    var panel = document.querySelector('.panel[data-tab="download"]');
    if (panel && !panel.querySelector('.features-banner')) {
      var banner = el('div', { class: 'features-banner', html: icon('sparkles') +
        '<span><strong>New:</strong> “Download All” can now fetch several chapters at the same time — see <strong>Chapters at once</strong> below. ' +
        'Heads-up: 2 at once is already risky, and 3–4 will most likely get your IP temporarily blocked by comix.to.</span>' });
      var head = panel.querySelector('.panel-head');
      if (head) head.insertAdjacentElement('afterend', banner);
      else panel.insertBefore(banner, panel.firstChild);
    }
  }

  function clearConcurrencyNotice(keepDom) {
    if (!concurrencyNoticeActive) return;
    concurrencyNoticeActive = false;
    if (!keepDom) {
      var nav = document.querySelector('.nav-item[data-tab="download"]');
      if (nav) nav.classList.remove('has-badge');
      var banner = document.querySelector('.panel[data-tab="download"] .features-banner');
      if (banner) banner.remove();
    }
    try {
      var payload = {};
      payload[NOTICE_KEY_CONCURRENCY] = { active: false, seenVersion: chrome.runtime.getManifest().version };
      chrome.storage.local.set(payload);
    } catch (e) {}
    clearToolbarBadgeUnless(NOTICE_KEY);
  }

  // Clear the toolbar "NEW" badge only if the OTHER notice isn't still active.
  // (We check the key we did NOT just modify, so there's no read-after-write race.)
  function clearToolbarBadgeUnless(otherKey) {
    try {
      chrome.storage.local.get(otherKey, function (res) {
        var other = res && res[otherKey];
        if (other && other.active) return;
        try { if (chrome.action && chrome.action.setBadgeText) chrome.action.setBadgeText({ text: '' }); } catch (e) {}
      });
    } catch (e) {}
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    if (!S) { document.getElementById('content').textContent = 'Settings module failed to load.'; return; }
    var m = chrome.runtime.getManifest();
    document.getElementById('ver').textContent = 'v' + m.version;

    buildUI();
    readFeaturesNotice();
    readConcurrencyNotice();

    document.getElementById('btn-save').addEventListener('click', onSave);
    document.getElementById('btn-discard').addEventListener('click', onDiscard);
    document.getElementById('import-file').addEventListener('change', onImportFile);

    document.getElementById('modal-confirm').addEventListener('click', function () {
      var cb = modalConfirmCb; closeModal(false); if (cb) cb();
    });
    document.getElementById('modal-cancel').addEventListener('click', function () { closeModal(true); });
    document.getElementById('modal').addEventListener('click', function (e) {
      if (e.target === this) closeModal(true);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !document.getElementById('modal').hidden) closeModal(true);
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); onSave(); }
    });
    window.addEventListener('beforeunload', function (e) {
      if (changedKeys().length) { e.preventDefault(); e.returnValue = ''; }
    });

    S.getSettings().then(function (loaded) {
      current = clone(loaded);
      draft = clone(loaded);
      syncControls();
      updateDirty();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
