// のりかえNavi Service Worker
const CACHE = 'norinavi-v2';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './data.js', './manifest.json',
  './icon.svg', './icon-192.png', './icon-512.png', './icon-180.png', './icon-512-maskable.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// ネットワーク優先(更新が即反映)・オフライン時はキャッシュにフォールバック
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (e.request.url.startsWith(self.location.origin) && res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() =>
      caches.match(e.request).then(hit => hit || caches.match('./index.html'))
    )
  );
});
