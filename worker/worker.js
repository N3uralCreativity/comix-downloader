/**
 * Comix-Downloader community service — Cloudflare Worker (free tier). One KV namespace (BADGES).
 *
 * Two features, both keyed by OPAQUE salted hashes the extension computes client-side (raw comix
 * ids / chapter ids are never sent or stored); only coarse aggregates are kept — no PII.
 *
 * 1) Tenure badge — first-seen date per user (server-timestamped, never overwritten):
 *      POST /v1/seen   {"id":"<hash>"}            -> {"id","first":"YYYY-MM-DD"}
 *      GET  /v1/seen?ids=a,b,c (<=50)             -> {"a":"YYYY-MM-DD","b":null,...}
 *
 * 2) Crowd quality flags — how many readers flagged a chapter (broken/missing/wrong):
 *      POST /v1/flag   {"chapter":"<hash>","user":"<hash>","type":"broken|missing|wrong"}
 *                                                 -> {"chapter","counts":{broken,missing,wrong,total},"flagged":true}
 *        (one flag per user per chapter; the per-user marker is server-side + TTL'd)
 *      GET  /v1/flags?ids=a,b,c (<=50)            -> {"a":{broken,missing,wrong,total},"b":null,...}
 *
 * 3) Remote user notices — admin-controlled warning/notification payloads:
 *      GET  /v1/notices                            -> {"notices":[active notices only]}
 *      GET  /v1/notices?admin=1 (Bearer token)     -> {"notices":[all notices]}
 *      PUT  /v1/notices  (Bearer CDL_NOTICE_ADMIN_TOKEN)
 *        {"id":"scramble-regression-2026-07","active":true}
 *        OR {"notices":[...]}                      -> replace full notice list
 *    Without the optional admin token, edit BADGES KV key "notices:v1" manually.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CDL-Admin',
  'Access-Control-Max-Age': '86400',
};
const MAX_IDS = 50;
const ID_RE = /^[a-f0-9]{8,64}$/;            // hex hash only
const FLAG_TYPES = { broken: 1, missing: 1, wrong: 1 };
const FLAG_MARKER_TTL = 400 * 24 * 3600;     // per-user-per-chapter dedup marker lifetime (~400d)
const NOTICE_KV_KEY = 'notices:v1';
const NOTICE_ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,80}$/i;
const NOTICE_TYPES = { warning: 1, notification: 1 };
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

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS, extraHeaders || {}),
  });
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function parseIds(url) {
  const raw = (url.searchParams.get('ids') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set(raw)].slice(0, MAX_IDS).filter((id) => ID_RE.test(id));
}
function withTotal(agg) {
  const b = (agg && agg.broken) || 0, m = (agg && agg.missing) || 0, w = (agg && agg.wrong) || 0;
  return { broken: b, missing: m, wrong: w, total: b + m + w };
}
function stringValue(value, max) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.slice(0, max || 1000);
}
function isoValue(value) {
  const s = stringValue(value, 64);
  if (!s) return '';
  const date = new Date(s);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}
function cleanUrl(value) {
  const s = stringValue(value, 500);
  if (!s) return '';
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch (_) {
    return '';
  }
}
function sanitizeNotice(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = stringValue(raw.id, 81);
  const type = stringValue(raw.type, 20).toLowerCase();
  const title = stringValue(raw.title, 120);
  const message = stringValue(raw.message, 1200);
  if (!NOTICE_ID_RE.test(id) || !NOTICE_TYPES[type] || !title || !message) return null;
  const notice = {
    id,
    type,
    active: raw.active === true,
    title,
    message,
  };
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
function sanitizeNotices(value) {
  const raw = Array.isArray(value) ? value : (value && Array.isArray(value.notices) ? value.notices : []);
  const out = [];
  for (const item of raw.slice(0, 20)) {
    const notice = sanitizeNotice(item);
    if (notice) out.push(notice);
  }
  return out;
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
    return Object.assign({}, notice, { updatedAt: changed ? now : (previous.updatedAt || previousUpdatedAt || now) });
  });
}
async function readNoticeState(env) {
  let state = null;
  try { state = JSON.parse((await env.BADGES.get(NOTICE_KV_KEY)) || 'null'); } catch (_) {}
  const notices = sanitizeNotices(state);
  return {
    notices: notices.length ? notices : defaultNotices(),
    updatedAt: state && typeof state.updatedAt === 'string' ? state.updatedAt : null,
  };
}
function adminAuthorized(request, env) {
  const token = env.CDL_NOTICE_ADMIN_TOKEN || '';
  if (!token) return false;
  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  const supplied = (bearer && bearer[1]) || request.headers.get('X-CDL-Admin') || '';
  return supplied === token;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;
    if (!env.BADGES) return json({ error: 'KV not bound' }, 500);

    // ── Tenure badge ──────────────────────────────────────────────────────────
    if (path === '/v1/seen') {
      if (request.method === 'POST') {
        let body; try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400); }
        const id = body && typeof body.id === 'string' ? body.id.toLowerCase() : '';
        if (!ID_RE.test(id)) return json({ error: 'bad id' }, 400);
        let first = await env.BADGES.get(id);
        if (!first) { first = todayISO(); await env.BADGES.put(id, first); }
        return json({ id, first });
      }
      if (request.method === 'GET') {
        const ids = parseIds(url);
        const out = {};
        await Promise.all(ids.map(async (id) => { out[id] = (await env.BADGES.get(id)) || null; }));
        return json(out);
      }
      return json({ error: 'method not allowed' }, 405);
    }

    // ── Remote user notices ───────────────────────────────────────────────────
    if (path === '/v1/notices') {
      if (request.method === 'GET') {
        const state = await readNoticeState(env);
        if (url.searchParams.get('admin') === '1') {
          if (!adminAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
          return json(state, 200, { 'Cache-Control': 'no-store' });
        }
        return json({
          notices: state.notices.filter((notice) => notice.active),
          updatedAt: state.updatedAt,
        }, 200, { 'Cache-Control': 'no-store' });
      }
      if (request.method === 'PUT') {
        if (!adminAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
        let body; try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400); }

        let notices;
        const now = new Date().toISOString();
        const previousState = await readNoticeState(env);
        if (Array.isArray(body) || Array.isArray(body.notices)) {
          notices = mergeNoticeRevisions(sanitizeNotices(body), previousState.notices, now, previousState.updatedAt);
        } else if (body && typeof body === 'object') {
          notices = previousState.notices.map((notice) => Object.assign({}, notice));
          const id = stringValue(body.id, 81);
          const idx = notices.findIndex((notice) => notice.id === id);
          if (idx < 0 || typeof body.active !== 'boolean') return json({ error: 'bad notice update' }, 400);
          notices[idx].active = body.active;
          notices = mergeNoticeRevisions(notices, previousState.notices, now, previousState.updatedAt);
        } else {
          return json({ error: 'bad request' }, 400);
        }

        if (!notices.length) return json({ error: 'no valid notices' }, 400);
        const state = { updatedAt: now, notices };
        await env.BADGES.put(NOTICE_KV_KEY, JSON.stringify(state));
        return json(state, 200, { 'Cache-Control': 'no-store' });
      }
      return json({ error: 'method not allowed' }, 405);
    }

    // ── Crowd quality flags ───────────────────────────────────────────────────
    if (path === '/v1/flag' && request.method === 'POST') {
      let body; try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400); }
      const chapter = body && typeof body.chapter === 'string' ? body.chapter.toLowerCase() : '';
      const user = body && typeof body.user === 'string' ? body.user.toLowerCase() : '';
      const type = body && body.type;
      if (!ID_RE.test(chapter) || !ID_RE.test(user) || !FLAG_TYPES[type]) return json({ error: 'bad request' }, 400);
      const marker = 'flagu:' + chapter + ':' + user;
      const aggKey = 'flag:' + chapter;
      let agg = {}; try { agg = JSON.parse((await env.BADGES.get(aggKey)) || '{}') || {}; } catch (_) {}
      const already = await env.BADGES.get(marker);
      if (!already) {
        agg[type] = (agg[type] || 0) + 1;
        await env.BADGES.put(aggKey, JSON.stringify({ broken: agg.broken || 0, missing: agg.missing || 0, wrong: agg.wrong || 0 }));
        await env.BADGES.put(marker, '1', { expirationTtl: FLAG_MARKER_TTL });
      }
      return json({ chapter, counts: withTotal(agg), flagged: true });
    }
    if (path === '/v1/flags' && request.method === 'GET') {
      const ids = parseIds(url);
      const out = {};
      await Promise.all(ids.map(async (id) => {
        const v = await env.BADGES.get('flag:' + id);
        out[id] = v ? withTotal(JSON.parse(v)) : null;
      }));
      return json(out);
    }

    return json({ error: 'not found' }, 404);
  },
};
