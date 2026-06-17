// のりかえNavi Service Worker
const CACHE = 'norinavi-v7';
const TILE_CACHE = 'norinavi-tiles-v1';
const TILE_LIMIT = 600; // 地図タイルのキャッシュ上限(古いものから削除)
const ASSETS = ['./', './index.html', './styles.css', './app.js', './data.js', './realtime.js', './busdata.js', './manifest.json',
  './icon.svg', './icon-192.png', './icon-512.png', './icon-180.png', './icon-512-maskable.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE && k !== TILE_CACHE).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

// 地図タイル(地理院タイル)はキャッシュ優先で実行時キャッシュ → 訪問済み領域はオフラインでも表示
function isTile(url) {
  return url.includes('cyberjapandata.gsi.go.jp') || url.includes('tile') && url.endsWith('.png');
}
async function tileFirst(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) {
      cache.put(req, res.clone());
      trimCache(TILE_CACHE, TILE_LIMIT);
    }
    return res;
  } catch {
    return hit || Response.error();
  }
}
async function trimCache(name, limit) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length > limit) for (let i = 0; i < keys.length - limit; i++) cache.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  if (isTile(url)) { e.respondWith(tileFirst(e.request)); return; }
  // アプリ本体はネットワーク優先・オフライン時はキャッシュ
  e.respondWith(
    fetch(e.request).then(res => {
      if (url.startsWith(self.location.origin) && res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() =>
      caches.match(e.request).then(hit => hit || caches.match('./index.html'))
    )
  );
});
