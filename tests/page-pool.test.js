'use strict';
/**
 * Chapter pages download through a rolling pool (run: `node tests/page-pool.test.js`):
 * never more than the configured number at once, and a slow page no longer holds back
 * the pages after it.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name); }
}

function extractFunction(name) {
  const marker = source.indexOf(`function ${name}(`);
  if (marker === -1) throw new Error(`Missing function ${name}`);
  const start = source.slice(Math.max(0, marker - 6), marker) === 'async ' ? marker - 6 : marker;
  const bodyStart = source.indexOf('{', source.indexOf(')', marker));
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unterminated function ${name}`);
}

const context = { console: { warn() {} }, Math, Number, Array, Promise };
vm.createContext(context);
vm.runInContext(`${extractFunction('forEachPageInPool')}; globalThis.pool = forEachPageInPool;`, context);
const pool = context.pool;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  // Width is a ceiling
  {
    let active = 0; let peak = 0; const seen = [];
    await pool([...Array(20).keys()], 3, () => false, async (item, index) => {
      active++; peak = Math.max(peak, active); seen.push(index);
      await wait(5 + (item % 4) * 3);
      active--;
    });
    check('never more than the configured pages at once', peak === 3);
    check('every page is downloaded once', seen.length === 20 && new Set(seen).size === 20);
    check('pages start in reading order', seen.slice(0, 3).join() === '0,1,2');
  }

  // A slow page does not hold back the others (the old fixed groups did)
  {
    const finished = [];
    const t0 = Date.now();
    await pool([...Array(9).keys()], 3, () => false, async (item) => {
      await wait(item === 0 ? 150 : 10);
      finished.push(item);
    });
    const elapsed = Date.now() - t0;
    check('the other pages finish while one page is slow', finished.indexOf(0) === finished.length - 1);
    check('total time is about the slow page, not slow page x groups', elapsed < 260);
  }

  // Stopping
  {
    let stop = false; const started = [];
    await pool([...Array(30).keys()], 2, () => stop, async (item) => {
      started.push(item);
      if (item === 3) stop = true;
      await wait(5);
    });
    check('no new page starts after a stop', started.length <= 5);
  }

  // A throwing task does not stop the rest
  {
    const done = [];
    await pool([...Array(6).keys()], 2, () => false, async (item) => {
      if (item === 1) throw new Error('boom');
      done.push(item);
    });
    check('one failing page does not stop the others', done.length === 5);
  }

  // Edge cases
  {
    let calls = 0;
    await pool([], 3, () => false, async () => { calls++; });
    check('an empty chapter does nothing', calls === 0);
    let peak = 0; let active = 0;
    await pool([1, 2, 3], 0, () => false, async () => { active++; peak = Math.max(peak, active); await wait(2); active--; });
    check('a width of 0 still downloads one page at a time', peak === 1);
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => { console.error(error); process.exit(1); });
