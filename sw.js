const CACHE_NAME = "attendance-cache-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/src/config.js",
  "/src/main.js",
  "/vendor/html5-qrcode.min.js",
  "/vendor/qrcode.min.js",
  "/manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req).then((res) => {
        try {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        } catch {}
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
