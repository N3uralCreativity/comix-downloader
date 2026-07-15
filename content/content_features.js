/**
 * content_features.js — Comix Downloader "Additional Features" (v3.0.0)
 *
 * Runs on *://comix.to/* alongside content_title.js (loaded after it). IIFE-wrapped
 * so its top-level declarations can never collide with content_title.js's global `const`s.
 *
 * Independently-toggled, OFF-by-default site enhancements:
 *   - features.dedupeChapters      : hide duplicate chapters in the title list (list page)
 *   - features.enforceChapterOrder : force ascending numeric order in the list (list page)
 *   - features.fixReaderNav        : accurate next/prev with source switching (reader page)
 *   - features.flagBrokenPages     : warn when a chapter's page images fail to load (reader)
 *   - features.prefetchNext        : warm the next chapter near the end of the current one (reader)
 *   - features.resumeScroll        : reopen a chapter at the exact spot you stopped (reader)
 *   - features.recapOnReturn       : "welcome back" banner + jump-to-next on a series page (list)
 *   - features.readingStats        : local reading tracker feeding the Home "Your Reading" panel
 *   - features.catchupEstimate     : "N chapters left · ~time at your pace" chip (list)
 * Always-on (not settings): community chapter flags — reader flag button + "⚠ N" list markers,
 * shared through the same tiny Worker as the profile tenure badge (opaque salted hashes only).
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

  // ── Seamless prefetch state ───────────────────────────────────────────────────
  var prefetchState = null;        // { url, done, scrollTimer, onScroll, warmed:[] } for the current chapter
  var prefetchEntriesCache = null; // { slug, entries } — chapter list, reused across a series' chapters

  // ── Resume scroll-position state ──────────────────────────────────────────────
  var resumeState = null; // { url, chapterId, onScroll, saveTimer, restored, restoring, userMoved, restoreTimer, tries }

  // ── Recap-on-return state ─────────────────────────────────────────────────────
  var lastRecordedUrl = null; // dedupe last-read writes per chapter open

  // ── Local reading tracker + catch-up estimate state ──────────────────────────
  var readTrack = null;   // { url, slug, id, name, active, lastAct, maxFrac, tick, onAct, onHide }
  var catchupData = null; // { slug, lastNum|null, pace, ready } for the current series page

  // ── Crowd quality flags state ────────────────────────────────────────────────
  var readerFlagsState = null;   // { url, chapterId, widget }
  var flaggedLocal = null;       // Set of chapterIds this user already flagged (from storage)
  var _userHashId, _userHashPromise;

  function bg(action, payload) {
    return new Promise(function (res) {
      try { chrome.runtime.sendMessage(Object.assign({ action: action }, payload || {}), function (r) { res(r || {}); }); }
      catch (_) { res({}); }
    });
  }
  // The current comix user's opaque id, resolved once (for submitting flags).
  function getUserHashId() {
    if (_userHashId !== undefined) return Promise.resolve(_userHashId);
    if (_userHashPromise) return _userHashPromise;
    _userHashPromise = fetch('/api/v1/user', { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(function (r) { return (r.ok && /json/i.test(r.headers.get('content-type') || '')) ? r.json() : null; })
      .then(function (j) { var u = j && j.result; _userHashId = (u && (u.hashId || u.hid)) ? String(u.hashId || u.hid) : null; return _userHashId; })
      .catch(function () { _userHashId = null; return null; });
    return _userHashPromise;
  }
  function chapterIdFromUrl(url) { var m = String(url || '').match(/\/title\/[^/]+\/(\d+)-chapter-/i); return m ? m[1] : ''; }
  function loadFlaggedLocal() {
    try { chrome.storage.local.get('cdlFlaggedChapters', function (r) { flaggedLocal = new Set((r && r.cdlFlaggedChapters) || []); }); } catch (e) { flaggedLocal = new Set(); }
  }
  function markFlaggedLocal(id) {
    if (!flaggedLocal) flaggedLocal = new Set();
    flaggedLocal.add(id);
    try { chrome.storage.local.set({ cdlFlaggedChapters: [].slice.call(flaggedLocal).slice(-500) }); } catch (e) {}
  }
  function flagSummary(counts) {
    if (!counts || !counts.total) return '';
    var parts = [];
    if (counts.broken) parts.push(counts.broken + ' broken');
    if (counts.missing) parts.push(counts.missing + ' missing');
    if (counts.wrong) parts.push(counts.wrong + ' wrong');
    return parts.join(', ');
  }

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
      out.push({ row: row, key: key, parsed: p, chapterId: chapterIdFromUrl(href), url: absolute(href), label: (link.textContent || '').trim() });
    });
    return out;
  }

  // Lightweight undo used when both list features are off — never tags rows.
  function cleanupListFeatures() {
    [].slice.call(document.querySelectorAll('.' + HIDDEN_CLASS)).forEach(function (el) {
      el.classList.remove(HIDDEN_CLASS);
    });
    clearOrder(null);
    clearListFlagBadges();
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

      // ── crowd quality flags (⚠ N on flagged rows) — always on ──
      applyCrowdFlagsToList(rows);

      // ── recap-on-return banner + catch-up chip (re-ensured here so they heal after React re-renders) ──
      if (cfg['features.recapOnReturn']) ensureRecap(rows);
      if (cfg['features.catchupEstimate']) ensureCatchup(rows);
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

  // ════════════════════════ seamless prefetch ════════════════════════
  // As the reader nears the end of a chapter, quietly warm the NEXT chapter so opening it
  // feels instant: fetch its server HTML once (which also primes the browser cache), warm
  // the SPA data endpoint comix's own "next" uses, and preload the first few page images.
  // Deliberately gentle — one chapter ahead only, only past ~60%, at most once per chapter.
  var PREFETCH_TRIGGER = 0.6; // fraction of the chapter scrolled before we read ahead
  var PREFETCH_IMAGES = 6;    // how many leading page images of the next chapter to warm

  function nearChapterEnd() {
    try {
      // A freshly opened, not-yet-laid-out reader has scrollHeight ≈ viewport, which makes the
      // ratio (and the end marker) lie. Only trust either signal once you've actually scrolled
      // at least a viewport into the chapter.
      if (window.scrollY < window.innerHeight) return false;
      var h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
      if (h > 0 && (window.scrollY + window.innerHeight) / h >= PREFETCH_TRIGGER) return true;
      // Robust fallback for the virtualized reader: its end marker is on/near screen.
      var end = document.querySelector('.rpage-chap-ending, [class*="chap-ending"]');
      if (end) { var r = end.getBoundingClientRect(); if (r.top < window.innerHeight * 1.5) return true; }
      return false;
    } catch (e) { return false; }
  }

  function startPrefetch(url) {
    prefetchState = { url: url, done: false, scrollTimer: null, onScroll: null, warmed: [] };
    var onScroll = function () {
      if (!prefetchState || prefetchState.done || prefetchState.scrollTimer) return;
      prefetchState.scrollTimer = setTimeout(function () {
        if (!prefetchState) return;
        prefetchState.scrollTimer = null;
        if (nearChapterEnd()) doPrefetch();
      }, 250);
    };
    prefetchState.onScroll = onScroll;
    addReaderScrollListener(onScroll);
    if (nearChapterEnd()) doPrefetch(); // short chapter / already scrolled down
  }
  function stopPrefetch() {
    if (!prefetchState) return;
    if (prefetchState.onScroll) removeReaderScrollListener(prefetchState.onScroll);
    if (prefetchState.scrollTimer) clearTimeout(prefetchState.scrollTimer);
    prefetchState = null;
  }
  function syncPrefetch() {
    if (!cfg['features.prefetchNext']) { stopPrefetch(); return; }
    if (prefetchState && prefetchState.url === location.href) return; // same chapter
    stopPrefetch();
    startPrefetch(location.href);
  }

  async function doPrefetch() {
    if (!prefetchState || prefetchState.done) return;
    prefetchState.done = true; // once per chapter, whether or not we find a next url
    try {
      var nextUrl = await resolveNextChapterUrl();
      if (!nextUrl || !prefetchState) return;
      await warmNextChapter(nextUrl);
    } catch (e) { /* best-effort; never disturb reading */ }
  }

  async function resolveNextChapterUrl() {
    // Reuse fixReaderNav's already-computed next url when present (avoids extra list fetches).
    if (readerState && readerState.entriesSlug === currentSlug() && readerState.nextUrl) return readerState.nextUrl;
    var slug = currentSlug();
    if (!slug) return null;
    if (!prefetchEntriesCache || prefetchEntriesCache.slug !== slug) {
      prefetchEntriesCache = { slug: slug, entries: await fetchAllChapterEntries(slug) };
    }
    var node = Core.computeAdjacentChapter(prefetchEntriesCache.entries || [], location.href, 1);
    return node ? Core.pickCandidateUrl(node, location.href) : null;
  }

  async function warmNextChapter(url) {
    var html = '';
    try {
      var r = await fetch(url, { credentials: 'same-origin' }); // warms the document + yields page urls
      if (r && r.ok) html = await r.text();
    } catch (e) {}
    if (!prefetchState) return;
    // Warm the SPA data endpoint too — comix's native next button navigates via _next/data.
    try {
      var buildId = readBuildId();
      if (buildId) {
        var p = new URL(url, location.origin).pathname;
        fetch('/_next/data/' + buildId + p + '.json', { credentials: 'same-origin' }).catch(function () {});
      }
    } catch (e) {}
    // Preload the first few page images so the top of the next chapter paints instantly.
    if (html) {
      Core.parseReaderImages(html, url).slice(0, PREFETCH_IMAGES).forEach(function (it) {
        try { var im = new Image(); im.decoding = 'async'; im.src = it.src; if (prefetchState) prefetchState.warmed.push(im); } catch (e) {}
      });
    }
  }

  function readBuildId() {
    try { var el = document.getElementById('__NEXT_DATA__'); if (el) return JSON.parse(el.textContent || '{}').buildId || null; } catch (e) {}
    return null;
  }

  // ════════════════════════ resume scroll position ════════════════════════
  // Remember exactly where you stopped in each chapter (page + offset within it, plus a
  // whole-chapter fraction as a fallback) and jump back there when you reopen it. Opt-in;
  // stored only in this device's extension storage — nothing leaves the machine.
  var RESUME_KEY = 'cdlReaderScroll';
  var RESUME_MAX = 300;        // cap stored chapters (evict oldest by timestamp)
  var RESUME_MIN_FRAC = 0.02;  // ignore trivially-near-top positions (and clear on scroll-to-top)

  function readerScrollElement() {
    var preferred = document.querySelector('main.rpage-main, .rpage-main');
    if (preferred && preferred.scrollHeight > preferred.clientHeight + 40) return preferred;

    // Keep working if comix.to renames the reader class: walk from a rendered page
    // to the first genuinely scrollable ancestor, matching the extraction logic.
    var node = document.querySelector('[data-page], ' + PAGE_IMG_SEL);
    while (node && node !== document.body && node !== document.documentElement) {
      var style = null;
      try { style = window.getComputedStyle(node); } catch (e) {}
      if (node.scrollHeight > node.clientHeight + 40 && (!style || /(auto|scroll)/.test(style.overflowY || ''))) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function isRootScrollElement(node) {
    return node === document.scrollingElement || node === document.documentElement || node === document.body;
  }

  function readerScrollMetrics() {
    var node = readerScrollElement();
    var root = isRootScrollElement(node);
    var viewport = Math.max(1, root ? window.innerHeight : (node.clientHeight || window.innerHeight));
    var top = root ? Math.max(window.scrollY || 0, node.scrollTop || 0) : (node.scrollTop || 0);
    var height = node.scrollHeight || 0;
    if (root) height = Math.max(height, document.documentElement.scrollHeight || 0, document.body ? document.body.scrollHeight || 0 : 0);
    return { node: node, root: root, top: top, viewport: viewport, max: Math.max(1, height - viewport) };
  }

  function addReaderScrollListener(listener) {
    try { window.addEventListener('scroll', listener, { passive: true }); } catch (e) {}
    // Element scroll events do not bubble, but they do pass through capture. This
    // also survives the reader replacing its scroll container during a mode change.
    try { document.addEventListener('scroll', listener, { passive: true, capture: true }); } catch (e) {}
  }

  function removeReaderScrollListener(listener) {
    try { window.removeEventListener('scroll', listener); } catch (e) {}
    try { document.removeEventListener('scroll', listener, true); } catch (e) {}
  }

  function setReaderScrollTop(top) {
    var metrics = readerScrollMetrics();
    var target = Math.max(0, Math.min(metrics.max, Math.round(top || 0)));
    if (metrics.root) window.scrollTo(0, target);
    else metrics.node.scrollTop = target;
  }

  function scrollMax() { return readerScrollMetrics().max; }
  function scrollFrac() {
    var metrics = readerScrollMetrics();
    return Math.min(1, Math.max(0, metrics.top / metrics.max));
  }
  // The page currently at the top of the viewport + how far into it we've scrolled (0..1).
  function currentPageInfo() {
    var els = document.querySelectorAll('[data-page]');
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.bottom > 0) {
        var p = parseInt(els[i].getAttribute('data-page'), 10);
        var intra = r.height > 0 ? Math.min(1, Math.max(0, (-r.top) / r.height)) : 0;
        return { page: isNaN(p) ? null : p, intra: intra };
      }
    }
    return { page: null, intra: 0 };
  }

  function startResume(url) {
    var id = chapterIdFromUrl(url);
    resumeState = { url: url, chapterId: id, onScroll: null, saveTimer: null, restored: false, restoring: false, userMoved: false, restoreTimer: null, tries: 0 };
    var onScroll = function () {
      if (!resumeState || resumeState.restoring) return;   // ignore our own restore scrolls
      if (!resumeState.restored) { resumeState.userMoved = true; return; } // user took over first
      if (resumeState.saveTimer) return;
      resumeState.saveTimer = setTimeout(function () { if (resumeState) { resumeState.saveTimer = null; saveResume(); } }, 400);
    };
    resumeState.onScroll = onScroll;
    addReaderScrollListener(onScroll);
    if (!id) { resumeState.restored = true; return; }
    try {
      chrome.storage.local.get(RESUME_KEY, function (r) {
        if (!resumeState || resumeState.chapterId !== id) return;
        var saved = ((r && r[RESUME_KEY]) || {})[id];
        if (saved && saved.frac > RESUME_MIN_FRAC && !resumeState.userMoved) tryRestore(saved);
        else resumeState.restored = true;
      });
    } catch (e) { resumeState.restored = true; }
  }

  function scrollToSaved(saved) {
    var target = null;
    var metrics = readerScrollMetrics();
    if (saved.page != null) {
      var el = document.querySelector('[data-page="' + saved.page + '"]');
      if (el) {
        var r = el.getBoundingClientRect();
        var viewportTop = metrics.root ? 0 : metrics.node.getBoundingClientRect().top;
        target = metrics.top + (r.top - viewportTop) + (saved.intra || 0) * r.height;
      }
    }
    if (target == null) target = (saved.frac || 0) * scrollMax();
    setReaderScrollTop(target);
  }

  function tryRestore(saved) {
    if (!resumeState || resumeState.userMoved) { if (resumeState) resumeState.restored = true; return; }
    if (scrollMax() > 40) { // content tall enough that the saved spot is reachable
      resumeState.restoring = true;
      scrollToSaved(saved);
      resumeState.restoreTimer = setTimeout(function () {
        if (!resumeState) return;
        scrollToSaved(saved); // settle again after late layout shifts (images loading in)
        resumeState.restoring = false;
        resumeState.restored = true;
      }, 350);
      return;
    }
    if (++resumeState.tries < 25) resumeState.restoreTimer = setTimeout(function () { tryRestore(saved); }, 150);
    else resumeState.restored = true; // give up cleanly after ~3.75s
  }

  function saveResume() {
    if (!resumeState || !resumeState.chapterId) return;
    var id = resumeState.chapterId;
    var frac = scrollFrac();
    var info = currentPageInfo();
    try {
      chrome.storage.local.get(RESUME_KEY, function (r) {
        if (!resumeState || resumeState.chapterId !== id) return;
        var map = (r && r[RESUME_KEY]) || {};
        if (frac <= RESUME_MIN_FRAC) { if (map[id]) { delete map[id]; persistResume(map); } return; } // back at top → forget
        map[id] = { frac: frac, page: info.page, intra: info.intra, ts: Date.now() };
        var keys = Object.keys(map);
        if (keys.length > RESUME_MAX) {
          keys.sort(function (a, b) { return (map[a].ts || 0) - (map[b].ts || 0); });
          for (var i = 0; i < keys.length - RESUME_MAX; i++) delete map[keys[i]];
        }
        persistResume(map);
      });
    } catch (e) {}
  }
  function persistResume(map) { try { var o = {}; o[RESUME_KEY] = map; chrome.storage.local.set(o); } catch (e) {} }

  function stopResume() {
    if (!resumeState) return;
    if (resumeState.onScroll) removeReaderScrollListener(resumeState.onScroll);
    if (resumeState.saveTimer) clearTimeout(resumeState.saveTimer);
    if (resumeState.restoreTimer) clearTimeout(resumeState.restoreTimer);
    resumeState = null;
  }
  function syncResume() {
    if (!cfg['features.resumeScroll']) { stopResume(); return; }
    if (resumeState && resumeState.url === location.href) return; // same chapter
    stopResume();
    startResume(location.href);
  }

  // ════════════════════════ recap on return ════════════════════════
  // Opening a chapter records "last read" for its series (locally). Reopening the series
  // page after a while shows a small banner: which chapter you left off at, how long ago,
  // and a one-click jump to the next one. Nothing leaves the device.
  var LASTREAD_KEY = 'cdlLastRead';
  var LASTREAD_MAX = 200;                  // cap stored series (evict oldest)
  var RECAP_MIN_AGE = 12 * 3600 * 1000;    // only recap after a real break, not a bathroom one

  var recapData = null;      // { slug, rec|null } — storage read for the current series page
  var recapDismissed = {};   // slug -> true, this SPA session only

  function fmtAgo(ms) {
    var m = Math.floor(ms / 60000);
    if (m < 2) return 'just now';
    if (m < 60) return m + ' minutes ago';
    var h = Math.floor(m / 60);
    if (h < 48) return h + (h === 1 ? ' hour ago' : ' hours ago');
    var d = Math.floor(h / 24);
    if (d < 14) return d + ' days ago';
    var w = Math.floor(d / 7);
    if (w < 9) return w + ' weeks ago';
    var mo = Math.floor(d / 30);
    if (mo < 12) return mo + (mo === 1 ? ' month ago' : ' months ago');
    var y = Math.floor(d / 365);
    return y + (y === 1 ? ' year ago' : ' years ago');
  }

  function recordLastRead() {
    var url = location.href.split('#')[0];
    if (lastRecordedUrl === url) return;
    lastRecordedUrl = url;
    var slug = currentSlug();
    var id = chapterIdFromUrl(url);
    if (!slug || !id) return;
    var p = Core.parseChapterNumber(url);
    try {
      chrome.storage.local.get(LASTREAD_KEY, function (r) {
        var map = (r && r[LASTREAD_KEY]) || {};
        map[slug] = { url: url, id: id, num: (p && p.kind === 'num') ? p.value : null, ts: Date.now() };
        var keys = Object.keys(map);
        if (keys.length > LASTREAD_MAX) {
          keys.sort(function (a, b) { return (map[a].ts || 0) - (map[b].ts || 0); });
          for (var i = 0; i < keys.length - LASTREAD_MAX; i++) delete map[keys[i]];
        }
        var o = {}; o[LASTREAD_KEY] = map;
        chrome.storage.local.set(o);
      });
    } catch (e) {}
  }

  function syncRecap() {
    if (!cfg['features.recapOnReturn']) { stopRecap(); return; }
    var slug = currentSlug();
    if (recapData && recapData.slug === slug) return; // already loaded for this series
    stopRecap();
    recapData = { slug: slug, rec: null };
    try {
      chrome.storage.local.get(LASTREAD_KEY, function (r) {
        if (!recapData || recapData.slug !== slug) return;
        recapData.rec = ((r && r[LASTREAD_KEY]) || {})[slug] || null;
        if (recapData.rec) applyListFeatures(); // rows may already be rendered → show now
      });
    } catch (e) {}
  }

  // Called from applyListFeatures with the collected rows (so it also heals after React churn).
  function ensureRecap(rows) {
    if (!recapData || !recapData.rec || recapDismissed[recapData.slug]) return;
    if (document.getElementById('cdl-recap')) return;
    if (!rows.length) return;
    var rec = recapData.rec;
    if (Date.now() - (rec.ts || 0) < RECAP_MIN_AGE) return;

    // The next chapter strictly after the one we left off at (smallest such number in the list).
    var next = null;
    if (rec.num != null) {
      rows.forEach(function (rw) {
        if (!rw.parsed || rw.parsed.kind !== 'num' || rw.parsed.value <= rec.num) return;
        if (!next || rw.parsed.value < next.parsed.value) next = rw;
      });
    }

    var box = document.createElement('div');
    box.id = 'cdl-recap';
    box.setAttribute('style', 'display:flex;align-items:center;gap:12px;margin:10px 0;padding:10px 14px;' +
      'background:rgba(60,130,110,.12);border:1px solid rgba(60,130,110,.35);border-radius:10px;font-size:13.5px;line-height:1.4;');
    var txt = document.createElement('span');
    txt.style.flex = '1';
    var chLabel = rec.num != null ? ('Chapter ' + rec.num) : 'a chapter';
    txt.textContent = 'Welcome back — you left off at ' + chLabel + ', ' + fmtAgo(Date.now() - (rec.ts || 0)) + '.';
    box.appendChild(txt);

    var go = document.createElement('a');
    go.href = next ? next.url : rec.url;
    go.textContent = next ? ('Continue · Chapter ' + next.parsed.value + ' →') : ('Reopen ' + chLabel);
    go.setAttribute('style', 'flex:none;padding:6px 12px;border-radius:8px;background:rgba(60,130,110,.85);' +
      'color:#fff;text-decoration:none;font-weight:600;white-space:nowrap;');
    box.appendChild(go);

    var x = document.createElement('button');
    x.textContent = '×';
    x.title = 'Dismiss';
    x.setAttribute('style', 'flex:none;width:24px;height:24px;border:0;border-radius:6px;background:transparent;' +
      'color:inherit;opacity:.6;cursor:pointer;font-size:16px;line-height:1;');
    var dismissSlug = recapData.slug; // capture now — recapData may be gone by click time
    x.addEventListener('click', function () {
      recapDismissed[dismissSlug] = true;
      box.remove();
    });
    box.appendChild(x);

    // Sit just above the chapters block (its section when there is one).
    var sect = rows[0].row.closest('section') || rows[0].row.parentElement;
    if (sect && sect.parentNode) sect.parentNode.insertBefore(box, sect);
  }

  function removeRecap() {
    var el = document.getElementById('cdl-recap');
    if (el) el.remove();
  }
  function stopRecap() {
    removeRecap();
    recapData = null;
  }

  // ════════════════════════ local reading tracker ════════════════════════
  // Measures how much you ACTUALLY read: while a chapter is open, count 5-second ticks in
  // which the tab is visible and there was recent input (scroll/keys/pointer). Leaving the
  // chapter folds the sample into `cdlReadStats` via the pure Core reducers. A chapter only
  // counts as "finished" (and only teaches your pace) if you got most of the way through.
  // Local-only: nothing ever leaves the device. Powers reading stats + catch-up estimates.
  var TRACK_TICK_SECS = 5;
  var TRACK_IDLE_MS = 30000;    // no input for 30s → you stopped reading
  var TRACK_MIN_SECS = 30;      // under this it was a peek, not a read
  var TRACK_MAX_SECS = 2700;    // cap one chapter's credited time (45 min)
  var TRACK_FINISH_FRAC = 0.85; // scrolled this far → the chapter counts as read

  function trackingEnabled() { return !!(cfg['features.readingStats'] || cfg['features.catchupEstimate']); }

  // How far through the chapter you are, but robust to the reader not having laid out yet
  // (a short scrollHeight makes the plain ratio read ~1 at the top of a fresh page).
  function chapterFrac() {
    var metrics = readerScrollMetrics();
    if (metrics.max > metrics.viewport) return Math.min(1, Math.max(0, metrics.top / metrics.max));
    // Short (or not-yet-grown) documents: only trust "finished" when truly at the bottom
    // of real, rendered chapter content.
    if (metrics.max > 40 && metrics.top >= metrics.max - 20 && document.querySelector(PAGE_IMG_SEL)) return 1;
    return 0;
  }

  function seriesNameFromTitle() {
    // Reader tab titles look like "Series Name · Ch.18" — take the series part.
    var t = (document.title || '').split('·')[0].trim();
    return t && t.length > 1 ? t : currentSlug();
  }

  function startReadTrack(url) {
    readTrack = { url: url, slug: currentSlug(), id: chapterIdFromUrl(url), name: seriesNameFromTitle(),
      active: 0, total: 0, credited: false, lastAct: Date.now(), maxFrac: 0, tick: null, onAct: null, onHide: null };
    var onAct = function () { if (readTrack) readTrack.lastAct = Date.now(); };
    readTrack.onAct = onAct;
    addReaderScrollListener(onAct);
    ['keydown', 'pointerdown', 'wheel'].forEach(function (ev) { window.addEventListener(ev, onAct, { passive: true }); });
    var onHide = function () { if (readTrack && document.visibilityState === 'hidden') flushReadTrack(); };
    readTrack.onHide = onHide;
    document.addEventListener('visibilitychange', onHide);
    readTrack.tick = setInterval(function () {
      if (!readTrack || document.hidden) return;
      if (Date.now() - readTrack.lastAct <= TRACK_IDLE_MS) {
        readTrack.active += TRACK_TICK_SECS;
        var f = chapterFrac();
        if (f > readTrack.maxFrac) readTrack.maxFrac = f;
        var reachedEnd = !readTrack.credited && readTrack.total + readTrack.active >= TRACK_MIN_SECS && readTrack.maxFrac >= TRACK_FINISH_FRAC;
        // Flush every 30 active seconds: a full-page navigation kills this script without
        // warning, so long sessions must not sit only in memory. Also flush as soon as
        // the finish threshold is crossed, instead of risking a route change first.
        if (reachedEnd || readTrack.active >= TRACK_MIN_SECS) flushReadTrack();
      }
    }, TRACK_TICK_SECS * 1000);
  }

  // Fold the accumulated slice into storage and zero it (tracking continues if still open).
  // A chapter is credited as "finished" (and teaches the pace) at most ONCE per open.
  function flushReadTrack() {
    if (!readTrack) return;
    var currentFrac = chapterFrac();
    if (currentFrac > readTrack.maxFrac) readTrack.maxFrac = currentFrac;
    var secs = Math.min(readTrack.active, TRACK_MAX_SECS);
    readTrack.active = 0;
    readTrack.total = Math.min(readTrack.total + secs, TRACK_MAX_SECS);
    var finished = !readTrack.credited && readTrack.total >= TRACK_MIN_SECS && readTrack.maxFrac >= TRACK_FINISH_FRAC;
    // A final route/visibility flush can happen between five-second ticks. It may
    // carry no new seconds but must still preserve a newly observed completion.
    if (secs < TRACK_TICK_SECS && !finished) return;
    if (finished) readTrack.credited = true;
    var sample = { ts: Date.now(), slug: readTrack.slug, name: readTrack.name, seconds: secs,
      finished: finished, paceSecs: finished ? readTrack.total : 0 };
    try {
      chrome.storage.local.get('cdlReadStats', function (r) {
        var stats = Core.recordReadSample((r && r.cdlReadStats) || null, sample);
        try { chrome.storage.local.set({ cdlReadStats: stats }); } catch (e) {}
      });
    } catch (e) {}
  }

  function stopReadTrack() {
    if (!readTrack) return;
    flushReadTrack();
    if (readTrack.tick) clearInterval(readTrack.tick);
    var onAct = readTrack.onAct;
    if (onAct) {
      removeReaderScrollListener(onAct);
      ['keydown', 'pointerdown', 'wheel'].forEach(function (ev) { try { window.removeEventListener(ev, onAct); } catch (e) {} });
    }
    if (readTrack.onHide) { try { document.removeEventListener('visibilitychange', readTrack.onHide); } catch (e) {} }
    readTrack = null;
  }
  function syncReadTrack() {
    if (!trackingEnabled()) { stopReadTrack(); return; }
    if (readTrack && readTrack.url === location.href) return; // same chapter
    stopReadTrack();
    startReadTrack(location.href);
  }

  // ════════════════════════ catch-up estimate (series page) ════════════════════════
  function syncCatchup() {
    if (!cfg['features.catchupEstimate']) { stopCatchup(); return; }
    var slug = currentSlug();
    if (catchupData && catchupData.slug === slug) return;
    stopCatchup();
    catchupData = { slug: slug, lastNum: null, pace: Core.PACE_DEFAULT_SECS, ready: false };
    try {
      chrome.storage.local.get(['cdlLastRead', 'cdlReadStats'], function (r) {
        if (!catchupData || catchupData.slug !== slug) return;
        var rec = ((r && r.cdlLastRead) || {})[slug];
        catchupData.lastNum = rec && rec.num != null ? rec.num : null;
        catchupData.pace = Core.readingPace(r && r.cdlReadStats);
        catchupData.ready = true;
        applyListFeatures(); // rows may already be rendered → show now
      });
    } catch (e) { catchupData.ready = true; }
  }

  // Called from applyListFeatures with the collected rows (heals after React churn).
  function ensureCatchup(rows) {
    if (!catchupData || !catchupData.ready) return;
    if (document.getElementById('cdl-catchup')) return;
    if (!rows.length) return;
    var nums = rows.map(function (rw) { return rw.parsed && rw.parsed.kind === 'num' ? rw.parsed.value : null; })
      .filter(function (v) { return v != null; });
    if (!nums.length) return;
    var est = Core.estimateCatchup(nums, catchupData.lastNum, catchupData.pace);

    var chip = document.createElement('div');
    chip.id = 'cdl-catchup';
    chip.setAttribute('style', 'display:inline-flex;align-items:center;gap:8px;margin:6px 0;padding:6px 12px;' +
      'background:rgba(90,110,160,.12);border:1px solid rgba(90,110,160,.35);border-radius:999px;font-size:12.5px;');
    if (est.count === 0) {
      chip.textContent = '✓ You’re all caught up';
    } else if (catchupData.lastNum != null) {
      chip.textContent = '≈ ' + est.count + (est.count === 1 ? ' chapter' : ' chapters') + ' left · ~' + Core.fmtDuration(est.seconds) + ' at your pace';
    } else {
      chip.textContent = est.count + (est.count === 1 ? ' chapter' : ' chapters') + ' · ≈ ' + Core.fmtDuration(est.seconds) + ' at your pace';
    }
    chip.title = 'Estimated from your own reading speed, measured on this device only.';

    var sect = rows[0].row.closest('section') || rows[0].row.parentElement;
    if (sect && sect.parentNode) sect.parentNode.insertBefore(chip, sect);
  }

  function stopCatchup() {
    var el = document.getElementById('cdl-catchup');
    if (el) el.remove();
    catchupData = null;
  }

  // ════════════════════════ crowd quality flags ════════════════════════
  // Reader: a flag button injected INTO comix's own reader controls (so it matches the site and
  // never overlaps them), with a small count badge, plus a broken/missing/wrong menu.
  var FLAG_BTN_ID = 'cdl-flag-btn';
  var FLAG_TYPES = [['broken', 'Broken images'], ['missing', 'Missing pages'], ['wrong', 'Wrong chapter']];
  function flagSvg() {
    var ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg');
    s.setAttribute('width', '16'); s.setAttribute('height', '16'); s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    [['path', 'M5 21V4'], ['path', 'M5 4c4-2 8 2 12 0v9c-4 2-8-2-12 0']].forEach(function (p) { var e = document.createElementNS(ns, p[0]); e.setAttribute('d', p[1]); s.appendChild(e); });
    return s;
  }
  // Host = comix's floating reader controls (preferred) or the bottom-bar actions; native classes
  // make our button look identical to the site's own.
  function flagHost() {
    var col = document.querySelector('.rpage-floatctl__col') || document.querySelector('.rpage-floatctl');
    if (col) return { el: col, cls: 'rpage-floatctl__btn', row: true };
    var ba = document.querySelector('.rpage-bottombar__actions') || document.querySelector('.rpage-bottombar__controls');
    if (ba) return { el: ba, cls: 'rpage-iconbtn', row: false };
    return null;
  }
  function ensureFlagButton() {
    if (!readerFlagsState) return;
    var existing = document.getElementById(FLAG_BTN_ID);
    if (existing) { updateFlagButton(existing); return; }
    var host = flagHost(); if (!host) return; // reader controls not mounted yet — observer retries
    var btn = document.createElement('button');
    btn.type = 'button'; btn.id = FLAG_BTN_ID; btn.className = host.cls;
    btn.setAttribute('aria-label', 'Flag a problem with this chapter'); btn.title = 'Flag a problem with this chapter';
    btn.style.position = 'relative';
    btn.appendChild(flagSvg());
    var badge = document.createElement('span'); badge.className = 'cdl-flag-badge-n';
    badge.style.cssText = 'position:absolute;top:-4px;right:-4px;min-width:15px;height:15px;padding:0 3px;border-radius:8px;background:#eab308;color:#1a1204;font:800 9px/15px system-ui,sans-serif;text-align:center;display:none;';
    btn.appendChild(badge);
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); toggleFlagMenu(btn); });
    if (host.row) { var row = document.createElement('div'); row.className = 'rpage-floatctl__row'; row.appendChild(btn); host.el.appendChild(row); }
    else host.el.appendChild(btn);
    updateFlagButton(btn);
  }
  function updateFlagButton(btn) {
    var st = readerFlagsState; if (!st) return;
    var badge = btn.querySelector('.cdl-flag-badge-n');
    var total = st.counts && st.counts.total;
    if (badge) { if (total) { badge.textContent = total > 99 ? '99+' : String(total); badge.style.display = ''; } else { badge.style.display = 'none'; } }
    var s = flagSummary(st.counts);
    var mine = flaggedLocal && flaggedLocal.has(st.chapterId);
    btn.title = (total ? ('⚠ ' + total + ' flagged (' + s + ')') : 'Flag a problem with this chapter') + (mine ? ' · you flagged this' : '');
    btn.style.color = (total || mine) ? '#eab308' : '';
  }
  function toggleFlagMenu(btn) {
    var open = document.getElementById('cdl-flag-menu');
    if (open) { open.remove(); return; }
    var st = readerFlagsState; if (!st) return;
    var menu = document.createElement('div'); menu.id = 'cdl-flag-menu';
    var r = btn.getBoundingClientRect();
    menu.style.cssText = 'position:fixed;z-index:2147483647;min-width:180px;background:var(--bg-2,#1f2226);color:var(--text,#cdd5d6);' +
      'border:1px solid var(--surface-3,#3a4248);border-radius:8px;overflow:hidden;box-shadow:0 10px 28px rgba(0,0,0,.5);font:600 13px/1.3 system-ui,sans-serif;';
    var head = document.createElement('div'); head.textContent = 'Flag this chapter as…';
    head.style.cssText = 'padding:8px 12px;color:var(--text-3,#8a8a8a);font-weight:700;border-bottom:1px solid var(--surface-3,#3a4248);';
    menu.appendChild(head);
    FLAG_TYPES.forEach(function (t) {
      var mi = document.createElement('button'); mi.type = 'button'; mi.textContent = t[1];
      mi.style.cssText = 'display:block;width:100%;background:none;border:0;color:inherit;text-align:left;padding:9px 12px;cursor:pointer;font:inherit;';
      mi.addEventListener('mouseenter', function () { mi.style.background = 'var(--surface-3,#3a4248)'; });
      mi.addEventListener('mouseleave', function () { mi.style.background = 'none'; });
      mi.addEventListener('click', function () { menu.remove(); submitFlag(st.chapterId, t[0]); });
      menu.appendChild(mi);
    });
    document.body.appendChild(menu);
    var mr = menu.getBoundingClientRect();
    var left = Math.max(8, Math.min(r.left, window.innerWidth - mr.width - 8));
    var top = r.top - mr.height - 8; if (top < 8) top = r.bottom + 8; // above the button, or below if no room
    menu.style.left = left + 'px'; menu.style.top = top + 'px';
    var closer = function (ev) { if (!menu.contains(ev.target) && ev.target !== btn) { menu.remove(); document.removeEventListener('mousedown', closer, true); } };
    setTimeout(function () { document.addEventListener('mousedown', closer, true); }, 0);
  }
  function submitFlag(chapterId, type) {
    getUserHashId().then(function (uid) {
      if (!uid) return;
      bg('cdlFlagSubmit', { chapterId: chapterId, userHashId: uid, type: type }).then(function (r) {
        if (!r || !r.ok) return;
        markFlaggedLocal(chapterId);
        if (readerFlagsState && readerFlagsState.chapterId === chapterId) {
          readerFlagsState.counts = r.counts;
          var btn = document.getElementById(FLAG_BTN_ID); if (btn) updateFlagButton(btn);
        }
      });
    });
  }
  function removeFlagUI() {
    var b = document.getElementById(FLAG_BTN_ID);
    if (b) { var row = b.closest('.rpage-floatctl__row'); (row && row.children.length === 1 ? row : b).remove(); }
    var m = document.getElementById('cdl-flag-menu'); if (m) m.remove();
  }
  function startReaderFlags(url) {
    var chapterId = chapterIdFromUrl(url); if (!chapterId) return;
    readerFlagsState = { url: url, chapterId: chapterId, counts: null, observer: null, debounce: null };
    ensureFlagButton(); // may no-op until controls mount; the observer re-tries
    bg('cdlFlagLookup', { chapterIds: [chapterId] }).then(function (r) {
      if (!readerFlagsState || readerFlagsState.chapterId !== chapterId) return;
      readerFlagsState.counts = (r && r.counts && r.counts[chapterId]) || null;
      ensureFlagButton();
    });
    try {
      var obs = new MutationObserver(function () {
        if (!readerFlagsState || readerFlagsState.debounce) return;
        readerFlagsState.debounce = setTimeout(function () { if (readerFlagsState) { readerFlagsState.debounce = null; ensureFlagButton(); } }, 200);
      });
      obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
      readerFlagsState.observer = obs;
    } catch (e) {}
  }
  function stopReaderFlags() {
    if (readerFlagsState) {
      if (readerFlagsState.observer) { try { readerFlagsState.observer.disconnect(); } catch (e) {} }
      if (readerFlagsState.debounce) clearTimeout(readerFlagsState.debounce);
    }
    removeFlagUI();
    readerFlagsState = null;
  }
  function syncReaderFlags() {
    // Community chapter flags are always on (not a setting).
    if (readerFlagsState && readerFlagsState.url === location.href) { ensureFlagButton(); return; }
    stopReaderFlags(); startReaderFlags(location.href);
  }

  // List: append a "⚠ N" marker to chapter rows other users flagged (batch lookup, cached in bg).
  function applyCrowdFlagsToList(rows) {
    var ids = []; rows.forEach(function (r) { if (r.chapterId) ids.push(r.chapterId); });
    if (!ids.length) return;
    bg('cdlFlagLookup', { chapterIds: ids }).then(function (res) {
      if (!res || !res.counts) return;
      rows.forEach(function (r) {
        if (!r.chapterId || !r.row.isConnected) return;
        var counts = res.counts[r.chapterId];
        var badge = r.row.querySelector('.cdl-flag-badge');
        if (counts && counts.total) {
          var label = '⚠ ' + counts.total;
          if (!badge) {
            badge = document.createElement('span'); badge.className = 'cdl-flag-badge';
            badge.style.cssText = 'display:inline-flex;align-items:center;margin-left:8px;padding:1px 7px;border-radius:5px;font:800 10px/1.6 system-ui,sans-serif;color:#f5c451;background:rgba(234,179,8,.14);border:1px solid rgba(234,179,8,.4);vertical-align:middle;';
            r.row.appendChild(badge);
          }
          if (badge.textContent !== label) badge.textContent = label; // avoid needless mutations (observer churn)
          var tip = flagSummary(counts) + ' — flagged by other Comix-Downloader users';
          if (badge.title !== tip) badge.title = tip;
        } else if (badge) { badge.remove(); }
      });
    });
  }
  function clearListFlagBadges() {
    [].slice.call(document.querySelectorAll('.cdl-flag-badge')).forEach(function (el) { el.remove(); });
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
        syncReaderFlags(); // starts/stops the crowd-flag widget per the flag + current chapter
        syncPrefetch();   // starts/stops read-ahead per the flag + current chapter
        syncResume();     // starts/stops exact scroll-position resume per the flag + current chapter
        if (cfg['features.recapOnReturn']) recordLastRead(); // remember this chapter for the recap banner
        syncReadTrack();  // measure active reading time (stats + pace), when enabled
        stopRecap();      // the recap banner belongs on the list, not the reader (drop its cache too)
        stopCatchup();
      } else if (type === 'list') {
        // Crossed into a chapter list (possibly from a reader) — drop reader features.
        stopReaderNav();
        stopReaderKb();
        stopPageHealth();
        stopReaderFlags();
        stopPrefetch();
        stopResume();
        // Community chapter flags always run on a list, so this branch is always active
        // (dedupe/order still gate themselves inside applyListFeatures).
        stopReadTrack(); // flush the reading sample from the chapter we just left
        ensureStyle();
        applyListFeatures();
        startListObserver();
        syncRecap();   // "welcome back" recap banner on a series page
        syncCatchup(); // "N chapters · ~time at your pace" chip
      } else {
        // Some other comix page (home, search, …): nothing applies — tear it all down.
        stopReaderNav();
        stopReaderKb();
        stopPageHealth();
        stopReaderFlags();
        stopPrefetch();
        stopResume();
        stopRecap();
        stopReadTrack();
        stopCatchup();
        stopListObserver();
        cleanupListFeatures();
        removeStyleIfUnused();
      }
    } catch (e) { /* no-op */ }
  }

  function boot() {
    loadFlaggedLocal();
    CDLSettings.getSettings().then(function (loaded) {
      cfg = loaded;
      applyForPage();
    }).catch(function () { applyForPage(); });
    CDLSettings.onChange(function (next) { cfg = next; applyForPage(); });

    // SPA-aware: the page type can change without a content-script re-run, so
    // re-apply on every soft navigation + bfcache restore. The `cdl:locationchange`
    // event is emitted by the MAIN-world bridge in content/extract-bridge.js — an
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
