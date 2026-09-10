// Blob URL ownership for Chromium MV3. Archive bytes stay binary across the
// service worker / offscreen document boundary (runtime messaging is JSON-only).
(function (root) {
  'use strict';

  const DOCUMENT_PATH = 'offscreen/downloads.html';
  const TARGET = 'cdl-download-url';
  const REQUEST_TIMEOUT_MS = 15000;
  const retained = new Set();
  let operations = Promise.resolve();

  function serial(task) {
    const result = operations.then(task);
    operations = result.catch(() => {});
    return result;
  }

  function supported() {
    return typeof root.URL.createObjectURL === 'function' || !!(
      root.chrome?.offscreen?.createDocument && root.clients?.matchAll && root.MessageChannel
    );
  }

  async function findDocument() {
    const url = root.chrome.runtime.getURL(DOCUMENT_PATH);
    const clients = await root.clients.matchAll({ type: 'window', includeUncontrolled: true });
    return clients.find((client) => client.url === url);
  }

  async function ensureDocument() {
    let client = await findDocument();
    if (!client) {
      await root.chrome.offscreen.createDocument({
        url: DOCUMENT_PATH,
        reasons: ['BLOBS'],
        justification: 'Create temporary download URLs for ZIP, CBZ, and PDF files.',
      });
      client = await findDocument();
    }
    if (!client) throw new Error('The archive download document could not be opened.');
    return client;
  }

  function request(client, command, payload = {}) {
    return new Promise((resolve, reject) => {
      const channel = new root.MessageChannel();
      const finish = (error, response) => {
        clearTimeout(timer);
        channel.port1.close();
        channel.port2.close();
        if (error) reject(error);
        else resolve(response);
      };
      const timer = setTimeout(() => finish(new Error('The archive download document did not respond.')), REQUEST_TIMEOUT_MS);
      channel.port1.onmessage = ({ data }) => {
        if (data?.ok) finish(null, data);
        else finish(new Error(data?.error || 'The archive download URL could not be prepared.'));
      };
      channel.port1.onmessageerror = () => finish(new Error('The archive download message could not be read.'));
      try {
        // Client.postMessage uses structured clone, including Blob data. Do not
        // replace it with chrome.runtime.sendMessage for binary archives.
        client.postMessage({ target: TARGET, command, ...payload }, [channel.port2]);
      } catch (error) { finish(error); }
    });
  }

  async function fromBlob(blob) {
    let id;
    try {
      if (typeof root.URL.createObjectURL === 'function') {
        const url = root.URL.createObjectURL(blob);
        let released = false;
        return { url, revoke() {
          if (released) return;
          released = true;
          root.URL.revokeObjectURL(url);
        } };
      }
      if (!supported()) throw new Error('This browser cannot create archive download URLs.');
      id = root.crypto.randomUUID();
      retained.add(id);
      const result = await serial(async () => {
        const client = await ensureDocument();
        const response = await request(client, 'create', { id, blob });
        if (typeof response.url !== 'string' || !response.url.startsWith(`blob:${root.chrome.runtime.getURL('')}`)) {
          throw new Error('The archive download document returned an invalid URL.');
        }
        return response;
      });
      let releasePromise = null;
      return { url: result.url, revoke() {
        if (releasePromise) return releasePromise;
        retained.delete(id);
        releasePromise = serial(async () => {
          const client = await findDocument();
          if (client) await request(client, 'revoke', { id });
        }).catch(() => {});
        return releasePromise;
      } };
    } catch (error) {
      retained.delete(id);
      const failure = new Error(error?.message || String(error), { cause: error });
      failure.cdlKind = 'archive_url';
      failure.cdlPhase = 'archive_url';
      throw failure;
    }
  }

  async function maintain() {
    return serial(async () => {
      const client = await findDocument();
      if (!client) return;
      const { entries } = await request(client, 'list');
      // After a worker restart, keep URLs still used by the downloads manager.
      // Unclaimed URLs (including abandoned Save again state) can be released.
      const orphaned = entries.some((entry) => !retained.has(entry.id));
      const downloads = orphaned ? await root.chrome.downloads.search({ state: 'in_progress' }) : [];
      const { count } = await request(client, 'prune', {
        ids: [...retained], urls: downloads.map((item) => item.url),
      });
      if (count === 0 && retained.size === 0) await root.chrome.offscreen.closeDocument();
    });
  }

  if (root.clients && root.chrome?.runtime?.onMessage) {
    root.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.action !== 'cdlDownloadUrlMaintenance' ||
          sender.id !== root.chrome.runtime.id || sender.url !== root.chrome.runtime.getURL(DOCUMENT_PATH)) return;
      maintain().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    });
  }

  root.CDLDownloadUrl = { supported, fromBlob };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.CDLDownloadUrl;
})(typeof globalThis !== 'undefined' ? globalThis : this);
