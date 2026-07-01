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
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};
const MAX_IDS = 50;
const ID_RE = /^[a-f0-9]{8,64}$/;            // hex hash only
const FLAG_TYPES = { broken: 1, missing: 1, wrong: 1 };
const FLAG_MARKER_TTL = 400 * 24 * 3600;     // per-user-per-chapter dedup marker lifetime (~400d)

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
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
