'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const CDLSettings = require('../core/settings.js');

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
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unterminated function ${name}`);
}

const context = { CDLSettings, String };
vm.createContext(context);
vm.runInContext(`
  ${extractFunction('seriesFolderName')}
  ${extractFunction('buildChapterFolderName')}
  ${extractFunction('buildChapterEntryName')}
  ${extractFunction('chapterNamingParts')}
  ${extractFunction('buildCbzFileBase')}
  ${extractFunction('buildCbzEntryName')}
  ${extractFunction('uniqueChapterEntryName')}
  ${extractFunction('sanitizeFilename')}
  ${extractFunction('downloadTargetFilename')}
  ${extractFunction('uniqueDirectCbzEntryName')}
  ${extractFunction('directCbzTargetFilename')}
  ${extractFunction('resolveOutputOptions')}
  globalThis.api = {
    buildCbzFileBase,
    buildCbzEntryName,
    uniqueChapterEntryName,
    uniqueDirectCbzEntryName,
    directCbzTargetFilename,
    resolveOutputOptions,
  };
`, context);

const baseOptions = {
  folderLayout: 'default',
  folderFmt: 'Ch{num4}{rest}',
  cbzFileTpl: '{entry}',
  slug: 'solo-leveling',
  seriesMeta: { title: 'Solo Leveling', language: 'en' },
};
const chapter = {
  chapterLabel: 'Ch12',
  scanlator: 'Flame Comics',
  groupId: '42',
};

check('default CBZ template preserves the legacy Download All entry',
  context.api.buildCbzEntryName(baseOptions, chapter, 'Solo Leveling') === 'Ch0012');

check('custom CBZ template renders chapter and scanlator tokens',
  context.api.buildCbzEntryName({
    ...baseOptions,
    cbzFileTpl: '{manga} - Ch{num4} [{scanlator}]',
  }, chapter, 'Solo Leveling') === 'Solo Leveling - Ch0012 [Flame Comics]');

check('CBZ template exposes group id, language, label, and date-safe metadata',
  context.api.buildCbzFileBase({
    ...baseOptions,
    cbzFileTpl: '{label}-{groupId}-{language}-{group}',
  }, 'Ch12', 'Solo Leveling', chapter, 'Ch0012') ===
    'Ch12-42-en-Flame Comics');

check('Kavita layout keeps its series folder while customizing the CBZ basename',
  context.api.buildCbzEntryName({
    ...baseOptions,
    folderLayout: 'kavita',
    cbzFileTpl: 'Ch{num4} [{scanlator}]',
  }, chapter, 'Solo Leveling') === 'Solo Leveling/Ch0012 [Flame Comics]');

const stored = new Set(['Same.cbz']);
const zip = {
  file(name, value) {
    if (arguments.length === 1) return stored.has(name) ? { name } : null;
    stored.add(name);
    return this;
  },
};
check('duplicate custom CBZ names gain a chapter suffix instead of overwriting',
  context.api.uniqueChapterEntryName(zip, 'Same', 'cbz', 'Ch12') === 'Same-Ch12');

const directNames = new Set();
check('direct CBZ names use the same deterministic collision suffixes',
  context.api.uniqueDirectCbzEntryName(directNames, 'Same', 'Ch12') === 'Same' &&
  context.api.uniqueDirectCbzEntryName(directNames, 'Same', 'Ch13') === 'Same-Ch13');
check('direct CBZ files respect the configured browser download folder',
  context.api.directCbzTargetFilename('Ch0012', 'Comix Downloader/Manga') ===
    'Comix Downloader/Manga/Ch0012.cbz');
check('direct CBZ files preserve the Kavita series subfolder',
  context.api.directCbzTargetFilename('Solo Leveling/Ch0012', 'Comix Downloader') ===
    'Comix Downloader/Solo Leveling/Ch0012.cbz');
check('direct delivery only applies to CBZ and stays disabled by default',
  context.api.resolveOutputOptions({}, {}).directCbz === false &&
  context.api.resolveOutputOptions({ 'output.directCbz': true }, { format: 'zip' }).directCbz === false &&
  context.api.resolveOutputOptions({ 'output.directCbz': true }, { format: 'cbz' }).directCbz === true);
check('direct CBZ delivery omits series-level files that require an outer ZIP',
  context.api.resolveOutputOptions({
    'output.format': 'cbz',
    'output.directCbz': true,
    'output.includeSeriesMeta': true,
  }, {}).includeSeriesMeta === false);

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
