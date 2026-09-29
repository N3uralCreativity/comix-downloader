'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function extractFunction(name) {
  const marker = source.indexOf(`function ${name}(`);
  if (marker < 0) throw new Error(`Missing function ${name}`);
  const start = source.slice(Math.max(0, marker - 6), marker) === 'async ' ? marker - 6 : marker;
  const bodyStart = source.indexOf('{', source.indexOf(')', marker));
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth++;
    if (character === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unterminated function ${name}`);
}

async function run() {
  const context = { Date, URL, Set, Promise, Math, Array };
  vm.createContext(context);
  vm.runInContext(`
    const CDL_AGENDA_HISTORY_STALE_MS = 7 * 24 * 60 * 60 * 1000;
    const CDL_AGENDA_RETRY_COOLDOWN_MS = 15 * 60 * 1000;
    ${extractFunction('normalizeAgendaCoverUrl')}
    ${extractFunction('agendaHistoryEvidenceCount')}
    ${extractFunction('agendaRefreshReason')}
    ${extractFunction('runAgendaPool')}
    globalThis.refreshReason = agendaRefreshReason;
    globalThis.runPool = runAgendaPool;
  `, context);

  const now = Date.now();
  const subscription = { coverUrl: 'https://comix.to/poster.webp' };
  const current = {
    historyEvents: [{ chapterKey: '1' }, { chapterKey: '2' }],
    lastBackfillAt: now - 60_000,
  };
  assert.strictEqual(context.refreshReason(subscription, current, { onlyMissing: true }, now), '');
  assert.strictEqual(context.refreshReason(subscription, current, {}, now), '');
  assert.strictEqual(context.refreshReason(subscription, {
    ...current,
    lastBackfillAt: now - (8 * 24 * 60 * 60 * 1000),
  }, {}, now), 'stale-history');

  const recentFailure = { lastAttemptAt: now - 30_000 };
  assert.strictEqual(context.refreshReason(subscription, recentFailure, { onlyMissing: true }, now), '');
  assert.strictEqual(context.refreshReason(subscription, recentFailure, {}, now), 'missing-history');
  assert.strictEqual(context.refreshReason({}, {
    ...current,
    lastAttemptAt: now - 30_000,
  }, { onlyMissing: true }, now), '');

  let active = 0;
  let peak = 0;
  const results = await context.runPool([1, 2, 3, 4, 5], 2, async (value) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return value * 2;
  });
  assert.deepStrictEqual(Array.from(results), [2, 4, 6, 8, 10]);
  assert.strictEqual(peak, 2);

  console.log('RESULT: Agenda refresh cache and worker-pool tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
