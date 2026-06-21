/**
 * extract-bridge.js — runs at document_start in the page's MAIN world on comix.to.
 *
 * Makes background (unfocused) chapter extraction fast and reliable.
 *
 * The extension extracts a chapter by opening it in a BACKGROUND tab (active:false).
 * The new comix.to reader only loads page images as they are scrolled into view, and
 * the browser heavily throttles that rendering (layout / IntersectionObserver / rAF)
 * in unfocused tabs — so a scroll-based extraction crawls and times out unless the
 * user keeps the tab focused.
 *
 * But the reader also fetches an encrypted chapters API on load and decrypts it to a
 * JSON page list — and that is plain JS work (a fetch + a decrypt), NOT gated on
 * rendering. The decrypted JSON is produced through TextDecoder, so we grab it the
 * moment it appears. That gives every page URL (normal AND scrambled) in ~1s with no
 * scrolling at all, fully in the background. background.js reads window.__cdlPages.
 *
 * Scoped to ONLY the extension's throwaway extraction tabs via the #cdlx marker that
 * background.js appends to their URL — it never hooks anything on a page the user is
 * actually reading. Must run at document_start so it wraps TextDecoder before the
 * reader decrypts.
 */
(function () {
  'use strict';
  try {
    if (!/cdlx/.test(location.hash)) return;

    // ── Capture the decrypted page list ──────────────────────────────────────────
    const tryCapture = (s) => {
      if (window.__cdlPages || typeof s !== 'string' || s.length < 200 || s.indexOf('"pages"') === -1) return;
      try {
        const j = JSON.parse(s);
        const r = (j && j.result) || j;
        const p = r && r.pages;
        const items = p && Array.isArray(p.items) ? p.items : (Array.isArray(p) ? p : null);
        if (!items || !items.length) return;
        const base = (p && p.baseUrl) || '';
        const out = [];
        for (let i = 0; i < items.length; i++) {
          const u = items[i] && items[i].url;
          if (typeof u === 'string' && u) out.push({ src: /^https?:/i.test(u) ? u : (base + u), index: i + 1 });
        }
        if (out.length) window.__cdlPages = out;
      } catch (_) {}
    };
    const TD = window.TextDecoder && window.TextDecoder.prototype;
    if (TD && TD.decode) {
      const orig = TD.decode;
      TD.decode = function () { const r = orig.apply(this, arguments); try { tryCapture(r); } catch (_) {} return r; };
    }
    // Fallback path in case decryption goes through atob() instead of TextDecoder.
    if (typeof window.atob === 'function') {
      const oa = window.atob;
      window.atob = function (x) { const r = oa.apply(this, arguments); try { tryCapture(r); } catch (_) {} return r; };
    }

    // ── Report visible ───────────────────────────────────────────────────────────
    // The reader may defer the chapters fetch while it believes the tab is hidden;
    // making it think it is visible keeps the page list arriving promptly.
    const def = (k, v) => { try { Object.defineProperty(document, k, { configurable: true, get: () => v }); } catch (_) {} };
    def('hidden', false);
    def('visibilityState', 'visible');
    def('webkitHidden', false);
    def('webkitVisibilityState', 'visible');
    const swallow = (e) => { e.stopImmediatePropagation(); };
    ['visibilitychange', 'webkitvisibilitychange', 'blur'].forEach((ev) => {
      try { document.addEventListener(ev, swallow, true); } catch (_) {}
      try { window.addEventListener(ev, swallow, true); } catch (_) {}
    });
  } catch (_) {}
})();
