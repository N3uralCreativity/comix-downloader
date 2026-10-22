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
 * scrolling at all, fully in the background. Results stay in this closure until
 * background.js requests them through a synchronous, page-local event.
 *
 * Scoped to ONLY the extension's throwaway extraction tabs via the #cdlx marker that
 * background.js appends to their URL — it never hooks anything on a page the user is
 * actually reading. Must run at document_start so it wraps TextDecoder before the
 * reader decrypts.
 */
(function () {
  'use strict';

  try {
    if (location.hash !== '#cdlx') return;
    // Keep the legacy extraction bootstrap, but do not leave its marker in the URL.
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch (_) {}
    let capturedPages = null;
    window.addEventListener('cdl:extract-pages', function (event) {
      if (capturedPages && event.detail && typeof event.detail === 'object') {
        event.detail.pages = capturedPages.map(function (page) { return { src: page.src, index: page.index }; });
      }
    });

    // ── Capture the decrypted page list ──────────────────────────────────────────
    const tryCapture = (s) => {
      if (capturedPages || typeof s !== 'string' || s.length < 200 || s.indexOf('"pages"') === -1) return;
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
        if (out.length) { capturedPages = out; restoreDecoders(); }
      } catch (_) {}
    };
    const TD = window.TextDecoder && window.TextDecoder.prototype;
    const nativeDecode = TD && TD.decode;
    const nativeAtob = window.atob;
    let decodeHook, atobHook;
    function restoreDecoders() {
      if (TD && TD.decode === decodeHook) TD.decode = nativeDecode;
      if (window.atob === atobHook) window.atob = nativeAtob;
    }
    if (TD && TD.decode) {
      const orig = TD.decode;
      decodeHook = function () { const r = orig.apply(this, arguments); try { tryCapture(r); } catch (_) {} return r; };
      TD.decode = decodeHook;
    }
    // Fallback path in case decryption goes through atob() instead of TextDecoder.
    if (typeof window.atob === 'function') {
      const oa = window.atob;
      atobHook = function (x) { const r = oa.apply(this, arguments); try { tryCapture(r); } catch (_) {} return r; };
      window.atob = atobHook;
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
