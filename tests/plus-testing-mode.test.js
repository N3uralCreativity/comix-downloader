'use strict';

// Testing server conveniences: everyone is a Plus member with no device limit, and
// private testing builds sign in to one shared tester account with a local key.
// Production must ignore all of it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

const TESTER = 'tester@plus-testing.invalid';
const KEY = 'tester-key-0123456789abcdefghijklmnop';
let deviceCounter = 0;
function devicePayload(extra) {
  deviceCounter += 1;
  return {
    deviceId: 'dev_' + String(deviceCounter).padStart(20, 'x'),
    deviceName: 'Chrome on Windows',
    publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' },
    ...extra,
  };
}

async function testingFixture(overrides) {
  const emails = [];
  const f = await fixture({
    ENVIRONMENT: 'testing',
    AUTH_PEPPER: 'pepper',
    TESTING_EVERYONE_PLUS: 'true',
    TESTER_EMAIL: TESTER,
    TESTER_SIGN_IN_KEY: KEY,
    TEST_EMAIL_SINK: async (payload) => { emails.push(payload); },
    ...overrides,
  });
  const verify = (body) => f.fetch('http://localhost/v1/auth/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { f, emails, verify };
}

(async () => {
  await serverTest('on the testing server every account is a Plus member with no device limit', async () => {
    const { f } = await testingFixture();
    f.env.PLUS_DB.db.prepare("UPDATE entitlements SET state='expired' WHERE user_id='user0'").run();
    const account = (await f.request('user0')('/v1/account')).account;
    assert.equal(account.state, 'active');
    assert.equal(account.periodEnd, '2099-12-31T00:00:00.000Z');
    assert.equal(account.deviceLimit, 1000);
    // The Cloud Library invite list no longer applies either.
    f.env.LIBRARY_TEST_EMAILS = 'someone-else@example.test';
    const listing = await f.request('user0')('/v1/library');
    assert.ok(Array.isArray(listing.nodes));
    f.env.PLUS_DB.db.close();
  });

  await serverTest('the tester key signs in to the shared tester account on any number of browsers', async () => {
    const { f, emails, verify } = await testingFixture();
    for (let i = 0; i < 7; i += 1) {
      const response = await verify(devicePayload({ email: TESTER, code: '', testerKey: KEY, intent: 'login' }));
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.account.email, TESTER);
      assert.equal(body.account.state, 'active');
      assert.ok(body.tokens.accessToken);
    }
    assert.equal(emails.length, 0, 'the tester account is never emailed');

    const wrong = await verify(devicePayload({ email: TESTER, code: '', testerKey: 'wrong-key', intent: 'login' }));
    assert.equal(wrong.status, 400);
    const otherEmail = await verify(devicePayload({ email: 'reader@example.test', code: '', testerKey: KEY, intent: 'login' }));
    assert.equal(otherEmail.status, 400, 'the key works for the tester account only');
    f.env.PLUS_DB.db.close();
  });

  await serverTest('production ignores the testing flags even if they were set', async () => {
    const { f, verify } = await testingFixture({ ENVIRONMENT: 'production' });
    f.env.PLUS_DB.db.prepare("UPDATE entitlements SET state='expired' WHERE user_id='user0'").run();
    const account = (await f.request('user0')('/v1/account')).account;
    assert.equal(account.state, 'expired');
    assert.equal(account.deviceLimit, 5);
    const tester = await verify(devicePayload({ email: TESTER, code: '', testerKey: KEY, intent: 'login' }));
    assert.equal(tester.status, 400);
    f.env.PLUS_DB.db.close();
  });

  await serverTest('only the testing section of wrangler.jsonc turns the conveniences on', () => {
    const config = read('plus-worker/wrangler.jsonc');
    const production = config.slice(config.indexOf('"production"'));
    const testing = config.slice(0, config.indexOf('"env"'));
    assert.match(testing, /"TESTING_EVERYONE_PLUS": "true"/);
    assert.match(testing, /"TESTER_EMAIL": "tester@plus-testing\.invalid"/);
    assert.doesNotMatch(production, /TESTING_EVERYONE_PLUS|TESTER_EMAIL|TESTER_SIGN_IN_KEY/);
  });

  await test('the tester key file never reaches git, public exports or packages', () => {
    assert.match(read('.gitignore'), /^plus-tester\.local\.json$/m);
    assert.doesNotMatch(read('scripts/build-release.ps1'), /plus-tester/);
    const core = read('core/plus-core.js');
    assert.match(core, /if \(CHANNEL !== 'testing'/, 'only private testing builds read the tester file');
    assert.match(core, /cdlPlusSignedOutAt/, 'a manual sign-out is respected');
  });

  console.log(`\n${passed} testing-mode checks passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
