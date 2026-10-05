// 온라인이면 항상 최신 파일을 받아 쓰고(화면 수정이 바로 반영됨), 오프라인일 때만 저장해 둔 사본을 쓴다.
const CACHE = "dividend-v3"; // 배포 워크플로가 매번 새 값으로 바꿔서, 설치된 앱이 새 버전을 받는다
const SHELL = ["./", "index.html", "app.js", "engine.js", "charts.js", "accounts.js", "data.json", "manifest.webmanifest", "icon-192.png"];

self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return r;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("index.html"))),
  );
});
