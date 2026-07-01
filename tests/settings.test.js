'use strict';
/**
 * Node unit tests for settings.js (run: `node tests/settings.test.js`).
 * Not shipped in the extension package (build-release.ps1 uses a file allowlist).
 */

// ── Minimal in-memory chrome.storage.local shim ──────────────────────────────
const store = {};
let listeners = [];
global.chrome = {
  storage: {
    local: {
      get(key) {
        if (key == null) return Promise.resolve(Object.assign({}, store));
        if (typeof key === 'string') return Promise.resolve(key in store ? { [key]: store[key] } : {});
        return Promise.resolve({});
      },
      set(obj) {
        const changes = {};
        for (const k in obj) { changes[k] = { oldValue: store[k], newValue: obj[k] }; store[k] = obj[k]; }
        listeners.forEach((l) => l(changes, 'local'));
        return Promise.resolve();
      }
    },
    onChanged: {
      addListener(fn) { listeners.push(fn); },
      removeListener(fn) { listeners = listeners.filter((x) => x !== fn); }
    }
  },
  runtime: {}
};

const S = require('../settings.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; } else { fail++; console.error('FAIL:', name); }
}

// 1. Defaults
check('validate({}) deep-equals DEFAULTS', JSON.stringify(S.validate({})) === JSON.stringify(S.DEFAULTS));

// 2. Numeric clamping / rounding
check('int clamp high', S.validate({ 'perf.batchSize': 999 })['perf.batchSize'] === 8);
check('int clamp low', S.validate({ 'perf.batchSize': -5 })['perf.batchSize'] === 1);
check('int round', S.validate({ 'download.chaptersPerPart': 3.7 })['download.chaptersPerPart'] === 4);
check('float clamp', S.validate({ 'advanced.jpgQuality': 2 })['advanced.jpgQuality'] === 1.0);
check('pagePollMs clamp high', S.validate({ 'perf.pagePollMs': 99999 })['perf.pagePollMs'] === 3000);
check('pagePollMs clamp low', S.validate({ 'perf.pagePollMs': 1 })['perf.pagePollMs'] === 50);
check('pageSettleMs clamp low', S.validate({ 'perf.pageSettleMs': -10 })['perf.pageSettleMs'] === 0);
check('scrollSettleMs default', S.validate({})['perf.scrollSettleMs'] === 800);
check('concurrentChapters default 2', S.validate({})['download.concurrentChapters'] === 2);
check('concurrentChapters clamp high', S.validate({ 'download.concurrentChapters': 99 })['download.concurrentChapters'] === 10);
check('concurrentChapters clamp low', S.validate({ 'download.concurrentChapters': 0 })['download.concurrentChapters'] === 1);
check('imageRetries default 1', S.validate({})['retry.imageRetries'] === 1);
check('chapterRetries default 1', S.validate({})['retry.chapterRetries'] === 1);

// 3. Enums / bools / colors
check('enum bad -> default', S.validate({ 'perf.rateLimitMode': 'nope' })['perf.rateLimitMode'] === 'dynamic');
check('enum good', S.validate({ 'perf.rateLimitMode': 'off' })['perf.rateLimitMode'] === 'off');
check('bool cast', S.validate({ 'appearance.disableAnim': 1 })['appearance.disableAnim'] === true);
check('color bad -> default', S.validate({ 'appearance.accentColor': 'red' })['appearance.accentColor'] === '#60a5fa');
check('color good', S.validate({ 'appearance.accentColor': '#abc' })['appearance.accentColor'] === '#abc');

// 4. Merge drops unknown, keeps known
const merged = S.validate({ 'unknown.key': 5, 'perf.batchSize': 4 });
check('drops unknown key', !('unknown.key' in merged));
check('keeps known key', merged['perf.batchSize'] === 4);

// 5. Templates / names
check('renderTemplate tokens', S.renderTemplate('{manga}-Ch{chapter}', { manga: 'Solo', chapter: '12' }) === 'Solo-Ch12');
check('renderTemplate unknown literal', S.renderTemplate('{foo}', {}) === '{foo}');
check('templateContext pads', S.templateContext({ num: 7 }).num4 === '0007');
check('renderName basic', S.renderName('Ch{num4}', { num: 3 }) === 'Ch0003');
check('renderName sanitizes', S.renderName('{manga}', { manga: 'a/b:c*?' }) === 'a_b_c__');
check('renderName maxLen', S.renderName('{manga}', { manga: 'x'.repeat(100) }, 60).length === 60);
check('string maxLen', S.validate({ 'appearance.allLabel': 'y'.repeat(100) })['appearance.allLabel'].length === 40);

// 5b. Home personalization keys
check('home.* keys all exist in DEFAULTS', [
  'home.customLayout', 'home.sections', 'home.hero', 'home.heroSource', 'home.heroSkipRead',
  'home.cardStyle', 'home.rows', 'home.density', 'home.showProgress', 'home.itemsPerSection',
  'home.openInNewTab', 'home.greeting', 'home.hoverPreview'
].every(function (k) { return k in S.DEFAULTS; }));

// enums fall back to their defaults on garbage, accept valid values
check('home.hero default two', S.validate({})['home.hero'] === 'two');
check('home.hero bad -> default', S.validate({ 'home.hero': 'nope' })['home.hero'] === 'two');
check('home.hero good', S.validate({ 'home.hero': 'off' })['home.hero'] === 'off');
check('home.heroSource good', S.validate({ 'home.heroSource': 'continue-reading' })['home.heroSource'] === 'continue-reading');
check('home.heroSource bad -> default', S.validate({ 'home.heroSource': 'x' })['home.heroSource'] === 'new-chapters');
check('home.cardStyle good', S.validate({ 'home.cardStyle': 'classic' })['home.cardStyle'] === 'classic');
check('home.cardStyle bad -> default', S.validate({ 'home.cardStyle': 'x' })['home.cardStyle'] === 'overlay');
check('home.density bad -> default', S.validate({ 'home.density': 'x' })['home.density'] === 'comfortable');
// ints clamp to their bounds
check('home.rows clamp high', S.validate({ 'home.rows': 9 })['home.rows'] === 3);
check('home.rows clamp low', S.validate({ 'home.rows': 0 })['home.rows'] === 1);
check('home.itemsPerSection clamp high', S.validate({ 'home.itemsPerSection': 999 })['home.itemsPerSection'] === 40);
check('home.itemsPerSection clamp low', S.validate({ 'home.itemsPerSection': 1 })['home.itemsPerSection'] === 6);
// bools cast
check('home.showProgress bool cast', S.validate({ 'home.showProgress': 0 })['home.showProgress'] === false);
check('home.openInNewTab bool cast', S.validate({ 'home.openInNewTab': 1 })['home.openInNewTab'] === true);

// 5b-profile. The tenure badge is built-in / always-on — intentionally NOT a setting.
check('profile.badge is NOT a setting (mandatory feature)', !('profile.badge' in S.DEFAULTS) && !S.SCHEMA['profile.badge']);
check('features.flagBrokenPages default false + in DEFAULTS', S.validate({})['features.flagBrokenPages'] === false && ('features.flagBrokenPages' in S.DEFAULTS));
check('features.crowdFlags is NOT a setting (mandatory feature)', !('features.crowdFlags' in S.DEFAULTS) && !S.SCHEMA['features.crowdFlags']);

// 5c. home.sections (sectionList) normalization
const SECT = (v) => S.validate({ 'home.sections': v })['home.sections'];
check('home.sections default has 8 entries', SECT(undefined).length === 8);
check('home.sections includes the whats-new feed (off by default)', SECT(undefined).some(function (s) { return s.id === 'whats-new' && s.on === false; }));
check('home.sections drops unknown + dedupes + keeps known set', (function () {
  var v = SECT([{ id: 'latest-updates', on: true }, { id: 'latest-updates', on: false }, { id: 'bogus', on: true }]);
  var ids = v.map(function (s) { return s.id; });
  return v.length === 8 && ids.filter(function (i) { return i === 'latest-updates'; }).length === 1 && ids.indexOf('bogus') === -1;
})());
check('home.sections preserves stored order, appends missing', (function () {
  var v = SECT([{ id: 'user-collections', on: true }, { id: 'new-chapters', on: false }]);
  return v[0].id === 'user-collections' && v[1].id === 'new-chapters';
})());
check('home.sections coerces on to boolean', (function () {
  var v = SECT([{ id: 'continue-reading', on: 1 }, { id: 'new-chapters', on: 0 }]);
  var byId = {}; v.forEach(function (s) { byId[s.id] = s.on; });
  return byId['continue-reading'] === true && byId['new-chapters'] === false;
})());
check('home.sections garbage -> default selection', (function () {
  var v = SECT('not an array');
  return v.length === 8 && v.filter(function (s) { return s.on; }).length === 3;
})());

// 6. Async API + onChange broadcast + export/import
(async () => {
  let changes = 0;
  const off = S.onChange(() => { changes++; });

  await S.saveSettings({ 'perf.batchSize': 6 });
  let got = await S.getSettings();
  check('save/get roundtrip', got['perf.batchSize'] === 6);

  await S.patchSettings({ 'frame.width': 420 });
  got = await S.getSettings();
  check('patch preserves other keys', got['perf.batchSize'] === 6 && got['frame.width'] === 420);

  await S.resetDefaults();
  got = await S.getSettings();
  check('resetDefaults', got['perf.batchSize'] === 3 && got['frame.width'] === 380);
  check('onChange fired', changes >= 3);
  off();

  await S.saveSettings({ 'naming.imagePadDigits': 4, 'download.splitMode': 'single' });
  const json = await S.exportJSON();
  await S.resetDefaults();
  await S.importJSON(json);
  got = await S.getSettings();
  check('export/import roundtrip', got['naming.imagePadDigits'] === 4 && got['download.splitMode'] === 'single');

  let rejected = false;
  try { await S.importJSON('not json'); } catch (e) { rejected = true; }
  check('import rejects bad json', rejected);

  // Schema/tab integrity
  const allTabKeys = S.TABS.reduce((a, t) => a.concat(t.keys), []);
  check('every DEFAULT has a SCHEMA entry', Object.keys(S.DEFAULTS).every((k) => S.SCHEMA[k]));
  check('every DEFAULT appears in a TAB', Object.keys(S.DEFAULTS).every((k) => allTabKeys.indexOf(k) !== -1));
  check('no stray TAB keys', allTabKeys.every((k) => S.DEFAULTS[k] !== undefined));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
