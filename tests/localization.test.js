'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const expectedLocales = ['en', 'es', 'fr', 'id', 'ja', 'pt_BR', 'th', 'vi'];
const requiredMessages = [
  'extensionName',
  'extensionDescription',
  'reviewPromptTitle',
  'reviewPromptMessage',
  'reviewPromptAction',
  'reviewPromptDismiss',
  'updateAvailableTitle',
  'updateAvailableMessage',
  'updateAvailableAction',
  'updateInstalling',
  'updateBusy',
  'updateFailed',
  'updateToolbarTitle',
  'updateCheckAction',
  'updateChecking',
  'updateUpToDate',
  'updateCheckThrottled',
  'updateCheckUnsupported',
  'updateCheckFailed',
  'updateAvailableShort',
];

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.strictEqual(manifest.default_locale, 'en');
assert.strictEqual(manifest.name, '__MSG_extensionName__');
assert.strictEqual(manifest.description, '__MSG_extensionDescription__');

const localesDir = path.join(root, '_locales');
const actualLocales = fs.readdirSync(localesDir)
  .filter((entry) => fs.statSync(path.join(localesDir, entry)).isDirectory())
  .sort();
assert.deepStrictEqual(actualLocales, expectedLocales);

for (const locale of expectedLocales) {
  const messagesPath = path.join(localesDir, locale, 'messages.json');
  const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
  for (const name of requiredMessages) {
    assert.ok(messages[name], `${locale} is missing ${name}`);
    assert.ok(messages[name].message.trim(), `${locale}.${name} is empty`);
  }
  const descriptionLength = [...messages.extensionDescription.message].length;
  assert.ok(
    descriptionLength <= 132,
    `${locale} extensionDescription is ${descriptionLength} characters (maximum 132)`
  );
  const reviewCopy = [
    messages.reviewPromptTitle.message,
    messages.reviewPromptMessage.message,
    messages.reviewPromptAction.message,
  ].join(' ').toLowerCase();
  assert.ok(!/(five|5)[ -]?stars?/.test(reviewCopy), `${locale} asks for a five-star review`);
}

assert.ok(
  fs.existsSync(path.join(root, 'store-listing', 'README.md')),
  'store-listing/README.md is missing'
);

console.log(`localization.test.js: ${expectedLocales.length} locales validated`);
