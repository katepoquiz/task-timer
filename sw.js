// Offline support. Serves the app from a local cache, so it opens with no internet.
// When you change any app file, bump VERSION so installed copies pick up the update.
const VERSION = 'v1.0.0';
const CACHE = `tasktimer-${VERSION}`;
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './store.js', './time.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
  './icons/icon-maskable-512.png', './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Cache first, network as fallback. The whole app updates at once when VERSION changes.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch {
      return (await cache.match(new URL('./index.html', self.registration.scope).href)) || Response.error();
    }
  })());
});

// Pause / Stop buttons on the reminder notification.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const action = event.action || 'open';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      const win = wins[0];
      try { await win.focus(); } catch { /* ignore */ }
      win.postMessage({ type: 'notification-action', action });
    } else {
      await self.clients.openWindow(action === 'open' ? './' : `./?action=${action}`);
    }
  })());
});
