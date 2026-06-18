/**
 * cdl-features-core.js — Comix Downloader "Additional Features" pure logic (V2.0.2)
 *
 * DOM-free, window-free, chrome-free. Loaded as a classic script that attaches
 * `globalThis.CDLFeaturesCore`, AND exported via module.exports so the same file is
 * unit-testable under plain `node` (mirrors the settings.js dual-context pattern).
 *
 * This module owns the *correctness* of the three site features:
 *   - parseChapterNumber : robust chapter-number parsing (ch22 == 22, 22.5 distinct,
 *                          volumes/seasons stripped, specials & ranges handled).
 *   - sortChapters       : strict numeric ascending order (specials last).
 *   - dedupeChapters     : one entry per chapter number (first occurrence kept).
 *   - computeAdjacentChapter / pickCandidateUrl : the reader "true next/prev" with
 *                          source switching.
 *
 * It is deliberately free of any DOM/network code so it can be reasoned about and
 * tested in isolation; content_features.js does the impure DOM/fetch wiring.
 */
(function (global) {
  'use strict';

  // Words that mark a non-numbered "special" chapter. Order doesn't matter.
  var SPECIAL_WORDS = [
    'side story', 'side-story', 'sidestory', 'oneshot', 'one-shot',
    'extra', 'omake', 'bonus', 'special', 'gaiden', 'epilogue',
    'prologue', 'interlude', 'afterword'
  ];

  // Matches a chapter path inside arbitrary text (raw JSON, hrefs, …).
  // e.g. /title/solo-leveling/9517864-chapter-92
  var CHAPTER_PATH_RE = /\/title\/[a-z0-9-]+\/\d+-chapter-[\w.-]+/gi;

  // Canonical extractor: the `{id}-chapter-{label}` segment is authoritative.
  var CHAPTER_SEG_RE = /(?:^|\/)(\d+)-chapter-([0-9a-z._-]+?)(?:[/?#]|$)/i;

  var KIND_RANK = { num: 0, special: 1, unknown: 2 };

  function _text(entry) {
    if (entry == null) return '';
    if (typeof entry === 'string') return entry;
    return entry.chapterUrl || entry.chapterLabel || entry.url || entry.label || '';
  }

  /**
   * Parse a chapter label OR url into a sort key:
   *   { kind:'num'|'special'|'unknown', value:Number, special:String|null, raw:String }
   * Never throws.
   */
  function parseChapterNumber(input) {
    var raw = String(input == null ? '' : input);
    var s = raw.trim();

    // If it's a path/url, the `-chapter-X` segment wins (collapses ch22 / 22 / Chapter 22).
    var seg = s.match(CHAPTER_SEG_RE);
    if (seg) s = seg[2];

    s = s.toLowerCase().trim();

    // A "special" if any keyword is present (may also carry a number, e.g. "Extra 2").
    var special = null;
    for (var i = 0; i < SPECIAL_WORDS.length; i++) {
      if (s.indexOf(SPECIAL_WORDS[i]) !== -1) { special = SPECIAL_WORDS[i]; break; }
    }

    // Drop volume/season/part qualifiers — only the chapter number drives neighbor logic.
    var t = s
      .replace(/\bvol(?:ume)?\.?\s*\d+(?:\.\d+)?/g, ' ')
      .replace(/\bseasons?\.?\s*\d+/g, ' ')
      .replace(/\bs\s*\d+\b/g, ' ')
      .replace(/\bparts?\.?\s*\d+/g, ' ')
      .replace(/\bpt\.?\s*\d+/g, ' ');

    // Drop the chapter word itself ("chapter 5", "ch. 5", "ep 5" → " 5"). Word-bounded so
    // "ch22" (no boundary) is untouched and still yields 22 below.
    t = t.replace(/\b(?:chapters?|chaps?|ch|episodes?|epis?|ep|#)\b\.?/g, ' ');

    var num = t.match(/(\d+(?:\.\d+)?)/);
    var value = num ? parseFloat(num[1]) : NaN;

    if (special) {
      return { kind: 'special', value: isFinite(value) ? value : Infinity, special: special, raw: raw };
    }
    if (isFinite(value)) {
      return { kind: 'num', value: value, special: null, raw: raw };
    }
    return { kind: 'unknown', value: Infinity, special: null, raw: raw };
  }

  function parseEntry(entry) { return parseChapterNumber(_text(entry)); }

  // Stable identity for "the same chapter". ch22 / 22 / Chapter 22 share it; 22.5 differs.
  function dedupeKey(p) {
    if (p.kind === 'num') return 'n:' + p.value;
    if (p.kind === 'special') return 's:' + p.special + ':' + (isFinite(p.value) ? p.value : '');
    return 'u:' + String(p.raw).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // Order: numbers asc, then specials (by name then value), then unknowns. Stable.
  function compareChapters(a, b) {
    var ra = KIND_RANK[a.kind], rb = KIND_RANK[b.kind];
    if (ra !== rb) return ra - rb;
    if (a.kind === 'special' && a.special !== b.special) {
      return a.special < b.special ? -1 : 1;
    }
    if (a.value !== b.value) {
      // NaN-safe (shouldn't occur — value is finite or Infinity).
      if (!isFinite(a.value)) return 1;
      if (!isFinite(b.value)) return -1;
      return a.value - b.value;
    }
    return 0;
  }

  // Numeric ascending sort of an entry list (specials last). Stable, returns a new array.
  function sortChapters(list) {
    var arr = (list || []).map(function (e, idx) { return { e: e, p: parseEntry(e), idx: idx }; });
    arr.sort(function (x, y) {
      var c = compareChapters(x.p, y.p);
      return c !== 0 ? c : x.idx - y.idx;
    });
    return arr.map(function (w) { return w.e; });
  }

  // Keep one entry per chapter number, first occurrence in input order. Does NOT sort.
  function dedupeChapters(list) {
    var seen = Object.create(null);
    var out = [];
    (list || []).forEach(function (e) {
      var k = dedupeKey(parseEntry(e));
      if (!seen[k]) { seen[k] = true; out.push(e); }
    });
    return out;
  }

  /**
   * Build a sorted, unique-by-number index. Each node keeps every candidate url for that
   * number (one per source) so the reader can prefer a source:
   *   [{ key, parsed, candidates:[url,…] }, …]  sorted ascending.
   */
  function buildChapterIndex(list) {
    var map = new Map();
    (list || []).forEach(function (e) {
      var p = parseEntry(e);
      var k = dedupeKey(p);
      if (!map.has(k)) map.set(k, { key: k, parsed: p, candidates: [] });
      map.get(k).candidates.push(_text(e));
    });
    var arr = [];
    map.forEach(function (v) { arr.push(v); });
    arr.sort(function (a, b) { return compareChapters(a.parsed, b.parsed); });
    return arr;
  }

  function chapterIdOf(url) {
    var m = String(url == null ? '' : url).match(/(?:^|\/)(\d+)-chapter-/i);
    return m ? parseInt(m[1], 10) : null;
  }

  /**
   * The true numeric neighbor of `currentUrl` in `direction` (+1 next / -1 prev), across
   * ALL sources. Returns the index node ({key,parsed,candidates}) or null at the boundary.
   * If the current chapter isn't in the list, snaps to the nearest numbered entry first.
   */
  function computeAdjacentChapter(list, currentUrl, direction) {
    var index = buildChapterIndex(list);
    if (!index.length) return null;

    var cur = parseChapterNumber(currentUrl);
    var curKey = dedupeKey(cur);
    var i = -1;
    for (var n = 0; n < index.length; n++) { if (index[n].key === curKey) { i = n; break; } }

    if (i === -1) {
      // Stale/unknown current: snap to nearest numbered entry by value.
      if (cur.kind === 'num') {
        var best = -1, bestD = Infinity;
        for (var m = 0; m < index.length; m++) {
          if (index[m].parsed.kind !== 'num') continue;
          var d = Math.abs(index[m].parsed.value - cur.value);
          if (d < bestD) { bestD = d; best = m; }
        }
        i = best;
      }
      if (i === -1) return null;
    }

    var j = i + (direction >= 0 ? 1 : -1);
    if (j < 0 || j >= index.length) return null;
    return index[j];
  }

  /**
   * Choose one url from an index node's candidates, preferring the source whose numeric
   * chapter-id is closest to the current chapter's id (a free, metadata-less heuristic to
   * stay on the same source when possible). Falls back to the first candidate.
   */
  function pickCandidateUrl(node, currentUrl) {
    if (!node || !node.candidates || !node.candidates.length) return null;
    if (node.candidates.length === 1) return node.candidates[0];
    var curId = chapterIdOf(currentUrl);
    if (curId == null) return node.candidates[0];
    var best = node.candidates[0], bestD = Infinity;
    node.candidates.forEach(function (u) {
      var id = chapterIdOf(u);
      if (id == null) return;
      var d = Math.abs(id - curId);
      if (d < bestD) { bestD = d; best = u; }
    });
    return best;
  }

  // Raw chapter-path matches inside arbitrary text (pure; normalization stays in the DOM file).
  function extractChapterPaths(text) {
    if (!text) return [];
    var matches = String(text).match(CHAPTER_PATH_RE) || [];
    return Array.from(new Set(matches));
  }

  // Minimal HTML-attribute entity decode (enough for URLs in src=""): keep &amp;
  // last so we never turn "&amp;lt;" into "<".
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

  // Reader page-image extraction for the 2026 comix.to reader redesign. Each page
  // renders as <img class="rpage-page__img" alt="Page N" src="<opaque url>"> inside
  // a virtualized list; the URLs are opaque + extension-less, so they can NOT be
  // enumerated the way the old "01.webp..NN.webp" scheme allowed — we must read the
  // actual src of every page image. This parses them out of an HTML string (pass the
  // raw, pre-virtualization server HTML to get the full set) into [{src,index}],
  // deduped by page number and sorted ascending. `baseUrl` resolves relative srcs.
  //
  // NOTE: an inline copy of this lives in background.js (extractChapterImagesFromPage,
  // injected into the page where it can't import this module) — keep the two in sync.
  function parseReaderImages(html, baseUrl) {
    if (!html) return [];
    var byIndex = new Map();
    var tags = String(html).match(/<img\b[^>]*>/gi) || [];
    for (var i = 0; i < tags.length; i++) {
      var tag = tags[i];
      if (!/\brpage-page__img\b/.test(tag)) continue;
      var srcM = tag.match(/\bsrc\s*=\s*"([^"]+)"/i) || tag.match(/\bsrc\s*=\s*'([^']+)'/i);
      if (!srcM) continue;
      var src = decodeHtmlEntities(srcM[1]).trim();
      if (!src || /^data:/i.test(src)) continue;
      if (baseUrl) { try { src = new URL(src, baseUrl).href; } catch (_) {} }
      var altM = tag.match(/\balt\s*=\s*"[^"]*?(\d+)[^"]*"/i) || tag.match(/\balt\s*=\s*'[^']*?(\d+)[^']*'/i);
      var index = altM ? parseInt(altM[1], 10) : (byIndex.size + 1);
      if (!byIndex.has(index)) byIndex.set(index, { src: src, index: index });
    }
    return Array.from(byIndex.values()).sort(function (a, b) { return a.index - b.index; });
  }

  var CDLFeaturesCore = {
    SPECIAL_WORDS: SPECIAL_WORDS,
    CHAPTER_PATH_RE: CHAPTER_PATH_RE,
    parseChapterNumber: parseChapterNumber,
    dedupeKey: dedupeKey,
    compareChapters: compareChapters,
    sortChapters: sortChapters,
    dedupeChapters: dedupeChapters,
    buildChapterIndex: buildChapterIndex,
    chapterIdOf: chapterIdOf,
    computeAdjacentChapter: computeAdjacentChapter,
    pickCandidateUrl: pickCandidateUrl,
    extractChapterPaths: extractChapterPaths,
    parseReaderImages: parseReaderImages
  };

  global.CDLFeaturesCore = CDLFeaturesCore;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CDLFeaturesCore; // for Node-based unit tests
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
