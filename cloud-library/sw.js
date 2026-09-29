const SHELL = "cdl-library-shell-v1";
const FILES = [
  "./",
  "./library.css",
  "./library.js",
  "../core/cloud-library.js",
  "../core/plus-core.js",
  "../lib/lucide.min.js",
  "../lib/jszip.min.js",
  "../icons/icon128.png",
  "../icons/icon.svg",
  "./manifest.webmanifest",
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(FILES)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("cdl-library-shell-") && k !== SHELL)
            .map((k) => caches.delete(k)),
        ),
      ),
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    !FILES.some((f) => new URL(f, self.location.href).pathname === url.pathname)
  )
    return;
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request).then((r) => r || Response.error()),
    ),
  );
});
