'use strict';
/**
 * Integration tests (run: `node tests/integration.test.js`).
 *
 * settings.js is the single source of truth for configuration, but the runtime
 * code reads it with string keys (cfg['perf.batchSize'], CFG['frame.width'], …).
 * A typo there would silently fall back to a default instead of erroring, so we
 * assert every key referenced in the runtime code actually exists in DEFAULTS.
 * We also lock in the default naming templates so an untouched config keeps
 * producing v1.1.2-style filenames.
 */
const fs = require('fs');
const path = require('path');
const S = require('../settings.js');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const DEFAULT_KEYS = Object.keys(S.DEFAULTS);

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; } else { fail++; console.error('FAIL:', name); } }

// Collect every `<varName>['some.key']` reference in a source file.
function refsIn(src, varName) {
  const re = new RegExp(varName + "\\[['\"]([\\w.]+)['\"]\\]", 'g');
  const out = new Set(); let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return [...out];
}

// 1. background.js (service worker) settings keys
const bgKeys = refsIn(read('background.js'), 'cfg');
check('background.js reads a meaningful number of settings', bgKeys.length >= 15);
bgKeys.forEach((k) => check('background.js key exists in DEFAULTS: ' + k, DEFAULT_KEYS.indexOf(k) !== -1));

// 2. content_title.js (content script) settings keys
const ctKeys = refsIn(read('content_title.js'), 'CFG');
check('content_title.js reads a meaningful number of settings', ctKeys.length >= 9);
ctKeys.forEach((k) => check('content_title.js key exists in DEFAULTS: ' + k, DEFAULT_KEYS.indexOf(k) !== -1));

// 3. options.js dependency + preview maps must reference real keys
const opt = read('options.js');
function blockKeys(src, marker) {
  const i = src.indexOf(marker);
  if (i === -1) return [];
  const j = src.indexOf('};', i);
  const slice = src.slice(i, j === -1 ? undefined : j);
  const re = /['"]([a-z]+\.[a-zA-Z]+)['"]\s*:/g;
  const out = new Set(); let m;
  while ((m = re.exec(slice))) out.add(m[1]);
  return [...out];
}
const depKeys = blockKeys(opt, 'var DEPENDS');
const prevKeys = blockKeys(opt, 'var PREVIEW_CTX');
check('options.js DEPENDS map is present', depKeys.length > 0);
depKeys.forEach((k) => check('options.js DEPENDS key valid: ' + k, DEFAULT_KEYS.indexOf(k) !== -1));
prevKeys.forEach((k) => check('options.js PREVIEW_CTX key valid: ' + k, DEFAULT_KEYS.indexOf(k) !== -1));

// 4. Default naming templates reproduce v1.1.2-style names
check('default single-chapter ZIP name',
  S.renderName(S.DEFAULTS['naming.singleZipTpl'], { manga: 'solo-leveling', chapter: '12', num: '12' }, 196) === 'solo-leveling-Ch12');
check('default Download-All ZIP name',
  S.renderName(S.DEFAULTS['naming.allZipTpl'], { manga: 'solo-leveling' }, 196) === 'solo-leveling');
check('default chapter folder name (padded)',
  S.renderName(S.DEFAULTS['naming.chapterFolderFmt'], { num: '12', rest: '' }, 80) === 'Ch0012');
check('default chapter folder keeps decimal suffix',
  S.renderName(S.DEFAULTS['naming.chapterFolderFmt'], { num: '12', rest: '.5' }, 80) === 'Ch0012.5');

// 5. manifest wiring sanity
const mf = JSON.parse(read('manifest.json'));
check('manifest version is 2.x', /^2\./.test(mf.version));
check('settings.js loads before content_title.js', JSON.stringify(mf.content_scripts[0].js) === JSON.stringify(['settings.js', 'content_title.js']));
check('options_ui opens in a tab', mf.options_ui && mf.options_ui.page === 'options.html' && mf.options_ui.open_in_tab === true);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
