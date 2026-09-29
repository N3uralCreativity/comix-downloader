// Carries the Plus sign-in between the extension and the Plus website (the account
// page and the web library), both served from the Plus service origin. The extension
// registers this script for that origin only, and only after the Plus permission is
// granted. The page and this script talk with window.postMessage; the background
// accepts these relays only from tabs on the Plus origin.
(function () {
  'use strict';
  if (window.__cdlPlusBridge) {
    window.__cdlPlusBridge.announce('hello');
    return;
  }
  var SITE = 'cdl-plus-site';
  var EXTENSION = 'cdl-plus-extension';
  var last = null;
  var relaying = 0;
  var changeTimer = 0;

  function post(message) {
    window.postMessage(Object.assign({ source: EXTENSION }, message), location.origin);
  }
  function send(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          void chrome.runtime.lastError;
          resolve(response || { ok: false });
        });
      } catch (_) { resolve({ ok: false }); }
    });
  }
  // transition: 'initial' when the page asks, 'signed-in' / 'signed-out' when the
  // extension's own sign-in changes while the page is open.
  async function announce(reason) {
    var response = await send({ action: 'cdlPlusBridgeState' });
    var state = { signedIn: !!response.signedIn, email: response.email || '', signedOutAt: Number(response.signedOutAt) || 0 };
    var changed = !last || last.signedIn !== state.signedIn || last.email !== state.email;
    if (reason === 'change' && !changed) return;
    var transition = reason === 'change' ? (state.signedIn ? 'signed-in' : 'signed-out') : 'initial';
    last = state;
    post({ type: 'state', transition: transition, signedIn: state.signedIn, email: state.email, signedOutAt: state.signedOutAt });
  }

  window.addEventListener('message', async function (event) {
    if (event.source !== window || event.origin !== location.origin) return;
    var data = event.data;
    if (!data || data.source !== SITE || typeof data.type !== 'string') return;
    if (data.type === 'hello') { announce('hello'); return; }
    if (data.type === 'handoff' && typeof data.code === 'string') {
      // Taking over another account signs the extension out first; the page should
      // only hear the final state, not that brief sign-out.
      relaying += 1;
      var redeemed = await send({ action: 'cdlPlusBridgeRedeem', code: data.code, email: String(data.email || '') });
      relaying -= 1;
      post({ type: 'handoff-result', ok: !!redeemed.ok, message: redeemed.error && redeemed.error.message || '' });
      announce('change');
      return;
    }
    if (data.type === 'request-handoff') {
      var created = await send({ action: 'cdlPlusBridgeCreateCode' });
      post({ type: 'handoff-code', ok: !!(created.ok && created.code), code: created.code || '', email: created.email || '' });
      return;
    }
    if (data.type === 'signed-out') await send({ action: 'cdlPlusBridgeSignOut' });
  });

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !(changes.cdlPlusState || changes.cdlPlusSecrets) || relaying) return;
      // A sign-in writes the tokens and the account separately; report them once.
      clearTimeout(changeTimer);
      changeTimer = setTimeout(function () { if (!relaying) announce('change'); }, 250);
    });
  } catch (_) {}

  window.__cdlPlusBridge = { announce: announce };
  announce('hello');
})();
