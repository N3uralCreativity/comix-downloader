'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'legacy', 'options.css'), 'utf8');

assert.match(css, /html, body\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?overflow-x:\s*hidden;/,
  'standalone settings must not expand beyond the mobile viewport');
assert.match(css, /@media \(max-width:\s*720px\)[\s\S]*?\.sidebar\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?overflow-x:\s*auto;/,
  'the mobile settings navigation must scroll inside the viewport');
assert.match(css, /@media \(max-width:\s*720px\)[\s\S]*?\.nav-item\s*\{[\s\S]*?width:\s*auto;[\s\S]*?flex:\s*0 0 auto;/,
  'mobile navigation items must retain readable widths without stretching the page');
assert.match(css, /@media \(max-width:\s*720px\)[\s\S]*?\.content\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*100%;[\s\S]*?min-width:\s*0;/,
  'mobile settings content must remain constrained to the viewport');

console.log('options-responsive.test.js: all tests passed');
