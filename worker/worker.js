import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Comix-Downloader community service.
 *
 * D1 stores first-seen dates and deduplicated chapter flags. KV stores the small,
 * read-heavy notice document. All user and chapter identifiers are opaque hashes
 * produced by the extension; raw comix.to identifiers are never sent here.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CDL-Admin',
  'Access-Control-Max-Age': '86400',
};
const RESPONSE_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const MAX_IDS = 50;
const ID_RE = /^[a-f0-9]{8,64}$/;
const FLAG_TYPES = new Set(['broken', 'missing', 'wrong']);
const FLAG_TTL_SECONDS = 400 * 24 * 3600;
const PUBLIC_BODY_LIMIT = 2048;
const NOTICE_BODY_LIMIT = 64 * 1024;
const RATE_LIMIT_SECONDS = 60;
const MAX_AUTH_TOKEN_LENGTH = 512;
const NOTICE_KV_KEY = 'notices:v1';
const NOTICE_ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,80}$/i;
const NOTICE_TYPES = new Set(['warning', 'notification']);
const DEFAULT_NOTICES = [
  {
    id: 'scramble-regression-2026-07',
    type: 'warning',
    active: false,
    updatedAt: '2026-07-08T00:00:00.000Z',
    title: 'Scrambled page warning',
    message: 'The recurring comix.to scrambling issue was reported again. Downloaded chapters might look odd until the extension is updated. Expect an update within the next few days. Stay tuned and check GitHub for progress.',
    ctaLabel: 'Check GitHub',
    ctaUrl: 'https://github.com/N3uralCreativity/comix-downloader/issues',
  },
];

class ApiError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.headers = headers || {};
  }
}

function responseHeaders(extraHeaders) {
  return Object.assign({}, CORS, RESPONSE_HEADERS, extraHeaders || {});
}

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status ?? 200,
    headers: responseHeaders(Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders || {})),
  });
}

function methodNotAllowed(allow) {
  return json({ error: 'method not allowed' }, 405, { Allow: allow });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function parseIds(url) {
  const out = [];
  const seen = new Set();
  const values = (url.searchParams.get('ids') || '').split(',');
  for (const value of values) {
    const id = value.trim().toLowerCase();
    if (!ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length === MAX_IDS) break;
  }
  return out;
}

function countValue(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function withTotal(aggregate) {
  const broken = countValue(aggregate && aggregate.broken);
  const missing = countValue(aggregate && aggregate.missing);
  const wrong = countValue(aggregate && aggregate.wrong);
  return { broken, missing, wrong, total: broken + missing + wrong };
}

function rowsFrom(result) {
  return result && Array.isArray(result.results) ? result.results : [];
}

function aggregateFlagRows(rows, includeChapter) {
  const grouped = Object.create(null);
  for (const row of rows || []) {
    const chapter = includeChapter ? String(row.chapter || '') : '_';
    const type = String(row.type || '');
    if (includeChapter && !ID_RE.test(chapter)) continue;
    if (!FLAG_TYPES.has(type)) continue;
    if (!grouped[chapter]) grouped[chapter] = {};
    grouped[chapter][type] = countValue(row.count);
  }
  return grouped;
}

function stringValue(value, max) {
  const string = typeof value === 'string' ? value.trim() : '';
  return string.slice(0, max || 1000);
}

function isoValue(value) {
  const string = stringValue(value, 64);
  if (!string) return '';
  const date = new Date(string);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function cleanUrl(value) {
  const string = stringValue(value, 500);
  if (!string) return '';
  try {
    const url = new URL(string);
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch (_) {
    return '';
  }
}

function sanitizeNotice(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = stringValue(raw.id, 81);
  const type = stringValue(raw.type, 20).toLowerCase();
  const title = stringValue(raw.title, 120);
  const message = stringValue(raw.message, 1200);
  if (!NOTICE_ID_RE.test(id) || !NOTICE_TYPES.has(type) || !title || !message) return null;
  const notice = { id, type, active: raw.active === true, title, message };
  const updatedAt = isoValue(raw.updatedAt);
  if (updatedAt) notice.updatedAt = updatedAt;
  const ctaLabel = stringValue(raw.ctaLabel || (raw.button && raw.button.label), 80);
  const ctaUrl = cleanUrl(raw.ctaUrl || (raw.button && raw.button.url));
  if (ctaLabel && ctaUrl) {
    notice.ctaLabel = ctaLabel;
    notice.ctaUrl = ctaUrl;
  }
  return notice;
}

function noticeArray(value) {
  if (Array.isArray(value)) return value;
  return value && Array.isArray(value.notices) ? value.notices : [];
}

function sanitizeNotices(value) {
  const out = [];
  const ids = new Set();
  for (const item of noticeArray(value).slice(0, 20)) {
    const notice = sanitizeNotice(item);
    if (!notice || ids.has(notice.id)) continue;
    ids.add(notice.id);
    out.push(notice);
  }
  return out;
}

function validateNoticeList(value) {
  const raw = noticeArray(value);
  if (!raw.length || raw.length > 20) return null;
  const notices = raw.map(sanitizeNotice);
  if (notices.some((notice) => !notice)) return null;
  if (new Set(notices.map((notice) => notice.id)).size !== notices.length) return null;
  return notices;
}

function defaultNotices() {
  return DEFAULT_NOTICES.map((notice) => Object.assign({}, notice));
}

function noticeRevisionFields(notice) {
  return JSON.stringify({
    id: notice.id,
    type: notice.type,
    active: notice.active === true,
    title: notice.title,
    message: notice.message,
    ctaLabel: notice.ctaLabel || '',
    ctaUrl: notice.ctaUrl || '',
  });
}

function mergeNoticeRevisions(nextNotices, previousNotices, now, previousUpdatedAt) {
  const previousById = new Map((previousNotices || []).map((notice) => [notice.id, notice]));
  return nextNotices.map((notice) => {
    const previous = previousById.get(notice.id);
    const changed = !previous || noticeRevisionFields(notice) !== noticeRevisionFields(previous);
    return Object.assign({}, notice, {
      updatedAt: changed ? now : (previous.updatedAt || previousUpdatedAt || now),
    });
  });
}

async function readNoticeState(env) {
  if (!env.BADGES) throw new Error('BADGES binding is missing');
  const raw = await env.BADGES.get(NOTICE_KV_KEY);
  let state = null;
  if (raw) {
    try {
      state = JSON.parse(raw);
    } catch (_) {
      console.warn({ event: 'invalid_notice_state' });
    }
  }
  const notices = sanitizeNotices(state);
  return {
    notices: notices.length ? notices : defaultNotices(),
    updatedAt: state ? (isoValue(state.updatedAt) || null) : null,
  };
}

function secureEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (!left || !right || left.length > MAX_AUTH_TOKEN_LENGTH || right.length > MAX_AUTH_TOKEN_LENGTH) return false;
  const leftHash = createHash('sha256').update(left, 'utf8').digest();
  const rightHash = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftHash, rightHash);
}

function adminAuthorized(request, env) {
  const token = env.CDL_NOTICE_ADMIN_TOKEN || '';
  const authorization = request.headers.get('Authorization') || '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  const supplied = (bearer && bearer[1]) || request.headers.get('X-CDL-Admin') || '';
  return secureEqual(supplied, token);
}

async function readJsonBody(request, maxBytes) {
  const mediaType = (request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') throw new ApiError(415, 'content type must be application/json');

  const announcedLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(announcedLength) && announcedLength > maxBytes) {
    throw new ApiError(413, 'request body too large');
  }
  if (!request.body) throw new ApiError(400, 'bad json');

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (_) {}
      throw new ApiError(413, 'request body too large');
    }
    text += decoder.decode(result.value, { stream: true });
  }
  text += decoder.decode();

  try {
    return JSON.parse(text);
  } catch (_) {
    throw new ApiError(400, 'bad json');
  }
}

async function enforceRateLimit(request, limiter, bucket) {
  if (!limiter || typeof limiter.limit !== 'function') {
    throw new Error('rate-limit binding is missing');
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const result = await limiter.limit({ key: bucket + ':' + ip });
  if (!result || result.success !== true) {
    throw new ApiError(429, 'too many requests', { 'Retry-After': String(RATE_LIMIT_SECONDS) });
  }
}

function requireDatabase(env) {
  if (!env.FLAGS_DB) throw new Error('FLAGS_DB binding is missing');
  return env.FLAGS_DB;
}

async function handleSeen(request, env, url) {
  if (request.method === 'POST') {
    const database = requireDatabase(env);
    await enforceRateLimit(request, env.WRITE_RATE_LIMITER, 'seen-write');
    const body = await readJsonBody(request, PUBLIC_BODY_LIMIT);
    const id = body && typeof body.id === 'string' ? body.id.toLowerCase() : '';
    if (!ID_RE.test(id)) throw new ApiError(400, 'bad id');

    const firstSeen = todayISO();
    const results = await database.batch([
      database.prepare('INSERT OR IGNORE INTO user_tenure (user_hash, first_seen) VALUES (?, ?)').bind(id, firstSeen),
      database.prepare('SELECT first_seen FROM user_tenure WHERE user_hash = ?').bind(id),
    ]);
    const row = rowsFrom(results[1])[0];
    if (!row || typeof row.first_seen !== 'string') throw new Error('D1 first-seen lookup failed');
    return json({ id, first: row.first_seen });
  }

  if (request.method === 'GET') {
    const database = requireDatabase(env);
    await enforceRateLimit(request, env.READ_RATE_LIMITER, 'seen-read');
    const ids = parseIds(url);
    const out = Object.fromEntries(ids.map((id) => [id, null]));
    if (!ids.length) return json(out);
    const placeholders = ids.map(() => '?').join(',');
    const result = await database.prepare(
      'SELECT user_hash, first_seen FROM user_tenure WHERE user_hash IN (' + placeholders + ')',
    ).bind(...ids).all();
    for (const row of rowsFrom(result)) {
      if (out[row.user_hash] === null && typeof row.first_seen === 'string') out[row.user_hash] = row.first_seen;
    }
    return json(out);
  }

  return methodNotAllowed('GET, POST');
}

async function handleNotices(request, env, url) {
  if (request.method === 'GET') {
    if (url.searchParams.get('admin') === '1') {
      await enforceRateLimit(request, env.WRITE_RATE_LIMITER, 'notices-admin');
      if (!adminAuthorized(request, env)) {
        return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer realm="Comix Downloader notices"' });
      }
    } else {
      await enforceRateLimit(request, env.READ_RATE_LIMITER, 'notices-read');
    }
    const state = await readNoticeState(env);
    if (url.searchParams.get('admin') === '1') return json(state);
    return json({
      notices: state.notices.filter((notice) => notice.active),
      updatedAt: state.updatedAt,
    });
  }

  if (request.method === 'PUT') {
    await enforceRateLimit(request, env.WRITE_RATE_LIMITER, 'notices-write');
    if (!adminAuthorized(request, env)) {
      return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer realm="Comix Downloader notices"' });
    }
    const body = await readJsonBody(request, NOTICE_BODY_LIMIT);
    const now = new Date().toISOString();
    const previousState = await readNoticeState(env);
    let notices;

    if (Array.isArray(body) || (body && Array.isArray(body.notices))) {
      const validated = validateNoticeList(body);
      if (!validated) throw new ApiError(400, 'invalid notice list');
      notices = mergeNoticeRevisions(validated, previousState.notices, now, previousState.updatedAt);
    } else if (body && typeof body === 'object') {
      notices = previousState.notices.map((notice) => Object.assign({}, notice));
      const id = stringValue(body.id, 81);
      const index = notices.findIndex((notice) => notice.id === id);
      if (index < 0 || typeof body.active !== 'boolean') throw new ApiError(400, 'bad notice update');
      notices[index].active = body.active;
      notices = mergeNoticeRevisions(notices, previousState.notices, now, previousState.updatedAt);
    } else {
      throw new ApiError(400, 'bad request');
    }

    const state = { updatedAt: now, notices };
    await env.BADGES.put(NOTICE_KV_KEY, JSON.stringify(state));
    return json(state);
  }

  return methodNotAllowed('GET, PUT');
}

async function handleFlag(request, env) {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const database = requireDatabase(env);
  await enforceRateLimit(request, env.WRITE_RATE_LIMITER, 'flag-write');
  const body = await readJsonBody(request, PUBLIC_BODY_LIMIT);
  const chapter = body && typeof body.chapter === 'string' ? body.chapter.toLowerCase() : '';
  const user = body && typeof body.user === 'string' ? body.user.toLowerCase() : '';
  const type = body && body.type;
  if (!ID_RE.test(chapter) || !ID_RE.test(user) || !FLAG_TYPES.has(type)) {
    throw new ApiError(400, 'bad request');
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + FLAG_TTL_SECONDS;
  const results = await database.batch([
    database.prepare('DELETE FROM chapter_flags WHERE expires_at <= ?').bind(now),
    database.prepare(
      'INSERT OR IGNORE INTO chapter_flags (chapter, user_hash, type, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(chapter, user, type, now, expiresAt),
    database.prepare(
      'SELECT type, COUNT(*) AS count FROM chapter_flags WHERE chapter = ? AND expires_at > ? GROUP BY type',
    ).bind(chapter, now),
  ]);
  const grouped = aggregateFlagRows(rowsFrom(results[2]), false);
  return json({ chapter, counts: withTotal(grouped._), flagged: true });
}

async function handleFlags(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const database = requireDatabase(env);
  await enforceRateLimit(request, env.READ_RATE_LIMITER, 'flags-read');
  const ids = parseIds(url);
  const out = Object.fromEntries(ids.map((id) => [id, null]));
  if (!ids.length) return json(out);

  const now = Math.floor(Date.now() / 1000);
  const placeholders = ids.map(() => '?').join(',');
  const result = await database.prepare(
    'SELECT chapter, type, COUNT(*) AS count FROM chapter_flags WHERE expires_at > ? AND chapter IN ('
      + placeholders + ') GROUP BY chapter, type',
  ).bind(now, ...ids).all();
  const grouped = aggregateFlagRows(rowsFrom(result), true);
  for (const chapter of Object.keys(grouped)) out[chapter] = withTotal(grouped[chapter]);
  return json(out);
}

async function handleRequest(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: responseHeaders({ 'Cache-Control': 'public, max-age=86400' }) });
  }

  const url = new URL(request.url);
  if (url.pathname === '/v1/seen') return handleSeen(request, env, url);
  if (url.pathname === '/v1/notices') return handleNotices(request, env, url);
  if (url.pathname === '/v1/flag') return handleFlag(request, env);
  if (url.pathname === '/v1/flags') return handleFlags(request, env, url);
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message }, error.status, error.headers);
      let pathname = 'invalid-url';
      try { pathname = new URL(request.url).pathname; } catch (_) {}
      console.error({
        event: 'worker_request_error',
        method: request.method,
        path: pathname,
        error: error instanceof Error ? error.message : 'unknown error',
      });
      return json({ error: 'internal server error' }, 500);
    }
  },
};
