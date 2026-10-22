/* 沙盤 service worker：介面檔案先用快取（秒開）；行情資料一律先抓網路，失敗才用上次的（並標記成離線，App 就不讓你下單）。
   注意：冷眼等其他 App 也在同一個網址底下，快取名稱一律用 sandtable- 開頭，也只清自己的舊快取。 */
const BUILD = '__BUILD__';
const SHELL = `sandtable-shell-${BUILD}`;
const DATA = 'sandtable-data';
const FONTS = 'sandtable-fonts';
const SHELL_FILES = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'src/app.js', 'src/rules.js', 'src/engine.js', 'src/data.js',
  'src/store.js', 'src/stats.js', 'src/dca.js', 'src/table3d.js', 'src/charts.js', 'src/fx.js', 'src/guide.js', 'vendor/three.module.min.js',
  'vendor/three.core.min.js', 'vendor/fx/EffectComposer.js', 'vendor/fx/Pass.js', 'vendor/fx/RenderPass.js', 'vendor/fx/ShaderPass.js',
  'vendor/fx/MaskPass.js', 'vendor/fx/OutputPass.js', 'vendor/fx/UnrealBloomPass.js', 'vendor/fx/CopyShader.js', 'vendor/fx/LuminosityHighPassShader.js',
  'vendor/fx/OutputShader.js', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('sandtable-shell-') && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin && url.pathname.includes('/data/')) {
    const key = url.origin + url.pathname;
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(DATA).then((c) => c.put(key, copy)); }
      return res;
    }).catch(() => caches.open(DATA).then((c) => c.match(key)).then((r) => {
      if (!r) return Response.error();
      const h = new Headers(r.headers);
      h.set('X-Sandtable-Offline', '1');
      return r.blob().then((b) => new Response(b, { status: 200, statusText: 'OK', headers: h }));
    })));
    return;
  }
  if (url.origin === location.origin && url.pathname.includes('/sandtable/')) {
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      const net = fetch(e.request).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.hostname.endsWith('gstatic.com') || url.hostname.endsWith('googleapis.com')) {
    e.respondWith(caches.open(FONTS).then((c) => c.match(e.request).then((hit) => hit || fetch(e.request).then((res) => { c.put(e.request, res.clone()); return res; }))));
  }
});
