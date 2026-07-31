(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CDLUpdateState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STORAGE_KEY = 'cdlUpdateAvailable';

  function parseVersion(value) {
    var text = typeof value === 'string' ? value.trim() : '';
    if (!/^\d+(?:\.\d+){0,3}$/.test(text)) return null;
    return text.split('.').map(function (part) { return Number(part); });
  }

  function compareVersions(left, right) {
    var a = parseVersion(left);
    var b = parseVersion(right);
    if (!a || !b) return 0;
    var length = Math.max(a.length, b.length);
    for (var i = 0; i < length; i++) {
      var difference = (a[i] || 0) - (b[i] || 0);
      if (difference !== 0) return difference > 0 ? 1 : -1;
    }
    return 0;
  }

  function normalizeAvailableUpdate(value, currentVersion) {
    var source = value && typeof value === 'object' ? value : {};
    var version = typeof source.version === 'string' ? source.version.trim() : '';
    if (!parseVersion(currentVersion) || !parseVersion(version)) return null;
    if (compareVersions(version, currentVersion) <= 0) return null;
    var detectedAt = Number(source.detectedAt);
    return {
      version: version,
      detectedAt: Number.isFinite(detectedAt) && detectedAt > 0
        ? Math.floor(detectedAt)
        : 0,
    };
  }

  function createAvailableUpdate(version, currentVersion, now) {
    return normalizeAvailableUpdate({
      version: version,
      detectedAt: Number.isFinite(Number(now)) ? Number(now) : Date.now(),
    }, currentVersion);
  }

  function hasActiveDownloadWork(activity) {
    var state = activity && typeof activity === 'object' ? activity : {};
    return state.downloadAllActive === true ||
      Number(state.activeChapterDownloads) > 0 ||
      Number(state.queuedChapterDownloads) > 0 ||
      Number(state.pendingExtractionTabs) > 0 ||
      state.pendingArchive === true;
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    compareVersions: compareVersions,
    normalizeAvailableUpdate: normalizeAvailableUpdate,
    createAvailableUpdate: createAvailableUpdate,
    hasActiveDownloadWork: hasActiveDownloadWork,
  };
});
