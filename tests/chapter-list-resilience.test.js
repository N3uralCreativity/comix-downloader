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

const context = { Array, String };
vm.createContext(context);
vm.runInContext(`${extractFunction('hasChapterGroupData')}; globalThis.hasGroups = hasChapterGroupData;`, context);

check('a single named translator still exposes the group selector',
  context.hasGroups([{ group: 'Flame Comics' }]));
check('legacy rows without group metadata keep the selector hidden',
  !context.hasGroups([{ group: '' }, { group: null }]));

const goToPage = extractFunction('goToChapterPage');
check('an active pager page is accepted only when chapter rows are present',
  goToPage.includes('cur === target && hasRows'));
check('empty chapter pages invoke automatic list recovery',
  goToPage.includes('recoverChapterListView()'));
check('chapter navigation has a bounded retry limit',
  goToPage.includes('CHAPTER_LIST_NAV_RETRIES'));

const walkPages = extractFunction('walkChapterListPages');
check('chapter pagination restores page state in a finally block',
  walkPages.includes('finally') && walkPages.includes('restoreRenderedChapterPage(originalPage)'));
check('chapter pagination rejects empty or incomplete pages',
  walkPages.includes('empty or incomplete page'));
check('chapter pagination reports a failed page instead of returning partial data',
  walkPages.includes('stopped responding on page'));

const collectRows = extractFunction('collectChapterRowsWithGroups');
check('Download All temporarily reads the unfiltered All groups list',
  collectRows.includes("selectChapterGroup('All groups')"));
check('the original site group and page are restored after collection',
  collectRows.includes('selectChapterGroup(originalGroup)') &&
  collectRows.includes('restoreRenderedChapterPage(originalPage)'));
check('partial row collections are rejected before opening download options',
  collectRows.includes('rows.length < result.total'));

check('active progress frames periodically reconcile their durable session',
  source.includes('DOWNLOAD_ALL_SESSION_SYNC_MS = 2000') &&
  source.includes("action: 'getDownloadAllSession'") &&
  source.includes('restoreDownloadAllPopupFromSession(session)'));
check('session reconciliation can update an already-visible progress frame',
  source.includes("let popup = document.getElementById('cdl-all-popup')") &&
  !extractFunction('restoreDownloadAllPopupFromSession').includes("document.getElementById('cdl-all-popup')) return"));
check('returning to a visible tab forces an immediate session refresh',
  source.includes("document.addEventListener('visibilitychange'") &&
  source.includes('syncDownloadAllSessionNow()'));

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
