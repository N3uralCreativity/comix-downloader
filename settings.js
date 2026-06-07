/**
 * settings.js — Comix Downloader shared settings module (V2.0.0)
 *
 * Single source of truth for user configuration. Loaded as a plain classic
 * script in FOUR contexts and attaches `globalThis.CDLSettings`:
 *   - Service worker (Chrome): importScripts('settings.js')
 *   - Service worker (Firefox): listed in background.scripts
 *   - Content script: listed before content_title.js in manifest content_scripts
 *   - popup.html / options.html: <script src="settings.js"></script>
 *
 * No DOM / window assumptions. Defaults equal the v1.1.2 hardcoded behavior, so
 * an untouched config reproduces the previous version exactly.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'cdlSettings';

  // chrome.* is present in every extension context; Firefox also exposes browser.*.
  var storage = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
    ? chrome.storage.local
    : null;

  // ── DEFAULTS (each value == current v1.1.2 literal) ──────────────────────────
  var DEFAULTS = {
    // Download & ZIP
    'download.splitMode': 'multipart',     // 'multipart' | 'single'
    'download.chaptersPerPart': 5,         // ZIP_PART_MAX_CHAPTERS
    'download.mbPerPart': 300,             // ZIP_PART_MAX_BYTES / 1MB
    'download.concurrentChapters': 1,      // how many chapters "Download All" fetches at once (1 = original behavior)
    'download.skipDownloaded': true,       // in Download All, default to only chapters not already grabbed

    // Output format & library
    'output.format': 'zip',                // 'zip' (folders of images) | 'cbz' (per-chapter comic file)
    'output.includeComicInfo': true,       // write ComicInfo.xml per chapter
    'output.includeSeriesMeta': false,     // save cover.jpg + series.json for the series
    'output.folderLayout': 'default',      // 'default' (Ch0001) | 'kavita' (Series/Series - Chapter 0001)

    // Reader
    'reader.keyboardShortcuts': false,     // J/K or arrows = prev/next chapter, D = download current

    // Performance & Network
    'perf.batchSize': 3,                   // BATCH_SIZE
    'perf.rateLimitMode': 'dynamic',       // 'dynamic' | 'fixed' | 'off'
    'perf.rateBaseMs': 1500,
    'perf.rateMinMs': 800,
    'perf.rateMaxMs': 8000,
    'perf.imageTimeoutMs': 30000,
    'perf.tabLoadTimeoutMs': 120000,
    'perf.pagePollMs': 400,                // poll interval waiting for first page image
    'perf.pageSettleMs': 300,              // settle wait after page images are detected
    'perf.scrollSettleMs': 800,            // wait after a scroll-nudge to trigger lazy loading

    // Retries (0 == current "skip on failure" behavior)
    'retry.imageRetries': 0,
    'retry.chapterRetries': 0,

    // Naming & organization
    'naming.imagePadDigits': 3,
    'naming.chapterFolderFmt': 'Ch{num4}{rest}',
    'naming.singleZipTpl': '{manga}-Ch{chapter}',
    'naming.allZipTpl': '{manga}',
    'naming.slugMaxLen': 60,

    // Appearance — buttons
    'appearance.btnStyle': 'icon',         // 'icon' | 'icon+text'
    'appearance.accentMode': 'auto',       // 'auto' | 'custom'
    'appearance.accentColor': '#60a5fa',
    'appearance.btnScale': 1,
    'appearance.disableAnim': false,
    'appearance.allLabel': 'Download All',
    'appearance.allowFloating': true,

    // Appearance — progress frame
    'frame.position': 'bottom-right',      // bottom-right | bottom-left | top-right | top-left
    'frame.width': 380,
    'frame.autoHideSec': 0,                // 0 = never auto-hide

    // Advanced / risky
    'advanced.disableScramble': false,
    'advanced.imageFormat': 'preserve',    // 'preserve' | 'png' | 'jpg'
    'advanced.jpgQuality': 0.85,
    'advanced.aggressiveRetrieval': false,

    // Logs
    'logs.maxEntries': 500,                // MAX_LOG_ENTRIES

    // Additional Features (comix.to site enhancements — all OFF by default)
    'features.dedupeChapters': false,      // hide duplicate chapters in the title list
    'features.enforceChapterOrder': false, // force ascending numeric order in the list
    'features.fixReaderNav': false         // accurate reader next/prev w/ source switching
  };

  // ── SCHEMA (type, bounds, risk, label, help) ─────────────────────────────────
  // risk: 'none' | 'glitchy' | 'risky'. `warn` shows in the confirm dialog.
  var SCHEMA = {
    'download.splitMode': { type: 'enum', enum: ['multipart', 'single'], risk: 'risky',
      label: 'ZIP splitting', help: 'How a full-series "Download All" is packaged.',
      options: { multipart: 'Multiple parts (recommended)', single: 'One single ZIP' },
      warn: 'A single ZIP for a whole series can exhaust memory and fail to download or unzip on large titles. Multi-part is much safer.' },
    'download.chaptersPerPart': { type: 'int', min: 1, max: 50, risk: 'none',
      label: 'Chapters per part', help: 'Start a new ZIP part after this many chapters.' },
    'download.mbPerPart': { type: 'int', min: 50, max: 2000, risk: 'glitchy',
      label: 'Max size per part (MB)', help: 'Start a new ZIP part after this size.',
      warn: 'Parts larger than ~800 MB may strain memory while the ZIP is being built.' },
    'download.concurrentChapters': { type: 'int', min: 1, max: 4, risk: 'risky',
      label: 'Chapters at once', help: 'How many chapters "Download All" fetches at the same time (it opens that many background tabs at once). 1 = one chapter at a time — the original, safest behavior. Higher = faster, but far more aggressive toward comix.to.',
      warn: 'This multiplies how hard the extension hits comix.to (more open tabs AND more image requests at once). 1 is safe. 2 is already risky and can cause skipped or scrambled pages. 3–4 is almost certain to get your IP temporarily blocked by the site. Such blocks are usually short — typically a few minutes up to about an hour, occasionally up to ~24 hours if you keep pushing — but while blocked, pages (and whole chapters) can fail. If you raise this, keep "Parallel image downloads" low and leave rate limiting on.' },
    'download.skipDownloaded': { type: 'bool', risk: 'none',
      label: 'Skip already-downloaded', help: 'In "Download All", default to only the chapters you have not downloaded yet. You can still choose "All" in the panel to re-download everything.' },

    'output.format': { type: 'enum', enum: ['zip', 'cbz'], risk: 'none',
      label: 'Download format', help: 'ZIP keeps plain folders of images. CBZ makes one comic file per chapter that opens directly in Komga, Kavita, Mihon, YACReader, etc.',
      options: { zip: 'ZIP (folders of images)', cbz: 'CBZ (per chapter, library-ready)' } },
    'output.includeComicInfo': { type: 'bool', risk: 'none',
      label: 'Include ComicInfo.xml', help: 'Add a ComicInfo.xml (series, number, count, summary, tags…) to each chapter so library servers index it correctly.' },
    'output.includeSeriesMeta': { type: 'bool', risk: 'none',
      label: 'Include series info', help: 'Also save the cover image and a series.json (author, status, description, tags) for the series.' },
    'output.folderLayout': { type: 'enum', enum: ['default', 'kavita'], risk: 'none',
      label: 'Folder layout', help: 'How chapters are named and arranged inside the download.',
      options: { default: 'Default (Ch0001)', kavita: 'Kavita / Komga (Series / Series - Chapter 0001)' } },

    'reader.keyboardShortcuts': { type: 'bool', risk: 'none',
      label: 'Reader keyboard shortcuts', help: 'In the reader: J / K or ← / → jump to the previous / next chapter, and D downloads the current chapter. Ignored while typing in a text field.' },

    'perf.batchSize': { type: 'int', min: 1, max: 8, risk: 'glitchy',
      label: 'Parallel image downloads', help: 'How many images are fetched at once per chapter.',
      warn: 'More than 5 parallel downloads can trip the site’s rate-limiting and cause skipped images.' },
    'perf.rateLimitMode': { type: 'enum', enum: ['dynamic', 'fixed', 'off'], risk: 'risky',
      label: 'Rate limiting', help: 'Pacing between chapters during "Download All".',
      options: { dynamic: 'Dynamic (recommended)', fixed: 'Fixed delay', off: 'Off' },
      warn: 'Turning rate limiting OFF sends requests as fast as possible and can get your IP throttled or temporarily blocked by the site.' },
    'perf.rateBaseMs': { type: 'int', min: 0, max: 10000, risk: 'none',
      label: 'Base delay (ms)', help: 'Starting delay between chapters.' },
    'perf.rateMinMs': { type: 'int', min: 0, max: 10000, risk: 'none',
      label: 'Min delay (ms)', help: 'Fastest the dynamic limiter will go.' },
    'perf.rateMaxMs': { type: 'int', min: 1000, max: 30000, risk: 'none',
      label: 'Max delay (ms)', help: 'Slowest the dynamic limiter will back off to.' },
    'perf.imageTimeoutMs': { type: 'int', min: 5000, max: 120000, risk: 'glitchy',
      label: 'Image timeout (ms)', help: 'Give up on a single image after this long.',
      warn: 'A short timeout can cause more images to be skipped on slow connections.' },
    'perf.tabLoadTimeoutMs': { type: 'int', min: 30000, max: 300000, risk: 'none',
      label: 'Chapter load timeout (ms)', help: 'Give up opening a chapter tab after this long.' },
    'perf.pagePollMs': { type: 'int', min: 50, max: 3000, risk: 'risky',
      label: 'Page poll interval (ms)', help: 'How often to check whether the reader has rendered its first page image.',
      warn: 'Raising this slows every download; lowering it too far can give up before slow pages appear.' },
    'perf.pageSettleMs': { type: 'int', min: 0, max: 5000, risk: 'risky',
      label: 'Page settle delay (ms)', help: 'Pause after the reader appears, before reading page URLs from the DOM.',
      warn: 'Too short on a slow connection can miss late-loading pages.' },
    'perf.scrollSettleMs': { type: 'int', min: 0, max: 5000, risk: 'risky',
      label: 'Scroll settle delay (ms)', help: 'Pause after scrolling the reader to trigger lazy image loading.',
      warn: 'Too short can miss pages that only load once scrolled into view.' },

    'retry.imageRetries': { type: 'int', min: 0, max: 5, risk: 'none',
      label: 'Retry failed images', help: 'Re-attempt a failed image this many times (0 = skip, the default).' },
    'retry.chapterRetries': { type: 'int', min: 0, max: 3, risk: 'none',
      label: 'Retry failed chapters', help: 'Re-attempt a failed chapter this many times (0 = skip, the default).' },

    'naming.imagePadDigits': { type: 'int', min: 1, max: 5, risk: 'none',
      label: 'Image number padding', help: 'Zero-padding for page filenames (3 → 001.webp).' },
    'naming.chapterFolderFmt': { type: 'template', maxLen: 60, risk: 'glitchy',
      label: 'Chapter folder name', help: 'Folder per chapter inside the ZIP. Tokens: {num} {num2} {num4} {rest} {chapter} {manga}.',
      warn: 'Characters not allowed in filenames are replaced with "_" automatically.' },
    'naming.singleZipTpl': { type: 'template', maxLen: 80, risk: 'none',
      label: 'Single-chapter ZIP name', help: 'Tokens: {manga} {chapter} {date}.' },
    'naming.allZipTpl': { type: 'template', maxLen: 80, risk: 'none',
      label: '"Download All" ZIP name', help: 'Tokens: {manga} {date}.' },
    'naming.slugMaxLen': { type: 'int', min: 10, max: 120, risk: 'none',
      label: 'Max name length', help: 'Cap on the sanitized series name used in filenames.' },

    'appearance.btnStyle': { type: 'enum', enum: ['icon', 'icon+text'], risk: 'none',
      label: 'Download button style', help: 'Per-chapter button appearance.',
      options: { icon: 'Icon only', 'icon+text': 'Icon + text' } },
    'appearance.accentMode': { type: 'enum', enum: ['auto', 'custom'], risk: 'none',
      label: 'Accent color', help: 'Use the built-in blue, or pick your own.',
      options: { auto: 'Default blue', custom: 'Custom color' } },
    'appearance.accentColor': { type: 'color', risk: 'none',
      label: 'Custom accent', help: 'Used when "Accent color" is set to Custom.' },
    'appearance.btnScale': { type: 'float', min: 0.8, max: 1.5, step: 0.05, risk: 'none',
      label: 'Button size', help: 'Scale the per-chapter download button.' },
    'appearance.disableAnim': { type: 'bool', risk: 'none',
      label: 'Disable animations', help: 'Turn off the spinner and transitions (accessibility).' },
    'appearance.allLabel': { type: 'string', maxLen: 40, risk: 'none',
      label: '"Download All" label', help: 'Text shown on the Download All button.' },
    'appearance.allowFloating': { type: 'bool', risk: 'none',
      label: 'Floating button on mobile', help: 'Show a floating Download All button when the page layout hides the normal one.' },

    'frame.position': { type: 'enum', enum: ['bottom-right', 'bottom-left', 'top-right', 'top-left'], risk: 'none',
      label: 'Progress frame position', help: 'Where the Download All progress panel appears.',
      options: { 'bottom-right': 'Bottom right', 'bottom-left': 'Bottom left', 'top-right': 'Top right', 'top-left': 'Top left' } },
    'frame.width': { type: 'int', min: 300, max: 560, risk: 'none',
      label: 'Progress frame width (px)', help: 'Width of the progress panel.' },
    'frame.autoHideSec': { type: 'int', min: 0, max: 60, risk: 'none',
      label: 'Auto-hide after (s)', help: 'Hide the panel this long after it finishes (0 = keep it open).' },

    'advanced.disableScramble': { type: 'bool', risk: 'risky',
      label: 'Disable de-scramble', help: 'Skip un-scrambling protected images.',
      warn: 'comix.to scrambles some pages. With this on, those pages are saved as unreadable mosaics.' },
    'advanced.imageFormat': { type: 'enum', enum: ['preserve', 'png', 'jpg'], risk: 'risky',
      label: 'Image format', help: 'Keep original images, or re-encode them all.',
      options: { preserve: 'Preserve original (recommended)', png: 'Convert to PNG', jpg: 'Convert to JPG' },
      warn: 'Re-encoding every image is slow and CPU-heavy, and is lossy. JPG also discards transparency. "Preserve original" keeps the best quality.' },
    'advanced.jpgQuality': { type: 'float', min: 0.5, max: 1.0, step: 0.05, risk: 'glitchy',
      label: 'JPG quality', help: 'Only used when converting to JPG.',
      warn: 'Low quality produces visible compression artifacts.' },
    'advanced.aggressiveRetrieval': { type: 'bool', risk: 'glitchy',
      label: 'Aggressive page detection', help: 'Faster, looser image discovery.',
      warn: 'Speeds up extraction but may occasionally grab the wrong images or extra pages.' },

    'logs.maxEntries': { type: 'int', min: 50, max: 2000, risk: 'none',
      label: 'Activity log size', help: 'How many log entries to keep.' },

    'features.dedupeChapters': { type: 'bool', risk: 'none',
      label: 'Hide duplicate chapters', help: 'On a title page, show only one row per chapter number (the same chapter from other sources is hidden). Affects only what you see — your downloads are unchanged.' },
    'features.enforceChapterOrder': { type: 'bool', risk: 'none',
      label: 'Force numeric chapter order', help: 'Reorder the title-page chapter list strictly by chapter number when the site renders it out of order.' },
    'features.fixReaderNav': { type: 'bool', risk: 'glitchy',
      label: 'Accurate next/prev in reader', help: 'Make the reader’s next / previous go to the true neighbouring chapter number, switching source if the current one skips it.',
      warn: 'Overrides the site’s built-in next / previous buttons and arrow keys in the reader. Turn it off to restore the native behaviour.' }
  };

  // ── Tab grouping for the options UI ──────────────────────────────────────────
  var TABS = [
    { id: 'download', label: 'Download & ZIP', icon: 'box',
      keys: ['download.concurrentChapters', 'download.splitMode', 'download.chaptersPerPart', 'download.mbPerPart'] },
    { id: 'output', label: 'Output & Library', icon: 'box',
      keys: ['output.format', 'output.includeComicInfo', 'output.includeSeriesMeta', 'output.folderLayout', 'download.skipDownloaded'] },
    { id: 'perf', label: 'Performance', icon: 'gauge',
      keys: ['perf.batchSize', 'perf.rateLimitMode', 'perf.rateBaseMs', 'perf.rateMinMs', 'perf.rateMaxMs', 'perf.imageTimeoutMs', 'perf.tabLoadTimeoutMs', 'perf.pagePollMs', 'perf.pageSettleMs', 'perf.scrollSettleMs'] },
    { id: 'retry', label: 'Retries', icon: 'repeat',
      keys: ['retry.imageRetries', 'retry.chapterRetries'] },
    { id: 'naming', label: 'Naming', icon: 'tag',
      keys: ['naming.imagePadDigits', 'naming.chapterFolderFmt', 'naming.singleZipTpl', 'naming.allZipTpl', 'naming.slugMaxLen'] },
    { id: 'appearance', label: 'Appearance', icon: 'brush',
      keys: ['appearance.btnStyle', 'appearance.accentMode', 'appearance.accentColor', 'appearance.btnScale', 'appearance.disableAnim', 'appearance.allLabel', 'appearance.allowFloating', 'frame.position', 'frame.width', 'frame.autoHideSec'] },
    { id: 'advanced', label: 'Advanced', icon: 'warn',
      keys: ['advanced.disableScramble', 'advanced.imageFormat', 'advanced.jpgQuality', 'advanced.aggressiveRetrieval'] },
    { id: 'features', label: 'Additional Features', icon: 'sparkles',
      keys: ['features.dedupeChapters', 'features.enforceChapterOrder', 'features.fixReaderNav', 'reader.keyboardShortcuts'] },
    { id: 'about', label: 'About & Backup', icon: 'info',
      keys: ['logs.maxEntries'] }
  ];

  // ── Validation helpers ───────────────────────────────────────────────────────
  function clampNumber(v, min, max, fallback, isInt) {
    var n = (typeof v === 'number') ? v : parseFloat(v);
    if (!isFinite(n)) n = fallback;
    if (typeof min === 'number' && n < min) n = min;
    if (typeof max === 'number' && n > max) n = max;
    return isInt ? Math.round(n) : n;
  }

  function isHexColor(v) {
    return typeof v === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
  }

  function validateValue(key, value) {
    var s = SCHEMA[key];
    var def = DEFAULTS[key];
    if (!s) return undefined;
    switch (s.type) {
      case 'int':   return clampNumber(value, s.min, s.max, def, true);
      case 'float': return clampNumber(value, s.min, s.max, def, false);
      case 'bool':  return Boolean(value);
      case 'enum':  return (s.enum.indexOf(value) !== -1) ? value : def;
      case 'color': return isHexColor(value) ? value : def;
      case 'string':
      case 'template': {
        var str = (value == null) ? def : String(value);
        var max = s.maxLen || 200;
        if (str.length > max) str = str.slice(0, max);
        return str;
      }
      default: return def;
    }
  }

  function mergeWithDefaults(stored) {
    var out = {};
    var src = (stored && typeof stored === 'object') ? stored : {};
    for (var key in DEFAULTS) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
      out[key] = Object.prototype.hasOwnProperty.call(src, key) ? src[key] : DEFAULTS[key];
    }
    return out;
  }

  // Full validate: merge with defaults, then coerce every value, dropping unknowns.
  function validate(obj) {
    var merged = mergeWithDefaults(obj);
    var out = {};
    for (var key in DEFAULTS) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
      out[key] = validateValue(key, merged[key]);
    }
    return out;
  }

  // ── Storage (promise-first, callback fallback for old Chrome) ─────────────────
  function storageGet(key) {
    if (!storage) return Promise.resolve({});
    try {
      var ret = storage.get(key);
      if (ret && typeof ret.then === 'function') return ret.then(function (r) { return r || {}; });
    } catch (e) { /* fall through to callback form */ }
    return new Promise(function (resolve, reject) {
      try {
        storage.get(key, function (res) {
          var err = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError);
          if (err) reject(err); else resolve(res || {});
        });
      } catch (e2) { reject(e2); }
    });
  }

  function storageSet(obj) {
    if (!storage) return Promise.resolve();
    try {
      var ret = storage.set(obj);
      if (ret && typeof ret.then === 'function') return ret;
    } catch (e) { /* fall through to callback form */ }
    return new Promise(function (resolve, reject) {
      try {
        storage.set(obj, function () {
          var err = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError);
          if (err) reject(err); else resolve();
        });
      } catch (e2) { reject(e2); }
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  function getSettings() {
    return storageGet(STORAGE_KEY).then(function (res) {
      return validate(res ? res[STORAGE_KEY] : null);
    }).catch(function () { return validate({}); });
  }

  function saveSettings(obj) {
    var clean = validate(obj);
    var payload = {};
    payload[STORAGE_KEY] = clean;
    return storageSet(payload).then(function () { return clean; });
  }

  function patchSettings(partial) {
    return getSettings().then(function (cur) {
      var next = {};
      for (var k in cur) { if (Object.prototype.hasOwnProperty.call(cur, k)) next[k] = cur[k]; }
      if (partial) { for (var p in partial) { if (Object.prototype.hasOwnProperty.call(partial, p)) next[p] = partial[p]; } }
      return saveSettings(next);
    });
  }

  function resetDefaults() {
    return saveSettings({}); // validate({}) yields a full defaults object
  }

  // Subscribe to settings changes. Returns an unsubscribe function.
  function onChange(cb) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) {
      return function () {};
    }
    var listener = function (changes, area) {
      if (area && area !== 'local') return;
      if (changes && changes[STORAGE_KEY]) {
        cb(validate(changes[STORAGE_KEY].newValue));
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return function () {
      try { chrome.storage.onChanged.removeListener(listener); } catch (e) {}
    };
  }

  // ── Templates & filenames ─────────────────────────────────────────────────────
  function sanitizeFilename(name, maxLen) {
    var s = String(name == null ? '' : name)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^\.+/, '')
      .trim();
    if (maxLen && s.length > maxLen) s = s.slice(0, maxLen).trim();
    return s || 'comix';
  }

  // Replace {token} with ctx[token]; unknown tokens are left literal.
  function renderTemplate(tpl, ctx) {
    ctx = ctx || {};
    var str = String(tpl == null ? '' : tpl);
    return str.replace(/\{(\w+)\}/g, function (m, token) {
      if (Object.prototype.hasOwnProperty.call(ctx, token)) {
        return ctx[token] == null ? '' : String(ctx[token]);
      }
      return m;
    });
  }

  // Build the standard token context (adds zero-padded number variants + date).
  function templateContext(parts) {
    parts = parts || {};
    var n = (parts.num == null) ? '' : String(parts.num);
    var pad = function (len) { return n ? n.padStart(len, '0') : ''; };
    return {
      manga: parts.manga == null ? '' : String(parts.manga),
      chapter: parts.chapter == null ? '' : String(parts.chapter),
      rest: parts.rest == null ? '' : String(parts.rest),
      num: n,
      num2: pad(2),
      num4: pad(4),
      date: parts.date || new Date().toISOString().slice(0, 10)
    };
  }

  // Convenience: render a template then sanitize for use as a filename/folder.
  function renderName(tpl, parts, maxLen) {
    return sanitizeFilename(renderTemplate(tpl, templateContext(parts)), maxLen);
  }

  // ── Export / import ───────────────────────────────────────────────────────────
  function exportJSON() {
    return getSettings().then(function (cur) {
      return JSON.stringify({ __comix: 'settings', version: 2, settings: cur }, null, 2);
    });
  }

  function importJSON(text) {
    var parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { return Promise.reject(new Error('That file is not valid JSON.')); }
    if (!parsed || typeof parsed !== 'object') {
      return Promise.reject(new Error('That file is not a valid settings file.'));
    }
    var incoming = (parsed.settings && typeof parsed.settings === 'object') ? parsed.settings : parsed;
    if (!incoming || typeof incoming !== 'object') {
      return Promise.reject(new Error('That file is not a valid settings file.'));
    }
    if (Object.keys(incoming).length > 200) {
      return Promise.reject(new Error('That settings file is too large.'));
    }
    return saveSettings(incoming); // validate() clamps values and drops unknown keys
  }

  var CDLSettings = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    SCHEMA: SCHEMA,
    TABS: TABS,
    getSettings: getSettings,
    saveSettings: saveSettings,
    patchSettings: patchSettings,
    resetDefaults: resetDefaults,
    onChange: onChange,
    validate: validate,
    validateValue: validateValue,
    mergeWithDefaults: mergeWithDefaults,
    renderTemplate: renderTemplate,
    templateContext: templateContext,
    renderName: renderName,
    sanitizeFilename: sanitizeFilename,
    exportJSON: exportJSON,
    importJSON: importJSON
  };

  global.CDLSettings = CDLSettings;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CDLSettings; // for Node-based unit tests
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
