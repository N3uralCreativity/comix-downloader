'use strict';
/** Unit tests for the comix.to popup/ad policy. */
const A = require('../content/adblock-main.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error('FAIL:', name); }
}

const pageUrl = 'https://comix.to/title/example';
const popup = (overrides) => A.shouldAllowPopup(Object.assign({
  url: 'https://ads.example/landing',
  targetName: '_blank',
  pageUrl,
  clickHref: '',
  trusted: true,
  ageMs: 10
}, overrides || {}));

check('click-anywhere external popup is blocked', popup() === false);
check('untrusted popup is blocked', popup({ trusted: false }) === false);
check('stale click popup is blocked', popup({ ageMs: A.INTENT_MAX_AGE_MS + 1 }) === false);
check('explicit matching external link is allowed', popup({
  url: 'https://anilist.co/manga/123',
  clickHref: 'https://anilist.co/manga/123'
}) === true);
check('ad popup during a legitimate link click is blocked', popup({
  url: 'https://ads.example/landing',
  clickHref: 'https://anilist.co/manga/123'
}) === false);
check('comix social share popup is allowed', popup({
  url: 'https://www.reddit.com/submit?url=https%3A%2F%2Fcomix.to',
  targetName: 'share-window'
}) === true);
check('unknown site cannot borrow share-window allowance', popup({
  url: 'https://ads.example/landing',
  targetName: 'share-window'
}) === false);

const anchor = (overrides) => A.shouldBlockProgrammaticAnchor(Object.assign({
  href: 'https://ads.example/landing',
  targetName: '_blank',
  download: false,
  pageUrl,
  clickHref: '',
  trusted: true,
  ageMs: 10
}, overrides || {}));

check('scripted external anchor popup is blocked', anchor() === true);
check('matching deliberate anchor click is allowed', anchor({
  href: 'https://discord.gg/example',
  clickHref: 'https://discord.gg/example'
}) === false);
check('same-origin scripted anchor is allowed', anchor({ href: 'https://comix.to/browse' }) === false);
check('same-tab anchor is left to normal navigation', anchor({ targetName: '_self' }) === false);
check('download anchor is allowed', anchor({ download: true }) === false);

const overlay = (overrides) => A.isSuspiciousOverlay(Object.assign({
  href: 'https://ads.example/landing',
  pageUrl,
  rect: { width: 1200, height: 700 },
  viewport: { width: 1280, height: 720 },
  position: 'fixed',
  opacity: '0',
  zIndex: '2147483647',
  hasVisibleContent: false
}, overrides || {}));

check('transparent external viewport overlay is blocked', overlay() === true);
check('large empty high-z external overlay is blocked', overlay({ opacity: '1' }) === true);
check('visible external card is not treated as an overlay', overlay({
  rect: { width: 400, height: 240 },
  opacity: '1',
  zIndex: '20',
  hasVisibleContent: true
}) === false);
check('small external link is not treated as an overlay', overlay({
  rect: { width: 100, height: 40 }
}) === false);
check('same-origin overlay is not treated as an ad', overlay({ href: 'https://comix.to/browse' }) === false);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
