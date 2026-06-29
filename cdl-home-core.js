/**
 * cdl-home-core.js — Comix Downloader "Custom Home" pure logic (v3.0.0)
 *
 * DOM-free, window-free, chrome-free. Loaded as a classic script that attaches
 * `globalThis.CDLHomeCore`, AND exported via module.exports so the same file is
 * unit-testable under plain `node` (mirrors cdl-features-core.js / settings.js).
 *
 * Owns the *correctness* of the custom Home feature:
 *   - classifyHomeSection : decide, from a section's heading text, whether the
 *                           custom Home keeps it (native) or hides it.
 *   - parseFollowedTitles : parse comix `a.card` title cards out of an HTML string
 *                           (the user's followed-titles page) into a clean list.
 *
 * The impure DOM/fetch wiring lives in content_home.js. Selectors come from the
 * captured Home DOM (see the comix-home-dom memory): cards are `a.card[href="/title/…"]`
 * with `.card__poster-wrap img` (alt = title), `.card__title[title]`, `.card__ch`,
 * `.card__time`; sections are `section.section` with `h2.section__title`.
 */
(function (global) {
  'use strict';

  // Native Home sections the custom layout KEEPS (matched by heading text, case-insensitive,
  // whitespace-collapsed). Everything else in the main column is hidden. "Recently Followed
  // Comics" is NOT here — it isn't a native Home section; content_home.js renders it itself.
  var KEEP_HEADINGS = [
    'new chapters from followed comics',
    'reading history'
  ];

  function _norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  // Minimal HTML-attribute entity decode (enough for titles/URLs). &amp; last so we
  // never turn "&amp;lt;" into "<".
  function decodeHtmlEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&quot;/g, '"')
      .replace(/&#x2F;/gi, '/')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  function _attr(tag, name) {
    if (!tag) return '';
    var m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"', 'i'))
      || tag.match(new RegExp("\\b" + name + "\\s*=\\s*'([^']*)'", 'i'));
    return m ? m[1] : '';
  }

  function _stripTags(s) { return String(s == null ? '' : s).replace(/<[^>]*>/g, ''); }

  // Inner text of the first element whose class contains `cls`, within `inner`.
  function _classText(inner, cls) {
    var m = inner.match(new RegExp('class\\s*=\\s*["\'][^"\']*\\b' + cls + '\\b[^"\']*["\'][^>]*>([\\s\\S]*?)<', 'i'));
    return m ? _norm(decodeHtmlEntities(_stripTags(m[1]))) : '';
  }

  /**
   * Classify a native Home section from its heading text:
   *   'keep'   — render it (one of the followed/history personalized sections)
   *   'remove' — hide it (global carousels, announcements, etc.)
   *   'unknown'— empty/no heading; treated as removable by the caller.
   * Substring match so "New Chapters from Followed Comics" matches even with stray
   * suffixes (counts/badges) appended to the heading.
   */
  function classifyHomeSection(headingText) {
    var t = _norm(headingText).toLowerCase();
    if (!t) return 'unknown';
    for (var i = 0; i < KEEP_HEADINGS.length; i++) {
      if (t === KEEP_HEADINGS[i] || t.indexOf(KEEP_HEADINGS[i]) !== -1) return 'keep';
    }
    return 'remove';
  }

  /**
   * Parse comix title cards (`a.card[href="/title/…"]`) out of an HTML string into
   *   [{ title, url, slug, cover, chapter, time }]
   * in document order, deduped by slug. `baseUrl` resolves relative href/cover.
   * Never throws; returns [] on empty/garbage input.
   */
  function parseFollowedTitles(html, baseUrl) {
    if (!html) return [];
    var out = [];
    var seen = Object.create(null);
    // Anchors aren't nested, so <a …>…</a> (non-greedy) captures one card cleanly.
    var re = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html))) {
      var attrs = m[1], inner = m[2];
      if (!/\bclass\s*=\s*["'][^"']*\bcard\b/i.test(attrs)) continue;
      var href = decodeHtmlEntities(_attr(attrs, 'href')).trim();
      if (!href || href.indexOf('/title/') === -1) continue;
      var slug = (href.match(/\/title\/([^/?#"']+)/) || [null, ''])[1];
      if (!slug || seen[slug]) continue;
      seen[slug] = true;

      var url = href;
      if (baseUrl) { try { url = new URL(href, baseUrl).href; } catch (_) {} }

      var imgTag = (inner.match(/<img\b[^>]*>/i) || [''])[0];
      var cover = decodeHtmlEntities(_attr(imgTag, 'src')).trim();
      if (!cover) {
        var ss = _attr(imgTag, 'srcset');
        if (ss) cover = decodeHtmlEntities(ss.split(',')[0].trim().split(/\s+/)[0] || '').trim();
      }
      if (cover && baseUrl) { try { cover = new URL(cover, baseUrl).href; } catch (_) {} }

      // Title: prefer the card__title element's title attr, then img alt, then card__title text.
      var titleTag = (inner.match(/<[^>]*\bclass\s*=\s*["'][^"']*\bcard__title\b[^"']*["'][^>]*>/i) || [''])[0];
      var title = decodeHtmlEntities(_attr(titleTag, 'title')).trim();
      if (!title) title = decodeHtmlEntities(_attr(imgTag, 'alt')).trim();
      if (!title) title = _classText(inner, 'card__title');
      title = _norm(title);

      out.push({
        title: title,
        url: url,
        slug: slug,
        cover: cover,
        chapter: _classText(inner, 'card__ch'),
        time: _classText(inner, 'card__time')
      });
    }
    return out;
  }

  /**
   * Pull a series synopsis out of a fetched title-page HTML for the hover popup.
   * Prefers og:description, falls back to the standard meta description (both are
   * present in comix's SSR <head>). Returns '' when absent. Never throws.
   */
  function parseMetaDescription(html) {
    if (!html) return '';
    var head = String(html).slice(0, 60000); // metas live in <head>; cap the scan
    var m = head.match(/<meta\b[^>]*\bproperty\s*=\s*["']og:description["'][^>]*>/i)
      || head.match(/<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*>/i)
      || head.match(/<meta\b[^>]*\bproperty\s*=\s*["']og:description["'][^>]*>/i);
    if (!m) return '';
    return _norm(decodeHtmlEntities(_attr(m[0], 'content')));
  }

  // Pull the `"title"` values out of a `"<key>":[{...}]` array in comix's title-page
  // flight data (e.g. "genres":[{"id":11,"title":"Drama","slug":"drama"}, …]). Robust
  // to JSON \uXXXX escapes; returns [] when absent. The arrays contain only objects
  // (no nested `]`), so a non-greedy bracket capture is safe.
  function _arrayTitles(html, key) {
    var m = String(html).match(new RegExp('"' + key + '"\\s*:\\s*(\\[[^\\]]*\\])'));
    if (!m) return [];
    try {
      var arr = JSON.parse(m[1]);
      return arr.map(function (o) { return o && o.title ? String(o.title) : ''; }).filter(Boolean);
    } catch (_) {
      var out = [], re = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g, t;
      while ((t = re.exec(m[1]))) { try { out.push(JSON.parse('"' + t[1] + '"')); } catch (e) { out.push(t[1]); } }
      return out;
    }
  }

  /**
   * Parse a fetched title-page HTML into the metadata the hover popup shows:
   *   { description, genres[], demographics[], tags[], type, status }
   * Genres/tags come from the SSR flight-data JSON (not the client-rendered chips),
   * description from og:description. Never throws.
   */
  function parseTitleMeta(html) {
    if (!html) return { description: '', genres: [], demographics: [], tags: [], type: '', status: '' };
    var h = String(html);
    return {
      description: parseMetaDescription(h),
      genres: _arrayTitles(h, 'genres'),
      demographics: _arrayTitles(h, 'demographics'),
      tags: _arrayTitles(h, 'tags'),
      type: (h.match(/"type"\s*:\s*"([a-z0-9 _-]{1,24})"/i) || [, ''])[1],
      status: (h.match(/"status"\s*:\s*"([a-z0-9 _-]{1,24})"/i) || [, ''])[1]
    };
  }

  function _pick(o, keys) {
    if (!o) return undefined;
    for (var i = 0; i < keys.length; i++) { var v = o[keys[i]]; if (v != null && v !== '') return v; }
    return undefined;
  }
  function _num(v) { if (v == null || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function _fmt(o, keys) { var v = _pick(o, keys); return v == null ? '' : String(v); }

  /**
   * Parse a comix `/api/v1/user/...` titles response (following-titles / history) into rich
   * cards. Uses the real fields confirmed from the live API: `url` (canonical title link),
   * `poster.medium`, `latestChapter`, `synopsis`, `ratedAvg`, `type`/`status`/`contentRating`,
   * the per-context "time ago" strings, and `bookmarkPivot` for added-time / last-read.
   * Returns:
   *   { title, url, hid, cover, latestChapter, lastRead, progress, synopsis, rating,
   *     type, status, contentRating, time:{ chapterUpdated, added, updated, created, read } }
   * Tolerant of missing fields (history shape may differ); `baseUrl` resolves relative URLs.
   * Never throws.
   */
  function parseTitlesApi(json, baseUrl) {
    var items = json && json.result && json.result.items;
    if (!Array.isArray(items)) items = Array.isArray(json) ? json : (json && Array.isArray(json.items) ? json.items : []);
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i]; if (!it || typeof it !== 'object') continue;
      var hid = _pick(it, ['hid', 'hashId', 'id']);
      if (hid == null) continue;
      hid = String(hid);
      var bp = it.bookmarkPivot || it.pivot || {};
      var rp = (it.readProgress && typeof it.readProgress === 'object') ? it.readProgress : {};
      var poster = it.poster || it.cover || {};
      var cover = (typeof poster === 'string') ? poster : _pick(poster, ['medium', 'large', 'small', 'url']) || '';
      if (cover && baseUrl) { try { cover = new URL(cover, baseUrl).href; } catch (_) {} }
      var url = it.url || ('/title/' + hid);
      if (baseUrl) { try { url = new URL(url, baseUrl).href; } catch (_) {} }
      // Reading-History items carry a readProgress with the exact resume chapter URL.
      var resumeUrl = rp.chapterUrl || '';
      if (resumeUrl && baseUrl) { try { resumeUrl = new URL(resumeUrl, baseUrl).href; } catch (_) {} }

      var latest = _num(_pick(it, ['latestChapter', 'lastChapter', 'newestChapter', 'chapter']));
      var lastRead = _num(_pick(rp, ['chapter']));
      if (lastRead == null) lastRead = _num(_pick(it, ['userChapter', 'lastReadChapter', 'readChapter', 'currentChapter']));
      if (lastRead == null) lastRead = _num(_pick(bp, ['userChapter', 'lastReadChapter']));
      if (lastRead === 0) lastRead = null; // 0 = not started
      var progress = _num(_pick(rp, ['percent']));
      if (progress == null) progress = _num(_pick(it, ['progress', 'percent', 'percentage']));
      if (progress == null && lastRead != null && latest && latest > 0) progress = Math.round((lastRead / latest) * 100);
      var pNum = (progress == null) ? null : Math.max(0, Math.min(100, Math.round(progress)));

      var alts = Array.isArray(it.altTitles) ? it.altTitles.map(function (x) { return _norm(x); }).filter(Boolean) : [];
      out.push({
        title: _norm(it.title || it.name || ''),
        altTitles: alts,
        url: url, hid: hid, cover: cover, resumeUrl: resumeUrl,
        latestChapter: latest, lastRead: lastRead, progress: pNum,
        synopsis: _norm(it.synopsis || it.description || ''),
        rating: _num(_pick(it, ['ratedAvg', 'rating', 'score'])),
        type: it.type || '', status: it.status || '', contentRating: it.contentRating || '',
        time: {
          chapterUpdated: _fmt(it, ['chapterUpdatedAtFormatted']),
          added: _fmt(bp, ['addedAtFormatted']) || _fmt(it, ['addedAtFormatted', 'followedAtFormatted']),
          updated: _fmt(it, ['updatedAtFormatted']),
          created: _fmt(it, ['createdAtFormatted']),
          read: _fmt(rp, ['readAtFormatted']) || _fmt(bp, ['lastReadAtFormatted', 'readAtFormatted']) || _fmt(it, ['lastReadAtFormatted', 'readAtFormatted', 'updatedAtFormatted'])
        }
      });
    }
    return out;
  }

  /**
   * Parse comix's `GET /api/v1/collections` response into landscape collection cards:
   *   { id, name, url, owner, itemCount, likeCount, time, covers[] }
   * Collections are user-made lists of comics (not comics). `covers` are best-effort thumbnails
   * (field name varies / may be absent — render a placeholder when empty). `url` prefers an
   * explicit field, else falls back to `/collection/{id}`. `baseUrl` resolves relative URLs.
   * Never throws.
   */
  function parseCollectionsApi(json, baseUrl) {
    var items = json && json.result && json.result.items;
    if (!Array.isArray(items)) items = Array.isArray(json) ? json : (json && Array.isArray(json.items) ? json.items : []);
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i]; if (!it || typeof it !== 'object') continue;
      var id = _pick(it, ['id', 'hashId', 'hid']); if (id == null) continue;
      id = String(id);
      var url = it.url || it.path || ('/collection/' + id);
      if (baseUrl) { try { url = new URL(url, baseUrl).href; } catch (_) {} }
      // covers: try several shapes, then fall back to the contained titles' posters.
      var covers = [];
      var cand = it.covers || it.thumbnails || it.previewCovers || it.posters || it.images;
      if (Array.isArray(cand)) covers = cand.map(function (c) { return typeof c === 'string' ? c : (c ? _pick(c, ['medium', 'large', 'small', 'url', 'thumbnail']) : ''); }).filter(Boolean);
      if (!covers.length && Array.isArray(it.items)) {
        covers = it.items.map(function (x) { var p = x && (x.poster || x.cover); return p ? (typeof p === 'string' ? p : _pick(p, ['medium', 'large', 'small', 'url'])) : ''; }).filter(Boolean);
      }
      if (baseUrl) covers = covers.map(function (c) { try { return new URL(c, baseUrl).href; } catch (_) { return c; } });
      var owner = it.owner && typeof it.owner === 'object' ? (it.owner.username || it.owner.displayName || it.owner.name || '') : (it.owner || it.username || '');
      out.push({
        id: id, name: _norm(it.name || it.title || ''), url: url, owner: _norm(owner),
        itemCount: _num(_pick(it, ['itemCount', 'count', 'titlesCount', 'titleCount'])) || 0,
        likeCount: _num(_pick(it, ['likeCount', 'likes', 'favoriteCount'])) || 0,
        covers: covers.slice(0, 3),
        time: _fmt(it, ['updatedAtFormatted', 'createdAtFormatted', 'addedAtFormatted'])
      });
    }
    return out;
  }

  /**
   * Has the reader already read this title's latest chapter? True only when we know
   * both numbers and the last-read chapter is at/after the latest one. Unknown latest
   * or unknown last-read ⇒ false (treat as "has something new"), so a title is only
   * dropped from the hero when we're certain it's caught up.
   */
  function isCaughtUp(t) {
    if (!t) return false;
    var latest = _num(t.latestChapter);
    var read = _num(t.lastRead);
    if (latest == null || read == null) return false;
    return read >= latest;
  }

  /**
   * Choose up to `n` titles to feature in the hero. Prefers titles with an UNREAD
   * latest chapter (so a series you just finished stops being featured the moment you
   * return to Home); only falls back to caught-up titles to fill empty slots, so the
   * hero never collapses when everything has been read. Input order is preserved
   * (callers pass newest-chapter-first), which keeps "freshest unread" on top.
   */
  function selectHero(cards, n) {
    n = n || 2;
    var list = (cards || []).filter(Boolean);
    var fresh = [], caughtUp = [];
    for (var i = 0; i < list.length; i++) (isCaughtUp(list[i]) ? caughtUp : fresh).push(list[i]);
    return fresh.concat(caughtUp).slice(0, n);
  }

  /**
   * Order titles for the "What's New" feed: UNREAD (you haven't read the latest chapter) first,
   * then already-read — each group keeping the caller's order (chapter_updated_desc = newest first).
   * Returns shallow clones annotated with `unread:boolean`. Never throws.
   */
  function sortFeed(cards) {
    var list = (cards || []).filter(Boolean);
    var fresh = [], read = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i], u = !isCaughtUp(t);
      var c = {}; for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k)) c[k] = t[k];
      c.unread = u; (u ? fresh : read).push(c);
    }
    return fresh.concat(read);
  }

  /**
   * Parse comix's `GET /api/v1/user` response into { loggedIn, name }.
   * Logged-in shape: { status:'ok', result:{ id, username, displayName, … } }.
   * Logged-out returns a non-ok status / no real identity (or a guest flag). Prefers displayName,
   * falls back to username/name. Tolerant of top-level vs result-nested shapes. Never throws.
   */
  function parseUser(json) {
    if (!json || typeof json !== 'object') return { loggedIn: false, name: '' };
    var r = (json.result && typeof json.result === 'object') ? json.result
      : (json.user && typeof json.user === 'object') ? json.user
      : (json.username || json.displayName || json.id) ? json : null;
    if (!r) return { loggedIn: false, name: '' };
    var guest = r.guest === true || r.isGuest === true || /^(guest|anonymous|anon)$/i.test(String(r.username || ''));
    var hasIdentity = !!(r.username || r.id) && !guest;
    return { loggedIn: hasIdentity, name: hasIdentity ? _norm(r.displayName || r.username || r.name || '') : '' };
  }

  // ── Section registry — every section the custom Home can show ────────────────
  // `source:'api'`  → we fetch comix's JSON and render it (personal sections).
  // `source:'dom'`  → comix already rendered this carousel on the Home; we re-render its
  //                   `a.card`s in our own style and hide the native original (global sections).
  // `match` (dom only): candidate heading texts (normalized, substring) used to find the
  //                   native `section.section` for that id. `id` order here == default order.
  // `defaultOn` — whether the section is enabled in a fresh config (personal rails on; the feed,
  // global carousels and collections off / opt-in).
  // `layout:'feed'` — render as a vertical "what's new" feed (unread-first) instead of a rail.
  var HOME_SECTIONS = [
    { id: 'whats-new', title: 'What’s New', sub: 'New chapters across everything you follow',
      source: 'api', api: '/api/v1/user/following-titles?sort=chapter_updated_desc&folder_ids[]=1', layout: 'feed', timeKey: 'chapterUpdated' },
    { id: 'continue-reading', title: 'Continue Reading', sub: 'Pick up where you left off',
      source: 'api', api: '/api/v1/user/history', progress: true, timeKey: 'read', defaultOn: true },
    { id: 'new-chapters', title: 'New Chapters from Followed Comics', sub: 'Fresh chapters from series you follow',
      source: 'api', api: '/api/v1/user/following-titles?sort=chapter_updated_desc&folder_ids[]=1', feedsHero: true, timeKey: 'chapterUpdated', defaultOn: true },
    { id: 'recently-followed', title: 'Recently Followed Comics', sub: 'The newest titles you added to your library',
      source: 'api', api: '/api/v1/user/following-titles?sort=added_desc', timeKey: 'added', defaultOn: true },
    { id: 'most-recent-popular', title: 'Most Recent Popular', sub: 'Trending across comix right now',
      source: 'dom', match: ['most recent popular'] },
    { id: 'most-follows-new', title: 'Most Follows · New Comics', sub: 'New series gaining followers fast',
      source: 'dom', match: ['most follows'] },
    { id: 'latest-updates', title: 'Latest Updates', sub: 'The newest chapters site-wide',
      source: 'dom', match: ['latest updates'] },
    // Collections are user-made lists/folders of comics, not comics — own API + own (landscape) card.
    { id: 'user-collections', title: 'User Collections', sub: 'Curated lists from the community',
      source: 'collections', api: '/api/v1/collections?sort=recent' }
  ];
  var _byId = Object.create(null);
  for (var _i = 0; _i < HOME_SECTIONS.length; _i++) _byId[HOME_SECTIONS[_i].id] = HOME_SECTIONS[_i];

  // The default ordered selection: the three personal rails on; feed/globals/collections off.
  function defaultHomeSections() {
    return HOME_SECTIONS.map(function (s) { return { id: s.id, on: !!s.defaultOn }; });
  }

  /**
   * Normalize a stored `home.sections` value into a full, ordered `[{id,on}]` list over the
   * known section ids: drops unknown ids and duplicates, coerces `on` to boolean, preserves the
   * stored order, then appends any known sections missing from the stored list (off, in registry
   * order) so newly added sections always surface. Tolerant of garbage; never throws.
   */
  function normalizeSections(stored) {
    var out = [], seen = Object.create(null);
    if (Array.isArray(stored)) {
      for (var i = 0; i < stored.length; i++) {
        var it = stored[i];
        var id = it && typeof it === 'object' ? it.id : it; // accept [{id,on}] or ['id', …]
        if (typeof id !== 'string' || !_byId[id] || seen[id]) continue;
        seen[id] = true;
        out.push({ id: id, on: it && typeof it === 'object' ? Boolean(it.on) : true });
      }
    }
    for (var j = 0; j < HOME_SECTIONS.length; j++) {
      var s = HOME_SECTIONS[j];
      if (!seen[s.id]) out.push({ id: s.id, on: !!s.defaultOn });
    }
    return out;
  }

  /**
   * Resolve a stored `home.sections` value into the ordered list of registry entries that are
   * ON, each shallow-cloned with its `order` index (position among enabled sections). Used by
   * content_home to know what to render and in what flex order.
   */
  function resolveSections(stored) {
    var norm = normalizeSections(stored);
    var out = [], order = 0;
    for (var i = 0; i < norm.length; i++) {
      if (!norm[i].on) continue;
      var base = _byId[norm[i].id];
      var entry = {};
      for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) entry[k] = base[k];
      entry.order = order++;
      out.push(entry);
    }
    return out;
  }

  /**
   * Match a native `section.section` heading text to a registry section id (global/dom sources
   * only), case/space-insensitive, substring. Returns the id, or null when nothing matches.
   */
  function matchNativeSection(headingText) {
    var t = _norm(headingText).toLowerCase();
    if (!t) return null;
    for (var i = 0; i < HOME_SECTIONS.length; i++) {
      var s = HOME_SECTIONS[i];
      if (s.source !== 'dom' || !s.match) continue;
      for (var j = 0; j < s.match.length; j++) {
        if (t === s.match[j] || t.indexOf(s.match[j]) !== -1) return s.id;
      }
    }
    return null;
  }

  var CDLHomeCore = {
    KEEP_HEADINGS: KEEP_HEADINGS,
    HOME_SECTIONS: HOME_SECTIONS,
    decodeHtmlEntities: decodeHtmlEntities,
    classifyHomeSection: classifyHomeSection,
    parseFollowedTitles: parseFollowedTitles,
    parseMetaDescription: parseMetaDescription,
    parseTitleMeta: parseTitleMeta,
    parseTitlesApi: parseTitlesApi,
    parseCollectionsApi: parseCollectionsApi,
    parseUser: parseUser,
    isCaughtUp: isCaughtUp,
    selectHero: selectHero,
    sortFeed: sortFeed,
    defaultHomeSections: defaultHomeSections,
    normalizeSections: normalizeSections,
    resolveSections: resolveSections,
    matchNativeSection: matchNativeSection
  };

  global.CDLHomeCore = CDLHomeCore;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CDLHomeCore; // for Node-based unit tests
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
