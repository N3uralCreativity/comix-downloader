'use strict';
/**
 * How often the extension asks comix for something, run: `node tests/request-pacing.test.js`.
 * Covers the cool-down of an image host that keeps failing (background.js) and the pace of
 * reading the chapter list (content/content_title.js). The page pace, the shared wait comix
 * asks for and Cloudflare pauses are in tests/comix-tab-image-fetch.test.js; the time between
 * chapters is in tests/comix-api.test.js.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8').replace(/\r\n/g, '\n');
const titleScript = fs.readFileSync(path.join(__dirname, '..', 'content', 'content_title.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name); }
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

function extractConst(source, name) {
  const match = source.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (!match) throw new Error(`Missing const ${name}`);
  return match[0];
}

(async () => {
  // An image host that keeps failing is left alone for a while
  {
    const logs = [];
    const context = { URL, Date, Math, Map, cdlLog: (level, message) => logs.push(message) };
    vm.createContext(context);
    vm.runInContext([
      'const imageHostCooldownUntil = new Map();',
      ...['IMAGE_HOST_TRIP_FAILURES', 'IMAGE_HOST_TRIP_BASE_MS', 'IMAGE_HOST_TRIP_MAX_MS', 'imageHostHealth']
        .map((name) => extractConst(background, name)),
      ...['imageHostKey', 'deferImageHost', 'noteImageHostFailure', 'noteImageHostSuccess']
        .map((name) => extractFunction(background, name)),
      'globalThis.api = { noteImageHostFailure, noteImageHostSuccess, cooldowns: imageHostCooldownUntil };',
    ].join('\n'), context);
    const { api } = context;
    const host = 'https://c150.kkplayer.wtf';
    const left = () => (api.cooldowns.get(host) || 0) - Date.now();

    const early = [1, 2, 3, 4, 5].map((n) => api.noteImageHostFailure(`${host}/hi/page-${n}`));
    check('five failed pages in a row do not stop a host yet', early.every((ms) => ms === 0) && !api.cooldowns.has(host));
    const first = api.noteImageHostFailure(`${host}/hi/page-6`);
    check('the sixth stops it for 30 s', first === 30000 && left() > 29000 && left() <= 30000);
    check('the log says so', logs.length === 1 && logs[0].includes('kkplayer.wtf') && logs[0].includes('30 s'));
    let second = 0;
    for (let n = 0; n < 6; n++) second = api.noteImageHostFailure(`${host}/hi/again-${n}`) || second;
    check('if it keeps failing after that, the next stop is twice as long', second === 60000);
    let longest = 0;
    for (let n = 0; n < 60; n++) longest = Math.max(longest, api.noteImageHostFailure(`${host}/hi/more-${n}`));
    check('a stop never lasts more than 5 minutes', longest === 5 * 60 * 1000);

    const other = 'https://ek10.spark-node-v2.site';
    for (let n = 0; n < 5; n++) api.noteImageHostFailure(`${other}/i5/p${n}`);
    api.noteImageHostSuccess(`${other}/i5/ok`);
    const afterSuccess = [0, 1, 2, 3, 4].map((n) => api.noteImageHostFailure(`${other}/i5/q${n}`));
    check('a page that loads clears the count for its host', afterSuccess.every((ms) => ms === 0) && !api.cooldowns.has(other));
    check('hosts are counted separately', api.cooldowns.has(host) && !api.cooldowns.has(other));
  }

  // The chapter list is read about one page a second
  {
    const context = { Date, Math, setTimeout, Promise };
    vm.createContext(context);
    vm.runInContext([
      // A shorter gap than the real one (CHAPTER_LIST_PAGE_GAP_MS) keeps the test quick.
      'const CHAPTER_LIST_PAGE_GAP_MS = 200;',
      'let chapterListNextTurnAt = 0;',
      extractFunction(titleScript, 'wait'),
      extractFunction(titleScript, 'waitForChapterListTurn'),
      'globalThis.turn = waitForChapterListTurn;',
    ].join('\n'), context);
    const realGap = Number((titleScript.match(/^const CHAPTER_LIST_PAGE_GAP_MS = (\d+);$/m) || [])[1]);
    check('the real gap between two chapter-list pages is one second', realGap === 1000);

    const times = [];
    for (let n = 0; n < 4; n++) { await context.turn(null); times.push(Date.now()); }
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    check('each move through the list waits its turn (160-240 ms apart here)', gaps.every((gap) => gap >= 150 && gap <= 300));

    let cancelled = false;
    const collection = { checkpoint() { if (cancelled) throw Object.assign(new Error('cancelled'), { code: 'CDL_CHAPTER_LIST_CANCELLED' }); } };
    const waiting = context.turn(collection).catch((e) => e);
    cancelled = true;
    const result = await waiting;
    check('cancelling the list ends the wait', result && result.code === 'CDL_CHAPTER_LIST_CANCELLED');
  }

  // Every way of moving through the list takes that turn first
  {
    const before = (fn, call) => {
      const body = extractFunction(titleScript, fn);
      const turn = body.indexOf('await waitForChapterListTurn(collection);');
      return turn !== -1 && turn < body.indexOf(call);
    };
    check('a pager click waits its turn', before('goToChapterPage', 'btn.click()'));
    check('switching the sort to reload an empty list waits its turn', before('recoverChapterListView', 'alternative.click()') &&
      (() => {
        const body = extractFunction(titleScript, 'recoverChapterListView');
        const second = body.indexOf('await waitForChapterListTurn(collection);', body.indexOf('alternative.click()'));
        return second !== -1 && second < body.indexOf('original.click()');
      })());
    check('reading a list page from the older data route waits its turn', before('fetchChapterListPage', 'fetch('));
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });
