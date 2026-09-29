'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const background = read('background.js');
const content = read('content/content_agenda.js');
const ui = read('core/plus-ui.js');
const build = read('scripts/build-release.ps1');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

test('the Agenda script and its view helpers load on every comix page', () => {
  const entry = manifest.content_scripts.find((item) => Array.isArray(item.js) && item.js.includes('content/content_agenda.js'));
  assert.ok(entry);
  assert.deepStrictEqual(entry.js, ['core/cdl-agenda-view.js', 'content/content_agenda.js']);
  assert.deepStrictEqual(entry.matches, ['*://comix.to/*', '*://comix.ws/*']);
  assert.strictEqual(entry.run_at, 'document_idle');
  assert.strictEqual(entry.world, undefined, 'the Agenda runs in the isolated world');
});

test('the Agenda entry is a comix header link that sits before Settings', () => {
  assert.match(content, /querySelector\('\.topnav__right'\)/);
  assert.match(content, /querySelector\('\.settings'\)/);
  assert.match(content, /link\.className = 'icon-btn'/);
  assert.match(content, /link\.href = View\.PATH/);
  assert.match(content, /insertBefore\(entry, settings \|\| right\.firstChild\)/);
  assert.match(content, /setAttribute\('aria-current', 'page'\)/);
  assert.match(content, /MutationObserver\(scheduleEnsure\)/);
});

test('the Agenda fills a real comix page instead of opening an extension tab', () => {
  assert.doesNotMatch(content, /openAgendaPage|chrome-extension:|agenda\.html/);
  assert.match(content, /View\.isAgendaPath\(location\.pathname\)/);
  assert.match(content, /main:not\(/, 'comix\'s own not-found body is hidden');
  assert.match(content, /class: 'list-main cdl-agenda'/);
  [
    'section__header', 'section__title', 'section__kicker', 'section__controls',
    'card card--compact', 'card__poster-wrap', 'poster poster--md', 'card__body',
    'card__meta', 'card__ch', 'card__time', 'card__title',
    'btn btn--sm', 'btn--primary', 'btn--soft', 'grid-updates', 'panel cdl-agenda-panel',
  ].forEach((name) => assert.ok(content.includes(name), `uses comix's ${name}`));
  assert.match(content, /cdl:locationchange/);
  assert.match(content, /popstate/);
  assert.strictEqual(fs.existsSync(path.join(root, 'agenda')), false, 'the old standalone Agenda page is gone');
});

test('the background opens or focuses the comix Agenda tab', () => {
  assert.match(background, /message\.action === 'openAgendaPage'/);
  assert.match(background, /openOrFocusComixAgenda\(sender\.tab\?\.url \|\| message\.pageUrl \|\| ''\)/);
  assert.match(background, /function comixAgendaUrl\(value\)[\s\S]*?\/agenda`/);
  assert.match(background, /chrome\.tabs\.update\(existing\.id, \{ active: true \}\)/);
  assert.doesNotMatch(background, /agenda\/agenda\.html|openOrFocusExtensionPage/);
});

test('readers without Plus get guidance and Plus settings opens its own view', () => {
  assert.match(content, /AGENDA_\(PLUS_REQUIRED\|UNAVAILABLE\)/);
  assert.match(content, /Release Agenda is part of Comix Downloader Plus\./);
  assert.match(content, /action: 'cdlOpenComixSettings', pageUrl: location\.href, view: 'plus'/);
  assert.match(background, /cdlOpenExtSettingsView: view === 'plus' \? 'plus' : 'main'/);
  assert.match(read('content/cdl-embed-settings.js'), /if \(r\.cdlOpenExtSettingsView === 'plus'\) activatePlus\(true\)/);
  assert.doesNotMatch(ui, /agendaOnly/);
});

test('all browser packages include the Agenda scripts and no standalone page', () => {
  assert.match(build, /"content\/content_agenda\.js"/);
  assert.match(build, /"core\/cdl-agenda-view\.js"/);
  assert.doesNotMatch(build, /"agenda",/);
});

console.log(`\nRESULT: ${passed} passed, 0 failed`);
