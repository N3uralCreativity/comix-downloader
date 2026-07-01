/**
 * content_features.js — Comix Downloader "Additional Features" (V2.0.2)
 *
 * Runs on *://comix.to/title/* alongside content_title.js (loaded after it). IIFE-wrapped
 * so its top-level declarations can never collide with content_title.js's global `const`s.
 *
 * Three independently-toggled, OFF-by-default site enhancements:
 *   - features.dedupeChapters      : hide duplicate chapters in the title list (list page)
 *   - features.enforceChapterOrder : force ascending numeric order in the list (list page)
 *   - features.fixReaderNav        : accurate next/prev with source switching (reader page)
 *
 * Design rules:
 *   - Pure correctness lives in CDLFeaturesCore (DOM-free, unit-tested).
 *   - Never remove/move React-managed nodes for hiding; hide via a CSS class. Reordering
 *     prefers CSS `order` (flex/grid) and only does a guarded DOM move when every child is
 *     one of our rows.
 *   - Every feature degrades to a SILENT no-op on any error and fully cleans up when its
 *     toggle is turned off (no page reload needed).
 */
(function () {
  'use strict';

  if (typeof CDLSettings === 'undefined' || typeof CDLFeaturesCore === 'undefined') return;
  var Core = CDLFeaturesCore;

  var CHAPTER_LINK_SEL = 'a[href*="/title/"]';
  var CHAPTER_HREF_RE = /\/\d+-chapter-/i;
  var STYLE_ID = 'cdl-features-style';
  var HIDDEN_CLASS = 'cdl-dupe-hidden';
  var MAX_PAGES = 100;

  // comix.to is a Next.js SPA; the page type can change without a content-script
  // re-run, so derive it from location.pathname on demand instead of once at load.
  //   'reader' = /title/{slug}/{numericId}, 'list' = /title/{slug}, else 'other'.
  function currentPageType() {
    var p = location.pathname.split('/').filter(Boolean);
    if (p[0] !== 'title' || !p[1]) return 'other';
    if (p.length >= 3 && /^\d+/.test(p[2])) return 'reader';
    return 'list';
  }
  var isReader = currentPageType() === 'reader';

  var cfg = Object.assign({}, CDLSettings.DEFAULTS);

  // ── List-page state ─────────────────────────────────────────────────────────
  var applying = false;
  var listObserver = null;
  var listDebounce = null;
  var domReorderedContainers = new Set();
  var originalOrderMap = new WeakMap();

  // ── Reader-page state ────────────────────────────────────────────────────────
  var readerState = null;
  var routeDebounce = null;
  var pageHealthState = null; // { url, broken:{}, seen:WeakSet, observer, banner, debounce, dismissed }
  var PAGE_IMG_SEL = 'img.rpage-page__img, img[alt^="Page"]';

  // ════════════════════════ shared helpers ════════════════════════
  function absolute(path) {
    try { return new URL(path, location.origin).href; } catch (e) { return ''; }
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = '.' + HIDDEN_CLASS + '{display:none !important;}';
    (document.head || document.documentElement).appendChild(style);
  }
  function removeStyleIfUnused() {
    if (!cfg['features.dedupeChapters'] && !cfg['features.enforceChapterOrder']) {
      var s = document.getElementById(STYLE_ID);
      if (s) s.remove();
    }
  }

  // ════════════════════════ list page: dedup + order ════════════════════════
  function getChaptersRoot() {
    var heading = [].slice.call(document.querySelectorAll('h1, h2, h3'))
      .find(function (el) { return /^chapters$/i.test((el.textContent || '').trim()); });
    return (heading && heading.closest('section')) || document.body;
  }

  function chapterLinksIn(root) {
    return [].slice.call(root.querySelectorAll(CHAPTER_LINK_SEL))
      .filter(function (a) { return CHAPTER_HREF_RE.test(a.getAttribute('href') || a.href || ''); });
  }

  // The row element representing a chapter (mirrors content_title.js injectButtonForRow).
  function rowOf(link) {
    return link.closest('li, tr, [class*="mchap"], [class*="chapter"]') || link.parentElement || link;
  }

  function collectRows(root) {
    var out = [];
    var seenRows = new Set();
    chapterLinksIn(root).forEach(function (link) {
      var row = rowOf(link);
      if (!row || seenRows.has(row)) return;
      seenRows.add(row);
      var href = link.getAttribute('href') || link.href || '';
      var p = Core.parseChapterNumber(href);
      var key = Core.dedupeKey(p);
      if (row.getAttribute('data-cdl-key') !== key) row.setAttribute('data-cdl-key', key);
      row.setAttribute('data-cdl-num', String(p.value));
      out.push({ row: row, key: key, parsed: p });
    });
    return out;
  }

  // Lightweight undo used when both list features are off — never tags rows.
  function cleanupListFeatures() {
    [].slice.call(document.querySelectorAll('.' + HIDDEN_CLASS)).forEach(function (el) {
      el.classList.remove(HIDDEN_CLASS);
    });
    clearOrder(null);
  }

  function applyListFeatures() {
    if (applying) return;
    applying = true;
    try {
      var root = getChaptersRoot();
      var rows = collectRows(root);

      // ── dedup (diff-before-write to avoid observer churn) ──
      if (cfg['features.dedupeChapters']) {
        var seen = Object.create(null);
        rows.forEach(function (r) {
          var dup = !!seen[r.key];
          seen[r.key] = true;
          var hidden = r.row.classList.contains(HIDDEN_CLASS);
          if (dup && !hidden) r.row.classList.add(HIDDEN_CLASS);
          else if (!dup && hidden) r.row.classList.remove(HIDDEN_CLASS);
        });
      } else {
        rows.forEach(function (r) {
          if (r.row.classList.contains(HIDDEN_CLASS)) r.row.classList.remove(HIDDEN_CLASS);
        });
      }

      // ── order ──
      if (cfg['features.enforceChapterOrder']) applyOrder(rows);
      else clearOrder(rows);
    } catch (e) { /* no-op */ } finally {
      applying = false;
    }
  }

  function applyOrder(rows) {
    if (!rows.length) return;
    var byContainer = new Map();
    rows.forEach(function (r) {
      var c = r.row.parentElement;
      if (!c) return;
      if (!byContainer.has(c)) byContainer.set(c, []);
      byContainer.get(c).push(r);
    });
    byContainer.forEach(function (list, container) {
      try {
        var sorted = list.slice().sort(function (a, b) { return Core.compareChapters(a.parsed, b.parsed); });
        var display = '';
        try { display = (getComputedStyle(container).display || ''); } catch (e) {}
        if (/flex|grid/.test(display)) {
          // CSS order — structure untouched, diff before write
          sorted.forEach(function (r, i) {
            var val = String(i);
            if (r.row.style.order !== val) r.row.style.order = val;
          });
        } else {
          // Guarded DOM reorder — only when EVERY child is one of our rows.
          var children = [].slice.call(container.children);
          var managed = new Set(list.map(function (r) { return r.row; }));
          if (children.length !== managed.size || !children.every(function (ch) { return managed.has(ch); })) return;
          var sortedRows = sorted.map(function (r) { return r.row; });
          var same = children.length === sortedRows.length && children.every(function (n, idx) { return n === sortedRows[idx]; });
          if (same) return; // already ordered — no mutation
          if (!originalOrderMap.has(container)) {
            originalOrderMap.set(container, children.slice());
            domReorderedContainers.add(container);
          }
          var frag = document.createDocumentFragment();
          sortedRows.forEach(function (n) { frag.appendChild(n); });
          container.appendChild(frag);
        }
      } catch (e) { /* skip this container */ }
    });
  }

  function clearOrder(rows) {
    if (rows) rows.forEach(function (r) { if (r.row.style.order) r.row.style.order = ''; });
    // also clear any stray inline order we may have set on now-uncollected rows
    [].slice.call(document.querySelectorAll('[data-cdl-num]')).forEach(function (el) {
      if (el.style.order) el.style.order = '';
    });
    // restore DOM-reordered containers to their snapshotted order
    domReorderedContainers.forEach(function (container) {
      var original = originalOrderMap.get(container);
      if (!original) return;
      try {
        var frag = document.createDocumentFragment();
        original.forEach(function (node) { frag.appendChild(node); });
        container.appendChild(frag);
      } catch (e) {}
    });
    domReorderedContainers.clear();
  }

  function startListObserver() {
    if (listObserver) return;
    listObserver = new MutationObserver(function (mutations) {
      if (applying) return;
      var relevant = false;
      for (var i = 0; i < mutations.length && !relevant; i++) {
        var mut = mutations[i];
        if (mut.type !== 'childList') continue;
        var nodes = [].slice.call(mut.addedNodes).concat([].slice.call(mut.removedNodes));
        for (var j = 0; j < nodes.length; j++) {
          var n = nodes[j];
          if (n.nodeType !== 1) continue;
          if ((n.matches && n.matches(CHAPTER_LINK_SEL)) || (n.querySelector && n.querySelector(CHAPTER_LINK_SEL))) { relevant = true; break; }
        }
      }
      if (!relevant || listDebounce) return;
      listDebounce = setTimeout(function () { listDebounce = null; applyListFeatures(); }, 100);
    });
    listObserver.observe(document.body, { childList: true, subtree: true });
  }
  function stopListObserver() {
    if (listObserver) { listObserver.disconnect(); listObserver = null; }
    if (listDebounce) { clearTimeout(listDebounce); listDebounce = null; }
  }

  // ════════════════════════ reader page: accurate next/prev ════════════════════════
  async function fetchAllChapterEntries(slug) {
    var urls = new Set();
    var buildId = null, payload = '';
    var nextEl = document.getElementById('__NEXT_DATA__');
    if (nextEl) {
      payload = nextEl.textContent || '';
      try { buildId = JSON.parse(payload).buildId; } catch (e) {}
    }
    Core.extractChapterPaths(payload).forEach(function (p) { var u = absolute(p); if (u) urls.add(u); });

    if (buildId && slug) {
      for (var page = 1; page <= MAX_PAGES; page++) {
        var text = '';
        try {
          var r = await fetch('/_next/data/' + buildId + '/title/' + slug + '.json?page=' + page, { headers: { Accept: 'application/json' } });
          if (!r.ok) break;
          text = await r.text();
        } catch (e) { break; }
        var found = Core.extractChapterPaths(text).map(absolute).filter(Boolean);
        if (!found.length) break;
        var fresh = 0;
        for (var k = 0; k < found.length; k++) { if (!urls.has(found[k])) { urls.add(found[k]); fresh++; } }
        if (!fresh && page > 1) break;
      }
    }

    var prefix = '/title/' + slug + '/';
    var out = [];
    urls.forEach(function (u) {
      try { if (new URL(u).pathname.indexOf(prefix) === 0) out.push({ chapterUrl: u }); } catch (e) {}
    });
    return out;
  }

  function currentSlug() { return location.pathname.split('/').filter(Boolean)[1] || ''; }

  async function startReaderNav() {
    if (readerState) return;
    readerState = { entries: null, entriesSlug: null, patched: [], navObserver: null, navDebounce: null, nextUrl: null, prevUrl: null };
    patchHistoryOnce();
    window.addEventListener('cdl:locationchange', onReaderRouteChange);
    window.addEventListener('popstate', onReaderRouteChange);
    await refreshReaderNav();
  }

  async function refreshReaderNav() {
    if (!readerState) return;
    try {
      var slug = currentSlug();
      if (!readerState.entries || readerState.entriesSlug !== slug) {
        readerState.entries = await fetchAllChapterEntries(slug);
        readerState.entriesSlug = slug;
      }
      if (!readerState) return; // toggled off while awaiting
      var entries = readerState.entries || [];
      var cur = location.href;
      var nextNode = Core.computeAdjacentChapter(entries, cur, 1);
      var prevNode = Core.computeAdjacentChapter(entries, cur, -1);
      readerState.nextUrl = nextNode ? Core.pickCandidateUrl(nextNode, cur) : null;
      readerState.prevUrl = prevNode ? Core.pickCandidateUrl(prevNode, cur) : null;
      patchNavControls();
      if (readerState.patched.length) stopNavObserver();
      else observeNavControls();
    } catch (e) { /* no-op */ }
  }

  // Locate next/prev clickable controls, most-reliable signal first.
  function findNavControls(dir) {
    var isNext = dir === 'next';
    var tiers = [];

    var ariaSel = isNext ? '[aria-label*="next" i]' : '[aria-label*="prev" i],[aria-label*="previous" i]';
    tiers.push([].slice.call(document.querySelectorAll(ariaSel)));

    tiers.push([].slice.call(document.querySelectorAll('[class*="rpage"]')).filter(function (el) {
      var c = (typeof el.className === 'string' ? el.className : '').toLowerCase();
      return isNext ? /next/.test(c) : /prev/.test(c);
    }));

    var words = isNext ? ['next', '›', '»', '→', '▶', '⟩'] : ['prev', 'previous', '‹', '«', '←', '◀', '⟨'];
    tiers.push([].slice.call(document.querySelectorAll('a, button, [role="button"]')).filter(function (el) {
      var t = (el.getAttribute('aria-label') || el.title || el.textContent || '').trim().toLowerCase();
      if (!t || t.length > 12) return false;
      return words.indexOf(t) !== -1;
    }));

    for (var i = 0; i < tiers.length; i++) {
      var clickables = tiers[i].map(function (el) {
        if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') return el;
        return el.closest('a, button, [role="button"]');
      }).filter(Boolean);
      var uniq = Array.from(new Set(clickables));
      if (uniq.length) return uniq;
    }
    return [];
  }

  function patchOne(elm, url) {
    if (!elm || elm.getAttribute('data-cdl-nav') === '1') return;
    var isAnchor = elm.tagName === 'A';
    var origHref = isAnchor ? elm.getAttribute('href') : null;
    var handler = function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      location.assign(url);
    };
    elm.addEventListener('click', handler, true); // capture beats the site's React handler
    if (isAnchor) elm.setAttribute('href', url);
    elm.setAttribute('data-cdl-nav', '1');
    readerState.patched.push({ elm: elm, handler: handler, isAnchor: isAnchor, origHref: origHref });
  }

  function patchNavControls() {
    if (!readerState) return;
    unpatchNavControls();
    if (readerState.nextUrl) findNavControls('next').forEach(function (el) { patchOne(el, readerState.nextUrl); });
    if (readerState.prevUrl) findNavControls('prev').forEach(function (el) { patchOne(el, readerState.prevUrl); });
  }

  function unpatchNavControls() {
    if (!readerState) return;
    (readerState.patched || []).forEach(function (p) {
      try {
        p.elm.removeEventListener('click', p.handler, true);
        p.elm.removeAttribute('data-cdl-nav');
        if (p.isAnchor) {
          if (p.origHref == null) p.elm.removeAttribute('href');
          else p.elm.setAttribute('href', p.origHref);
        }
      } catch (e) {}
    });
    readerState.patched = [];
  }

  function observeNavControls() {
    if (!readerState || readerState.navObserver) return;
    var obs = new MutationObserver(function () {
      if (!readerState || readerState.navDebounce) return;
      readerState.navDebounce = setTimeout(function () {
        if (!readerState) return;
        readerState.navDebounce = null;
        patchNavControls();
        if (readerState.patched.length) stopNavObserver();
      }, 200);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    readerState.navObserver = obs;
  }
  function stopNavObserver() {
    if (!readerState) return;
    if (readerState.navObserver) { readerState.navObserver.disconnect(); readerState.navObserver = null; }
    if (readerState.navDebounce) { clearTimeout(readerState.navDebounce); readerState.navDebounce = null; }
  }

  function onReaderRouteChange() {
    if (!readerState) return;
    if (routeDebounce) clearTimeout(routeDebounce);
    routeDebounce = setTimeout(function () { routeDebounce = null; refreshReaderNav(); }, 150);
  }

  function patchHistoryOnce() {
    try {
      if (history.pushState && history.pushState.__cdlPatched) return;
      ['pushState', 'replaceState'].forEach(function (m) {
        var orig = history[m];
        if (typeof orig !== 'function' || orig.__cdlPatched) return;
        var wrapped = function () {
          var ret = orig.apply(this, arguments);
          try { window.dispatchEvent(new Event('cdl:locationchange')); } catch (e) {}
          return ret;
        };
        wrapped.__cdlPatched = true;
        wrapped.__cdlOrig = orig;
        history[m] = wrapped;
      });
    } catch (e) {}
  }
  function stopReaderNav() {
    if (!readerState) return;
    unpatchNavControls();
    stopNavObserver();
    window.removeEventListener('cdl:locationchange', onReaderRouteChange);
    window.removeEventListener('popstate', onReaderRouteChange);
    if (routeDebounce) { clearTimeout(routeDebounce); routeDebounce = null; }
    // NOTE: the history pushState/replaceState patch is intentionally NOT removed
    // here. It is now a session-wide concern: content_title.js and applyForPage()
    // rely on cdl:locationchange for the whole SPA session, not just reader nav.
    readerState = null;
  }

  // ════════════════════════ reader page: keyboard shortcuts ════════════════════════
  // Opt-in. J / → = next chapter, K / ← = previous chapter, D = download current.
  // Self-contained (works whether or not fixReaderNav is on); ignored while typing.
  var kbState = null;

  function getReaderMangaName() {
    var h = document.querySelector('h1');
    var t = (h && (h.textContent || '').trim()) || (document.title || '').replace(/\s*[-|].*$/, '').trim();
    return t || currentSlug() || 'manga';
  }
  function readerChapterLabel() {
    var p = Core.parseChapterNumber(location.href);
    if (p && p.kind === 'num' && isFinite(p.value)) return 'Ch' + p.value;
    var m = location.pathname.match(/\d+-chapter-([\w.-]+)/i);
    return m ? 'Ch' + m[1] : 'chapter';
  }
  async function kbResolveEntries() {
    var slug = currentSlug();
    if (readerState && readerState.entries && readerState.entriesSlug === slug) return readerState.entries;
    if (kbState && kbState.entries && kbState.slug === slug) return kbState.entries;
    var entries = await fetchAllChapterEntries(slug);
    if (kbState) { kbState.entries = entries; kbState.slug = slug; }
    return entries;
  }
  async function kbNavigate(direction) {
    try {
      var entries = await kbResolveEntries();
      var node = Core.computeAdjacentChapter(entries, location.href, direction);
      var url = node ? Core.pickCandidateUrl(node, location.href) : null;
      if (url) location.assign(url);
    } catch (e) { /* no-op */ }
  }
  function kbDownloadCurrent() {
    if (!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id)) return;
    var manga = getReaderMangaName();
    var label = readerChapterLabel();
    try {
      chrome.runtime.sendMessage({
        action: 'downloadChapter',
        chapterUrl: location.href,
        zipName: manga + '-' + label,
        options: {
          format: cfg['output.format'] || 'zip',
          includeComicInfo: cfg['output.includeComicInfo'] !== false,
          includeSeriesMeta: false,
          folderLayout: 'default',
          chapterLabel: label,
          mangaName: manga,
          slug: currentSlug(),   // so the background records it in the per-series manifest
          seriesMeta: { title: manga, slug: currentSlug(), sourceUrl: location.href }
        }
      });
      kbToast('Downloading ' + label + '…');
    } catch (e) { /* no-op */ }
  }
  function kbIsTyping(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }
  function onKbKeydown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (kbIsTyping(e.target || document.activeElement)) return;
    var k = e.key;
    if (k === 'j' || k === 'J' || k === 'ArrowRight') { e.preventDefault(); kbNavigate(1); }
    else if (k === 'k' || k === 'K' || k === 'ArrowLeft') { e.preventDefault(); kbNavigate(-1); }
    else if (k === 'd' || k === 'D') { e.preventDefault(); kbDownloadCurrent(); }
  }
  var kbToastTimer = null;
  function kbToast(msg) {
    try {
      var id = 'cdl-kb-toast';
      var t = document.getElementById(id);
      if (!t) {
        t = document.createElement('div');
        t.id = id;
        t.style.cssText = 'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
          'background:var(--surface-2, rgba(19,21,31,0.96));color:var(--text-emphasis, #eef1f8);font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
          'padding:9px 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.14);box-shadow:0 6px 20px rgba(0,0,0,0.4);pointer-events:none;';
        document.body.appendChild(t);
      }
      t.textContent = msg;
      t.style.opacity = '1';
      clearTimeout(kbToastTimer);
      kbToastTimer = setTimeout(function () { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; }, 1800);
    } catch (e) {}
  }
  function startReaderKb() {
    if (kbState) return;
    kbState = { entries: null, slug: null };
    window.addEventListener('keydown', onKbKeydown, true);
  }
  function stopReaderKb() {
    if (!kbState) return;
    window.removeEventListener('keydown', onKbKeydown, true);
    kbState = null;
  }

  // ════════════════════════ reader page: broken/missing-page warning ════════════════════════
  // Passive: watches the chapter's page images (same selectors the extractor uses) and flags any
  // that fail to load — so a broken/missing page reads as a bad upload, not your connection.
  function pageNumOf(img) {
    var m = (img.getAttribute('alt') || '').match(/(\d+)/);
    if (m) return m[1];
    var dp = img.closest && img.closest('[data-page]');
    if (dp && dp.getAttribute('data-page')) return dp.getAttribute('data-page');
    return img.currentSrc || img.src || '';
  }
  function markBroken(img) {
    if (!pageHealthState) return;
    var key = pageNumOf(img);
    if (!key || pageHealthState.broken[key]) return;
    pageHealthState.broken[key] = true;
    scheduleHealthBanner();
  }
  function watchPageImg(img) {
    if (!pageHealthState || pageHealthState.seen.has(img)) return;
    pageHealthState.seen.add(img);
    if (img.complete) { if (img.naturalWidth === 0) markBroken(img); return; } // already failed
    img.addEventListener('error', function () { markBroken(img); }, { once: true });
    img.addEventListener('load', function () { if (img.naturalWidth === 0) markBroken(img); }, { once: true });
  }
  function scanPageImgs() {
    if (!pageHealthState) return;
    [].slice.call(document.querySelectorAll(PAGE_IMG_SEL)).forEach(watchPageImg);
  }
  function scheduleHealthBanner() {
    if (!pageHealthState || pageHealthState.bannerTimer) return;
    pageHealthState.bannerTimer = setTimeout(function () { if (pageHealthState) { pageHealthState.bannerTimer = null; updateHealthBanner(); } }, 200);
  }
  function updateHealthBanner() {
    if (!pageHealthState) return;
    var nums = Object.keys(pageHealthState.broken);
    if (!nums.length || pageHealthState.dismissed) {
      if (pageHealthState.banner) { pageHealthState.banner.remove(); pageHealthState.banner = null; }
      return;
    }
    var b = pageHealthState.banner;
    if (!b) {
      b = document.createElement('div'); b.id = 'cdl-pagehealth';
      b.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'display:flex;align-items:center;gap:10px;max-width:92vw;padding:9px 12px 9px 14px;border-radius:10px;' +
        'background:var(--surface-2,#2a2118);color:var(--text-emphasis,#f5e9d6);border:1px solid rgba(234,179,8,.55);' +
        'box-shadow:0 8px 24px rgba(0,0,0,.45);font:600 13px/1.35 system-ui,sans-serif;';
      var msg = document.createElement('span'); msg.id = 'cdl-pagehealth-msg';
      var x = document.createElement('button'); x.textContent = '✕'; x.title = 'Dismiss';
      x.style.cssText = 'background:none;border:0;color:inherit;cursor:pointer;font-size:15px;line-height:1;opacity:.7;padding:2px 4px;';
      x.addEventListener('click', function () { if (pageHealthState) pageHealthState.dismissed = true; b.remove(); if (pageHealthState) pageHealthState.banner = null; });
      b.appendChild(msg); b.appendChild(x);
      (document.body || document.documentElement).appendChild(b);
      pageHealthState.banner = b;
    }
    var n = nums.length;
    var list = nums.filter(function (k) { return /^\d+$/.test(k); }).sort(function (a, c) { return a - c; });
    var where = list.length ? (' (page' + (list.length > 1 ? 's ' : ' ') + list.slice(0, 6).join(', ') + (list.length > 6 ? '…' : '') + ')') : '';
    b.querySelector('#cdl-pagehealth-msg').textContent = '⚠ ' + n + ' page' + (n > 1 ? 's' : '') + ' failed to load in this chapter' + where + ' — the upload may be broken.';
  }
  function startPageHealth(url) {
    pageHealthState = { url: url, broken: Object.create(null), seen: new WeakSet(), observer: null, banner: null, bannerTimer: null, scanTimer: null, dismissed: false };
    scanPageImgs();
    try {
      var obs = new MutationObserver(function () {
        if (!pageHealthState || pageHealthState.scanTimer) return;
        pageHealthState.scanTimer = setTimeout(function () { if (pageHealthState) { pageHealthState.scanTimer = null; scanPageImgs(); } }, 150);
      });
      obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
      pageHealthState.observer = obs;
    } catch (e) {}
  }
  function stopPageHealth() {
    if (!pageHealthState) return;
    if (pageHealthState.observer) { try { pageHealthState.observer.disconnect(); } catch (e) {} }
    if (pageHealthState.bannerTimer) clearTimeout(pageHealthState.bannerTimer);
    if (pageHealthState.scanTimer) clearTimeout(pageHealthState.scanTimer);
    if (pageHealthState.banner) { try { pageHealthState.banner.remove(); } catch (e) {} }
    pageHealthState = null;
  }
  function syncPageHealth() {
    if (!cfg['features.flagBrokenPages']) { stopPageHealth(); return; }
    if (pageHealthState && pageHealthState.url === location.href) { scanPageImgs(); return; } // same chapter
    stopPageHealth();
    startPageHealth(location.href);
  }

  // ════════════════════════ wiring ════════════════════════
  function applyForPage() {
    try {
      var type = currentPageType();
      isReader = (type === 'reader');
      if (type === 'reader') {
        // Crossed into a reader (possibly from a list via SPA nav) — drop list features.
        stopListObserver();
        cleanupListFeatures();
        removeStyleIfUnused();
        if (cfg['features.fixReaderNav']) startReaderNav();
        else stopReaderNav();
        if (cfg['reader.keyboardShortcuts']) startReaderKb();
        else stopReaderKb();
        syncPageHealth(); // starts/stops the broken-page watcher per the flag + current chapter
      } else if (type === 'list') {
        // Crossed into a chapter list (possibly from a reader) — drop reader features.
        stopReaderNav();
        stopReaderKb();
        stopPageHealth();
        var anyList = cfg['features.dedupeChapters'] || cfg['features.enforceChapterOrder'];
        if (anyList) {
          ensureStyle();
          applyListFeatures();
          startListObserver();
        } else {
          stopListObserver();
          cleanupListFeatures(); // flags off → unhide + clear order, no row tagging
          removeStyleIfUnused();
        }
      } else {
        // Some other comix page (home, search, …): nothing applies — tear it all down.
        stopReaderNav();
        stopReaderKb();
        stopPageHealth();
        stopListObserver();
        cleanupListFeatures();
        removeStyleIfUnused();
      }
    } catch (e) { /* no-op */ }
  }

  function boot() {
    CDLSettings.getSettings().then(function (loaded) {
      cfg = loaded;
      applyForPage();
    }).catch(function () { applyForPage(); });
    CDLSettings.onChange(function (next) { cfg = next; applyForPage(); });

    // SPA-aware: the page type can change without a content-script re-run, so
    // re-apply on every soft navigation + bfcache restore. The `cdl:locationchange`
    // event is emitted by the MAIN-world bridge in scripts/extract-bridge.js — an
    // isolated-world history patch can't observe the page's own pushState calls.
    // Next fires pushState/replaceState often with the SAME path; only re-apply on a
    // real path change (in-page list changes are handled by the list MutationObserver).
    var lastPath = location.pathname;
    var onRoute = function () {
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      applyForPage();
    };
    window.addEventListener('cdl:locationchange', onRoute);
    window.addEventListener('popstate', onRoute);
    window.addEventListener('hashchange', onRoute);
    window.addEventListener('pageshow', function (e) { if (e.persisted) applyForPage(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
