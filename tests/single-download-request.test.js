'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const CDLSettings = require('../core/settings.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) passed++;
  else { failed++; console.error('FAIL:', name); }
}

function extractFunction(name) {
  const marker = source.indexOf(`function ${name}(`);
  if (marker === -1) throw new Error(`Missing function ${name}`);
  const bodyStart = source.indexOf('{', source.indexOf(')', marker));
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(marker, i + 1);
  }
  throw new Error(`Unterminated function ${name}`);
}

const context = { CDLSettings, String, Number, Math, decodeURIComponent };
vm.createContext(context);
vm.runInContext(`
  ${extractFunction('chapterLabelFromUrl')}
  ${extractFunction('usableSingleDownloadMangaName')}
  ${extractFunction('singleDownloadTitleFromUrl')}
  ${extractFunction('singleDownloadMangaToken')}
  ${extractFunction('normalizeSingleChapterDownloadRequest')}
  globalThis.normalizeRequest = normalizeSingleChapterDownloadRequest;
`, context);

const cfg = {
  ...CDLSettings.DEFAULTS,
  'output.format': 'cbz',
  'output.includeComicInfo': true,
  'naming.singleZipTpl': '{manga}-Ch{chapter}',
};
const chapterUrl = 'https://comix.to/title/m7j0-way-to-heaven/5663065-chapter-101';
const normalized = context.normalizeRequest(chapterUrl, cfg, {
  format: 'zip',
  includeComicInfo: false,
  chapterLabel: 'Ch101',
  mangaName: 'Way To Heaven',
  scanlator: 'Rizz Fables',
  groupId: '207',
  seriesMeta: { title: 'Way To Heaven' },
});

check('saved CBZ settings override stale page-cached ZIP options',
  normalized.options.format === 'cbz' && normalized.options.includeComicInfo === true);
check('single chapter request keeps its title, chapter, and scanlator metadata',
  normalized.zipName === 'Way-To-Heaven-Ch101.zip' &&
  normalized.options.mangaName === 'Way To Heaven' &&
  normalized.options.chapterLabel === 'Ch101' &&
  normalized.options.scanlator === 'Rizz Fables' &&
  normalized.options.groupId === '207');

const recovered = context.normalizeRequest(chapterUrl, cfg, {
  format: 'zip',
  mangaName: 'Untitled',
  seriesMeta: { title: 'Loading...' },
});
check('missing or placeholder page metadata cannot degrade to download.zip',
  recovered.zipName === 'Way-To-Heaven-Ch101.zip' &&
  recovered.options.mangaName === 'Way To Heaven');

const custom = context.normalizeRequest(chapterUrl, {
  ...cfg,
  'naming.singleZipTpl': '{manga}-Ch{num4}-{scanlator}',
}, {
  mangaName: 'Way To Heaven',
  scanlator: 'Rizz Fables',
});
check('background naming uses scanlator-aware saved templates',
  custom.zipName === 'Way-To-Heaven-Ch0101-Rizz Fables.zip');

console.log(`Single download request tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
