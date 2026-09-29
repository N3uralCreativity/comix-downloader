'use strict';

// Launch readiness: the Plus member limit and waiting list, branded emails, the Cloud
// Library outside the private test, and the testing/production service switch.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
// The server code (plus-worker/) stays in the private repository; the public copy of this
// file runs only the extension checks.
const hasServer = fs.existsSync(path.join(root, 'plus-worker'));
const { fixture } = hasServer ? require('./helpers/cloud-fixture.cjs') : {};

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}
async function serverTest(name, fn) {
  if (hasServer) return test(name, fn);
  console.log(`SKIP ${name} (server code is private)`);
}

async function runHourly(f) {
  const jobs = [];
  await f.worker.default.scheduled({ cron: '15 * * * *' }, f.env, { waitUntil: (job) => jobs.push(job) });
  await Promise.all(jobs);
}

(async () => {
  await serverTest('a full Plus stops checkout before payment, lists the person and alerts the developer once', async () => {
    const emails = [];
    const f = await fixture({
      PLUS_MEMBER_LIMIT: '1',
      ADMIN_EMAIL: 'dev@example.test',
      SERVICE_ORIGIN: 'https://plus.example.test',
      TEST_EMAIL_SINK: async (payload) => { emails.push(payload); },
      ENVIRONMENT: 'test',
    });
    const db = f.env.PLUS_DB.db;
    // user1 holds the only place; user0 has an account but no Plus yet.
    db.prepare("UPDATE entitlements SET state='pending_checkout' WHERE user_id='user0'").run();
    const stripeCalls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => { stripeCalls.push(String(url)); throw new Error('Stripe must not be called'); };
    try {
      await assert.rejects(() => f.request('user0')('/v1/billing/checkout', { method: 'POST' }), (error) => {
        assert.equal(error.code, 'PLUS_CAPACITY_REACHED');
        assert.equal(error.status, 409);
        assert.match(error.message, /Plus is full for the moment/);
        assert.match(error.message, /Nothing has been charged/);
        assert.doesNotMatch(error.message, /\d/, 'the message never reveals numbers');
        return true;
      });
      await assert.rejects(() => f.request('user0')('/v1/billing/checkout', { method: 'POST' }), (error) => error.code === 'PLUS_CAPACITY_REACHED');
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(stripeCalls, [], 'nobody reaches the payment page while Plus is full');
    const listed = db.prepare("SELECT user_id, notified_at FROM plus_waitlist").all();
    assert.deepEqual(listed.map((row) => row.user_id), ['user0']);
    const alerts = emails.filter((mail) => mail.to[0] === 'dev@example.test');
    assert.equal(alerts.length, 1, 'the developer is told once, not on every attempt');
    assert.match(alerts[0].subject, /Plus is full/);
    assert.match(alerts[0].text, /PLUS_MEMBER_LIMIT/);
    assert.match(alerts[0].html, /Waiting now/);

    // Nobody is emailed while Plus is still full.
    await runHourly(f);
    assert.equal(emails.filter((mail) => mail.to[0] === 'reader@example.test').length, 0);

    // Raising the limit lets the hourly job invite the oldest person on the list.
    f.env.PLUS_MEMBER_LIMIT = '5';
    await runHourly(f);
    const invites = emails.filter((mail) => mail.to[0] === 'reader@example.test');
    assert.equal(invites.length, 1);
    assert.match(invites[0].subject, /A place in Comix Downloader Plus is open/);
    assert.match(invites[0].html, /https:\/\/plus\.example\.test\/account\?mode=login/);
    assert.ok(db.prepare("SELECT notified_at FROM plus_waitlist WHERE user_id='user0'").get().notified_at);
    await runHourly(f);
    assert.equal(emails.filter((mail) => mail.to[0] === 'reader@example.test').length, 1, 'each person is invited once');
    db.close();
  });

  await serverTest('without a member limit, checkout is never held back', async () => {
    const f = await fixture({
      ENVIRONMENT: 'test',
      BILLING_RETURN_URL: 'https://plus.example.test/v1/billing/return',
      STRIPE_SECRET_KEY: 'sk_test_fixture',
      STRIPE_PRICE_ID: 'price_fixture',
    });
    f.env.PLUS_DB.db.prepare("UPDATE entitlements SET state='pending_checkout' WHERE user_id='user0'").run();
    const realFetch = globalThis.fetch;
    let reachedStripe = false;
    globalThis.fetch = async () => { reachedStripe = true; throw new Error('stop at Stripe'); };
    try {
      await assert.rejects(() => f.request('user0')('/v1/billing/checkout', { method: 'POST' }), (error) => error.code !== 'PLUS_CAPACITY_REACHED');
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(reachedStripe, true);
    f.env.PLUS_DB.db.close();
  });

  await serverTest('service emails are branded HTML with a plain-text twin and escape what readers typed', async () => {
    const { renderEmail } = await import(pathToFileURL(path.join(root, 'plus-worker/emails.mjs')).href);
    const mail = renderEmail({
      origin: 'https://plus.example.test/',
      title: 'A new device signed in',
      preheader: 'Preview line',
      intro: ['Hello ', { strong: 'reader' }, '.'],
      code: '246810',
      details: [['Device', '<script>alert(1)</script>']],
      button: { label: 'Review your devices', url: 'https://plus.example.test/account' },
      note: 'Closing note.',
      reason: 'Why you got this.',
      privacyUrl: 'https://example.test/privacy.html',
      supportEmail: 'help@example.test',
    });
    assert.match(mail.html, /<img src="https:\/\/plus\.example\.test\/icons\/icon128\.png"/);
    assert.match(mail.html, /role="presentation"/);
    assert.match(mail.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(mail.html, /<script>/);
    assert.match(mail.html, /246810/);
    assert.match(mail.text, /246810/);
    assert.match(mail.text, /Review your devices: https:\/\/plus\.example\.test\/account/);
    assert.match(mail.text, /Questions\? Write to help@example\.test\./);

    const worker = read('plus-worker/worker.mjs');
    ['Your sign-in code', 'A new device signed in', 'Your free trial ends in 7 days', 'Your cloud data will be deleted soon', 'A place in Plus is open', 'Plus is full']
      .forEach((title) => assert.ok(worker.includes(`title: '${title}'`), title));
    assert.match(worker, /reply_to: String\(env\.SUPPORT_EMAIL\)/);
  });

  await serverTest('the sign-in code email carries the code in both versions', async () => {
    const emails = [];
    const f = await fixture({ ENVIRONMENT: 'test', AUTH_PEPPER: 'pepper', TEST_VERIFICATION_CODE: '135790', TEST_EMAIL_SINK: async (payload) => { emails.push(payload); } });
    await f.fetch('http://localhost/v1/auth/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'new-reader@example.test' }) });
    const mail = emails.find((item) => /verification code/i.test(item.subject));
    assert.ok(mail, 'a code email was sent');
    assert.match(mail.text, /135790/);
    assert.match(mail.html, /135790/);
    f.env.PLUS_DB.db.close();
  });

  await serverTest('the Cloud Library opens to every Plus member when no invite list is set', async () => {
    const f = await fixture({ ENVIRONMENT: 'production', LIBRARY_TEST_EMAILS: '' });
    const listing = await f.request('user0')('/v1/library');
    assert.ok(Array.isArray(listing.nodes));
    f.env.LIBRARY_TEST_EMAILS = 'someone-else@example.test';
    await assert.rejects(() => f.request('user0')('/v1/library'), (error) => error.code === 'LIBRARY_INVITE_REQUIRED');
    f.env.PLUS_DB.db.close();
  });

  await serverTest('launch copy no longer mentions the private test', async () => {
    const shipped = ['plus-worker/cloud-library.mjs', 'core/cloud-library.js', 'core/plus-core.js', 'cloud-library/library.js'].map(read).join('\n');
    // Only quoted text reaches readers; code comments may still describe the test builds.
    assert.doesNotMatch(shipped, /["'`][^"'`\n]*(private test|testing Worker|Private testing limits)[^"'`\n]*["'`]/i);
    const library = read('plus-worker/cloud-library.mjs');
    assert.match(library, /allowed\.length && !allowed\.includes/);
    assert.doesNotMatch(library, /env\.ENVIRONMENT !== "testing"/);
    // Daily budgets are configurable and can be shared out per person.
    assert.match(library, /library:daily-reads:\$\{user\}/);
    assert.match(library, /library:daily-writes:\$\{user\}/);
    assert.match(library, /total: bounded\(env\.LIBRARY_TOTAL_BYTES, 5000000000, 1000000000000\)/);
  });

  await test('public releases use the production service and private builds the testing one', () => {
    const Plus = require('../core/plus-core.js');
    assert.equal(Plus.releaseChannel('4.3.0'), 'production');
    assert.equal(Plus.releaseChannel('4.2.36.1'), 'testing');
    assert.equal(Plus.releaseChannel(''), 'testing');
    assert.equal(Plus.API_ORIGINS.production, 'https://plus.n3uralcreativity.top');
    // Every copy of the production address agrees.
    const production = Plus.API_ORIGINS.production;
    assert.ok(read('core/plus-ui.js').includes(`'${production}'`), 'plus-ui.js');
    assert.ok(read('scripts/build-release.ps1').includes(`"${production}/*"`), 'build-release.ps1');
    assert.ok(read('scripts/validate-release.ps1').includes(`'${production}/*'`), 'validate-release.ps1');
    if (!hasServer) return;
    const wrangler = read('plus-worker/wrangler.jsonc');
    assert.ok(wrangler.includes(`"SERVICE_ORIGIN": "${production}"`), 'wrangler SERVICE_ORIGIN');
    assert.match(wrangler, /"pattern":\s*"plus\.n3uralcreativity\.top",\s*"custom_domain":\s*true/, 'wrangler custom domain');
    // Production has its own database; the testing service never binds it.
    assert.doesNotMatch(wrangler, /REPLACE_WITH_PRODUCTION_D1_ID/);
    assert.equal((wrangler.match(/5637967f-ddc2-424f-82f2-3a15f6b93288/g) || []).length, 1);
    assert.ok(wrangler.indexOf('5637967f-ddc2-424f-82f2-3a15f6b93288') > wrangler.indexOf('"production"'), 'the production database sits in env.production');
    // Wrangler offers to add new databases and buckets to the top (testing) section:
    // the testing service must only ever bind testing resources.
    const config = JSON.parse(wrangler.replace(/^\s*\/\/.*$/gm, ''));
    for (const item of [...config.d1_databases.map((d) => d.database_name), ...config.r2_buckets.map((b) => b.bucket_name)]) {
      assert.match(item, /-testing$/, 'testing section binds ' + item);
    }
    for (const item of [...config.env.production.d1_databases.map((d) => d.database_name), ...config.env.production.r2_buckets.map((b) => b.bucket_name)]) {
      assert.doesNotMatch(item, /-testing$/, 'production section binds ' + item);
    }
    assert.match(wrangler, /"PLUS_MEMBER_LIMIT": "100"/);
    assert.match(wrangler, /"LIBRARY_TOTAL_BYTES": "100000000000"/);
    assert.match(wrangler, /"STRIPE_LIVE_MODE": "true"/);
    assert.match(read('popup/popup.js'), /PRIVATE_BUILD \? 'Private testing build' : 'comix\.to chapter downloader'/);
  });

  console.log(`\nRESULT: ${passed} passed, 0 failed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
