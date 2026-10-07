/* ChronOar – Service Worker (Offline-Speicher)
 *
 * - App-Dateien werden beim Installieren gecacht, damit die App ohne Netz startet.
 * - index.html, config.json, relationen.csv, anleitung.html: online immer frisch (Updates kommen sofort an), offline aus dem Cache.
 * - Anfragen an andere Server (Google-Sheet-Skript) laufen NIE über den Cache,
 *   damit die Sportlerliste immer aktuell ist.
 *
 * Nach Änderungen an Dateien in FILES: CACHE-Version hochzählen.
 */
const CACHE = "chronoar-v7";
const FILES = ["./", "./index.html", "./config.json", "./manifest.webmanifest", "./jsqr.min.js", "./qrcode.min.js",
  "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png", "./anleitung.html", "./relationen.csv"];
const FRESH = ["/", "/index.html", "/config.json", "/anleitung.html", "/relationen.csv"];

self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  const sameOrigin = url.origin === self.location.origin;
  const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!sameOrigin && !isFont) return;               // Google-Sheet-Skript usw.: direkt ins Netz

  const scopePath = new URL(self.registration.scope).pathname;
  const rel = "/" + url.pathname.slice(scopePath.length);
  if (req.mode === "navigate" || FRESH.includes(rel)) {  // erst Netz, dann Cache
    e.respondWith(fetch(req).then(r => {
      if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(req.mode === "navigate" ? "./index.html" : req, c)); }
      return r;
    }).catch(() => caches.match(req.mode === "navigate" ? "./index.html" : req, { ignoreSearch: true })));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {   // erst Cache, dann Netz
    if (r.ok || r.type === "opaque") { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
    return r;
  })));
});
