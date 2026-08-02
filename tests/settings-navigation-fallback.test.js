'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'content', 'cdl-embed-settings.js'), 'utf8');
const popup = fs.readFileSync(path.join(root, 'popup', 'popup.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

function extractFunction(source, name) {
  const marker = source.indexOf(`function ${name}(`);
  if (marker === -1) throw new Error(`Missing function ${name}`);
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
    if (ch === '}' && --depth === 0) return source.slice(marker, i + 1);
  }
  throw new Error(`Unterminated function ${name}`);
}

const context = { Number, Date };
vm.createContext(context);
vm.runInContext(`
  const CDL_SETTINGS_NAVIGATION_TTL_MS = 90 * 1000;
  ${extractFunction(background, 'isFreshSettingsNavigationAttempt')}
  globalThis.isFresh = isFreshSettingsNavigationAttempt;
`, context);

assert.equal(context.isFresh({ tabId: 42, startedAt: 10_000 }, 42, 11_000), true,
  'the exact recently opened settings tab is tracked');
assert.equal(context.isFresh({ tabId: 42, startedAt: 10_000 }, 41, 11_000), false,
  'another comix.to tab must never inherit the warning');
assert.equal(context.isFresh({ tabId: 42, startedAt: 10_000 }, 42, 100_001), false,
  'expired navigation attempts are ignored');
assert.equal(context.isFresh({ tabId: 42, startedAt: 12_000 }, 42, 11_000), false,
  'future timestamps are rejected');
assert.equal(context.isFresh(null, 42, 11_000), false,
  'malformed navigation state is rejected');

assert.match(popup, /sendRuntimeMessage\(\{ action: 'cdlOpenComixSettings' \}\)/,
  'the popup must use the tracked settings-tab flow');
assert.match(background, /chrome\.tabs\.create\(\{ url: CDL_COMIX_SETTINGS_URL \}\)/,
  'the preferred destination must remain the native comix.to settings page');
assert.match(background, /\[CDL_SETTINGS_NAVIGATION_KEY\]: \{ tabId: id, startedAt \}/,
  'the attempt must be bound to the exact created tab');
assert.match(content, /send\(\{ action: 'cdlProbeSettingsNavigation' \}\)/,
  'the destination tab must ask whether it owns a tracked attempt');
assert.match(content, /if \(!onSettingsPage\(\)\) \{\s*showSettingsFallback\('redirected'\)/,
  'a redirect away from the settings route must trigger the warning');
assert.match(content, /fallbackDeadline = Date\.now\(\) \+ 10000/,
  'an unmounted in-site settings UI must time out instead of waiting forever');
assert.match(content, /Settings page unavailable/,
  'the fallback must clearly explain that the settings page failed');
assert.match(content, /Open extension settings/,
  'the fallback must provide an explicit standalone settings action');
assert.match(content, /openBtn\.addEventListener\('click',[\s\S]*cdlOpenStandaloneSettings/,
  'the standalone page may open only after the user clicks its button');
assert.match(background, /message\.action === 'cdlOpenStandaloneSettings'[\s\S]*openStandaloneSettingsPage\(\)/,
  'the user action must route to the packaged options page');
assert.ok(
  content.indexOf('finishSettingsNavigationAttempt();', content.indexOf('contentBox().appendChild(nextView);')) >
    content.indexOf('contentBox().appendChild(nextView);'),
  'a successful embedded settings mount must clear the tracked attempt');
assert.equal(manifest.options_ui.page, 'legacy/options.html',
  'the standalone fallback must remain a packaged extension page');
assert.equal(manifest.options_ui.open_in_tab, true,
  'the fallback settings UI must open in its own browser tab');

console.log('settings-navigation-fallback.test.js: all tests passed');
