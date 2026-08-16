'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const titleSource = fs.readFileSync(
  path.join(__dirname, '..', 'content', 'content_title.js'),
  'utf8'
);
const featuresSource = fs.readFileSync(
  path.join(__dirname, '..', 'content', 'content_features.js'),
  'utf8'
);
let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) passed++;
  else { failed++; console.error('FAIL:', name); }
}

function extractFunction(source, name) {
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

async function main() {
  const totalEntries = 2021;
  const pageSize = 20;
  let currentPage = 1;
  let collectedPages = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const requestedPages = [];

  const context = {
    Array,
    Error,
    Math,
    Number,
    Promise,
    Set,
    getCurrentRenderedChapterPage: () => currentPage,
    goToChapterPage: async (target) => { currentPage = target; return true; },
    extractChapterUrlsFromDom: () => [`chapter-${currentPage}`],
    getChapterListRange: () => ({
      from: ((currentPage - 1) * pageSize) + 1,
      to: Math.min(currentPage * pageSize, totalEntries),
      total: totalEntries,
    }),
    getChaptersSection: () => ({}),
    restoreRenderedChapterPage: async (target) => { currentPage = target; return true; },
    recoverChapterListView: async () => true,
    fetchChapterListPage: async (_buildId, _slug, page) => {
      activeRequests++;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise(resolve => setTimeout(resolve, 0));
      requestedPages.push(page);
      activeRequests--;
      return [`chapter-${page}`];
    },
    setTimeout,
    window: { scrollY: 100, scrollTo() {} },
  };
  vm.createContext(context);
  vm.runInContext(`
    const CHAPTERS_PER_PAGE = 20;
    const CHAPTER_LIST_FETCH_CONCURRENCY = 4;
    ${extractFunction(titleSource, 'getChapterListPageCount')}
    ${extractFunction(titleSource, 'fetchChapterListPages')}
    ${extractFunction(titleSource, 'walkChapterListPages')}
    globalThis.api = { getChapterListPageCount, fetchChapterListPages, walkChapterListPages };
  `, context);

  check('page count supports more than 100 chapter-list pages',
    context.api.getChapterListPageCount(totalEntries) === 102);

  const walkResult = await context.api.walkChapterListPages(() => { collectedPages++; });
  check('rendered pagination reads every page beyond the former limit',
    walkResult.total === totalEntries && collectedPages === 102);
  check('rendered pagination restores the original page', currentPage === 1);

  const fetched = await context.api.fetchChapterListPages('build', 'series', totalEntries);
  check('legacy page fetching includes every page beyond the former limit',
    fetched.length === 102 && requestedPages.length === 102 && requestedPages.includes(102));
  check('legacy page fetching keeps request concurrency bounded', maxActiveRequests <= 4);

  const walkSource = extractFunction(titleSource, 'walkChapterListPages');
  check('rendered pagination detects a stalled pager instead of using a fixed cap',
    walkSource.includes('seenRanges.has') && walkSource.includes('did not advance past items'));
  check('browser chapter collectors no longer contain the 100-page caps',
    !titleSource.includes('MAX_CHAPTER_LIST_PAGES') && !featuresSource.includes('MAX_PAGES'));

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
