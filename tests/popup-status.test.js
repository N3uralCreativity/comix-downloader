'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const popup = require(path.join(root, 'popup', 'popup.js'));
const html = fs.readFileSync(path.join(root, 'popup', 'popup.html'), 'utf8');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');

assert.equal(popup.isSupportedTabUrl('https://comix.to/title/example'), true);
assert.equal(popup.isSupportedTabUrl('http://comix.to/'), true);
assert.equal(popup.isSupportedTabUrl('https://comix.ws/title/example'), true);
assert.equal(popup.isSupportedTabUrl('http://comix.ws/'), true);
assert.equal(popup.isSupportedTabUrl('https://cdn.comix.to/image.jpg'), false,
  'CDN subdomains do not run the extension content scripts');
assert.equal(popup.isSupportedTabUrl('https://cdn.comix.ws/image.jpg'), false,
  'new-domain CDN subdomains do not run the extension content scripts');
assert.equal(popup.isSupportedTabUrl('https://comix.to.example/title/example'), false);
assert.equal(popup.isSupportedTabUrl('https://comix.ws.example/title/example'), false);
assert.equal(popup.isSupportedTabUrl('about:addons'), false);
assert.equal(popup.isSupportedTabUrl(''), false);

assert.equal(
  popup.derivePopupActivityState('https://comix.to/title/example', { downloading: false }).key,
  'active'
);
assert.equal(
  popup.derivePopupActivityState('https://comix.ws/title/example', { downloading: false }).key,
  'active'
);
assert.equal(
  popup.comixSettingsUrlForTab('https://comix.ws/title/example'),
  'https://comix.ws/user?tab=settings'
);
assert.equal(
  popup.comixSettingsUrlForTab('https://example.com/'),
  'https://comix.to/user?tab=settings'
);
assert.equal(
  popup.derivePopupActivityState('https://example.com/', { downloading: false }).key,
  'inactive'
);
assert.equal(
  popup.derivePopupActivityState('https://example.com/', { downloading: true }).key,
  'downloading',
  'download activity must take precedence over current-tab support'
);

assert.match(html, /id="footer-status"[^>]*data-state="checking"/);
assert.match(html, /id="footer-status-label">Checking\.\.\.<\/span>/);
assert.match(html, /\.footer-status\[data-state="active"\]/);
assert.match(html, /\.footer-status\[data-state="downloading"\]/);
assert.match(background, /message\.action === 'getPopupActivity'/,
  'the popup must read live activity from the background context');
assert.match(background, /downloading: hasPopupDownloadActivity\(\)/,
  'the background response must include all tracked download work');

console.log('popup-status.test.js: all tests passed');
