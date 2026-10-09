// 朝刊アプリのオフライン用キャッシュ
const VERSION = "asa-v2";
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png",
  "vendor/marked.min.js", "vendor/purify.min.js", "vendor/leaflet.js", "vendor/leaflet.css",
  "vendor/images/marker-icon.png", "vendor/images/marker-icon-2x.png", "vendor/images/marker-shadow.png"];
const RUNTIME = "asa-runtime-v1";
const RUNTIME_HOSTS = ["upload.wikimedia.org", "tile.openstreetmap.org", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== RUNTIME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // 画面のファイル:ネットを先に試し、だめならキャッシュ(更新がすぐ届くように)
    e.respondWith(fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(VERSION).then(c => c.put(req, cp)); } return r; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
    return;
  }
  if (RUNTIME_HOSTS.includes(url.hostname)) {
    // 写真・地図・フォント:キャッシュがあればそれを使う
    e.respondWith(caches.open(RUNTIME).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok || r.type === "opaque") { c.put(req, r.clone()); trim(c); }
      return r;
    }));
  }
});
async function trim(c) {
  const ks = await c.keys();
  for (let i = 0; i < ks.length - 400; i++) await c.delete(ks[i]);
}
