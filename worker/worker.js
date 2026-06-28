/**
 * Comix-Downloader badge service — Cloudflare Worker (free tier).
 *
 * Stores, per extension user, the date the service FIRST heard from them, so other
 * extension users can see "Comix-Downloader user · N months" on their comix profile.
 *
 * Privacy/safety by design:
 *   - The key is an OPAQUE salted hash of the comix user id (the extension hashes it
 *     client-side); raw comix ids are never sent or stored.
 *   - The "first seen" date is set by THIS server on first contact and never overwritten,
 *     so a client cannot back-date or forge its tenure.
 *   - Only a coarse YYYY-MM-DD date is stored — no other PII.
 *
 * Bind a KV namespace named `BADGES` (see wrangler.toml). Endpoints:
 *   POST /v1/seen           body {"id":"<hash>"}        -> {"id","first":"YYYY-MM-DD"}
 *   GET  /v1/seen?ids=a,b,c (<=50 hashes, comma-sep)    -> {"a":"YYYY-MM-DD","b":null,...}
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};
const MAX_IDS = 50;
const ID_RE = /^[a-f0-9]{8,64}$/; // hex hash only

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
  });
}
function todayISO() { return new Date().toISOString().slice(0, 10); }

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    if (url.pathname !== '/v1/seen') return json({ error: 'not found' }, 404);
    if (!env.BADGES) return json({ error: 'KV not bound' }, 500);

    // Register / read-own: record first-seen for a single hashed id (server-timestamped).
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400); }
      const id = body && typeof body.id === 'string' ? body.id.toLowerCase() : '';
      if (!ID_RE.test(id)) return json({ error: 'bad id' }, 400);
      let first = await env.BADGES.get(id);
      if (!first) { first = todayISO(); await env.BADGES.put(id, first); } // never overwrite
      return json({ id, first });
    }

    // Batch lookup of other users' first-seen dates.
    if (request.method === 'GET') {
      const raw = (url.searchParams.get('ids') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const ids = [...new Set(raw)].slice(0, MAX_IDS).filter((id) => ID_RE.test(id));
      const out = {};
      await Promise.all(ids.map(async (id) => { out[id] = (await env.BADGES.get(id)) || null; }));
      return json(out);
    }

    return json({ error: 'method not allowed' }, 405);
  },
};
