(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CDLReviewPrompt = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STORAGE_KEY = 'cdlReviewPrompt';
  var SUCCESS_THRESHOLD = 3;
  var updateQueue = Promise.resolve();

  function normalizeState(value) {
    var source = value && typeof value === 'object' ? value : {};
    var successfulDownloads = Math.max(
      0,
      Math.floor(Number(source.successfulDownloads) || 0)
    );
    var shown = source.shown === true;
    return {
      successfulDownloads: successfulDownloads,
      eligible: !shown && (source.eligible === true || successfulDownloads >= SUCCESS_THRESHOLD),
      shown: shown,
      shownAt: shown && Number.isFinite(Number(source.shownAt))
        ? Number(source.shownAt)
        : null,
      shownVersion: shown && typeof source.shownVersion === 'string'
        ? source.shownVersion
        : '',
    };
  }

  function withSerializedUpdate(task) {
    var operation = updateQueue.catch(function () {}).then(task);
    updateQueue = operation.catch(function () {});
    return operation;
  }

  async function readState(storage) {
    var values = await storage.get(STORAGE_KEY);
    return normalizeState(values && values[STORAGE_KEY]);
  }

  function writeState(storage, state) {
    var values = {};
    values[STORAGE_KEY] = state;
    return storage.set(values);
  }

  function recordSuccessfulDownload(storage) {
    return withSerializedUpdate(async function () {
      var state = await readState(storage);
      if (state.shown) return state;
      state.successfulDownloads += 1;
      state.eligible = state.successfulDownloads >= SUCCESS_THRESHOLD;
      await writeState(storage, state);
      return state;
    });
  }

  function claimPrompt(storage, version, now) {
    return withSerializedUpdate(async function () {
      var state = await readState(storage);
      if (!state.eligible || state.shown) {
        return { show: false, state: state };
      }
      state.eligible = false;
      state.shown = true;
      state.shownAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
      state.shownVersion = typeof version === 'string' ? version : '';
      await writeState(storage, state);
      return { show: true, state: state };
    });
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    SUCCESS_THRESHOLD: SUCCESS_THRESHOLD,
    normalizeState: normalizeState,
    readState: readState,
    recordSuccessfulDownload: recordSuccessfulDownload,
    claimPrompt: claimPrompt,
  };
});
