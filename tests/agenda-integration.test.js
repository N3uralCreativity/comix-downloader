'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const background = read('background.js');
const titleContent = read('content/content_title.js');
const ui = read('core/plus-ui.js');
const build = read('scripts/build-release.ps1');
const validate = read('scripts/validate-release.ps1');
const plusPage = read('docs/plus.html');
const privacyPage = read('docs/privacy.html');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test('every browser build loads the pure agenda engine before background', () => {
  assert.match(background, /importScripts\('core\/cdl-agenda-core\.js'\)/);
  assert.match(build, /"core\/cdl-agenda-core\.js"/);
  assert.match(build, /"core\/plus-core\.js",\s*"core\/cdl-agenda-core\.js",\s*"background\.js"/);
  assert.match(validate, /'core\/plus-core\.js', 'core\/cdl-agenda-core\.js', 'background\.js'/);
});

test('history backfill reads rendered comix rows with adaptive SPA pagination', () => {
  assert.match(background, /\.mchap-list \.mchap-item/);
  assert.match(background, /\.mchap-row__time/);
  assert.match(background, /button\.npager__nav\[aria-label="Next page"\]/);
  assert.match(background, /maxPages:\s*1,\s*maxRows: Math\.min\(40, requestedMaxRows\)/);
  assert.match(background, /agendaSnapshotHasEnoughHistory\(out\)/);
  assert.match(background, /maxPages:\s*3,\s*maxRows:\s*80,\s*adaptive:\s*true/);
  assert.doesNotMatch(background, /await sleep\(2500\)/);
  assert.match(background, /CDLAgendaCore\.extractChapterEvents\(\{ items: snapshot\.rows \}/);
  assert.match(background, /\.mpage__poster img/);
  assert.match(background, /meta\[property="og:image"\]/);
  assert.match(background, /coverUrl: readCoverUrl\(\)/);
});

test('subscriptions retain safe cover URLs and old entries request cover backfill', () => {
  assert.match(background, /subscribeSeries\(message\.slug, message\.mangaName, sourceUrl, message\.coverUrl, message\.agendaSnapshot\)/);
  assert.match(background, /function normalizeAgendaCoverUrl\(value\)/);
  assert.match(background, /parsed\.protocol !== 'https:' && parsed\.protocol !== 'http:'/);
  assert.match(background, /coverUrl: normalizeAgendaCoverUrl\(subscription\.coverUrl \|\| history\.coverUrl\)/);
  assert.match(background, /fetchSeriesCoverDirect\(slug, subscriptions\[slug\]\.sourceOrigin\)/);
  assert.match(background, /agendaRefreshReason\(/);
});

test('subscribing and later title visits capture the visible chapter history immediately', () => {
  assert.match(titleContent, /function collectAgendaTitleSnapshot\(\)/);
  assert.match(titleContent, /agendaSnapshot,\s*\n/);
  assert.match(titleContent, /action: 'agendaObserveTitle'/);
  assert.match(background, /message\.action === 'agendaObserveTitle'/);
  assert.match(background, /recordAgendaTitleSnapshot\(message\.slug/);
  assert.match(background, /requireSubscription: true/);
});

test('Agenda refresh reuses cache and limits hidden title work by platform', () => {
  assert.match(background, /CDL_AGENDA_HISTORY_STALE_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(background, /CDL_AGENDA_RETRY_COOLDOWN_MS = 15 \* 60 \* 1000/);
  assert.match(background, /const historyWorkerCount = mobile \? 1 : 2/);
  assert.match(background, /chrome\.tabs\.create\(\{ url: 'about:blank', active: false \}\)/);
  assert.match(background, /runAgendaPool\(historyTasks, historyWorkerCount/);
  assert.match(background, /expectedPageKind: 'title'/);
  assert.match(background, /cached: Math\.max\(0, allSlugs\.length - candidates\.length\)/);
});

test('normal subscription checks record new chapters as local first-seen evidence', () => {
  assert.match(background, /recordAgendaObservedChapters\(slug, entry\.mangaName, newOnes, entry\.lastCheck\)/);
  assert.match(background, /source: 'first-seen'/);
  assert.match(background, /precision: 'day'/);
  assert.match(background, /delete all\[slug\]/);
});

test('agenda messages are Plus-gated and expose read and refresh actions', () => {
  assert.match(background, /CDL_AGENDA_ACTIVE_STATES/);
  assert.match(background, /message\.action === 'agendaGet'/);
  assert.match(background, /message\.action === 'agendaRefresh'/);
  assert.match(background, /AGENDA_PLUS_REQUIRED/);
  assert.doesNotMatch(background, /message\.action === 'plusAgenda/);
});

test('the Agenda is one native comix page with honest estimate language', () => {
  const page = read('content/content_agenda.js');
  const view = read('core/cdl-agenda-view.js');
  // Plus settings keep an Agenda tab, but it opens the comix page instead of a second copy.
  assert.match(ui, /\{ id: 'agenda', label: 'Agenda' \}/);
  assert.match(ui, /action: 'openAgendaPage'/);
  assert.doesNotMatch(ui, /agendaOnly|cdl-plus-agenda-|agendaRefresh|agendaGet/);
  assert.match(page, /action: refresh \? 'agendaRefresh' : 'agendaGet'/);
  assert.match(page, /never an official release date/);
  assert.match(page, /Each estimate sits on its most likely day/);
  assert.match(view, /broad timing/);
  assert.match(page, /'Other weeks'/);
  assert.match(page, /'Not scheduled yet'/);
  assert.doesNotMatch(view + page, /Likely this week - day not yet precise/);
  assert.match(page, /Previous week/);
  assert.match(page, /Next week/);
  assert.match(page, /class: 'poster poster--md'/);
  assert.match(page, /loading: 'lazy'/);
  assert.match(page, /referrerpolicy: 'no-referrer'/);
  assert.match(page, /Refreshing missing or stale followed-series history/);
  assert.match(view, /parallel worker\(s\)/);
});

test('Plus website presents Agenda as available without claiming official dates', () => {
  assert.match(plusPage, /<span>Release Agenda<\/span><span class="none">Not available<\/span><span class="yes">Included<\/span>/);
  assert.match(plusPage, /never an official release date/);
  assert.doesNotMatch(plusPage, /release agenda is a planned Plus addition/);
});

test('privacy copy states Agenda evidence remains local and outside Plus sync', () => {
  assert.match(privacyPage, /followed-series chapter-age observations and inferred agenda state/);
  assert.match(privacyPage, /Agenda history are never sent to Plus/);
});

console.log(`\nRESULT: ${passed} passed, 0 failed`);
