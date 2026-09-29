'use strict';

// Plus member feedback: messages reach the developer's inbox (ADMIN_EMAIL) from the
// extension and from the account website, only for people who have had Plus, with
// the member's address included only when they allow a reply.
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

async function feedbackFixture(overrides) {
  const emails = [];
  const f = await fixture({
    ENVIRONMENT: 'test',
    ADMIN_EMAIL: 'dev@example.test',
    SERVICE_ORIGIN: 'https://plus.example.test',
    TEST_EMAIL_SINK: async (payload) => { emails.push(payload); },
    ...overrides,
  });
  const send = (user, body) => f.request(user)('/v1/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { f, emails, send };
}

(async () => {
  await serverTest('member feedback reaches the developer with a reply address and the message escaped', async () => {
    const { f, emails, send } = await feedbackFixture();
    const result = await send('user0', {
      kind: 'add',
      message: 'Please add a dark reader theme.\nAlso <b>bold</b> ideas.',
      allowReply: true,
      version: '4.3.0',
      browser: 'Chrome on Windows',
    });
    assert.equal(result.sent, true);
    assert.equal(emails.length, 1);
    const mail = emails[0];
    assert.deepEqual(mail.to, ['dev@example.test']);
    assert.equal(mail.reply_to, 'reader@example.test');
    assert.equal(mail.subject, 'Plus feedback: Something to add');
    assert.match(mail.html, /Please add a dark reader theme\./);
    assert.match(mail.html, /&lt;b&gt;bold&lt;\/b&gt;/);
    assert.doesNotMatch(mail.html, /<b>bold<\/b>/);
    assert.match(mail.html, /Extension v4\.3\.0 on Chrome on Windows/);
    assert.match(mail.html, /white-space:pre-wrap/);
    assert.match(mail.text, /> Please add a dark reader theme\.\n> Also <b>bold<\/b> ideas\./);
    assert.match(mail.text, /Reply to this email to reach reader@example\.test/);
    f.env.PLUS_DB.db.close();
  });

  await serverTest('without reply permission the member address is left out', async () => {
    const { f, emails, send } = await feedbackFixture();
    await send('user0', { kind: 'dislike', message: 'The Cloud Library upload is too slow for me.', allowReply: false });
    const mail = emails[0];
    assert.notEqual(mail.reply_to, 'reader@example.test');
    assert.doesNotMatch(mail.html, /reader@example\.test/);
    assert.doesNotMatch(mail.text, /reader@example\.test/);
    assert.match(mail.text, /Asked not to be contacted/);
    f.env.PLUS_DB.db.close();
  });

  await serverTest('feedback needs a topic, a real message, a Plus history and stays under five a day', async () => {
    const { f, emails, send } = await feedbackFixture();
    await assert.rejects(() => send('user0', { kind: 'toString', message: 'A long enough message.' }), (error) => error.code === 'INVALID_FEEDBACK' && error.status === 400);
    await assert.rejects(() => send('user0', { kind: 'other', message: 'short' }), (error) => error.code === 'INVALID_FEEDBACK');
    await assert.rejects(() => send('user0', { kind: 'other', message: 'x'.repeat(4001) }), (error) => error.code === 'INVALID_FEEDBACK');

    f.env.PLUS_DB.db.prepare("UPDATE entitlements SET state='pending_checkout' WHERE user_id='user1'").run();
    await assert.rejects(() => send('user1', { kind: 'other', message: 'I never started Plus.' }), (error) => error.code === 'FEEDBACK_MEMBERS_ONLY' && error.status === 403);
    f.env.PLUS_DB.db.prepare("UPDATE entitlements SET state='expired' WHERE user_id='user1'").run();
    await send('user1', { kind: 'remove', message: 'I left because of the price, sorry.' });

    for (let i = 0; i < 5; i += 1) await send('user0', { kind: 'other', message: `Message number ${i} with enough words.` });
    await assert.rejects(() => send('user0', { kind: 'other', message: 'One message too many today.' }), (error) => error.code === 'FEEDBACK_LIMIT' && error.status === 429);
    assert.equal(emails.length, 6, 'only accepted messages are emailed');
    f.env.PLUS_DB.db.close();
  });

  await serverTest('the account website sends feedback with its own session, from its own origin only', async () => {
    const { f, emails } = await feedbackFixture();
    const worker = f.worker;
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 86400000).toISOString();
    const db = f.env.PLUS_DB.db;
    db.prepare("INSERT INTO devices(id,user_id,name,public_key_jwk,approved_at,created_at,last_seen_at,kind) VALUES('web_feedback','user0','Website','{}',?,?,?,'web')").run(now, now, now);
    db.prepare('INSERT INTO sessions(id,user_id,device_id,access_hash,refresh_hash,access_expires_at,refresh_expires_at,created_at,rotated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('web_session', 'user0', 'web_feedback', await worker.__test.sha256Hex('web-access'), await worker.__test.sha256Hex('web-cookie'), future, future, now, now);
    const post = (headers) => f.fetch('http://localhost/v1/web/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'cdl_plus_session=web-cookie', ...headers },
      body: JSON.stringify({ kind: 'dislike', message: 'The account page is hard to find.', allowReply: true }),
    });
    const blocked = await post({});
    assert.equal(blocked.status, 403, 'a POST without the website origin is refused');
    const sent = await post({ Origin: 'http://localhost' });
    assert.equal(sent.status, 200);
    assert.equal(emails.length, 1);
    assert.match(emails[0].html, /Plus website/);
    db.close();
  });

  await test('the extension offers feedback in Plus settings and sends it through the Plus service', () => {
    const core = read('core/plus-core.js');
    assert.match(core, /action === 'plusSendFeedback'/);
    assert.match(core, /authorizedRequest\('\/v1\/feedback'/);
    const ui = read('core/plus-ui.js');
    assert.match(ui, /\{ id: 'feedback', label: 'Feedback' \}/);
    assert.match(ui, /action: 'plusSendFeedback'/);
    assert.match(ui, /Tell the developer why Plus ended for you/);
  });

  await test('Download All shows Save to as tiles, with Cloud locked until Plus can save', () => {
    const title = read('content/content_title.js');
    assert.doesNotMatch(title, /<select id="cdl-op-destination">/);
    ['local', 'cloud', 'both'].forEach((value) => assert.match(title, new RegExp(`destinationTile\\('${value}'`)));
    assert.match(title, /action: 'plusGetState'/);
    assert.match(title, /PLUS_CLOUD_SAVE_STATES = new Set\(\['trial', 'active', 'grace', 'cancelled_active'\]\)/);
    assert.doesNotMatch(title, /alert\(response\?\.error\?\.message/);
  });

  console.log(`\n${passed} Plus feedback checks passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
