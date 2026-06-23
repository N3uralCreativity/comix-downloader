/**
 * cdl-embed-settings.js — embeds the extension's settings page inside comix.to's
 * own settings page (comix.to/user?tab=settings), under a clearly-labelled
 * divider so it's obvious which settings belong to the site and which to the
 * extension. The standalone options.html tab keeps working independently — both
 * are live in parallel.
 *
 * comix.to is a client-rendered SPA: tab/route changes don't reload the page, so
 * we watch history + the DOM and (un)inject as the user moves in and out of the
 * settings tab. The actual settings UI is the real options page loaded in an
 * iframe (options.html?embed=1), which reports its height back so the frame
 * sizes to its content with no inner scrollbar.
 */
(function () {
  'use strict';
  if (window.top !== window) return; // never run inside our own iframe

  var SECTION_ID = 'cdl-ext-settings';
  var STYLE_ID = 'cdl-ext-settings-style';
  var FRAME_ID = 'cdl-ext-settings-frame';
  var pollTimer = null;
  var bodyObserver = null;

  // The settings tab is active when its sections are in the DOM. We also accept
  // the ?tab=settings URL as a hint, but the DOM is the source of truth (comix
  // is an SPA and may swap tabs without always updating the query string).
  function onSettingsPage() {
    if (document.querySelector('.usettings__section')) return true;
    return /\/user(?:\/|$)/.test(location.pathname) &&
           /(?:^|[?&])tab=settings(?:&|$)/.test(location.search);
  }

  // comix renders the settings tab as:
  //   <div class="user-content"><div class="uview">
  //     <div class="uview__head">…Settings…</div>
  //     <section class="usettings__section">…</section> … </div></div>
  // We append our block as the last child of that .uview so it sits right after
  // the site's own settings. Text-matching is kept as a defensive fallback.
  // EDIT POINT: if the panel lands in the wrong place, tune this function.
  function findAnchor() {
    var sec = document.querySelector('.usettings__section');
    if (sec) {
      var view = (sec.closest && sec.closest('.uview')) || sec.parentElement;
      if (view) return view;
    }
    var uc = document.querySelector('.user-content .uview') || document.querySelector('.user-content');
    if (uc) return uc;
    // Fallback: anchor on a known label and climb to its column.
    var nodes = document.querySelectorAll('h2,h3,p,div,section');
    for (var i = 0; i < nodes.length; i++) {
      var t = (nodes[i].textContent || '').trim();
      if (/^Control which sections/.test(t) || t === 'Profile visibility') {
        var el = nodes[i];
        for (var d = 0; d < 6 && el.parentElement; d++) {
          el = el.parentElement;
          if (/\b(uview|user-content)\b/.test(el.className || '')) return el;
        }
        return nodes[i].parentElement;
      }
    }
    return null;
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent =
      '#' + SECTION_ID + '{margin:22px 0 8px;}' +
      '#' + SECTION_ID + ' .cdl-ext-head{display:flex;align-items:center;gap:10px;' +
        'padding:12px 14px;border:1px solid rgba(255,255,255,0.07);border-bottom:none;' +
        'border-radius:10px 10px 0 0;background:var(--surface,#202326);}' +
      '#' + SECTION_ID + ' .cdl-ext-head svg{width:18px;height:18px;color:var(--accent,#8765eb);flex-shrink:0;}' +
      '#' + SECTION_ID + ' .cdl-ext-htext{display:flex;flex-direction:column;gap:2px;min-width:0;}' +
      '#' + SECTION_ID + ' .cdl-ext-title{font-weight:700;font-size:14px;color:var(--text-emphasis,#f5f5f5);}' +
      '#' + SECTION_ID + ' .cdl-ext-sub{font-size:12px;color:var(--text-2,#a0a0a0);}' +
      '#' + SECTION_ID + ' iframe{display:block;width:100%;height:480px;border:1px solid rgba(255,255,255,0.07);' +
        'border-radius:0 0 10px 10px;background:var(--bg,#181a1c);color-scheme:dark;}';
    (document.head || document.documentElement).appendChild(s);
  }

  function buildSection() {
    var wrap = document.createElement('div');
    wrap.id = SECTION_ID;

    var head = document.createElement('div');
    head.className = 'cdl-ext-head';

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    var p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p1.setAttribute('d', 'M12 15V3'); // download glyph
    var p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p2.setAttribute('d', 'M7 10l5 5 5-5');
    var p3 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p3.setAttribute('d', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4');
    svg.appendChild(p3); svg.appendChild(p2); svg.appendChild(p1);

    var htext = document.createElement('div');
    htext.className = 'cdl-ext-htext';
    var title = document.createElement('div');
    title.className = 'cdl-ext-title';
    title.textContent = 'Comix Downloader — Extension settings';
    var sub = document.createElement('div');
    sub.className = 'cdl-ext-sub';
    sub.textContent = 'Everything below belongs to the browser extension, not comix.to.';
    htext.appendChild(title); htext.appendChild(sub);

    head.appendChild(svg); head.appendChild(htext);

    var frame = document.createElement('iframe');
    frame.id = FRAME_ID;
    frame.setAttribute('title', 'Comix Downloader extension settings');
    frame.src = chrome.runtime.getURL('options.html') + '?embed=1';

    wrap.appendChild(head);
    wrap.appendChild(frame);
    return wrap;
  }

  function tryInject() {
    if (!onSettingsPage()) return;
    if (document.getElementById(SECTION_ID)) return; // already there
    var anchor = findAnchor();
    if (!anchor) return; // settings panel not rendered yet — poll will retry
    injectStyle();
    anchor.appendChild(buildSection());
  }

  function remove() {
    var el = document.getElementById(SECTION_ID);
    if (el) el.remove();
  }

  // Size the frame to its content (reported via postMessage from options.js).
  window.addEventListener('message', function (e) {
    if (!e || !e.data || e.data.type !== 'cdl-embed-height') return;
    var frame = document.getElementById(FRAME_ID);
    if (frame && e.source === frame.contentWindow) {
      frame.style.height = Math.max(220, e.data.height | 0) + 'px';
    }
  });

  function onRouteChange() {
    if (onSettingsPage()) {
      startWatching();
      tryInject();
    } else {
      stopWatching();
      remove();
    }
  }

  // While on the settings tab, poll briefly (the panel renders async) and watch
  // for comix re-rendering the column out from under us.
  function startWatching() {
    if (!pollTimer) {
      var tries = 0;
      pollTimer = setInterval(function () {
        tryInject();
        if (document.getElementById(SECTION_ID) || ++tries > 40) { clearInterval(pollTimer); pollTimer = null; }
      }, 250);
    }
    if (!bodyObserver && document.body) {
      bodyObserver = new MutationObserver(function () {
        if (onSettingsPage() && !document.getElementById(SECTION_ID)) tryInject();
      });
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    }
  }
  function stopWatching() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (bodyObserver) { bodyObserver.disconnect(); bodyObserver = null; }
  }

  // SPA route detection: patch history + listen for pop/hash changes.
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    history[m] = function () {
      var r = orig.apply(this, arguments);
      try { window.dispatchEvent(new Event('cdl:locationchange')); } catch (_) {}
      return r;
    };
  });
  window.addEventListener('popstate', onRouteChange);
  window.addEventListener('hashchange', onRouteChange);
  window.addEventListener('cdl:locationchange', onRouteChange);

  onRouteChange(); // initial
})();
