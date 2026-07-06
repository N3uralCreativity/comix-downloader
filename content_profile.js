/**
 * content_profile.js — Comix-Downloader "tenure badge" on comix profiles (v3.0.0).
 *
 * Shows a small badge next to the name on a comix profile page (`/u/{hashId}`) that, on
 * hover, says how long that person has been a Comix-Downloader user. Only other people
 * who ALSO have the extension see it. This is a built-in, always-on part of the
 * extension (no setting / not disableable) — having the extension IS the badge.
 *
 * The badge data is shared via a tiny free backend (see worker/): the background
 * service worker registers the current user (server-timestamped first-seen) and looks
 * up other users' first-seen dates — keyed by an opaque salted hash of the (public)
 * comix id, plus a coarse date. Pure logic lives in cdl-badge-core.js (CDLBadgeCore);
 * SPA-gated like content_home.js.
 *
 * Isolated world, loaded after content_features.js, SPA-aware via `cdl:locationchange`.
 */
(function () {
  'use strict';
  if (window.top !== window) return;
  var Core = (typeof CDLBadgeCore !== 'undefined') ? CDLBadgeCore : null;
  if (!Core) return;

  var BADGE_ID = 'cdl-tenure-badge';
  var DEV_ID = 'cdl-dev-badge';
  var STYLE_ID = 'cdl-badge-style';
  var registered = false, curHash = null, observer = null, debounce = null, resolved = null;

  // ── tiny DOM builders ──────────────────────────────────────────────────────
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else n.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  // SVG glyphs: download arrow (tenure) and code `< >` (dev).
  function svgIcon(paths) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '13'); s.setAttribute('height', '13');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2.4');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    paths.forEach(function (p) { var el2 = document.createElementNS(ns, p[0]); el2.setAttribute(p[0] === 'polyline' ? 'points' : 'd', p[1]); s.appendChild(el2); });
    return s;
  }
  function mark() {
    // The "Angle Tray" brand mark (icons/icon.svg), filled with currentColor.
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '13'); s.setAttribute('height', '13');
    s.setAttribute('fill', 'currentColor');
    var g = document.createElementNS(ns, 'polygon');
    g.setAttribute('points', '10,2.6 14,2.6 14,8.6 18.8,8.6 12,15.8 5.2,8.6 10,8.6');
    s.appendChild(g);
    var t = document.createElementNS(ns, 'path');
    t.setAttribute('d', 'M3 16.8 6.2 20h11.6l3.2-3.2v4.8H3z');
    s.appendChild(t);
    return s;
  }
  function devIcon() { return svgIcon([['polyline', '8 7 3 12 8 17'], ['polyline', '16 7 21 12 16 17']]); }

  function bg(action, payload) {
    return new Promise(function (resolve) {
      try { chrome.runtime.sendMessage(Object.assign({ action: action }, payload || {}), function (r) { resolve(r || {}); }); }
      catch (_) { resolve({}); }
    });
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var both = '#' + BADGE_ID + ',#' + DEV_ID;
    // Expand a descendant/pseudo suffix across BOTH badge ids — a plain `both + ' .x'`
    // would mis-parse as `#a` + `#b .x` and wrongly style the first badge itself.
    var ea = function (suffix) { return '#' + BADGE_ID + suffix + ',#' + DEV_ID + suffix; };
    var css =
      both + '{display:inline-flex;align-items:center;gap:4px;vertical-align:middle;margin-left:10px;' +
        'padding:3px 8px 3px 6px;border-radius:6px;line-height:1;cursor:default;position:relative;' +
        'font-size:11px;font-weight:800;letter-spacing:.03em;font-family:inherit;}' +
      ea(' svg') + '{display:block;flex:0 0 auto;}' +
      // tenure = accent (cyan); dev = gold, to stand apart
      '#' + BADGE_ID + '{color:var(--accent,#66e8fa);background:rgba(var(--accent-rgb,102 232 250)/.14);border:1px solid rgba(var(--accent-rgb,102 232 250)/.34);}' +
      '#' + DEV_ID + '{color:#f2c14e;background:rgba(242,193,78,.15);border:1px solid rgba(242,193,78,.42);}' +
      ea(' .cdl-chip-tip') + '{position:absolute;left:50%;top:calc(100% + 9px);' +
        'transform:translateX(-50%) translateY(4px);background:var(--bg-2,#1f2226);color:var(--text,#cdd5d6);' +
        'border:1px solid var(--surface-3,#3a4248);border-radius:4px;padding:7px 11px;font-size:12px;font-weight:600;' +
        'white-space:nowrap;box-shadow:0 10px 28px rgba(0,0,0,.5);opacity:0;pointer-events:none;' +
        'transition:opacity .13s ease,transform .13s ease;z-index:2147483647;}' +
      ea(' .cdl-chip-tip::before') + '{content:"";position:absolute;left:50%;top:-5px;width:9px;height:9px;' +
        'transform:translateX(-50%) rotate(45deg);background:var(--bg-2,#1f2226);border-left:1px solid var(--surface-3,#3a4248);border-top:1px solid var(--surface-3,#3a4248);}' +
      ea(':hover .cdl-chip-tip') + ',' + ea(':focus .cdl-chip-tip') + '{opacity:1;transform:translateX(-50%) translateY(0);}';
    var st = el('style', { id: STYLE_ID }); st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  function buildChip(id, opt) {
    ensureStyle();
    var tip = opt.tip || opt.label;
    return el('span', { id: id, tabindex: '0', role: 'note', 'aria-label': tip, title: tip }, [
      opt.icon,
      el('span', { class: 'cdl-chip-label', text: opt.label }),
      el('span', { class: 'cdl-chip-tip', text: tip })
    ]);
  }

  function removeBadges() {
    [BADGE_ID, DEV_ID].forEach(function (id) { var b = document.getElementById(id); if (b) b.remove(); });
  }

  // Find the profile name heading (anchor by the displayName text, robust to hashed
  // classes), falling back to the first H1.
  function findNameHeading(name) {
    if (name) {
      var norm = String(name).trim().toLowerCase();
      var heads = document.querySelectorAll('h1, h2');
      for (var i = 0; i < heads.length; i++) {
        if ((heads[i].textContent || '').trim().toLowerCase() === norm) return heads[i];
      }
    }
    return document.querySelector('h1');
  }
  function insertChip(name, chip) {
    if (document.getElementById(chip.id)) return true;
    var anchor = findNameHeading(name); if (!anchor) return false;
    anchor.appendChild(chip); return true;
  }

  // Insert whichever badges apply from the resolved data (idempotent; retried by the observer
  // until the name heading exists). Dev badge (hardcoded) first, then the tenure badge.
  function tryInsert() {
    if (!resolved || resolved.hid !== curHash) return;
    if (resolved.devLabel && !document.getElementById(DEV_ID)) {
      insertChip(resolved.name, buildChip(DEV_ID, { icon: devIcon(), label: 'DEV', tip: resolved.devLabel }));
    }
    if (resolved.tenure && !document.getElementById(BADGE_ID)) {
      insertChip(resolved.name, buildChip(BADGE_ID, { icon: mark(), label: 'CDL', tip: 'Comix-Downloader user · ' + resolved.tenure }));
    }
  }

  function renderBadge() {
    var hid = Core.profileHashFromPath(location.pathname);
    if (!hid) { removeBadges(); resolved = null; curHash = null; return; }
    if (curHash !== hid) { removeBadges(); curHash = hid; resolved = null; }
    if (resolved === 'pending') return;
    if (resolved && resolved.hid === hid) { tryInsert(); return; } // cached → just (re)place
    resolved = 'pending';
    // Resolve canonical hashId + displayName (the URL segment IS the hashId on comix, but the
    // API also normalises username URLs). The dev badge is hardcoded (no network); the tenure
    // badge comes from the worker.
    fetch('/api/v1/users/' + encodeURIComponent(hid), { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(function (r) { return (r.ok && /json/i.test(r.headers.get('content-type') || '')) ? r.json() : null; })
      .then(function (j) { var u = j && j.result; finishResolve(hid, (u && (u.hashId || u.hid)) ? String(u.hashId || u.hid) : hid, (u && (u.displayName || u.username)) || null); })
      .catch(function () { finishResolve(hid, hid, null); });
  }
  function finishResolve(hid, canon, name) {
    if (curHash !== hid) { resolved = null; return; }
    var sp = Core.specialBadge(canon);
    resolved = { hid: hid, canon: canon, name: name, devLabel: sp ? sp.label : '', tenure: '' };
    tryInsert();
    bg('cdlBadgeLookup', { hashId: canon }).then(function (r) {
      if (!resolved || resolved.hid !== hid || curHash !== hid) return;
      resolved.tenure = (r && r.ok && r.first) ? Core.formatTenure(r.first) : '';
      tryInsert();
    });
  }

  // Register the current user once per page load (background throttles to ~once/day).
  function registerSelf() {
    if (registered) return;
    registered = true;
    fetch('/api/v1/user', { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(function (r) { return (r.ok && /json/i.test(r.headers.get('content-type') || '')) ? r.json() : null; })
      .then(function (j) { var u = j && j.result; var hid = u && (u.hashId || u.hid); if (hid) bg('cdlBadgeRegister', { hashId: String(hid) }); })
      .catch(function () {});
  }

  function ensureObserver() {
    if (observer) return;
    observer = new MutationObserver(function () {
      if (debounce) return;
      debounce = setTimeout(function () { debounce = null; if (Core.isProfilePath(location.pathname)) renderBadge(); }, 300);
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    if (debounce) { clearTimeout(debounce); debounce = null; }
  }

  function teardown() {
    stopObserver(); removeBadges();
    var st = document.getElementById(STYLE_ID); if (st) st.remove();
    curHash = null; resolved = null;
  }

  function sync() {
    registerSelf();
    // Diagnostic marker (harmless): lets `document.documentElement.dataset.cdlProfile` report
    // whether this script is loaded and its state — active (on a profile) | idle (elsewhere).
    try {
      document.documentElement.setAttribute('data-cdl-profile',
        Core.isProfilePath(location.pathname) ? 'active' : 'idle');
    } catch (_) {}
    if (Core.isProfilePath(location.pathname)) { renderBadge(); ensureObserver(); }
    else teardown();
  }

  function boot() {
    sync();
    var lastPath = location.pathname;
    var onRoute = function () { if (location.pathname === lastPath) return; lastPath = location.pathname; curHash = null; resolved = null; removeBadges(); sync(); };
    window.addEventListener('cdl:locationchange', onRoute);
    window.addEventListener('popstate', onRoute);
    window.addEventListener('hashchange', onRoute);
    window.addEventListener('pageshow', function (e) { if (e.persisted) sync(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
