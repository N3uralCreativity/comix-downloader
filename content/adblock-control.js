/**
 * adblock-control.js - relays the stored ad-blocking setting to MAIN world.
 * Runs in the extension's isolated world at document_start.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'cdlSettings';
  var SETTING_KEY = 'features.blockAds';
  var STATE_ATTR = 'data-cdl-adblock';
  var STATE_EVENT = 'cdl:adblock-state';
  var lastValue = null;

  function publish(enabled) {
    enabled = enabled !== false;
    if (lastValue === enabled && document.documentElement &&
        document.documentElement.getAttribute(STATE_ATTR) === (enabled ? 'on' : 'off')) return;
    lastValue = enabled;

    var html = document.documentElement;
    if (!html) {
      document.addEventListener('readystatechange', function retry() { publish(enabled); }, { once: true });
      return;
    }
    html.setAttribute(STATE_ATTR, enabled ? 'on' : 'off');
    try { window.dispatchEvent(new Event(STATE_EVENT)); } catch (_) {}
  }

  function valueFromSettings(settings) {
    return !settings || settings[SETTING_KEY] !== false;
  }

  publish(true);

  try {
    chrome.storage.local.get(STORAGE_KEY, function (result) {
      try {
        if (chrome.runtime && chrome.runtime.lastError) return;
      } catch (_) {}
      publish(valueFromSettings(result && result[STORAGE_KEY]));
    });
  } catch (_) {}

  try {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'local' || !changes || !changes[STORAGE_KEY]) return;
      publish(valueFromSettings(changes[STORAGE_KEY].newValue));
    });
  } catch (_) {}
})();
