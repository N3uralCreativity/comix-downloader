/* global CDLPlus, CDLCloudLibrary, JSZip, lucide */
"use strict";
const $ = (id) => document.getElementById(id),
  icons = () => lucide.createIcons();
const adapter = {
  runtime: {},
  permissions: { contains: (_p, cb) => cb(true) },
  storage: {
    local: {
      get(keys, cb) {
        const all = JSON.parse(
            localStorage.getItem("cdl-library-account") || "{}",
          ),
          out = {};
        for (const k of typeof keys === "string"
          ? [keys]
          : keys || Object.keys(all))
          out[k] = all[k];
        cb(out);
      },
      set(value, cb) {
        const all = JSON.parse(
          localStorage.getItem("cdl-library-account") || "{}",
        );
        localStorage.setItem(
          "cdl-library-account",
          JSON.stringify({ ...all, ...value }),
        );
        cb?.();
      },
      remove(keys, cb) {
        const all = JSON.parse(
          localStorage.getItem("cdl-library-account") || "{}",
        );
        for (const k of Array.isArray(keys) ? keys : [keys]) delete all[k];
        localStorage.setItem("cdl-library-account", JSON.stringify(all));
        cb?.();
      },
    },
  },
};
const extension = !!globalThis.chrome?.runtime?.id;
// Only the testing service labels itself; the public service shows no label.
$("test-label").hidden = extension
  ? CDLPlus.CHANNEL !== "testing"
  : location.hostname === new URL(CDLPlus.API_ORIGINS.production).hostname;
const service = CDLPlus.createService({
    chrome: extension ? chrome : adapter,
    apiOrigin: extension ? CDLPlus.API_ORIGIN : location.origin,
  }),
  library = service.library;
document.querySelector(".brand img").src = "../icons/icon128.png";
document.querySelector('a[href="/account"]').href =
  (extension ? CDLPlus.API_ORIGIN : location.origin) + "/account";
let data = { nodes: [], progress: [] },
  currentFolder = null,
  view = "library",
  selected = new Set(),
  readerNode = null,
  currentPage = 0,
  readerGeneration = 0,
  observer = null,
  progressTimer = null,
  pendingProgress = null,
  progressChain = Promise.resolve(),
  pageLoads = Promise.resolve(),
  objectUrls = new Set(),
  scrollFrame = 0,
  authSignature = null,
  sessionBusy = false;
const imageTypes = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
};
const imageName = (name) => /\.(jpe?g|png|webp|avif)$/i.test(name);
function notice(text, error = false) {
  $("notice").hidden = !text;
  $("notice").textContent = text || "";
  $("notice").classList.toggle("error", error);
}
function report(error) {
  // WebCrypto failures carry no message; never show a bare "OperationError".
  notice(
    error?.name === "OperationError"
      ? "Part of your library could not be decrypted on this browser. Sign out and sign in again to reload your key."
      : error.message || String(error),
    true,
  );
  if (
    [
      "LIBRARY_SERVER_UPDATE_REQUIRED",
      "LIBRARY_DISABLED",
      "LIBRARY_INVITE_REQUIRED",
    ].includes(error.code)
  ) {
    $("workspace").hidden = true;
    $("auth").hidden = false;
    $("login").hidden = true;
    $("verify").hidden = true;
    $("unlock").hidden = true;
    $("setup").hidden = false;
    $("setup-message").textContent =
      error.code === "LIBRARY_DISABLED"
        ? "You are signed in, but Cloud Library is not available right now. Try again later."
        : error.message;
    notice("");
  }
}
function button(label, icon, action) {
  const b = document.createElement("button");
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  const i = document.createElement("i");
  i.dataset.lucide = icon;
  b.append(i);
  b.onclick = () => task(action, b);
  return b;
}
async function task(action, control) {
  if (control) control.disabled = true;
  try {
    return await action();
  } catch (e) {
    report(e);
  } finally {
    if (control) control.disabled = false;
    icons();
  }
}
async function call(action, extra = {}) {
  return service.handleMessage({ action, ...extra });
}
// On the website, the library shares one sign-in with the account page and the
// extension in this browser (see /site-session.js on the Plus service).
const siteReady = extension
  ? Promise.resolve(null)
  : new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "/site-session.js";
      script.onload = () => resolve(window.CDLPlusSite || null);
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
    });
async function webApi(path, body) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || result.ok === false)
    throw Object.assign(
      new Error(result?.error?.message || "The Plus service could not complete this request."),
      { code: result?.error?.code, requestId: result?.error?.requestId },
    );
  return result;
}
// Brings this library in line with the website sign-in: take it over when only the
// website is signed in, or restore the website sign-in when only the library is.
async function syncWithSite(state) {
  if (extension) return state;
  // Library tabs share one session: one tab at a time, re-reading it once inside the
  // lock, so two open tabs never sign in twice and leave an extra device behind.
  const run = async () => {
    state = await service.publicView();
    const site = await webApi("/v1/web/account").catch(() => ({ signedIn: false }));
    if (!state.signedIn && site.signedIn && site.account) {
      const created = await webApi("/v1/web/handoff-code", {});
      return call("plusRedeemHandoff", {
        code: created.code,
        email: site.account.email,
        deviceName: "Cloud Library · " + CDLPlus.describeBrowser(),
      });
    }
    if (state.signedIn && !site.signedIn) {
      const created = await call("plusCreateHandoff");
      await webApi("/v1/web/auth/handoff", { code: created.code });
      (await siteReady)?.stamp();
    }
    return state;
  };
  return navigator.locks
    ? navigator.locks.request("cdl-library-site-session", run)
    : run();
}
function formatBytes(value) {
  return value >= 1e9
    ? (value / 1e9).toFixed(2) + " GB"
    : (value / 1e6).toFixed(1) + " MB";
}
function theme(value) {
  document.documentElement.dataset.theme = value;
  localStorage.setItem("cdl-library-theme", value);
}
theme(localStorage.getItem("cdl-library-theme") || "dark");
$("theme").onclick = () =>
  theme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
async function session() {
  if (sessionBusy) return;
  sessionBusy = true;
  try {
    await renderSession();
  } finally {
    sessionBusy = false;
  }
}
const signature = (state) =>
  JSON.stringify([
    state.signedIn,
    state.state.account?.email,
    state.encryptionReady,
  ]);
async function renderSession() {
  let state = await service.publicView();
  try {
    state = await syncWithSite(state);
  } catch (error) {
    report(error);
  }
  authSignature = signature(state);
  notice("");
  $("setup").hidden = true;
  $("auth").hidden = false;
  $("workspace").hidden = true;
  $("reader").hidden = true;
  $("signout").hidden = !state.signedIn;
  $("login").hidden = state.signedIn || !extension;
  $("site-signin").hidden = state.signedIn || extension;
  $("verify").hidden = true;
  $("unlock").hidden = !state.signedIn;
  if (!state.signedIn) return;
  // Email sign-in is enough: the account's key is fetched for this browser.
  if (!state.encryptionReady) {
    try {
      state = await call("plusUnlock");
      authSignature = signature(state);
    } catch (error) {
      report(error);
    }
  }
  if (!state.encryptionReady) {
    const account = state.state.account || {};
    $("create-key").hidden = !!account.encryptionInitialized;
    $("legacy-recovery").hidden = !account.encryptionInitialized || !!account.keyEscrow;
    $("unlock-message").textContent = account.encryptionInitialized
      ? "You are signed in, but your library could not be unlocked on this browser yet. Check your connection and try again."
      : "You are signed in. Set up encryption once for this account to start your library.";
    return;
  }
  $("auth").hidden = true;
  $("workspace").hidden = false;
  await refresh();
}
$("retry-setup").onclick = () => task(session, $("retry-setup"));
async function changedSession() {
  if (sessionBusy) return;
  const state = await service.publicView();
  if (signature(state) === authSignature) return;
  library.pause();
  pendingProgress = null;
  clearTimeout(progressTimer);
  releasePages();
  readerNode = null;
  data = { nodes: [], progress: [] };
  $("items").replaceChildren();
  await session();
}
if (extension && chrome.storage.onChanged)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      area === "local" &&
      (changes[CDLPlus.STATE_KEY] || changes[CDLPlus.SECRET_KEY])
    )
      task(changedSession);
  });
else
  window.addEventListener("storage", (event) => {
    if (event.key === "cdl-library-account") task(changedSession);
  });
window.addEventListener("focus", () => task(changedSession));
siteReady.then((site) =>
  site?.onSiteChanged(async () => {
    if (!(await service.publicView()).signedIn) task(session);
  }),
);
$("login").onsubmit = (e) => {
  e.preventDefault();
  task(async () => {
    await call("plusRequestCode", { email: $("email").value });
    $("verify").hidden = false;
    notice("A sign-in code has been sent to your email.");
  }, e.submitter);
};
$("verify").onsubmit = (e) => {
  e.preventDefault();
  task(async () => {
    await call("plusVerifyCode", {
      email: $("email").value,
      code: $("code").value,
      deviceName: $("device-name").value,
      intent: "login",
    });
    notice("");
    await session();
  }, e.submitter);
};
$("recovery").onsubmit = (e) => {
  e.preventDefault();
  task(async () => {
    await call("plusRecover", { recoveryCode: $("recovery-code").value });
    $("recovery-code").value = "";
    await session();
  }, e.submitter);
};
$("retry-unlock").onclick = () =>
  task(async () => {
    await call("plusUnlock");
    await session();
  });
$("create-key").onclick = () =>
  task(async () => {
    await call("plusBootstrapEncryption");
    await session();
  });
$("signout").onclick = () =>
  task(async () => {
    library.pause();
    await closeReader();
    const site = await siteReady;
    if (site) await site.signOut();
    else {
      // Revoke the website session first, or the next check signs the library back in.
      if (!extension) await webApi("/v1/web/logout", {}).catch(() => {});
      await call("plusSignOut");
    }
    data = { nodes: [], progress: [] };
    $("items").replaceChildren();
    notice("");
    await session();
  });
async function refresh() {
  data = await library.list();
  $("storage-label").textContent =
    formatBytes(data.usage.bytes) + " / " + formatBytes(data.limits.account);
  $("storage-bar").max = data.limits.account;
  $("storage-bar").value = data.usage.bytes;
  $("import").disabled = !data.writable;
  $("new-folder").disabled = !data.writable;
  if (data.offline) notice("Offline library. Only saved pages are available.");
  render();
}
function breadcrumbs() {
  $("breadcrumbs").replaceChildren();
  const root = document.createElement("button");
  root.textContent =
    view === "trash"
      ? "Trash"
      : view === "transfers"
        ? "Transfers"
        : "My library";
  root.onclick = () => {
    currentFolder = null;
    render();
  };
  $("breadcrumbs").append(root);
  let n = data.nodes.find((n) => n.id === currentFolder),
    chain = [],
    seen = new Set();
  while (n && !seen.has(n.id)) {
    seen.add(n.id);
    chain.unshift(n);
    n = data.nodes.find((p) => p.id === n.parent_id);
  }
  for (const p of chain) {
    const b = document.createElement("button");
    b.textContent = "/ " + p.details.name;
    b.onclick = () => {
      currentFolder = p.id;
      render();
    };
    $("breadcrumbs").append(b);
  }
}
function render() {
  breadcrumbs();
  $("transfers").hidden = view !== "transfers";
  $("items").hidden = view === "transfers";
  $("empty").hidden = true;
  if (view === "transfers") {
    task(renderTransfers);
    return;
  }
  const needle = $("search").value.toLowerCase();
  let nodes = data.nodes.filter(
    (n) =>
      n.state !== "purging" &&
      (view === "trash" ? !!n.deleted_at : !n.deleted_at) &&
      (needle || view === "trash" || n.parent_id === currentFolder) &&
      n.details.name.toLowerCase().includes(needle),
  );
  nodes.sort((a, b) =>
    a.kind === b.kind
      ? $("sort").value === "recent"
        ? b.created_at.localeCompare(a.created_at)
        : a.details.name.localeCompare(b.details.name, undefined, {
            numeric: true,
          })
      : a.kind === "folder"
        ? -1
        : 1,
  );
  $("items").replaceChildren();
  $("empty").hidden = !!nodes.length;
  $("empty").querySelector("h2").textContent =
    view === "trash" ? "Trash is empty" : "No chapters or folders";
  for (const n of nodes) {
    const card = document.createElement("article");
    card.className = "item " + n.kind;
    const select = document.createElement("input");
    select.type = "checkbox";
    select.className = "select-item";
    select.setAttribute("aria-label", "Select " + n.details.name);
    select.checked = selected.has(n.id);
    select.onchange = () => {
      select.checked ? selected.add(n.id) : selected.delete(n.id);
      selection();
    };
    const cover = button(
      n.details.name,
      n.kind === "folder" ? "folder" : "book-open",
      async () => {
        if (view === "trash") return;
        if (n.kind === "folder") {
          currentFolder = n.id;
          selected.clear();
          render();
        } else await read(n);
      },
    );
    cover.className = "cover";
    const preview =
      n.details.thumbnail ||
      (n.details.isSeries &&
        data.nodes.find(
          (child) =>
            child.parent_id === n.id &&
            child.kind === "chapter" &&
            !child.deleted_at,
        )?.details.thumbnail);
    if (
      preview &&
      /^data:image\/(jpeg|png|webp);base64,[a-zA-Z0-9+/=]+$/.test(preview)
    ) {
      const img = new Image();
      img.src = preview;
      img.alt = n.details.name;
      cover.replaceChildren(img);
      if (n.details.isSeries) card.classList.remove("folder");
    }
    const details = document.createElement("div");
    details.className = "item-details";
    const name = document.createElement("h2");
    name.textContent = n.details.name;
    const subtitle = document.createElement("small");
    subtitle.textContent =
      n.kind === "folder"
        ? "Folder"
        : n.page_count +
          " pages" +
          (n.state === "uploading" ? " / Incomplete" : "");
    const actions = document.createElement("div");
    actions.className = "item-actions";
    if (view === "trash") {
      actions.append(
        button("Restore", "rotate-ccw", async () => {
          await library.restore(n.id);
          await refresh();
        }),
        button("Delete permanently", "trash-2", async () => {
          if (
            await confirmAction(
              "Delete permanently?",
              n.details.name +
                " will no longer be accessible. Storage is reclaimed by scheduled cleanup.",
            )
          ) {
            await library.purge(n.id);
            await refresh();
          }
        }),
      );
    } else {
      actions.append(
        button("Rename", "pencil", async () => {
          const result = await edit("Rename", n.details.name, false);
          if (result) {
            await library.update(n, { ...n.details, name: result.name });
            await refresh();
          }
        }),
        button("Move", "folder-input", () => move([n.id])),
        button("Move to trash", "trash-2", async () => {
          if (
            await confirmAction(
              "Move to trash?",
              n.details.name +
                " and its contents will be kept for up to 7 days.",
            )
          ) {
            await library.trash(n.id);
            await refresh();
          }
        }),
      );
    }
    details.append(name, subtitle, actions);
    card.append(select, cover, details);
    $("items").append(card);
  }
  selection();
  icons();
}
function selection() {
  $("bulk").hidden = !selected.size || view !== "library";
  $("selection-count").textContent = selected.size + " selected";
}
document.querySelectorAll("[data-view]").forEach(
  (b) =>
    (b.onclick = () => {
      view = b.dataset.view;
      currentFolder = null;
      selected.clear();
      document
        .querySelectorAll("[data-view]")
        .forEach((x) => x.classList.toggle("active", x === b));
      render();
    }),
);
$("search").oninput = render;
$("sort").onchange = render;
$("layout").onclick = () => {
  $("items").classList.toggle("list");
};
$("refresh").onclick = () => task(refresh);
$("clear-selected").onclick = () => {
  selected.clear();
  render();
};
$("move-selected").onclick = () => task(() => move([...selected]));
$("trash-selected").onclick = () =>
  task(async () => {
    if (
      !(await confirmAction(
        "Move selected items to trash?",
        selected.size + " items selected.",
      ))
    )
      return;
    for (const id of selected) await library.trash(id);
    selected.clear();
    await refresh();
  });
function edit(title, name, showParent, copy = "") {
  $("editor-title").textContent = title;
  $("edit-name").value = name || "";
  $("name-label").hidden = name === null;
  $("edit-name").required = name !== null;
  $("parent-label").hidden = !showParent;
  $("editor-copy").textContent = copy;
  $("edit-parent").replaceChildren(new Option("My library", ""));
  for (const n of data.nodes.filter(
    (n) => n.kind === "folder" && !n.deleted_at && n.state === "ready",
  ))
    $("edit-parent").add(new Option(n.details.name, n.id));
  $("edit-parent").value = currentFolder || "";
  $("editor-submit").textContent =
    name === null && !showParent ? "Confirm" : "Save";
  $("editor").showModal();
  return new Promise((resolve) => {
    $("editor").addEventListener(
      "close",
      () =>
        resolve(
          $("editor").returnValue === "save"
            ? {
                name: $("edit-name").value.trim(),
                parentId: $("edit-parent").value || null,
              }
            : null,
        ),
      { once: true },
    );
  });
}
const confirmAction = (title, copy) => edit(title, null, false, copy);
async function move(ids) {
  const result = await edit("Move to folder", null, true);
  if (!result) return;
  for (const id of ids) {
    const n = data.nodes.find((n) => n.id === id);
    if (n) await library.update(n, n.details, result.parentId);
  }
  selected.clear();
  await refresh();
}
$("new-folder").onclick = () =>
  task(async () => {
    const result = await edit("New folder", "", false);
    if (result?.name) {
      await library.folder(result.name, currentFolder);
      await refresh();
    }
  });
$("clear-offline").onclick = () =>
  task(async () => {
    await library.clearOffline();
    notice("Offline pages removed from this device.");
  });
$("import").onclick = () => $("files").click();
async function thumbnail(file) {
  const blob = new Blob([
      file.arrayBuffer ? await file.arrayBuffer() : file.buffer,
    ]),
    bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = 100;
  canvas.height = Math.min(
    160,
    Math.round((bitmap.height * 100) / bitmap.width),
  );
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.55);
}
$("files").onchange = () =>
  task(async () => {
    const files = [...$("files").files];
    $("files").value = "";
    if (!files.length) return;
    const archives = files.filter((f) => /\.(cbz|zip)$/i.test(f.name));
    if (archives.length && (archives.length !== 1 || files.length !== 1))
      throw new Error(
        "Import one CBZ at a time, or select a chapter of images.",
      );
    let images = files.filter((f) => imageName(f.name));
    if (archives.length) {
      if (archives[0].size > 256 * 1024 * 1024)
        throw new Error("Each import can be up to 256 MiB.");
      const zip = await JSZip.loadAsync(archives[0]),
        entries = Object.values(zip.files).filter(
          (f) => !f.dir && imageName(f.name),
        );
      let total = 0;
      if (!entries.length || entries.length > 1000)
        throw new Error("The archive must contain 1 to 1000 images.");
      for (const f of entries) {
        const size = f._data?.uncompressedSize;
        if (!Number.isSafeInteger(size) || size > CDLCloudLibrary.MAX_PAGE)
          throw new Error("An archive page exceeds the 8 MiB limit.");
        total += size;
      }
      if (total > 256 * 1024 * 1024)
        throw new Error("Expanded chapter exceeds the 256 MiB test limit.");
      images = [];
      for (const f of entries) {
        const buffer = await f.async("uint8array");
        if (buffer.length > CDLCloudLibrary.MAX_PAGE)
          throw new Error("Expanded page exceeds the size limit.");
        images.push({ name: f.name, buffer });
      }
    }
    images.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    if (!images.length)
      throw new Error("Select supported image files or a CBZ.");
    const result = await edit(
      "Import chapter",
      archives[0]?.name.replace(/\.(cbz|zip)$/i, "") || "Chapter",
      true,
    );
    if (!result?.name) return;
    notice("Preparing encrypted pages...");
    await library.saveChapter(
      {
        name: result.name,
        parentId: result.parentId,
        files: images,
        thumbnail: await thumbnail(images[0]),
      },
      (p) => notice(`Uploading ${p.completed} / ${p.total} pages`),
    );
    notice("Chapter saved to Cloud Library.");
    await refresh();
  });
async function renderTransfers() {
  const jobs = await library.jobs();
  $("transfers").replaceChildren();
  if (!jobs.length) {
    const p = document.createElement("p");
    p.textContent = "No pending transfers.";
    $("transfers").append(p);
  }
  for (const job of jobs) {
    const row = document.createElement("div");
    row.className = "transfer";
    const title = document.createElement("strong");
    title.textContent = job.name;
    const info = document.createElement("small");
    info.textContent = job.node.pages.length + " pages";
    row.append(
      title,
      info,
      button("Resume upload", "play", async () => {
        await library.resume(job.id, (p) => {
          info.textContent = p.completed + " / " + p.total;
        });
        notice("Upload complete.");
        await refresh();
      }),
      button("Pause upload", "pause", () => library.pause()),
      button("Cancel transfer", "x", async () => {
        library.pause();
        if (await confirmAction("Cancel this transfer?", job.name)) {
          await library.discard(job.id);
          await refresh();
        }
      }),
    );
    $("transfers").append(row);
  }
  icons();
}
function releasePages() {
  readerGeneration++;
  observer?.disconnect();
  observer = null;
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
  $("pages").replaceChildren();
}
async function closeReader() {
  await flushProgress();
  releasePages();
  readerNode = null;
  $("reader").hidden = true;
  $("workspace").hidden = false;
}
$("close-reader").onclick = () => task(closeReader);
async function read(n, pageOverride) {
  if (n.state !== "ready")
    throw new Error("Resume this chapter in Transfers before reading it.");
  await flushProgress();
  releasePages();
  readerNode = n;
  $("workspace").hidden = true;
  $("reader").hidden = false;
  $("reader-title").textContent = n.details.name;
  const progress = data.progress.find((p) => p.node_id === n.id);
  currentPage = Math.min(
    n.page_count - 1,
    pageOverride ?? progress?.details?.page ?? 0,
  );
  $("page-total").textContent = "/ " + n.page_count;
  $("page-number").max = n.page_count;
  $("page-number").value = currentPage + 1;
  const generation = readerGeneration,
    mode = $("reading-mode").value;
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        e.target.dataset.near = String(e.isIntersecting);
        if (e.isIntersecting) load(Number(e.target.dataset.page), generation);
        else unload(e.target);
      }
    },
    { rootMargin: "500px 0px" },
  );
  for (let i = 0; i < n.page_count; i++) {
    const holder = document.createElement("div");
    holder.className = "page loading";
    holder.dataset.page = i;
    holder.textContent = "Page " + (i + 1);
    holder.hidden = mode !== "scroll" && i !== currentPage;
    $("pages").append(holder);
    if (mode === "scroll") observer.observe(holder);
  }
  if (mode === "scroll") $("pages").children[currentPage].scrollIntoView();
  else {
    load(currentPage, generation);
    window.scrollTo(0, 0);
  }
  icons();
}
function unload(holder) {
  const img = holder.querySelector("img");
  if (!img) return;
  const rect = holder.getBoundingClientRect();
  holder.style.aspectRatio = rect.width + "/" + rect.height;
  URL.revokeObjectURL(img.src);
  objectUrls.delete(img.src);
  holder.textContent = "Page " + (Number(holder.dataset.page) + 1);
  delete holder.dataset.loading;
  delete holder.dataset.loaded;
  holder.classList.add("loading");
}
window.addEventListener(
  "scroll",
  () => {
    if (scrollFrame || !readerNode || $("reading-mode").value !== "scroll")
      return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      const top = document
          .querySelector(".reader-tools")
          .getBoundingClientRect().bottom,
        bottom =
          innerHeight - document.querySelector(".page-tools").offsetHeight;
      let best = currentPage,
        area = 0;
      for (const holder of $("pages").children) {
        const rect = holder.getBoundingClientRect(),
          visible = Math.min(rect.bottom, bottom) - Math.max(rect.top, top);
        if (visible > area) {
          area = visible;
          best = Number(holder.dataset.page);
        }
      }
      if (best !== currentPage) {
        currentPage = best;
        $("page-number").value = best + 1;
        scheduleProgress();
      }
    });
  },
  { passive: true },
);
function load(index, generation) {
  const holder = $("pages").children[index];
  if (!holder || holder.dataset.loading || holder.dataset.loaded) return;
  holder.dataset.loading = "true";
  const n = readerNode;
  pageLoads = pageLoads
    .catch(() => {})
    .then(async () => {
      if (generation !== readerGeneration) return;
      try {
        if (holder.hidden || holder.dataset.near === "false") {
          delete holder.dataset.loading;
          return;
        }
        const data = await library.page(n.id, index);
        if (generation !== readerGeneration) return;
        if (holder.hidden || holder.dataset.near === "false") {
          delete holder.dataset.loading;
          return;
        }
        const mime =
          imageTypes[
            (n.details.names[index] || "").split(".").pop().toLowerCase()
          ] || "image/jpeg";
        const url = URL.createObjectURL(new Blob([data], { type: mime }));
        objectUrls.add(url);
        const img = new Image();
        img.src = url;
        img.alt = n.details.name + " - page " + (index + 1);
        holder.replaceChildren(img);
        holder.classList.remove("loading");
        holder.dataset.loaded = "true";
      } catch (e) {
        if (generation !== readerGeneration) return;
        holder.replaceChildren(
          button("Retry page", "refresh-cw", () => {
            delete holder.dataset.loading;
            load(index, generation);
          }),
        );
        report(e);
      }
    });
}
function scheduleProgress() {
  clearTimeout(progressTimer);
  if (!readerNode || data.offline || !data.writable) return;
  pendingProgress = { node: readerNode.id, page: currentPage };
  progressTimer = setTimeout(flushProgress, 800);
}
function flushProgress() {
  clearTimeout(progressTimer);
  const pending = pendingProgress;
  pendingProgress = null;
  if (!pending) return progressChain;
  progressChain = progressChain
    .catch(() => {})
    .then(async () => {
      const { node, page } = pending,
        previous = data.progress.find((p) => p.node_id === node);
      try {
        const result = await library.progress(
          node,
          { page },
          previous?.revision || 0,
        );
        data.progress = data.progress
          .filter((p) => p.node_id !== node)
          .concat({ ...result.progress, details: { page } });
      } catch (e) {
        if (e.code === "LIBRARY_CONFLICT")
          notice(
            "Reading progress changed on another device. Refresh the library before saving a new position.",
          );
        else report(e);
      }
    });
  return progressChain;
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushProgress();
});
function jump(index) {
  if (!readerNode || !Number.isFinite(index)) return;
  currentPage = Math.max(
    0,
    Math.min(readerNode.page_count - 1, Math.floor(index)),
  );
  $("page-number").value = currentPage + 1;
  if ($("reading-mode").value === "scroll")
    $("pages").children[currentPage].scrollIntoView();
  else {
    [...$("pages").children].forEach((p, i) => {
      p.hidden = i !== currentPage;
      if (p.hidden) unload(p);
    });
    load(currentPage, readerGeneration);
    window.scrollTo(0, 0);
  }
  scheduleProgress();
}
$("page-number").onchange = () => jump(Number($("page-number").value) - 1);
$("prev-page").onclick = () => jump(currentPage - 1);
$("next-page").onclick = () => jump(currentPage + 1);
$("reading-mode").onchange = () => task(() => read(readerNode, currentPage));
$("zoom").oninput = () =>
  $("pages").style.setProperty("--width", $("zoom").value + "%");
document.addEventListener("keydown", (e) => {
  if (!readerNode || e.target.matches("input,select")) return;
  const direction = $("reading-mode").value === "rtl" ? -1 : 1;
  if (e.key === "ArrowRight") {
    e.preventDefault();
    jump(currentPage + direction);
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    jump(currentPage - direction);
  }
});
$("next-chapter").onclick = () =>
  task(async () => {
    const siblings = data.nodes
      .filter(
        (n) =>
          n.parent_id === readerNode.parent_id &&
          n.kind === "chapter" &&
          n.state === "ready" &&
          !n.deleted_at,
      )
      .sort((a, b) =>
        a.details.name.localeCompare(b.details.name, undefined, {
          numeric: true,
        }),
      );
    const next =
      siblings[siblings.findIndex((n) => n.id === readerNode.id) + 1];
    if (next) await read(next);
    else notice("You reached the last saved chapter.");
  });
$("offline").onclick = () =>
  task(async () => {
    const n = readerNode;
    for (let i = 0; i < n.page_count; i++) {
      await library.page(n.id, i, true);
      notice(`Saving offline: ${i + 1} / ${n.page_count}`);
    }
    await navigator.storage?.persist?.();
    notice("Chapter saved on this device.");
  }, $("offline"));
$("export").onclick = () =>
  task(async () => {
    const n = readerNode,
      zip = new JSZip();
    for (let i = 0; i < n.page_count; i++) {
      const ext = n.details.names[i].split(".").pop().toLowerCase();
      zip.file(
        String(i + 1).padStart(4, "0") + "." + ext,
        await library.page(n.id, i),
      );
      notice(`Preparing export: ${i + 1} / ${n.page_count}`);
    }
    const blob = await zip.generateAsync({
        type: "blob",
        compression: "STORE",
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = n.details.name.replace(/[<>:"/\\|?*]/g, "_") + ".cbz";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    notice("CBZ export ready.");
  }, $("export"));
if (!extension && "serviceWorker" in navigator)
  navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
icons();
task(session);
