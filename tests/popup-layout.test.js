'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const popup = require(path.join(root, 'popup', 'popup.js'));
const html = fs.readFileSync(path.join(root, 'popup', 'popup.html'), 'utf8');

const FIREFOX_ANDROID =
  'Mozilla/5.0 (Android 15; Mobile; rv:142.0) Gecko/142.0 Firefox/142.0';
const FIREFOX_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36';

assert.equal(popup.isFirefoxAndroid(FIREFOX_ANDROID), true,
  'Firefox Android must receive the full-overlay layout');
assert.equal(popup.isFirefoxAndroid(FIREFOX_DESKTOP), false,
  'desktop Firefox must retain the compact popup');
assert.equal(popup.isFirefoxAndroid(CHROME_ANDROID), false,
  'Android Chromium browsers must retain the existing popup layout');
assert.equal(popup.isFirefoxAndroid(''), false,
  'missing user-agent data must fail closed');

assert.match(html, /body\s*\{[\s\S]*?width:\s*340px;/,
  'the default desktop popup width must remain 340px');
assert.match(html, /html\.firefox-android body\s*\{[\s\S]*?width:\s*100vw;[\s\S]*?height:\s*100dvh;/,
  'Firefox Android must fill the overlay viewport');
assert.match(html, /html\.firefox-android \.logs-wrap\s*\{[\s\S]*?flex:\s*1 1 auto;/,
  'the mobile activity log must expand into remaining height');
assert.match(html, /env\(safe-area-inset-bottom, 0px\)/,
  'the mobile footer must respect the device safe area');

console.log('popup-layout.test.js: all tests passed');
