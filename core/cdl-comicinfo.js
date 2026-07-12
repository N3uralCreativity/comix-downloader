/**
 * cdl-comicinfo.js — Comix Downloader ComicInfo.xml builder (V2.2.0)
 *
 * DOM-free, window-free, chrome-free pure helper. Loaded as a classic script that
 * attaches `globalThis.CDLComicInfo`, AND exported via module.exports so the same
 * file is unit-testable under plain `node` (mirrors settings.js / cdl-features-core.js).
 *
 * ComicInfo.xml is the metadata sidecar that Komga, Kavita, Mihon (local source),
 * YACReader, Tachiyomi, etc. read from inside a .cbz/.cbr. We write one per chapter.
 */
(function (global) {
  'use strict';

  function xmlEscape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // Emitted in this order (loosely the ComicInfo.xsd element sequence) for tidy,
  // tool-friendly files. Empty/missing fields are skipped.
  var FIELD_ORDER = [
    'Title', 'Series', 'Number', 'Count', 'Volume', 'Summary',
    'Year', 'Month', 'Day', 'Writer', 'Penciller', 'Genre', 'Tags',
    'Web', 'PageCount', 'LanguageISO', 'Manga'
  ];

  // Build a ComicInfo.xml string from a flat fields object. Arrays (genres/tags)
  // are joined with ", ". Unknown or empty fields are omitted. Never throws.
  function buildComicInfoXml(fields) {
    fields = fields || {};
    var map = {
      Title: fields.title,
      Series: fields.series,
      Number: fields.number,
      Count: fields.count,
      Volume: fields.volume,
      Summary: fields.summary,
      Year: fields.year,
      Month: fields.month,
      Day: fields.day,
      Writer: fields.writer,
      Penciller: fields.penciller,
      Genre: Array.isArray(fields.genres) ? fields.genres.join(', ') : fields.genres,
      Tags: Array.isArray(fields.tags) ? fields.tags.join(', ') : fields.tags,
      Web: fields.web,
      PageCount: fields.pageCount,
      LanguageISO: fields.language,
      Manga: fields.manga
    };

    var lines = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">'
    ];
    for (var i = 0; i < FIELD_ORDER.length; i++) {
      var key = FIELD_ORDER[i];
      var val = map[key];
      if (val == null) continue;
      var str = String(val).trim();
      if (str === '') continue;
      lines.push('  <' + key + '>' + xmlEscape(str) + '</' + key + '>');
    }
    lines.push('</ComicInfo>');
    return lines.join('\n') + '\n';
  }

  var CDLComicInfo = { buildComicInfoXml: buildComicInfoXml, xmlEscape: xmlEscape };

  global.CDLComicInfo = CDLComicInfo;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CDLComicInfo; // for Node-based unit tests
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
