'use strict';

const archiveUrls = new Map();
let maintenanceTimer = null;

function scheduleMaintenance() {
  if (maintenanceTimer) return;
  maintenanceTimer = setTimeout(async () => {
    maintenanceTimer = null;
    try { await chrome.runtime.sendMessage({ action: 'cdlDownloadUrlMaintenance' }); } catch (_) {}
    scheduleMaintenance();
  }, 30000);
}

function revokeArchiveUrl(id) {
  const url = archiveUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  archiveUrls.delete(id);
}

navigator.serviceWorker.addEventListener('message', (event) => {
  const { data, ports, source } = event;
  if (data?.target !== 'cdl-download-url' || !ports[0] ||
      source?.scriptURL !== chrome.runtime.getURL('background.js')) return;
  const port = ports[0];
  try {
    let response;
    if (data.command === 'create') {
      if (typeof data.id !== 'string' || !data.id || !(data.blob instanceof Blob)) {
        throw new Error('Invalid archive data.');
      }
      if (!archiveUrls.has(data.id)) archiveUrls.set(data.id, URL.createObjectURL(data.blob));
      response = { url: archiveUrls.get(data.id) };
    } else if (data.command === 'revoke') {
      revokeArchiveUrl(data.id);
      response = {};
    } else if (data.command === 'list') {
      response = { entries: [...archiveUrls].map(([id, url]) => ({ id, url })) };
    } else if (data.command === 'prune') {
      const ids = new Set(data.ids), urls = new Set(data.urls);
      for (const [id, url] of archiveUrls) {
        if (!ids.has(id) && !urls.has(url)) revokeArchiveUrl(id);
      }
      response = { count: archiveUrls.size };
    } else {
      throw new Error('Unknown archive operation.');
    }
    port.postMessage({ ok: true, ...response });
  } catch (error) {
    port.postMessage({ ok: false, error: error.message || 'Archive URL creation failed.' });
  } finally {
    port.close();
    scheduleMaintenance();
  }
});

scheduleMaintenance();
