/* Service Worker админки — офлайн-кэш оболочки.
   ВАЖНО: лежит в КОРНЕ сайта (рядом с index.html), иначе PWA/scope не работают. */
const CACHE = "daria-admin-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./assets/fonts.css",
  "./assets/fonts/material-symbols.woff2",
  "./assets/fonts/inter-cyrillic.woff2",
  "./assets/fonts/inter-cyrillic-ext.woff2",
  "./assets/fonts/inter-latin.woff2"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  // network-first для навигации, cache-first для статики
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("./index.html")));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});

// Клик по уведомлению → открыть/сфокусировать админку
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow("./index.html");
    })
  );
});
