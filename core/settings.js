/**
 * settings.js — Comix Downloader shared settings module (V2.0.0)
 *
 * Single source of truth for user configuration. Loaded as a plain classic
 * script in FOUR contexts and attaches `globalThis.CDLSettings`:
 *   - Service worker (Chrome): importScripts('core/settings.js')
 *   - Service worker (Firefox): listed in background.scripts
 *   - Content script: listed before content_title.js in manifest content_scripts
 *   - legacy/options.html: <script src="../core/settings.js"></script>
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
    'download.concurrentChapters': 2,      // how many chapters "Download All" fetches at once (up to 10)
    'download.skipDownloaded': true,       // in Download All, default to only chapters not already grabbed

    // Output format & library
    'output.format': 'zip',                // 'zip' (folders of images) | 'cbz' (per-chapter comic file)
    'output.includeComicInfo': true,       // write ComicInfo.xml per chapter
    'output.includeSeriesMeta': false,     // save cover.jpg + series.json for the series
    'output.folderLayout': 'default',      // 'default' (Ch0001) | 'kavita' (Series/Series - Chapter 0001)

    // Reader
    'reader.keyboardShortcuts': false,     // J/K or arrows = prev/next chapter, D = download current

    // Subscribe & watch (background new-chapter checks; all local)
    'subscribe.enabled': false,            // master toggle for background checking
    'subscribe.intervalMinutes': 360,      // how often to check (6h default)
    'subscribe.notify': true,              // desktop notification on new chapters
    'subscribe.autoDownload': false,       // auto-download new chapters when found

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

    // Retries (0 == "skip on failure"; 1 == retry once, the default)
    'retry.imageRetries': 1,
    'retry.chapterRetries': 1,

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

    // Additional Features (comix.to site enhancements)
    'features.blockAds': true,             // block injected click ads/popups (on by default)
    'features.dedupeChapters': false,      // hide duplicate chapters in the title list
    'features.enforceChapterOrder': false, // force ascending numeric order in the list
    'features.fixReaderNav': false,        // accurate reader next/prev w/ source switching
    'features.flagBrokenPages': false,     // warn in the reader when a chapter's pages fail to load
    'features.prefetchNext': false,        // read one chapter ahead near the end for instant page turns
    'features.resumeScroll': false,        // remember the exact scroll position in each chapter
    'features.recapOnReturn': false,       // on a series page, recap where you left off + what's next
    'features.readingStats': false,        // track reading time/chapters locally + show a Home stats section
    'features.catchupEstimate': false,     // on a series page, estimate time to catch up at your pace
    // Community chapter flags (v3.0.0) are a built-in, always-on feature — intentionally NOT a
    // setting (like the profile tenure badge). See content_features.js.

    // Home (v3.0.0 custom Home redesign — OFF by default)
    'home.customLayout': false,            // replace comix's Home with the focused custom layout
    // Ordered section selection. id order = display order; on = shown. Personal sections on by
    // default, comix's global carousels off (opt-in). Mirrors CDLHomeCore.defaultHomeSections().
    'home.sections': [
      { id: 'whats-new', on: false },
      { id: 'continue-reading', on: true },
      { id: 'reading-stats', on: false },
      { id: 'new-chapters', on: true },
      { id: 'recently-followed', on: true },
      { id: 'most-recent-popular', on: false },
      { id: 'most-follows-new', on: false },
      { id: 'latest-updates', on: false },
      { id: 'user-collections', on: false }
    ],
    'home.hero': 'two',                     // 'two' | 'one' | 'off' — featured hero panels
    'home.heroSource': 'new-chapters',     // which section's data feeds the hero
    'home.heroSkipRead': true,             // skip series whose latest chapter you've already read
    'home.cardStyle': 'overlay',           // 'overlay' (title on art) | 'classic' (title below)
    'home.rows': 2,                        // rows per carousel (1–3)
    'home.density': 'comfortable',         // 'comfortable' | 'compact' — card size / per-row count
    'home.showProgress': true,             // progress bar + % on Continue Reading cards
    'home.itemsPerSection': 24,            // max cards fetched/shown per section (6–40)
    'home.openInNewTab': false,            // open comics in a new tab
    'home.greeting': true,                 // show a welcome header at the top
    'home.hoverPreview': true              // cursor-following detail popup on card hover
    // Note: the profile "Comix-Downloader user" tenure badge (v3.0.0) is a built-in,
    // always-on feature — intentionally NOT a setting (see content_profile.js).
  };

  // Section ids/labels for the home.sections picker (kept in sync with CDLHomeCore.HOME_SECTIONS;
  // a unit test asserts the id sets match). Defined here so the options UIs render without home-core.
  var HOME_SECTION_LABELS = [
    { id: 'whats-new', label: 'What’s New (feed)' },
    { id: 'continue-reading', label: 'Continue Reading' },
    { id: 'reading-stats', label: 'Your Reading (stats)' },
    { id: 'new-chapters', label: 'New Chapters from Followed Comics' },
    { id: 'recently-followed', label: 'Recently Followed Comics' },
    { id: 'most-recent-popular', label: 'Most Recent Popular' },
    { id: 'most-follows-new', label: 'Most Follows · New Comics' },
    { id: 'latest-updates', label: 'Latest Updates' },
    { id: 'user-collections', label: 'User Collections' }
  ];

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
    'download.concurrentChapters': { type: 'int', min: 1, max: 10, risk: 'risky',
      label: 'Chapters at once', help: 'How many chapters can download at the same time. This applies to "Download All" and to separate chapter buttons. The default is 2; raise it to download faster, or use 1 to process chapters one at a time. Up to 10.',
      warn: 'This multiplies how hard the extension hits comix.to by opening more background tabs and making more image requests at once. Higher values are faster but more aggressive and can get your IP temporarily blocked by the site. While blocked, pages or whole chapters can fail. If you raise this value, keep "Parallel image downloads" low and leave rate limiting on.' },
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

    'subscribe.enabled': { type: 'bool', risk: 'none',
      label: 'Watch subscribed series', help: 'Periodically check the series you subscribed to (from their title page) for new chapters, in the background.' },
    'subscribe.intervalMinutes': { type: 'int', min: 30, max: 1440, risk: 'none',
      label: 'Check interval (minutes)', help: 'How often to check subscribed series. Longer is gentler on the site.' },
    'subscribe.notify': { type: 'bool', risk: 'none',
      label: 'Notify on new chapters', help: 'Show a desktop notification when a subscribed series gets new chapters.' },
    'subscribe.autoDownload': { type: 'bool', risk: 'glitchy',
      label: 'Auto-download new chapters', help: 'When new chapters are found, download just those automatically using your saved output settings.',
      warn: 'Runs a download in the background without asking. On ongoing series this uses bandwidth and disk space, and counts against the site like any other download.' },

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
      label: 'Accent color', help: 'Match comix.to’s own accent (cyan / purple), or pick your own.',
      options: { auto: 'Match comix theme', custom: 'Custom color' } },
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

    'features.blockAds': { type: 'bool', risk: 'none',
      label: 'Block comix.to ads and popups', help: 'Stops the site\'s intermittent click-anywhere ads, popunders, scripted external tabs, and transparent ad overlays. Enabled by default; turn it off to restore the site\'s native ad behavior.' },
    'features.dedupeChapters': { type: 'bool', risk: 'none',
      label: 'Hide duplicate chapters', help: 'On a title page, show only one row per chapter number (the same chapter from other sources is hidden). Affects only what you see — your downloads are unchanged.' },
    'features.enforceChapterOrder': { type: 'bool', risk: 'none',
      label: 'Force numeric chapter order', help: 'Reorder the title-page chapter list strictly by chapter number when the site renders it out of order.' },
    'features.fixReaderNav': { type: 'bool', risk: 'glitchy',
      label: 'Accurate next/prev in reader', help: 'Make the reader’s next / previous go to the true neighbouring chapter number, switching source if the current one skips it.',
      warn: 'Overrides the site’s built-in next / previous buttons and arrow keys in the reader. Turn it off to restore the native behaviour.' },
    'features.flagBrokenPages': { type: 'bool', risk: 'none',
      label: 'Warn about broken pages', help: 'While you read, quietly checks the chapter’s page images and shows a small warning if any fail to load — so you know a page is broken/missing (often a bad scanlation upload) rather than assuming it’s your connection. Purely informational; nothing is sent anywhere.' },
    'features.prefetchNext': { type: 'bool', risk: 'none',
      label: 'Read ahead for instant page turns', help: 'As you near the end of a chapter, quietly loads the start of the next one in the background so opening it feels instant. Only ever reads one chapter ahead, and only when you’re most of the way through.',
      warn: 'Fetches the next chapter (its page and a few images) a little early, so it uses slightly more data. Turn it off to only ever load what you actually open.' },
    'features.resumeScroll': { type: 'bool', risk: 'none',
      label: 'Resume exact scroll position', help: 'Remembers exactly where you stopped in each chapter — not just which chapter — and jumps back to that spot when you reopen it. Handy for long webtoon chapters. Stored only on this device; nothing is sent anywhere.',
      warn: 'When you reopen a chapter it scrolls to where you left off. Turn it off to always start chapters from the top.' },
    'features.recapOnReturn': { type: 'bool', risk: 'none',
      label: 'Recap where you left off', help: 'When you reopen a series page, shows a small banner reminding you which chapter you last read and how long ago, with a one-click button to jump straight to the next one. Based only on chapters you open on this device; nothing is sent anywhere.' },
    'features.readingStats': { type: 'bool', risk: 'none',
      label: 'Reading stats', help: 'Quietly tracks how much you actually read (active time and chapters finished, on this device only) and shows a "Your Reading" section on the custom Home page: this week’s chapters, your streak, hours read and top series. Nothing is sent anywhere; turn it off to stop tracking.' },
    'features.catchupEstimate': { type: 'bool', risk: 'none',
      label: 'Catch-up time estimate', help: 'On a series page, shows how many chapters you have left and roughly how long they’ll take at your measured reading pace (falls back to ~4 min per chapter until it has learned your speed). All measured and stored on this device only.' },

    'home.customLayout': { type: 'bool', risk: 'glitchy',
      label: 'Custom Home page', help: 'Replace comix.to’s Home with a focused, larger layout built from the sections you choose below. Everything else (announcements, banners, sidebar) is hidden.',
      warn: 'Restyles and hides parts of comix’s Home page. Turn it off to restore the native Home exactly as it was.' },
    'home.sections': { type: 'sectionList', risk: 'none', sections: HOME_SECTION_LABELS,
      label: 'Home sections', help: 'Pick which sections appear and drag them into the order you want. Continue Reading, New Chapters and Recently Followed are your own data; the rest are comix’s global carousels, re-styled to match.' },
    'home.hero': { type: 'enum', enum: ['two', 'one', 'off'], risk: 'none',
      label: 'Featured hero', help: 'Big spotlight banner(s) at the very top of the Home.',
      options: { two: 'Two side-by-side', one: 'One wide', off: 'Off' } },
    'home.heroSource': { type: 'enum', enum: ['new-chapters', 'recently-followed', 'continue-reading'], risk: 'none',
      label: 'Hero picks from', help: 'Which section’s comics get featured in the hero.',
      options: { 'new-chapters': 'New chapters from followed', 'recently-followed': 'Recently followed', 'continue-reading': 'Continue reading' } },
    'home.heroSkipRead': { type: 'bool', risk: 'none',
      label: 'Hero skips already-read', help: 'Don’t feature a series in the hero once you’ve read its latest chapter — the next unread series takes its place.' },
    'home.cardStyle': { type: 'enum', enum: ['overlay', 'classic'], risk: 'none',
      label: 'Card style', help: 'How comics look in the carousels.',
      options: { overlay: 'Cover with overlay text', classic: 'Cover with text below' } },
    'home.rows': { type: 'int', min: 1, max: 3, risk: 'none',
      label: 'Rows per section', help: 'How many rows tall each carousel is.' },
    'home.density': { type: 'enum', enum: ['comfortable', 'compact'], risk: 'none',
      label: 'Card density', help: 'Comfortable shows larger cards; Compact fits more per row.',
      options: { comfortable: 'Comfortable', compact: 'Compact' } },
    'home.showProgress': { type: 'bool', risk: 'none',
      label: 'Reading progress bars', help: 'Show a progress bar and % on Continue Reading cards.' },
    'home.itemsPerSection': { type: 'int', min: 6, max: 40, risk: 'none',
      label: 'Comics per section', help: 'How many comics each section loads at most.' },
    'home.openInNewTab': { type: 'bool', risk: 'none',
      label: 'Open in new tab', help: 'Open a comic in a new browser tab when you click it on the custom Home.' },
    'home.greeting': { type: 'bool', risk: 'none',
      label: 'Welcome header', help: 'Show a short welcome header at the top of the custom Home.' },
    'home.hoverPreview': { type: 'bool', risk: 'none',
      label: 'Home hover preview', help: 'On the custom Home, hovering a comic shows a cursor-following popup with its cover, title, latest chapter and synopsis.' }
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
      keys: ['features.blockAds', 'features.dedupeChapters', 'features.enforceChapterOrder', 'features.fixReaderNav', 'features.flagBrokenPages', 'features.prefetchNext', 'features.resumeScroll', 'features.recapOnReturn', 'features.readingStats', 'features.catchupEstimate', 'reader.keyboardShortcuts'] },
    { id: 'home', label: 'Home', icon: 'sparkles',
      keys: ['home.customLayout', 'home.sections', 'home.hero', 'home.heroSource', 'home.heroSkipRead',
        'home.cardStyle', 'home.rows', 'home.density', 'home.showProgress', 'home.itemsPerSection',
        'home.openInNewTab', 'home.greeting', 'home.hoverPreview'] },
    { id: 'sync', label: 'Sync & Library', icon: 'repeat',
      keys: ['subscribe.enabled', 'subscribe.intervalMinutes', 'subscribe.notify', 'subscribe.autoDownload'] },
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

  // Normalize a sectionList value (e.g. home.sections) into a full, ordered [{id,on}] list over
  // the known section ids: drop unknown/duplicate ids, coerce `on` to boolean, preserve the
  // stored order, then append any known sections missing from the stored list (using their
  // default `on` from `def`) so newly added sections always surface. Falls back to `def`.
  function validateSectionList(value, sections, def) {
    var known = Object.create(null);
    (sections || []).forEach(function (s) { if (s && s.id) known[s.id] = true; });
    var defOn = Object.create(null);
    (Array.isArray(def) ? def : []).forEach(function (d) { if (d && d.id) defOn[d.id] = !!d.on; });
    var out = [], seen = Object.create(null);
    if (Array.isArray(value)) {
      value.forEach(function (it) {
        var id = it && typeof it === 'object' ? it.id : it;
        if (typeof id !== 'string' || !known[id] || seen[id]) return;
        seen[id] = true;
        out.push({ id: id, on: it && typeof it === 'object' ? Boolean(it.on) : true });
      });
    }
    (sections || []).forEach(function (s) {
      if (s && s.id && !seen[s.id]) out.push({ id: s.id, on: !!defOn[s.id] });
    });
    return out;
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
      case 'sectionList': return validateSectionList(value, s.sections, def);
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
