(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CDLCloudLibrary = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const encoder = new TextEncoder(),
    decoder = new TextDecoder();
  const MAX_PAGE = 8 * 1024 * 1024 - 29;
  const id = () => "lib_" + crypto.randomUUID().replace(/-/g, "");
  const bytes = (value) =>
    value instanceof Uint8Array ? value : new Uint8Array(value);
  const b64 = (value) => {
    let s = "";
    for (const c of bytes(value)) s += String.fromCharCode(c);
    return btoa(s);
  };
  const unb64 = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  const hash = async (value) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          typeof value === "string" ? encoder.encode(value) : value,
        ),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  async function key(dek) {
    const material = await crypto.subtle.importKey("raw", dek, "HKDF", false, [
      "deriveKey",
    ]);
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode("cdl-cloud-library-v1"),
        info: encoder.encode("media-and-metadata"),
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }
  async function sourceIdentity(dek, source) {
    const material = await crypto.subtle.importKey("raw", dek, "HKDF", false, [
      "deriveKey",
    ]);
    const signingKey = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode("cdl-cloud-library-v1"),
        info: encoder.encode("source-identity"),
      },
      material,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign"],
    );
    return Array.from(
      new Uint8Array(
        await crypto.subtle.sign("HMAC", signingKey, encoder.encode(source)),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  }
  async function seal(data, dek, context) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
        await key(dek),
        data,
      ),
    );
    const result = new Uint8Array(13 + encrypted.length);
    result[0] = 1;
    result.set(iv, 1);
    result.set(encrypted, 13);
    return result;
  }
  async function open(data, dek, context) {
    data = bytes(data);
    if (data[0] !== 1 || data.length < 29)
      throw new Error("Unsupported encrypted library file.");
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: data.slice(1, 13),
          additionalData: encoder.encode(context),
        },
        await key(dek),
        data.slice(13),
      ),
    );
  }
  function createStore() {
    let db;
    async function database() {
      if (!db)
        db = new Promise((resolve, reject) => {
          const r = indexedDB.open("cdl-cloud-library", 1);
          r.onupgradeneeded = () => r.result.createObjectStore("records");
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
      return db;
    }
    async function transaction(mode, action) {
      const d = await database();
      return new Promise((resolve, reject) => {
        const tx = d.transaction("records", mode),
          r = action(tx.objectStore("records"));
        tx.oncomplete = () => resolve(r.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () =>
          reject(tx.error || new Error("Local storage write aborted."));
      });
    }
    return {
      get: (k) => transaction("readonly", (s) => s.get(k)),
      set: (k, v) => transaction("readwrite", (s) => s.put(v, k)),
      delete: (k) => transaction("readwrite", (s) => s.delete(k)),
      keys: () => transaction("readonly", (s) => s.getAllKeys()),
    };
  }
  function create(options) {
    const store = options.store || createStore();
    // Tests pass their own wait so retries do not sleep for real.
    const wait = options.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
    let transferring = null,
      stopped = false;
    const paused = () =>
      Object.assign(new Error("Upload paused. Resume it from Transfers."), {
        code: "LIBRARY_PAUSED",
      });
    async function transfer(action) {
      if (transferring) throw new Error("Another upload is running.");
      stopped = false;
      transferring = Promise.resolve().then(async () => {
        const c = await context();
        if (globalThis.navigator?.locks)
          return navigator.locks.request(
            "cdl-library-upload:" + c.user,
            { ifAvailable: true },
            (lock) => {
              if (!lock)
                throw new Error(
                  "Another library tab is uploading. Pause it before starting this transfer.",
                );
              return action();
            },
          );
        return action();
      });
      try {
        return await transferring;
      } finally {
        transferring = null;
      }
    }
    const request = options.request;
    async function context() {
      const c = await options.context();
      if (!c.user)
        throw Object.assign(new Error("Sign in to Comix Downloader Plus."), {
          code: "AUTH_REQUIRED",
        });
      if (!c.dek)
        throw Object.assign(
          new Error(
            "You are signed in, but this browser could not unlock your library yet. Check your connection and try again.",
          ),
          { code: "LIBRARY_LOCKED" },
        );
      return { ...c, dek: typeof c.dek === "string" ? unb64(c.dek) : c.dek };
    }
    const json = (method, body) => ({
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const path = (nodeId) => "/v1/library/nodes/" + nodeId;
    async function encode(value, c, nodeId, part = "metadata") {
      return b64(
        await seal(
          encoder.encode(JSON.stringify(value)),
          c.dek,
          `${c.user}/${nodeId}/${part}`,
        ),
      );
    }
    async function decode(value, c, nodeId, part = "metadata") {
      return JSON.parse(
        decoder.decode(
          await open(unb64(value), c.dek, `${c.user}/${nodeId}/${part}`),
        ),
      );
    }
    async function list() {
      const c = await context();
      let result;
      try {
        result = await request("/v1/library", { method: "GET" });
        await store.set(`index:${c.user}`, result);
      } catch (e) {
        if (e.code !== "PLUS_NETWORK_ERROR") throw e;
        result = await store.get(`index:${c.user}`);
        if (!result) throw e;
        result.offline = true;
        result.writable = false;
      }
      for (const n of result.nodes)
        n.details = await decode(n.metadata, c, n.id);
      for (const p of result.progress)
        p.details = await decode(p.metadata, c, p.node_id, "progress");
      return result;
    }
    async function folder(name, parentId = null, source = null) {
      const c = await context(),
        nodeId = id();
      return request(
        "/v1/library/nodes",
        json("POST", {
          id: nodeId,
          kind: "folder",
          parentId,
          metadata: await encode({ name, isSeries: !!source }, c, nodeId),
          sourceHash: source
            ? await sourceIdentity(c.dek, `${c.user}/folder/${source}`)
            : null,
        }),
      );
    }
    async function update(node, details, parentId = node.parent_id) {
      const c = await context();
      return request(
        path(node.id),
        json("PUT", {
          metadata: await encode(details, c, node.id),
          parentId,
          revision: node.revision,
        }),
      );
    }
    async function jobs() {
      const c = await context(),
        prefix = `job:${c.user}:`,
        keys = (await store.keys()).filter((k) => k.startsWith(prefix));
      const out = [];
      for (const k of keys) out.push(await store.get(k));
      return out;
    }
    async function upload(job, onProgress = () => {}) {
      const c = await context();
      if (c.user !== job.user)
        throw new Error("This upload belongs to another account.");
      if (stopped) throw paused();
      const created = await request(
        "/v1/library/nodes",
        json("POST", job.node),
      );
      if (created.node.id !== job.node.id || created.node.state === "ready") {
        if (created.node.state !== "ready" || created.node.deleted_at)
          throw new Error(
            "This chapter already has an unfinished or trashed upload. Resume or restore it first.",
          );
        await discard(job.id, false);
        return created.node;
      }
      const state = await request(path(job.node.id), { method: "GET" });
      let completed = state.pages.filter((p) => p.uploaded).length;
      for (const p of state.pages) {
        if (stopped) throw paused();
        if (!p.uploaded) {
          const data = await store.get(`page:${c.user}:${job.id}:${p.page}`);
          if (!data)
            throw new Error(
              "Local upload data is missing. Remove this transfer and import the chapter again.",
            );
          for (let attempt = 0; ; attempt++) {
            try {
              await request(path(job.node.id) + "/pages/" + p.page, {
                method: "PUT",
                headers: { "Content-Type": "application/octet-stream" },
                body: data,
              });
              break;
            } catch (e) {
              // Too many requests this minute: wait for the window to pass instead of
              // pausing. A daily limit also answers 429, but waiting cannot help there.
              const busy = e.status === 429 && e.code === "RATE_LIMITED";
              if (
                stopped ||
                attempt >= (busy ? 8 : 2) ||
                (e.status && e.status < 500 && !busy)
              )
                throw e;
              await wait(busy ? Math.min(30000, 5000 * (attempt + 1)) : 1000 * (attempt + 1));
            }
          }
          completed++;
        }
        onProgress({ completed, total: state.pages.length });
      }
      if (stopped) throw paused();
      const result = await request(
        path(job.node.id) + "/commit",
        json("POST", {}),
      );
      await discard(job.id, false);
      return result.node;
    }
    async function resumeJob(jobId, onProgress) {
      const c = await context(),
        job = await store.get(`job:${c.user}:${jobId}`);
      if (!job) throw new Error("Transfer not found.");
      return upload(job, onProgress);
    }
    function resume(jobId, onProgress) {
      return transfer(() => resumeJob(jobId, onProgress));
    }
    async function discard(jobId, remote = true) {
      if (remote && transferring) {
        stopped = true;
        await transferring.catch(() => {});
      }
      const c = await context(),
        jobKey = `job:${c.user}:${jobId}`,
        job = await store.get(jobKey);
      if (remote && job) {
        try {
          await request(path(job.node.id), { method: "DELETE" });
        } catch (e) {
          if (![404, 410].includes(e.status)) throw e;
        }
      }
      for (const k of await store.keys())
        if (k.startsWith(`page:${c.user}:${jobId}:`)) await store.delete(k);
      await store.delete(jobKey);
    }
    async function prepareChapter(
      { name, series, parentId = null, source, files, thumbnail, cover },
      onProgress,
    ) {
      const c = await context(),
        nodeId = id();
      if (!files.length || files.length > 1000)
        throw new Error("Choose between 1 and 1000 images.");
      let total = 0;
      for (const f of files) {
        const size = f.size ?? f.buffer?.byteLength ?? 0;
        total += size;
        if (size > MAX_PAGE)
          throw new Error("Each page must be smaller than 8 MiB.");
      }
      if (total > 256 * 1024 * 1024)
        throw new Error(
          "Each chapter import can be up to 256 MiB.",
        );
      if (series && !parentId)
        parentId = (await folder(series, null, series)).node.id;
      const sourceHash = source
        ? await sourceIdentity(c.dek, `${c.user}/chapter/${source}`)
        : null;
      if (sourceHash) {
        const pending = (await jobs()).find(
          (j) => j.node.sourceHash === sourceHash,
        );
        if (pending) return resumeJob(pending.id, onProgress);
        const index = await request("/v1/library", { method: "GET" }),
          existing = index.nodes.find((n) => n.source_hash === sourceHash);
        if (existing) {
          if (existing.state === "ready" && !existing.deleted_at)
            return existing;
          throw new Error(
            "This chapter is incomplete or in Trash. Resume or restore it in Cloud Library.",
          );
        }
      }
      const pages = [],
        names = [];
      try {
        if (
          !thumbnail &&
          typeof OffscreenCanvas !== "undefined" &&
          typeof createImageBitmap === "function"
        ) {
          try {
            // A series cover, when the caller has one, previews better than the
            // first page, which is often a scanlator credits page.
            const first = files[0],
              previewBytes = cover
                ? cover
                : first.arrayBuffer
                  ? await first.arrayBuffer()
                  : first.buffer,
              bitmap = await createImageBitmap(new Blob([previewBytes]));
            const canvas = new OffscreenCanvas(
              160,
              Math.min(256, Math.round((bitmap.height * 160) / bitmap.width)),
            );
            canvas
              .getContext("2d")
              .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            bitmap.close();
            thumbnail =
              "data:image/jpeg;base64," +
              b64(
                await (
                  await canvas.convertToBlob({
                    type: "image/jpeg",
                    quality: 0.6,
                  })
                ).arrayBuffer(),
              );
          } catch (_) {
            /* A cover preview is optional; original page bytes remain unchanged. */
          }
        }
        for (let i = 0; i < files.length; i++) {
          const f = files[i],
            data = bytes(f.arrayBuffer ? await f.arrayBuffer() : f.buffer);
          if (data.length > MAX_PAGE)
            throw new Error("Each page must be smaller than 8 MiB.");
          const encrypted = await seal(
            data,
            c.dek,
            `${c.user}/${nodeId}/page/${i}`,
          );
          pages.push({ size: encrypted.length, digest: await hash(encrypted) });
          names.push(f.name);
          await store.set(`page:${c.user}:${nodeId}:${i}`, encrypted);
        }
        let metadata = await encode(
          { name, series, names, thumbnail: thumbnail || null },
          c,
          nodeId,
        );
        // The Worker caps encrypted metadata at 64 KiB; a long page list wins over the preview.
        if (metadata.length > 60000)
          metadata = await encode(
            { name, series, names, thumbnail: null },
            c,
            nodeId,
          );
        const job = {
          id: nodeId,
          user: c.user,
          name,
          createdAt: new Date().toISOString(),
          node: {
            id: nodeId,
            kind: "chapter",
            parentId,
            pages,
            metadata,
            sourceHash,
          },
        };
        await store.set(`job:${c.user}:${nodeId}`, job);
      } catch (e) {
        await discard(nodeId, false);
        throw e;
      }
      return resumeJob(nodeId, onProgress);
    }
    function saveChapter(chapter, onProgress) {
      return transfer(() => prepareChapter(chapter, onProgress));
    }
    async function page(nodeId, index, offline = false) {
      const c = await context(),
        cacheKey = `cache:${c.user}:${nodeId}:${index}`;
      let data = await store.get(cacheKey);
      if (!data) {
        const result = await request(
          path(nodeId) + "/pages/" + index,
          { method: "GET" },
          true,
        );
        data = result.bytes;
      }
      if (offline) await store.set(cacheKey, data);
      return open(data, c.dek, `${c.user}/${nodeId}/page/${index}`);
    }
    async function progress(nodeId, details, revision = 0) {
      const c = await context();
      return request(
        path(nodeId) + "/progress",
        json("PUT", {
          metadata: await encode(details, c, nodeId, "progress"),
          revision,
        }),
      );
    }
    async function clearOffline() {
      const c = await context();
      for (const k of await store.keys())
        if (k.startsWith(`cache:${c.user}:`)) await store.delete(k);
    }
    return {
      list,
      folder,
      update,
      saveChapter,
      resume,
      jobs,
      discard,
      page,
      progress,
      clearOffline,
      pause: () => {
        stopped = true;
      },
      trash: (nodeId) => request(path(nodeId), { method: "DELETE" }),
      restore: (nodeId) => request(path(nodeId) + "/restore", json("POST", {})),
      purge: (nodeId) => request(path(nodeId) + "/purge", json("POST", {})),
    };
  }
  return { create, createStore, seal, open, hash, MAX_PAGE };
});
