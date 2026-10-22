/* Shared SPA notifications stay inside the extension's isolated content world. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory; return; }
  if (root && !Object.prototype.hasOwnProperty.call(root, 'CDLRoute')) root.CDLRoute = factory(root);
})(typeof window !== 'undefined' ? window : null, function (win) {
  'use strict';
  var subscribers = new Set();
  var lastUrl = win.location.href;

  function notify() {
    if (win.location.href === lastUrl) return;
    lastUrl = win.location.href;
    subscribers.forEach(function (callback) { try { callback(); } catch (_) {} });
  }

  // This only wraps the isolated world's methods, never the website's History API.
  ['pushState', 'replaceState'].forEach(function (method) {
    var original = win.history[method];
    if (typeof original !== 'function') return;
    win.history[method] = function () {
      var result = original.apply(this, arguments);
      notify();
      return result;
    };
  });
  ['popstate', 'hashchange', 'pageshow'].forEach(function (name) { win.addEventListener(name, notify); });
  try {
    win.chrome.runtime.onMessage.addListener(function (message, sender) {
      if (sender && sender.id === win.chrome.runtime.id && message && message.action === 'cdlRouteChanged') notify();
    });
  } catch (_) {}

  return {
    subscribe: function (callback) {
      if (typeof callback !== 'function') return function () {};
      subscribers.add(callback);
      return function () { subscribers.delete(callback); };
    },
    unsubscribe: function (callback) { subscribers.delete(callback); }
  };
});
