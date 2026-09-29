'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const PlusUI = require('../core/plus-ui.js');
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

// The server code (plus-worker/) stays in the private repository. The public copy of this
// file skips the checks that read it.
const hasServer = fs.existsSync(path.join(root, 'plus-worker'));
function serverTest(name, fn) {
  if (hasServer) return test(name, fn);
  console.log(`SKIP ${name} (server code is private)`);
}
// Public releases carry three-part versions and use the production Plus service.
const PLUS_ORIGIN = /^\d+\.\d+\.\d+$/.test(JSON.parse(read('manifest.json')).version)
  ? 'https://plus.n3uralcreativity.top'
  : 'https://plus.n3uralcreativity.top';

test('manifest narrows the community Worker and keeps Plus optional', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(manifest.host_permissions.includes('https://comix-downloader-badge.comixdl.workers.dev/*'));
  assert.equal(manifest.host_permissions.some((entry) => entry === 'https://*.workers.dev/*'), false);
  assert.ok(manifest.optional_host_permissions.includes(`${PLUS_ORIGIN}/*`));
  assert.equal(manifest.host_permissions.includes(`${PLUS_ORIGIN}/*`), false);
});

test('Plus setup lives in settings; the popup only signs in and opens Plus pages', () => {
  const settings = read('core/settings.js');
  const standalone = read('legacy/options.js');
  const embedded = read('content/cdl-embed-settings.js');
  const popupHtml = read('popup/popup.html');
  const popupJs = read('popup/popup.js');
  assert.match(read('legacy/options.html'), /core\/plus-ui\.js/);
  assert.match(settings, /id:\s*'plus',\s*label:\s*'Comix Downloader Plus'/);
  assert.match(standalone, /tab\.id === 'plus'/);
  assert.match(standalone, /CDLPlusUI\.createSection\(\{ variant: 'standalone', dedicated: true, hideHeader: true \}\)/);
  assert.match(embedded, /PLUS_NAV_ID/);
  assert.match(embedded, /PLUS_VIEW_ID/);
  assert.match(embedded, /CDLPlusUI\.createSection\(\{ variant: 'embedded', send: send, dedicated: true, hideHeader: true \}\)/);
  // The popup stays unchanged for readers without Plus: the account icon and the
  // Plus row start hidden and only appear once the build reports a Plus state.
  assert.match(popupHtml, /id="btn-account"[^>]*\shidden>/);
  assert.match(popupHtml, /id="plus-row" hidden>/);
  assert.match(popupHtml, /id="account-panel"[^>]*\shidden>/);
  // Signing in happens in the popup; creating an account, checkout, and pricing do not.
  assert.match(popupJs, /intent: 'login'/);
  assert.match(popupJs, /requestDirectConsentIfPossible\(\)/);
  assert.doesNotMatch(popupJs, /plusCheckout|intent: 'create'|US\$|30 days free/);
  assert.doesNotMatch(read('content/content_title.js'), /Comix Downloader Plus|plusRequest|plusCheckout/i);
});

test('Plus requests optional access directly from the extension settings gesture', () => {
  const chromePayload = PlusUI.permissionPayloadForManifest({});
  assert.deepEqual(chromePayload, { origins: ['https://plus.n3uralcreativity.top/*'] });
  const firefoxPayload = PlusUI.permissionPayloadForManifest({
    browser_specific_settings: { gecko: { data_collection_permissions: { optional: [
      'personallyIdentifyingInfo', 'authenticationInfo', 'browsingActivity', 'websiteContent', 'technicalAndInteraction',
    ] } } },
  });
  assert.deepEqual(firefoxPayload.data_collection, [
    'personallyIdentifyingInfo', 'authenticationInfo', 'browsingActivity', 'websiteContent', 'technicalAndInteraction',
  ]);
  assert.doesNotMatch(read('core/plus-core.js'), /permissions\.request/);
  assert.match(read('core/plus-ui.js'), /Request immediately in the click handler/);
});

test('Firefox Cloud uploads require the websiteContent consent before any page is sent', () => {
  const background = read('background.js');
  const build = read('scripts/build-release.ps1');
  const validate = read('scripts/validate-release.ps1');
  const ui = read('core/plus-ui.js');
  assert.match(build, /"browsingActivity", "websiteContent", "technicalAndInteraction"/);
  assert.match(validate, /'browsingActivity', 'websiteContent', 'technicalAndInteraction'/);
  assert.match(background, /chrome\.permissions\.contains\(\{ data_collection: \['websiteContent'\] \}/);
  // The check runs in the Cloud pre-flight, before any chapter is fetched or uploaded.
  const preflight = background.indexOf('await ensureCloudUploadConsent();');
  assert.ok(preflight > 0 && preflight < background.indexOf('cdlPlusService.library.saveChapter('));
  assert.match(ui, /permissionCall\('request', payload\)/);
  assert.match(ui, /Allow Cloud uploads/);
  assert.doesNotMatch(ui, /Never leave this device/);
});

test('Plus offers separate account creation and sign-in paths', () => {
  const ui = read('core/plus-ui.js');
  const core = read('core/plus-core.js');
  assert.match(ui, /text: 'Create account'/);
  assert.match(ui, /text: 'Sign in'/);
  assert.match(ui, /plusVerifyCode[\s\S]*intent/);
  assert.match(core, /intent === 'login'/);
  assert.match(core, /intent:\s*intent === 'login' \? 'login' : 'create'/);
});

test('release builds include the shared Plus client in every browser package', () => {
  const build = read('scripts/build-release.ps1');
  const validate = read('scripts/validate-release.ps1');
  assert.match(build, /core\/plus-core\.js/);
  assert.match(build, /core\/plus-ui\.js/);
  assert.match(build, /data_collection_permissions/);
  assert.match(build, /required\s*=\s*@\("none"\)/);
  assert.match(validate, /personallyIdentifyingInfo/);
  assert.match(validate, /core\/plus-core\.js/);
});

serverTest('dedicated Plus Worker binds testing storage without committing credentials', () => {
  const config = read('plus-worker/wrangler.jsonc');
  assert.match(config, /comix-downloader-plus-api/);
  assert.match(config, /5055d971-79b6-4c55-8f1c-a4be910f5f10/);
  assert.match(config, /price_1U5SgDEfNahi50y975hsNfp8/);
  assert.match(config, /STRIPE_LIVE_MODE"\s*:\s*"false"/);
  assert.doesNotMatch(config, /AUTH_PEPPER|RESEND_API_KEY|STRIPE_SECRET_KEY\s*"\s*:/);
});

serverTest('the Worker hosts the account portal and keeps web sessions out of device limits', () => {
  const worker = read('plus-worker/worker.mjs');
  const portal = read('plus-worker/portal.mjs');
  const migration = read('plus-worker/migrations/0002_web_portal_sessions.sql');
  assert.match(worker, /path === '\/account'/);
  assert.match(worker, /cdl_plus_session/);
  assert.match(worker, /kind='extension'/);
  assert.match(worker, /INSERT INTO devices[\s\S]*Account portal[\s\S]*'web'/);
  assert.match(portal, /Create account/);
  assert.match(portal, /Sign in/);
  assert.match(portal, /Continue to checkout/);
  // The perk text rule must not reach the icon tiles, which are spans too.
  assert.doesNotMatch(portal, /\.perks span\{/);
  assert.match(portal, /\.perk-ico\{display:grid;place-items:center/);
  assert.match(migration, /kind TEXT NOT NULL DEFAULT 'extension'/);
});

serverTest('Plus Worker guards destructive actions and serializes snapshots atomically', () => {
  const worker = read('plus-worker/worker.mjs');
  assert.match(worker, /PLUS_DB\.batch\(statements\)/);
  assert.match(worker, /WHERE user_id=\? AND revision=\?/);
  assert.match(worker, /RECENT_VERIFICATION_REQUIRED/);
  assert.match(worker, /RESET_CONFIRMATION_REQUIRED/);
  assert.match(worker, /async function deleteCloudData[\s\S]*?requireApproved/);
  assert.match(worker, /async function deleteAccount[\s\S]*?requireApproved/);
  assert.match(worker, /provider_updated_at/);
  assert.match(read('plus-worker/migrations/0001_plus.sql'), /billing_provider/);
  assert.match(read('plus-worker/migrations/0001_plus.sql'), /provider_event_created/);
});

test('email sign-in alone unlocks a device, and cloud reset stays in Plus settings', () => {
  const core = read('core/plus-core.js');
  const ui = read('core/plus-ui.js');
  const popupSource = read('popup/popup.js');
  assert.match(core, /\/v1\/keys\/escrow/);
  assert.match(ui, /Sign in again with a code sent to your email/);
  assert.doesNotMatch(ui, /Save this recovery code|I saved the recovery code/);
  assert.doesNotMatch(popupSource, /recovery code/i);
  assert.match(ui, /Local extension data will remain/);
  assert.match(core, /confirmation: confirmation/);
  assert.match(core, /lastPayloadHash/);
});

test('public documentation states the free-mode and encryption boundaries', () => {
  const plus = read('docs/plus.html');
  const privacy = read('docs/privacy.html');
  const disclosures = read('docs/STORE_DISCLOSURES.md');
  const documentation = read('docs/Documentation.html');
  [plus, privacy, disclosures, documentation].forEach((source) => {
    assert.match(source, /optional/i);
    assert.match(source, /free/i);
  });
  assert.match(privacy, /No account or Plus API request is made unless you explicitly create an account, sign in, or start Plus setup/i);
  assert.match(privacy, /AES-256-GCM/);
  assert.match(disclosures, /No remote executable code/i);
});

test('Plus legal and deployment documents are complete and linked', () => {
  ['docs/plus.html', 'docs/privacy.html', 'docs/terms.html', 'docs/refund.html', 'docs/STORE_DISCLOSURES.md', 'plus-worker/README.md', 'tests/fixtures/plus-settings-preview.html'].filter((file) => hasServer || !file.startsWith('plus-worker/')).forEach((file) => {
    assert.equal(fs.existsSync(path.join(root, file)), true, file);
  });
  const index = read('docs/index.html');
  assert.match(index, /href="plus\.html"/);
  assert.match(read('docs/plus.html'), /href="terms\.html"/);
  assert.match(read('docs/plus.html'), /href="refund\.html"/);
});

test('Plus landing page uses real product captures and opens sign-up and sign-in', () => {
  const plus = read('docs/plus.html');
  ['plus-cloud-library.jpg', 'plus-cloud-folder.jpg', 'plus-cloud-reader.jpg', 'plus-cloud-phone.jpg',
    'plus-cloud-save.png', 'plus-agenda.jpg', 'plus-sync.png', 'plus-popup.png'].forEach((file) => {
    assert.equal(fs.existsSync(path.join(root, 'docs/assets', file)), true, file);
    assert.ok(plus.includes(`assets/${file}`), file);
  });
  // Every capture is described for screen readers.
  (plus.match(/<img\b[^>]*>/g) || []).forEach((tag) => assert.match(tag, /\balt="[^"]{8,}"/, tag));
  // The trial button's hover rolls its label to the reassurance line; screen readers keep the first.
  assert.match(plus, /account\?mode=create"><span class="roll"><span>Start 30-day free trial<\/span><span aria-hidden="true">Try it free. Stop anytime.<\/span><\/span><\/a>/);
  // The trial button wears the headline's "Read it anywhere & offline." colour; its hover shadow is the violet.
  const headline = /\.plus-hero h1 span \{[^}]*color: (#[0-9a-f]{6})/.exec(plus)[1];
  assert.match(plus, new RegExp(`\\.plus-hero-cta \\.btn-start \\{[^}]*background: ${headline}; color: #15171b;`));
  // Each state carries the glow and the panel shadow, so they animate apart and never blur together.
  assert.match(plus, /\.plus-hero-cta \.btn-start \{[^}]*box-shadow: 0 12px 30px rgba\(189,167,255,\.28\), 0 0 0 #8b5cf6;/);
  assert.match(plus, /\.btn-start:is\(:hover, :focus-visible\) \{[^}]*box-shadow: 0 12px 30px rgba\(189,167,255,0\), 6px 6px 0 #8b5cf6;/);
  // Sign in beside it and the focus ring use the same lilac.
  assert.match(plus, /\.plus-cta-signin:is\(:hover, :focus-visible\) \{ border-color: #bda7ff;/);
  assert.match(plus, /:is\(\.btn-start, \.plus-cta-signin\):focus-visible \{ outline: 2px solid #bda7ff;/);
  assert.match(plus, /prefers-reduced-motion: reduce\) \{\s*\.plus-hero-cta \.btn-start,/);
  assert.match(plus, /account\?mode=login"[^>]*>(?:<svg[\s\S]*?<\/svg>)?Sign in</);
  assert.match(plus, /Now available/);
  // site.css gives .btn-ghost a white fill, which reads as a blank button on this dark hero.
  assert.doesNotMatch(plus, /class="btn-ghost"/);
  assert.match(plus, /\.plus-cta-signin \{[^}]*background: transparent/);
  assert.doesNotMatch(plus, /Planned: 30 days free|not a commitment|nav-signin-soon">Soon/);
  assert.doesNotMatch(plus, /setup guide/i);
});

test('every site page signs in through the portal and describes the shared website sign-in', () => {
  ['index.html', 'Documentation.html', 'plus.html', 'privacy.html', 'terms.html', 'refund.html', 'welcome.html', 'changelog.html'].forEach((file) => {
    assert.match(read(`docs/${file}`), /class="nav-signin" href="https:\/\/[^"]+\/account\?mode=login"/, file);
  });
  const index = read('docs/index.html');
  const documentation = read('docs/Documentation.html');
  // The server holds each account key so an email code unlocks everything: never claim end-to-end.
  assert.doesNotMatch(index + documentation + read('docs/plus.html'), /end-to-end/i);
  assert.match(index, /account\?mode=create">Start free trial</);
  assert.match(documentation, /id="plus-sign-in">One sign-in for the website and the extension</);
  assert.match(documentation, /Signing out on either side signs both out/);
  assert.match(documentation, /assets\/plus-sync\.png/);
  assert.doesNotMatch(documentation, /plus-settings\.png|Grant access to the exact Plus API origin/);
  assert.match(read('docs/privacy.html'), /<dt>Shared sign-in<\/dt>/);
  assert.match(read('docs/STORE_DISCLOSURES.md'), /content\/plus-bridge\.js/);
  const library = read('cloud-library/library.js');
  // Open library tabs take the website sign-in one at a time, so none adds a second device.
  assert.match(library, /navigator\.locks\.request\("cdl-library-site-session", run\)/);
  // Without the site script, sign-out still revokes the website session before the library's.
  assert.match(library, /await webApi\("\/v1\/web\/logout", \{\}\)\.catch\(\(\) => \{\}\);\s*await call\("plusSignOut"\);/);
  assert.match(library, /error\?\.name === "OperationError"/);
  if (hasServer) assert.match(read('scripts/cloud-library-local.cjs'), /url\.pathname === "\/site-session\.js"/);
});

serverTest('sandbox checkout returns to the Worker and settings refresh after external billing', () => {
  const config = read('plus-worker/wrangler.jsonc');
  const worker = read('plus-worker/worker.mjs');
  const ui = read('core/plus-ui.js');
  assert.match(config, /BILLING_RETURN_URL/);
  assert.match(config, /\/v1\/billing\/return/);
  assert.match(worker, /handleBillingReturn/);
  assert.match(worker, /new URL\('\/account', url\.origin\)/);
  assert.match(worker, /account\.searchParams\.set\('checkout', mode\)/);
  assert.match(ui, /refreshAfterExternalTab/);
  assert.match(ui, /document\.addEventListener\('visibilitychange', onReturn\)/);
});

serverTest('lifecycle email scope is transactional and tracked once per account event', () => {
  const worker = read('plus-worker/worker.mjs');
  const privacy = read('docs/privacy.html');
  assert.match(worker, /sendTrackedServiceEmail/);
  assert.match(worker, /sendLifecycleEmailSafely\(env, user, 'trial_reminder'/);
  assert.match(worker, /sendLifecycleEmailSafely\(env, user, 'cloud_deletion_warning'/);
  assert.match(worker, /`new_device:\$\{deviceId\}`/);
  assert.match(privacy, /new-device security alerts/i);
  assert.match(privacy, /seven-day trial reminder/i);
  assert.doesNotMatch(worker, /newsletter|abandoned.cart/i);
});

console.log(`\nRESULT: ${passed} passed, 0 failed`);
