'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content', 'content_features.js'), 'utf8');
let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) passed++;
  else { failed++; console.error('FAIL:', name); }
}

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`Missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
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

const root = { scrollTop: 0, scrollHeight: 900, clientHeight: 900 };
const body = { scrollTop: 0, scrollHeight: 900, clientHeight: 900 };
const main = {
  scrollTop: 142000,
  scrollHeight: 159313,
  clientHeight: 900,
  parentElement: body,
  getBoundingClientRect() { return { top: 0, bottom: 900 }; },
};
const pageNode = { scrollTop: 0, scrollHeight: 1333, clientHeight: 1333, parentElement: main };
const listenerCalls = [];
let mode = 'preferred';
let rootScrollTarget = null;

const documentMock = {
  scrollingElement: root,
  documentElement: root,
  body,
  querySelector(selector) {
    if (selector === 'main.rpage-main, .rpage-main') return mode === 'preferred' ? main : null;
    if (selector.startsWith('[data-page]')) return mode === 'none' ? null : pageNode;
    if (selector === 'img.rpage-page__img, img[alt^="Page"]') return pageNode;
    return null;
  },
  addEventListener(type, listener, options) { listenerCalls.push({ op: 'add-document', type, options }); },
  removeEventListener(type, listener, options) { listenerCalls.push({ op: 'remove-document', type, options }); },
};
const windowMock = {
  innerHeight: 900,
  scrollY: 0,
  getComputedStyle(node) { return { overflowY: node === main ? 'auto' : 'visible' }; },
  scrollTo(x, y) { rootScrollTarget = y; root.scrollTop = y; this.scrollY = y; },
  addEventListener(type, listener, options) { listenerCalls.push({ op: 'add-window', type, options }); },
  removeEventListener(type, listener, options) { listenerCalls.push({ op: 'remove-window', type, options }); },
};

const context = { document: documentMock, window: windowMock, PAGE_IMG_SEL: 'img.rpage-page__img, img[alt^="Page"]' };
vm.createContext(context);
vm.runInContext(`
  ${extractFunction('readerScrollElement')}
  ${extractFunction('isRootScrollElement')}
  ${extractFunction('readerScrollMetrics')}
  ${extractFunction('addReaderScrollListener')}
  ${extractFunction('removeReaderScrollListener')}
  ${extractFunction('setReaderScrollTop')}
  ${extractFunction('scrollMax')}
  ${extractFunction('scrollFrac')}
  ${extractFunction('chapterFrac')}
  globalThis.api = { readerScrollElement, readerScrollMetrics, addReaderScrollListener,
    removeReaderScrollListener, setReaderScrollTop, scrollMax, scrollFrac, chapterFrac };
`, context);

const api = context.api;
check('reader selects the live rpage-main scroller', api.readerScrollElement() === main);
check('reader metrics use inner scrollTop', api.readerScrollMetrics().top === 142000);
check('reader metrics use inner viewport and range', api.readerScrollMetrics().viewport === 900 && api.readerScrollMetrics().max === 158413);
check('chapter progress reflects the inner reader scroller', api.chapterFrac() > 0.89 && api.chapterFrac() < 0.90);

mode = 'ancestor';
check('reader falls back to a scrollable page ancestor after a class rename', api.readerScrollElement() === main);

main.scrollTop = 0;
api.setReaderScrollTop(120000);
check('resume writes to the inner reader scroller', main.scrollTop === 120000 && rootScrollTarget === null);

const listener = function () {};
api.addReaderScrollListener(listener);
api.removeReaderScrollListener(listener);
check('inner scroll events are observed during capture', listenerCalls.some((call) =>
  call.op === 'add-document' && call.type === 'scroll' && call.options && call.options.capture === true));
check('captured scroll listener is removed with capture enabled', listenerCalls.some((call) =>
  call.op === 'remove-document' && call.type === 'scroll' && call.options === true));

mode = 'none';
root.scrollHeight = 5000;
root.clientHeight = 900;
root.scrollTop = 2050;
windowMock.scrollY = 2050;
check('normal document scrolling remains supported', api.readerScrollMetrics().root === true && api.scrollFrac() === 0.5);

const flushContext = { captured: [] };
vm.createContext(flushContext);
vm.runInContext(`
  var TRACK_TICK_SECS = 5, TRACK_MIN_SECS = 30, TRACK_MAX_SECS = 2700, TRACK_FINISH_FRAC = 0.85;
  var readTrack = null, fraction = 0, captured = globalThis.captured;
  function chapterFrac() { return fraction; }
  var Core = { recordReadSample: function (stats, sample) { captured.push(sample); return stats || {}; } };
  var chrome = { storage: { local: {
    get: function (key, callback) { callback({ cdlReadStats: {} }); },
    set: function () {}
  } } };
  ${extractFunction('flushReadTrack')}
  globalThis.runFlush = function (track, currentFraction) {
    readTrack = track; fraction = currentFraction; captured.length = 0;
    flushReadTrack();
    return { track: readTrack, samples: captured.slice() };
  };
`, flushContext);

const finalFlush = flushContext.runFlush({
  slug: 'series', name: 'Series', active: 0, total: 60, credited: false, maxFrac: 0,
}, 0.9);
check('final flush credits completion between timer ticks', finalFlush.track.credited === true && finalFlush.samples.length === 1);
check('between-ticks completion adds no duplicate reading time',
  finalFlush.samples[0].finished === true && finalFlush.samples[0].seconds === 0 && finalFlush.samples[0].paceSecs === 60);

const unfinishedFlush = flushContext.runFlush({
  slug: 'series', name: 'Series', active: 0, total: 60, credited: false, maxFrac: 0,
}, 0.5);
check('empty final flush does not write an unfinished sample', unfinishedFlush.samples.length === 0);

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
