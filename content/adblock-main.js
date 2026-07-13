/**
 * adblock-main.js - comix.to-specific popup and click-overlay protection.
 *
 * Runs at document_start in the page's MAIN world so site/ad scripts receive the
 * guarded window.open. The isolated adblock-control.js content script relays the
 * stored setting through a DOM attribute + event; page code never receives access
 * to extension storage.
 */
(function (root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CDLAdblock = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var STATE_ATTR = 'data-cdl-adblock';
  var STATE_EVENT = 'cdl:adblock-state';
  var INTENT_MAX_AGE_MS = 1500;
  var SHARE_HOSTS = [
    'facebook.com', 'messenger.com', 'twitter.com', 'x.com',
    'reddit.com', 'whatsapp.com', 'telegram.me', 't.me'
  ];

  function parseUrl(value, baseUrl) {
    if (value == null || value === '') return null;
    try { return new URL(String(value), baseUrl); } catch (_) { return null; }
  }

  function hostMatches(hostname, expected) {
    return hostname === expected || hostname.endsWith('.' + expected);
  }

  function isKnownShareUrl(url) {
    if (!url || !/^https?:$/.test(url.protocol)) return false;
    return SHARE_HOSTS.some(function (host) { return hostMatches(url.hostname, host); });
  }

  function sameDestination(a, b) {
    if (!a || !b) return false;
    return a.href === b.href;
  }

  /**
   * Allow only popups that match the link the user deliberately clicked, plus
   * comix.to's named social-share popup. A click elsewhere opening an unrelated
   * destination is the site's intermittent ad/popunder behavior.
   */
  function shouldAllowPopup(input) {
    input = input || {};
    if (!input.trusted || input.ageMs < 0 || input.ageMs > INTENT_MAX_AGE_MS) return false;

    var destination = parseUrl(input.url, input.pageUrl);
    if (!destination) return false;

    var clicked = parseUrl(input.clickHref, input.pageUrl);
    if (clicked && sameDestination(destination, clicked)) return true;

    return input.targetName === 'share-window' && isKnownShareUrl(destination);
  }

  function opensNewContext(targetName) {
    var target = String(targetName || '').toLowerCase();
    return !!target && target !== '_self' && target !== '_top' && target !== '_parent';
  }

  /** Block ad scripts that create an external anchor and invoke .click(). */
  function shouldBlockProgrammaticAnchor(input) {
    input = input || {};
    if (!opensNewContext(input.targetName) || input.download) return false;

    var destination = parseUrl(input.href, input.pageUrl);
    var page = parseUrl(input.pageUrl, input.pageUrl);
    if (!destination || !page || !/^https?:$/.test(destination.protocol)) return false;
    if (destination.origin === page.origin) return false;

    var clicked = parseUrl(input.clickHref, input.pageUrl);
    return !(input.trusted && input.ageMs >= 0 && input.ageMs <= INTENT_MAX_AGE_MS &&
      clicked && sameDestination(destination, clicked));
  }

  /** Detect the transparent, viewport-sized external anchors used by click ads. */
  function isSuspiciousOverlay(input) {
    input = input || {};
    var destination = parseUrl(input.href, input.pageUrl);
    var page = parseUrl(input.pageUrl, input.pageUrl);
    if (!destination || !page || !/^https?:$/.test(destination.protocol)) return false;
    if (destination.origin === page.origin) return false;

    var rect = input.rect || {};
    var viewport = input.viewport || {};
    var vw = Math.max(1, Number(viewport.width) || 0);
    var vh = Math.max(1, Number(viewport.height) || 0);
    var width = Math.max(0, Number(rect.width) || 0);
    var height = Math.max(0, Number(rect.height) || 0);
    var areaRatio = (width * height) / (vw * vh);
    var broad = areaRatio >= 0.3 || (width >= vw * 0.85 && height >= vh * 0.25);
    var positioned = /^(fixed|absolute|sticky)$/.test(String(input.position || '').toLowerCase());
    var opacity = Number(input.opacity);
    if (!isFinite(opacity)) opacity = 1;
    var zIndex = parseInt(input.zIndex, 10);
    if (!isFinite(zIndex)) zIndex = 0;
    var disguised = opacity <= 0.15 || (!input.hasVisibleContent && zIndex >= 1000);

    return broad && positioned && disguised;
  }

  function install(win) {
    if (!win || !win.document || win.__cdlAdblockInstalled) return;
    win.__cdlAdblockInstalled = true;

    var doc = win.document;
    var enabled = true;
    var lastIntent = { trusted: false, time: 0, href: '' };

    function syncState() {
      var html = doc.documentElement;
      enabled = !html || html.getAttribute(STATE_ATTR) !== 'off';
    }

    function closestElement(target, selector) {
      if (!target) return null;
      var node = target.nodeType === 1 ? target : target.parentElement;
      try { return node && node.closest ? node.closest(selector) : null; } catch (_) { return null; }
    }

    function overlayInput(anchor) {
      if (!anchor || !anchor.getBoundingClientRect) return null;
      var rect = anchor.getBoundingClientRect();
      var style;
      try { style = win.getComputedStyle(anchor); } catch (_) { style = {}; }
      var text = String(anchor.textContent || '').trim();
      var media = null;
      try { media = anchor.querySelector('img, picture, video, canvas, svg'); } catch (_) {}
      return {
        href: anchor.href || anchor.getAttribute('href') || '',
        pageUrl: win.location.href,
        rect: { width: rect.width, height: rect.height },
        viewport: { width: win.innerWidth, height: win.innerHeight },
        position: style.position || '',
        opacity: style.opacity,
        zIndex: style.zIndex,
        hasVisibleContent: !!(text || media)
      };
    }

    function isOverlay(anchor) {
      return !!anchor && isSuspiciousOverlay(overlayInput(anchor));
    }

    function recordIntent(event) {
      if (!event || !event.isTrusted) return;
      if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
      var anchor = closestElement(event.target, 'a[href]');
      lastIntent = {
        trusted: true,
        time: Date.now(),
        href: anchor && !isOverlay(anchor) ? (anchor.href || anchor.getAttribute('href') || '') : ''
      };
    }

    function currentIntent() {
      return {
        trusted: !!lastIntent.trusted,
        ageMs: lastIntent.time ? Date.now() - lastIntent.time : Infinity,
        clickHref: lastIntent.href || ''
      };
    }

    function reportBlocked() {
      try { win.dispatchEvent(new Event('cdl:adblocked')); } catch (_) {}
    }

    syncState();
    try { win.addEventListener(STATE_EVENT, syncState, false); } catch (_) {}
    try {
      if (win.MutationObserver && doc.documentElement) {
        var stateObserver = new win.MutationObserver(syncState);
        stateObserver.observe(doc.documentElement, {
          attributes: true,
          attributeFilter: [STATE_ATTR]
        });
      }
    } catch (_) {}
    ['pointerdown', 'mousedown', 'touchstart', 'click', 'keydown'].forEach(function (type) {
      try { win.addEventListener(type, recordIntent, true); } catch (_) {}
    });

    var nativeOpen = win.open;
    if (typeof nativeOpen === 'function' && !nativeOpen.__cdlAdblockGuard) {
      var guardedOpen = function (url, targetName, features) {
        if (!enabled) return nativeOpen.apply(win, arguments);
        var intent = currentIntent();
        var allowed = shouldAllowPopup({
          url: url,
          targetName: String(targetName || ''),
          features: String(features || ''),
          pageUrl: win.location.href,
          clickHref: intent.clickHref,
          trusted: intent.trusted,
          ageMs: intent.ageMs
        });
        if (allowed) return nativeOpen.apply(win, arguments);
        reportBlocked();
        return null;
      };
      guardedOpen.__cdlAdblockGuard = true;
      guardedOpen.__cdlNative = nativeOpen;
      try { win.open = guardedOpen; } catch (_) {}
    }

    var Anchor = win.HTMLAnchorElement;
    var anchorProto = Anchor && Anchor.prototype;
    var nativeAnchorClick = anchorProto && anchorProto.click;
    if (typeof nativeAnchorClick === 'function' && !nativeAnchorClick.__cdlAdblockGuard) {
      var guardedAnchorClick = function () {
        if (enabled) {
          var intent = currentIntent();
          var blocked = shouldBlockProgrammaticAnchor({
            href: this.href || this.getAttribute('href') || '',
            targetName: this.target || this.getAttribute('target') || '',
            download: !!(this.download || this.hasAttribute('download')),
            pageUrl: win.location.href,
            clickHref: intent.clickHref,
            trusted: intent.trusted,
            ageMs: intent.ageMs
          });
          if (blocked) {
            reportBlocked();
            return;
          }
        }
        return nativeAnchorClick.apply(this, arguments);
      };
      guardedAnchorClick.__cdlAdblockGuard = true;
      guardedAnchorClick.__cdlNative = nativeAnchorClick;
      try { anchorProto.click = guardedAnchorClick; } catch (_) {}
    }

    function blockOverlayClick(event) {
      if (!enabled || !event) return;
      var anchor = closestElement(event.target, 'a[href]');
      if (!isOverlay(anchor)) return;
      try { event.preventDefault(); } catch (_) {}
      try { event.stopImmediatePropagation(); } catch (_) {}
      reportBlocked();
      try { anchor.remove(); } catch (_) {}
    }

    try { doc.addEventListener('click', blockOverlayClick, true); } catch (_) {}
    try { doc.addEventListener('auxclick', blockOverlayClick, true); } catch (_) {}

  }

  return {
    STATE_ATTR: STATE_ATTR,
    STATE_EVENT: STATE_EVENT,
    INTENT_MAX_AGE_MS: INTENT_MAX_AGE_MS,
    shouldAllowPopup: shouldAllowPopup,
    shouldBlockProgrammaticAnchor: shouldBlockProgrammaticAnchor,
    isSuspiciousOverlay: isSuspiciousOverlay,
    install: install
  };
});
