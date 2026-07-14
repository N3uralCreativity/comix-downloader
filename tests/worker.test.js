/**
 * Endpoint tests for worker/worker.js (run: `node tests/worker.test.js`).
 * Cloudflare bindings are represented by deterministic in-memory fakes.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORKER_URL = 'https://comix-downloader-badge.test';
const USER_A = 'a'.repeat(32);
const USER_B = 'b'.repeat(32);
const CHAPTER_A = 'c'.repeat(32);
const CHAPTER_B = 'd'.repeat(32);

class FakeKV {
  constructor(entries) {
    this.values = new Map(Object.entries(entries || {}));
  }

  async get(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  async put(key, value) {
    this.values.set(key, String(value));
  }
}

class FakeRateLimiter {
  constructor(success) {
    this.success = success !== false;
    this.calls = [];
  }

  async limit(options) {
    this.calls.push(options);
    return { success: this.success };
  }
}

class FakeStatement {
  constructor(database, sql, params) {
    this.database = database;
    this.sql = sql.replace(/\s+/g, ' ').trim();
    this.params = params || [];
  }

  bind(...params) {
    return new FakeStatement(this.database, this.sql, params);
  }

  async all() {
    return this.database.execute(this);
  }

  async run() {
    return this.database.execute(this);
  }
}

class FakeD1 {
  constructor() {
    this.users = new Map();
    this.flags = new Map();
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    const usersBefore = new Map(this.users);
    const flagsBefore = new Map(this.flags);
    try {
      const results = [];
      for (const statement of statements) results.push(await this.execute(statement));
      return results;
    } catch (error) {
      this.users = usersBefore;
      this.flags = flagsBefore;
      throw error;
    }
  }

  async execute(statement) {
    const sql = statement.sql;
    const params = statement.params;

    if (sql.startsWith('INSERT OR IGNORE INTO user_tenure')) {
      const [id, firstSeen] = params;
      const changes = this.users.has(id) ? 0 : 1;
      if (changes) this.users.set(id, firstSeen);
      return this.result([], changes);
    }

    if (sql.startsWith('SELECT first_seen FROM user_tenure')) {
      const firstSeen = this.users.get(params[0]);
      return this.result(firstSeen ? [{ first_seen: firstSeen }] : []);
    }

    if (sql.startsWith('SELECT user_hash, first_seen FROM user_tenure')) {
      const rows = params
        .filter((id) => this.users.has(id))
        .map((id) => ({ user_hash: id, first_seen: this.users.get(id) }));
      return this.result(rows);
    }

    if (sql.startsWith('DELETE FROM chapter_flags')) {
      const now = params[0];
      let changes = 0;
      for (const [key, flag] of this.flags) {
        if (flag.expires_at <= now) {
          this.flags.delete(key);
          changes += 1;
        }
      }
      return this.result([], changes);
    }

    if (sql.startsWith('INSERT OR IGNORE INTO chapter_flags')) {
      const [chapter, user, type, createdAt, expiresAt] = params;
      const key = chapter + ':' + user;
      const changes = this.flags.has(key) ? 0 : 1;
      if (changes) {
        this.flags.set(key, {
          chapter,
          user_hash: user,
          type,
          created_at: createdAt,
          expires_at: expiresAt,
        });
      }
      return this.result([], changes);
    }

    if (sql.startsWith('SELECT type, COUNT(*) AS count FROM chapter_flags')) {
      const [chapter, now] = params;
      return this.result(this.flagCounts([chapter], now, false));
    }

    if (sql.startsWith('SELECT chapter, type, COUNT(*) AS count FROM chapter_flags')) {
      const [now, ...chapters] = params;
      return this.result(this.flagCounts(chapters, now, true));
    }

    throw new Error('Unhandled fake D1 statement: ' + sql);
  }

  flagCounts(chapters, now, includeChapter) {
    const allowed = new Set(chapters);
    const counts = new Map();
    for (const flag of this.flags.values()) {
      if (!allowed.has(flag.chapter) || flag.expires_at <= now) continue;
      const key = flag.chapter + ':' + flag.type;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].map(([key, count]) => {
      const separator = key.lastIndexOf(':');
      const chapter = key.slice(0, separator);
      const type = key.slice(separator + 1);
      return includeChapter ? { chapter, type, count } : { type, count };
    });
  }

  result(results, changes) {
    return { success: true, results, meta: { changes: changes || 0 } };
  }
}

function environment(overrides) {
  return Object.assign({
    BADGES: new FakeKV(),
    FLAGS_DB: new FakeD1(),
    READ_RATE_LIMITER: new FakeRateLimiter(),
    WRITE_RATE_LIMITER: new FakeRateLimiter(),
    CDL_NOTICE_ADMIN_TOKEN: 'test-admin-token',
  }, overrides || {});
}

function request(pathname, method, body, headers) {
  const requestHeaders = new Headers(headers || {});
  requestHeaders.set('CF-Connecting-IP', '203.0.113.10');
  let requestBody;
  if (body !== undefined) {
    requestBody = typeof body === 'string' ? body : JSON.stringify(body);
    if (!requestHeaders.has('Content-Type')) requestHeaders.set('Content-Type', 'application/json');
  }
  return new Request(WORKER_URL + pathname, { method: method || 'GET', headers: requestHeaders, body: requestBody });
}

async function body(response) {
  return response.json();
}

async function loadWorker() {
  const source = fs.readFileSync(path.join(ROOT, 'worker', 'worker.js'), 'utf8');
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  return (await import(dataUrl)).default;
}

(async () => {
  const worker = await loadWorker();
  let passed = 0;
  let failed = 0;
  const originalConsoleError = console.error;
  console.error = () => {};

  async function test(name, callback) {
    try {
      await callback();
      passed += 1;
      console.log('PASS  ' + name);
    } catch (error) {
      failed += 1;
      originalConsoleError('FAIL  ' + name);
      originalConsoleError(error && error.stack ? error.stack : error);
    }
  }

  await test('OPTIONS returns CORS and security headers', async () => {
    const response = await worker.fetch(request('/v1/seen', 'OPTIONS'), environment());
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(response.headers.get('Access-Control-Allow-Methods'), /PUT/);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  });

  await test('unknown routes return hardened JSON 404 responses', async () => {
    const response = await worker.fetch(request('/unknown'), environment());
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await body(response), { error: 'not found' });
  });

  await test('POST rejects a non-JSON content type', async () => {
    const response = await worker.fetch(
      request('/v1/seen', 'POST', '{"id":"' + USER_A + '"}', { 'Content-Type': 'text/plain' }),
      environment(),
    );
    assert.equal(response.status, 415);
  });

  await test('POST rejects malformed JSON', async () => {
    const response = await worker.fetch(request('/v1/seen', 'POST', '{bad'), environment());
    assert.equal(response.status, 400);
    assert.deepEqual(await body(response), { error: 'bad json' });
  });

  await test('public mutation bodies are capped at 2 KiB', async () => {
    const response = await worker.fetch(request('/v1/seen', 'POST', JSON.stringify({ id: 'a'.repeat(3000) })), environment());
    assert.equal(response.status, 413);
  });

  await test('first-seen registration never overwrites an existing date', async () => {
    const env = environment();
    env.FLAGS_DB.users.set(USER_A, '2025-02-03');
    const existing = await worker.fetch(request('/v1/seen', 'POST', { id: USER_A }), env);
    const created = await worker.fetch(request('/v1/seen', 'POST', { id: USER_B }), env);
    assert.deepEqual(await body(existing), { id: USER_A, first: '2025-02-03' });
    assert.match((await body(created)).first, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(env.FLAGS_DB.users.get(USER_A), '2025-02-03');
  });

  await test('first-seen lookup deduplicates, validates, and preserves misses', async () => {
    const env = environment();
    env.FLAGS_DB.users.set(USER_A, '2025-02-03');
    const response = await worker.fetch(
      request('/v1/seen?ids=' + USER_A + ',invalid,' + USER_B + ',' + USER_A),
      env,
    );
    assert.deepEqual(await body(response), { [USER_A]: '2025-02-03', [USER_B]: null });
  });

  await test('invalid first-seen hashes are rejected', async () => {
    const response = await worker.fetch(request('/v1/seen', 'POST', { id: 'not-a-hash' }), environment());
    assert.equal(response.status, 400);
  });

  await test('rate-limit denial returns 429 and Retry-After', async () => {
    const limiter = new FakeRateLimiter(false);
    const response = await worker.fetch(
      request('/v1/seen', 'POST', { id: USER_A }),
      environment({ WRITE_RATE_LIMITER: limiter }),
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Retry-After'), '60');
    assert.equal(limiter.calls[0].key, 'seen-write:203.0.113.10');
  });

  await test('missing D1 and rate-limit bindings fail closed', async () => {
    const noDatabase = await worker.fetch(request('/v1/seen?ids=' + USER_A), environment({ FLAGS_DB: null }));
    const noWriteLimiter = await worker.fetch(
      request('/v1/seen', 'POST', { id: USER_A }),
      environment({ WRITE_RATE_LIMITER: null }),
    );
    const noReadLimiter = await worker.fetch(
      request('/v1/seen?ids=' + USER_A),
      environment({ READ_RATE_LIMITER: null }),
    );
    assert.equal(noDatabase.status, 500);
    assert.equal(noWriteLimiter.status, 500);
    assert.equal(noReadLimiter.status, 500);
  });

  await test('read rate-limit denial returns 429 without querying storage', async () => {
    const limiter = new FakeRateLimiter(false);
    const response = await worker.fetch(
      request('/v1/flags?ids=' + CHAPTER_A),
      environment({ READ_RATE_LIMITER: limiter }),
    );
    assert.equal(response.status, 429);
    assert.equal(limiter.calls[0].key, 'flags-read:203.0.113.10');
  });

  await test('public notices expose active entries only', async () => {
    const state = {
      updatedAt: '2026-01-01T00:00:00.000Z',
      notices: [
        { id: 'active', type: 'warning', active: true, title: 'Active', message: 'Shown' },
        { id: 'inactive', type: 'notification', active: false, title: 'Inactive', message: 'Hidden' },
      ],
    };
    const env = environment({ BADGES: new FakeKV({ 'notices:v1': JSON.stringify(state) }) });
    const response = await worker.fetch(request('/v1/notices'), env);
    const data = await body(response);
    assert.equal(data.notices.length, 1);
    assert.equal(data.notices[0].id, 'active');
  });

  await test('notice administration requires a timing-safe bearer token', async () => {
    const env = environment();
    const denied = await worker.fetch(request('/v1/notices?admin=1'), env);
    const allowed = await worker.fetch(
      request('/v1/notices?admin=1', 'GET', undefined, { Authorization: 'Bearer test-admin-token' }),
      env,
    );
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('WWW-Authenticate'), /^Bearer/);
    assert.equal(allowed.status, 200);
  });

  await test('legacy X-CDL-Admin authentication remains supported', async () => {
    const response = await worker.fetch(
      request('/v1/notices?admin=1', 'GET', undefined, { 'X-CDL-Admin': 'test-admin-token' }),
      environment(),
    );
    assert.equal(response.status, 200);
  });

  await test('notice updates preserve revisions for unchanged notices', async () => {
    const oldState = {
      updatedAt: '2026-01-03T00:00:00.000Z',
      notices: [
        {
          id: 'first', type: 'warning', active: false, title: 'First', message: 'Old',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'second', type: 'notification', active: false, title: 'Second', message: 'Same',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    };
    const env = environment({ BADGES: new FakeKV({ 'notices:v1': JSON.stringify(oldState) }) });
    const response = await worker.fetch(
      request('/v1/notices', 'PUT', {
        notices: [
          { id: 'first', type: 'warning', active: true, title: 'First', message: 'Old' },
          { id: 'second', type: 'notification', active: false, title: 'Second', message: 'Same' },
        ],
      }, { Authorization: 'Bearer test-admin-token' }),
      env,
    );
    const data = await body(response);
    assert.equal(response.status, 200);
    assert.notEqual(data.notices[0].updatedAt, oldState.notices[0].updatedAt);
    assert.equal(data.notices[1].updatedAt, oldState.notices[1].updatedAt);
  });

  await test('notice updates reject duplicate IDs and oversized bodies', async () => {
    const duplicate = { id: 'same', type: 'warning', active: true, title: 'Same', message: 'Message' };
    const env = environment();
    const invalid = await worker.fetch(
      request('/v1/notices', 'PUT', { notices: [duplicate, duplicate] }, { Authorization: 'Bearer test-admin-token' }),
      env,
    );
    const oversized = await worker.fetch(
      request('/v1/notices', 'PUT', JSON.stringify({ notices: [], padding: 'x'.repeat(70 * 1024) }), {
        Authorization: 'Bearer test-admin-token',
      }),
      env,
    );
    assert.equal(invalid.status, 400);
    assert.equal(oversized.status, 413);
  });

  await test('chapter flags are counted once per user and chapter', async () => {
    const env = environment();
    const first = await worker.fetch(
      request('/v1/flag', 'POST', { chapter: CHAPTER_A, user: USER_A, type: 'broken' }),
      env,
    );
    const duplicate = await worker.fetch(
      request('/v1/flag', 'POST', { chapter: CHAPTER_A, user: USER_A, type: 'missing' }),
      env,
    );
    const second = await worker.fetch(
      request('/v1/flag', 'POST', { chapter: CHAPTER_A, user: USER_B, type: 'missing' }),
      env,
    );
    assert.deepEqual((await body(first)).counts, { broken: 1, missing: 0, wrong: 0, total: 1 });
    assert.deepEqual((await body(duplicate)).counts, { broken: 1, missing: 0, wrong: 0, total: 1 });
    assert.deepEqual((await body(second)).counts, { broken: 1, missing: 1, wrong: 0, total: 2 });
  });

  await test('type allowlists reject inherited object property names', async () => {
    const env = environment();
    const flag = await worker.fetch(
      request('/v1/flag', 'POST', { chapter: CHAPTER_A, user: USER_A, type: 'toString' }),
      env,
    );
    const notice = await worker.fetch(
      request('/v1/notices', 'PUT', {
        notices: [{ id: 'bad-type', type: 'toString', active: true, title: 'Bad', message: 'Bad type' }],
      }, { Authorization: 'Bearer test-admin-token' }),
      env,
    );
    assert.equal(flag.status, 400);
    assert.equal(notice.status, 400);
  });

  await test('expired flags are removed before a replacement is inserted', async () => {
    const env = environment();
    env.FLAGS_DB.flags.set(CHAPTER_A + ':' + USER_A, {
      chapter: CHAPTER_A,
      user_hash: USER_A,
      type: 'broken',
      created_at: 1,
      expires_at: 2,
    });
    const response = await worker.fetch(
      request('/v1/flag', 'POST', { chapter: CHAPTER_A, user: USER_A, type: 'wrong' }),
      env,
    );
    assert.deepEqual((await body(response)).counts, { broken: 0, missing: 0, wrong: 1, total: 1 });
  });

  await test('chapter flag lookup batches counts and preserves misses', async () => {
    const env = environment();
    await worker.fetch(request('/v1/flag', 'POST', { chapter: CHAPTER_A, user: USER_A, type: 'wrong' }), env);
    const response = await worker.fetch(request('/v1/flags?ids=' + CHAPTER_A + ',' + CHAPTER_B), env);
    assert.deepEqual(await body(response), {
      [CHAPTER_A]: { broken: 0, missing: 0, wrong: 1, total: 1 },
      [CHAPTER_B]: null,
    });
  });

  await test('known endpoints return 405 with an Allow header', async () => {
    const seen = await worker.fetch(request('/v1/seen', 'DELETE'), environment());
    const flag = await worker.fetch(request('/v1/flag', 'GET'), environment());
    assert.equal(seen.status, 405);
    assert.equal(seen.headers.get('Allow'), 'GET, POST');
    assert.equal(flag.status, 405);
    assert.equal(flag.headers.get('Allow'), 'POST');
  });

  await test('notice reads fail cleanly when KV is not bound', async () => {
    const response = await worker.fetch(request('/v1/notices'), environment({ BADGES: null }));
    assert.equal(response.status, 500);
    assert.deepEqual(await body(response), { error: 'internal server error' });
  });

  console.error = originalConsoleError;
  console.log('\nRESULT: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
