(function (global, factory) {
  'use strict';
  var api = factory(global);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CDLPlusUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (global) {
  'use strict';

  var STYLE_ID = 'cdl-plus-ui-style';
  var DATA_PERMISSIONS = ['personallyIdentifyingInfo', 'authenticationInfo', 'browsingActivity', 'websiteContent', 'technicalAndInteraction'];
  // Same rule as core/plus-core.js, which the popup does not load: three-part versions are public releases.
  var PUBLIC_RELEASE = (function () {
    try { return /^\d+\.\d+\.\d+$/.test(String(global.chrome.runtime.getManifest().version)); } catch (_) { return false; }
  })();
  var API_PERMISSION = (PUBLIC_RELEASE
    ? 'https://plus.n3uralcreativity.top'
    : 'https://plus.n3uralcreativity.top') + '/*';

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else if (key === 'onclick') node.addEventListener('click', value);
      else if (key === 'checked') node.checked = !!value;
      else if (key === 'disabled') node.disabled = !!value;
      else if (value != null) node.setAttribute(key, value);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function formatBytes(value) {
    var bytes = Number(value) || 0;
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MiB';
  }
  function formatDate(value, withTime) {
    if (!value) return 'Not yet';
    var date = new Date(value); if (!Number.isFinite(date.getTime())) return 'Not yet';
    try { return new Intl.DateTimeFormat(undefined, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(date); }
    catch (_) { return date.toLocaleString(); }
  }
  // The stat strip reads better as "4 min ago" than as an absolute stamp:
  // the question it answers is whether this device is current.
  function formatRelative(value) {
    if (!value) return 'Never';
    var stamp = new Date(value).getTime();
    if (!Number.isFinite(stamp)) return 'Never';
    var delta = Date.now() - stamp;
    if (delta < 60000) return 'Just now';
    var minutes = Math.round(delta / 60000);
    if (minutes < 60) return minutes + ' min ago';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours === 1 ? '1 hour ago' : hours + ' hours ago';
    var days = Math.round(hours / 24);
    if (days < 30) return days === 1 ? 'Yesterday' : days + ' days ago';
    return formatDate(value);
  }
  function stateLabel(state) {
    return ({ pending_checkout: 'Checkout required', trial: 'Free trial', active: 'Active', grace: 'Payment grace period', cancelled_active: 'Cancelled - active until period end', expired: 'Expired' })[state] || 'Signed out';
  }
  function tokenSource() {
    if (global.CDLPlusTokens) return global.CDLPlusTokens;
    try { if (typeof require === 'function') return require('./plus-tokens.js'); } catch (_) {}
    return null;
  }

  // The pane is styled entirely from core/plus-tokens.js so it shares one
  // visual system with the account portal and the Plus page. Tokens are scoped
  // to .cdl-plus, and surface tokens fall back to the host settings chrome so
  // the pane keeps matching whatever theme comix.to is running.
  function injectStyle() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    var Tokens = tokenSource();
    if (!Tokens) return;
    var css = [
      Tokens.tokenCss({ scope: '.cdl-plus', accentFrom: '--accent', inheritFont: true, compact: true, indent: '' }),
      '.cdl-plus{--plus-bg:var(--bg,#111416);--plus-panel:var(--panel,#1b1f22);--plus-text:inherit;--plus-muted:var(--muted,#8d969b)}',

      '.cdl-plus{position:relative;color:inherit;margin-top:0!important;padding-top:20px!important;border-top:0!important}',
      '.cdl-plus:before{content:"";position:absolute;left:0;top:0;width:36px;height:2px;background:var(--plus-accent)}',
      '.cdl-plus.is-dedicated{padding-top:0!important}',
      '.cdl-plus.is-dedicated:before{display:none}',
      '.cdl-plus-body{display:flex;flex-direction:column;gap:16px}',

      '.cdl-plus-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}',
      '.cdl-plus-titleline{display:flex;align-items:center;gap:9px;min-width:0}',
      '.cdl-plus-title{margin:0!important;font-size:var(--plus-t-md)!important;line-height:1.3;font-weight:750;color:inherit}',
      '.cdl-plus-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border:1px solid var(--plus-accent-edge);border-radius:var(--plus-radius);background:var(--plus-accent-wash);color:var(--plus-accent-hi);font:800 var(--plus-t-micro)/1 var(--plus-mono);letter-spacing:.1em;text-transform:uppercase}',
      '.cdl-plus-copy{margin:6px 0 0!important;max-width:74ch;color:var(--plus-muted)!important;font-size:var(--plus-t-sm)!important;line-height:1.55}',
      '.cdl-plus-price{flex:0 0 auto;text-align:right;color:var(--plus-muted);font-size:var(--plus-t-tiny)}',
      '.cdl-plus-price strong{display:block;color:inherit;font-size:var(--plus-t-base)}',
      '.cdl-plus-subhead{margin:0;color:var(--plus-muted);font:700 var(--plus-t-micro)/1 var(--plus-mono);letter-spacing:.12em;text-transform:uppercase}',

      '.cdl-plus-welcome{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:start}',
      '.cdl-plus-welcome h3{margin:0!important;color:inherit;font-size:var(--plus-t-lg)!important;line-height:1.25;font-weight:760}',
      '.cdl-plus-offer{text-align:right;white-space:nowrap}',
      '.cdl-plus-offer strong{display:block;color:inherit;font-size:var(--plus-t-md);line-height:1.2}',
      '.cdl-plus-offer span{display:block;margin-top:3px;color:var(--plus-muted);font-size:var(--plus-t-tiny)}',
      '.cdl-plus-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;margin:0;padding:0;list-style:none;border:1px solid var(--plus-line);background:var(--plus-line)}',
      '.cdl-plus-facts li{min-width:0;padding:11px 12px;background:var(--plus-panel)}',
      '.cdl-plus-facts strong{display:block;font-size:var(--plus-t-sm);font-weight:700;color:inherit}',
      '.cdl-plus-facts span{display:block;margin-top:3px;color:var(--plus-muted);font-size:var(--plus-t-tiny);line-height:1.45}',

      '.cdl-plus-strip{padding:11px 13px;border-left:3px solid var(--plus-accent);background:var(--plus-accent-wash);color:var(--plus-text-soft);font-size:var(--plus-t-sm);line-height:1.55}',
      '.cdl-plus-strip.error{border-left-color:var(--plus-danger);background:var(--plus-danger-wash);color:var(--plus-danger)}',
      '.cdl-plus-strip.warn{border-left-color:var(--plus-warn);background:var(--plus-warn-wash);color:var(--plus-text-soft)}',
      '.cdl-plus-error-ref{display:block;margin-top:5px;color:var(--plus-muted);font:var(--plus-t-tiny)/1.5 var(--plus-mono)}',

      '.cdl-plus-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.cdl-plus-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:var(--plus-control-h);padding:0 13px;border:1px solid var(--plus-line-hi);border-radius:var(--plus-radius);background:var(--plus-panel-hi);color:inherit;font:700 var(--plus-t-sm)/1.2 inherit;cursor:pointer;transition:background .12s ease,border-color .12s ease}',
      '.cdl-plus-btn:hover:not(:disabled){border-color:var(--plus-accent);background:var(--plus-accent-wash)}',
      '.cdl-plus-btn:focus-visible{outline:2px solid var(--plus-accent);outline-offset:1px}',
      '.cdl-plus-btn:disabled{opacity:.45;cursor:default}',
      '.cdl-plus-btn.primary{border-color:var(--plus-accent);background:var(--plus-accent);color:var(--plus-accent-ink)}',
      '.cdl-plus-btn.primary:hover:not(:disabled){border-color:var(--plus-accent-lo);background:var(--plus-accent-lo)}',
      '.cdl-plus-btn.danger{border-color:var(--plus-danger);background:var(--plus-danger-wash);color:var(--plus-danger)}',

      '.cdl-plus-auth-choice{display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;align-self:start;border:1px solid var(--plus-line-hi);border-radius:var(--plus-radius);background:var(--plus-sunken)}',
      '.cdl-plus-choice{min-height:var(--plus-control-h);padding:0 18px;border:0;border-radius:0;background:transparent;color:var(--plus-muted);font:700 var(--plus-t-sm)/1.2 inherit;cursor:pointer;transition:background .12s ease,color .12s ease}',
      '.cdl-plus-choice+.cdl-plus-choice{border-left:1px solid var(--plus-line-hi)}',
      '.cdl-plus-choice:hover{color:inherit}',
      '.cdl-plus-choice[aria-selected="true"]{background:var(--plus-accent);color:var(--plus-accent-ink)}',

      '.cdl-plus-auth{padding:16px;border:1px solid var(--plus-line);border-radius:var(--plus-radius);background:var(--plus-surface)}',
      '.cdl-plus-auth-head{margin-bottom:14px}',
      '.cdl-plus-auth-head strong{display:block;font-size:var(--plus-t-base);font-weight:750}',
      '.cdl-plus-auth-head span{display:block;margin-top:4px;color:var(--plus-muted);font-size:var(--plus-t-tiny);line-height:1.5}',
      '.cdl-plus-form{display:grid;grid-template-columns:minmax(160px,1fr) auto;gap:8px;max-width:620px}',
      '.cdl-plus-input{box-sizing:border-box;width:100%;min-width:0;min-height:var(--plus-control-h);padding:0 11px;border:1px solid var(--plus-line-hi);border-radius:var(--plus-radius);background:var(--plus-sunken);color:inherit;font:var(--plus-t-base)/1.4 inherit}',
      '.cdl-plus-input::placeholder{color:var(--plus-faint)}',
      '.cdl-plus-input:focus{outline:0;border-color:var(--plus-accent);box-shadow:inset 0 0 0 1px var(--plus-accent)}',
      '.cdl-plus-code{font:700 var(--plus-t-md)/1.3 var(--plus-mono);letter-spacing:.34em}',

      '.cdl-plus-steps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;border:1px solid var(--plus-line);background:var(--plus-line)}',
      '.cdl-plus-step{position:relative;padding:10px 12px 10px 26px;background:var(--plus-panel);color:var(--plus-muted);font-size:var(--plus-t-tiny);line-height:1.4}',
      '.cdl-plus-step:before{content:"";position:absolute;left:12px;top:13px;width:7px;height:7px;background:var(--plus-line-hi)}',
      '.cdl-plus-step.done,.cdl-plus-step.current{color:inherit}',
      '.cdl-plus-step.done:before,.cdl-plus-step.current:before{background:var(--plus-accent)}',
      '.cdl-plus-step.current{box-shadow:inset 2px 0 0 var(--plus-accent)}',

      '.cdl-plus-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;border:1px solid var(--plus-line);background:var(--plus-line)}',
      '.cdl-plus-metric{min-width:0;padding:11px 13px;background:var(--plus-panel)}',
      '.cdl-plus-metric span{display:block;margin-bottom:5px;color:var(--plus-muted);font:700 var(--plus-t-micro)/1 var(--plus-mono);letter-spacing:.1em;text-transform:uppercase}',
      '.cdl-plus-metric strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:inherit;font:700 var(--plus-t-base)/1.25 inherit}',

      '.cdl-plus-tabs{display:flex;width:100%;border-bottom:1px solid var(--plus-line-hi);overflow-x:auto;scrollbar-width:none}',
      '.cdl-plus-tabs::-webkit-scrollbar{display:none}',
      '.cdl-plus-tab{flex:0 0 auto;margin-bottom:-1px;min-height:var(--plus-control-h);padding:0 14px;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--plus-muted);font:700 var(--plus-t-sm)/1.2 inherit;cursor:pointer}',
      '.cdl-plus-tab:hover{color:inherit}',
      '.cdl-plus-tab[aria-selected="true"]{color:inherit;border-bottom-color:var(--plus-accent)}',
      '.cdl-plus-pane{display:flex;flex-direction:column;gap:16px;padding-top:4px}',


      '.cdl-plus-oview{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}',
      '.cdl-plus-oview h4{margin:0!important;color:inherit;font-size:var(--plus-t-md)!important;font-weight:750}',
      '.cdl-plus-catstate{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:1px;border:1px solid var(--plus-line);background:var(--plus-line)}',
      '.cdl-plus-catcell{display:flex;align-items:flex-start;gap:9px;min-width:0;padding:11px 12px;background:var(--plus-panel)}',
      '.cdl-plus-catdot{flex:0 0 auto;width:7px;height:7px;margin-top:4px;background:var(--plus-line-hi)}',
      '.cdl-plus-catcell.is-on .cdl-plus-catdot{background:var(--plus-accent)}',
      '.cdl-plus-catcell strong{display:block;color:var(--plus-muted);font-size:var(--plus-t-sm);font-weight:700;line-height:1.3}',
      '.cdl-plus-catcell em{display:block;margin-top:4px;color:var(--plus-faint);font:700 var(--plus-t-micro)/1.3 var(--plus-mono);font-style:normal;letter-spacing:.08em;text-transform:uppercase}',
      '.cdl-plus-catcell.is-on strong{color:inherit}',
      '.cdl-plus-catcell.is-on em{color:var(--plus-accent-hi)}',
      '.cdl-plus-metaline{display:flex;flex-wrap:wrap;gap:12px 30px;padding-top:14px;border-top:1px solid var(--plus-line)}',
      '.cdl-plus-metaitem{min-width:0}',
      '.cdl-plus-metaitem span{display:block;margin-bottom:4px;color:var(--plus-muted);font:700 var(--plus-t-micro)/1 var(--plus-mono);letter-spacing:.1em;text-transform:uppercase}',
      '.cdl-plus-metaitem strong{display:block;color:inherit;font-size:var(--plus-t-sm);font-weight:700;overflow-wrap:anywhere}',

      '.cdl-plus-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 18px;margin:0}',
      '.cdl-plus-kv dt{color:var(--plus-muted);font:700 var(--plus-t-micro)/1.5 var(--plus-mono);letter-spacing:.08em;text-transform:uppercase}',
      '.cdl-plus-kv dd{margin:0;font-size:var(--plus-t-sm);overflow-wrap:anywhere}',

      '.cdl-plus-categories{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
      '.cdl-plus-category{display:flex;align-items:flex-start;gap:9px;padding:10px 11px;border:1px solid var(--plus-line);border-radius:var(--plus-radius);cursor:pointer}',
      '.cdl-plus-category:hover{border-color:var(--plus-line-hi);background:var(--plus-panel-hi)}',
      '.cdl-plus-category:has(input:checked){border-color:var(--plus-accent-edge);background:var(--plus-accent-wash)}',
      '.cdl-plus-category input{margin:1px 0 0;accent-color:var(--plus-accent)}',
      '.cdl-plus-category strong{display:block;font-size:var(--plus-t-sm);font-weight:700}',
      '.cdl-plus-category>span>span{display:block;margin-top:3px;color:var(--plus-muted);font-size:var(--plus-t-tiny);line-height:1.45}',

      '.cdl-plus-list{border-top:1px solid var(--plus-line)}',
      '.cdl-plus-item{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--plus-line)}',
      '.cdl-plus-item-main{min-width:0}',
      '.cdl-plus-item-main strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--plus-t-sm);font-weight:700}',
      '.cdl-plus-item-main span{display:block;margin-top:3px;color:var(--plus-muted);font-size:var(--plus-t-tiny)}',

      '.cdl-plus-feedback{display:flex;flex-direction:column;gap:12px;max-width:640px}',
      '.cdl-plus-feedback-title{margin:0!important;color:inherit;font-size:var(--plus-t-md)!important;font-weight:750}',
      '.cdl-plus-chips{display:flex;flex-wrap:wrap;gap:6px}',
      '.cdl-plus-chip{min-height:30px;padding:0 12px;border:1px solid var(--plus-line-hi);border-radius:var(--plus-radius);background:transparent;color:var(--plus-muted);font:700 var(--plus-t-sm)/1.2 inherit;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease}',
      '.cdl-plus-chip:hover{color:inherit}',
      '.cdl-plus-chip[aria-pressed="true"]{border-color:var(--plus-accent);background:var(--plus-accent-wash);color:inherit}',
      '.cdl-plus-chip:focus-visible{outline:2px solid var(--plus-accent);outline-offset:1px}',
      '.cdl-plus-textarea{min-height:124px;padding:10px 11px;resize:vertical;font:var(--plus-t-base)/1.5 inherit}',
      '.cdl-plus-count{margin-top:-6px;color:var(--plus-faint);font:var(--plus-t-tiny)/1 var(--plus-mono);text-align:right}',
      '.cdl-plus-check{display:flex;align-items:flex-start;gap:9px;font-size:var(--plus-t-sm);line-height:1.5;cursor:pointer}',
      '.cdl-plus-check input{margin-top:2px;accent-color:var(--plus-accent)}',
      '.cdl-plus-details{padding-top:14px;border-top:1px solid var(--plus-line)}',
      '.cdl-plus-details summary{cursor:pointer;color:var(--plus-muted);font-size:var(--plus-t-sm);font-weight:700}',
      '.cdl-plus-details summary:hover{color:inherit}',
      '.cdl-plus-details[open] summary{margin-bottom:14px}',

      '.cdl-plus-loading{height:2px;overflow:hidden;background:var(--plus-line)}',
      '.cdl-plus-loading:after{content:"";display:block;width:34%;height:100%;background:var(--plus-accent);animation:cdlPlusLoad 1s ease-in-out infinite}',
      '@keyframes cdlPlusLoad{0%{transform:translateX(-110%)}100%{transform:translateX(390%)}}',

      '@media(max-width:900px){.cdl-plus-catstate{grid-template-columns:repeat(3,minmax(0,1fr))}}',
      '@media(max-width:720px){.cdl-plus-head,.cdl-plus-welcome{display:block}.cdl-plus-price,.cdl-plus-offer{margin-top:12px;text-align:left}.cdl-plus-metrics,.cdl-plus-facts,.cdl-plus-steps{grid-template-columns:repeat(2,minmax(0,1fr))}.cdl-plus-catstate{grid-template-columns:repeat(2,minmax(0,1fr))}.cdl-plus-categories{grid-template-columns:1fr}.cdl-plus-form{grid-template-columns:1fr}.cdl-plus-form .cdl-plus-btn{width:fit-content}.cdl-plus-auth-choice{display:grid;width:100%;align-self:stretch}}',
      '@media(max-width:430px){.cdl-plus-facts,.cdl-plus-steps,.cdl-plus-catstate{grid-template-columns:1fr}.cdl-plus-metric{padding:9px 11px}.cdl-plus-kv{grid-template-columns:1fr;gap:2px}.cdl-plus-actions{align-items:stretch}.cdl-plus-actions .cdl-plus-btn{width:100%}}',
      '@media(prefers-reduced-motion:reduce){.cdl-plus-loading:after{animation:none;width:100%}.cdl-plus-btn,.cdl-plus-choice{transition:none}}'
    ].join('');
    document.head.appendChild(el('style', { id: STYLE_ID, text: css }));
  }

  function runtimeSend(message) {
    return new Promise(function (resolve) {
      try {
        global.chrome.runtime.sendMessage(message, function (response) {
          if (global.chrome.runtime.lastError) resolve({ ok: false, error: { code: 'EXTENSION_MESSAGE_FAILED', message: global.chrome.runtime.lastError.message } });
          else resolve(response || { ok: false, error: { code: 'EMPTY_RESPONSE', message: 'The extension returned no response.' } });
        });
      } catch (error) { resolve({ ok: false, error: { code: 'EXTENSION_MESSAGE_FAILED', message: error.message } }); }
    });
  }
  function permissionCall(method, payload) {
    if (!global.chrome || !global.chrome.permissions || !global.chrome.permissions[method]) return Promise.resolve(method === 'getAll' ? {} : false);
    return new Promise(function (resolve) {
      try {
        var fn = global.chrome.permissions[method].bind(global.chrome.permissions);
        var result = method === 'getAll' ? fn(function (value) { resolve(value || {}); }) : fn(payload, function (value) { resolve(!!value); });
        if (result && typeof result.then === 'function') result.then(resolve).catch(function () { resolve(method === 'getAll' ? {} : false); });
      } catch (_) { resolve(method === 'getAll' ? {} : false); }
    });
  }
  function permissionPayloadForManifest(manifest) {
    var payload = { origins: [API_PERMISSION] };
    var gecko = manifest && manifest.browser_specific_settings && manifest.browser_specific_settings.gecko;
    var declared = gecko && gecko.data_collection_permissions && gecko.data_collection_permissions.optional;
    if (Array.isArray(declared)) {
      var requested = DATA_PERMISSIONS.filter(function (category) { return declared.indexOf(category) !== -1; });
      if (requested.length) payload.data_collection = requested;
    }
    return payload;
  }
  function requestDirectConsentIfPossible() {
    if (!/^(?:chrome|moz)-extension:$/.test(global.location && global.location.protocol || '')) return Promise.resolve(null);
    var manifest = {};
    try { manifest = global.chrome.runtime.getManifest(); } catch (_) {}
    // Request immediately in the click handler. Awaiting another extension API
    // first loses Chromium's transient user activation and silently denies it.
    return permissionCall('request', permissionPayloadForManifest(manifest));
  }

  function createSection(options) {
    options = options || {};
    injectStyle();
    var send = options.send || runtimeSend;
    var root = el('section', { class: (options.variant === 'embedded' ? 'usettings__section ' : 'section ') + 'cdl-plus' + (options.dedicated ? ' is-dedicated' : '') });
    var body = el('div', { class: 'cdl-plus-body' }, [el('div', { class: 'cdl-plus-loading' })]);
    if (!options.hideHeader) {
      root.appendChild(el('div', { class: 'cdl-plus-head' }, [
        el('div', {}, [
          el('div', { class: 'cdl-plus-titleline' }, [el('h3', { class: 'cdl-plus-title', text: 'Comix Downloader Plus' }), el('span', { class: 'cdl-plus-badge', text: 'OPTIONAL' })]),
          el('p', { class: 'cdl-plus-copy', text: 'Encrypted cross-device sync and 30-day restore history. Every existing extension feature remains free and works without an account.' }),
        ]),
        el('div', { class: 'cdl-plus-price' }, [el('strong', { text: '30 days free' }), document.createTextNode('then US$1.50/month')]),
      ]));
    }
    root.appendChild(body);
    var currentView = null;
    var externalRefreshCleanup = null;

    function status(text, kind, reference) {
      var node = el('div', { class: 'cdl-plus-strip' + (kind ? ' ' + kind : ''), text: text });
      if (reference) node.appendChild(el('span', { class: 'cdl-plus-error-ref', text: 'Reference: ' + reference }));
      return node;
    }
    function errorMessage(result) {
      var error = result && result.error || {};
      // A full Plus is not a failure: the account is on the waiting list, so say so calmly.
      var node = error.code === 'PLUS_CAPACITY_REACHED'
        ? status(error.message, 'warn')
        : status(error.message || 'The Plus request failed.', 'error', error.requestId || error.code);
      node.setAttribute('data-call-error', '');
      return node;
    }
    async function call(message, button) {
      if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
      var result = await send(message);
      if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
      if (!result || !result.ok) throw result || { error: { message: 'No response from the extension.' } };
      return result;
    }
    function showCallError(result, container) {
      var target = container || body;
      var old = target.querySelector('[data-call-error]'); if (old) old.remove();
      target.insertBefore(errorMessage(result), target.firstChild);
      var code = result && result.error && result.error.code;
      if ((code === 'PLUS_PERMISSION_DECLINED' || code === 'PLUS_PERMISSION_REQUIRED') && options.variant === 'embedded') {
        var open = el('button', { type: 'button', class: 'cdl-plus-btn', text: 'Open standalone settings' });
        open.addEventListener('click', function () { send({ action: 'openOptions' }); });
        target.insertBefore(el('div', { class: 'cdl-plus-actions' }, [open]), target.children[1] || null);
      }
    }
    function setBusy(text) { clear(body); body.appendChild(status(text || 'Working...')); body.appendChild(el('div', { class: 'cdl-plus-loading' })); }
    async function reload(refreshAccount) {
      setBusy(refreshAccount ? 'Refreshing account status...' : 'Loading Plus status...');
      var result = await send({ action: refreshAccount ? 'plusRefreshAccount' : 'plusGetState' });
      if (!result || !result.ok) { clear(body); body.appendChild(errorMessage(result)); return; }
      currentView = result;
      render(result);
    }
    function refreshAfterExternalTab() {
      if (externalRefreshCleanup) externalRefreshCleanup();
      var armedAt = Date.now();
      var timeout = 0;
      var finished = false;
      function cleanup() {
        if (finished) return;
        finished = true;
        global.removeEventListener('focus', onReturn);
        document.removeEventListener('visibilitychange', onReturn);
        if (timeout) global.clearTimeout(timeout);
        externalRefreshCleanup = null;
      }
      function onReturn() {
        if (finished || Date.now() - armedAt < 500 || document.visibilityState === 'hidden') return;
        cleanup();
        global.setTimeout(function () { reload(true); }, 250);
      }
      global.addEventListener('focus', onReturn);
      document.addEventListener('visibilitychange', onReturn);
      timeout = global.setTimeout(cleanup, 10 * 60 * 1000);
      externalRefreshCleanup = cleanup;
    }

    function renderSignedOut(view) {
      clear(body);
      body.appendChild(el('div', { class: 'cdl-plus-welcome' }, [
        el('div', {}, [
          el('h3', { text: 'Plus is off' }),
          el('p', { class: 'cdl-plus-copy', text: 'Every download, reader, library and watch feature keeps working exactly as it does now, without an account. Plus adds encrypted synchronization between your own browsers. Nothing is sent anywhere until you create an account here.' }),
        ]),
        el('div', { class: 'cdl-plus-offer' }, [
          el('strong', { text: '30 days free' }),
          el('span', { text: 'then US$1.50/month' }),
        ]),
      ]));
      body.appendChild(el('ul', { class: 'cdl-plus-facts' }, [
        el('li', {}, [el('strong', { text: 'Five browsers' }), el('span', { text: 'Approve each one once, revoke any of them from here.' })]),
        el('li', {}, [el('strong', { text: 'You pick what travels' }), el('span', { text: 'Every category starts off. Comic files never sync.' })]),
        el('li', {}, [el('strong', { text: '30 days of restore points' }), el('span', { text: 'Roll a bad merge back without touching the other devices.' })]),
      ]));
      var chooser = el('div', { class: 'cdl-plus-auth-choice', role: 'tablist', 'aria-label': 'Plus account access' });
      var create = el('button', { type: 'button', class: 'cdl-plus-choice', role: 'tab', 'aria-selected': 'true', text: 'Create account' });
      var login = el('button', { type: 'button', class: 'cdl-plus-choice', role: 'tab', 'aria-selected': 'false', text: 'Sign in' });
      chooser.appendChild(create); chooser.appendChild(login); body.appendChild(chooser);

      async function begin(intent, button) {
        create.setAttribute('aria-selected', intent === 'create' ? 'true' : 'false');
        login.setAttribute('aria-selected', intent === 'login' ? 'true' : 'false');
        try {
          var directGrant = await requestDirectConsentIfPossible();
          if (directGrant === false) throw { error: { code: 'PLUS_PERMISSION_DECLINED', message: 'Permission to contact the Plus API was not granted. No data was sent.' } };
          await call({ action: 'plusRequestConsent' }, button);
          renderCodeForm(intent);
        } catch (error) { showCallError(error); }
      }
      create.addEventListener('click', function () { begin('create', create); });
      login.addEventListener('click', function () { begin('login', login); });
      if (view.state.setupStarted) renderCodeForm('create');
      testerAction(body);
    }

    function renderCodeForm(intent) {
      intent = intent === 'login' ? 'login' : 'create';
      var existing = body.querySelector('.cdl-plus-auth'); if (existing) existing.remove();
      var wrap = el('div', { class: 'cdl-plus-auth' });
      wrap.appendChild(el('div', { class: 'cdl-plus-auth-head' }, [
        el('strong', { text: intent === 'login' ? 'Sign in to your Plus account' : 'Create your Plus account' }),
        el('span', { text: intent === 'login' ? 'Use the email already linked to Plus.' : 'Verify your email before starting the secure Stripe trial checkout.' }),
      ]));
      var email = el('input', { class: 'cdl-plus-input', type: 'email', autocomplete: 'email', placeholder: 'you@example.com', 'aria-label': 'Email address' });
      var codeButton = el('button', { type: 'button', class: 'cdl-plus-btn', text: 'Send code' });
      var form = el('div', { class: 'cdl-plus-form' }, [email, codeButton]);
      var codeArea = el('div');
      codeButton.addEventListener('click', async function () {
        try {
          await call({ action: 'plusRequestCode', email: email.value.trim() }, codeButton);
          clear(codeArea); codeArea.appendChild(status('If the address can receive a code, it will arrive shortly. The code expires in 10 minutes.'));
          var code = el('input', { class: 'cdl-plus-input cdl-plus-code', type: 'text', inputmode: 'numeric', maxlength: '6', autocomplete: 'one-time-code', placeholder: '000000', 'aria-label': 'Six-digit verification code' });
          var verify = el('button', { type: 'button', class: 'cdl-plus-btn primary', text: 'Verify' });
          var codeForm = el('div', { class: 'cdl-plus-form' }, [code, verify]); codeArea.appendChild(codeForm);
          verify.addEventListener('click', async function () {
            try { setBusy('Verifying this browser...'); await call({ action: 'plusVerifyCode', email: email.value.trim(), code: code.value.trim(), intent: intent }); await reload(false); }
            catch (error) { clear(body); body.appendChild(errorMessage(error)); body.appendChild(wrap); }
          });
          code.focus();
        } catch (error) { showCallError(error, wrap); }
      });
      wrap.appendChild(form); wrap.appendChild(codeArea); body.appendChild(wrap);
    }

    function accountHeader(account, lastSyncAt) {
      var dateLabel = account.state === 'trial' ? 'Trial ends' : account.state === 'cancelled_active' ? 'Access ends' : account.state === 'active' ? 'Renews' : account.state === 'grace' ? 'Grace ends' : account.state === 'expired' ? 'Cloud deletion' : 'Next step';
      var date = account.state === 'trial' ? account.trialEnd : account.state === 'cancelled_active' || account.state === 'active' ? account.periodEnd : account.state === 'grace' ? account.graceEnd : account.state === 'expired' ? account.dataDeleteAt : null;
      return el('div', { class: 'cdl-plus-metrics' }, [
        metric('Status', stateLabel(account.state)),
        metric(dateLabel, formatDate(date)),
        metric('Devices', (account.deviceCount || 0) + ' / ' + (account.deviceLimit || 5)),
        metric('Last sync', formatRelative(lastSyncAt)),
      ]);
    }
    function metric(label, value) { return el('div', { class: 'cdl-plus-metric' }, [el('span', { text: label }), el('strong', { text: value, title: value })]); }
    function setupSteps(current) {
      var order = ['Account', 'Plan', 'Encryption', 'Sync'];
      var currentIndex = Math.max(0, order.indexOf(current));
      return el('div', { class: 'cdl-plus-steps', 'aria-label': 'Plus setup progress' }, order.map(function (label, index) {
        return el('div', { class: 'cdl-plus-step ' + (index < currentIndex ? 'done' : index === currentIndex ? 'current' : ''), text: label });
      }));
    }
    function accountActions(account) {
      var refresh = el('button', { type: 'button', class: 'cdl-plus-btn', text: 'Refresh status' });
      refresh.addEventListener('click', function () { reload(true); });
      var signout = el('button', { type: 'button', class: 'cdl-plus-btn', text: 'Sign out' });
      signout.addEventListener('click', async function () { try { await call({ action: 'plusSignOut' }, signout); await reload(false); } catch (error) { showCallError(error); } });
      var nodes = [refresh, signout];
      var library = el('button', { type: 'button', class: 'cdl-plus-btn', text: 'Cloud Library' });
      library.addEventListener('click', async function () { try { await call({ action: 'plusOpenLibrary' }, library); } catch (error) { showCallError(error); } });
      nodes.unshift(library);
      if (account.state !== 'pending_checkout') {
        var billing = el('button', { type: 'button', class: 'cdl-plus-btn', text: 'Manage billing' });
        billing.addEventListener('click', async function () {
          try {
            var result = await call({ action: 'plusBillingPortal', open: true }, billing);
            if (result.opened) refreshAfterExternalTab();
          } catch (error) { showCallError(error); }
        });
        nodes.unshift(billing);
      }
      return el('div', { class: 'cdl-plus-actions' }, nodes);
    }

    function renderPendingCheckout(view) {
      clear(body); body.appendChild(setupSteps('Plan')); body.appendChild(accountHeader(view.state.account, view.state.lastSyncAt));
      var intro = status('Email verified. Complete the secure Stripe Managed Payments checkout to start the card-backed 30-day trial. The first US$1.50 payment is due after the trial unless cancelled.');
      body.appendChild(intro);
      var checkout = el('button', { type: 'button', class: 'cdl-plus-btn primary', text: 'Continue to secure checkout' });
      checkout.addEventListener('click', async function () {
        try {
          var result = await call({ action: 'plusCheckout', open: true }, checkout);
          if (result.opened) refreshAfterExternalTab();
        } catch (error) {
          showCallError(error);
          // Plus is full: drop the checkout wording and let them try again later.
          if (error && error.error && error.error.code === 'PLUS_CAPACITY_REACHED') {
            intro.remove();
            checkout.textContent = 'Check again';
            checkout.classList.remove('primary');
          }
        }
      });
      body.appendChild(el('div', { class: 'cdl-plus-actions' }, [checkout])); body.appendChild(accountActions(view.state.account));
    }

    // A browser that lost its approval (removed from Devices, or the account key was
    // reset elsewhere) only needs a fresh email code.
    function renderDeviceApproval(view) {
      clear(body); body.appendChild(accountHeader(view.state.account, view.state.lastSyncAt));
      body.appendChild(status('This browser needs a fresh sign-in. Sign in again with a code sent to your email; that is all it takes.', 'warn'));
      var again = el('button', { type: 'button', class: 'cdl-plus-btn primary', text: 'Sign in again' });
      again.addEventListener('click', async function () { try { await call({ action: 'plusSignOut' }, again); await reload(false); } catch (error) { showCallError(error); } });
      body.appendChild(el('div', { class: 'cdl-plus-actions' }, [again]));
    }

    // Normally automatic after checkout; shown only if setting up the key did not finish.
    function renderEncryptionSetup(view) {
      clear(body); body.appendChild(setupSteps('Encryption')); body.appendChild(accountHeader(view.state.account, view.state.lastSyncAt));
      if (view.state.lastError) body.appendChild(status(view.state.lastError.message, 'error', view.state.lastError.requestId || view.state.lastError.code));
      body.appendChild(status('Set up encrypted cloud storage for this account. It happens once; every browser you sign in to with your email gets access automatically.'));
      var create = el('button', { type: 'button', class: 'cdl-plus-btn primary', text: 'Set up encryption' });
      create.addEventListener('click', async function () { try { setBusy('Setting up encryption...'); await call({ action: 'plusBootstrapEncryption' }, create); await reload(false); } catch (error) { clear(body); body.appendChild(errorMessage(error)); body.appendChild(accountActions(view.state.account)); } });
      body.appendChild(el('div', { class: 'cdl-plus-actions' }, [create])); body.appendChild(accountActions(view.state.account));
    }

    function renderExistingKeyRecovery(view) {
      clear(body); body.appendChild(accountHeader(view.state.account, view.state.lastSyncAt));
      if (view.state.lastError) body.appendChild(status(view.state.lastError.message, 'error', view.state.lastError.requestId || view.state.lastError.code));
      if (view.state.account.keyEscrow) {
        body.appendChild(status('Your cloud data could not be unlocked on this browser yet. Check your connection and try again.', 'warn'));
        var retry = el('button', { type: 'button', class: 'cdl-plus-btn primary', text: 'Try again' });
        retry.addEventListener('click', async function () { try { await call({ action: 'plusUnlock' }, retry); await reload(true); } catch (error) { showCallError(error); } });
        body.appendChild(el('div', { class: 'cdl-plus-actions' }, [retry])); body.appendChild(accountActions(view.state.account));
        return;
      }
      // Accounts created with a recovery code, before sign-in became email-only.
      body.appendChild(status('This account was set up before email-only sign-in. Open Plus once on a browser that already shows your data and it switches over automatically, or enter your old recovery code here.', 'warn'));
      var recovery = el('input', { class: 'cdl-plus-input cdl-plus-code', type: 'text', autocomplete: 'off', placeholder: 'XXXX-XXXX-XXXX-...', 'aria-label': 'Recovery code' });
      var use = el('button', { type: 'button', class: 'cdl-plus-btn', text: 'Use recovery code' });
      use.addEventListener('click', async function () {
        try { setBusy('Opening the encrypted account key...'); await call({ action: 'plusRecover', recoveryCode: recovery.value.trim() }, use); await reload(true); }
        catch (error) { renderExistingKeyRecovery(view); showCallError(error); }
      });
      var check = el('button', { type: 'button', class: 'cdl-plus-btn primary', text: 'Check again' });
      check.addEventListener('click', async function () { try { await call({ action: 'plusUnlock' }, check); await reload(true); } catch (error) { showCallError(error); } });
      body.appendChild(el('div', { class: 'cdl-plus-actions' }, [check]));
      body.appendChild(el('div', { class: 'cdl-plus-form' }, [recovery, use]));
      body.appendChild(accountActions(view.state.account));
      testerAction(body);
    }

    // Private testing builds with plus-tester.local.json can switch to the shared tester
    // account, which the testing service treats as Plus on every browser.
    function testerAction(container) {
      if (PUBLIC_RELEASE) return;
      send({ action: 'plusTesterAvailable' }).then(function (result) {
        if (!result || !result.ok || !result.available || !container.isConnected) return;
        var tester = el('button', { type: 'button', class: 'cdl-plus-btn primary', text: 'Use the tester account' });
        tester.addEventListener('click', async function () {
          try { setBusy('Signing in to the tester account...'); await call({ action: 'plusSignInAsTester' }); await reload(false); }
          catch (error) { await reload(false); showCallError(error); }
        });
        container.appendChild(el('div', { class: 'cdl-plus-details' }, [
          el('p', { class: 'cdl-plus-copy', text: 'Private testing build: the tester account has Plus on every browser, with no email code and no device limit.' }),
          el('div', { class: 'cdl-plus-actions' }, [tester]),
        ]));
      });
    }

    function categoryPicker(view) {
      var selected = new Set(view.state.selectedCategories || []);
      var wrap = el('div');
      var grid = el('div', { class: 'cdl-plus-categories' });
      (view.categories || []).forEach(function (category) {
        var checkbox = el('input', { type: 'checkbox', value: category.id, checked: selected.has(category.id) });
        grid.appendChild(el('label', { class: 'cdl-plus-category' }, [checkbox, el('span', {}, [el('strong', { text: category.label }), el('span', { text: category.description })])]));
      });
      var select = el('button', { type: 'button', class: 'cdl-plus-btn', text: 'Select recommended' });
      select.addEventListener('click', function () { grid.querySelectorAll('input').forEach(function (input) { input.checked = (view.recommendedCategories || []).indexOf(input.value) !== -1; }); });
      var saveText = selected.size ? 'Save categories' : 'Save and create first backup';
      var save = el('button', { type: 'button', class: 'cdl-plus-btn primary', text: saveText });
      save.addEventListener('click', async function () {
        var categories = Array.from(grid.querySelectorAll('input:checked')).map(function (input) { return input.value; });
        if (!categories.length && !global.confirm('Turn off cloud synchronization for every category?')) return;
        try {
          await call({ action: 'plusSetCategories', categories: categories }, save);
          if (!selected.size && categories.length) await call({ action: 'plusSyncNow' }, save);
          await reload(true);
        } catch (error) { showCallError(error, wrap); }
      });
      wrap.appendChild(el('p', { class: 'cdl-plus-subhead', text: 'Synchronized categories' })); wrap.appendChild(grid); wrap.appendChild(el('div', { class: 'cdl-plus-actions' }, [select, save]));
      return wrap;
    }

    function renderRestorePanel(view, holder) {
      setPanelBusy(holder, 'Loading restore history...');
      send({ action: 'plusListSnapshots' }).then(function (result) {
        clear(holder);
        if (!result || !result.ok) { holder.appendChild(errorMessage(result)); return; }
        var snapshots = result.snapshots || [];
        if (!snapshots.length) { holder.appendChild(status('No restore point is available yet.')); return; }
        var list = el('div', { class: 'cdl-plus-list' });
        snapshots.forEach(function (snapshot) {
          var restore = el('button', { type: 'button', class: 'cdl-plus-btn', text: snapshot.kind === 'latest' ? 'Current' : 'Restore', disabled: snapshot.kind === 'latest' });
          restore.addEventListener('click', async function () {
            var categories = view.state.selectedCategories || [];
            if (!categories.length) return;
            var readOnly = view.state.account && view.state.account.state === 'expired';
            var confirmation = readOnly
              ? 'Restore the selected sync categories from ' + formatDate(snapshot.createdAt, true) + ' to this device? Expired accounts are read-only, so the cloud backup will not be changed.'
              : 'Restore the selected sync categories from ' + formatDate(snapshot.createdAt, true) + '? A Before restore point will be created first.';
            if (!global.confirm(confirmation)) return;
            try { setPanelBusy(holder, 'Restoring and re-encrypting selected data...'); await call({ action: 'plusRestoreSnapshot', snapshotId: snapshot.id, categories: categories }, restore); await reload(true); }
            catch (error) { clear(holder); holder.appendChild(errorMessage(error)); }
          });
          list.appendChild(el('div', { class: 'cdl-plus-item' }, [el('div', { class: 'cdl-plus-item-main' }, [el('strong', { text: snapshot.kind === 'before_restore' ? 'Before restore' : snapshot.kind === 'daily' ? 'Daily restore point' : 'Current backup' }), el('span', { text: formatDate(snapshot.createdAt, true) + ' - ' + formatBytes(snapshot.sizeBytes) + ' - revision ' + snapshot.revision })]), restore]));
        });
        holder.appendChild(list);
      });
    }
    function setPanelBusy(holder, text) { clear(holder); holder.appendChild(status(text)); holder.appendChild(el('div', { class: 'cdl-plus-loading' })); }

    function renderDevicesPanel(holder) {
      setPanelBusy(holder, 'Loading devices...');
      send({ action: 'plusListDevices' }).then(function (result) {
        clear(holder); if (!result || !result.ok) { holder.appendChild(errorMessage(result)); return; }
        var list = el('div', { class: 'cdl-plus-list' });
        (result.devices || []).forEach(function (device) {
          var action = null;
          if (!device.approved && !device.revoked) {
            action = el('button', { type: 'button', class: 'cdl-plus-btn primary', text: 'Approve' });
            action.addEventListener('click', async function () { try { await call({ action: 'plusApproveDevice', deviceId: device.id, publicKeyJwk: device.publicKeyJwk }, action); renderDevicesPanel(holder); } catch (error) { clear(holder); holder.appendChild(errorMessage(error)); } });
          } else if (!device.current && !device.revoked) {
            action = el('button', { type: 'button', class: 'cdl-plus-btn danger', text: 'Revoke' });
            action.addEventListener('click', async function () { if (!global.confirm('Revoke ' + device.name + '? It will need approval again.')) return; try { await call({ action: 'plusRevokeDevice', deviceId: device.id }, action); renderDevicesPanel(holder); } catch (error) { clear(holder); holder.appendChild(errorMessage(error)); } });
          }
          list.appendChild(el('div', { class: 'cdl-plus-item' }, [el('div', { class: 'cdl-plus-item-main' }, [el('strong', { text: device.name + (device.current ? ' (this device)' : '') }), el('span', { text: device.revoked ? 'Revoked' : device.approved ? 'Approved - last seen ' + formatDate(device.lastSeenAt, true) : 'Waiting for approval' })]), action]));
        }); holder.appendChild(list);
      });
    }

    function destructiveControls(view) {
      var details = el('details', { class: 'cdl-plus-details' }, [el('summary', { text: 'Cloud data and account controls' })]);
      var exportButton = el('button', { type: 'button', class: 'cdl-plus-btn', text: 'Export decrypted cloud data' });
      exportButton.addEventListener('click', async function () { if (!global.confirm('Export a readable JSON copy of synchronized metadata to this device?')) return; try { await call({ action: 'plusExportCloudData' }, exportButton); } catch (error) { showCallError(error, details); } });
      var deleteCloud = el('button', { type: 'button', class: 'cdl-plus-btn danger', text: 'Delete cloud backups' });
      deleteCloud.addEventListener('click', async function () { if (!global.confirm('Delete every encrypted cloud snapshot? Local extension data will remain.')) return; try { await call({ action: 'plusDeleteCloudData' }, deleteCloud); await reload(true); } catch (error) { showCallError(error, details); } });
      var reset = el('button', { type: 'button', class: 'cdl-plus-btn danger', text: 'Reset cloud encryption' });
      reset.addEventListener('click', async function () { var confirmation = global.prompt('Type RESET to delete cloud sync keys and backups. Local extension data will remain:'); if (confirmation !== 'RESET') return; try { await call({ action: 'plusResetCloudSync', confirmation: confirmation }, reset); await reload(true); } catch (error) { showCallError(error, details); } });
      var deleteAccount = el('button', { type: 'button', class: 'cdl-plus-btn danger', text: 'Delete Plus account' });
      deleteAccount.addEventListener('click', async function () { if (global.prompt('Type DELETE to cancel billing and permanently delete the Plus account:') !== 'DELETE') return; try { await call({ action: 'plusDeleteAccount' }, deleteAccount); await reload(false); } catch (error) { showCallError(error, details); } });
      details.appendChild(el('div', { class: 'cdl-plus-actions' }, [exportButton, deleteCloud, reset, deleteAccount]));
      return details;
    }

    // Feedback goes straight to the developer's inbox through the Plus service.
    var FEEDBACK_KINDS = [
      { id: 'dislike', label: 'Something bothers me' },
      { id: 'add', label: 'Add something' },
      { id: 'remove', label: 'Remove something' },
      { id: 'other', label: 'Something else' },
    ];
    var FEEDBACK_MAX = 4000;
    function renderFeedbackPanel(holder, intro) {
      clear(holder);
      var form = el('div', { class: 'cdl-plus-feedback' });
      var kind = '';
      var chips = el('div', { class: 'cdl-plus-chips', role: 'group', 'aria-label': 'What is it about?' });
      FEEDBACK_KINDS.forEach(function (option) {
        var chip = el('button', { type: 'button', class: 'cdl-plus-chip', 'aria-pressed': 'false', 'data-kind': option.id, text: option.label });
        chip.addEventListener('click', function () {
          kind = option.id;
          chips.querySelectorAll('.cdl-plus-chip').forEach(function (other) { other.setAttribute('aria-pressed', other === chip ? 'true' : 'false'); });
        });
        chips.appendChild(chip);
      });
      var text = el('textarea', {
        class: 'cdl-plus-input cdl-plus-textarea', maxlength: String(FEEDBACK_MAX), 'aria-label': 'Your message',
        placeholder: 'What bothers you, what would you add, or what would you remove? Honest is best.',
      });
      var count = el('div', { class: 'cdl-plus-count', text: '0 / ' + FEEDBACK_MAX });
      text.addEventListener('input', function () { count.textContent = text.value.length + ' / ' + FEEDBACK_MAX; });
      var reply = el('input', { type: 'checkbox', checked: true });
      var send = el('button', { type: 'button', class: 'cdl-plus-btn primary', text: 'Send to the developer' });
      send.addEventListener('click', async function () {
        var old = form.querySelector('[data-call-error]'); if (old) old.remove();
        var message = text.value.trim();
        var problem = !kind ? 'Choose what your message is about.' : message.length < 10 ? 'Write at least a sentence so the developer can act on it.' : '';
        if (problem) { form.insertBefore(errorMessage({ error: { message: problem } }), form.firstChild); return; }
        try {
          await call({ action: 'plusSendFeedback', kind: kind, message: message, allowReply: reply.checked }, send);
          clear(holder);
          var again = el('button', { type: 'button', class: 'cdl-plus-btn', text: 'Write another message' });
          again.addEventListener('click', function () { renderFeedbackPanel(holder, intro); });
          holder.appendChild(status(reply.checked
            ? 'Thank you. Your message went straight to the developer, who may reply by email.'
            : 'Thank you. Your message went straight to the developer, without your email address.'));
          holder.appendChild(el('div', { class: 'cdl-plus-actions' }, [again]));
        } catch (error) { showCallError(error, form); }
      });
      form.appendChild(el('div', {}, [
        el('h4', { class: 'cdl-plus-feedback-title', text: 'Tell the developer' }),
        el('p', { class: 'cdl-plus-copy', text: intro || 'Honest, constructive feedback goes straight to the developer\'s inbox. Say what bothers you, what you would add, or what you would remove.' }),
      ]));
      form.appendChild(chips);
      form.appendChild(text);
      form.appendChild(count);
      form.appendChild(el('label', { class: 'cdl-plus-check' }, [reply, el('span', { text: 'The developer can reply to me by email. Leave it unticked to send without your address.' })]));
      form.appendChild(el('div', { class: 'cdl-plus-actions' }, [send]));
      holder.appendChild(form);
    }

    // Firefox treats Cloud Library page uploads as "websiteContent" data collection.
    // Accounts that signed in before that category was declared grant it here.
    function renderCloudUploadConsent(holder) {
      var manifest = {};
      try { manifest = global.chrome.runtime.getManifest(); } catch (_) {}
      var gecko = manifest && manifest.browser_specific_settings && manifest.browser_specific_settings.gecko;
      var declared = gecko && gecko.data_collection_permissions && gecko.data_collection_permissions.optional;
      if (!Array.isArray(declared) || declared.indexOf('websiteContent') === -1) return;
      var payload = { data_collection: ['websiteContent'] };
      permissionCall('contains', payload).then(function (granted) {
        if (granted) return;
        var allow = el('button', { type: 'button', class: 'cdl-plus-btn', text: 'Allow Cloud uploads' });
        allow.addEventListener('click', function () {
          // Request inside the click handler so Firefox keeps the user gesture.
          permissionCall('request', payload).then(function (ok) { if (ok) clear(holder); });
        });
        holder.appendChild(status('Firefox asks separately before Cloud Library can upload the chapter pages you save. Pages are encrypted on this device first.', 'warn'));
        holder.appendChild(el('div', { class: 'cdl-plus-actions' }, [allow]));
      });
    }

    function renderDashboard(view) {
      clear(body); var account = view.state.account; body.appendChild(accountHeader(account, view.state.lastSyncAt));
      if (view.state.lastError) body.appendChild(status(view.state.lastError.message, 'error', view.state.lastError.requestId || view.state.lastError.code));
      if (account.state === 'grace') body.appendChild(status('Automatic sync remains available during the seven-day payment grace period. Update payment details in the billing portal.', 'warn'));
      if (account.state === 'cancelled_active') body.appendChild(status('Plus remains active until ' + formatDate(account.periodEnd) + '. Automatic renewal is cancelled.'));

      var tabs = el('div', { class: 'cdl-plus-tabs', role: 'tablist', 'aria-label': 'Plus account sections' });
      var pane = el('div', { class: 'cdl-plus-pane', role: 'tabpanel', tabindex: '0' });
      var tabDefinitions = [
        { id: 'overview', label: 'Overview' },
        { id: 'agenda', label: 'Agenda' },
        { id: 'sync', label: 'Sync' },
        { id: 'devices', label: 'Devices' },
        { id: 'restore', label: 'Restore' },
        { id: 'account', label: 'Account' },
        { id: 'feedback', label: 'Feedback' },
      ];

      function renderOverview() {
        clear(pane);
        var selected = new Set(view.state.selectedCategories || []);
        var sync = el('button', { type: 'button', class: 'cdl-plus-btn primary', text: 'Sync now', disabled: !selected.size || account.state === 'expired' });
        sync.addEventListener('click', async function () { try { await call({ action: 'plusSyncNow' }, sync); await reload(true); } catch (error) { showCallError(error, pane); } });

        pane.appendChild(el('div', { class: 'cdl-plus-oview' }, [
          el('div', {}, [
            el('h4', { text: selected.size ? 'Synchronization is ready' : 'Choose what Plus should synchronize' }),
            el('p', { class: 'cdl-plus-copy', text: selected.size
              ? 'Changes are encrypted on this device before they leave the extension, then again after ten seconds, at browser startup, and every fifteen minutes while the browser runs.'
              : 'Nothing is synchronized until at least one category is selected in the Sync tab. Until then Plus holds no data for this account.' }),
          ]),
          el('div', { class: 'cdl-plus-actions' }, [sync]),
        ]));

        pane.appendChild(el('p', { class: 'cdl-plus-subhead', text: 'What travels between your browsers' }));
        pane.appendChild(el('div', { class: 'cdl-plus-catstate' }, (view.categories || []).map(function (category) {
          var on = selected.has(category.id);
          return el('div', { class: 'cdl-plus-catcell' + (on ? ' is-on' : ''), title: category.description }, [
            el('span', { class: 'cdl-plus-catdot' }),
            el('div', {}, [
              el('strong', { text: category.label }),
              el('em', { text: on ? 'Syncing' : 'Off' }),
            ]),
          ]);
        })));

        pane.appendChild(el('div', { class: 'cdl-plus-metaline' }, [
          metaItem('Account', account.email || 'Verified'),
          metaItem('Last sync', formatDate(view.state.lastSyncAt, true)),
          metaItem('Encryption', 'AES-256-GCM, on this device'),
          metaItem('Comic files', 'Only Cloud saves, encrypted'),
        ]));
        var consentHolder = el('div');
        pane.appendChild(consentHolder);
        renderCloudUploadConsent(consentHolder);
      }
      function metaItem(label, value) {
        return el('div', { class: 'cdl-plus-metaitem' }, [el('span', { text: label }), el('strong', { text: value, title: value })]);
      }
      function renderSync() { clear(pane); pane.appendChild(categoryPicker(view)); }
      function renderAgenda() {
        clear(pane);
        var open = el('button', { type: 'button', class: 'cdl-plus-btn primary', text: 'Open Release Agenda' });
        open.addEventListener('click', async function () { try { await call({ action: 'openAgendaPage' }, open); } catch (error) { showCallError(error, pane); } });
        pane.appendChild(el('div', { class: 'cdl-plus-oview' }, [
          el('div', {}, [
            el('h4', { text: 'Release Agenda' }),
            el('p', { class: 'cdl-plus-copy', text: 'Estimated comix.to availability for the series you follow opens as a comix.to page, inside the site\'s own header and theme. Every date is inferred from upload history, never an official release.' }),
          ]),
          el('div', { class: 'cdl-plus-actions' }, [open]),
        ]));
      }
      function renderDevices() { renderDevicesPanel(pane); }
      function renderRestore() { renderRestorePanel(view, pane); }
      function renderAccount() {
        clear(pane);
        pane.appendChild(el('p', { class: 'cdl-plus-subhead', text: 'Subscription and security' }));
        pane.appendChild(el('p', { class: 'cdl-plus-copy', text: 'Manage billing, refresh the subscription state, sign out of this browser, or control encrypted cloud data.' }));
        pane.appendChild(el('div', { class: 'cdl-plus-metaline' }, [
          metaItem('Plan', stateLabel(account.state)),
          metaItem('Encrypted cloud data', formatBytes(account.storageBytes)),
          metaItem('Approved devices', (account.deviceCount || 0) + ' of ' + (account.deviceLimit || 5)),
        ]));
        pane.appendChild(accountActions(account));
        pane.appendChild(destructiveControls(view));
      }
      function renderFeedback() { renderFeedbackPanel(pane); }
      var renderers = { overview: renderOverview, agenda: renderAgenda, sync: renderSync, devices: renderDevices, restore: renderRestore, account: renderAccount, feedback: renderFeedback };
      function selectTab(id) {
        tabs.querySelectorAll('.cdl-plus-tab').forEach(function (button) {
          var selected = button.getAttribute('data-tab') === id;
          button.setAttribute('aria-selected', selected ? 'true' : 'false');
          button.tabIndex = selected ? 0 : -1;
        });
        pane.setAttribute('aria-labelledby', 'cdl-plus-tab-' + id);
        renderers[id]();
      }
      tabDefinitions.forEach(function (definition, index) {
        var button = el('button', {
          type: 'button', class: 'cdl-plus-tab', role: 'tab', id: 'cdl-plus-tab-' + definition.id,
          'data-tab': definition.id, 'aria-selected': index === 0 ? 'true' : 'false', tabindex: index === 0 ? '0' : '-1', text: definition.label,
        });
        button.addEventListener('click', function () { selectTab(definition.id); });
        button.addEventListener('keydown', function (event) {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          var direction = event.key === 'ArrowRight' ? 1 : -1;
          var next = (index + direction + tabDefinitions.length) % tabDefinitions.length;
          var target = tabs.querySelector('[data-tab="' + tabDefinitions[next].id + '"]');
          selectTab(tabDefinitions[next].id); target.focus();
        });
        tabs.appendChild(button);
      });
      body.appendChild(tabs); body.appendChild(pane); renderOverview();
    }

    function renderExpired(view) {
      clear(body); body.appendChild(accountHeader(view.state.account, view.state.lastSyncAt));
      var deletionPending = view.state.account.dataDeleteAt && Date.parse(view.state.account.dataDeleteAt) > Date.now();
      var backupAvailable = !!view.encryptionReady && deletionPending;
      body.appendChild(status(deletionPending
        ? 'Automatic synchronization is paused. Existing encrypted backups stay available for restore or export until the deletion date.'
        : 'The cloud retention period ended. Cloud backups and encryption keys are no longer available; local extension data was not deleted.', 'warn'));
      var restart = el('button', { type: 'button', class: 'cdl-plus-btn primary', text: 'Restart Plus' });
      restart.addEventListener('click', async function () {
        try {
          var result = await call({ action: 'plusCheckout', open: true }, restart);
          if (result.opened) refreshAfterExternalTab();
        } catch (error) { showCallError(error); }
      });
      var exportButton = el('button', { type: 'button', class: 'cdl-plus-btn', text: 'Export cloud data', disabled: !backupAvailable });
      exportButton.addEventListener('click', async function () { try { await call({ action: 'plusExportCloudData' }, exportButton); } catch (error) { showCallError(error); } });
      var restore = el('button', { type: 'button', class: 'cdl-plus-btn', text: 'View restore history', disabled: !backupAvailable });
      var holder = el('div'); restore.addEventListener('click', function () { renderRestorePanel(view, holder); });
      body.appendChild(el('div', { class: 'cdl-plus-actions' }, [restart, exportButton, restore])); body.appendChild(holder); body.appendChild(accountActions(view.state.account));
      var feedback = el('details', { class: 'cdl-plus-details' }, [el('summary', { text: 'Tell the developer why Plus ended for you' })]);
      var feedbackHolder = el('div'); feedback.appendChild(feedbackHolder);
      renderFeedbackPanel(feedbackHolder, 'If something made you stop, or Plus was missing something, the developer would like to know. Your message goes straight to their inbox.');
      body.appendChild(feedback); body.appendChild(destructiveControls(view));
    }

    function render(view) {
      if (!view.signedIn || !view.state.account) { renderSignedOut(view); return; }
      var account = view.state.account;
      if (!account.device || !account.device.approved) { renderDeviceApproval(view); return; }
      if (account.state === 'pending_checkout') { renderPendingCheckout(view); return; }
      if (!view.encryptionReady && account.encryptionInitialized) { renderExistingKeyRecovery(view); return; }
      if (account.state === 'expired') { renderExpired(view); return; }
      if (!view.encryptionReady) { renderEncryptionSetup(view); return; }
      renderDashboard(view);
    }

    reload(false);
    return root;
  }

  return { createSection: createSection, injectStyle: injectStyle, formatBytes: formatBytes, formatDate: formatDate, formatRelative: formatRelative, permissionPayloadForManifest: permissionPayloadForManifest, requestDirectConsentIfPossible: requestDirectConsentIfPossible };
});
