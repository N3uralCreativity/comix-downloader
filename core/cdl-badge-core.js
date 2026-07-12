/**
 * cdl-badge-core.js — Comix-Downloader "tenure badge" pure logic (v3.0.0)
 *
 * DOM-free, window-free, chrome-free. Loaded as a classic script that attaches
 * `globalThis.CDLBadgeCore`, AND exported via module.exports so the same file is
 * unit-testable under plain `node` (mirrors cdl-home-core.js / settings.js).
 *
 * The badge shows, on another user's comix profile, how long they've been a
 * Comix-Downloader user. This module owns the *pure* parts:
 *   - profileHashFromPath / isProfilePath : recognise comix profile routes `/u/{hashId}`.
 *   - formatTenure : turn a "first seen" date into a coarse human label
 *                    (days → weeks → months → years).
 *
 * The impure parts (hashing the id with crypto.subtle, the network calls, the DOM)
 * live in background.js / content_profile.js.
 */
(function (global) {
  'use strict';

  // comix profile pages are `/u/{hashId}` (confirmed from /api/v1/users/{hashId}.url).
  // The hashId is alphanumeric; tolerate an optional `-slug` suffix and a trailing slash.
  var PROFILE_RE = /^\/u\/([a-z0-9]+)(?:-[^/?#]*)?\/?$/i;

  function profileHashFromPath(pathname) {
    var m = String(pathname == null ? '' : pathname).match(PROFILE_RE);
    return m ? m[1] : null;
  }
  function isProfilePath(pathname) {
    return profileHashFromPath(pathname) != null;
  }

  // Hardcoded role badges, keyed by comix profile hashId. Shown to every extension user
  // with NO backend (baked into the extension). `label` is the hover/full text; `short` is
  // the compact chip text. Add collaborators here as needed.
  var SPECIAL_BADGES = {
    l0v2e: { label: 'Comix-Downloader Dev', short: 'DEV', kind: 'dev' } // Yse3ra (author)
  };
  function specialBadge(hashId) {
    if (hashId == null || hashId === '') return null;
    return SPECIAL_BADGES[String(hashId)] || null;
  }

  function _plural(n, unit) { return n + ' ' + unit + (n === 1 ? '' : 's'); }

  /**
   * Coarse "member for …" label from an ISO date (or epoch ms) of first contact.
   *   0 days        → "today"
   *   1–6 days      → "N day(s)"
   *   7–59 days     → "N week(s)"   (rounded)
   *   60–364 days   → "N month(s)"  (~30.4-day months)
   *   365+ days     → "N year(s)"
   * `nowMs` defaults to Date.now(); returns '' for an unparseable/empty/future input.
   */
  function formatTenure(first, nowMs) {
    if (first == null || first === '') return '';
    var t = (typeof first === 'number') ? first : Date.parse(first);
    if (!isFinite(t)) return '';
    var now = (nowMs == null) ? Date.now() : nowMs;
    var days = Math.floor((now - t) / 86400000);
    if (days < 0) days = 0;
    if (days === 0) return 'today';
    if (days < 7) return _plural(days, 'day');
    if (days < 60) return _plural(Math.round(days / 7), 'week');
    if (days < 365) return _plural(Math.round(days / 30.4), 'month');
    return _plural(Math.floor(days / 365), 'year');
  }

  var CDLBadgeCore = {
    SPECIAL_BADGES: SPECIAL_BADGES,
    specialBadge: specialBadge,
    profileHashFromPath: profileHashFromPath,
    isProfilePath: isProfilePath,
    formatTenure: formatTenure
  };

  global.CDLBadgeCore = CDLBadgeCore;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CDLBadgeCore; // for Node-based unit tests
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
