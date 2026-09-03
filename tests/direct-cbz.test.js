'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JSZip = require('../lib/jszip.min.js');
const CDLComicInfo = require('../core/cdl-comicinfo.js');

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

const context = { JSZip, CDLComicInfo };
vm.createContext(context);
vm.runInContext(`
  ${extractFunction('buildChapterComicInfoXml')}
  ${extractFunction('buildChapterCbzBytes')}
  globalThis.buildChapterCbzBytes = buildChapterCbzBytes;
`, context);

(async () => {
  const chapter = {
    chapterLabel: 'Ch12',
    chapterUrl: 'https://comix.to/title/solo-leveling/1-chapter-12',
    imagesTotal: 2,
    files: [
      { name: '001.webp', buffer: new Uint8Array([1, 2, 3]) },
      { name: '002.webp', buffer: new Uint8Array([4, 5, 6]) },
    ],
  };
  const progress = [];
  const bytes = await context.buildChapterCbzBytes(chapter, {
    includeComicInfo: true,
    totalCount: 20,
    seriesMeta: { title: 'Solo Leveling', language: 'en' },
  }, 'Solo Leveling', (metadata) => progress.push(metadata.percent));
  const archive = await JSZip.loadAsync(bytes);

  check('direct CBZ bytes contain each ordered chapter image',
    !!archive.file('001.webp') && !!archive.file('002.webp'));
  check('direct CBZ bytes preserve ComicInfo metadata', (() => {
    const entry = archive.file('ComicInfo.xml');
    return !!entry;
  })());
  const xml = await archive.file('ComicInfo.xml').async('string');
  check('direct CBZ ComicInfo identifies the series and chapter',
    xml.includes('<Series>Solo Leveling</Series>') && xml.includes('<Number>12</Number>'));
  check('direct CBZ generation reports real archive progress',
    progress.length > 0 && progress.some((value) => Number(value) > 0));

  const withoutMetadata = await context.buildChapterCbzBytes(chapter, {
    includeComicInfo: false,
    seriesMeta: { title: 'Solo Leveling' },
  }, 'Solo Leveling');
  const plainArchive = await JSZip.loadAsync(withoutMetadata);
  check('ComicInfo remains optional in direct CBZ mode', !plainArchive.file('ComicInfo.xml'));

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
