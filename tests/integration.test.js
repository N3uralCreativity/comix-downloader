'use strict';
/**
 * Integration tests (run: `node tests/integration.test.js`).
 *
 * settings.js is the single source of truth for configuration, but the runtime
 * code reads it with string keys (cfg['perf.batchSize'], CFG['frame.width'], …).
 * A typo there would silently fall back to a default instead of erroring, so we
 * assert every key referenced in the runtime code actually exists in DEFAULTS.
 * We also lock in the default naming templates so an untouched config keeps
 * producing v1.1.2-style filenames.
 */
const fs = require('fs');
const path = require('path');
const S = require('../core/settings.js');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const DEFAULT_KEYS = Object.keys(S.DEFAULTS);

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; } else { fail++; console.error('FAIL:', name); } }

// Collect every `<varName>['some.key']` reference in a source file.
function refsIn(src, varName) {
  const re = new RegExp(varName + "\\[['\"]([\\w.]+)['\"]\\]", 'g');
  const out = new Set(); let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return [...out];
}

// 1. background.js (service worker) settings keys
const backgroundSource = read('background.js');
const bgKeys = refsIn(backgroundSource, 'cfg');
check('background.js reads a meaningful number of settings', bgKeys.length >= 15);
bgKeys.forEach((k) => check('background.js key exists in DEFAULTS: ' + k, DEFAULT_KEYS.indexOf(k) !== -1));
check('browser Save cancellation gets exactly one automatic retry by default',
  backgroundSource.includes('cancelRetryCount = 1') &&
  backgroundSource.includes('saveAs: forceSaveAs || cancelledAttempts > 0'));
check('Download All retains a prepared archive for an explicit Save retry',
  backgroundSource.includes('waitForPendingArchiveSaveDecision') &&
  backgroundSource.includes("message.action === 'retryArchiveSave'"));
check('Download All keeps concurrent chapter events behind the active archive stage',
  backgroundSource.includes('archivePresentationActive') &&
  backgroundSource.includes('deferredChapterProgress') &&
  backgroundSource.includes("phase: 'resuming'"));
check('Download All persists a lightweight accepted ZIP checkpoint',
  backgroundSource.includes("const DL_RESUME_KEY = 'cdlDownloadAllResume'") &&
  backgroundSource.includes('updateDownloadAllResumeCheckpoint') &&
  backgroundSource.includes('if (accepted && updateCheckpoint && !resumeData.checkpointBlocked)'));
check('Download All exposes a checkpoint resume message without persisting archive bytes',
  backgroundSource.includes("message.action === 'resumeDownloadAll'") &&
  backgroundSource.includes('remainingChapters = resumeData.chapters.slice(checkpointIndex)') &&
  !backgroundSource.slice(
    backgroundSource.indexOf('function _serializeSession('),
    backgroundSource.indexOf('function persistDownloadAllSession(')
  ).includes('generatedArchive'));
check('the configured Downloads subfolder reaches every archive workflow',
  backgroundSource.includes("downloadTargetFilename(outName, cfg['output.downloadSubfolder'])") &&
  backgroundSource.includes("downloadSubfolder: cfg['output.downloadSubfolder'] || ''") &&
  backgroundSource.includes('await handleDownloadAllRequest(chapters, mangaName, zipName, null, options)'));
check('a new Download All request reattaches to an existing durable operation',
  backgroundSource.includes('existing.status === \'awaiting_save\'') &&
  backgroundSource.includes('existing: true, session: _serializeSession(existing)'));
check('Download All persistence is isolated by title slug',
  backgroundSource.includes("const DL_SESSION_PREFIX = 'cdlDownloadAllSession:'") &&
  backgroundSource.includes("const DL_RESUME_PREFIX = 'cdlDownloadAllResume:'") &&
  backgroundSource.includes('downloadAllStorageKeys(sessionOrSlug)'));
check('an inactive checkpoint cannot block Download All on another title',
  backgroundSource.includes('if (downloadAllSession && downloadAllSession.active)') &&
  !backgroundSource.includes('is waiting to be resumed or discarded'));
check('review requests are counted only after confirmed archive saves',
  backgroundSource.includes('if (delivery.confirmed) await recordSuccessfulDownloadForReview()') &&
  backgroundSource.includes('confirmedZipParts === savedZipNames.length') &&
  backgroundSource.includes('unconfirmedZipParts === 0 && incompleteCount === 0'));
check('review prompt eligibility is claimed through the serialized background worker',
  backgroundSource.includes("message.action === 'claimReviewPrompt'") &&
  backgroundSource.includes('CDLReviewPrompt.claimPrompt(chrome.storage.local, version)'));
check('signed browser updates surface in the popup and can reload safely',
  backgroundSource.includes('chrome.runtime.onUpdateAvailable.addListener') &&
  backgroundSource.includes("message.action === 'getAvailableUpdate'") &&
  backgroundSource.includes("message.action === 'installAvailableUpdate'") &&
  backgroundSource.includes('hasActiveDownloadWork()') &&
  backgroundSource.includes('chrome.runtime.reload()'));
check('Download All progress takes priority over the update-ready toolbar badge',
  backgroundSource.includes("setBadgeText({ text: 'UP' })") &&
  backgroundSource.includes('_downloadProgressBadgeActive') &&
  backgroundSource.includes('void refreshIdleBadge()'));

// 2. content_title.js (content script) settings keys
const contentTitleSource = read('content/content_title.js');
const ctKeys = refsIn(contentTitleSource, 'CFG');
check('Firefox Android handoffs are accepted without weakening desktop verification',
  backgroundSource.includes('const mobileHandoff = mobile &&') &&
  backgroundSource.includes('response.handoff === true') &&
  contentTitleSource.includes('handoff: true'));
check('content_title.js reads a meaningful number of settings', ctKeys.length >= 9);
ctKeys.forEach((k) => check('content_title.js key exists in DEFAULTS: ' + k, DEFAULT_KEYS.indexOf(k) !== -1));
check('Download All frame exposes Download, ZIP, and Save stages',
  contentTitleSource.includes('data-stage="download"') &&
  contentTitleSource.includes('data-stage="zip"') &&
  contentTitleSource.includes('data-stage="save"'));
check('Download All frame consumes real ZIP and browser save percentages',
  contentTitleSource.includes('msg.zipPercent') && contentTitleSource.includes('msg.savePercent'));
check('PDF output is available per chapter with visible build progress',
  backgroundSource.includes('buildChapterPdfOutput') &&
  contentTitleSource.includes("PDF_OUTPUT_VISIBLE ? '<div class=\"cdl-op-card\" data-fmt=\"pdf\"") &&
  contentTitleSource.includes("phase === 'buildingPdf'"));
check('PDF output remains dormant at every user-facing settings boundary',
  S.PDF_OUTPUT_VISIBLE === false &&
  S.SCHEMA['output.format'].enum.join(',') === 'zip,cbz' &&
  contentTitleSource.includes('const visibleFormats = PDF_OUTPUT_VISIBLE'));
check('visible format cards always divide the available width evenly',
  contentTitleSource.includes('grid-template-columns:repeat(${PDF_OUTPUT_VISIBLE ? 3 : 2},minmax(0,1fr))'));
check('Download All exposes direct CBZ delivery without changing the default',
  S.DEFAULTS['output.directCbz'] === false &&
  contentTitleSource.includes('id="cdl-op-direct-cbz"') &&
  contentTitleSource.includes("directCbz: format === 'cbz' && directCbzInput.checked"));
check('direct CBZ delivery bypasses outer ZIP packing and uses confirmed browser saves',
  backgroundSource.includes('const saveDirectCbz = async') &&
  backgroundSource.includes('buildChapterCbzBytes(chapter, opts, mangaName, onCbzProgress)') &&
  backgroundSource.includes('const saved = await _doZipAndSave(pending)'));
check('PDF work overlaps chapter fetching without concurrent PDF builds',
  backgroundSource.includes('let pdfBuildChain = Promise.resolve()') &&
  backgroundSource.includes('enqueuePdfBuild(async () =>') &&
  backgroundSource.includes('files: [], pdfBytes'));
check('PDF finalization keeps the Manifest V3 worker alive and remains visible',
  backgroundSource.includes('withExtensionKeepAlive') &&
  backgroundSource.includes('chrome.runtime.getPlatformInfo(') &&
  contentTitleSource.includes('msg.pdfFinalizing === true'));
check('Cloudflare challenges pause for one user-completed browser verification',
  backgroundSource.includes('coordinateCloudflareChallenge') &&
  backgroundSource.includes('_cloudflareChallengeGate') &&
  backgroundSource.includes("reportCloudflareChallenge(onState, 'required')") &&
  !backgroundSource.includes('turnstile-bypass'));
check('Download All frame no longer substitutes a fake 99 percent ZIP state',
  !contentTitleSource.includes("style.width            = '99%'") &&
  !contentTitleSource.includes("style.width = '99%'"));
check('active Download All sessions do not expose a duplicate-work Retry timer',
  !contentTitleSource.includes('allowFullRetry ? setTimeout'));
check('cancelled Save state offers an explicit Save again action',
  contentTitleSource.includes('<span>Save again</span>') &&
  contentTitleSource.includes("action: 'retryArchiveSave'") &&
  contentTitleSource.includes("closeBtn.textContent = 'Discard'"));
check('graceful cancellation keeps the user-facing button label as Cancel',
  contentTitleSource.includes('id="cdl-ap-cancel-btn">Cancel</button>') &&
  backgroundSource.includes("message.action === 'cancelDownloadAll'") &&
  backgroundSource.includes('_signalDownloadAllStop()'));
check('Download All frame handles the post-archive resuming state',
  contentTitleSource.includes("phase === 'resuming'"));
check('Download All explains which configured partition threshold started a ZIP part',
  backgroundSource.includes('downloadAllPartSplitReason') &&
  backgroundSource.includes('splitReason') &&
  contentTitleSource.includes('_dlAllPartBoundaryText'));
check('recoverable archive errors keep their checkpoint without masquerading as interruptions',
  backgroundSource.includes("errorKind: 'archive_save'") &&
  contentTitleSource.includes('if (message.canResumeDownload) updateDownloadAllPopupInterrupted(message)'));
check('a single-chapter setup error cannot terminate an active Download All session', (() => {
  const start = backgroundSource.indexOf("message.action === 'downloadChapter'");
  const end = backgroundSource.indexOf("message.action === 'downloadAllChapters'", start);
  const block = backgroundSource.slice(start, end);
  return block.includes('notifyChapterDownloadError') && !block.includes('notifyDownloadAllError');
})());
check('download errors expose stable support diagnostics without replacing friendly messages',
  backgroundSource.includes('function createErrorDiagnostic') &&
  backgroundSource.includes("'CDL-ZIP-001'") &&
  backgroundSource.includes('sanitizeDiagnosticText') &&
  contentTitleSource.includes('See technical details') &&
  contentTitleSource.includes('Copy diagnostics'));
check('single-chapter failures open a retryable diagnostic panel',
  contentTitleSource.includes('function showChapterDownloadError') &&
  contentTitleSource.includes("panel.id = 'cdl-single-error'") &&
  contentTitleSource.includes('showChapterDownloadError(errorMessage, message.diagnostic'));
check('failed Download All chapters retain per-chapter diagnostics across refreshes',
  backgroundSource.includes('if (progress.diagnostic) existing.diagnostic = progress.diagnostic') &&
  backgroundSource.includes('diagnostic: result.diagnostic || null') &&
  contentTitleSource.includes('entry.diagnostic || null'));
check('interrupted Download All sessions expose Resume download and Discard actions',
  contentTitleSource.includes('<span>Resume download</span>') &&
  contentTitleSource.includes("action: 'resumeDownloadAll'") &&
  contentTitleSource.includes("discardBtn.textContent = 'Discard'"));
check('Download All restoration retries transient service-worker wake failures',
  contentTitleSource.includes('restoreDownloadAllPopupFromBackground(attempt = 0)') &&
  contentTitleSource.includes('attempt >= 4') &&
  contentTitleSource.includes('250 * (2 ** attempt)'));
check('a refresh-time duplicate start response restores the existing frame',
  contentTitleSource.includes('if (!err && response?.session)') &&
  contentTitleSource.includes('restoreDownloadAllPopupFromSession(response.session)'));

// 2b. content_features.js (content script) feature-flag keys
const cfKeys = refsIn(read('content/content_features.js'), 'cfg');
check('content_features.js reads the feature flags', cfKeys.length >= 3);
cfKeys.forEach((k) => check('content_features.js key exists in DEFAULTS: ' + k, DEFAULT_KEYS.indexOf(k) !== -1));

// 2c. content_profile.js (tenure badge) keys
const cpKeys = refsIn(read('content/content_profile.js'), 'cfg');
cpKeys.forEach((k) => check('content_profile.js key exists in DEFAULTS: ' + k, DEFAULT_KEYS.indexOf(k) !== -1));

// 3. options.js dependency + preview maps must reference real keys
const opt = read('legacy/options.js');
function blockKeys(src, marker) {
  const i = src.indexOf(marker);
  if (i === -1) return [];
  const j = src.indexOf('};', i);
  const slice = src.slice(i, j === -1 ? undefined : j);
  const re = /['"]([a-z]+\.[a-zA-Z]+)['"]\s*:/g;
  const out = new Set(); let m;
  while ((m = re.exec(slice))) out.add(m[1]);
  return [...out];
}
const depKeys = blockKeys(opt, 'var DEPENDS');
const prevKeys = blockKeys(opt, 'var PREVIEW_CTX');
check('options.js DEPENDS map is present', depKeys.length > 0);
depKeys.forEach((k) => check('options.js DEPENDS key valid: ' + k, DEFAULT_KEYS.indexOf(k) !== -1));
prevKeys.forEach((k) => check('options.js PREVIEW_CTX key valid: ' + k, DEFAULT_KEYS.indexOf(k) !== -1));

// 4. Default naming templates reproduce v1.1.2-style names
check('default single-chapter ZIP name',
  S.renderName(S.DEFAULTS['naming.singleZipTpl'], { manga: 'solo-leveling', chapter: '12', num: '12' }, 196) === 'solo-leveling-Ch12');
check('default Download-All ZIP name',
  S.renderName(S.DEFAULTS['naming.allZipTpl'], { manga: 'solo-leveling' }, 196) === 'solo-leveling');
check('default chapter folder name (padded)',
  S.renderName(S.DEFAULTS['naming.chapterFolderFmt'], { num: '12', rest: '' }, 80) === 'Ch0012');
check('default chapter folder keeps decimal suffix',
  S.renderName(S.DEFAULTS['naming.chapterFolderFmt'], { num: '12', rest: '.5' }, 80) === 'Ch0012.5');
check('default CBZ name preserves the existing generated entry',
  S.renderName(S.DEFAULTS['naming.cbzFileTpl'], { entry: 'Ch0012' }, 160) === 'Ch0012');
check('CBZ naming metadata is carried from title rows into the background worker',
  contentTitleSource.includes('scanlator: c.scanlator || c.group ||') &&
  backgroundSource.includes('chapter.scanlator || chapter.group') &&
  backgroundSource.includes('buildCbzEntryName(opts, r, mangaName)'));

// 5. manifest wiring sanity
const mf = JSON.parse(read('manifest.json'));
check('manifest version is 4.x', /^4\./.test(mf.version));
check('manifest metadata uses WebExtension localization',
  mf.default_locale === 'en' &&
  mf.name === '__MSG_extensionName__' &&
  mf.description === '__MSG_extensionDescription__');
const mainCs = mf.content_scripts.find((c) => Array.isArray(c.js) && c.js.includes('content/content_title.js'));
check('content_scripts load in dependency order', mainCs && JSON.stringify(mainCs.js) === JSON.stringify(['core/settings.js', 'content/content_notices.js', 'core/cdl-features-core.js', 'core/cdl-home-core.js', 'core/cdl-badge-core.js', 'content/content_title.js', 'content/content_features.js', 'content/content_home.js', 'content/content_profile.js']));
// The title/features bundle must match ALL of comix.to (not just /title/*) so it
// is present when a Next.js soft-navigation lands on a title page — otherwise the
// download buttons only appear after a hard refresh (SPA injection fix).
check('title content scripts match all of comix.to (SPA soft-nav)', !!mainCs && mainCs.matches.indexOf('*://comix.to/*') !== -1);
check('remote notices content script is registered', !!mainCs && mainCs.js.indexOf('content/content_notices.js') !== -1);
const bridgeCs = mf.content_scripts.find((c) => Array.isArray(c.js) && c.js.includes('content/extract-bridge.js'));
check('extract-bridge runs at document_start in the MAIN world', !!bridgeCs && bridgeCs.run_at === 'document_start' && bridgeCs.world === 'MAIN');
check('ad blocker loads before the bridge in MAIN world', !!bridgeCs && JSON.stringify(bridgeCs.js) === JSON.stringify(['content/adblock-main.js', 'content/extract-bridge.js']));
const adControlCs = mf.content_scripts.find((c) => Array.isArray(c.js) && c.js.includes('content/adblock-control.js'));
check('ad blocker control runs at document_start in isolated world', !!adControlCs && adControlCs.run_at === 'document_start' && !adControlCs.world);
const embedCs = mf.content_scripts.find((c) => Array.isArray(c.js) && c.js.includes('content/cdl-embed-settings.js'));
check('settings-embed content script is registered on comix.to', !!embedCs && embedCs.matches.indexOf('*://comix.to/*') !== -1);
check('settings-embed loads the settings module (CDLSettings)', !!embedCs && embedCs.js.indexOf('core/settings.js') !== -1);
check('options_ui points at the archived legacy page', mf.options_ui && mf.options_ui.page === 'legacy/options.html' && mf.options_ui.open_in_tab === true);
check('image CDN request rule has host-access-only permission',
  mf.permissions.includes('declarativeNetRequestWithHostAccess') && !mf.permissions.includes('declarativeNetRequest'));
const imageRuleResource = mf.declarative_net_request && mf.declarative_net_request.rule_resources &&
  mf.declarative_net_request.rule_resources.find((resource) => resource.id === 'comix_image_headers');
check('image CDN request rule is registered and enabled',
  !!imageRuleResource && imageRuleResource.enabled === true && imageRuleResource.path === 'rules/comix-image-headers.json');
const imageRules = JSON.parse(read('rules/comix-image-headers.json'));
const imageRule = imageRules.find((rule) => rule.id === 1);
check('image CDN rule only modifies extension fetches to wowpic hosts',
  !!imageRule && imageRule.action.type === 'modifyHeaders' &&
  imageRule.condition.regexFilter.includes('wowpic[1-9]') &&
  JSON.stringify(imageRule.condition.resourceTypes) === JSON.stringify(['xmlhttprequest']));
check('image CDN rule removes Origin and supplies the comix.to referrer', (() => {
  const headers = imageRule && imageRule.action.requestHeaders || [];
  return headers.some((header) => header.header.toLowerCase() === 'origin' && header.operation === 'remove') &&
    headers.some((header) => header.header.toLowerCase() === 'referer' && header.operation === 'set' && header.value === 'https://comix.to/');
})());
const releaseScript = read('scripts/build-release.ps1');
check('release packages both ad blocker scripts', releaseScript.includes('content/adblock-main.js') && releaseScript.includes('content/adblock-control.js'));
check('release packages declarative request rules', releaseScript.includes('"rules"'));
check('release packages all locales and the review state helper',
  releaseScript.includes('"_locales"') && releaseScript.includes('"core/review-prompt.js"'));
check('release packages the update state helper',
  releaseScript.includes('"core/update-state.js"'));
check('release emits dedicated Chromium-store packages',
  ['chrome', 'opera', 'chromium'].every((target) => releaseScript.includes(`"${target}"`)));
const releaseValidator = read('scripts/validate-release.ps1');
check('release validator enforces Chromium package parity',
  releaseValidator.includes('Assert-MapsEqual $referenceMap $targetMap') && releaseValidator.includes("@('chrome', 'opera', 'chromium')"));
check('release validator audits ZIP contents',
  releaseValidator.includes('Get-ArchiveFileMap') && releaseValidator.includes('Assert-MapsEqual $stagedMap $archiveMap'));
check('release validator enforces localized metadata and locale inventory',
  releaseValidator.includes("$expectedLocales = @('en', 'es', 'fr', 'id', 'ja', 'pt_BR', 'th', 'vi')") &&
  releaseValidator.includes("name -eq '__MSG_extensionName__'"));
const adblockMain = read('content/adblock-main.js');
check('ad blocker observes cross-world setting changes', adblockMain.includes('new win.MutationObserver(syncState)') && adblockMain.includes('attributeFilter: [STATE_ATTR]'));

// 6. analyzeImageSequence (background.js) — gate of the CDN page-count probe.
// It must recognize ONLY the enumerator's signature (same base/ext, exactly
// 1..N): a false positive would let the probe rewrite a list of real DOM srcs.
const bgSrc = read('background.js');
const aisStart = bgSrc.indexOf('function analyzeImageSequence');
const aisEnd = bgSrc.indexOf('\n}', aisStart);
check('analyzeImageSequence present in background.js', aisStart !== -1 && aisEnd !== -1);
const analyzeImageSequence = eval('(' + bgSrc.slice(aisStart, aisEnd + 2) + ')');

const mkSeq = (n, base = 'https://cdn.example/abc/', digits = 2, ext = '.webp') =>
  Array.from({ length: n }, (_, i) => ({ src: `${base}${String(i + 1).padStart(digits, '0')}${ext}`, index: i + 1 }));

const seq125 = analyzeImageSequence(mkSeq(125));
check('detects an enumerated 1..N sequence',
  !!seq125 && seq125.count === 125 && seq125.base === 'https://cdn.example/abc/' && seq125.ext === '.webp' && seq125.digits === 2);
check('detects unpadded sequences too', (() => {
  const s = analyzeImageSequence(mkSeq(12, 'https://c/x/', 1, '.jpg'));
  return !!s && s.count === 12 && s.digits === 1 && s.ext === '.jpg';
})());
check('rejects mixed bases',
  analyzeImageSequence([{ src: 'https://a/h1/1.webp' }, { src: 'https://a/h2/2.webp' }]) === null);
check('rejects gapped sequences (real DOM srcs)',
  analyzeImageSequence([{ src: 'https://a/x/01.webp' }, { src: 'https://a/x/03.webp' }]) === null);
check('rejects sequences not starting at 1',
  analyzeImageSequence([{ src: 'https://a/x/02.webp' }, { src: 'https://a/x/03.webp' }]) === null);
check('rejects a single image', analyzeImageSequence(mkSeq(1)) === null);
check('rejects non-numeric filenames',
  analyzeImageSequence([{ src: 'https://a/x/cover.webp' }, { src: 'https://a/x/01.webp' }]) === null);
check('rejects empty/invalid input',
  analyzeImageSequence(null) === null && analyzeImageSequence([]) === null);

// 7. makeScramblePermutation (background.js) — must reproduce comix.to's EXACT tile
// order so scrambled pages descramble correctly. The expected permutations below
// were captured from the reader's own descramble (its drawImage tile blits) for the
// given seeds, so they are ground truth, not derived from this code.
const mspStart = bgSrc.indexOf('function makeScramblePermutation');
const mspEnd = bgSrc.indexOf('\n}', mspStart);
check('makeScramblePermutation present in background.js', mspStart !== -1 && mspEnd !== -1);
const makeScramblePermutation = eval('(' + bgSrc.slice(mspStart, mspEnd + 2) + ')');
check('descramble: real seed 3131104163 (5x5)',
  JSON.stringify(makeScramblePermutation(3131104163, 25)) ===
  JSON.stringify([19, 3, 0, 18, 12, 22, 20, 8, 17, 7, 16, 11, 14, 15, 2, 13, 4, 21, 10, 6, 23, 24, 1, 9, 5]));
check('descramble: real seed 3287645735 (5x5)',
  JSON.stringify(makeScramblePermutation(3287645735, 25)) ===
  JSON.stringify([24, 20, 6, 15, 11, 19, 10, 14, 17, 2, 21, 9, 3, 5, 13, 1, 22, 0, 16, 7, 12, 23, 8, 18, 4]));
check('descramble: seed 0 (5x5)',
  JSON.stringify(makeScramblePermutation(0, 25)) ===
  JSON.stringify([4, 20, 18, 12, 13, 7, 8, 15, 23, 11, 10, 3, 5, 0, 22, 1, 6, 2, 16, 24, 9, 21, 14, 19, 17]));
check('descramble: low bit of seed is ignored (f(0) === f(1))',
  JSON.stringify(makeScramblePermutation(0, 25)) === JSON.stringify(makeScramblePermutation(1, 25)));
check('descramble: arbitrary grid (seed 1000000, 16x16 first 6)',
  JSON.stringify(makeScramblePermutation(1000000, 256).slice(0, 6)) === JSON.stringify([6, 65, 9, 242, 181, 32]));
check('descramble: output is a valid permutation of 0..N-1', (() => {
  const p = makeScramblePermutation(3131104163, 25);
  return p.length === 25 && [...p].sort((a, b) => a - b).every((v, i) => v === i);
})());
// comix's 2026 "algo 3" reuses the generator with init constant 0x1 on some
// pages. Ground truth captured from the reader's own descramble of a real
// scrambled page (seed 3620498592, 5x5) — see unscrambleImageBlob's seam pick.
check('descramble: algo-3 0x1 init variant (real seed 3620498592, 5x5)',
  JSON.stringify(makeScramblePermutation(3620498592, 25, 0x1)) ===
  JSON.stringify([20, 15, 0, 12, 1, 10, 9, 18, 6, 7, 17, 8, 5, 2, 16, 19, 22, 3, 11, 13, 23, 14, 4, 24, 21]));
check('descramble: algo-3 0x1cb1d init variant (real seed 3869954323, 5x5)',
  JSON.stringify(makeScramblePermutation(3869954323, 25, 0x1cb1d)) ===
  JSON.stringify([2, 0, 12, 5, 19, 17, 8, 7, 11, 22, 10, 18, 14, 15, 9, 16, 3, 6, 24, 1, 20, 21, 4, 23, 13]));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
