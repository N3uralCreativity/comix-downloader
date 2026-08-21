'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const CDLFeaturesCore = require('../core/cdl-features-core.js');

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

const context = { CDLFeaturesCore, String, Number, Map, Array };
vm.createContext(context);
vm.runInContext(`
  ${extractFunction('chapterKeyOf')}
  ${extractFunction('chapterNumericValue')}
  ${extractFunction('parseSpecificChapterSelection')}
  globalThis.parseSelection = parseSpecificChapterSelection;
`, context);

const rows = [1, 2, 14, 20, 20.5, 21, 25, 94].map((number) => ({
  chapterLabel: `Ch${number}`,
  chapterUrl: `https://comix.to/title/example/${number}-chapter-${number}`,
  group: 'Group A',
}));

let result = context.parseSelection('1, 14, 94, 21', rows);
check('comma-separated chapter numbers select only those chapters in reading order',
  result.chapters.map((row) => row.chapterLabel).join(',') === 'Ch1,Ch14,Ch21,Ch94');

result = context.parseSelection('20-25', rows);
check('ranges include available decimal chapters without inventing missing chapters',
  result.chapters.map((row) => row.chapterLabel).join(',') === 'Ch20,Ch20.5,Ch21,Ch25');

result = context.parseSelection('25-20, Ch14, 14', rows);
check('descending ranges are normalized and duplicate selections are removed',
  result.chapters.map((row) => row.chapterLabel).join(',') === 'Ch14,Ch20,Ch20.5,Ch21,Ch25');

result = context.parseSelection('2, 999, prologue', rows);
check('unavailable and malformed selectors remain distinguishable',
  result.chapters.length === 1 && result.chapters[0].chapterLabel === 'Ch2' &&
  result.unmatched.join(',') === '999' && result.invalid.join(',') === 'prologue');

check('the options panel exposes quick entry and the real-list chapter picker',
  source.includes('value="specific"') &&
  source.includes('id="cdl-op-specific-input"') &&
  source.includes('id="cdl-op-pick"') &&
  source.includes('function openSpecificChapterPicker(') &&
  source.includes('cdl-specific-chapter-check'));

check('chapter picker checkboxes stay centered in chapter rows',
  source.includes('align-self:center !important') &&
  source.includes('justify-self:center') &&
  source.includes('margin:auto 0 auto 5px'));

check('chapter picker focuses the real list and blocks outside misclicks',
  source.includes("layer.id = 'cdl-specific-picker-focus'") &&
  source.includes('cdl-specific-focus-shade') &&
  source.includes('Selecting chapters') &&
  source.includes("chapterSection.addEventListener('click', picker.onChapterClick, true)") &&
  source.includes('picker.focus = createSpecificChapterPickerFocus(chapterSection)'));

check('specific selections feed the existing Download All subset',
  source.includes("if (scope === 'specific') return orderedSpecificChapters();") &&
  source.includes('_lastDlAllParams = { chapters: subset, mangaName, zipName, options };'));

console.log(`Specific chapter selection tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
