"use strict";
const assert = require("node:assert/strict");
require("../core/cloud-library.js");
const Plus = require("../core/plus-core.js");

// Token refresh relies on the Web Locks API, which every supported browser has (and Node 24+).
// Older Node versions (CI runs Node 22) lack it, so provide the same one-at-a-time lock here.
if (!globalThis.navigator || !globalThis.navigator.locks) {
  const queues = new Map();
  const locks = {
    request(name, callback) {
      const run = (queues.get(name) || Promise.resolve()).then(() => callback({ name }));
      queues.set(name, run.catch(() => {}));
      return run;
    },
  };
  if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "locks", { value: locks, configurable: true });
  else globalThis.navigator = { locks };
}

(async () => {
  const store = {
    [Plus.SECRET_KEY]: {
      tokens: { accessToken: "expired", refreshToken: "original" },
    },
  };
  const chrome = {
    runtime: {},
    storage: {
      local: {
        get(keys, cb) {
          const result = {};
          for (const key of Array.isArray(keys) ? keys : [keys])
            result[key] = structuredClone(store[key]);
          cb(result);
        },
        set(value, cb) {
          Object.assign(store, structuredClone(value));
          cb();
        },
      },
    },
  };
  let refreshes = 0,
    legacyWorker = false;
  const fetch = async (url, init) => {
    if (url.endsWith("/v1/auth/refresh")) {
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(JSON.parse(init.body).refreshToken, "original");
      return Response.json({
        ok: true,
        tokens: { accessToken: "fresh", refreshToken: "rotated" },
      });
    }
    if (init.headers.Authorization !== "Bearer fresh")
      return Response.json({ ok: false }, { status: 401 });
    return Response.json({
      ok: true,
      account: {
        id: legacyWorker ? undefined : "user",
        state: "active",
        device: { id: "device" },
      },
    });
  };
  const background = Plus.createService({ chrome, fetch });
  const libraryTab = Plus.createService({ chrome, fetch });
  await Promise.all(
    [background, libraryTab, background, libraryTab].map((service) =>
      service.handleMessage({ action: "plusRefreshAccount" }),
    ),
  );
  assert.equal(
    refreshes,
    1,
    "Background and library tabs must not race the same rotating refresh token.",
  );
  assert.equal(store[Plus.SECRET_KEY].tokens.refreshToken, "rotated");
  legacyWorker = true;
  delete store[Plus.STATE_KEY].account.id;
  store[Plus.SECRET_KEY].dek = btoa("x".repeat(32));
  await assert.rejects(
    () => libraryTab.library.list(),
    (error) => error.code === "LIBRARY_SERVER_UPDATE_REQUIRED",
  );
  assert.equal(
    (await libraryTab.publicView()).signedIn,
    true,
    "An old server is not a failed login.",
  );
  legacyWorker = false;
  await libraryTab.handleMessage({ action: "plusRefreshAccount" });
  delete store[Plus.SECRET_KEY].dek;
  await assert.rejects(
    () => libraryTab.library.list(),
    (error) => error.code === "LIBRARY_LOCKED",
  );
  assert.equal(
    (await libraryTab.publicView()).signedIn,
    true,
    "A missing encryption key is not a failed login.",
  );
  console.log(
    "PASS shared PLUS authentication: one token refresh across background and library contexts.",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
