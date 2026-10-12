/**
 * cdl-confirm.js - confirmation warnings the developer switches on from the notices admin
 * page, one per feature (the notices Worker's "confirmations"). Before such a feature
 * starts, CDLConfirm.ask(feature) shows each active warning for it, and the "plus" one too
 * when it is a Plus feature, with Cancel and a continue button. It resolves true only when
 * every warning was confirmed, and true at once when none is active.
 *
 * Loaded in content scripts (comix pages, isolated world: nothing is added to the page's
 * own window) and in the popup and settings pages. Warnings come with the notices document
 * content_notices.js reads on every comix page; when that copy is older than ten minutes
 * the document is read again here.
 */
(function (root) {
  'use strict';
  if (root.CDLConfirm) return;

  var API_URL = 'https://comix-downloader-badge.comixdl.workers.dev/v1/notices';
  var CACHE_KEY = 'cdlConfirmations';
  var FRESH_MS = 10 * 60 * 1000;
  var FETCH_TIMEOUT_MS = 3000;
  var FEATURES = [
    'download-all', 'download-selected', 'download-chapter',
    'plus', 'plus-cloud-save', 'plus-cloud-library', 'plus-agenda', 'plus-sync',
  ];
  var PLUS_FEATURES = ['plus-cloud-save', 'plus-cloud-library', 'plus-agenda', 'plus-sync'];
  var queue = Promise.resolve();

  function text(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
  }

  // Active warnings by feature, from the Worker's list.
  function clean(list) {
    var out = {};
    (Array.isArray(list) ? list : []).forEach(function (raw) {
      if (!raw || typeof raw !== 'object' || raw.active === false) return;
      var feature = text(raw.feature, 40);
      var title = text(raw.title, 120);
      var message = text(raw.message, 1200);
      if (FEATURES.indexOf(feature) < 0 || !title || !message || out[feature]) return;
      out[feature] = { feature: feature, title: title, message: message, confirmLabel: text(raw.confirmLabel, 40) || 'Continue anyway' };
    });
    return out;
  }

  function storage() {
    try {
      return root.chrome && root.chrome.storage && root.chrome.storage.local ? root.chrome.storage.local : null;
    } catch (_) {
      return null;
    }
  }

  function readCache() {
    return new Promise(function (resolve) {
      var local = storage();
      if (!local) return resolve(null);
      try {
        local.get(CACHE_KEY, function (got) { resolve((got && got[CACHE_KEY]) || null); });
      } catch (_) {
        resolve(null);
      }
    });
  }

  // Keeps the warnings from a notices document the extension just read.
  function remember(list) {
    var entry = { fetchedAt: Date.now(), items: clean(list) };
    var local = storage();
    if (local) {
      try {
        var payload = {};
        payload[CACHE_KEY] = entry;
        local.set(payload);
      } catch (_) {}
    }
    return entry;
  }

  async function fetchLatest() {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS) : null;
    try {
      var res = await fetch(API_URL, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller ? controller.signal : undefined,
      });
      if (!res.ok) return null;
      var data = await res.json();
      return remember(data && data.confirmations);
    } catch (_) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function current() {
    var cached = await readCache();
    if (cached && Date.now() - (Number(cached.fetchedAt) || 0) < FRESH_MS) return cached.items || {};
    var latest = await fetchLatest();
    return ((latest || cached) && (latest || cached).items) || {};
  }

  var STYLE = [
    ':host { all: initial; }',
    '.overlay { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 16px;',
    '  background: rgba(8, 10, 14, 0.62); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }',
    '.card { width: min(480px, 100%); max-height: calc(100vh - 32px); overflow: auto; border-radius: 8px;',
    '  background: #ffffff; color: #17202d; box-shadow: 0 28px 80px rgba(0, 0, 0, 0.48); }',
    '.bar { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: #111827; color: #f8fafc;',
    '  border-bottom: 3px solid #f59e0b; font-weight: 700; }',
    '.bar svg { width: 20px; height: 20px; flex: none; color: #fbbf24; }',
    '.body { padding: 18px 20px 20px; }',
    '.title { margin: 0 0 8px; font-size: 19px; line-height: 1.25; font-weight: 750; }',
    '.message { margin: 0 0 20px; white-space: pre-line; color: #334155; }',
    '.actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; }',
    'button { font: 600 14px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 11px 16px;',
    '  border-radius: 6px; cursor: pointer; }',
    '.cancel { background: #ffffff; color: #17202d; border: 1px solid #cbd5e1; }',
    '.cancel:hover { background: #f3f5f7; }',
    '.confirm { background: #111827; color: #ffffff; border: 1px solid #111827; }',
    '.confirm:hover { background: #273449; }',
    'button:focus-visible { outline: 3px solid rgba(34, 211, 238, 0.6); outline-offset: 2px; }',
    '.note { margin-top: 14px; font-size: 12px; color: #64748b; }',
    '@media (max-width: 420px) { .actions > button { flex: 1 1 140px; } }',
  ].join('\n');

  function element(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.textContent = content;
    return node;
  }

  function warningIcon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M12 9v4M12 17h.01M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0z');
    svg.appendChild(path);
    return svg;
  }

  // One warning on screen; resolves true for the continue button, false otherwise.
  function show(item) {
    return new Promise(function (resolve) {
      var host = document.createElement('div');
      var shadow = host.attachShadow({ mode: 'closed' });
      var style = document.createElement('style');
      style.textContent = STYLE;
      var overlay = element('div', 'overlay');
      var card = element('section', 'card');
      card.setAttribute('role', 'alertdialog');
      card.setAttribute('aria-modal', 'true');
      var bar = element('div', 'bar');
      bar.append(warningIcon(), element('span', '', 'Comix Downloader'));
      var body = element('div', 'body');
      var title = element('h2', 'title', item.title);
      title.id = 'cdl-confirm-title';
      var message = element('p', 'message', item.message);
      message.id = 'cdl-confirm-message';
      card.setAttribute('aria-labelledby', title.id);
      card.setAttribute('aria-describedby', message.id);
      var actions = element('div', 'actions');
      var cancel = element('button', 'cancel', 'Cancel');
      cancel.type = 'button';
      var confirm = element('button', 'confirm', item.confirmLabel);
      confirm.type = 'button';
      actions.append(cancel, confirm);
      var note = element('p', 'note', 'Sent by the Comix Downloader extension. Not a Comix site message.');
      body.append(title, message, actions, note);
      card.append(bar, body);
      overlay.appendChild(card);
      shadow.append(style, overlay);

      var done = false;
      function finish(result) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        host.remove();
        resolve(result);
      }
      function onKey(event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      }
      cancel.addEventListener('click', function () { finish(false); });
      confirm.addEventListener('click', function () { finish(true); });
      overlay.addEventListener('click', function (event) { if (event.target === overlay) finish(false); });
      document.addEventListener('keydown', onKey, true);
      (document.body || document.documentElement).appendChild(host);
      cancel.focus();
    });
  }

  async function askNow(feature) {
    if (FEATURES.indexOf(feature) < 0) return true;
    var items;
    try {
      items = await current();
    } catch (_) {
      return true;
    }
    var keys = [feature];
    if (PLUS_FEATURES.indexOf(feature) >= 0) keys.push('plus');
    for (var i = 0; i < keys.length; i++) {
      if (items[keys[i]] && !(await show(items[keys[i]]))) return false;
    }
    return true;
  }

  // Warnings asked for at the same time wait for each other instead of stacking.
  function ask(feature) {
    var next = queue.then(function () { return askNow(feature); });
    queue = next.catch(function () {});
    return next;
  }

  root.CDLConfirm = { ask: ask, remember: remember, FEATURES: FEATURES.slice() };
})(typeof globalThis !== 'undefined' ? globalThis : this);
