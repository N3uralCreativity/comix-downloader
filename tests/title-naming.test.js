'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const CDLSettings = require('../core/settings.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'content', 'content_title.js'), 'utf8');
let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) passed++;
  else { failed++; console.error('FAIL:', name); }
}

const start = source.indexOf('function normalizeMangaName(');
const end = source.indexOf('// ── Slugification', start);
if (start === -1 || end === -1) throw new Error('Unable to locate manga title helpers');
const namingStart = source.indexOf('function buildSingleZipName(');
const namingEnd = source.indexOf('// Dynamic, settings-driven CSS', namingStart);
const metadataStart = source.indexOf('function getChapterSourceMetadata(');
const metadataEnd = source.indexOf('function buildSingleZipName(', metadataStart);
const slugStart = source.indexOf('function slugify(');
const slugEnd = source.indexOf('// ── Extraction du numéro', slugStart);
if ([namingStart, namingEnd, metadataStart, metadataEnd, slugStart, slugEnd].some((offset) => offset === -1)) {
  throw new Error('Unable to locate archive naming helpers');
}

const context = {
  CFG: {},
  document: null,
  location: null,
  decodeURIComponent,
  String,
  CDLSettings,
};
vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}\nthis.api = { getMangaName, mangaNameFromTitlePath, usableMangaName };`, context);
vm.runInContext(`
  ${source.slice(namingStart, namingEnd)}
  ${source.slice(metadataStart, metadataEnd)}
  ${source.slice(slugStart, slugEnd)}
  this.api.buildSingleZipName = buildSingleZipName;
  this.api.buildAllZipName = buildAllZipName;
  this.api.getChapterSourceMetadata = getChapterSourceMetadata;
`, context);

function element(text, content) {
  return {
    textContent: text || '',
    getAttribute(name) { return name === 'content' ? (content || '') : ''; },
  };
}

function resolveName({ title = '', pathname = '/title/qqwrm-full-time-awakening', selectors = {} } = {}) {
  context.document = {
    title,
    querySelector(selector) { return selectors[selector] || null; },
  };
  context.location = { pathname };
  return context.api.getMangaName();
}

check('current Comix title markup is preferred', resolveName({
  title: 'Untitled',
  selectors: {
    '.mpage__title': element('Full-Time Awakening'),
    'meta[property="og:title"]': element('', 'Wrong metadata'),
  },
}) === 'Full-Time Awakening');

check('Open Graph title replaces a transient Untitled heading', resolveName({
  title: 'Untitled',
  selectors: {
    '.mpage__title': element('Untitled'),
    'meta[property="og:title"]': element('', 'Full-Time Awakening'),
  },
}) === 'Full-Time Awakening');

check('page title suffix is removed', resolveName({
  title: 'The Spark in Your Eyes | Comix',
  pathname: '/title/k7yg7-the-spark-in-your-eyes',
}) === 'The Spark in Your Eyes');

check('title URL is a stable last resort for a placeholder page', resolveName({
  title: 'Just a moment...',
  pathname: '/title/qqwrm-full-time-awakening',
  selectors: { h1: element('Untitled') },
}) === 'Full Time Awakening');

const recoveredName = resolveName({
  title: 'Untitled',
  pathname: '/title/qqwrm-full-time-awakening',
  selectors: { '.mpage__title': element('Untitled') },
});
check('recovered titles reach single and Download All archive filenames',
  context.api.buildSingleZipName(recoveredName, 'Ch4') === 'Full-Time-Awakening-Ch4.zip' &&
  context.api.buildAllZipName(recoveredName) === 'Full-Time-Awakening.zip');

const groupElement = {
  textContent: 'Rizz Fables',
  getAttribute(name) { return name === 'href' ? '/groups/207' : ''; },
  querySelector(selector) { return selector === 'span' ? { textContent: 'Rizz Fables' } : null; },
};
const chapterRow = {
  querySelector(selector) { return selector === '.mchap-row__group' ? groupElement : null; },
};
const chapterItem = {
  querySelector(selector) { return selector === '.mchap-row' ? chapterRow : null; },
};
const siblingDownloadAnchor = {
  matches() { return false; },
  closest(selector) {
    if (selector === '.mchap-item') return chapterItem;
    return null;
  },
  parentElement: chapterItem,
};
const sourceMetadata = context.api.getChapterSourceMetadata(siblingDownloadAnchor);
check('chapter buttons read scanlator metadata from their sibling Comix row',
  sourceMetadata.scanlator === 'Rizz Fables' &&
  sourceMetadata.group === 'Rizz Fables' &&
  sourceMetadata.groupId === '207');

context.CFG['naming.singleZipTpl'] = '{manga}-Ch{chapter}-{scanlator}';
check('single-chapter naming exposes scanlator tokens',
  context.api.buildSingleZipName('Way To Heaven', 'Ch101', sourceMetadata) ===
    'Way-To-Heaven-Ch101-Rizz Fables.zip');

check('placeholder names never pass validation',
  context.api.usableMangaName('Untitled') === '' &&
  context.api.usableMangaName('Loading...') === '' &&
  context.api.usableMangaName('Just a moment...') === '');

check('non-title pages keep a deterministic fallback', resolveName({
  title: 'Untitled',
  pathname: '/',
}) === 'comix-title');

console.log(`Title naming tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
