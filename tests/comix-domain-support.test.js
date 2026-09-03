'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const titleContent = fs.readFileSync(path.join(root, 'content', 'content_title.js'), 'utf8');

const helpersStart = background.indexOf('const CDL_COMIX_ORIGINS');
const helpersEnd = background.indexOf('const CDL_SETTINGS_NAVIGATION_KEY');
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart, 'Comix domain helpers must exist');

const context = { URL };
vm.createContext(context);
vm.runInContext(`
  ${background.slice(helpersStart, helpersEnd)}
  globalThis.api = {
    supportedComixOrigin,
    preferredComixOrigin,
    comixOriginCandidates,
    comixSettingsUrl,
  };
`, context);

const api = context.api;
assert.equal(api.supportedComixOrigin('https://comix.to/title/example'), 'https://comix.to');
assert.equal(api.supportedComixOrigin('https://comix.ws/title/example'), 'https://comix.ws');
assert.equal(api.supportedComixOrigin('http://comix.ws/title/example'), 'https://comix.ws');
assert.equal(api.supportedComixOrigin('https://cdn.comix.ws/image.jpg'), '');
assert.equal(api.supportedComixOrigin('https://comix.ws.example/title/example'), '');
assert.deepStrictEqual(
  Array.from(api.comixOriginCandidates('https://comix.ws/title/example')),
  ['https://comix.ws', 'https://comix.to']
);
assert.equal(
  api.comixSettingsUrl('https://comix.ws/title/example'),
  'https://comix.ws/user?tab=settings'
);
assert.equal(
  api.comixSettingsUrl('https://example.com/'),
  'https://comix.to/user?tab=settings'
);

assert.match(background, /fetchSeriesChapterPathsDirect\(slug, origin\)/,
  'subscription checks must try each supported origin');
assert.match(background, /fetchSeriesChapterPathsViaTab\(slug, origin\)/,
  'subscription tab fallback must retain the selected origin');
assert.match(background, /sourceOrigin: sourceOrigin \|\| CDL_DEFAULT_COMIX_ORIGIN/,
  'new subscriptions must remember their source domain');
assert.match(background, /preferredComixOrigin\(cdlSubscriptions\[slug\][\s\S]*sourceOrigin\)/,
  'subscription notifications must reopen the remembered domain');
assert.match(titleContent, /action: 'subscribe'[\s\S]*sourceUrl: location\.href/,
  'the title page must identify its source domain when subscribing');

console.log('comix-domain-support.test.js: all tests passed');
