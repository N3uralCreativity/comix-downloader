'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const popup = require(path.join(root, 'popup', 'popup.js'));
const html = fs.readFileSync(path.join(root, 'popup', 'popup.html'), 'utf8');

function view(account, extra = {}) {
  return {
    ok: true,
    signedIn: !!account,
    encryptionReady: true,
    state: { account: account || null },
    ...extra,
  };
}
const ready = { email: 'reader@example.test', state: 'trial', device: { approved: true }, encryptionInitialized: true };

// Builds without Plus, or a background that does not answer, keep the popup unchanged.
assert.equal(popup.derivePlusAccountState(null).key, 'unavailable');
assert.equal(popup.derivePlusAccountState({ ok: false, error: { code: 'PLUS_UNAVAILABLE' } }).key, 'unavailable');
assert.equal(popup.derivePlusAccountState(view(null)).key, 'signed-out');

assert.deepEqual(popup.derivePlusAccountState(view(ready)),
  { key: 'ready', email: 'reader@example.test', label: 'Plus trial' });
assert.equal(popup.derivePlusAccountState(view({ ...ready, state: 'cancelled_active' })).label, 'Plus, renewal off');

// Each unfinished step points to Plus settings, in the same order settings uses.
const setup = (account, extra) => popup.derivePlusAccountState(view(account, extra));
assert.match(setup({ ...ready, device: { approved: false } }).message, /Sign in again/);
assert.match(setup({ ...ready, state: 'pending_checkout' }).message, /checkout/);
assert.match(setup(ready, { encryptionReady: false }).message, /still unlocking/);
assert.match(setup({ ...ready, encryptionInitialized: false }, { encryptionReady: false }).message, /finish setting up encryption/);
assert.equal(setup({ ...ready, state: 'expired' }).key, 'expired');
assert.equal(setup({ ...ready, device: { approved: false } }).key, 'setup');

// A started sign-in resumes where the reader left it, for ten minutes.
const now = Date.parse('2026-09-23T20:00:00Z');
const ttl = popup.PLUS_LOGIN_TTL_MS;
assert.equal(ttl, 10 * 60 * 1000);
assert.equal(popup.pendingLoginStep(null, now), null);
assert.equal(popup.pendingLoginStep({ email: '', updatedAt: now }, now), null);
assert.equal(popup.pendingLoginStep({ email: 'a@b.co', codeSentAt: null, updatedAt: now - 1000 }, now), 'email');
assert.equal(popup.pendingLoginStep({ email: 'a@b.co', codeSentAt: now - 60000, updatedAt: now - 60000 }, now), 'code');
assert.equal(popup.pendingLoginStep({ email: 'a@b.co', codeSentAt: now - ttl, updatedAt: now - 1000 }, now), 'email',
  'an expired code falls back to the email step');
assert.equal(popup.pendingLoginStep({ email: 'a@b.co', codeSentAt: now, updatedAt: now - ttl }, now), null,
  'an abandoned sign-in is forgotten');
assert.equal(popup.pendingLoginStep({ email: 'a@b.co', codeSentAt: now, updatedAt: now + 5000 }, now), null,
  'a record from the future is ignored');
// Records the popup keeps in memory must resolve exactly like the stored copy.
assert.equal(popup.pendingLoginStep(popup.pendingLoginRecord('a@b.co', Date.now())), 'code');
assert.equal(popup.pendingLoginStep(popup.pendingLoginRecord('a@b.co', null)), 'email');

// Markup: one quiet icon at the end of the Settings/GitHub row (the header keeps
// its layout), hidden until the Plus state is known, plus a hidden shortcut row.
assert.match(html, /<button class="btn btn-ghost btn-account" id="btn-account"[^>]*aria-controls="account-panel"[^>]*hidden>/);
assert.ok(html.indexOf('id="btn-account"') > html.indexOf('id="btn-github"'), 'the account icon follows GitHub');
assert.ok(html.indexOf('id="account-panel"') > html.indexOf('id="btn-account"'), 'the account panel opens below its button');
assert.match(html, /<section class="account-panel" id="account-panel"[^>]*hidden><\/section>/);
assert.match(html, /id="btn-cloud-library"/);
assert.match(html, /id="btn-agenda"/);
assert.ok(html.indexOf('<script src="../core/plus-ui.js"></script>') !== -1 &&
  html.indexOf('<script src="../core/plus-ui.js"></script>') < html.indexOf('<script src="popup.js"></script>'),
  'the shared consent helper loads before the popup script');

console.log('popup-account.test.js: all tests passed');
