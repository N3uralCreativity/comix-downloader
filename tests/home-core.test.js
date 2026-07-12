'use strict';
/**
 * Node unit tests for cdl-home-core.js (run: `node tests/home-core.test.js`).
 * Pure logic — no DOM, no chrome shim. Not shipped (build allowlist excludes tests/).
 *
 * Fixtures mirror the real captured comix Home markup: cards are `a.card[href="/title/…"]`
 * with `.card__poster-wrap img` (alt=title, srcset), `.card__title[title]`, `.card__ch`,
 * `.card__time`; sections are `section.section` with `h2.section__title`.
 */
const C = require('../core/cdl-home-core.js');
const S = require('../core/settings.js');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; } else { fail++; console.error('FAIL:', name); } }

// ── classifyHomeSection ──────────────────────────────────────────────────────
check('keep: New Chapters from Followed Comics', C.classifyHomeSection('New Chapters from Followed Comics') === 'keep');
check('keep: Reading History', C.classifyHomeSection('Reading History') === 'keep');
check('keep is case/space-insensitive', C.classifyHomeSection('  reading   HISTORY ') === 'keep');
check('keep tolerates a trailing badge', C.classifyHomeSection('Reading History 12') === 'keep');
check('remove: Most Recent Popular', C.classifyHomeSection('Most Recent Popular') === 'remove');
check('remove: Most Follows · New Comics', C.classifyHomeSection('Most Follows · New Comics') === 'remove');
check('remove: Latest Updates', C.classifyHomeSection('Latest Updates') === 'remove');
check('remove: User Collections', C.classifyHomeSection('User Collections') === 'remove');
check('remove: Announcements', C.classifyHomeSection('ANNOUNCEMENTS') === 'remove');
// "Recently Followed Comics" is NOT a native keep (we render it ourselves).
check('remove: Recently Followed Comics (we render it, not keep native)', C.classifyHomeSection('Recently Followed Comics') === 'remove');
check('unknown: empty heading', C.classifyHomeSection('') === 'unknown');
check('unknown: null heading (no throw)', C.classifyHomeSection(null) === 'unknown');

// ── parseFollowedTitles ──────────────────────────────────────────────────────
// Two real-shaped cards (one with rank slot), an absolute and a relative cover, an
// HTML entity in the title, plus a DUPLICATE slug that must be deduped, and a
// non-card anchor that must be ignored.
const HTML = `
<section class="section"><h2 class="section__title">Recently Followed Comics</h2>
<div class="swiper-wrapper">
  <div class="swiper-slide"><div class="card__rank-slot"><div class="card__rank">1</div>
    <a class="card" href="/title/dkgd8-my-favorite-character-wants-a-divorce">
      <div class="card__poster-wrap"><div class="poster poster--md">
        <img alt="My Favorite Character Wants a Divorce" loading="lazy"
             srcset="https://static.comix.to/18e0/i/0/d4/693828f973034@280.jpg 280w, https://static.comix.to/18e0/i/0/d4/693828f973034.jpg 600w"
             src="https://static.comix.to/18e0/i/0/d4/693828f973034@280.jpg"></div>
        <div class="card__menu"><button class="card__action card__action--menu" aria-label="Add to library"></button></div></div>
      <div class="card__body"><div class="card__meta"><span class="card__ch">Ch.43</span><span class="card__time">1d ago</span></div>
        <div class="card__title" title="My Favorite Character Wants a Divorce">My Favorite Character Wants a Divorce</div></div>
    </a></div></div>
  <div class="swiper-slide">
    <a href="/title/snow-leopard-baby?ref=home" class="card">
      <div class="card__poster-wrap"><div class="poster poster--md">
        <img alt="The Snow Leopard Baby &amp; the Black Leopard Family" src="/cdn/cover2.jpg"></div></div>
      <div class="card__body"><div class="card__meta"><span class="card__ch">Ch.72</span><span class="card__time">2h ago</span></div>
        <div class="card__title" title="The Snow Leopard Baby &amp; the Black Leopard Family">The Snow Leopard Baby …</div></div>
    </a></div>
  <div class="swiper-slide">
    <a class="card" href="/title/dkgd8-my-favorite-character-wants-a-divorce"><div class="card__title" title="dupe">dupe</div></a></div>
  <a class="nav-btn" href="/user">not a card</a>
</div></section>`;

const titles = C.parseFollowedTitles(HTML, 'https://comix.to/home');

check('parses both unique cards (dedupes repeated slug, ignores non-card anchor)', titles.length === 2);
check('keeps document order', titles[0].slug === 'dkgd8-my-favorite-character-wants-a-divorce' && titles[1].slug === 'snow-leopard-baby');
check('absolute cover preserved', titles[0].cover === 'https://static.comix.to/18e0/i/0/d4/693828f973034@280.jpg');
check('relative cover resolved against baseUrl', titles[1].cover === 'https://comix.to/cdn/cover2.jpg');
check('relative href resolved to absolute url', titles[1].url === 'https://comix.to/title/snow-leopard-baby?ref=home');
check('title from title-attr', titles[0].title === 'My Favorite Character Wants a Divorce');
check('title entity decoded', titles[1].title === 'The Snow Leopard Baby & the Black Leopard Family');
check('chapter + time parsed', titles[0].chapter === 'Ch.43' && titles[0].time === '1d ago');
check('second card chapter parsed', titles[1].chapter === 'Ch.72' && titles[1].time === '2h ago');

// Falls back to img alt when no card__title element is present.
const ALT_ONLY = `<a class="card" href="/title/foo-bar"><img alt="Foo &#39;Bar&#39;" src="/c.jpg"></a>`;
const altTitles = C.parseFollowedTitles(ALT_ONLY, 'https://comix.to/');
check('title falls back to img alt (entity decoded)', altTitles.length === 1 && altTitles[0].title === "Foo 'Bar'");

// Robustness: empty / garbage never throws.
check('empty html -> []', JSON.stringify(C.parseFollowedTitles('', 'https://comix.to/')) === '[]');
check('null html -> []', JSON.stringify(C.parseFollowedTitles(null)) === '[]');
check('no cards -> []', JSON.stringify(C.parseFollowedTitles('<div>nothing here</div>')) === '[]');

// ── parseMetaDescription (hover popup synopsis) ──────────────────────────────
check('og:description wins', C.parseMetaDescription(
  '<head><meta name="description" content="generic"><meta property="og:description" content="The real synopsis."></head>') === 'The real synopsis.');
check('falls back to meta description', C.parseMetaDescription(
  '<head><meta name="description" content="A &amp; B story"></head>') === 'A & B story');
check('no meta -> empty', C.parseMetaDescription('<head><title>x</title></head>') === '');
check('null html -> empty (no throw)', C.parseMetaDescription(null) === '');

// ── parseTitleMeta (hover genres/tags/badges) ────────────────────────────────
// Mirrors comix's real title-page flight data + meta.
const TITLE_HTML = `<head><meta property="og:description" content="A reincarnation tale &amp; more.">
</head><body><script>self.__next_f.push([1,"...\\"editUrl\\":\\"/user/manga/x/edit\\",
\\"genres\\":[{\\"id\\":11,\\"title\\":\\"Drama\\",\\"slug\\":\\"drama\\"},{\\"id\\":12,\\"title\\":\\"Fantasy\\",\\"slug\\":\\"fantasy\\"}],
\\"demographics\\":[{\\"id\\":1,\\"title\\":\\"Shoujo\\",\\"slug\\":\\"shoujo\\"}],\\"formats\\":[],
\\"tags\\":[{\\"id\\":98871,\\"title\\":\\"European Ambience\\",\\"slug\\":\\"european-ambience\\"},{\\"id\\":98872,\\"title\\":\\"Full Color\\",\\"slug\\":\\"full-color\\"}],
\\"type\\":\\"manhwa\\",\\"status\\":\\"releasing\\""])</script></body>`;
const meta = C.parseTitleMeta(TITLE_HTML.replace(/\\"/g, '"'));
check('parseTitleMeta description', meta.description === 'A reincarnation tale & more.');
check('parseTitleMeta genres', JSON.stringify(meta.genres) === JSON.stringify(['Drama', 'Fantasy']));
check('parseTitleMeta demographics', JSON.stringify(meta.demographics) === JSON.stringify(['Shoujo']));
check('parseTitleMeta tags', JSON.stringify(meta.tags) === JSON.stringify(['European Ambience', 'Full Color']));
check('parseTitleMeta type', meta.type === 'manhwa');
check('parseTitleMeta status', meta.status === 'releasing');
check('parseTitleMeta empty html (no throw)', JSON.stringify(C.parseTitleMeta('')) === JSON.stringify({ description: '', genres: [], demographics: [], tags: [], type: '', status: '' }));

// ── parseTitlesApi (comix /api/v1/user/* JSON → cards) — real field shape ─────
const apiJson = {
  status: 'ok',
  result: {
    items: [
      // following-titles item (sort=added_desc) — has bookmarkPivot.addedAtFormatted
      { id: 115867, hid: 'x5ekj', title: 'Saihokuryou no Kaibutsu', type: 'manga', status: 'releasing',
        altTitles: ['The Monster of the Northernmost Territory', '最北領の怪物'],
        poster: { medium: 'https://static.comix.to/a@280.jpg', large: 'https://static.comix.to/a.jpg' },
        latestChapter: 3.5, chapterUpdatedAtFormatted: '12h ago', updatedAtFormatted: '4h ago',
        synopsis: 'Rodney becomes a lord buried in debt.', ratedAvg: 9.5, contentRating: 'safe',
        url: '/title/x5ekj-saihokuryou', bookmarkPivot: { folderId: 5, addedAtFormatted: '6h ago', userChapter: 0 } },
      // Reading-History item — real shape: progress lives in readProgress.
      { id: 2, hid: 'dk250', title: 'Operation: Heartbeat', type: 'manhwa', status: 'releasing',
        poster: { medium: '/rel/cover.jpg' }, latestChapter: 32,
        readProgress: { current: 74, total: 74, percent: 100, chapter: 32, chapterUrl: '/title/dk250-op/10280290-chapter-32', readAtFormatted: '8h ago' } },
    ],
  },
};
const cards = C.parseTitlesApi(apiJson, 'https://comix.to/');
check('parseTitlesApi count', cards.length === 2);
check('parseTitlesApi prefers canonical url field', cards[0].url === 'https://comix.to/title/x5ekj-saihokuryou');
check('parseTitlesApi falls back to /title/{hid}', cards[1].url === 'https://comix.to/title/dk250');
check('parseTitlesApi title', cards[0].title === 'Saihokuryou no Kaibutsu');
check('parseTitlesApi absolute cover', cards[0].cover === 'https://static.comix.to/a@280.jpg');
check('parseTitlesApi relative cover resolved', cards[1].cover === 'https://comix.to/rel/cover.jpg');
check('parseTitlesApi decimal latestChapter', cards[0].latestChapter === 3.5);
check('parseTitlesApi synopsis', cards[0].synopsis === 'Rodney becomes a lord buried in debt.');
check('parseTitlesApi rating', cards[0].rating === 9.5);
check('parseTitlesApi altTitles', JSON.stringify(cards[0].altTitles) === JSON.stringify(['The Monster of the Northernmost Territory', '最北領の怪物']));
check('parseTitlesApi added time (bookmarkPivot)', cards[0].time.added === '6h ago');
check('parseTitlesApi chapterUpdated time', cards[0].time.chapterUpdated === '12h ago');
check('parseTitlesApi userChapter=0 → not started', cards[0].lastRead === null && cards[0].progress === null);
check('parseTitlesApi readProgress.percent → progress', cards[1].progress === 100);
check('parseTitlesApi readProgress.chapter → lastRead', cards[1].lastRead === 32);
check('parseTitlesApi readProgress.readAtFormatted → time.read', cards[1].time.read === '8h ago');
check('parseTitlesApi resumeUrl from readProgress.chapterUrl', cards[1].resumeUrl === 'https://comix.to/title/dk250-op/10280290-chapter-32');
check('parseTitlesApi type/status/contentRating', cards[0].type === 'manga' && cards[0].status === 'releasing' && cards[0].contentRating === 'safe');
check('parseTitlesApi empty/garbage (no throw)',
  JSON.stringify(C.parseTitlesApi(null)) === '[]' && JSON.stringify(C.parseTitlesApi({ result: {} })) === '[]');

// ── parseCollectionsApi (User Collections: landscape, list-of-comics cards) ───────
const collJson = {
  status: 'ok', result: { items: [
    { id: 30498, name: 'best bl i have ever read', description: 'x', isPublic: true, itemCount: 4, likeCount: 7,
      createdAtFormatted: '1d ago', updatedAtFormatted: '1m ago', owner: { id: 803898, hashId: 'em805e', username: 'motherpeach' },
      covers: ['https://static.comix.to/a@280.jpg', '/rel/b.jpg'] },
    { id: 31000, name: 'no covers list', itemCount: 1, likeCount: 0, owner: { displayName: 'Reader' } } // titles fallback empty
  ] }
};
const colls = C.parseCollectionsApi(collJson, 'https://comix.to/');
check('parseCollectionsApi count', colls.length === 2);
check('parseCollectionsApi name', colls[0].name === 'best bl i have ever read');
check('parseCollectionsApi owner from owner.username', colls[0].owner === 'motherpeach');
check('parseCollectionsApi owner from displayName', colls[1].owner === 'Reader');
check('parseCollectionsApi itemCount/likeCount', colls[0].itemCount === 4 && colls[0].likeCount === 7);
check('parseCollectionsApi url fallback to /collection/{id}', colls[0].url === 'https://comix.to/collection/30498');
check('parseCollectionsApi covers resolved (abs + rel)', colls[0].covers[0] === 'https://static.comix.to/a@280.jpg' && colls[0].covers[1] === 'https://comix.to/rel/b.jpg');
check('parseCollectionsApi no covers → empty array', Array.isArray(colls[1].covers) && colls[1].covers.length === 0);
check('parseCollectionsApi time prefers updated', colls[0].time === '1m ago');
check('parseCollectionsApi prefers explicit url field', C.parseCollectionsApi({ result: { items: [{ id: 5, name: 'n', url: '/collection/abc-5' }] } }, 'https://comix.to/')[0].url === 'https://comix.to/collection/abc-5');
check('parseCollectionsApi covers from contained items posters', C.parseCollectionsApi({ result: { items: [{ id: 9, name: 'n', items: [{ poster: { medium: '/p1.jpg' } }, { cover: 'https://static/p2.jpg' }] }] } }, 'https://comix.to/')[0].covers.length === 2);
check('parseCollectionsApi empty/garbage (no throw)', C.parseCollectionsApi(null).length === 0 && C.parseCollectionsApi({ result: {} }).length === 0);

// ── isCaughtUp / selectHero (hero skips already-read latest chapters) ─────────
check('isCaughtUp: read == latest', C.isCaughtUp({ latestChapter: 41, lastRead: 41 }) === true);
check('isCaughtUp: read > latest', C.isCaughtUp({ latestChapter: 41, lastRead: 42 }) === true);
check('isCaughtUp: unread newest', C.isCaughtUp({ latestChapter: 41, lastRead: 40 }) === false);
check('isCaughtUp: never read', C.isCaughtUp({ latestChapter: 41, lastRead: null }) === false);
check('isCaughtUp: unknown latest ⇒ false', C.isCaughtUp({ latestChapter: null, lastRead: 5 }) === false);
check('isCaughtUp: handles null/undefined', C.isCaughtUp(null) === false && C.isCaughtUp(undefined) === false);
check('isCaughtUp: decimal chapters', C.isCaughtUp({ latestChapter: 3.5, lastRead: 3.5 }) === true && C.isCaughtUp({ latestChapter: 3.5, lastRead: 3 }) === false);

// selectHero: prefer titles with an unread latest chapter, newest-first order preserved.
const heroPool = [
  { hid: 'a', latestChapter: 41, lastRead: 41 }, // caught up
  { hid: 'b', latestChapter: 50, lastRead: 48 }, // unread
  { hid: 'c', latestChapter: 12, lastRead: null }, // never read
  { hid: 'd', latestChapter: 9, lastRead: 9 },   // caught up
];
const picks = C.selectHero(heroPool, 2);
check('selectHero picks the two unread, in order', picks.length === 2 && picks[0].hid === 'b' && picks[1].hid === 'c');
check('selectHero skips caught-up titles', !picks.some(function (t) { return t.hid === 'a' || t.hid === 'd'; }));
// All read ⇒ fall back so the hero never collapses.
const allRead = [{ hid: 'a', latestChapter: 5, lastRead: 5 }, { hid: 'b', latestChapter: 7, lastRead: 7 }];
const fb = C.selectHero(allRead, 2);
check('selectHero falls back to caught-up when nothing is unread', fb.length === 2 && fb[0].hid === 'a' && fb[1].hid === 'b');
// One unread + one read ⇒ unread first, read fills the second slot.
const mixed = C.selectHero([{ hid: 'a', latestChapter: 5, lastRead: 5 }, { hid: 'b', latestChapter: 7, lastRead: 6 }], 2);
check('selectHero fills remaining slot with caught-up, unread first', mixed.length === 2 && mixed[0].hid === 'b' && mixed[1].hid === 'a');
check('selectHero empty/garbage (no throw)', C.selectHero([], 2).length === 0 && C.selectHero(null, 2).length === 0);

// ── parseUser (greeting: logged-in name vs login prompt) ─────────────────────────
const uIn = C.parseUser({ status: 'ok', result: { id: 147668, hashId: 'l0v2e', username: 'Yse3ra', displayName: 'Yse3ra', bio: 'x' } });
check('parseUser: logged in', uIn.loggedIn === true);
check('parseUser: prefers displayName', uIn.name === 'Yse3ra');
check('parseUser: prefers displayName over username', C.parseUser({ result: { username: 'u', displayName: 'Display Name' } }).name === 'Display Name');
check('parseUser: falls back to username', C.parseUser({ result: { id: 5, username: 'OnlyUser' } }).name === 'OnlyUser');
check('parseUser: top-level shape', C.parseUser({ username: 'Top', id: 9 }).loggedIn === true && C.parseUser({ username: 'Top', id: 9 }).name === 'Top');
check('parseUser: guest flag → logged out', C.parseUser({ result: { id: 1, username: 'guest', guest: true } }).loggedIn === false);
check('parseUser: guest username → logged out', C.parseUser({ result: { username: 'Guest' } }).loggedIn === false);
check('parseUser: null/empty → logged out', C.parseUser(null).loggedIn === false && C.parseUser({}).loggedIn === false && C.parseUser({ result: null }).loggedIn === false);
check('parseUser: logged-out has empty name', C.parseUser(null).name === '');

// ── section registry: defaultHomeSections / normalizeSections / resolveSections ───
const def = C.defaultHomeSections();
check('defaultHomeSections: all 9 known sections', def.length === 9);
check('defaultHomeSections: 3 personal rails on by default', def.filter(function (s) { return s.on; }).length === 3);
check('defaultHomeSections: the on ones are the 3 rails (feed off by default)',
  def.filter(function (s) { return s.on; }).map(function (s) { return s.id; }).join() === 'continue-reading,new-chapters,recently-followed');
check('defaultHomeSections: whats-new feed exists but is off', def.some(function (s) { return s.id === 'whats-new' && s.on === false; }));

// normalizeSections: drop unknown, dedupe, coerce on, append missing (off)
const norm = C.normalizeSections([
  { id: 'latest-updates', on: true },        // a global section turned on
  { id: 'continue-reading', on: false },     // a personal section turned off
  { id: 'continue-reading', on: true },      // duplicate → ignored
  { id: 'no-such-section', on: true },        // unknown → dropped
  'recently-followed'                         // bare string id → on:true
]);
check('normalizeSections: full known set, no dupes/unknowns', norm.length === 9);
check('normalizeSections: preserves stored order first', norm[0].id === 'latest-updates' && norm[1].id === 'continue-reading' && norm[2].id === 'recently-followed');
check('normalizeSections: coerces on (off honored)', norm[1].id === 'continue-reading' && norm[1].on === false);
check('normalizeSections: bare string id → on', norm[2].on === true);
check('normalizeSections: appends missing sections with their default on-state', (function () {
  var byId = {}; norm.forEach(function (s) { byId[s.id] = s; });
  // new-chapters (personal) missing → default on; most-recent-popular (global) missing → default off
  return byId['new-chapters'] && byId['new-chapters'].on === true && byId['most-recent-popular'].on === false;
})());
check('normalizeSections: garbage → all known, default on flags', (function () {
  var n = C.normalizeSections(null);
  return n.length === 9 && n.filter(function (s) { return s.on; }).length === 3;
})());

// sortFeed: unread (haven't read the latest) first, then read; order within each group preserved.
const feed = C.sortFeed([
  { hid: 'a', latestChapter: 10, lastRead: 10 }, // read
  { hid: 'b', latestChapter: 20, lastRead: 18 }, // unread
  { hid: 'c', latestChapter: 5, lastRead: null }, // unread (never read)
  { hid: 'd', latestChapter: 7, lastRead: 7 }    // read
]);
check('sortFeed: unread first then read', feed.map(function (t) { return t.hid; }).join() === 'b,c,a,d');
check('sortFeed: annotates unread flag', feed[0].unread === true && feed[0].hid === 'b' && feed[2].unread === false && feed[2].hid === 'a');
check('sortFeed: preserves order within groups', feed[0].hid === 'b' && feed[1].hid === 'c' && feed[2].hid === 'a' && feed[3].hid === 'd');
check('sortFeed: clones (does not mutate input)', (function () { var inp = [{ hid: 'x', latestChapter: 3, lastRead: 1 }]; var out = C.sortFeed(inp); return out[0] !== inp[0] && inp[0].unread === undefined; })());
check('sortFeed: empty/garbage (no throw)', C.sortFeed([]).length === 0 && C.sortFeed(null).length === 0);
check('whats-new is a feed-layout api section in the registry', (function () { var w = C.HOME_SECTIONS.filter(function (s) { return s.id === 'whats-new'; })[0]; return w && w.layout === 'feed' && w.source === 'api' && !w.defaultOn; })());

// resolveSections: only ON, ordered, with order index + registry fields. Use COMPLETE lists so
// there's no append-the-missing surprise (the settings UI always stores all known sections).
const resolved = C.resolveSections([
  { id: 'latest-updates', on: true },
  { id: 'continue-reading', on: false },
  { id: 'new-chapters', on: true },
  { id: 'recently-followed', on: false },
  { id: 'most-recent-popular', on: false },
  { id: 'most-follows-new', on: false },
  { id: 'user-collections', on: false }
]);
check('resolveSections: only enabled sections', resolved.length === 2);
check('resolveSections: order follows the list', resolved[0].id === 'latest-updates' && resolved[1].id === 'new-chapters');
check('resolveSections: assigns sequential order index', resolved[0].order === 0 && resolved[1].order === 1);
check('resolveSections: carries source + api for personal', resolved[1].source === 'api' && /following-titles/.test(resolved[1].api));
check('resolveSections: global section is dom source', resolved[0].source === 'dom');
check('resolveSections: empty when nothing on', C.resolveSections(
  C.defaultHomeSections().map(function (s) { return { id: s.id, on: false }; })).length === 0);

// matchNativeSection: heading text → registry id (dom sources only)
check('matchNativeSection: Most Recent Popular', C.matchNativeSection('Most Recent Popular') === 'most-recent-popular');
check('matchNativeSection: case/space-insensitive', C.matchNativeSection('  latest   UPDATES ') === 'latest-updates');
check('matchNativeSection: Most Follows · New Comics', C.matchNativeSection('Most Follows · New Comics') === 'most-follows-new');
// User Collections is API-sourced (not DOM-matched) → not returned by matchNativeSection
check('matchNativeSection: User Collections NOT dom-matched', C.matchNativeSection('User Collections') === null);
check('matchNativeSection: personal headings do NOT match (not dom)', C.matchNativeSection('Reading History') === null && C.matchNativeSection('New Chapters from Followed Comics') === null);
check('matchNativeSection: unknown → null', C.matchNativeSection('Top 10 Uploaders') === null && C.matchNativeSection('') === null);

// consistency: settings SCHEMA section ids === home-core registry ids (same contract)
check('SCHEMA home.sections ids match the registry ids', (function () {
  var reg = C.HOME_SECTIONS.map(function (s) { return s.id; }).sort().join();
  var sch = (S.SCHEMA['home.sections'].sections || []).map(function (s) { return s.id; }).sort().join();
  return reg === sch && reg.length > 0;
})());
check('DEFAULTS home.sections ids match the registry ids', (function () {
  var reg = C.HOME_SECTIONS.map(function (s) { return s.id; }).sort().join();
  var d = (S.DEFAULTS['home.sections'] || []).map(function (s) { return s.id; }).sort().join();
  return reg === d;
})());

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
