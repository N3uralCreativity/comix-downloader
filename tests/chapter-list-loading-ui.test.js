'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content', 'content_title.js'), 'utf8');
let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) passed++;
  else { failed++; console.error('FAIL:', name); }
}

function extractFunction(name) {
  const marker = source.indexOf(`function ${name}(`);
  if (marker === -1) throw new Error(`Missing function ${name}`);
  const start = source.slice(Math.max(0, marker - 6), marker) === 'async ' ? marker - 6 : marker;
  const bodyStart = source.indexOf('{', source.indexOf(')', marker));
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unterminated function ${name}`);
}

const controlContext = { AbortController, Error };
vm.createContext(controlContext);
vm.runInContext(`
  ${extractFunction('createChapterListCollectionControl')}
  globalThis.createControl = createChapterListCollectionControl;
`, controlContext);

const updates = [];
const control = controlContext.createControl((progress) => updates.push(progress));
control.report({ phase: 'reading', page: 101 });
check('collection controls forward live progress', updates.length === 1 && updates[0].page === 101);
control.cancel();
check('cancelling aborts active legacy chapter-list requests', control.signal.aborted === true);
check('cancelled controls stop forwarding progress', (() => {
  control.report({ phase: 'ready' });
  return updates.length === 1;
})());
check('cancelled controls throw a distinguishable cancellation error', (() => {
  try { control.checkpoint(); return false; }
  catch (error) { return error.code === 'CDL_CHAPTER_LIST_CANCELLED'; }
})());

const popupSource = extractFunction('showChapterListLoadingPopup');
const updateSource = extractFunction('updateChapterListLoadingPopup');
const errorSource = extractFunction('showChapterListLoadingError');
const collectRowsSource = extractFunction('collectChapterRowsWithGroups');

check('the loader identifies itself as Comix Downloader',
  popupSource.includes('<span>Comix Downloader</span>') && popupSource.includes('/ Download All'));
check('the loader exposes Open list, Read chapters, and Options stages',
  popupSource.includes('Open list') && popupSource.includes('Read chapters') && popupSource.includes('Options'));
check('the loader exposes entry, chapter, and group counters',
  popupSource.includes('cdl-cl-entries') && popupSource.includes('cdl-cl-chapters') && popupSource.includes('cdl-cl-groups'));
check('the loader switches from indeterminate to real page progress',
  updateSource.includes("phase === 'reading'") && updateSource.includes('page / totalPages * 100'));
check('collection reports progress from each rendered chapter page',
  extractFunction('walkChapterListPages').includes("phase: 'reading'") &&
  extractFunction('walkChapterListPages').includes('totalPages: getChapterListPageCount'));
check('cancellation restores the original source and chapter page',
  collectRowsSource.includes('finally') && collectRowsSource.includes('selectChapterGroup(originalGroup)') &&
  collectRowsSource.includes('restoreRenderedChapterPage(originalPage)'));
check('chapter-list failures use the extension diagnostic panel instead of an alert',
  errorSource.includes("errorKind: 'chapter_list'") &&
  errorSource.includes('_cdlAddPopupDiagnostic') &&
  !source.includes("alert(collectionError?.message"));
check('chapter-list errors provide Retry and Close actions',
  errorSource.includes("retry.textContent = 'Retry'") && errorSource.includes("close.textContent = 'Close'"));
check('the loader has responsive and reduced-motion styling',
  source.includes('#cdl-all-popup[data-progress-mode="indeterminate"] .cdl-ap-bar') &&
  source.includes('@media (max-width: 640px)') && source.includes('@media (prefers-reduced-motion: reduce)'));

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
